using System.Linq;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-RECAP-010/011/016: シーズンの振り返り client methods, models and the share cards (contracts/protocol.md §43).</summary>
    public class SeasonRecapTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public SeasonRecapTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        // produced by the real server code (PlayerService: 7 ranked races on the partner, promoted C → B, final rank 4)
        internal const string List = "{\"enabled\":true,\"recaps\":[{\"id\":\"season:2026-11\",\"kind\":\"season\",\"periodId\":\"2026-11\",\"title\":\"2026年11月シーズン\",\"short\":false,\"builtAt\":1796054400000,\"opened\":false,\"completed\":false}],\"unseen\":\"season:2026-11\"}";
        internal const string View = "{\"id\":\"season:2026-11\",\"kind\":\"season\",\"periodId\":\"2026-11\",\"title\":\"2026年11月シーズン\",\"short\":false,\"sinceNote\":null,\"steps\":[{\"unit\":\"戦\",\"notes\":[\"3着以内 6回\"],\"key\":\"races\",\"label\":\"走ったレース\",\"value\":\"7\"},{\"unit\":\"勝\",\"notes\":[\"勝率 57%\"],\"key\":\"wins\",\"label\":\"勝利\",\"value\":\"4\"},{\"unit\":null,\"notes\":[\"12頭立て\"],\"key\":\"best_finish\",\"label\":\"最高着順\",\"value\":\"1着\"},{\"unit\":null,\"notes\":[\"最終順位 4位\",\"C級からB級へ昇格\"],\"key\":\"rank\",\"label\":\"到達したクラス\",\"value\":\"B級\"},{\"unit\":null,\"notes\":[\"7戦4勝\"],\"key\":\"horse\",\"label\":\"いちばん一緒に走った馬\",\"value\":null,\"horseName\":\"アイボウ\"},{\"unit\":null,\"notes\":[\"5戦\"],\"key\":\"style\",\"label\":\"よく使った脚質\",\"value\":\"差し\"},{\"unit\":null,\"notes\":[],\"key\":\"moments\",\"label\":\"名場面\",\"value\":null,\"moments\":[{\"kind\":\"promotion\",\"text\":\"C級からB級へ昇格\",\"horseName\":null},{\"kind\":\"first_win\",\"text\":\"シーズン初勝利（きらめき競馬場 芝2000m）\",\"horseName\":\"アイボウ\"},{\"kind\":\"streak\",\"text\":\"2連勝\",\"horseName\":null}]},{\"unit\":null,\"notes\":[],\"key\":\"end\",\"label\":\"おつかれさまでした\",\"value\":null}],\"shareCards\":[{\"card\":\"summary\",\"title\":\"2026年11月シーズン\",\"headline\":\"7\",\"unit\":\"戦\",\"lines\":[\"4勝・3着以内 6回\"],\"horseName\":null,\"rank\":false},{\"card\":\"horse\",\"title\":\"2026年11月シーズン\",\"headline\":\"\",\"unit\":null,\"lines\":[\"いちばん一緒に走った馬\",\"7戦4勝\"],\"horseName\":\"アイボウ\",\"rank\":false},{\"card\":\"moment\",\"title\":\"2026年11月シーズン\",\"headline\":\"\",\"unit\":null,\"lines\":[\"名場面\",\"シーズン初勝利（きらめき競馬場 芝2000m）\"],\"horseName\":\"アイボウ\",\"rank\":false},{\"card\":\"rank\",\"title\":\"2026年11月シーズン\",\"headline\":\"B級\",\"unit\":null,\"lines\":[\"最終順位 4位\"],\"horseName\":null,\"rank\":true}],\"openedAt\":null,\"completedAt\":null}";
        internal const string ViewEn = "{\"id\":\"season:2026-11\",\"kind\":\"season\",\"periodId\":\"2026-11\",\"title\":\"Season 11/2026\",\"short\":false,\"sinceNote\":null,\"steps\":[{\"unit\":\"races\",\"notes\":[\"Top 3: 6 times\"],\"key\":\"races\",\"label\":\"Races run\",\"value\":\"7\"},{\"unit\":\"wins\",\"notes\":[\"Win rate 57%\"],\"key\":\"wins\",\"label\":\"Wins\",\"value\":\"4\"},{\"unit\":null,\"notes\":[\"12 runners\"],\"key\":\"best_finish\",\"label\":\"Best finish\",\"value\":\"1st\"},{\"unit\":null,\"notes\":[\"Final position: 4th\",\"Promoted from Class C to Class B\"],\"key\":\"rank\",\"label\":\"Class reached\",\"value\":\"Class B\"},{\"unit\":null,\"notes\":[\"7 races, 4 wins\"],\"key\":\"horse\",\"label\":\"Your most-raced horse\",\"value\":null,\"horseName\":\"アイボウ\"},{\"unit\":null,\"notes\":[\"5 races\"],\"key\":\"style\",\"label\":\"Most-used running style\",\"value\":\"Closer\"},{\"unit\":null,\"notes\":[],\"key\":\"moments\",\"label\":\"Moments\",\"value\":null,\"moments\":[{\"kind\":\"promotion\",\"text\":\"Promoted from Class C to Class B\",\"horseName\":null},{\"kind\":\"first_win\",\"text\":\"First win of the season (Kirameki Racecourse, Turf 2000 m)\",\"horseName\":\"アイボウ\"},{\"kind\":\"streak\",\"text\":\"2 wins in a row\",\"horseName\":null}]},{\"unit\":null,\"notes\":[],\"key\":\"end\",\"label\":\"Well ridden.\",\"value\":null}],\"shareCards\":[{\"card\":\"summary\",\"title\":\"Season 11/2026\",\"headline\":\"7\",\"unit\":\"races\",\"lines\":[\"4 wins, Top 3: 6 times\"],\"horseName\":null,\"rank\":false},{\"card\":\"horse\",\"title\":\"Season 11/2026\",\"headline\":\"\",\"unit\":null,\"lines\":[\"Your most-raced horse\",\"7 races, 4 wins\"],\"horseName\":\"アイボウ\",\"rank\":false},{\"card\":\"moment\",\"title\":\"Season 11/2026\",\"headline\":\"\",\"unit\":null,\"lines\":[\"Moments\",\"First win of the season (Kirameki Racecourse, Turf 2000 m)\"],\"horseName\":\"アイボウ\",\"rank\":false},{\"card\":\"rank\",\"title\":\"Season 11/2026\",\"headline\":\"Class B\",\"unit\":null,\"lines\":[\"Final position: 4th\"],\"horseName\":null,\"rank\":true}],\"openedAt\":null,\"completedAt\":null}";

        [Fact]
        public async Task ListsRecapsAndTheUnseenOne()
        {
            _http.Reply(200, List);
            var l = await _api.GetRecapsAsync();
            Assert.Equal("GET", _http.Requests[0].Method);
            Assert.Equal("/v1/recaps", _http.Requests[0].Path);
            Assert.True(l.Enabled);
            Assert.Single(l.Recaps);
            Assert.Equal("season:2026-11", l.Unseen);
            Assert.Equal("2026年11月シーズン", l.Recaps[0].Title);
            Assert.False(l.Recaps[0].IsYear);
        }

        [Fact]
        public async Task ParsesTheStepsInOrder()
        {
            _http.Reply(200, View);
            var v = await _api.GetRecapAsync("season:2026-11");
            Assert.Equal("/v1/recaps/season%3A2026-11", _http.Requests[0].Path);
            Assert.Equal(new[] { "races", "wins", "best_finish", "rank", "horse", "style", "moments", "end" }, v.Steps.Select(s => s.Key).ToArray());
            Assert.Equal("7", v.Steps[0].Value);
            Assert.Equal("戦", v.Steps[0].Unit);
            Assert.Equal("3着以内 6回", v.Steps[0].Notes[0]);
            Assert.Equal("アイボウ", v.Steps[4].HorseName);
            Assert.Null(v.Steps[4].Value);
            Assert.Equal("promotion", v.Steps[6].Moments[0].Kind);
            Assert.Null(v.SinceNote);
            Assert.False(v.Short);
        }

        [Fact]
        public async Task ProgressPostsTheStepAndRefusesOthers()
        {
            _http.Reply(200, "{\"openedAt\":1796054400000,\"completedAt\":null}");
            var p = await _api.RecapProgressAsync("season:2026-11", "open");
            Assert.Equal("POST", _http.Requests[0].Method);
            Assert.Equal("/v1/recaps/season%3A2026-11/progress", _http.Requests[0].Path);
            Assert.Contains("\"step\":\"open\"", _http.Requests[0].Body);
            Assert.Equal(1796054400000, p.OpenedAt);
            Assert.Null(p.CompletedAt);
            await Assert.ThrowsAsync<System.ArgumentException>(() => _api.RecapProgressAsync("season:2026-11", "share"));
        }

        [Fact]
        public void ShareCardsUseTheShareCardPathAndHideRank()
        {
            var v = RecapView.FromJson(View);
            var all = RecapShare.Build(v, hideRank: false);
            Assert.Equal(new[] { "recap_summary", "recap_horse", "recap_moment", "recap_rank" }, all.Select(c => c.Kind).ToArray());
            Assert.All(all, c => Assert.Equal(ShareCard.GameTitle, c.Watermark));
            Assert.Equal("7戦", all[0].PlaceText);
            Assert.Equal("アイボウ", all[1].HorseName);
            Assert.EndsWith("#ムチ一閃", all[0].ShareText);
            var hidden = RecapShare.Build(v, hideRank: true);
            Assert.DoesNotContain(hidden, c => c.Kind == "recap_rank");
            Assert.DoesNotContain(hidden, c => c.ShareText.Contains("位"));
        }

        [Fact]
        public void EnglishKeepsHorseNamesAndSpacesTheUnit()
        {
            var v = RecapView.FromJson(ViewEn);
            Assert.Equal("Season 11/2026", v.Title);
            Assert.Equal("アイボウ", v.Steps.First(s => s.Key == "horse").HorseName);
            var c = RecapShare.Build(v, false)[0];
            Assert.Equal("7 races", c.PlaceText);
            Assert.Equal("1st", v.Steps.First(s => s.Key == "best_finish").Value);
        }
    }
}
