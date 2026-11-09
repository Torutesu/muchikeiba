using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-SHORT-004/005/009: the T6 coin shortfall on INSUFFICIENT_COINS and GET /v1/shop/shortfall (contracts/protocol.md §29).</summary>
    public class ApiClientShortfallTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientShortfallTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        internal const string Shortfall = "{\"short\":true,\"coinKind\":\"paid\",\"need\":1500,\"have\":300,\"shortfall\":1200,\"headline\":\"有償コインが1,200枚足りません\","
            + "\"status\":\"covered\",\"blockedCode\":null,\"ageCheck\":false,\"line\":\"コイン1,660（¥2,400）で足ります\",\"notes\":[\"有償コインだけで支払います（無償コインは使えません）\"],"
            + "\"offer\":{\"offerId\":\"shortfall\",\"touchpoint\":\"T6\",\"productId\":\"coin_2400\",\"name\":\"コイン1,660\",\"priceYen\":2400,\"paidCoins\":1660,\"covers\":true,"
            + "\"contents\":[{\"type\":\"paid_coins\",\"qty\":1660,\"label\":\"有償コイン1,660枚\"}],"
            + "\"firstPurchaseBonus\":{\"coins\":1660,\"currency\":\"free\",\"label\":\"はじめての購入時のみ：無償コイン1,660枚をプレゼント\"},\"oneTime\":false}}";

        [Fact]
        public async Task DrawFailureCarriesTheShortfall()
        {
            _http.Reply(409, "{\"error\":{\"code\":\"INSUFFICIENT_COINS\",\"message\":\"need 1500, have 300\",\"details\":{\"coinKind\":\"paid\",\"need\":1500,\"have\":300,\"shortfall\":" + Shortfall + "}}}");
            var e = await Assert.ThrowsAsync<InsufficientCoinsException>(() => _api.DrawAsync("stepup_paid", 10, "c:k1"));
            Assert.NotNull(e.Shortfall);
            var s = e.Shortfall;
            Assert.True(s.Short && s.HasOffer);
            Assert.Equal("paid", s.CoinKind);
            Assert.Equal(1200, s.Amount);
            Assert.Equal("有償コインが1,200枚足りません", s.Headline);
            Assert.Equal("shortfall", s.Offer.OfferId);
            Assert.Equal("T6", s.Offer.Touchpoint);
            Assert.Equal("coin_2400", s.Offer.ProductId);
            Assert.True(s.Offer.Covers);
            Assert.Equal("有償コイン1,660枚", s.Offer.Contents[0].Label);
            Assert.Equal("はじめての購入時のみ：無償コイン1,660枚をプレゼント", s.Offer.FirstPurchaseBonus.Label);
            Assert.Single(s.Notes);
        }

        [Fact]
        public async Task OlderServersAndOtherErrorsHaveNoShortfall()
        {
            _http.Reply(409, "{\"error\":{\"code\":\"INSUFFICIENT_COINS\",\"message\":\"need 100, have 0\"}}");
            var e = await Assert.ThrowsAsync<InsufficientCoinsException>(() => _api.DrawAsync("standard", 1, "c:k2"));
            Assert.Null(e.Shortfall);
            // the old three-argument factory still works
            Assert.IsType<InsufficientCoinsException>(ApiErrorCodes.Create("INSUFFICIENT_COINS", "x", 409));
        }

        [Fact]
        public async Task PreviewEndpoints()
        {
            _http.Reply(200, Shortfall).Reply(200, Shortfall).Reply(200, "{\"short\":false,\"coinKind\":\"any\",\"need\":100,\"have\":500,\"shortfall\":0,\"headline\":null,\"status\":\"not_short\",\"blockedCode\":null,\"ageCheck\":false,\"line\":null,\"notes\":[],\"offer\":null}");
            var a = await _api.GetCoinShortfallForGachaAsync("stepup_paid", 10);
            Assert.Equal("/v1/shop/shortfall?for=gacha&bannerId=stepup_paid&count=10", _http.Requests[0].Path);
            Assert.Equal("covered", a.Status);
            await _api.GetCoinShortfallForCosmeticAsync("tack_bridle_gold");
            Assert.Equal("/v1/shop/shortfall?for=cosmetic&itemId=tack_bridle_gold", _http.Requests[1].Path);
            var c = await _api.GetCoinShortfallAsync(100, "any");
            Assert.Equal("/v1/shop/shortfall?for=coins&coins=100&kind=any", _http.Requests[2].Path);
            Assert.False(c.Short);
            Assert.False(c.HasOffer);
            Assert.All(_http.Requests, r => Assert.Equal("GET", r.Method));
        }
    }
}
