using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-RPT-001..020: /v1/reports and /v1/blocks client methods and models (contracts/protocol.md §47).</summary>
    public class ApiClientReportsTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientReportsTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        // shaped like the real server's answers (server/test/reports.test.ts)
        internal const string Options = "{\"enabled\":true,\"categories\":[{\"id\":\"name\",\"label\":\"不適切な名前\",\"kinds\":[\"display_name\",\"horse_name\",\"stable_name\"]},{\"id\":\"text\",\"label\":\"不適切なキャプション・文\",\"kinds\":[\"replay_title\",\"photo_caption\"]},{\"id\":\"cheating\",\"label\":\"不正の疑い\",\"kinds\":[\"race\"]},{\"id\":\"harassment\",\"label\":\"嫌がらせ\",\"kinds\":[\"player\",\"display_name\",\"horse_name\",\"stable_name\",\"replay_title\",\"photo_caption\",\"race\"]},{\"id\":\"other\",\"label\":\"その他\",\"kinds\":[\"player\",\"display_name\",\"horse_name\",\"stable_name\",\"replay_title\",\"photo_caption\",\"race\"]}],\"noteMaxChars\":100,\"remainingToday\":9}";
        internal const string Blocks = "{\"blocked\":[{\"playerId\":\"gone\",\"name\":\"プレイヤー\"},{\"playerId\":\"b\",\"name\":\"ベニ\"}],\"count\":2,\"max\":100,\"effects\":[{\"feature\":\"activity\",\"text\":\"相手からのお知らせが届かなくなります\"},{\"feature\":\"stable\",\"text\":\"お互いのマイ厩舎を開けず、いいねもできなくなります\"}]}";

        [Fact]
        public async Task OptionsParseCategoriesAndKinds()
        {
            _http.Reply(200, Options);
            var o = await _api.GetReportOptionsAsync();
            Assert.Equal("/v1/reports/options", _http.Requests[0].Path);
            Assert.True(o.Enabled);
            Assert.Equal(ReportCategories.All.Length, o.Categories.Count);
            Assert.True(o.Categories[0].Allows(ReportContentKinds.HorseName));
            Assert.False(o.Categories[0].Allows(ReportContentKinds.Race));
            Assert.Equal(100, o.NoteMaxChars);
            Assert.Equal(9, o.RemainingToday);
        }

        [Fact]
        public async Task SubmitSendsTheContentKeyAndIsNotRetried()
        {
            _http.Reply(200, "{\"received\":true,\"blocked\":true,\"remainingToday\":8}");
            var r = await _api.SubmitReportAsync(new ReportTarget("p9", ReportContentKinds.HorseName, "h1"), ReportCategories.Name, ReportSources.Stable, "  ", true);
            Assert.Equal("/v1/reports", _http.Requests[0].Path);
            Assert.Equal("{\"targetId\":\"p9\",\"category\":\"name\",\"source\":\"stable\",\"content\":{\"kind\":\"horse_name\",\"horseId\":\"h1\"},\"alsoBlock\":true}", _http.Requests[0].Body);
            Assert.True(r.Received);
            Assert.True(r.Blocked);
            Assert.Equal(8, r.RemainingToday);

            _http.Reply(503, "{\"error\":{\"code\":\"INTERNAL\"}}");
            await Assert.ThrowsAnyAsync<Exception>(() => _api.SubmitReportAsync(new ReportTarget("p9", ReportContentKinds.Player), ReportCategories.Other, ReportSources.Profile, "メモ"));
            Assert.Equal(2, _http.Requests.Count); // not retried: each attempt uses today's allowance
            Assert.Contains("\"note\":\"メモ\"", _http.Requests[1].Body);
        }

        [Fact]
        public async Task TargetsAndArgumentsAreChecked()
        {
            Assert.Throws<ArgumentException>(() => new ReportTarget("p9", ReportContentKinds.Race));
            Assert.Throws<ArgumentException>(() => new ReportTarget("p9", ReportContentKinds.DisplayName, "x"));
            Assert.Throws<ArgumentException>(() => new ReportTarget("p9", "chat"));
            Assert.Throws<ArgumentException>(() => new ReportTarget("", ReportContentKinds.Player));
            // Round 18 integration: a quick chat phrase needs its feed reference
            Assert.Throws<ArgumentException>(() => new ReportTarget("p9", ReportContentKinds.Qchat));
            Assert.Equal("feedRef", ReportContentKinds.RefKey(ReportContentKinds.Qchat));
            await Assert.ThrowsAsync<ArgumentException>(() => _api.SubmitReportAsync(new ReportTarget("p9", ReportContentKinds.Player), "spam", ReportSources.Profile));
            await Assert.ThrowsAsync<ArgumentException>(() => _api.SubmitReportAsync(new ReportTarget("p9", ReportContentKinds.Player), ReportCategories.Other, "chat"));
        }

        [Fact]
        public async Task BlockListAndChanges()
        {
            _http.Reply(200, Blocks).Reply(503, "{\"error\":{\"code\":\"INTERNAL\"}}").Reply(200, "{\"playerId\":\"x y\",\"blocked\":true,\"count\":3,\"max\":100}")
                .Reply(200, "{\"playerId\":\"b\",\"blocked\":false,\"count\":2,\"max\":100}");
            var l = await _api.GetBlocksAsync();
            Assert.Equal("/v1/blocks", _http.Requests[0].Path);
            Assert.Equal("プレイヤー", l.Blocked[0].Name);
            Assert.Equal("stable", l.Effects[1].Feature);
            Assert.Equal(2, l.Count);
            var b = await _api.BlockAsync("x y");
            Assert.Equal("PUT", _http.Requests[2].Method);
            Assert.Equal("/v1/blocks/x%20y", _http.Requests[2].Path);
            Assert.True(b.Blocked);
            var u = await _api.UnblockAsync("b");
            Assert.Equal("DELETE", _http.Requests[3].Method);
            Assert.False(u.Blocked);
        }

        [Fact]
        public void NamesMatchTheServer()
        {
            string reports = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "src", "domain", "reports.ts"));
            foreach (var c in ReportCategories.All) Assert.Contains("'" + c + "'", reports);
            foreach (var k in ReportContentKinds.All) Assert.Contains("'" + k + "'", reports);
            foreach (var s in ReportSources.All) Assert.Contains("'" + s + "'", reports);
        }
    }
}
