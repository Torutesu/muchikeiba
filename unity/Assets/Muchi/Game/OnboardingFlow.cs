using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    /// <summary>The FTUE screens in order (06 §2.3). <see cref="Done"/> = the FTUE is over (normal home).</summary>
    public enum FtueStep { Consent = 0, FirstRace = 1, Naming = 2, FirstScout = 3, Home = 4, Done = 5 }

    /// <summary>
    /// The first session (docs/planning/06 §2.3, REQ-UXU-001..004 / REQ-UXS-001/002/004/030): 同意してはじめる → the tutorial race
    /// (whip only; lost → もう一度, the 3rd try is assisted to a win) → name the horse just ridden (granted as the first partner)
    /// → the free welcome 10-pull as its own screen → home. Pure C#: the screens read <see cref="Screen"/> and call the step
    /// methods; nothing here touches UnityEngine.
    ///
    /// Resume after a kill: the step reached is kept on the device and merged with what the server knows (partner granted →
    /// at least the scout; tutorial gacha drawn → home), so a relaunch never replays a finished step, never shows naming
    /// again for a granted partner and never loses the welcome pulls (their idempotency key is kept until the reveal, see
    /// <see cref="GameBackend.EnsureFirstScoutAsync"/>). Offline: consent and the name are kept on the device and sent by
    /// <see cref="SyncAsync"/> once the server answers (the tutorial runs on the device engine either way).
    /// Each FTUE KPI step is sent once (<see cref="AnalyticsEvent.FtueStep"/>, the fixed list of protocol §8.7).
    /// </summary>
    public sealed class OnboardingFlow
    {
        public const string KeyStep = "muchi.ftue.step";
        /// <summary>Consent given while offline: "&lt;atMs&gt;" (sent with the server's current versions on sync).</summary>
        public const string KeyPendingConsent = "muchi.ftue.consent.pending";
        /// <summary>The versions this device last consented to ("terms|privacy"), for the offline title screen.</summary>
        public const string KeyConsentedVersions = "muchi.ftue.consent.versions";
        public const string KeyKpiSent = "muchi.ftue.kpi";
        /// <summary>Katakana 2–9 (the server is the judge; this only catches the obvious before sending).</summary>
        public const int NameMin = 2, NameMax = 9;
        /// <summary>Name chips under the field (client list, REQ-UXU-003 ①).</summary>
        public static readonly string[] NameSuggestions = { "アカツキ", "ハヤテ", "イッセン" };

        private readonly GameBackend _b;
        private readonly IKeyValueStore _kv;
        private readonly Action<AnalyticsEvent> _track;
        private readonly NowMs _now;

        public OnboardingFlow(GameBackend backend, Action<AnalyticsEvent> track = null, NowMs now = null)
        {
            _b = backend ?? throw new ArgumentNullException(nameof(backend));
            _kv = backend.Store;
            _track = track;
            _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            Step = Stored;
        }

        /// <summary>The FTUE step reached (persisted).</summary>
        public FtueStep Step { get; private set; }
        /// <summary>Error / notice for the current screen in Japanese (null = none).</summary>
        public string Message { get; private set; }
        /// <summary>A request is in flight: disable the primary button.</summary>
        public bool Busy { get; private set; }
        /// <summary>The welcome pulls in draw order (the reveal flips them one by one; not sorted by rarity).</summary>
        public List<PullResult> Pulls { get; private set; } = new List<PullResult>();
        /// <summary>The last tutorial race result (null before the first finish).</summary>
        public RaceResultModel LastRace { get; private set; }

        /// <summary>
        /// The consent screen must be shown (before anything else): first launch, or the server raised the terms / privacy
        /// version (<see cref="ConsentUpdated"/>). Offline: until this device has consented once.
        /// </summary>
        public bool ConsentRequired
        {
            get
            {
                var c = _b.Online ? _b.Player?.Consent : null;
                if (c != null) return c.Required && !(HasPendingConsent && c.TermsVersion == null);
                return !HasPendingConsent && string.IsNullOrEmpty(_kv.Get(KeyConsentedVersions));
            }
        }

        /// <summary>"規約が更新されました" (the player had consented to an older version).</summary>
        public bool ConsentUpdated => _b.Online && _b.Player?.Consent != null && _b.Player.Consent.Required && _b.Player.Consent.TermsVersion != null;
        public bool HasPendingConsent => !string.IsNullOrEmpty(_kv.Get(KeyPendingConsent));
        /// <summary>The versions linked from the title screen (null offline before the first fetch).</summary>
        public ConsentVersions ConsentVersions => _b.Player?.Consent?.Current;

        /// <summary>What to show now: the consent screen while required, else the step reached.</summary>
        public FtueStep Screen => ConsentRequired ? FtueStep.Consent : Step == FtueStep.Consent ? FtueStep.FirstRace : Step;
        public bool InFtue => Screen != FtueStep.Done;

        private FtueStep Stored => int.TryParse(_kv.Get(KeyStep), NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) && n >= 0 && n <= (int)FtueStep.Done ? (FtueStep)n : FtueStep.Consent;

        private void Advance(FtueStep to)
        {
            if (to <= Step) return;
            Step = to;
            _kv.Set(KeyStep, ((int)to).ToString(CultureInfo.InvariantCulture));
        }

        /// <summary>
        /// Call after <see cref="GameBackend.InitializeAsync"/> (every launch): merges the stored step with the server's
        /// facts and sends what was kept offline. Returns <see cref="Screen"/>.
        /// </summary>
        public async Task<FtueStep> ResumeAsync(CancellationToken ct = default)
        {
            Step = Stored;
            await SyncAsync(ct);
            var p = _b.Online ? _b.Player : null;
            if (p != null)
            {
                bool scoutPending = !string.IsNullOrEmpty(_kv.Get(GameBackend.KeyFirstScoutIdem));
                if (p.PartnerHorseId != null) Advance(FtueStep.FirstScout);
                // the welcome pulls were drawn and shown (or drawn by the pre-round-8 naming flow): nothing left but home
                if (p.TutorialGachaUsed && !scoutPending) Advance(p.PartnerHorseId != null || p.Horses.Count > 0 ? FtueStep.Home : Step);
            }
            if (Step == FtueStep.Consent && !ConsentRequired) Advance(FtueStep.FirstRace);
            return Screen;
        }

        /// <summary>Send consent and the partner name kept while offline (no-op offline or when nothing is pending).</summary>
        public async Task SyncAsync(CancellationToken ct = default)
        {
            if (!_b.Online || _b.Api == null) return;
            if (HasPendingConsent && _b.Player?.Consent?.Current != null)
            {
                var r = await SendConsentAsync(ct);
                if (r.Ok) _kv.Set(KeyPendingConsent, "");
            }
            if (_b.PendingPartnerName != null && Step >= FtueStep.Naming)
            {
                var r = await _b.SyncPendingPartnerAsync(ct);
                // a definite refusal (NG_NAME …) dropped the grant's key: forget the offline name and ask again;
                // without an answer the key is kept and the same name is sent on the next launch
                if (!r.Ok && string.IsNullOrEmpty(_kv.Get(GameBackend.KeyPartnerIdem)))
                {
                    _kv.Set(GameBackend.KeyPendingPartnerName, "");
                    Step = FtueStep.Naming; _kv.Set(KeyStep, ((int)Step).ToString(CultureInfo.InvariantCulture));
                    Message = r.Message;
                }
            }
        }

        // ------------------------------------------------------------------ consent (REQ-UXU-001 / REQ-UXS-001)

        /// <summary>
        /// 同意してはじめる. Online: records the versions shown; CONSENT_VERSION_MISMATCH → refetch the player and send the new
        /// versions once (the screen does not change). Offline or no answer: kept on the device and sent later; the
        /// tutorial starts anyway (it runs on the device).
        /// </summary>
        public async Task<ActionResult> AcceptConsentAsync(CancellationToken ct = default)
        {
            Message = null;
            if (!_b.Online || _b.Api == null || _b.Player?.Consent?.Current == null)
            {
                KeepConsentOffline();
                return AfterConsent();
            }
            Busy = true;
            try
            {
                var r = await SendConsentAsync(ct);
                if (!r.Ok)
                {
                    if (r.Message == UxText.Offline) { KeepConsentOffline(); return AfterConsent(); }
                    Message = r.Message;
                    return r;
                }
                return AfterConsent();
            }
            finally { Busy = false; }
        }

        private void KeepConsentOffline()
        {
            _kv.Set(KeyPendingConsent, _now().ToString(CultureInfo.InvariantCulture));
            var cur = ConsentVersions;
            if (cur != null) _kv.Set(KeyConsentedVersions, cur.TermsVersion + "|" + cur.PrivacyVersion);
            else if (string.IsNullOrEmpty(_kv.Get(KeyConsentedVersions))) _kv.Set(KeyConsentedVersions, "local");
        }

        private async Task<ActionResult> SendConsentAsync(CancellationToken ct)
        {
            for (int attempt = 0; attempt < 2; attempt++)
            {
                var cur = _b.Player?.Consent?.Current;
                if (cur == null) return ActionResult.Error(UxText.Offline);
                try
                {
                    var v = await _b.Api.RecordConsentAsync(cur.TermsVersion, cur.PrivacyVersion, ct);
                    _kv.Set(KeyConsentedVersions, cur.TermsVersion + "|" + cur.PrivacyVersion);
                    if (_b.Player != null) _b.Player.Consent = v;
                    return ActionResult.Success();
                }
                catch (ConflictException e) when (e.Code == ApiErrorCode.ConsentVersionMismatch && attempt == 0)
                {
                    await _b.RefreshAsync(ct); // new versions: send those (the title screen already links the current pages)
                }
                catch (ApiException e) { return ActionResult.Error(UxText.For(e)); }
            }
            return ActionResult.Error(UxText.Errors["CONSENT_VERSION_MISMATCH"]);
        }

        private ActionResult AfterConsent()
        {
            Track("consent");
            Advance(FtueStep.FirstRace);
            return ActionResult.Success();
        }

        // ------------------------------------------------------------------ first race (REQ-UXU-002 / REQ-UXS-004)

        /// <summary>Starts (or restarts, もう一度) the tutorial race; the attempt count is stored, so the 3rd try is assisted even after a relaunch.</summary>
        public IRaceDriver StartFirstRace()
        {
            if (Step < FtueStep.FirstRace) Advance(FtueStep.FirstRace);
            Track("race1_start");
            return _b.CreateTutorialRace();
        }

        /// <summary>The player used the whip in the first race (KPI race1_whip, once).</summary>
        public void FirstRaceWhip() => Track("race1_whip");

        /// <summary>
        /// The tutorial race finished. Won → naming (KPI race1_win, value = retries before the win). Lost → stays on the race
        /// with <see cref="RaceResultModel.PrimaryAction"/> もう一度 (call <see cref="StartFirstRace"/> again).
        /// </summary>
        public ActionResult FinishFirstRace(RaceResultModel result)
        {
            LastRace = result;
            if (result == null || !result.HasResult) return ActionResult.Error("レースが終わっていません");
            if (!result.Won) return ActionResult.Error(result.PrimaryAction);
            Track("race1_win", Math.Max(0, _b.TutorialAttempts - 1));
            Advance(FtueStep.Naming);
            return ActionResult.Success();
        }

        // ------------------------------------------------------------------ naming (REQ-UXU-003 / REQ-UXS-002)

        /// <summary>The obvious problems before sending (empty, length, not kana). Hiragana is accepted (the server converts it).</summary>
        public static string ValidateName(string name)
        {
            name = (name ?? "").Trim();
            if (name.Length == 0) return "名前を入力してください";
            int len = new StringInfo(name).LengthInTextElements;
            if (len < NameMin || len > NameMax || !name.All(IsKana)) return UxText.Errors["INVALID_NAME"];
            return null;
        }

        private static bool IsKana(char c) => (c >= 'ぁ' && c <= 'ゖ') || (c >= 'ァ' && c <= 'ヺ') || c == 'ー' || c == '・';

        /// <summary>この馬に名前を: grants the horse just ridden as the first partner (keyed; offline kept for later), then the scout.</summary>
        public async Task<ActionResult> SubmitNameAsync(string name, CancellationToken ct = default)
        {
            Message = ValidateName(name);
            if (Message != null) return ActionResult.Error(Message);
            if (Step < FtueStep.Naming) return ActionResult.Error("先に初レースを走ってください");
            Busy = true;
            try
            {
                var r = await _b.NamePartnerAsync(name.Trim(), ct);
                if (!r.Ok) { Message = r.Message; return r; }
                Track("named");
                Advance(FtueStep.FirstScout);
                return r;
            }
            finally { Busy = false; }
        }

        // ------------------------------------------------------------------ welcome scout (REQ-UXU-004 / REQ-GACHA-010)

        /// <summary>入厩祝い 10連: draws (or re-fetches after a kill) the free pulls. Offline: the fixed preview, nothing drawn.</summary>
        public async Task<ActionResult> DrawFirstScoutAsync(CancellationToken ct = default)
        {
            if (Step < FtueStep.FirstScout) return ActionResult.Error("先に相棒に名前をつけてください");
            Busy = true;
            try
            {
                var r = await _b.EnsureFirstScoutAsync(ct);
                if (!r.Ok) { Message = r.Message; return r; }
                Pulls = _b.FirstScout?.Results.ToList() ?? new List<PullResult>();
                Message = null;
                return r;
            }
            finally { Busy = false; }
        }

        /// <summary>The reveal (and its list) was shown or skipped: home next.</summary>
        public void FinishFirstScout()
        {
            _b.FirstScoutShown();
            _b.MarkScoutUsed();
            Track("gacha_done");
            Advance(FtueStep.Home);
        }

        /// <summary>The home screen was reached: the FTUE is over.</summary>
        public void EnterHome()
        {
            if (Step < FtueStep.Home) return;
            Track("home");
            Advance(FtueStep.Done);
        }

        // ------------------------------------------------------------------ KPI

        private void Track(string step, int? value = null)
        {
            var sent = (_kv.Get(KeyKpiSent) ?? "").Split(',');
            if (sent.Contains(step)) return;
            _kv.Set(KeyKpiSent, string.Join(",", sent.Where(s => s.Length > 0).Concat(new[] { step })));
            _track?.Invoke(AnalyticsEvent.FtueStep(_now(), step, value));
        }
    }
}
