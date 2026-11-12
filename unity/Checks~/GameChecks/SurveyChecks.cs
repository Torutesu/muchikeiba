// ゲーム内アンケート (REQ-SURVEY-005..011/022, contracts/protocol.md §69): SurveyModel over a routed fake server. Never offline /
// during the FTUE / after another prompt claimed the session (SessionPrompts.Survey, the lowest priority); the home card →
// the sheet (one question per page, とばす for optional ones), skip in one tap, submit once with one kept key (a retry after a
// network failure sends the same key), SURVEY_CLOSED closes quietly, an account change resets it, English, no reward words.
using System.Linq;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class SurveyChecks
{
    sealed class FakeServer : IHttp
    {
        public readonly List<HttpRequest> Sent = new List<HttpRequest>();
        public readonly Dictionary<string, Func<HttpRequest, HttpResponse>> Routes = new Dictionary<string, Func<HttpRequest, HttpResponse>>();
        public Task<HttpResponse> SendAsync(HttpRequest r, CancellationToken ct)
        {
            Sent.Add(r);
            if (Routes.TryGetValue(r.Method + " " + r.Path, out var h)) return Task.FromResult(h(r));
            return Task.FromResult(new HttpResponse(404, "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"no route\"}}"));
        }
    }
    sealed class Tokens : IAuthTokenProvider { public Task<string> GetTokenAsync(bool f, CancellationToken ct) => Task.FromResult("tok"); }

    const string Player = "{\"id\":\"g\",\"wallet\":{\"paid\":0,\"free\":0,\"total\":0,\"debt\":0},\"season\":{\"id\":\"2026-12\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[],\"equipment\":{\"tack\":{},\"decor\":[]},\"deletion\":{\"status\":\"none\"}}";
    static string Offer(string placement) => "{\"reason\":null,\"survey\":{\"id\":\"sv_whip_feel\",\"rev\":1,\"placement\":\"" + placement + "\",\"endAt\":1796698800000,\"title\":\"ムチの手ごたえ\",\"intro\":null,\"questions\":["
        + "{\"id\":\"feel\",\"kind\":\"scale\",\"required\":true,\"text\":\"手ごたえは？\",\"options\":null,\"maxChoices\":null,\"labels\":{\"low\":\"弱い\",\"high\":\"強い\"},\"maxLength\":null},"
        + "{\"id\":\"wish\",\"kind\":\"multi\",\"required\":false,\"text\":\"増えてほしいものは？\",\"options\":[{\"id\":\"tracks\",\"text\":\"コース\"},{\"id\":\"events\",\"text\":\"イベント\"}],\"maxChoices\":1,\"labels\":null,\"maxLength\":null},"
        + "{\"id\":\"free\",\"kind\":\"text\",\"required\":false,\"text\":\"ひとことあれば\",\"options\":null,\"maxChoices\":null,\"labels\":null,\"maxLength\":20}]}}";

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset, string root)
    {
        var s = new FakeServer();
        string placementAsked = null;
        bool none = false;
        s.Routes["POST /v1/player/bootstrap"] = _ => new HttpResponse(200, Player);
        s.Routes["GET /v1/player"] = _ => new HttpResponse(200, Player);
        foreach (var p in SurveyPlacements.All)
        {
            var pl = p;
            s.Routes["GET /v1/surveys/current?placement=" + pl] = _ => { placementAsked = pl; return new HttpResponse(200, none ? "{\"survey\":null,\"reason\":\"cool_down\"}" : Offer(pl)); };
        }
        s.Routes["POST /v1/surveys/sv_whip_feel/shown"] = _ => new HttpResponse(200, "{\"surveyId\":\"sv_whip_feel\",\"shows\":1,\"done\":null}");
        s.Routes["POST /v1/surveys/sv_whip_feel/skip"] = _ => new HttpResponse(200, "{\"surveyId\":\"sv_whip_feel\",\"outcome\":\"skipped\",\"at\":1}");
        var keys = new List<string>();
        int answerMode = 0; // 0 ok, 1 network failure (5xx), 2 closed
        s.Routes["POST /v1/surveys/sv_whip_feel/answers"] = r =>
        {
            keys.Add(r.Headers.TryGetValue("idempotency-key", out var k) ? k : null);
            if (answerMode == 1) return new HttpResponse(503, "{\"error\":{\"code\":\"INTERNAL\",\"message\":\"down\"}}");
            if (answerMode == 2) return new HttpResponse(409, "{\"error\":{\"code\":\"SURVEY_CLOSED\",\"message\":\"this survey has ended\"}}");
            return new HttpResponse(200, "{\"surveyId\":\"sv_whip_feel\",\"outcome\":\"answered\",\"at\":1}");
        };
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, new MemoryKeyValueStore(), ruleset);
        await b.InitializeAsync();
        int Gets() => s.Sent.Count(r => r.Path.StartsWith("/v1/surveys/current"));

        // offline / FTUE / another prompt this session: nothing is asked
        var off = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, null, null, new MemoryKeyValueStore(), ruleset);
        var m0 = new SurveyModel(off);
        check(!await m0.CheckAsync("home") && m0.LastReason == "offline", "survey: offline → not shown");
        bool ftue = true;
        var gate = new SessionPrompts(); // R22 integration: the one §58.11 mechanism
        var m1 = new SurveyModel(b, () => ftue) { Prompts = gate };
        check(!await m1.CheckAsync("home") && m1.LastReason == "ftue" && Gets() == 0, "survey: during the FTUE → not asked (no request)");
        ftue = false;
        gate.TryClaim(SessionPrompts.ReviewPrompt);
        check(!await m1.CheckAsync("result") && m1.LastReason == "session_prompt" && Gets() == 0, "survey: the review showed this session → no survey (§58.11)");
        check(gate.Pick(new[] { SessionPrompts.ReviewPrompt, SessionPrompts.Survey }) == SessionPrompts.ReviewPrompt
            && new SessionPrompts().Pick(new[] { SessionPrompts.Survey, SessionPrompts.RemindersPrePermission }) == SessionPrompts.RemindersPrePermission
            && new SessionPrompts().Pick(new[] { SessionPrompts.Survey, SessionPrompts.PromotionOutcome }) == SessionPrompts.PromotionOutcome
            && new SessionPrompts().Pick(new[] { SessionPrompts.Survey }) == SessionPrompts.Survey
            && !new SessionPrompts().TryClaim(SessionPrompts.Survey, new[] { SessionPrompts.ReviewPrompt }),
            "survey: the one table puts the survey last (§58.11)");
        gate.NewSession();

        // the home card → the sheet; required / optional pages; the card claims the session
        check(await m1.CheckAsync("home") && m1.CardVisible && !m1.SheetVisible && placementAsked == "home" && gate.Claimed == SessionPrompts.Survey, "survey: home card shown and claims the session");
        check(s.Sent.Any(r => r.Path == "/v1/surveys/sv_whip_feel/shown"), "survey: the show is reported");
        check(!await m1.CheckAsync("result") && m1.LastReason == "busy", "survey: one at a time");
        m1.Open();
        check(m1.SheetVisible && m1.Index == 0 && m1.Progress == "1 / 3" && !m1.CanNext && m1.NextButton == SurveyModel.NextLabel, "survey: the sheet opens on a required question (次へ disabled)");
        m1.Answers.Scale("feel", 5);
        check(m1.Next() && m1.Current.Id == "wish" && m1.NextButton == SurveyModel.PassLabel, "survey: an optional question offers とばす");
        check(m1.Answers.Toggle("wish", "events") && !m1.Answers.Toggle("wish", "tracks"), "survey: maxChoices respected");
        check(m1.Next() && m1.IsLast && m1.NextButton == SurveyModel.PassLabel, "survey: the last (free text) page");
        m1.Answers.Text("free", "あ".PadRight(21, 'あ'));
        check(!m1.CanNext && m1.Answers.Remaining("free") == -1, "survey: text over maxLength blocks sending");
        m1.Answers.Text("free", "音が好き");
        // a network failure keeps the sheet and the key; the retry sends the same key
        answerMode = 1;
        var f = await m1.SubmitAsync();
        check(!f.Ok && m1.SheetVisible && keys.Count == 1, "survey: a failed send keeps the sheet");
        answerMode = 0;
        var ok = await m1.SubmitAsync();
        check(ok.Ok && m1.ThanksVisible && !m1.SheetVisible && keys.Count == 2 && keys[0] == keys[1] && keys[0].StartsWith("c:"), "survey: the retry sends the same idempotency key; thanks");
        var body = s.Sent.Last(r => r.Path.EndsWith("/answers")).Body;
        check(body.Contains("\"feel\":5") && body.Contains("\"wish\":[\"events\"]") && body.Contains("音が好き") && body.Contains("\"placement\":\"home\""), "survey: the answers as the server expects them");
        m1.CloseThanks();
        check(!await m1.CheckAsync("result") && m1.LastReason == "shown", "survey: never a second survey in one session");

        // skip: one tap from the result sheet (a new session)
        var g2 = new SessionPrompts();
        var m2 = new SurveyModel(b) { Prompts = g2 };
        check(await m2.CheckAsync("result") && m2.SheetVisible && !m2.CardVisible, "survey: after a race result → the sheet directly");
        var sk = await m2.SkipAsync();
        check(sk.Ok && !m2.SheetVisible && s.Sent.Any(r => r.Path == "/v1/surveys/sv_whip_feel/skip"), "survey: skip is one tap and is sent");

        // the server says no; SURVEY_CLOSED closes quietly; an account change resets the session
        var m3 = new SurveyModel(b);
        none = true;
        check(!await m3.CheckAsync("home") && m3.LastReason == "cool_down", "survey: the server's reason is kept");
        none = false;
        await m3.CheckAsync("result");
        m3.Answers.Scale("feel", 2);
        answerMode = 2;
        var cl = await m3.SubmitAsync();
        check(!cl.Ok && !m3.SheetVisible && !m3.ThanksVisible && m3.Message == SurveyModel.ClosedText, "survey: SURVEY_CLOSED → the sheet closes with a neutral line");
        var reset = new AccountChangeReset { Surveys = m3, Prompts = g2 };
        reset.OnAccountChanged();
        check(!m3.ShownThisSession && m3.Survey == null && g2.Claimed == null, "survey: an account change starts a new survey session");

        // English; no reward / urgency words anywhere on the card or sheet
        var texts = new[] { SurveyModel.Kicker, SurveyModel.AnswerLabel, SurveyModel.SkipLabel, SurveyModel.NextLabel, SurveyModel.BackLabel, SurveyModel.PassLabel, SurveyModel.SendLabel,
            SurveyModel.OptionalNote, SurveyModel.NoRewardNote, SurveyModel.ThanksTitle, SurveyModel.ThanksBody, SurveyModel.ClosedText, SurveyModel.CloseLabel, SurveyModel.TextHint, SurveyModel.ChoicesFormat, SurveyModel.RemainingFormat };
        Loc.LoadEnglish(File.ReadAllText(Path.Combine(root, "engine", "Muchi.Client", "Resources", "Muchi", "ui-en.json")));
        Loc.SetLocale("en");
        try { foreach (var t in texts) check(!Loc.HasJapanese(Loc.T(t)), "survey: English for " + t + " → " + Loc.T(t)); }
        finally { Loc.SetLocale("ja"); }
        var all = string.Join(" ", texts.Where(t => t != SurveyModel.NoRewardNote));
        check(new[] { "報酬", "もらえる", "プレゼント", "コイン", "倍", "今だけ", "お得", "残りわずか" }.All(w => !all.Contains(w)), "survey: no reward or urgency words");
    }
}
