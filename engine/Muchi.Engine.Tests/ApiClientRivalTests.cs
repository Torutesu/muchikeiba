using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-RIVAL-001..016: /v1/rival client methods and models (contracts/protocol.md §28).</summary>
    public class ApiClientRivalTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientRivalTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        // produced by the real server (RivalService.view over PlayerService + MemoryRivalRegistry): week 1 against the CPU,
        // week 2 paired with the human candidate, three ranked races, one challenge race, a time attack each
        internal const string Human = "{\"enabled\":true,\"optOut\":false,\"weekId\":\"2026-12-14\",\"weekEndsAt\":1797793200000,\"rival\":{\"kind\":\"human\",\"playerId\":\"b\",\"card\":{\"displayName\":\"ハヤテ乗り\",\"titleId\":null,\"classId\":\"C\",\"silks\":{\"pattern\":\"chevrons\",\"colors\":[\"brown\",\"yellow\"],\"cap\":\"plain\"},\"partner\":{\"name\":\"ハヤテ\",\"rarity\":\"SR\",\"style\":\"sashi\",\"appearance\":{\"coat\":\"chestnut\",\"face\":\"blaze\",\"legs\":[\"none\",\"none\",\"sock\",\"none\"],\"mane\":\"normal\",\"build\":\"standard\"}}},\"dissolved\":false},\"score\":{\"me\":2,\"them\":1,\"rankedRaces\":3,\"minRaces\":3,\"taMe\":1,\"taThem\":0},\"recent\":[{\"raceId\":\"r6\",\"at\":1797303600000,\"mode\":\"friend\",\"me\":3,\"them\":4,\"point\":null},{\"raceId\":\"r5\",\"at\":1797303600000,\"mode\":\"ranked\",\"me\":1,\"them\":2,\"point\":\"me\"},{\"raceId\":\"r4\",\"at\":1797303600000,\"mode\":\"ranked\",\"me\":6,\"them\":3,\"point\":\"them\"},{\"raceId\":\"r3\",\"at\":1797303600000,\"mode\":\"ranked\",\"me\":2,\"them\":5,\"point\":\"me\"}],\"timeAttack\":[{\"trackId\":\"aoba_turf_1600\",\"trackName\":\"青葉競馬場 芝1600m\",\"me\":70210,\"rival\":71004,\"faster\":\"me\"}],\"result\":{\"weekId\":\"2026-12-07\",\"outcome\":\"win\",\"kind\":\"cpu\",\"rivalName\":\"堅実のアサギ\",\"me\":3,\"them\":0,\"taMe\":0,\"taThem\":0,\"freeCoins\":20,\"settledAt\":1797303600000,\"newTitles\":[\"rival_first\"]},\"history\":[{\"weekId\":\"2026-12-07\",\"outcome\":\"win\",\"kind\":\"cpu\",\"rivalName\":\"堅実のアサギ\",\"me\":3,\"them\":0,\"taMe\":0,\"taThem\":0,\"freeCoins\":20,\"settledAt\":1797303600000,\"newTitles\":[\"rival_first\"]}],\"record\":{\"weeksWon\":1,\"weeksPlayed\":1,\"titles\":[{\"titleId\":\"rival_first\",\"name\":\"好敵手\",\"weeksWon\":1,\"unlocked\":true},{\"titleId\":\"rival_5\",\"name\":\"宿命の対決\",\"weeksWon\":5,\"unlocked\":false},{\"titleId\":\"rival_20\",\"name\":\"ライバルキラー\",\"weeksWon\":20,\"unlocked\":false}],\"nextTitle\":{\"titleId\":\"rival_5\",\"name\":\"宿命の対決\",\"weeksWon\":5,\"unlocked\":false}},\"rewards\":{\"win\":20,\"draw\":10,\"lose\":10,\"noContest\":10,\"minRaces\":3},\"challenge\":{\"left\":3,\"perDay\":3},\"rules\":{\"rankedOnly\":true,\"challengeUnranked\":true,\"fixedRewards\":true,\"noStreakRewards\":true,\"taBreaksTies\":true}}";
        internal const string Cpu = "{\"enabled\":true,\"optOut\":false,\"weekId\":\"2026-12-14\",\"weekEndsAt\":1797793200000,\"rival\":{\"kind\":\"cpu\",\"cpuId\":\"cpu_asagi\",\"name\":\"堅実のアサギ\",\"personality\":\"steady\",\"line\":\"毎週コツコツ。今週も先に着くのはこっちだ\",\"style\":\"senko\",\"targetPlace\":6,\"taMedal\":\"silver\"},\"score\":{\"me\":2,\"them\":1,\"rankedRaces\":3,\"minRaces\":3,\"taMe\":1,\"taThem\":0},\"recent\":[{\"raceId\":\"r9\",\"at\":1797303600000,\"mode\":\"ranked\",\"me\":4,\"them\":null,\"point\":\"me\"}],\"timeAttack\":[{\"trackId\":\"aoba_turf_1600\",\"trackName\":\"青葉競馬場 芝1600m\",\"me\":70210,\"rival\":71004,\"faster\":\"me\"}],\"result\":null,\"history\":[{\"weekId\":\"2026-12-07\",\"outcome\":\"win\",\"kind\":\"cpu\",\"rivalName\":\"堅実のアサギ\",\"me\":3,\"them\":0,\"taMe\":0,\"taThem\":0,\"freeCoins\":20,\"settledAt\":1797303600000,\"newTitles\":[\"rival_first\"]}],\"record\":{\"weeksWon\":1,\"weeksPlayed\":1,\"titles\":[{\"titleId\":\"rival_first\",\"name\":\"好敵手\",\"weeksWon\":1,\"unlocked\":true},{\"titleId\":\"rival_5\",\"name\":\"宿命の対決\",\"weeksWon\":5,\"unlocked\":false},{\"titleId\":\"rival_20\",\"name\":\"ライバルキラー\",\"weeksWon\":20,\"unlocked\":false}],\"nextTitle\":{\"titleId\":\"rival_5\",\"name\":\"宿命の対決\",\"weeksWon\":5,\"unlocked\":false}},\"rewards\":{\"win\":20,\"draw\":10,\"lose\":10,\"noContest\":10,\"minRaces\":3},\"challenge\":null,\"rules\":{\"rankedOnly\":true,\"challengeUnranked\":true,\"fixedRewards\":true,\"noStreakRewards\":true,\"taBreaksTies\":true}}";
        internal const string Result = "{\"enabled\":true,\"optOut\":false,\"weekId\":\"2026-12-21\",\"weekEndsAt\":1798398000000,\"rival\":{\"kind\":\"human\",\"playerId\":\"b\",\"card\":{\"displayName\":\"ハヤテ乗り\",\"titleId\":null,\"classId\":\"C\",\"silks\":{\"pattern\":\"chevrons\",\"colors\":[\"brown\",\"yellow\"],\"cap\":\"plain\"},\"partner\":{\"name\":\"ハヤテ\",\"rarity\":\"SR\",\"style\":\"sashi\",\"appearance\":{\"coat\":\"chestnut\",\"face\":\"blaze\",\"legs\":[\"none\",\"none\",\"sock\",\"none\"],\"mane\":\"normal\",\"build\":\"standard\"}}},\"dissolved\":false},\"score\":{\"me\":0,\"them\":0,\"rankedRaces\":0,\"minRaces\":3,\"taMe\":0,\"taThem\":0},\"recent\":[],\"timeAttack\":[],\"result\":{\"weekId\":\"2026-12-14\",\"outcome\":\"win\",\"kind\":\"human\",\"rivalName\":\"ハヤテ乗り\",\"me\":2,\"them\":1,\"taMe\":1,\"taThem\":0,\"freeCoins\":20,\"settledAt\":1797908400000,\"newTitles\":[]},\"history\":[{\"weekId\":\"2026-12-14\",\"outcome\":\"win\",\"kind\":\"human\",\"rivalName\":\"ハヤテ乗り\",\"me\":2,\"them\":1,\"taMe\":1,\"taThem\":0,\"freeCoins\":20,\"settledAt\":1797908400000,\"newTitles\":[]},{\"weekId\":\"2026-12-07\",\"outcome\":\"win\",\"kind\":\"cpu\",\"rivalName\":\"堅実のアサギ\",\"me\":3,\"them\":0,\"taMe\":0,\"taThem\":0,\"freeCoins\":20,\"settledAt\":1797303600000,\"newTitles\":[\"rival_first\"]}],\"record\":{\"weeksWon\":2,\"weeksPlayed\":2,\"titles\":[{\"titleId\":\"rival_first\",\"name\":\"好敵手\",\"weeksWon\":1,\"unlocked\":true},{\"titleId\":\"rival_5\",\"name\":\"宿命の対決\",\"weeksWon\":5,\"unlocked\":false},{\"titleId\":\"rival_20\",\"name\":\"ライバルキラー\",\"weeksWon\":20,\"unlocked\":false}],\"nextTitle\":{\"titleId\":\"rival_5\",\"name\":\"宿命の対決\",\"weeksWon\":5,\"unlocked\":false}},\"rewards\":{\"win\":20,\"draw\":10,\"lose\":10,\"noContest\":10,\"minRaces\":3},\"challenge\":{\"left\":3,\"perDay\":3},\"rules\":{\"rankedOnly\":true,\"challengeUnranked\":true,\"fixedRewards\":true,\"noStreakRewards\":true,\"taBreaksTies\":true}}";

        [Fact]
        public async Task HumanRivalViewParsesCardScoreRacesAndTimeAttack()
        {
            _http.Reply(200, Human);
            var v = await _api.GetRivalAsync();
            Assert.Equal("/v1/rival", _http.Requests[0].Path);
            Assert.True(v.Enabled);
            Assert.Equal("2026-12-14", v.WeekId);
            Assert.True(v.Rival.IsHuman);
            Assert.Equal("ハヤテ乗り", v.Rival.DisplayName);
            Assert.Equal("ハヤテ", v.Rival.Card.Partner.Name);
            Assert.Equal("chestnut", v.Rival.Card.Partner.Appearance.Coat);
            Assert.Equal("chevrons", v.Rival.Card.Silks.Pattern);
            Assert.Equal(2, v.Score.Me);
            Assert.Equal(1, v.Score.Them);
            Assert.True(v.Score.Qualified);
            Assert.Equal(1, v.Score.TaMe);
            Assert.Equal("friend", v.Recent[0].Mode);
            Assert.Null(v.Recent[0].Point);
            Assert.Equal("me", v.Recent[1].Point);
            Assert.Equal(2, v.Recent[1].Them);
            Assert.Equal(70210, v.TimeAttack[0].Me);
            Assert.Equal("me", v.TimeAttack[0].Faster);
            Assert.Equal("win", v.Result.Outcome);
            Assert.Equal("cpu", v.Result.Kind);
            Assert.Equal(20, v.Result.FreeCoins);
            Assert.Contains("rival_first", v.Result.NewTitles);
            Assert.Equal(1, v.Record.WeeksWon);
            Assert.Equal("rival_5", v.Record.NextTitle.TitleId);
            Assert.Equal(20, v.Rewards.Win);
            Assert.Equal(3, v.Rewards.MinRaces);
            Assert.Equal(3, v.ChallengesLeft);
            Assert.True(v.Rules.ChallengeUnranked);
            Assert.True(v.Rules.NoStreakRewards);
        }

        [Fact]
        public async Task CpuRivalAndWeekResult()
        {
            _http.Reply(200, Cpu);
            var v = await _api.GetRivalAsync();
            Assert.True(v.Rival.IsCpu);
            Assert.Equal("堅実のアサギ", v.Rival.DisplayName);
            Assert.Equal(6, v.Rival.TargetPlace);
            Assert.Equal("steady", v.Rival.Personality);
            Assert.Null(v.Recent[0].Them);
            Assert.Null(v.ChallengesLeft);
            Assert.Null(v.Result);

            _http.Reply(200, Result);
            var r = await _api.GetRivalAsync();
            Assert.Equal("2026-12-14", r.Result.WeekId);
            Assert.Equal("human", r.Result.Kind);
            Assert.Equal("ハヤテ乗り", r.Result.RivalName);
            Assert.Equal(2, r.History.Count);
        }

        [Fact]
        public async Task SettingsBlockChallengeSeen()
        {
            _http.Reply(200, "{\"optOut\":true}");
            Assert.True(await _api.SetRivalOptOutAsync(true));
            Assert.Equal("PUT", _http.Requests[0].Method);
            Assert.Equal("/v1/rival/settings", _http.Requests[0].Path);
            Assert.Contains("\"optOut\":true", _http.Requests[0].Body);

            _http.Reply(200, "{\"blocked\":\"u_9\",\"dissolved\":true}");
            Assert.Equal("u_9", await _api.BlockRivalAsync());
            Assert.Equal("/v1/rival/block", _http.Requests[1].Path);

            _http.Reply(200, "{\"ok\":true,\"rivalId\":\"u_9\"}");
            Assert.Equal("u_9", await _api.ChallengeRivalAsync("さくら-42"));
            Assert.Contains("\"passphrase\":\"さくら-42\"", _http.Requests[2].Body);

            _http.Reply(200, "{\"unseen\":null}");
            Assert.True(await _api.MarkRivalResultSeenAsync("2026-12-14"));
            Assert.Equal("/v1/rival/results/2026-12-14/seen", _http.Requests[3].Path);

            _http.Reply(409, "{\"error\":{\"code\":\"RIVAL_CHALLENGE_LIMIT\",\"message\":\"at most 3 challenges per day\"}}");
            var e = await Assert.ThrowsAsync<ConflictException>(() => _api.ChallengeRivalAsync("x"));
            Assert.Equal(ApiErrorCode.RivalChallengeLimit, e.Code);
        }

        [Fact]
        public async Task DisabledHidesTheCard()
        {
            _http.Reply(200, "{\"enabled\":false}");
            var v = await _api.GetRivalAsync();
            Assert.False(v.Enabled);
            Assert.Null(v.Rival);
        }
    }
}
