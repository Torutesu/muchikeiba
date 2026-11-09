// 購入履歴・コイン履歴・ガチャ履歴 (REQ-HIST-001..014, contracts/protocol.md §33): HistoryModel over a fake API. The header keeps
// 有償 / 無償 apart, tabs page with the server's cursor (one load at a time, a late page of an old tab is dropped), the
// detail lines, the 問い合わせ selection (max 10, only listed rows) and draft, history_view once per tab, offline text.
using Muchi.Client;
using Muchi.Game;

static class HistoryChecks
{
    sealed class FakeApi : IHistoryApi
    {
        public readonly List<string> Calls = new List<string>();
        public TaskCompletionSource<bool> Gate;
        public List<string> LastRefs;
        public Task<HistorySummary> GetHistorySummaryAsync(CancellationToken ct = default)
        {
            Calls.Add("summary");
            return Task.FromResult(new HistorySummary { Paid = 1200, Free = 340, Total = 1540, Month = "2026-11", MonthSpentYen = 3000, MonthlyLimitYen = 5000, RemainingYen = 2000, AgeLimited = true, LimitText = "今月の購入 ¥3,000 ／ 上限 ¥5,000（年齢に応じた月額上限）" });
        }
        public Task<HistoryPage<PurchaseHistoryRow>> GetPurchaseHistoryAsync(string cursor = null, int limit = 20, CancellationToken ct = default)
        {
            Calls.Add("purchases:" + (cursor ?? "-"));
            var page = new HistoryPage<PurchaseHistoryRow> { Note = "ストアで保留中の購入は、支払いが終わるとここに表示されます。", NextCursor = cursor == null ? "next1" : null };
            page.Items.Add(new PurchaseHistoryRow { Ref = cursor == null ? "P-00000001" : "P-00000002", At = 1794193200000, Product = "コイン1,020", PriceYen = 1500, StoreName = "App Store", Status = cursor == null ? "completed" : "refunded", StatusText = cursor == null ? "購入済み" : "返金済み", PaidCoins = 1020, BonusCoins = 1020 });
            return Task.FromResult(page);
        }
        public async Task<HistoryPage<CoinHistoryRow>> GetCoinHistoryAsync(string currency, string cursor = null, int limit = 20, CancellationToken ct = default)
        {
            Calls.Add("coins:" + currency + ":" + (cursor ?? "-"));
            if (Gate != null) await Gate.Task;
            var page = new HistoryPage<CoinHistoryRow>();
            page.Items.Add(new CoinHistoryRow { Ref = "C-3", At = 1794193200000, Currency = currency, Direction = "spent", Amount = 1000, BalanceAfter = 20, Category = "gacha", Title = "スカウト10回（恒常ガチャ）" });
            return page;
        }
        public Task<HistoryPage<GachaHistoryRow>> GetGachaHistoryAsync(string cursor = null, int limit = 20, CancellationToken ct = default)
        {
            Calls.Add("gacha");
            var g = new GachaHistoryRow { Ref = "G-1", At = 1794193200000, Banner = "恒常ガチャ", Via = "coins", ViaText = "コイン", Count = 10, PaidCoins = 1000, Summary = "SR 1・R 9" };
            g.Results.Add(new GachaHistoryResult { TemplateId = "t_inazuma", Name = "イナズマランナー", Rarity = "SR" });
            var page = new HistoryPage<GachaHistoryRow>();
            page.Items.Add(g);
            return Task.FromResult(page);
        }
        public Task<SupportTicket> CreateSupportTicketAsync(IReadOnlyList<string> refs, string topic, CancellationToken ct = default)
        {
            LastRefs = refs.ToList();
            return Task.FromResult(new SupportTicket { Format = "muchi.support-ticket.v1", PlayerId = "u1", Topic = topic, Body = "問い合わせ番号：" + string.Join(" / ", refs) });
        }
    }

    public static async Task Run(Action<bool, string> check)
    {
        var api = new FakeApi();
        var views = new List<string>();
        HistoryModel m = null;
        m = new HistoryModel(api, () => true, e => views.Add(e.Name + ":" + HistoryModel.TabWire(m.Tab)), () => 1);
        await m.OpenAsync();
        check(m.PaidText == "有償 1,200" && m.FreeText == "無償 340", "header: 有償 and 無償 apart (" + m.PaidText + " / " + m.FreeText + ")");
        check(m.LimitText != null && Math.Abs(m.LimitProgress - 0.6f) < 0.001f, "header: this month against the age band limit (60%)");
        check(m.Lines.Count == 1 && m.Lines[0].Amount == "¥1,500" && m.Lines[0].Sub == "App Store・購入済み" && m.HasMore && m.Note != null, "purchases: price, store and status; more pages; the pending note");
        await m.MoreAsync();
        check(m.Lines.Count == 2 && !m.HasMore && m.Lines[1].Muted && api.Calls.Contains("purchases:next1"), "more: the server cursor as is; a refunded purchase is muted; the end");
        await m.MoreAsync();
        check(api.Calls.Count(c => c.StartsWith("purchases")) == 2, "no request past the end");

        await m.SelectTabAsync(HistoryTab.PaidCoins);
        check(m.Lines.Count == 1 && m.Lines[0].Amount == "−1,000" && m.Lines[0].Negative && m.Lines[0].Sub == "残高 20" && api.Calls.Contains("coins:paid:-"), "paid coins tab: spent with a sign and the balance after");
        await m.SelectTabAsync(HistoryTab.FreeCoins);
        check(api.Calls.Contains("coins:free:-"), "free coins tab asks for free coins only");
        await m.SelectTabAsync(HistoryTab.Gacha);
        check(m.Lines[0].Amount == "10連" && HistoryModel.CountText(1) == "単発" && m.Lines[0].Sub == "SR 1・R 9・有償 1,000・無償 0", "gacha tab: count, rarity summary, coins used paid / free");
        m.ShowDetail("G-1");
        var d = m.DetailLines();
        check(d.Contains("問い合わせ番号 G-1") && d.Contains("SR　イナズマランナー"), "detail: the reference and what was drawn");
        check(views.Count == 4 && views[0].Contains("purchases") && views[1].Contains("coins_paid") && views[3].Contains("gacha"), "history_view once per tab opening (" + views.Count + ")");

        // one load at a time; a page that lands after the player switched tabs is dropped
        api.Gate = new TaskCompletionSource<bool>();
        var slow = m.SelectTabAsync(HistoryTab.PaidCoins);
        await m.SelectTabAsync(HistoryTab.Gacha); // ignored while loading
        check(m.Tab == HistoryTab.PaidCoins && m.Loading, "a second tab tap while loading is ignored");
        api.Gate.SetResult(true); await slow; api.Gate = null;
        check(!m.Loading && m.Lines.Count == 1, "the slow page lands once");

        // 問い合わせ: only listed rows, at most 10, the draft carries references only
        check(!m.ToggleSelect("P-99999999"), "a reference not on screen cannot be selected");
        check(m.ToggleSelect("C-3") && m.Selected.Count == 1, "select a row");
        var r = await m.CreateTicketAsync(SupportTopics.Coins);
        check(r.Ok && api.LastRefs.SequenceEqual(new[] { "C-3" }) && m.Ticket.Body.Contains("C-3"), "the draft is built from the selected references");
        check(HistoryModel.SupportNote.Contains("問い合わせ番号だけ"), "the sheet says only reference numbers are sent");
        var none = new HistoryModel(api, () => true);
        check(!(await none.CreateTicketAsync(SupportTopics.Other)).Ok, "nothing selected: no request");

        var off = new HistoryModel(api, () => false);
        await off.OpenAsync();
        check(off.Message == HistoryModel.OfflineText && off.Lines.Count == 0 && off.Summary == null, "offline: the online-only message, no list");
        check(HistoryModel.When(1794193200000) == "2026/11/09 12:00", "times in JST");
    }
}
