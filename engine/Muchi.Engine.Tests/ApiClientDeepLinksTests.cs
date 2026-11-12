using System.Text.Json;
using System.Text.RegularExpressions;
using Muchi.Client;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-LINK-001..024: link parsing / routes, /v1/links and the rematch calls (contracts/protocol.md §63).</summary>
    public class ApiClientDeepLinksTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly FakeAuth _auth = new FakeAuth();
        private readonly ApiClient _api;
        private const string Tok = "k7mq3xphr2abcdefghjkmn";

        public ApiClientDeepLinksTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, _auth, opt, new FakeDelay(), new SeqIds());
        }

        // the shapes the real server returns (LinkService.create / resolve, Rematches.view)
        internal const string Created = "{\"token\":\"" + Tok + "\",\"url\":\"https://link.muchi-issen.example/l/" + Tok + "\",\"appUrl\":\"muchi://l/" + Tok + "\",\"type\":\"room\",\"createdAt\":1794279600000,\"expiresAt\":1794281400000,\"created\":true,\"shareText\":\"ムチ一閃のフレンド部屋に招待します\\nhttps://link.muchi-issen.example/l/" + Tok + "\"}";
        internal const string ResolvedRoom = "{\"state\":\"ok\",\"type\":\"room\",\"screen\":\"friend_room_join\",\"target\":{\"passphrase\":\"123456\"},\"expiresAt\":1794281400000}";
        internal const string Rematch = "{\"raceId\":\"r-9\",\"state\":\"opened\",\"reason\":null,\"you\":\"pressed\",\"pressed\":3,\"eligible\":4,\"windowSec\":20,\"deadlineAt\":1794279620000,\"room\":{\"passphrase\":\"654321\",\"members\":3,\"host\":false}}";

        [Fact]
        public void ParserMatchesTheServer()
        {
            Assert.Equal(Tok, DeepLinkParser.Parse("https://link.muchi-issen.example/l/" + Tok));
            Assert.Equal(Tok, DeepLinkParser.Parse("https://other.example/l/" + Tok + "/?utm=1#x", "muchi", out var e1));
            Assert.Equal(DeepLinkEntries.Universal, e1);
            Assert.Equal(Tok, DeepLinkParser.Parse("MUCHI://l/" + Tok, "muchi", out var e2));
            Assert.Equal(DeepLinkEntries.Scheme, e2);
            Assert.Equal(Tok, DeepLinkParser.Parse(" " + DeepLinkParser.Format(Tok).ToUpperInvariant().Replace('-', 'ー') + " ", "muchi", out var e3));
            Assert.Equal(DeepLinkEntries.Typed, e3);
            Assert.Equal(Tok, DeepLinkParser.Parse("ｋ７ｍｑ３ｘｐｈｒ２ａｂｃｄｅｆｇｈｊｋｍｎ"));
            foreach (var bad in new[] { null, "", "https://x/p/" + Tok, "https://x/l/short", "muchi://room/123456", Tok + "a", Tok.Substring(0, 21) + "0", "https://x/l/a/b" })
                Assert.Null(DeepLinkParser.Parse(bad));
            Assert.Equal("k7mq-3xph-r2ab-cdef-ghjk-mn", DeepLinkParser.Format(Tok));
            Assert.Equal(Tok, DeepLinkParser.FromInstallReferrer("utm_source=google-play&link%3D" + Tok));
            Assert.Equal(Tok, DeepLinkParser.FromInstallReferrer("link=" + Tok + "&utm_medium=x"));
            Assert.Null(DeepLinkParser.FromInstallReferrer("utm_source=google-play"));
            Assert.Null(DeepLinkParser.FromInstallReferrer(null));
        }

        [Fact]
        public void AlphabetScreensAndTypesAreTheServers()
        {
            var ts = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "src", "domain", "deepLinks.ts"));
            Assert.Equal(Regex.Match(ts, "TOKEN_ALPHABET = '([^']+)'").Groups[1].Value, DeepLinkParser.Alphabet);
            Assert.Equal(int.Parse(Regex.Match(ts, @"TOKEN_LENGTH = (\d+)").Groups[1].Value), DeepLinkParser.TokenLength);
            var types = Regex.Matches(Regex.Match(ts, @"LINK_TYPES = \[([^\]]+)\]").Groups[1].Value, "'([^']+)'").Select(m => m.Groups[1].Value).ToArray();
            Assert.Equal(types, LinkTypes.All);
            var screens = Regex.Match(ts, @"LINK_SCREENS: Record<LinkType, string> = \{([^}]+)\}").Groups[1].Value;
            foreach (Match m in Regex.Matches(screens, @"(\w+): '([^']+)'")) Assert.Equal(m.Groups[2].Value, DeepLinkRoutes.ScreenOf(m.Groups[1].Value));
            Assert.Contains("LINK_LIMIT", ApiErrorCodes.WireCodes);
        }

        [Fact]
        public async Task CreateResolveListRevoke()
        {
            _http.Reply(200, Created).Reply(200, ResolvedRoom).Reply(200, "{\"enabled\":true,\"links\":[{\"token\":\"" + Tok + "\",\"url\":\"u\",\"type\":\"room\",\"createdAt\":1,\"expiresAt\":2}],\"createsToday\":1,\"createsPerDay\":30}").Reply(200, "{\"revoked\":true}");
            var c = await _api.CreateLinkAsync(LinkTypes.Room, new Dictionary<string, string> { ["passphrase"] = "123456" });
            using (var body = JsonDocument.Parse(_http.Requests[0].Body))
            {
                Assert.Equal("room", body.RootElement.GetProperty("type").GetString());
                Assert.Equal("123456", body.RootElement.GetProperty("target").GetProperty("passphrase").GetString());
            }
            Assert.True(c.Created);
            Assert.EndsWith("/l/" + Tok, c.Url);
            var r = await _api.ResolveLinkAsync("https://link.muchi-issen.example/l/" + Tok.ToUpperInvariant());
            using (var body = JsonDocument.Parse(_http.Requests[1].Body)) Assert.Equal(Tok, body.RootElement.GetProperty("token").GetString()); // canonical token sent
            Assert.True(r.Ok);
            Assert.Equal(DeepLinkRoutes.FriendRoomJoin, r.Screen);
            Assert.Equal("123456", r.Passphrase);
            var l = await _api.ListLinksAsync();
            Assert.Equal(30, l.CreatesPerDay);
            Assert.Single(l.Links);
            Assert.True(await _api.RevokeLinkAsync(Tok));
            Assert.Equal("/v1/links/" + Tok, _http.Requests[3].Path);
            Assert.Equal("DELETE", _http.Requests[3].Method);
        }

        [Fact]
        public async Task OtherStatesAndTheDailyLimit()
        {
            _http.Reply(200, "{\"state\":\"unavailable\"}")
                .Reply(200, "{\"state\":\"maintenance\",\"type\":\"room\",\"endAt\":1794283200000,\"endsAtJst\":\"11/11 13:00\",\"message\":\"メンテナンス\"}")
                .Reply(200, "{\"state\":\"update_required\",\"type\":\"team\",\"minVersion\":\"2.0.0\",\"storeUrl\":\"https://apps.apple.com/app/id0\"}")
                .Reply(200, "{\"state\":\"ok\",\"type\":\"friend\",\"screen\":\"friend_request\",\"target\":{\"friendCode\":\"0312345678\",\"displayName\":\"ハヤテ\",\"self\":false}}");
            Assert.Equal(LinkStates.Unavailable, (await _api.ResolveLinkAsync("nope")).State);
            var m = await _api.ResolveLinkAsync(Tok);
            Assert.Equal(LinkStates.Maintenance, m.State);
            Assert.Equal("11/11 13:00", m.EndsAtJst);
            var u = await _api.ResolveLinkAsync(Tok);
            Assert.Equal("2.0.0", u.MinVersion);
            var f = await _api.ResolveLinkAsync(Tok);
            Assert.Equal("ハヤテ", f.DisplayName);
            Assert.False(f.Self);
            _http.Reply(429, "{\"error\":{\"code\":\"LINK_LIMIT\",\"message\":\"x\",\"details\":{\"createsPerDay\":30}}}");
            var e = await Assert.ThrowsAnyAsync<ApiException>(() => _api.CreateLinkAsync(LinkTypes.Friend));
            Assert.Equal(ApiErrorCode.LinkLimit, e.Code);
        }

        [Fact]
        public async Task RematchCallsAndView()
        {
            _http.Reply(200, Rematch).Reply(200, Rematch).Reply(200, "{\"raceId\":\"r-9\",\"state\":\"waiting\",\"reason\":null,\"you\":\"declined\",\"pressed\":1,\"eligible\":3,\"windowSec\":20,\"deadlineAt\":1794279620000,\"room\":null}");
            var v = await _api.RematchPressAsync("r-9", "h1");
            Assert.Equal("/v1/friend-rooms/rematch/r-9", _http.Requests[0].Path);
            using (var body = JsonDocument.Parse(_http.Requests[0].Body)) Assert.Equal("h1", body.RootElement.GetProperty("horseId").GetString());
            Assert.True(v.Opened);
            Assert.Equal("654321", v.RoomPassphrase);
            Assert.Equal(0, v.SecondsLeft(1794279600000)); // opened: no countdown
            await _api.RematchStatusAsync("r-9");
            Assert.Equal("GET", _http.Requests[1].Method);
            var d = await _api.RematchDeclineAsync("r-9");
            Assert.Equal("DELETE", _http.Requests[2].Method);
            Assert.Equal(RematchStates.Declined, d.You);
            Assert.Equal(20, d.SecondsLeft(1794279600000));
            Assert.False(d.Opened);
        }

        [Fact]
        public void AnalyticsNeverCarriesTheToken()
        {
            var e = AnalyticsEvent.DeepLinkOpen(1, DeepLinkEntries.Referrer, LinkTypes.Cup);
            Assert.Equal("deep_link_open", e.Name);
            Assert.Equal("none", J2(AnalyticsEvent.DeepLinkOpen(1, DeepLinkEntries.Typed, null)));
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.DeepLinkOpen(1, "clipboard", LinkTypes.Cup));
            var ts = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "src", "domain", "kpi.ts"));
            Assert.Contains("DEEP_LINK_ENTRIES = ['universal', 'scheme', 'referrer', 'typed']", ts);
        }

        private static string J2(AnalyticsEvent e) => JsonDocument.Parse(e.PropsJson).RootElement.GetProperty("type").GetString();
    }
}
