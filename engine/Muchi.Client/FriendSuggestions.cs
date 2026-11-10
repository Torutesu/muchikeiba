using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-FSUG-001..016: おすすめフレンド (server/src/domain/friendSuggest.ts, contracts/protocol.md §49).
    // People the player already met (friend rooms, events, tournaments, the branch, likes, cheers) plus a count of mutual
    // friends. Nothing is granted. A request goes through the normal friend request flow on the server. The reason text is
    // Japanese, or English when the request asked for it; display names are player-typed and never translated.

    public static class FriendSuggestionKinds
    {
        public const string Opponent = "opponent", Team = "team", Liked = "liked", Cheered = "cheered", Mutual = "mutual";
        public static readonly string[] All = { Opponent, Team, Liked, Cheered, Mutual };
    }

    public sealed class FriendSuggestionReason
    {
        public string Kind;
        /// <summary>Mutual friends (only for Kind "mutual"; who they are is never sent).</summary>
        public int N;
        internal static FriendSuggestionReason Parse(JsonNode o) => new FriendSuggestionReason { Kind = J.Str(o, "kind"), N = J.Int(o, "n") };
    }

    public sealed class FriendSuggestion
    {
        public string PlayerId, DisplayName, TitleId, ClassId;
        /// <summary>The reason line (「同じ支部・共通のフレンド3人」), at most two reasons.</summary>
        public string Text;
        public Silks Silks;
        public List<FriendSuggestionReason> Reasons = new List<FriendSuggestionReason>();
        internal static FriendSuggestion Parse(JsonNode o) => new FriendSuggestion
        {
            PlayerId = J.Str(o, "playerId"), DisplayName = J.Str(o, "displayName"), TitleId = J.Str(o, "titleId"), ClassId = J.Str(o, "classId"),
            Text = J.Str(o, "text"), Silks = Silks.Parse(J.Opt(o, "silks")), Reasons = J.List(o, "reasons", FriendSuggestionReason.Parse),
        };
    }

    /// <summary>GET /v1/friends/suggestions. Enabled false = the section is not shown at all.</summary>
    public sealed class FriendSuggestions
    {
        public bool Enabled;
        public List<FriendSuggestion> Items = new List<FriendSuggestion>();
        /// <summary>「おすすめに表示しない」 (default off).</summary>
        public bool Hidden;
        internal static FriendSuggestions Parse(JsonNode o) => new FriendSuggestions
        {
            Enabled = J.Bool(o, "enabled"), Items = J.List(o, "items", FriendSuggestion.Parse), Hidden = J.Bool(J.Opt(o, "settings"), "hidden"),
        };
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-FSUG-001: the suggestions (at most 10 by default).</summary>
        public Task<FriendSuggestions> GetFriendSuggestionsAsync(CancellationToken ct = default)
            => Call("GET", "/v1/friends/suggestions", null, true, null, true, FriendSuggestions.Parse, ct);

        /// <summary>
        /// REQ-FSUG-008: a friend request to someone suggested right now (NOT_FOUND otherwise; FRIEND_LIMIT as for any request).
        /// Safe to retry: a repeated call answers the same without sending again.
        /// </summary>
        public Task<FriendOpResult> RequestSuggestedFriendAsync(string playerId, CancellationToken ct = default)
            => Call("POST", "/v1/friends/suggestions/" + Seg(playerId) + "/request", JsonNode.Obj(), true, null, true, FriendOpResult.Parse, ct);

        /// <summary>REQ-FSUG-009: hide this suggestion (idempotent).</summary>
        public Task<bool> DismissSuggestionAsync(string playerId, CancellationToken ct = default)
            => Call("POST", "/v1/friends/suggestions/" + Seg(playerId) + "/dismiss", JsonNode.Obj(), true, null, true, o => J.Bool(o, "ok"), ct);

        /// <summary>REQ-FSUG-007: 「おすすめに表示しない」. Returns the stored value.</summary>
        public Task<bool> SetSuggestionsHiddenAsync(bool hidden, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("hidden", hidden);
            return Call("PUT", "/v1/friends/suggestions/settings", b, true, null, true, o => J.Bool(o, "hidden"), ct);
        }
    }
}
