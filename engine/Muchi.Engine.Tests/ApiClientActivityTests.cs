using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-ACT-001..016: /v1/activity client methods and models (contracts/protocol.md §40).</summary>
    public class ApiClientActivityTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientActivityTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        // shaped like the real server's answer (server/test/activity.test.ts): collapsed likes, a tournament result, gifts
        internal const string Page = "{\"items\":[{\"id\":\"9\",\"kind\":\"stable_like\",\"category\":\"friends\",\"at\":1794193200000,\"count\":12,\"unread\":true,\"actors\":[{\"playerId\":\"p3\",\"name\":\"ハヤテ\"}],\"text\":\"マイ厩舎に12件のいいねが届きました\",\"link\":{\"screen\":\"stable\",\"id\":null}},{\"id\":\"7\",\"kind\":\"tournament_result\",\"category\":\"events\",\"at\":1794190000000,\"count\":1,\"unread\":true,\"actors\":[],\"text\":\"「秋の大会」の最終順位は2位でした\",\"link\":{\"screen\":\"tournaments\",\"id\":\"t1\"}},{\"id\":\"5\",\"kind\":\"gift_arrived\",\"category\":\"gifts\",\"at\":1794180000000,\"count\":2,\"unread\":false,\"actors\":[],\"text\":\"プレゼントボックスに2件のプレゼントが届きました\",\"link\":{\"screen\":\"gift_box\",\"id\":null}}],\"nextCursor\":\"5\",\"unread\":2,\"readUpTo\":\"5\",\"links\":{\"whatsNew\":1}}";

        [Fact]
        public async Task PageParsesEntriesLinksAndTheCursor()
        {
            _http.Reply(200, Page).Reply(200, "{\"items\":[],\"nextCursor\":null,\"unread\":2,\"readUpTo\":\"5\",\"links\":{\"whatsNew\":0}}");
            var p = await _api.GetActivityAsync();
            Assert.Equal("/v1/activity?limit=20", _http.Requests[0].Path);
            Assert.Equal(3, p.Items.Count);
            Assert.Equal(12, p.Items[0].Count);
            Assert.Equal("ハヤテ", p.Items[0].Actors[0].Name);
            Assert.Equal(ActivityScreens.Stable, p.Items[0].Screen);
            Assert.Equal("t1", p.Items[1].LinkId);
            Assert.Equal(ActivityScreens.GiftBox, p.Items[2].Screen);
            Assert.False(p.Items[2].Unread);
            Assert.Equal(2, p.Unread);
            Assert.Equal(1, p.WhatsNew);
            Assert.True(p.HasMore);
            var next = await _api.GetActivityAsync(p.NextCursor, 10);
            Assert.Equal("/v1/activity?limit=10&cursor=5", _http.Requests[1].Path);
            Assert.False(next.HasMore);
            await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => _api.GetActivityAsync(null, 51));
        }

        [Fact]
        public async Task MarkReadIsRetriedSafely()
        {
            _http.Reply(503, "{\"error\":{\"code\":\"INTERNAL\"}}").Reply(200, "{\"readUpTo\":\"9\",\"unread\":0}");
            var r = await _api.MarkActivityReadAsync("9");
            Assert.Equal(2, _http.Requests.Count);
            Assert.Equal("/v1/activity/read", _http.Requests[1].Path);
            Assert.Equal("{\"upTo\":\"9\"}", _http.Requests[1].Body);
            Assert.Equal("9", r.ReadUpTo);
            Assert.Equal(0, r.Unread);
        }

        [Fact]
        public async Task PlayerViewCarriesTheBell()
        {
            _http.Reply(200, "{\"id\":\"u1\",\"activity\":{\"unread\":4}}");
            var v = await _api.GetPlayerAsync();
            Assert.Equal(4, v.Activity.Unread);
        }

        [Fact]
        public async Task ActivityEventsMatchTheServerSchema()
        {
            _http.Reply(200, "{\"accepted\":2}");
            await _api.SendAnalyticsAsync("ios", "1", new[] { AnalyticsEvent.ActivityOpen(5, 3), AnalyticsEvent.ActivityTap(6, ActivityKinds.StableLike, ActivityScreens.Stable) });
            Assert.Contains("\"name\":\"activity_open\"", _http.Requests[0].Body);
            Assert.Contains("\"unread\":3", _http.Requests[0].Body);
            Assert.Contains("\"kind\":\"stable_like\"", _http.Requests[0].Body);
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.ActivityTap(0, "claim", ActivityScreens.Stable));
            Assert.Throws<ArgumentOutOfRangeException>(() => AnalyticsEvent.ActivityOpen(0, -1));
            string ts = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "src", "domain", "kpi.ts"));
            Assert.Contains("z.literal('activity_open')", ts);
            foreach (var k in ActivityKinds.All) Assert.Contains("'" + k + "'", ts);
            foreach (var s in ActivityScreens.All) Assert.Contains("'" + s + "'", ts);
        }
    }
}
