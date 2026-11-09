using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-BOX-001..014 プレゼントボックス (server/src/domain/giftBox.ts, contracts/protocol.md §26).
    // Free coins and items only — paid coins are never in the box. Expiry text is shown only for a real expiresAt.

    /// <summary>The home envelope badge (GET /v1/player, bootstrap, every box response).</summary>
    public sealed class GiftBadge
    {
        public int Unclaimed, ExpiringSoon;
        internal static GiftBadge Parse(JsonNode o) => o == null ? new GiftBadge() : new GiftBadge { Unclaimed = J.Int(o, "unclaimed"), ExpiringSoon = J.Int(o, "expiringSoon") };
    }

    public sealed class GiftItem
    {
        public string ItemId, Name;
        public int Qty;
        internal static GiftItem Parse(JsonNode o) => new GiftItem { ItemId = J.Str(o, "itemId"), Name = J.Str(o, "name"), Qty = J.Int(o, "qty") };
    }

    /// <summary>One gift (unclaimed, claimed or expired).</summary>
    public sealed class GiftEntry
    {
        /// <summary>Source: ops_compensation | ops_grant | invite | event | tournament | team | league | season | team_goal | exchange.</summary>
        public string GiftId, Source, TitleKey, Title, Status, How, HeldReason, HeldItemId;
        public int? Rank;
        public int FreeCoins;
        public List<GiftItem> Items = new List<GiftItem>();
        /// <summary>Display lines of the contents (「無償コイン300枚」「スカウト券×1」, localised by the server).</summary>
        public List<string> Lines = new List<string>();
        public long CreatedAt;
        /// <summary>null = no expiry (show no expiry text at all).</summary>
        public long? ExpiresAt, DoneAt;
        public bool Unclaimed => Status == "unclaimed";
        public bool Expired => Status == "expired";
        public bool IsCompensation => Source == "ops_compensation";

        /// <summary>
        /// Whole days left before it expires, rounded up (「あと3日」), or null when it never expires. 0 = expires within the day
        /// it is read on — callers show 「本日まで」. Never invented: only from the server's expiresAt.
        /// </summary>
        public int? DaysLeft(long nowMs)
        {
            if (ExpiresAt == null) return null;
            long ms = ExpiresAt.Value - nowMs;
            if (ms <= 0) return 0;
            return (int)((ms + 86_399_999L) / 86_400_000L);
        }

        internal static GiftEntry Parse(JsonNode o)
        {
            var c = J.Opt(o, "contents");
            var h = J.Opt(o, "held");
            return new GiftEntry
            {
                GiftId = J.Str(o, "giftId"), Source = J.Str(o, "source"), TitleKey = J.Str(o, "titleKey"), Title = J.Str(o, "title"), Status = J.Str(o, "status"),
                How = J.Str(o, "how"), Rank = J.IntN(o, "rank"), FreeCoins = J.Int(c, "freeCoins"), Items = J.List(c, "items", GiftItem.Parse),
                Lines = J.List(o, "lines", x => x.AsString()), CreatedAt = J.Long(o, "createdAt"), ExpiresAt = J.LongN(o, "expiresAt"), DoneAt = J.LongN(o, "doneAt"),
                HeldReason = J.Str(h, "reason"), HeldItemId = J.Str(h, "itemId"),
            };
        }
    }

    /// <summary>GET /v1/gift-box (one page of one tab).</summary>
    public sealed class GiftBoxPage
    {
        public bool Enabled;
        /// <summary>box | history</summary>
        public string Tab;
        public GiftBadge Badge = new GiftBadge();
        public int MaxUnclaimed, Total, Offset, Limit, HistoryDays;
        public int? NextOffset, DefaultExpiryDays;
        /// <summary>Always false: the box never holds paid coins.</summary>
        public bool PaidCoins;
        public List<GiftEntry> Entries = new List<GiftEntry>();
        internal static GiftBoxPage Parse(JsonNode o)
        {
            var r = J.Opt(o, "rules");
            return new GiftBoxPage
            {
                Enabled = J.Bool(o, "enabled"), Tab = J.Str(o, "tab"), Badge = GiftBadge.Parse(J.Opt(o, "badge")), MaxUnclaimed = J.Int(o, "maxUnclaimed"),
                Total = J.Int(o, "total"), Offset = J.Int(o, "offset"), Limit = J.Int(o, "limit"), NextOffset = J.IntN(o, "nextOffset"),
                DefaultExpiryDays = J.IntN(r, "defaultExpiryDays"), HistoryDays = J.Int(r, "historyDays"), PaidCoins = J.Bool(r, "paidCoins"),
                Entries = J.List(o, "entries", GiftEntry.Parse),
            };
        }
    }

    public sealed class GiftClaimed
    {
        public string GiftId, Source;
        public int FreeCoins;
        public List<ItemQtyView> Items = new List<ItemQtyView>();
        internal static GiftClaimed Parse(JsonNode o) => new GiftClaimed { GiftId = J.Str(o, "giftId"), Source = J.Str(o, "source"), FreeCoins = J.Int(o, "freeCoins"), Items = J.List(o, "items", ItemQtyView.Parse) };
    }

    public sealed class ItemQtyView
    {
        public string ItemId;
        public int Qty;
        internal static ItemQtyView Parse(JsonNode o) => new ItemQtyView { ItemId = J.Str(o, "itemId"), Qty = J.Int(o, "qty") };
    }

    /// <summary>A gift that stayed in the box: receiving it would go over a hold limit (item_cap / coin_cap).</summary>
    public sealed class GiftHeld
    {
        public string GiftId, Reason, ItemId;
        internal static GiftHeld Parse(JsonNode o) => new GiftHeld { GiftId = J.Str(o, "giftId"), Reason = J.Str(o, "reason"), ItemId = J.Str(o, "itemId") };
    }

    /// <summary>Result of claim (one) or claim-all.</summary>
    public sealed class GiftClaimResult
    {
        public List<GiftClaimed> Claimed = new List<GiftClaimed>();
        public List<GiftHeld> Held = new List<GiftHeld>();
        public int TotalFreeCoins;
        public Dictionary<string, int> TotalItems = new Dictionary<string, int>();
        public GiftBadge Badge = new GiftBadge();
        public Wallet Wallet;
        /// <summary>Current counts of the items that changed.</summary>
        public Dictionary<string, int> Items = new Dictionary<string, int>();
        internal static GiftClaimResult Parse(JsonNode o)
        {
            var t = J.Opt(o, "totals");
            return new GiftClaimResult
            {
                Claimed = J.List(o, "claimed", GiftClaimed.Parse), Held = J.List(o, "held", GiftHeld.Parse), TotalFreeCoins = J.Int(t, "freeCoins"),
                TotalItems = J.Map(t, "items", v => v.AsInt()), Badge = GiftBadge.Parse(J.Opt(o, "badge")), Wallet = Wallet.Parse(J.Opt(o, "wallet")),
                Items = J.Map(o, "items", v => v.AsInt()),
            };
        }
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-BOX-004: one page of the box (<paramref name="tab"/> "box") or the last 90 days of history ("history").</summary>
        public Task<GiftBoxPage> GetGiftBoxAsync(string tab = "box", int offset = 0, int limit = 50, CancellationToken ct = default)
        {
            if (tab != "box" && tab != "history") throw new System.ArgumentException("tab is box or history", nameof(tab));
            var inv = System.Globalization.CultureInfo.InvariantCulture;
            return Call("GET", "/v1/gift-box?tab=" + tab + "&offset=" + offset.ToString(inv) + "&limit=" + limit.ToString(inv), null, true, null, true, GiftBoxPage.Parse, ct);
        }

        /// <summary>
        /// REQ-BOX-005: receive one gift. Keyed (reuse the key until an answer arrives). ConflictException GIFT_HOLD_CAP (it stays in the
        /// box), GIFT_EXPIRED, ALREADY_CLAIMED; PurchaseBlockedException DELETION_PENDING while the account is scheduled for deletion.
        /// </summary>
        public Task<GiftClaimResult> ClaimGiftAsync(string giftId, string idempotencyKey = null, CancellationToken ct = default)
            => Call("POST", "/v1/gift-box/" + System.Uri.EscapeDataString(giftId) + "/claim", JsonNode.Obj(), true, idempotencyKey ?? NewIdempotencyKey(), true, GiftClaimResult.Parse, ct);

        /// <summary>REQ-BOX-005: receive everything that fits (soonest expiry first); the rest is listed in Held with its reason. Keyed.</summary>
        public Task<GiftClaimResult> ClaimAllGiftsAsync(string idempotencyKey = null, CancellationToken ct = default)
            => Call("POST", "/v1/gift-box/claim-all", JsonNode.Obj(), true, idempotencyKey ?? NewIdempotencyKey(), true, GiftClaimResult.Parse, ct);
    }
}
