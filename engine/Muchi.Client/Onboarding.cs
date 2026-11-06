using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-UXS-001..040: consent, the first partner, unlocks, A/B values, beginner / season missions and account
    // deletion. server/src/domain/onboarding.ts and accountDeletion.ts, contracts/protocol.md §8.7.

    /// <summary>Terms / privacy versions (YYYY-MM-DD strings chosen by the server).</summary>
    public sealed class ConsentVersions
    {
        public string TermsVersion, PrivacyVersion;
        internal static ConsentVersions Parse(JsonNode o) => o == null ? null : new ConsentVersions { TermsVersion = J.Str(o, "termsVersion"), PrivacyVersion = J.Str(o, "privacyVersion") };
    }

    /// <summary>REQ-UXS-001: what the player consented to and whether the consent screen must be shown (again).</summary>
    public sealed class ConsentView
    {
        /// <summary>Versions consented to (null until the first consent).</summary>
        public string TermsVersion, PrivacyVersion;
        public long? ConsentedAt;
        /// <summary>The versions to show and send back with <see cref="ApiClient.RecordConsentAsync"/>.</summary>
        public ConsentVersions Current;
        /// <summary>True before the first consent and after a version bump.</summary>
        public bool Required;
        internal static ConsentView Parse(JsonNode o) => o == null ? null : new ConsentView
        {
            TermsVersion = J.Str(o, "termsVersion"), PrivacyVersion = J.Str(o, "privacyVersion"), ConsentedAt = J.LongN(o, "consentedAt"),
            Current = ConsentVersions.Parse(J.Opt(o, "current")), Required = J.Bool(o, "required"),
        };
    }

    /// <summary>REQ-UXS-014: one feature of the unlock table. Display only: the feature's API works before it opens.</summary>
    public sealed class FeatureUnlock
    {
        /// <summary>race, partner, scout, stable, missions, login_bonus, shop, season_pass, bond, season, breeding, friends, friend_rooms, teams, spectate, time_attack, events, tournaments, my_stable, stud.</summary>
        public string Key;
        public bool Unlocked;
        /// <summary>The condition that opened it ("always" | "races" | "days" | "rankedRaces" | "breedings"), null while locked.</summary>
        public string By;
        /// <summary>The thresholds (any one opens the feature); null = not a condition.</summary>
        public int? Races, Days, RankedRaces, Breedings;
        internal static FeatureUnlock Parse(JsonNode o) => new FeatureUnlock
        {
            Key = J.Str(o, "key"), Unlocked = J.Bool(o, "unlocked"), By = J.Str(o, "by"),
            Races = J.IntN(o, "races"), Days = J.IntN(o, "days"), RankedRaces = J.IntN(o, "rankedRaces"), Breedings = J.IntN(o, "breedings"),
        };
    }

    public sealed class UnlocksView
    {
        /// <summary>Game day since install (1 = install day, REQ-UXS-011).</summary>
        public int Day;
        public int Races, RankedRaces, Breedings;
        public List<FeatureUnlock> Features = new List<FeatureUnlock>();
        public bool IsUnlocked(string key)
        {
            foreach (var f in Features) if (f.Key == key) return f.Unlocked;
            return true; // unknown keys are not gated
        }
        internal static UnlocksView Parse(JsonNode o) => o == null ? null : new UnlocksView
        {
            Day = J.Int(o, "day"), Races = J.Int(o, "races"), RankedRaces = J.Int(o, "rankedRaces"), Breedings = J.Int(o, "breedings"),
            Features = J.List(o, "features", FeatureUnlock.Parse),
        };
    }

    /// <summary>REQ-UXS-032: A/B buckets and the values the app uses (absent value = the app's default).</summary>
    public sealed class ExperimentsView
    {
        /// <summary>Experiment id → bucket id.</summary>
        public Dictionary<string, string> Assignments = new Dictionary<string, string>();
        public int? TutorialDistanceM;
        /// <summary>The server applies this one itself (first ranked race); exposed for display.</summary>
        public string FirstRankedTrackId;
        /// <summary>"race2_top3" | "day2_launch" | null.</summary>
        public string PushPermissionTiming;
        /// <summary>"first_bottom_half" | "fifth_race" | null (the server picks the starter offer's trigger with it).</summary>
        public string StarterOfferTrigger;
        /// <summary>"race" | "ranked_promotion" | null.</summary>
        public string HomePrimaryButton;
        /// <summary>Show the first-win bonus on the home screen (null = default, shown).</summary>
        public bool? FirstWinBonus;
        internal static ExperimentsView Parse(JsonNode o)
        {
            if (o == null) return new ExperimentsView();
            var v = J.Opt(o, "values");
            var fw = J.Opt(v, "firstWinBonus");
            return new ExperimentsView
            {
                Assignments = J.Map(o, "assignments", x => x.AsString()),
                TutorialDistanceM = J.IntN(v, "tutorialDistanceM"), FirstRankedTrackId = J.Str(v, "firstRankedTrackId"),
                PushPermissionTiming = J.Str(v, "pushPermissionTiming"), StarterOfferTrigger = J.Str(v, "starterOfferTrigger"),
                HomePrimaryButton = J.Str(v, "homePrimaryButton"), FirstWinBonus = fw == null ? (bool?)null : fw.AsBool(),
            };
        }
    }

    /// <summary>REQ-UXS-040: "none" or "scheduled" (with the time it will run; cancellable until then).</summary>
    public sealed class DeletionStatus
    {
        public string Status = "none";
        public long? RequestedAt, DeleteAt;
        public bool Scheduled => Status == "scheduled";
        internal static DeletionStatus Parse(JsonNode o) => o == null ? new DeletionStatus() : new DeletionStatus
        {
            Status = J.Str(o, "status") ?? "none", RequestedAt = J.LongN(o, "requestedAt"), DeleteAt = J.LongN(o, "deleteAt"),
        };
    }

    /// <summary>What the player gives up (shown before the second step; nothing is refunded).</summary>
    public sealed class DeletionForfeit
    {
        public int PaidCoins, FreeCoins, Horses, Items;
        /// <summary>Unclaimed 厩舎手当 days (running and queued packs).</summary>
        public int AllowanceDays;
        /// <summary>True when this season's pass is owned.</summary>
        public bool SeasonPass;
        internal static DeletionForfeit Parse(JsonNode o) => o == null ? null : new DeletionForfeit
        {
            PaidCoins = J.Int(o, "paidCoins"), FreeCoins = J.Int(o, "freeCoins"), Horses = J.Int(o, "horses"), Items = J.Int(o, "items"),
            AllowanceDays = J.Int(o, "allowanceDays"), SeasonPass = J.Bool(o, "seasonPass"),
        };
    }

    /// <summary>
    /// DELETE /v1/player. Step 1: <c>Status == "confirm_required"</c> with a short-lived <see cref="ConfirmToken"/>,
    /// <see cref="Forfeit"/> and <see cref="Notice"/>. Step 2 (token): <c>"scheduled"</c> with <see cref="DeleteAt"/>.
    /// </summary>
    public sealed class DeletionRequest
    {
        public string Status;
        public string ConfirmToken;
        public long? ExpiresAt, RequestedAt, DeleteAt;
        public int CancelWindowDays;
        public DeletionForfeit Forfeit;
        public string Notice;
        public bool ConfirmRequired => Status == "confirm_required";
        public bool Scheduled => Status == "scheduled";
        internal static DeletionRequest Parse(JsonNode o) => new DeletionRequest
        {
            Status = J.Str(o, "status"), ConfirmToken = J.Str(o, "confirmToken"), ExpiresAt = J.LongN(o, "expiresAt"),
            RequestedAt = J.LongN(o, "requestedAt"), DeleteAt = J.LongN(o, "deleteAt"), CancelWindowDays = J.Int(o, "cancelWindowDays"),
            Forfeit = DeletionForfeit.Parse(J.Opt(o, "forfeit")), Notice = J.Str(o, "notice"),
        };
    }

    /// <summary>REQ-UXS-015: one step of the 10-step beginner list (claim them in order).</summary>
    public sealed class BeginnerStep
    {
        public string Id, Kind;
        public int Step, Target, Progress;
        public Reward Reward;
        public bool Claimed, Locked, Claimable;
        internal static BeginnerStep Parse(JsonNode o) => new BeginnerStep
        {
            Id = J.Str(o, "id"), Kind = J.Str(o, "kind"), Step = J.Int(o, "step"), Target = J.Int(o, "target"), Progress = J.Int(o, "progress"),
            Reward = Reward.Parse(J.Opt(o, "reward")), Claimed = J.Bool(o, "claimed"), Locked = J.Bool(o, "locked"), Claimable = J.Bool(o, "claimable"),
        };
    }

    public sealed class BeginnerMissions
    {
        public bool Completed;
        public List<BeginnerStep> Steps = new List<BeginnerStep>();
        internal static BeginnerMissions Parse(JsonNode o) => o == null ? new BeginnerMissions() : new BeginnerMissions { Completed = J.Bool(o, "completed"), Steps = J.List(o, "steps", BeginnerStep.Parse) };
    }

    /// <summary>REQ-UXS-016: a season mission (reward = pass XP). <see cref="Target"/> is null when not available (e.g. promotion line in S class).</summary>
    public sealed class SeasonMission
    {
        public string Id, Kind;
        public int? Target;
        public int Progress;
        public Reward Reward;
        public bool Claimed, Available, Claimable;
        internal static SeasonMission Parse(JsonNode o) => new SeasonMission
        {
            Id = J.Str(o, "id"), Kind = J.Str(o, "kind"), Target = J.IntN(o, "target"), Progress = J.Int(o, "progress"), Reward = Reward.Parse(J.Opt(o, "reward")),
            Claimed = J.Bool(o, "claimed"), Available = J.Bool(o, "available"), Claimable = J.Bool(o, "claimable"),
        };
    }

    public sealed class SeasonMissions
    {
        public string SeasonId;
        public List<SeasonMission> Missions = new List<SeasonMission>();
        internal static SeasonMissions Parse(JsonNode o) => o == null ? new SeasonMissions() : new SeasonMissions { SeasonId = J.Str(o, "seasonId"), Missions = J.List(o, "missions", SeasonMission.Parse) };
    }

    /// <summary>REQ-UXS-010: today's first-win bonus (ranked wins; coins for the 1st, 2nd, 3rd win of the game day).</summary>
    public sealed class FirstWinBonusView
    {
        public List<string> Modes = new List<string>();
        public int[] ByWin = new int[0];
        public int WinsToday, Remaining;
        /// <summary>Coins for the next win today, or null when used up.</summary>
        public int? Next;
        internal static FirstWinBonusView Parse(JsonNode o) => o == null ? new FirstWinBonusView() : new FirstWinBonusView
        {
            Modes = J.List(o, "modes", x => x.AsString()), ByWin = J.Ints(o, "byWin"), WinsToday = J.Int(o, "winsToday"), Remaining = J.Int(o, "remaining"), Next = J.IntN(o, "next"),
        };
    }

    /// <summary>GET /v1/missions: daily, beginner and season missions plus the first-win bonus (one claim endpoint for all).</summary>
    public sealed class MissionBoard
    {
        public List<Mission> Missions = new List<Mission>();
        public BeginnerMissions Beginner = new BeginnerMissions();
        public SeasonMissions Season = new SeasonMissions();
        public FirstWinBonusView FirstWinBonus = new FirstWinBonusView();
        internal static MissionBoard Parse(JsonNode o) => new MissionBoard
        {
            Missions = J.List(o, "missions", Mission.Parse), Beginner = BeginnerMissions.Parse(J.Opt(o, "beginner")),
            Season = SeasonMissions.Parse(J.Opt(o, "season")), FirstWinBonus = FirstWinBonusView.Parse(J.Opt(o, "firstWinBonus")),
        };
    }

    public sealed partial class ApiClient
    {
        /// <summary>
        /// REQ-UXS-001: record consent to the versions shown (<see cref="ConsentView.Current"/>). Idempotent, so it
        /// is retried. <see cref="ConflictException"/> CONSENT_VERSION_MISMATCH: the versions changed; refetch the player.
        /// </summary>
        public Task<ConsentView> RecordConsentAsync(string termsVersion, string privacyVersion, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("termsVersion", termsVersion);
            b.Set("privacyVersion", privacyVersion);
            return Call("POST", "/v1/player/consent", b, true, null, true, ConsentView.Parse, ct);
        }

        /// <summary>
        /// REQ-UXS-002: grant and name the tutorial partner (once). Keyed: a retry with the same key returns the same horse;
        /// a second grant is ConflictException PARTNER_ALREADY_GRANTED; ValidationException INVALID_NAME / NG_NAME grant nothing.
        /// </summary>
        public Task<Horse> GrantPartnerAsync(string name, string idempotencyKey = null, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("name", name);
            return Call("POST", "/v1/player/partner", b, true, idempotencyKey ?? NewIdempotencyKey(), true, o => Horse.Parse(J.Opt(o, "horse")), ct);
        }

        /// <summary>
        /// REQ-UXS-040 step 1: ask for a confirmation token and what will be lost. Not retried (each call issues a new
        /// token). Already scheduled → Status "scheduled".
        /// </summary>
        public Task<DeletionRequest> RequestAccountDeletionAsync(CancellationToken ct = default)
            => Call("DELETE", "/v1/player", null, true, null, false, DeletionRequest.Parse, ct);

        /// <summary>
        /// REQ-UXS-040 step 2: schedule the deletion with the token from step 1 (the same answer when already scheduled,
        /// so it is retried). ConflictException DELETION_CONFIRM_INVALID: wrong or expired token, start over.
        /// </summary>
        public Task<DeletionRequest> ConfirmAccountDeletionAsync(string confirmToken, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("confirmToken", confirmToken);
            return Call("DELETE", "/v1/player", b, true, null, true, DeletionRequest.Parse, ct);
        }

        /// <summary>
        /// REQ-UXS-040: cancel a scheduled deletion within the window. Not retried (a second cancel is NOT_FOUND);
        /// ConflictException DELETION_IN_PROGRESS once the deletion run has started (irreversible).
        /// </summary>
        public Task<DeletionStatus> CancelAccountDeletionAsync(CancellationToken ct = default)
            => Call("POST", "/v1/player/deletion/cancel", JsonNode.Obj(), true, null, false, DeletionStatus.Parse, ct);

        /// <summary>GET /v1/missions with the beginner list, season missions and today's first-win bonus.</summary>
        public Task<MissionBoard> GetMissionBoardAsync(CancellationToken ct = default)
            => Call("GET", "/v1/missions", null, true, null, true, MissionBoard.Parse, ct);
    }
}
