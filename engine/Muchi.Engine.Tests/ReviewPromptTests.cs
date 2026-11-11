using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-REV-001..016: レビュー依頼のタイミング — the shared decision (contracts/review-prompt.vectors.json) and the client API (protocol §59).</summary>
    public class ReviewPromptTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ReviewPromptTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        private static JsonNode Get(JsonNode o, string k) { Assert.True(o.TryGet(k, out var x), k); return x; }

        [Fact]
        public void DecisionMatchesTheServerVectors()
        {
            var v = JsonNode.Parse(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "contracts", "review-prompt.vectors.json")));
            int n = 0;
            foreach (var c in Get(v, "cases").Items)
            {
                string name = Get(c, "name").AsString();
                var got = ReviewPromptPolicy.Decide(ReviewPromptRules.Parse(Get(c, "rules")), ReviewPromptSummary.Parse(Get(c, "summary")));
                var e = Get(c, "expect");
                string Str(string k) { var x = Get(e, k); return x.IsNull ? null : x.AsString(); }
                Assert.True(Get(e, "show").AsBool() == got.Show && Str("reason") == got.Reason && Str("style") == got.Style,
                    name + ": expected " + e + " got " + got.Show + "/" + got.Reason + "/" + got.Style);
                n++;
            }
            Assert.True(n >= 30);
        }

        [Fact]
        public async Task StatusCheckAndAnswer()
        {
            _http.Reply(200, "{\"v\":1,\"rules\":{\"enabled\":true,\"moments\":[\"first_win\"],\"minDaysSinceInstall\":3,\"minRacesPlayed\":10,\"maxPerYear\":3,\"coolDownDays\":120,\"quietMinutes\":{\"loss\":30,\"purchase\":1440,\"refund\":43200,\"error\":30,\"maintenanceNotice\":60},\"softAsk\":{\"ios\":false,\"android\":false}},\"history\":{\"count365\":1,\"lastAt\":1790000000000},\"serverSummary\":{\"installedAt\":1780000000000,\"racesPlayed\":12,\"inFtue\":false,\"accountClosing\":false,\"maintenanceVisible\":false,\"coinDebt\":false,\"minutesSincePurchase\":null,\"minutesSinceRefund\":null,\"lastSessionId\":\"s_old_session\",\"history\":[1790000000000]}}");
            var st = await _api.GetReviewPromptAsync();
            Assert.Equal("/v1/review-prompt", _http.Requests[0].Path);
            Assert.True(st.Rules.Enabled);
            Assert.Equal(43200, st.Rules.Quiet("refund"));
            Assert.Equal(1, st.Count365);
            // the device pre-check: same session as the server's last → no; the cool-down from the history → no
            Assert.Equal("session", ReviewPromptPolicy.Decide(st.Rules, st.Summary("ios", "first_win", 1790000000000 + 10 * ReviewPromptPolicy.DayMs, "s_old_session", false, false, null, null, null)).Reason);
            Assert.Equal("cool_down", ReviewPromptPolicy.Decide(st.Rules, st.Summary("ios", "first_win", 1790000000000 + 10 * ReviewPromptPolicy.DayMs, "s_new_session", false, false, null, null, null)).Reason);
            Assert.True(ReviewPromptPolicy.Decide(st.Rules, st.Summary("ios", "first_win", 1790000000000 + 130 * ReviewPromptPolicy.DayMs, "s_new_session", false, false, null, null, null)).Show);

            _http.Reply(200, "{\"v\":1,\"show\":true,\"style\":\"native\",\"reason\":null,\"promptId\":\"rp_2\"}");
            var c = await _api.CheckReviewPromptAsync("first_win", "ios", "s_new_session", false, 999_999, null, 5);
            var req = _http.Requests[1];
            Assert.Equal("POST", req.Method);
            Assert.Equal("/v1/review-prompt/check", req.Path);
            Assert.False(string.IsNullOrEmpty(req.Headers["idempotency-key"]));
            Assert.Contains("\"minutesSinceLoss\":525600", req.Body); // capped to a year
            Assert.Contains("\"minutesSinceError\":null", req.Body);
            Assert.Contains("\"minutesSinceMaintenanceNotice\":5", req.Body);
            Assert.True(c.Show);
            Assert.Equal("rp_2", c.PromptId);

            _http.Reply(200, "{\"promptId\":\"rp_2\",\"next\":\"help_inquiry\",\"helpCategory\":\"other\"}");
            var a = await _api.AnswerReviewPromptAsync("rp_2", "soft_no");
            Assert.Equal("/v1/review-prompt/rp_2/answer", _http.Requests[2].Path);
            Assert.Contains("\"step\":\"soft_no\"", _http.Requests[2].Body);
            Assert.Equal("help_inquiry", a.Next);
            Assert.Equal("other", a.HelpCategory);
        }

        [Fact]
        public void NoRewardAnywhere()
        {
            // REQ-REV-009: no type or member of the review prompt API speaks of a reward, granted coins or items (CoinDebt is the refund block)
            var types = new[] { typeof(ReviewPromptRules), typeof(ReviewPromptSummary), typeof(ReviewDecision), typeof(ReviewPromptCheck), typeof(ReviewPromptAnswer), typeof(ReviewPromptStatus), typeof(IStoreReview) };
            foreach (var t in types)
                foreach (var mbr in t.GetMembers(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static))
                    Assert.DoesNotMatch("(?i)reward|freecoin|paidcoin|item|grant|gift", mbr.Name);
            Assert.False(new NullStoreReview().Available);
        }
    }
}
