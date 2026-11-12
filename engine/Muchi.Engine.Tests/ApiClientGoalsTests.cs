using System.Threading.Tasks;
using Muchi.Client;
using Xunit;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-GOAL-001/009: /v1/home/goals client methods on JSON produced by the real server (PlayerService.goals / claimGoals).</summary>
    public class ApiClientGoalsTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientGoalsTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        // a player after 10 ranked races (places 1,4,2,6,3,5,2,8,1,3) on 2026-12-08, its claim, and a fresh player
        internal const string View = @"{""day"":""2026-12-08"",""now"":1796698800000,""today"":{""open"":true,""items"":[{""id"":""race3"",""table"":""daily"",""kind"":""races"",""progress"":3,""target"":3,""reward"":{""freeCoins"":15},""claimed"":false,""claimable"":true},{""id"":""win1"",""table"":""daily"",""kind"":""wins"",""progress"":1,""target"":1,""reward"":{""freeCoins"":30},""claimed"":false,""claimable"":true},{""id"":""top3x2"",""table"":""daily"",""kind"":""top3"",""progress"":2,""target"":2,""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]},""claimed"":false,""claimable"":true},{""id"":""train1"",""table"":""daily"",""kind"":""training"",""progress"":0,""target"":1,""reward"":{""items"":[{""itemId"":""training_apple"",""qty"":1}]},""claimed"":false,""claimable"":false},{""id"":""first_win"",""table"":""first_win"",""kind"":""first_win"",""progress"":1,""target"":1,""reward"":{""freeCoins"":30},""claimed"":true,""claimable"":false}],""done"":4,""total"":5,""claimable"":3,""complete"":false,""resetAt"":1796756400000,""loginBonus"":{""open"":true,""claimedToday"":false}},""path"":{""step"":1,""steps"":10,""done"":0,""current"":{""id"":""bm_scout"",""table"":""beginner"",""kind"":""gacha"",""progress"":0,""target"":1,""reward"":{""freeCoins"":50},""claimed"":false,""claimable"":false},""finalReward"":{""items"":[{""itemId"":""gacha_ticket_10"",""qty"":1}]}},""week"":null,""season"":{""open"":true,""seasonId"":""2026-12"",""endsAt"":1798729200000,""classId"":""C"",""nextClassId"":""B"",""points"":165,""races"":10,""line"":300,""left"":135,""demoteBelow"":null,""status"":""climbing"",""pace"":{""races"":10,""pace10"":165,""racesToLine"":9,""minRaces"":3},""power"":{""horseId"":""h1"",""partner"":true,""total"":3320,""cap"":2800,""usable"":2800,""nextCap"":3200,""nextUsable"":3200,""held"":520},""ladder"":[{""classId"":""C"",""statCap"":2800,""promotePoints"":300,""demoteBelowPoints"":null,""current"":true,""reached"":true,""rewards"":{""top"":{""maxRank"":10,""reward"":{""freeCoins"":300}},""floor"":{""freeCoins"":50}}},{""classId"":""B"",""statCap"":3200,""promotePoints"":400,""demoteBelowPoints"":50,""current"":false,""reached"":false,""rewards"":{""top"":{""maxRank"":10,""reward"":{""freeCoins"":500}},""floor"":{""freeCoins"":80}}},{""classId"":""A"",""statCap"":3600,""promotePoints"":500,""demoteBelowPoints"":80,""current"":false,""reached"":false,""rewards"":{""top"":{""maxRank"":10,""reward"":{""freeCoins"":800,""items"":[{""itemId"":""gacha_ticket"",""qty"":1}]}},""floor"":{""freeCoins"":120}}},{""classId"":""S"",""statCap"":4000,""promotePoints"":null,""demoteBelowPoints"":100,""current"":false,""reached"":false,""rewards"":{""top"":{""maxRank"":1,""reward"":{""freeCoins"":3000,""items"":[{""itemId"":""ticket_sr_plus"",""qty"":1}]}},""floor"":{""freeCoins"":200}}}],""missions"":[{""id"":""sm_races10"",""table"":""season"",""kind"":""ranked_races"",""progress"":10,""target"":10,""reward"":{""passXp"":100},""claimed"":false,""claimable"":true},{""id"":""sm_races30"",""table"":""season"",""kind"":""ranked_races"",""progress"":10,""target"":30,""reward"":{""passXp"":200},""claimed"":false,""claimable"":false},{""id"":""sm_wins5"",""table"":""season"",""kind"":""wins"",""progress"":2,""target"":5,""reward"":{""passXp"":150},""claimed"":false,""claimable"":false},{""id"":""sm_top3_15"",""table"":""season"",""kind"":""top3"",""progress"":6,""target"":15,""reward"":{""passXp"":150},""claimed"":false,""claimable"":false},{""id"":""sm_promotion"",""table"":""season"",""kind"":""promotion_line"",""progress"":165,""target"":300,""reward"":{""passXp"":300},""claimed"":false,""claimable"":false}],""pass"":{""level"":2,""maxLevel"":30,""freeClaimable"":2},""promotion"":null},""claimable"":4}";
        internal const string Claim = @"{""claimed"":[{""id"":""race3"",""table"":""daily"",""reward"":{""freeCoins"":15}},{""id"":""win1"",""table"":""daily"",""reward"":{""freeCoins"":30}},{""id"":""top3x2"",""table"":""daily"",""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}},{""id"":""sm_races10"",""table"":""season"",""reward"":{""passXp"":100}}],""total"":{""freeCoins"":45,""passXp"":100,""items"":[{""itemId"":""breeding_material"",""qty"":1}]},""ladder"":{""day"":""2026-12-08"",""now"":1796698800000,""today"":{""open"":true,""items"":[{""id"":""race3"",""table"":""daily"",""kind"":""races"",""progress"":3,""target"":3,""reward"":{""freeCoins"":15},""claimed"":true,""claimable"":false},{""id"":""win1"",""table"":""daily"",""kind"":""wins"",""progress"":1,""target"":1,""reward"":{""freeCoins"":30},""claimed"":true,""claimable"":false},{""id"":""top3x2"",""table"":""daily"",""kind"":""top3"",""progress"":2,""target"":2,""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]},""claimed"":true,""claimable"":false},{""id"":""train1"",""table"":""daily"",""kind"":""training"",""progress"":0,""target"":1,""reward"":{""items"":[{""itemId"":""training_apple"",""qty"":1}]},""claimed"":false,""claimable"":false},{""id"":""first_win"",""table"":""first_win"",""kind"":""first_win"",""progress"":1,""target"":1,""reward"":{""freeCoins"":30},""claimed"":true,""claimable"":false}],""done"":4,""total"":5,""claimable"":0,""complete"":false,""resetAt"":1796756400000,""loginBonus"":{""open"":true,""claimedToday"":false}},""path"":{""step"":1,""steps"":10,""done"":0,""current"":{""id"":""bm_scout"",""table"":""beginner"",""kind"":""gacha"",""progress"":0,""target"":1,""reward"":{""freeCoins"":50},""claimed"":false,""claimable"":false},""finalReward"":{""items"":[{""itemId"":""gacha_ticket_10"",""qty"":1}]}},""week"":null,""season"":{""open"":true,""seasonId"":""2026-12"",""endsAt"":1798729200000,""classId"":""C"",""nextClassId"":""B"",""points"":165,""races"":10,""line"":300,""left"":135,""demoteBelow"":null,""status"":""climbing"",""pace"":{""races"":10,""pace10"":165,""racesToLine"":9,""minRaces"":3},""power"":{""horseId"":""h1"",""partner"":true,""total"":3320,""cap"":2800,""usable"":2800,""nextCap"":3200,""nextUsable"":3200,""held"":520},""ladder"":[{""classId"":""C"",""statCap"":2800,""promotePoints"":300,""demoteBelowPoints"":null,""current"":true,""reached"":true,""rewards"":{""top"":{""maxRank"":10,""reward"":{""freeCoins"":300}},""floor"":{""freeCoins"":50}}},{""classId"":""B"",""statCap"":3200,""promotePoints"":400,""demoteBelowPoints"":50,""current"":false,""reached"":false,""rewards"":{""top"":{""maxRank"":10,""reward"":{""freeCoins"":500}},""floor"":{""freeCoins"":80}}},{""classId"":""A"",""statCap"":3600,""promotePoints"":500,""demoteBelowPoints"":80,""current"":false,""reached"":false,""rewards"":{""top"":{""maxRank"":10,""reward"":{""freeCoins"":800,""items"":[{""itemId"":""gacha_ticket"",""qty"":1}]}},""floor"":{""freeCoins"":120}}},{""classId"":""S"",""statCap"":4000,""promotePoints"":null,""demoteBelowPoints"":100,""current"":false,""reached"":false,""rewards"":{""top"":{""maxRank"":1,""reward"":{""freeCoins"":3000,""items"":[{""itemId"":""ticket_sr_plus"",""qty"":1}]}},""floor"":{""freeCoins"":200}}}],""missions"":[{""id"":""sm_races10"",""table"":""season"",""kind"":""ranked_races"",""progress"":10,""target"":10,""reward"":{""passXp"":100},""claimed"":true,""claimable"":false},{""id"":""sm_races30"",""table"":""season"",""kind"":""ranked_races"",""progress"":10,""target"":30,""reward"":{""passXp"":200},""claimed"":false,""claimable"":false},{""id"":""sm_wins5"",""table"":""season"",""kind"":""wins"",""progress"":2,""target"":5,""reward"":{""passXp"":150},""claimed"":false,""claimable"":false},{""id"":""sm_top3_15"",""table"":""season"",""kind"":""top3"",""progress"":6,""target"":15,""reward"":{""passXp"":150},""claimed"":false,""claimable"":false},{""id"":""sm_promotion"",""table"":""season"",""kind"":""promotion_line"",""progress"":165,""target"":300,""reward"":{""passXp"":300},""claimed"":false,""claimable"":false}],""pass"":{""level"":3,""maxLevel"":30,""freeClaimable"":3},""promotion"":null},""claimable"":0}}";
        internal const string Fresh = @"{""day"":""2026-12-08"",""now"":1796698800000,""today"":{""open"":false,""items"":[],""done"":0,""total"":0,""claimable"":0,""complete"":false,""resetAt"":1796756400000,""loginBonus"":{""open"":false,""claimedToday"":false}},""path"":{""step"":1,""steps"":10,""done"":0,""current"":{""id"":""bm_scout"",""table"":""beginner"",""kind"":""gacha"",""progress"":0,""target"":1,""reward"":{""freeCoins"":50},""claimed"":false,""claimable"":false},""finalReward"":{""items"":[{""itemId"":""gacha_ticket_10"",""qty"":1}]}},""week"":null,""season"":{""open"":false,""seasonId"":""2026-12"",""endsAt"":1798729200000,""classId"":""C"",""nextClassId"":""B"",""points"":0,""races"":0,""line"":300,""left"":300,""demoteBelow"":null,""status"":""rookie"",""pace"":{""races"":0,""pace10"":null,""racesToLine"":null,""minRaces"":3},""power"":{""horseId"":""h1"",""partner"":true,""total"":3320,""cap"":2800,""usable"":2800,""nextCap"":3200,""nextUsable"":3200,""held"":520},""ladder"":[{""classId"":""C"",""statCap"":2800,""promotePoints"":300,""demoteBelowPoints"":null,""current"":true,""reached"":true,""rewards"":{""top"":{""maxRank"":10,""reward"":{""freeCoins"":300}},""floor"":{""freeCoins"":50}}},{""classId"":""B"",""statCap"":3200,""promotePoints"":400,""demoteBelowPoints"":50,""current"":false,""reached"":false,""rewards"":{""top"":{""maxRank"":10,""reward"":{""freeCoins"":500}},""floor"":{""freeCoins"":80}}},{""classId"":""A"",""statCap"":3600,""promotePoints"":500,""demoteBelowPoints"":80,""current"":false,""reached"":false,""rewards"":{""top"":{""maxRank"":10,""reward"":{""freeCoins"":800,""items"":[{""itemId"":""gacha_ticket"",""qty"":1}]}},""floor"":{""freeCoins"":120}}},{""classId"":""S"",""statCap"":4000,""promotePoints"":null,""demoteBelowPoints"":100,""current"":false,""reached"":false,""rewards"":{""top"":{""maxRank"":1,""reward"":{""freeCoins"":3000,""items"":[{""itemId"":""ticket_sr_plus"",""qty"":1}]}},""floor"":{""freeCoins"":200}}}],""missions"":[{""id"":""sm_races10"",""table"":""season"",""kind"":""ranked_races"",""progress"":0,""target"":10,""reward"":{""passXp"":100},""claimed"":false,""claimable"":false},{""id"":""sm_races30"",""table"":""season"",""kind"":""ranked_races"",""progress"":0,""target"":30,""reward"":{""passXp"":200},""claimed"":false,""claimable"":false},{""id"":""sm_wins5"",""table"":""season"",""kind"":""wins"",""progress"":0,""target"":5,""reward"":{""passXp"":150},""claimed"":false,""claimable"":false},{""id"":""sm_top3_15"",""table"":""season"",""kind"":""top3"",""progress"":0,""target"":15,""reward"":{""passXp"":150},""claimed"":false,""claimable"":false},{""id"":""sm_promotion"",""table"":""season"",""kind"":""promotion_line"",""progress"":0,""target"":300,""reward"":{""passXp"":300},""claimed"":false,""claimable"":false}],""pass"":{""level"":0,""maxLevel"":30,""freeClaimable"":0},""promotion"":null},""claimable"":0}";

        [Fact]
        public async Task ParsesTheLadder()
        {
            _http.Reply(200, View);
            var v = await _api.GetGoalsAsync();
            Assert.Equal("GET", _http.Requests[0].Method);
            Assert.Equal("/v1/home/goals", _http.Requests[0].Path);
            Assert.True(v.Today.Open);
            Assert.Equal(5, v.Today.Total);
            Assert.Equal(3, v.Today.Claimable);
            Assert.Equal("first_win", v.Today.Items[4].Table);
            Assert.True(v.Today.Items[4].Claimed);
            Assert.Equal(15, v.Today.Items[0].Reward.FreeCoins);
            Assert.Equal(1, v.Path.Step);
            Assert.Equal("gacha_ticket_10", v.Path.FinalReward.Items[0].ItemId);
            Assert.Null(v.Week);
            var s = v.Season;
            Assert.Equal("climbing", s.Status);
            Assert.Equal(300, s.Line);
            Assert.Equal(135, s.Left);
            Assert.Equal(165, s.Pace10);
            Assert.Equal(9, s.RacesToLine);
            Assert.True(s.HasPower && s.PowerIsPartner);
            Assert.Equal(2800, s.PowerUsable);
            Assert.Equal(3200, s.PowerNextUsable);
            Assert.Equal(520, s.PowerHeld);
            Assert.Equal(new[] { "C", "B", "A", "S" }, s.Ladder.ConvertAll(r => r.ClassId));
            Assert.True(s.Ladder[0].Current);
            Assert.Null(s.Ladder[3].PromotePoints);
            Assert.Equal(3000, s.Ladder[3].TopReward.FreeCoins);
            Assert.Equal(100, s.Missions[0].Reward.PassXp);
            Assert.Null(s.PromotionStatus); // §68 not on this server
            Assert.Equal(4, v.Claimable);
        }

        [Fact]
        public async Task ClaimIsKeyedAndReturnsTheSumAndTheNewLadder()
        {
            _http.Reply(200, Claim);
            var r = await _api.ClaimGoalsAsync("c:goal-1");
            Assert.Equal("POST", _http.Requests[0].Method);
            Assert.Equal("/v1/home/goals/claim", _http.Requests[0].Path);
            Assert.Equal("c:goal-1", _http.Requests[0].Headers["idempotency-key"]);
            Assert.Equal(4, r.Claimed.Count);
            Assert.Equal("season", r.Claimed[3].Table);
            Assert.Equal(45, r.Total.FreeCoins);
            Assert.Equal(100, r.Total.PassXp);
            Assert.Equal(0, r.Ladder.Claimable);
        }

        [Fact]
        public void AFreshPlayerHasThePathAndNoDailySet()
        {
            var v = GoalLadderView.FromJson(Fresh);
            Assert.False(v.Today.Open);
            Assert.Equal("rookie", v.Season.Status);
            Assert.Equal(10, v.Path.Steps);
            Assert.Null(GoalLadderView.FromJson("nope"));
        }
    }
}
