using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-ADV-001..016 (contracts/protocol.md §39, docs/handoff-codex-round15-race-advice.md): 出走前アドバイス, the game layer.
    // Pure C#: Codex's panel binds to the public members. The model never invents advice: the server computes it
    // (GET /v1/races/advice) and the device recomputes the same thing with RaceAdvice.Compute when the selected horse changes
    // or when offline (an input the game built from local data). No odds, no win chance, no purchase prompt anywhere.

    public interface IRaceAdviceApi
    {
        Task<RaceAdviceResult> GetRaceAdviceAsync(RaceAdviceQuery query, CancellationToken ct = default);
    }

    /// <summary>ApiClient as the advice API.</summary>
    public sealed class RaceAdviceApi : IRaceAdviceApi
    {
        private readonly ApiClient _api;
        public RaceAdviceApi(ApiClient api) { _api = api ?? throw new ArgumentNullException(nameof(api)); }
        public Task<RaceAdviceResult> GetRaceAdviceAsync(RaceAdviceQuery query, CancellationToken ct = default) => _api.GetRaceAdviceAsync(query, ct);
    }

    /// <summary>One horse row of the panel.</summary>
    public sealed class AdviceRow
    {
        public string HorseId, Name;
        public int Rank;
        /// <summary>good | ok | poor</summary>
        public string Grade;
        /// <summary>"よく合う" / "合う" / "条件外あり" (words, never ◎○△).</summary>
        public string GradeText;
        public bool Suggested, Selected;
        /// <summary>The reasons, each with its mark (plus / ok / minus / off), in the app's language.</summary>
        public List<(string Mark, string Text)> Reasons = new List<(string, string)>();
    }

    public sealed class RaceAdviceModel
    {
        public const string KeyEnabled = "muchi.advice.enabled";
        public const string Title = "出走前アドバイス";
        /// <summary>Shown under the panel, always (honesty: it is a calculation, not a promise).</summary>
        public const string Footnote = "アドバイスは馬の適性とルールから計算しています。勝ちを約束するものではありません。";
        public const string OffText = "アドバイスはオフです（設定で変えられます）";
        public const string SettingLabel = "アドバイスを表示する";
        public static readonly IReadOnlyDictionary<string, string> GradeTexts = new Dictionary<string, string> { ["good"] = "よく合う", ["ok"] = "合う", ["poor"] = "条件外あり" };

        private readonly IRaceAdviceApi _api;
        private readonly IKeyValueStore _kv;
        private readonly Func<bool> _online;
        private readonly Action<AnalyticsEvent> _track;
        private readonly Func<long> _clock;
        private int _openSeq;
        private bool _followSent;

        public RaceAdviceModel(IRaceAdviceApi api, IKeyValueStore store = null, Func<bool> online = null, Action<AnalyticsEvent> track = null, Func<long> clock = null)
        {
            _api = api;
            _kv = store ?? new MemoryKeyValueStore();
            _online = online ?? (() => true);
            _track = track;
            _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        /// <summary>The device setting (default on). Off: no request, no panel, no KPI. The tutorial shows its fixed version anyway.</summary>
        public bool Enabled
        {
            get => _kv.Get(KeyEnabled) != "0";
            set => _kv.Set(KeyEnabled, value ? "1" : "0");
        }

        public RaceAdviceQuery Query { get; private set; }
        public RaceAdviceResult Result { get; private set; }
        public string SelectedHorseId { get; private set; }
        public bool Loading { get; private set; }
        /// <summary>The advice was computed on the device (offline or recomputed for another horse) rather than received.</summary>
        public bool ComputedOnDevice { get; private set; }
        public string Message { get; private set; }

        public string Context => Result?.Context ?? Query?.Context;
        public bool Visible => Result != null;
        public string SuggestedHorseId => Result?.SuggestedHorseId;

        /// <summary>The panel's lines (pick, ground, field, style, whip…) in the app's language.</summary>
        public List<string> Lines
        {
            get
            {
                var o = new List<string>();
                if (Result != null) foreach (var l in Result.Lines) o.Add(Loc.T(l.Text));
                return o;
            }
        }

        public List<AdviceRow> Rows
        {
            get
            {
                var o = new List<AdviceRow>();
                if (Result == null) return o;
                foreach (var h in Result.Horses)
                {
                    var row = new AdviceRow
                    {
                        HorseId = h.HorseId, Name = h.Name, Rank = h.Rank, Grade = h.Grade, GradeText = Loc.T(GradeTexts.TryGetValue(h.Grade ?? "ok", out var g) ? g : "合う"),
                        Suggested = h.HorseId == Result.SuggestedHorseId, Selected = h.HorseId == SelectedHorseId,
                    };
                    foreach (var c in h.Checks) row.Reasons.Add((c.Mark, Loc.T(c.Text)));
                    o.Add(row);
                }
                return o;
            }
        }

        /// <summary>
        /// Opens the panel for a race context. <paramref name="offlineInput"/> (optional) is what the game can build from local data
        /// (its horses, the course, RaceAdvice.Rules of the bundled ruleset) for offline races; it is computed on the device.
        /// </summary>
        public async Task OpenAsync(RaceAdviceQuery query, AdviceInput offlineInput = null, CancellationToken ct = default)
        {
            Query = query ?? new RaceAdviceQuery();
            int seq = ++_openSeq;
            Result = null; Message = null; ComputedOnDevice = false; _followSent = false;
            SelectedHorseId = Query.HorseId;
            if (Query.Context == "tutorial") { Show(RaceAdvice.Tutorial(), true); return; } // REQ-ADV-010: fixed, regardless of the setting
            if (!Enabled) { Message = OffText; return; }
            RaceAdviceResult r = null;
            bool device = false;
            if (_online() && _api != null)
            {
                Loading = true;
                try { r = await _api.GetRaceAdviceAsync(Query, ct); }
                catch (ApiException e) { Message = UxText.For(e); }
                finally { if (seq == _openSeq) Loading = false; }
            }
            if (seq != _openSeq) return; // a newer open won
            if (r == null && offlineInput != null)
            {
                r = RaceAdvice.Compute(Query.HorseId != null ? offlineInput.WithFocus(Query.HorseId) : offlineInput);
                r.Context = Query.Context;
                device = true;
                Message = null;
            }
            if (r == null) { Message = Message ?? "OFFLINE"; return; }
            Show(r, device);
        }

        private void Show(RaceAdviceResult r, bool device)
        {
            Result = r;
            ComputedOnDevice = device;
            SelectedHorseId = SelectedHorseId ?? r.FocusHorseId ?? r.SuggestedHorseId;
            if (Enabled || r.Tutorial)
            {
                try { _track?.Invoke(AnalyticsEvent.AdviceView(_clock(), Context ?? "ranked", Math.Min(30, r.Horses.Count), r.SuggestedHorseId != null)); }
                catch (ArgumentException) { /* an unknown context is not reported */ }
            }
        }

        /// <summary>The player selected another horse: the tips follow it (recomputed on the device from the server's input; same result).</summary>
        public void Select(string horseId)
        {
            SelectedHorseId = horseId;
            if (Result?.Input == null || Result.Tutorial) return;
            var ctx = Result.Context;
            Result = RaceAdvice.Compute(Result.Input.WithFocus(horseId));
            Result.Context = ctx;
            ComputedOnDevice = true;
        }

        /// <summary>The race is entered with <paramref name="horseId"/>: advice_follow once per opening, only when a horse was suggested.</summary>
        public void OnEnter(string horseId)
        {
            if (_followSent || Result == null || Result.Tutorial || Result.SuggestedHorseId == null || !Enabled) return;
            _followSent = true;
            try { _track?.Invoke(AnalyticsEvent.AdviceFollow(_clock(), Context ?? "ranked", horseId == Result.SuggestedHorseId)); }
            catch (ArgumentException) { }
        }

        /// <summary>REQ-ADV-014: the result screen's line about the whip tip (null when no whip tip was shown).</summary>
        public string DebriefLine(RaceDebriefRecorder recorder)
        {
            var tip = Result?.Whip;
            if (tip == null || recorder == null) return null;
            return Loc.T(RaceAdvice.WhipTipText(RaceAdvice.CheckWhipTip(tip, recorder), tip));
        }
    }
}
