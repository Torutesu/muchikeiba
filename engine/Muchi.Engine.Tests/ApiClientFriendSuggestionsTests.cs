using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-FSUG-001..016: /v1/friends/suggestions client methods and models (contracts/protocol.md §49).</summary>
    public class ApiClientFriendSuggestionsTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientFriendSuggestionsTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        // shaped like the real server's answer (server/test/friendSuggest.test.ts)
        internal const string List = "{\"enabled\":true,\"items\":[{\"playerId\":\"b\",\"displayName\":\"ベニ\",\"titleId\":null,\"classId\":\"C\",\"reasons\":[{\"kind\":\"team\"},{\"kind\":\"mutual\",\"n\":2}],\"text\":\"同じ支部・共通のフレンド2人\"},{\"playerId\":\"a\",\"displayName\":\"アオイ\",\"titleId\":null,\"classId\":\"B\",\"silks\":{\"pattern\":\"plain\",\"colors\":[\"white\",\"navy\"],\"cap\":\"plain\"},\"reasons\":[{\"kind\":\"opponent\"}],\"text\":\"最近のレースで対戦\"}],\"settings\":{\"hidden\":false}}";

        [Fact]
        public async Task ListParsesReasonsAndSettings()
        {
            _http.Reply(200, List).Reply(200, "{\"enabled\":false,\"items\":[],\"settings\":{\"hidden\":true}}");
            var s = await _api.GetFriendSuggestionsAsync();
            Assert.Equal("/v1/friends/suggestions", _http.Requests[0].Path);
            Assert.True(s.Enabled);
            Assert.False(s.Hidden);
            Assert.Equal(2, s.Items.Count);
            Assert.Equal("ベニ", s.Items[0].DisplayName);
            Assert.Equal(FriendSuggestionKinds.Team, s.Items[0].Reasons[0].Kind);
            Assert.Equal(2, s.Items[0].Reasons[1].N);
            Assert.Equal("同じ支部・共通のフレンド2人", s.Items[0].Text);
            Assert.Null(s.Items[0].Silks);
            Assert.Equal("plain", s.Items[1].Silks.Pattern);
            var off = await _api.GetFriendSuggestionsAsync();
            Assert.False(off.Enabled);
            Assert.True(off.Hidden);
        }

        [Fact]
        public async Task RequestDismissAndSettingAreRetriedSafely()
        {
            _http.Reply(503, "{\"error\":{\"code\":\"INTERNAL\"}}").Reply(200, "{\"status\":\"requested\",\"playerId\":\"a\"}")
                .Reply(200, "{\"ok\":true}").Reply(200, "{\"hidden\":true}");
            var r = await _api.RequestSuggestedFriendAsync("a");
            Assert.Equal("/v1/friends/suggestions/a/request", _http.Requests[1].Path);
            Assert.Equal("requested", r.Status);
            Assert.True(await _api.DismissSuggestionAsync("p_9"));
            Assert.Equal("/v1/friends/suggestions/p_9/dismiss", _http.Requests[2].Path);
            Assert.True(await _api.SetSuggestionsHiddenAsync(true));
            Assert.Equal("PUT", _http.Requests[3].Method);
            Assert.Equal("{\"hidden\":true}", _http.Requests[3].Body);
        }

        [Fact]
        public async Task ViewEventMatchesTheServerSchema()
        {
            _http.Reply(200, "{\"accepted\":1}");
            await _api.SendAnalyticsAsync("ios", "1", new[] { AnalyticsEvent.FsugView(5, 4) });
            Assert.Contains("\"name\":\"fsug_view\"", _http.Requests[0].Body);
            Assert.Contains("\"shown\":4", _http.Requests[0].Body);
            Assert.Throws<ArgumentOutOfRangeException>(() => AnalyticsEvent.FsugView(0, 31));
            string ts = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "src", "domain", "kpi.ts"));
            Assert.Contains("z.literal('fsug_view')", ts);
            string fs = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "src", "domain", "friendSuggest.ts"));
            foreach (var k in FriendSuggestionKinds.All) Assert.Contains("'" + k + "'", fs);
        }
    }
}
