using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-SURVEY-001..024 ゲーム内アンケート — ops-run in-app surveys (server/src/domain/surveys.ts, contracts/protocol.md §69).
    // The server decides which survey (at most one) the quiet お知らせ row offers (R22 integration: no home card, no sheet after a result) and keeps the
    // player's answers; the device only draws it, checks an answer with the same rules before sending it (SurveyAnswerBuilder)
    // and keeps one idempotency key per answer set. NOTHING is granted for answering: no reward type, field or call exists here.
    // Skipping is one tap and that survey never comes back. Never during the FTUE; never an interruption (not in the §58.11
    // prompt table): the player opens it from the row (Muchi.Game.SurveyModel).

    public static class SurveyKinds
    {
        public const string Single = "single", Multi = "multi", Scale = "scale", Text = "text";
        public static readonly string[] All = { Single, Multi, Scale, Text };
    }

    public static class SurveyPlacements
    {
        /// <summary>R22 integration: the one place — a quiet row inside お知らせ (no home card, no sheet after a result).</summary>
        public const string Inbox = "inbox";
        public static readonly string[] All = { Inbox };
    }

    /// <summary>Fixed limits shared with the server (§69.1).</summary>
    public static class SurveyRules
    {
        public const int MaxQuestions = 5, ScaleMin = 1, ScaleMax = 5, MaxTextLength = 200;
        /// <summary>The offer reasons in the server's order (§69.4); null reason = a survey to show.</summary>
        public static readonly string[] Reasons = { "disabled", "account_closing", "ftue", "cool_down", "none" };
        /// <summary>Characters as the server counts them (Unicode code points).</summary>
        public static int Length(string s)
        {
            if (string.IsNullOrEmpty(s)) return 0;
            int n = 0;
            for (int i = 0; i < s.Length; i++) { n++; if (char.IsHighSurrogate(s[i]) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1])) i++; }
            return n;
        }
    }

    public sealed class SurveyOption
    {
        public string Id, Text;
        internal static SurveyOption Parse(JsonNode o) => new SurveyOption { Id = J.Str(o, "id"), Text = J.Str(o, "text") };
    }

    /// <summary>One question, already in the request's language.</summary>
    public sealed class SurveyQuestion
    {
        public string Id, Kind, Text;
        public bool Required;
        public List<SurveyOption> Options = new List<SurveyOption>();
        /// <summary>multi only.</summary>
        public int? MaxChoices;
        /// <summary>scale only: the words at 1 and 5.</summary>
        public string LowLabel, HighLabel;
        /// <summary>text only.</summary>
        public int? MaxLength;
        internal static SurveyQuestion Parse(JsonNode o)
        {
            var l = J.Opt(o, "labels");
            return new SurveyQuestion
            {
                Id = J.Str(o, "id"), Kind = J.Str(o, "kind"), Text = J.Str(o, "text"), Required = J.Bool(o, "required"),
                Options = J.Opt(o, "options") != null ? J.List(o, "options", SurveyOption.Parse) : new List<SurveyOption>(),
                MaxChoices = J.IntN(o, "maxChoices"), LowLabel = J.Str(l, "low"), HighLabel = J.Str(l, "high"), MaxLength = J.IntN(o, "maxLength"),
            };
        }
    }

    public sealed class SurveyView
    {
        public string Id, Title, Intro, Placement;
        public int Rev;
        public long EndAt;
        public List<SurveyQuestion> Questions = new List<SurveyQuestion>();
        public SurveyQuestion Question(string id) => Questions.FirstOrDefault(q => q.Id == id);
        internal static SurveyView Parse(JsonNode o) => o == null ? null : new SurveyView
        {
            Id = J.Str(o, "id"), Rev = J.Int(o, "rev"), Title = J.Str(o, "title"), Intro = J.Str(o, "intro"), Placement = J.Str(o, "placement"),
            EndAt = J.Long(o, "endAt"), Questions = J.List(o, "questions", SurveyQuestion.Parse),
        };
    }

    /// <summary>GET /v1/surveys/current: the survey to show here, or the reason there is none.</summary>
    public sealed class SurveyOffer
    {
        public SurveyView Survey;
        public string Reason;
        /// <summary>Never opened yet: a small dot on the お知らせ row (never a home badge).</summary>
        public bool Unread;
        internal static SurveyOffer Parse(JsonNode o) => new SurveyOffer { Survey = SurveyView.Parse(J.Opt(o, "survey")), Reason = J.Str(o, "reason"), Unread = J.Bool(o, "unread") };
    }

    /// <summary>shown / skip / answers.</summary>
    public sealed class SurveyActionResult
    {
        public string SurveyId, Outcome;
        public long At;
        public int Shows;
        internal static SurveyActionResult Parse(JsonNode o) => new SurveyActionResult { SurveyId = J.Str(o, "surveyId"), Outcome = J.Str(o, "outcome"), At = J.Long(o, "at"), Shows = J.Int(o, "shows") };
    }

    /// <summary>
    /// REQ-SURVEY-009 on the device: collects the answers question by question with the server's rules (an option of the
    /// question, at most MaxChoices, 1..5, text at most MaxLength; required questions present). <see cref="Problems"/> is empty
    /// when <see cref="ToJson"/> would pass the server's strict check. Whitespace-only text counts as no answer.
    /// </summary>
    public sealed class SurveyAnswerBuilder
    {
        private readonly SurveyView _s;
        private readonly Dictionary<string, object> _a = new Dictionary<string, object>();
        public SurveyAnswerBuilder(SurveyView survey) { _s = survey ?? throw new ArgumentNullException(nameof(survey)); }

        private SurveyQuestion Q(string id, string kind)
        {
            var q = _s.Question(id) ?? throw new ArgumentException("unknown question " + id);
            if (q.Kind != kind) throw new ArgumentException(id + " is a " + q.Kind + " question");
            return q;
        }
        public SurveyAnswerBuilder Choose(string questionId, string optionId)
        {
            var q = Q(questionId, SurveyKinds.Single);
            if (q.Options.All(o => o.Id != optionId)) throw new ArgumentException("unknown option " + optionId);
            _a[questionId] = optionId; return this;
        }
        /// <summary>multi: toggles one option; returns false (no change) when it would go over MaxChoices.</summary>
        public bool Toggle(string questionId, string optionId)
        {
            var q = Q(questionId, SurveyKinds.Multi);
            if (q.Options.All(o => o.Id != optionId)) throw new ArgumentException("unknown option " + optionId);
            var cur = _a.TryGetValue(questionId, out var v) ? new List<string>((List<string>)v) : new List<string>();
            if (cur.Contains(optionId)) cur.Remove(optionId);
            else { if (cur.Count >= (q.MaxChoices ?? q.Options.Count)) return false; cur.Add(optionId); }
            if (cur.Count == 0) _a.Remove(questionId);
            else _a[questionId] = q.Options.Select(o => o.Id).Where(cur.Contains).ToList(); // the definition's order
            return true;
        }
        public SurveyAnswerBuilder Scale(string questionId, int value)
        {
            Q(questionId, SurveyKinds.Scale);
            if (value < SurveyRules.ScaleMin || value > SurveyRules.ScaleMax) throw new ArgumentOutOfRangeException(nameof(value));
            _a[questionId] = value; return this;
        }
        /// <summary>text: kept as typed (the server scrubs emails, URLs, long numbers…); blank clears it.</summary>
        public SurveyAnswerBuilder Text(string questionId, string text)
        {
            Q(questionId, SurveyKinds.Text);
            if (string.IsNullOrWhiteSpace(text)) _a.Remove(questionId); else _a[questionId] = text;
            return this;
        }
        public SurveyAnswerBuilder Clear(string questionId) { _a.Remove(questionId); return this; }
        public bool Has(string questionId) => _a.ContainsKey(questionId);
        public object Value(string questionId) => _a.TryGetValue(questionId, out var v) ? v : null;
        /// <summary>Characters left for a text question (negative = too long).</summary>
        public int Remaining(string questionId)
        {
            var q = Q(questionId, SurveyKinds.Text);
            return (q.MaxLength ?? SurveyRules.MaxTextLength) - SurveyRules.Length(Value(questionId) as string);
        }

        public List<string> Problems()
        {
            var p = new List<string>();
            foreach (var q in _s.Questions)
            {
                if (!_a.TryGetValue(q.Id, out var v)) { if (q.Required) p.Add(q.Id + " is required"); continue; }
                if (q.Kind == SurveyKinds.Text && SurveyRules.Length((string)v) > Math.Min(q.MaxLength ?? SurveyRules.MaxTextLength, SurveyRules.MaxTextLength)) p.Add(q.Id + " is too long");
            }
            return p;
        }
        public bool Complete => Problems().Count == 0;
        /// <summary>The answer count (KPI-free; for the progress line only).</summary>
        public int Count => _a.Count;

        public JsonNode ToJson()
        {
            var o = JsonNode.Obj();
            foreach (var q in _s.Questions)
            {
                if (!_a.TryGetValue(q.Id, out var v)) continue;
                if (v is int n) o.Set(q.Id, n);
                else if (v is List<string> xs) { var a = JsonNode.Arr(); foreach (var x in xs) a.Add(JsonNode.Str(x)); o.Set(q.Id, a); }
                else o.Set(q.Id, (string)v);
            }
            return o;
        }
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-SURVEY-005: the one survey to show at <paramref name="placement"/> (always inbox: the お知らせ row), or why none (a read).</summary>
        public Task<SurveyOffer> GetSurveyAsync(string placement, CancellationToken ct = default)
            => Call("GET", "/v1/surveys/current?placement=" + Uri.EscapeDataString(placement), null, true, null, true, SurveyOffer.Parse, ct);

        /// <summary>REQ-SURVEY-007: the survey is on screen (counts the show; makes it the current one).</summary>
        public Task<SurveyActionResult> SurveyShownAsync(string surveyId, string placement, CancellationToken ct = default)
            => Call("POST", "/v1/surveys/" + Seg(surveyId) + "/shown", JsonNode.Obj().Set("placement", placement), true, null, false, SurveyActionResult.Parse, ct);

        /// <summary>REQ-SURVEY-008: one tap; that survey never comes back (safe to retry).</summary>
        public Task<SurveyActionResult> SkipSurveyAsync(string surveyId, string placement, CancellationToken ct = default)
            => Call("POST", "/v1/surveys/" + Seg(surveyId) + "/skip", JsonNode.Obj().Set("placement", placement), true, null, true, SurveyActionResult.Parse, ct);

        /// <summary>
        /// REQ-SURVEY-009: send the answers once. Make <paramref name="idempotencyKey"/> once per answer set and reuse it on every
        /// retry (the same key returns the same result). SURVEY_CLOSED (409) = the survey ended: close the sheet quietly.
        /// </summary>
        public Task<SurveyActionResult> AnswerSurveyAsync(string surveyId, string placement, SurveyAnswerBuilder answers, string idempotencyKey, CancellationToken ct = default)
        {
            if (answers == null) throw new ArgumentNullException(nameof(answers));
            var b = JsonNode.Obj().Set("placement", placement).Set("answers", answers.ToJson());
            return Call("POST", "/v1/surveys/" + Seg(surveyId) + "/answers", b, true, idempotencyKey ?? NewIdempotencyKey(), true, SurveyActionResult.Parse, ct);
        }
    }
}
