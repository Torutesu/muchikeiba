using Muchi.Client;
using Muchi.Engine;

namespace Muchi.Engine.Tests
{
    /// <summary>HUD race-feel data (docs/planning/06 §6.3): stamina warnings, the whip cue, slipstream, kakari, camera.</summary>
    public class RaceFeelTests
    {
        private static readonly RulesetParams Rs = TestUtil.Ruleset();

        [Fact]
        public void StaminaLevels()
        {
            Assert.Equal(StaminaWarning.None, RaceFeel.StaminaLevel(301, 1));
            Assert.Equal(StaminaWarning.Low, RaceFeel.StaminaLevel(300, 1));
            Assert.Equal(StaminaWarning.Critical, RaceFeel.StaminaLevel(100, 1));
            Assert.Equal(StaminaWarning.Empty, RaceFeel.StaminaLevel(0, 0));
        }

        [Fact]
        public void TutorialWhipCueShowsOnceAtThe300mMarkOnly()
        {
            var feel = new RaceFeelTracker(0);
            var shown = new List<long>();
            var race = TutorialOutcomeTests.Play(new[] { 260, 200 }, 1, 20261105, r =>
            {
                var s = feel.Update(r.Sim);
                if (s.WhipChance) shown.Add(RaceFeel.RemainingMm(r.Sim, r.Sim.GetHorse(0)));
            });
            Assert.Single(feel.Cues, c => c.Kind == RaceFeelCueKind.WhipChance);
            Assert.Equal(RaceFeel.TextWhipChance, feel.Cues.First(c => c.Kind == RaceFeelCueKind.WhipChance).Text);
            Assert.NotEmpty(shown);
            Assert.All(shown, mm => Assert.InRange(mm, 258_000, 300_000)); // from 300 m, off after the first whip — never from the gate
            Assert.True(race.IsFinished);
        }

        [Fact]
        public void WhipCueTimesOutWithoutAWhipAndOpensAtTheSpurtOnLongRaces()
        {
            var feel = new RaceFeelTracker(0);
            var shown = new List<long>();
            TutorialOutcomeTests.Play(new int[0], 1, 20261105, r => { if (feel.Update(r.Sim).WhipChance) shown.Add(RaceFeel.RemainingMm(r.Sim, r.Sim.GetHorse(0))); });
            Assert.InRange(shown.Min(), 200_000, 202_000);
            Assert.InRange(shown.Max(), 298_000, 300_000);

            var sim = new RaceSim(TestUtil.Cfg(TestUtil.CornerTrack(2000), Rs, new[] { TestUtil.H("a"), TestUtil.H("b") }, 1));
            Assert.Equal(400, RaceFeel.WhipChanceStartM(sim)); // min(spurt zone 700 m, 400 m)
        }

        [Fact]
        public void StaminaThresholdsAndEmptyAreRaisedOnceEachInOrder()
        {
            var me = TestUtil.H("me", 500); me.Stamina = 0;
            var cfg = TestUtil.Cfg(TestUtil.CornerTrack(2400), Rs, new[] { me, TestUtil.H("b") }, 1);
            var sim = new RaceSim(cfg);
            var feel = new RaceFeelTracker(0);
            bool blinkSeen = false;
            var cmds = new byte[2];
            while (!sim.IsFinished)
            {
                cmds[0] = sim.Tick == sim.P.GateOpenTick ? Cmd.Start : (byte)0;
                sim.Step(cmds);
                var s = feel.Update(sim);
                blinkSeen |= s.StaminaBlink;
                if (s.Stamina == StaminaWarning.Empty && !sim.GetHorse(0).Finished) Assert.Equal(RaceFeel.TextStaminaEmpty, s.Hint);
            }
            var kinds = feel.Cues.Where(c => c.Kind <= RaceFeelCueKind.StaminaEmpty).Select(c => c.Kind).ToList();
            Assert.Equal(new[] { RaceFeelCueKind.StaminaLow, RaceFeelCueKind.StaminaCritical, RaceFeelCueKind.StaminaEmpty }, kinds);
            Assert.True(blinkSeen);
            Assert.Contains(feel.Cues, c => c.Kind == RaceFeelCueKind.Runaway); // burning too fast before the final stretch
        }

        [Fact]
        public void KakariWarningOnceAndOnlyWhileUnreined()
        {
            var rs = TestUtil.Ruleset(("kakariChancePer100000PerTickAtTemper0", 3000));
            var cfg = TestUtil.Cfg(TestUtil.CornerTrack(2000), rs, new[] { TestUtil.H("me", 500, temper: 0), TestUtil.H("b") }, 1);
            var sim = new RaceSim(cfg);
            var feel = new RaceFeelTracker(0);
            var cmds = new byte[2];
            bool warnedWhileReining = false, warned = false;
            while (!sim.IsFinished)
            {
                var h = sim.GetHorse(0);
                cmds[0] = !h.Departed ? Cmd.Start : h.IsKakari && !h.Reining && sim.Tick % 7 == 0 ? Cmd.ReinPress : !h.IsKakari && h.Reining ? Cmd.ReinRelease : (byte)0;
                sim.Step(cmds);
                var s = feel.Update(sim);
                warned |= s.KakariWarning;
                warnedWhileReining |= s.KakariWarning && sim.GetHorse(0).Reining;
            }
            Assert.True(warned);
            Assert.False(warnedWhileReining);
            Assert.Single(feel.Cues, c => c.Kind == RaceFeelCueKind.Kakari);
            Assert.Equal(RaceFeel.TextKakari, feel.Cues.First(c => c.Kind == RaceFeelCueKind.Kakari).Text);
        }

        [Fact]
        public void SlipstreamFlagMatchesTheEngineDrainSaving()
        {
            // follower right behind a leader in lane 0 vs the same horse alone: drain differs exactly while the flag is on
            var cfg = TestUtil.Cfg(TestUtil.StraightTrack(1200), Rs, new[] { TestUtil.H("lead", 500), TestUtil.H("me", 500) }, 2);
            var sim = new RaceSim(cfg);
            var cmds = new byte[2];
            int flagged = 0;
            while (!sim.IsFinished)
            {
                var me = sim.GetHorse(1);
                cmds[0] = sim.Tick == sim.P.GateOpenTick ? Cmd.Start : (byte)0;
                cmds[1] = sim.Tick == sim.P.GateOpenTick + 6 ? Cmd.Start : me.Departed && me.LaneTarget > 0 && !me.IsChangingLane ? Cmd.LaneIn : (byte)0;
                sim.Step(cmds);
                bool slip = RaceFeel.InSlipstream(sim, 1);
                var prev = sim.GetPreviousHorse(1);
                var cur = sim.GetHorse(1);
                if (slip)
                {
                    flagged++;
                    // engine drain with the slipstream saving applied (same order of operations as RaceSim)
                    long drain = (cur.Speed * cur.Speed).Raw * sim.P.DrainMicroPerSpeedSqPerTick / 1000000 * (1000 - sim.P.SlipstreamSavePermille) / 1000;
                    if (!cur.Reining && cur.Composure >= sim.P.BadComposureThreshold && prev.Stamina.Raw > drain && !cur.Finished)
                        Assert.Equal(prev.Stamina.Raw - drain, cur.Stamina.Raw);
                }
            }
            Assert.True(flagged > 20, "follower drafted for " + flagged + " ticks");
        }

        [Fact]
        public void TrackerCopesWithSeveralTicksPerUpdate()
        {
            var a = new RaceFeelTracker(0);
            var b = new RaceFeelTracker(0);
            TutorialOutcomeTests.Play(new[] { 280, 150 }, 1, 20261105, r => { a.Update(r.Sim); if (r.Sim.Tick % 5 == 0) b.Update(r.Sim); });
            Assert.Equal(a.Cues.Count(c => c.Kind == RaceFeelCueKind.WhipChance), b.Cues.Count(c => c.Kind == RaceFeelCueKind.WhipChance));
            Assert.Equal(a.Cues.Count(c => c.Kind <= RaceFeelCueKind.StaminaEmpty), b.Cues.Count(c => c.Kind <= RaceFeelCueKind.StaminaEmpty));
        }

        [Fact]
        public void MashedWhipHint()
        {
            var feel = new RaceFeelTracker(0);
            bool hint = false;
            TutorialOutcomeTests.Play(new[] { 250, 249, 248 }, 1, 20261105, r => hint |= feel.Update(r.Sim).WhipMashed);
            Assert.True(hint);
            Assert.Single(feel.Cues, c => c.Kind == RaceFeelCueKind.WhipMash);
        }

        // ------------------------------------------------------------------ camera

        [Fact]
        public void CameraKeepsThePartnerInFrameAllRace()
        {
            foreach (var track in new[] { TestUtil.CornerTrack(2000), Muchi.Verifier.SampleRaces.Turf1600(), TestUtil.StraightTrack(400) })
            {
                var cfg = TestUtil.Cfg(track, Rs, new[] { TestUtil.H("me", 520), TestUtil.H("b"), TestUtil.H("c") }, 1);
                foreach (bool left in new[] { true, false })
                {
                    var geo = new TrackGeometry(cfg.Track, left);
                    var rig = new RaceCameraRig(geo, cfg.Track, Rs.LaneWidthMm);
                    var sim = new RaceSim(cfg);
                    var cmds = new byte[3];
                    var modes = new HashSet<RaceCameraMode>();
                    while (!sim.IsFinished)
                    {
                        var h = sim.GetHorse(0);
                        cmds[0] = !h.Departed ? Cmd.Start : h.LaneTarget < 6 && sim.Tick % 50 == 0 ? Cmd.LaneOut : (byte)0;
                        sim.Step(cmds);
                        for (int a = 0; a <= 1000; a += 500)
                        {
                            var shot = rig.Shot(sim.GetPreviousHorse(0), sim.GetHorse(0), a);
                            var horse = geo.Interpolated(sim.GetPreviousHorse(0), sim.GetHorse(0), a, Rs.LaneWidthMm);
                            Assert.True(RaceCameraRig.InFrame(shot, horse, 1.2), track.Id + " " + shot + " horse " + horse);
                            modes.Add(shot.Mode);
                        }
                    }
                    Assert.Contains(RaceCameraMode.Follow, modes);
                    Assert.Contains(RaceCameraMode.Finish, modes);
                    if (track.Segments[track.Segments.Count - 1].Kind == SegmentKind.Straight && track.Segments[track.Segments.Count - 1].LengthM >= 100)
                        Assert.Contains(RaceCameraMode.FinalStraight, modes);
                }
            }
        }

        [Fact]
        public void CameraFollowShotIsBehindAndAbove()
        {
            var cfg = TestUtil.Cfg(TestUtil.StraightTrack(2000), Rs, new[] { TestUtil.H("a") }, 1);
            var rig = RaceCameraRig.For(cfg);
            var shot = rig.ShotAt(500, 0);
            Assert.Equal(RaceCameraMode.Follow, shot.Mode);
            Assert.Equal(493.5, shot.Position.Z, 3); // 6.5 m back on a straight heading +Z
            Assert.Equal(3.0, shot.Height, 3);
            var low = rig.ShotAt(1900, 0);
            Assert.Equal(RaceCameraMode.FinalStraight, low.Mode);
            Assert.True(low.Height < shot.Height);
            Assert.Equal(RaceCameraMode.Finish, rig.ShotAt(1990, 0).Mode);
        }
    }
}
