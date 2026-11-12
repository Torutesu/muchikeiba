using System;
using System.Collections.Generic;
using Muchi.Engine;

namespace Muchi.Client
{
    /// <summary>
    /// Ruleset 1.4 tactics state of the player's horse for the HUD (docs/quality/race-play.md): the 仕掛け window and the go
    /// line (the gold mark on the distance bar), the hold (溜め) and its charge, the whip rhythm ring, the slingshot and the
    /// final-stretch duel. Read-only presentation data; built by <see cref="RaceTactics.Snapshot"/> from the engine state.
    /// </summary>
    public sealed class RaceTacticsSnapshot
    {
        public int RemainingM;
        /// <summary>Metres to go where the 仕掛け window opens / where a horse that has not gone goes by itself.</summary>
        public int GoWindowM, AutoGoM;
        /// <summary>The go line: going here spends the horse's stamina about right (RaceSim.GoLineM).</summary>
        public int GoLineM;
        /// <summary>Inside the window and not gone yet.</summary>
        public bool InWindow;
        /// <summary>Time to start the hold: a full charge from here releases on the go line (the button glows gold).</summary>
        public bool GoNow;
        /// <summary>At or past the go line without having gone.</summary>
        public bool LineReached;
        public bool Gathering;
        /// <summary>Charge of the hold, ‰ of a full charge (1000 = 溜めきった: it goes by itself).</summary>
        public int ChargePermille;
        /// <summary>The horse has gone (the spurt is on).</summary>
        public bool Committed;
        /// <summary>Charge of the go in ticks (0 = tap, -1 = auto), -2 before the go.</summary>
        public int GoCharge = -2;
        public bool KickActive;
        /// <summary>Whip rhythm ring: progress since the go / last whip, ‰ of <see cref="RingTicks"/>; the gold arc is GoldFrom..GoldTo ‰.</summary>
        public int BeatPermille, GoldFromPermille, GoldToPermille, RingTicks;
        /// <summary>Inside the 会心 window now (and a whip left): the ring is gold.</summary>
        public bool Beat;
        public int PerfectWhips;
        /// <summary>A slingshot is ready (long enough in a slipstream inside the window) and a lane beside looks clear.</summary>
        public bool SlingReady;
        public bool SlingActive;
        /// <summary>A rival level with the player in the last <see cref="RaceTactics.DuelFromM"/> m (−1 = none).</summary>
        public int DuelSlot = -1;
        /// <summary>Boxed in inside the window before the go (a go now would hit the horse ahead).</summary>
        public bool Boxed;
        // pops set by RaceFeelTracker (the moment just happened)
        public bool PerfectPop, GoPop, SlingPop;
        public int LastGoCharge;
        /// <summary>One word for the HUD state machine: wait / window / gonow / gather / full / go / done.</summary>
        public string Phase = "wait";
    }

    public static class RaceTactics
    {
        /// <summary>A rival within this many metres to go, level with the player (±1 length, ≤ 1.5 lanes apart), is a duel.</summary>
        public const int DuelFromM = 400;
        public const long DuelGapMm = 2400;

        public static RaceTacticsSnapshot Snapshot(RaceSim sim, int slot)
        {
            var s = new RaceTacticsSnapshot();
            if (sim == null || !sim.TacticsEnabled || slot < 0 || slot >= sim.EntrantCount) return s;
            var p = sim.P;
            var h = sim.GetHorse(slot);
            s.RemainingM = (int)Math.Max(0, (sim.Track.Distance - h.Distance).Raw >> 16);
            s.GoWindowM = sim.GoWindowM;
            s.AutoGoM = sim.AutoGoM;
            s.GoLineM = sim.GoLineM(slot);
            s.Committed = h.InSpurt;
            s.Gathering = h.Gathering;
            s.ChargePermille = p.GatherMaxTicks <= 0 ? 0 : Math.Min(1000, h.GatherTicks * 1000 / p.GatherMaxTicks);
            s.KickActive = h.KickTicksLeft > 0;
            s.PerfectWhips = h.PerfectWhips;
            s.SlingActive = h.SlingTicksLeft > 0;
            if (h.InSpurt) s.GoCharge = h.GoCharge;
            if (!h.Departed || h.Finished) { s.Phase = h.Finished ? "done" : "wait"; return s; }

            s.InWindow = !h.InSpurt && s.RemainingM <= s.GoWindowM;
            s.LineReached = !h.InSpurt && s.RemainingM <= s.GoLineM;
            long chargeM = (h.Speed.Raw >> 16) * p.GatherMaxTicks / Math.Max(1, sim.Config.Net.TickHz);
            s.GoNow = s.InWindow && !h.Gathering && s.RemainingM <= s.GoLineM + chargeM; // GoLineM is never later than the auto mark
            s.Boxed = s.InWindow && h.Blocked;

            // rhythm ring: the gold arc is the 会心 window after the go / the last whip
            s.RingTicks = p.RhythmToTicks + 6;
            s.GoldFromPermille = p.RhythmFromTicks * 1000 / s.RingTicks;
            s.GoldToPermille = p.RhythmToTicks * 1000 / s.RingTicks;
            if (h.InSpurt)
            {
                int since = sim.Tick - h.RhythmRefTick;
                s.BeatPermille = Math.Min(1000, Math.Max(0, since * 1000 / s.RingTicks));
                s.Beat = h.WhipsLeft > 0 && since >= p.RhythmFromTicks && since <= p.RhythmToTicks;
            }

            bool late = s.RemainingM <= s.GoWindowM;
            if (late && !s.SlingActive && h.SlipTicks >= p.SlingshotMinSlipTicks)
                s.SlingReady = LaneLooksClear(sim, slot, h.LaneTarget + 1) || LaneLooksClear(sim, slot, h.LaneTarget - 1);

            if (s.RemainingM <= DuelFromM)
            {
                long best = long.MaxValue;
                for (int j = 0; j < sim.EntrantCount; j++)
                {
                    if (j == slot) continue;
                    var o = sim.GetHorse(j);
                    if (o.Finished || !o.Departed) continue;
                    long d = Math.Abs((o.Distance - h.Distance).ToMilli());
                    if (d > DuelGapMm || (o.Lane - h.Lane).Abs() > Fx.FromRatio(3, 2)) continue;
                    if (d < best) { best = d; s.DuelSlot = j; }
                }
            }

            s.Phase = h.InSpurt ? "go" : h.Gathering ? (s.ChargePermille >= 1000 ? "full" : "gather") : s.GoNow ? "gonow" : s.InWindow ? "window" : "wait";
            return s;
        }

        /// <summary>The engine's lane-change clearance, approximately (pre-step positions; the engine decides).</summary>
        public static bool LaneLooksClear(RaceSim sim, int slot, int lane)
        {
            if (lane < 0 || lane >= sim.P.LaneCount) return false;
            var me = sim.GetHorse(slot);
            Fx laneFx = Fx.FromInt(lane);
            long clear = sim.P.LaneChangeClearanceMm;
            for (int j = 0; j < sim.EntrantCount; j++)
            {
                if (j == slot) continue;
                var o = sim.GetHorse(j);
                if (o.Finished) continue;
                bool occ = (o.Lane - laneFx).Abs() < Fx.FromRatio(3, 4) || o.LaneTarget == lane;
                if (occ && Math.Abs((o.Distance - me.Distance).ToMilli()) < clear) return false;
            }
            return true;
        }
    }

    /// <summary>
    /// The post-race lesson from data (docs/quality/race-play.md): the player's ride is re-simulated with the go moved earlier
    /// and later (the same inputs from the hold on, shifted; every other horse rides itself as in the race), and the line says
    /// what the nearest better timing would have given — 「仕掛けがあと0.5秒早ければ2着」 — or that the timing was the best of
    /// those tried. Nothing is invented: each line is a race the engine actually ran. Before 1.4 (no 仕掛け) the shifted block
    /// is the player's whips from the first spurt-zone whip on. Deterministic.
    /// </summary>
    public sealed class GoCounterfactual
    {
        /// <summary>Shifts tried, in ticks (negative = earlier), nearest first.</summary>
        public static readonly int[] DefaultShifts = { -10, 10, -20, 20, -30, 30, -40, 40, -60 };

        public int ActualPlace;
        public long ActualTimeMs = -1;
        /// <summary>Best shift found (0 = the actual timing was the best of those tried).</summary>
        public int BestShiftTicks;
        public int BestPlace;
        public long BestTimeMs = -1;
        /// <summary>The player never went (1.4: the horse went at the auto mark) / never whipped in the spurt zone (older).</summary>
        public bool NoDecision;
        /// <summary>Ruleset 1.4 facts of the actual ride: the go (metres to go, -1 = none), its charge (ticks; -1 auto), 会心 whips / whips after the go.</summary>
        public int GoRemainingM = -1, GoCharge = -2, PerfectWhips, WhipsAfterGo;
        public bool Tactics;
        public string Line;
        public string Tip;
        /// <summary>Races simulated for the analysis (the actual one + one per shift).</summary>
        public int Simulations;

        public static GoCounterfactual Analyze(RaceConfig config, IList<InputRecord> inputs, int slot, int[] shifts = null)
        {
            if (config == null) throw new ArgumentNullException(nameof(config));
            if (inputs == null) throw new ArgumentNullException(nameof(inputs));
            shifts = shifts ?? DefaultShifts;
            var r = new GoCounterfactual { Tactics = config.Ruleset.HasTacticsKeys };
            var actual = Run(config, inputs, slot);
            r.Simulations = 1;
            r.ActualPlace = actual.place;
            r.ActualTimeMs = actual.timeMs;
            var h = actual.sim.GetHorse(slot);

            // the block to move: 1.4 = from the press (Gather) or, for an auto go, an inserted tap go; older = spurt-zone whips
            int from = -1;
            bool insertGo = false;
            var evs = actual.sim.Events;
            if (r.Tactics)
            {
                r.GoCharge = h.InSpurt ? h.GoCharge : -2;
                r.PerfectWhips = h.PerfectWhips;
                foreach (var e in evs)
                {
                    if (e.Slot != slot) continue;
                    if (e.Type == RaceEventType.Gather && from < 0) from = e.Tick;
                    if (e.Type == RaceEventType.Go) { r.GoRemainingM = RemainingAt(actual.sim, slot, e.Tick, inputs, config); if (from < 0) from = e.Tick; }
                    if (e.Type == RaceEventType.Whip && h.GoTick >= 0 && e.Tick >= h.GoTick) r.WhipsAfterGo++;
                }
                if (h.GoCharge == -1) { r.NoDecision = true; insertGo = true; }
            }
            else
            {
                // before 1.4 the 仕掛け is the first whip in the spurt zone (the player's SpurtStart comes first)
                int spurtTick = -1;
                foreach (var e in evs)
                {
                    if (e.Slot != slot) continue;
                    if (e.Type == RaceEventType.SpurtStart && spurtTick < 0) spurtTick = e.Tick;
                    if (e.Type == RaceEventType.Whip && spurtTick >= 0 && e.Tick >= spurtTick && from < 0) from = e.Tick;
                }
                if (from < 0) r.NoDecision = true;
            }
            if (from < 0) { r.Describe(); return r; }

            int bestShift = 0, bestPlace = actual.place; long bestTime = actual.timeMs;
            foreach (int sh in shifts)
            {
                if (insertGo && sh >= 0) continue; // an auto go can only be improved by going yourself, earlier
                var moved = Shift(inputs, slot, from, sh, insertGo);
                if (moved == null) continue;
                var alt = Run(config, moved, slot);
                r.Simulations++;
                bool better = alt.place < bestPlace || (alt.place == bestPlace && alt.timeMs >= 0 && (bestTime < 0 || alt.timeMs + 50 < bestTime));
                if (better && (alt.place < actual.place || alt.timeMs + 100 < actual.timeMs)) { bestShift = sh; bestPlace = alt.place; bestTime = alt.timeMs; }
            }
            r.BestShiftTicks = bestShift;
            r.BestPlace = bestPlace;
            r.BestTimeMs = bestTime;
            r.Describe();
            return r;
        }

        private void Describe()
        {
            string secs = (Math.Abs(BestShiftTicks) * 50 / 100 / 10.0).ToString("0.0", System.Globalization.CultureInfo.InvariantCulture);
            string side = BestShiftTicks < 0 ? "早" : "遅";
            if (Tactics && NoDecision && BestShiftTicks < 0 && BestPlace < ActualPlace)
                Line = "自分で" + secs + "秒早く仕掛けていれば" + BestPlace + "着";
            else if (BestShiftTicks != 0 && BestPlace < ActualPlace)
                Line = "仕掛けがあと" + secs + "秒" + side + "ければ" + BestPlace + "着";
            else if (BestShiftTicks != 0 && BestTimeMs >= 0 && ActualTimeMs >= 0)
            {
                string gain = ((ActualTimeMs - BestTimeMs) / 100 / 10.0).ToString("0.0", System.Globalization.CultureInfo.InvariantCulture);
                Line = "仕掛けがあと" + secs + "秒" + side + "ければ、" + gain + "秒速くゴールできた";
            }
            else if (!NoDecision) Line = "仕掛けのタイミングは最善だった";
            else Line = null;

            if (!Tactics) { Tip = null; return; }
            if (NoDecision) Tip = "金の線で長押しして溜め、離して仕掛ける";
            else if (WhipsAfterGo > 0 && PerfectWhips * 2 < WhipsAfterGo) Tip = "ムチは金の輪が光った瞬間に：会心";
            else if (GoCharge >= 0 && GoCharge < 20) Tip = "仕掛ける前に長押しで溜めると、一閃の加速";
            else Tip = "風よけから外へ出すと、抜け出しの加速";
        }

        /// <summary>The perfect-whip line for the result screen ("会心のムチ 3/5"), or null when no whip came after the go.</summary>
        public string PerfectLine => Tactics && WhipsAfterGo > 0 ? "会心のムチ " + PerfectWhips + "/" + WhipsAfterGo : null;

        private static int RemainingAt(RaceSim done, int slot, int tick, IList<InputRecord> inputs, RaceConfig config)
        {
            // re-run to the tick (cheap enough for one call on the result screen)
            var sim = new RaceSim(config);
            var byTick = Index(inputs);
            var cmds = new byte[config.Entrants.Count];
            while (!sim.IsFinished && sim.Tick <= tick)
            {
                Array.Clear(cmds, 0, cmds.Length);
                if (byTick.TryGetValue(sim.Tick, out var l)) foreach (var x in l) if (x.Slot >= 0 && x.Slot < cmds.Length) cmds[x.Slot] |= x.Cmd;
                sim.Step(cmds);
            }
            return (int)Math.Max(0, (sim.Track.Distance - sim.GetHorse(slot).Distance).Raw >> 16);
        }

        /// <summary>The player's inputs from <paramref name="from"/> on moved by <paramref name="shift"/> ticks (OR-merged); null if it would move before the gate.</summary>
        private static List<InputRecord> Shift(IList<InputRecord> inputs, int slot, int from, int shift, bool insertGo)
        {
            if (from + shift <= 0) return null;
            var map = new SortedDictionary<long, byte>();
            void Put(int tick, int s, byte c) { long k = ((long)tick << 8) | (uint)s; map[k] = (byte)((map.TryGetValue(k, out var v) ? v : 0) | c); }
            foreach (var r in inputs)
            {
                if (r.Slot == slot && r.Tick >= from) Put(r.Tick + shift, r.Slot, r.Cmd);
                else Put(r.Tick, r.Slot, r.Cmd);
            }
            if (insertGo) Put(from + shift, slot, (byte)(Cmd.Whip | Cmd.Start)); // a tap go where the horse went by itself, earlier
            var list = new List<InputRecord>(map.Count);
            foreach (var kv in map) list.Add(new InputRecord((int)(kv.Key >> 8), (int)(kv.Key & 0xff), kv.Value));
            return list;
        }

        private static Dictionary<int, List<InputRecord>> Index(IList<InputRecord> inputs)
        {
            var byTick = new Dictionary<int, List<InputRecord>>();
            foreach (var x in inputs)
            {
                if (!byTick.TryGetValue(x.Tick, out var l)) byTick[x.Tick] = l = new List<InputRecord>();
                l.Add(x);
            }
            return byTick;
        }

        private static (RaceSim sim, int place, long timeMs) Run(RaceConfig config, IList<InputRecord> inputs, int slot)
        {
            var sim = new RaceSim(config);
            var byTick = Index(inputs);
            var cmds = new byte[config.Entrants.Count];
            while (!sim.IsFinished)
            {
                Array.Clear(cmds, 0, cmds.Length);
                if (byTick.TryGetValue(sim.Tick, out var l)) foreach (var x in l) if (x.Slot >= 0 && x.Slot < cmds.Length) cmds[x.Slot] |= x.Cmd;
                sim.Step(cmds);
            }
            int place = Array.IndexOf(sim.Result.Order, slot) + 1;
            var h = sim.GetHorse(slot);
            long ms = h.Finished ? (long)(h.FinishTick - config.Ruleset.GateOpenTick) * 50 + (long)h.FinishFracRaw * 50 / 65536 : -1;
            return (sim, place, ms);
        }
    }
}
