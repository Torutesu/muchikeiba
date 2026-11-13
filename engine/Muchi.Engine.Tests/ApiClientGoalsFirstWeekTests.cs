using System.Threading.Tasks;
using Muchi.Client;
using Xunit;

namespace Muchi.Engine.Tests
{
    /// <summary>
    /// REQ-GOAL-013..015 (quality pass 2, the first week): today.tomorrow, partner and path.current.screen/open on JSON produced
    /// by the real server (a day-1 player: login bonus received, 3 races, the partner trained twice), and an older server's
    /// ladder (no new fields) still parsing.
    /// </summary>
    public class ApiClientGoalsFirstWeekTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientGoalsFirstWeekTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        internal const string Day1 = @"{""day"":""2026-11-13"",""now"":1794500702748,""today"":{""open"":true,""items"":[{""id"":""race3"",""table"":""daily"",""kind"":""races"",""progress"":3,""target"":3,""reward"":{""freeCoins"":15},""claimed"":false,""claimable"":true},{""id"":""win1"",""table"":""daily"",""kind"":""wins"",""progress"":1,""target"":1,""reward"":{""freeCoins"":30},""claimed"":false,""claimable"":true},{""id"":""top3x2"",""table"":""daily"",""kind"":""top3"",""progress"":2,""target"":2,""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]},""claimed"":false,""claimable"":true},{""id"":""train1"",""table"":""daily"",""kind"":""training"",""progress"":1,""target"":1,""reward"":{""items"":[{""itemId"":""training_apple"",""qty"":1}]},""claimed"":false,""claimable"":true},{""id"":""first_win"",""table"":""first_win"",""kind"":""first_win"",""progress"":1,""target"":1,""reward"":{""freeCoins"":30},""claimed"":true,""claimable"":false}],""done"":5,""total"":5,""claimable"":4,""complete"":false,""resetAt"":1794582000000,""loginBonus"":{""open"":true,""claimedToday"":true,""next"":{""track"":""beginner"",""day"":2,""days"":7,""reward"":{""broodmare"":""t_broodmare""}}},""playerDay"":1,""tomorrow"":{""playerDay"":2,""at"":1794582000000,""loginBonus"":{""track"":""beginner"",""day"":2,""days"":7,""reward"":{""broodmare"":""t_broodmare""}},""opens"":[""breeding"",""friends"",""friend_rooms""],""trainingSlots"":3}},""path"":{""step"":1,""steps"":10,""done"":0,""current"":{""id"":""bm_scout"",""table"":""beginner"",""kind"":""gacha"",""progress"":1,""target"":1,""reward"":{""freeCoins"":50},""claimed"":false,""claimable"":true,""screen"":""scout"",""open"":true},""finalReward"":{""items"":[{""itemId"":""gacha_ticket_10"",""qty"":1}]}},""week"":null,""season"":{""open"":false,""seasonId"":""2026-11"",""endsAt"":1796050800000,""classId"":""C"",""nextClassId"":""B"",""points"":62,""races"":3,""line"":300,""left"":238,""demoteBelow"":null,""status"":""rookie"",""pace"":{""races"":3,""pace10"":206,""racesToLine"":12,""minRaces"":3},""power"":{""horseId"":""h1"",""partner"":true,""total"":3330,""cap"":2800,""usable"":2800,""nextCap"":3200,""nextUsable"":3200,""held"":530},""ladder"":[{""classId"":""C"",""statCap"":2800,""promotePoints"":300,""demoteBelowPoints"":null,""current"":true,""reached"":true,""rewards"":{""top"":{""maxRank"":10,""reward"":{""freeCoins"":300}},""floor"":{""freeCoins"":50}}},{""classId"":""B"",""statCap"":3200,""promotePoints"":400,""demoteBelowPoints"":50,""current"":false,""reached"":false,""rewards"":{""top"":{""maxRank"":10,""reward"":{""freeCoins"":500}},""floor"":{""freeCoins"":80}}},{""classId"":""A"",""statCap"":3600,""promotePoints"":500,""demoteBelowPoints"":80,""current"":false,""reached"":false,""rewards"":{""top"":{""maxRank"":10,""reward"":{""freeCoins"":800,""items"":[{""itemId"":""gacha_ticket"",""qty"":1}]}},""floor"":{""freeCoins"":120}}},{""classId"":""S"",""statCap"":4000,""promotePoints"":null,""demoteBelowPoints"":100,""current"":false,""reached"":false,""rewards"":{""top"":{""maxRank"":1,""reward"":{""freeCoins"":3000,""items"":[{""itemId"":""ticket_sr_plus"",""qty"":1}]}},""floor"":{""freeCoins"":200}}}],""missions"":[{""id"":""sm_races10"",""table"":""season"",""kind"":""ranked_races"",""progress"":3,""target"":10,""reward"":{""passXp"":100},""claimed"":false,""claimable"":false},{""id"":""sm_races30"",""table"":""season"",""kind"":""ranked_races"",""progress"":3,""target"":30,""reward"":{""passXp"":200},""claimed"":false,""claimable"":false},{""id"":""sm_wins5"",""table"":""season"",""kind"":""wins"",""progress"":1,""target"":5,""reward"":{""passXp"":150},""claimed"":false,""claimable"":false},{""id"":""sm_top3_15"",""table"":""season"",""kind"":""top3"",""progress"":2,""target"":15,""reward"":{""passXp"":150},""claimed"":false,""claimable"":false},{""id"":""sm_promotion"",""table"":""season"",""kind"":""promotion_line"",""progress"":62,""target"":300,""reward"":{""passXp"":300},""claimed"":false,""claimable"":false}],""pass"":{""level"":0,""maxLevel"":30,""freeClaimable"":0},""promotion"":null},""partner"":{""horseId"":""h1"",""name"":""アカツキ"",""stage"":0,""stageKey"":""debut"",""stages"":5,""stageFrom"":0,""nextStageAt"":24,""trainedTotal"":10,""potential"":240,""gainedToday"":10,""gainedYesterday"":0,""trainingOpen"":true,""sessionsLeft"":0,""full"":false},""claimable"":5}";

        [Fact]
        public async Task ParsesTomorrowThePartnerAndTheStepScreen()
        {
            _http.Reply(200, Day1);
            var v = await _api.GetGoalsAsync();
            Assert.Equal(1, v.Today.PlayerDay);
            var t = v.Today.Tomorrow;
            Assert.NotNull(t);
            Assert.Equal(2, t.PlayerDay);
            Assert.Equal(v.Today.ResetAt, t.At);
            Assert.Equal("beginner", t.LoginTrack);
            Assert.Equal(2, t.LoginDay);
            Assert.Equal("t_broodmare", t.LoginReward.Broodmare);
            Assert.Equal(new[] { "breeding", "friends", "friend_rooms" }, t.Opens.ToArray());
            Assert.Equal(3, t.TrainingSlots);
            var p = v.Partner;
            Assert.NotNull(p);
            Assert.Equal("debut", p.StageKey);
            Assert.Equal(5, p.Stages);
            Assert.Equal(24, p.NextStageAt);
            Assert.Equal(10, p.TrainedTotal);
            Assert.Equal(10, p.GainedToday);
            Assert.Equal(0, p.SessionsLeft);
            Assert.True(p.TrainingOpen);
            Assert.Equal("scout", v.Path.Current.Screen);
            Assert.True(v.Path.Current.Open);
            Assert.True(v.Path.Current.Claimable);
        }

        [Fact]
        public async Task AnOlderServerWithoutTheFirstWeekFieldsStillParses()
        {
            _http.Reply(200, ApiClientGoalsTests.View);
            var v = await _api.GetGoalsAsync();
            Assert.Null(v.Today.Tomorrow);
            Assert.Equal(0, v.Today.PlayerDay);
            Assert.Null(v.Partner);
            Assert.Null(v.Path.Current.Screen);
            Assert.True(v.Path.Current.Open);
        }
    }
}
