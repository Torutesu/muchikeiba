using System;
using System.Threading.Tasks;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-SURVEY-005..011/021: ゲーム内アンケート — the client API and the answer builder (protocol §69).</summary>
    public class SurveyTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public SurveyTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        internal const string OfferJson = "{\"reason\":null,\"survey\":{\"id\":\"sv_whip_feel\",\"rev\":2,\"placement\":\"home\",\"endAt\":1790000000000,\"title\":\"ムチの手ごたえ\",\"intro\":\"1分で終わる質問です。\",\"questions\":["
            + "{\"id\":\"feel\",\"kind\":\"scale\",\"required\":true,\"text\":\"手ごたえは？\",\"options\":null,\"maxChoices\":null,\"labels\":{\"low\":\"弱い\",\"high\":\"強い\"},\"maxLength\":null},"
            + "{\"id\":\"mode\",\"kind\":\"single\",\"required\":true,\"text\":\"いちばん遊ぶのは？\",\"options\":[{\"id\":\"ranked\",\"text\":\"ランク戦\"},{\"id\":\"events\",\"text\":\"イベント\"}],\"maxChoices\":null,\"labels\":null,\"maxLength\":null},"
            + "{\"id\":\"wish\",\"kind\":\"multi\",\"required\":false,\"text\":\"増えてほしいものは？\",\"options\":[{\"id\":\"tracks\",\"text\":\"コース\"},{\"id\":\"events\",\"text\":\"イベント\"},{\"id\":\"silks\",\"text\":\"勝負服\"}],\"maxChoices\":2,\"labels\":null,\"maxLength\":null},"
            + "{\"id\":\"free\",\"kind\":\"text\",\"required\":false,\"text\":\"ひとことあれば\",\"options\":null,\"maxChoices\":null,\"labels\":null,\"maxLength\":10}]}}";

        [Fact]
        public async Task OfferShownAnswerSkip()
        {
            _http.Reply(200, OfferJson);
            var o = await _api.GetSurveyAsync("home");
            Assert.Equal("/v1/surveys/current?placement=home", _http.Requests[0].Path);
            Assert.Null(o.Reason);
            Assert.Equal(4, o.Survey.Questions.Count);
            Assert.Equal("弱い", o.Survey.Question("feel").LowLabel);
            Assert.Equal(2, o.Survey.Question("wish").MaxChoices);

            _http.Reply(200, "{\"surveyId\":\"sv_whip_feel\",\"shows\":1,\"done\":null}");
            Assert.Equal(1, (await _api.SurveyShownAsync("sv_whip_feel", "home")).Shows);
            Assert.Equal("/v1/surveys/sv_whip_feel/shown", _http.Requests[1].Path);

            var b = new SurveyAnswerBuilder(o.Survey);
            Assert.Equal(new[] { "feel is required", "mode is required" }, b.Problems());
            b.Scale("feel", 4).Choose("mode", "ranked");
            Assert.True(b.Toggle("wish", "silks"));
            Assert.True(b.Toggle("wish", "tracks"));
            Assert.False(b.Toggle("wish", "events")); // maxChoices 2
            b.Text("free", "   ");
            Assert.False(b.Has("free"));
            b.Text("free", "ムチの音が好き🐎");
            Assert.Equal(2, b.Remaining("free")); // code points, like the server
            Assert.True(b.Complete);
            Assert.Throws<ArgumentException>(() => b.Choose("mode", "cups"));
            Assert.Throws<ArgumentException>(() => b.Scale("mode", 3));
            Assert.Throws<ArgumentOutOfRangeException>(() => b.Scale("feel", 6));
            Assert.Throws<ArgumentException>(() => b.Text("nope", "x"));

            _http.Reply(200, "{\"surveyId\":\"sv_whip_feel\",\"outcome\":\"answered\",\"at\":1790000000000}");
            var a = await _api.AnswerSurveyAsync("sv_whip_feel", "home", b, "c:survey-1");
            Assert.Equal("answered", a.Outcome);
            var req = _http.Requests[2];
            Assert.Equal("/v1/surveys/sv_whip_feel/answers", req.Path);
            Assert.Equal("c:survey-1", req.Headers["idempotency-key"]);
            var body = JsonNode.Parse(req.Body);
            Assert.True(body.TryGet("answers", out var ans));
            Assert.Equal("{\"feel\":4,\"mode\":\"ranked\",\"wish\":[\"tracks\",\"silks\"],\"free\":\"ムチの音が好き🐎\"}", ans.ToString());

            _http.Reply(200, "{\"surveyId\":\"sv_whip_feel\",\"outcome\":\"skipped\",\"at\":1}");
            Assert.Equal("skipped", (await _api.SkipSurveyAsync("sv_whip_feel", "result")).Outcome);
        }

        [Fact]
        public async Task ClosedSurveyIsATypedNeutralError()
        {
            var b = new SurveyAnswerBuilder(SurveyOfferParse());
            b.Scale("feel", 1).Choose("mode", "events");
            _http.Reply(409, "{\"error\":{\"code\":\"SURVEY_CLOSED\",\"message\":\"this survey has ended\"}}");
            var e = await Assert.ThrowsAnyAsync<ApiException>(() => _api.AnswerSurveyAsync("sv_whip_feel", "home", b, "c:k"));
            Assert.Equal(ApiErrorCode.SurveyClosed, e.Code);
            Assert.Single(_http.Requests); // a 409 is never retried
            Assert.Contains("SURVEY_CLOSED", ApiErrorCodes.WireCodes);
        }

        private static SurveyView SurveyOfferParse()
        {
            var n = JsonNode.Parse(OfferJson);
            n.TryGet("survey", out var s);
            var f = typeof(SurveyView).GetMethod("Parse", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
            return (SurveyView)f.Invoke(null, new object[] { s });
        }
    }
}
