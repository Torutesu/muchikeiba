using System;
using System.Threading.Tasks;
using Muchi.Client;
using Xunit;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-NEXT-010..013: /v1/home/next client methods, the model and the offline fallback (contracts/protocol.md §45).</summary>
    public class ApiClientNextActionTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientNextActionTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        // produced by the real server (PlayerService.dismissNextAction) after 3 races, a gift expiring in 2 days and missions_close closed
        internal const string View = "{\"enabled\":true,\"day\":\"2026-12-08\",\"onboarding\":false,\"primary\":{\"kind\":\"missions_claim\",\"count\":1,\"deadlineAt\":null,\"featureKey\":null,\"refId\":null,\"screen\":\"missions\",\"dismissible\":true},\"chips\":[{\"kind\":\"gift_expiring\",\"count\":1,\"deadlineAt\":1796871600000,\"featureKey\":null,\"refId\":null,\"screen\":\"gift_box\",\"dismissible\":true},{\"kind\":\"feature_unlocked\",\"count\":null,\"deadlineAt\":null,\"featureKey\":\"missions\",\"refId\":null,\"screen\":\"feature\",\"dismissible\":true}],\"dismissed\":[\"missions_close\"],\"nextDayAt\":1796756400000}";
        private const long Now = 1796698800000; // 2026-12-08 12:00 JST
        private static readonly DayRolloverInfo Rule = new DayRolloverInfo { HourJst = 4, PreviousHourJst = 0, EffectiveAtMs = 1796065200000 };

        [Fact]
        public async Task ParsesTheView()
        {
            _http.Reply(200, View);
            var v = await _api.GetNextActionsAsync();
            Assert.Equal("GET", _http.Requests[0].Method);
            Assert.Equal("/v1/home/next", _http.Requests[0].Path);
            Assert.True(v.Enabled);
            Assert.Equal("2026-12-08", v.Day);
            Assert.Equal("missions_claim", v.Primary.Kind);
            Assert.Equal(1, v.Primary.Count);
            Assert.Null(v.Primary.DeadlineAt);
            Assert.Equal(2, v.Chips.Count);
            Assert.Equal(1796871600000, v.Chips[0].DeadlineAt);
            Assert.Equal("missions", v.Chips[1].FeatureKey);
            Assert.Equal(new[] { "missions_close" }, v.Dismissed);
            // round trip for the offline cache
            var back = NextActionsView.FromJson(v.ToJson());
            Assert.Equal(v.Primary.Kind, back.Primary.Kind);
            Assert.Equal(v.Chips[0].DeadlineAt, back.Chips[0].DeadlineAt);
            Assert.Equal(v.NextDayAt, back.NextDayAt);
            Assert.Null(NextActionsView.FromJson("not json"));
        }

        [Fact]
        public async Task DismissSendsTheKindAndRefusesUnknownOnes()
        {
            _http.Reply(200, View);
            await _api.DismissNextActionAsync("missions_close");
            Assert.Equal("POST", _http.Requests[0].Method);
            Assert.Equal("/v1/home/next/dismiss", _http.Requests[0].Path);
            Assert.Contains("\"kind\":\"missions_close\"", _http.Requests[0].Body);
            await Assert.ThrowsAsync<ArgumentException>(() => _api.DismissNextActionAsync("shop"));
            Assert.Single(_http.Requests);
        }

        [Fact]
        public void PlayerViewCarriesTheBootstrapList()
        {
            var p = Muchi.Net.JsonNode.Parse("{\"id\":\"p\",\"nextActions\":" + View + "}");
            Assert.Equal("missions_claim", PlayerViewParse(p).NextActions.Primary.Kind);
            Assert.Null(PlayerViewParse(Muchi.Net.JsonNode.Parse("{\"id\":\"p\"}")).NextActions); // older server
        }
        private static PlayerView PlayerViewParse(Muchi.Net.JsonNode o) => (PlayerView)typeof(PlayerView).GetMethod("Parse", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!.Invoke(null, new object[] { o })!;

        [Fact]
        public void OfflineFallbackKeepsTodayDropsPastDeadlinesAndLocalCloses()
        {
            var cached = NextActionsView.FromJson(View);
            var same = NextActionFallback.Offline(cached, Now, Rule);
            Assert.True(same.FromCache);
            Assert.Equal("missions_claim", same.Primary.Kind);
            Assert.Equal(2, same.Chips.Count);
            // closed on this device → the next one moves up (chips never become the race card)
            var closed = NextActionFallback.Offline(cached, Now, Rule, new[] { "missions_claim" });
            Assert.Equal("gift_expiring", closed.Primary.Kind);
            Assert.Single(closed.Chips);
            // a card's real deadline passed (same game day) → dropped
            cached.Chips[0].DeadlineAt = Now + 1000;
            var later = NextActionFallback.Offline(cached, Now + 2000, Rule, new[] { "missions_claim" });
            Assert.Equal("feature_unlocked", later.Primary.Kind);
            Assert.Empty(later.Chips);
            // another game day: yesterday's reasons are stale → only the race card
            var tomorrow = NextActionFallback.Offline(cached, 1796756400000 + 1, Rule);
            Assert.Equal("race", tomorrow.Primary.Kind);
            Assert.Empty(tomorrow.Chips);
            Assert.False(tomorrow.Primary.Dismissible);
            // nothing cached → the race card
            Assert.Equal("race", NextActionFallback.Offline(null, Now, Rule).Primary.Kind);
        }

        [Fact]
        public void ScoutTicketIsNeverThePrimaryCardOffline()
        {
            var v = NextActionsView.FromJson("{\"enabled\":true,\"day\":\"2026-12-08\",\"onboarding\":false,\"primary\":{\"kind\":\"race\",\"screen\":\"race\",\"dismissible\":false},\"chips\":[{\"kind\":\"scout_ticket\",\"count\":2,\"screen\":\"scout\",\"dismissible\":true}],\"dismissed\":[],\"nextDayAt\":1796756400000}");
            var o = NextActionFallback.Offline(v, Now, Rule);
            Assert.Equal("race", o.Primary.Kind);
            Assert.Equal("scout_ticket", o.Chips[0].Kind);
            Assert.True(NextKinds.ChipOnly("scout_ticket"));
        }

        [Fact]
        public void AnalyticsEventsCheckKindAndSlot()
        {
            Assert.Equal("next_card_view", AnalyticsEvent.NextCardView(1, "gift_expiring", "primary").Name);
            Assert.Equal("next_card_tap", AnalyticsEvent.NextCardTap(1, "scout_ticket", "chip").Name);
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.NextCardTap(1, "shop", "chip"));
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.NextCardView(1, "race", "banner"));
        }
    }
}
