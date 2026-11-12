using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-ACT-001..016: アクティビティ (server/src/domain/activity.ts, contracts/protocol.md §40).
    // A list of things that happened to the player while away, with a deep link per entry. Display + links only: nothing is
    // claimed from here (a gift entry links to the gift box). Text is Japanese from the server, or English when the request
    // asked for it (Accept-Language); player names inside it are never translated.

    /// <summary>The home bell (GET /v1/player `activity`).</summary>
    public sealed class ActivityBadge
    {
        public int Unread;
        internal static ActivityBadge Parse(JsonNode o) => o == null ? new ActivityBadge() : new ActivityBadge { Unread = J.Int(o, "unread") };
    }

    public static class ActivityKinds
    {
        public const string FriendRequest = "friend_request", FriendAccepted = "friend_accepted", RivalWeek = "rival_week", RivalRecord = "rival_record",
            StableLike = "stable_like", TeamCheer = "team_cheer", TournamentResult = "tournament_result", GiftArrived = "gift_arrived",
            TeamGoalTier = "team_goal_tier", TeamGoalWeek = "team_goal_week", ReplayShare = "replay_share",
            // Round 16 integration: hosted cups (§42.7) and the season recap (§43)
            CupInvited = "cup_invited", CupStarted = "cup_started", CupFinished = "cup_finished", CupCancelled = "cup_cancelled", RecapReady = "recap_ready",
            /// <summary>REQ-RPT-013: support's request after a report (no actor; links to 通報とブロック).</summary>
            OpsNotice = "ops_notice", InquiryAnswered = "inquiry_answered",
            // Round 18: a quick chat phrase that named me (§52.8)
            QchatMention = "qchat_mention",
            // Round 18: the personal data export is ready (§51; Category "account", LinkId = requestId)
            DataExportReady = "data_export_ready",
            // Round 22: a promotion at the season close (§68; Category "season", Screen recap, LinkId = season:YYYY-MM)
            ClassPromoted = "class_promoted",
            // Round 23: a new device signed in (§70.4; Category "account", LinkId = sessionId, no push)
            NewDevice = "new_device";
        public static readonly string[] All = { FriendRequest, FriendAccepted, RivalWeek, RivalRecord, StableLike, TeamCheer, TournamentResult, GiftArrived, TeamGoalTier, TeamGoalWeek, ReplayShare, InquiryAnswered,
            CupInvited, CupStarted, CupFinished, CupCancelled, RecapReady, OpsNotice, QchatMention, DataExportReady, ClassPromoted, NewDevice };
    }

    /// <summary>Where an entry leads (`link.screen`).</summary>
    public static class ActivityScreens
    {
        public const string Friends = "friends", Rival = "rival", Stable = "stable", TeamFeed = "team_feed", Tournaments = "tournaments",
            GiftBox = "gift_box", TeamGoal = "team_goal", Replay = "replay", WhatsNew = "whats_new", HelpInquiry = "help_inquiry",
            /// <summary>Round 16: the hosted cup (LinkId = cupId) and the season recap (LinkId = recap id, e.g. season:2026-11).</summary>
            Cups = "cups", Recap = "recap",
            /// <summary>REQ-RPT-011: 通報とブロック (block list + what a block does + guidelines).</summary>
            Safety = "safety",
            /// <summary>Round 18: settings › privacy (the data export, §51).</summary>
            Privacy = "privacy",
            /// <summary>Round 23: settings › ログイン中の端末 (§70; LinkId = the new session).</summary>
            Devices = "devices";
        public static readonly string[] All = { Friends, Rival, Stable, TeamFeed, Tournaments, GiftBox, TeamGoal, Replay, WhatsNew, HelpInquiry, Cups, Recap, Safety, Privacy, Devices };
    }

    public sealed class ActivityActor
    {
        /// <summary>Name as of now (a deleted or banned player shows the neutral name). Never translated.</summary>
        public string PlayerId, Name;
        internal static ActivityActor Parse(JsonNode o) => new ActivityActor { PlayerId = J.Str(o, "playerId"), Name = J.Str(o, "name") };
    }

    /// <summary>One entry. Count &gt; 1 = collapsed (「12件のいいね」). Category = the push category (friends | events | gifts), or support (a support reply, §48.8: no push).</summary>
    public sealed class ActivityItem
    {
        public string Id, Kind, Category, Text, Screen, LinkId;
        public long At;
        public int Count;
        public bool Unread;
        public List<ActivityActor> Actors = new List<ActivityActor>();
        internal static ActivityItem Parse(JsonNode o)
        {
            var l = J.Opt(o, "link");
            return new ActivityItem
            {
                Id = J.Str(o, "id"), Kind = J.Str(o, "kind"), Category = J.Str(o, "category"), At = J.Long(o, "at"), Count = J.Int(o, "count"),
                Unread = J.Bool(o, "unread"), Actors = J.List(o, "actors", ActivityActor.Parse), Text = J.Str(o, "text"), Screen = J.Str(l, "screen"), LinkId = J.Str(l, "id"),
            };
        }
    }

    /// <summary>GET /v1/activity: a page, newest first. Pass NextCursor back as is; null = the end.</summary>
    public sealed class ActivityPage
    {
        public List<ActivityItem> Items = new List<ActivityItem>();
        public string NextCursor, ReadUpTo;
        public int Unread;
        /// <summary>Unseen what's-new entries (REQ-CB-008): a link to that screen, not entries of this list.</summary>
        public int WhatsNew;
        public bool HasMore => NextCursor != null;
        internal static ActivityPage Parse(JsonNode o) => new ActivityPage
        {
            Items = J.List(o, "items", ActivityItem.Parse), NextCursor = J.Str(o, "nextCursor"), ReadUpTo = J.Str(o, "readUpTo"), Unread = J.Int(o, "unread"),
            WhatsNew = J.Int(J.Opt(o, "links"), "whatsNew"),
        };
    }

    public sealed class ActivityReadResult
    {
        public string ReadUpTo;
        public int Unread;
        internal static ActivityReadResult Parse(JsonNode o) => new ActivityReadResult { ReadUpTo = J.Str(o, "readUpTo"), Unread = J.Int(o, "unread") };
    }

    public sealed partial class ApiClient
    {
        public const int ActivityPageMax = 50;

        /// <summary>REQ-ACT-001/007: one page of the activity list.</summary>
        public Task<ActivityPage> GetActivityAsync(string cursor = null, int limit = 20, CancellationToken ct = default)
        {
            if (limit < 1 || limit > ActivityPageMax) throw new ArgumentOutOfRangeException(nameof(limit), "1.." + ActivityPageMax);
            var q = "?limit=" + limit + (string.IsNullOrEmpty(cursor) ? "" : "&cursor=" + Uri.EscapeDataString(cursor));
            return Call("GET", "/v1/activity" + q, null, true, null, true, ActivityPage.Parse, ct);
        }

        /// <summary>REQ-ACT-008: mark read up to an entry id (null = everything now). Idempotent on the server, so it is safe to retry.</summary>
        public Task<ActivityReadResult> MarkActivityReadAsync(string upTo = null, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            if (upTo != null) b.Set("upTo", upTo);
            return Call("POST", "/v1/activity/read", b, true, null, true, ActivityReadResult.Parse, ct);
        }
    }
}
