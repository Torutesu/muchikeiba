using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-EXCH-001..012: イベント交換所 (server/src/domain/exchange.ts, contracts/protocol.md §30).
    // Event points are earned only by racing the event (fixed by place + participation, a daily cap) and spent on fixed-price
    // lines with a per-player stock. Nothing is random, nothing rewards taking every line, and points cannot be bought.
    // After the event the exchange stays open for its grace days; points left at the close become material (shown before).

    /// <summary>The leftover rule and, once converted, what the points became.</summary>
    public sealed class ExchangeLeftover
    {
        public string ItemId;
        public int PointsPerUnit;
        /// <summary>"up": ceil(points / PointsPerUnit), so 1 point still gives 1 unit.</summary>
        public string Rounding;
        /// <summary>Units the current points would become.</summary>
        public int Preview;
        public ExchangeConversion Converted;
        internal static ExchangeLeftover Parse(JsonNode o) => o == null ? null : new ExchangeLeftover
        {
            ItemId = J.Str(o, "itemId"), PointsPerUnit = J.Int(o, "pointsPerUnit", 1), Rounding = J.Str(o, "rounding") ?? "up", Preview = J.Int(o, "preview"),
            Converted = ExchangeConversion.Parse(J.Opt(o, "converted")),
        };
        /// <summary>The same rounding as the server (ceil), for a local preview after a buy.</summary>
        public int QtyFor(int points) => points <= 0 || PointsPerUnit <= 0 ? 0 : (points + PointsPerUnit - 1) / PointsPerUnit;
    }

    public sealed class ExchangeConversion
    {
        public long At;
        public int Points, Qty;
        public string ItemId;
        internal static ExchangeConversion Parse(JsonNode o) => o == null ? null : new ExchangeConversion { At = J.Long(o, "at"), Points = J.Int(o, "points"), Qty = J.Int(o, "qty"), ItemId = J.Str(o, "itemId") };
    }

    /// <summary>GET /v1/events summary per event (null = no exchange).</summary>
    public sealed class ExchangeSummary
    {
        /// <summary>"upcoming" / "open" / "grace" / "closed".</summary>
        public string Status;
        public long ClosesAtMs;
        public int GraceDays, Points;
        public ExchangeLeftover Leftover;
        public ExchangeConversion Converted;
        internal static ExchangeSummary Parse(JsonNode o) => o == null ? null : new ExchangeSummary
        {
            Status = J.Str(o, "status"), ClosesAtMs = J.Long(o, "closesAtMs"), GraceDays = J.Int(o, "graceDays"), Points = J.Int(o, "points"),
            Leftover = ExchangeLeftover.Parse(J.Opt(o, "leftover")), Converted = ExchangeConversion.Parse(J.Opt(o, "converted")),
        };
    }

    public sealed class ExchangeEarn
    {
        public int[] ByPlace = new int[0];
        public int Participation, DailyCap, EarnedToday, RemainingToday;
        public long ResetsAtMs;
        internal static ExchangeEarn Parse(JsonNode o) => o == null ? new ExchangeEarn() : new ExchangeEarn
        {
            ByPlace = J.Ints(o, "byPlace"), Participation = J.Int(o, "participation"), DailyCap = J.Int(o, "dailyCap"),
            EarnedToday = J.Int(o, "earnedToday"), RemainingToday = J.Int(o, "remainingToday"), ResetsAtMs = J.Long(o, "resetsAtMs"),
        };
        /// <summary>Points a finish at `place` gives before the daily cap (the server's byPlace + participation).</summary>
        public int PointsFor(int place) => (place >= 1 && place <= ByPlace.Length ? ByPlace[place - 1] : 0) + Participation;
    }

    /// <summary>One exchange line.</summary>
    public sealed class ExchangeLine
    {
        public string Id, Name;
        /// <summary>"coins" / "material" / "ticket" / "cosmetic" / "horse".</summary>
        public string Kind;
        public int Price, Stock, Bought, Remaining, MaxQty;
        public bool Owned, Affordable;
        /// <summary>Item art key (horse: collection portrait; coins: null = the client's coin icon).</summary>
        public string Icon;
        public int RewardFreeCoins;
        public List<ItemQty> RewardItems = new List<ItemQty>();
        public string RewardHorse;
        internal static ExchangeLine Parse(JsonNode o)
        {
            var r = J.Opt(o, "reward");
            return new ExchangeLine
            {
                Id = J.Str(o, "id"), Name = J.Str(o, "name"), Kind = J.Str(o, "kind"), Price = J.Int(o, "price"), Stock = J.Int(o, "stock"),
                Bought = J.Int(o, "bought"), Remaining = J.Int(o, "remaining"), MaxQty = J.Int(o, "maxQty"), Owned = J.Bool(o, "owned"), Affordable = J.Bool(o, "affordable"),
                Icon = J.Str(o, "icon"), RewardFreeCoins = J.Int(r, "freeCoins"), RewardItems = J.List(r, "items", ItemQty.Parse), RewardHorse = J.Str(r, "horse"),
            };
        }
    }

    /// <summary>GET /v1/events/:eventId/exchange.</summary>
    public sealed class ExchangeView
    {
        public string EventId, Name, Status;
        public long StartAtMs, EndAtMs, ClosesAtMs;
        public int GraceDays, Points, Earned, Spent;
        public ExchangeEarn Earn;
        public ExchangeLeftover Leftover;
        public List<ExchangeLine> Items = new List<ExchangeLine>();
        /// <summary>Always false / false / false: points are never sold, nothing is random, no reward for taking everything.</summary>
        public bool Purchasable, Random, CompletionReward;
        internal static ExchangeView Parse(JsonNode o)
        {
            var rules = J.Opt(o, "rules");
            return new ExchangeView
            {
                EventId = J.Str(o, "eventId"), Name = J.Str(o, "name"), Status = J.Str(o, "status"),
                StartAtMs = J.Long(o, "startAtMs"), EndAtMs = J.Long(o, "endAtMs"), ClosesAtMs = J.Long(o, "closesAtMs"), GraceDays = J.Int(o, "graceDays"),
                Points = J.Int(o, "points"), Earned = J.Int(o, "earned"), Spent = J.Int(o, "spent"),
                Earn = ExchangeEarn.Parse(J.Opt(o, "earn")), Leftover = ExchangeLeftover.Parse(J.Opt(o, "leftover")), Items = J.List(o, "items", ExchangeLine.Parse),
                Purchasable = J.Bool(rules, "purchasable"), Random = J.Bool(rules, "random"), CompletionReward = J.Bool(rules, "completionReward"),
            };
        }
        public ExchangeLine Find(string id) { foreach (var l in Items) if (l.Id == id) return l; return null; }
        /// <summary>Lines can be exchanged in "open" and "grace".</summary>
        public bool CanExchange => Status == "open" || Status == "grace";
    }

    /// <summary>POST /v1/events/:eventId/exchange.</summary>
    public sealed class ExchangeResult
    {
        public string EventId, ItemId, Kind;
        public int Qty, Spent, Points, Bought, Remaining;
        public int GrantedFreeCoins;
        public List<ItemQty> GrantedItems = new List<ItemQty>();
        public string GrantedHorse;
        public ExchangeView Exchange;
        public Wallet Wallet;
        internal static ExchangeResult Parse(JsonNode o)
        {
            var g = J.Opt(o, "granted");
            return new ExchangeResult
            {
                EventId = J.Str(o, "eventId"), ItemId = J.Str(o, "itemId"), Kind = J.Str(o, "kind"), Qty = J.Int(o, "qty"), Spent = J.Int(o, "spent"), Points = J.Int(o, "points"),
                Bought = J.Int(o, "bought"), Remaining = J.Int(o, "remaining"),
                GrantedFreeCoins = J.Int(g, "freeCoins"), GrantedItems = J.List(g, "items", ItemQty.Parse), GrantedHorse = J.Str(g, "horse"),
                Exchange = J.Opt(o, "exchange") == null ? null : ExchangeView.Parse(J.Opt(o, "exchange")), Wallet = Wallet.Parse(J.Opt(o, "wallet")),
            };
        }
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-EXCH-009: the event's exchange (lines, stock, my points, today's cap, close time, leftover preview). 404 if the event has none.</summary>
        public Task<ExchangeView> GetExchangeAsync(string eventId, CancellationToken ct = default)
            => Call("GET", "/v1/events/" + Seg(eventId) + "/exchange", null, true, null, true, ExchangeView.Parse, ct);

        /// <summary>
        /// REQ-EXCH-008: spend points on `qty` units of one line (keyed: keep the same key until a response arrives, so a retry never pays twice).
        /// ConflictException EXCHANGE_NOT_OPEN / EXCHANGE_CLOSED / OUT_OF_STOCK / INSUFFICIENT_POINTS / ALREADY_PURCHASED.
        /// </summary>
        public Task<ExchangeResult> ExchangeAsync(string eventId, string itemId, int qty = 1, string idempotencyKey = null, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("itemId", itemId);
            b.Set("qty", qty);
            return Call("POST", "/v1/events/" + Seg(eventId) + "/exchange", b, true, idempotencyKey ?? NewIdempotencyKey(), true, ExchangeResult.Parse, ct);
        }
    }
}
