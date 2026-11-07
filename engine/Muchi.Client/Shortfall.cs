using System.Collections.Generic;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // T6 コイン不足の案内 (contracts/protocol.md §29, REQ-SHORT-001..009, server/src/domain/shortfall.ts): which coins are short,
    // by how much, and the one smallest pack this player can buy now. Every text is built by the server: show it as is.

    /// <summary>The one pack offered for a shortfall (offerId "shortfall", touchpoint "T6").</summary>
    public sealed class ShortfallOffer
    {
        public string OfferId, Touchpoint, ProductId, Name;
        public int PriceYen, PaidCoins;
        /// <summary>The pack's paid coins alone cover the shortfall (false: the largest buyable pack, still short).</summary>
        public bool Covers;
        public List<ProductContent> Contents = new List<ProductContent>();
        /// <summary>The shop's own first-purchase line, only while this pack still has it for this player.</summary>
        public FirstPurchaseBonus FirstPurchaseBonus;
        public bool OneTime;
        internal static ShortfallOffer Parse(JsonNode o) => o == null ? null : new ShortfallOffer
        {
            OfferId = J.Str(o, "offerId"), Touchpoint = J.Str(o, "touchpoint"), ProductId = J.Str(o, "productId"), Name = J.Str(o, "name"),
            PriceYen = J.Int(o, "priceYen"), PaidCoins = J.Int(o, "paidCoins"), Covers = J.Bool(o, "covers"),
            Contents = J.List(o, "contents", ProductContent.Parse), FirstPurchaseBonus = FirstPurchaseBonus.Parse(J.Opt(o, "firstPurchaseBonus")),
            OneTime = J.Bool(o, "oneTime"),
        };
    }

    /// <summary>
    /// The shortfall of a payment. <see cref="CoinKind"/>: "any" (paid + free), "paid" (paid-only spends: free coins do not count),
    /// "free" (free-only payments: never a purchase suggestion). <see cref="Status"/>: covered | largest_only | none_buyable |
    /// free_only | not_short.
    /// </summary>
    public sealed class CoinShortfall
    {
        public bool Short;
        public string CoinKind, Status, Headline, Line;
        /// <summary>The price, the coins that may pay for it, and how many are missing.</summary>
        public int Need, Have, Amount;
        /// <summary>none_buyable: AGE_LIMIT_EXCEEDED | UNSETTLED_DEBT | DELETION_PENDING | BANNED | null.</summary>
        public string BlockedCode;
        /// <summary>Age not registered: the purchase confirmation asks for the birth month first (limits are judged there).</summary>
        public bool AgeCheck;
        public List<string> Notes = new List<string>();
        public ShortfallOffer Offer;
        public bool HasOffer => Short && Offer != null && !string.IsNullOrEmpty(Offer.ProductId);
        public static CoinShortfall Parse(JsonNode o) => o == null ? null : new CoinShortfall
        {
            Short = J.Bool(o, "short"), CoinKind = J.Str(o, "coinKind"), Status = J.Str(o, "status"), Headline = J.Str(o, "headline"), Line = J.Str(o, "line"),
            Need = J.Int(o, "need"), Have = J.Int(o, "have"), Amount = J.Int(o, "shortfall"), BlockedCode = J.Str(o, "blockedCode"), AgeCheck = J.Bool(o, "ageCheck"),
            Notes = J.List(o, "notes", x => x.AsString()), Offer = ShortfallOffer.Parse(J.Opt(o, "offer")),
        };
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-SHORT-005: before a gacha pull (the step-up's current step price; paid-only banners count paid coins only).</summary>
        public Task<CoinShortfall> GetCoinShortfallForGachaAsync(string bannerId, int count, CancellationToken ct = default)
            => Call("GET", "/v1/shop/shortfall?for=gacha&bannerId=" + Seg(bannerId) + "&count=" + (count == 1 ? "1" : "10"), null, true, null, true, CoinShortfall.Parse, ct);

        /// <summary>REQ-SHORT-005: before buying a cosmetic. ConflictException NOT_ELIGIBLE (not sold for coins) / ALREADY_PURCHASED.</summary>
        public Task<CoinShortfall> GetCoinShortfallForCosmeticAsync(string itemId, CancellationToken ct = default)
            => Call("GET", "/v1/shop/shortfall?for=cosmetic&itemId=" + Seg(itemId), null, true, null, true, CoinShortfall.Parse, ct);

        /// <summary>REQ-SHORT-005: an amount (1..1,000,000) of "any" or "paid" coins.</summary>
        public Task<CoinShortfall> GetCoinShortfallAsync(int coins, string kind = "any", CancellationToken ct = default)
            => Call("GET", "/v1/shop/shortfall?for=coins&coins=" + coins.ToString(CultureInfo.InvariantCulture) + "&kind=" + (kind == "paid" ? "paid" : "any"), null, true, null, true, CoinShortfall.Parse, ct);
    }
}
