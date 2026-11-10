using System.Globalization;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Net;
using Muchi.Verifier;

namespace Muchi.Engine.Tests
{
    /// <summary>
    /// A player who holds the whip button (REQ-A11Y-012): the inner rider plays everything else, its own whips are
    /// dropped, and the button is held from <c>holdFromM</c> metres out to the line. With <c>holdFromM</c> = 0 it holds
    /// from the best point for the hold's spacing (the strongest possible hold player).
    /// </summary>
    public sealed class HoldRider : IRider
    {
        private readonly IRider _inner;
        private readonly int _holdFromM;
        public readonly WhipHold Hold = new WhipHold();
        public readonly List<(int tick, byte cmd)> HoldCmds = new List<(int, byte)>();
        private bool _holding;
        public HoldRider(IRider inner, int holdFromM = 0) { _inner = inner; _holdFromM = holdFromM; }
        public void Reset(RaceSim sim, int slot, ulong seed) { _inner.Reset(sim, slot, seed); Hold.Reset(); HoldCmds.Clear(); _holding = false; }
        public byte Decide(RaceSim sim, int slot, int tick)
        {
            var me = sim.GetHorse(slot);
            byte c = _inner.Decide(sim, slot, tick);
            if (me.Departed) c = (byte)(c & ~Cmd.Whip);
            long rem = (sim.Track.Distance - me.Distance).Raw >> 16;
            if (me.Departed && !_holding)
            {
                int spacing = WhipHold.Spacing(sim.P);
                long speedMm = Math.Max(1, me.Speed.Raw * 1000 >> 16);
                long needM = (long)Math.Min(me.WhipsLeft, 1 + WhipHold.MaxRepeats(sim.P)) * spacing * speedMm / 1000 / sim.Config.Net.TickHz;
                _holding = _holdFromM > 0 ? rem <= _holdFromM : rem <= needM + 15 && rem <= sim.SpurtZoneM;
            }
            byte h = Hold.Next(sim, slot, _holding);
            if (h != 0) HoldCmds.Add((tick, h));
            return (byte)(c | h);
        }
    }

    public class AccessibilityTests
    {
        private readonly Xunit.Abstractions.ITestOutputHelper _out;
        public AccessibilityTests(Xunit.Abstractions.ITestOutputHelper output) { _out = output; }

        private static JsonNode Contract() => JsonNode.Parse(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "contracts", "a11y-tokens.json")));

        [Fact]
        public void TokensEqualTheContractAndAreReadableOnNavy()
        {
            var c = Contract();
            Assert.Equal(AccessibilityTokens.Background, c.Get("background").AsString());
            foreach (var (mode, table) in new[] { ("standard", AccessibilityTokens.Standard), ("cvd", AccessibilityTokens.Cvd) })
            {
                var m = c.Get("modes").Get(mode);
                Assert.Equal(m.Count, table.Count);
                foreach (var kv in m.Props) Assert.Equal(kv.Value.AsString(), table[kv.Key]);
                foreach (var n in AccessibilityTokens.Names)
                {
                    double min = n.StartsWith("status.") ? 4.5 : 3.0;
                    Assert.True(AccessibilityTokens.Contrast(table[n], AccessibilityTokens.Background) >= min, mode + " " + n);
                }
            }
            Assert.Equal("#00d2ed", AccessibilityTokens.Color(ColorMode.Cvd, AccessibilityTokens.GaugeOk)); // the cyan tone stays
            Assert.Equal("#cc6633", AccessibilityTokens.Color(ColorMode.Cvd, AccessibilityTokens.GaugeCritical));
            Assert.True(AccessibilityTokens.CriticalHatch(ColorMode.Cvd));
            Assert.False(AccessibilityTokens.CriticalHatch(ColorMode.Standard));
            Assert.Throws<KeyNotFoundException>(() => AccessibilityTokens.Color(ColorMode.Standard, "gauge.typo"));
            Assert.Equal(21.0, AccessibilityTokens.Contrast("#ffffff", "#000000"), 6);
        }

        [Fact]
        public void SettingsParseRoundTripAndFallBackToDefaults()
        {
            var d = AccessibilitySettings.Defaults;
            Assert.Equal(TextSize.Standard, d.TextSize);
            Assert.True(d.Haptics && d.Subtitles && !d.ReduceMotion);
            Assert.Equal(WhipInput.Tap, d.WhipInput);
            const string server = "{\"textSize\":\"largest\",\"colorMode\":\"cvd\",\"reduceMotion\":true,\"haptics\":false,\"subtitles\":false,\"oneHanded\":\"left\",\"whipInput\":\"hold\",\"rev\":3,\"updatedAt\":1797000000000,\"textScale\":{\"standard\":1,\"large\":1.15,\"largest\":1.3},\"rules\":{\"affectsRace\":false}}";
            var s = AccessibilitySettings.Parse(server);
            Assert.Equal(TextSize.Largest, s.TextSize);
            Assert.Equal(ColorMode.Cvd, s.ColorMode);
            Assert.True(s.ReduceMotion);
            Assert.False(s.Haptics);
            Assert.False(s.Subtitles);
            Assert.Equal(OneHandedLayout.Left, s.OneHanded);
            Assert.Equal(WhipInput.Hold, s.WhipInput);
            Assert.Equal(3, s.Rev);
            Assert.Equal(1797000000000L, s.UpdatedAt);
            var back = AccessibilitySettings.Parse(s.ToLocalJson());
            Assert.True(back.SameValues(s));
            Assert.Equal(3, back.Rev);
            // the PUT body: exactly the seven keys
            var body = s.ToBody();
            Assert.Equal(new[] { "textSize", "colorMode", "reduceMotion", "haptics", "subtitles", "oneHanded", "whipInput" }, body.Props.Select(p => p.Key).ToArray());
            // unknown values / types / garbage → defaults, never an exception
            var odd = AccessibilitySettings.Parse("{\"textSize\":\"huge\",\"colorMode\":\"mono\",\"haptics\":\"no\",\"subtitles\":0,\"oneHanded\":\"both\",\"whipInput\":\"auto\"}");
            Assert.True(odd.SameValues(AccessibilitySettings.Defaults));
            Assert.True(AccessibilitySettings.Parse("{not json").SameValues(AccessibilitySettings.Defaults));
            Assert.True(AccessibilitySettings.Parse((string)null).SameValues(AccessibilitySettings.Defaults));
            var clone = s.Clone(); clone.Haptics = true;
            Assert.False(clone.SameValues(s));
        }

        [Fact]
        public async Task ApiGetPutAndThePlayerView()
        {
            var http = new FakeHttp();
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            var api = new ApiClient(http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
            http.Reply(200, "{\"textSize\":\"standard\",\"colorMode\":\"standard\",\"reduceMotion\":false,\"haptics\":true,\"subtitles\":true,\"oneHanded\":\"off\",\"whipInput\":\"tap\",\"rev\":0,\"updatedAt\":null}");
            var g = await api.GetAccessibilityAsync();
            Assert.Equal("GET", http.Requests[0].Method);
            Assert.Equal("/v1/settings/accessibility", http.Requests[0].Path);
            Assert.Null(g.UpdatedAt);
            // PUT is idempotent (a full replace), so a 503 is retried without an idempotency key
            http.Reply(503, "{\"error\":{\"code\":\"INTERNAL\"}}").Reply(200, "{\"textSize\":\"large\",\"colorMode\":\"standard\",\"reduceMotion\":true,\"haptics\":true,\"subtitles\":true,\"oneHanded\":\"right\",\"whipInput\":\"tap\",\"rev\":1,\"updatedAt\":5}");
            var want = AccessibilitySettings.Defaults; want.TextSize = TextSize.Large; want.ReduceMotion = true; want.OneHanded = OneHandedLayout.Right;
            var p = await api.SetAccessibilityAsync(want);
            Assert.Equal(3, http.Requests.Count);
            Assert.Equal("PUT", http.Requests[1].Method);
            Assert.Equal(http.Requests[1].Body, http.Requests[2].Body);
            Assert.Equal("{\"textSize\":\"large\",\"colorMode\":\"standard\",\"reduceMotion\":true,\"haptics\":true,\"subtitles\":true,\"oneHanded\":\"right\",\"whipInput\":\"tap\"}", http.Requests[1].Body);
            Assert.True(p.SameValues(want));
            Assert.Equal(1, p.Rev);
        }

        [Fact]
        public void TextScaleMotionAndFlashes()
        {
            Assert.Equal(1.0f, TextScale.Factor(TextSize.Standard));
            Assert.Equal(16f * 1.3f, TextScale.Px(16, TextSize.Largest), 3);
            Assert.Equal(32f, TextScale.Px(32, TextSize.Largest));   // headings stay
            Assert.Equal(16f, TextScale.MinPx(16, false));            // Japanese never below standard
            Assert.Equal(16f * 0.66f, TextScale.MinPx(16, true), 3);

            var normal = MotionPolicy.For(false);
            Assert.Equal(1f, normal.CameraShakeScale);
            Assert.Equal(380, normal.RevealGlowMs(380));
            var reduced = MotionPolicy.For(true);
            Assert.Equal(0f, reduced.CameraShakeScale);
            Assert.Equal(0f, reduced.FovKickScale);
            Assert.False(reduced.SpeedLines || reduced.BackgroundDrift || reduced.GaugeBlink);
            Assert.Equal(0, reduced.RevealGlowMs(380));
            Assert.Equal(150, reduced.RevealFlipMs(600));
            Assert.Equal(150, reduced.TransitionMs(340));
            Assert.Equal(100, reduced.TransitionMs(100));

            var f = new FlashLimiter();
            Assert.True(f.TryFlash(0) && f.TryFlash(100) && f.TryFlash(200));
            Assert.False(f.TryFlash(300));   // a 4th light inside one second
            Assert.False(f.TryFlash(999));
            Assert.True(f.TryFlash(1000));   // the first one left the window
            // a burst of overtakes every frame never lights more than 3 times in any 1 s window
            var g = new FlashLimiter(); var lit = new List<long>();
            for (long t = 0; t < 10_000; t += 16) if (g.TryFlash(t)) lit.Add(t);
            for (int i = 3; i < lit.Count; i++) Assert.True(lit[i] - lit[i - 3] >= 1000);
            // the prototype's repeating blinks (site/style.css): stamina 0.4 s steps, whip chance 0.45 s alternate
            Assert.True(FlashLimiter.BlinkRate(0.4, false) <= 3);
            Assert.True(FlashLimiter.BlinkRate(0.45, true) <= 3);
            Assert.True(FlashLimiter.BlinkRate(0.3, false) > 3);
        }

        private static RaceConfig Cfg(RaceMode mode, ulong seed)
        {
            var horses = new List<HorseSpec>();
            for (int i = 0; i < 8; i++) horses.Add(SampleRaces.Horse("h" + i, 500, (RunningStyle)(i % 4), 500));
            return BalanceHarness.Config("hold_" + seed, SeedMix.Mix(seed), SampleRaces.Turf2000(), TestUtil.Ruleset(), horses, new HashSet<int> { 0 }, _ => 3, mode);
        }

        [Fact]
        public void HoldSendsTapBytesAtTheAssistSpacingOncePerTick()
        {
            var cfg = Cfg(RaceMode.Ranked, 41);
            var rider = new HoldRider(new SkilledRider());
            var sim = BalanceHarness.Run(cfg, new Dictionary<int, IRider> { [0] = rider }, 41);
            Assert.True(sim.IsFinished);
            int spacing = WhipHold.Spacing(cfg.Ruleset);
            Assert.Equal(Math.Max(cfg.Ruleset.WhipEffectTicks, cfg.Ruleset.WhipDiminishWindowTicks) + InputAssistant.WhipSpacingExtraTicks, spacing);
            var whips = rider.HoldCmds.Where(x => x.cmd == Cmd.Whip).Select(x => x.tick).ToList();
                        Assert.Equal(2, WhipHold.MaxRepeats(cfg.Ruleset));           // 6 whips: half automatic (press + 2)
            Assert.Equal(1 + WhipHold.MaxRepeats(cfg.Ruleset), whips.Count); // one held press; the rest would be taps
            for (int i = 1; i < whips.Count; i++) Assert.True(whips[i] - whips[i - 1] >= spacing, "spacing " + (whips[i] - whips[i - 1]));
            Assert.All(rider.HoldCmds, x => Assert.True(x.cmd == Cmd.Whip || x.cmd == Cmd.Start));
            Assert.Equal(rider.HoldCmds.Count, rider.HoldCmds.Select(x => x.tick).Distinct().Count());
            // never a mashed whip (inside the diminish window)
            Assert.Equal(whips.Count - 1, rider.Hold.Repeats);
        }

        [Fact]
        public void HoldPressIsATapAndTheTutorialNeverRepeats()
        {
            var sim = new RaceSim(Cfg(RaceMode.Ranked, 7));
            var h = new WhipHold();
            Assert.Equal(0, h.Next(sim, 0, false));
            Assert.Equal(Cmd.Start, h.Next(sim, 0, true));   // before departure the press is START…
            Assert.Equal(0, h.Next(sim, 0, true));           // …and holding it does not repeat
            var tut = new RaceSim(Cfg(RaceMode.Tutorial, 8));
            var cmds = new byte[8];
            while (!tut.GetHorse(0).Departed) { cmds[0] = tut.Tick >= tut.P.GateOpenTick ? Cmd.Start : (byte)0; tut.Step(cmds); }
            cmds[0] = 0;
            var th = new WhipHold();
            Assert.Equal(Cmd.Whip, th.Next(tut, 0, true));   // the press is a whip, like a tap
            for (int i = 0; i < 200 && !tut.IsFinished; i++) { tut.Step(cmds); Assert.Equal(0, th.Next(tut, 0, true)); }
            Assert.Equal(0, th.Repeats);
            Assert.Equal(0, new WhipHold().Next(null, 0, true));
        }

        /// <summary>
        /// REQ-A11Y-012 / §27.2, measured with the R11 tools (same horse, same race, 240 seeds, every style and gate):
        /// 1) the strongest hold player (one press at the best point for the hold's rhythm, skilled everywhere else)
        ///    finishes exactly where a skilled rider tapping the same whips does — a hold is a tap sequence;
        /// 2) it stays below the best tapping plan of the harness (SkilledRider over a sweep of whip spacings) and not
        ///    above the R11 SkilledRider: win-rate ratio below 1.0, worse average place, head to head below half.
        /// Findings while writing this: the default SkilledRider (spacing = the diminish window, 20 ticks) is not the
        /// strongest tapper — a wider rhythm (about 32 ticks) wins more; and the whip window is forgiving, so an unlimited
        /// held rhythm (all 6 whips) rode level with the best tapping (head to head 51.7 %). The repeat budget
        /// (maxWhips / 2 − 1: one press gives half the whips) is what puts the hold under skilled play.
        /// </summary>
        [Fact]
        public void HoldIsCappedBelowSkilledPlay()
        {
            var rs = TestUtil.Ruleset();
            var track = SampleRaces.Turf2000();
            const int races = 240;
            int holdSpacing = WhipHold.Spacing(rs);
            (int wins, long places, int[] each) Measure(Func<IRider> make)
            {
                int wins = 0; long places = 0; var each = new int[races];
                for (int r = 0; r < races; r++)
                {
                    ulong seed = 7_300_000UL + (ulong)r * 7919UL;
                    var rng = new Pcg32(seed, 5);
                    var horses = new List<HorseSpec>();
                    for (int i = 0; i < 12; i++) horses.Add(SampleRaces.RandomHorse(ref rng, "f" + i, 500, 150));
                    int slot = r % 12;
                    horses[slot] = SampleRaces.Horse("me", 500, (RunningStyle)(r / 12 % 4), 500);
                    var cfg = BalanceHarness.Config("hc_" + r, SeedMix.Mix(seed), track, rs, horses, new HashSet<int> { slot }, _ => 3);
                    int pl = BalanceHarness.PlaceOf(BalanceHarness.Run(cfg, new Dictionary<int, IRider> { [slot] = make() }, seed), slot);
                    each[r] = pl; places += pl + 1; if (pl == 0) wins++;
                }
                return (wins, places, each);
            }
            var hold = Measure(() => new HoldRider(new SkilledRider()));
            var sameRhythm = Measure(() => new CappedTapper(holdSpacing, 1 + WhipHold.MaxRepeats(rs)));
            int same = Enumerable.Range(0, races).Count(i => hold.each[i] == sameRhythm.each[i]);
            Assert.True(same >= races * 95 / 100, "a hold rides like tapping the same rhythm: " + same + "/" + races);
            var r11 = Measure(() => new SkilledRider());
            var best = (spacing: 0, wins: -1, places: 0L);
            foreach (int sp in new[] { 0, 28, 32, 36 })
            {
                var m = Measure(() => new SkilledRider { WhipSpacing = sp });
                if (m.wins > best.wins) best = (sp, m.wins, m.places);
            }
            int bestSpacing = best.spacing;
            double duel = AssistHarness.Duel(rs, () => new HoldRider(new SkilledRider()), () => new SkilledRider { WhipSpacing = bestSpacing }, races, 7_400_000UL, track);
            double duelR11 = AssistHarness.Duel(rs, () => new HoldRider(new SkilledRider()), () => new SkilledRider(), races, 7_400_000UL, track);
            double duelNone = AssistHarness.Duel(rs, () => new HoldRider(new SkilledRider()), () => new NoInputRider(), races, 7_400_000UL, track);
            string msg = string.Format(CultureInfo.InvariantCulture,
                "hold (spacing {0}) wins {1} avg place {2:F2} | same rhythm tapped: wins {3}, same place in {4}/{5} | best tapping (spacing {6}) wins {7} avg place {8:F2} | ratio {9:F2} | duel hold>best {10:P1} hold>R11 skilled {11:P1} hold>no input {12:P1} | R11 skilled wins {13}",
                holdSpacing, hold.wins, (double)hold.places / races, sameRhythm.wins, same, races, bestSpacing, best.wins, (double)best.places / races,
                best.wins <= 0 ? 0 : (double)hold.wins / best.wins, duel, duelR11, duelNone, r11.wins);
            _out.WriteLine(msg);
            Assert.True(best.wins > 0, msg);
            Assert.True((double)hold.wins / best.wins < 1.0, "hold must never beat the best tapping: " + msg);
            Assert.True(hold.places >= best.places, msg);
            Assert.True(duel <= 0.45, msg);                 // like R11c for the full assist
            Assert.True(duelR11 < 0.5, msg);                // and under the R11 skilled rider too
            Assert.True(hold.wins <= r11.wins, msg);
            Assert.True(duelNone >= 0.7, msg);              // still a real help (R11d)
        }

        /// <summary>A skilled rider whose whips are tapped at a fixed rhythm from the best point, at most <c>max</c> of them (the hold's sequence, by hand).</summary>
        private sealed class CappedTapper : IRider
        {
            private readonly SkilledRider _inner = new SkilledRider();
            private readonly int _spacing, _max;
            private int _n, _last = -100000;
            private bool _go;
            public CappedTapper(int spacing, int max) { _spacing = spacing; _max = max; }
            public void Reset(RaceSim sim, int slot, ulong seed) { _inner.Reset(sim, slot, seed); _n = 0; _last = -100000; _go = false; }
            public byte Decide(RaceSim sim, int slot, int t)
            {
                var me = sim.GetHorse(slot);
                byte c = _inner.Decide(sim, slot, t);
                if (!me.Departed) return c;
                c = (byte)(c & ~Cmd.Whip);
                long rem = (sim.Track.Distance - me.Distance).Raw >> 16;
                long speedMm = Math.Max(1, me.Speed.Raw * 1000 >> 16);
                long needM = (long)Math.Min(me.WhipsLeft, _max) * _spacing * speedMm / 1000 / sim.Config.Net.TickHz;
                if (!_go) _go = rem <= needM + 15 && rem <= sim.SpurtZoneM;
                if (_go && _n < _max && me.WhipsLeft > 0 && t - _last >= _spacing) { _n++; _last = t; c |= Cmd.Whip; }
                return c;
            }
        }
    }
}
