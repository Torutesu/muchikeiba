using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Client
{
    // =====================================================================================================
    // 騎手の道 (single-player career, REQ-CAREER-*, contracts/protocol.md §66).
    //
    // Flow: GetCareerAsync (the map: chapters, races, story, objectives, my stars) → StartCareerRaceAsync (the server issues
    // the config: mode challenge, the CPU field, the chapter's stat cap, no skills) → CareerRun (OfflineRace on the device in
    // the player's slot, the clear objective live in the HUD) → SubmitCareerRaceAsync (inputs only; the server re-simulates
    // with the C# verifier and evaluates every objective itself, then pays the first clear / new stars once ever).
    // CareerRun.StarsNow gives the device the same verdict before the answer comes back; the server's is the one that counts.
    // =====================================================================================================

    /// <summary>Server limits for career submissions (career.json config.maxInputs).</summary>
    public static class CareerLimits
    {
        public const int MaxInputs = 400;
        /// <summary>Stars per race (star 1 = the clear).</summary>
        public const int StarsPerRace = 3;
    }

    /// <summary>One objective of a race (star 1 = the clear, stars 2 and 3 = the extra goals).</summary>
    public sealed class CareerObjective
    {
        public int Star;
        public ChallengeConditions Conditions;
        public List<ChallengeLabel> Labels = new List<ChallengeLabel>();
        /// <summary>The reward this objective pays once ever (null for a star without one).</summary>
        public Reward Reward;
        /// <summary>The labels joined: "1着でゴール・ムチ3回以内".</summary>
        public string Text => string.Join("・", Labels.ConvertAll(l => l.Text));
        internal static CareerObjective Parse(JsonNode o)
        {
            var rw = J.Opt(o, "reward");
            return new CareerObjective
            {
                Star = J.Int(o, "star"), Conditions = ChallengeConditions.Parse(J.Opt(o, "objective")), Labels = J.List(o, "labels", ChallengeLabel.Parse),
                Reward = rw == null ? null : Reward.Parse(rw),
            };
        }
    }

    public sealed class CareerRewarded
    {
        public bool Clear, Star2, Star3;
        internal static CareerRewarded Parse(JsonNode o) => o == null ? new CareerRewarded() : new CareerRewarded { Clear = J.Bool(o, "clear"), Star2 = J.Bool(o, "star2"), Star3 = J.Bool(o, "star3") };
    }

    public sealed class CareerProgress
    {
        public bool Unlocked, Cleared;
        public long? ClearedAt;
        public int[] Stars = new int[0];
        public int Attempts;
        public int? BestPlace;
        public long? BestTimeMs;
        public CareerRewarded Rewarded = new CareerRewarded();
        public bool HasStar(int star) => Array.IndexOf(Stars, star) >= 0;
        internal static CareerProgress Parse(JsonNode o) => o == null ? null : new CareerProgress
        {
            Unlocked = J.Bool(o, "unlocked"), Cleared = J.Bool(o, "cleared"), ClearedAt = J.LongN(o, "clearedAt"), Stars = J.Ints(o, "stars"), Attempts = J.Int(o, "attempts"),
            BestPlace = J.IntN(o, "bestPlace"), BestTimeMs = J.LongN(o, "bestTimeMs"), Rewarded = CareerRewarded.Parse(J.Opt(o, "rewarded")),
        };
    }

    /// <summary>One race of the map (GET /v1/career) or the race of a started session (<see cref="Progress"/> null there).</summary>
    public sealed class CareerRace
    {
        public string Id, ChapterId, Title, StoryBefore, StoryAfter, TrackId, Surface, Going;
        public int DistanceM, FieldSize, CpuCount, CpuLevel, CpuStatPermille, StatCap;
        public bool Night;
        /// <summary>Running styles of the CPU field ("nige", "senko", …), or empty for any.</summary>
        public List<string> CpuStyles = new List<string>();
        public List<CareerObjective> Objectives = new List<CareerObjective>();
        public CareerProgress Progress;
        public CareerObjective Clear => Objectives.Find(o => o.Star == 1);
        public int MaxStars => Objectives.Count;
        internal static CareerRace Parse(JsonNode o)
        {
            var story = J.Opt(o, "story");
            return new CareerRace
            {
                Id = J.Str(o, "id"), ChapterId = J.Str(o, "chapterId"), Title = J.Str(o, "title"), StoryBefore = J.Str(story, "before"), StoryAfter = J.Str(story, "after"),
                TrackId = J.Str(o, "trackId"), Surface = J.Str(o, "surface"), Going = J.Str(o, "going"), DistanceM = J.Int(o, "distanceM"), FieldSize = J.Int(o, "fieldSize"),
                CpuCount = J.Int(o, "cpuCount"), CpuLevel = J.Int(o, "cpuLevel"), CpuStatPermille = J.Int(o, "cpuStatPermille", 1000), StatCap = J.Int(o, "statCap"),
                Night = J.Bool(o, "night"), CpuStyles = J.List(o, "cpuStyles", n => n.AsString()), Objectives = J.List(o, "objectives", CareerObjective.Parse),
                Progress = CareerProgress.Parse(J.Opt(o, "progress")),
            };
        }
    }

    public sealed class CareerChapter
    {
        public string Id, Art, Title, Subtitle;
        public int StatCap, Stars, MaxStars, ClearedRaces;
        public bool Unlocked, Cleared;
        public List<CareerRace> Races = new List<CareerRace>();
        internal static CareerChapter Parse(JsonNode o) => new CareerChapter
        {
            Id = J.Str(o, "id"), Art = J.Str(o, "art"), Title = J.Str(o, "title"), Subtitle = J.Str(o, "subtitle"), StatCap = J.Int(o, "statCap"),
            Stars = J.Int(o, "stars"), MaxStars = J.Int(o, "maxStars"), ClearedRaces = J.Int(o, "clearedRaces"), Unlocked = J.Bool(o, "unlocked"), Cleared = J.Bool(o, "cleared"),
            Races = J.List(o, "races", CareerRace.Parse),
        };
    }

    public sealed class CareerRules
    {
        public bool Skills, Normalized, Ranked, Leaderboards, Missions, Energy, PaidContinue, PaidSkip, RewardOnce;
        internal static CareerRules Parse(JsonNode o) => o == null ? null : new CareerRules
        {
            Skills = J.Bool(o, "skills"), Normalized = J.Bool(o, "normalized"), Ranked = J.Bool(o, "ranked"), Leaderboards = J.Bool(o, "leaderboards"), Missions = J.Bool(o, "missions"),
            Energy = J.Bool(o, "energy"), PaidContinue = J.Bool(o, "paidContinue"), PaidSkip = J.Bool(o, "paidSkip"), RewardOnce = J.Bool(o, "rewardOnce"),
        };
    }

    /// <summary>GET /v1/career</summary>
    public sealed class CareerView
    {
        public bool Enabled;
        public int Version, TotalStars, MaxStars, ClearedRaces, TotalRaces, StartsLeftToday;
        public string NextRaceId;
        public List<CareerChapter> Chapters = new List<CareerChapter>();
        public CareerRules Rules;

        public CareerChapter Chapter(string id) => Chapters.Find(c => c.Id == id);
        public CareerRace Race(string id)
        {
            foreach (var c in Chapters) { var r = c.Races.Find(x => x.Id == id); if (r != null) return r; }
            return null;
        }
        /// <summary>The first open race not yet cleared (the map's marker), null when the whole road is cleared.</summary>
        public CareerRace NextRace => NextRaceId == null ? null : Race(NextRaceId);

        internal static CareerView Parse(JsonNode o) => new CareerView
        {
            Enabled = J.Bool(o, "enabled"), Version = J.Int(o, "version"), TotalStars = J.Int(o, "totalStars"), MaxStars = J.Int(o, "maxStars"), ClearedRaces = J.Int(o, "clearedRaces"),
            TotalRaces = J.Int(o, "totalRaces"), StartsLeftToday = J.Int(o, "startsLeftToday"), NextRaceId = J.Str(o, "nextRaceId"),
            Chapters = J.List(o, "chapters", CareerChapter.Parse), Rules = CareerRules.Parse(J.Opt(o, "rules")),
        };
    }

    /// <summary>A started career race (POST /v1/career/races/:raceId/start).</summary>
    public sealed class CareerSession
    {
        public string SessionId, Token, RaceId, ChapterId;
        public int PlayerSlot, StartsLeftToday;
        public long ExpiresAt;
        public RaceConfig Config;
        /// <summary>The config exactly as received (echoed back on submit so the server can detect tampering).</summary>
        public JsonNode ConfigJson;
        public CareerRace Race;
        /// <summary>The clear objective in the weekly challenge shape (the HUD line).</summary>
        public ChallengeConditions Conditions;
        internal static CareerSession Parse(JsonNode o)
        {
            var cfg = J.Opt(o, "config");
            return new CareerSession
            {
                SessionId = J.Str(o, "sessionId"), Token = J.Str(o, "token"), RaceId = J.Str(o, "raceId"), ChapterId = J.Str(o, "chapterId"),
                PlayerSlot = J.Int(o, "playerSlot"), StartsLeftToday = J.Int(o, "startsLeftToday"), ExpiresAt = J.Long(o, "expiresAt"),
                ConfigJson = cfg, Config = cfg == null ? null : ProtocolCodec.ParseConfig(cfg), Race = CareerRace.Parse(J.Opt(o, "race")),
                Conditions = ChallengeConditions.Parse(J.Opt(o, "conditions")),
            };
        }
    }

    public sealed class CareerStarResult
    {
        public int Star;
        public bool Ok, Newly;
        public ChallengeEvaluation Evaluation;
        internal static CareerStarResult Parse(JsonNode o) => new CareerStarResult { Star = J.Int(o, "star"), Ok = J.Bool(o, "ok"), Newly = J.Bool(o, "newly"), Evaluation = ChallengeEvaluation.Parse(J.Opt(o, "evaluation")) };
    }

    public sealed class CareerGrant
    {
        /// <summary>clear / star2 / star3</summary>
        public string Kind;
        public Reward Reward;
        internal static CareerGrant Parse(JsonNode o) => new CareerGrant { Kind = J.Str(o, "kind"), Reward = Reward.Parse(J.Opt(o, "reward")) };
    }

    /// <summary>POST /v1/career/submit</summary>
    public sealed class CareerResult
    {
        public string SessionId, RaceId, ChapterId, ResultHash, UnlockedRaceId;
        public ChallengeEvaluation Evaluation;
        public bool Cleared, FirstClear, ChapterCleared;
        public List<CareerStarResult> Objectives = new List<CareerStarResult>();
        public int[] Stars = new int[0], NewStars = new int[0];
        public List<CareerGrant> Rewards = new List<CareerGrant>();
        public int TotalStars;
        internal static CareerResult Parse(JsonNode o) => new CareerResult
        {
            SessionId = J.Str(o, "sessionId"), RaceId = J.Str(o, "raceId"), ChapterId = J.Str(o, "chapterId"), ResultHash = J.Str(o, "resultHash"),
            UnlockedRaceId = J.Str(o, "unlockedRaceId"), Evaluation = ChallengeEvaluation.Parse(J.Opt(o, "evaluation")), Cleared = J.Bool(o, "cleared"),
            FirstClear = J.Bool(o, "firstClear"), ChapterCleared = J.Bool(o, "chapterCleared"), Objectives = J.List(o, "objectives", CareerStarResult.Parse),
            Stars = J.Ints(o, "stars"), NewStars = J.Ints(o, "newStars"), Rewards = J.List(o, "rewards", CareerGrant.Parse), TotalStars = J.Int(o, "totalStars"),
        };
    }

    /// <summary>
    /// One career race on the device: a <see cref="ChallengeRun"/> (the player's OfflineRace in the issued slot, the clear
    /// objective live in the HUD) plus the extra objectives, judged on the device exactly like the server (REQ-CAREER-008:
    /// a star needs the clear in the same run).
    /// </summary>
    public sealed class CareerRun
    {
        public const string RaceIdPrefix = "car_";
        /// <summary>The mode label of a career race on photo and share cards (never 「週替わりチャレンジ」).</summary>
        public const string ModeLabel = "騎手の道";

        /// <summary>True for a 騎手の道 config (raceId car_…; the engine mode is challenge).</summary>
        public static bool IsCareer(RaceConfig c) => c != null && c.RaceId != null && c.RaceId.StartsWith(RaceIdPrefix, StringComparison.Ordinal);

        public CareerSession Session { get; }
        public ChallengeRun Challenge { get; }
        /// <summary>Star 1 (the clear) first, then stars 2 and 3.</summary>
        public IReadOnlyList<ChallengeConditions> Objectives { get; }
        public OfflineRace Race => Challenge.Race;
        public int PlayerSlot => Challenge.PlayerSlot;

        public CareerRun(CareerSession session) : this(session.Config, session.PlayerSlot, ObjectivesOf(session)) { Session = session; }

        /// <summary>Offline use (tests, the prototype): a career config, the player's slot and the objectives (star 1 first).</summary>
        public CareerRun(RaceConfig config, int playerSlot, IReadOnlyList<ChallengeConditions> objectives)
        {
            if (objectives == null || objectives.Count < 1 || objectives.Count > CareerLimits.StarsPerRace) throw new ArgumentException("1..3 objectives (star 1 = the clear)");
            Objectives = objectives;
            Challenge = new ChallengeRun(config, playerSlot, objectives[0]);
            Challenge.Race.MaxRecordedInputs = CareerLimits.MaxInputs;
        }

        private static List<ChallengeConditions> ObjectivesOf(CareerSession s)
        {
            var list = new List<ChallengeConditions>();
            if (s.Race != null) foreach (var o in s.Race.Objectives) list.Add(o.Conditions ?? new ChallengeConditions());
            if (list.Count == 0) list.Add(s.Conditions ?? new ChallengeConditions());
            return list;
        }

        /// <summary>Whips used so far (the number the server will count).</summary>
        public int WhipsUsed => Challenge.WhipsUsed;

        /// <summary>The device's verdict per objective once the race has finished (null before). Star k (k ≥ 2) needs star 1.</summary>
        public List<ChallengeEvaluation> Evaluate()
        {
            if (!Race.IsFinished) return null;
            var list = new List<ChallengeEvaluation>();
            foreach (var o in Objectives) list.Add(ChallengeEvaluator.Evaluate(o, Race.Config, PlayerSlot, Race.RecordedInputs, Race.Sim.Result));
            return list;
        }

        /// <summary>The stars this run earns on the device (1-based, ascending), empty before the finish or on a fail.</summary>
        public int[] StarsNow()
        {
            var ev = Evaluate();
            if (ev == null || !ev[0].Cleared) return new int[0];
            var stars = new List<int> { 1 };
            for (int i = 1; i < ev.Count; i++) if (ev[i].Cleared) stars.Add(i + 1);
            return stars.ToArray();
        }

        /// <summary>The replay log the server will verify (issued config + the player's inputs).</summary>
        public ReplayLog Log() => Challenge.Log();
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-CAREER-003: the 騎手の道 map with my progress (Enabled false when off).</summary>
        public Task<CareerView> GetCareerAsync(CancellationToken ct = default)
            => Call("GET", "/v1/career", null, true, null, true, CareerView.Parse, ct);

        /// <summary>
        /// REQ-CAREER-004: start an open race with an own active horse. Keyed: keep the same <paramref name="idempotencyKey"/>
        /// until an answer arrives (a retry returns the same session). ConflictException CAREER_LOCKED / HORSE_NOT_ACTIVE,
        /// CAREER_LIMIT_REACHED (anti-abuse), NotFoundException (unknown race, or the mode is off).
        /// </summary>
        public Task<CareerSession> StartCareerRaceAsync(string raceId, string horseId, string idempotencyKey = null, CancellationToken ct = default)
        {
            if (string.IsNullOrEmpty(raceId)) throw new ArgumentException("raceId");
            if (string.IsNullOrEmpty(horseId)) throw new ArgumentException("horseId");
            var b = JsonNode.Obj();
            b.Set("horseId", horseId);
            return Call("POST", "/v1/career/races/" + Seg(raceId) + "/start", b, true, idempotencyKey ?? NewIdempotencyKey(), true, CareerSession.Parse, ct);
        }

        /// <summary>
        /// REQ-CAREER-007: submit a finished run (inputs + the device's result hash; the issued config is echoed). Safe to retry:
        /// the server returns the stored result for the same session and hash, and pays nothing twice. ConflictException
        /// CAREER_RESULT_MISMATCH when the re-simulation differs; ServerException VERIFIER_UNAVAILABLE (the session stays open).
        /// </summary>
        public Task<CareerResult> SubmitCareerRaceAsync(CareerSession session, CareerRun run, CancellationToken ct = default)
        {
            if (session == null) throw new ArgumentNullException(nameof(session));
            if (run == null || !run.Race.IsFinished) throw new InvalidOperationException("the race has not finished");
            return SubmitCareerRaceAsync(session, run.Race.RecordedInputs, run.Race.ResultHash, ct);
        }

        public Task<CareerResult> SubmitCareerRaceAsync(CareerSession session, IReadOnlyList<InputRecord> inputs, string resultHash, CancellationToken ct = default)
        {
            if (session == null) throw new ArgumentNullException(nameof(session));
            if (inputs == null) throw new ArgumentNullException(nameof(inputs));
            if (inputs.Count > CareerLimits.MaxInputs) throw new ArgumentException("too many inputs: " + inputs.Count + " (max " + CareerLimits.MaxInputs + ")", nameof(inputs));
            var b = JsonNode.Obj();
            b.Set("sessionId", session.SessionId);
            b.Set("token", session.Token);
            b.Set("resultHash", resultHash);
            var arr = JsonNode.Arr();
            foreach (var r in inputs)
            {
                var t = JsonNode.Arr();
                t.Add(JsonNode.Num(r.Tick));
                t.Add(JsonNode.Num(r.Slot));
                t.Add(JsonNode.Num(r.Cmd));
                arr.Add(t);
            }
            b.Set("inputs", arr);
            if (session.ConfigJson != null) b.Set("config", session.ConfigJson);
            return Call("POST", "/v1/career/submit", b, true, null, true, CareerResult.Parse, ct);
        }
    }
}
