using System.Linq;
using System.Threading.Tasks;
using Muchi.Client;
using Xunit;

namespace Muchi.Engine.Tests
{
    /// <summary>
    /// REQ-GOAL-017..020, REQ-ITEM-010/011 (quality pass 3, docs/quality/week2.md): the solo way of a social first step, graduation
    /// as the week-2 goal (day 8), the week-2 arc, the treat hint, on JSON produced by the real server: day 3 at the friend step
    /// (tired partner, one apple), day 7 with graduation waiting (one session left), day 10 inside week 2.
    /// </summary>
    public class ApiClientGoalsWeek2Tests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientGoalsWeek2Tests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        [Fact]
        public async Task ParsesTheSoloWayOfTheFriendStep()
        {
            _http.Reply(200, Day3);
            var v = await _api.GetGoalsAsync();
            var c = v.Path.Current;
            Assert.Equal("friends", c.Kind);
            Assert.Equal("friends", c.Screen);
            Assert.NotNull(c.Alt);
            Assert.Equal("treat", c.Alt.Kind);
            Assert.Equal("training", c.Alt.Screen);
            Assert.True(c.Alt.Open);
            Assert.Equal(0, c.Alt.Progress);
            Assert.Equal(1, c.Alt.Target);
            Assert.False(c.Reached);
            Assert.True(c.DayOk);
            Assert.Null(c.FromDay);
            Assert.Null(v.Week2);
            Assert.Null(v.Today.Tomorrow.GraduateReward);
        }

        [Fact]
        public async Task ParsesGraduationTomorrowTheWeek2PreviewAndThePartnersTreat()
        {
            _http.Reply(200, Day7);
            var v = await _api.GetGoalsAsync();
            Assert.Equal(7, v.Today.PlayerDay);
            var c = v.Path.Current;
            Assert.Equal("bm_graduate", c.Id);
            Assert.True(c.Reached);
            Assert.False(c.DayOk);
            Assert.False(c.Claimable);
            Assert.Equal(8, c.FromDay);
            Assert.Equal(8, v.Path.FinalFromDay);
            var t = v.Today.Tomorrow;
            Assert.True(t.GraduateReady);
            Assert.Equal("gacha_ticket_10", t.GraduateReward.Items[0].ItemId);
            var w = v.Week2;
            Assert.NotNull(w);
            Assert.Equal(0, w.Day);
            Assert.Equal(8, w.FromDay);
            Assert.Equal(14, w.ToDay);
            Assert.Equal(new[] { 8, 9, 10, 11, 12, 13, 14 }, w.Days.Select(x => x.PlayerDay).ToArray());
            Assert.All(w.Days, x => Assert.NotNull(x.LoginReward));
            Assert.Equal(50, w.Days[0].LoginReward.FreeCoins);
            Assert.Equal("gacha_ticket_10", w.Days[0].GraduateReward.Items[0].ItemId);
            Assert.Equal(14, w.PeakDay);
            Assert.Equal("ticket_sr_plus", w.PeakReward.Items[0].ItemId);
            Assert.Equal(8, w.GraduateDay);
            var tr = v.Partner.Treat;
            Assert.NotNull(tr);
            Assert.Equal("training_apple", tr.ItemId);
            Assert.Equal(30, tr.Fatigue);
            Assert.Equal(0, tr.FatigueAfter);
            Assert.Equal(850, tr.EfficiencyPermille);
            Assert.Equal(1000, tr.EfficiencyAfterPermille);
            Assert.Equal(1, v.Partner.SessionsLeft);
        }

        [Fact]
        public async Task ParsesTheArcInsideWeek2()
        {
            _http.Reply(200, Day10);
            var v = await _api.GetGoalsAsync();
            var w = v.Week2;
            Assert.Equal(3, w.Day);
            Assert.Equal(new[] { 8, 9 }, w.Days.Where(x => x.Past).Select(x => x.PlayerDay).ToArray());
            var today = w.Days.Single(x => x.Today);
            Assert.Equal(10, today.PlayerDay);
            Assert.Equal(3, today.LoginDay);
            Assert.True(today.GraduateReady);
            Assert.True(v.Path.Current.Claimable);
            Assert.Null(v.Partner.Treat);
        }

        [Fact]
        public async Task ParsesTheTrainingTreatHint()
        {
            _http.Reply(200, Training);
            var tv = (await _api.GetTrainingAsync()).Horses[0];
            Assert.NotNull(tv.Treat);
            Assert.Equal(55, tv.Treat.Fatigue);
            Assert.Equal(25, tv.Treat.FatigueAfter);
            Assert.Equal(725, tv.Treat.EfficiencyPermille);
            Assert.Equal(875, tv.Treat.EfficiencyAfterPermille);
            Assert.False(tv.Treat.Unblocks);
        }

        [Fact]
        public async Task AnOlderServerWithoutTheWeek2FieldsStillParses()
        {
            _http.Reply(200, ApiClientGoalsFirstWeekTests.Day1);
            var v = await _api.GetGoalsAsync();
            Assert.Null(v.Week2);
            Assert.Null(v.Path.Current.Alt);
            Assert.True(v.Path.Current.DayOk);
            Assert.True(v.Path.Current.Reached);
            Assert.Null(v.Path.FinalFromDay);
            Assert.Null(v.Today.Tomorrow.GraduateReward);
            Assert.Null(v.Partner.Treat);
        }

        internal const string Day3 = @"{""day"":""2026-12-10"",""now"":1796871600000,""today"":{""open"":true,""items"":[{""id"":""race3"",""table"":""daily"",""kind"":""races"",""progress"":0,""target"":3,""reward"":{""freeCoins"":15},""claimed"":false,""claimable"":false},{""id"":""win1"",""table"":""daily"",""kind"":""wins"",""progress"":0,""target"":1,""reward"":{""freeCoins"":30},""claimed"":false,""claimable"":false},{""id"":""top3x2"",""table"":""daily"",""kind"":""top3"",""progress"":0,""target"":2,""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]},""claimed"":false,""claimable"":false},{""id"":""train1"",""table"":""daily"",""kind"":""training"",""progress"":1,""target"":1,""reward"":{""items"":[{""itemId"":""training_apple"",""qty"":1}]},""claimed"":true,""claimable"":false},{""id"":""first_win"",""table"":""first_win"",""kind"":""first_win"",""progress"":0,""target"":1,""reward"":{""freeCoins"":30},""claimed"":false,""claimable"":false}],""done"":1,""total"":5,""claimable"":0,""complete"":false,""resetAt"":1796929200000,""loginBonus"":{""open"":true,""claimedToday"":true,""next"":{""track"":""beginner"",""day"":4,""days"":7,""reward"":{""freeCoins"":100}}},""playerDay"":3,""tomorrow"":{""playerDay"":4,""at"":1796929200000,""loginBonus"":{""track"":""beginner"",""day"":4,""days"":7,""reward"":{""freeCoins"":100}},""opens"":[""time_attack"",""weekly_challenge""],""trainingSlots"":3,""graduate"":null}},""path"":{""step"":6,""steps"":10,""done"":5,""current"":{""id"":""bm_friend"",""table"":""beginner"",""kind"":""friends"",""progress"":0,""target"":1,""reward"":{""freeCoins"":100},""claimed"":false,""claimable"":false,""screen"":""friends"",""open"":true,""alt"":{""kind"":""treat"",""target"":1,""progress"":0,""screen"":""training"",""open"":true},""reached"":false,""fromDay"":null,""dayOk"":true},""finalReward"":{""items"":[{""itemId"":""gacha_ticket_10"",""qty"":1}]},""finalFromDay"":8},""week"":null,""week2"":null,""season"":{""open"":true,""seasonId"":""2026-12"",""endsAt"":1798729200000,""classId"":""C"",""nextClassId"":""B"",""points"":255,""races"":15,""line"":300,""left"":45,""demoteBelow"":null,""status"":""climbing"",""pace"":{""races"":15,""pace10"":170,""racesToLine"":3,""minRaces"":3},""power"":{""horseId"":""h1"",""partner"":true,""total"":3330,""cap"":2800,""usable"":2800,""nextCap"":3200,""nextUsable"":3200,""held"":530},""ladder"":[{""classId"":""C"",""statCap"":2800,""promotePoints"":300,""demoteBelowPoints"":null,""current"":true,""reached"":true,""rewards"":{""top"":{""maxRank"":10,""reward"":{""freeCoins"":300}},""floor"":{""freeCoins"":50}}},{""classId"":""B"",""statCap"":3200,""promotePoints"":400,""demoteBelowPoints"":50,""current"":false,""reached"":false,""rewards"":{""top"":{""maxRank"":10,""reward"":{""freeCoins"":500}},""floor"":{""freeCoins"":80}}},{""classId"":""A"",""statCap"":3600,""promotePoints"":500,""demoteBelowPoints"":80,""current"":false,""reached"":false,""rewards"":{""top"":{""maxRank"":10,""reward"":{""freeCoins"":800,""items"":[{""itemId"":""gacha_ticket"",""qty"":1}]}},""floor"":{""freeCoins"":120}}},{""classId"":""S"",""statCap"":4000,""promotePoints"":null,""demoteBelowPoints"":100,""current"":false,""reached"":false,""rewards"":{""top"":{""maxRank"":1,""reward"":{""freeCoins"":3000,""items"":[{""itemId"":""ticket_sr_plus"",""qty"":1}]}},""floor"":{""freeCoins"":200}}}],""missions"":[{""id"":""sm_races10"",""table"":""season"",""kind"":""ranked_races"",""progress"":10,""target"":10,""reward"":{""passXp"":100},""claimed"":false,""claimable"":true},{""id"":""sm_races30"",""table"":""season"",""kind"":""ranked_races"",""progress"":15,""target"":30,""reward"":{""passXp"":200},""claimed"":false,""claimable"":false},{""id"":""sm_wins5"",""table"":""season"",""kind"":""wins"",""progress"":3,""target"":5,""reward"":{""passXp"":150},""claimed"":false,""claimable"":false},{""id"":""sm_top3_15"",""table"":""season"",""kind"":""top3"",""progress"":9,""target"":15,""reward"":{""passXp"":150},""claimed"":false,""claimable"":false},{""id"":""sm_promotion"",""table"":""season"",""kind"":""promotion_line"",""progress"":255,""target"":300,""reward"":{""passXp"":300},""claimed"":false,""claimable"":false}],""pass"":{""level"":3,""maxLevel"":30,""freeClaimable"":3},""promotion"":null},""partner"":{""horseId"":""h1"",""name"":""アカツキ"",""stage"":0,""stageKey"":""debut"",""stages"":5,""stageFrom"":0,""nextStageAt"":24,""trainedTotal"":10,""potential"":240,""gainedToday"":10,""gainedYesterday"":0,""trainingOpen"":true,""treat"":null,""sessionsLeft"":0,""full"":false},""claimable"":1}";
        internal const string Day7 = @"{""day"":""2026-12-14"",""now"":1797217200000,""today"":{""open"":true,""items"":[{""id"":""race3"",""table"":""daily"",""kind"":""races"",""progress"":0,""target"":3,""reward"":{""freeCoins"":15},""claimed"":false,""claimable"":false},{""id"":""win1"",""table"":""daily"",""kind"":""wins"",""progress"":0,""target"":1,""reward"":{""freeCoins"":30},""claimed"":false,""claimable"":false},{""id"":""top3x2"",""table"":""daily"",""kind"":""top3"",""progress"":0,""target"":2,""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]},""claimed"":false,""claimable"":false},{""id"":""train1"",""table"":""daily"",""kind"":""training"",""progress"":1,""target"":1,""reward"":{""items"":[{""itemId"":""training_apple"",""qty"":1}]},""claimed"":true,""claimable"":false},{""id"":""first_win"",""table"":""first_win"",""kind"":""first_win"",""progress"":0,""target"":1,""reward"":{""freeCoins"":30},""claimed"":false,""claimable"":false}],""done"":1,""total"":5,""claimable"":0,""complete"":false,""resetAt"":1797274800000,""loginBonus"":{""open"":true,""claimedToday"":true,""next"":{""track"":""normal"",""day"":1,""days"":7,""reward"":{""freeCoins"":50}}},""playerDay"":7,""tomorrow"":{""playerDay"":8,""at"":1797274800000,""loginBonus"":{""track"":""normal"",""day"":1,""days"":7,""reward"":{""freeCoins"":50}},""opens"":[],""trainingSlots"":3,""graduate"":{""reward"":{""items"":[{""itemId"":""gacha_ticket_10"",""qty"":1}]},""ready"":true}}},""path"":{""step"":10,""steps"":10,""done"":9,""current"":{""id"":""bm_graduate"",""table"":""beginner"",""kind"":""races"",""progress"":15,""target"":15,""reward"":{""items"":[{""itemId"":""gacha_ticket_10"",""qty"":1}]},""claimed"":false,""claimable"":false,""screen"":""race"",""open"":true,""alt"":null,""reached"":true,""fromDay"":8,""dayOk"":false},""finalReward"":{""items"":[{""itemId"":""gacha_ticket_10"",""qty"":1}]},""finalFromDay"":8},""week"":{""endsAt"":1797793200000,""challenge"":{""weekId"":""2026-12-14"",""endsAt"":1797793200000,""cleared"":0,""total"":3,""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":3}]},""badgeId"":""wch_badge_aoba"",""badgeName"":""青葉の一閃章"",""badgeEarned"":false},""rival"":null,""teamGoal"":null,""rivalResult"":null},""week2"":{""fromDay"":8,""toDay"":14,""day"":0,""days"":[{""playerDay"":8,""today"":false,""past"":false,""loginBonus"":{""track"":""normal"",""day"":1,""days"":7,""reward"":{""freeCoins"":50}},""graduate"":{""reward"":{""items"":[{""itemId"":""gacha_ticket_10"",""qty"":1}]},""ready"":true}},{""playerDay"":9,""today"":false,""past"":false,""loginBonus"":{""track"":""normal"",""day"":2,""days"":7,""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":3}]}},""graduate"":null},{""playerDay"":10,""today"":false,""past"":false,""loginBonus"":{""track"":""normal"",""day"":3,""days"":7,""reward"":{""items"":[{""itemId"":""costume_login"",""qty"":1}]}},""graduate"":null},{""playerDay"":11,""today"":false,""past"":false,""loginBonus"":{""track"":""normal"",""day"":4,""days"":7,""reward"":{""freeCoins"":100}},""graduate"":null},{""playerDay"":12,""today"":false,""past"":false,""loginBonus"":{""track"":""normal"",""day"":5,""days"":7,""reward"":{""items"":[{""itemId"":""gacha_ticket"",""qty"":1}]}},""graduate"":null},{""playerDay"":13,""today"":false,""past"":false,""loginBonus"":{""track"":""normal"",""day"":6,""days"":7,""reward"":{""freeCoins"":100}},""graduate"":null},{""playerDay"":14,""today"":false,""past"":false,""loginBonus"":{""track"":""normal"",""day"":7,""days"":7,""reward"":{""items"":[{""itemId"":""ticket_sr_plus"",""qty"":1}]}},""graduate"":null}],""peak"":{""playerDay"":14,""reward"":{""items"":[{""itemId"":""ticket_sr_plus"",""qty"":1}]}},""graduate"":{""playerDay"":8,""reward"":{""items"":[{""itemId"":""gacha_ticket_10"",""qty"":1}]}}},""season"":{""open"":true,""seasonId"":""2026-12"",""endsAt"":1798729200000,""classId"":""C"",""nextClassId"":""B"",""points"":255,""races"":15,""line"":300,""left"":45,""demoteBelow"":null,""status"":""climbing"",""pace"":{""races"":15,""pace10"":170,""racesToLine"":3,""minRaces"":3},""power"":{""horseId"":""h1"",""partner"":true,""total"":3336,""cap"":2800,""usable"":2800,""nextCap"":3200,""nextUsable"":3200,""held"":536},""ladder"":[{""classId"":""C"",""statCap"":2800,""promotePoints"":300,""demoteBelowPoints"":null,""current"":true,""reached"":true,""rewards"":{""top"":{""maxRank"":10,""reward"":{""freeCoins"":300}},""floor"":{""freeCoins"":50}}},{""classId"":""B"",""statCap"":3200,""promotePoints"":400,""demoteBelowPoints"":50,""current"":false,""reached"":false,""rewards"":{""top"":{""maxRank"":10,""reward"":{""freeCoins"":500}},""floor"":{""freeCoins"":80}}},{""classId"":""A"",""statCap"":3600,""promotePoints"":500,""demoteBelowPoints"":80,""current"":false,""reached"":false,""rewards"":{""top"":{""maxRank"":10,""reward"":{""freeCoins"":800,""items"":[{""itemId"":""gacha_ticket"",""qty"":1}]}},""floor"":{""freeCoins"":120}}},{""classId"":""S"",""statCap"":4000,""promotePoints"":null,""demoteBelowPoints"":100,""current"":false,""reached"":false,""rewards"":{""top"":{""maxRank"":1,""reward"":{""freeCoins"":3000,""items"":[{""itemId"":""ticket_sr_plus"",""qty"":1}]}},""floor"":{""freeCoins"":200}}}],""missions"":[{""id"":""sm_races10"",""table"":""season"",""kind"":""ranked_races"",""progress"":10,""target"":10,""reward"":{""passXp"":100},""claimed"":false,""claimable"":true},{""id"":""sm_races30"",""table"":""season"",""kind"":""ranked_races"",""progress"":15,""target"":30,""reward"":{""passXp"":200},""claimed"":false,""claimable"":false},{""id"":""sm_wins5"",""table"":""season"",""kind"":""wins"",""progress"":3,""target"":5,""reward"":{""passXp"":150},""claimed"":false,""claimable"":false},{""id"":""sm_top3_15"",""table"":""season"",""kind"":""top3"",""progress"":9,""target"":15,""reward"":{""passXp"":150},""claimed"":false,""claimable"":false},{""id"":""sm_promotion"",""table"":""season"",""kind"":""promotion_line"",""progress"":255,""target"":300,""reward"":{""passXp"":300},""claimed"":false,""claimable"":false}],""pass"":{""level"":3,""maxLevel"":30,""freeClaimable"":3},""promotion"":null},""partner"":{""horseId"":""h1"",""name"":""アカツキ"",""stage"":0,""stageKey"":""debut"",""stages"":5,""stageFrom"":0,""nextStageAt"":24,""trainedTotal"":16,""potential"":240,""gainedToday"":6,""gainedYesterday"":0,""trainingOpen"":true,""treat"":{""itemId"":""training_apple"",""name"":""りんごのおやつ"",""owned"":2,""fatigue"":30,""fatigueAfter"":0,""efficiencyPermille"":850,""efficiencyAfterPermille"":1000,""tired"":false,""unblocks"":false},""sessionsLeft"":1,""full"":false},""claimable"":1}";
        internal const string Day10 = @"{""day"":""2026-12-17"",""now"":1797476400000,""today"":{""open"":true,""items"":[{""id"":""race3"",""table"":""daily"",""kind"":""races"",""progress"":0,""target"":3,""reward"":{""freeCoins"":15},""claimed"":false,""claimable"":false},{""id"":""win1"",""table"":""daily"",""kind"":""wins"",""progress"":0,""target"":1,""reward"":{""freeCoins"":30},""claimed"":false,""claimable"":false},{""id"":""top3x2"",""table"":""daily"",""kind"":""top3"",""progress"":0,""target"":2,""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]},""claimed"":false,""claimable"":false},{""id"":""train1"",""table"":""daily"",""kind"":""training"",""progress"":0,""target"":1,""reward"":{""items"":[{""itemId"":""training_apple"",""qty"":1}]},""claimed"":false,""claimable"":false},{""id"":""first_win"",""table"":""first_win"",""kind"":""first_win"",""progress"":0,""target"":1,""reward"":{""freeCoins"":30},""claimed"":false,""claimable"":false}],""done"":0,""total"":5,""claimable"":0,""complete"":false,""resetAt"":1797534000000,""loginBonus"":{""open"":true,""claimedToday"":true,""next"":{""track"":""normal"",""day"":4,""days"":7,""reward"":{""freeCoins"":100}}},""playerDay"":10,""tomorrow"":{""playerDay"":11,""at"":1797534000000,""loginBonus"":{""track"":""normal"",""day"":4,""days"":7,""reward"":{""freeCoins"":100}},""opens"":[],""trainingSlots"":3,""graduate"":null}},""path"":{""step"":10,""steps"":10,""done"":9,""current"":{""id"":""bm_graduate"",""table"":""beginner"",""kind"":""races"",""progress"":15,""target"":15,""reward"":{""items"":[{""itemId"":""gacha_ticket_10"",""qty"":1}]},""claimed"":false,""claimable"":true,""screen"":""race"",""open"":true,""alt"":null,""reached"":true,""fromDay"":8,""dayOk"":true},""finalReward"":{""items"":[{""itemId"":""gacha_ticket_10"",""qty"":1}]},""finalFromDay"":8},""week"":{""endsAt"":1797793200000,""challenge"":{""weekId"":""2026-12-14"",""endsAt"":1797793200000,""cleared"":0,""total"":3,""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":3}]},""badgeId"":""wch_badge_aoba"",""badgeName"":""青葉の一閃章"",""badgeEarned"":false},""rival"":null,""teamGoal"":null,""rivalResult"":null},""week2"":{""fromDay"":8,""toDay"":14,""day"":3,""days"":[{""playerDay"":8,""today"":false,""past"":true,""loginBonus"":null,""graduate"":null},{""playerDay"":9,""today"":false,""past"":true,""loginBonus"":null,""graduate"":null},{""playerDay"":10,""today"":true,""past"":false,""loginBonus"":{""track"":""normal"",""day"":3,""days"":7,""reward"":{""items"":[{""itemId"":""costume_login"",""qty"":1}]}},""graduate"":{""reward"":{""items"":[{""itemId"":""gacha_ticket_10"",""qty"":1}]},""ready"":true}},{""playerDay"":11,""today"":false,""past"":false,""loginBonus"":{""track"":""normal"",""day"":4,""days"":7,""reward"":{""freeCoins"":100}},""graduate"":null},{""playerDay"":12,""today"":false,""past"":false,""loginBonus"":{""track"":""normal"",""day"":5,""days"":7,""reward"":{""items"":[{""itemId"":""gacha_ticket"",""qty"":1}]}},""graduate"":null},{""playerDay"":13,""today"":false,""past"":false,""loginBonus"":{""track"":""normal"",""day"":6,""days"":7,""reward"":{""freeCoins"":100}},""graduate"":null},{""playerDay"":14,""today"":false,""past"":false,""loginBonus"":{""track"":""normal"",""day"":7,""days"":7,""reward"":{""items"":[{""itemId"":""ticket_sr_plus"",""qty"":1}]}},""graduate"":null}],""peak"":{""playerDay"":14,""reward"":{""items"":[{""itemId"":""ticket_sr_plus"",""qty"":1}]}},""graduate"":{""playerDay"":10,""reward"":{""items"":[{""itemId"":""gacha_ticket_10"",""qty"":1}]}}},""season"":{""open"":true,""seasonId"":""2026-12"",""endsAt"":1798729200000,""classId"":""C"",""nextClassId"":""B"",""points"":255,""races"":15,""line"":300,""left"":45,""demoteBelow"":null,""status"":""climbing"",""pace"":{""races"":15,""pace10"":170,""racesToLine"":3,""minRaces"":3},""power"":{""horseId"":""h1"",""partner"":true,""total"":3336,""cap"":2800,""usable"":2800,""nextCap"":3200,""nextUsable"":3200,""held"":536},""ladder"":[{""classId"":""C"",""statCap"":2800,""promotePoints"":300,""demoteBelowPoints"":null,""current"":true,""reached"":true,""rewards"":{""top"":{""maxRank"":10,""reward"":{""freeCoins"":300}},""floor"":{""freeCoins"":50}}},{""classId"":""B"",""statCap"":3200,""promotePoints"":400,""demoteBelowPoints"":50,""current"":false,""reached"":false,""rewards"":{""top"":{""maxRank"":10,""reward"":{""freeCoins"":500}},""floor"":{""freeCoins"":80}}},{""classId"":""A"",""statCap"":3600,""promotePoints"":500,""demoteBelowPoints"":80,""current"":false,""reached"":false,""rewards"":{""top"":{""maxRank"":10,""reward"":{""freeCoins"":800,""items"":[{""itemId"":""gacha_ticket"",""qty"":1}]}},""floor"":{""freeCoins"":120}}},{""classId"":""S"",""statCap"":4000,""promotePoints"":null,""demoteBelowPoints"":100,""current"":false,""reached"":false,""rewards"":{""top"":{""maxRank"":1,""reward"":{""freeCoins"":3000,""items"":[{""itemId"":""ticket_sr_plus"",""qty"":1}]}},""floor"":{""freeCoins"":200}}}],""missions"":[{""id"":""sm_races10"",""table"":""season"",""kind"":""ranked_races"",""progress"":10,""target"":10,""reward"":{""passXp"":100},""claimed"":false,""claimable"":true},{""id"":""sm_races30"",""table"":""season"",""kind"":""ranked_races"",""progress"":15,""target"":30,""reward"":{""passXp"":200},""claimed"":false,""claimable"":false},{""id"":""sm_wins5"",""table"":""season"",""kind"":""wins"",""progress"":3,""target"":5,""reward"":{""passXp"":150},""claimed"":false,""claimable"":false},{""id"":""sm_top3_15"",""table"":""season"",""kind"":""top3"",""progress"":9,""target"":15,""reward"":{""passXp"":150},""claimed"":false,""claimable"":false},{""id"":""sm_promotion"",""table"":""season"",""kind"":""promotion_line"",""progress"":255,""target"":300,""reward"":{""passXp"":300},""claimed"":false,""claimable"":false}],""pass"":{""level"":3,""maxLevel"":30,""freeClaimable"":3},""promotion"":null},""partner"":{""horseId"":""h1"",""name"":""アカツキ"",""stage"":0,""stageKey"":""debut"",""stages"":5,""stageFrom"":0,""nextStageAt"":24,""trainedTotal"":16,""potential"":240,""gainedToday"":0,""gainedYesterday"":0,""trainingOpen"":true,""treat"":null,""sessionsLeft"":2,""full"":false},""claimable"":2}";
        internal const string Training = @"{""enabled"":true,""slotsPerDay"":3,""usedToday"":2,""slotsLeft"":1,""perHorsePerDay"":2,""items"":[{""itemId"":""training_apple"",""name"":""りんごのおやつ"",""fatigueRelief"":30,""owned"":1}],""open"":null,""menus"":[{""id"":""hill"",""name"":""坂路"",""baseGain"":6,""fatigue"":30,""weights"":{""burst"":2,""guts"":1,""stamina"":1},""bondMultiplier"":1},{""id"":""wood"",""name"":""ウッド"",""baseGain"":6,""fatigue"":25,""weights"":{""speed"":2,""stamina"":1,""temper"":1},""bondMultiplier"":1},{""id"":""pool"",""name"":""プール"",""baseGain"":3,""fatigue"":-20,""weights"":{""stamina"":2,""temper"":1},""bondMultiplier"":1},{""id"":""awase"",""name"":""併せ馬"",""baseGain"":7,""fatigue"":35,""weights"":{""guts"":2,""speed"":1,""burst"":1},""bondMultiplier"":2}],""timing"":{""beats"":5,""durationMs"":6000,""leadMs"":800,""tailMs"":200,""perfectMs"":60,""goodMs"":150,""perfectPoints"":2,""goodPoints"":1,""strayPenalty"":1,""permillePerPoint"":10,""maxTaps"":10,""minTapGapMs"":80,""maxScore"":10},""fatigue"":{""max"":100,""restAt"":80,""recoveryPerDay"":40},""partial"":false,""horses"":[{""horseId"":""h1"",""name"":""アカツキ"",""rarity"":""SR"",""trained"":{""speed"":2,""stamina"":3,""burst"":3,""guts"":1,""temper"":1},""trainedTotal"":10,""potential"":240,""perStatCap"":96,""fatigue"":55,""condition"":""normal"",""bondLevel"":1,""todayCount"":2,""sessions"":2,""log"":[{""at"":1796871600000,""menuId"":""wood"",""grade"":""normal"",""gain"":4,""score"":0},{""at"":1796871600000,""menuId"":""hill"",""grade"":""normal"",""gain"":6,""score"":0}],""blocked"":""horse_daily_limit"",""menus"":[{""id"":""hill"",""blocked"":""horse_daily_limit"",""outlook"":{""min"":5,""max"":5,""efficiencyPermille"":725,""bondPermille"":0,""softPermille"":958}},{""id"":""wood"",""blocked"":""horse_daily_limit"",""outlook"":{""min"":5,""max"":5,""efficiencyPermille"":725,""bondPermille"":0,""softPermille"":958}},{""id"":""pool"",""blocked"":""horse_daily_limit"",""outlook"":{""min"":3,""max"":3,""efficiencyPermille"":725,""bondPermille"":0,""softPermille"":958}},{""id"":""awase"",""blocked"":""horse_daily_limit"",""outlook"":{""min"":5,""max"":6,""efficiencyPermille"":725,""bondPermille"":0,""softPermille"":958}}],""treat"":{""itemId"":""training_apple"",""name"":""りんごのおやつ"",""owned"":1,""fatigue"":55,""fatigueAfter"":25,""efficiencyPermille"":725,""efficiencyAfterPermille"":875,""tired"":false,""unblocks"":false}}],""rules"":{""rankedNormalized"":true,""fatigueAffectsRaces"":false,""inherited"":false,""paidBoosts"":false}}";
    }
}
