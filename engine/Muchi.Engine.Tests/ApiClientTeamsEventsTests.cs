using System.IO;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>Teams (支部) and event race endpoints (server/src/http/app.ts, round 4) and the "event" race mode.</summary>
    public class ApiClientTeamsEventsTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly FakeDelay _delay = new FakeDelay();
        private readonly ApiClient _api;

        public ApiClientTeamsEventsTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, _delay, new SeqIds());
        }

        private static string Canon(string json) => JsonNode.Parse(json).ToString();

        private HttpRequest Last(string method, string path, string body = null)
        {
            var r = _http.Requests[_http.Requests.Count - 1];
            Assert.Equal(method, r.Method);
            Assert.Equal(path, r.Path);
            if (body != null) Assert.Equal(Canon(body), Canon(r.Body));
            return r;
        }

        private const string Team = "{\"teamId\":\"tabc123def\",\"name\":\"あおばRC\",\"joinPolicy\":\"approval\",\"announcement\":\"毎晩21時\",\"createdAt\":1,\"disbanded\":false,\"season\":\"2026-11\",\"points\":120,\"maxMembers\":20,"
            + "\"members\":[{\"playerId\":\"lead\",\"displayName\":\"L\",\"role\":\"leader\",\"joinedAt\":1,\"contribution\":100},{\"playerId\":\"a\",\"displayName\":\"A\",\"role\":\"officer\",\"joinedAt\":2,\"contribution\":20}],"
            + "\"myRole\":\"leader\",\"requests\":[{\"playerId\":\"b\",\"displayName\":\"B\",\"at\":3}]}";

        [Fact]
        public async Task CreateAndReadTeam()
        {
            _http.Reply(200, Team);
            var t = await _api.CreateTeamAsync("あおばRC", TeamJoinPolicy.Approval, "毎晩21時");
            Last("POST", "/v1/teams", "{\"name\":\"あおばRC\",\"joinPolicy\":\"approval\",\"announcement\":\"毎晩21時\"}");
            Assert.Equal(TeamJoinPolicy.Approval, t.JoinPolicy);
            Assert.Equal(TeamRole.Leader, t.MyRole);
            Assert.Equal(TeamRole.Officer, t.Members[1].Role);
            Assert.Equal(20, t.Members[1].Contribution);
            Assert.Equal("b", Assert.Single(t.Requests).PlayerId);

            _http.Reply(200, "{\"team\":" + Team + ",\"cooldownUntil\":0,\"outgoing\":[],\"rank\":{\"rank\":3,\"total\":40,\"generatedAt\":5}}");
            var me = await _api.GetMyTeamAsync();
            Last("GET", "/v1/teams/me");
            Assert.Equal(3, me.Rank.Rank);

            _http.Reply(200, "{\"team\":null,\"cooldownUntil\":99,\"outgoing\":[\"tx\"],\"rank\":null}");
            var none = await _api.GetMyTeamAsync();
            Assert.Null(none.Team);
            Assert.Null(none.Rank);
            Assert.Equal(99, none.CooldownUntil);
        }

        [Fact]
        public async Task TeamManagementCalls()
        {
            _http.Reply(200, "{\"status\":\"requested\",\"teamId\":\"tabc123def\"}");
            Assert.Equal("requested", await _api.JoinTeamAsync("tabc123def"));
            Last("POST", "/v1/teams/tabc123def/join");

            _http.Reply(200, "{\"status\":\"joined\",\"teamId\":\"tabc123def\",\"playerId\":\"b\"}");
            Assert.True(await _api.ApproveTeamRequestAsync("b"));
            Last("POST", "/v1/teams/me/requests/b/approve");

            _http.Reply(200, "{\"declined\":true}");
            Assert.True(await _api.DeclineTeamRequestAsync("c"));
            Last("POST", "/v1/teams/me/requests/c/decline");

            _http.Reply(200, Team);
            await _api.SetTeamRoleAsync("a", TeamRole.Officer);
            Last("PUT", "/v1/teams/me/roles", "{\"playerId\":\"a\",\"role\":\"officer\"}");

            _http.Reply(200, Team);
            await _api.TransferTeamLeadershipAsync("a");
            Last("POST", "/v1/teams/me/transfer", "{\"playerId\":\"a\"}");

            _http.Reply(200, Team);
            await _api.UpdateTeamAsync("新しいお知らせ", TeamJoinPolicy.Open);
            Last("PUT", "/v1/teams/me", "{\"announcement\":\"新しいお知らせ\",\"joinPolicy\":\"open\"}");

            _http.Reply(200, "{\"kicked\":\"x\"}");
            Assert.True(await _api.KickTeamMemberAsync("x"));
            Last("POST", "/v1/teams/me/kick", "{\"playerId\":\"x\"}");

            _http.Reply(200, "{\"left\":\"tabc123def\",\"disbanded\":false}");
            Assert.False(await _api.LeaveTeamAsync());
            Last("POST", "/v1/teams/me/leave");

            _http.Reply(200, "{\"disbanded\":\"tabc123def\"}");
            Assert.Equal("tabc123def", await _api.DisbandTeamAsync());
            Last("DELETE", "/v1/teams/me");

            _http.Reply(200, "{\"cancelled\":true}");
            Assert.True(await _api.CancelTeamRequestAsync("tzzz999yyy"));
            Last("DELETE", "/v1/teams/tzzz999yyy/request");

            _http.Reply(200, Team);
            Assert.Equal("あおばRC", (await _api.GetTeamAsync("tabc123def")).Name);
            Last("GET", "/v1/teams/tabc123def");
        }

        [Fact]
        public async Task SearchAndLeaderboard()
        {
            _http.Reply(200, "[{\"teamId\":\"tabc123def\",\"name\":\"あおばRC\",\"joinPolicy\":\"open\",\"members\":5,\"points\":300,\"season\":\"2026-11\",\"updatedAt\":9}]");
            var found = await _api.SearchTeamsAsync("あおば RC");
            Assert.Equal(300, Assert.Single(found).Points);
            Last("GET", "/v1/teams/search?q=" + System.Uri.EscapeDataString("あおば RC"));

            _http.Reply(200, "{\"seasonId\":\"2026-11\",\"board\":\"teams\",\"generatedAt\":5,\"total\":1,\"entries\":[{\"rank\":1,\"teamId\":\"tabc123def\",\"name\":\"あおばRC\",\"points\":300,\"members\":5}]}");
            var b = await _api.GetTeamLeaderboardAsync();
            Assert.Equal(1, Assert.Single(b.Entries).Rank);
            var r = Last("GET", "/v1/teams/leaderboard/current");
            Assert.False(r.Headers.ContainsKey("authorization")); // public snapshot
        }

        private const string Ev = "{\"id\":\"sprint_cup_2026_11\",\"name\":\"青葉スプリント杯\",\"status\":\"open\",\"startAtMs\":1,\"endAtMs\":2,\"trackIds\":[\"aoba_turf_1600\"],"
            + "\"fee\":{\"kind\":\"free\",\"freeCoins\":30},\"eligible\":true,\"notEligibleReasons\":[],\"me\":{\"points\":110,\"races\":1,\"wins\":1,\"milestones\":[],\"pending\":false,\"closed\":false,\"rank\":null}}";

        [Fact]
        public async Task Events()
        {
            _http.Reply(200, "[" + Ev + "]");
            var list = await _api.GetEventsAsync();
            Assert.Equal("free", list[0].Fee.Kind);
            Assert.Equal(110, list[0].Me.Points);
            Last("GET", "/v1/events");

            _http.Reply(200, "{\"state\":\"queued\",\"eventId\":\"sprint_cup_2026_11\",\"entryId\":\"e1\"}");
            Assert.Equal("queued", await _api.EnqueueEventAsync("sprint_cup_2026_11", "h1", "my-key"));
            var r = Last("POST", "/v1/events/sprint_cup_2026_11/enqueue", "{\"horseId\":\"h1\"}");
            Assert.Equal("my-key", r.Headers["idempotency-key"]);

            _http.Reply(200, "{\"state\":\"none\",\"refunded\":true}");
            Assert.True(await _api.CancelEventQueueAsync("sprint_cup_2026_11"));
            Last("POST", "/v1/events/sprint_cup_2026_11/cancel");

            _http.Reply(200, "{\"eventId\":\"sprint_cup_2026_11\",\"generatedAt\":1,\"total\":1,\"entries\":[{\"rank\":1,\"playerId\":\"p\",\"displayName\":\"P\",\"points\":110,\"races\":1,\"wins\":1}]}");
            Assert.Equal(110, Assert.Single((await _api.GetEventLeaderboardAsync("sprint_cup_2026_11")).Entries).Points);

            _http.Reply(200, "{\"event\":" + Ev + ",\"rank\":{\"rank\":1,\"total\":1,\"generatedAt\":1}}");
            var me = await _api.GetMyEventAsync("sprint_cup_2026_11");
            Assert.Equal(1, me.Rank.Rank);
            Last("GET", "/v1/events/sprint_cup_2026_11/me");
        }

        [Fact]
        public async Task NewErrorCodesAreTyped()
        {
            _http.Reply(409, "{\"error\":{\"code\":\"TEAM_COOLDOWN\",\"message\":\"later\"}}");
            var e = await Assert.ThrowsAsync<ConflictException>(() => _api.JoinTeamAsync("tabc123def"));
            Assert.Equal(ApiErrorCode.TeamCooldown, e.Code);
            _http.Reply(404, "{\"error\":{\"code\":\"NOT_IN_TEAM\",\"message\":\"x\"}}");
            await Assert.ThrowsAsync<NotFoundException>(() => _api.LeaveTeamAsync());
            _http.Reply(409, "{\"error\":{\"code\":\"EVENT_CLOSED\",\"message\":\"x\"}}");
            var e2 = await Assert.ThrowsAsync<ConflictException>(() => _api.EnqueueEventAsync("sprint_cup_2026_11", "h"));
            Assert.Equal(ApiErrorCode.EventClosed, e2.Code);
        }

        [Fact]
        public void EventModeRoundTripsAndTheGoldenEventRaceHonoursNoWhips()
        {
            Assert.Equal(RaceMode.Event, ProtocolCodec.ParseMode("event"));
            Assert.Equal("event", ProtocolCodec.ModeToString(RaceMode.Event));
            var cfg = ProtocolCodec.ParseConfig(JsonNode.Parse(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "contracts", "golden", "ts-config-event.json"))));
            Assert.Equal(RaceMode.Event, cfg.Mode);
            Assert.Equal(0, cfg.Ruleset.MaxWhips);
            var sim = new RaceSim(cfg);
            var cmds = new byte[cfg.Entrants.Count];
            while (!sim.IsFinished)
            {
                for (int i = 0; i < cmds.Length; i++) cmds[i] = (byte)((sim.Tick % 5 == 0 ? Cmd.Whip : 0) | (sim.Tick == cfg.Ruleset.GateOpenTick ? Cmd.Start : 0));
                sim.Step(cmds);
            }
            for (int s = 0; s < cfg.Entrants.Count; s++) Assert.Equal(0, sim.GetHorse(s).WhipsLeft);
            Assert.DoesNotContain(sim.Events, ev => ev.Type == RaceEventType.Whip); // whips are refused under maxWhips 0
        }
    }
}
