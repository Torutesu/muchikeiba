using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Game
{
    // REQ-LIMIT-001..022 (contracts/protocol.md §67, docs/handoff-codex-round22-self-limits.md): 使いすぎ・遊びすぎの防止, the game layer.
    // Pure C#: the 「使いすぎ・遊びすぎの防止」 screen (own monthly limit, a waiting raise and its cancel, a custom amount, the play-time
    // reminder), the refused-purchase sentence with its link, and the play-time sheet at safe points. The screen is opened from the
    // purchase history (その他 › 設定・サポート › 購入・コイン・ガチャ履歴 › 上限の設定), the purchase confirmation (上限を設定), a refused
    // purchase / the shortfall card, and the sheet itself — never a new row on either その他 page.
    // The sheet is player-requested: it does NOT go through SessionPromptGate (§58.11) and does not use or take the session's one
    // prompt; when it shows at a safe point, the other prompts wait for the next one (SheetVisible). Nothing here moves coins.

    public sealed class SpendingChoiceRow
    {
        /// <summary>null = 上限なし.</summary>
        public int? Yen;
        public string Label;
        /// <summary>「すぐに効きます」 or 「72時間後に効きます」 (what saving it would do); empty for the current amount.</summary>
        public string WhenText;
        public bool Current;
    }

    public sealed class PlaytimeChoiceRow
    {
        public int? Value;
        public string Label;
        public bool Current;
    }

    public sealed class SelfLimitsModel : ScreenModel
    {
        public const string Title = "使いすぎ・遊びすぎの防止";
        public const string SpendingKicker = "月の購入上限";
        public const string PlaytimeKicker = "遊ぶ時間のお知らせ";
        public const string NoLimitLabel = "上限なし";
        public const string OffLabel = "使わない";
        public const string CustomLabel = "金額を入力";
        public const string CancelRaiseLabel = "変更を取り消す";
        public const string LinkLabel = "上限の設定";
        public const string ConfirmLinkLabel = "上限を設定";
        public const string AppliesNowText = "すぐに効きます";
        public const string SessionLabel = "一度に遊ぶ時間";
        public const string DailyLabel = "一日の合計";
        public const string QuietLabel = "◯時を過ぎたら";
        public const string KeyClock = "muchi.selfLimits.clock";

        private readonly Action<AnalyticsEvent> _track;
        private readonly NowMs _now;
        private readonly Func<string> _locale;

        /// <param name="localOffsetMin">The device's UTC offset in minutes (Unity: TimeZoneInfo.Local.GetUtcOffset(DateTime.Now)).</param>
        public SelfLimitsModel(GameBackend backend, Action<AnalyticsEvent> track = null, NowMs now = null, Func<string> locale = null, int localOffsetMin = 540) : base(backend, backend?.Store)
        {
            _track = track;
            _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            _locale = locale ?? (() => Loc.Current);
            Clock = LoadClock();
            Clock.LocalOffsetMin = localOffsetMin;
        }

        public SelfLimitsView View { get; private set; }
        public PlaytimeClock Clock { get; private set; }
        /// <summary>The sheet is up: show it first; ConsentModel / LocalNotificationModel / ReviewPromptModel wait for the next safe point.</summary>
        public bool SheetVisible => Sheet != null;
        public PlaytimeDecision Sheet { get; private set; }

        public List<SpendingChoiceRow> SpendingRows { get; private set; } = new List<SpendingChoiceRow>();
        public List<PlaytimeChoiceRow> SessionRows { get; private set; } = new List<PlaytimeChoiceRow>();
        public List<PlaytimeChoiceRow> DailyRows { get; private set; } = new List<PlaytimeChoiceRow>();
        public List<PlaytimeChoiceRow> QuietRows { get; private set; } = new List<PlaytimeChoiceRow>();
        public bool CanCancelRaise => View?.Spending.Pending != null;

        private static string Yen(int v) => "¥" + v.ToString("N0", CultureInfo.InvariantCulture);
        public static string HourLabel(int h) => h + "時";
        private string CoolOffText => (View?.Spending.CoolOffHours ?? 72) + "時間後に効きます";

        public async Task<ActionResult> LoadAsync(CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline("上限の設定はオンラインで変えられます");
            try { Apply(await B.Api.GetSelfLimitsAsync(ct)); Online = true; return ActionResult.Success(); }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>Saves a listed or custom amount (null = 上限なし). Lower → now; higher / none → after the cool-off.</summary>
        public async Task<ActionResult> SetSpendingAsync(int? yen, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline("上限の設定はオンラインで変えられます");
            if (yen.HasValue && View != null && !View.Spending.IsValidAmount(yen.Value)) return ActionResult.Error("この金額は選べません");
            try
            {
                var r = await B.Api.SetSpendingLimitAsync(yen, ct);
                Apply(r.View);
                return ActionResult.Success(r.Applied == "pending" ? r.View.Spending.PendingText : r.Applied == "now" ? "上限を変えました" : null);
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        public async Task<ActionResult> CancelRaiseAsync(CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline("上限の設定はオンラインで変えられます");
            try { Apply((await B.Api.CancelSpendingRaiseAsync(ct)).View); return ActionResult.Success("変更を取り消しました"); }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        public async Task<ActionResult> SetPlaytimeAsync(PlaytimeSettings values, bool session, bool daily, bool quietAfter, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline("お知らせの設定はオンラインで変えられます");
            try { Apply((await B.Api.SetPlaytimeAsync(values, session, daily, quietAfter, ct)).View); return ActionResult.Success(); }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        // ------------------------------------------------------------------------------------- refused purchases (§67.2)

        /// <summary>The one sentence for a purchase refused by the player's own limit (no raise suggested; the link only opens this screen).</summary>
        public static string RefusedText(SelfLimitExceededException e) => "自分で決めた今月の上限（" + Yen(e.SelfLimitYen) + "）を超えるため、購入できません";

        // ------------------------------------------------------------------------------------- the play-time sheet (§67.4)

        private PlaytimeSettings Settings => View?.Playtime.Settings ?? B.Player?.SelfLimits?.Playtime ?? new PlaytimeSettings();

        public void OnForeground() { Clock.Foreground(_now()); SaveClock(); }
        public void OnBackground() { Clock.Background(_now()); SaveClock(); }

        /// <summary>
        /// Call at a place (PlaytimePlaces): after the race result closes (race_result) and on the home (home). Elsewhere it returns
        /// null and the reminder waits. Returns the sheet to show (also in <see cref="Sheet"/>), or null.
        /// </summary>
        public PlaytimeDecision AtPlace(string place)
        {
            var d = Clock.Ask(_now(), Settings, place, Loc.Normalize(_locale()));
            SaveClock();
            if (!d.Show) return null;
            Clock.Accept(d);
            SaveClock();
            Sheet = d;
            return d;
        }

        /// <summary>The answer: continue | stop | settings. Returns the screen to open (stop → home, settings → self_limits, continue → null).</summary>
        public string Answer(string choice)
        {
            var d = Sheet;
            Sheet = null;
            if (d == null) return null;
            _track?.Invoke(AnalyticsEvent.PlaytimeReminderShown(_now(), d.Reasons, Clock.SessionMinutes, Clock.DayMinutes, choice));
            return choice == "stop" ? "home" : choice == "settings" ? "self_limits" : null;
        }

        /// <summary>An account change on this device (§54): the clock starts afresh.</summary>
        public void ForgetClock() { Clock = new PlaytimeClock { LocalOffsetMin = Clock.LocalOffsetMin }; Sheet = null; SaveClock(); }

        // ------------------------------------------------------------------------------------- internals

        private PlaytimeClock LoadClock()
        {
            var raw = Kv.Get(KeyClock);
            if (string.IsNullOrEmpty(raw)) return new PlaytimeClock();
            try { return PlaytimeClock.FromJson(JsonNode.Parse(raw)); } catch { return new PlaytimeClock(); }
        }
        private void SaveClock() => Kv.Set(KeyClock, Clock.ToJson().ToString());

        private void Apply(SelfLimitsView v)
        {
            View = v;
            var sp = v.Spending;
            var amounts = sp.ChoicesYen.Select(x => (int?)x).ToList();
            if (sp.LimitYen.HasValue && !amounts.Contains(sp.LimitYen)) amounts.Add(sp.LimitYen); // a custom amount shows as its own row
            amounts = amounts.OrderBy(x => x).ToList();
            amounts.Add(null);
            SpendingRows = amounts.Select(x => new SpendingChoiceRow
            {
                Yen = x, Label = x.HasValue ? Yen(x.Value) : NoLimitLabel, Current = x == sp.LimitYen,
                WhenText = x == sp.LimitYen ? "" : sp.AppliesNow(x) ? AppliesNowText : CoolOffText,
            }).ToList();
            var pt = v.Playtime;
            List<PlaytimeChoiceRow> Rows(List<int> xs, int? cur, Func<int, string> label) =>
                new[] { (int?)null }.Concat(xs.Select(x => (int?)x)).Select(x => new PlaytimeChoiceRow { Value = x, Label = x.HasValue ? label(x.Value) : OffLabel, Current = x == cur }).ToList();
            SessionRows = Rows(pt.SessionChoices, pt.Settings.SessionMin, x => x + "分");
            DailyRows = Rows(pt.DailyChoices, pt.Settings.DailyMin, x => x + "分");
            QuietRows = Rows(pt.QuietAfterChoices, pt.Settings.QuietAfterHour, HourLabel);
            Message = null;
        }
    }
}
