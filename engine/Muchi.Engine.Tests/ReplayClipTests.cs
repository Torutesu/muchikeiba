using System.Linq;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>
    /// Replay share (REQ-UXS-070, 071): the clip re-simulates the race from config + inputs and shows exactly the states
    /// the live race had, covers the last 200 m (at most 10 s, finish inside), the camera keeps the focus horse in frame,
    /// and the share card carries only place / time / horse / course / skills / watermark.
    /// </summary>
    public class ReplayClipTests
    {
        private static RaceConfig Field(ulong seed = 7, SkillSpec skill = null, int distance = 1600)
        {
            var rs = TestUtil.Ruleset();
            var horses = Enumerable.Range(0, 8).Select(i => TestUtil.H("h" + i, 520 + i * 7, (RunningStyle)(i % 4))).ToList();
            horses[0].Name = "アカツキ";
            horses[0].Speed = horses[0].Burst = horses[0].Stamina = 640; // finishes ahead of the field: the run-out after the line is kept
            horses[0].Skill = skill;
            var cfg = TestUtil.Cfg(TestUtil.CornerTrack(distance), rs, horses, 1, seed);
            cfg.Mode = RaceMode.Ranked;
            cfg.Entrants[0].PlayerId = "player_secret_id";
            return cfg;
        }

        /// <summary>Rides slot 0 (start, spaced whips from 400 m) and records every state of every horse per tick.</summary>
        private static (OfflineRace race, Dictionary<int, HorseState[]> live) Ride(RaceConfig cfg)
        {
            var race = new OfflineRace(cfg, 0);
            var live = new Dictionary<int, HorseState[]>();
            void Snap() { live[race.Sim.Tick] = Enumerable.Range(0, cfg.Entrants.Count).Select(s => race.Sim.GetHorse(s)).ToArray(); }
            Snap();
            int lastWhip = -100;
            while (!race.IsFinished)
            {
                var me = race.Sim.GetHorse(0);
                var left = race.Sim.Track.Distance - me.Distance;
                if (race.Sim.Tick == race.Sim.P.GateOpenTick) race.Input(Cmd.Start);
                if (me.Departed && left <= Fx.FromInt(400) && race.Sim.Tick - lastWhip >= 24) { lastWhip = race.Sim.Tick; race.Input(Cmd.Whip); }
                race.StepOnce();
                Snap();
            }
            return (race, live);
        }

        [Fact]
        public void ClipReproducesTheLiveRaceOverTheLast200m()
        {
            var cfg = Field();
            var (race, live) = Ride(cfg);
            var clip = ReplayClip.Build(cfg, race.AllInputs(), 0, null, null, race.Sim.Result.Hash);
            Assert.Equal(race.Sim.Result.Hash, clip.ResultHash);
            Assert.True(clip.DurationMs <= 10_000 && clip.DurationMs > 5_000, "duration " + clip.DurationMs);
            // every state in the window equals the live race bit for bit
            for (int t = clip.StartTick; t <= clip.EndTick; t++)
                for (int s = 0; s < cfg.Entrants.Count; s++)
                {
                    var a = clip.StatesAt(t)[s]; var b = live[t][s];
                    Assert.True(a.Distance == b.Distance && a.Lane == b.Lane && a.Speed == b.Speed && a.Stamina == b.Stamina && a.Rank == b.Rank && a.FinishTick == b.FinishTick, "tick " + t + " slot " + s);
                }
            // the window: starts at (or after, when capped by 10 s) 200 m left, contains the finish and the run-out
            var first = clip.StatesAt(clip.StartTick)[0];
            double remStart = cfg.Track.DistanceM - TrackGeometry.DistanceM(first.Distance);
            Assert.True(remStart <= 200.01, "starts " + remStart + " m out");
            Assert.True(clip.FinishAtMs > 0 && clip.FinishAtMs <= clip.DurationMs - 1000, "finish at " + clip.FinishAtMs);
            Assert.Equal(race.FinishTimeMs(0), clip.FocusTimeMs);
            Assert.Equal(System.Array.IndexOf(race.Sim.Result.Order, 0) + 1, clip.FocusPlace);
            // frames at 30 fps, time increasing, interpolating between consecutive ticks
            Assert.Equal(clip.DurationMs * 30 / 1000 + 1, clip.FrameCount);
            var frames = clip.Frames().ToList();
            Assert.Equal(clip.FrameCount, frames.Count);
            Assert.True(frames.Zip(frames.Skip(1), (a, b) => b.TimeMs > a.TimeMs && b.FocusRemainingM <= a.FocusRemainingM + 1e-9).All(x => x));
            Assert.Equal(0, frames[^1].FocusRemainingM, 6);
            Assert.Equal(clip.DurationMs, frames[^1].TimeMs);
        }

        [Fact]
        public void LongFinalStretchIsCappedAtTenSecondsAndShortOptionsWork()
        {
            var cfg = Field(11);
            var (race, _) = Ride(cfg);
            var clip = ReplayClip.Build(cfg, race.AllInputs(), 0, new ReplayClipOptions { FinalDistanceM = 400 });
            Assert.True(clip.DurationMs <= 10_000);
            Assert.True(clip.FinishAtMs > 0, "the finish is kept when the start moves later");
            var shortClip = ReplayClip.Build(cfg, race.AllInputs(), 0, new ReplayClipOptions { FinalDistanceM = 50, PostFinishMs = 0 });
            Assert.True(shortClip.DurationMs < 5_000 && shortClip.FinishAtMs <= shortClip.DurationMs);
            Assert.Throws<ArgumentException>(() => ReplayClip.Build(cfg, race.AllInputs(), 0, new ReplayClipOptions { MaxDurationMs = 100 }));
            Assert.Throws<ArgumentException>(() => ReplayClip.Build(cfg, race.AllInputs(), 9));
        }

        [Fact]
        public void ReplayThatDoesNotReproduceTheHashIsRefused()
        {
            var cfg = Field();
            var (race, _) = Ride(cfg);
            Assert.Throws<InvalidOperationException>(() => ReplayClip.Build(cfg, race.AllInputs(), 0, null, null, new string('0', 64)));
            // dropping the inputs is a different race: same check catches it
            Assert.Throws<InvalidOperationException>(() => ReplayClip.Build(cfg, new List<InputRecord>(), 0, null, null, race.Sim.Result.Hash));
        }

        [Fact]
        public void CameraKeysFollowTheFocusHorseIntoTheFinishShot()
        {
            var cfg = Field();
            var (race, _) = Ride(cfg);
            var clip = ReplayClip.Build(cfg, race.AllInputs(), 0);
            var keys = clip.CameraKeys;
            Assert.True(keys.Count >= clip.DurationMs / 250);
            Assert.True(keys.Zip(keys.Skip(1), (a, b) => b.TimeMs > a.TimeMs).All(x => x));
            Assert.Equal(0, keys[0].TimeMs);
            Assert.Equal(clip.DurationMs, keys[^1].TimeMs);
            Assert.Contains(keys, k => k.Shot.Mode == RaceCameraMode.Finish);
            Assert.Contains(keys, k => k.Shot.Mode == RaceCameraMode.FinalStraight);
            foreach (var f in clip.Frames())
                Assert.True(RaceCameraRig.InFrame(f.Camera, clip.PoseOf(f, 0), 1.2), "frame " + f.Index + " " + f.Camera);
        }

        [Fact]
        public void ShareCardCarriesOnlyTheRaceAndTheHorse()
        {
            var skill = new SkillSpec { Id = "sk_r", Name = "ラスト", Trigger = SkillTrigger.Remaining, Value = 320, SpeedPermille = 30, DurationTicks = 100 };
            var cfg = Field(7, skill);
            var (race, _) = Ride(cfg);
            var clip = ReplayClip.Build(cfg, race.AllInputs(), 0);
            var s = Assert.Single(clip.FocusSkills);
            Assert.Equal("ラスト", s.SkillName);
            Assert.InRange(s.RemainingM, 300, 320);
            Assert.Contains(clip.Events, e => e.Type == RaceEventType.Finish && e.Slot == 0);
            var card = ShareCard.Build(clip, "青葉競馬場 芝1600m");
            Assert.Equal("ムチ一閃", card.Watermark);
            Assert.Equal("アカツキ", card.HorseName);
            Assert.Equal(clip.FocusPlace + "着 / 8頭", card.PlaceText);
            Assert.Equal(ShareCard.FormatTime(race.FinishTimeMs(0)), card.TimeText);
            Assert.Equal("ランク戦", card.ModeLabel);
            Assert.Equal("固有スキル「ラスト」 残り" + s.RemainingM + "m", Assert.Single(card.SkillLines));
            Assert.Contains("アカツキ", card.ShareText);
            Assert.Contains("#ムチ一閃", card.ShareText);
            string all = string.Join("|", card.Watermark, card.PlaceText, card.TimeText, card.HorseName, card.CourseName, card.ModeLabel, card.ShareText, string.Join("|", card.SkillLines));
            Assert.DoesNotContain("player_secret_id", all);
            foreach (var e in cfg.Entrants.Skip(1)) Assert.DoesNotContain(e.Horse.Name, all); // rivals are not named
            // default course label from the spec
            Assert.Equal("芝1600m", ShareCard.Build(clip).CourseName);
        }

        [Fact]
        public void TimeAttackCardHasNoPlace()
        {
            var rs = TestUtil.Ruleset();
            var h = TestUtil.H("ta", 600); h.Name = "ハヤテ";
            var cfg = OfflinePresets.TimeAttack(TestUtil.CornerTrack(1600), h, rs, 3);
            cfg.Mode = RaceMode.TimeAttack;
            var race = new OfflineRace(cfg, 0);
            while (!race.IsFinished) { if (race.Sim.Tick == race.Sim.P.GateOpenTick) race.Input(Cmd.Start); race.StepOnce(); }
            var card = ShareCard.Build(ReplayClip.Build(cfg, race.AllInputs(), 0));
            Assert.Equal("完走", card.PlaceText);
            Assert.Equal("タイムアタック", card.ModeLabel);
            Assert.DoesNotContain("着", card.ShareText);
        }

        [Fact]
        public void OnlineClientKeepsTheConfirmedInputsForReplays()
        {
            // the lockstep client logs what it simulated; replaying that log reproduces its race
            var cfg = Field(5);
            var (race, _) = Ride(cfg);
            var t = new CaptureTransport();
            var c = new LockstepClient(t, cfg.RaceId, "tok");
            var start = JsonNode.Obj().Set("t", "start").Set("you", 0).Set("startAtMs", 0L).Set("config", ProtocolCodec.ConfigToJson(cfg));
            c.HandleMessage(start.ToString());
            var ins = JsonNode.Arr();
            foreach (var r in race.AllInputs()) ins.Add(JsonNode.Arr().Add(JsonNode.Num(r.Tick)).Add(JsonNode.Num(r.Slot)).Add(JsonNode.Num(r.Cmd)));
            c.HandleMessage(JsonNode.Obj().Set("t", "b").Set("from", 0).Set("to", cfg.Ruleset.MaxTicks - 1).Set("in", ins).ToString());
            Assert.True(c.Sim.IsFinished);
            Assert.Equal(race.Sim.Result.Hash, c.Sim.Result.Hash);
            Assert.Equal(race.AllInputs().Count, c.ConfirmedInputs.Count);
            Assert.Equal(c.Sim.Result.Hash, ReplayClip.Build(cfg, c.ConfirmedInputs.ToList(), 0).ResultHash);
        }

        private sealed class CaptureTransport : ITransport
        {
            public readonly List<string> Sent = new List<string>();
            public void Send(string message) => Sent.Add(message);
        }
    }
}
