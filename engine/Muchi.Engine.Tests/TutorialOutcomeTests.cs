using Muchi.Client;
using Muchi.Engine;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-UXS-004: the tutorial's outcome is fixed by the whip rule, for every input pattern and seed.</summary>
    public class TutorialOutcomeTests
    {
        private static readonly RulesetParams Rs = TestUtil.Ruleset();

        /// <summary>Plays the tutorial pressing WHIP once at each remaining distance in <paramref name="whipAtM"/> (descending).
        /// One whip per tick at most; <paramref name="whippedAtMm"/> gets the remaining distance (mm, as the director
        /// sees it before the tick) of every whip that reached the engine.</summary>
        internal static OfflineRace Play(int[] whipAtM, int attempt = 1, ulong seed = 20261105, Action<OfflineRace> onTick = null, List<long> whippedAtMm = null)
        {
            var race = OfflinePresets.TutorialRace(Rs, attempt, seed);
            if (onTick != null) race.Stepped += onTick;
            int k = 0;
            while (!race.IsFinished)
            {
                var me = race.Sim.GetHorse(OfflinePresets.TutorialPlayerSlot);
                long rem = (race.Sim.Track.Distance - me.Distance).ToMilli();
                if (me.Departed && k < whipAtM.Length && rem <= whipAtM[k] * 1000L)
                {
                    race.Input(Cmd.Whip);
                    k++;
                    if (me.WhipsLeft > 0) whippedAtMm?.Add(rem);
                }
                race.StepOnce();
            }
            return race;
        }

        private static int PlaceOf(OfflineRace r) => Array.IndexOf(r.Sim.Result.Order, OfflinePresets.TutorialPlayerSlot) + 1;
        private static TutorialDirector Dir(OfflineRace r) => (TutorialDirector)r.Director;

        public static IEnumerable<object[]> Table => new[]
        {
            // whips (remaining m)             attempt  place
            new object[] { new int[0],                       1, 2 },
            new object[] { new[] { 250 },                    1, 2 },
            new object[] { new[] { 150 },                    2, 2 },
            new object[] { new[] { 300, 280 },               1, 1 },
            new object[] { new[] { 250, 200 },               1, 1 },
            new object[] { new[] { 120, 60 },                1, 1 },
            new object[] { new[] { 200, 199, 198 },          1, 1 }, // mashed still wins
            new object[] { new[] { 300, 250, 200, 150, 100, 60 }, 1, 1 },
            new object[] { new[] { 399, 380, 360, 340, 320 }, 1, 2 }, // all before the window: they do not count
            new object[] { new[] { 399, 380, 360, 340, 320, 200 }, 1, 2 },
            new object[] { new[] { 45, 30, 10 },             1, 2 }, // too late to count
            new object[] { new[] { 100, 40 },                1, 2 }, // one counted, one too late
            new object[] { new int[0],                       2, 2 },
            new object[] { new int[0],                       3, 1 }, // assisted
            new object[] { new[] { 250 },                    3, 1 },
            new object[] { new[] { 399, 380 },               4, 1 },
        };

        [Theory]
        [MemberData(nameof(Table))]
        public void BehaviourTable(int[] whips, int attempt, int expectedPlace)
        {
            var r = Play(whips, attempt);
            Assert.Equal(expectedPlace, PlaceOf(r));
            Assert.Equal(expectedPlace == 1 ? TutorialOutcome.Win : TutorialOutcome.CloseSecond, Dir(r).Outcome);
            Assert.Equal(OfflinePresets.TutorialRivalSlot, r.Sim.Result.Order[expectedPlace == 1 ? 1 : 0]); // the rival takes the other of the top two
            long margin = r.Sim.Result.Margins[1].ToMilli();
            if (expectedPlace == 2) Assert.InRange(margin, 300, 2_000); // a close 2nd: under 1 length behind the rival
            else Assert.True(margin > 0);
        }

        [Fact]
        public void TheRuleItself()
        {
            Assert.Equal(TutorialOutcome.CloseSecond, TutorialDirector.Expected(0, 1));
            Assert.Equal(TutorialOutcome.CloseSecond, TutorialDirector.Expected(1, 2));
            Assert.Equal(TutorialOutcome.Win, TutorialDirector.Expected(2, 1));
            Assert.Equal(TutorialOutcome.Win, TutorialDirector.Expected(0, 3));
            Assert.True(TutorialDirector.CountsAt(300_000) && TutorialDirector.CountsAt(50_000));
            Assert.False(TutorialDirector.CountsAt(300_001) || TutorialDirector.CountsAt(49_999));
        }

        /// <summary>Patterns × attempts × seeds: the finishing place always follows the rule.</summary>
        [Fact]
        public void SweepPatternsAndSeeds()
        {
            int[] spots = { 400, 330, 300, 260, 200, 150, 100, 70, 51, 45, 20, 3 };
            var patterns = new List<int[]> { new int[0] };
            foreach (var a in spots)
            {
                patterns.Add(new[] { a });
                patterns.Add(new[] { a, a - 1, a - 2, a - 3, a - 4, a - 5 }); // mashing
                foreach (var b in spots) if (b < a) patterns.Add(new[] { a, b });
            }
            var rnd = new Random(20261106);
            for (int i = 0; i < 60; i++)
            {
                var l = new List<int>();
                int n = rnd.Next(1, 8);
                for (int j = 0; j < n; j++) l.Add(rnd.Next(0, 401));
                l.Sort(); l.Reverse();
                patterns.Add(l.ToArray());
            }
            int runs = 0;
            foreach (ulong seed in new ulong[] { 20261105, 7, 99_999 })
                for (int attempt = 1; attempt <= 3; attempt++)
                    foreach (var p in patterns)
                    {
                        var at = new List<long>();
                        var r = Play(p, attempt, seed, null, at);
                        int counted = at.Count(TutorialDirector.CountsAt);
                        Assert.Equal(counted, Dir(r).CountedWhips);
                        int expected = TutorialDirector.Expected(counted, attempt) == TutorialOutcome.Win ? 1 : 2;
                        Assert.True(PlaceOf(r) == expected, "whips [" + string.Join(",", p) + "] attempt " + attempt + " seed " + seed + ": place " + PlaceOf(r) + ", expected " + expected);
                        runs++;
                    }
            Assert.True(runs > 1000);
        }

        /// <summary>Many seeds with the typical patterns (no whip, one, two, assisted).</summary>
        [Fact]
        public void SweepManySeeds()
        {
            for (ulong seed = 1; seed <= 150; seed++)
            {
                Assert.Equal(2, PlaceOf(Play(new int[0], 1, seed)));
                Assert.Equal(2, PlaceOf(Play(new[] { 200 }, 2, seed)));
                Assert.Equal(1, PlaceOf(Play(new[] { 250, 180 }, 1, seed)));
                Assert.Equal(1, PlaceOf(Play(new int[0], 3, seed)));
            }
        }

        [Fact]
        public void DeterministicAndReplaysFromAllInputs()
        {
            var a = Play(new[] { 280, 190, 189 });
            var b = Play(new[] { 280, 190, 189 });
            Assert.Equal(a.Sim.Result.Hash, b.Sim.Result.Hash);
            Assert.NotEmpty(a.DirectorInputs);
            Assert.All(a.DirectorInputs, i => Assert.Equal(OfflinePresets.TutorialRivalSlot, i.Slot));
            Assert.Equal(a.Sim.Result.Hash, RaceReplay.Run(a.Config, a.AllInputs()).Result.Hash);
        }

        [Fact]
        public void PlayerHasOnlyTheWhipAndRivalIsAutoAttached()
        {
            // the plain preset + OfflineRace (old call sites, the WASM prototype) gets the director too, attempt 1
            var race = new OfflineRace(OfflinePresets.Tutorial(Rs), OfflinePresets.TutorialPlayerSlot) { AutoStart = true };
            Assert.IsType<TutorialDirector>(race.Director);
            Assert.Equal(1, Dir(race).Attempt);
            while (!race.Sim.GetHorse(0).Departed) race.StepOnce();
            race.Input(Cmd.LaneOut | Cmd.ReinPress);
            race.StepOnce();
            var me = race.Sim.GetHorse(0);
            Assert.False(me.Reining);
            Assert.Equal(0, me.LaneTarget);
            Assert.DoesNotContain(race.RecordedInputs, i => (i.Cmd & ~(Cmd.Start | Cmd.Whip)) != 0);
        }

        [Fact]
        public void OtherModesHaveNoDirector()
        {
            var ta = new OfflineRace(OfflinePresets.TimeAttack(Muchi.Verifier.SampleRaces.Turf1600(), TestUtil.H("ta", 600), Rs), 0);
            Assert.Null(ta.Director);
            var practice = new OfflineRace(TestUtil.Cfg(TestUtil.StraightTrack(1200), Rs, new[] { TestUtil.H("a"), TestUtil.H("b") }, 1), 0);
            Assert.Null(practice.Director);
            // the online/ranked ruleset is untouched: the tutorial's overrides live on a copy
            Assert.Equal(950, Rs.ReinSpeedPermille);
            Assert.Equal(OfflinePresets.TutorialReinSpeedPermille, OfflinePresets.Tutorial(Rs).Ruleset.ReinSpeedPermille);
        }
    }
}
