using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Client
{
    // =====================================================================================================
    // 週替わりチャレンジ (weekly challenge, REQ-WCH-*, contracts/protocol.md §31).
    //
    // Flow: GetWeeklyChallengesAsync → StartWeeklyChallengeAsync (server issues the config: CPU field, ground,
    // normalised stats, no skills) → ChallengeRun (OfflineRace on the device in the player's slot, the condition
    // shown live in the HUD) → SubmitWeeklyChallengeAsync (inputs only; the server re-simulates with the C# verifier
    // and evaluates the conditions itself). ChallengeEvaluator gives the device the same verdict before the answer
    // comes back; the server's verdict is the one that counts.
    // =====================================================================================================

    /// <summary>Server limits for challenge submissions (progression.weeklyChallenge.maxInputs).</summary>
    public static class WeeklyChallengeLimits
    {
        public const int MaxInputs = 400;
    }

    /// <summary>The conditions of one challenge (all must hold, and the horse must finish).</summary>
    public sealed class ChallengeConditions
    {
        /// <summary>Finish in the top N (1 = win), or null.</summary>
        public int? MaxPlace;
        /// <summary>Required running style ("nige"/"senko"/"sashi"/"oikomi"), or null.</summary>
        public string Style;
        /// <summary>At most N whip inputs, or null.</summary>
        public int? MaxWhips;
        /// <summary>Finish within this race time (ms from the gate opening), or null.</summary>
        public long? MaxTimeMs;
        internal static ChallengeConditions Parse(JsonNode o) => new ChallengeConditions
        {
            MaxPlace = J.IntN(o, "maxPlace"), Style = J.Str(o, "style"), MaxWhips = J.IntN(o, "maxWhips"), MaxTimeMs = J.LongN(o, "maxTimeMs"),
        };
    }

    public sealed class ChallengeLabel
    {
        /// <summary>finish / place / style / whips / time</summary>
        public string Kind, Text;
        internal static ChallengeLabel Parse(JsonNode o) => new ChallengeLabel { Kind = J.Str(o, "kind"), Text = J.Str(o, "text") };
    }

    public sealed class ChallengeLoan
    {
        public string TemplateId, Name, Style;
        public int StatTotal;
        internal static ChallengeLoan Parse(JsonNode o) => o == null ? null : new ChallengeLoan
        {
            TemplateId = J.Str(o, "templateId"), Name = J.Str(o, "name"), Style = J.Str(o, "style"), StatTotal = J.Int(o, "statTotal"),
        };
    }

    public sealed class ChallengeProgress
    {
        public bool Cleared;
        public long? ClearedAt;
        public int Attempts;
        public int? BestPlace;
        public long? BestTimeMs;
        internal static ChallengeProgress Parse(JsonNode o) => o == null ? null : new ChallengeProgress
        {
            Cleared = J.Bool(o, "cleared"), ClearedAt = J.LongN(o, "clearedAt"), Attempts = J.Int(o, "attempts"), BestPlace = J.IntN(o, "bestPlace"), BestTimeMs = J.LongN(o, "bestTimeMs"),
        };
    }

    /// <summary>One challenge card (GET /v1/challenges/weekly). <see cref="Progress"/> is null in next week's preview.</summary>
    public sealed class WeeklyChallenge
    {
        public string Id, Title, TrackId, Surface, Going;
        public int DistanceM, CpuCount, CpuLevel, CpuStatPermille;
        public bool Night;
        public ChallengeConditions Conditions;
        public List<ChallengeLabel> Labels = new List<ChallengeLabel>();
        public Reward Reward;
        public ChallengeLoan Loan;
        public ChallengeProgress Progress;
        internal static WeeklyChallenge Parse(JsonNode o) => new WeeklyChallenge
        {
            Id = J.Str(o, "id"), Title = J.Str(o, "title"), TrackId = J.Str(o, "trackId"), Surface = J.Str(o, "surface"),
            Going = J.Str(o, "going"), DistanceM = J.Int(o, "distanceM"), CpuCount = J.Int(o, "cpuCount"), CpuLevel = J.Int(o, "cpuLevel"),
            CpuStatPermille = J.Int(o, "cpuStatPermille", 1000), Night = J.Bool(o, "night"), Conditions = ChallengeConditions.Parse(J.Opt(o, "conditions")),
            Labels = J.List(o, "labels", ChallengeLabel.Parse), Reward = Reward.Parse(J.Opt(o, "reward")), Loan = ChallengeLoan.Parse(J.Opt(o, "loan")),
            Progress = ChallengeProgress.Parse(J.Opt(o, "progress")),
        };
    }

    public sealed class ChallengeBadge
    {
        public string Id, Name;
        public bool Earned, NewlyEarned;
        public long? EarnedAt;
        internal static ChallengeBadge Parse(JsonNode o) => o == null ? null : new ChallengeBadge
        {
            Id = J.Str(o, "id"), Name = J.Str(o, "name"), Earned = J.Bool(o, "earned"), NewlyEarned = J.Bool(o, "newlyEarned"), EarnedAt = J.LongN(o, "earnedAt"),
        };
    }

    public sealed class EarnedBadge
    {
        public string WeekId, BadgeId;
        public long At;
        internal static EarnedBadge Parse(JsonNode o) => new EarnedBadge { WeekId = J.Str(o, "weekId"), BadgeId = J.Str(o, "badgeId"), At = J.Long(o, "at") };
    }

    public sealed class ChallengeWeekPreview
    {
        public string WeekId;
        public long StartsAt;
        public ChallengeBadge Badge;
        public List<WeeklyChallenge> Challenges = new List<WeeklyChallenge>();
        internal static ChallengeWeekPreview Parse(JsonNode o) => o == null ? null : new ChallengeWeekPreview
        {
            WeekId = J.Str(o, "weekId"), StartsAt = J.Long(o, "startsAt"), Badge = ChallengeBadge.Parse(J.Opt(o, "badge")), Challenges = J.List(o, "challenges", WeeklyChallenge.Parse),
        };
    }

    public sealed class ChallengeRules
    {
        public int StatCap;
        public bool Normalized, Skills, LoanAtCap, PaidBoosts, RewardOncePerWeek;
        internal static ChallengeRules Parse(JsonNode o) => o == null ? null : new ChallengeRules
        {
            StatCap = J.Int(o, "statCap"), Normalized = J.Bool(o, "normalized"), Skills = J.Bool(o, "skills"), LoanAtCap = J.Bool(o, "loanAtCap"),
            PaidBoosts = J.Bool(o, "paidBoosts"), RewardOncePerWeek = J.Bool(o, "rewardOncePerWeek"),
        };
    }

    /// <summary>GET /v1/challenges/weekly</summary>
    public sealed class WeeklyChallengeView
    {
        public bool Enabled;
        public string WeekId;
        public long StartsAt, EndsAt, ServerNow;
        public List<WeeklyChallenge> Challenges = new List<WeeklyChallenge>();
        public int ClearedCount, StartsLeftToday, BadgeCount;
        public ChallengeBadge Badge;
        public ChallengeWeekPreview Next;
        public List<EarnedBadge> Badges = new List<EarnedBadge>();
        public ChallengeRules Rules;

        public WeeklyChallenge Challenge(string id) => Challenges.Find(c => c.Id == id);

        /// <summary>Whole days left in the week (from the server's clock, rounded up; 0 once it has ended). Never a fake timer.</summary>
        public int DaysLeft => EndsAt <= ServerNow ? 0 : (int)((EndsAt - ServerNow + 86_399_999) / 86_400_000);

        internal static WeeklyChallengeView Parse(JsonNode o) => new WeeklyChallengeView
        {
            Enabled = J.Bool(o, "enabled"), WeekId = J.Str(o, "weekId"), StartsAt = J.Long(o, "startsAt"), EndsAt = J.Long(o, "endsAt"), ServerNow = J.Long(o, "serverNow"),
            Challenges = J.List(o, "challenges", WeeklyChallenge.Parse), ClearedCount = J.Int(o, "clearedCount"), StartsLeftToday = J.Int(o, "startsLeftToday"),
            BadgeCount = J.Int(o, "badgeCount"), Badge = ChallengeBadge.Parse(J.Opt(o, "badge")), Next = ChallengeWeekPreview.Parse(J.Opt(o, "next")),
            Badges = J.List(o, "badges", EarnedBadge.Parse), Rules = ChallengeRules.Parse(J.Opt(o, "rules")),
        };
    }

    /// <summary>A started challenge (POST /v1/challenges/weekly/:id/start).</summary>
    public sealed class WeeklyChallengeSession
    {
        public string SessionId, Token, WeekId, ChallengeId;
        public int PlayerSlot, StartsLeftToday;
        public long ExpiresAt;
        public RaceConfig Config;
        /// <summary>The config exactly as received (echoed back on submit so the server can detect tampering).</summary>
        public JsonNode ConfigJson;
        public WeeklyChallenge Challenge;
        internal static WeeklyChallengeSession Parse(JsonNode o)
        {
            var cfg = J.Opt(o, "config");
            return new WeeklyChallengeSession
            {
                SessionId = J.Str(o, "sessionId"), Token = J.Str(o, "token"), WeekId = J.Str(o, "weekId"), ChallengeId = J.Str(o, "challengeId"),
                PlayerSlot = J.Int(o, "playerSlot"), StartsLeftToday = J.Int(o, "startsLeftToday"), ExpiresAt = J.Long(o, "expiresAt"),
                ConfigJson = cfg, Config = cfg == null ? null : ProtocolCodec.ParseConfig(cfg), Challenge = WeeklyChallenge.Parse(J.Opt(o, "challenge")),
            };
        }
    }

    public sealed class ChallengeCheck
    {
        /// <summary>finish / place / style / whips / time</summary>
        public string Kind;
        /// <summary>Target and actual as text-free values: numbers as strings, the style id, or null.</summary>
        public string Target, Actual;
        public bool Ok;
        internal static ChallengeCheck Parse(JsonNode o) => new ChallengeCheck { Kind = J.Str(o, "kind"), Target = J.Str(o, "target"), Actual = J.Str(o, "actual"), Ok = J.Bool(o, "ok") };
    }

    /// <summary>The evaluation of a run (server: evaluateChallenge; device: <see cref="ChallengeEvaluator"/>).</summary>
    public sealed class ChallengeEvaluation
    {
        public bool Finished, Cleared;
        public int? Place;
        public long? TimeMs;
        public int Whips;
        public string Style;
        public List<ChallengeCheck> Checks = new List<ChallengeCheck>();
        public ChallengeCheck Check(string kind) => Checks.Find(c => c.Kind == kind);
        internal static ChallengeEvaluation Parse(JsonNode o) => o == null ? null : new ChallengeEvaluation
        {
            Finished = J.Bool(o, "finished"), Cleared = J.Bool(o, "cleared"), Place = J.IntN(o, "place"), TimeMs = J.LongN(o, "timeMs"),
            Whips = J.Int(o, "whips"), Style = J.Str(o, "style"), Checks = J.List(o, "checks", ChallengeCheck.Parse),
        };
    }

    /// <summary>POST /v1/challenges/weekly/submit</summary>
    public sealed class WeeklyChallengeResult
    {
        public string SessionId, WeekId, ChallengeId, ResultHash;
        public ChallengeEvaluation Evaluation;
        public bool Cleared, FirstClear, Credited;
        /// <summary>The reward granted by this run (first clear this week), or null.</summary>
        public Reward Reward;
        public int ClearedCount;
        public ChallengeBadge Badge;
        internal static WeeklyChallengeResult Parse(JsonNode o)
        {
            var rw = J.Opt(o, "reward");
            return new WeeklyChallengeResult
            {
                SessionId = J.Str(o, "sessionId"), WeekId = J.Str(o, "weekId"), ChallengeId = J.Str(o, "challengeId"), ResultHash = J.Str(o, "resultHash"),
                Evaluation = ChallengeEvaluation.Parse(J.Opt(o, "evaluation")), Cleared = J.Bool(o, "cleared"), FirstClear = J.Bool(o, "firstClear"),
                Credited = J.Bool(o, "credited", true), Reward = rw == null ? null : Reward.Parse(rw), ClearedCount = J.Int(o, "clearedCount"),
                Badge = ChallengeBadge.Parse(J.Opt(o, "badge")),
            };
        }
    }

    /// <summary>
    /// REQ-WCH-005: the same evaluation as the server's evaluateChallenge (protocol §31.7), from a finished simulation and
    /// the inputs the device will submit. Place from the result order, time with the time attack formula, whips = input
    /// records of the player's slot with the WHIP bit, style from the issued config.
    /// </summary>
    public static class ChallengeEvaluator
    {
        public static int WhipInputs(IReadOnlyList<InputRecord> inputs, int playerSlot)
        {
            int n = 0;
            foreach (var r in inputs) if (r.Slot == playerSlot && (r.Cmd & Cmd.Whip) != 0) n++;
            return n;
        }

        public static string StyleId(RunningStyle s) => s == RunningStyle.Nige ? "nige" : s == RunningStyle.Senko ? "senko" : s == RunningStyle.Sashi ? "sashi" : "oikomi";

        /// <summary>Race time (ms from the gate opening) of a finish tick + Q16.16 fraction, exactly as the server computes it.</summary>
        public static long RaceTimeMs(RaceConfig config, int finishTick, long finishFrac)
        {
            int msPerTick = 1000 / config.Net.TickHz;
            return (long)(finishTick - config.Ruleset.GateOpenTick) * msPerTick + finishFrac * msPerTick / 65536;
        }

        public static ChallengeEvaluation Evaluate(ChallengeConditions cond, RaceConfig config, int playerSlot, IReadOnlyList<InputRecord> inputs, RaceResult result)
        {
            int idx = Array.IndexOf(result.Order, playerSlot);
            int tick = idx >= 0 ? result.FinishTicks[idx] : -1;
            bool finished = tick >= 0;
            int? place = finished ? idx + 1 : (int?)null;
            long? time = finished ? RaceTimeMs(config, tick, Math.Max(0, result.FinishFracOrDistanceRaw[idx])) : (long?)null;
            int whips = WhipInputs(inputs, playerSlot);
            string style = StyleId(config.Entrants[playerSlot].Horse.Style);
            var ev = new ChallengeEvaluation { Finished = finished, Place = place, TimeMs = time, Whips = whips, Style = style };
            ev.Checks.Add(new ChallengeCheck { Kind = "finish", Target = null, Actual = finished ? "1" : "0", Ok = finished });
            if (cond.MaxPlace.HasValue) ev.Checks.Add(new ChallengeCheck { Kind = "place", Target = Num(cond.MaxPlace.Value), Actual = place.HasValue ? Num(place.Value) : null, Ok = place.HasValue && place.Value <= cond.MaxPlace.Value });
            if (cond.Style != null) ev.Checks.Add(new ChallengeCheck { Kind = "style", Target = cond.Style, Actual = style, Ok = style == cond.Style });
            if (cond.MaxWhips.HasValue) ev.Checks.Add(new ChallengeCheck { Kind = "whips", Target = Num(cond.MaxWhips.Value), Actual = Num(whips), Ok = whips <= cond.MaxWhips.Value });
            if (cond.MaxTimeMs.HasValue) ev.Checks.Add(new ChallengeCheck { Kind = "time", Target = Num(cond.MaxTimeMs.Value), Actual = time.HasValue ? Num(time.Value) : null, Ok = time.HasValue && time.Value <= cond.MaxTimeMs.Value });
            bool all = true;
            foreach (var c in ev.Checks) all &= c.Ok;
            ev.Cleared = all;
            return ev;
        }

        private static string Num(long v) => v.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// One challenge attempt on the device: the player's OfflineRace in the issued slot (CPUs ride themselves), the input
    /// count capped to what the server accepts, and the live state of each condition for the HUD.
    /// </summary>
    public sealed class ChallengeRun
    {
        public WeeklyChallengeSession Session { get; }
        public ChallengeConditions Conditions { get; }
        public OfflineRace Race { get; }
        public int PlayerSlot => Race.PlayerSlot;

        public ChallengeRun(WeeklyChallengeSession session) : this(session.Config, session.PlayerSlot, session.Challenge?.Conditions) { Session = session; }

        /// <summary>Offline use (tests, the prototype): any challenge config, the player's slot and the conditions.</summary>
        public ChallengeRun(RaceConfig config, int playerSlot, ChallengeConditions conditions)
        {
            if (config == null) throw new ArgumentNullException(nameof(config));
            if (config.Mode != RaceMode.Challenge) throw new ArgumentException("not a challenge config");
            if (playerSlot < 0 || playerSlot >= config.Entrants.Count || config.Entrants[playerSlot].Kind != EntrantKind.Human) throw new ArgumentException("the player slot is not the human entrant");
            Conditions = conditions ?? new ChallengeConditions();
            Race = new OfflineRace(config, playerSlot) { MaxRecordedInputs = WeeklyChallengeLimits.MaxInputs };
        }

        /// <summary>Whips used so far (the number the server will count).</summary>
        public int WhipsUsed => ChallengeEvaluator.WhipInputs(Race.RecordedInputs, PlayerSlot);

        /// <summary>The whip condition can no longer be met (shown red in the HUD).</summary>
        public bool WhipsBroken => Conditions.MaxWhips.HasValue && WhipsUsed > Conditions.MaxWhips.Value;

        /// <summary>The time condition can no longer be met: the race clock is past the limit and the horse has not finished.</summary>
        public bool TimeBroken
        {
            get
            {
                if (!Conditions.MaxTimeMs.HasValue) return false;
                var h = Race.Sim.GetHorse(PlayerSlot);
                if (h.Finished) return Race.FinishTimeMs(PlayerSlot) > Conditions.MaxTimeMs.Value;
                int msPerTick = 1000 / Race.Config.Net.TickHz;
                return (long)(Race.Sim.Tick - Race.Sim.P.GateOpenTick) * msPerTick > Conditions.MaxTimeMs.Value;
            }
        }

        /// <summary>Elapsed race time (ms from the gate opening), 0 before it.</summary>
        public long ElapsedMs => Math.Max(0, (long)(Race.Sim.Tick - Race.Sim.P.GateOpenTick) * (1000 / Race.Config.Net.TickHz));

        /// <summary>The device's verdict once the race has finished (null before). The server's verdict decides.</summary>
        public ChallengeEvaluation Evaluate() => Race.IsFinished ? ChallengeEvaluator.Evaluate(Conditions, Race.Config, PlayerSlot, Race.RecordedInputs, Race.Sim.Result) : null;

        /// <summary>The replay log the server will verify (issued config + the player's inputs).</summary>
        public ReplayLog Log() => new ReplayLog { Config = Race.Config, EndTick = -1, Inputs = new List<InputRecord>(Race.RecordedInputs) };
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-WCH-002: this week's 3 challenges with my progress, the badge, next week's preview (Enabled false when off).</summary>
        public Task<WeeklyChallengeView> GetWeeklyChallengesAsync(CancellationToken ct = default)
            => Call("GET", "/v1/challenges/weekly", null, true, null, true, WeeklyChallengeView.Parse, ct);

        /// <summary>
        /// REQ-WCH-003: start a challenge with an own horse (<paramref name="horseId"/>) or the loan horse (<paramref name="loan"/>).
        /// Keyed: keep the same <paramref name="idempotencyKey"/> until an answer arrives (a retry returns the same session).
        /// ConflictException CHALLENGE_HORSE_INELIGIBLE / CHALLENGE_LIMIT_REACHED, NotFoundException (not this week's).
        /// </summary>
        public Task<WeeklyChallengeSession> StartWeeklyChallengeAsync(string challengeId, string horseId = null, bool loan = false, string idempotencyKey = null, CancellationToken ct = default)
        {
            if ((horseId == null) == !loan) throw new ArgumentException("give either a horseId or loan = true");
            var b = JsonNode.Obj();
            if (loan) b.Set("loan", true); else b.Set("horseId", horseId);
            return Call("POST", "/v1/challenges/weekly/" + Seg(challengeId) + "/start", b, true, idempotencyKey ?? NewIdempotencyKey(), true, WeeklyChallengeSession.Parse, ct);
        }

        /// <summary>
        /// REQ-WCH-008: submit a finished run (inputs + the device's result hash; the issued config is echoed). Safe to retry:
        /// the server returns the stored result for the same session and hash. ConflictException CHALLENGE_RESULT_MISMATCH when
        /// the re-simulation differs; ServerException VERIFIER_UNAVAILABLE (the session stays open, retry later).
        /// </summary>
        public Task<WeeklyChallengeResult> SubmitWeeklyChallengeAsync(WeeklyChallengeSession session, ChallengeRun run, CancellationToken ct = default)
        {
            if (session == null) throw new ArgumentNullException(nameof(session));
            if (run == null || !run.Race.IsFinished) throw new InvalidOperationException("the race has not finished");
            return SubmitWeeklyChallengeAsync(session, run.Race.RecordedInputs, run.Race.ResultHash, ct);
        }

        public Task<WeeklyChallengeResult> SubmitWeeklyChallengeAsync(WeeklyChallengeSession session, IReadOnlyList<InputRecord> inputs, string resultHash, CancellationToken ct = default)
        {
            if (inputs == null) throw new ArgumentNullException(nameof(inputs));
            if (inputs.Count > WeeklyChallengeLimits.MaxInputs) throw new ArgumentException("too many inputs: " + inputs.Count + " (max " + WeeklyChallengeLimits.MaxInputs + ")", nameof(inputs));
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
            return Call("POST", "/v1/challenges/weekly/submit", b, true, null, true, WeeklyChallengeResult.Parse, ct);
        }
    }
}
