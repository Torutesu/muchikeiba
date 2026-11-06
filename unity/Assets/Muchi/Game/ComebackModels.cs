using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-CB-001..012 (docs/planning/06 §4.5, contracts/protocol.md "復帰キャンペーン・お知らせ"): the comeback welcome,
    // the 7-day comeback login track, comeback missions, the pass-XP catch-up and the one-time what's-new card. Pure C#:
    // Codex's screens bind to the public fields and call the async actions from the main thread.

    /// <summary>One cell of the comeback login track.</summary>
    public sealed class ComebackDayCell
    {
        public int Day;
        public string RewardText;
        public bool Claimed;
        /// <summary>The cell the claim button sits on (the next unclaimed day, when claimable today).</summary>
        public bool Today;
    }

    /// <summary>One comeback mission row. <see cref="Feature"/> is the screen the "行ってみる" button opens.</summary>
    public sealed class ComebackMissionRow
    {
        public string Id, Title, Guide, Feature, RewardText;
        public int Progress, Target;
        public bool Claimed, Claimable;
        public string ProgressText => Math.Min(Progress, Target).ToString(CultureInfo.InvariantCulture) + "/" + Target.ToString(CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// The comeback campaign screens: welcome (once), login track, missions and the catch-up meter.
    /// Rules the model keeps for the screens:
    ///  - the end date is the server's real window end (shown as a date, "11月23日まで"); there is no countdown timer;
    ///  - rewards are listed as they are (free coins / tickets / material); no "◯倍" wording is built;
    ///  - while the account is scheduled for deletion the screen shows <see cref="DeletionGuard"/>'s banner and no claim button;
    ///  - claims keep their idempotency key until the server answers (a retry after a timeout never pays twice);
    ///  - the lapse-reminder opt-in (push category "comeback", off by default) is offered once, never pre-ticked.
    /// </summary>
    public sealed class ComebackModel : ScreenModel
    {
        public const string KeyPendingLogin = "muchi.comeback.login";
        public const string KeyPendingMission = "muchi.comeback.mission";
        public const string KeyPushAsked = "muchi.comeback.pushAsked";
        private readonly NowMs _now;

        public ComebackModel(GameBackend backend, NowMs now = null) : base(backend, backend?.Store) { _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()); }

        public ComebackView View { get; private set; }
        public bool Active => View != null && View.Active && View.Window != null;
        public ComebackWindow Window => Active ? View.Window : null;
        public bool ShowWelcome => Active && Window.ShowWelcome;
        public bool Blocked => Active && Window.Blocked;
        public List<ComebackDayCell> Days { get; private set; } = new List<ComebackDayCell>();
        public List<ComebackMissionRow> Missions { get; private set; } = new List<ComebackMissionRow>();
        /// <summary>The last reward granted (toast), null when none.</summary>
        public string Toast { get; private set; }

        public string WelcomeTitle => "おかえりなさい！";
        /// <summary>"7日ぶりのご来場です。11月23日まで、復帰キャンペーンを用意しました".</summary>
        public string WelcomeBody => Active ? Window.LapseDays.ToString(CultureInfo.InvariantCulture) + "日ぶりのご来場です。" + EndText + "、復帰キャンペーンを用意しました" : null;
        /// <summary>"11月23日まで" — the last game day of the window (the exclusive end minus one instant).</summary>
        public string EndText => Active ? DeletionGuard.JstDate(Window.EndsAt - 1) + "まで" : null;
        /// <summary>"残り14日" (game days, counting today).</summary>
        public string RemainingText => Active ? "残り" + Window.RemainingDays.ToString(CultureInfo.InvariantCulture) + "日" : null;
        /// <summary>"ログインボーナス 2/7".</summary>
        public string LoginProgressText => Active ? "復帰ログインボーナス " + Window.Login.Claimed + "/" + Window.Login.Total : null;
        public bool CanClaimLogin => Active && !Blocked && Window.Login.ClaimableToday;
        /// <summary>"パスXP上乗せ中：1レースごとに +20（残り 480）" / null when the catch-up is used up.</summary>
        public string CatchUpText => Active && Window.CatchUp.Active ? "パスXP上乗せ中：1レースごとに +" + Window.CatchUp.BonusPerRace + "（残り " + Window.CatchUp.RemainingXp + "）" : null;
        /// <summary>0..1 for the catch-up meter.</summary>
        public float CatchUpProgress => Active && Window.CatchUp.CapXp > 0 ? Math.Min(1f, Window.CatchUp.GrantedXp / (float)Window.CatchUp.CapXp) : 0f;
        public string BlockedText => Blocked ? DeletionGuard.Banner(B) ?? DeletionGuard.Banner((long?)null) : null;

        /// <summary>Offer the lapse-reminder opt-in once (window running, category off, not asked before on this device).</summary>
        public bool ShowPushOptIn => Active && !View.PushEnabled && Kv.Get(KeyPushAsked) != "1";
        public string PushOptInText => "また間があいたとき、お知らせを受け取りますか？（3日目・7日目の夜に1回ずつ。設定でいつでも変えられます）";

        public async Task<ActionResult> LoadAsync(CancellationToken ct = default)
        {
            Message = null;
            if (!ServerAvailable) { View = null; Rebuild(null); return Offline("復帰キャンペーンはオンラインで表示されます"); }
            try
            {
                View = await B.Api.GetComebackAsync(ct);
                Online = true;
                Rebuild(null);
                return ActionResult.Success();
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>Call when the welcome screen was displayed (it counts as shown then).</summary>
        public async Task MarkWelcomedAsync(CancellationToken ct = default)
        {
            if (!Active || !ServerAvailable) return;
            try { await B.Api.MarkComebackWelcomedAsync(ct); Window.ShowWelcome = false; }
            catch (ApiException e) { Message = UxText.For(e); }
        }

        public async Task<ActionResult> ClaimLoginAsync(Func<string, string> itemName = null, CancellationToken ct = default)
        {
            Toast = null;
            if (!CanClaimLogin) return ActionResult.Error(Blocked ? BlockedText : UxText.Errors["ALREADY_CLAIMED"]);
            string day = GameDay.Key(_now());
            string key = PendingKey(KeyPendingLogin, day);
            try
            {
                var c = await B.Api.ClaimComebackLoginAsync(key, ct);
                Kv.Set(KeyPendingLogin, "");
                Toast = "復帰ログインボーナス " + c.Day + "日目：" + UxText.Reward(c.Reward, itemName);
                Apply(c.Window, itemName);
                await B.RefreshAsync(ct);
                return ActionResult.Success(Toast);
            }
            catch (ApiException e) { return Failed(e, KeyPendingLogin); }
        }

        public async Task<ActionResult> ClaimMissionAsync(string missionId, Func<string, string> itemName = null, CancellationToken ct = default)
        {
            Toast = null;
            var row = Missions.Find(x => x.Id == missionId);
            if (row == null || !row.Claimable || Blocked) return ActionResult.Error(Blocked ? BlockedText : UxText.Errors["NOT_ELIGIBLE"]);
            string key = PendingKey(KeyPendingMission, missionId);
            try
            {
                var c = await B.Api.ClaimComebackMissionAsync(missionId, key, ct);
                Kv.Set(KeyPendingMission, "");
                Toast = row.Title + "：" + UxText.Reward(c.Reward, itemName);
                Apply(c.Window, itemName);
                await B.RefreshAsync(ct);
                return ActionResult.Success(Toast);
            }
            catch (ApiException e) { return Failed(e, KeyPendingMission); }
        }

        /// <summary>The player answered the opt-in (yes turns the "comeback" push category on). Asked once per device either way.</summary>
        public async Task<ActionResult> AnswerPushOptInAsync(bool yes, CancellationToken ct = default)
        {
            Kv.Set(KeyPushAsked, "1");
            if (!yes || !ServerAvailable) return ActionResult.Success();
            try
            {
                var p = await B.Api.SetPushPreferencesAsync(new PushPreferencesPatch { Comeback = true }, ct);
                if (View != null) View.PushEnabled = p.Comeback;
                return ActionResult.Success();
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        private string PendingKey(string kvKey, string scope)
        {
            var stored = (Kv.Get(kvKey) ?? "").Split('|');
            if (stored.Length == 2 && stored[0] == scope) return stored[1];
            string key = B.Api.NewIdempotencyKey();
            Kv.Set(kvKey, scope + "|" + key);
            return key;
        }

        private ActionResult Failed(ApiException e, string kvKey)
        {
            if (!GameBackend.IsTransient(e)) Kv.Set(kvKey, "");
            Message = UxText.For(e);
            return ActionResult.Error(Message);
        }

        private void Apply(ComebackWindow w, Func<string, string> itemName)
        {
            if (View != null && w != null) View.Window = w;
            Rebuild(itemName);
        }

        private void Rebuild(Func<string, string> itemName)
        {
            Days = new List<ComebackDayCell>();
            Missions = new List<ComebackMissionRow>();
            if (!Active) return;
            var w = Window;
            foreach (var d in w.Login.Days)
                Days.Add(new ComebackDayCell { Day = d.Day, RewardText = UxText.Reward(d.Reward, itemName), Claimed = d.Claimed, Today = !d.Claimed && d.Day == w.Login.Claimed + 1 && w.Login.ClaimableToday && !w.Blocked });
            foreach (var m in w.Missions)
                Missions.Add(new ComebackMissionRow { Id = m.Id, Title = m.Title, Guide = m.Guide, Feature = m.Feature, RewardText = UxText.Reward(m.Reward, itemName), Progress = m.Progress, Target = m.Target, Claimed = m.Claimed, Claimable = m.Claimable && !w.Blocked });
        }
    }

    /// <summary>One line of the what's-new card.</summary>
    public sealed class WhatsNewLine
    {
        public string Id, Kind, Label, Title, Body, Feature;
        /// <summary>"11月30日まで" for banners and events with a real end; null otherwise.</summary>
        public string EndText;
    }

    /// <summary>
    /// REQ-CB-008: the one-time home card listing what went live since the player last looked (features, banners, events).
    /// Shown once: <see cref="DismissAsync"/> (or tapping a line) marks everything up to the GET's <c>upTo</c> as seen on the
    /// server, and the same position is kept on the device so a failed mark never shows the card twice.
    /// </summary>
    public sealed class WhatsNewModel : ScreenModel
    {
        public const string KeySeenUpTo = "muchi.whatsnew.seenUpTo";
        public static readonly IReadOnlyDictionary<string, string> KindLabels = new Dictionary<string, string>
        {
            ["feature"] = "新機能", ["banner"] = "スカウト", ["event"] = "イベント", ["balance"] = "調整",
        };

        public WhatsNewModel(GameBackend backend) : base(backend, backend?.Store) { }

        public WhatsNew Data { get; private set; }
        public List<WhatsNewLine> Lines { get; private set; } = new List<WhatsNewLine>();
        public string Title => "前回からのお知らせ";
        /// <summary>"ほか2件" when more than the listed items went live.</summary>
        public string MoreText => Data != null && Data.More > 0 ? "ほか" + Data.More + "件" : null;
        public bool ShowCard => Data != null && Data.ShowCard && Lines.Count > 0;

        public async Task<ActionResult> LoadAsync(CancellationToken ct = default)
        {
            Message = null;
            Lines = new List<WhatsNewLine>();
            if (!ServerAvailable) { Data = null; return ActionResult.Success(); } // nothing to show offline
            try
            {
                Data = await B.Api.GetWhatsNewAsync(ct);
                Online = true;
                long.TryParse(Kv.Get(KeySeenUpTo) ?? "0", NumberStyles.Integer, CultureInfo.InvariantCulture, out long local);
                foreach (var it in Data.Items)
                {
                    if (it.At <= local) continue; // seen on this device, the server mark did not arrive
                    Lines.Add(new WhatsNewLine
                    {
                        Id = it.Id, Kind = it.Kind, Label = KindLabels.TryGetValue(it.Kind ?? "", out var l) ? l : "お知らせ",
                        Title = it.Title, Body = it.Body, Feature = it.Feature,
                        EndText = it.EndsAt.HasValue ? DeletionGuard.JstDate(it.EndsAt.Value - 1) + "まで" : null,
                    });
                }
                return ActionResult.Success();
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>Closes the card for good (everything listed counts as seen).</summary>
        public async Task DismissAsync(CancellationToken ct = default)
        {
            if (Data == null) return;
            long upTo = Data.UpTo;
            Kv.Set(KeySeenUpTo, upTo.ToString(CultureInfo.InvariantCulture));
            Lines = new List<WhatsNewLine>();
            if (!ServerAvailable) return;
            try { await B.Api.MarkWhatsNewSeenAsync(upTo, ct); }
            catch (ApiException e) { Message = UxText.For(e); }
        }
    }
}
