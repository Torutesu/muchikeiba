using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-TGOAL-*: GET /v1/teams/me/goal and the team feed's "goal" items (contracts/protocol.md §32).</summary>
    public class ApiClientTeamGoalTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientTeamGoalTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        // produced by the real server (TeamsService.goal) one week after a team of three reached the 2nd milestone
        internal const string View = "{\"teamId\":\"tixmuqc4zk\",\"teamName\":\"あおばRC\",\"enabled\":true,\"current\":{\"week\":\"2026-12-14\",\"endsAt\":1797793200000,\"goalId\":\"races_sum\",\"kind\":\"races\",\"label\":\"支部で合計60レース\",\"scale\":3,\"progress\":7,\"tier\":0,\"minContribution\":3,"
            + "\"milestones\":[{\"tier\":1,\"target\":18,\"reached\":false,\"reward\":{\"freeCoins\":5}},{\"tier\":2,\"target\":36,\"reached\":false,\"reward\":{\"freeCoins\":10,\"items\":[{\"itemId\":\"breeding_material\",\"qty\":1}]}},{\"tier\":3,\"target\":60,\"reached\":false,\"reward\":{\"freeCoins\":20,\"items\":[{\"itemId\":\"breeding_material\",\"qty\":1}]}}],"
            + "\"my\":{\"contribution\":4,\"today\":4,\"dailyCap\":10,\"qualified\":true},\"top\":[{\"playerId\":\"a\",\"displayName\":\"騎手A\",\"n\":4},{\"playerId\":\"b\",\"displayName\":\"騎手B\",\"n\":3}],\"contributors\":2},"
            + "\"lastWeek\":{\"week\":\"2026-12-07\",\"goalId\":\"races_sum\",\"kind\":\"races\",\"label\":\"支部で合計60レース\",\"targets\":[18,36,60],\"progress\":38,\"tier\":2,\"reward\":{\"freeCoins\":10,\"items\":[{\"itemId\":\"breeding_material\",\"qty\":1}]},"
            + "\"top\":[{\"playerId\":\"a\",\"displayName\":\"騎手A\",\"n\":20},{\"playerId\":\"b\",\"displayName\":\"騎手B\",\"n\":16},{\"playerId\":\"lead\",\"displayName\":\"騎手LEAD\",\"n\":2}],\"eligible\":true,\"paid\":true},"
            + "\"player\":{\"enabled\":true,\"sentToday\":{\"races\":4,\"wins\":0,\"ta_pb\":0},\"pending\":0,\"lastReward\":{\"week\":\"2026-12-07\",\"teamId\":\"tixmuqc4zk\",\"tier\":2,\"contribution\":20,\"reward\":{\"freeCoins\":10,\"items\":[{\"itemId\":\"breeding_material\",\"qty\":1}]}}}}";
        internal const string GoalItem = "{\"seq\":2,\"at\":1796787360000,\"kind\":\"goal\",\"playerId\":\"\",\"displayName\":\"\",\"mine\":false,\"stampId\":null,\"stampAsset\":null,\"race\":null,\"goal\":{\"week\":\"2026-12-07\",\"goalId\":\"races_sum\",\"label\":\"支部で合計60レース\",\"tier\":2,\"target\":36,\"tiers\":3},\"reactions\":[],\"myReaction\":null}";

        [Fact]
        public async Task ViewParsesTheWeekMilestonesMyContributionAndLastWeek()
        {
            _http.Reply(200, View);
            var v = await _api.GetTeamGoalAsync();
            Assert.Equal("GET", _http.Requests[0].Method);
            Assert.Equal("/v1/teams/me/goal", _http.Requests[0].Path);
            Assert.True(v.InTeam);
            Assert.Equal("あおばRC", v.TeamName);
            var w = v.Current;
            Assert.Equal("races", w.Kind);
            Assert.Equal("支部で合計60レース", w.Label);
            Assert.Equal(60, w.FinalTarget);
            Assert.Equal(3, w.Milestones.Count);
            Assert.Equal(18, w.Milestones[0].Target);
            Assert.Equal(1, w.Milestones[1].Reward.Items[0].Qty);
            Assert.Equal(4, w.MyContribution);
            Assert.Equal(10, w.DailyCap);
            Assert.False(w.TodayCapped);
            Assert.True(w.Qualified);
            Assert.Equal("騎手A", w.Top[0].DisplayName);
            Assert.Equal(new[] { 18, 36, 60 }, v.LastWeek.Targets);
            Assert.Equal(2, v.LastWeek.Tier);
            Assert.True(v.LastWeek.Paid);
            Assert.Equal(10, v.LastWeek.Reward.FreeCoins);
            Assert.Equal(4, v.SentRaces);
            Assert.Equal(20, v.LastReward.Contribution);
        }

        [Fact]
        public async Task NotInATeamAndRetriedOnA5xx()
        {
            _http.Reply(503, "{\"error\":{\"code\":\"INTERNAL\"}}").Reply(200, "{\"teamId\":null,\"teamName\":null,\"enabled\":true,\"current\":null,\"lastWeek\":null,\"player\":{\"enabled\":true,\"sentToday\":{\"races\":0,\"wins\":0,\"ta_pb\":0},\"pending\":0,\"lastReward\":null}}");
            var v = await _api.GetTeamGoalAsync();
            Assert.Equal(2, _http.Requests.Count);
            Assert.False(v.InTeam);
            Assert.Null(v.Current);
            Assert.Null(v.LastWeek);
            Assert.Null(v.LastReward);
        }

        [Fact]
        public async Task FeedGoalItemsParse()
        {
            _http.Reply(200, "{\"teamId\":\"tixmuqc4zk\",\"latestSeq\":2,\"nextBefore\":null,\"muted\":[],\"items\":[" + GoalItem + "]}");
            var page = await _api.GetTeamFeedAsync();
            var it = page.Items[0];
            Assert.True(it.IsGoal);
            Assert.False(it.IsRace);
            Assert.Equal("", it.PlayerId);
            Assert.Equal(2, it.Goal.Tier);
            Assert.Equal(36, it.Goal.Target);
            Assert.Equal("支部で合計60レース", it.Goal.Label);
        }
    }
}
