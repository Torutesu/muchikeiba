using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-SURVEY-001..024 (contracts/protocol.md §69, docs/handoff-codex-round22-surveys.md): ゲーム内アンケート, the game layer.
    // Pure C#: Codex calls CheckAsync("home") when the home screen settles and CheckAsync("result") after a race result is
    // closed, then draws the home card (CardVisible) or the sheet (SheetVisible: one question per page, Index / Current) and the
    // thanks state (ThanksVisible). Skip is one tap from the card or any page of the sheet and that survey never comes back.
    // Nothing is granted for answering: this model has no reward, coins or shop link. Never offline, never during the FTUE, and
    // only through the §58.11 one-prompt-per-session gate (SessionPrompts.Survey, the lowest priority).

    public sealed class SurveyModel : ScreenModel
    {
        public const string Kicker = "アンケート";
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

        /// <summary>R22 integration (§58.11): the session's ONE prompt mechanism (the same instance every model gets); a survey is `survey`, the lowest.</summary>
        public SessionPrompts Prompts { get; set; }
        public SurveyView Survey { get; private set; }
        /// <summary>home | result.</summary>
        public string Placement { get; private set; }
        public bool CardVisible { get; private set; }
        public bool SheetVisible { get; private set; }
        public bool ThanksVisible { get; private set; }
        /// <summary>The page of the sheet (0-based question index).</summary>
        public int Index { get; private set; }
        public SurveyAnswerBuilder Answers { get; private set; }
        /// <summary>Why no survey showed: a §69.4 reason, or offline / ftue / session_prompt / busy / shown.</summary>
        public string LastReason { get; private set; }
        /// <summary>A survey was shown this session (no second one).</summary>
        public bool ShownThisSession { get; private set; }

        public SurveyQuestion Current => Survey != null && Index >= 0 && Index < Survey.Questions.Count ? Survey.Questions[Index] : null;
        public bool IsLast => Survey != null && Index == Survey.Questions.Count - 1;
        /// <summary>"2 / 4" (after Loc nothing to translate).</summary>
        public string Progress => Survey == null ? "" : (Index + 1) + " / " + Survey.Questions.Count;
        /// <summary>The current page may move on: answered, or optional (then the button reads とばす).</summary>
        public bool CanNext => Current != null && (!Current.Required || Answers.Has(Current.Id)) && TextFits;
        public string NextButton => Current != null && !Answers.Has(Current.Id) && !Current.Required ? PassLabel : IsLast ? SendLabel : NextLabel;
        private bool TextFits => Current == null || Current.Kind != SurveyKinds.Text || Answers.Remaining(Current.Id) >= 0;

        private bool Skip(string reason) { LastReason = reason; return false; }

        /// <summary>REQ-SURVEY-005/006: ask the server whether a survey shows at <paramref name="placement"/>; true = drawn now.</summary>
        public async Task<bool> CheckAsync(string placement, CancellationToken ct = default)
        {
            LastReason = null;
            if (placement != SurveyPlacements.Home && placement != SurveyPlacements.Result) throw new ArgumentException("placement " + placement);
            if (_busy || CardVisible || SheetVisible || ThanksVisible) return Skip("busy");
            if (ShownThisSession) return Skip("shown");
            if (!ServerAvailable) return Skip("offline");
            if (_inFtue()) return Skip("ftue");
            if (Prompts != null && !Prompts.CanShow(SessionPrompts.Survey)) return Skip("session_prompt");
            _busy = true;
            try
            {
                var o = await B.Api.GetSurveyAsync(placement, ct);
                if (o.Survey == null) return Skip(o.Reason ?? "none");
                // another prompt may have claimed the session while we waited
                if (Prompts != null && !Prompts.TryClaim(SessionPrompts.Survey)) return Skip("session_prompt");
                Survey = o.Survey; Placement = placement; Index = 0; Answers = new SurveyAnswerBuilder(o.Survey);
                ShownThisSession = true;
                if (placement == SurveyPlacements.Home) CardVisible = true; else SheetVisible = true;
                try { await B.Api.SurveyShownAsync(Survey.Id, placement, ct); } catch (ApiException e) { Message = e.Message; } // the count is best effort
                return true;
            }
            catch (ApiException e) { Message = e.Message; return Skip("error"); }
            finally { _busy = false; }
        }

        /// <summary>The home card's 答える: open the sheet on the first question.</summary>
        public void Open()
        {
            if (!CardVisible) return;
            CardVisible = false; SheetVisible = true; Index = 0;
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
        /// The sheet / card closed without skipping (back button): it may come back later (the server stops after
        /// maxShowsPerSurvey shows). Nothing is sent.
        /// </summary>
        public void Later() { CardVisible = false; SheetVisible = false; }

        /// <summary>REQ-SURVEY-008: one tap; that survey never comes back. The card / sheet closes at once (offline too).</summary>
        public async Task<ActionResult> SkipAsync(CancellationToken ct = default)
        {
            if (Survey == null || !(CardVisible || SheetVisible)) return ActionResult.Error("no survey");
            var id = Survey.Id;
            var placement = Placement;
            CardVisible = false; SheetVisible = false;
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
                SheetVisible = false; ThanksVisible = true;
                return ActionResult.Success();
            }
            catch (ApiException e) when (e.Code == ApiErrorCode.SurveyClosed || e.Code == ApiErrorCode.NotFound || e.Code == ApiErrorCode.NotEligible || e.Code == ApiErrorCode.Conflict)
            {
                // neutral: the survey ended / is not for this player any more / was already answered on another device
                Kv.Set(k, null);
                SheetVisible = false;
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
            CardVisible = SheetVisible = ThanksVisible = false;
            Survey = null; Answers = null; Index = 0; Placement = null; LastReason = null; ShownThisSession = false; Message = null;
        }
    }
}
