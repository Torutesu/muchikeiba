using System.Globalization;
using System.Text;
using Muchi.Engine;

namespace Muchi.Verifier
{
    // =====================================================================================
    // Balance harness (docs/spec/balance-targets.md). Measures every race-side balance target
    // with fixed seeds so results are reproducible and can be asserted in CI.
    // Rider policies play human slots through the same command bytes a real player sends.
    // =====================================================================================

    /// <summary>A player model that decides the command byte for one slot each tick (pre-step state).</summary>
    public interface IRider
    {
        void Reset(RaceSim sim, int slot, ulong seed);
        byte Decide(RaceSim sim, int slot, int tick);
    }

    public enum WhipPlan { Spaced, Mash, Early, None }

    internal static class RiderUtil
    {
        public static long Meters(Fx f) => f.Raw >> 16;
        public static long RemainingM(RaceSim sim, HorseState h) => Meters(sim.Track.Distance - h.Distance);
        /// <summary>Speed in mm/s.</summary>
        public static long SpeedMm(Fx f) => f.Raw * 1000 >> 16;

        /// <summary>Closest horse ahead within <paramref name="rangeM"/> in the given lane (±0.5), or -1.</summary>
        public static int AheadInLane(RaceSim sim, int slot, Fx laneCenter, long rangeM, out long gapMm)
        {
            var me = sim.GetHorse(slot);
            int best = -1;
            gapMm = long.MaxValue;
            Fx half = Fx.FromRatio(1, 2);
            for (int j = 0; j < sim.EntrantCount; j++)
            {
                if (j == slot) continue;
                var o = sim.GetHorse(j);
                if (o.Finished || !o.Departed) continue;
                if ((o.Lane - laneCenter).Abs() > half) continue;
                long gap = (o.Distance - me.Distance).Raw * 1000 >> 16;
                if (gap <= 0 || gap > rangeM * 1000) continue;
                if (gap < gapMm) { gapMm = gap; best = j; }
            }
            return best;
        }

        /// <summary>Approximation of the engine's lane-clear rule (the engine ignores a change into an occupied lane anyway).</summary>
        public static bool LaneLooksClear(RaceSim sim, int slot, int lane)
        {
            if (lane < 0 || lane >= sim.P.LaneCount) return false;
            var me = sim.GetHorse(slot);
            long clearMm = sim.P.LaneChangeClearanceMm + 500;
            Fx laneFx = Fx.FromInt(lane);
            for (int j = 0; j < sim.EntrantCount; j++)
            {
                if (j == slot) continue;
                var o = sim.GetHorse(j);
                if (o.Finished) continue;
                bool occ = (o.Lane - laneFx).Abs() < Fx.FromRatio(3, 4) || o.LaneTarget == lane;
                if (!occ) continue;
                long d = Math.Abs((o.Distance - me.Distance).Raw * 1000 >> 16);
                if (d < clearMm) return false;
            }
            return true;
        }
    }

    /// <summary>
    /// "上手い人": perfect start, keeps composure and pace with the rein, hunts a slipstream before the
    /// spurt, steers round slower horses, and spaces the six whips so the last one ends on the line.
    /// </summary>
    public sealed class SkilledRider : IRider
    {
        public WhipPlan Whips = WhipPlan.Spaced;
        /// <summary>Start whipping this many meters out (0 = time the six whips to end on the line).</summary>
        public int WhipFromM = 0;
        /// <summary>Ticks between whips (0 = the shortest spacing without diminishing).</summary>
        public int WhipSpacing = 0;
        /// <summary>Rein when stamina‰ + margin is below the remaining distance‰.</summary>
        public int ReinMargin = -100;
        public bool HuntSlipstream = true;
        public bool SwitchOnlyIfSlower = false;
        private int _lastWhip = -1000;
        private int _lastLaneTick = -1000;

        public void Reset(RaceSim sim, int slot, ulong seed) { _lastWhip = -1000; _lastLaneTick = -1000; }

        public byte Decide(RaceSim sim, int slot, int t)
        {
            var p = sim.P;
            var me = sim.GetHorse(slot);
            if (me.Finished) return 0;
            if (!me.Departed) return t >= p.GateOpenTick ? Cmd.Start : (byte)0;

            byte c = 0;
            long rem = RiderUtil.RemainingM(sim, me);
            bool spurt = rem <= p.SpurtDistanceM;
            long speedMm = Math.Max(1, RiderUtil.SpeedMm(me.Speed));
            int spacing = WhipSpacing > 0 ? WhipSpacing : Math.Max(p.WhipEffectTicks, p.WhipDiminishWindowTicks);

            // whips
            if (me.WhipsLeft > 0 && t - _lastWhip >= spacing)
            {
                bool go = false;
                switch (Whips)
                {
                    case WhipPlan.Spaced:
                        {
                            // start so the remaining whips are spread over the rest of the race
                            long needTicks = (long)me.WhipsLeft * spacing;
                            long needM = needTicks * speedMm / 1000 / sim.Config.Net.TickHz;
                            go = WhipFromM > 0 ? rem <= WhipFromM : spurt && rem <= needM + 15;
                            break;
                        }
                    case WhipPlan.Early: go = rem <= 1300 && rem > p.SpurtDistanceM + 50; break;
                    case WhipPlan.Mash: go = rem <= 400; break;
                }
                if (Whips == WhipPlan.Mash && rem <= 400) go = true; // mashing ignores spacing below
                if (go) { c |= Cmd.Whip; _lastWhip = t; }
            }
            else if (Whips == WhipPlan.Mash && me.WhipsLeft > 0 && rem <= 400)
            {
                c |= Cmd.Whip; _lastWhip = t;
            }

            // rein: never in the spurt; otherwise keep composure and a stamina reserve for the finish
            bool wantRein = false;
            if (!spurt)
            {
                long remPermille = (sim.Track.Distance - me.Distance).Raw * 1000 / sim.Track.Distance.Raw;
                bool composure = me.Composure < p.BadComposureThreshold + 20 || me.IsKakari;
                bool reserve = me.StaminaPermille + ReinMargin < remPermille;
                wantRein = composure || reserve;
            }
            if (wantRein && !me.Reining) c |= Cmd.ReinPress;
            if (!wantRein && me.Reining) c |= Cmd.ReinRelease;

            // lanes (one decision every 4 ticks)
            if (!me.IsChangingLane && t - _lastLaneTick >= 4)
            {
                long rangeM = (p.BlockRangeMm * 2) / 1000 + 1;
                int ahead = RiderUtil.AheadInLane(sim, slot, me.Lane, rangeM, out _);
                bool blocked = ahead >= 0 && ((spurt && !SwitchOnlyIfSlower) || sim.GetHorse(ahead).Speed < me.Speed);
                if (blocked)
                {
                    if (RiderUtil.LaneLooksClear(sim, slot, me.LaneTarget + 1)) { c |= Cmd.LaneOut; _lastLaneTick = t; }
                    else if (RiderUtil.LaneLooksClear(sim, slot, me.LaneTarget - 1)) { c |= Cmd.LaneIn; _lastLaneTick = t; }
                }
                else if (!spurt && HuntSlipstream)
                {
                    long slipM = p.SlipstreamRangeMm / 1000;
                    bool inSlip = RiderUtil.AheadInLane(sim, slot, me.Lane, slipM, out _) >= 0;
                    if (!inSlip)
                    {
                        // move under a horse in the next lane in (saves ground too), else out
                        if (RiderUtil.AheadInLane(sim, slot, Fx.FromInt(me.LaneTarget - 1), slipM, out _) >= 0 && RiderUtil.LaneLooksClear(sim, slot, me.LaneTarget - 1)) { c |= Cmd.LaneIn; _lastLaneTick = t; }
                        else if (me.LaneTarget > 0 && RiderUtil.LaneLooksClear(sim, slot, me.LaneTarget - 1)) { c |= Cmd.LaneIn; _lastLaneTick = t; }
                    }
                }
            }
            return c;
        }
    }

    /// <summary>
    /// "初心者": taps start late about half the time, never manages pace with the rein, whips from a random
    /// point with uneven spacing, and reacts to what the screen shows (a pulling horse, being boxed in)
    /// slowly and only half the time. Leaves lane choice to the jockey's auto-steer.
    /// </summary>
    public sealed class CasualRider : IRider
    {
        public bool PerfectStart, DriftToRail, GoodWhips;
        private Pcg32 _rng;
        private int _startDelay, _whipFromM, _nextWhip;

        public void Reset(RaceSim sim, int slot, ulong seed)
        {
            _rng = new Pcg32(seed, 77);
            _startDelay = _rng.Range(0, 9);          // window is 0..3 → ~45% get the boost
            _whipFromM = 250 + _rng.Range(0, 350);    // 250..600m out
            _nextWhip = -1;
        }

        public byte Decide(RaceSim sim, int slot, int t)
        {
            var p = sim.P;
            var me = sim.GetHorse(slot);
            if (me.Finished) return 0;
            if (!me.Departed) return t >= p.GateOpenTick + (PerfectStart ? 0 : _startDelay) ? Cmd.Start : (byte)0;
            byte c = 0;
            long rem = RiderUtil.RemainingM(sim, me);
            if (DriftToRail && rem > p.SpurtDistanceM && !me.IsChangingLane && me.LaneTarget > 0 && t % 4 == 0 && RiderUtil.LaneLooksClear(sim, slot, me.LaneTarget - 1)) c |= Cmd.LaneIn;
            if (GoodWhips)
            {
                if (me.WhipsLeft > 0 && rem <= 150 && t - _nextWhip >= 20) { c |= Cmd.Whip; _nextWhip = t; }
            }
            else if (me.WhipsLeft > 0 && rem <= _whipFromM)
            {
                if (_nextWhip < 0) _nextWhip = t;
                if (t >= _nextWhip) { c |= Cmd.Whip; _nextWhip = t + 6 + _rng.Range(0, 30); }
            }
            // reacts to what the screen shows, slowly and not always: a pulling horse (rein), being boxed in (steer out)
            if (t % 10 == 0)
            {
                if (me.IsKakari && !me.Reining && _rng.Chance(1, 2)) c |= Cmd.ReinPress;
                else if (!me.IsKakari && me.Reining) c |= Cmd.ReinRelease;
                if (!me.IsChangingLane && me.Blocked && _rng.Chance(1, 2)) c |= Cmd.LaneOut;
            }
            return c;
        }
    }

    public sealed class HarnessMetric
    {
        public string Id, Label, Unit, Target;
        public double Value;
        public bool Pass;
        public override string ToString() => Id + " " + Label + ": " + Value.ToString("F3", CultureInfo.InvariantCulture) + Unit + "  [" + Target + "] " + (Pass ? "OK" : "NG");
    }

    public sealed class HarnessReport
    {
        public readonly List<HarnessMetric> Metrics = new List<HarnessMetric>();
        public bool AllPass => Metrics.All(m => m.Pass);
        public HarnessMetric Get(string id) => Metrics.First(m => m.Id == id);
        public void Add(string id, string label, double v, double lo, double hi, string unit = "")
        {
            Metrics.Add(new HarnessMetric
            {
                Id = id, Label = label, Unit = unit, Value = v, Pass = v >= lo && v <= hi,
                Target = lo.ToString("G4", CultureInfo.InvariantCulture) + ".." + hi.ToString("G4", CultureInfo.InvariantCulture),
            });
        }
        public string Markdown()
        {
            var sb = new StringBuilder();
            sb.AppendLine("| id | 指標 | 値 | 目標 | 判定 |");
            sb.AppendLine("|---|---|---|---|---|");
            foreach (var m in Metrics)
                sb.AppendLine("| " + m.Id + " | " + m.Label + " | " + m.Value.ToString(m.Unit == "%" ? "F1" : "F2", CultureInfo.InvariantCulture) + m.Unit + " | " + m.Target + m.Unit + " | " + (m.Pass ? "OK" : "NG") + " |");
            return sb.ToString();
        }
    }

    /// <summary>Runs every race-side target. <paramref name="scale"/> multiplies race counts (1 = CI size).</summary>
    public static class BalanceHarness
    {
        public const int TickHz = 20;

        public static RaceConfig Config(string id, ulong seed, TrackSpec track, RulesetParams rs, IList<HorseSpec> horses, ISet<int> humans, Func<int, int> cpuLevel, RaceMode mode = RaceMode.Ranked)
        {
            var c = new RaceConfig { RaceId = id, Mode = mode, Seed = seed, Track = track, Ruleset = rs, Net = new NetParams() };
            for (int i = 0; i < horses.Count; i++)
                c.Entrants.Add(new Entrant
                {
                    Slot = i, Kind = humans.Contains(i) ? EntrantKind.Human : EntrantKind.Cpu,
                    PlayerId = humans.Contains(i) ? "p_" + i : null, CpuLevel = cpuLevel(i), Horse = horses[i],
                });
            c.Validate();
            return c;
        }

        /// <summary>Runs a race where the given slots are driven by riders.</summary>
        public static RaceSim Run(RaceConfig cfg, IDictionary<int, IRider> riders, ulong riderSeed)
        {
            var sim = new RaceSim(cfg);
            foreach (var kv in riders) kv.Value.Reset(sim, kv.Key, riderSeed + (ulong)kv.Key * 31UL);
            var cmds = new byte[cfg.Entrants.Count];
            while (!sim.IsFinished)
            {
                Array.Clear(cmds, 0, cmds.Length);
                foreach (var kv in riders) cmds[kv.Key] = kv.Value.Decide(sim, kv.Key, sim.Tick);
                sim.Step(cmds);
            }
            return sim;
        }

        public static int PlaceOf(RaceSim sim, int slot) => Array.IndexOf(sim.Result.Order, slot);

        public static long TimeMs(RaceSim sim, int slot)
        {
            var h = sim.GetHorse(slot);
            if (!h.Finished) return -1;
            return (long)(h.FinishTick - sim.P.GateOpenTick) * 50 + (long)h.FinishFracRaw * 50 / 65536;
        }

        private static List<HorseSpec> Field(ref Pcg32 rng, string prefix, int center, int spread, Surface surface)
        {
            var list = new List<HorseSpec>();
            for (int i = 0; i < 12; i++)
            {
                var h = SampleRaces.RandomHorse(ref rng, prefix + i, center, spread);
                h.Surface = surface;
                list.Add(h);
            }
            return list;
        }

        private static HorseSpec Even(string id, int stat, RunningStyle style, Surface surface)
        {
            var h = SampleRaces.Horse(id, stat, style, 500);
            h.Surface = surface;
            return h;
        }

        /// <summary>
        /// Paired comparison on the same race and horse: the slot ridden by <paramref name="rider"/> vs the same slot
        /// left to a level-3 CPU. Returns win rates of both and the average places gained by the rider.
        /// </summary>
        public static (double riderWin, double cpuWin, double placesGained) RiderVsCpu(RulesetParams rs, Func<IRider> rider, int races, ulong seedBase, TrackSpec track = null)
        {
            track ??= SampleRaces.Turf2000();
            int rw = 0, cw = 0; long gained = 0;
            for (int r = 0; r < races; r++)
            {
                var rng = new Pcg32(seedBase + (ulong)r * 7919UL, 5);
                var horses = Field(ref rng, "f", 500, 150, track.Surface);
                int slot = r % 12;
                var cfgCpu = Config("rc_" + r, SeedMix.Mix(seedBase + (ulong)r), track, rs, horses, new HashSet<int>(), _ => 3);
                var simCpu = Run(cfgCpu, new Dictionary<int, IRider>(), 0);
                var cfgRider = Config("rc_" + r, SeedMix.Mix(seedBase + (ulong)r), track, rs, horses, new HashSet<int> { slot }, _ => 3);
                var simRider = Run(cfgRider, new Dictionary<int, IRider> { [slot] = rider() }, seedBase + (ulong)r);
                int pc = PlaceOf(simCpu, slot), pr = PlaceOf(simRider, slot);
                if (pc == 0) cw++;
                if (pr == 0) rw++;
                gained += pc - pr;
            }
            return ((double)rw / races, (double)cw / races, (double)gained / races);
        }

        /// <summary>Head to head inside a CPU field: share of races where rider A finishes ahead of rider B.</summary>
        public static double Duel(RulesetParams rs, Func<IRider> a, int statA, Func<IRider> b, int statB, int races, ulong seedBase)
        {
            var track = SampleRaces.Turf2000();
            int aAhead = 0;
            for (int r = 0; r < races; r++)
            {
                var rng = new Pcg32(seedBase + (ulong)r * 104729UL, 9);
                var horses = Field(ref rng, "d", 500, 150, track.Surface);
                int sa = r % 12, sb = (r + 6) % 12;
                var style = (RunningStyle)(r / 12 % 4);
                horses[sa] = Even("A", statA, style, track.Surface);
                horses[sb] = Even("B", statB, style, track.Surface);
                var cfg = Config("du_" + r, SeedMix.Mix(seedBase + 77 + (ulong)r), track, rs, horses, new HashSet<int> { sa, sb }, _ => 3);
                var sim = Run(cfg, new Dictionary<int, IRider> { [sa] = a(), [sb] = b() }, seedBase + (ulong)r);
                if (PlaceOf(sim, sa) < PlaceOf(sim, sb)) aAhead++;
            }
            return (double)aAhead / races;
        }

        /// <summary>Average finishing time (ms) of a skilled rider with a given whip plan, same seeds for every plan.</summary>
        public static double WhipPlanTime(RulesetParams rs, WhipPlan plan, int races, ulong seedBase) =>
            WhipPlanTime(rs, () => new SkilledRider { Whips = plan }, races, seedBase);

        public static double WhipPlanTime(RulesetParams rs, Func<SkilledRider> make, int races, ulong seedBase)
        {
            var track = SampleRaces.Turf2000();
            long sum = 0;
            for (int r = 0; r < races; r++)
            {
                var rng = new Pcg32(seedBase + (ulong)r * 7919UL, 5);
                var horses = Field(ref rng, "w", 500, 150, track.Surface);
                int slot = r % 12;
                horses[slot] = Even("me", 500, (RunningStyle)(r / 12 % 4), track.Surface);
                var cfg = Config("wp_" + r, SeedMix.Mix(seedBase + (ulong)r), track, rs, horses, new HashSet<int> { slot }, _ => 3);
                var sim = Run(cfg, new Dictionary<int, IRider> { [slot] = make() }, seedBase + (ulong)r);
                sum += TimeMs(sim, slot);
            }
            return (double)sum / races;
        }

        /// <summary>Win rate per CPU level (equal horses, levels rotated over gates).</summary>
        public static double[] CpuLevelWinRates(RulesetParams rs, int races, ulong seedBase)
        {
            var track = SampleRaces.Turf2000();
            var wins = new int[6];
            var runners = new int[6];
            for (int r = 0; r < races; r++)
            {
                var horses = Enumerable.Range(0, 12).Select(i => Even("lv" + i, 500, (RunningStyle)((i + r) % 4), track.Surface)).ToList();
                int Level(int i) => (i + r) % 5 + 1;
                var cfg = Config("lv_" + r, SeedMix.Mix(seedBase + (ulong)r), track, rs, horses, new HashSet<int>(), Level);
                var sim = Run(cfg, new Dictionary<int, IRider>(), 0);
                for (int i = 0; i < 12; i++) runners[Level(i)]++;
                wins[Level(sim.Result.Order[0])]++;
            }
            return Enumerable.Range(0, 6).Select(l => runners[l] == 0 ? 0 : (double)wins[l] / runners[l]).ToArray();
        }

        /// <summary>Win rate per gate group (inner 1-4, middle 5-8, outer 9-12) in CPU-only fields.</summary>
        public static double[] GateGroupWinRates(RulesetParams rs, int races, ulong seedBase, TrackSpec trackOverride = null)
        {
            var wins = new int[3];
            for (int r = 0; r < races; r++)
            {
                var rng = new Pcg32(seedBase + (ulong)r * 7919UL, 3);
                var track = trackOverride ?? SampleRaces.Turf2000();
                var horses = Field(ref rng, "g", 500, 150, track.Surface);
                var cfg = Config("gt_" + r, SeedMix.Mix(seedBase + (ulong)r), track, rs, horses, new HashSet<int>(), _ => 3);
                var sim = Run(cfg, new Dictionary<int, IRider>(), 0);
                wins[sim.Result.Order[0] / 4]++;
            }
            return wins.Select(w => (double)w / races / 4).ToArray(); // per runner
        }

        /// <summary>Solo time-attack runs (horse normalised to statCap) → sorted finish times in ms.</summary>
        public static List<long> SoloTimes(RulesetParams rs, TrackSpec track, int statCap, Func<IRider> rider, int runs, ulong seedBase)
        {
            if (rs.HasBalanceKeys && rs.ConditionVariancePermille != 0)
            {
                // the server issues time attack with form switched off (timeAttackRuleset), so measure the same way
                var node = Muchi.Net.ProtocolCodec.RulesetToJson(rs);
                node.Set("conditionVariancePermille", 0);
                rs = Muchi.Net.ProtocolCodec.ParseRuleset(node);
            }
            var times = new List<long>();
            for (int r = 0; r < runs; r++)
            {
                var rng = new Pcg32(seedBase + (ulong)r * 31337UL, 11);
                var h = SampleRaces.RandomHorse(ref rng, "ta", 700, 200);
                h.Surface = Surface.Both;
                h.DistMinM = 1000; h.DistMaxM = 3000;
                int total = h.Speed + h.Stamina + h.Burst + h.Guts + h.Temper;
                if (total > statCap)
                {
                    h.Speed = h.Speed * statCap / total; h.Stamina = h.Stamina * statCap / total; h.Burst = h.Burst * statCap / total;
                    h.Guts = h.Guts * statCap / total; h.Temper = h.Temper * statCap / total;
                }
                var cfg = Config("ta_" + r, SeedMix.Mix(seedBase + (ulong)r), track, rs, new List<HorseSpec> { h }, new HashSet<int> { 0 }, _ => 3, RaceMode.TimeAttack);
                var sim = Run(cfg, new Dictionary<int, IRider> { [0] = rider() }, seedBase + (ulong)r);
                times.Add(TimeMs(sim, 0));
            }
            times.Sort();
            return times;
        }

        /// <summary>Tracks from server/master/tracks.json.</summary>
        public static List<TrackSpec> LoadServerTracks(string path)
        {
            var root = Muchi.Net.JsonNode.Parse(File.ReadAllText(path));
            var list = new List<TrackSpec>();
            foreach (var t in root.Get("tracks").Items)
            {
                var spec = new TrackSpec
                {
                    Id = t.Get("id").AsString(),
                    Surface = Muchi.Net.ProtocolCodec.ParseSurface(t.Get("surface").AsString(), false),
                    DistanceM = t.Get("distanceM").AsInt(),
                };
                foreach (var sg in t.Get("segments").Items)
                {
                    bool corner = sg.Get("kind").AsString() == "corner";
                    spec.Segments.Add(new TrackSegment(corner ? SegmentKind.Corner : SegmentKind.Straight, sg.Get("lengthM").AsInt(), corner ? sg.Get("radiusM").AsInt() : 0));
                }
                list.Add(spec);
            }
            return list;
        }

        public static long Percentile(List<long> sorted, int pct) => sorted[Math.Min(sorted.Count - 1, sorted.Count * pct / 100)];

        private static readonly (string name, Going going, bool dirt)[] Goings =
        {
            ("turf-firm", Going.FirmOrFast, false), ("turf-good", Going.Good, false), ("turf-yielding", Going.YieldingOrMuddy, false), ("turf-soft", Going.SoftOrSloppy, false),
            ("dirt-fast", Going.FirmOrFast, true), ("dirt-good", Going.Good, true), ("dirt-muddy", Going.YieldingOrMuddy, true), ("dirt-sloppy", Going.SoftOrSloppy, true),
        };

        public static HarnessReport Run(RulesetParams rs, int scale = 1)
        {
            var rep = new HarnessReport();
            int n = 240 * scale;
            ulong s = 20251;

            // R1 race length (2000m good turf, CPU field)
            var good = BalanceProbe.Run(rs, n, s);
            rep.Add("R1", "2000m良・勝ち時計(秒)", good.AvgWinnerSeconds(TickHz, rs.GateOpenTick), 85, 95, "s");
            rep.Add("R1b", "完走しない馬(レース数)", good.Dnf, 0, 0);

            // R2 running-style balance on every going (per-runner win rate, uniform 8.33%)
            foreach (var g in Goings)
            {
                var track = g.dirt ? SampleRaces.WithGoing(SampleRaces.Dirt1800(), g.going) : SampleRaces.WithGoing(SampleRaces.Turf2000(), g.going);
                var b = BalanceProbe.Run(rs, n, s + 100, 150, track);
                double lo = 1, hi = 0;
                foreach (RunningStyle st in Enum.GetValues(typeof(RunningStyle)))
                {
                    lo = Math.Min(lo, b.StyleWinRate(st));
                    hi = Math.Max(hi, b.StyleWinRate(st));
                }
                rep.Add("R2." + g.name, g.name + " 脚質別勝率の最小(%)", lo * 100, 6.25 - Tolerance(n), 100, "%");
                rep.Add("R2." + g.name + "+", g.name + " 脚質別勝率の最大(%)", hi * 100, 0, 10.42 + Tolerance(n), "%");
            }

            // R3 skill expression
            int rn = 192 * scale;
            var skilled = RiderVsCpu(rs, () => new SkilledRider(), rn, s + 200);
            var casual = RiderVsCpu(rs, () => new CasualRider(), rn, s + 200);
            rep.Add("R3a", "上手い人が同じ馬・同じレースでCPU(レベル3)より上げる着順", skilled.placesGained, 1.0, 4.0);
            rep.Add("R3b", "上手い人の勝率 ÷ CPUが乗った時の勝率", skilled.cpuWin <= 0 ? 0 : skilled.riderWin / skilled.cpuWin, 1.5, 4.0);
            rep.Add("R3c", "初心者が同じ馬でCPU(レベル3)より上げる着順(負=下がる) ※レベル3≈初心者", casual.placesGained, -1.5, 0.5);
            rep.Add("R3d", "上手い人(475) が初心者(500) に先着(%)", Duel(rs, () => new SkilledRider(), 475, () => new CasualRider(), 500, rn, s + 300) * 100, 55, 85, "%");
            rep.Add("R3e", "上手い人(500) が初心者(500) に先着(%)", Duel(rs, () => new SkilledRider(), 500, () => new CasualRider(), 500, rn, s + 300) * 100, 65, 92, "%");
            rep.Add("R3f", "上手い人(500) が上手い人(525) に先着(%)", Duel(rs, () => new SkilledRider(), 500, () => new SkilledRider(), 525, rn, s + 400) * 100, 20, 45, "%");

            // R4 whip plans (same seeds): mashing and early whips must not beat spaced whips
            int wn = 120 * scale;
            double spaced = WhipPlanTime(rs, WhipPlan.Spaced, wn, s + 500);
            double mash = WhipPlanTime(rs, WhipPlan.Mash, wn, s + 500);
            double early = WhipPlanTime(rs, WhipPlan.Early, wn, s + 500);
            double none = WhipPlanTime(rs, WhipPlan.None, wn, s + 500);
            rep.Add("R4a", "連打 − 間隔をあける(ms, 正なら連打が遅い)", mash - spaced, 50, 100000, "ms");
            rep.Add("R4b", "早打ち − ムチなし(ms, 正なら早打ちが損)", early - none, 0, 100000, "ms");
            rep.Add("R4c", "ムチなし − 間隔をあける(ms, ムチの価値)", none - spaced, 300, 100000, "ms");
            double from400 = WhipPlanTime(rs, () => new SkilledRider { WhipFromM = 400, WhipSpacing = 24 }, wn, s + 500);
            rep.Add("R4d", "ムチなし − 残り400mから間隔をあけて打つ(ms, 正なら打つ方が速い)", none - from400, 0, 100000, "ms");

            // R5 CPU levels monotonic, level 3 ≈ casual
            var lv = CpuLevelWinRates(rs, 300 * scale, s + 600);
            bool mono = true;
            for (int l = 2; l <= 5; l++) if (lv[l] + 0.015 < lv[l - 1]) mono = false;
            for (int l = 1; l <= 5; l++) rep.Add("R5.L" + l, "CPUレベル" + l + "の勝率(%)", lv[l] * 100, 0, 100, "%");
            rep.Add("R5a", "CPUレベル1〜5の勝率が単調(1=はい)", mono ? 1 : 0, 1, 1);
            rep.Add("R5b", "CPUレベル5とレベル1の勝率差(pt)", (lv[5] - lv[1]) * 100, 3, 20, "pt");

            // R6 going specialists on soft turf
            var soft = BalanceProbe.Run(rs, 300 * scale, s + 700, 150, SampleRaces.WithGoing(SampleRaces.Turf2000(), Going.SoftOrSloppy), aptMix: true);
            double heavyRatio = soft.AptWinRate(GoingAptitude.Heavy) / (1.0 / 12);
            rep.Add("R6", "重馬場巧者の勝率 ÷ 一様(重)", heavyRatio, 1.1, 2.0);

            // R7 gate bias
            var gates = GateGroupWinRates(rs, 360 * scale, s + 800);
            rep.Add("R7", "内枠(1-4)と外枠(9-12)の1頭あたり勝率の差(pt)", Math.Abs(gates[0] - gates[2]) * 100, 0, 4, "pt");
            rep.Add("R7i", "内枠(1-4)の1頭あたり勝率(%)", gates[0] * 100, 0, 100, "%");
            rep.Add("R7o", "外枠(9-12)の1頭あたり勝率(%)", gates[2] * 100, 0, 100, "%");

            // R8 strongest horse still matters (stats count) but does not decide alone
            rep.Add("R8", "最強馬の勝率(%)", (double)good.StrongestWins / good.Races * 100, 20, 45, "%");
            return rep;
        }

        /// <summary>
        /// Per-course targets (REQ-TRACK-002, docs/spec/balance-targets.md §2.1) for every course in server/master/tracks.json
        /// on good ground: T1 no runner fails to finish and the winning time stays a fair pace for the distance; T2 no running
        /// style dominates the course (≤ 2× uniform; the weakest style is reported); T7 small gate bias (same band as R7). Fixed seeds.
        /// </summary>
        public static HarnessReport TrackRun(RulesetParams rs, IEnumerable<TrackSpec> tracks, int scale = 1)
        {
            var rep = new HarnessReport();
            int n = 240 * scale;
            ulong s = 70707;
            foreach (var t in tracks)
            {
                var b = BalanceProbe.Run(rs, n, s + 100, 150, t);
                double secs = b.AvgWinnerSeconds(TickHz, rs.GateOpenTick);
                rep.Add("T1." + t.Id, t.Id + " 完走しない馬(レース数)", b.Dnf, 0, 0);
                rep.Add("T1." + t.Id + ".pace", t.Id + " 勝ち時計の1000mあたり(秒)", secs * 1000.0 / t.DistanceM, 40, 48, "s");
                double lo = 1, hi = 0;
                foreach (RunningStyle st in Enum.GetValues(typeof(RunningStyle)))
                {
                    lo = Math.Min(lo, b.StyleWinRate(st));
                    hi = Math.Max(hi, b.StyleWinRate(st));
                    rep.Add("T2." + t.Id + "." + st, t.Id + " " + st + "の勝率(%)", b.StyleWinRate(st) * 100, 0, 100, "%");
                }
                // course character is allowed (逃げ有利の短距離・差し追込有利の長距離), but no style may dominate a course:
                // at most twice the uniform rate. The minimum is reported (known issue at 2400m, balance-targets.md §5).
                rep.Add("T2." + t.Id, t.Id + " 脚質別勝率の最小(%) ※参考", lo * 100, 0, 100, "%");
                rep.Add("T2." + t.Id + "+", t.Id + " 脚質別勝率の最大(%)", hi * 100, 0, 2 * 100.0 / 12, "%");
                var gates = GateGroupWinRates(rs, 360 * scale, s + 800, t);
                rep.Add("T7." + t.Id, t.Id + " 内枠と外枠の1頭あたり勝率の差(pt)", Math.Abs(gates[0] - gates[2]) * 100, 0, 4, "pt");
            }
            return rep;
        }

        /// <summary>Statistical slack (percentage points) for per-runner rates measured over n races.</summary>
        public static double Tolerance(int n) => n >= 600 ? 0.5 : 1.0;

        /// <summary>Medal thresholds per track for time attack: gold = top 10% of skilled runs, bronze = casual median.</summary>
        public static List<(string track, long gold, long silver, long bronze)> TimeAttackThresholds(RulesetParams rs, IEnumerable<TrackSpec> tracks, int statCap, int runs = 60)
        {
            var list = new List<(string, long, long, long)>();
            foreach (var t in tracks)
            {
                var sk = SoloTimes(rs, t, statCap, () => new SkilledRider(), runs, 4242);
                var ca = SoloTimes(rs, t, statCap, () => new CasualRider(), runs, 4242);
                list.Add((t.Id, Percentile(sk, 10), Percentile(sk, 50), Percentile(ca, 50)));
            }
            return list;
        }
    }
}
