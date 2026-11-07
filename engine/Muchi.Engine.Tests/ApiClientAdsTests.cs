using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-AD-003..010: /v1/ads client methods and models (contracts/protocol.md §21).</summary>
    public class ApiClientAdsTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientAdsTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        private const string View = "{\"enabled\":true,\"eligible\":true,\"reason\":null,\"pref\":\"auto\",\"payerQuietUntil\":null,\"day\":\"2026-12-11\","
            + "\"globalCap\":3,\"globalUsed\":1,\"globalLeft\":2,\"startsLeft\":11,\"network\":\"admob\",\"placements\":["
            + "{\"id\":\"daily_coins\",\"surface\":\"home\",\"title\":\"動画を見て、無償コインを受け取る\",\"rewardLabel\":\"無償コイン10枚\",\"reward\":{\"freeCoins\":10},\"dailyCap\":1,\"used\":1,\"left\":0,\"adUnitKey\":\"REWARDED_HOME\",\"available\":false},"
            + "{\"id\":\"ta_attempt\",\"surface\":\"time_attack\",\"title\":\"動画を見て、タイムアタックをもう1回\",\"rewardLabel\":\"タイムアタック1回\",\"reward\":{\"taAttempts\":1},\"dailyCap\":1,\"used\":0,\"left\":1,\"adUnitKey\":\"REWARDED_TA\",\"available\":true}],"
            + "\"adRequest\":{\"nonPersonalized\":true,\"underAgeOfConsent\":false,\"ageKnown\":false},\"open\":[]}";

        [Fact]
        public async Task ViewParsesPlacementsAndHints()
        {
            _http.Reply(200, View);
            var v = await _api.GetAdsAsync();
            Assert.Equal("GET", _http.Requests[0].Method);
            Assert.Equal("/v1/ads", _http.Requests[0].Path);
            Assert.True(v.Eligible);
            Assert.Null(v.Reason);
            Assert.Equal(2, v.GlobalLeft);
            Assert.Equal(2, v.Placements.Count);
            Assert.Equal("無償コイン10枚", v.Placement("daily_coins").RewardLabel);
            Assert.Equal(10, v.Placement("daily_coins").Reward.FreeCoins);
            Assert.False(v.Placement("daily_coins").Available);
            Assert.Null(v.ForSurface("home"));
            Assert.Equal("ta_attempt", v.ForSurface("time_attack").Id);
            Assert.Equal(1, v.ForSurface("time_attack").Reward.TaAttempts);
            Assert.True(v.AdRequest.NonPersonalized);
            Assert.DoesNotContain("倍", View);
        }

        [Fact]
        public async Task StartIsKeyedAndRetriedWithTheSameKey()
        {
            _http.Reply(503, "{\"error\":{\"code\":\"INTERNAL\"}}")
                 .Reply(200, "{\"sessionId\":\"ad_0123456789abcdef\",\"placementId\":\"daily_coins\",\"network\":\"admob\",\"adUnitKey\":\"REWARDED_HOME\","
                    + "\"customData\":\"ad_0123456789abcdef\",\"userId\":\"p1\",\"expiresAt\":1796000000000,\"rewardLabel\":\"無償コイン10枚\",\"adRequest\":{\"nonPersonalized\":false}}");
            var s = await _api.StartAdAsync("daily_coins");
            Assert.Equal(2, _http.Requests.Count);
            Assert.Equal("/v1/ads/daily_coins/start", _http.Requests[1].Path);
            Assert.Equal("POST", _http.Requests[1].Method);
            Assert.Equal(_http.Requests[0].Headers["idempotency-key"], _http.Requests[1].Headers["idempotency-key"]);
            Assert.Equal("ad_0123456789abcdef", s.CustomData);
            Assert.Equal("p1", s.UserId);
            Assert.False(s.AdRequest.NonPersonalized);
        }

        [Fact]
        public async Task LimitReachedIsAConflict()
        {
            _http.Reply(409, "{\"error\":{\"code\":\"AD_LIMIT_REACHED\",\"message\":\"daily_coins: today's views are used up\"}}");
            var e = await Assert.ThrowsAsync<ConflictException>(() => _api.StartAdAsync("daily_coins"));
            Assert.Equal(ApiErrorCode.AdLimitReached, e.Code);
        }

        [Fact]
        public async Task SessionPollingAndPreference()
        {
            _http.Reply(200, "{\"sessionId\":\"ad_0123456789abcdef\",\"placementId\":\"daily_coins\",\"status\":\"open\",\"expiresAt\":1,\"reward\":null,\"rewardLabel\":null,\"reason\":null,\"wallet\":{\"paid\":0,\"free\":100,\"total\":100,\"debt\":0}}")
                 .Reply(200, "{\"sessionId\":\"ad_0123456789abcdef\",\"placementId\":\"daily_coins\",\"status\":\"rewarded\",\"expiresAt\":1,\"reward\":{\"freeCoins\":10},\"rewardLabel\":\"無償コイン10枚\",\"reason\":null,\"wallet\":{\"paid\":0,\"free\":110,\"total\":110,\"debt\":0}}")
                 .Reply(200, View.Replace("\"pref\":\"auto\"", "\"pref\":\"off\"").Replace("\"eligible\":true,\"reason\":null", "\"eligible\":false,\"reason\":\"opted_out\""));
            var a = await _api.GetAdSessionAsync("ad_0123456789abcdef");
            Assert.False(a.Final);
            var b = await _api.GetAdSessionAsync("ad_0123456789abcdef");
            Assert.True(b.Rewarded && b.Final);
            Assert.Equal(110, b.Wallet.Free);
            Assert.Equal("/v1/ads/sessions/ad_0123456789abcdef", _http.Requests[1].Path);
            var v = await _api.SetAdPreferenceAsync(AdPref.Off);
            Assert.Equal("PUT", _http.Requests[2].Method);
            Assert.Equal("{\"mode\":\"off\"}", _http.Requests[2].Body);
            Assert.Equal("opted_out", v.Reason);
        }

        [Fact]
        public void AnalyticsEventsMatchTheServerSchema()
        {
            var o = AnalyticsEvent.AdOfferView(5, "daily_coins", "home");
            Assert.Equal("ad_offer_view", o.Name);
            var s = AnalyticsEvent.AdStart(6, "daily_coins", "home", "no_fill");
            Assert.Equal("ad_start", s.Name);
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.AdStart(6, "daily_coins", "race", "shown"));
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.AdStart(6, "daily_coins", "home", "rewarded"));
        }
    }
}
