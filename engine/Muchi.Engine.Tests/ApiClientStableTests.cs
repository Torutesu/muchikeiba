using System.IO;
using System.Linq;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>マイ厩舎 on the wire (server/src/http/app.ts, contracts/protocol.md §8.6, REQ-STABLE-*).</summary>
    public class ApiClientStableTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientStableTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        private static string Canon(string json) => JsonNode.Parse(json).ToString();

        private HttpRequest Last(string method, string path, string body = null, bool keyed = false)
        {
            var r = _http.Requests[_http.Requests.Count - 1];
            Assert.Equal(method, r.Method);
            Assert.Equal(path, r.Path);
            if (body == null) Assert.True(r.Body == null || r.Body == "{}", "unexpected body " + r.Body);
            else Assert.Equal(Canon(body), Canon(r.Body));
            Assert.Equal(keyed, r.Headers.ContainsKey("idempotency-key"));
            return r;
        }

        internal const string Snapshot = "{\"v\":1,\"playerId\":\"a\",\"displayName\":\"騎手A\",\"titleId\":null,\"classId\":\"C\","
            + "\"silks\":{\"pattern\":\"hoops\",\"colors\":[\"red\",\"white\"],\"cap\":\"plain\"},\"name\":null,"
            + "\"theme\":{\"id\":\"standard\",\"name\":\"いつもの厩舎\",\"key\":\"stable/theme/standard\"},"
            + "\"slots\":[{\"itemId\":\"decor_flower_box\",\"name\":\"花のプランター\",\"key\":\"decor/flower_box\"},null,null],"
            + "\"horses\":[{\"horseId\":\"h1\",\"name\":\"アカツキ\",\"rarity\":\"SR\",\"style\":\"nige\",\"bondLevel\":3,\"appearance\":{\"coat\":\"gray\",\"face\":\"none\",\"legs\":[\"none\",\"none\",\"none\",\"none\"],\"mane\":\"normal\",\"build\":\"standard\"}}],"
            + "\"autoHorses\":true,\"trophies\":{\"titleIds\":[\"first_win\"],\"races\":10,\"wins\":2,\"top3\":5,\"tournamentWins\":0,\"tournamentPodiums\":1},\"likes\":7,\"updatedAt\":1000}";

        internal const string Mine = "{\"saved\":true,\"layout\":{\"theme\":\"standard\",\"name\":null,\"slots\":[\"decor_flower_box\",null],\"featuredHorseIds\":[],\"updatedAt\":1000},"
            + "\"themes\":[{\"id\":\"standard\",\"name\":\"いつもの厩舎\",\"key\":\"stable/theme/standard\",\"slots\":3,\"unlocked\":true,\"unlockLikes\":null,\"unlockItem\":null},"
            + "{\"id\":\"cedar\",\"name\":\"杉板の厩舎\",\"key\":\"stable/theme/cedar\",\"slots\":4,\"unlocked\":false,\"unlockLikes\":10,\"unlockItem\":null}],"
            + "\"decor\":[{\"itemId\":\"decor_flower_box\",\"name\":\"花のプランター\",\"key\":\"decor/flower_box\",\"owned\":true,\"price\":200,\"currency\":\"any\"},"
            + "{\"itemId\":\"decor_trophy_shelf\",\"name\":\"トロフィー棚\",\"key\":\"decor/trophy_shelf\",\"owned\":false,\"price\":500,\"currency\":\"any\"}],"
            + "\"featuredMax\":3,\"nameMaxChars\":12,\"likes\":{\"received\":7,\"givenToday\":1,\"perDay\":5,\"perTargetPerDay\":1},\"preview\":" + Snapshot + ",\"notice\":\"いいねにコインは付きません\"}";

        [Fact]
        public async Task MineSaveVisitsVisitAndLike()
        {
            _http.Reply(200, Mine);
            var mine = await _api.GetMyStableAsync();
            Last("GET", "/v1/stable");
            Assert.True(mine.Saved);
            Assert.Equal(new[] { "decor_flower_box", null }, mine.Layout.Slots.ToArray());
            Assert.Equal(10, mine.Themes[1].UnlockLikes);
            Assert.Null(mine.Themes[0].UnlockLikes);
            Assert.False(mine.Decor[1].Owned);
            Assert.Equal(5, mine.Likes.PerDay);
            Assert.Equal("騎手Aの厩舎", mine.Preview.PlateName);
            Assert.Null(mine.Preview.Slots[1]);
            Assert.Equal(1, mine.Preview.DecorCount);
            Assert.Equal("gray", mine.Preview.Horses[0].Appearance.Coat);
            Assert.Equal(1, mine.Preview.Trophies.TournamentPodiums);

            var layout = mine.Layout.Clone();
            layout.Name = "ほしぞら厩舎";
            layout.FeaturedHorseIds.Add("h1");
            _http.Reply(200, "{\"layout\":{\"theme\":\"standard\",\"name\":\"ほしぞら厩舎\",\"slots\":[\"decor_flower_box\",null],\"featuredHorseIds\":[\"h1\"],\"updatedAt\":2000},\"snapshot\":" + Snapshot + "}");
            var saved = await _api.SaveStableAsync(layout);
            Last("PUT", "/v1/stable", "{\"theme\":\"standard\",\"name\":\"ほしぞら厩舎\",\"slots\":[\"decor_flower_box\",null],\"featuredHorseIds\":[\"h1\"]}");
            Assert.Equal(2000, saved.Layout.UpdatedAt);
            Assert.Equal("a", saved.Snapshot.PlayerId);

            _http.Reply(200, "{\"friends\":[{\"playerId\":\"f\",\"displayName\":\"F\",\"titleId\":null,\"name\":null,\"themeKey\":\"stable/theme/cedar\",\"likes\":3,\"decorCount\":2,\"horseCount\":1,\"updatedAt\":5}],\"recommended\":[]}");
            var v = await _api.GetStableVisitsAsync();
            Last("GET", "/v1/stable/visits");
            Assert.Equal("Fの厩舎", v.Friends[0].PlateName);
            Assert.Empty(v.Recommended);

            _http.Reply(200, "{\"stable\":" + Snapshot + ",\"viewer\":{\"relation\":\"friend\",\"likedToday\":0,\"likesLeftToday\":4,\"canLike\":true}}");
            var visit = await _api.GetStableAsync("a/b");
            Last("GET", "/v1/stable/a%2Fb");
            Assert.True(visit.Viewer.CanLike);
            Assert.Equal("friend", visit.Viewer.Relation);

            _http.Reply(200, "{\"playerId\":\"a\",\"likes\":8,\"remainingToday\":3}");
            var like = await _api.LikeStableAsync("a", "k-1");
            var req = Last("POST", "/v1/stable/a/like", null, keyed: true);
            Assert.Equal("k-1", req.Headers["idempotency-key"]);
            Assert.Equal(8, like.Likes);
            Assert.Equal(3, like.RemainingToday);
        }

        [Fact]
        public async Task LikeErrorsAreTypedAndAKeyIsReusedOnRetry()
        {
            _http.Reply(409, "{\"error\":{\"code\":\"LIKE_LIMIT\",\"message\":\"5 likes per day\"}}");
            var e1 = await Assert.ThrowsAsync<ConflictException>(() => _api.LikeStableAsync("a"));
            Assert.Equal(ApiErrorCode.LikeLimit, e1.Code);
            _http.Reply(409, "{\"error\":{\"code\":\"ALREADY_LIKED\",\"message\":\"x\"}}");
            Assert.Equal(ApiErrorCode.AlreadyLiked, (await Assert.ThrowsAsync<ConflictException>(() => _api.LikeStableAsync("a"))).Code);
            _http.Reply(404, "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"this stable is not open yet\"}}");
            await Assert.ThrowsAsync<NotFoundException>(() => _api.GetStableAsync("zz"));
            // a 5xx is retried with the same key (the server counts the like once)
            _http.Reply(503, "{\"error\":{\"code\":\"INTERNAL\",\"message\":\"x\"}}").Reply(200, "{\"playerId\":\"a\",\"likes\":1,\"remainingToday\":4}");
            var n = _http.Requests.Count;
            await _api.LikeStableAsync("a");
            Assert.Equal(_http.Requests[n].Headers["idempotency-key"], _http.Requests[n + 1].Headers["idempotency-key"]);
        }

        [Fact]
        public void ThemeKeysMatchTheManifest()
        {
            Assert.Equal("stable/theme/cedar", AssetKeys.StableTheme("cedar"));
            var root = new DirectoryInfo(System.AppContext.BaseDirectory);
            while (root != null && !File.Exists(Path.Combine(root.FullName, "contracts", "assets.manifest.json"))) root = root.Parent;
            var keys = AssetKeys.ParseManifestKeys(File.ReadAllText(Path.Combine(root!.FullName, "contracts", "assets.manifest.json")));
            var stable = JsonNode.Parse(File.ReadAllText(Path.Combine(root.FullName, "server", "master", "stable.json")));
            foreach (var t in stable.Get("themes").Items) Assert.Contains(AssetKeys.StableTheme(t.Get("id").AsString()), keys);
            Assert.Contains(AssetKeys.Fallback("stable/theme"), keys);
        }
    }
}
