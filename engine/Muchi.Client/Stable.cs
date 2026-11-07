using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-STABLE-*: マイ厩舎 (飾る・訪問・いいね). server/src/domain/stable.ts, contracts/protocol.md §8.6.
    // Likes never give coins to either side; cumulative likes only unlock room themes.

    /// <summary>A placed decor item (asset key "decor/&lt;name&gt;", contracts/assets.md).</summary>
    public sealed class StableSlot
    {
        public string ItemId, Name, Key;
        internal static StableSlot Parse(JsonNode o) => o == null || o.IsNull ? null : new StableSlot { ItemId = J.Str(o, "itemId"), Name = J.Str(o, "name"), Key = J.Str(o, "key") };
    }

    /// <summary>A horse standing in the 馬房 of a stable.</summary>
    public sealed class StableHorse
    {
        public string HorseId, Name, Rarity, Style;
        public int BondLevel;
        public Appearance Appearance = new Appearance();
        internal static StableHorse Parse(JsonNode o) => new StableHorse
        {
            HorseId = J.Str(o, "horseId"), Name = J.Str(o, "name"), Rarity = J.Str(o, "rarity"), Style = J.Str(o, "style"), BondLevel = J.Int(o, "bondLevel"),
            Appearance = Appearance.Parse(J.Opt(o, "appearance")) ?? new Appearance(),
        };
    }

    /// <summary>トロフィー棚: filled automatically from titles, race stats and tournament results.</summary>
    public sealed class StableTrophies
    {
        public List<string> TitleIds = new List<string>();
        public int Races, Wins, Top3, TournamentWins, TournamentPodiums;
        /// <summary>REQ-ACH-009: achievement badges on the trophy shelf (highest tier per achievement, best first; empty for older copies).</summary>
        public List<AchievementBadge> Badges = new List<AchievementBadge>();
        internal static StableTrophies Parse(JsonNode o) => new StableTrophies
        {
            TitleIds = J.List(o, "titleIds", x => x.AsString()), Races = J.Int(o, "races"), Wins = J.Int(o, "wins"), Top3 = J.Int(o, "top3"),
            TournamentWins = J.Int(o, "tournamentWins"), TournamentPodiums = J.Int(o, "tournamentPodiums"), Badges = J.List(o, "badges", AchievementBadge.Parse),
        };
    }

    /// <summary>The public copy of a stable, as visitors see it (never wallet, items or purchases).</summary>
    public sealed class StableSnapshot
    {
        public string PlayerId, DisplayName, TitleId, ClassId;
        /// <summary>表札; null = show <see cref="PlateName"/>'s default "&lt;DisplayName&gt;の厩舎".</summary>
        public string Name;
        public string ThemeId, ThemeName, ThemeKey;
        public Silks Silks = new Silks();
        /// <summary>One entry per slot of the theme; null = empty slot.</summary>
        public List<StableSlot> Slots = new List<StableSlot>();
        public List<StableHorse> Horses = new List<StableHorse>();
        /// <summary>No horses were chosen: the server shows the top active horses.</summary>
        public bool AutoHorses;
        public StableTrophies Trophies = new StableTrophies();
        public int Likes;
        public long UpdatedAt;

        public string PlateName => string.IsNullOrEmpty(Name) ? (DisplayName ?? "") + "の厩舎" : Name;
        public int DecorCount => Slots.Count(s => s != null);

        internal static StableSnapshot Parse(JsonNode o)
        {
            if (o == null) return null;
            var t = J.Opt(o, "theme");
            return new StableSnapshot
            {
                PlayerId = J.Str(o, "playerId"), DisplayName = J.Str(o, "displayName"), TitleId = J.Str(o, "titleId"), ClassId = J.Str(o, "classId"),
                Name = J.Str(o, "name"), ThemeId = J.Str(t, "id"), ThemeName = J.Str(t, "name"), ThemeKey = J.Str(t, "key") ?? AssetKeys.StableTheme("default"),
                Silks = Silks.Parse(J.Opt(o, "silks")) ?? new Silks(),
                Slots = J.List(o, "slots", StableSlot.Parse), Horses = J.List(o, "horses", StableHorse.Parse), AutoHorses = J.Bool(o, "autoHorses"),
                Trophies = StableTrophies.Parse(J.Opt(o, "trophies")), Likes = J.Int(o, "likes"), UpdatedAt = J.Long(o, "updatedAt"),
            };
        }
    }

    /// <summary>A stable in the visit lists (friends / recommended).</summary>
    public sealed class StableSummary
    {
        public string PlayerId, DisplayName, TitleId, Name, ThemeKey;
        public int Likes, DecorCount, HorseCount;
        public long UpdatedAt;
        public string PlateName => string.IsNullOrEmpty(Name) ? (DisplayName ?? "") + "の厩舎" : Name;
        internal static StableSummary Parse(JsonNode o) => new StableSummary
        {
            PlayerId = J.Str(o, "playerId"), DisplayName = J.Str(o, "displayName"), TitleId = J.Str(o, "titleId"), Name = J.Str(o, "name"), ThemeKey = J.Str(o, "themeKey"),
            Likes = J.Int(o, "likes"), DecorCount = J.Int(o, "decorCount"), HorseCount = J.Int(o, "horseCount"), UpdatedAt = J.Long(o, "updatedAt"),
        };
    }

    /// <summary>A room theme: decor slot count and how it unlocks (cumulative likes or owning an item; never coins from likes).</summary>
    public sealed class StableTheme
    {
        public string Id, Name, Key, UnlockItem;
        public int Slots;
        public int? UnlockLikes;
        public bool Unlocked;
        internal static StableTheme Parse(JsonNode o) => new StableTheme
        {
            Id = J.Str(o, "id"), Name = J.Str(o, "name"), Key = J.Str(o, "key"), Slots = J.Int(o, "slots"), Unlocked = J.Bool(o, "unlocked"),
            UnlockLikes = J.IntN(o, "unlockLikes"), UnlockItem = J.Str(o, "unlockItem"),
        };
    }

    /// <summary>A decor cosmetic and whether I own it (only owned decor can be placed; buy it in the cosmetics shop).</summary>
    public sealed class StableDecor
    {
        public string ItemId, Name, Key, Currency;
        public int Price;
        public bool Owned;
        internal static StableDecor Parse(JsonNode o) => new StableDecor
        {
            ItemId = J.Str(o, "itemId"), Name = J.Str(o, "name"), Key = J.Str(o, "key"), Currency = J.Str(o, "currency"), Price = J.Int(o, "price"), Owned = J.Bool(o, "owned"),
        };
    }

    /// <summary>The editable layout (PUT /v1/stable body).</summary>
    public sealed class StableLayout
    {
        public string Theme = "standard";
        /// <summary>表札, or null for the default "&lt;表示名&gt;の厩舎".</summary>
        public string Name;
        public List<string> Slots = new List<string>();
        public List<string> FeaturedHorseIds = new List<string>();
        public long? UpdatedAt;

        public StableLayout Clone() => new StableLayout { Theme = Theme, Name = Name, Slots = new List<string>(Slots), FeaturedHorseIds = new List<string>(FeaturedHorseIds), UpdatedAt = UpdatedAt };

        internal static StableLayout Parse(JsonNode o) => o == null ? new StableLayout() : new StableLayout
        {
            Theme = J.Str(o, "theme") ?? "standard", Name = J.Str(o, "name"),
            Slots = J.List(o, "slots", x => x.IsNull ? null : x.AsString()), FeaturedHorseIds = J.List(o, "featuredHorseIds", x => x.AsString()), UpdatedAt = J.LongN(o, "updatedAt"),
        };

        internal JsonNode ToJson()
        {
            var b = JsonNode.Obj();
            b.Set("theme", Theme);
            b.Set("name", Name == null ? JsonNode.Null() : JsonNode.Str(Name));
            var s = JsonNode.Arr();
            foreach (var x in Slots) s.Add(x == null ? JsonNode.Null() : JsonNode.Str(x));
            b.Set("slots", s);
            var h = JsonNode.Arr();
            foreach (var x in FeaturedHorseIds) h.Add(JsonNode.Str(x));
            b.Set("featuredHorseIds", h);
            return b;
        }
    }

    /// <summary>Like counters: received in total, given today and today's limits.</summary>
    public sealed class StableLikes
    {
        public int Received, GivenToday, PerDay, PerTargetPerDay;
        internal static StableLikes Parse(JsonNode o) => new StableLikes { Received = J.Int(o, "received"), GivenToday = J.Int(o, "givenToday"), PerDay = J.Int(o, "perDay"), PerTargetPerDay = J.Int(o, "perTargetPerDay") };
    }

    /// <summary>GET /v1/stable: my layout (or the default one built from the equipped decor), themes, decor, likes and what visitors see.</summary>
    public sealed class MyStable
    {
        /// <summary>False until the first save: other players cannot visit yet.</summary>
        public bool Saved;
        public StableLayout Layout = new StableLayout();
        public List<StableTheme> Themes = new List<StableTheme>();
        public List<StableDecor> Decor = new List<StableDecor>();
        public int FeaturedMax, NameMaxChars;
        public StableLikes Likes = new StableLikes();
        /// <summary>The public copy as visitors see it (null before the first save or while the account is suspended).</summary>
        public StableSnapshot Preview;
        public string Notice;

        internal static MyStable Parse(JsonNode o) => new MyStable
        {
            Saved = J.Bool(o, "saved"), Layout = StableLayout.Parse(J.Opt(o, "layout")), Themes = J.List(o, "themes", StableTheme.Parse), Decor = J.List(o, "decor", StableDecor.Parse),
            FeaturedMax = J.Int(o, "featuredMax"), NameMaxChars = J.Int(o, "nameMaxChars", 12), Likes = StableLikes.Parse(J.Opt(o, "likes")),
            Preview = StableSnapshot.Parse(J.Opt(o, "preview")), Notice = J.Str(o, "notice"),
        };
    }

    /// <summary>PUT /v1/stable result.</summary>
    public sealed class StableSaveResult
    {
        public StableLayout Layout;
        public StableSnapshot Snapshot;
        internal static StableSaveResult Parse(JsonNode o) => new StableSaveResult { Layout = StableLayout.Parse(J.Opt(o, "layout")), Snapshot = StableSnapshot.Parse(J.Opt(o, "snapshot")) };
    }

    /// <summary>The visitor's side of a visit.</summary>
    public sealed class StableViewer
    {
        /// <summary>"self" | "friend" | "other".</summary>
        public string Relation;
        public int LikedToday, LikesLeftToday;
        public bool CanLike;
        internal static StableViewer Parse(JsonNode o) => new StableViewer { Relation = J.Str(o, "relation"), LikedToday = J.Int(o, "likedToday"), LikesLeftToday = J.Int(o, "likesLeftToday"), CanLike = J.Bool(o, "canLike") };
    }

    /// <summary>GET /v1/stable/:playerId.</summary>
    public sealed class StableVisit
    {
        public StableSnapshot Stable;
        public StableViewer Viewer = new StableViewer();
        internal static StableVisit Parse(JsonNode o) => new StableVisit { Stable = StableSnapshot.Parse(J.Opt(o, "stable")), Viewer = StableViewer.Parse(J.Opt(o, "viewer")) };
    }

    /// <summary>GET /v1/stable/visits.</summary>
    public sealed class StableVisits
    {
        public List<StableSummary> Friends = new List<StableSummary>();
        public List<StableSummary> Recommended = new List<StableSummary>();
        internal static StableVisits Parse(JsonNode o) => new StableVisits { Friends = J.List(o, "friends", StableSummary.Parse), Recommended = J.List(o, "recommended", StableSummary.Parse) };
    }

    /// <summary>POST /v1/stable/:playerId/like. No coins are ever attached to a like.</summary>
    public sealed class StableLikeResult
    {
        public string PlayerId;
        /// <summary>The stable's like total after this like.</summary>
        public int Likes;
        public int RemainingToday;
        internal static StableLikeResult Parse(JsonNode o) => new StableLikeResult { PlayerId = J.Str(o, "playerId"), Likes = J.Int(o, "likes"), RemainingToday = J.Int(o, "remainingToday") };
    }

    public sealed partial class ApiClient
    {
        // ------------------------------------------------------------------ マイ厩舎 (REQ-STABLE-*)

        /// <summary>My stable: layout, themes (unlock state), decor (owned), like counters and the public preview.</summary>
        public Task<MyStable> GetMyStableAsync(CancellationToken ct = default)
            => Call("GET", "/v1/stable", null, true, null, true, MyStable.Parse, ct);

        /// <summary>
        /// Save the layout (full replace). Only owned decor (NOT_ELIGIBLE otherwise), unlocked themes, own active horses
        /// (HORSE_NOT_FOUND / HORSE_NOT_ACTIVE) and an NG-checked plate name (INVALID_NAME / NG_NAME). Safe to retry.
        /// </summary>
        public Task<StableSaveResult> SaveStableAsync(StableLayout layout, CancellationToken ct = default)
            => Call("PUT", "/v1/stable", (layout ?? new StableLayout()).ToJson(), true, null, true, StableSaveResult.Parse, ct);

        /// <summary>Friends' stables and a few recommended ones (most liked).</summary>
        public Task<StableVisits> GetStableVisitsAsync(CancellationToken ct = default)
            => Call("GET", "/v1/stable/visits", null, true, null, true, StableVisits.Parse, ct);

        /// <summary>Visit a stable (read from the public copy). NotFoundException when it is not open (never saved, or suspended).</summary>
        public Task<StableVisit> GetStableAsync(string playerId, CancellationToken ct = default)
            => Call("GET", "/v1/stable/" + Seg(playerId), null, true, null, true, StableVisit.Parse, ct);

        /// <summary>
        /// Like a stable (no coins for either side). LIKE_LIMIT = today's likes are used up, ALREADY_LIKED = this stable was
        /// liked today, NOT_ELIGIBLE = your own stable. A retry with the same key counts once.
        /// </summary>
        public Task<StableLikeResult> LikeStableAsync(string playerId, string idempotencyKey = null, CancellationToken ct = default)
            => Call("POST", "/v1/stable/" + Seg(playerId) + "/like", null, true, idempotencyKey ?? NewIdempotencyKey(), true, StableLikeResult.Parse, ct);
    }
}
