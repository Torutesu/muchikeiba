using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // 友達招待 on the wire (contracts/protocol.md §19, server/src/domain/invite.ts, REQ-INV-001..012).
    // Every amount and text comes from the server (rewards, share text, terms key): display verbatim.

    /// <summary>Invite code rules shared with the server (alphabet, check symbol, display form, deep link).</summary>
    public static class InviteCodes
    {
        /// <summary>No vowels and no look-alike characters (server INVITE_ALPHABET).</summary>
        public const string Alphabet = "23456789BCDFGHJKMNPQRSTVWXZ";
        public const int Length = 8;
        public const string DeepLinkHost = "invite";

        /// <summary>Upper-cases and strips spaces and dashes; null when it cannot be a code (bad symbol, length or check symbol).</summary>
        public static string Normalize(string raw)
        {
            if (raw == null) return null;
            var sb = new StringBuilder();
            foreach (char ch in raw)
            {
                if (ch == ' ' || ch == '-' || ch == '　') continue;
                sb.Append(char.ToUpperInvariant(ch));
            }
            string c = sb.ToString();
            if (c.Length != Length) return null;
            foreach (char ch in c) if (Alphabet.IndexOf(ch) < 0) return null;
            if (Alphabet.IndexOf(c[0]) >= 16) return null; // first symbol = directory shard (16 shards)
            return Check(c.Substring(0, Length - 1)) == c[Length - 1] ? c : null;
        }

        /// <summary>"92W65BGF" → "92W6-5BGF".</summary>
        public static string Display(string code) => code == null || code.Length != Length ? code : code.Substring(0, 4) + "-" + code.Substring(4);

        internal static char Check(string body)
        {
            int sum = 0;
            for (int i = 0; i < body.Length; i++) sum += (Alphabet.IndexOf(body[i]) + 1) * (i + 2);
            return Alphabet[sum % Alphabet.Length];
        }

        /// <summary>
        /// The code in an opened link: <c>muchi://invite/&lt;code&gt;</c> or the https fallback <c>https://&lt;host&gt;/i/&lt;code&gt;</c>
        /// (query and fragment ignored). Null when the link is not an invite link or the code is malformed.
        /// </summary>
        public static string FromLink(string url, string scheme = "muchi")
        {
            if (string.IsNullOrEmpty(url)) return null;
            string u = url;
            int q = u.IndexOfAny(new[] { '?', '#' });
            if (q >= 0) u = u.Substring(0, q);
            string deep = scheme + "://" + DeepLinkHost + "/";
            if (u.StartsWith(deep, StringComparison.OrdinalIgnoreCase)) return Normalize(u.Substring(deep.Length).TrimEnd('/'));
            if (u.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                int i = u.IndexOf("/i/", 8, StringComparison.Ordinal);
                if (i > 0) return Normalize(u.Substring(i + 3).TrimEnd('/'));
            }
            return null;
        }
    }

    public sealed class InviteShare
    {
        /// <summary><c>muchi://invite/&lt;code&gt;</c> (opens the app; see docs/handoff-codex-round10-invite.md).</summary>
        public string DeepLink;
        /// <summary>https fallback (store page / landing page when the app is not installed).</summary>
        public string Url;
        /// <summary>Text for the OS share sheet (already contains the code and the URL).</summary>
        public string Text;
        internal static InviteShare Parse(JsonNode o) => new InviteShare { DeepLink = J.Str(o, "deepLink"), Url = J.Str(o, "url"), Text = J.Str(o, "text") };
    }

    public sealed class InvitedBy
    {
        /// <summary>Null when the inviter's account was deleted.</summary>
        public string PlayerId, DisplayName;
        public long At;
        /// <summary>Milestones this player reached that were credited to the inviter.</summary>
        public string[] Milestones = new string[0];
        internal static InvitedBy Parse(JsonNode o) => o == null ? null : new InvitedBy
        {
            PlayerId = J.Str(o, "playerId"), DisplayName = J.Str(o, "displayName"), At = J.Long(o, "at"), Milestones = J.Strs(o, "milestones"),
        };
    }

    public sealed class InviteRedeemState
    {
        public bool Eligible;
        /// <summary>null when eligible; else "ftue" | "window_closed" | "already_redeemed" | "deletion".</summary>
        public string Reason;
        public int WindowDays, DaysLeft;
        public InvitedBy InvitedBy;
        public Reward WelcomeGift;
        internal static InviteRedeemState Parse(JsonNode o) => new InviteRedeemState
        {
            Eligible = J.Bool(o, "eligible"), Reason = J.Str(o, "reason"), WindowDays = J.Int(o, "windowDays"), DaysLeft = J.Int(o, "daysLeft"),
            InvitedBy = InvitedBy.Parse(J.Opt(o, "invitedBy")), WelcomeGift = Reward.Parse(J.Opt(o, "welcomeGift")),
        };
    }

    public sealed class InviteeMilestone
    {
        public string Id;
        public long At;
        /// <summary>False when the invitee was over the counted cap (reached, but nothing paid).</summary>
        public bool Rewarded;
        internal static InviteeMilestone Parse(JsonNode o) => new InviteeMilestone { Id = J.Str(o, "id"), At = J.Long(o, "at"), Rewarded = J.Bool(o, "rewarded") };
    }

    public sealed class Invitee
    {
        /// <summary>"deleted:n" with <see cref="Deleted"/> once the invitee's account was deleted.</summary>
        public string PlayerId, DisplayName;
        public long At;
        /// <summary>Within the counted cap: milestones pay the inviter.</summary>
        public bool Counted, Deleted;
        public List<InviteeMilestone> Milestones = new List<InviteeMilestone>();
        internal static Invitee Parse(JsonNode o) => new Invitee
        {
            PlayerId = J.Str(o, "playerId"), DisplayName = J.Str(o, "displayName"), At = J.Long(o, "at"), Counted = J.Bool(o, "counted"), Deleted = J.Bool(o, "deleted"),
            Milestones = J.List(o, "milestones", InviteeMilestone.Parse),
        };
    }

    public sealed class InviteMilestoneDef
    {
        /// <summary>kind: "beginner_complete" | "class" (ClassId) | "ranked_races" (Target).</summary>
        public string Id, Kind, ClassId;
        public int? Target;
        public Reward Reward;
        /// <summary>Yen value used for the 景品表示法 check (at most ¥200 each); for the terms page, not for the share text.</summary>
        public int RewardYen;
        internal static InviteMilestoneDef Parse(JsonNode o) => new InviteMilestoneDef
        {
            Id = J.Str(o, "id"), Kind = J.Str(o, "kind"), ClassId = J.Str(o, "classId"), Target = J.IntN(o, "target"), Reward = Reward.Parse(J.Opt(o, "reward")), RewardYen = J.Int(o, "rewardYen"),
        };
    }

    /// <summary>GET /v1/invite: my code and share links, my redemption state, my invitees and the milestone table (REQ-INV-001/002/006).</summary>
    public sealed class InviteView
    {
        public string Code, DisplayCode;
        public InviteShare Share;
        public InviteRedeemState Redeem;
        public List<Invitee> Invitees = new List<Invitee>();
        /// <summary>Invitees inside the cap / the cap (e.g. 2 / 10).</summary>
        public int Counted, Cap;
        public List<InviteMilestoneDef> Milestones = new List<InviteMilestoneDef>();
        /// <summary>Key of the terms section about invites (shown next to the share button).</summary>
        public string TermsKey;
        internal static InviteView Parse(JsonNode o) => new InviteView
        {
            Code = J.Str(o, "code"), DisplayCode = J.Str(o, "displayCode"), Share = InviteShare.Parse(J.Opt(o, "share")), Redeem = InviteRedeemState.Parse(J.Opt(o, "redeem")),
            Invitees = J.List(o, "invitees", Invitee.Parse), Counted = J.Int(o, "counted"), Cap = J.Int(o, "cap"),
            Milestones = J.List(o, "milestones", InviteMilestoneDef.Parse), TermsKey = J.Str(o, "termsKey"),
        };
        public static InviteView FromJson(string json) => Parse(JsonNode.Parse(json));
    }

    /// <summary>POST /v1/invite/redeem result.</summary>
    public sealed class InviteRedeemResult
    {
        /// <summary>"redeemed" (first time) or "already" (a retry of the same redemption).</summary>
        public string Status;
        public string InviterId, InviterName;
        public Reward WelcomeGift;
        /// <summary>False when either side's friend list was full (the redemption still counts).</summary>
        public bool Friended;
        internal static InviteRedeemResult Parse(JsonNode o)
        {
            var inv = J.Opt(o, "inviter");
            return new InviteRedeemResult
            {
                Status = J.Str(o, "status"), InviterId = J.Str(inv, "playerId"), InviterName = J.Str(inv, "displayName"),
                WelcomeGift = Reward.Parse(J.Opt(o, "welcomeGift")), Friended = J.Bool(o, "friended"),
            };
        }
        public static InviteRedeemResult FromJson(string json) => Parse(JsonNode.Parse(json));
    }

    public sealed partial class ApiClient
    {
        /// <summary>
        /// GET /v1/invite. <paramref name="installId"/>: the app's random per-install id (keychain / keystore), sent so the
        /// server can refuse redemptions of this player's code from the same device (only a hash is stored).
        /// </summary>
        public Task<InviteView> GetInviteAsync(string installId = null, CancellationToken ct = default)
        {
            var h = installId == null ? null : new Dictionary<string, string> { ["x-install-id"] = installId };
            return Call("GET", "/v1/invite", null, true, null, true, InviteView.Parse, ct, h);
        }

        /// <summary>
        /// POST /v1/invite/redeem: enter a friend's code once, within the first days after the tutorial. Safe to retry (the
        /// server answers "already" for the same redemption). Errors: INVITE_CODE_INVALID (typo), NOT_FOUND (unknown code),
        /// INVITE_SELF, INVITE_ALREADY_REDEEMED, INVITE_WINDOW_CLOSED, NOT_ELIGIBLE (tutorial not done), INVITE_REFUSED
        /// (anti-abuse; do not say why), RATE_LIMITED.
        /// </summary>
        public Task<InviteRedeemResult> RedeemInviteAsync(string code, string installId, CancellationToken ct = default)
        {
            if (string.IsNullOrEmpty(installId)) throw new ArgumentException("installId is required", nameof(installId));
            var b = JsonNode.Obj().Set("code", code ?? "").Set("installId", installId);
            return Call("POST", "/v1/invite/redeem", b, true, null, false, InviteRedeemResult.Parse, ct);
        }
    }
}
