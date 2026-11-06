using System.Text.RegularExpressions;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>Round 10: team cheer stamps / team feed (REQ-TEAMFEED-*) and the per-player shop list.</summary>
    public class ApiClientRound10Tests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientRound10Tests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test/" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        private void Single(string method, string path, string body = null)
        {
            Assert.Single(_http.Requests);
            Assert.Equal(method, _http.Requests[0].Method);
            Assert.Equal(path, _http.Requests[0].Path);
            if (body != null) Assert.Equal(body, _http.Requests[0].Body);
        }

        [Fact]
        public async Task MyProductsCarryOwnership()
        {
            _http.Reply(200, "{\"personalized\":true,\"seasonId\":\"2026-11\",\"products\":[{\"id\":\"season_pass\",\"kind\":\"season_pass\",\"priceYen\":1000,\"owned\":true,\"ownedReason\":\"season_pass\",\"purchasedThisSeason\":true},{\"id\":\"coin_160\",\"kind\":\"coins\",\"priceYen\":160,\"owned\":false,\"ownedReason\":null,\"purchasedThisSeason\":null}]}");
            var list = await _api.GetMyProductsAsync();
            Single("GET", "/v1/shop/products?mine=1");
            Assert.NotNull(_http.Requests[0].Headers["authorization"]);
            Assert.True(list.Personalized);
            Assert.Equal("2026-11", list.SeasonId);
            Assert.True(list.Products[0].Owned);
            Assert.Equal("season_pass", list.Products[0].OwnedReason);
            Assert.True(list.Products[0].PurchasedThisSeason);
            Assert.False(list.Products[1].Owned);
            Assert.Null(list.Products[1].PurchasedThisSeason);

            _http.Requests.Clear();
            _http.Reply(200, "{\"personalized\":false,\"products\":[{\"id\":\"coin_160\",\"kind\":\"coins\",\"priceYen\":160}]}");
            var anon = await _api.GetProductsAsync();
            Assert.False(anon.Personalized);
            Assert.Null(anon.Products[0].Owned); // unknown, not "not owned"
        }

        [Fact]
        public async Task StampsCatalogAndFeedPaging()
        {
            _http.Reply(200, "{\"version\":1,\"limits\":{\"postIntervalMs\":10000,\"postsPerDay\":50,\"feedSize\":100,\"pageMax\":50},\"stamps\":[{\"id\":\"cheer\",\"label\":\"がんばれ！\",\"asset\":\"stamp/cheer\",\"unlock\":{\"kind\":\"default\"},\"unlockText\":\"最初から使える\",\"unlocked\":true},{\"id\":\"whip\",\"label\":\"ムチ一閃！\",\"asset\":\"stamp/whip\",\"unlock\":{\"kind\":\"races\",\"count\":10},\"unlockText\":\"レースに10回出走で解放\",\"unlocked\":false},{\"id\":\"carrot\",\"label\":\"にんじん！\",\"unlock\":{\"kind\":\"cosmetic\",\"itemId\":\"stamp_carrot\"},\"unlocked\":false}]}");
            var cat = await _api.GetStampsAsync();
            Single("GET", "/v1/stamps");
            Assert.Equal(3, cat.Stamps.Count);
            Assert.True(cat.Stamps[0].Unlocked);
            Assert.Equal("races", cat.Stamps[1].UnlockKind);
            Assert.Equal(10, cat.Stamps[1].UnlockCount);
            Assert.Equal("stamp_carrot", cat.Stamps[2].UnlockItemId);
            Assert.Equal("stamp/carrot", cat.Stamps[2].Asset); // derived when the server omits it
            Assert.Equal(10000, cat.PostIntervalMs);

            _http.Requests.Clear();
            _http.Reply(200, "{\"teamId\":\"tabc123456\",\"items\":[{\"seq\":7,\"at\":5,\"kind\":\"race\",\"playerId\":\"a\",\"displayName\":\"A\",\"mine\":false,\"stampId\":null,\"stampAsset\":null,\"race\":{\"raceId\":\"r1\",\"mode\":\"ranked\",\"place\":1,\"fieldSize\":12,\"trackId\":\"t\"},\"reactions\":[{\"stampId\":\"nice\",\"count\":2,\"mine\":true}],\"myReaction\":\"nice\"},{\"seq\":6,\"at\":4,\"kind\":\"stamp\",\"playerId\":\"b\",\"displayName\":\"B\",\"mine\":true,\"stampId\":\"cheer\",\"stampAsset\":\"stamp/cheer\",\"race\":null,\"reactions\":[],\"myReaction\":null}],\"nextBefore\":6,\"latestSeq\":7,\"muted\":[\"x\"]}");
            var page = await _api.GetTeamFeedAsync();
            Single("GET", "/v1/teams/me/feed");
            Assert.Equal(2, page.Items.Count);
            Assert.True(page.Items[0].IsRace);
            Assert.Equal(1, page.Items[0].Race.Place);
            Assert.Equal("nice", page.Items[0].MyReaction);
            Assert.True(page.Items[0].Reactions[0].Mine);
            Assert.Null(page.Items[1].Race);
            Assert.Equal(6, page.NextBefore);
            Assert.Equal(new[] { "x" }, page.Muted);

            _http.Requests.Clear();
            _http.Reply(200, "{\"teamId\":\"t\",\"items\":[],\"nextBefore\":null,\"latestSeq\":7,\"muted\":[]}");
            var older = await _api.GetTeamFeedAsync(6, 20);
            Single("GET", "/v1/teams/me/feed?before=6&limit=20");
            Assert.Null(older.NextBefore);
        }

        [Fact]
        public async Task PostReactReportMute()
        {
            _http.Reply(200, "{\"teamId\":\"t\",\"seq\":3,\"at\":9,\"stampId\":\"cheer\"}");
            var r = await _api.PostStampAsync("cheer");
            Single("POST", "/v1/teams/me/feed/stamps", "{\"stampId\":\"cheer\"}");
            Assert.Equal(3, r.Seq);

            // a rate-limited post is not retried (posts are not idempotent) and surfaces as RateLimitedException
            _http.Requests.Clear();
            _http.Reply(429, "{\"error\":{\"code\":\"RATE_LIMITED\",\"message\":\"one stamp per 10 s\"}}");
            await Assert.ThrowsAsync<RateLimitedException>(() => _api.PostStampAsync("cheer"));
            Assert.Single(_http.Requests);

            _http.Requests.Clear();
            _http.Reply(409, "{\"error\":{\"code\":\"STAMP_LOCKED\",\"message\":\"レースに10回出走で解放\"}}");
            var locked = await Assert.ThrowsAsync<ConflictException>(() => _api.PostStampAsync("whip"));
            Assert.Equal(ApiErrorCode.StampLocked, locked.Code);

            _http.Requests.Clear();
            _http.Reply(200, "{\"teamId\":\"t\",\"seq\":3,\"myReaction\":\"nice\"}");
            Assert.Equal("nice", await _api.ReactToFeedItemAsync(3, "nice"));
            Single("PUT", "/v1/teams/me/feed/3/reaction", "{\"stampId\":\"nice\"}");

            _http.Requests.Clear();
            _http.Reply(200, "{\"teamId\":\"t\",\"seq\":3,\"myReaction\":null}");
            Assert.Null(await _api.ReactToFeedItemAsync(3, null));
            Single("PUT", "/v1/teams/me/feed/3/reaction", "{\"stampId\":null}");

            _http.Requests.Clear();
            _http.Reply(200, "{\"reported\":true,\"seq\":3}");
            Assert.True(await _api.ReportFeedItemAsync(3, FeedReportReason.Harassment));
            Single("POST", "/v1/teams/me/feed/3/report", "{\"reason\":\"harassment\"}");

            _http.Requests.Clear();
            _http.Reply(200, "{\"muted\":[\"a\"]}");
            Assert.Equal(new[] { "a" }, await _api.SetFeedMuteAsync("a", true));
            Single("PUT", "/v1/teams/me/feed/mutes", "{\"playerId\":\"a\",\"muted\":true}");

            _http.Requests.Clear();
            _http.Reply(200, "{\"muted\":[]}");
            Assert.Empty(await _api.GetFeedMutesAsync());
            Single("GET", "/v1/teams/me/feed/mutes");
        }

        [Fact]
        public void StampKeysAndErrorCodeMatchTheServer()
        {
            Assert.Equal("stamp/cheer", AssetKeys.Stamp("cheer"));
            Assert.Equal("stamp", AssetKeys.KindOf("stamp/cheer"));
            Assert.Equal(ApiErrorCode.StampLocked, ApiErrorCodes.Parse("STAMP_LOCKED"));
            var root = new DirectoryInfo(AppContext.BaseDirectory);
            while (root != null && !Directory.Exists(Path.Combine(root.FullName, "contracts"))) root = root.Parent;
            Assert.NotNull(root);
            var keys = new HashSet<string>(AssetKeys.ParseManifestKeys(File.ReadAllText(Path.Combine(root!.FullName, "contracts", "assets.manifest.json"))));
            var stamps = JsonNode.Parse(File.ReadAllText(Path.Combine(root.FullName, "server", "master", "stamps.json")));
            foreach (var s in stamps.Get("stamps").Items) Assert.Contains(AssetKeys.Stamp(s.Get("id").AsString()), keys);
            Assert.Contains(AssetKeys.Fallback("stamp"), keys);
            // every server error code is known to the client
            var errors = File.ReadAllText(Path.Combine(root.FullName, "server", "src", "domain", "errors.ts"));
            Assert.Contains("'STAMP_LOCKED'", errors);
            Assert.Contains("STAMP_LOCKED", ApiErrorCodes.WireCodes);
        }
    }
}
