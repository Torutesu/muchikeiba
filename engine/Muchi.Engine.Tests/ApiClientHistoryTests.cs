using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-HIST-001..014: /v1/history client methods and models (contracts/protocol.md §33).</summary>
    public class ApiClientHistoryTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientHistoryTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        // produced by the real server (PlayerService.history / historyTicket): a 14-year-old buys コイン1,020 and scouts 10
        internal const string Summary = "{\"wallet\":{\"paid\":20,\"free\":1020,\"total\":1040,\"debt\":0},\"month\":\"2026-11\",\"monthSpentYen\":1500,\"monthlyLimitYen\":5000,\"remainingYen\":3500,\"ageLimited\":true,\"limitText\":\"今月の購入 ¥1,500 ／ 上限 ¥5,000（年齢に応じた月額上限）\",\"notice\":\"有償コインに有効期限はありません。使うときは有償コインから先に使われます。無償コインはゲーム内で受け取ったコインです。\",\"windows\":{\"purchasesDays\":2557,\"coinsDays\":365,\"gachaDays\":90}}";
        internal const string Purchases = "{\"items\":[{\"ref\":\"P-4976B071\",\"at\":1794193200000,\"product\":\"コイン1,020\",\"productId\":\"coin_1500\",\"priceYen\":1500,\"store\":\"fake\",\"storeName\":\"テスト\",\"status\":\"completed\",\"statusText\":\"購入済み\",\"paidCoins\":1020,\"bonusCoins\":1020,\"bonusPaid\":false}],\"nextCursor\":null,\"windowDays\":2557,\"note\":\"ストアで保留中の購入は、支払いが終わるとここに表示されます。\"}";
        internal const string Coins = "{\"items\":[{\"ref\":\"C-3\",\"at\":1794193200000,\"currency\":\"paid\",\"direction\":\"spent\",\"amount\":1000,\"balanceAfter\":20,\"category\":\"gacha\",\"title\":\"スカウト10回（恒常ガチャ）\"}],\"currency\":\"paid\",\"nextCursor\":\"aDE6Y29pbnM6Mw\",\"windowDays\":365}";
        internal const string Gacha = "{\"items\":[{\"ref\":\"G-1\",\"at\":1794193200000,\"banner\":\"恒常ガチャ\",\"bannerId\":\"standard\",\"via\":\"coins\",\"viaText\":\"コイン\",\"count\":10,\"coins\":{\"paid\":1000,\"free\":0},\"results\":[{\"templateId\":\"t_morino\",\"name\":\"モリノシズク\",\"rarity\":\"R\",\"duplicate\":false},{\"templateId\":\"t_akanegumo\",\"name\":\"アカネグモ\",\"rarity\":\"R\",\"duplicate\":false},{\"templateId\":\"t_hoshifuru\",\"name\":\"ホシフルオカ\",\"rarity\":\"R\",\"duplicate\":false},{\"templateId\":\"t_yukimi\",\"name\":\"ユキミザクラ\",\"rarity\":\"R\",\"duplicate\":false},{\"templateId\":\"t_akanegumo\",\"name\":\"アカネグモ\",\"rarity\":\"R\",\"duplicate\":true},{\"templateId\":\"t_natsu\",\"name\":\"ナツノアラシ\",\"rarity\":\"R\",\"duplicate\":false},{\"templateId\":\"t_yuyake\",\"name\":\"ユウヤケボシ\",\"rarity\":\"R\",\"duplicate\":false},{\"templateId\":\"t_natsu\",\"name\":\"ナツノアラシ\",\"rarity\":\"R\",\"duplicate\":true},{\"templateId\":\"t_natsu\",\"name\":\"ナツノアラシ\",\"rarity\":\"R\",\"duplicate\":true},{\"templateId\":\"t_inazuma\",\"name\":\"イナズマランナー\",\"rarity\":\"SR\",\"duplicate\":false}],\"summary\":\"SR 1・R 9\"}],\"nextCursor\":null,\"windowDays\":90}";
        internal const string Ticket = "{\"format\":\"muchi.support-ticket.v1\",\"playerId\":\"u1\",\"topic\":\"purchase_missing\",\"topicText\":\"購入したのに届かない\",\"createdAt\":1794193200000,\"items\":[{\"ref\":\"P-4976B071\",\"kind\":\"purchase\",\"at\":1794193200000,\"title\":\"コイン1,020\",\"detail\":\"¥1,500・テスト・購入済み\"},{\"ref\":\"C-3\",\"kind\":\"coin\",\"at\":1794193200000,\"title\":\"スカウト10回（恒常ガチャ）\",\"detail\":\"有償コイン1,000枚・使用\"}],\"body\":\"問い合わせ番号：P-4976B071 / C-3\"}";

        [Fact]
        public async Task SummaryKeepsPaidAndFreeApartAndTheAgeLimit()
        {
            _http.Reply(200, Summary);
            var s = await _api.GetHistorySummaryAsync();
            Assert.Equal("/v1/history/summary", _http.Requests[0].Path);
            Assert.Equal(20, s.Paid);
            Assert.Equal(1020, s.Free);
            Assert.Equal(1040, s.Total);
            Assert.True(s.AgeLimited);
            Assert.Equal(5000, s.MonthlyLimitYen);
            Assert.Equal(3500, s.RemainingYen);
            Assert.Equal(1500, s.MonthSpentYen);
            Assert.StartsWith("今月の購入", s.LimitText);
            Assert.Equal(90, s.GachaDays);
            Assert.Equal(365, s.CoinsDays);
        }

        [Fact]
        public async Task ListsParseAndPageWithTheCursor()
        {
            _http.Reply(200, Purchases).Reply(200, Coins).Reply(200, Gacha);
            var p = await _api.GetPurchaseHistoryAsync();
            Assert.Equal("/v1/history/purchases?limit=20", _http.Requests[0].Path);
            Assert.Equal("P-4976B071", p.Items[0].Ref);
            Assert.Equal("completed", p.Items[0].Status);
            Assert.Equal(1500, p.Items[0].PriceYen);
            Assert.False(p.Items[0].Refunded);
            Assert.False(p.HasMore);
            Assert.NotNull(p.Note);
            var c = await _api.GetCoinHistoryAsync("paid", null, 1);
            Assert.Equal("/v1/history/coins?limit=1&currency=paid", _http.Requests[1].Path);
            Assert.Equal(-1000, c.Items[0].Delta);
            Assert.Equal("gacha", c.Items[0].Category);
            Assert.True(c.HasMore);
            var g = await _api.GetGachaHistoryAsync();
            Assert.Equal(10, g.Items[0].Results.Count);
            Assert.Equal(1000, g.Items[0].PaidCoins);
            Assert.Equal("standard", g.Items[0].BannerId);
            Assert.Equal("SR", g.Items[0].Results[9].Rarity);
            _http.Reply(200, "{\"items\":[],\"nextCursor\":null,\"windowDays\":365}");
            await _api.GetCoinHistoryAsync("paid", c.NextCursor, 1);
            Assert.Equal("/v1/history/coins?limit=1&currency=paid&cursor=" + c.NextCursor, _http.Requests[3].Path);
            await Assert.ThrowsAsync<ArgumentException>(() => _api.GetCoinHistoryAsync("gold"));
            await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => _api.GetGachaHistoryAsync(null, 51));
        }

        [Fact]
        public async Task SupportTicketSendsReferencesOnlyAndIsRetriedSafely()
        {
            _http.Reply(503, "{\"error\":{\"code\":\"INTERNAL\"}}").Reply(200, Ticket);
            var t = await _api.CreateSupportTicketAsync(new[] { "P-4976B071", "C-3" }, SupportTopics.PurchaseMissing);
            Assert.Equal(2, _http.Requests.Count);
            Assert.Equal("{\"refs\":[\"P-4976B071\",\"C-3\"],\"topic\":\"purchase_missing\"}", _http.Requests[1].Body);
            Assert.Equal("u1", t.PlayerId);
            Assert.Equal(2, t.Items.Count);
            Assert.Equal("coin", t.Items[1].Kind);
            Assert.Contains("P-4976B071", t.Body);
            Assert.Contains("muchi.support-ticket.v1", t.Raw);
            await Assert.ThrowsAsync<ArgumentException>(() => _api.CreateSupportTicketAsync(new[] { "C-1", "C-1" }, "refund"));
            await Assert.ThrowsAsync<ArgumentException>(() => _api.CreateSupportTicketAsync(new string[0], "refund"));
            await Assert.ThrowsAsync<ArgumentException>(() => _api.CreateSupportTicketAsync(new[] { "C-1" }, "angry"));
        }

        [Fact]
        public async Task HistoryViewEventMatchesTheServerSchema()
        {
            _http.Reply(200, "{\"accepted\":1}");
            await _api.SendAnalyticsAsync("ios", "1", new[] { AnalyticsEvent.HistoryView(5, "coins_free") });
            Assert.Contains("\"name\":\"history_view\"", _http.Requests[0].Body);
            Assert.Contains("\"tab\":\"coins_free\"", _http.Requests[0].Body);
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.HistoryView(0, "ledger"));
            string ts = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "src", "domain", "kpi.ts"));
            Assert.Contains("z.literal('history_view')", ts);
            Assert.Contains("['purchases', 'coins_paid', 'coins_free', 'gacha']", ts);
        }
    }
}
