using System.IO;
using System.Linq;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-MYRP-*: マイリプレイ client methods and models, and ReplayPlayer on the real engine (contracts/protocol.md §37).</summary>
    public class MyReplaysTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public MyReplaysTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        // the shape PlayerService.myReplays answers (server test my-replays.test.ts)
        internal const string View = "{\"enabled\":true,\"maxSaved\":20,\"used\":1,\"titleMaxChars\":24,\"saved\":[{\"raceId\":\"r1\",\"at\":1796695200000,\"mode\":\"ranked\",\"trackId\":\"kirameki_turf_2000\",\"place\":1,\"fieldSize\":12,\"slot\":0,\"resultHash\":\"" + H64 + "\",\"rulesetVersion\":\"1.3.0\",\"moment\":\"win\",\"replayTitle\":\"1着\",\"favorite\":true,\"public\":false,\"savedAt\":1796695300000,\"sizeBytes\":18234,\"playable\":true,\"reason\":null}],\"moments\":[{\"raceId\":\"r2\",\"at\":1796696200000,\"mode\":\"ranked\",\"trackId\":\"aoba_turf_1600\",\"place\":2,\"fieldSize\":12,\"slot\":1,\"resultHash\":\"" + H64 + "\",\"rulesetVersion\":\"1.3.0\",\"moment\":\"photo\",\"saved\":false,\"expiresAt\":1799115400000}],\"recent\":[]}";
        private const string H64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

        [Fact]
        public async Task ListParsesSavedMomentsAndTitlesAsTyped()
        {
            _http.Reply(200, View);
            var v = await _api.GetMyReplaysAsync();
            Assert.Equal("/v1/replays", _http.Requests[0].Path);
            Assert.True(v.Enabled);
            Assert.False(v.Full);
            var s = v.Saved.Single();
            Assert.Equal("1着", s.ReplayTitle); // player-typed, never translated
            Assert.True(s.Favorite && !s.Public && s.Playable && s.IsMoment);
            Assert.Equal(18234, s.SizeBytes);
            var mo = v.Moments.Single();
            Assert.Equal("photo", mo.Moment);
            Assert.Equal(1799115400000L, mo.ExpiresAt);
            Assert.False(mo.Saved);
        }

        [Fact]
        public async Task SaveIsKeyedUpdateIsPatchDeleteIsSafe()
        {
            _http.Reply(503, "{\"error\":{\"code\":\"INTERNAL\"}}").Reply(200, "{\"saved\":" + SavedJson() + ",\"alreadySaved\":false,\"view\":" + View + "}");
            var r = await _api.SaveReplayAsync("r1", "差し切った日");
            Assert.Equal("POST", _http.Requests[0].Method);
            Assert.Equal(_http.Requests[0].Headers["idempotency-key"], _http.Requests[1].Headers["idempotency-key"]); // the retry reuses the key
            Assert.Contains("\"replayTitle\":\"差し切った日\"", _http.Requests[0].Body);
            Assert.False(r.AlreadySaved);
            _http.Reply(200, "{\"saved\":" + SavedJson() + "}");
            await _api.UpdateReplayAsync("r1", clearTitle: true, isPublic: true);
            Assert.Equal("PATCH", _http.Requests[2].Method);
            Assert.Equal("/v1/replays/r1", _http.Requests[2].Path);
            Assert.Equal("{\"replayTitle\":null,\"public\":true}", _http.Requests[2].Body);
            bool refused = false;
            try { _ = _api.UpdateReplayAsync("r1"); } catch (System.ArgumentException) { refused = true; }
            Assert.True(refused); // nothing to change: refused before any request
            _http.Reply(200, "{\"deleted\":false,\"view\":" + View + "}");
            Assert.False((await _api.DeleteReplayAsync("r1")).Deleted);
            Assert.Equal("DELETE", _http.Requests[3].Method);
            _http.Reply(409, "{\"error\":{\"code\":\"REPLAY_LIMIT\",\"message\":\"at most 20\"}}");
            var e = await Assert.ThrowsAsync<ConflictException>(() => _api.SaveReplayAsync("r9"));
            Assert.Equal(ApiErrorCode.ReplayLimit, e.Code);
            _http.Reply(410, "{\"error\":{\"code\":\"REPLAY_EXPIRED\",\"message\":\"gone\"}}");
            var x = await Assert.ThrowsAsync<ConflictException>(() => _api.GetReplayDataAsync("r9"));
            Assert.Equal(ApiErrorCode.ReplayExpired, x.Code);
            Assert.Equal(410, x.Status);
        }

        private static string SavedJson() => "{\"raceId\":\"r1\",\"at\":1,\"mode\":\"ranked\",\"trackId\":\"t\",\"place\":1,\"fieldSize\":12,\"slot\":0,\"resultHash\":\"" + H64 + "\",\"rulesetVersion\":\"1.3.0\",\"moment\":\"win\",\"replayTitle\":null,\"favorite\":false,\"public\":true,\"savedAt\":2,\"sizeBytes\":10,\"playable\":true,\"reason\":null}";

        /// <summary>A ridden race (slot 0 a human with a secret id) and its §37 replay data, as the server sends it.</summary>
        private static (RaceConfig cfg, OfflineRace race, string json) Ridden(string playerIdInLog)
        {
            var rs = TestUtil.Ruleset();
            var horses = Enumerable.Range(0, 8).Select(i => TestUtil.H("h" + i, 520 + i * 7, (RunningStyle)(i % 4))).ToList();
            var cfg = TestUtil.Cfg(TestUtil.CornerTrack(1600), rs, horses, 1, 11);
            cfg.Mode = RaceMode.Ranked;
            cfg.Entrants[0].PlayerId = "player_secret_id";
            var race = new OfflineRace(cfg, 0);
            int lastWhip = -100;
            while (!race.IsFinished)
            {
                var me = race.Sim.GetHorse(0);
                if (race.Sim.Tick == race.Sim.P.GateOpenTick) race.Input(Cmd.Start);
                if (me.Departed && race.Sim.Track.Distance - me.Distance <= Fx.FromInt(500) && race.Sim.Tick - lastWhip >= 24) { lastWhip = race.Sim.Tick; race.Input(Cmd.Whip); }
                race.StepOnce();
            }
            // what the server sends: the stored log with the other humans' ids replaced (here: the rider's own id swapped too)
            var sent = ProtocolCodec.ParseConfig(ProtocolCodec.ConfigToJson(cfg).ToString());
            sent.Entrants[0].PlayerId = playerIdInLog;
            var log = new ReplayLog { Config = sent, EndTick = race.Sim.Tick, Inputs = race.AllInputs().ToList() };
            var o = JsonNode.Obj().Set("raceId", "r1").Set("owner", "me").Set("replayTitle", "テスト").Set("resultHash", race.Sim.Result.Hash).Set("focusSlot", 0)
                .Set("rulesetVersion", cfg.Ruleset.RulesetVersion).Set("playable", true).Set("reason", JsonNode.Null())
                .Set("entrants", JsonNode.Arr().Add(JsonNode.Obj().Set("slot", 0).Set("horseName", "h0").Set("owner", "you")))
                .Set("replayLog", ProtocolCodec.ReplayLogToJson(log));
            return (cfg, race, o.ToString());
        }

        [Fact]
        public void PlayerReSimulatesTheWholeRaceAndRedactedIdsKeepTheHash()
        {
            var (cfg, race, json) = Ridden("p0");
            var d = ReplayData.FromJson(json);
            Assert.Equal("テスト", d.ReplayTitle);
            var p = ReplayPlayer.Open(d);
            Assert.True(p.Playable, p.Reason);
            Assert.Equal(race.Sim.Result.Hash, p.Result.Hash); // REQ-MYRP-008: playerId is never read by the engine
            Assert.Equal(race.Sim.Tick, p.EndTick);
            Assert.Equal(0, p.CameraSlot);
            // states equal the live race at the end
            var f = p.FrameAt(p.DurationMs);
            for (int s = 0; s < cfg.Entrants.Count; s++) Assert.Equal(race.Sim.GetHorse(s).Distance, f.To[s].Distance);
            Assert.True(f.Finished);
            Assert.Equal(0, f.RemainingM, 6);
        }

        [Fact]
        public void SpeedsCameraSeekAndTheLast200m()
        {
            var (cfg, _, json) = Ridden("player_secret_id");
            var p = ReplayPlayer.Open(ReplayData.FromJson(json));
            Assert.Equal(1.0, p.Speed);
            p.Advance(1000);
            Assert.Equal(1000, p.TimeMs);
            p.SetSpeed(0.5); p.Advance(1000);
            Assert.Equal(1500, p.TimeMs);
            p.SetSpeed(2); p.Advance(1000);
            Assert.Equal(3500, p.TimeMs);
            Assert.Throws<System.ArgumentException>(() => p.SetSpeed(4));
            Assert.Equal(0.5, p.CycleSpeed());
            p.Paused = true; p.Advance(1000);
            Assert.Equal(3500, p.TimeMs);
            p.Paused = false;
            // last 200 m of any horse: the camera horse has <= 200 m left there and > 200 m a tick earlier
            for (int slot = 0; slot < cfg.Entrants.Count; slot += 3)
            {
                p.SetCamera(slot);
                p.JumpToFinalStretch();
                var at = p.Frame();
                Assert.Equal(slot, at.CameraSlot);
                Assert.True(at.RemainingM <= 200.01, "slot " + slot + " rem " + at.RemainingM);
                Assert.True(p.FrameAt(p.TimeMs - 50).RemainingM > 199.0);
            }
            Assert.Throws<System.ArgumentOutOfRangeException>(() => p.SetCamera(cfg.Entrants.Count));
            p.Seek(int.MaxValue);
            Assert.True(p.AtEnd);
            p.Advance(1000);
            Assert.Equal(p.DurationMs, p.TimeMs);
            // the share card is the REQ-UXS-071 one, for the player's own horse
            var card = p.BuildShareCard("きらめき 芝1600m");
            Assert.Equal(System.Array.IndexOf(p.Result.Order, 0) + 1, card.Place);
            Assert.Equal("ムチ一閃", card.Watermark);
            Assert.DoesNotContain("player_secret_id", card.ShareText);
        }

        [Fact]
        public void NeverPlaysADifferentRace()
        {
            var (_, _, json) = Ridden("p0");
            // another build reproducing a different hash
            var wrong = ReplayPlayer.Open(ReplayData.FromJson(json.Replace("\"resultHash\":\"", "\"resultHash\":\"0")));
            Assert.False(wrong.Playable);
            Assert.Equal(ReplayUnplayable.HashMismatch, wrong.Reason);
            Assert.Throws<System.InvalidOperationException>(() => wrong.Frame());
            // the server says the ruleset is retired: not even simulated
            var retired = ReplayPlayer.Open(ReplayData.FromJson(json.Replace("\"playable\":true,\"reason\":null", "\"playable\":false,\"reason\":\"ruleset_retired\"")));
            Assert.Equal(ReplayUnplayable.RulesetRetired, retired.Reason);
            // a ruleset key this build does not know: the log cannot be read → broken, never a crash
            var unknown = ReplayData.FromJson(json.Replace("\"maxTicks\":", "\"futureKey\":1,\"maxTicks\":"));
            Assert.Null(unknown.Log);
            Assert.NotNull(unknown.LogError);
            Assert.Equal(ReplayUnplayable.Broken, ReplayPlayer.Open(unknown).Reason);
        }

        [Fact]
        public void LegacyGoldenRulesetsStillReplay()
        {
            // REQ-MYRP-007: replays pinned to ruleset 1.0 .. 1.2 re-simulate to their recorded hash with this engine
            var dir = Path.Combine(TestUtil.RepoRoot, "contracts", "golden", "legacy");
            int n = 0;
            foreach (var f in Directory.GetFiles(dir, "*.json"))
            {
                var g = JsonNode.Parse(File.ReadAllText(f));
                var o = JsonNode.Obj().Set("raceId", "g").Set("resultHash", g.Get("expected").Get("resultHash").AsString()).Set("focusSlot", 0).Set("playable", true)
                    .Set("rulesetVersion", g.Get("log").Get("config").Get("ruleset").Get("rulesetVersion").AsString()).Set("replayLog", g.Get("log"));
                var p = ReplayPlayer.Open(ReplayData.FromJson(o.ToString()));
                Assert.True(p.Playable, f + ": " + p.Reason);
                n++;
            }
            Assert.True(n >= 10);
        }
    }
}
