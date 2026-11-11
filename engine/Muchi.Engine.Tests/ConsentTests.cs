using System.Collections.Generic;
using System.Threading.Tasks;
using Muchi.Client;
using Muchi.Net;
using Xunit;

namespace Muchi.Engine.Tests
{
    // 広告・分析の同意管理 (REQ-CNS-002/005/009/010/013/017, contracts/protocol.md §58): the client SDK side.
    public class ConsentTests
    {
        private const string View = "{\"policyVersion\":\"2026-11-01\",\"decidedVersion\":null,\"decidedAt\":null,\"updatedAt\":null,\"rev\":0,\"required\":true,\"prompt\":\"ad_offer\",\"minor\":false,"
            + "\"personalizedAds\":{\"value\":false,\"effective\":false,\"locked\":\"age_unknown\"},\"analytics\":{\"value\":true,\"effective\":true,\"locked\":null},"
            + "\"platform\":{\"os\":\"ios\",\"att\":\"denied\",\"gdprApplies\":null,\"cmp\":null,\"at\":5},"
            + "\"adRequest\":{\"npa\":1,\"nonPersonalized\":true,\"underAgeOfConsent\":false,\"ageKnown\":false,\"tagForChildDirected\":false,\"extras\":{\"npa\":\"1\"}},\"kpi\":{\"optional\":true}}";

        private static (ApiClient api, FakeHttp http) Api()
        {
            var http = new FakeHttp();
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            return (new ApiClient(http, new FakeAuth(), opt, new FakeDelay(), new SeqIds()), http);
        }

        [Fact]
        public void ParsesTheView()
        {
            var s = ConsentState.Parse(JsonNode.Parse(View));
            Assert.Equal("2026-11-01", s.PolicyVersion);
            Assert.True(s.Required);
            Assert.Equal(ConsentPrompt.AdOffer, s.Prompt);
            Assert.False(s.PersonalizedAds.Effective);
            Assert.Equal("age_unknown", s.PersonalizedAds.Locked);
            Assert.True(s.Analytics.Effective);
            Assert.Equal(AttStatus.Denied, s.Att);
            Assert.Null(s.GdprApplies);
            Assert.Null(s.Cmp);
            Assert.Equal(1, s.AdRequest.Npa);
            Assert.Equal("1", s.AdRequest.Extras["npa"]);
            Assert.True(s.AllowsClientEvent("screen_view"));
        }

        [Fact]
        public void SafeDefaultsAndNeverPersonaliseByAccident()
        {
            var empty = ConsentState.Parse((JsonNode)null);
            Assert.Equal(ConsentPrompt.None, empty.Prompt);
            Assert.True(empty.AdRequest.NonPersonalized);
            Assert.Equal("1", empty.AdRequest.Extras["npa"]);
            // a contradictory payload (npa 1 but nonPersonalized false) stays non-personalised
            var odd = ConsentState.Parse(JsonNode.Parse("{\"adRequest\":{\"npa\":1,\"nonPersonalized\":false}}"));
            Assert.True(odd.AdRequest.NonPersonalized);
            var pa = ConsentState.Parse(JsonNode.Parse("{\"adRequest\":{\"npa\":0,\"nonPersonalized\":false,\"extras\":{}}}"));
            Assert.False(pa.AdRequest.NonPersonalized);
            Assert.False(pa.AdRequest.Extras.ContainsKey("npa"));
            // analytics off → no client event passes
            var off = ConsentState.Parse(JsonNode.Parse("{\"analytics\":{\"value\":false,\"effective\":false},\"kpi\":{\"optional\":false}}"));
            Assert.False(off.AllowsClientEvent("session_start"));
            foreach (AttStatus a in new[] { AttStatus.NotDetermined, AttStatus.Restricted, AttStatus.Denied, AttStatus.Authorized, AttStatus.Unavailable })
                Assert.Equal(a, ConsentWire.ParseAtt(ConsentWire.Att(a)));
            foreach (CmpStatus c in new[] { CmpStatus.Unknown, CmpStatus.NotRequired, CmpStatus.Required, CmpStatus.Obtained })
                Assert.Equal(c, ConsentWire.ParseCmp(ConsentWire.Cmp(c)));
        }

        [Fact]
        public async Task ApiCalls()
        {
            var (api, http) = Api();
            http.Reply(200, View).Reply(200, View).Reply(200, View).Reply(200, View);
            await api.GetPrivacyChoicesAsync();
            Assert.Equal("GET", http.Requests[0].Method);
            Assert.Equal("/v1/privacy/choices", http.Requests[0].Path);
            await api.SetPrivacyChoicesAsync("2026-11-01", "prompt", null, false);
            Assert.Equal("PUT", http.Requests[1].Method);
            Assert.Equal("{\"privacyVersion\":\"2026-11-01\",\"source\":\"prompt\",\"analytics\":false}", http.Requests[1].Body);
            await api.ReportPrivacyPlatformAsync("ios", AttStatus.Authorized, null, null);
            Assert.Equal("/v1/privacy/platform", http.Requests[2].Path);
            Assert.Equal("{\"os\":\"ios\",\"att\":\"authorized\"}", http.Requests[2].Body);
            await api.NotePrivacyPromptShownAsync("2026-11-01");
            Assert.Equal("POST", http.Requests[3].Method);
            Assert.Equal("/v1/privacy/prompt-shown", http.Requests[3].Path);
            await Assert.ThrowsAsync<System.ArgumentException>(() => api.SetPrivacyChoicesAsync("v", "elsewhere", null, null));
        }

        [Fact]
        public async Task PlayerViewCarriesTheBlock()
        {
            var (api, http) = Api();
            http.Reply(200, "{\"id\":\"p\",\"wallet\":{\"paid\":0,\"free\":0,\"total\":0,\"debt\":0},\"privacyChoices\":{\"required\":false,\"prompt\":null,\"analytics\":{\"value\":false,\"effective\":false}}}")
                .Reply(200, "{\"id\":\"p\",\"wallet\":{\"paid\":0,\"free\":0,\"total\":0,\"debt\":0}}");
            var p = await api.GetPlayerAsync();
            Assert.False(p.PrivacyChoices.Required);
            Assert.False(p.PrivacyChoices.OptionalAnalytics);
            var old = await api.GetPlayerAsync();
            Assert.True(old.PrivacyChoices.AdRequest.NonPersonalized);
        }

        [Fact]
        public void AnalyticsGateDropsOnTheDevice()
        {
            var sent = new List<string>();
            var a = new AnalyticsClient((pl, v, evs, ct) => { foreach (var e in evs) sent.Add(e.Name); return Task.FromResult(new AnalyticsIngestResult { Accepted = evs.Count }); }, new AnalyticsOptions());
            bool allow = false;
            a.Gate = _ => allow;
            a.Track(AnalyticsEvent.SessionStart(1));
            Assert.Equal(0, a.Pending);
            Assert.Equal(1, a.Withheld);
            allow = true;
            a.Track(AnalyticsEvent.SessionStart(2));
            Assert.Equal(1, a.Pending);
        }
    }
}
