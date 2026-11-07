using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-CB-001..012: comeback window, claims, what's new and the opt-in push category (server/src/domain/comeback.ts).</summary>
    public class ApiClientComebackTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientComebackTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        internal const string WindowJson = "{\"id\":\"cb1_20261110\",\"tier\":\"short\",\"lapseDays\":7,\"startDay\":\"2026-11-10\",\"endDay\":\"2026-11-23\",\"endsAt\":1795446000000,"
            + "\"remainingDays\":14,\"day\":1,\"days\":14,\"showWelcome\":true,\"completed\":false,\"blocked\":false,"
            + "\"login\":{\"claimed\":0,\"total\":7,\"claimableToday\":true,\"days\":[{\"day\":1,\"reward\":{\"freeCoins\":100},\"claimed\":false},{\"day\":2,\"reward\":{\"items\":[{\"itemId\":\"gacha_ticket\",\"qty\":1}]},\"claimed\":false}]},"
            + "\"missions\":[{\"id\":\"cb_race\",\"kind\":\"races\",\"feature\":\"skills\",\"title\":\"まずは1レース\",\"guide\":\"固有スキル\",\"target\":1,\"progress\":0,\"reward\":{\"freeCoins\":50},\"claimed\":false,\"claimable\":false}],"
            + "\"catchUp\":{\"seasonId\":\"2026-11\",\"targetXp\":600,\"capXp\":500,\"grantedXp\":0,\"remainingXp\":500,\"bonusPerRace\":20,\"active\":true}}";

        [Fact]
        public async Task ComebackViewParses()
        {
            _http.Reply(200, "{\"active\":true,\"push\":{\"category\":\"comeback\",\"enabled\":false},\"window\":" + WindowJson + "}");
            var v = await _api.GetComebackAsync();
            Assert.Equal("GET /v1/comeback", _http.Requests[0].ToString());
            Assert.True(v.Active);
            Assert.False(v.PushEnabled);
            var w = v.Window;
            Assert.Equal("short", w.Tier);
            Assert.Equal(7, w.LapseDays);
            Assert.Equal(1795446000000, w.EndsAt);
            Assert.True(w.ShowWelcome);
            Assert.Equal(7, w.Login.Total);
            Assert.True(w.Login.ClaimableToday);
            Assert.Equal("gacha_ticket", w.Login.Days[1].Reward.Items[0].ItemId);
            Assert.Equal("skills", w.Missions[0].Feature);
            Assert.Equal(500, w.CatchUp.RemainingXp);
            Assert.Equal(20, w.CatchUp.BonusPerRace);
        }

        [Fact]
        public async Task InactiveViewHasNoWindow()
        {
            _http.Reply(200, "{\"active\":false,\"window\":null,\"push\":{\"category\":\"comeback\",\"enabled\":true}}");
            var v = await _api.GetComebackAsync();
            Assert.False(v.Active);
            Assert.Null(v.Window);
            Assert.True(v.PushEnabled);
        }

        [Fact]
        public async Task ClaimsAreKeyedAndRetriedWithTheSameKey()
        {
            _http.Reply(503, "{\"error\":{\"code\":\"INTERNAL\",\"message\":\"x\"}}").Reply(200, "{\"day\":1,\"reward\":{\"freeCoins\":100},\"window\":" + WindowJson + "}");
            var c = await _api.ClaimComebackLoginAsync();
            Assert.Equal(1, c.Day);
            Assert.Equal(100, c.Reward.FreeCoins);
            Assert.Equal(2, _http.Requests.Count);
            Assert.All(_http.Requests, r => Assert.Equal("key1", r.Headers["idempotency-key"]));
            Assert.Equal("POST /v1/comeback/login", _http.Requests[0].ToString());

            _http.Reply(200, "{\"missionId\":\"cb_race\",\"reward\":{\"freeCoins\":50},\"window\":" + WindowJson + "}");
            var m = await _api.ClaimComebackMissionAsync("cb_race", "c:fixed");
            Assert.Equal("cb_race", m.MissionId);
            Assert.Equal("POST /v1/comeback/missions/cb_race/claim", _http.Requests[2].ToString());
            Assert.Equal("c:fixed", _http.Requests[2].Headers["idempotency-key"]);
        }

        [Fact]
        public async Task DeletionPendingIsAConflict()
        {
            _http.Reply(409, "{\"error\":{\"code\":\"DELETION_PENDING\",\"message\":\"x\"}}");
            var e = await Assert.ThrowsAnyAsync<ApiException>(() => _api.ClaimComebackLoginAsync());
            Assert.Equal(ApiErrorCode.DeletionPending, e.Code);
            Assert.Equal("DELETION_PENDING", e.WireCode);
        }

        [Fact]
        public async Task WhatsNewAndSeen()
        {
            _http.Reply(200, "{\"since\":1,\"upTo\":1795000000000,\"showCard\":true,\"more\":0,\"items\":[{\"id\":\"banner_pickup_ginga\",\"kind\":\"banner\",\"title\":\"ピックアップ\",\"body\":\"新しいスカウト\",\"at\":1793458800000,\"feature\":\"scout\",\"bannerId\":\"pickup_ginga\",\"eventId\":null,\"endsAt\":1796050800000},"
                + "{\"id\":\"skills_v1\",\"kind\":\"feature\",\"title\":\"固有スキル\",\"body\":\"…\",\"at\":1793458800000,\"feature\":\"skills\",\"bannerId\":null,\"eventId\":null,\"endsAt\":null}]}");
            var w = await _api.GetWhatsNewAsync();
            Assert.True(w.ShowCard);
            Assert.Equal(2, w.Items.Count);
            Assert.Equal("pickup_ginga", w.Items[0].BannerId);
            Assert.Null(w.Items[1].EndsAt);
            _http.Reply(200, "{\"seenUpTo\":1795000000000}");
            Assert.Equal(1795000000000, await _api.MarkWhatsNewSeenAsync(w.UpTo));
            Assert.Contains("\"upTo\":1795000000000", _http.Requests[1].Body);
            _http.Reply(200, "{\"windowId\":\"cb1\",\"welcomedAt\":5}");
            Assert.Equal(5, await _api.MarkComebackWelcomedAsync());
        }

        [Fact]
        public async Task PushPreferencesCarryTheComebackCategory()
        {
            _http.Reply(200, "{\"categories\":{\"season\":true,\"friends\":true,\"invites\":true,\"events\":true,\"comeback\":false},\"quietHours\":null,\"dailyCap\":2,\"devices\":1,\"topics\":{\"subscribe\":[],\"unsubscribe\":[]}}");
            var p = await _api.SetPushPreferencesAsync(new PushPreferencesPatch { Comeback = true });
            Assert.Contains("\"comeback\":true", _http.Requests[0].Body);
            Assert.False(p.Comeback);
        }
    }
}
