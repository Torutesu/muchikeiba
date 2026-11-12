using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-UXS-010/017..022: shop display data, offers, the 30-day daily pack 厩舎手当 and the per-season pass.
    // server/src/domain/shop.ts and pass.ts, contracts/protocol.md §13. Every label is built by the server:
    // show it as is (no "2倍", no made-up timers; the only end times are real season ends).

    /// <summary>One line of what a product contains (display order). Type: paid_coins | daily_free_coins | pass_premium | pass_levels | item.</summary>
    public sealed class ProductContent
    {
        public string Type, Label;
        public int Qty;
        /// <summary>daily_free_coins: days and total coins.</summary>
        public int Days, Total;
        /// <summary>pass_premium: number of premium levels and the reward per level.</summary>
        public int Levels;
        public Reward Reward;
        /// <summary>item: the item id.</summary>
        public string ItemId;
        /// <summary>Quality pass 2 — item: what it does in play (server-built, null when not stated).</summary>
        public string Purpose;
        /// <summary>Quality pass 2 — pass_premium: every tier added up and its label (a sum, never a ratio).</summary>
        public Reward TrackTotal;
        public string TotalLabel;
        internal static ProductContent Parse(JsonNode o)
        {
            var total = J.Opt(o, "total");
            return new ProductContent
            {
                Type = J.Str(o, "type"), Label = J.Str(o, "label"), Qty = J.Int(o, "qty"), Days = J.Int(o, "days"),
                Total = total != null && total.Kind == JsonKind.Number ? total.AsInt() : 0,
                Levels = J.Int(o, "levels"), Reward = J.Opt(o, "reward") == null ? null : Reward.Parse(J.Opt(o, "reward")), ItemId = J.Str(o, "itemId"),
                Purpose = J.Str(o, "purpose"),
                TrackTotal = total != null && total.Kind == JsonKind.Object ? Reward.Parse(total) : null,
                TotalLabel = J.Str(o, "totalLabel"),
            };
        }
    }

    /// <summary>First-purchase bonus of a coin pack: stated as coins ("無償コイン◯枚"), never as a multiplier.</summary>
    public sealed class FirstPurchaseBonus
    {
        public int Coins;
        /// <summary>"free" (default) or "paid".</summary>
        public string Currency;
        public string Label;
        internal static FirstPurchaseBonus Parse(JsonNode o) => o == null ? null : new FirstPurchaseBonus { Coins = J.Int(o, "coins"), Currency = J.Str(o, "currency"), Label = J.Str(o, "label") };
    }

    /// <summary>{ kind: "season" } (season pass, ends with the calendar-month season) or { kind: "days", days } (厩舎手当).</summary>
    public sealed class ProductPeriod
    {
        public string Kind;
        public int? Days;
        internal static ProductPeriod Parse(JsonNode o) => o == null ? null : new ProductPeriod { Kind = J.Str(o, "kind"), Days = J.IntN(o, "days") };
    }

    /// <summary>厩舎手当 terms: free coins every game day for <see cref="Days"/> days (claimed once a day). Never auto-renews.</summary>
    public sealed class AllowanceTerms
    {
        public int Days, DailyFreeCoins;
        public bool AutoRenew;
        internal static AllowanceTerms Parse(JsonNode o) => o == null ? null : new AllowanceTerms { Days = J.Int(o, "days"), DailyFreeCoins = J.Int(o, "dailyFreeCoins"), AutoRenew = J.Bool(o, "autoRenew") };
    }

    public sealed class LegalLink
    {
        public string Key, Title;
        internal static LegalLink Parse(JsonNode o) => new LegalLink { Key = J.Str(o, "key"), Title = J.Str(o, "title") };
    }

    /// <summary>purchase-intent for a season pass: the season it is for and how long is left (game days).</summary>
    public sealed class PassPurchaseInfo
    {
        public string SeasonId;
        public long EndsAt;
        public int RemainingDays, Levels;
        /// <summary>Within the last 7 days: the confirmation says "このパスは◯日で終わります".</summary>
        public bool LastWeek;
        public bool AutoRenew;
        internal static PassPurchaseInfo Parse(JsonNode o) => o == null ? null : new PassPurchaseInfo
        {
            SeasonId = J.Str(o, "seasonId"), EndsAt = J.Long(o, "endsAt"), RemainingDays = J.Int(o, "remainingDays"), Levels = J.Int(o, "levels"),
            LastWeek = J.Bool(o, "lastWeek"), AutoRenew = J.Bool(o, "autoRenew"),
        };
    }

    /// <summary>A pass line: a reward every <see cref="Every"/> levels.</summary>
    public sealed class PassLine
    {
        public int Every;
        public Reward Reward;
        internal static PassLine Parse(JsonNode o) => o == null ? null : new PassLine { Every = J.Int(o, "every"), Reward = Reward.Parse(J.Opt(o, "reward")) };
    }

    /// <summary>REQ-UXS-021: a closed season's pass, incl. the levels granted automatically at the close.</summary>
    public sealed class PassSeasonRecord
    {
        public string SeasonId;
        public int Xp, Level, BoostXp, AutoFreeCoins;
        public bool Premium;
        public int[] GrantedFree = new int[0], GrantedPremium = new int[0], AutoGrantedFree = new int[0], AutoGrantedPremium = new int[0];
        public long At;
        internal static PassSeasonRecord Parse(JsonNode o)
        {
            if (o == null) return null;
            var g = J.Opt(o, "granted");
            var a = J.Opt(o, "autoGranted");
            return new PassSeasonRecord
            {
                SeasonId = J.Str(o, "seasonId"), Xp = J.Int(o, "xp"), Level = J.Int(o, "level"), Premium = J.Bool(o, "premium"), BoostXp = J.Int(o, "boostXp"),
                GrantedFree = J.Ints(g, "free"), GrantedPremium = J.Ints(g, "premium"), AutoGrantedFree = J.Ints(a, "free"), AutoGrantedPremium = J.Ints(a, "premium"),
                AutoFreeCoins = J.Int(o, "autoFreeCoins"), At = J.Long(o, "at"),
            };
        }
    }

    /// <summary>
    /// REQ-UXS-017: one offer. Show the one-time sheet only while <see cref="ShowPopup"/> (T2 after the result screen,
    /// T3 on the pass screen / season start, T4 after the promotion), then call <see cref="ApiClient.MarkOfferViewedAsync"/>.
    /// </summary>
    public sealed class ShopOffer
    {
        public string Id, ProductId;
        /// <summary>"T2" (starter) | "T3" (season pass) | "T4" (promotion pack) | "shop" (厩舎手当, shop only).</summary>
        public string Touchpoint;
        /// <summary>"popup" | "recommended".</summary>
        public string Placement;
        /// <summary>first_4th_or_worse | race5 | pass_unlock | pass_level_up | season_start | class_&lt;id&gt; | null.</summary>
        public string Reason;
        public long? TriggeredAt, ViewedAt;
        public bool ShowPopup;
        /// <summary>Real end of the period (season end) or null; never a countdown made up for the sale.</summary>
        public long? EndsAt;
        public int? RemainingDays;
        internal static ShopOffer Parse(JsonNode o) => new ShopOffer
        {
            Id = J.Str(o, "id"), ProductId = J.Str(o, "productId"), Touchpoint = J.Str(o, "touchpoint"), Placement = J.Str(o, "placement"), Reason = J.Str(o, "reason"),
            TriggeredAt = J.LongN(o, "triggeredAt"), ViewedAt = J.LongN(o, "viewedAt"), ShowPopup = J.Bool(o, "showPopup"),
            EndsAt = J.LongN(o, "endsAt"), RemainingDays = J.IntN(o, "remainingDays"),
        };
    }

    /// <summary>T1: coin packs that still carry their first-purchase bonus.</summary>
    public sealed class FirstPurchaseOffer
    {
        public bool Available;
        public List<string> ProductIds = new List<string>();
        public string NoticeKey;
        internal static FirstPurchaseOffer Parse(JsonNode o) => o == null ? new FirstPurchaseOffer() : new FirstPurchaseOffer
        {
            Available = J.Bool(o, "available"), ProductIds = J.List(o, "productIds", x => x.AsString()), NoticeKey = J.Str(o, "noticeKey"),
        };
    }

    /// <summary>A queued 厩舎手当 (bought while one was running): its game-day range.</summary>
    public sealed class AllowanceQueued
    {
        public string StartDate, EndDate;
        internal static AllowanceQueued Parse(JsonNode o) => o == null ? null : new AllowanceQueued { StartDate = J.Str(o, "startDate"), EndDate = J.Str(o, "endDate") };
    }

    /// <summary>REQ-UXS-018: the running 厩舎手当. Dates are game days "YYYY-MM-DD" (REQ-UXS-011).</summary>
    public sealed class AllowanceView
    {
        public bool Active, ClaimedToday;
        public string ProductId, StartDate, EndDate;
        /// <summary>Day of the pack (1..Days), days left including today, coins per day, days claimed.</summary>
        public int Day, Days, DaysLeft, DailyFreeCoins, ClaimedDays;
        public AllowanceQueued Queued;
        public bool CanClaim => Active && !ClaimedToday;
        internal static AllowanceView Parse(JsonNode o) => o == null ? new AllowanceView() : new AllowanceView
        {
            Active = J.Bool(o, "active"), ClaimedToday = J.Bool(o, "claimedToday"), ProductId = J.Str(o, "productId"), StartDate = J.Str(o, "startDate"),
            EndDate = J.Str(o, "endDate"), Day = J.Int(o, "day"), Days = J.Int(o, "days"), DaysLeft = J.Int(o, "daysLeft"), DailyFreeCoins = J.Int(o, "dailyFreeCoins"),
            ClaimedDays = J.Int(o, "claimedDays"), Queued = AllowanceQueued.Parse(J.Opt(o, "queued")),
        };
    }

    /// <summary>POST /v1/shop/allowance/claim: today's coins, the updated pack and the wallet.</summary>
    public sealed class AllowanceClaim
    {
        public int FreeCoins;
        public AllowanceView Allowance;
        public Wallet Wallet;
        internal static AllowanceClaim Parse(JsonNode o) => new AllowanceClaim { FreeCoins = J.Int(o, "freeCoins"), Allowance = AllowanceView.Parse(o), Wallet = Wallet.Parse(J.Opt(o, "wallet")) };
    }

    /// <summary>GET /v1/shop/offers.</summary>
    public sealed class ShopOffers
    {
        public List<ShopOffer> Offers = new List<ShopOffer>();
        public FirstPurchaseOffer FirstPurchase = new FirstPurchaseOffer();
        public AllowanceView Allowance = new AllowanceView();
        internal static ShopOffers Parse(JsonNode o) => new ShopOffers
        {
            Offers = J.List(o, "offers", ShopOffer.Parse), FirstPurchase = FirstPurchaseOffer.Parse(J.Opt(o, "firstPurchase")), Allowance = AllowanceView.Parse(J.Opt(o, "allowance")),
        };
    }

    public sealed class OfferViewed
    {
        public string OfferId;
        public long ViewedAt;
        internal static OfferViewed Parse(JsonNode o) => new OfferViewed { OfferId = J.Str(o, "offerId"), ViewedAt = J.Long(o, "viewedAt") };
    }

    public sealed partial class ApiClient
    {
        /// <summary>
        /// REQ-UXS-017: offers for this player (lazy triggers are recorded by the call; bought products never come back).
        /// PurchaseBlockedException DELETION_PENDING while the account is scheduled for deletion.
        /// </summary>
        public Task<ShopOffers> GetShopOffersAsync(CancellationToken ct = default)
            => Call("GET", "/v1/shop/offers", null, true, null, true, ShopOffers.Parse, ct);

        /// <summary>Record that the one-time sheet was shown (the first time is kept, so it is retried). NotFoundException for an offer not returned now.</summary>
        public Task<OfferViewed> MarkOfferViewedAsync(string offerId, CancellationToken ct = default)
            => Call("POST", "/v1/shop/offers/" + Seg(offerId) + "/view", JsonNode.Obj(), true, null, true, OfferViewed.Parse, ct);

        /// <summary>REQ-UXS-018: the running (or queued) 厩舎手当.</summary>
        public Task<AllowanceView> GetAllowanceAsync(CancellationToken ct = default)
            => Call("GET", "/v1/shop/allowance", null, true, null, true, AllowanceView.Parse, ct);

        /// <summary>
        /// Claim today's 厩舎手当 coins. Keyed, so a retry never pays twice. ConflictException ALREADY_CLAIMED (today done) /
        /// NOT_ELIGIBLE (no pack running); PurchaseBlockedException DELETION_PENDING while a deletion is scheduled.
        /// </summary>
        public Task<AllowanceClaim> ClaimAllowanceAsync(string idempotencyKey = null, CancellationToken ct = default)
            => Call("POST", "/v1/shop/allowance/claim", JsonNode.Obj(), true, idempotencyKey ?? NewIdempotencyKey(), true, AllowanceClaim.Parse, ct);
    }
}
