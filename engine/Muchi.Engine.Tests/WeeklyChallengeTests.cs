using System.Linq;
using Muchi.Client;
using Muchi.Net;
using Muchi.Verifier;
using Xunit.Abstractions;

namespace Muchi.Engine.Tests
{
    /// <summary>
    /// 週替わりチャレンジ (REQ-WCH-*, protocol §31): every challenge config the server issues (contracts/golden
    /// ts-config-challenge-*.json, built by startChallenge with the loan horse) runs on the device, verifies on the server
    /// with the same hash, the device evaluation equals the one computed from the verifier output, the time limits are
    /// reachable with the loan horse, and the client API speaks the server's shapes.
    /// </summary>
    public class WeeklyChallengeTests
    {
        private readonly ITestOutputHelper _out;
        public WeeklyChallengeTests(ITestOutputHelper output) { _out = output; }

        private static string Golden(string id) => Path.Combine(TestUtil.RepoRoot, "contracts", "golden", "ts-config-challenge-" + id + ".json");

        /// <summary>The challenge definitions of the shipped master (server/master/progression.json weeklyChallenge).</summary>
        private static Dictionary<string, ChallengeConditions> MasterConditions()
        {
            var prog = JsonNode.Parse(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "master", "progression.json")));
            var map = new Dictionary<string, ChallengeConditions>();
            var rot = prog.Get("weeklyChallenge").Get("rotation");
            for (int w = 0; w < rot.Count; w++)
            {
                var chs = rot[w].Get("challenges");
                for (int i = 0; i < chs.Count; i++)
                {
                    var c = chs[i].Get("conditions");
                    map[chs[i].Get("id").AsString()] = new ChallengeConditions
                    {
                        MaxPlace = c.Has("maxPlace") ? c.Get("maxPlace").AsInt() : (int?)null, Style = c.Has("style") ? c.Get("style").AsString() : null,
                        MaxWhips = c.Has("maxWhips") ? c.Get("maxWhips").AsInt() : (int?)null, MaxTimeMs = c.Has("maxTimeMs") ? c.Get("maxTimeMs").AsLong() : (long?)null,
                    };
                }
            }
            return map;
        }

        private static (RaceConfig cfg, int slot) Load(string id)
        {
            var cfg = ProtocolCodec.ParseConfig(File.ReadAllText(Golden(id)));
            return (cfg, cfg.Entrants.FindIndex(e => e.Kind == EntrantKind.Human));
        }

        /// <summary>A plain rider: START on the gate, rein 1200 → 700 m out, up to <paramref name="whips"/> spaced whips from 400 m out.</summary>
        private static ChallengeRun Ride(RaceConfig cfg, int slot, ChallengeConditions cond, int whips)
        {
            var run = new ChallengeRun(cfg, slot, cond);
            var race = run.Race;
            var p = race.Sim.P;
            int lastWhip = -100, used = 0;
            bool rein = false, released = false;
            while (!race.IsFinished)
            {
                int tick = race.Sim.Tick;
                var me = race.Sim.GetHorse(slot);
                var left = race.Sim.Track.Distance - me.Distance;
                if (tick == p.GateOpenTick) race.Input(Cmd.Start);
                if (!rein && left < Fx.FromInt(1200) && left > Fx.FromInt(700)) { rein = true; race.Input(Cmd.ReinPress); }
                if (rein && !released && left <= Fx.FromInt(700)) { released = true; race.Input(Cmd.ReinRelease); }
                if (me.Departed && left <= Fx.FromInt(400) && used < whips && tick - lastWhip >= 24) { used++; lastWhip = tick; race.Input(Cmd.Whip); }
                race.StepOnce();
            }
            return run;
        }

        private static JsonNode Verify(ReplayLog log)
        {
            var (status, body) = VerifyService.Verify(ProtocolCodec.ReplayLogToJson(log).ToString());
            Assert.Equal(200, status);
            return JsonNode.Parse(body);
        }

        [Fact]
        public void ChallengeModeRoundTripsAndNeverChangesTheSimulation()
        {
            Assert.Equal(RaceMode.Challenge, ProtocolCodec.ParseMode("challenge"));
            Assert.Equal("challenge", ProtocolCodec.ModeToString(RaceMode.Challenge));
            Assert.Equal("challenge", Commentator.ModeName(RaceMode.Challenge));
            Assert.Equal("週替わりチャレンジ", ShareCard.ModeText(RaceMode.Challenge));
            var (cfg, slot) = Load("wa_nige");
            Assert.Equal(RaceMode.Challenge, cfg.Mode);
            // the same race as another mode gives the same result: the mode is a label
            var a = RaceReplay.Run(cfg, new List<InputRecord> { new InputRecord(cfg.Ruleset.GateOpenTick, slot, Cmd.Start) });
            var json = ProtocolCodec.ConfigToJson(cfg);
            json.Set("mode", "friend");
            var b = RaceReplay.Run(ProtocolCodec.ParseConfig(json), new List<InputRecord> { new InputRecord(cfg.Ruleset.GateOpenTick, slot, Cmd.Start) });
            Assert.Equal(a.Result.Hash, b.Result.Hash);
        }


        [Fact]
        public void EveryIssuedChallengeRunsVerifiesAndEvaluatesTheSameOnBothSides()
        {
            var conds = MasterConditions();
            Assert.Equal(9, conds.Count);
            foreach (var kv in conds)
            {
                var (cfg, slot) = Load(kv.Key);
                Assert.True(slot >= 0, kv.Key);
                foreach (var e in cfg.Entrants) Assert.Null(e.Horse.Skill); // no skills in challenges
                int whips = kv.Value.MaxWhips ?? 3;
                var run = Ride(cfg, slot, kv.Value, whips);
                Assert.All(run.Race.RecordedInputs, r => Assert.Equal(slot, r.Slot));
                var dev = run.Evaluate();
                Assert.Equal(Math.Min(whips, cfg.Ruleset.MaxWhips), run.WhipsUsed);
                // the server's view: the verifier's output + the submitted inputs
                var v = Verify(run.Log());
                Assert.Equal(run.Race.ResultHash, v.Get("resultHash").AsString());
                var res = new RaceResult
                {
                    Order = Enumerable.Range(0, v.Get("order").Count).Select(i => v.Get("order")[i].AsInt()).ToArray(),
                    FinishTicks = Enumerable.Range(0, v.Get("finishTicks").Count).Select(i => v.Get("finishTicks")[i].AsInt()).ToArray(),
                    FinishFracOrDistanceRaw = Enumerable.Range(0, v.Get("finishFracs").Count).Select(i => v.Get("finishFracs")[i].AsLong()).ToArray(),
                };
                var srv = ChallengeEvaluator.Evaluate(kv.Value, cfg, slot, run.Race.RecordedInputs, res);
                Assert.Equal(srv.Place, dev.Place);
                Assert.Equal(srv.TimeMs, dev.TimeMs);
                Assert.Equal(srv.Whips, dev.Whips);
                Assert.Equal(srv.Cleared, dev.Cleared);
                Assert.Equal(run.Race.FinishTimeMs(slot), dev.TimeMs ?? -1);
                _out.WriteLine($"{kv.Key}: place {dev.Place}/{cfg.Entrants.Count} time {dev.TimeMs} whips {dev.Whips} cleared {dev.Cleared}");
            }
        }

        [Fact]
        public void TimeLimitsAreReachableWithTheLoanHorseAndNotFree()
        {
            // E18 / protocol §31.2: a plain ride on the loan horse (START on the gate, rein, 3 whips) makes the limit;
            // the same horse never pressing START (a late auto start), never reining or whipping misses it
            foreach (var kv in MasterConditions().Where(c => c.Value.MaxTimeMs.HasValue))
            {
                var (cfg, slot) = Load(kv.Key);
                var good = Ride(cfg, slot, kv.Value, 3).Evaluate();
                Assert.True(good.Finished, kv.Key);
                Assert.True(good.TimeMs <= kv.Value.MaxTimeMs, $"{kv.Key}: a plain ride {good.TimeMs} ms should make {kv.Value.MaxTimeMs} ms");
                var lazy = new ChallengeRun(cfg, slot, kv.Value);
                while (!lazy.Race.IsFinished) lazy.Race.StepOnce();
                var lz = lazy.Evaluate();
                _out.WriteLine($"{kv.Key}: limit {kv.Value.MaxTimeMs} plain {good.TimeMs} lazy {lz.TimeMs}");
                Assert.True(lz.TimeMs > good.TimeMs, kv.Key);
                Assert.True(lz.TimeMs > kv.Value.MaxTimeMs, $"{kv.Key}: a lazy ride ({lz.TimeMs} ms) must not clear it");
            }
        }

        [Fact]
        public void SharedEvaluationExampleMatchesTheServer()
        {
            // the same numbers as server/test/weeklyChallenge.test.ts "shared example" (golden wa_whip3 config)
            var (cfg, slot) = Load("wa_whip3");
            Assert.Equal(2, slot);
            int o1 = (slot + 1) % 8;
            var order = new[] { o1, slot }.Concat(Enumerable.Range(0, 8).Where(x => x != slot && x != o1)).ToArray();
            var res = new RaceResult
            {
                Order = order,
                FinishTicks = order.Select((_, i) => 1840 + i * 5).ToArray(),
                FinishFracOrDistanceRaw = order.Select((_, i) => (long)(40000 + i)).ToArray(),
            };
            var inputs = new List<InputRecord> { new InputRecord(59, slot, Cmd.Start), new InputRecord(1200, slot, Cmd.Whip), new InputRecord(1300, slot, (byte)(Cmd.Whip | Cmd.Start)), new InputRecord(1400, o1, Cmd.Whip) };
            var ev = ChallengeEvaluator.Evaluate(new ChallengeConditions { MaxPlace = 3, MaxWhips = 3, MaxTimeMs = 100000 }, cfg, slot, inputs, res);
            Assert.True(ev.Finished);
            Assert.Equal(2, ev.Place);
            Assert.Equal(89280, ev.TimeMs);
            Assert.Equal(2, ev.Whips);
            Assert.Equal("senko", ev.Style);
            Assert.True(ev.Cleared);
            Assert.Equal(new[] { "finish", "place", "whips", "time" }, ev.Checks.Select(c => c.Kind).ToArray());
            // a DNF fails every challenge
            res.FinishTicks[1] = -1;
            var dnf = ChallengeEvaluator.Evaluate(new ChallengeConditions { MaxWhips = 3 }, cfg, slot, inputs, res);
            Assert.False(dnf.Finished);
            Assert.False(dnf.Cleared);
            Assert.Null(dnf.TimeMs);
        }

        [Fact]
        public void HudStateTracksTheWhipConditionLive()
        {
            var (cfg, slot) = Load("wm_nowhip");
            var run = new ChallengeRun(cfg, slot, new ChallengeConditions { MaxWhips = 0, MaxPlace = 5 });
            var race = run.Race;
            while (race.Sim.Tick <= race.Sim.P.GateOpenTick) { if (race.Sim.Tick == race.Sim.P.GateOpenTick) race.Input(Cmd.Start); race.StepOnce(); }
            Assert.Equal(0, run.WhipsUsed);
            Assert.False(run.WhipsBroken);
            for (int i = 0; i < 40; i++) race.StepOnce();
            race.Input(Cmd.Whip);
            race.StepOnce();
            Assert.Equal(1, run.WhipsUsed);
            Assert.True(run.WhipsBroken);
            Assert.Throws<ArgumentException>(() => new ChallengeRun(cfg, (slot + 1) % cfg.Entrants.Count, null));
        }

        // ------------------------------------------------------------------------------------------- client API
        private readonly FakeHttp _http = new FakeHttp();
        private ApiClient Api()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            return new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        // produced by the real server (WeeklyChallengeService) after one verified clear of wa_nige
        internal const string View = @"{""enabled"":true,""weekId"":""2026-11-02"",""startsAt"":1793545200000,""endsAt"":1794150000000,""serverNow"":1793847600000,""challenges"":[{""id"":""wa_nige"",""title"":""逃げ切りの一閃"",""trackId"":""aoba_turf_1600"",""surface"":""turf"",""distanceM"":1600,""going"":""good"",""night"":false,""cpuCount"":7,""cpuLevel"":3,""cpuStatPermille"":1000,""conditions"":{""style"":""nige"",""maxPlace"":1},""labels"":[{""kind"":""style"",""text"":""逃げの馬で出走""},{""kind"":""place"",""text"":""1着でゴール""}],""reward"":{""freeCoins"":10},""loan"":{""templateId"":""t_hinode"",""name"":""ヒノデエクスプレス"",""style"":""nige"",""statTotal"":3200},""progress"":{""cleared"":true,""clearedAt"":1793847600000,""attempts"":1,""bestPlace"":1,""bestTimeMs"":92009}},{""id"":""wa_whip3"",""title"":""ムチは3発まで"",""trackId"":""kirameki_turf_2000"",""surface"":""turf"",""distanceM"":2000,""going"":""good"",""night"":false,""cpuCount"":7,""cpuLevel"":3,""cpuStatPermille"":1000,""conditions"":{""maxWhips"":3,""maxPlace"":3},""labels"":[{""kind"":""place"",""text"":""3着以内でゴール""},{""kind"":""whips"",""text"":""ムチ3回以内""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]},""loan"":{""templateId"":""t_natsu"",""name"":""ナツノアラシ"",""style"":""senko"",""statTotal"":3200},""progress"":{""cleared"":false,""clearedAt"":null,""attempts"":0,""bestPlace"":null,""bestTimeMs"":null}},{""id"":""wa_rain"",""title"":""雨の重馬場"",""trackId"":""kirameki_turf_2000"",""surface"":""turf"",""distanceM"":2000,""going"":""soft"",""night"":false,""cpuCount"":5,""cpuLevel"":2,""cpuStatPermille"":1000,""conditions"":{""maxTimeMs"":94000},""labels"":[{""kind"":""time"",""text"":""1:34.0以内で完走""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]},""loan"":{""templateId"":""t_minamo"",""name"":""ミナモノリズム"",""style"":""oikomi"",""statTotal"":3200},""progress"":{""cleared"":false,""clearedAt"":null,""attempts"":0,""bestPlace"":null,""bestTimeMs"":null}}],""clearedCount"":1,""badge"":{""id"":""wch_badge_aoba"",""name"":""青葉の一閃章"",""earned"":false,""earnedAt"":null},""startsLeftToday"":29,""next"":{""weekId"":""2026-11-09"",""startsAt"":1794150000000,""badge"":{""id"":""wch_badge_minato"",""name"":""みなとの夜章""},""challenges"":[{""id"":""wm_night"",""title"":""ナイターの先行策"",""trackId"":""minato_dirt_1800"",""surface"":""dirt"",""distanceM"":1800,""going"":""fast"",""night"":true,""cpuCount"":7,""cpuLevel"":3,""cpuStatPermille"":1000,""conditions"":{""style"":""senko"",""maxPlace"":2},""labels"":[{""kind"":""style"",""text"":""先行の馬で出走""},{""kind"":""place"",""text"":""2着以内でゴール""}],""reward"":{""freeCoins"":10},""loan"":{""templateId"":""t_dorobune"",""name"":""ドロブネ"",""style"":""senko"",""statTotal"":3200}}]},""badges"":[],""badgeCount"":0,""rules"":{""statCap"":3200,""normalized"":true,""skills"":false,""loanAtCap"":true,""paidBoosts"":false,""rewardOncePerWeek"":true}}";
        internal const string Start = @"{""sessionId"":""w9qhl49w1guq21yw99o3"",""weekId"":""2026-11-02"",""challengeId"":""wa_nige"",""playerSlot"":1,""config"":null,""expiresAt"":1793848500000,""startsLeftToday"":29,""challenge"":{""id"":""wa_nige"",""title"":""逃げ切りの一閃"",""trackId"":""aoba_turf_1600"",""surface"":""turf"",""distanceM"":1600,""going"":""good"",""night"":false,""cpuCount"":7,""cpuLevel"":3,""cpuStatPermille"":1000,""conditions"":{""style"":""nige"",""maxPlace"":1},""labels"":[{""kind"":""style"",""text"":""逃げの馬で出走""},{""kind"":""place"",""text"":""1着でゴール""}],""reward"":{""freeCoins"":10},""loan"":{""templateId"":""t_hinode"",""name"":""ヒノデエクスプレス"",""style"":""nige"",""statTotal"":3200}},""token"":""tok""}";
        internal const string Submit = @"{""sessionId"":""w9qhl49w1guq21yw99o3"",""weekId"":""2026-11-02"",""challengeId"":""wa_nige"",""resultHash"":""aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"",""evaluation"":{""finished"":true,""place"":1,""timeMs"":92009,""whips"":1,""style"":""nige"",""cleared"":true,""checks"":[{""kind"":""finish"",""target"":null,""actual"":1,""ok"":true},{""kind"":""place"",""target"":1,""actual"":1,""ok"":true},{""kind"":""style"",""target"":""nige"",""actual"":""nige"",""ok"":true}]},""cleared"":true,""firstClear"":true,""reward"":{""freeCoins"":10},""clearedCount"":1,""badge"":{""id"":""wch_badge_aoba"",""name"":""青葉の一閃章"",""earned"":false,""newlyEarned"":false},""credited"":true}";

        [Fact]
        public async Task ViewParsesChallengesProgressBadgePreviewAndRules()
        {
            var api = Api();
            _http.Reply(200, View);
            var v = await api.GetWeeklyChallengesAsync();
            Assert.Equal("/v1/challenges/weekly", _http.Requests[0].Path);
            Assert.True(v.Enabled);
            Assert.Equal(3, v.Challenges.Count);
            var n = v.Challenge("wa_nige");
            Assert.Equal("nige", n.Conditions.Style);
            Assert.Equal(1, n.Conditions.MaxPlace);
            Assert.Null(n.Conditions.MaxWhips);
            Assert.Equal("逃げの馬で出走", n.Labels[0].Text);
            Assert.Equal(10, n.Reward.FreeCoins);
            Assert.Equal(3200, n.Loan.StatTotal);
            Assert.True(n.Progress.Cleared);
            Assert.Equal(92009, n.Progress.BestTimeMs);
            Assert.Equal("soft", v.Challenge("wa_rain").Going);
            Assert.Equal("breeding_material", v.Challenge("wa_whip3").Reward.Items[0].ItemId);
            Assert.Equal(1, v.ClearedCount);
            Assert.False(v.Badge.Earned);
            Assert.Equal("2026-11-09", v.Next.WeekId);
            Assert.Null(v.Next.Challenges[0].Progress);
            Assert.True(v.Next.Challenges[0].Night);
            Assert.False(v.Rules.Skills);
            Assert.False(v.Rules.PaidBoosts);
            Assert.Equal(4, v.DaysLeft);
        }

        [Fact]
        public async Task StartIsKeyedAndSubmitSendsOnlyInputsAndTheEchoedConfig()
        {
            var api = Api();
            var start = JsonNode.Parse(Start);
            start.Set("config", JsonNode.Parse(File.ReadAllText(Golden("wa_nige"))));
            var (cfg, slot) = Load("wa_nige");
            start.Set("playerSlot", slot);
            _http.Reply(503, "{\"error\":{\"code\":\"INTERNAL\"}}").Reply(200, start.ToString());
            var s = await api.StartWeeklyChallengeAsync("wa_nige", loan: true);
            Assert.Equal(2, _http.Requests.Count);
            Assert.Equal("/v1/challenges/weekly/wa_nige/start", _http.Requests[1].Path);
            Assert.Equal(_http.Requests[0].Headers["idempotency-key"], _http.Requests[1].Headers["idempotency-key"]);
            Assert.Equal("{\"loan\":true}", _http.Requests[1].Body);
            Assert.Equal(RaceMode.Challenge, s.Config.Mode);
            Assert.Equal(slot, s.PlayerSlot);
            Assert.Equal("nige", s.Challenge.Conditions.Style);
            await Assert.ThrowsAsync<ArgumentException>(() => api.StartWeeklyChallengeAsync("wa_nige", "h1", true));

            var run = new ChallengeRun(s);
            var race = run.Race;
            while (!race.IsFinished) { if (race.Sim.Tick == race.Sim.P.GateOpenTick) race.Input(Cmd.Start); race.StepOnce(); }
            _http.Reply(200, Submit);
            var r = await api.SubmitWeeklyChallengeAsync(s, run);
            var req = _http.Requests[2];
            Assert.Equal("/v1/challenges/weekly/submit", req.Path);
            var body = JsonNode.Parse(req.Body);
            Assert.Equal(s.SessionId, body.Get("sessionId").AsString());
            Assert.Equal(race.ResultHash, body.Get("resultHash").AsString());
            Assert.Equal(race.RecordedInputs.Count, body.Get("inputs").Count);
            Assert.Equal(slot, body.Get("inputs")[0][1].AsInt());
            Assert.True(body.Has("config"));
            Assert.False(body.Has("cleared")); // the client never claims a verdict
            Assert.True(r.Cleared);
            Assert.True(r.FirstClear);
            Assert.Equal(10, r.Reward.FreeCoins);
            Assert.Equal(1, r.Evaluation.Place);
            Assert.Equal("1", r.Evaluation.Check("place").Actual);
            Assert.False(r.Badge.NewlyEarned);
        }

        [Fact]
        public async Task ChallengeErrorsMapToTypedExceptions()
        {
            var api = Api();
            foreach (var w in new[] { "CHALLENGE_LIMIT_REACHED", "CHALLENGE_HORSE_INELIGIBLE", "CHALLENGE_SESSION_EXPIRED", "CHALLENGE_SESSION_USED", "CHALLENGE_RESULT_MISMATCH" })
                Assert.Contains(w, ApiErrorCodes.WireCodes);
            _http.Reply(409, "{\"error\":{\"code\":\"CHALLENGE_HORSE_INELIGIBLE\"}}");
            var e = await Assert.ThrowsAsync<ConflictException>(() => api.StartWeeklyChallengeAsync("wa_nige", horseId: "h1"));
            Assert.Equal(ApiErrorCode.ChallengeHorseIneligible, e.Code);
        }
    }
}
