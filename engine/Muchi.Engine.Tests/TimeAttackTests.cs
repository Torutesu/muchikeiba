using System.Linq;
using Muchi.Client;
using Muchi.Net;
using Muchi.Verifier;
using Xunit.Abstractions;

namespace Muchi.Engine.Tests
{
    /// <summary>
    /// Time attack + ghosts (REQ-TA-*): the run recorded on the device verifies on the server, ghosts replay
    /// their recorded finish, tampering is detected, and the client API speaks the server's shapes.
    /// </summary>
    public class TimeAttackTests
    {
        private readonly ITestOutputHelper _out;
        public TimeAttackTests(ITestOutputHelper output) { _out = output; }

        private static string GoldenPath => Path.Combine(TestUtil.RepoRoot, "contracts", "golden", "ts-config-timeattack.json");

        /// <summary>The config exactly as the TypeScript time-attack builder produces it (contracts/golden).</summary>
        private static TimeAttackSession Session(ulong? seed = null)
        {
            var json = JsonNode.Parse(File.ReadAllText(GoldenPath));
            if (seed.HasValue) json.Set("seed", seed.Value.ToString(System.Globalization.CultureInfo.InvariantCulture));
            return new TimeAttackSession { SessionId = "s1", Token = "tok", ConfigJson = json, Config = ProtocolCodec.ParseConfig(json), AttemptsLeft = 29 };
        }

        /// <summary>A competent rider: start on the gate, hold the rein mid-race, spaced whips from 400m out.</summary>
        private static void Ride(OfflineRace race, Action stepOnce, bool whip = true)
        {
            var p = race.Sim.P;
            int lastWhip = -100, whips = 0;
            bool rein = false, released = false;
            while (!race.IsFinished)
            {
                int tick = race.Sim.Tick;
                var me = race.Sim.GetHorse(0);
                var left = race.Sim.Track.Distance - me.Distance;
                if (tick == p.GateOpenTick) race.Input(Cmd.Start);
                if (!rein && left < Fx.FromInt(1200) && left > Fx.FromInt(700)) { rein = true; race.Input(Cmd.ReinPress); }
                if (rein && !released && left <= Fx.FromInt(700)) { released = true; race.Input(Cmd.ReinRelease); }
                if (whip && left <= Fx.FromInt(400) && whips < p.MaxWhips && tick - lastWhip >= 24) { whips++; lastWhip = tick; race.Input(Cmd.Whip); }
                stepOnce();
            }
        }

        private static OfflineRace RunOnce(TimeAttackSession s, bool whip = true)
        {
            var race = new OfflineRace(s.Config, 0);
            Ride(race, race.StepOnce, whip);
            return race;
        }

        private static ReplayLog LogOf(OfflineRace race) => new ReplayLog { Config = race.Config, EndTick = -1, Inputs = race.RecordedInputs.ToList() };

        private static JsonNode Verify(ReplayLog log)
        {
            var (status, body) = VerifyService.Verify(ProtocolCodec.ReplayLogToJson(log).ToString());
            Assert.Equal(200, status);
            return JsonNode.Parse(body);
        }

        /// <summary>Server formula (server/src/domain/timeAttack.ts raceTimeMs).</summary>
        private static long ServerTimeMs(RaceConfig c, int finishTick, long finishFrac)
        {
            int msPerTick = 1000 / c.Net.TickHz;
            return (long)(finishTick - c.Ruleset.GateOpenTick) * msPerTick + finishFrac * msPerTick / 65536;
        }

        [Fact]
        public void TsTimeAttackConfigIsASingleNormalisedHorse()
        {
            var s = Session();
            Assert.Equal(RaceMode.TimeAttack, s.Config.Mode);
            Assert.Single(s.Config.Entrants);
            Assert.Equal(EntrantKind.Human, s.Config.Entrants[0].Kind);
            Assert.Equal("timeattack", ProtocolCodec.ModeToString(s.Config.Mode));
        }

        [Fact]
        public void RecordedRunVerifiesWithTheSameHashTimeAndFraction()
        {
            var s = Session();
            var race = RunOnce(s);
            var me = race.Sim.GetHorse(0);
            Assert.True(me.Finished);
            Assert.NotEmpty(race.RecordedInputs);
            Assert.All(race.RecordedInputs, r => Assert.Equal(0, r.Slot));
            Assert.Equal(race.RecordedInputs.Count, race.RecordedInputs.Select(r => r.Tick).Distinct().Count());

            var v = Verify(LogOf(race));
            Assert.Equal(race.ResultHash, v.Get("resultHash").AsString());
            Assert.Equal(me.FinishTick, v.Get("finishTicks")[0].AsInt());
            Assert.Equal(me.FinishFracRaw, v.Get("finishFracs")[0].AsLong());
            Assert.Equal(race.FinishTimeMs(0), ServerTimeMs(s.Config, me.FinishTick, me.FinishFracRaw));
        }

        [Fact]
        public void TamperedLogsDoNotReproduceTheClaimedHash()
        {
            var s = Session();
            var race = RunOnce(s);
            var claimed = race.ResultHash;

            // drop the gate START (the horse starts late). Note: a whip that changes nothing about the finish
            // (e.g. one in the final tick) is invisible to the result hash, so tamper tests use inputs that matter.
            var dropped = LogOf(race);
            dropped.Inputs.RemoveAt(dropped.Inputs.FindIndex(r => (r.Cmd & Cmd.Start) != 0));
            Assert.NotEqual(claimed, Verify(dropped).Get("resultHash").AsString());

            // a stronger horse than issued (the server always uses ITS config, so this only shows the hash moves)
            var stronger = LogOf(race);
            var e = stronger.Config.Entrants[0];
            stronger.Config = ProtocolCodec.ParseConfig(ProtocolCodec.ConfigToJson(stronger.Config));
            stronger.Config.Entrants[0].Horse.Speed = Math.Min(1000, e.Horse.Speed + 200);
            Assert.NotEqual(claimed, Verify(stronger).Get("resultHash").AsString());

            // whips moved earlier
            var shifted = LogOf(race);
            shifted.Inputs = shifted.Inputs.Select(r => (r.Cmd & Cmd.Whip) != 0 ? new InputRecord(r.Tick - 40, r.Slot, r.Cmd) : r).OrderBy(r => r.Tick).ToList();
            Assert.NotEqual(claimed, Verify(shifted).Get("resultHash").AsString());
        }

        [Fact]
        public void GhostReplayReproducesTheRecordedFinish()
        {
            var s = Session(seed: 99);
            var race = RunOnce(s);
            var ghost = new Ghost { Log = LogOf(race), Meta = new GhostMeta { PlayerId = "p1", FinishTick = race.Sim.GetHorse(0).FinishTick, TimeMs = race.FinishTimeMs(0) } };
            // through JSON, as it comes from GET /v1/time-attack/ghosts/…
            var wire = JsonNode.Obj();
            wire.Set("meta", JsonNode.Parse("{\"playerId\":\"p1\",\"displayName\":\"騎手\",\"horseName\":\"H\",\"seasonId\":\"2026-11\",\"trackId\":\"t\",\"timeMs\":" + race.FinishTimeMs(0) + ",\"finishTick\":" + race.Sim.GetHorse(0).FinishTick + ",\"finishFrac\":0}"));
            wire.Set("log", ProtocolCodec.ReplayLogToJson(ghost.Log));
            var parsed = Ghost.Parse(JsonNode.Parse(wire.ToString()));

            var gp = new GhostPlayer(parsed);
            gp.RunToEnd();
            Assert.True(gp.Finished);
            Assert.Equal(race.Sim.GetHorse(0).FinishTick, gp.Horse.FinishTick);
            Assert.Equal(race.Sim.GetHorse(0).FinishFracRaw, gp.Horse.FinishFracRaw);
            Assert.Equal(race.FinishTimeMs(0), gp.FinishTimeMs);
            Assert.Equal(race.ResultHash, gp.Sim.Result.Hash);
        }

        [Fact]
        public void GhostsRunInLockstepAndNeverAffectThePlayersRun()
        {
            var ghostRace = RunOnce(Session(seed: 5));
            var ghost = new Ghost { Log = LogOf(ghostRace) };

            var solo = RunOnce(Session(seed: 6), whip: false);

            var run = new TimeAttackRun(Session(seed: 6));
            var gp = run.AddGhost(ghost);
            var gp2 = run.AddGhost(ghost);
            Ride(run.Race, () =>
            {
                run.StepOnce();
                if (!gp.Finished) Assert.Equal(run.Race.Sim.Tick, gp.Sim.Tick);
            }, whip: false);
            Assert.Equal(solo.ResultHash, run.Race.ResultHash);           // the player's run is unaffected by ghosts
            Assert.Equal(solo.RecordedInputs.Count, run.Race.RecordedInputs.Count);
            gp.RunToEnd();
            Assert.Equal(ghostRace.Sim.GetHorse(0).FinishTick, gp.Horse.FinishTick);
            Assert.Equal(gp.Horse.FinishTick, gp2.Horse.FinishTick);
            // the whipping ghost beats the no-whip player
            Assert.True(gp.FinishTimeMs < run.FinishTimeMs);
        }

        [Fact]
        public void TimeAttackRunRequiresATimeAttackConfig()
        {
            var s = Session();
            s.Config.Mode = RaceMode.Ranked;
            Assert.Throws<ArgumentException>(() => new TimeAttackRun(s));
        }

        /// <summary>Measures typical times per track (used to set the milestone thresholds in master/progression.json).</summary>
        [Fact]
        public void MeasureTypicalTimesPerTrack()
        {
            var baseCfg = Session();
            foreach (var (track, segments, dist) in new[]
            {
                ("aoba_turf_1600", new[] { (0, 350, 0), (1, 600, 120), (0, 650, 0) }, 1600),
                ("kirameki_turf_2000", new[] { (0, 300, 0), (1, 300, 110), (0, 450, 0), (1, 450, 110), (0, 500, 0) }, 2000),
                ("minato_turf_2400", new[] { (0, 400, 0), (1, 300, 130), (0, 500, 0), (1, 600, 130), (0, 600, 0) }, 2400),
            })
            {
                var times = new List<long>();
                var noWhip = new List<long>();
                for (ulong seed = 1; seed <= 20; seed++)
                {
                    var s = Session(seed);
                    s.Config.Track = new TrackSpec { Id = track, Surface = Surface.Turf, DistanceM = dist, Segments = segments.Select(x => new TrackSegment((SegmentKind)x.Item1, x.Item2, x.Item3)).ToList() };
                    times.Add(RunOnce(s).FinishTimeMs(0));
                    noWhip.Add(RunOnce(s, whip: false).FinishTimeMs(0));
                }
                times.Sort();
                noWhip.Sort();
                string line = $"{track}: ridden min {times.First()} median {times[times.Count / 2]} max {times.Last()} | no whip median {noWhip[noWhip.Count / 2]}";
                _out.WriteLine(line);
                File.AppendAllText(Path.Combine(AppContext.BaseDirectory, "ta-times.txt"), line + Environment.NewLine);
                Assert.All(times, t => Assert.True(t > 0));
            }
        }

        // ------------------------------------------------------------------ client API

        private readonly FakeHttp _http = new FakeHttp();

        private ApiClient Api()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            return new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        [Fact]
        public async Task StartParsesTheIssuedConfigAndIsNotRetried()
        {
            var api = Api();
            string cfg = File.ReadAllText(GoldenPath);
            _http.Reply(200, "{\"sessionId\":\"abc\",\"token\":\"t.k\",\"expiresAt\":1730000600000,\"attemptsLeft\":29,\"config\":" + cfg + "}");
            var s = await api.StartTimeAttackAsync("kirameki_turf_2000", "h_1");
            Assert.Equal("abc", s.SessionId);
            Assert.Equal(RaceMode.TimeAttack, s.Config.Mode);
            Assert.Equal(29, s.AttemptsLeft);
            var r = Assert.Single(_http.Requests);
            Assert.Equal("POST", r.Method);
            Assert.Equal("/v1/time-attack/start", r.Path);
            Assert.Equal(JsonNode.Parse("{\"trackId\":\"kirameki_turf_2000\",\"horseId\":\"h_1\"}").ToString(), JsonNode.Parse(r.Body).ToString());

            _http.Requests.Clear();
            _http.Reply(503, "{\"error\":{\"code\":\"INTERNAL\",\"message\":\"x\"}}").Reply(200, "{}");
            await Assert.ThrowsAsync<ServerException>(() => api.StartTimeAttackAsync("kirameki_turf_2000", "h_1"));
            Assert.Single(_http.Requests); // consumes an attempt: never retried automatically
        }

        [Fact]
        public async Task SubmitSendsInputsHashAndEchoedConfigAndRetries()
        {
            var api = Api();
            var s = Session();
            var race = RunOnce(s);
            _http.Reply(503, "{\"error\":{\"code\":\"VERIFIER_UNAVAILABLE\",\"message\":\"down\"}}")
                 .Reply(200, "{\"sessionId\":\"s1\",\"trackId\":\"kirameki_turf_2000\",\"seasonId\":\"2026-11\",\"finished\":true,\"timeMs\":91234,\"finishTick\":1885,\"finishFrac\":1200,\"resultHash\":\"" + race.ResultHash + "\",\"seasonBest\":true,\"allTimeBest\":true,\"previousSeasonBestMs\":null,\"milestones\":[{\"id\":\"ta_first_clear\",\"reward\":{\"freeCoins\":50}}],\"published\":true}");
            var r = await api.SubmitTimeAttackAsync(s, race);
            Assert.True(r.Finished && r.SeasonBest && r.Published);
            Assert.Equal(91234, r.TimeMs);
            Assert.Equal("ta_first_clear", r.Milestones.Single().Id);
            Assert.Equal(50, r.Milestones.Single().Reward.FreeCoins);
            Assert.Equal(2, _http.Requests.Count);
            var body = JsonNode.Parse(_http.Requests[1].Body);
            Assert.Equal("s1", body.Get("sessionId").AsString());
            Assert.Equal("tok", body.Get("token").AsString());
            Assert.Equal(race.ResultHash, body.Get("resultHash").AsString());
            Assert.Equal(race.RecordedInputs.Count, body.Get("inputs").Count);
            Assert.Equal(race.RecordedInputs[0].Tick, body.Get("inputs")[0][0].AsInt());
            Assert.Equal(s.ConfigJson.ToString(), body.Get("config").ToString());
            Assert.Equal(_http.Requests[0].Body, _http.Requests[1].Body);

            await Assert.ThrowsAsync<InvalidOperationException>(() => api.SubmitTimeAttackAsync(s, new OfflineRace(s.Config, 0)));
        }

        [Fact]
        public async Task ResultMismatchIsAConflict()
        {
            var api = Api();
            var s = Session();
            var race = RunOnce(s);
            _http.Reply(422, "{\"error\":{\"code\":\"TA_RESULT_MISMATCH\",\"message\":\"no\"}}");
            var e = await Assert.ThrowsAsync<ConflictException>(() => api.SubmitTimeAttackAsync(s, race));
            Assert.Equal(ApiErrorCode.TaResultMismatch, e.Code);
            Assert.Single(_http.Requests);
        }

        [Fact]
        public async Task MeGhostListAndGhostDownload()
        {
            var api = Api();
            _http.Reply(200, "{\"trackId\":\"kirameki_turf_2000\",\"seasonId\":\"2026-11\",\"seasonBest\":{\"timeMs\":91000,\"finishTick\":1880,\"finishFrac\":0,\"sessionId\":\"s1\",\"horseId\":\"h\",\"horseName\":\"H\",\"at\":1},\"allTimeBest\":null,\"attemptsLeft\":28,\"milestones\":[{\"id\":\"m\",\"maxTimeMs\":null,\"reward\":{\"freeCoins\":5},\"reached\":true}],\"rank\":{\"rank\":3,\"total\":40,\"generatedAt\":5}}");
            var me = await api.GetTimeAttackMeAsync("kirameki_turf_2000");
            Assert.Equal(91000, me.SeasonBest.TimeMs);
            Assert.Null(me.AllTimeBest);
            Assert.Equal(3, me.Rank);
            Assert.Equal(40, me.Total);
            Assert.True(me.Milestones[0].Reached);
            Assert.Equal("/v1/time-attack/kirameki_turf_2000/me", _http.Requests.Last().Path);

            _http.Reply(200, "{\"seasonId\":\"2026-11\",\"trackId\":\"kirameki_turf_2000\",\"kind\":\"friends\",\"ghosts\":[{\"playerId\":\"p 2\",\"displayName\":\"友\",\"horseName\":\"H\",\"timeMs\":90000,\"rank\":null,\"path\":\"/v1/time-attack/ghosts/2026-11/kirameki_turf_2000/p%202\"}]}");
            var list = await api.GetGhostsAsync("kirameki_turf_2000", GhostKind.Friends, "2026-11");
            Assert.Equal("/v1/time-attack/kirameki_turf_2000/ghosts?kind=friends&seasonId=2026-11", _http.Requests.Last().Path);
            Assert.Null(list.Ghosts[0].Rank);

            var race = RunOnce(Session());
            var file = JsonNode.Obj();
            file.Set("meta", JsonNode.Parse("{\"playerId\":\"p 2\",\"displayName\":\"友\",\"horseName\":\"H\",\"seasonId\":\"2026-11\",\"trackId\":\"kirameki_turf_2000\",\"timeMs\":90000,\"finishTick\":1800,\"finishFrac\":0}"));
            file.Set("log", ProtocolCodec.ReplayLogToJson(LogOf(race)));
            _http.Reply(200, file.ToString());
            var g = await api.GetGhostAsync(list.Ghosts[0]);
            Assert.Equal("/v1/time-attack/ghosts/2026-11/kirameki_turf_2000/p%202", _http.Requests.Last().Path);
            Assert.Equal("p 2", g.Meta.PlayerId);
            Assert.Equal(race.RecordedInputs.Count, g.Log.Inputs.Count);
        }
    }
}
