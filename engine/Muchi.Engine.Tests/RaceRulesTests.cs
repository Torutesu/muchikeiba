using Muchi.Engine;
using Muchi.Verifier;

namespace Muchi.Engine.Tests
{
    public class DeterminismTests
    {
        private static (RaceConfig cfg, List<InputRecord> inputs) Scenario(ulong seed)
        {
            var rs = TestUtil.Ruleset();
            var rng = new Pcg32(seed, 11);
            var horses = Enumerable.Range(0, 12).Select(i => SampleRaces.RandomHorse(ref rng, "d" + i, 500, 200)).ToList();
            var cfg = SampleRaces.Config("det_" + seed, seed, SampleRaces.Turf2000(), rs, horses, 6);
            var inputs = new List<InputRecord>();
            var irng = new Pcg32(seed ^ 0xABCDEF, 2);
            byte[] choices = { Cmd.Start, Cmd.LaneIn, Cmd.LaneOut, Cmd.ReinPress, Cmd.ReinRelease, Cmd.Whip };
            for (int t = 0; t < 2400; t += 1 + irng.NextInt(15))
                for (int s = 0; s < 6; s++)
                    if (irng.Chance(1, 3)) inputs.Add(new InputRecord(t, s, choices[irng.NextInt(choices.Length)]));
            inputs.Sort((a, b) => a.Tick != b.Tick ? a.Tick.CompareTo(b.Tick) : a.Slot.CompareTo(b.Slot));
            // merge duplicates (tick,slot) by OR to respect the log format
            var merged = new List<InputRecord>();
            foreach (var r in inputs)
            {
                if (merged.Count > 0 && merged[^1].Tick == r.Tick && merged[^1].Slot == r.Slot)
                    merged[^1] = new InputRecord(r.Tick, r.Slot, (byte)(merged[^1].Cmd | r.Cmd));
                else merged.Add(r);
            }
            return (cfg, merged);
        }

        [Fact]
        public void SameConfigAndInputsGiveSameHash1000Times()
        {
            var (cfg, inputs) = Scenario(777);
            var first = RaceReplay.Run(cfg, inputs);
            for (int i = 0; i < 999; i++)
            {
                var again = RaceReplay.Run(cfg, inputs);
                Assert.Equal(first.Result.Hash, again.Result.Hash);
                if (i % 100 == 0) Assert.Equal(first.Checksums, again.Checksums);
            }
        }

        [Fact]
        public void DifferentSeedsGiveDifferentRaces()
        {
            var hashes = new HashSet<string>();
            for (ulong s = 1; s <= 20; s++)
            {
                var (cfg, inputs) = Scenario(1000 + s);
                hashes.Add(RaceReplay.Run(cfg, inputs).Result.Hash);
            }
            Assert.Equal(20, hashes.Count);
        }

        [Fact]
        public void ChangingOnlyTheSeedChangesTheResult()
        {
            var (cfg, inputs) = Scenario(5);
            string h1 = RaceReplay.Run(cfg, inputs).Result.Hash;
            cfg.Seed++;
            Assert.NotEqual(h1, RaceReplay.Run(cfg, inputs).Result.Hash);
        }

        [Fact]
        public void ConfigBuiltIndependentlyGivesSameResult()
        {
            var (cfg, inputs) = Scenario(31);
            var copy = Muchi.Net.ProtocolCodec.ParseConfig(Muchi.Net.ProtocolCodec.ConfigToJson(cfg).ToString());
            var a = RaceReplay.Run(cfg, inputs);
            var b = RaceReplay.Run(copy, inputs.AsEnumerable().Reverse().ToList()); // input order must not matter
            Assert.Equal(a.Result.Hash, b.Result.Hash);
            Assert.Equal(a.Checksums, b.Checksums);
        }

        [Fact]
        public void StepPerformanceIsWellUnderBudget()
        {
            var (cfg, inputs) = Scenario(9);
            var sw = System.Diagnostics.Stopwatch.StartNew();
            int ticks = 0;
            for (int i = 0; i < 20; i++) ticks += RaceReplay.Run(cfg, inputs).Result.EndTick + 1;
            sw.Stop();
            double msPerTick = sw.Elapsed.TotalMilliseconds / ticks;
            Assert.True(msPerTick < 0.1, "ms per tick = " + msPerTick); // NFR-001
        }
    }

    public class RaceRulesTests
    {
        private static readonly RulesetParams Rs = TestUtil.Ruleset();

        private static RaceConfig Solo(TrackSpec track, RulesetParams rs = null, HorseSpec horse = null)
            => TestUtil.Cfg(track, rs ?? Rs, new List<HorseSpec> { horse ?? TestUtil.H("solo") }, 1);

        private static int FinishTick(RaceSim sim, int slot = 0) => sim.GetHorse(slot).FinishTick;

        [Fact]
        public void GoodStartBeatsAutoStart()
        {
            int gate = Rs.GateOpenTick;
            var good = TestUtil.RunScripted(Solo(TestUtil.StraightTrack()), (s, t) => t == gate ? new byte[] { Cmd.Start } : null);
            var late = TestUtil.RunScripted(Solo(TestUtil.StraightTrack()), (s, t) => null);
            Assert.True(FinishTick(good) < FinishTick(late));
            Assert.Contains(good.Events, e => e.Type == RaceEventType.Start && e.Value == 0);
            Assert.Contains(late.Events, e => e.Type == RaceEventType.LateStart && e.Tick == gate + Rs.AutoStartDelayTicks);
        }

        [Fact]
        public void EarlyStartIsIgnoredWithoutPenalty()
        {
            int gate = Rs.GateOpenTick;
            var sim = new RaceSim(Solo(TestUtil.StraightTrack()));
            for (int t = 0; t < gate; t++) sim.Step(new byte[] { Cmd.Start });
            Assert.False(sim.GetHorse(0).Departed);
            Assert.Equal(Fx.Zero, sim.GetHorse(0).Distance);
            sim.Step(new byte[] { Cmd.Start });
            Assert.True(sim.GetHorse(0).Departed);
            Assert.True(sim.GetHorse(0).StartBoostTicksLeft > 0);
        }

        [Fact]
        public void StartAfterWindowGetsNoBoost()
        {
            int gate = Rs.GateOpenTick;
            var sim = new RaceSim(Solo(TestUtil.StraightTrack()));
            while (sim.Tick < gate + Rs.StartReactionWindowTicks) sim.Step(null);
            sim.Step(new byte[] { Cmd.Start });
            Assert.True(sim.GetHorse(0).Departed);
            Assert.Equal(0, sim.GetHorse(0).StartBoostTicksLeft);
        }

        private static bool InFinalStretch(RaceSim s, HorseState h) => s.Track.Distance - h.Distance <= Fx.FromInt(400);

        private static byte[] SpacedWhips(RaceSim s, int t, int gate, int unused)
        {
            if (t == gate) return new byte[] { Cmd.Start };
            var h = s.GetHorse(0);
            if (InFinalStretch(s, h) && h.WhipsLeft > 0 && t - h.LastWhipTick >= 24) return new byte[] { Cmd.Whip };
            return null;
        }

        [Fact]
        public void WellTimedWhipsBeatNoWhips()
        {
            int gate = Rs.GateOpenTick;
            var whipped = TestUtil.RunScripted(Solo(SampleRaces.Turf2000()), (s, t) => SpacedWhips(s, t, gate, 0));
            var plain = TestUtil.RunScripted(Solo(SampleRaces.Turf2000()), (s, t) => t == gate ? new byte[] { Cmd.Start } : null);
            Assert.Equal(0, whipped.GetHorse(0).WhipsLeft);
            Assert.True(FinishTick(whipped) < FinishTick(plain), $"whipped {FinishTick(whipped)} vs plain {FinishTick(plain)}");
        }

        [Fact]
        public void MashingWhipsIsWorseThanSpacingThem()
        {
            int gate = Rs.GateOpenTick;
            var spaced = TestUtil.RunScripted(Solo(SampleRaces.Turf2000()), (s, t) => SpacedWhips(s, t, gate, 0));
            var mashed = TestUtil.RunScripted(Solo(SampleRaces.Turf2000()), (s, t) =>
            {
                if (t == gate) return new byte[] { Cmd.Start };
                var h = s.GetHorse(0);
                return InFinalStretch(s, h) && h.WhipsLeft > 0 ? new byte[] { Cmd.Whip } : null;
            });
            Assert.Equal(0, mashed.GetHorse(0).WhipsLeft);
            Assert.True(FinishTick(spaced) < FinishTick(mashed) ||
                        (FinishTick(spaced) == FinishTick(mashed) && spaced.GetHorse(0).FinishFracRaw < mashed.GetHorse(0).FinishFracRaw));
        }

        [Fact]
        public void WhipsAreCappedAtMaxWhips()
        {
            int gate = Rs.GateOpenTick;
            var sim = TestUtil.RunScripted(Solo(TestUtil.StraightTrack()), (s, t) => t == gate ? new byte[] { Cmd.Start } : (t > gate && t % 5 == 0 ? new byte[] { Cmd.Whip } : null));
            Assert.Equal(Rs.MaxWhips, sim.Events.Count(e => e.Type == RaceEventType.Whip));
            Assert.Equal(0, sim.GetHorse(0).WhipsLeft);
        }

        [Fact]
        public void EarlyWhipCostsComposureAndIsWeaker()
        {
            int gate = Rs.GateOpenTick;
            var sim = new RaceSim(Solo(SampleRaces.Turf2000()));
            while (sim.Tick <= gate) sim.Step(sim.Tick == gate ? new byte[] { Cmd.Start } : null);
            for (int i = 0; i < 100; i++) sim.Step(null);
            int before = sim.GetHorse(0).Composure;
            sim.Step(new byte[] { Cmd.Whip });
            var h = sim.GetHorse(0);
            Assert.Equal(Rs.EarlyWhipEffectPermille, h.WhipEffectPermille);
            Assert.True(h.Composure < before);
        }

        [Fact]
        public void ReinLowersSpeedAndDrain()
        {
            int gate = Rs.GateOpenTick;
            RaceSim Run(bool rein)
            {
                var sim = new RaceSim(Solo(TestUtil.StraightTrack(2000)));
                while (sim.Tick < gate + 600)
                {
                    int t = sim.Tick;
                    byte c = t == gate ? Cmd.Start : (rein && t == gate + 100 ? Cmd.ReinPress : (byte)0);
                    sim.Step(new[] { c });
                }
                return sim;
            }
            var reined = Run(true).GetHorse(0);
            var free = Run(false).GetHorse(0);
            Assert.True(reined.Speed < free.Speed);
            Assert.True(reined.Stamina > free.Stamina);
            Assert.True(reined.Reining);
        }

        [Fact]
        public void ContradictoryInputsAreResolved()
        {
            int gate = Rs.GateOpenTick;
            var cfg = TestUtil.Cfg(TestUtil.StraightTrack(), Rs, new List<HorseSpec> { TestUtil.H("a"), TestUtil.H("b") }, 2);
            var sim = new RaceSim(cfg);
            while (sim.Tick <= gate) sim.Step(sim.Tick == gate ? new byte[] { Cmd.Start, Cmd.Start } : null);
            for (int i = 0; i < 200; i++) sim.Step(null);
            sim.Step(new byte[] { Cmd.ReinPress, 0 });
            Assert.True(sim.GetHorse(0).Reining);
            sim.Step(new byte[] { (byte)(Cmd.ReinPress | Cmd.ReinRelease), (byte)(Cmd.LaneIn | Cmd.LaneOut) });
            Assert.False(sim.GetHorse(0).Reining);
            Assert.Equal(1, sim.GetHorse(1).LaneTarget);
        }

        [Fact]
        public void OutsideLaneLosesGroundInCornersButNotOnStraights()
        {
            int gate = Rs.GateOpenTick;
            byte[] Script(RaceSim s, int t, bool goWide)
            {
                if (t == gate) return new byte[] { Cmd.Start };
                if (goWide && t > gate && t < gate + 100 && t % 10 == 0) return new byte[] { Cmd.LaneOut };
                return null;
            }
            var insideC = TestUtil.RunScripted(Solo(TestUtil.CornerTrack()), (s, t) => Script(s, t, false));
            var wideC = TestUtil.RunScripted(Solo(TestUtil.CornerTrack()), (s, t) => Script(s, t, true));
            Assert.True(wideC.GetHorse(0).LaneTarget >= 5);
            Assert.True(FinishTick(wideC) > FinishTick(insideC) + 20, $"wide {FinishTick(wideC)} inside {FinishTick(insideC)}");

            var insideS = TestUtil.RunScripted(Solo(TestUtil.StraightTrack()), (s, t) => Script(s, t, false));
            var wideS = TestUtil.RunScripted(Solo(TestUtil.StraightTrack()), (s, t) => Script(s, t, true));
            Assert.Equal(FinishTick(insideS), FinishTick(wideS));
            Assert.Equal(insideS.GetHorse(0).FinishFracRaw, wideS.GetHorse(0).FinishFracRaw);
        }

        [Fact]
        public void LaneClampsAtRailAndOutsideEdge()
        {
            int gate = Rs.GateOpenTick;
            var sim = TestUtil.RunScripted(Solo(TestUtil.StraightTrack()), (s, t) => t == gate ? new byte[] { Cmd.Start } : (t > gate && t % 7 == 0 ? new byte[] { Cmd.LaneIn } : null));
            Assert.Equal(0, sim.GetHorse(0).LaneTarget);
            Assert.Equal(Fx.Zero, sim.GetHorse(0).Lane);
            var sim2 = TestUtil.RunScripted(Solo(TestUtil.StraightTrack()), (s, t) => t == gate ? new byte[] { Cmd.Start } : (t > gate && t % 7 == 0 ? new byte[] { Cmd.LaneOut } : null));
            Assert.Equal(Rs.LaneCount - 1, sim2.GetHorse(0).LaneTarget);
        }

        [Fact]
        public void SlipstreamSavesStaminaForTheFollower()
        {
            // same race twice; only slipstreamSavePermille differs. The leader (no one ahead) is unaffected,
            // the follower tucked in behind keeps more stamina when slipstream is on.
            int gate = 60;
            RaceSim Run(int save)
            {
                var rs = TestUtil.Ruleset(("slipstreamSavePermille", save), ("kakariChancePer100000PerTickAtTemper0", 0));
                var horses = new List<HorseSpec> { TestUtil.H("lead", 700), TestUtil.H("follow", 500) };
                var cfg = TestUtil.Cfg(TestUtil.StraightTrack(2000), rs, horses, 2);
                var sim = new RaceSim(cfg);
                while (sim.Tick < gate + 900)
                {
                    int t = sim.Tick;
                    var c = new byte[2];
                    if (t == gate) { c[0] = Cmd.Start; c[1] = Cmd.Start; }
                    var f = sim.GetHorse(1);
                    var l = sim.GetHorse(0);
                    if (t > gate + 60 && f.LaneTarget == 1 && (l.Distance - f.Distance) > Fx.FromInt(3)) c[1] = Cmd.LaneIn;
                    // follower holds position right behind the leader with the rein
                    if (f.LaneTarget == 0 && (l.Distance - f.Distance) < Fx.FromInt(4) && !f.Reining) c[1] |= Cmd.ReinPress;
                    if (f.LaneTarget == 0 && (l.Distance - f.Distance) > Fx.FromInt(5) && f.Reining) c[1] |= Cmd.ReinRelease;
                    sim.Step(c);
                }
                return sim;
            }
            var with = Run(300);
            var without = Run(0);
            Assert.Equal(0, with.GetHorse(1).LaneTarget);
            Assert.Equal(with.GetHorse(0).Stamina, without.GetHorse(0).Stamina);
            Assert.True(with.GetHorse(1).Stamina > without.GetHorse(1).Stamina);
        }

        [Fact]
        public void BlockedHorseCannotPassInSameLane()
        {
            int gate = 60;
            var rs = TestUtil.Ruleset(("kakariChancePer100000PerTickAtTemper0", 0));
            var horses = new List<HorseSpec> { TestUtil.H("slow", 100), TestUtil.H("fast", 1000) };
            var cfg = TestUtil.Cfg(TestUtil.StraightTrack(1500), rs, horses, 2);
            bool sawBlocked = false;
            bool passedWhileSameLane = false;
            // slow horse starts on time, fast horse starts late, then tucks in behind and never changes lane
            var sim = TestUtil.RunScripted(cfg, (s, t) =>
            {
                var c = new byte[2];
                if (t == gate) c[0] = Cmd.Start;
                var f = s.GetHorse(1);
                var l = s.GetHorse(0);
                if (f.Departed && f.LaneTarget == 1 && l.Distance - f.Distance > Fx.FromInt(4)) c[1] = Cmd.LaneIn;
                return c;
            }, s =>
            {
                var f = s.GetHorse(1);
                var l = s.GetHorse(0);
                if (f.Blocked) sawBlocked = true;
                if (!f.IsChangingLane && f.LaneTarget == 0 && !l.Finished && f.Distance > l.Distance) passedWhileSameLane = true;
            });
            Assert.True(sawBlocked);
            Assert.False(passedWhileSameLane);
            Assert.True(sim.GetHorse(0).FinishTick <= sim.GetHorse(1).FinishTick);
        }

        [Fact]
        public void LaneChangeIntoOccupiedLaneIsRefused()
        {
            int gate = 60;
            var cfg = TestUtil.Cfg(TestUtil.StraightTrack(), Rs, new List<HorseSpec> { TestUtil.H("a"), TestUtil.H("b") }, 2);
            var sim = new RaceSim(cfg);
            while (sim.Tick <= gate) sim.Step(sim.Tick == gate ? new byte[] { Cmd.Start, Cmd.Start } : null);
            sim.Step(new byte[] { 0, Cmd.LaneIn }); // side by side → refused
            Assert.Equal(1, sim.GetHorse(1).LaneTarget);
            Assert.DoesNotContain(sim.Events, e => e.Type == RaceEventType.LaneChange);
        }

        [Fact]
        public void KakariDependsOnTemperAndReinRecovers()
        {
            var rs = TestUtil.Ruleset(("kakariChancePer100000PerTickAtTemper0", 2000));
            int gate = rs.GateOpenTick;
            var hot = TestUtil.RunScripted(Solo(SampleRaces.Turf2000(), rs, TestUtil.H("hot", 500, RunningStyle.Senko, 0)), (s, t) => t == gate ? new byte[] { Cmd.Start } : null);
            var calm = TestUtil.RunScripted(Solo(SampleRaces.Turf2000(), rs, TestUtil.H("calm", 500, RunningStyle.Senko, 1000)), (s, t) => t == gate ? new byte[] { Cmd.Start } : null);
            Assert.Contains(hot.Events, e => e.Type == RaceEventType.Kakari);
            Assert.DoesNotContain(calm.Events, e => e.Type == RaceEventType.Kakari);

            // rein recovers composure
            var sim = new RaceSim(Solo(SampleRaces.Turf2000(), rs, TestUtil.H("hot2", 500, RunningStyle.Senko, 0)));
            while (sim.Tick <= gate) sim.Step(sim.Tick == gate ? new byte[] { Cmd.Start } : null);
            while (sim.GetHorse(0).Composure >= 60) sim.Step(null);
            int low = sim.GetHorse(0).Composure;
            sim.Step(new byte[] { Cmd.ReinPress });
            for (int i = 0; i < 100; i++) sim.Step(null);
            Assert.True(sim.GetHorse(0).Composure > low);
        }

        [Fact]
        public void ExhaustedHorseDropsToGutsFloor()
        {
            var rs = TestUtil.Ruleset(("drainMicroPerSpeedSqPerTick", 200000));
            int gate = rs.GateOpenTick;
            var horse = TestUtil.H("tired", 500);
            var sim = new RaceSim(Solo(TestUtil.StraightTrack(2000), rs, horse));
            while (sim.Tick < gate + 600) sim.Step(sim.Tick == gate ? new byte[] { Cmd.Start } : null);
            var h = sim.GetHorse(0);
            Assert.Equal(0, h.Stamina.Raw);
            int floor = rs.GutsFloorMinPermille + (rs.GutsFloorMaxPermille - rs.GutsFloorMinPermille) * horse.Guts / 1000;
            Assert.True(h.Speed <= sim.TopSpeed(0).MulPermille(floor));
        }

        [Fact]
        public void HigherGutsHoldsMoreSpeedWhenExhausted()
        {
            var rs = TestUtil.Ruleset(("drainMicroPerSpeedSqPerTick", 200000));
            int gate = rs.GateOpenTick;
            Fx SpeedWith(int guts)
            {
                var horse = TestUtil.H("g", 500);
                horse.Guts = guts;
                var sim = new RaceSim(Solo(TestUtil.StraightTrack(2000), rs, horse));
                while (sim.Tick < gate + 600) sim.Step(sim.Tick == gate ? new byte[] { Cmd.Start } : null);
                return sim.GetHorse(0).Speed;
            }
            Assert.True(SpeedWith(1000) > SpeedWith(0));
        }

        [Fact]
        public void OutOfAptitudeLowersTopSpeedAndStamina()
        {
            var fit = TestUtil.H("fit");
            var unfit = TestUtil.H("unfit");
            unfit.DistMinM = 2400; unfit.DistMaxM = 3200; unfit.Surface = Surface.Dirt;
            var cfg = TestUtil.Cfg(SampleRaces.Turf2000(), Rs, new List<HorseSpec> { fit, unfit }, 0);
            var sim = new RaceSim(cfg);
            Assert.True(sim.TopSpeed(1) < sim.TopSpeed(0));
            Assert.True(sim.GetHorse(1).StaminaMax < sim.GetHorse(0).StaminaMax);
            var both = TestUtil.H("both");
            both.Surface = Surface.Both;
            var sim2 = new RaceSim(TestUtil.Cfg(SampleRaces.Turf2000(), Rs, new List<HorseSpec> { fit, both }, 0));
            Assert.Equal(sim2.TopSpeed(0), sim2.TopSpeed(1));
        }

        [Fact]
        public void MaxTicksEndsTheRace()
        {
            var rs = TestUtil.Ruleset(("maxTicks", 500));
            var sim = TestUtil.RunScripted(Solo(SampleRaces.Turf2000(), rs), (s, t) => null);
            Assert.True(sim.IsFinished);
            Assert.Equal(500, sim.Tick);
            Assert.Equal(-1, sim.Result.FinishTicks[0]);
            Assert.Throws<InvalidOperationException>(() => sim.Step(null));
        }

        [Fact]
        public void CpuTakeoverAndHumanResume()
        {
            int gate = Rs.GateOpenTick;
            var cfg = TestUtil.Cfg(SampleRaces.Turf2000(), Rs, Enumerable.Range(0, 3).Select(i => TestUtil.H("t" + i)).ToList(), 1);
            // the human never touches anything, but is taken over before the gate → the CPU starts and whips
            var sim = TestUtil.RunScripted(cfg, (s, t) => t == 10 ? new byte[] { Cmd.CpuTakeover, 0, 0 } : null);
            Assert.Contains(sim.Events, e => e.Type == RaceEventType.CpuTakeover && e.Slot == 0 && e.Tick == 10);
            Assert.Contains(sim.Events, e => e.Type == RaceEventType.Start && e.Slot == 0);
            Assert.True(sim.GetHorse(0).WhipsLeft < Rs.MaxWhips);

            var sim2 = new RaceSim(cfg);
            sim2.Step(new byte[] { Cmd.CpuTakeover, Cmd.HumanResume, 0 });
            Assert.True(sim2.GetHorse(0).CpuControlled);
            Assert.True(sim2.GetHorse(1).CpuControlled); // CPU entrants cannot be "resumed"
            sim2.Step(new byte[] { Cmd.HumanResume, 0, 0 });
            Assert.False(sim2.GetHorse(0).CpuControlled);
            Assert.Contains(sim2.Events, e => e.Type == RaceEventType.HumanResume && e.Slot == 0);
        }

        [Fact]
        public void HumanInputsAreIgnoredWhileCpuControlled()
        {
            var cfg = TestUtil.Cfg(SampleRaces.Turf2000(), Rs, Enumerable.Range(0, 2).Select(i => TestUtil.H("h" + i)).ToList(), 1);
            int gate = Rs.GateOpenTick;
            var a = TestUtil.RunScripted(cfg, (s, t) => t == 0 ? new byte[] { Cmd.CpuTakeover, 0 } : new byte[] { Cmd.Whip, 0 });
            var b = TestUtil.RunScripted(cfg, (s, t) => t == 0 ? new byte[] { Cmd.CpuTakeover, 0 } : null);
            Assert.Equal(a.Result.Hash, b.Result.Hash);
        }

        [Fact]
        public void EventsAndRenderApiAreConsistent()
        {
            var rs = Rs;
            var rng = new Pcg32(3, 3);
            var cfg = TestUtil.Cfg(SampleRaces.Turf2000(), rs, Enumerable.Range(0, 12).Select(i => SampleRaces.RandomHorse(ref rng, "e" + i)).ToList(), 0);
            var sim = new RaceSim(cfg);
            HorseState[] last = null;
            while (!sim.IsFinished)
            {
                sim.Step(null);
                if (last != null)
                    for (int i = 0; i < 12; i++) Assert.Equal(last[i].Distance, sim.GetPreviousHorse(i).Distance);
                last = Enumerable.Range(0, 12).Select(sim.GetHorse).ToArray();
                // ranks form a permutation consistent with SlotAtRank
                for (int r = 0; r < 12; r++) Assert.Equal(r, sim.GetHorse(sim.SlotAtRank(r)).Rank);
            }
            Assert.Single(sim.Events, e => e.Type == RaceEventType.GateOpen && e.Tick == rs.GateOpenTick);
            var finishes = sim.Events.Where(e => e.Type == RaceEventType.Finish).ToList();
            Assert.Equal(12, finishes.Count);
            Assert.Equal(Enumerable.Range(1, 12), finishes.Select(e => e.Value).OrderBy(v => v));
            Assert.Equal(finishes.OrderBy(e => e.Value).Select(e => e.Slot), sim.Result.Order);
            Assert.Single(sim.Events, e => e.Type == RaceEventType.RaceEnd);
            Assert.Equal(12, sim.Events.Count(e => e.Type == RaceEventType.SpurtStart));
            Assert.Contains(sim.Events, e => e.Type == RaceEventType.LeaderChanged);
            Assert.Equal(sim.Result.Order[0], sim.Events.Last().Slot);
            // margins are non-negative
            Assert.All(sim.Result.Margins, m => Assert.True(m.Raw >= 0));
            Assert.InRange(sim.GetHorse(0).StaminaPermille, 0, 1000);
        }

        [Fact]
        public void FinishOrderUsesSubTickFraction()
        {
            var rng = new Pcg32(8, 8);
            for (int k = 0; k < 30; k++)
            {
                var cfg = TestUtil.Cfg(SampleRaces.Turf1600(), Rs, Enumerable.Range(0, 12).Select(i => SampleRaces.RandomHorse(ref rng, "f" + i)).ToList(), 0, (ulong)k + 500);
                var res = RaceReplay.Run(cfg, new List<InputRecord>()).Result;
                for (int p = 1; p < 12; p++)
                {
                    Assert.True(res.FinishTicks[p] >= res.FinishTicks[p - 1]);
                    if (res.FinishTicks[p] == res.FinishTicks[p - 1])
                        Assert.True(res.FinishFracOrDistanceRaw[p] > res.FinishFracOrDistanceRaw[p - 1] ||
                                    (res.FinishFracOrDistanceRaw[p] == res.FinishFracOrDistanceRaw[p - 1] && res.Order[p] > res.Order[p - 1]));
                }
            }
        }
    }

    public class BalanceTests
    {
        [Fact]
        public void DefaultRulesetMeetsBalanceTargets()
        {
            var rs = TestUtil.Ruleset();
            var rep = BalanceProbe.Run(rs, 400);
            double win = rep.AvgWinnerSeconds(20, rs.GateOpenTick);
            double last = rep.AvgLastSeconds(20, rs.GateOpenTick);
            Assert.Equal(0, rep.Dnf);
            Assert.InRange(win, 85.0, 100.0);
            Assert.InRange(last, 85.0, 105.0);
            foreach (RunningStyle s in Enum.GetValues(typeof(RunningStyle)))
                Assert.InRange(rep.StyleWinRate(s), 0.03, 0.17); // uniform = 8.3%
            Assert.True((double)rep.StrongestWins / rep.Races > 0.2, "stats must matter: " + rep.Describe(20, rs.GateOpenTick));
        }

        [Fact]
        public void BetterCpuLevelWinsMoreOften()
        {
            var rs = TestUtil.Ruleset();
            int strongWins = 0;
            for (int r = 0; r < 200; r++)
            {
                var horses = Enumerable.Range(0, 12).Select(i => TestUtil.H("lv" + i, 500, (RunningStyle)(i % 4), 500)).ToList();
                var cfg = TestUtil.Cfg(SampleRaces.Turf2000(), rs, horses, 0, (ulong)r + 9000);
                // slots 0..5 level 5, slots 6..11 level 1
                for (int i = 0; i < 12; i++) cfg.Entrants[i].CpuLevel = i < 6 ? 5 : 1;
                var res = RaceReplay.Run(cfg, new List<InputRecord>()).Result;
                if (res.Order[0] < 6) strongWins++;
            }
            Assert.True(strongWins > 100, "level-5 riders won " + strongWins + "/200");
        }
    }
}
