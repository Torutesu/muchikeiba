using Muchi.Client;
using Muchi.Engine;

namespace Muchi.Engine.Tests
{
    public class ClientOfflineTests
    {
        private static int PlaceOf(RaceSim sim, int slot) => Array.IndexOf(sim.Result.Order, slot) + 1;

        /// <summary>Plays the tutorial; whipFrom = remaining meters at which whipping starts (-1 = never).</summary>
        internal static OfflineRace PlayTutorial(int whipFromM, int whipInterval = 24, int maxWhips = 6, ulong seed = 20261105)
        {
            var race = new OfflineRace(OfflinePresets.Tutorial(TestUtil.Ruleset(), seed), OfflinePresets.TutorialPlayerSlot) { AutoStart = true };
            int whips = 0, last = -1000;
            while (!race.IsFinished)
            {
                var sim = race.Sim;
                var me = sim.GetHorse(0);
                var left = sim.Track.Distance - me.Distance;
                if (whipFromM >= 0 && me.Departed && whips < maxWhips && left <= Fx.FromInt(whipFromM) && sim.Tick - last >= whipInterval)
                {
                    race.Input(Cmd.Whip);
                    whips++;
                    last = sim.Tick;
                }
                race.StepOnce();
            }
            return race;
        }

        private static int Wins(int whipFromM, int seeds = 60)
        {
            int w = 0;
            for (ulong s = 1; s <= (ulong)seeds; s++) if (PlaceOf(PlayTutorial(whipFromM, seed: s).Sim, 0) == 1) w++;
            return w;
        }

        [Theory]
        [InlineData(400)]
        [InlineData(300)]
        [InlineData(200)]
        public void TutorialIsWonWithSensibleWhipTiming(int whipFromM)
        {
            Assert.True(Wins(whipFromM) >= 58, "a whip from " + whipFromM + "m out should almost always win");
            Assert.Equal(1, PlaceOf(PlayTutorial(whipFromM).Sim, 0)); // the shipped seed always wins
        }

        [Fact]
        public void TutorialIsLostWithoutWhipOrWithAVeryLateWhip()
        {
            Assert.True(Wins(-1) <= 2, "no whip should almost never win");
            Assert.True(Wins(60) <= 3, "whipping only in the last 60m should almost never win");
            Assert.NotEqual(1, PlaceOf(PlayTutorial(-1).Sim, 0)); // the shipped seed loses without the whip
        }

        [Fact]
        public void TutorialIsShortAndOnlyNeedsTheWhip()
        {
            var race = PlayTutorial(300);
            long ms = race.FinishTimeMs(0);
            Assert.InRange(ms, 15_000, 35_000); // a short, final-straight-only race
            Assert.True(race.Sim.GetHorse(0).Departed);
            Assert.Single(race.Sim.Track.Spec.Segments);
        }

        [Fact]
        public void FixedStepDriverFollowsTheClockAndPauses()
        {
            var race = new OfflineRace(OfflinePresets.Tutorial(TestUtil.Ruleset()), 0) { AutoStart = true };
            race.Start(1000);
            race.Update(1000 + 50 * 7 + 10);
            Assert.Equal(7, race.Sim.Tick);
            race.Pause(1360);
            race.Update(5000);
            Assert.Equal(7, race.Sim.Tick);
            race.Resume(5000);
            race.Update(5000 + 50 * 3);
            Assert.Equal(10, race.Sim.Tick);
            // a long frame hitch only advances MaxCatchUpTicks and then slides the timeline
            race.Update(5000 + 50 * 3 + 10_000);
            Assert.Equal(10 + race.MaxCatchUpTicks, race.Sim.Tick);
            race.Update(5000 + 50 * 3 + 10_000 + 50);
            Assert.Equal(11 + race.MaxCatchUpTicks, race.Sim.Tick);
        }

        [Fact]
        public void InputsAreAppliedOnTheNextTickOnly()
        {
            var race = new OfflineRace(OfflinePresets.Tutorial(TestUtil.Ruleset()), 0) { AutoStart = true };
            while (!race.Sim.GetHorse(0).Departed) race.StepOnce();
            for (int i = 0; i < 40; i++) race.StepOnce();
            int before = race.Sim.GetHorse(0).WhipsLeft;
            race.Input(Cmd.Whip);
            race.StepOnce();
            Assert.Equal(before - 1, race.Sim.GetHorse(0).WhipsLeft);
            race.StepOnce();
            Assert.Equal(before - 1, race.Sim.GetHorse(0).WhipsLeft);
        }

        [Fact]
        public void OfflineRaceIsDeterministic()
        {
            var a = PlayTutorial(300);
            var b = PlayTutorial(300);
            Assert.Equal(a.Sim.Result.Hash, b.Sim.Result.Hash);
        }

        [Fact]
        public void TimeAttackReportsAFinishTime()
        {
            var cfg = OfflinePresets.TimeAttack(Muchi.Verifier.SampleRaces.Turf1600(), TestUtil.H("ta", 600), TestUtil.Ruleset());
            var race = new OfflineRace(cfg, 0) { AutoStart = true };
            while (!race.IsFinished) race.StepOnce();
            Assert.InRange(race.FinishTimeMs(0), 60_000, 100_000);
        }
    }
}
