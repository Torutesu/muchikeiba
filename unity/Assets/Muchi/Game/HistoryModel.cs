using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-HIST-001..014 (contracts/protocol.md §33, docs/handoff-codex-round13-history.md): 購入履歴・コイン履歴・ガチャ履歴,
    // the game layer. Pure C#: Codex's screen binds to the public fields. Read-only — nothing here spends or grants.

    /// <summary>The server calls the history screen needs (ApiClient in the app, a fake in the checks).</summary>
    public interface IHistoryApi
    {
        Task<HistorySummary> GetHistorySummaryAsync(CancellationToken ct = default);
        Task<HistoryPage<PurchaseHistoryRow>> GetPurchaseHistoryAsync(string cursor = null, int limit = 20, CancellationToken ct = default);
        Task<HistoryPage<CoinHistoryRow>> GetCoinHistoryAsync(string currency, string cursor = null, int limit = 20, CancellationToken ct = default);
        Task<HistoryPage<GachaHistoryRow>> GetGachaHistoryAsync(string cursor = null, int limit = 20, CancellationToken ct = default);
        Task<SupportTicket> CreateSupportTicketAsync(IReadOnlyList<string> refs, string topic, CancellationToken ct = default);
    }

    /// <summary><see cref="IHistoryApi"/> over the real client.</summary>
    public sealed class ApiHistory : IHistoryApi
    {
        private readonly ApiClient _api;
        public ApiHistory(ApiClient api) { _api = api ?? throw new ArgumentNullException(nameof(api)); }
        public Task<HistorySummary> GetHistorySummaryAsync(CancellationToken ct = default) => _api.GetHistorySummaryAsync(ct);
        public Task<HistoryPage<PurchaseHistoryRow>> GetPurchaseHistoryAsync(string cursor = null, int limit = 20, CancellationToken ct = default) => _api.GetPurchaseHistoryAsync(cursor, limit, ct);
        public Task<HistoryPage<CoinHistoryRow>> GetCoinHistoryAsync(string currency, string cursor = null, int limit = 20, CancellationToken ct = default) => _api.GetCoinHistoryAsync(currency, cursor, limit, ct);
        public Task<HistoryPage<GachaHistoryRow>> GetGachaHistoryAsync(string cursor = null, int limit = 20, CancellationToken ct = default) => _api.GetGachaHistoryAsync(cursor, limit, ct);
        public Task<SupportTicket> CreateSupportTicketAsync(IReadOnlyList<string> refs, string topic, CancellationToken ct = default) => _api.CreateSupportTicketAsync(refs, topic, ct);
    }

    public enum HistoryTab { Purchases, PaidCoins, FreeCoins, Gacha }

    /// <summary>One list row as the screen draws it (any tab). All texts Japanese — show <c>Loc.T(row.X)</c>.</summary>
    public sealed class HistoryLine
    {
        public string Ref;
        public long At;
        /// <summary>"2026/11/09 12:00" (JST).</summary>
        public string When;
        public string Title;
        /// <summary>Right column: "¥480" / "+310" / "−1,000" / "10連".</summary>
        public string Amount;
        /// <summary>Second line: store and status / balance after / the rarity summary.</summary>
        public string Sub;
        /// <summary>refunded / pending / spent: the screen tints the amount.</summary>
        public bool Muted, Negative;
        public object Source;
    }

    /// <summary>
    /// The history screen (設定 → 履歴): a balance header with 有償 / 無償 apart, four tabs, "more" paging, a detail row and
    /// the 問い合わせ sheet. Rules the model keeps:
    ///  - paid and free coins are separate tabs; the header never shows a single merged balance only (資金決済法);
    ///  - one load per tab at a time (a second tap while loading is ignored), and "more" uses the server's cursor as is;
    ///  - the support sheet sends at most 10 selected references and nothing else; the draft comes back for the contact form;
    ///  - every tab opening sends history_view once (KPI);
    ///  - offline: no list, the message <see cref="OfflineText"/>.
    /// </summary>
    public sealed class HistoryModel
    {
        public const int PageSize = 20;
        public const string OfflineText = "履歴はオンラインで確認できます";
        public const string EmptyText = "まだ記録がありません";
        public const string SupportNote = "選んだ記録の問い合わせ番号だけを送ります（お名前や連絡先は含みません）。";
        public static readonly IReadOnlyDictionary<HistoryTab, string> TabNames = new Dictionary<HistoryTab, string>
        {
            [HistoryTab.Purchases] = "購入履歴", [HistoryTab.PaidCoins] = "有償コイン", [HistoryTab.FreeCoins] = "無償コイン", [HistoryTab.Gacha] = "ガチャ履歴",
        };
        public static readonly IReadOnlyDictionary<string, string> TopicNames = new Dictionary<string, string>
        {
            [SupportTopics.PurchaseMissing] = "購入したのに届かない", [SupportTopics.Refund] = "返金について", [SupportTopics.Coins] = "コインの増減について",
            [SupportTopics.Gacha] = "スカウトの結果について", [SupportTopics.Other] = "その他の問い合わせ",
        };

        private readonly IHistoryApi _api;
        private readonly Func<bool> _online;
        private readonly Action<AnalyticsEvent> _track;
        private readonly Func<long> _clock;

        public HistoryModel(IHistoryApi api, Func<bool> online = null, Action<AnalyticsEvent> track = null, Func<long> clock = null)
        {
            _api = api;
            _online = online ?? (() => true);
            _track = track;
            _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        public HistorySummary Summary { get; private set; }
        public HistoryTab Tab { get; private set; } = HistoryTab.Purchases;
        public List<HistoryLine> Lines { get; } = new List<HistoryLine>();
        public string NextCursor { get; private set; }
        public bool HasMore => NextCursor != null;
        public bool Loading { get; private set; }
        public string Message { get; private set; }
        /// <summary>Purchases tab: where a purchase the store still holds as pending shows up.</summary>
        public string Note { get; private set; }
        public HistoryLine Detail { get; private set; }
        public List<string> Selected { get; } = new List<string>();
        public SupportTicket Ticket { get; private set; }

        /// <summary>"有償 1,200" / "無償 340" for the header (never one merged number only).</summary>
        public string PaidText => Summary == null ? null : "有償 " + N(Summary.Paid);
        public string FreeText => Summary == null ? null : "無償 " + N(Summary.Free);
        /// <summary>"今月の購入 ¥3,000 ／ 上限 ¥5,000…" for age bands with a limit, else null.</summary>
        public string LimitText => Summary?.LimitText;
        public float LimitProgress => Summary?.MonthlyLimitYen is int lim && lim > 0 ? Math.Min(1f, Summary.MonthSpentYen / (float)lim) : 0f;

        private static string N(int v) => v.ToString("N0", CultureInfo.InvariantCulture);
        private static string Signed(int v) => v > 0 ? "+" + N(v) : v < 0 ? "−" + N(-v) : "±0";
        public static string When(long at) => DateTimeOffset.FromUnixTimeMilliseconds(at).ToOffset(TimeSpan.FromHours(9)).ToString("yyyy/MM/dd HH:mm", CultureInfo.InvariantCulture);

        public static string TabWire(HistoryTab t) => t == HistoryTab.Purchases ? "purchases" : t == HistoryTab.PaidCoins ? "coins_paid" : t == HistoryTab.FreeCoins ? "coins_free" : "gacha";

        /// <summary>Opens the screen: the header, then <paramref name="tab"/>.</summary>
        public async Task OpenAsync(HistoryTab tab = HistoryTab.Purchases, CancellationToken ct = default)
        {
            Summary = null;
            if (!_online() || _api == null) { Message = OfflineText; Lines.Clear(); NextCursor = null; return; }
            try { Summary = await _api.GetHistorySummaryAsync(ct); }
            catch (ApiException e) { Message = UxText.For(e); }
            await SelectTabAsync(tab, ct);
        }

        /// <summary>Switches tab (first page). history_view is sent once per opening of a tab.</summary>
        public async Task SelectTabAsync(HistoryTab tab, CancellationToken ct = default)
        {
            if (Loading) return;
            Tab = tab; Lines.Clear(); NextCursor = null; Detail = null; Note = null; Message = null;
            if (!_online() || _api == null) { Message = OfflineText; return; }
            _track?.Invoke(AnalyticsEvent.HistoryView(_clock(), TabWire(tab)));
            await LoadPageAsync(null, ct);
        }

        /// <summary>The next page of the current tab (ignored while loading or at the end).</summary>
        public Task MoreAsync(CancellationToken ct = default) => Loading || NextCursor == null ? Task.CompletedTask : LoadPageAsync(NextCursor, ct);

        private async Task LoadPageAsync(string cursor, CancellationToken ct)
        {
            Loading = true;
            var tab = Tab;
            try
            {
                List<HistoryLine> rows; string next;
                switch (tab)
                {
                    case HistoryTab.Purchases:
                        var p = await _api.GetPurchaseHistoryAsync(cursor, PageSize, ct);
                        rows = p.Items.Select(PurchaseLine).ToList(); next = p.NextCursor; Note = p.Note; break;
                    case HistoryTab.Gacha:
                        var g = await _api.GetGachaHistoryAsync(cursor, PageSize, ct);
                        rows = g.Items.Select(GachaLine).ToList(); next = g.NextCursor; break;
                    default:
                        var c = await _api.GetCoinHistoryAsync(tab == HistoryTab.PaidCoins ? "paid" : "free", cursor, PageSize, ct);
                        rows = c.Items.Select(CoinLine).ToList(); next = c.NextCursor; break;
                }
                if (tab != Tab) return; // the player switched tab meanwhile
                Lines.AddRange(rows);
                NextCursor = next;
                if (Lines.Count == 0) Message = EmptyText;
            }
            catch (ApiException e) { Message = UxText.For(e); }
            finally { Loading = false; }
        }

        public static HistoryLine PurchaseLine(PurchaseHistoryRow r) => new HistoryLine
        {
            Ref = r.Ref, At = r.At, When = When(r.At), Title = r.Product, Amount = "¥" + N(r.PriceYen), Sub = r.StoreName + "・" + r.StatusText,
            Muted = r.Status == "refunded" || r.Status == "test", Source = r,
        };
        public static HistoryLine CoinLine(CoinHistoryRow r) => new HistoryLine
        {
            Ref = r.Ref, At = r.At, When = When(r.At), Title = r.Title, Amount = Signed(r.Delta), Sub = "残高 " + N(r.BalanceAfter),
            Negative = r.Delta < 0, Muted = r.Direction == "note", Source = r,
        };
        public static HistoryLine GachaLine(GachaHistoryRow r) => new HistoryLine
        {
            Ref = r.Ref, At = r.At, When = When(r.At), Title = r.Banner, Amount = CountText(r.Count),
            Sub = r.Summary + "・" + (r.Via == "coins" ? "有償 " + N(r.PaidCoins) + "・無償 " + N(r.FreeCoins) : r.ViaText), Source = r,
        };

        /// <summary>"単発" for one scout, "10連" for ten.</summary>
        public static string CountText(int n) => n == 1 ? "単発" : n.ToString(CultureInfo.InvariantCulture) + "連";

        /// <summary>The detail row (tap on a line).</summary>
        public void ShowDetail(string reference) => Detail = Lines.FirstOrDefault(l => l.Ref == reference);
        public void CloseDetail() => Detail = null;

        /// <summary>Detail lines for the selected row ("問い合わせ番号 P-…", what was drawn, …).</summary>
        public IReadOnlyList<string> DetailLines()
        {
            var d = Detail;
            if (d == null) return Array.Empty<string>();
            var o = new List<string> { d.When, "問い合わせ番号 " + d.Ref };
            if (d.Source is PurchaseHistoryRow p)
            {
                o.Add(p.StoreName + "・" + p.StatusText);
                if (p.PaidCoins > 0) o.Add("有償コイン" + N(p.PaidCoins) + "枚");
                if (p.BonusCoins > 0) o.Add((p.BonusPaid ? "有償コイン" : "無償コイン") + N(p.BonusCoins) + "枚");
            }
            else if (d.Source is CoinHistoryRow c) o.Add((c.Currency == "paid" ? "有償コイン" : "無償コイン") + N(c.Amount) + "枚");
            else if (d.Source is GachaHistoryRow g) foreach (var x in g.Results) o.Add(x.Rarity + "　" + x.Name);
            return o;
        }

        /// <summary>Selects / unselects a row for the 問い合わせ sheet (at most <see cref="ApiClient.SupportTicketRefsMax"/>).</summary>
        public bool ToggleSelect(string reference)
        {
            if (Selected.Remove(reference)) return true;
            if (Selected.Count >= ApiClient.SupportTicketRefsMax || Lines.All(l => l.Ref != reference)) return false;
            Selected.Add(reference);
            return true;
        }

        /// <summary>Builds the 問い合わせ draft for the selected rows (the server checks they are this player's).</summary>
        public async Task<ActionResult> CreateTicketAsync(string topic, CancellationToken ct = default)
        {
            if (Selected.Count == 0) return ActionResult.Error("記録を選んでください");
            if (!_online() || _api == null) return ActionResult.Error(OfflineText);
            try
            {
                Ticket = await _api.CreateSupportTicketAsync(Selected.ToList(), topic, ct);
                return ActionResult.Success("問い合わせの下書きを作りました");
            }
            catch (ApiException e) { return ActionResult.Error(UxText.For(e)); }
        }
    }
}
