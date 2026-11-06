using System.Linq;
using Muchi.Client;
using Muchi.Net;
using Muchi.Verifier;

namespace Muchi.Engine.Tests
{
    /// <summary>Spectator mode (REQ-SPEC-*) and tournament endpoints (REQ-TOUR-*) on the client side.</summary>
    public class SpectatorTournamentTests
    {
        private sealed class Recorder : ITransport
        {
            public readonly List<string> Sent = new List<string>();
            public void Send(string message) => Sent.Add(message);
        }

        private static string Start(RaceConfig cfg, int you, int? delayMs)
        {
            var o = JsonNode.Obj();
            o.Set("t", "start");
            o.Set("you", you);
            o.Set("startAtMs", 1000L);
            o.Set("config", ProtocolCodec.ConfigToJson(cfg));
            if (delayMs.HasValue)
            {
                var sp = JsonNode.Obj();
                sp.Set("delayMs", delayMs.Value);
                o.Set("spectator", sp);
            }
            return o.ToString();
        }

        private static string Bundle(int from, int to)
        {
            var o = JsonNode.Obj();
            o.Set("t", "b");
            o.Set("from", from);
            o.Set("to", to);
            o.Set("in", JsonNode.Arr());
            return o.ToString();
        }

        [Fact]
        public void SpectatorNeverSendsInputsChecksumsOrResultsAndSeesTheSameHash()
        {
            var rs = TestUtil.Ruleset();
            var cfg = SampleRaces.Config("spec_1", 9, SampleRaces.Turf1600(), rs, Enumerable.Range(0, 4).Select(i => TestUtil.H("s" + i)).ToList(), 2, 3, RaceMode.Tournament);
            var t = new Recorder();
            var c = new LockstepClient(t, "spec_1", "tk");
            c.Connect();
            c.HandleMessage(Start(cfg, -1, 10_000));
            Assert.True(c.IsSpectator);
            Assert.Equal(10_000, c.SpectatorDelayMs);
            c.QueueInput(Cmd.Whip);
            for (int from = 0; !c.Sim.IsFinished && from < cfg.Ruleset.MaxTicks; from += 20) c.HandleMessage(Bundle(from, from + 19));
            Assert.True(c.Sim.IsFinished);
            Assert.Equal(new[] { "hello" }, t.Sent.Select(s => JsonNode.Parse(s).Get("t").AsString()).ToArray());

            // a player fed the same stream computes the same result
            var p = new LockstepClient(new Recorder(), "spec_1", "tk");
            p.HandleMessage(Start(cfg, 0, null));
            Assert.False(p.IsSpectator);
            for (int from = 0; !p.Sim.IsFinished && from < cfg.Ruleset.MaxTicks; from += 20) p.HandleMessage(Bundle(from, from + 19));
            Assert.Equal(p.Sim.Result.Hash, c.Sim.Result.Hash);
            Assert.Equal(RaceMode.Tournament, c.Config.Mode);
        }

        [Fact]
        public void SpectatorRendersBehindByTheStreamDelay()
        {
            var cfg = SampleRaces.Config("spec_2", 3, SampleRaces.Turf1600(), TestUtil.Ruleset(), Enumerable.Range(0, 2).Select(i => TestUtil.H("r" + i)).ToList(), 2);
            var live = new LockstepClient(new Recorder(), "spec_2", "tk");
            var delayed = new LockstepClient(new Recorder(), "spec_2", "tk");
            live.RenderHistoryCapacity = delayed.RenderHistoryCapacity = 512; // keep every tick for the comparison
            live.HandleMessage(Start(cfg, -1, 0));
            delayed.HandleMessage(Start(cfg, -1, 2000));
            for (int from = 0; from < 400; from += 20) { live.HandleMessage(Bundle(from, from + 19)); delayed.HandleMessage(Bundle(from, from + 19)); }
            long now = 1000 + 300 * 50;
            Assert.Equal(live.RenderTickPermille(now - 2000), delayed.RenderTickPermille(now));
            Assert.True(live.RenderTickPermille(now) > delayed.RenderTickPermille(now));
        }

        [Fact]
        public void TournamentModeRoundTrips()
        {
            Assert.Equal(RaceMode.Tournament, ProtocolCodec.ParseMode("tournament"));
            Assert.Equal("tournament", ProtocolCodec.ModeToString(RaceMode.Tournament));
        }

        // ------------------------------------------------------------------ HTTP

        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public SpectatorTournamentTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        private HttpRequest Last(string method, string path)
        {
            var r = _http.Requests[_http.Requests.Count - 1];
            Assert.Equal(method, r.Method);
            Assert.Equal(path, r.Path);
            return r;
        }

        [Fact]
        public async Task LiveListAndSpectatorTicket()
        {
            _http.Reply(200, "{\"friends\":[{\"raceId\":\"r_f\",\"mode\":\"friend\",\"startAtMs\":5,\"trackId\":\"aoba_turf_1600\",\"visibility\":\"friends\",\"rating\":1500,\"delayMs\":0,\"title\":null,\"tournamentId\":null,\"players\":2,\"friends\":[\"pal\"],\"you\":false}],"
                + "\"featured\":[{\"raceId\":\"r_t\",\"mode\":\"tournament\",\"startAtMs\":6,\"trackId\":\"aoba_dirt_1400\",\"visibility\":\"public\",\"rating\":1700,\"delayMs\":10000,\"title\":\"杯 決勝\",\"tournamentId\":\"cup\",\"players\":8,\"friends\":[],\"you\":false}],\"generatedAt\":7}");
            var l = await _api.GetLiveRacesAsync();
            Last("GET", "/v1/races/live");
            Assert.Equal("pal", Assert.Single(l.Friends).Friends[0]);
            Assert.Equal("杯 決勝", l.Featured[0].Title);
            Assert.Equal(10_000, l.Featured[0].DelayMs);

            _http.Reply(200, "{\"raceId\":\"r_t\",\"ticket\":\"spec\",\"wsPath\":\"/v1/race/r_t/ws\",\"startAtMs\":6,\"delayMs\":10000,\"mode\":\"tournament\",\"title\":\"杯 決勝\",\"tournamentId\":\"cup\"}");
            var t = await _api.SpectateAsync("r_t");
            Last("POST", "/v1/race/r_t/spectate");
            Assert.Equal("spec", t.Ticket);
            Assert.Equal("wss://api.example.test/v1/race/r_t/ws", _api.SpectatorWebSocketUrl(t));
        }

        [Fact]
        public async Task TournamentCalls()
        {
            _http.Reply(200, "{\"tournaments\":[{\"id\":\"cup\",\"name\":\"杯\",\"status\":\"registration\",\"registrationOpensAtMs\":1,\"registrationClosesAtMs\":2,\"startsAtMs\":3,\"entrants\":4,\"maxEntrants\":64,\"heatSize\":12,\"finishedAt\":null,\"updatedAt\":1}],\"generatedAt\":5}");
            var list = await _api.GetTournamentsAsync();
            Last("GET", "/v1/tournaments");
            Assert.Equal("registration", Assert.Single(list).Status);

            _http.Reply(200, "{\"id\":\"cup\",\"name\":\"杯\",\"status\":\"finished\",\"startsAtMs\":3,\"entrants\":2,\"heatSize\":2,\"trackIds\":[\"aoba_dirt_1400\"],\"fieldSize\":4,\"advancePerHeat\":1,\"minEntrants\":2,"
                + "\"entry\":{\"classIds\":null,\"minRankedRaces\":0,\"styles\":null},\"statCap\":null,\"prizes\":[{\"maxRank\":1,\"reward\":{\"freeCoins\":500}}],"
                + "\"rounds\":[{\"index\":0,\"final\":true,\"startAtMs\":3,\"done\":true,\"heats\":[{\"id\":\"0-0\",\"raceId\":\"r_1\",\"status\":\"finished\",\"startAtMs\":3,\"trackId\":\"aoba_dirt_1400\",\"players\":[{\"playerId\":\"a\",\"displayName\":\"A\"},{\"playerId\":\"b\",\"displayName\":\"B\"}],"
                + "\"results\":[{\"playerId\":\"b\",\"place\":1,\"noShow\":false,\"advanced\":false,\"displayName\":\"B\"},{\"playerId\":\"a\",\"place\":3,\"noShow\":false,\"advanced\":false,\"displayName\":\"A\"}]}]}],"
                + "\"standings\":[{\"playerId\":\"b\",\"displayName\":\"B\",\"rank\":1,\"reachedRound\":0,\"final\":true,\"place\":1,\"noShow\":false},{\"playerId\":\"a\",\"displayName\":\"A\",\"rank\":2,\"reachedRound\":0,\"final\":true,\"place\":3,\"noShow\":false}]}");
            var d = await _api.GetTournamentAsync("cup");
            Last("GET", "/v1/tournaments/cup");
            Assert.Null(d.EntryClassIds);
            Assert.Equal(500, d.Prizes[0].Reward.FreeCoins);
            Assert.Equal(new[] { "a", "b" }, d.Rounds[0].Heats[0].PlayerIds);
            Assert.Equal(3, d.Rounds[0].Heats[0].Results[1].Place);
            Assert.Equal("b", d.Standings[0].PlayerId);

            _http.Reply(200, "{\"tournamentId\":\"cup\",\"status\":\"running\",\"registered\":true,\"horseId\":\"h1\",\"heat\":{\"round\":0,\"final\":false,\"heatId\":\"0-0\",\"raceId\":\"r_1\",\"startAtMs\":9,\"status\":\"created\",\"trackId\":\"aoba_dirt_1400\","
                + "\"assignment\":{\"raceId\":\"r_1\",\"slot\":1,\"ticket\":\"tk\",\"startAtMs\":9,\"wsPath\":\"/v1/race/r_1/ws\"},\"place\":null,\"advanced\":null},\"eliminated\":false,\"standing\":null,\"prize\":null,\"prizePaid\":false}");
            var me = await _api.GetMyTournamentAsync("cup");
            Last("GET", "/v1/tournaments/cup/me");
            Assert.Equal("tk", me.Heat.Assignment.Ticket);
            Assert.Null(me.Heat.Advanced);
            Assert.Null(me.Standing);

            _http.Reply(200, "{\"registered\":true,\"existing\":false,\"tournamentId\":\"cup\",\"status\":\"registration\",\"horseId\":\"h1\",\"heat\":null,\"eliminated\":false,\"standing\":null,\"prize\":null,\"prizePaid\":false}");
            Assert.True((await _api.RegisterTournamentAsync("cup", "h1")).Registered);
            Assert.Equal("{\"horseId\":\"h1\"}", Last("POST", "/v1/tournaments/cup/register").Body);

            _http.Reply(200, "{\"removed\":true}");
            Assert.True(await _api.UnregisterTournamentAsync("cup"));
            Last("POST", "/v1/tournaments/cup/unregister");

            _http.Reply(200, "{\"history\":[{\"tournamentId\":\"cup\",\"name\":\"杯\",\"rank\":1,\"at\":5,\"reward\":{\"freeCoins\":500}}]}");
            var h = await _api.GetTournamentHistoryAsync();
            Last("GET", "/v1/tournaments/history/me");
            Assert.Equal(500, Assert.Single(h).Reward.FreeCoins);
        }
    }
}
