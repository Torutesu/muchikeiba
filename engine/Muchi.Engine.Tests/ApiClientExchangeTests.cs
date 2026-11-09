using System.Linq;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-EXCH-001..012: /v1/events/:eventId/exchange client methods and models (contracts/protocol.md §30).</summary>
    public class ApiClientExchangeTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientExchangeTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        // produced by the real server (PlayerService.exchangeView / exchangeBuy) after three first places in the event
        internal const string View = "{\"eventId\":\"newyear_cup_2027_01\",\"name\":\"新春交換祭杯\",\"status\":\"open\",\"startAtMs\":1798729200000,\"endAtMs\":1799679600000,\"closesAtMs\":1799953200000,\"graceDays\":3,\"points\":120,\"earned\":120,\"spent\":0,\"earn\":{\"byPlace\":[30,25,21,18,16,14,12,10,8,6,5,4],\"participation\":10,\"dailyCap\":150,\"earnedToday\":120,\"remainingToday\":30,\"resetsAtMs\":1798743600000},\"leftover\":{\"itemId\":\"breeding_material\",\"pointsPerUnit\":100,\"rounding\":\"up\",\"preview\":2,\"converted\":null},\"items\":[{\"id\":\"ex_hatsuyuki\",\"name\":\"ハツユキソウ\",\"kind\":\"horse\",\"price\":800,\"stock\":1,\"bought\":0,\"remaining\":1,\"owned\":false,\"reward\":{\"horse\":\"t_hatsuyuki\"},\"icon\":\"collection/portrait/t_hatsuyuki\",\"affordable\":false,\"maxQty\":0},{\"id\":\"ex_scout_ticket\",\"name\":\"スカウト券\",\"kind\":\"ticket\",\"price\":300,\"stock\":1,\"bought\":0,\"remaining\":1,\"owned\":false,\"reward\":{\"items\":[{\"itemId\":\"gacha_ticket\",\"qty\":1}]},\"icon\":\"item/gacha_ticket\",\"affordable\":false,\"maxQty\":0},{\"id\":\"ex_coins_50\",\"name\":\"無償コイン 50\",\"kind\":\"coins\",\"price\":150,\"stock\":2,\"bought\":0,\"remaining\":2,\"owned\":false,\"reward\":{\"freeCoins\":50},\"icon\":null,\"affordable\":false,\"maxQty\":0},{\"id\":\"ex_material\",\"name\":\"配合素材\",\"kind\":\"material\",\"price\":120,\"stock\":3,\"bought\":0,\"remaining\":3,\"owned\":false,\"reward\":{\"items\":[{\"itemId\":\"breeding_material\",\"qty\":1}]},\"icon\":\"item/breeding_material\",\"affordable\":true,\"maxQty\":1},{\"id\":\"ex_flower_box\",\"name\":\"花かご（厩舎の飾り）\",\"kind\":\"cosmetic\",\"price\":200,\"stock\":1,\"bought\":0,\"remaining\":1,\"owned\":false,\"reward\":{\"items\":[{\"itemId\":\"decor_flower_box\",\"qty\":1}]},\"icon\":\"item/decor_flower_box\",\"affordable\":false,\"maxQty\":0}],\"rules\":{\"purchasable\":false,\"random\":false,\"completionReward\":false,\"sources\":[\"event_race\"]}}";
        internal const string Buy = "{\"eventId\":\"newyear_cup_2027_01\",\"itemId\":\"ex_material\",\"kind\":\"material\",\"qty\":1,\"spent\":120,\"points\":0,\"bought\":1,\"remaining\":2,\"granted\":{\"freeCoins\":0,\"items\":[{\"itemId\":\"breeding_material\",\"qty\":1}],\"horse\":null},\"wallet\":{\"paid\":0,\"free\":0,\"total\":0,\"debt\":0}}";
        internal const string Summary = "{\"status\":\"open\",\"closesAtMs\":1799953200000,\"graceDays\":3,\"points\":0,\"leftover\":{\"itemId\":\"breeding_material\",\"pointsPerUnit\":100},\"converted\":null}";

        [Fact]
        public async Task ViewParsesPointsStockCapAndTheRules()
        {
            _http.Reply(200, View);
            var v = await _api.GetExchangeAsync("newyear_cup_2027_01");
            Assert.Equal("/v1/events/newyear_cup_2027_01/exchange", _http.Requests[0].Path);
            Assert.Equal("open", v.Status);
            Assert.True(v.CanExchange);
            Assert.Equal(120, v.Points);
            Assert.Equal(3, v.GraceDays);
            Assert.Equal(1799953200000L, v.ClosesAtMs);
            Assert.Equal(150, v.Earn.DailyCap);
            Assert.Equal(30, v.Earn.RemainingToday);
            Assert.Equal(40, v.Earn.PointsFor(1));
            Assert.Equal(10, v.Earn.PointsFor(0));
            Assert.Equal(2, v.Leftover.Preview);
            Assert.Equal(v.Leftover.Preview, v.Leftover.QtyFor(v.Points));
            Assert.Equal(1, v.Leftover.QtyFor(1));
            Assert.Null(v.Leftover.Converted);
            Assert.Equal(5, v.Items.Count);
            var horse = v.Find("ex_hatsuyuki");
            Assert.Equal("horse", horse.Kind);
            Assert.Equal("t_hatsuyuki", horse.RewardHorse);
            Assert.Equal("collection/portrait/t_hatsuyuki", horse.Icon);
            var coins = v.Find("ex_coins_50");
            Assert.Equal(50, coins.RewardFreeCoins);
            Assert.Null(coins.Icon);
            var mat = v.Find("ex_material");
            Assert.True(mat.Affordable);
            Assert.Equal(1, mat.MaxQty);
            Assert.Equal(3, mat.Remaining);
            Assert.Equal("breeding_material", mat.RewardItems[0].ItemId);
            Assert.False(v.Purchasable);
            Assert.False(v.Random);
            Assert.False(v.CompletionReward);
        }

        [Fact]
        public async Task ExchangeIsKeyedAndARetryKeepsTheKey()
        {
            _http.Reply(503, "{\"error\":{\"code\":\"INTERNAL\"}}").Reply(200, Buy);
            var r = await _api.ExchangeAsync("newyear_cup_2027_01", "ex_material");
            Assert.Equal(2, _http.Requests.Count);
            Assert.Equal("POST", _http.Requests[1].Method);
            Assert.Equal("/v1/events/newyear_cup_2027_01/exchange", _http.Requests[1].Path);
            Assert.Equal(_http.Requests[0].Headers["idempotency-key"], _http.Requests[1].Headers["idempotency-key"]);
            Assert.Contains("\"itemId\":\"ex_material\"", _http.Requests[1].Body);
            Assert.Contains("\"qty\":1", _http.Requests[1].Body);
            Assert.Equal(120, r.Spent);
            Assert.Equal(0, r.Points);
            Assert.Equal(2, r.Remaining);
            Assert.Equal("breeding_material", r.GrantedItems.Single().ItemId);
            Assert.Null(r.GrantedHorse);
            Assert.Equal(0, r.Wallet.Paid);
        }

        [Fact]
        public async Task ExchangeErrorsAreTyped()
        {
            foreach (var (wire, code) in new[] { ("OUT_OF_STOCK", ApiErrorCode.OutOfStock), ("INSUFFICIENT_POINTS", ApiErrorCode.InsufficientPoints), ("EXCHANGE_CLOSED", ApiErrorCode.ExchangeClosed), ("EXCHANGE_NOT_OPEN", ApiErrorCode.ExchangeNotOpen) })
            {
                _http.Reply(409, "{\"error\":{\"code\":\"" + wire + "\"}}");
                var e = await Assert.ThrowsAsync<ConflictException>(() => _api.ExchangeAsync("newyear_cup_2027_01", "ex_material"));
                Assert.Equal(code, e.Code);
            }
        }

        [Fact]
        public async Task EventListCarriesThePointCounter()
        {
            var json = "[{\"id\":\"newyear_cup_2027_01\",\"name\":\"x\",\"status\":\"open\",\"exchange\":" + Summary + "},{\"id\":\"sprint_cup_2026_11\",\"name\":\"y\",\"status\":\"closed\",\"exchange\":null}]";
            _http.Reply(200, json);
            var list = await _api.GetEventsAsync();
            Assert.Equal(3, list[0].Exchange.GraceDays);
            Assert.Equal("open", list[0].Exchange.Status);
            Assert.Equal(100, list[0].Exchange.Leftover.PointsPerUnit);
            Assert.Null(list[1].Exchange);
        }
    }
}
