using System.Globalization;
using Muchi.Engine;

namespace Muchi.Verifier
{
    // =====================================================================================
    // Ruleset 1.4 tactics harness (docs/quality/race-play.md, docs/spec/balance-targets.md §2.4).
    // Measures whether the rider's decisions — when to go (仕掛け), how long to gather (溜め → 一閃), whipping on the
    // rhythm (会心), pulling out of a slipstream (slingshot) — change results, with the same horse, field and seed for every
    // variant, and that a stat gap still usually decides. Fixed seeds, so the numbers are reproducible and asserted in CI.
    // =====================================================================================

    /// <summary>
    /// A rider who knows the 1.4 controls: rides the first part of the race like <see cref="SkilledRider"/> (start, rein for a
    /// reserve, slipstream), then in the 仕掛け window holds the whip <see cref="ChargeTicks"/> ticks before the go line
    /// (shifted by <see cref="GoOffsetPermille"/>), releases it, whips on the rhythm and pulls out of a slipstream after the go.
    /// Every option can be switched off to measure what each decision is worth.
    /// </summary>
    public sealed class TacticalRider : IRider
    {
        /// <summary>false = never presses in the window: the horse goes at the auto mark (no decision, no kick).</summary>
        public bool UseGo = true;
        /// <summary>Go at the go line × (1000 + this)‰ metres to go (positive = earlier).</summary>
        public int GoOffsetPermille = 0;
        /// <summary>Go as soon as the window opens (ignores the go line).</summary>
        public bool GoAtWindow = false;
        /// <summary>Ticks to hold the whip before the release (0 = a plain tap go).</summary>
        public int ChargeTicks = -1;
        /// <summary>Whip on the rhythm (spacing inside the 会心 window) or off it (<see cref="OffBeatSpacing"/>).</summary>
        public bool OnBeat = true;
        public int OffBeatSpacing = 27;
        /// <summary>Whip from this many metres to go (0 = space the whips to end on the line, like SkilledRider).</summary>
        public int WhipFromM = 0;
        /// <summary>After the go, pull out of a slipstream into a clear lane (slingshot).</summary>
        public bool Slingshot = true;
        /// <summary>false = no rein before the go (rides freely: less stamina saved, a shorter go line).</summary>
        public bool SaveEarly = true;
        private readonly SkilledRider _early = new SkilledRider();
        private int _pressTick = -1, _lastWhip = -1000, _lastLane = -1000;

        /// <summary>Rein margin of the early race (SkilledRider.ReinMargin; lower = saves less stamina).</summary>
        public int EarlyReinMargin = -100;

        /// <summary>The early race hunts a slipstream (SkilledRider.HuntSlipstream).</summary>
        public bool EarlyHuntSlipstream = true;

        public void Reset(RaceSim sim, int slot, ulong seed) { _early.ReinMargin = EarlyReinMargin; _early.HuntSlipstream = EarlyHuntSlipstream; _early.Reset(sim, slot, seed); _pressTick = -1; _lastWhip = -1000; _lastLane = -1000; }

        public byte Decide(RaceSim sim, int slot, int t)
        {
            var p = sim.P;
            var me = sim.GetHorse(slot);
            if (me.Finished) return 0;
            if (!me.Departed) return t >= p.GateOpenTick ? Cmd.Start : (byte)0;
            long rem = RiderUtil.RemainingM(sim, me);
            int charge = ChargeTicks < 0 ? p.GatherMaxTicks : ChargeTicks;
            if (!me.InSpurt)
            {
                if (me.Gathering) return t - _pressTick >= charge ? Cmd.Start : (byte)0;
                if (UseGo && rem <= sim.GoWindowM)
                {
                    long line = GoAtWindow ? sim.GoWindowM : Math.Min(Math.Max((long)sim.SustainableSpurtM(slot) * p.GoLinePermille / 1000, sim.AutoGoM) * (1000 + GoOffsetPermille) / 1000, sim.GoWindowM);
                    long chargeM = (me.Speed.Raw >> 16) * charge / sim.Config.Net.TickHz;
                    if (rem <= line + chargeM || GoAtWindow) { _pressTick = t; return charge == 0 ? (byte)(Cmd.Whip | Cmd.Start) : Cmd.Whip; }
                }
                // before the go: the skilled early race, without its whips (a whip in the window would be the hold)
                byte e = (byte)(_early.Decide(sim, slot, t) & ~Cmd.Whip);
                if (!SaveEarly) e = (byte)((e & ~Cmd.ReinPress) | (me.Reining ? Cmd.ReinRelease : 0));
                return e;
            }

            byte c = 0;
            // whips: on the beat (from the go, then each whip), spread so the last lands near the line
            int spacing = OnBeat ? (p.RhythmFromTicks + p.RhythmToTicks) / 2 : OffBeatSpacing;
            long speedMm = Math.Max(1, RiderUtil.SpeedMm(me.Speed));
            long needM = (long)me.WhipsLeft * spacing * speedMm / 1000 / sim.Config.Net.TickHz;
            bool whipTime = WhipFromM > 0 ? rem <= WhipFromM : rem <= needM + 15;
            int since = t - me.RhythmRefTick;
            if (me.WhipsLeft > 0 && whipTime && since >= spacing && t - _lastWhip >= spacing) { c |= Cmd.Whip; _lastWhip = t; }

            // after the go: out of a slipstream into a clear lane (slingshot), else round a slower horse
            if (!me.IsChangingLane && t - _lastLane >= 4)
            {
                long rangeM = (p.BlockRangeMm * 2) / 1000 + 1;
                int ahead = RiderUtil.AheadInLane(sim, slot, me.Lane, rangeM, out _);
                bool slingReady = Slingshot && me.SlipTicks >= p.SlingshotMinSlipTicks;
                if (ahead >= 0 || slingReady)
                {
                    if (RiderUtil.LaneLooksClear(sim, slot, me.LaneTarget + 1)) { c |= Cmd.LaneOut; _lastLane = t; }
                    else if (RiderUtil.LaneLooksClear(sim, slot, me.LaneTarget - 1)) { c |= Cmd.LaneIn; _lastLane = t; }
                }
            }
            if (me.Reining) c |= Cmd.ReinRelease;
            return c;
        }
    }

    public static class TacticsHarness
    {
        /// <summary>Average finishing time (ms) and win rate of a rider on an even 500 horse in a level-3 field (same seeds for every rider).</summary>
        public static (double ms, double win, double place) Solo(RulesetParams rs, Func<IRider> rider, int races, ulong seedBase, int cpuLevel = 3)
        {
            var track = SampleRaces.Turf2000();
            long sum = 0; int wins = 0; long places = 0;
            for (int r = 0; r < races; r++)
            {
                var rng = new Pcg32(seedBase + (ulong)r * 7919UL, 5);
                var horses = BalanceHarness.Field(ref rng, "k", 500, 150, track.Surface);
                int slot = r % 12;
                horses[slot] = BalanceHarness.Even("me", 500, (RunningStyle)(r / 12 % 4), track.Surface);
                var cfg = BalanceHarness.Config("tk_" + r, SeedMix.Mix(seedBase + (ulong)r), track, rs, horses, new HashSet<int> { slot }, _ => cpuLevel);
                var sim = BalanceHarness.Run(cfg, new Dictionary<int, IRider> { [slot] = rider() }, seedBase + (ulong)r);
                sum += BalanceHarness.TimeMs(sim, slot);
                int pl = BalanceHarness.PlaceOf(sim, slot);
                places += pl;
                if (pl == 0) wins++;
            }
            return ((double)sum / races, (double)wins / races, (double)places / races + 1);
        }

        /// <summary>Head to head in a level-3 field: share of races where A (stat A) finishes ahead of B (stat B), same style.</summary>
        public static double Duel(RulesetParams rs, Func<IRider> a, int statA, Func<IRider> b, int statB, int races, ulong seedBase) =>
            BalanceHarness.Duel(rs, a, statA, b, statB, races, seedBase);

        public static HarnessReport Run(RulesetParams rs, int scale = 1)
        {
            if (!rs.HasTacticsKeys) throw new ArgumentException("the tactics harness needs a ruleset with the tactics keys (1.4+)");
            var rep = new HarnessReport();
            int n = 160 * scale;
            ulong s = 31415;
            var line = Solo(rs, () => new TacticalRider(), n, s);
            var auto = Solo(rs, () => new TacticalRider { UseGo = false }, n, s);
            var tap = Solo(rs, () => new TacticalRider { ChargeTicks = 0 }, n, s);
            var freeLine = line;
            var window = Solo(rs, () => new TacticalRider { GoOffsetPermille = 350 }, n, s);
            var late = Solo(rs, () => new TacticalRider { GoOffsetPermille = -350 }, n, s);
            var offBeat = Solo(rs, () => new TacticalRider { OnBeat = false }, n, s);
            var noSling = Solo(WithValue(rs, "slingshotTicks", 0), () => new TacticalRider(), n, s);
            var skilled13 = Solo(rs, () => new SkilledRider(), n, s);
            var casual = Solo(rs, () => new CasualRider(), n, s);
            // K1..K5: every decision is worth something, and the go has a wrong side on both ends
            rep.Add("K1", "仕掛けの判断の価値：自動の仕掛け − 持つラインで溜めて仕掛け(ms)", auto.ms - line.ms, 150, 100000, "ms");
            rep.Add("K1b", "溜めの価値：タップで仕掛け − 溜めて仕掛け(ms)", tap.ms - line.ms, 50, 100000, "ms");
            rep.Add("K2", "早すぎる仕掛け(ライン+35%) − 持つライン(ms, 正なら早すぎが損)", window.ms - freeLine.ms, 100, 100000, "ms");
            rep.Add("K2b", "遅すぎる仕掛け(ライン−35%) − 持つライン(ms, 正なら遅すぎが損)", late.ms - line.ms, 30, 100000, "ms");
            rep.Add("K3", "会心の価値：拍を外したムチ − 拍に合わせたムチ(ms)", offBeat.ms - line.ms, 60, 100000, "ms");
            rep.Add("K4", "抜け出しの価値：抜け出しの加速なし − あり(ms)", noSling.ms - line.ms, 30, 100000, "ms");
            rep.Add("K5.win", "1.4の上手い人(500)の勝率(%) ※CPUレベル3の場", line.win * 100, 0, 100, "%");
            rep.Add("K5.auto", "仕掛けを使わない上手い人(500)の勝率(%)", auto.win * 100, 0, 100, "%");
            rep.Add("K5.r13", "1.3の乗り方の上手い人(500)の勝率(%)", skilled13.win * 100, 0, 100, "%");
            rep.Add("K5.casual", "初心者(500)の勝率(%)", casual.win * 100, 0, 100, "%");
            rep.Add("K5", "勝率の比：1.4の上手い人 ÷ 仕掛けを使わない上手い人", auto.win <= 0 ? 0 : line.win / auto.win, 1.15, 3.0);
            // K6..K8: a good rider on an equal horse wins clearly more often; a stat gap still usually wins
            int dn = 192 * scale;
            rep.Add("K6", "1.4の上手い人(500) が 仕掛けを使わない上手い人(500) に先着(%)", Duel(rs, () => new TacticalRider(), 500, () => new TacticalRider { UseGo = false }, 500, dn, s + 300) * 100, 58, 85, "%");
            rep.Add("K6b", "1.4の上手い人(500) が 1.3の乗り方の上手い人(500) に先着(%)", Duel(rs, () => new TacticalRider(), 500, () => new SkilledRider(), 500, dn, s + 300) * 100, 55, 85, "%");
            rep.Add("K7", "1.4の上手い人(500) が 1.4の上手い人(550) に先着(%)（能力差が大きいと能力が勝つ）", Duel(rs, () => new TacticalRider(), 500, () => new TacticalRider(), 550, dn, s + 400) * 100, 10, 40, "%");
            rep.Add("K7b", "1.4の上手い人(500) が 仕掛けを使わない上手い人(600) に先着(%)（大きな能力差は腕で覆らない）", Duel(rs, () => new TacticalRider(), 500, () => new TacticalRider { UseGo = false }, 600, dn, s + 400) * 100, 5, 40, "%");
            rep.Add("K8", "1.4の上手い人(500) が 初心者(500) に先着(%)", Duel(rs, () => new TacticalRider(), 500, () => new CasualRider(), 500, dn, s + 500) * 100, 70, 97, "%");
            return rep;
        }

        /// <summary>A copy of <paramref name="rs"/> with one key changed (to measure what a mechanic is worth).</summary>
        public static RulesetParams WithValue(RulesetParams rs, string key, long value)
        {
            var node = Muchi.Net.ProtocolCodec.RulesetToJson(rs);
            node.Set(key, value);
            return Muchi.Net.ProtocolCodec.ParseRuleset(node);
        }

        /// <summary>
        /// Audit (docs/quality/race-play.md §2): what each decision of a ruleset is worth — the skilled ride with one decision
        /// taken away, same horse / field / seed. Works on any ruleset (1.3 measures the ride before the tactics).
        /// </summary>
        public static List<(string what, double ms, double win)> Audit(RulesetParams rs, int races, ulong seed)
        {
            var o = new List<(string, double, double)>();
            void Add(string what, Func<IRider> r) { var x = Solo(rs, r, races, seed); o.Add((what, x.ms, x.win)); }
            Add("skilled (all decisions)", () => new SkilledRider());
            Add("start: late tap (5 ticks)", () => new LateStart(new SkilledRider(), 5));
            Add("rein: never", () => new SkilledRider { ReinMargin = -100000 });
            Add("slipstream: never hunts", () => new SkilledRider { HuntSlipstream = false });
            Add("whips: none", () => new SkilledRider { Whips = WhipPlan.None });
            Add("whips: from 400 m, 24 ticks", () => new SkilledRider { WhipFromM = 400, WhipSpacing = 24 });
            Add("whips: mashed", () => new SkilledRider { Whips = WhipPlan.Mash });
            Add("casual", () => new CasualRider());
            if (rs.HasTacticsKeys)
            {
                Add("1.4 tactical (go line, hold, rhythm, slingshot)", () => new TacticalRider());
                Add("1.4 tactical, auto go", () => new TacticalRider { UseGo = false });
                Add("1.4 tactical, never hunts a slipstream", () => new TacticalRider { EarlyHuntSlipstream = false, Slingshot = false });
                Add("1.4 tactical, rein: never", () => new TacticalRider { EarlyReinMargin = -100000 });
                Add("1.4 tactical, whips off the beat", () => new TacticalRider { OnBeat = false });
                Add("1.4 tactical, tap go (no hold)", () => new TacticalRider { ChargeTicks = 0 });
            }
            return o;
        }

        /// <summary>Wraps a rider and presses START <see cref="_late"/> ticks after the gate (no start boost).</summary>
        private sealed class LateStart : IRider
        {
            private readonly IRider _r; private readonly int _late;
            public LateStart(IRider r, int late) { _r = r; _late = late; }
            public void Reset(RaceSim sim, int slot, ulong seed) => _r.Reset(sim, slot, seed);
            public byte Decide(RaceSim sim, int slot, int t)
            {
                if (!sim.GetHorse(slot).Departed) return t >= sim.P.GateOpenTick + _late ? Cmd.Start : (byte)0;
                return _r.Decide(sim, slot, t);
            }
        }

        /// <summary>Average time (ms) of the tactical rider by go offset (‰ of the go line) — the shape of the timing decision.</summary>
        public static List<(int offset, double ms, double win)> GoCurve(RulesetParams rs, int races, ulong seed, int[] offsets, bool saveEarly = true, int reinMargin = -100)
        {
            var o = new List<(int, double, double)>();
            foreach (var off in offsets)
            {
                var r = Solo(rs, () => new TacticalRider { GoOffsetPermille = off, SaveEarly = saveEarly, EarlyReinMargin = reinMargin }, races, seed);
                o.Add((off, r.ms, r.win));
            }
            return o;
        }

        public static string F(double v) => v.ToString("F1", CultureInfo.InvariantCulture);
    }
}
