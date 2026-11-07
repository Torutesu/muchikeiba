using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-CB-001..012: returning-player campaign (復帰キャンペーン) and the what's-new card.
    // server/src/domain/comeback.ts, contracts/protocol.md "復帰キャンペーン・お知らせ".

    /// <summary>One day of the 7-day comeback login track.</summary>
    public sealed class ComebackLoginDay
    {
        public int Day;
        public Reward Reward;
        public bool Claimed;
        internal static ComebackLoginDay Parse(JsonNode o) => new ComebackLoginDay { Day = J.Int(o, "day"), Reward = Reward.Parse(J.Opt(o, "reward")), Claimed = J.Bool(o, "claimed") };
    }

    public sealed class ComebackLogin
    {
        public int Claimed, Total;
        /// <summary>Today's day can be claimed (once per game day; a missed day is not lost).</summary>
        public bool ClaimableToday;
        public List<ComebackLoginDay> Days = new List<ComebackLoginDay>();
        internal static ComebackLogin Parse(JsonNode o) => o == null ? new ComebackLogin() : new ComebackLogin
        {
            Claimed = J.Int(o, "claimed"), Total = J.Int(o, "total"), ClaimableToday = J.Bool(o, "claimableToday"), Days = J.List(o, "days", ComebackLoginDay.Parse),
        };
    }

    /// <summary>A comeback mission. Progress counts from the window's start. <see cref="Feature"/> names the screen it re-teaches.</summary>
    public sealed class ComebackMission
    {
        public string Id, Kind, Feature, Title, Guide;
        public int Target, Progress;
        public Reward Reward;
        public bool Claimed, Claimable;
        internal static ComebackMission Parse(JsonNode o) => new ComebackMission
        {
            Id = J.Str(o, "id"), Kind = J.Str(o, "kind"), Feature = J.Str(o, "feature"), Title = J.Str(o, "title"), Guide = J.Str(o, "guide"),
            Target = J.Int(o, "target"), Progress = J.Int(o, "progress"), Reward = Reward.Parse(J.Opt(o, "reward")),
            Claimed = J.Bool(o, "claimed"), Claimable = J.Bool(o, "claimable"),
        };
    }

    /// <summary>Pass-XP catch-up: each rewarded race adds <see cref="BonusPerRace"/> until <see cref="RemainingXp"/> is 0.</summary>
    public sealed class ComebackCatchUp
    {
        public string SeasonId;
        public int TargetXp, CapXp, GrantedXp, RemainingXp, BonusPerRace;
        public bool Active;
        internal static ComebackCatchUp Parse(JsonNode o) => o == null ? new ComebackCatchUp() : new ComebackCatchUp
        {
            SeasonId = J.Str(o, "seasonId"), TargetXp = J.Int(o, "targetXp"), CapXp = J.Int(o, "capXp"), GrantedXp = J.Int(o, "grantedXp"),
            RemainingXp = J.Int(o, "remainingXp"), BonusPerRace = J.Int(o, "bonusPerRace"), Active = J.Bool(o, "active"),
        };
    }

    public sealed class ComebackWindow
    {
        public string Id, Tier, StartDay, EndDay;
        public int LapseDays, Day, Days, RemainingDays;
        /// <summary>Exclusive end (Unix ms): the real end of the window, shown as a date.</summary>
        public long EndsAt;
        /// <summary>Show the welcome screen (then POST /v1/comeback/welcome).</summary>
        public bool ShowWelcome, Completed;
        /// <summary>REQ-UXS-040: the account is scheduled for deletion; nothing can be claimed.</summary>
        public bool Blocked;
        public ComebackLogin Login = new ComebackLogin();
        public List<ComebackMission> Missions = new List<ComebackMission>();
        public ComebackCatchUp CatchUp = new ComebackCatchUp();
        internal static ComebackWindow Parse(JsonNode o) => o == null ? null : new ComebackWindow
        {
            Id = J.Str(o, "id"), Tier = J.Str(o, "tier"), StartDay = J.Str(o, "startDay"), EndDay = J.Str(o, "endDay"),
            LapseDays = J.Int(o, "lapseDays"), Day = J.Int(o, "day"), Days = J.Int(o, "days"), RemainingDays = J.Int(o, "remainingDays"), EndsAt = J.Long(o, "endsAt"),
            ShowWelcome = J.Bool(o, "showWelcome"), Completed = J.Bool(o, "completed"), Blocked = J.Bool(o, "blocked"),
            Login = ComebackLogin.Parse(J.Opt(o, "login")), Missions = J.List(o, "missions", ComebackMission.Parse), CatchUp = ComebackCatchUp.Parse(J.Opt(o, "catchUp")),
        };
    }

    /// <summary>GET /v1/comeback. <see cref="Window"/> is null unless a window is running.</summary>
    public sealed class ComebackView
    {
        public bool Active;
        public ComebackWindow Window;
        /// <summary>The opt-in push category for lapse reminders ("comeback") and whether it is on.</summary>
        public bool PushEnabled;
        internal static ComebackView Parse(JsonNode o) => new ComebackView
        {
            Active = J.Bool(o, "active"), Window = ComebackWindow.Parse(J.Opt(o, "window")), PushEnabled = J.Bool(J.Opt(o, "push"), "enabled"),
        };
    }

    public sealed class ComebackClaim
    {
        /// <summary>Login day claimed (login claims only).</summary>
        public int Day;
        /// <summary>Mission claimed (mission claims only).</summary>
        public string MissionId;
        public Reward Reward;
        public ComebackWindow Window;
        internal static ComebackClaim Parse(JsonNode o) => new ComebackClaim
        {
            Day = J.Int(o, "day"), MissionId = J.Str(o, "missionId"), Reward = Reward.Parse(J.Opt(o, "reward")), Window = ComebackWindow.Parse(J.Opt(o, "window")),
        };
    }

    /// <summary>One card line: feature | banner | event | balance.</summary>
    public sealed class WhatsNewItem
    {
        public string Id, Kind, Title, Body, Feature, BannerId, EventId;
        public long At;
        public long? EndsAt;
        internal static WhatsNewItem Parse(JsonNode o) => new WhatsNewItem
        {
            Id = J.Str(o, "id"), Kind = J.Str(o, "kind"), Title = J.Str(o, "title"), Body = J.Str(o, "body"), Feature = J.Str(o, "feature"),
            BannerId = J.Str(o, "bannerId"), EventId = J.Str(o, "eventId"), At = J.Long(o, "at"), EndsAt = J.LongN(o, "endsAt"),
        };
    }

    /// <summary>GET /v1/whats-new: what went live since the player last looked (newest first, at most 10).</summary>
    public sealed class WhatsNew
    {
        public long Since, UpTo;
        public bool ShowCard;
        public int More;
        public List<WhatsNewItem> Items = new List<WhatsNewItem>();
        internal static WhatsNew Parse(JsonNode o) => new WhatsNew
        {
            Since = J.Long(o, "since"), UpTo = J.Long(o, "upTo"), ShowCard = J.Bool(o, "showCard"), More = J.Int(o, "more"), Items = J.List(o, "items", WhatsNewItem.Parse),
        };
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-CB-001: the comeback window (an active day for the server; a window may start here).</summary>
        public Task<ComebackView> GetComebackAsync(CancellationToken ct = default)
            => Call("GET", "/v1/comeback", null, true, null, true, ComebackView.Parse, ct);

        /// <summary>
        /// REQ-CB-004: claim today's comeback login day. Keyed (retries return the same day). ConflictException ALREADY_CLAIMED;
        /// NOT_ELIGIBLE when no window runs; DELETION_PENDING while the account is scheduled for deletion.
        /// </summary>
        public Task<ComebackClaim> ClaimComebackLoginAsync(string idempotencyKey = null, CancellationToken ct = default)
            => Call("POST", "/v1/comeback/login", JsonNode.Obj(), true, idempotencyKey ?? NewIdempotencyKey(), true, ComebackClaim.Parse, ct);

        /// <summary>REQ-CB-005: claim a comeback mission. Keyed. NOT_ELIGIBLE until its target is reached.</summary>
        public Task<ComebackClaim> ClaimComebackMissionAsync(string missionId, string idempotencyKey = null, CancellationToken ct = default)
            => Call("POST", "/v1/comeback/missions/" + System.Uri.EscapeDataString(missionId) + "/claim", JsonNode.Obj(), true, idempotencyKey ?? NewIdempotencyKey(), true, ComebackClaim.Parse, ct);

        /// <summary>The welcome screen was shown (idempotent: the first time is kept).</summary>
        public Task<long> MarkComebackWelcomedAsync(CancellationToken ct = default)
            => Call("POST", "/v1/comeback/welcome", JsonNode.Obj(), true, null, true, o => J.Long(o, "welcomedAt"), ct);

        /// <summary>REQ-CB-008: the what's-new card.</summary>
        public Task<WhatsNew> GetWhatsNewAsync(CancellationToken ct = default)
            => Call("GET", "/v1/whats-new", null, true, null, true, WhatsNew.Parse, ct);

        /// <summary>The card was shown: pass <see cref="WhatsNew.UpTo"/> of the GET (idempotent, never moves back).</summary>
        public Task<long> MarkWhatsNewSeenAsync(long upTo, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("upTo", upTo);
            return Call("POST", "/v1/whats-new/seen", b, true, null, true, o => J.Long(o, "seenUpTo"), ct);
        }
    }
}
