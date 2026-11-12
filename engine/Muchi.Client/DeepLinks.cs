using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-LINK-001..024: ディープリンク・招待リンクと再戦 (server/src/domain/deepLinks.ts / linkService.ts / rematch.ts,
    // contracts/protocol.md §63). A link is `https://<host>/l/<token>` or `muchi://l/<token>`; the token is opaque — the server
    // resolves it. Never log a token; never put one into analytics. Opening a link never spends or joins anything by itself.

    /// <summary>Link types (server LINK_TYPES).</summary>
    public static class LinkTypes
    {
        public const string Room = "room", Cup = "cup", Replay = "replay", Invite = "invite", Friend = "friend", Team = "team", Help = "help";
        public static readonly string[] All = { Room, Cup, Replay, Invite, Friend, Team, Help };
    }

    /// <summary>States of POST /v1/links/resolve (server LINK_STATES). Every reason a link does not open is <see cref="Unavailable"/>.</summary>
    public static class LinkStates
    {
        public const string Ok = "ok", Unavailable = "unavailable", FriendsOnly = "friends_only", Maintenance = "maintenance", UpdateRequired = "update_required";
    }

    /// <summary>How a link reached the app (analytics <c>deep_link_open</c> entry).</summary>
    public static class DeepLinkEntries
    {
        public const string Universal = "universal", Scheme = "scheme", Referrer = "referrer", Typed = "typed";
    }

    /// <summary>The same token format and normalisation as the server (deepLinks.ts parseLink / normalizeToken).</summary>
    public static class DeepLinkParser
    {
        public const string Alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
        public const int TokenLength = 22;
        public const string DefaultScheme = "muchi";
        private const string Dashes = "-‐‑‒–—―−ーｰ";

        /// <summary>The canonical token from typed input (full-width → half-width, spaces / dashes removed, lower case), or null.</summary>
        public static string NormalizeToken(string raw)
        {
            if (raw == null) return null;
            var b = new StringBuilder(raw.Length);
            foreach (var c0 in raw)
            {
                var c = c0 >= '！' && c0 <= '～' ? (char)(c0 - 0xFEE0) : c0 == '　' ? ' ' : c0;
                if (char.IsWhiteSpace(c) || Dashes.IndexOf(c) >= 0) continue;
                b.Append(char.ToLowerInvariant(c));
            }
            var s = b.ToString();
            if (s.Length != TokenLength) return null;
            foreach (var ch in s) if (Alphabet.IndexOf(ch) < 0) return null;
            return s;
        }

        /// <summary>
        /// A token from anything a player can bring: <c>https://&lt;host&gt;/l/&lt;token&gt;</c> (query / fragment ignored),
        /// <c>&lt;scheme&gt;://l/&lt;token&gt;</c>, or the token typed by hand. Anything else → null.
        /// </summary>
        public static string Parse(string raw, string scheme = DefaultScheme) => Parse(raw, scheme, out _);

        public static string Parse(string raw, string scheme, out string entry)
        {
            entry = DeepLinkEntries.Typed;
            if (string.IsNullOrWhiteSpace(raw)) return null;
            var s = raw.Trim();
            var lower = s.ToLowerInvariant();
            string rest = null;
            if (lower.StartsWith("https://"))
            {
                int slash = s.IndexOf('/', 8);
                if (slash < 0) return null;
                var path = s.Substring(slash);
                if (!path.StartsWith("/l/")) return null;
                rest = path.Substring(3);
                entry = DeepLinkEntries.Universal;
            }
            else if (lower.StartsWith((scheme ?? DefaultScheme).ToLowerInvariant() + "://l/"))
            {
                rest = s.Substring((scheme ?? DefaultScheme).Length + 5);
                entry = DeepLinkEntries.Scheme;
            }
            if (rest == null) return NormalizeToken(s);
            int end = rest.IndexOfAny(new[] { '?', '#' });
            if (end >= 0) rest = rest.Substring(0, end);
            rest = rest.TrimEnd('/');
            if (rest.IndexOf('/') >= 0) return null;
            try { rest = Uri.UnescapeDataString(rest); } catch (UriFormatException) { return null; }
            return NormalizeToken(rest);
        }

        /// <summary>
        /// REQ-LINK-011 (Android): the Google Play install referrer the store page carried (<c>link=&lt;token&gt;</c> among other
        /// url-encoded pairs, e.g. <c>utm_source=x&amp;link=…</c>). Read once on the first launch. Null when there is none.
        /// </summary>
        public static string FromInstallReferrer(string referrer)
        {
            if (string.IsNullOrEmpty(referrer)) return null;
            string decoded;
            try { decoded = Uri.UnescapeDataString(referrer); } catch (UriFormatException) { return null; }
            foreach (var pair in decoded.Split('&'))
            {
                int eq = pair.IndexOf('=');
                if (eq > 0 && pair.Substring(0, eq).Trim() == "link") return NormalizeToken(pair.Substring(eq + 1));
            }
            return null;
        }

        /// <summary>Groups of four for reading out / typing (<c>abcd-efgh-…</c>).</summary>
        public static string Format(string token)
        {
            if (token == null) return null;
            var b = new StringBuilder();
            for (int i = 0; i < token.Length; i++) { if (i > 0 && i % 4 == 0) b.Append('-'); b.Append(token[i]); }
            return b.ToString();
        }
    }

    /// <summary>REQ-LINK-005: link type → the screen it opens (server LINK_SCREENS). The game layer maps screens to its own views.</summary>
    public static class DeepLinkRoutes
    {
        public const string FriendRoomJoin = "friend_room_join", CupJoin = "cup_join", FriendReplay = "friend_replay", InviteRedeem = "invite_redeem",
            FriendRequest = "friend_request", TeamView = "team_view", HelpArticle = "help_article";
        private static readonly Dictionary<string, string> ByType = new Dictionary<string, string>
        {
            [LinkTypes.Room] = FriendRoomJoin, [LinkTypes.Cup] = CupJoin, [LinkTypes.Replay] = FriendReplay, [LinkTypes.Invite] = InviteRedeem,
            [LinkTypes.Friend] = FriendRequest, [LinkTypes.Team] = TeamView, [LinkTypes.Help] = HelpArticle,
        };
        public static string ScreenOf(string type) => type != null && ByType.TryGetValue(type, out var s) ? s : null;
    }

    /// <summary>POST /v1/links.</summary>
    public sealed class CreatedLink
    {
        public string Token, Url, AppUrl, Type, ShareText;
        public long CreatedAt, ExpiresAt;
        /// <summary>False: the same live link for the same target (not counted against today's limit).</summary>
        public bool Created;
        internal static CreatedLink Parse(JsonNode o) => new CreatedLink
        {
            Token = J.Str(o, "token"), Url = J.Str(o, "url"), AppUrl = J.Str(o, "appUrl"), Type = J.Str(o, "type"), ShareText = J.Str(o, "shareText"),
            CreatedAt = J.Long(o, "createdAt"), ExpiresAt = J.Long(o, "expiresAt"), Created = J.Bool(o, "created"),
        };
    }

    public sealed class LinkInfo
    {
        public string Token, Url, Type;
        public long CreatedAt, ExpiresAt;
        internal static LinkInfo Parse(JsonNode o) => new LinkInfo { Token = J.Str(o, "token"), Url = J.Str(o, "url"), Type = J.Str(o, "type"), CreatedAt = J.Long(o, "createdAt"), ExpiresAt = J.Long(o, "expiresAt") };
    }

    /// <summary>GET /v1/links (live links, newest first).</summary>
    public sealed class LinkList
    {
        public bool Enabled;
        public List<LinkInfo> Links = new List<LinkInfo>();
        public int CreatesToday, CreatesPerDay;
        internal static LinkList Parse(JsonNode o) => new LinkList
        {
            Enabled = J.Bool(o, "enabled"), Links = J.List(o, "links", LinkInfo.Parse), CreatesToday = J.Int(o, "createsToday"), CreatesPerDay = J.Int(o, "createsPerDay"),
        };
    }

    /// <summary>POST /v1/links/resolve. <see cref="State"/> other than ok: show the matching notice; never retry by itself.</summary>
    public sealed class ResolvedLink
    {
        public string State, Type, Screen;
        public long ExpiresAt;
        /// <summary>The target as the server returned it (type-specific fields below read from it).</summary>
        public JsonNode Target;
        // update_required / maintenance
        public string MinVersion, StoreUrl, Message, EndsAtJst;
        public long EndAt;

        public bool Ok => State == LinkStates.Ok;
        public string Passphrase => J.Str(Target, "passphrase");
        public string Code => J.Str(Target, "code");
        public string FriendCode => J.Str(Target, "friendCode");
        /// <summary>The sharer's display name (friend links). A player-typed name: never translated.</summary>
        public string DisplayName => J.Str(Target, "displayName");
        public bool Self => J.Bool(Target, "self");
        public string TeamId => J.Str(Target, "teamId");
        public string TeamName => J.Str(Target, "teamName");
        public string ArticleId => J.Str(Target, "articleId");
        public string OwnerId => J.Str(Target, "ownerId");
        public string RaceId => J.Str(Target, "raceId");
        public string ReplayTitle => J.Str(Target, "replayTitle");
        public JsonNode CupPreview => J.Opt(Target, "preview");

        public static ResolvedLink Parse(JsonNode o)
        {
            var type = J.Str(o, "type");
            return new ResolvedLink
            {
                State = J.Str(o, "state") ?? LinkStates.Unavailable, Type = type, Screen = J.Str(o, "screen") ?? DeepLinkRoutes.ScreenOf(type), ExpiresAt = J.Long(o, "expiresAt"),
                Target = J.Opt(o, "target"), MinVersion = J.Str(o, "minVersion"), StoreUrl = J.Str(o, "storeUrl"), Message = J.Str(o, "message"),
                EndsAtJst = J.Str(o, "endsAtJst"), EndAt = J.Long(o, "endAt"),
            };
        }
        public static readonly ResolvedLink Unavailable = new ResolvedLink { State = LinkStates.Unavailable };
    }

    public static class RematchStates
    {
        public const string Waiting = "waiting", Opened = "opened", Closed = "closed";
        public const string TooFew = "too_few", NotIncluded = "not_included", Expired = "expired";
        public const string Pressed = "pressed", Declined = "declined", None = "none";
    }

    /// <summary>REQ-LINK-014..019: the rematch of one friend-room race (POST / GET / DELETE /v1/friend-rooms/rematch/:raceId).</summary>
    public sealed class RematchView
    {
        public string RaceId, State, Reason, You;
        public int Pressed, Eligible, WindowSec;
        public long? DeadlineAt;
        public string RoomPassphrase;
        public int RoomMembers;
        public bool RoomHost;
        public bool Opened => State == RematchStates.Opened && RoomPassphrase != null;
        public static RematchView Parse(JsonNode o)
        {
            var room = J.Opt(o, "room");
            return new RematchView
            {
                RaceId = J.Str(o, "raceId"), State = J.Str(o, "state"), Reason = J.Str(o, "reason"), You = J.Str(o, "you"),
                Pressed = J.Int(o, "pressed"), Eligible = J.Int(o, "eligible"), WindowSec = J.Int(o, "windowSec"), DeadlineAt = J.LongN(o, "deadlineAt"),
                RoomPassphrase = J.Str(room, "passphrase"), RoomMembers = J.Int(room, "members"), RoomHost = J.Bool(room, "host"),
            };
        }
        /// <summary>Whole seconds left in the window (0 when closed / unknown). The screen shows the real deadline, no fake timer.</summary>
        public int SecondsLeft(long nowMs) => DeadlineAt == null || State != RematchStates.Waiting ? 0 : (int)Math.Max(0, Math.Ceiling((DeadlineAt.Value - nowMs) / 1000.0));
    }

    public sealed partial class AnalyticsEvent
    {
        /// <summary>REQ-LINK-021: a link reached the app (how it arrived; its type once resolved, <c>none</c> when it did not open). Never the token.</summary>
        public static AnalyticsEvent DeepLinkOpen(long atMs, string entry, string type)
        {
            if (entry != DeepLinkEntries.Universal && entry != DeepLinkEntries.Scheme && entry != DeepLinkEntries.Referrer && entry != DeepLinkEntries.Typed) throw new ArgumentException("unknown entry " + entry);
            var t = Array.IndexOf(LinkTypes.All, type) >= 0 ? type : "none";
            return new AnalyticsEvent("deep_link_open", atMs, JsonNode.Obj().Set("entry", entry).Set("type", t));
        }
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-LINK-003: a link to share (the same live link again for the same target). <paramref name="target"/>: see protocol §63.1.</summary>
        public Task<CreatedLink> CreateLinkAsync(string type, IDictionary<string, string> target = null, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("type", type);
            var t = JsonNode.Obj();
            if (target != null) foreach (var kv in target) t.Set(kv.Key, kv.Value);
            b.Set("target", t);
            return Call("POST", "/v1/links", b, true, null, true, CreatedLink.Parse, ct); // idempotent on the server (same target → same link)
        }

        /// <summary>REQ-LINK-005: what a link opens (a URL, a scheme link or a typed token). Unknown / expired → State unavailable.</summary>
        public Task<ResolvedLink> ResolveLinkAsync(string urlOrToken, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            var token = DeepLinkParser.Parse(urlOrToken);
            b.Set("token", token ?? (urlOrToken ?? ""));
            return Call("POST", "/v1/links/resolve", b, true, null, true, ResolvedLink.Parse, ct);
        }

        public Task<LinkList> ListLinksAsync(CancellationToken ct = default)
            => Call("GET", "/v1/links", null, true, null, true, LinkList.Parse, ct);

        public Task<bool> RevokeLinkAsync(string token, CancellationToken ct = default)
            => Call("DELETE", "/v1/links/" + Uri.EscapeDataString(token ?? ""), null, true, null, true, (o) => J.Bool(o, "revoked"), ct);

        /// <summary>REQ-LINK-015: 「再戦」 (again = choose the horse again; safe to retry).</summary>
        public Task<RematchView> RematchPressAsync(string raceId, string horseId, CancellationToken ct = default)
            => Call("POST", "/v1/friend-rooms/rematch/" + Uri.EscapeDataString(raceId ?? ""), JsonNode.Obj().Set("horseId", horseId ?? ""), true, null, true, RematchView.Parse, ct);

        public Task<RematchView> RematchStatusAsync(string raceId, CancellationToken ct = default)
            => Call("GET", "/v1/friend-rooms/rematch/" + Uri.EscapeDataString(raceId ?? ""), null, true, null, true, RematchView.Parse, ct);

        /// <summary>REQ-LINK-016: 「やめる」.</summary>
        public Task<RematchView> RematchDeclineAsync(string raceId, CancellationToken ct = default)
            => Call("DELETE", "/v1/friend-rooms/rematch/" + Uri.EscapeDataString(raceId ?? ""), null, true, null, true, RematchView.Parse, ct);
    }
}
