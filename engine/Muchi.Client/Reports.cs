using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-RPT-001..020: 通報とブロック管理 (server/src/domain/reports.ts・blocks.ts, contracts/protocol.md §47).
    // A report only goes to the support queue: the client never learns whether it was merged with others or who else
    // reported, and the reported player never learns who reported them. The block list is the one list the team feed's
    // mute, the rival block and the activity list already use. Labels and effect texts come from the server (English when
    // the request asks for it); player names and the note are never translated.

    public static class ReportCategories
    {
        public const string Name = "name", Text = "text", Cheating = "cheating", Harassment = "harassment", Other = "other";
        public static readonly string[] All = { Name, Text, Cheating, Harassment, Other };
    }

    public static class ReportContentKinds
    {
        public const string Player = "player", DisplayName = "display_name", HorseName = "horse_name", StableName = "stable_name",
            ReplayTitle = "replay_title", PhotoCaption = "photo_caption", Race = "race",
            /// <summary>Round 18 integration: a §52 quick chat phrase in the branch feed (key "feedRef" = "teamId:seq").</summary>
            Qchat = "qchat";
        public static readonly string[] All = { Player, DisplayName, HorseName, StableName, ReplayTitle, PhotoCaption, Race, Qchat };

        /// <summary>The content key each kind needs (protocol §47.4), or null.</summary>
        public static string RefKey(string kind)
        {
            switch (kind)
            {
                case HorseName: return "horseId";
                case ReplayTitle: case Race: return "raceId";
                case PhotoCaption: return "photoId";
                case Qchat: return "feedRef";
                default: return null;
            }
        }
    }

    /// <summary>Where the report sheet was opened (`source`).</summary>
    public static class ReportSources
    {
        public const string Profile = "profile", Friends = "friends", TeamFeed = "team_feed", Stable = "stable", Hall = "hall",
            Replay = "replay", Photo = "photo", CupLobby = "cup_lobby";
        public static readonly string[] All = { Profile, Friends, TeamFeed, Stable, Hall, Replay, Photo, CupLobby };
    }

    /// <summary>What is being reported: the player, the content kind and its key (horse id, race id or photo id).</summary>
    public sealed class ReportTarget
    {
        public readonly string PlayerId, Kind, Ref;

        public ReportTarget(string playerId, string kind, string reference = null)
        {
            if (string.IsNullOrEmpty(playerId)) throw new ArgumentException("player id required", nameof(playerId));
            if (Array.IndexOf(ReportContentKinds.All, kind) < 0) throw new ArgumentException("unknown content kind " + kind, nameof(kind));
            var key = ReportContentKinds.RefKey(kind);
            if (key != null && string.IsNullOrEmpty(reference)) throw new ArgumentException(kind + " needs " + key, nameof(reference));
            if (key == null && reference != null) throw new ArgumentException(kind + " takes no key", nameof(reference));
            PlayerId = playerId; Kind = kind; Ref = reference;
        }
    }

    public sealed class ReportCategoryOption
    {
        public string Id, Label;
        public string[] Kinds = new string[0];
        internal static ReportCategoryOption Parse(JsonNode o) => new ReportCategoryOption { Id = J.Str(o, "id"), Label = J.Str(o, "label"), Kinds = J.Strs(o, "kinds") ?? new string[0] };
        public bool Allows(string kind) => Array.IndexOf(Kinds, kind) >= 0;
    }

    /// <summary>GET /v1/reports/options.</summary>
    public sealed class ReportOptions
    {
        public bool Enabled;
        public List<ReportCategoryOption> Categories = new List<ReportCategoryOption>();
        public int NoteMaxChars, RemainingToday;
        internal static ReportOptions Parse(JsonNode o) => new ReportOptions
        {
            Enabled = J.Bool(o, "enabled"), Categories = J.List(o, "categories", ReportCategoryOption.Parse), NoteMaxChars = J.Int(o, "noteMaxChars"), RemainingToday = J.Int(o, "remainingToday"),
        };
    }

    /// <summary>POST /v1/reports answer (never says whether it was merged or how many reported).</summary>
    public sealed class ReportResult
    {
        public bool Received, Blocked;
        public int RemainingToday;
        internal static ReportResult Parse(JsonNode o) => new ReportResult { Received = J.Bool(o, "received"), Blocked = J.Bool(o, "blocked"), RemainingToday = J.Int(o, "remainingToday") };
    }

    public sealed class BlockedPlayer
    {
        /// <summary>The name as of now (deleted / banned → the neutral name). Never translated.</summary>
        public string PlayerId, Name;
        internal static BlockedPlayer Parse(JsonNode o) => new BlockedPlayer { PlayerId = J.Str(o, "playerId"), Name = J.Str(o, "name") };
    }

    public sealed class BlockEffect
    {
        public string Feature, Text;
        internal static BlockEffect Parse(JsonNode o) => new BlockEffect { Feature = J.Str(o, "feature"), Text = J.Str(o, "text") };
    }

    /// <summary>GET /v1/blocks: newest block first, with what a block does per feature.</summary>
    public sealed class BlockList
    {
        public List<BlockedPlayer> Blocked = new List<BlockedPlayer>();
        public List<BlockEffect> Effects = new List<BlockEffect>();
        public int Count, Max;
        internal static BlockList Parse(JsonNode o) => new BlockList
        {
            Blocked = J.List(o, "blocked", BlockedPlayer.Parse), Effects = J.List(o, "effects", BlockEffect.Parse), Count = J.Int(o, "count"), Max = J.Int(o, "max"),
        };
    }

    /// <summary>PUT / DELETE /v1/blocks/:playerId.</summary>
    public sealed class BlockChange
    {
        public string PlayerId;
        public bool Blocked;
        public int Count, Max;
        internal static BlockChange Parse(JsonNode o) => new BlockChange { PlayerId = J.Str(o, "playerId"), Blocked = J.Bool(o, "blocked"), Count = J.Int(o, "count"), Max = J.Int(o, "max") };
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-RPT-001/002: the report sheet's categories, the note limit and today's allowance.</summary>
        public Task<ReportOptions> GetReportOptionsAsync(CancellationToken ct = default)
            => Call("GET", "/v1/reports/options", null, true, null, true, ReportOptions.Parse, ct);

        /// <summary>
        /// REQ-RPT-001..009: send a report. Not retried automatically (each attempt uses today's allowance); a resend of the same
        /// report is merged on the server, so the UI may offer 「もう一度送る」 after a network error.
        /// </summary>
        public Task<ReportResult> SubmitReportAsync(ReportTarget target, string category, string source, string note = null, bool alsoBlock = false, CancellationToken ct = default)
        {
            if (target == null) throw new ArgumentNullException(nameof(target));
            if (Array.IndexOf(ReportCategories.All, category) < 0) throw new ArgumentException("unknown category " + category, nameof(category));
            if (Array.IndexOf(ReportSources.All, source) < 0) throw new ArgumentException("unknown source " + source, nameof(source));
            var content = JsonNode.Obj().Set("kind", target.Kind);
            var key = ReportContentKinds.RefKey(target.Kind);
            if (key != null) content.Set(key, target.Ref);
            var b = JsonNode.Obj().Set("targetId", target.PlayerId).Set("category", category).Set("source", source).Set("content", content);
            if (!string.IsNullOrWhiteSpace(note)) b.Set("note", note);
            if (alsoBlock) b.Set("alsoBlock", true);
            return Call("POST", "/v1/reports", b, true, null, false, ReportResult.Parse, ct);
        }

        /// <summary>REQ-RPT-011: the block list with current names.</summary>
        public Task<BlockList> GetBlocksAsync(CancellationToken ct = default)
            => Call("GET", "/v1/blocks", null, true, null, true, BlockList.Parse, ct);

        /// <summary>REQ-RPT-011: block (idempotent, retried safely).</summary>
        public Task<BlockChange> BlockAsync(string playerId, CancellationToken ct = default)
            => Call("PUT", "/v1/blocks/" + Seg(playerId), null, true, null, true, BlockChange.Parse, ct);

        /// <summary>REQ-RPT-011: unblock (idempotent, retried safely).</summary>
        public Task<BlockChange> UnblockAsync(string playerId, CancellationToken ct = default)
            => Call("DELETE", "/v1/blocks/" + Seg(playerId), null, true, null, true, BlockChange.Parse, ct);
    }
}
