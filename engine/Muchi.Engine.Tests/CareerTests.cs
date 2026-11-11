using System.Linq;
using Muchi.Client;
using Muchi.Net;
using Muchi.Verifier;
using Xunit.Abstractions;

namespace Muchi.Engine.Tests
{
    /// <summary>
    /// 騎手の道 (REQ-CAREER-*, protocol §66): every career race the server issues (contracts/career-configs.sample.json, built by
    /// startCareerRace with the partner horse) runs on the device in CareerRun, verifies with the same hash, and the device's
    /// verdict per objective equals the one computed from the verifier output; the client API speaks the server's shapes.
    /// </summary>
    public class CareerTests
    {
        private readonly ITestOutputHelper _out;
        public CareerTests(ITestOutputHelper output) { _out = output; }

        private static List<(string id, int slot, RaceConfig cfg, List<ChallengeConditions> objectives)> Sample()
        {
            var root = JsonNode.Parse(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "contracts", "career-configs.sample.json")));
            var list = new List<(string, int, RaceConfig, List<ChallengeConditions>)>();
            var races = root.Get("races");
            for (int i = 0; i < races.Count; i++)
            {
                var r = races[i];
                var obs = new List<ChallengeConditions>();
                var o = r.Get("objectives");
                for (int j = 0; j < o.Count; j++)
                    obs.Add(new ChallengeConditions
                    {
                        MaxPlace = o[j].Has("maxPlace") ? o[j].Get("maxPlace").AsInt() : (int?)null,
                        MaxWhips = o[j].Has("maxWhips") ? o[j].Get("maxWhips").AsInt() : (int?)null,
                        MaxTimeMs = o[j].Has("maxTimeMs") ? o[j].Get("maxTimeMs").AsLong() : (long?)null,
                    });
                list.Add((r.Get("raceId").AsString(), r.Get("playerSlot").AsInt(), ProtocolCodec.ParseConfig(r.Get("config")), obs));
            }
            return list;
        }

        /// <summary>A plain rider: START on the gate, rein 1200 → 700 m out, up to <paramref name="whips"/> spaced whips from 400 m out.</summary>
        private static CareerRun Ride(RaceConfig cfg, int slot, List<ChallengeConditions> obs, int whips)
        {
            var run = new CareerRun(cfg, slot, obs);
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

        [Fact]
        public void EveryIssuedCareerRaceRunsVerifiesAndJudgesEveryStarTheSameOnBothSides()
        {
            var sample = Sample();
            Assert.Equal(17, sample.Count);
            int clears = 0;
            foreach (var (id, slot, cfg, obs) in sample)
            {
                Assert.Equal(RaceMode.Challenge, cfg.Mode);
                Assert.True(CareerRun.IsCareer(cfg), id);
                Assert.Equal(EntrantKind.Human, cfg.Entrants[slot].Kind);
                foreach (var e in cfg.Entrants) Assert.Null(e.Horse.Skill); // no unique skills in the career
                var run = Ride(cfg, slot, obs, 3);
                Assert.All(run.Race.RecordedInputs, r => Assert.Equal(slot, r.Slot));
                var (status, body) = VerifyService.Verify(ProtocolCodec.ReplayLogToJson(run.Log()).ToString());
                Assert.Equal(200, status);
                var v = JsonNode.Parse(body);
                Assert.Equal(run.Race.ResultHash, v.Get("resultHash").AsString());
                var res = new RaceResult
                {
                    Order = Enumerable.Range(0, v.Get("order").Count).Select(i => v.Get("order")[i].AsInt()).ToArray(),
                    FinishTicks = Enumerable.Range(0, v.Get("finishTicks").Count).Select(i => v.Get("finishTicks")[i].AsInt()).ToArray(),
                    FinishFracOrDistanceRaw = Enumerable.Range(0, v.Get("finishFracs").Count).Select(i => v.Get("finishFracs")[i].AsLong()).ToArray(),
                };
                var dev = run.Evaluate();
                var stars = new List<int>();
                for (int k = 0; k < obs.Count; k++)
                {
                    var srv = ChallengeEvaluator.Evaluate(obs[k], cfg, slot, run.Race.RecordedInputs, res);
                    Assert.Equal(srv.Place, dev[k].Place);
                    Assert.Equal(srv.TimeMs, dev[k].TimeMs);
                    Assert.Equal(srv.Whips, dev[k].Whips);
                    Assert.Equal(srv.Cleared, dev[k].Cleared);
                    if (srv.Cleared && (k == 0 || stars.Contains(1))) stars.Add(k + 1);
                }
                Assert.Equal(stars.ToArray(), run.StarsNow());
                if (stars.Contains(1)) clears++;
                _out.WriteLine($"{id}: place {dev[0].Place}/{cfg.Entrants.Count} time {dev[0].TimeMs} whips {dev[0].Whips} stars [{string.Join(",", stars)}]");
            }
            // the opening race teaches the basics: a plain ride on the partner clears it (balance-targets 4.20)
            var first = sample[0];
            Assert.Contains(1, Ride(first.cfg, first.slot, first.objectives, 3).StarsNow());
            _out.WriteLine($"plain partner ride clears {clears}/{sample.Count}");
        }

        [Fact]
        public void AStarNeedsTheClearAndTheLabelSaysCareer()
        {
            var (id, slot, cfg, obs) = Sample()[0];
            // a lazy ride (never pressing START, no whips): the whip star alone would hold, but without the clear no star counts
            var run = new CareerRun(cfg, slot, new List<ChallengeConditions> { new ChallengeConditions { MaxPlace = 1 }, new ChallengeConditions { MaxWhips = 0 } });
            while (!run.Race.IsFinished) run.Race.StepOnce();
            var ev = run.Evaluate();
            if (!ev[0].Cleared) { Assert.True(ev[1].Cleared); Assert.Empty(run.StarsNow()); }
            Assert.Throws<ArgumentException>(() => new CareerRun(cfg, slot, new List<ChallengeConditions>()));
            Assert.Throws<ArgumentException>(() => new CareerRun(cfg, slot, Enumerable.Repeat(new ChallengeConditions(), 4).ToList()));
            Assert.False(CareerRun.IsCareer(null));
            Assert.Equal("騎手の道", CareerRun.ModeLabel);
            // the same race as another mode gives the same result: the mode is a label (no engine change for the career)
            var a = RaceReplay.Run(cfg, new List<InputRecord> { new InputRecord(cfg.Ruleset.GateOpenTick, slot, Cmd.Start) });
            var json = ProtocolCodec.ConfigToJson(cfg);
            json.Set("mode", "friend");
            var b = RaceReplay.Run(ProtocolCodec.ParseConfig(json), new List<InputRecord> { new InputRecord(cfg.Ruleset.GateOpenTick, slot, Cmd.Start) });
            Assert.Equal(a.Result.Hash, b.Result.Hash);
        }

        // ------------------------------------------------------------------------------------------- client API
        private readonly FakeHttp _http = new FakeHttp();
        private ApiClient Api()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            return new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        // produced by the real server (CareerService) after one verified 3rd place with one whip on c1_debut (first two chapters)
        internal const string View = @"{""enabled"":true,""version"":1,""chapters"":[{""id"":""c1"",""art"":""dawn"",""title"":""はじめての一閃"",""subtitle"":""見習い騎手、最初の三戦"",""statCap"":2800,""unlocked"":true,""cleared"":false,""stars"":2,""maxStars"":9,""clearedRaces"":1,""races"":[{""id"":""c1_debut"",""chapterId"":""c1"",""title"":""デビュー戦"",""story"":{""before"":""厩舎の朝は早い。相棒の首をなでて、ゲートへ向かう。まずは最後まで走り切ろう。"",""after"":""鞍を下ろすと、調教師がうなずいた。「悪くない。次は直線の長いコースだ」""},""trackId"":""aoba_turf_1600"",""surface"":""turf"",""distanceM"":1600,""going"":""good"",""night"":false,""fieldSize"":6,""cpuCount"":5,""cpuLevel"":1,""cpuStatPermille"":800,""cpuStyles"":null,""statCap"":2800,""objectives"":[{""star"":1,""objective"":{""maxPlace"":3},""labels"":[{""kind"":""place"",""text"":""3着以内でゴール""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}},{""star"":2,""objective"":{""maxPlace"":1},""labels"":[{""kind"":""place"",""text"":""1着でゴール""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}},{""star"":3,""objective"":{""maxPlace"":3,""maxWhips"":3},""labels"":[{""kind"":""place"",""text"":""3着以内でゴール""},{""kind"":""whips"",""text"":""ムチ3回以内""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}}],""progress"":{""unlocked"":true,""cleared"":true,""clearedAt"":1793847600000,""stars"":[1,3],""attempts"":1,""bestPlace"":3,""bestTimeMs"":93000,""rewarded"":{""clear"":true,""star2"":false,""star3"":true}}},{""id"":""c1_straight"",""chapterId"":""c1"",""title"":""長い直線"",""story"":{""before"":""直線が長いぶん、ムチを入れる時間もある。焦らず、光るまで待つ。"",""after"":""最後の一完歩まで脚が残っていた。待てば、馬は応えてくれる。""},""trackId"":""kirameki_turf_2000"",""surface"":""turf"",""distanceM"":2000,""going"":""good"",""night"":false,""fieldSize"":6,""cpuCount"":5,""cpuLevel"":1,""cpuStatPermille"":850,""cpuStyles"":null,""statCap"":2800,""objectives"":[{""star"":1,""objective"":{""maxPlace"":3},""labels"":[{""kind"":""place"",""text"":""3着以内でゴール""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}},{""star"":2,""objective"":{""maxPlace"":1},""labels"":[{""kind"":""place"",""text"":""1着でゴール""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}},{""star"":3,""objective"":{""maxPlace"":2,""maxWhips"":2},""labels"":[{""kind"":""place"",""text"":""2着以内でゴール""},{""kind"":""whips"",""text"":""ムチ2回以内""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}}],""progress"":{""unlocked"":true,""cleared"":false,""clearedAt"":null,""stars"":[],""attempts"":0,""bestPlace"":null,""bestTimeMs"":null,""rewarded"":{""clear"":false,""star2"":false,""star3"":false}}},{""id"":""c1_firstwin"",""chapterId"":""c1"",""title"":""初勝利をつかめ"",""story"":{""before"":""今日は勝ちにいく。スタートを決めて、直線で一閃。"",""after"":""初めての勝利。相棒が鼻を鳴らした。騎手の道は、ここから始まる。""},""trackId"":""kirameki_turf_2000"",""surface"":""turf"",""distanceM"":2000,""going"":""good"",""night"":false,""fieldSize"":7,""cpuCount"":6,""cpuLevel"":1,""cpuStatPermille"":850,""cpuStyles"":null,""statCap"":2800,""objectives"":[{""star"":1,""objective"":{""maxPlace"":1},""labels"":[{""kind"":""place"",""text"":""1着でゴール""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}},{""star"":2,""objective"":{""maxPlace"":1,""maxWhips"":4},""labels"":[{""kind"":""place"",""text"":""1着でゴール""},{""kind"":""whips"",""text"":""ムチ4回以内""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}},{""star"":3,""objective"":{""maxPlace"":1,""maxWhips"":2},""labels"":[{""kind"":""place"",""text"":""1着でゴール""},{""kind"":""whips"",""text"":""ムチ2回以内""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}}],""progress"":{""unlocked"":false,""cleared"":false,""clearedAt"":null,""stars"":[],""attempts"":0,""bestPlace"":null,""bestTimeMs"":null,""rewarded"":{""clear"":false,""star2"":false,""star3"":false}}}]},{""id"":""c2"",""art"":""rain"",""title"":""雨の日の手綱"",""subtitle"":""重い馬場で、脚をためる"",""statCap"":2800,""unlocked"":false,""cleared"":false,""stars"":0,""maxStars"":9,""clearedRaces"":0,""races"":[{""id"":""c2_drizzle"",""chapterId"":""c2"",""title"":""小雨の青葉"",""story"":{""before"":""芝が水を含んでいる。いつもより早く疲れる。手綱を引いて、息を入れよう。"",""after"":""息を入れた分だけ、最後に伸びた。重い馬場では手綱がものを言う。""},""trackId"":""aoba_turf_1600"",""surface"":""turf"",""distanceM"":1600,""going"":""yielding"",""night"":false,""fieldSize"":7,""cpuCount"":6,""cpuLevel"":2,""cpuStatPermille"":950,""cpuStyles"":null,""statCap"":2800,""objectives"":[{""star"":1,""objective"":{""maxPlace"":3},""labels"":[{""kind"":""place"",""text"":""3着以内でゴール""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}},{""star"":2,""objective"":{""maxPlace"":2},""labels"":[{""kind"":""place"",""text"":""2着以内でゴール""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}},{""star"":3,""objective"":{""maxPlace"":1},""labels"":[{""kind"":""place"",""text"":""1着でゴール""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}}],""progress"":{""unlocked"":false,""cleared"":false,""clearedAt"":null,""stars"":[],""attempts"":0,""bestPlace"":null,""bestTimeMs"":null,""rewarded"":{""clear"":false,""star2"":false,""star3"":false}}},{""id"":""c2_frontrunners"",""chapterId"":""c2"",""title"":""前が速い"",""story"":{""before"":""今日の相手は前へ行きたい馬ばかり。無理に追いかけず、後ろで構える。"",""after"":""前の馬たちは重い馬場で脚を使い切った。待った者が笑う日もある。""},""trackId"":""kirameki_turf_2000"",""surface"":""turf"",""distanceM"":2000,""going"":""soft"",""night"":false,""fieldSize"":7,""cpuCount"":6,""cpuLevel"":2,""cpuStatPermille"":950,""cpuStyles"":[""nige"",""senko""],""statCap"":2800,""objectives"":[{""star"":1,""objective"":{""maxPlace"":3},""labels"":[{""kind"":""place"",""text"":""3着以内でゴール""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}},{""star"":2,""objective"":{""maxPlace"":1},""labels"":[{""kind"":""place"",""text"":""1着でゴール""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}},{""star"":3,""objective"":{""maxPlace"":3,""maxWhips"":3},""labels"":[{""kind"":""place"",""text"":""3着以内でゴール""},{""kind"":""whips"",""text"":""ムチ3回以内""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}}],""progress"":{""unlocked"":false,""cleared"":false,""clearedAt"":null,""stars"":[],""attempts"":0,""bestPlace"":null,""bestTimeMs"":null,""rewarded"":{""clear"":false,""star2"":false,""star3"":false}}},{""id"":""c2_storm"",""chapterId"":""c2"",""title"":""嵐のみなと"",""story"":{""before"":""2400mの重馬場。最後まで脚を残せるかは、道中の我慢しだい。"",""after"":""ずぶ濡れの勝負服で引き上げる。雨の日の乗り方が、少しわかった。""},""trackId"":""minato_turf_2400"",""surface"":""turf"",""distanceM"":2400,""going"":""soft"",""night"":false,""fieldSize"":8,""cpuCount"":7,""cpuLevel"":2,""cpuStatPermille"":950,""cpuStyles"":null,""statCap"":2800,""objectives"":[{""star"":1,""objective"":{""maxPlace"":2},""labels"":[{""kind"":""place"",""text"":""2着以内でゴール""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}},{""star"":2,""objective"":{""maxPlace"":1},""labels"":[{""kind"":""place"",""text"":""1着でゴール""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}},{""star"":3,""objective"":{""maxPlace"":1,""maxWhips"":3},""labels"":[{""kind"":""place"",""text"":""1着でゴール""},{""kind"":""whips"",""text"":""ムチ3回以内""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}}],""progress"":{""unlocked"":false,""cleared"":false,""clearedAt"":null,""stars"":[],""attempts"":0,""bestPlace"":null,""bestTimeMs"":null,""rewarded"":{""clear"":false,""star2"":false,""star3"":false}}}]}],""totalStars"":2,""maxStars"":51,""clearedRaces"":1,""totalRaces"":17,""nextRaceId"":""c1_straight"",""startsLeftToday"":199,""rules"":{""skills"":false,""normalized"":true,""ranked"":false,""leaderboards"":false,""missions"":false,""energy"":false,""paidContinue"":false,""paidSkip"":false,""rewardOnce"":true}}";
        internal const string Start = @"{""sessionId"":""k9qhl49w1guq21yw99o3"",""raceId"":""c1_debut"",""chapterId"":""c1"",""playerSlot"":0,""config"":null,""expiresAt"":1793848500000,""startsLeftToday"":199,""race"":{""id"":""c1_debut"",""chapterId"":""c1"",""title"":""デビュー戦"",""story"":{""before"":""厩舎の朝は早い。相棒の首をなでて、ゲートへ向かう。まずは最後まで走り切ろう。"",""after"":""鞍を下ろすと、調教師がうなずいた。「悪くない。次は直線の長いコースだ」""},""trackId"":""aoba_turf_1600"",""surface"":""turf"",""distanceM"":1600,""going"":""good"",""night"":false,""fieldSize"":6,""cpuCount"":5,""cpuLevel"":1,""cpuStatPermille"":800,""cpuStyles"":null,""statCap"":2800,""objectives"":[{""star"":1,""objective"":{""maxPlace"":3},""labels"":[{""kind"":""place"",""text"":""3着以内でゴール""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}},{""star"":2,""objective"":{""maxPlace"":1},""labels"":[{""kind"":""place"",""text"":""1着でゴール""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}},{""star"":3,""objective"":{""maxPlace"":3,""maxWhips"":3},""labels"":[{""kind"":""place"",""text"":""3着以内でゴール""},{""kind"":""whips"",""text"":""ムチ3回以内""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}}]},""conditions"":{""maxPlace"":3},""token"":""tok""}";
        internal const string Submit = @"{""sessionId"":""k9qhl49w1guq21yw99o3"",""raceId"":""c1_debut"",""chapterId"":""c1"",""resultHash"":""aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"",""evaluation"":{""finished"":true,""place"":3,""timeMs"":93000,""whips"":1,""style"":""sashi"",""cleared"":true,""checks"":[{""kind"":""finish"",""target"":null,""actual"":1,""ok"":true},{""kind"":""place"",""target"":3,""actual"":3,""ok"":true}]},""cleared"":true,""firstClear"":true,""objectives"":[{""star"":1,""ok"":true,""newly"":true,""evaluation"":{""finished"":true,""place"":3,""timeMs"":93000,""whips"":1,""style"":""sashi"",""cleared"":true,""checks"":[{""kind"":""finish"",""target"":null,""actual"":1,""ok"":true},{""kind"":""place"",""target"":3,""actual"":3,""ok"":true}]}},{""star"":2,""ok"":false,""newly"":false,""evaluation"":{""finished"":true,""place"":3,""timeMs"":93000,""whips"":1,""style"":""sashi"",""cleared"":false,""checks"":[{""kind"":""finish"",""target"":null,""actual"":1,""ok"":true},{""kind"":""place"",""target"":1,""actual"":3,""ok"":false}]}},{""star"":3,""ok"":true,""newly"":true,""evaluation"":{""finished"":true,""place"":3,""timeMs"":93000,""whips"":1,""style"":""sashi"",""cleared"":true,""checks"":[{""kind"":""finish"",""target"":null,""actual"":1,""ok"":true},{""kind"":""place"",""target"":3,""actual"":3,""ok"":true},{""kind"":""whips"",""target"":3,""actual"":1,""ok"":true}]}}],""stars"":[1,3],""newStars"":[1,3],""rewards"":[{""kind"":""clear"",""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}},{""kind"":""star3"",""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}}],""unlockedRaceId"":""c1_straight"",""chapterCleared"":false,""totalStars"":2}";

        [Fact]
        public async Task ViewParsesChaptersRacesObjectivesAndProgress()
        {
            var api = Api();
            _http.Reply(200, View);
            var v = await api.GetCareerAsync();
            Assert.Equal("/v1/career", _http.Requests[0].Path);
            Assert.True(v.Enabled);
            Assert.Equal(2, v.Chapters.Count);
            var c1 = v.Chapter("c1");
            Assert.Equal("dawn", c1.Art);
            Assert.Equal(2800, c1.StatCap);
            Assert.True(c1.Unlocked);
            Assert.Equal(9, c1.MaxStars);
            var r = v.Race("c1_debut");
            Assert.Equal("デビュー戦", r.Title);
            Assert.False(string.IsNullOrEmpty(r.StoryBefore));
            Assert.Equal(6, r.FieldSize);
            Assert.Equal(3, r.MaxStars);
            Assert.Equal(3, r.Clear.Conditions.MaxPlace);
            Assert.Equal("3着以内でゴール・ムチ3回以内", r.Objectives[2].Text);
            Assert.Equal("breeding_material", r.Clear.Reward.Items[0].ItemId);
            Assert.True(r.Progress.Cleared);
            Assert.True(r.Progress.HasStar(1));
            Assert.True(r.Progress.HasStar(3));
            Assert.False(r.Progress.HasStar(2));
            Assert.True(r.Progress.Rewarded.Clear);
            Assert.Equal("c1_straight", v.NextRaceId);
            Assert.Equal("c1_straight", v.NextRace.Id);
            Assert.True(v.NextRace.Progress.Unlocked);
            Assert.False(v.Race("c1_firstwin").Progress.Unlocked);
            Assert.Equal(new List<string> { "nige", "senko" }, v.Race("c2_frontrunners").CpuStyles);
            Assert.False(v.Rules.Energy);
            Assert.False(v.Rules.PaidContinue);
            Assert.True(v.Rules.RewardOnce);
        }

        [Fact]
        public async Task StartIsKeyedAndSubmitSendsOnlyInputsAndTheEchoedConfig()
        {
            var api = Api();
            var (id, slot, cfg, obs) = Sample()[0];
            var start = JsonNode.Parse(Start);
            start.Set("config", ProtocolCodec.ConfigToJson(cfg));
            start.Set("playerSlot", slot);
            _http.Reply(503, "{\"error\":{\"code\":\"INTERNAL\"}}").Reply(200, start.ToString());
            var s = await api.StartCareerRaceAsync("c1_debut", "h1");
            Assert.Equal(2, _http.Requests.Count);
            Assert.Equal("/v1/career/races/c1_debut/start", _http.Requests[1].Path);
            Assert.Equal(_http.Requests[0].Headers["idempotency-key"], _http.Requests[1].Headers["idempotency-key"]);
            Assert.Equal("{\"horseId\":\"h1\"}", _http.Requests[1].Body);
            Assert.Equal(RaceMode.Challenge, s.Config.Mode);
            Assert.Equal(3, s.Conditions.MaxPlace);
            Assert.Equal(3, s.Race.Objectives.Count);
            await Assert.ThrowsAsync<ArgumentException>(() => api.StartCareerRaceAsync("c1_debut", ""));

            var run = new CareerRun(s);
            Assert.Equal(3, run.Objectives.Count);
            var race = run.Race;
            while (!race.IsFinished) { if (race.Sim.Tick == race.Sim.P.GateOpenTick) race.Input(Cmd.Start); race.StepOnce(); }
            _http.Reply(200, Submit);
            var r = await api.SubmitCareerRaceAsync(s, run);
            var req = _http.Requests[2];
            Assert.Equal("/v1/career/submit", req.Path);
            var body = JsonNode.Parse(req.Body);
            Assert.Equal(s.SessionId, body.Get("sessionId").AsString());
            Assert.Equal(race.ResultHash, body.Get("resultHash").AsString());
            Assert.Equal(race.RecordedInputs.Count, body.Get("inputs").Count);
            Assert.True(body.Has("config"));
            Assert.False(body.Has("stars")); // the client never claims a verdict
            Assert.True(r.Cleared);
            Assert.True(r.FirstClear);
            Assert.Equal(new[] { 1, 3 }, r.Stars);
            Assert.Equal(new[] { 1, 3 }, r.NewStars);
            Assert.Equal(new[] { "clear", "star3" }, r.Rewards.Select(g => g.Kind).ToArray());
            Assert.Equal("c1_straight", r.UnlockedRaceId);
            Assert.False(r.ChapterCleared);
            Assert.Equal(3, r.Evaluation.Place);
            Assert.True(r.Objectives[2].Newly);
        }

        [Fact]
        public async Task CareerErrorsMapToTypedExceptions()
        {
            var api = Api();
            foreach (var w in new[] { "CAREER_LOCKED", "CAREER_LIMIT_REACHED", "CAREER_SESSION_EXPIRED", "CAREER_SESSION_USED", "CAREER_RESULT_MISMATCH" })
                Assert.Contains(w, ApiErrorCodes.WireCodes);
            _http.Reply(409, "{\"error\":{\"code\":\"CAREER_LOCKED\"}}");
            var e = await Assert.ThrowsAsync<ConflictException>(() => api.StartCareerRaceAsync("c1_firstwin", "h1"));
            Assert.Equal(ApiErrorCode.CareerLocked, e.Code);
        }
    }
}
