using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-REV-001..016 レビュー依頼のタイミング — in-app store review prompt (server/src/domain/reviewPrompt.ts, contracts/protocol.md §59).
    // The app asks for a store rating only through the OS's own in-app review API (IStoreReview; Codex wires the SDK), only at a
    // happy moment, never right after a loss / purchase / error / refund / maintenance notice, never during the FTUE, once per
    // session at most, within the yearly cap and the cool-down. ReviewPromptPolicy.Decide is the same pure rule as the server
    // (contracts/review-prompt.vectors.json): the device uses it to skip the server call when the answer is obviously no; the
    // server decides and keeps the history. NOTHING is ever granted for a review (App Store 5.6.1 / Google Play policy): there is
    // no reward type, field or call here, and the OS never tells us whether a review was written.

    /// <summary>The happy moments (§59.1).</summary>
    public static class ReviewMoments
    {
        public const string FirstWin = "first_win", FirstTournamentWin = "first_tournament_win", HallInduction = "hall_induction", HorseGoalChain = "horse_goal_chain";
        public static readonly string[] All = { FirstWin, FirstTournamentWin, HallInduction, HorseGoalChain };
    }

    /// <summary>progression.reviewPrompt (GET /v1/review-prompt <c>rules</c>).</summary>
    public sealed class ReviewPromptRules
    {
        public bool Enabled;
        public List<string> Moments = new List<string>();
        public int MinDaysSinceInstall, MinRacesPlayed, MaxPerYear = 3, CoolDownDays = 120;
        /// <summary>loss | purchase | refund | error | maintenanceNotice → minutes.</summary>
        public Dictionary<string, int> QuietMinutes = new Dictionary<string, int>();
        public bool SoftAskIos, SoftAskAndroid;
        public int Quiet(string k) => QuietMinutes.TryGetValue(k, out var v) ? v : 0;
        public static ReviewPromptRules Parse(JsonNode o)
        {
            var s = J.Opt(o, "softAsk");
            return new ReviewPromptRules
            {
                Enabled = J.Bool(o, "enabled"), Moments = (J.Strs(o, "moments") ?? new string[0]).ToList(),
                MinDaysSinceInstall = J.Int(o, "minDaysSinceInstall"), MinRacesPlayed = J.Int(o, "minRacesPlayed"),
                MaxPerYear = J.Int(o, "maxPerYear", 3), CoolDownDays = J.Int(o, "coolDownDays", 120),
                QuietMinutes = J.Map(o, "quietMinutes", x => x.AsInt()),
                SoftAskIos = J.Bool(s, "ios"), SoftAskAndroid = J.Bool(s, "android"),
            };
        }
    }

    /// <summary>The decision's input (§59.3). MinutesSince values: null = none / unknown.</summary>
    public sealed class ReviewPromptSummary
    {
        /// <summary>ios | android | editor</summary>
        public string Platform = "ios";
        public string Moment;
        public long Now, InstalledAt;
        public int RacesPlayed;
        public bool InFtue, AccountClosing, SessionPrompted, MaintenanceVisible, CoinDebt;
        public int? SinceLoss, SincePurchase, SinceRefund, SinceError, SinceMaintenanceNotice;
        public List<long> History = new List<long>();
        public static ReviewPromptSummary Parse(JsonNode o)
        {
            var m = J.Opt(o, "minutesSince");
            return new ReviewPromptSummary
            {
                Platform = J.Str(o, "platform"), Moment = J.Str(o, "moment"), Now = J.Long(o, "now"), InstalledAt = J.Long(o, "installedAt"),
                RacesPlayed = J.Int(o, "racesPlayed"), InFtue = J.Bool(o, "inFtue"), AccountClosing = J.Bool(o, "accountClosing"),
                SessionPrompted = J.Bool(o, "sessionPrompted"), MaintenanceVisible = J.Bool(o, "maintenanceVisible"), CoinDebt = J.Bool(o, "coinDebt"),
                SinceLoss = J.IntN(m, "loss"), SincePurchase = J.IntN(m, "purchase"), SinceRefund = J.IntN(m, "refund"),
                SinceError = J.IntN(m, "error"), SinceMaintenanceNotice = J.IntN(m, "maintenanceNotice"),
                History = J.List(o, "history", x => x.AsLong()),
            };
        }
    }

    public sealed class ReviewDecision
    {
        public bool Show;
        /// <summary>The first reason that applied (§59.3), or null when it shows.</summary>
        public string Reason;
        /// <summary>soft | native when it shows; null otherwise.</summary>
        public string Style;
    }

    /// <summary>REQ-REV-003: the same pure rule as the server's decideReviewPrompt (shared vectors).</summary>
    public static class ReviewPromptPolicy
    {
        public const long DayMs = 86_400_000L;
        public static readonly string[] Reasons =
        {
            "disabled", "moment", "account_closing", "ftue", "session", "maintenance", "refund", "purchase", "error", "loss",
            "too_new", "too_few_races", "year_cap", "cool_down",
        };

        static bool Within(int? since, int quiet) => since.HasValue && since.Value < quiet;
        static ReviewDecision No(string reason) => new ReviewDecision { Show = false, Reason = reason };

        public static ReviewDecision Decide(ReviewPromptRules r, ReviewPromptSummary x)
        {
            if (r == null || !r.Enabled) return No("disabled");
            if (x.Moment == null || !r.Moments.Contains(x.Moment)) return No("moment");
            if (x.AccountClosing) return No("account_closing");
            if (x.InFtue) return No("ftue");
            if (x.SessionPrompted) return No("session");
            if (x.MaintenanceVisible || Within(x.SinceMaintenanceNotice, r.Quiet("maintenanceNotice"))) return No("maintenance");
            if (x.CoinDebt || Within(x.SinceRefund, r.Quiet("refund"))) return No("refund");
            if (Within(x.SincePurchase, r.Quiet("purchase"))) return No("purchase");
            if (Within(x.SinceError, r.Quiet("error"))) return No("error");
            if (Within(x.SinceLoss, r.Quiet("loss"))) return No("loss");
            if (FloorDiv(x.Now - x.InstalledAt, DayMs) < r.MinDaysSinceInstall) return No("too_new");
            if (x.RacesPlayed < r.MinRacesPlayed) return No("too_few_races");
            var recent = x.History.Where(at => x.Now - at < 365 * DayMs).ToList();
            if (recent.Count >= r.MaxPerYear) return No("year_cap");
            if (recent.Any(at => x.Now - at < r.CoolDownDays * DayMs)) return No("cool_down");
            bool soft = x.Platform == "android" ? r.SoftAskAndroid : r.SoftAskIos;
            return new ReviewDecision { Show = true, Style = soft ? "soft" : "native" };
        }

        static long FloorDiv(long a, long b) => a >= 0 ? a / b : -((-a + b - 1) / b);
    }

    /// <summary>
    /// REQ-REV-010: the OS's own in-app review API (iOS AppStore.requestReview / SKStoreReviewController, Android Play In-App Review).
    /// Codex implements it with the store SDKs. The result is only "called": the OS never says whether it showed or what was rated,
    /// and nothing may be granted either way.
    /// </summary>
    public interface IStoreReview
    {
        /// <summary>False in the editor / on devices without the API: the game never asks then.</summary>
        bool Available { get; }
        /// <summary>ios | android | editor (the check's platform).</summary>
        string Platform { get; }
        /// <summary>Calls the OS API. Returns when the call was handed to the OS (not whether a sheet appeared).</summary>
        Task RequestReviewAsync(CancellationToken ct = default);
    }

    /// <summary>Editor / tests: never available, does nothing.</summary>
    public sealed class NullStoreReview : IStoreReview
    {
        public bool Available => false;
        public string Platform => "editor";
        public Task RequestReviewAsync(CancellationToken ct = default) => Task.CompletedTask;
    }

    /// <summary>POST /v1/review-prompt/check.</summary>
    public sealed class ReviewPromptCheck
    {
        public bool Show;
        public string Style, Reason, PromptId;
        internal static ReviewPromptCheck Parse(JsonNode o) => new ReviewPromptCheck
        {
            Show = J.Bool(o, "show"), Style = J.Str(o, "style"), Reason = J.Str(o, "reason"), PromptId = J.Str(o, "promptId"),
        };
    }

    /// <summary>POST /v1/review-prompt/:promptId/answer.</summary>
    public sealed class ReviewPromptAnswer
    {
        public string PromptId;
        /// <summary>store_review | help_inquiry | none</summary>
        public string Next;
        /// <summary>"other" with help_inquiry (§48), else null.</summary>
        public string HelpCategory;
        internal static ReviewPromptAnswer Parse(JsonNode o) => new ReviewPromptAnswer { PromptId = J.Str(o, "promptId"), Next = J.Str(o, "next"), HelpCategory = J.Str(o, "helpCategory") };
    }

    /// <summary>GET /v1/review-prompt: the rules and the server's facts for the device's pre-check.</summary>
    public sealed class ReviewPromptStatus
    {
        public ReviewPromptRules Rules;
        public int Count365;
        public long? LastAt;
        public long InstalledAt;
        public int RacesPlayed;
        public bool InFtue, AccountClosing, MaintenanceVisible, CoinDebt;
        public int? MinutesSincePurchase, MinutesSinceRefund;
        public string LastSessionId;
        public List<long> History = new List<long>();
        internal static ReviewPromptStatus Parse(JsonNode o)
        {
            var h = J.Opt(o, "history");
            var s = J.Opt(o, "serverSummary");
            return new ReviewPromptStatus
            {
                Rules = ReviewPromptRules.Parse(J.Opt(o, "rules")), Count365 = J.Int(h, "count365"), LastAt = J.LongN(h, "lastAt"),
                InstalledAt = J.Long(s, "installedAt"), RacesPlayed = J.Int(s, "racesPlayed"), InFtue = J.Bool(s, "inFtue"),
                AccountClosing = J.Bool(s, "accountClosing"), MaintenanceVisible = J.Bool(s, "maintenanceVisible"), CoinDebt = J.Bool(s, "coinDebt"),
                MinutesSincePurchase = J.IntN(s, "minutesSincePurchase"), MinutesSinceRefund = J.IntN(s, "minutesSinceRefund"),
                LastSessionId = J.Str(s, "lastSessionId"), History = J.List(s, "history", x => x.AsLong()),
            };
        }

        /// <summary>The summary the device can build now (its own facts added), for <see cref="ReviewPromptPolicy.Decide"/>.</summary>
        public ReviewPromptSummary Summary(string platform, string moment, long now, string sessionId, bool sessionPrompted, bool inFtue, int? sinceLoss, int? sinceError, int? sinceNotice) => new ReviewPromptSummary
        {
            Platform = platform, Moment = moment, Now = now, InstalledAt = InstalledAt, RacesPlayed = RacesPlayed,
            InFtue = InFtue || inFtue, AccountClosing = AccountClosing, SessionPrompted = sessionPrompted || (LastSessionId != null && LastSessionId == sessionId),
            MaintenanceVisible = MaintenanceVisible, CoinDebt = CoinDebt,
            SinceLoss = sinceLoss, SincePurchase = MinutesSincePurchase, SinceRefund = MinutesSinceRefund, SinceError = sinceError, SinceMaintenanceNotice = sinceNotice,
            History = new List<long>(History),
        };
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-REV-005: the rules and the server's facts (a read).</summary>
        public Task<ReviewPromptStatus> GetReviewPromptAsync(CancellationToken ct = default)
            => Call("GET", "/v1/review-prompt", null, true, null, true, ReviewPromptStatus.Parse, ct);

        /// <summary>
        /// REQ-REV-005/006: whether to ask now. The server records (and counts) only a yes; the same key returns the same answer.
        /// Minutes since the last loss / error dialog / maintenance notice on this device: null = none this session.
        /// </summary>
        public Task<ReviewPromptCheck> CheckReviewPromptAsync(string moment, string platform, string sessionId, bool inFtue, int? minutesSinceLoss, int? minutesSinceError, int? minutesSinceMaintenanceNotice, string idempotencyKey = null, CancellationToken ct = default)
        {
            JsonNode N(int? v) => v.HasValue ? JsonNode.Num(Math.Max(0, Math.Min(v.Value, 525_600))) : JsonNode.Null();
            var b = JsonNode.Obj().Set("moment", moment).Set("platform", platform).Set("sessionId", sessionId)
                .Set("client", JsonNode.Obj().Set("inFtue", inFtue).Set("minutesSinceLoss", N(minutesSinceLoss)).Set("minutesSinceError", N(minutesSinceError)).Set("minutesSinceMaintenanceNotice", N(minutesSinceMaintenanceNotice)));
            return Call("POST", "/v1/review-prompt/check", b, true, idempotencyKey ?? NewIdempotencyKey(), true, ReviewPromptCheck.Parse, ct);
        }

        /// <summary>REQ-REV-007: soft_yes | soft_no | soft_dismiss | native_requested (each written once; safe to retry).</summary>
        public Task<ReviewPromptAnswer> AnswerReviewPromptAsync(string promptId, string step, CancellationToken ct = default)
            => Call("POST", "/v1/review-prompt/" + Seg(promptId) + "/answer", JsonNode.Obj().Set("step", step), true, null, true, ReviewPromptAnswer.Parse, ct);
    }
}
