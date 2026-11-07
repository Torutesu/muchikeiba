using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-COL-001..005 図鑑 and REQ-ACH-001..009 実績 (server/src/domain/collection.ts, contracts/protocol.md §24).
    // Completing the book pays nothing (CollectionBook.CompletionRewards is always false); achievements pay free coins only.

    /// <summary>Counts of one section (or the whole book). Completion = obtained / total, in permille.</summary>
    public sealed class CollectionCounts
    {
        public int Total, Obtained, Seen, Unknown, CompletionPermille;
        public string CompletionText => (CompletionPermille / 10).ToString(System.Globalization.CultureInfo.InvariantCulture) + "%";
        internal static CollectionCounts Parse(JsonNode o) => new CollectionCounts
        {
            Total = J.Int(o, "total"), Obtained = J.Int(o, "obtained"), Seen = J.Int(o, "seen"), Unknown = J.Int(o, "unknown"), CompletionPermille = J.Int(o, "completionPermille"),
        };
    }

    /// <summary>A horse template in the book. Unknown entries carry only rarity and the silhouette key; stats only once obtained.</summary>
    public sealed class CollectionHorse
    {
        /// <summary>obtained | seen | unknown</summary>
        public string Id, State, Rarity, Name, Style, Surface, SkillId, Lore, Art, SeasonalLabel;
        public int DistMinM, DistMaxM;
        public Stats Stats;
        public bool Obtained => State == "obtained";
        public bool Unknown => State == "unknown";
        internal static CollectionHorse Parse(JsonNode o)
        {
            var d = J.Opt(o, "distance");
            var st = J.Opt(o, "stats");
            return new CollectionHorse
            {
                Id = J.Str(o, "id"), State = J.Str(o, "state"), Rarity = J.Str(o, "rarity"), Name = J.Str(o, "name"), Style = J.Str(o, "style"), Surface = J.Str(o, "surface"),
                SkillId = J.Str(o, "skillId"), Lore = J.Str(o, "lore"), Art = J.Str(o, "art"), SeasonalLabel = J.Str(J.Opt(o, "seasonal"), "label"),
                DistMinM = J.Int(d, "minM"), DistMaxM = J.Int(d, "maxM"),
                Stats = st == null ? null : Stats.Parse(st),
            };
        }
    }

    public sealed class CollectionSkill
    {
        public string Id, State, Rarity, Name, Condition, Effect, Lore;
        public List<string> Styles = new List<string>();
        internal static CollectionSkill Parse(JsonNode o) => new CollectionSkill
        {
            Id = J.Str(o, "id"), State = J.Str(o, "state"), Rarity = J.Str(o, "rarity"), Name = J.Str(o, "name"), Condition = J.Str(o, "condition"),
            Effect = J.Str(o, "effect"), Lore = J.Str(o, "lore"), Styles = J.List(o, "styles", x => x.AsString()),
        };
    }

    public sealed class CollectionCourse
    {
        public string Id, State, Name, Surface, Lore;
        public int DistanceM, Races, Wins;
        public int? BestFinishTick, TimeAttackBestMs;
        internal static CollectionCourse Parse(JsonNode o) => new CollectionCourse
        {
            Id = J.Str(o, "id"), State = J.Str(o, "state"), Name = J.Str(o, "name"), Surface = J.Str(o, "surface"), Lore = J.Str(o, "lore"),
            DistanceM = J.Int(o, "distanceM"), Races = J.Int(o, "races"), Wins = J.Int(o, "wins"), BestFinishTick = J.IntN(o, "bestFinishTick"), TimeAttackBestMs = J.IntN(o, "timeAttackBestMs"),
        };
    }

    public sealed class CollectionCosmetic
    {
        public string Id, State, Kind, Name, Lore, Icon;
        internal static CollectionCosmetic Parse(JsonNode o) => new CollectionCosmetic
        {
            Id = J.Str(o, "id"), State = J.Str(o, "state"), Kind = J.Str(o, "kind"), Name = J.Str(o, "name"), Lore = J.Str(o, "lore"), Icon = J.Str(o, "icon"),
        };
    }

    public sealed class CollectionSection<T>
    {
        public CollectionCounts Counts = new CollectionCounts();
        public List<T> Entries = new List<T>();
        internal static CollectionSection<T> Parse(JsonNode o, System.Func<JsonNode, T> f) => new CollectionSection<T> { Counts = CollectionCounts.Parse(o), Entries = J.List(o, "entries", f) };
    }

    /// <summary>GET /v1/collection.</summary>
    public sealed class CollectionBook
    {
        public CollectionSection<CollectionHorse> Horses = new CollectionSection<CollectionHorse>();
        public CollectionSection<CollectionSkill> Skills = new CollectionSection<CollectionSkill>();
        public CollectionSection<CollectionCourse> Courses = new CollectionSection<CollectionCourse>();
        public CollectionSection<CollectionCosmetic> Cosmetics = new CollectionSection<CollectionCosmetic>();
        public CollectionCounts Totals = new CollectionCounts();
        /// <summary>Always false: the book's completion is a display only (docs/planning/03, コンプガチャ).</summary>
        public bool CompletionRewards;
        public string Notice;
        internal static CollectionBook Parse(JsonNode o)
        {
            var s = J.Opt(o, "sections");
            return new CollectionBook
            {
                Horses = CollectionSection<CollectionHorse>.Parse(J.Opt(s, "horses"), CollectionHorse.Parse),
                Skills = CollectionSection<CollectionSkill>.Parse(J.Opt(s, "skills"), CollectionSkill.Parse),
                Courses = CollectionSection<CollectionCourse>.Parse(J.Opt(s, "courses"), CollectionCourse.Parse),
                Cosmetics = CollectionSection<CollectionCosmetic>.Parse(J.Opt(s, "cosmetics"), CollectionCosmetic.Parse),
                Totals = CollectionCounts.Parse(J.Opt(o, "totals")), CompletionRewards = J.Bool(o, "completionRewards"), Notice = J.Str(o, "notice"),
            };
        }
    }

    public sealed class AchievementTierInfo
    {
        public int Tier, Target, FreeCoins;
        public bool Unlocked, Claimed, Claimable;
        public long? UnlockedAt;
        public string Badge;
        internal static AchievementTierInfo Parse(JsonNode o) => new AchievementTierInfo
        {
            Tier = J.Int(o, "tier"), Target = J.Int(o, "target"), FreeCoins = J.Int(J.Opt(o, "reward"), "freeCoins"),
            Unlocked = J.Bool(o, "unlocked"), Claimed = J.Bool(o, "claimed"), Claimable = J.Bool(o, "claimable"), UnlockedAt = J.LongN(o, "unlockedAt"), Badge = J.Str(o, "badge"),
        };
    }

    public sealed class AchievementTitle
    {
        public string Id, Name, Icon;
        public int Tier;
        public bool Unlocked;
        internal static AchievementTitle Parse(JsonNode o) => new AchievementTitle { Id = J.Str(o, "id"), Name = J.Str(o, "name"), Icon = J.Str(o, "icon"), Tier = J.Int(o, "tier"), Unlocked = J.Bool(o, "unlocked") };
    }

    public sealed class Achievement
    {
        /// <summary>category: race | course | skill | breeding | time_attack | tournament | stable | team</summary>
        public string Id, Category, Name, Description, Metric, TrackId, Medal, Section, Badge;
        public int Progress, Tier, MaxTier;
        /// <summary>Target of the next tier (null when every tier is reached).</summary>
        public int? NextTarget;
        public List<AchievementTierInfo> Tiers = new List<AchievementTierInfo>();
        public List<AchievementTitle> Titles = new List<AchievementTitle>();
        public bool Complete => NextTarget == null;
        internal static Achievement Parse(JsonNode o) => new Achievement
        {
            Id = J.Str(o, "id"), Category = J.Str(o, "category"), Name = J.Str(o, "name"), Description = J.Str(o, "description"), Metric = J.Str(o, "metric"),
            TrackId = J.Str(o, "trackId"), Medal = J.Str(o, "medal"), Section = J.Str(o, "section"), Badge = J.Str(o, "badge"),
            Progress = J.Int(o, "progress"), Tier = J.Int(o, "tier"), MaxTier = J.Int(o, "maxTier"), NextTarget = J.IntN(o, "nextTarget"),
            Tiers = J.List(o, "tiers", AchievementTierInfo.Parse), Titles = J.List(o, "titles", AchievementTitle.Parse),
        };
    }

    public sealed class AchievementTotals
    {
        public int Tiers, Unlocked, Claimed, Claimable, ClaimableCoins, EarnedCoins, TotalCoins;
        internal static AchievementTotals Parse(JsonNode o) => new AchievementTotals
        {
            Tiers = J.Int(o, "tiers"), Unlocked = J.Int(o, "unlocked"), Claimed = J.Int(o, "claimed"), Claimable = J.Int(o, "claimable"),
            ClaimableCoins = J.Int(o, "claimableCoins"), EarnedCoins = J.Int(o, "earnedCoins"), TotalCoins = J.Int(o, "totalCoins"),
        };
    }

    /// <summary>GET /v1/achievements.</summary>
    public sealed class AchievementList
    {
        public List<Achievement> Achievements = new List<Achievement>();
        public AchievementTotals Totals = new AchievementTotals();
        /// <summary>REQ-UXS-040: the account is scheduled for deletion; nothing can be claimed.</summary>
        public bool Blocked;
        public string Notice;
        internal static AchievementList Parse(JsonNode o) => new AchievementList
        {
            Achievements = J.List(o, "achievements", Achievement.Parse), Totals = AchievementTotals.Parse(J.Opt(o, "totals")), Blocked = J.Bool(o, "blocked"), Notice = J.Str(o, "notice"),
        };
    }

    public sealed class AchievementClaimed
    {
        public string AchievementId;
        public int Tier, FreeCoins;
        internal static AchievementClaimed Parse(JsonNode o) => new AchievementClaimed { AchievementId = J.Str(o, "achievementId"), Tier = J.Int(o, "tier"), FreeCoins = J.Int(J.Opt(o, "reward"), "freeCoins") };
    }

    /// <summary>Result of a claim (one tier) or claim-all (<see cref="Claimed"/> lists every tier paid).</summary>
    public sealed class AchievementClaim
    {
        public List<AchievementClaimed> Claimed = new List<AchievementClaimed>();
        public int FreeCoins, WalletFree, WalletPaid;
        internal static AchievementClaim Parse(JsonNode o)
        {
            var c = new AchievementClaim { WalletFree = J.Int(J.Opt(o, "wallet"), "free"), WalletPaid = J.Int(J.Opt(o, "wallet"), "paid") };
            if (J.Opt(o, "claimed") != null) { c.Claimed = J.List(o, "claimed", AchievementClaimed.Parse); c.FreeCoins = J.Int(o, "freeCoins"); }
            else { var one = AchievementClaimed.Parse(o); c.Claimed.Add(one); c.FreeCoins = one.FreeCoins; }
            return c;
        }
    }

    public sealed class AchievementBadge
    {
        public string AchievementId, Badge;
        public int Tier;
        internal static AchievementBadge Parse(JsonNode o) => new AchievementBadge { AchievementId = J.Str(o, "achievementId"), Tier = J.Int(o, "tier"), Badge = J.Str(o, "badge") };
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-COL-001: the collection book (every template, skill, course and cosmetic with its state and counts).</summary>
        public Task<CollectionBook> GetCollectionAsync(CancellationToken ct = default)
            => Call("GET", "/v1/collection", null, true, null, true, CollectionBook.Parse, ct);

        /// <summary>REQ-ACH-004: achievements with progress, tiers, badges and the titles they unlock.</summary>
        public Task<AchievementList> GetAchievementsAsync(CancellationToken ct = default)
            => Call("GET", "/v1/achievements", null, true, null, true, AchievementList.Parse, ct);

        /// <summary>
        /// REQ-ACH-005: claim one unlocked tier (free coins). Keyed (a retry returns the same result). NOT_ELIGIBLE before the
        /// target, ConflictException ALREADY_CLAIMED, DELETION_PENDING while the account is scheduled for deletion.
        /// </summary>
        public Task<AchievementClaim> ClaimAchievementAsync(string achievementId, int tier, string idempotencyKey = null, CancellationToken ct = default)
            => Call("POST", "/v1/achievements/" + System.Uri.EscapeDataString(achievementId) + "/tiers/" + tier.ToString(System.Globalization.CultureInfo.InvariantCulture) + "/claim",
                JsonNode.Obj(), true, idempotencyKey ?? NewIdempotencyKey(), true, AchievementClaim.Parse, ct);

        /// <summary>REQ-ACH-005: claim every claimable tier at once. Keyed.</summary>
        public Task<AchievementClaim> ClaimAllAchievementsAsync(string idempotencyKey = null, CancellationToken ct = default)
            => Call("POST", "/v1/achievements/claim-all", JsonNode.Obj(), true, idempotencyKey ?? NewIdempotencyKey(), true, AchievementClaim.Parse, ct);
    }
}
