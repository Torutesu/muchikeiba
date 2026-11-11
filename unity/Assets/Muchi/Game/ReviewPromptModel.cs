using System;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-REV-001..016 (contracts/protocol.md §59, docs/handoff-codex-round20-review-prompt.md): レビュー依頼のタイミング, the game layer.
    // Pure C#: Codex calls OnMomentAsync after a happy moment's screen closes (first win result, first tournament ceremony, hall
    // induction ceremony, horse goal chain ribbon) and draws the soft pre-question sheet when SoftSheetVisible is true. The OS's
    // own review sheet comes from IStoreReview (Codex wires the store SDKs). Nothing is granted for a review, ever: this model has
    // no reward, no coins and no shop link, and never learns whether a review was written.

    /// <summary>What happened when a happy moment was offered.</summary>
    public enum ReviewOutcome
    {
        /// <summary>Not asked (see <see cref="ReviewPromptModel.LastReason"/>).</summary>
        Skipped,
        /// <summary>The OS's review API was called directly.</summary>
        NativeRequested,
        /// <summary>The soft pre-question sheet is up; wait for <see cref="ReviewPromptModel.AnswerSoftAsync"/>.</summary>
        SoftShown,
    }

    /// <summary>
    /// レビュー依頼. Rules the model keeps (the server is the judge; the model only avoids calls that are obviously no):
    ///  - never offline, never without the OS API (<see cref="IStoreReview.Available"/>), never during the FTUE, once per session;
    ///  - remembers this session's last loss, error dialog and maintenance notice (minutes since go to the server);
    ///  - native style: call the OS API at once and report native_requested;
    ///  - soft style (ops-configurable, default off, iOS only): はい → the OS API; いまいち → the help inquiry form (§48 "other"),
    ///    never the store; 閉じる → nothing more. Both buttons have the same size and weight.
    /// </summary>
    public sealed class ReviewPromptModel : ScreenModel
    {
        public const string SoftQuestion = "ムチ一閃を楽しんでいますか？";
        public const string YesLabel = "はい";
        public const string NoLabel = "いまいち";
        public const string CloseLabel = "閉じる";
        public const string SoftKicker = "ひとこと";
        public const string FeedbackLead = "ご意見をお聞かせください。お問い合わせの画面を開きます。";

        private readonly IStoreReview _store;
        private readonly Func<bool> _inFtue;
        private readonly NowMs _now;
        private long? _lossAt, _errorAt, _noticeAt;

        public ReviewPromptModel(GameBackend backend, IStoreReview store, Func<bool> inFtue = null, NowMs now = null, string sessionId = null, IKeyValueStore kv = null) : base(backend, kv ?? backend?.Store)
        {
            _store = store ?? new NullStoreReview();
            _inFtue = inFtue ?? (() => false);
            _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            SessionId = sessionId ?? ("s_" + Guid.NewGuid().ToString("N").Substring(0, 20));
        }

        /// <summary>One per app launch (a new model each launch).</summary>
        public string SessionId { get; private set; }
        /// <summary>R20 integration: the session's one-prompt gate (shared with ConsentModel and LocalNotificationModel).</summary>
        public SessionPromptGate Prompts { get; set; }

        /// <summary>
        /// R20 integration (§54): the account changed on this device (SESSION_REPLACED, a redeemed transfer code): a new session
        /// for the new account — a new session id, the session flag and this session's loss / error / notice times cleared.
        /// </summary>
        public void ResetSession()
        {
            SessionId = "s_" + Guid.NewGuid().ToString("N").Substring(0, 20);
            SessionPrompted = false; SoftSheetVisible = false; PromptId = null; Moment = null; Status = null; OpenInquiryCategory = null;
            _lossAt = _errorAt = _noticeAt = null;
        }
        public bool SessionPrompted { get; private set; }
        public ReviewPromptStatus Status { get; private set; }
        /// <summary>Why the last moment was not asked: a §59.3 reason, or offline / unavailable / busy.</summary>
        public string LastReason { get; private set; }
        public string PromptId { get; private set; }
        public string Moment { get; private set; }
        public bool SoftSheetVisible { get; private set; }
        /// <summary>Set after いまいち: open the help inquiry form with this category ("other"), then call <see cref="InquiryOpened"/>.</summary>
        public string OpenInquiryCategory { get; private set; }
        private bool _busy;

        /// <summary>Call when a race result shows a loss (place &gt; 1).</summary>
        public void NoteLoss() => _lossAt = _now();
        /// <summary>Call when an error dialog is shown.</summary>
        public void NoteError() => _errorAt = _now();
        /// <summary>Call when the maintenance notice / banner (§46) is shown.</summary>
        public void NoteMaintenanceNotice() => _noticeAt = _now();
        public void InquiryOpened() => OpenInquiryCategory = null;

        private int? Since(long? at) => at.HasValue ? (int?)Math.Max(0, Math.Min(525_600, (_now() - at.Value) / 60_000)) : null;

        /// <summary>REQ-REV-001/005: offer a happy moment. Returns what happened; never throws for server errors.</summary>
        public async Task<ReviewOutcome> OnMomentAsync(string moment, CancellationToken ct = default)
        {
            LastReason = null;
            if (_busy || SoftSheetVisible) return Skip("busy");
            if (!_store.Available) return Skip("unavailable");
            if (!ServerAvailable) return Skip("offline");
            if (SessionPrompted) return Skip("session");
            if (Prompts != null && !Prompts.CanShow(SessionPromptKind.Review)) return Skip("session_prompt"); // R20: consent / reminders sheet shown
            if (_inFtue()) return Skip("ftue");
            _busy = true;
            try
            {
                if (Status == null) Status = await B.Api.GetReviewPromptAsync(ct);
                var pre = ReviewPromptPolicy.Decide(Status.Rules, Status.Summary(_store.Platform, moment, _now(), SessionId, SessionPrompted, _inFtue(), Since(_lossAt), Since(_errorAt), Since(_noticeAt)));
                if (!pre.Show) return Skip(pre.Reason);
                var c = await B.Api.CheckReviewPromptAsync(moment, _store.Platform, SessionId, _inFtue(), Since(_lossAt), Since(_errorAt), Since(_noticeAt), null, ct);
                if (!c.Show) return Skip(c.Reason);
                SessionPrompted = true;
                Prompts?.Claim(SessionPromptKind.Review);
                PromptId = c.PromptId;
                Moment = moment;
                Status = null; // the history changed: fetch again next session's first moment
                if (c.Style == "soft") { SoftSheetVisible = true; return ReviewOutcome.SoftShown; }
                await RequestNativeAsync(ct);
                return ReviewOutcome.NativeRequested;
            }
            catch (ApiException e) { Message = e.Message; return Skip("error"); }
            finally { _busy = false; }
        }

        /// <summary>REQ-REV-007: the soft sheet's answer: "soft_yes" | "soft_no" | "soft_dismiss".</summary>
        public async Task<ActionResult> AnswerSoftAsync(string step, CancellationToken ct = default)
        {
            if (!SoftSheetVisible || PromptId == null) return ActionResult.Error("no pre-question");
            if (step != "soft_yes" && step != "soft_no" && step != "soft_dismiss") return ActionResult.Error("unknown answer " + step);
            SoftSheetVisible = false;
            try
            {
                var a = await B.Api.AnswerReviewPromptAsync(PromptId, step, ct);
                if (a.Next == "store_review") await RequestNativeAsync(ct);
                else if (a.Next == "help_inquiry") OpenInquiryCategory = a.HelpCategory ?? "other";
                return ActionResult.Success();
            }
            catch (ApiException e)
            {
                Message = e.Message;
                // offline after the sheet: いまいち still opens the inquiry form (it is how players reach support anyway)
                if (step == "soft_no") OpenInquiryCategory = "other";
                return ActionResult.Error(Message);
            }
        }

        private async Task RequestNativeAsync(CancellationToken ct)
        {
            await _store.RequestReviewAsync(ct);
            try { await B.Api.AnswerReviewPromptAsync(PromptId, "native_requested", ct); }
            catch (ApiException e) { Message = e.Message; } // the OS call happened; the record is best-effort
        }

        private ReviewOutcome Skip(string reason) { LastReason = reason; return ReviewOutcome.Skipped; }
    }
}
