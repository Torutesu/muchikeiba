using System;
using System.Collections.Generic;

namespace Muchi.Engine
{
    // =====================================================================================================
    // レースの見どころ — detection (REQ-HL-001..007, contracts/protocol.md §72).
    //
    // HighlightDetector re-simulates a race from its §7 replay log (config + confirmed inputs) with its own RaceSim and
    // picks up to three non-overlapping moments. Integers only (Q16.16 raw, mm, ticks): the same log and focus slot give
    // the same answer on every device and on the verifier (`Muchi.Verifier highlights`, contracts/highlights.vectors.json).
    // It only reads: the race, its checksums, result hash and the goldens never change. JSON: Muchi.Net.HighlightJson;
    // captions, the reel and sharing: Muchi.Client/Highlights.cs.
    // =====================================================================================================

    /// <summary>The moment kinds, in the tie-break order of §72.2.</summary>
    public static class HighlightKinds
    {
        public const string PhotoFinish = "photo_finish", NearMiss = "near_miss", LeadChange = "lead_change", WhipBurst = "whip_burst",
            Comeback = "comeback", UniqueSkill = "unique_skill", Finish = "finish";
        public static readonly string[] Order = { PhotoFinish, NearMiss, LeadChange, WhipBurst, Comeback, UniqueSkill, Finish };
        public static int IndexOf(string kind) => Array.IndexOf(Order, kind);
    }

    /// <summary>
    /// REQ-HL-002..005: the fixed rules of detection version 1. Not remote-configurable (the device and the verifier must
    /// agree): changing a number means a new <see cref="Version"/> and regenerated vectors.
    /// </summary>
    public static class HighlightRules
    {
        public const int Version = 1;
        public const int MaxMoments = 3;
        public const int MaxPerKind = 2;
        public const int FocusBonus = 30;
        public const int PhotoMarginMm = 500;
        public const int NearMissMarginMm = 1500;
        public const int FinalLeadM = 400;
        public const int WhipGainPlaces = 2;
        public const int WhipLookMs = 3000;
        public const int ComebackFromM = 600;
        public const int ComebackMaxPlace = 3;
        public const int ComebackMinField = 5;
        public const int MinTotalMs = 15_000;
        public const int MaxTotalMs = 30_000;
        /// <summary>Longest window (a lone window may stretch to <see cref="MinTotalMs"/>).</summary>
        public const int MaxWindowMs = 10_000;

        /// <summary>Window before / after the key tick, ms (§72.1).</summary>
        public static (int preMs, int postMs) Window(string kind)
        {
            switch (kind)
            {
                case HighlightKinds.PhotoFinish:
                case HighlightKinds.NearMiss: return (5000, 1500);
                case HighlightKinds.LeadChange: return (3000, 2000);
                case HighlightKinds.WhipBurst: return (1500, 3500);
                case HighlightKinds.Comeback: return (7000, 1000);
                case HighlightKinds.UniqueSkill: return (1000, 3000);
                default: return (4000, 1500);
            }
        }

        /// <summary>Ticks for <paramref name="ms"/> at <paramref name="hz"/> (truncated).</summary>
        public static int Ticks(int ms, int hz) => (int)((long)ms * hz / 1000);
    }

    /// <summary>One chosen moment (§72.2 item 4).</summary>
    public sealed class HighlightMoment
    {
        /// <summary>1..3 in score order (1 = the top moment: the share card and the link's start).</summary>
        public int Rank;
        public string Kind;
        public int StartTick, EndTick, KeyTick;
        /// <summary>The horse the moment is about (the camera follows it); <see cref="Slot2"/> the other horse or -1.</summary>
        public int Slot, Slot2 = -1;
        /// <summary>Kind-specific: margin mm (photo / near miss), metres left (lead change), places gained (whip), place at 600 m left (comeback), place when it fired (skill).</summary>
        public int Value;
        /// <summary>Metres the subject had left at the key tick (truncated, 0 once finished).</summary>
        public int RemainingM;
        /// <summary>1-based final place of the subject (0 = did not finish).</summary>
        public int Place;
        public int Score;

        public int DurationTicks => EndTick - StartTick;

        public override string ToString() => Rank + ":" + Kind + "@" + StartTick + "-" + EndTick + " slot " + Slot + " v" + Value + " s" + Score;
    }

    /// <summary>The detection result: up to three moments in race order.</summary>
    public sealed class HighlightSet
    {
        public int Version = HighlightRules.Version;
        public int FocusSlot = -1, EndTick, TickHz = 20;
        public List<HighlightMoment> Moments = new List<HighlightMoment>();
        public int TotalTicks { get { int t = 0; foreach (var m in Moments) t += m.DurationTicks; return t; } }
        public int TotalMs => (int)((long)TotalTicks * 1000 / Math.Max(1, TickHz));
        /// <summary>The rank-1 moment (null only for an empty set, which detection never returns for a run race).</summary>
        public HighlightMoment Top => Moments.Find(m => m.Rank == 1);
    }

    /// <summary>REQ-HL-001..005: the pure detection.</summary>
    public static class HighlightDetector
    {
        /// <summary>
        /// Re-simulate <paramref name="config"/> with <paramref name="inputs"/> and pick the moments. When
        /// <paramref name="expectedResultHash"/> is given and the re-simulation does not reproduce it, throws
        /// <see cref="InvalidOperationException"/> (never highlights a different race).
        /// </summary>
        public static HighlightSet Detect(RaceConfig config, IList<InputRecord> inputs, int focusSlot, string expectedResultHash = null)
        {
            if (config == null) throw new ArgumentNullException(nameof(config));
            if (inputs == null) throw new ArgumentNullException(nameof(inputs));
            var tl = Timeline.Run(config, inputs);
            if (!string.IsNullOrEmpty(expectedResultHash) && !string.Equals(expectedResultHash, tl.Result.Hash, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("the replay does not reproduce the result hash");
            return Pick(tl, focusSlot);
        }

        // ------------------------------------------------------------------ the re-simulation (read only)

        internal sealed class Timeline
        {
            public int N, T, Hz;
            public long TrackMm;
            public int[] Rank;      // [t * N + s]: 0-based rank when sim.Tick == t
            public int[] DistMm;    // [t * N + s]
            public List<RaceEvent> Events;
            public RaceResult Result;
            public int EndTick => T - 1;
            public long RemainingMm(int t, int s) => Math.Max(0, TrackMm - DistMm[Math.Min(T - 1, Math.Max(0, t)) * N + s]);
            public int RankAt(int t, int s) => Rank[Math.Min(T - 1, Math.Max(0, t)) * N + s];

            public static Timeline Run(RaceConfig cfg, IList<InputRecord> inputs)
            {
                var sim = new RaceSim(cfg);
                int n = cfg.Entrants.Count;
                var byTick = new Dictionary<int, List<InputRecord>>();
                foreach (var r in inputs)
                {
                    if (r.Slot < 0 || r.Slot >= n) throw new ArgumentException("input slot out of range");
                    if (r.Tick < 0 || r.Tick >= cfg.Ruleset.MaxTicks) throw new ArgumentException("input tick out of range");
                    if (!byTick.TryGetValue(r.Tick, out var list)) byTick[r.Tick] = list = new List<InputRecord>();
                    list.Add(r);
                }
                var rank = new List<int>(n * 2400);
                var dist = new List<int>(n * 2400);
                var cmds = new byte[n];
                while (true)
                {
                    for (int s = 0; s < n; s++)
                    {
                        var h = sim.GetHorse(s);
                        rank.Add(h.Rank);
                        dist.Add((int)h.Distance.ToMilli());
                    }
                    if (sim.IsFinished) break;
                    Array.Clear(cmds, 0, n);
                    if (byTick.TryGetValue(sim.Tick, out var l)) foreach (var r in l) cmds[r.Slot] |= r.Cmd;
                    sim.Step(cmds); // the same stepping as RaceReplay.Run / ReplayPlayer.Open
                }
                return new Timeline
                {
                    N = n, T = rank.Count / n, Hz = cfg.Net.TickHz, TrackMm = (long)cfg.Track.DistanceM * 1000,
                    Rank = rank.ToArray(), DistMm = dist.ToArray(), Events = new List<RaceEvent>(sim.Events), Result = sim.Result,
                };
            }
        }

        // ------------------------------------------------------------------ candidates and selection

        private static HighlightMoment Candidate(Timeline tl, int focus, string kind, int key, int slot, int slot2, int value, int score)
        {
            var (pre, post) = HighlightRules.Window(kind);
            int place = Array.IndexOf(tl.Result.Order, slot) + 1;
            if (place > 0 && tl.Result.FinishTicks[place - 1] < 0) place = 0;
            if (focus >= 0 && (slot == focus || slot2 == focus)) score += HighlightRules.FocusBonus;
            return new HighlightMoment
            {
                Kind = kind, KeyTick = key, Slot = slot, Slot2 = slot2, Value = value, Score = score, Place = place,
                StartTick = Math.Max(0, key - HighlightRules.Ticks(pre, tl.Hz)), EndTick = Math.Min(tl.EndTick, key + HighlightRules.Ticks(post, tl.Hz)),
                RemainingM = (int)(tl.RemainingMm(key, slot) / 1000),
            };
        }

        internal static List<HighlightMoment> Candidates(Timeline tl, int focus)
        {
            var c = new List<HighlightMoment>();
            var res = tl.Result;
            int n = tl.N;
            // photo finish / near miss: adjacent finishers (§72.1)
            for (int k = 1; k < res.Order.Length; k++)
            {
                if (res.FinishTicks[k] < 0 || res.FinishTicks[k - 1] < 0) continue;
                int front = res.Order[k - 1], back = res.Order[k];
                bool mine = focus >= 0 && (front == focus || back == focus);
                long mm = res.Margins[k].ToMilli();
                if (mm < 0) mm = 0;
                int key = Math.Min(tl.EndTick, res.FinishTicks[k]);
                if (mm < HighlightRules.PhotoMarginMm && (k == 1 || mine))
                    c.Add(Candidate(tl, focus, HighlightKinds.PhotoFinish, key, back, front, (int)mm, 90 + (int)((HighlightRules.PhotoMarginMm - mm) / 25)));
                else if (mm >= HighlightRules.PhotoMarginMm && mm < HighlightRules.NearMissMarginMm && (k <= 2 || mine))
                    c.Add(Candidate(tl, focus, HighlightKinds.NearMiss, key, back, front, (int)mm, 50 + (int)((HighlightRules.NearMissMarginMm - mm) / 50)));
            }
            int prevLeader = -1;
            var whipLook = HighlightRules.Ticks(HighlightRules.WhipLookMs, tl.Hz);
            foreach (var e in tl.Events)
            {
                switch (e.Type)
                {
                    case RaceEventType.LeaderChanged:
                    {
                        long rem = tl.RemainingMm(e.Tick + 1, e.Slot);
                        if (prevLeader >= 0 && prevLeader != e.Slot && rem > 0 && rem <= HighlightRules.FinalLeadM * 1000L)
                        {
                            int m = (int)(rem / 1000);
                            c.Add(Candidate(tl, focus, HighlightKinds.LeadChange, e.Tick, e.Slot, prevLeader, m, 60 + (HighlightRules.FinalLeadM - m) / 10));
                        }
                        prevLeader = e.Slot;
                        break;
                    }
                    case RaceEventType.Whip:
                    {
                        int before = tl.RankAt(e.Tick, e.Slot), after = tl.RankAt(e.Tick + 1 + whipLook, e.Slot);
                        int gained = before - after;
                        if (gained >= HighlightRules.WhipGainPlaces)
                            c.Add(Candidate(tl, focus, HighlightKinds.WhipBurst, e.Tick, e.Slot, -1, gained, 45 + 12 * Math.Min(gained, 6)));
                        break;
                    }
                    case RaceEventType.Skill:
                        c.Add(Candidate(tl, focus, HighlightKinds.UniqueSkill, e.Tick, e.Slot, -1, e.Value + 1, 40));
                        break;
                }
            }
            // comeback: in the last third with 600 m left, home in the first three
            if (n >= HighlightRules.ComebackMinField)
            {
                int threshold = n - (n + 2) / 3;
                long markMm = Math.Max(0, tl.TrackMm - HighlightRules.ComebackFromM * 1000L);
                for (int p = 1; p <= Math.Min(HighlightRules.ComebackMaxPlace, res.Order.Length); p++)
                {
                    int s = res.Order[p - 1], ft = res.FinishTicks[p - 1];
                    if (ft < 0) continue;
                    int at = -1;
                    for (int t = 0; t < tl.T; t++) if (tl.DistMm[t * n + s] >= markMm) { at = t; break; }
                    if (at < 0) continue;
                    int r = tl.Rank[at * n + s];
                    if (r < threshold) continue;
                    int score = 55 + Math.Min(40, 8 * (r + 1 - p)) + (p == 1 ? 15 : 0);
                    c.Add(Candidate(tl, focus, HighlightKinds.Comeback, Math.Min(tl.EndTick, ft), s, -1, r + 1, score));
                }
            }
            // the finish: always one, so every race has a highlight
            int winner = res.Order.Length > 0 ? res.Order[0] : 0;
            int fkey = res.Order.Length > 0 && res.FinishTicks[0] >= 0 ? Math.Min(tl.EndTick, res.FinishTicks[0]) : tl.EndTick;
            c.Add(Candidate(tl, focus, HighlightKinds.Finish, fkey, winner, -1, 0, 10));
            return c;
        }

        private static int Compare(HighlightMoment a, HighlightMoment b)
        {
            int x = b.Score.CompareTo(a.Score);
            if (x != 0) return x;
            if ((x = a.KeyTick.CompareTo(b.KeyTick)) != 0) return x;
            if ((x = HighlightKinds.IndexOf(a.Kind).CompareTo(HighlightKinds.IndexOf(b.Kind))) != 0) return x;
            if ((x = a.Slot.CompareTo(b.Slot)) != 0) return x;
            return a.Slot2.CompareTo(b.Slot2);
        }

        private static bool Overlaps(HighlightMoment a, HighlightMoment b) => a.StartTick <= b.EndTick && b.StartTick <= a.EndTick;

        internal static HighlightSet Pick(Timeline tl, int focus)
        {
            var cands = Candidates(tl, focus);
            cands.Sort(Compare); // List.Sort is unstable, but Compare is a total order on distinct candidates
            var chosen = new List<HighlightMoment>();
            foreach (var m in cands)
            {
                if (chosen.Count >= HighlightRules.MaxMoments) break;
                if (chosen.Exists(x => Overlaps(x, m))) continue;
                if (chosen.FindAll(x => x.Kind == m.Kind).Count >= HighlightRules.MaxPerKind) continue;
                if (m.Kind == HighlightKinds.WhipBurst && chosen.Exists(x => x.Kind == m.Kind && x.Slot == m.Slot)) continue;
                m.Rank = chosen.Count + 1;
                chosen.Add(m);
            }
            chosen.Sort((a, b) => a.StartTick.CompareTo(b.StartTick)); // no overlaps: starts are distinct
            Pad(chosen, tl.EndTick, tl.Hz);
            return new HighlightSet { FocusSlot = focus, EndTick = tl.EndTick, TickHz = tl.Hz, Moments = chosen };
        }

        /// <summary>§72.2 item 3: widen windows (earlier first, then later, never overlapping) until the reel lasts 15 s.</summary>
        private static void Pad(List<HighlightMoment> w, int endTick, int hz)
        {
            int k = w.Count;
            if (k == 0) return;
            int min = HighlightRules.Ticks(HighlightRules.MinTotalMs, hz);
            int cap = Math.Max(HighlightRules.Ticks(HighlightRules.MaxWindowMs, hz), (min + k - 1) / k);
            int total = 0;
            foreach (var m in w) total += m.DurationTicks;
            while (total < min)
            {
                bool progress = false;
                int share = (min - total + k - 1) / k;
                for (int i = 0; i < k && total < min; i++)
                {
                    int give = Math.Min(share, min - total);
                    int lo = i == 0 ? 0 : w[i - 1].EndTick + 1;
                    int can = Math.Min(give, Math.Min(w[i].StartTick - lo, cap - w[i].DurationTicks));
                    if (can > 0) { w[i].StartTick -= can; total += can; give -= can; progress = true; }
                    int hi = i == k - 1 ? endTick : w[i + 1].StartTick - 1;
                    can = Math.Min(give, Math.Min(hi - w[i].EndTick, cap - w[i].DurationTicks));
                    if (can > 0) { w[i].EndTick += can; total += can; progress = true; }
                }
                if (!progress) break;
            }
        }
    }

}
