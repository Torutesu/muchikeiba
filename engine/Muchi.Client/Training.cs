using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-TRAIN-001..014: 調教 (server/src/domain/training.ts, contracts/protocol.md §22).
    // The client never decides an outcome: it starts a session, plays the timing mini-game against the beats the server
    // issued, and submits the tap times (ms after the mini-game started). The server re-scores them with the same
    // steps as TrainingScorer below and applies the growth. Growth counts in races but ranked / tournaments / time attack
    // normalise it to the class cap; fatigue never reaches a race (TrainingRules says so — show it).

    /// <summary>The mini-game rules (server progression.training.timing).</summary>
    public sealed class TrainingTiming
    {
        public int Beats, DurationMs, LeadMs, TailMs, PerfectMs, GoodMs, PerfectPoints, GoodPoints, StrayPenalty, PermillePerPoint, MaxTaps, MinTapGapMs, MaxScore;
        internal static TrainingTiming Parse(JsonNode o) => o == null ? new TrainingTiming() : new TrainingTiming
        {
            Beats = J.Int(o, "beats"), DurationMs = J.Int(o, "durationMs"), LeadMs = J.Int(o, "leadMs"), TailMs = J.Int(o, "tailMs"),
            PerfectMs = J.Int(o, "perfectMs"), GoodMs = J.Int(o, "goodMs"), PerfectPoints = J.Int(o, "perfectPoints"), GoodPoints = J.Int(o, "goodPoints"),
            StrayPenalty = J.Int(o, "strayPenalty"), PermillePerPoint = J.Int(o, "permillePerPoint"), MaxTaps = J.Int(o, "maxTaps"),
            MinTapGapMs = J.Int(o, "minTapGapMs"), MaxScore = J.Int(o, "maxScore"),
        };
    }

    /// <summary>What a run of the mini-game scored (the server's scoreTiming result).</summary>
    public sealed class TimingScore
    {
        public int Perfect, Good, Miss, Stray, Score, BonusPermille;
        internal static TimingScore Parse(JsonNode o) => o == null ? new TimingScore() : new TimingScore
        {
            Perfect = J.Int(o, "perfect"), Good = J.Int(o, "good"), Miss = J.Int(o, "miss"), Stray = J.Int(o, "stray"), Score = J.Int(o, "score"), BonusPermille = J.Int(o, "bonusPermille"),
        };
    }

    /// <summary>
    /// REQ-TRAIN-006: the deterministic scorer, step for step the server's scoreTiming (shared test vector in
    /// server/test/training.test.ts). Beats in order; each takes the closest unused tap within GoodMs (ties → the earlier
    /// tap); taps that hit no beat cost StrayPenalty; the score is clamped to 0..MaxScore. Use it for the instant on-screen
    /// result; the server's number is the one that counts.
    /// </summary>
    public static class TrainingScorer
    {
        public static TimingScore Score(TrainingTiming t, IReadOnlyList<int> beats, IReadOnlyList<int> taps)
        {
            var used = new bool[taps.Count];
            int perfect = 0, good = 0, miss = 0;
            foreach (var b in beats)
            {
                int best = -1; long bestD = long.MaxValue;
                for (int j = 0; j < taps.Count; j++)
                {
                    if (used[j]) continue;
                    long d = Math.Abs((long)taps[j] - b);
                    if (d <= t.GoodMs && d < bestD) { best = j; bestD = d; }
                }
                if (best < 0) { miss++; continue; }
                used[best] = true;
                if (bestD <= t.PerfectMs) perfect++; else good++;
            }
            int stray = taps.Count - perfect - good;
            int max = t.Beats * t.PerfectPoints;
            int score = Math.Max(0, Math.Min(max, perfect * t.PerfectPoints + good * t.GoodPoints - stray * t.StrayPenalty));
            return new TimingScore { Perfect = perfect, Good = good, Miss = miss, Stray = stray, Score = score, BonusPermille = score * t.PermillePerPoint };
        }

        /// <summary>The judgement of one tap against the nearest beat (for the on-screen 「◎ / ○ / ×」 flash only).</summary>
        public static string Judge(TrainingTiming t, IReadOnlyList<int> beats, int tapMs)
        {
            long best = long.MaxValue;
            foreach (var b in beats) best = Math.Min(best, Math.Abs((long)tapMs - b));
            return best <= t.PerfectMs ? "perfect" : best <= t.GoodMs ? "good" : "miss";
        }

        /// <summary>REQ-TRAIN-007: the same bounds the server checks, so a tap the server would refuse is never recorded.</summary>
        public static bool Accepts(TrainingTiming t, IReadOnlyList<int> taps, int nextTapMs)
        {
            if (taps.Count >= t.MaxTaps) return false;
            if (nextTapMs < 0 || nextTapMs > t.DurationMs) return false;
            return taps.Count == 0 || nextTapMs - taps[taps.Count - 1] >= t.MinTapGapMs;
        }

        /// <summary>The grade the server will give (great ≥ 90% of the max score, good ≥ 50%).</summary>
        public static string Grade(TrainingTiming t, int score, bool skipped)
        {
            if (skipped) return "normal";
            int max = t.Beats * t.PerfectPoints;
            return score * 10 >= max * 9 ? "great" : score * 2 >= max ? "good" : "normal";
        }
    }

    public sealed class TrainingMenu
    {
        public string Id, Name;
        public int BaseGain, Fatigue, BondMultiplier = 1;
        public Dictionary<string, int> Weights = new Dictionary<string, int>();
        internal static TrainingMenu Parse(JsonNode o) => new TrainingMenu
        {
            Id = J.Str(o, "id"), Name = J.Str(o, "name"), BaseGain = J.Int(o, "baseGain"), Fatigue = J.Int(o, "fatigue"), BondMultiplier = J.Int(o, "bondMultiplier", 1),
            Weights = J.Map(o, "weights", x => x.AsInt()),
        };
    }

    public sealed class TrainingItem
    {
        public string ItemId, Name;
        public int FatigueRelief, Owned;
        internal static TrainingItem Parse(JsonNode o) => new TrainingItem { ItemId = J.Str(o, "itemId"), Name = J.Str(o, "name"), FatigueRelief = J.Int(o, "fatigueRelief"), Owned = J.Int(o, "owned") };
    }

    public sealed class TrainingLogEntry
    {
        public long At;
        public string MenuId, Grade;
        public int Gain, Score;
        internal static TrainingLogEntry Parse(JsonNode o) => new TrainingLogEntry { At = J.Long(o, "at"), MenuId = J.Str(o, "menuId"), Grade = J.Str(o, "grade"), Gain = J.Int(o, "gain"), Score = J.Int(o, "score") };
    }

    /// <summary>
    /// One active horse on the training screen. Blocked (and per menu MenuBlocked): null (can train) | no_slots |
    /// horse_daily_limit | potential_full | tired (only menus that add fatigue) | retired. Condition: fresh | normal | tired.
    /// </summary>
    public sealed class TrainingHorse
    {
        public string HorseId, Name, Rarity, Condition, Blocked;
        public Stats Trained = new Stats();
        public int TrainedTotal, Potential, PerStatCap, Fatigue, BondLevel, TodayCount, Sessions;
        public List<TrainingLogEntry> Log = new List<TrainingLogEntry>();
        /// <summary>False in the action responses' partial views (the log is only in GET /v1/training; MergeInto keeps the old one).</summary>
        public bool HasLog;
        public Dictionary<string, string> MenuBlocked = new Dictionary<string, string>();
        public bool CanTrain(string menuId) => MenuBlocked.TryGetValue(menuId, out var b) ? b == null : Blocked == null;
        internal static TrainingHorse Parse(JsonNode o)
        {
            var h = new TrainingHorse
            {
                HorseId = J.Str(o, "horseId"), Name = J.Str(o, "name"), Rarity = J.Str(o, "rarity"), Condition = J.Str(o, "condition"), Blocked = J.Str(o, "blocked"),
                Trained = Stats.Parse(J.Opt(o, "trained")), TrainedTotal = J.Int(o, "trainedTotal"), Potential = J.Int(o, "potential"), PerStatCap = J.Int(o, "perStatCap"),
                Fatigue = J.Int(o, "fatigue"), BondLevel = J.Int(o, "bondLevel", 1), TodayCount = J.Int(o, "todayCount"), Sessions = J.Int(o, "sessions"),
                Log = J.List(o, "log", TrainingLogEntry.Parse), HasLog = J.Opt(o, "log") != null,
            };
            foreach (var m in J.List(o, "menus", x => x)) h.MenuBlocked[J.Str(m, "id")] = J.Str(m, "blocked");
            return h;
        }
    }

    /// <summary>The fairness rules the server applies (REQ-TRAIN-003/009/010) — the screen states them as they are.</summary>
    public sealed class TrainingRules
    {
        public bool RankedNormalized = true, FatigueAffectsRaces, Inherited, PaidBoosts;
        internal static TrainingRules Parse(JsonNode o) => o == null ? new TrainingRules() : new TrainingRules
        {
            RankedNormalized = J.Bool(o, "rankedNormalized", true), FatigueAffectsRaces = J.Bool(o, "fatigueAffectsRaces"), Inherited = J.Bool(o, "inherited"), PaidBoosts = J.Bool(o, "paidBoosts"),
        };
    }

    /// <summary>An open session: the beats (ms after the mini-game starts) to play against.</summary>
    public sealed class TrainingSession
    {
        public string SessionId, HorseId, MenuId;
        public long StartedAt, ExpiresAt;
        public int[] Beats = new int[0];
        public int DurationMs;
        internal static TrainingSession Parse(JsonNode o) => o == null ? null : new TrainingSession
        {
            SessionId = J.Str(o, "sessionId"), HorseId = J.Str(o, "horseId"), MenuId = J.Str(o, "menuId"), StartedAt = J.Long(o, "startedAt"), ExpiresAt = J.Long(o, "expiresAt"),
            Beats = J.Ints(o, "beats"), DurationMs = J.Int(o, "durationMs"),
        };
    }

    /// <summary>
    /// GET /v1/training. Enabled=false → hide the tile. In the start / finish / item responses <see cref="Partial"/> is true and
    /// <see cref="Horses"/> holds only the horse concerned: use <see cref="MergeInto"/> on the full view you have.
    /// </summary>
    public sealed class TrainingView
    {
        public bool Enabled, Partial;
        public int SlotsPerDay, UsedToday, SlotsLeft, PerHorsePerDay, FatigueMax, RestAt, RecoveryPerDay;
        public List<TrainingMenu> Menus = new List<TrainingMenu>();
        public TrainingTiming Timing = new TrainingTiming();
        public List<TrainingItem> Items = new List<TrainingItem>();
        public List<TrainingHorse> Horses = new List<TrainingHorse>();
        public TrainingSession Open;
        public TrainingRules Rules = new TrainingRules();
        public TrainingHorse Horse(string id) => Horses.Find(h => h.HorseId == id);
        public TrainingMenu Menu(string id) => Menus.Find(m => m.Id == id);

        /// <summary>A partial view (one horse) applied to the full view <paramref name="full"/>: counts, items, open session and that horse. Returns the merged view.</summary>
        public TrainingView MergeInto(TrainingView full)
        {
            if (!Partial || full == null) return this;
            var horses = new List<TrainingHorse>(full.Horses);
            foreach (var h in Horses)
            {
                int i = horses.FindIndex(x => x.HorseId == h.HorseId);
                if (i >= 0) { if (!h.HasLog) { h.Log = horses[i].Log; h.HasLog = horses[i].HasLog; } horses[i] = h; } else horses.Add(h);
            }
            // the account's slots changed: every other horse's "no_slots" state follows the new count
            foreach (var h in horses)
            {
                if (Horses.Exists(x => x.HorseId == h.HorseId)) continue;
                if (SlotsLeft <= 0) { if (h.Blocked == null) h.Blocked = "no_slots"; foreach (var k in new List<string>(h.MenuBlocked.Keys)) if (h.MenuBlocked[k] == null) h.MenuBlocked[k] = "no_slots"; }
            }
            return new TrainingView
            {
                Enabled = Enabled, Partial = false, SlotsPerDay = SlotsPerDay, UsedToday = UsedToday, SlotsLeft = SlotsLeft, PerHorsePerDay = PerHorsePerDay,
                FatigueMax = FatigueMax, RestAt = RestAt, RecoveryPerDay = RecoveryPerDay, Menus = Menus, Timing = Timing, Items = Items,
                Horses = horses, Open = Open, Rules = Rules,
            };
        }
        internal static TrainingView Parse(JsonNode o)
        {
            if (o == null) return null;
            var f = J.Opt(o, "fatigue");
            return new TrainingView
            {
                Enabled = J.Bool(o, "enabled"), Partial = J.Bool(o, "partial"), SlotsPerDay = J.Int(o, "slotsPerDay"), UsedToday = J.Int(o, "usedToday"), SlotsLeft = J.Int(o, "slotsLeft"),
                PerHorsePerDay = J.Int(o, "perHorsePerDay"), FatigueMax = J.Int(f, "max", 100), RestAt = J.Int(f, "restAt"), RecoveryPerDay = J.Int(f, "recoveryPerDay"),
                Menus = J.List(o, "menus", TrainingMenu.Parse), Timing = TrainingTiming.Parse(J.Opt(o, "timing")), Items = J.List(o, "items", TrainingItem.Parse),
                Horses = J.List(o, "horses", TrainingHorse.Parse), Open = TrainingSession.Parse(J.Opt(o, "open")), Rules = TrainingRules.Parse(J.Opt(o, "rules")),
            };
        }
    }

    /// <summary>POST /v1/training/start. Preview = whole stat points without / with a perfect mini-game.</summary>
    public sealed class TrainingStart
    {
        public TrainingSession Session;
        public int PreviewMin, PreviewMax, SlotsLeft;
        /// <summary>This session's growth in thousandths of a point without / with a perfect mini-game (the part below a whole point carries over).</summary>
        public int PreviewMinMilli, PreviewMaxMilli;
        public TrainingView Training;
        internal static TrainingStart Parse(JsonNode o)
        {
            var p = J.Opt(o, "preview");
            return new TrainingStart
            {
                Session = TrainingSession.Parse(J.Opt(o, "session")), PreviewMin = J.Int(p, "min"), PreviewMax = J.Int(p, "max"), PreviewMinMilli = J.Int(p, "minMilli"), PreviewMaxMilli = J.Int(p, "maxMilli"), SlotsLeft = J.Int(o, "slotsLeft"),
                Training = TrainingView.Parse(J.Opt(o, "training")),
            };
        }
    }

    /// <summary>POST /v1/training/:id/finish. Grade: great | good | normal. Settled: done | skipped | expired.</summary>
    public sealed class TrainingResult
    {
        public string SessionId, HorseId, MenuId, Grade, Settled;
        public TimingScore Timing = new TimingScore();
        public Stats Gain = new Stats(), Trained = new Stats();
        public int Total, TrainedTotal, Potential, Fatigue;
        public bool Capped;
        public int EfficiencyPermille, BondPermille, TimingPermille, SoftPermille;
        public TrainingView Training;
        internal static TrainingResult Parse(JsonNode o)
        {
            var b = J.Opt(o, "breakdown");
            return new TrainingResult
            {
                SessionId = J.Str(o, "sessionId"), HorseId = J.Str(o, "horseId"), MenuId = J.Str(o, "menuId"), Grade = J.Str(o, "grade"), Settled = J.Str(o, "settled"),
                Timing = TimingScore.Parse(J.Opt(o, "timing")), Gain = Stats.Parse(J.Opt(o, "gain")), Trained = Stats.Parse(J.Opt(o, "trained")),
                Total = J.Int(o, "total"), TrainedTotal = J.Int(o, "trainedTotal"), Potential = J.Int(o, "potential"), Fatigue = J.Int(o, "fatigue"), Capped = J.Bool(o, "capped"),
                EfficiencyPermille = J.Int(b, "efficiencyPermille"), BondPermille = J.Int(b, "bondPermille"), TimingPermille = J.Int(b, "timingPermille"), SoftPermille = J.Int(b, "softPermille"),
                Training = TrainingView.Parse(J.Opt(o, "training")),
            };
        }
    }

    /// <summary>POST /v1/training/items/:itemId/use.</summary>
    public sealed class TrainingItemUse
    {
        public string ItemId, HorseId;
        public int FatigueBefore, Fatigue, Remaining;
        public TrainingView Training;
        internal static TrainingItemUse Parse(JsonNode o) => new TrainingItemUse
        {
            ItemId = J.Str(o, "itemId"), HorseId = J.Str(o, "horseId"), FatigueBefore = J.Int(o, "fatigueBefore"), Fatigue = J.Int(o, "fatigue"), Remaining = J.Int(o, "remaining"),
            Training = TrainingView.Parse(J.Opt(o, "training")),
        };
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-TRAIN-001: today's slots, menus, each active horse's growth and fatigue, an open session to resume.</summary>
        public Task<TrainingView> GetTrainingAsync(CancellationToken ct = default)
            => Call("GET", "/v1/training", null, true, null, true, TrainingView.Parse, ct);

        /// <summary>
        /// REQ-TRAIN-002: start a session (keyed: a retry returns the same session). Uses one of today's slots.
        /// ConflictException TRAINING_LIMIT / TRAINING_TIRED / TRAINING_POTENTIAL_FULL / HORSE_NOT_ACTIVE.
        /// </summary>
        public Task<TrainingStart> StartTrainingAsync(string horseId, string menuId, string idempotencyKey = null, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("horseId", horseId);
            b.Set("menuId", menuId);
            return Call("POST", "/v1/training/start", b, true, idempotencyKey ?? NewIdempotencyKey(), true, TrainingStart.Parse, ct);
        }

        /// <summary>
        /// REQ-TRAIN-006: finish with the tap times (ms after the mini-game started, increasing), or skipped=true for no mini-game.
        /// 422 TRAINING_INPUT_INVALID (taps the server cannot accept), ConflictException TRAINING_SESSION_EXPIRED / TRAINING_SESSION_USED.
        /// </summary>
        public Task<TrainingResult> FinishTrainingAsync(string sessionId, IReadOnlyList<int> taps, bool skipped = false, string idempotencyKey = null, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            var a = JsonNode.Arr();
            if (!skipped && taps != null) foreach (var t in taps) a.Add(JsonNode.Num(t));
            b.Set("taps", a);
            if (skipped) b.Set("skipped", true);
            return Call("POST", "/v1/training/" + Seg(sessionId) + "/finish", b, true, idempotencyKey ?? NewIdempotencyKey(), true, TrainingResult.Parse, ct);
        }

        /// <summary>REQ-TRAIN-008: a training item (fatigue relief) on one horse. NOT_ELIGIBLE when the horse is not tired; INSUFFICIENT_ITEMS.</summary>
        public Task<TrainingItemUse> UseTrainingItemAsync(string itemId, string horseId, string idempotencyKey = null, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("horseId", horseId);
            return Call("POST", "/v1/training/items/" + Seg(itemId) + "/use", b, true, idempotencyKey ?? NewIdempotencyKey(), true, TrainingItemUse.Parse, ct);
        }
    }
}
