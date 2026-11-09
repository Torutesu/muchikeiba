using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-BOX-001..014: /v1/gift-box client methods and models (contracts/protocol.md §26).</summary>
    public class ApiClientGiftBoxTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientGiftBoxTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        // produced by the real server (PlayerService.giftBox) after a compensation, a tournament prize and a grant with no expiry
        internal const string Box = "{\"enabled\":true,\"tab\":\"box\",\"badge\":{\"unclaimed\":3,\"expiringSoon\":0},\"maxUnclaimed\":500,\"total\":3,\"offset\":0,\"limit\":50,\"nextOffset\":null,\"rules\":{\"defaultExpiryDays\":30,\"historyDays\":90,\"paidCoins\":false},\"entries\":[{\"giftId\":\"gift_2\",\"source\":\"tournament\",\"titleKey\":\"tournament\",\"title\":\"大会の賞品\",\"rank\":2,\"contents\":{\"freeCoins\":100,\"items\":[]},\"lines\":[\"無償コイン100枚\"],\"createdAt\":1794279600000,\"expiresAt\":1796871600000,\"status\":\"unclaimed\",\"doneAt\":null,\"how\":null,\"held\":null},{\"giftId\":\"gift_1\",\"source\":\"ops_compensation\",\"titleKey\":\"ops_compensation_maintenance\",\"title\":\"メンテナンスのお詫び\",\"rank\":null,\"contents\":{\"freeCoins\":300,\"items\":[{\"itemId\":\"gacha_ticket\",\"name\":\"スカウト券\",\"qty\":1}]},\"lines\":[\"無償コイン300枚\",\"スカウト券×1\"],\"createdAt\":1794279600000,\"expiresAt\":1802055600000,\"status\":\"unclaimed\",\"doneAt\":null,\"how\":null,\"held\":null},{\"giftId\":\"gift_3\",\"source\":\"ops_grant\",\"titleKey\":\"ops_grant\",\"title\":\"運営からの贈り物\",\"rank\":null,\"contents\":{\"freeCoins\":50,\"items\":[]},\"lines\":[\"無償コイン50枚\"],\"createdAt\":1794279600000,\"expiresAt\":null,\"status\":\"unclaimed\",\"doneAt\":null,\"how\":null,\"held\":null}]}";
        // claim-all with one entry held (item cap)
        internal const string ClaimAll = "{\"claimed\":[{\"giftId\":\"gift_2\",\"source\":\"tournament\",\"freeCoins\":100,\"items\":[]},{\"giftId\":\"gift_1\",\"source\":\"ops_compensation\",\"freeCoins\":300,\"items\":[{\"itemId\":\"gacha_ticket\",\"qty\":1}]}],\"held\":[{\"giftId\":\"gift_3\",\"reason\":\"item_cap\",\"itemId\":\"gacha_ticket\"}],\"totals\":{\"freeCoins\":400,\"items\":{\"gacha_ticket\":1}},\"badge\":{\"unclaimed\":1,\"expiringSoon\":0},\"wallet\":{\"paid\":0,\"free\":400,\"total\":400,\"debt\":0},\"items\":{\"gacha_ticket\":1}}";

        [Fact]
        public async Task BoxParsesEntriesBadgeAndRealExpiryOnly()
        {
            _http.Reply(200, Box);
            var p = await _api.GetGiftBoxAsync();
            Assert.Equal("/v1/gift-box?tab=box&offset=0&limit=50", _http.Requests[0].Path);
            Assert.True(p.Enabled);
            Assert.False(p.PaidCoins);
            Assert.Equal(3, p.Badge.Unclaimed);
            Assert.Null(p.NextOffset);
            Assert.Equal(30, p.DefaultExpiryDays);
            Assert.Equal(3, p.Entries.Count);
            var t = p.Entries[0];
            Assert.Equal("tournament", t.Source);
            Assert.Equal(2, t.Rank);
            Assert.Equal(100, t.FreeCoins);
            Assert.True(t.Unclaimed);
            var comp = p.Entries[1];
            Assert.True(comp.IsCompensation);
            Assert.Equal("メンテナンスのお詫び", comp.Title);
            Assert.Equal("gacha_ticket", comp.Items[0].ItemId);
            Assert.Equal(new[] { "無償コイン300枚", "スカウト券×1" }, comp.Lines);
            long now = t.CreatedAt;
            Assert.Equal(30, t.DaysLeft(now));
            Assert.Equal(90, comp.DaysLeft(now));
            Assert.Equal(3, t.DaysLeft(t.ExpiresAt.Value - 3 * 86_400_000L + 1));
            Assert.Equal(0, t.DaysLeft(t.ExpiresAt.Value + 5));
            Assert.Null(p.Entries[2].ExpiresAt);
            Assert.Null(p.Entries[2].DaysLeft(now)); // no expiry: never an expiry text
        }

        [Fact]
        public async Task ClaimsAreKeyedAndReportHeldEntries()
        {
            _http.Reply(503, "{\"error\":{\"code\":\"INTERNAL\"}}").Reply(200, ClaimAll);
            var r = await _api.ClaimAllGiftsAsync();
            Assert.Equal("POST", _http.Requests[0].Method);
            Assert.Equal("/v1/gift-box/claim-all", _http.Requests[0].Path);
            Assert.Equal(_http.Requests[0].Headers["idempotency-key"], _http.Requests[1].Headers["idempotency-key"]);
            Assert.Equal(2, r.Claimed.Count);
            Assert.Equal(400, r.TotalFreeCoins);
            Assert.Equal(1, r.TotalItems["gacha_ticket"]);
            var held = Assert.Single(r.Held);
            Assert.Equal("item_cap", held.Reason);
            Assert.Equal("gacha_ticket", held.ItemId);
            Assert.Equal(400, r.Wallet.Free);
            Assert.Equal(0, r.Wallet.Paid);
            Assert.Equal(1, r.Badge.Unclaimed);

            _http.Reply(200, ClaimAll);
            await _api.ClaimGiftAsync("gift_3", "k-1");
            Assert.Equal("/v1/gift-box/gift_3/claim", _http.Requests[2].Path);
            Assert.Equal("k-1", _http.Requests[2].Headers["idempotency-key"]);
        }

        [Fact]
        public async Task ErrorsAndHistoryAndBadge()
        {
            _http.Reply(409, "{\"error\":{\"code\":\"GIFT_HOLD_CAP\",\"message\":\"over the limit\"}}");
            var e = await Assert.ThrowsAsync<ConflictException>(() => _api.ClaimGiftAsync("gift_1"));
            Assert.Equal(ApiErrorCode.GiftHoldCap, e.Code);
            _http.Reply(409, "{\"error\":{\"code\":\"GIFT_EXPIRED\"}}");
            Assert.Equal(ApiErrorCode.GiftExpired, (await Assert.ThrowsAsync<ConflictException>(() => _api.ClaimGiftAsync("gift_1"))).Code);
            _http.Reply(200, Box);
            await _api.GetGiftBoxAsync("history", 50, 20);
            Assert.Equal("/v1/gift-box?tab=history&offset=50&limit=20", _http.Requests[2].Path);
            await Assert.ThrowsAsync<System.ArgumentException>(() => _api.GetGiftBoxAsync("all"));
            _http.Reply(200, "{\"id\":\"u1\",\"giftBox\":{\"unclaimed\":4,\"expiringSoon\":1}}");
            var pv = await _api.GetPlayerAsync();
            Assert.Equal(4, pv.GiftBox.Unclaimed);
            Assert.Equal(1, pv.GiftBox.ExpiringSoon);
        }
    }
}
