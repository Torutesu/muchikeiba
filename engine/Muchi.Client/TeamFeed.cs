using System.Collections.Generic;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-TEAMFEED-*: 支部の応援スタンプ. server/src/domain/teamFeed.ts, contracts/protocol.md §18.
    // Only fixed stamps and automatic race items: there is no free text anywhere in the feed.

    /// <summary>One stamp of the fixed set (asset key "stamp/&lt;id&gt;", contracts/assets.md).</summary>
    public sealed class Stamp
    {
        public string Id, Label, Asset;
        /// <summary>"default" | "races" | "pass" | "cosmetic".</summary>
        public string UnlockKind;
        /// <summary>races: lifetime races needed.</summary>
        public int UnlockCount;
        /// <summary>cosmetic: the cosmetic to buy in the 見た目 shop (direct sale, fixed price).</summary>
        public string UnlockItemId;
        /// <summary>Server-built lock text ("レースに10回出走で解放").</summary>
        public string UnlockText;
        public bool Unlocked;
        internal static Stamp Parse(JsonNode o)
        {
            var u = J.Opt(o, "unlock");
            return new Stamp
            {
                Id = J.Str(o, "id"), Label = J.Str(o, "label"), Asset = J.Str(o, "asset") ?? AssetKeys.Stamp(J.Str(o, "id")),
                UnlockKind = J.Str(u, "kind") ?? "default", UnlockCount = J.Int(u, "count"), UnlockItemId = J.Str(u, "itemId"),
                UnlockText = J.Str(o, "unlockText"), Unlocked = J.Bool(o, "unlocked"),
            };
        }
    }

    public sealed class StampCatalog
    {
        public int Version;
        public List<Stamp> Stamps = new List<Stamp>();
        public int PostIntervalMs = 10000, PostsPerDay = 50, FeedSize = 100, PageMax = 50;
        internal static StampCatalog Parse(JsonNode o)
        {
            var l = J.Opt(o, "limits");
            return new StampCatalog
            {
                Version = J.Int(o, "version"), Stamps = J.List(o, "stamps", Stamp.Parse),
                PostIntervalMs = J.Int(l, "postIntervalMs", 10000), PostsPerDay = J.Int(l, "postsPerDay", 50), FeedSize = J.Int(l, "feedSize", 100), PageMax = J.Int(l, "pageMax", 50),
            };
        }
    }

    /// <summary>The race result of an automatic feed item (a member won or placed in ranked or a tournament).</summary>
    public sealed class FeedRaceInfo
    {
        public string RaceId, Mode, TrackId;
        public int Place, FieldSize;
        internal static FeedRaceInfo Parse(JsonNode o) => o == null ? null : new FeedRaceInfo
        {
            RaceId = J.Str(o, "raceId"), Mode = J.Str(o, "mode"), TrackId = J.Str(o, "trackId"), Place = J.Int(o, "place"), FieldSize = J.Int(o, "fieldSize"),
        };
    }

    public sealed class FeedReactionCount
    {
        public string StampId;
        public int Count;
        public bool Mine;
        internal static FeedReactionCount Parse(JsonNode o) => new FeedReactionCount { StampId = J.Str(o, "stampId"), Count = J.Int(o, "count"), Mine = J.Bool(o, "mine") };
    }

    public sealed class FeedItem
    {
        public long Seq, At;
        /// <summary>"stamp" | "race" | "goal" | "qchat" (REQ-QCHAT-009: a fixed phrase) (REQ-TGOAL-008: a team item, no author: not reportable, never hidden by a mute).</summary>
        public string Kind;
        public string PlayerId, DisplayName;
        public bool Mine;
        public string StampId, StampAsset;
        public FeedRaceInfo Race;
        public FeedGoalInfo Goal;
        /// <summary>REQ-QCHAT-009: set on "qchat" items (a fixed phrase; its text already in my language).</summary>
        public FeedQuickChat QuickChat;
        public List<FeedReactionCount> Reactions = new List<FeedReactionCount>();
        public string MyReaction;
        public bool IsRace => Kind == "race";
        public bool IsGoal => Kind == "goal";
        public bool IsQuickChat => Kind == "qchat";
        internal static FeedItem Parse(JsonNode o) => new FeedItem
        {
            Seq = J.Long(o, "seq"), At = J.Long(o, "at"), Kind = J.Str(o, "kind"), PlayerId = J.Str(o, "playerId"), DisplayName = J.Str(o, "displayName"),
            Mine = J.Bool(o, "mine"), StampId = J.Str(o, "stampId"), StampAsset = J.Str(o, "stampAsset"), Race = FeedRaceInfo.Parse(J.Opt(o, "race")), Goal = FeedGoalInfo.Parse(J.Opt(o, "goal")), QuickChat = FeedQuickChat.Parse(J.Opt(o, "qchat")),
            Reactions = J.List(o, "reactions", FeedReactionCount.Parse), MyReaction = J.Str(o, "myReaction"),
        };
    }

    /// <summary>A page of the team feed, newest first. Page down with <see cref="NextBefore"/> (null = no older items).</summary>
    public sealed class FeedPage
    {
        public string TeamId;
        public List<FeedItem> Items = new List<FeedItem>();
        public long? NextBefore;
        public long LatestSeq;
        /// <summary>The server copy of my mute list.</summary>
        public List<string> Muted = new List<string>();
        internal static FeedPage Parse(JsonNode o) => new FeedPage
        {
            TeamId = J.Str(o, "teamId"), Items = J.List(o, "items", FeedItem.Parse), NextBefore = J.LongN(o, "nextBefore"), LatestSeq = J.Long(o, "latestSeq"),
            Muted = J.List(o, "muted", x => x.AsString()),
        };
    }

    public sealed class StampPostResult
    {
        public string TeamId, StampId;
        public long Seq, At;
        internal static StampPostResult Parse(JsonNode o) => new StampPostResult { TeamId = J.Str(o, "teamId"), StampId = J.Str(o, "stampId"), Seq = J.Long(o, "seq"), At = J.Long(o, "at") };
    }

    public enum FeedReportReason { Spam, Harassment, Other }

    public sealed partial class ApiClient
    {
        // ------------------------------------------------------------------ 支部の応援スタンプ (REQ-TEAMFEED-*)

        /// <summary>The stamp set with my unlocks (server-built lock texts) and the post limits.</summary>
        public Task<StampCatalog> GetStampsAsync(CancellationToken ct = default)
            => Call("GET", "/v1/stamps", null, true, null, true, StampCatalog.Parse, ct);

        /// <summary>
        /// A page of my team's feed, newest first; <paramref name="before"/> = <see cref="FeedPage.NextBefore"/> of the previous page.
        /// Muted members are already left out. NotFoundException (NOT_IN_TEAM) outside a team.
        /// </summary>
        public Task<FeedPage> GetTeamFeedAsync(long? before = null, int? limit = null, CancellationToken ct = default)
        {
            var q = new List<string>();
            if (before.HasValue) q.Add("before=" + before.Value.ToString(CultureInfo.InvariantCulture));
            if (limit.HasValue) q.Add("limit=" + limit.Value.ToString(CultureInfo.InvariantCulture));
            return Call("GET", "/v1/teams/me/feed" + (q.Count > 0 ? "?" + string.Join("&", q) : ""), null, true, null, true, FeedPage.Parse, ct);
        }

        /// <summary>
        /// Post a stamp. Never retried (a post is not idempotent): RateLimitedException = 1 per 10 s / 50 a day,
        /// ConflictException STAMP_LOCKED = not unlocked, PurchaseBlockedException DELETION_PENDING = account deletion scheduled.
        /// </summary>
        public Task<StampPostResult> PostStampAsync(string stampId, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("stampId", stampId);
            return Call("POST", "/v1/teams/me/feed/stamps", b, true, null, false, StampPostResult.Parse, ct);
        }

        /// <summary>React to a feed item with a stamp (one per item; a new one replaces it; null removes it). Safe to retry.</summary>
        public Task<string> ReactToFeedItemAsync(long seq, string stampId, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("stampId", stampId == null ? JsonNode.Null() : JsonNode.Str(stampId));
            return Call("PUT", "/v1/teams/me/feed/" + seq.ToString(CultureInfo.InvariantCulture) + "/reaction", b, true, null, true, o => J.Str(o, "myReaction"), ct);
        }

        /// <summary>Report an item (support flag on its owner; it disappears from my feed). Safe to retry.</summary>
        public Task<bool> ReportFeedItemAsync(long seq, FeedReportReason reason, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("reason", reason == FeedReportReason.Spam ? "spam" : reason == FeedReportReason.Harassment ? "harassment" : "other");
            return Call("POST", "/v1/teams/me/feed/" + seq.ToString(CultureInfo.InvariantCulture) + "/report", b, true, null, true, o => J.Bool(o, "reported"), ct);
        }

        /// <summary>My mute list (server copy).</summary>
        public Task<List<string>> GetFeedMutesAsync(CancellationToken ct = default)
            => Call("GET", "/v1/teams/me/feed/mutes", null, true, null, true, o => J.List(o, "muted", x => x.AsString()), ct);

        /// <summary>Mute (block) or unmute a member: their items, reactions and cheer pushes disappear for me. Safe to retry.</summary>
        public Task<List<string>> SetFeedMuteAsync(string playerId, bool muted, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("playerId", playerId);
            b.Set("muted", muted);
            return Call("PUT", "/v1/teams/me/feed/mutes", b, true, null, true, o => J.List(o, "muted", x => x.AsString()), ct);
        }
    }
}
