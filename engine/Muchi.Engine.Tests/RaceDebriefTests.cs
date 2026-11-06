using Muchi.Client;
using Muchi.Engine;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-UXS-005: the one-line win/loss explanation.</summary>
    public class RaceDebriefTests
    {
        private static readonly RulesetParams Rs = TestUtil.Ruleset();

        private static RaceDebrief Tutorial(int[] whips, int attempt = 1)
        {
            var rec = new RaceDebriefRecorder(0);
            var race = TutorialOutcomeTests.Play(whips, attempt, 20261105, r => rec.Observe(r.Sim));
            var d = RaceDebrief.Build(race.Sim, rec);
            Assert.Equal(Array.IndexOf(race.Sim.Result.Order, 0) + 1, d.Place);
            return d;
        }

        // ------------------------------------------------------------ real races (tutorial)

        [Fact]
        public void TutorialWinWithTwoWhipsIsAWhipFinish()
        {
            var d = Tutorial(new[] { 250, 200 });
            Assert.True(d.Won);
            Assert.Equal(DebriefReason.WinWhipFinish, d.Reason);
            Assert.Equal("win_whip_finish", d.Code);
            Assert.Equal("残り250mのムチで差し切った", d.Line);
            Assert.False(string.IsNullOrEmpty(d.Tip));
        }

        [Fact]
        public void TutorialLossesNameTheWhipMistake()
        {
            var none = Tutorial(new int[0]);
            Assert.Equal((false, 2, DebriefReason.LossNoWhip), (none.Won, none.Place, none.Reason));
            Assert.Equal("ムチを使わなかった", none.Line);
            Assert.Contains("300m", none.Tip);

            var one = Tutorial(new[] { 200 });
            Assert.Equal(DebriefReason.LossTooFewWhips, one.Reason);
            Assert.StartsWith("残り300mからのムチが1回だけ。あと", one.Line);
            Assert.EndsWith("届かなかった", one.Line);

            Assert.Equal(DebriefReason.LossEarlyWhip, Tutorial(new[] { 399, 380, 360 }).Reason);
            Assert.Equal(DebriefReason.LossLateWhip, Tutorial(new[] { 40, 20 }).Reason);
        }

        [Fact]
        public void AssistedWinWithoutWhipsSaysTheHorseLasted()
        {
            var d = Tutorial(new int[0], attempt: 3);
            Assert.True(d.Won);
            Assert.Equal(DebriefReason.WinStaminaKept, d.Reason);
            Assert.Equal("最後まで脚が持った", d.Line);
            Assert.Contains("ムチを2回", d.Tip);
        }

        [Fact]
        public void FromTheInputLogEqualsTheLiveRecorder()
        {
            var rec = new RaceDebriefRecorder(0);
            var race = TutorialOutcomeTests.Play(new[] { 290, 150 }, 1, 20261105, r => rec.Observe(r.Sim));
            var live = RaceDebrief.Build(race.Sim, rec);
            var replay = RaceDebrief.FromInputs(race.Config, race.AllInputs(), 0);
            Assert.Equal((live.Reason, live.Line, live.Tip, live.Place), (replay.Reason, replay.Line, replay.Tip, replay.Place));
        }

        // ------------------------------------------------------------ real races (full engine rules)

        private static (RaceDebrief d, RaceSim sim) Run(RaceConfig cfg, Func<RaceSim, HorseState, byte> ride)
        {
            var rec = new RaceDebriefRecorder(0);
            var cmds = new byte[cfg.Entrants.Count];
            var sim = new RaceSim(cfg);
            while (!sim.IsFinished)
            {
                Array.Clear(cmds, 0, cmds.Length);
                cmds[0] = ride(sim, sim.GetHorse(0));
                sim.Step(cmds);
                rec.Observe(sim);
            }
            return (RaceDebrief.Build(sim, rec), sim);
        }

        private static long Rem(RaceSim s, HorseState h) => (s.Track.Distance - h.Distance).ToMilli();

        private static RaceConfig Field(HorseSpec me, int cpuStat, TrackSpec track, RulesetParams rs = null, ulong seed = 5)
        {
            var horses = new List<HorseSpec> { me };
            for (int i = 1; i < 6; i++) horses.Add(TestUtil.H("c" + i, cpuStat));
            return TestUtil.Cfg(track, rs ?? Rs, horses, 1, seed);
        }

        private static byte Start(RaceSim s, HorseState h) => !h.Departed && s.Tick >= s.P.GateOpenTick ? Cmd.Start : (byte)0;

        [Fact]
        public void StaminaThatRunsOutEarlyIsNamed()
        {
            var me = TestUtil.H("me", 500); me.Stamina = 0;
            var (d, _) = Run(Field(me, 600, TestUtil.CornerTrack(2400)), (s, h) => Start(s, h));
            Assert.False(d.Won);
            Assert.Equal(DebriefReason.LossStaminaEmpty, d.Reason);
            Assert.Matches("^残り\\d+mで脚が上がった$", d.Line);
            Assert.True(d.Facts.StaminaEmptyRemainingMm >= 50_000);
        }

        [Fact]
        public void KakariWithoutTheReinIsNamed()
        {
            var rs = TestUtil.Ruleset(("kakariChancePer100000PerTickAtTemper0", 3000), ("kakariDurationTicks", 200));
            var me = TestUtil.H("me", 500, temper: 0); me.Stamina = 100;
            var (d, _) = Run(Field(me, 600, TestUtil.CornerTrack(2400), rs), (s, h) => Start(s, h));
            Assert.False(d.Won);
            Assert.True(d.Facts.KakariCount > 0);
            Assert.Equal(DebriefReason.LossKakari, d.Reason);
            Assert.Equal("掛かって脚が早く尽きた", d.Line);
            Assert.Equal("掛かったら手綱を長押し", d.Tip);
        }

        [Fact]
        public void MashedWhipsAreNamed()
        {
            int whips = 0;
            var me = TestUtil.H("me", 480); me.Stamina = 1000;
            var (d, _) = Run(Field(me, 560, TestUtil.StraightTrack(1200)), (s, h) =>
            {
                if (!h.Departed) return Start(s, h);
                if (Rem(s, h) <= 300_000 && whips < 6) { whips++; return Cmd.Whip; } // six whips on six consecutive ticks
                return 0;
            });
            Assert.False(d.Won);
            Assert.True(d.Facts.MashedWhips >= 4);
            Assert.Equal(DebriefReason.LossWhipMash, d.Reason);
            Assert.Equal("ムチは間をあけて", d.Tip);
        }

        [Fact]
        public void RunningWideOnCornersIsNamed()
        {
            int whipTick = -100;
            var me = TestUtil.H("me", 560); me.Stamina = 1000;
            var (d, _) = Run(Field(me, 530, TestUtil.CornerTrack(2000)), (s, h) =>
            {
                if (!h.Departed) return Start(s, h);
                if (h.LaneTarget < 11 && !h.IsChangingLane) return Cmd.LaneOut; // drift to the outside lane and stay there
                if (Rem(s, h) <= 400_000 && h.WhipsLeft > 0 && s.Tick - whipTick >= 24) { whipTick = s.Tick; return Cmd.Whip; }
                return 0;
            });
            Assert.False(d.Won);
            Assert.True(d.Facts.WideLossMm >= 5_000, "wide loss " + d.Facts.WideLossMm);
            Assert.Equal(DebriefReason.LossWide, d.Reason);
            Assert.Matches("^コーナーで外を回り、\\d+m損した$", d.Line);
        }

        [Fact]
        public void AStrongHorseLeadingAllTheWayWinsFromTheFront()
        {
            var (d, _) = Run(Field(TestUtil.H("me", 900), 300, TestUtil.StraightTrack(1200)), (s, h) => Start(s, h));
            Assert.True(d.Won);
            Assert.Equal(DebriefReason.WinFromFront, d.Reason);
            Assert.Equal("先頭を譲らず逃げ切った", d.Line);
        }

        // ------------------------------------------------------------ every reason from facts

        private static RaceDebriefRecorder Facts(Action<RaceDebriefRecorder> set)
        {
            var f = new RaceDebriefRecorder(0) { RunningTicks = 1000 };
            set(f);
            return f;
        }

        private static void Whip(RaceDebriefRecorder f, long remMm, int rankBefore, bool spurt = true)
        {
            f.WhipCount++;
            f.WhipRemainingMm.Add(remMm);
            f.WhipRankBefore.Add(rankBefore);
            if (!spurt) f.EarlyWhips++;
            else if (f.FirstSpurtWhipRemainingMm < 0) { f.FirstSpurtWhipRemainingMm = remMm; f.RankAtFirstSpurtWhip = rankBefore; }
        }

        public static IEnumerable<object[]> Reasons => new[]
        {
            new object[] { DebriefReason.WinWhipFinish, 1, "残り200mのムチで3頭抜いた" },
            new object[] { DebriefReason.WinFromFront, 1, "先頭を譲らず逃げ切った" },
            new object[] { DebriefReason.WinSlipstream, 1, "前の馬の後ろで脚をため、最後に抜け出した" },
            new object[] { DebriefReason.WinStaminaKept, 1, "最後まで脚が持った" },
            new object[] { DebriefReason.LossKakari, 7, "掛かって脚が早く尽きた" },
            new object[] { DebriefReason.LossStaminaEmpty, 9, "残り250mで脚が上がった" },
            new object[] { DebriefReason.LossNoWhip, 4, "ムチを使わなかった" },
            new object[] { DebriefReason.LossEarlyWhip, 5, "ムチが早すぎて、あまり効かなかった" },
            new object[] { DebriefReason.LossLateWhip, 3, "ムチが残り50mからで遅かった" },
            new object[] { DebriefReason.LossWhipMash, 4, "ムチを連打して効きが落ちた" },
            new object[] { DebriefReason.LossBlocked, 3, "直線で前が詰まった" },
            new object[] { DebriefReason.LossWide, 2, "コーナーで外を回り、8m損した" },
            new object[] { DebriefReason.LossLateStart, 2, "出遅れが響いた" },
            new object[] { DebriefReason.LossOutpaced, 2, "勝ち馬まで1/2馬身届かなかった" },
        };

        [Theory]
        [MemberData(nameof(Reasons))]
        public void EveryReasonHasALineAndATip(DebriefReason reason, int place, string line)
        {
            var f = Facts(x =>
            {
                switch (reason)
                {
                    case DebriefReason.WinWhipFinish: Whip(x, 200_000, 3); break;
                    case DebriefReason.WinFromFront: x.LedTicks = 800; break;
                    case DebriefReason.WinSlipstream: x.SlipstreamTicks = 400; break;
                    case DebriefReason.LossKakari: x.KakariCount = 2; x.KakariUnreinedTicks = 60; x.StaminaEmptyRemainingMm = 600_000; break;
                    case DebriefReason.LossStaminaEmpty: x.StaminaEmptyRemainingMm = 250_000; Whip(x, 300_000, 2); break;
                    case DebriefReason.LossEarlyWhip: Whip(x, 900_000, 3, false); Whip(x, 850_000, 3, false); Whip(x, 300_000, 3); break;
                    case DebriefReason.LossLateWhip: Whip(x, 50_000, 3); break;
                    case DebriefReason.LossWhipMash: for (int i = 0; i < 4; i++) Whip(x, 300_000 - i * 1000, 3); x.MashedWhips = 3; break;
                    case DebriefReason.LossBlocked: Whip(x, 300_000, 3); x.BlockedFinalTicks = 40; break;
                    case DebriefReason.LossWide: Whip(x, 300_000, 3); x.WideLossMm = 8_400; break;
                    case DebriefReason.LossLateStart: Whip(x, 300_000, 3); x.LateStart = true; break;
                    case DebriefReason.LossOutpaced: Whip(x, 300_000, 3); break;
                }
            });
            var d = RaceDebrief.FromFacts(f, place, 12, 1_200, tutorial: false);
            Assert.Equal(reason, d.Reason);
            Assert.Equal(line, d.Line);
            Assert.False(string.IsNullOrWhiteSpace(d.Tip));
            Assert.Equal(place == 1, d.Won);
            Assert.Equal(d.Won, d.IsWinReason);
            Assert.Equal(RaceDebrief.CodeOf(reason), d.Code);
            Assert.True(d.Line.Length <= 30, "one short line: " + d.Line);
        }

        [Fact]
        public void TheSameFactsNeverFlipTheVerdict()
        {
            // whatever happened, a win gets a win line and a loss a loss line
            var f = Facts(x => { x.KakariCount = 3; x.KakariUnreinedTicks = 100; x.StaminaEmptyRemainingMm = 500_000; x.LateStart = true; });
            Assert.Equal(DebriefReason.WinStaminaKept, RaceDebrief.FromFacts(f, 1, 8, 300, false).Reason);
            Assert.Equal(DebriefReason.LossKakari, RaceDebrief.FromFacts(f, 2, 8, 300, false).Reason);
        }

        [Fact]
        public void MarginsInRacingTerms()
        {
            Assert.Equal("ハナ", RaceFeel.MarginText(100));
            Assert.Equal("クビ", RaceFeel.MarginText(600));
            Assert.Equal("1/2馬身", RaceFeel.MarginText(1200));
            Assert.Equal("1馬身", RaceFeel.MarginText(2400));
            Assert.Equal("1馬身半", RaceFeel.MarginText(3600));
            Assert.Equal("3馬身", RaceFeel.MarginText(7300));
            Assert.Equal("大差", RaceFeel.MarginText(30_000));
        }

        /// <summary>Random rides in real races: deterministic, and the line always agrees with the result.</summary>
        [Fact]
        public void RandomRacesNeverContradictTheResult()
        {
            var rnd = new Random(4242);
            for (int n = 0; n < 40; n++)
            {
                int seed = rnd.Next();
                var track = n % 2 == 0 ? TestUtil.CornerTrack(1600) : TestUtil.StraightTrack(1000);
                var cfg = Field(TestUtil.H("me", 400 + rnd.Next(300), temper: rnd.Next(1000)), 450 + rnd.Next(150), track, null, (ulong)seed);
                RaceDebrief Once()
                {
                    var r = new Random(seed);
                    return Run(cfg, (s, h) =>
                    {
                        if (!h.Departed) return r.Next(4) == 0 ? (byte)0 : Start(s, h);
                        int k = r.Next(60);
                        return k == 0 ? Cmd.Whip : k == 1 ? Cmd.LaneOut : k == 2 ? Cmd.LaneIn : k == 3 ? Cmd.ReinPress : k == 4 ? Cmd.ReinRelease : (byte)0;
                    }).d;
                }
                var a = Once();
                var b = Once();
                Assert.Equal((a.Reason, a.Line, a.Tip), (b.Reason, b.Line, b.Tip));
                Assert.Equal(a.Place == 1, a.Won);
                Assert.Equal(a.Won, a.IsWinReason);
                Assert.False(string.IsNullOrEmpty(a.Line) || string.IsNullOrEmpty(a.Tip));
            }
        }
    }
}
