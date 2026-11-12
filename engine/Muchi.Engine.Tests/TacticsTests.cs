using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Net;
using Muchi.Verifier;
using Xunit;

namespace Muchi.Engine.Tests
{
    /// <summary>
    /// Ruleset 1.4 tactics (docs/quality/race-play.md): the whip hold (溜め) and its release (仕掛け → 一閃), the auto go, 会心
    /// rhythm whips, the slingshot, CPUs using them, older rulesets untouched, and the client pieces (EffectiveCommand, WhipHold,
    /// the HUD tracker, the counterfactual lesson).
    /// </summary>
    public class TacticsTests
    {
        private static string TacticsPath => Path.Combine(TestUtil.RepoRoot, "contracts", "ruleset-params.1.4.0.json");
        private static RulesetParams R14() => ProtocolCodec.ParseRuleset(File.ReadAllText(TacticsPath));
        private static RulesetParams R13() => ProtocolCodec.ParseRuleset(File.ReadAllText(TestUtil.DefaultRulesetPath));

        private static RaceConfig Field(RulesetParams rs, int humans = 1, ulong seed = 1404, int cpuLevel = 3)
        {
            var rng = new Pcg32(seed, 3);
            var horses = Enumerable.Range(0, 12).Select(i => SampleRaces.RandomHorse(ref rng, "t" + i)).ToList();
            horses[0] = SampleRaces.Horse("me", 500, RunningStyle.Sashi);
            return SampleRaces.Config("tac_" + seed, seed, SampleRaces.Turf2000(), rs, horses, humans, cpuLevel);
        }

        /// <summary>Runs the race; <paramref name="rider"/> gives slot 0's byte from the pre-step state.</summary>
        private static RaceSim Run(RaceConfig cfg, Func<RaceSim, int, byte> rider)
        {
            var sim = new RaceSim(cfg);
            var cmds = new byte[cfg.Entrants.Count];
            while (!sim.IsFinished)
            {
                Array.Clear(cmds, 0, cmds.Length);
                cmds[0] = rider(sim, sim.Tick);
                sim.Step(cmds);
            }
            return sim;
        }

        private static long Rem(RaceSim sim) => (sim.Track.Distance - sim.GetHorse(0).Distance).Raw >> 16;

        [Fact]
        public void The14FileIs13PlusTheTacticsGroupAndTheGroupIsAllOrNone()
        {
            var a = JsonNode.Parse(File.ReadAllText(TestUtil.DefaultRulesetPath));
            var b = JsonNode.Parse(File.ReadAllText(TacticsPath));
            Assert.Equal("1.3.0", a.Get("rulesetVersion").AsString());
            Assert.Equal("1.4.0", b.Get("rulesetVersion").AsString());
            var extra = b.Props.Select(p => p.Key).Except(a.Props.Select(p => p.Key)).ToList();
            Assert.Equal(RulesetParams.TacticsIntKeys.OrderBy(k => k), extra.OrderBy(k => k));
            foreach (var p in a.Props)
                if (p.Key != "rulesetVersion" && p.Key != "cpuWhipIntervalTicks") Assert.Equal(p.Value.ToString(), b.Get(p.Key).ToString());
            Assert.False(R13().HasTacticsKeys);
            Assert.True(R14().HasTacticsKeys);
            // partial tactics groups are rejected
            var partial = JsonNode.Parse(File.ReadAllText(TestUtil.DefaultRulesetPath));
            partial.Set("goWindowPermille", 2500);
            Assert.ThrowsAny<Exception>(() => ProtocolCodec.ParseRuleset(partial));
            // the serialised ruleset round-trips with the group
            var rt = ProtocolCodec.ParseRuleset(ProtocolCodec.RulesetToJson(R14()));
            Assert.True(rt.HasTacticsKeys);
            Assert.Equal(R14().GoLinePermille, rt.GoLinePermille);
        }

        [Fact]
        public void BeforeTacticsStartAfterDepartureChangesNothing()
        {
            // 1.4 gives START (bit 0) after departure the meaning WHIP_RELEASE; in 1.3 it must stay a no-op (old replays)
            var cfg = Field(R13());
            byte Ride(RaceSim s, int t, bool extra)
            {
                var h = s.GetHorse(0);
                if (!h.Departed) return t >= s.P.GateOpenTick ? Cmd.Start : (byte)0;
                byte c = 0;
                if (Rem(s) <= 300 && t % 25 == 0 && h.WhipsLeft > 0) c |= Cmd.Whip;
                if (extra && t % 7 == 0) c |= Cmd.Start;
                return c;
            }
            var a = Run(cfg, (s, t) => Ride(s, t, false));
            var b = Run(cfg, (s, t) => Ride(s, t, true));
            Assert.Equal(a.Result.Hash, b.Result.Hash);
            Assert.DoesNotContain(a.Events, e => e.Type == RaceEventType.Go || e.Type == RaceEventType.Gather || e.Type == RaceEventType.Rhythm || e.Type == RaceEventType.Slingshot);
        }

        [Fact]
        public void HoldInTheWindowGathersAndTheReleaseGoesWithAKickScaledByTheCharge()
        {
            var cfg = Field(R14());
            int press = -1, release = -1;
            var sim = Run(cfg, (s, t) =>
            {
                var h = s.GetHorse(0);
                if (!h.Departed) return t >= s.P.GateOpenTick ? Cmd.Start : (byte)0;
                if (press < 0 && Rem(s) <= 900) { press = t; return Cmd.Whip; }
                if (press >= 0 && release < 0 && t - press == 25) { release = t; return Cmd.Start; }
                return 0;
            });
            var gather = sim.Events.Single(e => e.Slot == 0 && e.Type == RaceEventType.Gather);
            var go = sim.Events.Single(e => e.Slot == 0 && e.Type == RaceEventType.Go);
            Assert.Equal(press, gather.Tick);
            Assert.Equal(release, go.Tick);
            Assert.Equal(25, go.Value); // ticks gathered: the press tick and every tick until the release
            Assert.Equal(0, sim.GetHorse(0).WhipsLeft == sim.P.MaxWhips ? 0 : 1); // the hold spends no whip
            Assert.True(sim.GetHorse(0).InSpurt);
        }

        [Fact]
        public void PressAndReleaseOnOneTickIsAPlainGoAndAFullChargeGoesByItself()
        {
            var rs = R14();
            var tap = Run(Field(rs), (s, t) =>
            {
                var h = s.GetHorse(0);
                if (!h.Departed) return t >= s.P.GateOpenTick ? Cmd.Start : (byte)0;
                return !h.InSpurt && Rem(s) <= 800 ? (byte)(Cmd.Whip | Cmd.Start) : (byte)0;
            });
            Assert.Equal(0, tap.Events.Single(e => e.Slot == 0 && e.Type == RaceEventType.Go).Value);

            int press = -1;
            var full = Run(Field(rs), (s, t) =>
            {
                var h = s.GetHorse(0);
                if (!h.Departed) return t >= s.P.GateOpenTick ? Cmd.Start : (byte)0;
                if (press < 0 && Rem(s) <= 800) { press = t; return Cmd.Whip; }
                return 0; // never released
            });
            var go = full.Events.Single(e => e.Slot == 0 && e.Type == RaceEventType.Go);
            Assert.Equal(rs.GatherMaxTicks, go.Value);
            Assert.Equal(press + rs.GatherMaxTicks, go.Tick);
        }

        [Fact]
        public void WithoutAGoTheHorseGoesAtTheAutoMarkAndTheSpurtMarkStillCallsTheStretch()
        {
            var sim = Run(Field(R14()), (s, t) => !s.GetHorse(0).Departed && t >= s.P.GateOpenTick ? Cmd.Start : (byte)0);
            var go = sim.Events.Single(e => e.Slot == 0 && e.Type == RaceEventType.Go);
            Assert.Equal(-1, go.Value);
            var spurt = sim.Events.Single(e => e.Slot == 0 && e.Type == RaceEventType.SpurtStart);
            Assert.True(spurt.Tick >= go.Tick - 1); // auto go at 1000‰ = the spurt mark
        }

        [Fact]
        public void AWhipOnTheBeatIsPerfectAndOffTheBeatIsNot()
        {
            var rs = R14();
            int goTick = -1;
            var sim = Run(Field(rs), (s, t) =>
            {
                var h = s.GetHorse(0);
                if (!h.Departed) return t >= s.P.GateOpenTick ? Cmd.Start : (byte)0;
                if (!h.InSpurt) return Rem(s) <= 700 ? (byte)(Cmd.Whip | Cmd.Start) : (byte)0;
                if (goTick < 0) goTick = h.GoTick;
                if (t == goTick + 20) return Cmd.Whip;       // on the beat after the go
                if (t == goTick + 20 + 10) return Cmd.Whip;  // too soon after the last whip
                if (t == goTick + 30 + 21) return Cmd.Whip;  // on the beat again
                return 0;
            });
            var whips = sim.Events.Where(e => e.Slot == 0 && e.Type == RaceEventType.Whip).Select(e => e.Tick).ToList();
            var perfect = sim.Events.Where(e => e.Slot == 0 && e.Type == RaceEventType.Rhythm).Select(e => e.Tick).ToList();
            Assert.Equal(3, whips.Count);
            Assert.Equal(new[] { whips[0], whips[2] }, perfect);
            Assert.Equal(2, sim.GetHorse(0).PerfectWhips);
        }

        [Fact]
        public void PullingOutOfASlipstreamInsideTheWindowGivesTheSlingshot()
        {
            // a rider who hunts a slipstream and pulls out after the go (TacticalRider), over a few fixed fields
            var rs = R14();
            int slings = 0;
            for (ulong seed = 1; seed <= 12 && slings == 0; seed++)
            {
                var cfg = Field(rs, 1, 500 + seed);
                var sim = BalanceHarness.Run(cfg, new Dictionary<int, IRider> { [0] = new TacticalRider() }, seed);
                foreach (var e in sim.Events.Where(e => e.Slot == 0 && e.Type == RaceEventType.Slingshot))
                {
                    slings++;
                    // the burst comes with the lane change the rider asked for, inside the window
                    Assert.Contains(sim.Events, x => x.Slot == 0 && x.Type == RaceEventType.LaneChange && x.Tick == e.Tick && x.Value == e.Value);
                }
                // without the slingshot keys' effect (ticks 0) the same ride has no burst
                var off = BalanceHarness.Run(Field(TacticsHarness.WithValue(rs, "slingshotTicks", 0), 1, 500 + seed), new Dictionary<int, IRider> { [0] = new TacticalRider() }, seed);
                Assert.DoesNotContain(off.Events, x => x.Type == RaceEventType.Slingshot);
            }
            Assert.True(slings > 0, "a slingshot happened");
        }

        [Fact]
        public void TheTacticsGoldenShowsEveryMechanicAndVerifies()
        {
            var doc = JsonNode.Parse(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "contracts", "golden", "race-turf2000-tactics.json")));
            var log = ProtocolCodec.ParseReplayLog(doc.Get("log"));
            Assert.Equal("1.4.0", log.Config.Ruleset.RulesetVersion);
            var outp = RaceReplay.Run(log.Config, log.Inputs);
            Assert.Equal(doc.Get("expected").Get("resultHash").AsString(), outp.Result.Hash);
            var ev = outp.Sim.Events;
            Assert.Contains(ev, e => e.Slot == 0 && e.Type == RaceEventType.Gather);
            Assert.Contains(ev, e => e.Slot == 0 && e.Type == RaceEventType.Go && e.Value > 0);  // the 一閃
            Assert.Contains(ev, e => e.Slot == 1 && e.Type == RaceEventType.Go && e.Value == 0); // a plain tap go
            Assert.Contains(ev, e => e.Slot == 0 && e.Type == RaceEventType.Rhythm);
            Assert.Contains(ev, e => e.Type == RaceEventType.Slingshot);
            Assert.Contains(ev, e => e.Slot >= 2 && e.Type == RaceEventType.Go && e.Value > 0);  // CPUs hold and go too
        }

        [Fact]
        public void The14RaceIsDeterministicAndOnly14ChecksumsCarryTheNewState()
        {
            var cfg = Field(R14(), 0, 9, 5);
            var a = RaceReplay.Run(cfg, new List<InputRecord>());
            var b = RaceReplay.Run(Field(R14(), 0, 9, 5), new List<InputRecord>());
            Assert.Equal(a.Result.Hash, b.Result.Hash);
            // CPUs use the go (level 5 holds and releases before the auto mark)
            Assert.Contains(a.Sim.Events, e => e.Type == RaceEventType.Go && e.Value > 0);
            Assert.Contains(a.Sim.Events, e => e.Type == RaceEventType.Rhythm);
        }

        [Fact]
        public void EffectiveCommandKeepsTheHoldAndReleaseSoRecordedInputsReplayTheRace()
        {
            var cfg = Field(R14());
            var race = new OfflineRace(cfg, 0);
            int press = -1;
            while (!race.Sim.IsFinished)
            {
                var h = race.Sim.GetHorse(0);
                int t = race.Sim.Tick;
                byte c = 0;
                if (!h.Departed) c = t >= cfg.Ruleset.GateOpenTick ? Cmd.Start : (byte)0;
                else if (!h.InSpurt && press < 0 && Rem(race.Sim) <= 850) { press = t; c = Cmd.Whip; }
                else if (h.Gathering && t - press >= 20) c = Cmd.Start;
                else if (h.InSpurt && t - h.RhythmRefTick == 21) c = Cmd.Whip;
                race.Input(c); race.StepOnce();
            }
            Assert.Contains(race.RecordedInputs, r => r.Cmd == Cmd.Whip && r.Tick == press);
            Assert.Contains(race.RecordedInputs, r => r.Cmd == Cmd.Start && r.Tick == press + 20);
            var replay = RaceReplay.Run(cfg, race.AllInputs());
            Assert.Equal(race.ResultHash, replay.Result.Hash);
        }

        [Fact]
        public void TheAccessibilityHoldReleasesTheHoldAndRepeatsOnlyAfterTheGo()
        {
            var rs = R14();
            var cfg = Field(rs);
            var hold = new WhipHold();
            var sim = new RaceSim(cfg);
            var cmds = new byte[12];
            bool held = false; int pressTick = -1, releaseCmdTick = -1;
            while (!sim.IsFinished)
            {
                Array.Clear(cmds, 0, 12);
                var h = sim.GetHorse(0);
                int t = sim.Tick;
                if (!h.Departed) { if (t >= rs.GateOpenTick) cmds[0] = Cmd.Start; }
                else
                {
                    if (!held && pressTick < 0 && Rem(sim) <= 850) { held = true; pressTick = t; }
                    if (held && pressTick >= 0 && t - pressTick == 15) held = false;
                    byte b = hold.Next(sim, 0, held);
                    if ((b & Cmd.Start) != 0) releaseCmdTick = t;
                    cmds[0] = b;
                }
                sim.Step(cmds);
            }
            Assert.Equal(pressTick + 15, releaseCmdTick);
            Assert.Equal(0, hold.Repeats); // the hold before the go repeated nothing
            Assert.Equal(15, sim.Events.Single(e => e.Slot == 0 && e.Type == RaceEventType.Go).Value);
        }

        [Fact]
        public void TheHudTrackerRaisesTheTacticsCuesOnceAndTheSnapshotFollowsThePhases()
        {
            var cfg = Field(R14());
            var feel = new RaceFeelTracker(0);
            var sim = new RaceSim(cfg);
            var cmds = new byte[12];
            var phases = new List<string>();
            int press = -1;
            while (!sim.IsFinished)
            {
                Array.Clear(cmds, 0, 12);
                var h = sim.GetHorse(0);
                int t = sim.Tick;
                var tac = feel.Current.Tactics;
                if (!h.Departed) cmds[0] = t >= cfg.Ruleset.GateOpenTick ? Cmd.Start : (byte)0;
                else if (tac != null && tac.GoNow && press < 0) { press = t; cmds[0] = Cmd.Whip; }
                else if (h.Gathering && t - press >= 30) cmds[0] = Cmd.Start;
                else if (tac != null && tac.Beat && h.WhipsLeft > 0) cmds[0] = Cmd.Whip;
                sim.Step(cmds);
                var s = feel.Update(sim);
                if (s.Tactics != null && (phases.Count == 0 || phases[phases.Count - 1] != s.Tactics.Phase)) phases.Add(s.Tactics.Phase);
            }
            Assert.True(press > 0, "the go line cue came");
            Assert.Equal(new[] { "wait", "window", "gonow", "gather", "go", "done" }, phases.Where(p => p != "full").Distinct().ToArray());
            Assert.Single(feel.Cues, c => c.Kind == RaceFeelCueKind.GoNow);
            Assert.Single(feel.Cues, c => c.Kind == RaceFeelCueKind.Go);
            Assert.Contains(feel.Cues, c => c.Kind == RaceFeelCueKind.PerfectWhip);
            Assert.DoesNotContain(feel.Cues, c => c.Kind == RaceFeelCueKind.WhipChance); // the 1.3 whip cue stays off in 1.4
        }

        [Fact]
        public void TheCounterfactualLessonComesFromRacesTheEngineRan()
        {
            var cfg = Field(R14(), 1, 2024);
            var race = new OfflineRace(cfg, 0);
            int press = -1;
            while (!race.Sim.IsFinished)
            {
                var h = race.Sim.GetHorse(0);
                int t = race.Sim.Tick;
                byte c = 0;
                if (!h.Departed) c = t >= cfg.Ruleset.GateOpenTick ? Cmd.Start : (byte)0;
                else if (!h.InSpurt && press < 0 && Rem(race.Sim) <= race.Sim.AutoGoM + 40) { press = t; c = Cmd.Whip; } // a late go
                else if (h.Gathering && t - press >= 10) c = Cmd.Start;
                else if (h.InSpurt && t - h.RhythmRefTick == 21) c = Cmd.Whip;
                race.Input(c); race.StepOnce();
            }
            var inputs = race.AllInputs();
            var cf = GoCounterfactual.Analyze(cfg, inputs, 0);
            var again = GoCounterfactual.Analyze(cfg, inputs, 0);
            Assert.Equal(cf.Line, again.Line); // deterministic
            Assert.True(cf.Simulations > 1);
            Assert.Equal(Array.IndexOf(race.Sim.Result.Order, 0) + 1, cf.ActualPlace);
            Assert.NotNull(cf.Line);
            if (cf.BestShiftTicks != 0)
            {
                // the claimed better result is reproducible: shift the block and run it
                Assert.True(cf.BestPlace < cf.ActualPlace || cf.BestTimeMs < cf.ActualTimeMs);
                Assert.Contains("仕掛け", cf.Line);
            }
            else Assert.Equal(cf.ActualPlace <= GoCounterfactual.BestLinePlaceMax ? GoCounterfactual.BestLine : GoCounterfactual.UnchangedLine, cf.Line);
            Assert.NotNull(cf.PerfectLine);
        }

        [Theory]
        // quality integration: 「最善」 only when no better go was found AND the finish was good AND the 敗因 is not about timing
        [InlineData(2, null, "仕掛けのタイミングは最善だった")]
        [InlineData(3, DebriefReason.LossOutpaced, "仕掛けのタイミングは最善だった")]
        [InlineData(11, null, "仕掛けを前後に動かしても、着順は変わらなかった")]
        [InlineData(2, DebriefReason.LossEarlyWhip, "仕掛けを前後に動かしても、着順は変わらなかった")]
        [InlineData(3, DebriefReason.LossLateWhip, "仕掛けを前後に動かしても、着順は変わらなかった")]
        [InlineData(2, DebriefReason.LossWhipMash, "仕掛けを前後に動かしても、着順は変わらなかった")]
        public void TheBestTimingLineNeverContradictsThePlaceOrTheDebrief(int place, DebriefReason? reason, string expected)
        {
            var cf = new GoCounterfactual { Tactics = true, ActualPlace = place, BestPlace = place, ActualTimeMs = 120000, BestTimeMs = 120000 };
            cf.Reconcile(reason);
            Assert.Equal(expected, cf.Line);
        }

        [Fact]
        public void ABetterGoIsAlwaysNamedWhateverTheDebrief()
        {
            var cf = new GoCounterfactual { Tactics = true, ActualPlace = 9, BestPlace = 5, BestShiftTicks = -20, ActualTimeMs = 121000, BestTimeMs = 120400 };
            cf.Reconcile(DebriefReason.LossEarlyWhip);
            Assert.Equal("仕掛けがあと1.0秒早ければ5着", cf.Line);
        }

        [Fact]
        public void TheAssistNeverHoldsAndRidesBelowSkilledPlayOn14()
        {
            // §27: the whip assist's whips come after the (auto) go; it never presses in the window
            var cfg = Field(R14());
            var a = new InputAssistant(AssistLevel.Whip, 0);
            var sim = new RaceSim(cfg);
            var cmds = new byte[12];
            while (!sim.IsFinished)
            {
                Array.Clear(cmds, 0, 12);
                var h = sim.GetHorse(0);
                byte player = !h.Departed && sim.Tick >= cfg.Ruleset.GateOpenTick ? Cmd.Start : (byte)0;
                cmds[0] = a.Apply(sim, player);
                sim.Step(cmds);
            }
            Assert.DoesNotContain(sim.Events, e => e.Slot == 0 && e.Type == RaceEventType.Gather);
            Assert.Equal(-1, sim.Events.Single(e => e.Slot == 0 && e.Type == RaceEventType.Go).Value);
            Assert.Contains(sim.Events, e => e.Slot == 0 && e.Type == RaceEventType.Whip);
        }
    }
}
