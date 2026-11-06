using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-AD-001..012: opt-in rewarded video ads (server/src/domain/ads.ts, contracts/protocol.md §21).
    // The client NEVER grants a reward: it opens a session, shows the ad with the session's customData / userId as
    // the SDK's server-side verification options, then polls the session until the server reports the SSV callback.
    // Every text (title, reward label) comes from the server; show it as is (fixed amounts, never 「倍」).

    /// <summary>What one rewarded view gives: free coins (never paid coins) or extra time attack attempts today.</summary>
    public sealed class AdReward
    {
        public int FreeCoins, TaAttempts;
        internal static AdReward Parse(JsonNode o) => o == null ? null : new AdReward { FreeCoins = J.Int(o, "freeCoins"), TaAttempts = J.Int(o, "taAttempts") };
    }

    /// <summary>One offer card. Surface: home | result | time_attack | shop.</summary>
    public sealed class AdPlacementView
    {
        public string Id, Surface, Title, RewardLabel, AdUnitKey;
        public AdReward Reward;
        public int DailyCap, Used, Left;
        /// <summary>The card may be shown and started now (eligible, views and starts left today).</summary>
        public bool Available;
        internal static AdPlacementView Parse(JsonNode o) => new AdPlacementView
        {
            Id = J.Str(o, "id"), Surface = J.Str(o, "surface"), Title = J.Str(o, "title"), RewardLabel = J.Str(o, "rewardLabel"), AdUnitKey = J.Str(o, "adUnitKey"),
            Reward = AdReward.Parse(J.Opt(o, "reward")), DailyCap = J.Int(o, "dailyCap"), Used = J.Int(o, "used"), Left = J.Int(o, "left"), Available = J.Bool(o, "available"),
        };
    }

    /// <summary>Hints for the ad request (REQ-AD-009): request non-personalised ads / tag for under the age of consent.</summary>
    public sealed class AdRequestHints
    {
        public bool NonPersonalized = true, UnderAgeOfConsent, AgeKnown;
        internal static AdRequestHints Parse(JsonNode o) => o == null ? new AdRequestHints() : new AdRequestHints
        {
            NonPersonalized = J.Bool(o, "nonPersonalized"), UnderAgeOfConsent = J.Bool(o, "underAgeOfConsent"), AgeKnown = J.Bool(o, "ageKnown"),
        };
    }

    /// <summary>
    /// GET /v1/ads. <see cref="Reason"/> when not eligible: disabled | opted_out | deleting | ftue | first_day | age | payer_quiet | moderation.
    /// <see cref="Pref"/>: auto (default; hidden for 30 days after a payment) | on (opted in) | off (never).
    /// </summary>
    public sealed class AdsView
    {
        public bool Enabled, Eligible;
        public string Reason, Pref = "auto", Day, Network;
        public long? PayerQuietUntil;
        public int GlobalCap, GlobalUsed, GlobalLeft, StartsLeft;
        public List<AdPlacementView> Placements = new List<AdPlacementView>();
        public AdRequestHints AdRequest = new AdRequestHints();

        public AdPlacementView Placement(string id) => Placements.Find(p => p.Id == id);
        /// <summary>The first available placement for a surface, or null.</summary>
        public AdPlacementView ForSurface(string surface) => Placements.Find(p => p.Surface == surface && p.Available);

        internal static AdsView Parse(JsonNode o) => new AdsView
        {
            Enabled = J.Bool(o, "enabled"), Eligible = J.Bool(o, "eligible"), Reason = J.Str(o, "reason"), Pref = J.Str(o, "pref") ?? "auto", Day = J.Str(o, "day"),
            Network = J.Str(o, "network"), PayerQuietUntil = J.LongN(o, "payerQuietUntil"), GlobalCap = J.Int(o, "globalCap"), GlobalUsed = J.Int(o, "globalUsed"),
            GlobalLeft = J.Int(o, "globalLeft"), StartsLeft = J.Int(o, "startsLeft"), Placements = J.List(o, "placements", AdPlacementView.Parse),
            AdRequest = AdRequestHints.Parse(J.Opt(o, "adRequest")),
        };
    }

    /// <summary>POST /v1/ads/:placementId/start: pass CustomData and UserId to the SDK's server-side verification options.</summary>
    public sealed class AdStart
    {
        public string SessionId, PlacementId, Network, AdUnitKey, CustomData, UserId, RewardLabel;
        public long ExpiresAt;
        public AdRequestHints AdRequest = new AdRequestHints();
        internal static AdStart Parse(JsonNode o) => new AdStart
        {
            SessionId = J.Str(o, "sessionId"), PlacementId = J.Str(o, "placementId"), Network = J.Str(o, "network"), AdUnitKey = J.Str(o, "adUnitKey"),
            CustomData = J.Str(o, "customData"), UserId = J.Str(o, "userId"), RewardLabel = J.Str(o, "rewardLabel"), ExpiresAt = J.Long(o, "expiresAt"),
            AdRequest = AdRequestHints.Parse(J.Opt(o, "adRequest")),
        };
    }

    /// <summary>GET /v1/ads/sessions/:id. Status: open (waiting for the callback) | rewarded | rejected | expired.</summary>
    public sealed class AdSessionStatus
    {
        public string SessionId, PlacementId, Status, RewardLabel, Reason;
        public long ExpiresAt;
        public AdReward Reward;
        public Wallet Wallet;
        public bool Rewarded => Status == "rewarded";
        public bool Final => Status == "rewarded" || Status == "rejected" || Status == "expired";
        internal static AdSessionStatus Parse(JsonNode o) => new AdSessionStatus
        {
            SessionId = J.Str(o, "sessionId"), PlacementId = J.Str(o, "placementId"), Status = J.Str(o, "status"), RewardLabel = J.Str(o, "rewardLabel"),
            Reason = J.Str(o, "reason"), ExpiresAt = J.Long(o, "expiresAt"), Reward = AdReward.Parse(J.Opt(o, "reward")), Wallet = Wallet.Parse(J.Opt(o, "wallet")),
        };
    }

    public enum AdPref { Auto, On, Off }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-AD-003: offer cards, today's counts and why ads are hidden.</summary>
        public Task<AdsView> GetAdsAsync(CancellationToken ct = default)
            => Call("GET", "/v1/ads", null, true, null, true, AdsView.Parse, ct);

        /// <summary>REQ-AD-001: Auto (default), On (opt in even after paying), Off (never show ads).</summary>
        public Task<AdsView> SetAdPreferenceAsync(AdPref pref, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("mode", pref == AdPref.On ? "on" : pref == AdPref.Off ? "off" : "auto");
            return Call("PUT", "/v1/ads/preferences", b, true, null, true, AdsView.Parse, ct);
        }

        /// <summary>
        /// REQ-AD-005: open a session for one rewarded view (keyed: a retry returns the same session). Nothing is granted here.
        /// ConflictException AD_LIMIT_REACHED (today's views used up) / NOT_ELIGIBLE; RateLimitedException; PurchaseBlockedException DELETION_PENDING.
        /// </summary>
        public Task<AdStart> StartAdAsync(string placementId, string idempotencyKey = null, CancellationToken ct = default)
            => Call("POST", "/v1/ads/" + Seg(placementId) + "/start", JsonNode.Obj(), true, idempotencyKey ?? NewIdempotencyKey(), true, AdStart.Parse, ct);

        /// <summary>REQ-AD-007: poll after the ad closed until <see cref="AdSessionStatus.Final"/> (the SSV callback usually lands within seconds).</summary>
        public Task<AdSessionStatus> GetAdSessionAsync(string sessionId, CancellationToken ct = default)
            => Call("GET", "/v1/ads/sessions/" + Seg(sessionId), null, true, null, true, AdSessionStatus.Parse, ct);
    }
}
