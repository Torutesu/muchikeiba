using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-SURVEY-001..024 (contracts/protocol.md §69, docs/handoff-codex-round22-surveys.md): ゲーム内アンケート, the game layer.
    // R22 integration (the user's change): a survey never interrupts and never sits in a prominent place. The only entry is a
    // quiet row inside お知らせ (the home bell's screen): Codex calls CheckAsync() when that screen opens and draws the row
    // (RowVisible, with a small dot when Unread — never a badge or count on the home screen). The player taps it → OpenAsync()
    // → the sheet (SheetVisible: one question per page, Index / Current) → the thanks state (ThanksVisible). Skip is one tap from
    // any page and that survey never comes back. Not in the §58.11 prompt table (it neither takes nor waits for the session's
    // one prompt). Nothing is granted for answering: no reward, coins or shop link. Never offline, never during the FTUE.

    public sealed class SurveyModel : ScreenModel
    {
        public const string Kicker = "アンケート";
        /// <summary>R22 integration: the quiet row on the お知らせ screen (the only entry).</summary>
        public const string RowLabel = "アンケートにご協力ください";
        public const string AnswerLabel = "答える";
        public const string SkipLabel = "スキップ";
        public const string NextLabel = "次へ";
        public const string BackLabel = "戻る";
        public const string PassLabel = "とばす";
        public const string SendLabel = "送る";
        public const string OptionalNote = "任意";
        public const string NoRewardNote = "答えても何ももらえません。ゲームの内容も変わりません。";
        public const string ThanksTitle = "ありがとうございました";
        public const string ThanksBody = "いただいた声は、これからのムチ一閃づくりに使います。";
        public const string ClosedText = "このアンケートは終了しました";
        public const string CloseLabel = "閉じる";
        public const string TextHint = "名前やメールアドレスなどは書かないでください";
        /// <summary>string.Format with the max choices (after Loc.T).</summary>
        public const string ChoicesFormat = "{0}つまで選べます";
        /// <summary>string.Format with the characters left (after Loc.T).</summary>
        public const string RemainingFormat = "あと{0}文字";

        private readonly Func<bool> _inFtue;
        private bool _busy;
        private const string KeyPrefix = "muchi.survey.key.";

        public SurveyModel(GameBackend backend, Func<bool> inFtue = null, IKeyValueStore kv = null) : base(backend, kv ?? backend?.Store)
        {
            _inFtue = inFtue ?? (() => false);
        }

        public SurveyView Survey { get; private set; }
        /// <summary>Always <see cref="SurveyPlacements.Inbox"/> (the お知らせ row).</summary>
        public string Placement => SurveyPlacements.Inbox;
        /// <summary>The お知らせ screen shows the row 「アンケートにご協力ください ›」.</summary>
        public bool RowVisible { get; private set; }
        /// <summary>Never opened yet: a small dot next to the row on the お知らせ screen only (no home badge, not in the bell's count).</summary>
        public bool Unread { get; private set; }
        public bool SheetVisible { get; private set; }
        public bool ThanksVisible { get; private set; }
        /// <summary>The page of the sheet (0-based question index).</summary>
        public int Index { get; private set; }
        public SurveyAnswerBuilder Answers { get; private set; }
        /// <summary>Why no row shows: a §69.4 reason, or offline / ftue / busy / error.</summary>
        public string LastReason { get; private set; }

        public SurveyQuestion Current => Survey != null && Index >= 0 && Index < Survey.Questions.Count ? Survey.Questions[Index] : null;
        public bool IsLast => Survey != null && Index == Survey.Questions.Count - 1;
        /// <summary>"2 / 4" (after Loc nothing to translate).</summary>
        public string Progress => Survey == null ? "" : (Index + 1) + " / " + Survey.Questions.Count;
        /// <summary>The current page may move on: answered, or optional (then the button reads とばす).</summary>
        public bool CanNext => Current != null && (!Current.Required || Answers.Has(Current.Id)) && TextFits;
        public string NextButton => Current != null && !Answers.Has(Current.Id) && !Current.Required ? PassLabel : IsLast ? SendLabel : NextLabel;
        private bool TextFits => Current == null || Current.Kind != SurveyKinds.Text || Answers.Remaining(Current.Id) >= 0;

        private bool Skip(string reason) { LastReason = reason; RowVisible = false; Unread = false; return false; }

        /// <summary>REQ-SURVEY-005/006: the お知らせ screen opened — is there a survey for its quiet row? true = draw the row (a read; nothing is counted).</summary>
        public async Task<bool> CheckAsync(CancellationToken ct = default)
        {
            LastReason = null;
            if (_busy || SheetVisible || ThanksVisible) { LastReason = "busy"; return RowVisible; }
            if (!ServerAvailable) return Skip("offline");
            if (_inFtue()) return Skip("ftue");
            _busy = true;
            try
            {
                var o = await B.Api.GetSurveyAsync(SurveyPlacements.Inbox, ct);
                if (o.Survey == null) { Survey = null; return Skip(o.Reason ?? "none"); }
                Survey = o.Survey; Index = 0; Answers = new SurveyAnswerBuilder(o.Survey);
                RowVisible = true; Unread = o.Unread;
                return true;
            }
            catch (ApiException e) { Message = e.Message; return Skip("error"); }
            finally { _busy = false; }
        }

        /// <summary>The player tapped the row: open the sheet on the first question and count the show (best effort).</summary>
        public async Task<bool> OpenAsync(CancellationToken ct = default)
        {
            if (!RowVisible || Survey == null || SheetVisible) return false;
            SheetVisible = true; Index = 0; Unread = false;
            try { await B.Api.SurveyShownAsync(Survey.Id, SurveyPlacements.Inbox, ct); } catch (ApiException e) { Message = e.Message; } // the count is best effort
            return true;
        }

        /// <summary>次へ / とばす on a page; on the last page use <see cref="SubmitAsync"/>.</summary>
        public bool Next()
        {
            if (!SheetVisible || !CanNext || IsLast) return false;
            Index++;
            return true;
        }
        public bool Back()
        {
            if (!SheetVisible || Index == 0) return false;
            Index--;
            return true;
        }

        /// <summary>
        /// The sheet closed without skipping (back button): the row stays in お知らせ (the server stops offering after
        /// maxShowsPerSurvey opens). Nothing is sent.
        /// </summary>
        public void Later() { SheetVisible = false; }

        /// <summary>REQ-SURVEY-008: one tap; that survey never comes back. The card / sheet closes at once (offline too).</summary>
        public async Task<ActionResult> SkipAsync(CancellationToken ct = default)
        {
            if (Survey == null || !SheetVisible) return ActionResult.Error("no survey");
            var id = Survey.Id;
            var placement = Placement;
            SheetVisible = false; RowVisible = false;
            if (!ServerAvailable) return Offline("skip"); // shown-but-unanswered: the server stops offering after its show cap
            try { await B.Api.SkipSurveyAsync(id, placement, ct); return ActionResult.Success(); }
            catch (ApiException e) { return Fail(e); }
        }

        /// <summary>
        /// REQ-SURVEY-009: send the answers once (one idempotency key per answer set, kept on the device so a retry after a crash
        /// is the same request). SURVEY_CLOSED closes the sheet quietly with <see cref="ClosedText"/>.
        /// </summary>
        public async Task<ActionResult> SubmitAsync(CancellationToken ct = default)
        {
            if (!SheetVisible || Survey == null) return ActionResult.Error("no survey");
            if (!Answers.Complete) return ActionResult.Error(string.Join("; ", Answers.Problems()));
            if (!ServerAvailable) return Offline("survey");
            if (_busy) return ActionResult.Error("busy");
            _busy = true;
            var k = KeyPrefix + Survey.Id;
            var key = Kv.Get(k);
            if (string.IsNullOrEmpty(key)) { key = "c:survey:" + Guid.NewGuid().ToString("N"); Kv.Set(k, key); }
            try
            {
                await B.Api.AnswerSurveyAsync(Survey.Id, Placement, Answers, key, ct);
                Kv.Set(k, null);
                SheetVisible = false; RowVisible = false; ThanksVisible = true;
                return ActionResult.Success();
            }
            catch (ApiException e) when (e.Code == ApiErrorCode.SurveyClosed || e.Code == ApiErrorCode.NotFound || e.Code == ApiErrorCode.NotEligible || e.Code == ApiErrorCode.Conflict)
            {
                // neutral: the survey ended / is not for this player any more / was already answered on another device
                Kv.Set(k, null);
                SheetVisible = false; RowVisible = false;
                Message = ClosedText;
                return ActionResult.Error(ClosedText);
            }
            catch (ApiException e) { return Fail(e); } // keep the sheet and the key: the player may send again
            finally { _busy = false; }
        }

        public void CloseThanks() { ThanksVisible = false; Survey = null; Answers = null; }

        /// <summary>A new session (launch, or another account on this device: §54).</summary>
        public void ResetSession()
        {
            RowVisible = Unread = SheetVisible = ThanksVisible = false;
            Survey = null; Answers = null; Index = 0; LastReason = null; Message = null;
        }
    }
}
