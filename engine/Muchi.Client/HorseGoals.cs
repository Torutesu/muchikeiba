using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-HGOAL-001..016 馬ごとの目標 — per-horse goals (server/src/domain/horseGoals.ts, contracts/protocol.md §53).
    // A short chain of goals per horse, a pure function of its aptitudes (surface, distance range, running style, whether it has a
    // unique skill) and the course list; progress only from the §34 career record (confirmed results). HorseGoalChain is the same
    // rule as the server (contracts/horse-goals.vectors.json), so a screen can draw a chain before the server answers. The reward
    // is a ribbon only: nothing here changes coins, items or a horse's stats. Horse names are never translated.

    public sealed class HorseGoalHorse
    {
        /// <summary>turf | dirt | both</summary>
        public string Surface = "turf";
        public int DistMinM, DistMaxM;
        /// <summary>nige | senko | sashi | oikomi</summary>
        public string Style = "senko";
        /// <summary>The unique skill it races with, or null.</summary>
        public string SkillId;
        public static HorseGoalHorse Parse(JsonNode o) => new HorseGoalHorse
        {
            Surface = J.Str(o, "surface"), DistMinM = J.Int(o, "distMinM"), DistMaxM = J.Int(o, "distMaxM"), Style = J.Str(o, "style"), SkillId = J.Str(o, "skillId"),
        };
    }

    public sealed class HorseGoalTrack
    {
        public string Id, Name, Surface;
        public int DistanceM;
        public static HorseGoalTrack Parse(JsonNode o) => new HorseGoalTrack { Id = J.Str(o, "id"), Name = J.Str(o, "name"), Surface = J.Str(o, "surface"), DistanceM = J.Int(o, "distanceM") };
    }

    /// <summary>What the goals count: the §34 career record and its goal tallies.</summary>
    public sealed class HorseGoalRecord
    {
        public int Races, Wins, TournamentWins, RankedPlaces;
        public List<string> TaTracks = new List<string>();
        public Dictionary<string, int> SurfaceWins = new Dictionary<string, int> { { "turf", 0 }, { "dirt", 0 } };
        public Dictionary<string, int> BandWins = new Dictionary<string, int> { { "sprint", 0 }, { "mile", 0 }, { "intermediate", 0 }, { "long", 0 } };
        public static HorseGoalRecord Parse(JsonNode o)
        {
            var r = new HorseGoalRecord
            {
                Races = J.Int(o, "races"), Wins = J.Int(o, "wins"), TournamentWins = J.Int(o, "tournamentWins"), RankedPlaces = J.Int(o, "rankedPlaces"),
                TaTracks = (J.Strs(o, "taTracks") ?? new string[0]).ToList(),
            };
            foreach (var kv in J.Map(o, "surfaceWins", x => x.AsInt())) r.SurfaceWins[kv.Key] = kv.Value;
            foreach (var kv in J.Map(o, "bandWins", x => x.AsInt())) r.BandWins[kv.Key] = kv.Value;
            return r;
        }
    }

    /// <summary>One goal of a chain, with its progress.</summary>
    public sealed class HorseGoal
    {
        /// <summary>Stable id, e.g. "races:10", "surface_win:turf", "ta_course:aoba_turf_1600".</summary>
        public string Id;
        /// <summary>first_win | races | surface_win | ta_course | stretch_win | wins | ranked_top3 | tournament_win</summary>
        public string Kind;
        /// <summary>The Japanese line (translate with <see cref="Loc.T"/>; the English is in server-en.json).</summary>
        public string Text;
        public int Need, Have;
        public bool Done, Current;
        public long? CompletedAt;
        /// <summary>n | surface | trackId | course | band (numbers as invariant strings).</summary>
        public Dictionary<string, string> Params = new Dictionary<string, string>();
        public int Left => Math.Max(0, Need - Have);

        public static HorseGoal Parse(JsonNode o)
        {
            var g = new HorseGoal
            {
                Id = J.Str(o, "id"), Kind = J.Str(o, "kind"), Text = J.Str(o, "text"), Need = J.Int(o, "need"), Have = J.Int(o, "have"),
                Done = J.Bool(o, "done"), Current = J.Bool(o, "current"), CompletedAt = J.LongN(o, "completedAt"),
            };
            var p = J.Opt(o, "params");
            if (p != null && p.Kind == JsonKind.Object) foreach (var kv in p.Props) g.Params[kv.Key] = kv.Value.Kind == JsonKind.String ? kv.Value.AsString() : kv.Value.ToString();
            return g;
        }
    }

    /// <summary>REQ-HGOAL-001..003: the chain and its progress — the same rules as server/src/domain/horseGoals.ts (shared vectors).</summary>
    public static class HorseGoalChain
    {
        public const int Version = 1;
        public static readonly string[] Kinds = { "first_win", "races", "surface_win", "ta_course", "stretch_win", "wins", "ranked_top3", "tournament_win" };
        public const int RacesTarget = 10, SurfaceWinsTarget = 3, SkillWinsTarget = 5, RankedTop3Target = 5;
        private static readonly string[] BandOrder = { "sprint", "mile", "intermediate", "long" };
        private static readonly Dictionary<string, int[]> Bands = new Dictionary<string, int[]>
        {
            { "sprint", new[] { 0, 1400 } }, { "mile", new[] { 1401, 1800 } }, { "intermediate", new[] { 1801, 2400 } }, { "long", new[] { 2401, 99999 } },
        };
        private static readonly Dictionary<string, string> BandText = new Dictionary<string, string>
        {
            { "sprint", "短距離（1400m以下）で勝つ" }, { "mile", "マイル（1401〜1800m）で勝つ" }, { "intermediate", "中距離（1801〜2400m）で勝つ" }, { "long", "長距離（2401m以上）で勝つ" },
        };

        public static string BandOf(int distanceM)
        {
            foreach (var b in BandOrder) if (distanceM <= Bands[b][1]) return b;
            return "long";
        }

        private static bool Runs(HorseGoalHorse h, HorseGoalTrack t) => h.Surface == "both" || h.Surface == t.Surface;
        private static int Gap(HorseGoalHorse h, int d) => d < h.DistMinM ? h.DistMinM - d : d > h.DistMaxM ? d - h.DistMaxM : 0;

        public static string BestSurface(HorseGoalHorse h, IList<HorseGoalTrack> tracks)
        {
            if (h.Surface != "both") return h.Surface;
            int n(string s) => tracks.Count(t => t.Surface == s && Gap(h, t.DistanceM) == 0);
            return n("dirt") > n("turf") ? "dirt" : "turf";
        }

        public static HorseGoalTrack Course(HorseGoalHorse h, IList<HorseGoalTrack> tracks)
        {
            int mid2 = h.DistMinM + h.DistMaxM;
            HorseGoalTrack best = null;
            foreach (var t in tracks)
            {
                if (!Runs(h, t)) continue;
                if (best == null) { best = t; continue; }
                int c = Gap(h, t.DistanceM) - Gap(h, best.DistanceM);
                if (c == 0) c = Math.Abs(2 * t.DistanceM - mid2) - Math.Abs(2 * best.DistanceM - mid2);
                if (c == 0) c = string.CompareOrdinal(t.Id, best.Id);
                if (c < 0) best = t;
            }
            return best;
        }

        public static string StretchBand(HorseGoalHorse h, IList<HorseGoalTrack> tracks)
        {
            bool outside(string b) => Bands[b][1] < h.DistMinM || Bands[b][0] > h.DistMaxM;
            bool possible(string b) => outside(b) && tracks.Any(t => Runs(h, t) && BandOf(t.DistanceM) == b);
            var below = BandOrder.Where(b => Bands[b][1] < h.DistMinM).Reverse().ToList();
            var above = BandOrder.Where(b => Bands[b][0] > h.DistMaxM).ToList();
            var order = h.Style == "nige" || h.Style == "senko" ? below.Concat(above) : above.Concat(below);
            foreach (var b in order) if (possible(b)) return b;
            return null;
        }

        private static HorseGoal Def(string id, string kind, int need, string text, params string[] kv)
        {
            var g = new HorseGoal { Id = id, Kind = kind, Need = need, Text = text };
            for (int i = 0; i + 1 < kv.Length; i += 2) g.Params[kv[i]] = kv[i + 1];
            return g;
        }
        private static string N(int v) => v.ToString(CultureInfo.InvariantCulture);

        /// <summary>REQ-HGOAL-001/002: the chain in story order (6..8 goals), progress empty. Pure.</summary>
        public static List<HorseGoal> Build(HorseGoalHorse h, IList<HorseGoalTrack> tracks)
        {
            var o = new List<HorseGoal>
            {
                Def("first_win", "first_win", 1, "初勝利をあげる"),
                Def("races:" + N(RacesTarget), "races", RacesTarget, N(RacesTarget) + "戦を走る", "n", N(RacesTarget)),
            };
            var surface = BestSurface(h, tracks);
            o.Add(Def("surface_win:" + surface, "surface_win", SurfaceWinsTarget, (surface == "turf" ? "芝" : "ダート") + "で" + N(SurfaceWinsTarget) + "勝する", "surface", surface, "n", N(SurfaceWinsTarget)));
            var course = Course(h, tracks);
            if (course != null) o.Add(Def("ta_course:" + course.Id, "ta_course", 1, "タイムアタック " + course.Name + " で記録を残す", "trackId", course.Id, "course", course.Name));
            var band = StretchBand(h, tracks);
            if (band != null) o.Add(Def("stretch_win:" + band, "stretch_win", 1, BandText[band], "band", band));
            if (!string.IsNullOrEmpty(h.SkillId)) o.Add(Def("wins:" + N(SkillWinsTarget), "wins", SkillWinsTarget, N(SkillWinsTarget) + "勝する", "n", N(SkillWinsTarget)));
            o.Add(Def("ranked_top3:" + N(RankedTop3Target), "ranked_top3", RankedTop3Target, "ランク戦で3着以内に" + N(RankedTop3Target) + "回入る", "n", N(RankedTop3Target)));
            o.Add(Def("tournament_win", "tournament_win", 1, "大会で優勝する"));
            return o;
        }

        public static int Value(HorseGoal g, HorseGoalRecord r)
        {
            string p(string k) => g.Params.TryGetValue(k, out var v) ? v : "";
            int at(Dictionary<string, int> d, string k) => d.TryGetValue(k, out var v) ? v : 0;
            switch (g.Kind)
            {
                case "first_win": case "wins": return r.Wins;
                case "races": return r.Races;
                case "surface_win": return at(r.SurfaceWins, p("surface"));
                case "ta_course": return r.TaTracks.Contains(p("trackId")) ? 1 : 0;
                case "stretch_win": return at(r.BandWins, p("band"));
                case "ranked_top3": return r.RankedPlaces;
                case "tournament_win": return r.TournamentWins;
                default: return 0;
            }
        }

        /// <summary>REQ-HGOAL-003: progress of every goal (new objects); stamped = completion times already recorded.</summary>
        public static List<HorseGoal> Evaluate(IList<HorseGoal> chain, HorseGoalRecord r, IDictionary<string, long> stamped = null)
        {
            var o = new List<HorseGoal>();
            foreach (var d in chain)
            {
                long at = 0;
                bool has = stamped != null && stamped.TryGetValue(d.Id, out at);
                int have = Math.Min(d.Need, Math.Max(0, Value(d, r)));
                o.Add(new HorseGoal
                {
                    Id = d.Id, Kind = d.Kind, Text = d.Text, Need = d.Need, Params = new Dictionary<string, string>(d.Params),
                    Have = have, Done = has || have >= d.Need, CompletedAt = has ? at : (long?)null,
                });
            }
            var cur = o.FirstOrDefault(g => !g.Done);
            if (cur != null) cur.Current = true;
            return o;
        }
    }

    /// <summary>GET /v1/horses/:horseId/goals.</summary>
    public sealed class HorseGoalsView
    {
        public int V, DoneCount, Total;
        public string HorseId, HorseName, Status, Notice;
        public bool Pinned, ChainComplete;
        public long? ChainCompletedAt;
        public List<HorseGoal> Goals = new List<HorseGoal>();
        public HorseGoal Current => Goals.FirstOrDefault(g => g.Current);
        internal static HorseGoalsView Parse(JsonNode o) => new HorseGoalsView
        {
            V = J.Int(o, "v"), HorseId = J.Str(o, "horseId"), HorseName = J.Str(o, "horseName"), Status = J.Str(o, "status"), Notice = J.Str(o, "notice"),
            Pinned = J.Bool(o, "pinned"), ChainComplete = J.Bool(o, "chainComplete"), ChainCompletedAt = J.LongN(o, "chainCompletedAt"),
            DoneCount = J.Int(o, "doneCount"), Total = J.Int(o, "total"), Goals = J.List(o, "goals", HorseGoal.Parse),
        };
    }

    /// <summary>The home's pinned goal (bootstrap <c>horseGoalPin</c>, GET /v1/horse-goals/pinned, PUT /v1/horse-goals/pin).</summary>
    public sealed class HorseGoalPin
    {
        public string HorseId, HorseName;
        public HorseGoal Goal;
        public int DoneCount, Total;
        internal static HorseGoalPin Parse(JsonNode o) => o == null ? null : new HorseGoalPin
        {
            HorseId = J.Str(o, "horseId"), HorseName = J.Str(o, "horseName"), Goal = J.Opt(o, "goal") == null ? null : HorseGoal.Parse(J.Opt(o, "goal")),
            DoneCount = J.Int(o, "doneCount"), Total = J.Int(o, "total"),
        };
        internal static HorseGoalPin ParseWrapped(JsonNode o) => Parse(J.Opt(o, "pinned"));
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-HGOAL-010: a horse's goal chain. NotFoundException HORSE_NOT_FOUND (not owned) / NOT_FOUND (goals off).</summary>
        public Task<HorseGoalsView> GetHorseGoalsAsync(string horseId, CancellationToken ct = default)
            => Call("GET", "/v1/horses/" + Seg(horseId) + "/goals", null, true, null, true, HorseGoalsView.Parse, ct);

        /// <summary>
        /// REQ-HGOAL-007: pin a horse's goal to the home (null = unpin). A value replacement, safe to retry. ConflictException
        /// NOT_ELIGIBLE for a retired horse or one whose chain is complete. Returns the new pin (null when unpinned).
        /// </summary>
        public Task<HorseGoalPin> PinHorseGoalAsync(string horseId, CancellationToken ct = default)
            => Call("PUT", "/v1/horse-goals/pin", JsonNode.Obj().Set("horseId", horseId == null ? JsonNode.Null() : JsonNode.Str(horseId)), true, null, true, HorseGoalPin.ParseWrapped, ct);

        /// <summary>REQ-HGOAL-010: the pinned goal (null = none, or the pinned horse no longer qualifies).</summary>
        public Task<HorseGoalPin> GetPinnedHorseGoalAsync(CancellationToken ct = default)
            => Call("GET", "/v1/horse-goals/pinned", null, true, null, true, HorseGoalPin.ParseWrapped, ct);
    }

    public sealed partial class AnalyticsEvent
    {
        /// <summary>REQ-HGOAL-012: a goal panel was opened (surface "detail") or the pinned goal shown on the home ("home", once per game day).</summary>
        public static AnalyticsEvent HorseGoalView(long atMs, string surface, int done)
        {
            if (surface != "detail" && surface != "home") throw new ArgumentException("unknown goal surface " + surface);
            return new AnalyticsEvent("hgoal_view", atMs, JsonNode.Obj().Set("surface", surface).Set("done", Math.Max(0, Math.Min(done, 8))));
        }
    }
}
