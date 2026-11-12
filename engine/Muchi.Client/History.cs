using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-HIST-001..014: 購入履歴・コイン履歴・ガチャ履歴 (server/src/domain/history.ts, contracts/protocol.md §33).
    // Read-only lists over the server's records. Texts (Title, StatusText, …) are Japanese from the server, or English when
    // the request asked for it (Accept-Language). Rows are pointed at with Ref (P-/C-/G-), never with a store transaction id.

    /// <summary>GET /v1/history/summary: balances (paid / free apart) and this month's spend against the age band's limit.</summary>
    public sealed class HistorySummary
    {
        public int Paid, Free, Total, Debt;
        public string Month;
        public int MonthSpentYen;
        /// <summary>null: no limit (20 and over) or no age registered.</summary>
        public int? MonthlyLimitYen, RemainingYen;
        public bool AgeLimited;
        /// <summary>"今月の購入 ¥3,000 ／ 上限 ¥5,000（年齢に応じた月額上限）", or null when there is no limit.</summary>
        public string LimitText, Notice;
        public int PurchasesDays, CoinsDays, GachaDays;
        /// <summary>REQ-LIMIT-008 (§67.3): the player's own limit next to the age cap (null = none set); SelfLimitText is shown under LimitText.</summary>
        public int? SelfLimitYen, EffectiveLimitYen, SelfRemainingYen;
        public SelfLimitPending SelfLimitPending;
        public string SelfLimitText;
        internal static HistorySummary Parse(JsonNode o)
        {
            var w = J.Opt(o, "wallet");
            var win = J.Opt(o, "windows");
            return new HistorySummary
            {
                Paid = J.Int(w, "paid"), Free = J.Int(w, "free"), Total = J.Int(w, "total"), Debt = J.Int(w, "debt"),
                Month = J.Str(o, "month"), MonthSpentYen = J.Int(o, "monthSpentYen"), MonthlyLimitYen = J.IntN(o, "monthlyLimitYen"), RemainingYen = J.IntN(o, "remainingYen"),
                AgeLimited = J.Bool(o, "ageLimited"), LimitText = J.Str(o, "limitText"), Notice = J.Str(o, "notice"),
                PurchasesDays = J.Int(win, "purchasesDays"), CoinsDays = J.Int(win, "coinsDays"), GachaDays = J.Int(win, "gachaDays"),
                SelfLimitYen = J.IntN(o, "selfLimitYen"), EffectiveLimitYen = J.IntN(o, "effectiveLimitYen"), SelfRemainingYen = J.IntN(o, "selfRemainingYen"),
                SelfLimitPending = SelfLimitPending.Parse(J.Opt(o, "selfLimitPending")), SelfLimitText = J.Str(o, "selfLimitText"),
            };
        }
    }

    /// <summary>One purchase. Status: completed | refunded | pending | test.</summary>
    public sealed class PurchaseHistoryRow
    {
        public string Ref, Product, ProductId, Store, StoreName, Status, StatusText;
        public long At;
        public int PriceYen, PaidCoins, BonusCoins;
        public bool BonusPaid;
        public bool Refunded => Status == "refunded";
        internal static PurchaseHistoryRow Parse(JsonNode o) => new PurchaseHistoryRow
        {
            Ref = J.Str(o, "ref"), At = J.Long(o, "at"), Product = J.Str(o, "product"), ProductId = J.Str(o, "productId"), PriceYen = J.Int(o, "priceYen"),
            Store = J.Str(o, "store"), StoreName = J.Str(o, "storeName"), Status = J.Str(o, "status"), StatusText = J.Str(o, "statusText"),
            PaidCoins = J.Int(o, "paidCoins"), BonusCoins = J.Int(o, "bonusCoins"), BonusPaid = J.Bool(o, "bonusPaid"),
        };
    }

    /// <summary>One coin movement. Currency: paid | free. Direction: earned | spent | note (no coins moved).</summary>
    public sealed class CoinHistoryRow
    {
        public string Ref, Currency, Direction, Category, Title, PurchaseRef;
        public long At;
        public int Amount, BalanceAfter;
        /// <summary>+Amount for earned, −Amount for spent, 0 for a note.</summary>
        public int Delta => Direction == "earned" ? Amount : Direction == "spent" ? -Amount : 0;
        internal static CoinHistoryRow Parse(JsonNode o) => new CoinHistoryRow
        {
            Ref = J.Str(o, "ref"), At = J.Long(o, "at"), Currency = J.Str(o, "currency"), Direction = J.Str(o, "direction"), Amount = J.Int(o, "amount"),
            BalanceAfter = J.Int(o, "balanceAfter"), Category = J.Str(o, "category"), Title = J.Str(o, "title"), PurchaseRef = J.Str(o, "purchaseRef"),
        };
    }

    public sealed class GachaHistoryResult
    {
        public string TemplateId, Name, Rarity;
        public bool Duplicate;
        internal static GachaHistoryResult Parse(JsonNode o) => new GachaHistoryResult { TemplateId = J.Str(o, "templateId"), Name = J.Str(o, "name"), Rarity = J.Str(o, "rarity"), Duplicate = J.Bool(o, "duplicate") };
    }

    /// <summary>One draw. Via: coins | ticket | tutorial. BannerId null = a ticket not tied to a banner (SR+ ticket).</summary>
    public sealed class GachaHistoryRow
    {
        public string Ref, Banner, BannerId, Via, ViaText, Summary;
        public long At;
        public int Count, PaidCoins, FreeCoins;
        public List<GachaHistoryResult> Results = new List<GachaHistoryResult>();
        internal static GachaHistoryRow Parse(JsonNode o)
        {
            var c = J.Opt(o, "coins");
            return new GachaHistoryRow
            {
                Ref = J.Str(o, "ref"), At = J.Long(o, "at"), Banner = J.Str(o, "banner"), BannerId = J.Str(o, "bannerId"), Via = J.Str(o, "via"), ViaText = J.Str(o, "viaText"),
                Count = J.Int(o, "count"), PaidCoins = J.Int(c, "paid"), FreeCoins = J.Int(c, "free"), Results = J.List(o, "results", GachaHistoryResult.Parse), Summary = J.Str(o, "summary"),
            };
        }
    }

    /// <summary>A page of a history list (newest first). Pass NextCursor back as is; null = the end.</summary>
    public sealed class HistoryPage<T>
    {
        public List<T> Items = new List<T>();
        public string NextCursor;
        public int WindowDays;
        /// <summary>Purchases only: where a purchase the store still holds as pending shows up.</summary>
        public string Note;
        public bool HasMore => NextCursor != null;
        internal static HistoryPage<T> Parse(JsonNode o, Func<JsonNode, T> row) => new HistoryPage<T>
        {
            Items = J.List(o, "items", row), NextCursor = J.Str(o, "nextCursor"), WindowDays = J.Int(o, "windowDays"), Note = J.Str(o, "note"),
        };
    }

    public sealed class SupportTicketItem
    {
        public string Ref, Kind, Title, Detail;
        public long At;
        internal static SupportTicketItem Parse(JsonNode o) => new SupportTicketItem { Ref = J.Str(o, "ref"), Kind = J.Str(o, "kind"), At = J.Long(o, "at"), Title = J.Str(o, "title"), Detail = J.Str(o, "detail") };
    }

    /// <summary>
    /// POST /v1/history/support-ticket: the 問い合わせ draft (player id + the selected references only). Attach <see cref="Body"/>
    /// (or the whole <see cref="Raw"/> JSON) to the operator's contact form; nothing is stored on the server.
    /// </summary>
    public sealed class SupportTicket
    {
        public string Format, PlayerId, Topic, TopicText, Body, Raw;
        public long CreatedAt;
        public List<SupportTicketItem> Items = new List<SupportTicketItem>();
        internal static SupportTicket Parse(JsonNode o) => new SupportTicket
        {
            Format = J.Str(o, "format"), PlayerId = J.Str(o, "playerId"), Topic = J.Str(o, "topic"), TopicText = J.Str(o, "topicText"), CreatedAt = J.Long(o, "createdAt"),
            Items = J.List(o, "items", SupportTicketItem.Parse), Body = J.Str(o, "body"), Raw = o?.ToString(),
        };
    }

    public static class SupportTopics
    {
        public const string PurchaseMissing = "purchase_missing", Refund = "refund", Coins = "coins", Gacha = "gacha", Other = "other";
        public static readonly string[] All = { PurchaseMissing, Refund, Coins, Gacha, Other };
    }

    public sealed partial class ApiClient
    {
        public const int HistoryPageMax = 50, SupportTicketRefsMax = 10;

        private static string HistoryQuery(string cursor, int limit, string currency)
        {
            if (limit < 1 || limit > HistoryPageMax) throw new ArgumentOutOfRangeException(nameof(limit), "1.." + HistoryPageMax);
            var q = "?limit=" + limit;
            if (currency != null) q += "&currency=" + Uri.EscapeDataString(currency);
            if (!string.IsNullOrEmpty(cursor)) q += "&cursor=" + Uri.EscapeDataString(cursor);
            return q;
        }

        /// <summary>REQ-HIST-001: balances (paid / free apart) and this month's spend against the age band's limit.</summary>
        public Task<HistorySummary> GetHistorySummaryAsync(CancellationToken ct = default)
            => Call("GET", "/v1/history/summary", null, true, null, true, HistorySummary.Parse, ct);

        /// <summary>REQ-HIST-002: purchases in the legal retention period, newest first.</summary>
        public Task<HistoryPage<PurchaseHistoryRow>> GetPurchaseHistoryAsync(string cursor = null, int limit = 20, CancellationToken ct = default)
            => Call("GET", "/v1/history/purchases" + HistoryQuery(cursor, limit, null), null, true, null, true, o => HistoryPage<PurchaseHistoryRow>.Parse(o, PurchaseHistoryRow.Parse), ct);

        /// <summary>REQ-HIST-003: coin movements of the last 365 days for one currency ("paid" | "free"), newest first.</summary>
        public Task<HistoryPage<CoinHistoryRow>> GetCoinHistoryAsync(string currency, string cursor = null, int limit = 20, CancellationToken ct = default)
        {
            if (currency != "paid" && currency != "free") throw new ArgumentException("currency must be paid or free", nameof(currency));
            return Call("GET", "/v1/history/coins" + HistoryQuery(cursor, limit, currency), null, true, null, true, o => HistoryPage<CoinHistoryRow>.Parse(o, CoinHistoryRow.Parse), ct);
        }

        /// <summary>REQ-HIST-004: draws of the last 90 days, newest first.</summary>
        public Task<HistoryPage<GachaHistoryRow>> GetGachaHistoryAsync(string cursor = null, int limit = 20, CancellationToken ct = default)
            => Call("GET", "/v1/history/gacha" + HistoryQuery(cursor, limit, null), null, true, null, true, o => HistoryPage<GachaHistoryRow>.Parse(o, GachaHistoryRow.Parse), ct);

        /// <summary>
        /// REQ-HIST-009: the 問い合わせ draft for 1..10 selected rows (their Ref). Read-only on the server, so it is safe to retry.
        /// NotFoundException when a reference is outside the windows.
        /// </summary>
        public Task<SupportTicket> CreateSupportTicketAsync(IReadOnlyList<string> refs, string topic, CancellationToken ct = default)
        {
            if (refs == null || refs.Count < 1 || refs.Count > SupportTicketRefsMax) throw new ArgumentException("1.." + SupportTicketRefsMax + " references", nameof(refs));
            if (Array.IndexOf(SupportTopics.All, topic) < 0) throw new ArgumentException("unknown topic " + topic, nameof(topic));
            var a = JsonNode.Arr();
            var seen = new HashSet<string>();
            foreach (var r in refs) { if (!seen.Add(r)) throw new ArgumentException("duplicate reference " + r, nameof(refs)); a.Add(JsonNode.Str(r)); }
            var b = JsonNode.Obj();
            b.Set("refs", a);
            b.Set("topic", topic);
            return Call("POST", "/v1/history/support-ticket", b, true, null, true, SupportTicket.Parse, ct);
        }
    }
}
