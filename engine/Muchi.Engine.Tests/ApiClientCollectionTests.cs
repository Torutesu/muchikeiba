using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-COL-001..005 / REQ-ACH-001..009: 図鑑, achievements, claims and achievement titles (server/src/domain/collection.ts).</summary>
    public class ApiClientCollectionTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientCollectionTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        internal const string BookJson = "{\"sections\":{"
            + "\"horses\":{\"total\":3,\"obtained\":1,\"seen\":1,\"unknown\":1,\"completionPermille\":333,\"entries\":["
            + "{\"id\":\"t_partner\",\"state\":\"obtained\",\"rarity\":\"SR\",\"name\":\"アイボウ\",\"style\":\"sashi\",\"surface\":\"turf\",\"distance\":{\"minM\":1600,\"maxM\":2400},\"skillId\":\"sk_sueashi\",\"lore\":\"はじめての相棒。\",\"stats\":{\"speed\":600,\"stamina\":550,\"burst\":650,\"guts\":500,\"temper\":500},\"seasonal\":null,\"art\":\"collection/portrait/t_partner\"},"
            + "{\"id\":\"t_aozora\",\"state\":\"seen\",\"rarity\":\"R\",\"name\":\"アオゾラマーチ\",\"style\":\"nige\",\"surface\":\"turf\",\"distance\":{\"minM\":1200,\"maxM\":1800},\"skillId\":\"sk_ichibanyari\",\"lore\":\"元気な逃げ馬。\",\"stats\":null,\"seasonal\":null,\"art\":\"collection/portrait/t_aozora\"},"
            + "{\"id\":\"t_seiya\",\"state\":\"unknown\",\"rarity\":\"SSR\",\"name\":null,\"style\":null,\"surface\":null,\"distance\":null,\"skillId\":null,\"lore\":null,\"stats\":null,\"seasonal\":{\"label\":\"冬季限定\"},\"art\":\"collection/silhouette/t_seiya\"}]},"
            + "\"skills\":{\"total\":1,\"obtained\":1,\"seen\":0,\"unknown\":0,\"completionPermille\":1000,\"entries\":[{\"id\":\"sk_sueashi\",\"state\":\"obtained\",\"rarity\":\"SR\",\"name\":\"末脚一閃\",\"styles\":[\"sashi\"],\"condition\":\"後方から\",\"effect\":\"速度+\",\"lore\":\"一閃\"}]},"
            + "\"courses\":{\"total\":1,\"obtained\":1,\"seen\":0,\"unknown\":0,\"completionPermille\":1000,\"entries\":[{\"id\":\"aoba_turf_1600\",\"state\":\"obtained\",\"name\":\"青葉競馬場 芝1600m\",\"surface\":\"turf\",\"distanceM\":1600,\"lore\":\"マイル\",\"races\":4,\"wins\":1,\"bestFinishTick\":1700,\"timeAttackBestMs\":null}]},"
            + "\"cosmetics\":{\"total\":1,\"obtained\":0,\"seen\":0,\"unknown\":1,\"completionPermille\":0,\"entries\":[{\"id\":\"decor_flower_box\",\"state\":\"unknown\",\"kind\":\"decor\",\"name\":\"花のプランター\",\"lore\":null,\"icon\":\"item/decor_flower_box\"}]}},"
            + "\"totals\":{\"total\":6,\"obtained\":3,\"seen\":1,\"unknown\":2,\"completionPermille\":500},\"completionRewards\":false,\"notice\":\"図鑑の達成率は記録の表示だけです。そろえても報酬はありません。\"}";

        internal const string AchievementsJson = "{\"achievements\":[{\"id\":\"races\",\"category\":\"race\",\"name\":\"出走の記録\",\"description\":\"出走する\",\"metric\":\"races\",\"progress\":12,\"nextTarget\":50,\"tier\":1,\"maxTier\":2,\"badge\":\"badge/races_1\","
            + "\"tiers\":[{\"tier\":1,\"target\":10,\"reward\":{\"freeCoins\":10},\"unlocked\":true,\"unlockedAt\":1795000000000,\"claimed\":false,\"claimable\":true,\"badge\":\"badge/races_1\"},"
            + "{\"tier\":2,\"target\":50,\"reward\":{\"freeCoins\":20},\"unlocked\":false,\"unlockedAt\":null,\"claimed\":false,\"claimable\":false,\"badge\":\"badge/races_2\"}],\"titles\":[]},"
            + "{\"id\":\"tournament_win\",\"category\":\"tournament\",\"name\":\"大会の覇者\",\"description\":\"優勝\",\"metric\":\"tournamentWins\",\"progress\":0,\"nextTarget\":1,\"tier\":0,\"maxTier\":1,\"badge\":null,"
            + "\"tiers\":[{\"tier\":1,\"target\":1,\"reward\":{\"freeCoins\":20},\"unlocked\":false,\"unlockedAt\":null,\"claimed\":false,\"claimable\":false,\"badge\":\"badge/tournament_win_1\"}],"
            + "\"titles\":[{\"id\":\"ach_champion\",\"name\":\"大会の覇者\",\"tier\":1,\"unlocked\":false,\"icon\":\"title/ach_champion\"}]}],"
            + "\"blocked\":false,\"totals\":{\"tiers\":3,\"unlocked\":1,\"claimed\":0,\"claimable\":1,\"claimableCoins\":10,\"earnedCoins\":0,\"totalCoins\":50},\"notice\":\"課金やガチャの回数では達成しません。\"}";

        [Fact]
        public async Task CollectionBookParses()
        {
            _http.Reply(200, BookJson);
            var b = await _api.GetCollectionAsync();
            Assert.Equal("GET /v1/collection", _http.Requests[0].ToString());
            Assert.False(b.CompletionRewards);
            Assert.Equal(500, b.Totals.CompletionPermille);
            Assert.Equal("50%", b.Totals.CompletionText);
            Assert.Equal(3, b.Horses.Counts.Total);
            var partner = b.Horses.Entries[0];
            Assert.True(partner.Obtained);
            Assert.Equal(650, partner.Stats.Burst);
            Assert.Equal(2400, partner.DistMaxM);
            Assert.Null(b.Horses.Entries[1].Stats);
            var unknown = b.Horses.Entries[2];
            Assert.True(unknown.Unknown);
            Assert.Null(unknown.Name);
            Assert.Equal("collection/silhouette/t_seiya", unknown.Art);
            Assert.Equal(AssetKeys.CollectionSilhouette("t_seiya"), unknown.Art);
            Assert.Equal("冬季限定", unknown.SeasonalLabel);
            Assert.Equal("末脚一閃", b.Skills.Entries[0].Name);
            Assert.Equal(1700, b.Courses.Entries[0].BestFinishTick);
            Assert.Null(b.Courses.Entries[0].TimeAttackBestMs);
            Assert.Equal("decor", b.Cosmetics.Entries[0].Kind);
        }

        [Fact]
        public async Task AchievementsParse()
        {
            _http.Reply(200, AchievementsJson);
            var a = await _api.GetAchievementsAsync();
            Assert.Equal("GET /v1/achievements", _http.Requests[0].ToString());
            Assert.Equal(1, a.Totals.Claimable);
            Assert.Equal(10, a.Totals.ClaimableCoins);
            var races = a.Achievements[0];
            Assert.Equal(50, races.NextTarget);
            Assert.True(races.Tiers[0].Claimable);
            Assert.Equal(1795000000000, races.Tiers[0].UnlockedAt);
            Assert.Null(races.Tiers[1].UnlockedAt);
            Assert.Equal(AssetKeys.Badge("races", 2), races.Tiers[1].Badge);
            Assert.Equal("ach_champion", a.Achievements[1].Titles[0].Id);
            Assert.Null(a.Achievements[1].Badge);
        }

        [Fact]
        public async Task ClaimIsKeyedAndRetriedWithTheSameKey()
        {
            _http.Reply(503, "{\"error\":{\"code\":\"INTERNAL\",\"message\":\"x\"}}").Reply(200, "{\"achievementId\":\"races\",\"tier\":1,\"reward\":{\"freeCoins\":10},\"wallet\":{\"free\":110,\"paid\":0}}");
            var c = await _api.ClaimAchievementAsync("races", 1);
            Assert.Equal("POST /v1/achievements/races/tiers/1/claim", _http.Requests[0].ToString());
            Assert.Equal(_http.Requests[0].Headers["idempotency-key"], _http.Requests[1].Headers["idempotency-key"]);
            Assert.Single(c.Claimed);
            Assert.Equal(10, c.FreeCoins);
            Assert.Equal(110, c.WalletFree);
        }

        [Fact]
        public async Task ClaimAllAndErrors()
        {
            _http.Reply(200, "{\"claimed\":[{\"achievementId\":\"races\",\"tier\":1,\"reward\":{\"freeCoins\":10}},{\"achievementId\":\"wins\",\"tier\":1,\"reward\":{\"freeCoins\":10}}],\"freeCoins\":20,\"wallet\":{\"free\":120,\"paid\":0}}");
            var c = await _api.ClaimAllAchievementsAsync();
            Assert.Equal("POST /v1/achievements/claim-all", _http.Requests[0].ToString());
            Assert.Equal(2, c.Claimed.Count);
            Assert.Equal(20, c.FreeCoins);
            _http.Reply(409, "{\"error\":{\"code\":\"ALREADY_CLAIMED\",\"message\":\"races tier 1\"}}");
            var ex = await Assert.ThrowsAsync<ConflictException>(() => _api.ClaimAchievementAsync("races", 1));
            Assert.Equal(ApiErrorCode.AlreadyClaimed, ex.Code);
        }

        [Fact]
        public async Task TitlesCarryTheirAchievementTierAndStableShowsBadges()
        {
            _http.Reply(200, "{\"equipped\":\"ach_champion\",\"titles\":[{\"id\":\"debut\",\"name\":\"デビュー\",\"icon\":\"title/debut\",\"unlocked\":true,\"source\":\"record\"},"
                + "{\"id\":\"ach_champion\",\"name\":\"大会の覇者\",\"icon\":\"title/ach_champion\",\"unlocked\":true,\"source\":\"achievement\",\"achievementId\":\"tournament_win\",\"tier\":1}]}");
            var t = await _api.GetTitlesAsync();
            Assert.False(t.Titles[0].FromAchievement);
            Assert.True(t.Titles[1].FromAchievement);
            Assert.Equal("tournament_win", t.Titles[1].AchievementId);
            Assert.Equal(1, t.Titles[1].Tier);
            var tr = StableTrophiesFrom("{\"titleIds\":[\"debut\"],\"races\":3,\"wins\":1,\"top3\":2,\"tournamentWins\":1,\"tournamentPodiums\":1,\"badges\":[{\"achievementId\":\"races\",\"tier\":2,\"badge\":\"badge/races_2\"}]}");
            Assert.Equal("badge/races_2", tr.Badges[0].Badge);
            Assert.Empty(StableTrophiesFrom("{\"titleIds\":[],\"races\":0,\"wins\":0,\"top3\":0,\"tournamentWins\":0,\"tournamentPodiums\":0}").Badges);
        }

        private static StableTrophies StableTrophiesFrom(string json)
        {
            var m = typeof(StableTrophies).GetMethod("Parse", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
            return (StableTrophies)m.Invoke(null, new object[] { JsonNode.Parse(json) });
        }
    }
}
