using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;
using Muchi.Net;
using Xunit;

namespace Muchi.Engine.Tests
{
    /// <summary>Push device/preference endpoints and the analytics batching client (round 3, REQ-PUSH / REQ-KPI).</summary>
    public class PushAnalyticsClientTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly FakeDelay _delay = new FakeDelay();
        private readonly ApiClient _api;

        public PushAnalyticsClientTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, _delay, new SeqIds());
        }

        private static string Canon(string json) => JsonNode.Parse(json).ToString();

        private const string Prefs = "{\"categories\":{\"season\":true,\"friends\":true,\"invites\":false,\"events\":true},\"quietHours\":{\"startHour\":22,\"endHour\":8},\"dailyCap\":5,\"devices\":2,\"topics\":{\"subscribe\":[\"season_ja\",\"events_ja\"],\"unsubscribe\":[]}}";

        [Fact]
        public async Task RegisterAndUnregisterDevice()
        {
            _http.Reply(200, "{\"devices\":1}");
            Assert.Equal(1, await _api.RegisterPushDeviceAsync("fcm-token-1", PushPlatform.Android));
            var r = Assert.Single(_http.Requests);
            Assert.Equal("PUT", r.Method);
            Assert.Equal("/v1/push/devices", r.Path);
            Assert.Equal(Canon("{\"token\":\"fcm-token-1\",\"platform\":\"android\"}"), Canon(r.Body));

            _http.Requests.Clear();
            _http.Reply(200, "{\"removed\":1,\"devices\":0}");
            Assert.Equal(1, await _api.UnregisterPushDeviceAsync("fcm-token-1"));
            r = Assert.Single(_http.Requests);
            Assert.Equal("POST", r.Method);
            Assert.Equal("/v1/push/devices/unregister", r.Path);
        }

        [Fact]
        public async Task DeviceRegistrationIsRetriedOnServerErrors()
        {
            _http.Reply(503, "{\"error\":{\"code\":\"INTERNAL\"}}").Reply(200, "{\"devices\":1}");
            Assert.Equal(1, await _api.RegisterPushDeviceAsync("fcm-token-1", PushPlatform.Ios));
            Assert.Equal(2, _http.Requests.Count);
        }

        [Fact]
        public async Task PreferencesParseAndPatch()
        {
            _http.Reply(200, Prefs);
            var p = await _api.GetPushPreferencesAsync();
            Assert.True(p.Season);
            Assert.False(p.Invites);
            Assert.Equal(22, p.QuietStartHour);
            Assert.Equal(8, p.QuietEndHour);
            Assert.Equal(new[] { "season_ja", "events_ja" }, p.SubscribeTopics);
            Assert.Equal("/v1/push/preferences", _http.Requests[0].Path);

            _http.Requests.Clear();
            _http.Reply(200, Prefs);
            await _api.SetPushPreferencesAsync(new PushPreferencesPatch { Invites = true, QuietStartHour = 23, QuietEndHour = 7 });
            Assert.Equal("PUT", _http.Requests[0].Method);
            Assert.Equal(Canon("{\"categories\":{\"invites\":true},\"quietHours\":{\"startHour\":23,\"endHour\":7}}"), Canon(_http.Requests[0].Body));

            _http.Requests.Clear();
            _http.Reply(200, Prefs);
            await _api.SetPushPreferencesAsync(new PushPreferencesPatch { ClearQuietHours = true });
            Assert.Equal(Canon("{\"quietHours\":null}"), Canon(_http.Requests[0].Body));

            await Assert.ThrowsAsync<ArgumentException>(() => _api.SetPushPreferencesAsync(new PushPreferencesPatch { QuietStartHour = 1 }));
            await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => _api.SetPushPreferencesAsync(new PushPreferencesPatch { QuietStartHour = 24, QuietEndHour = 1 }));
        }

        [Fact]
        public async Task SendAnalyticsIsNotRetriedByTheApiClient()
        {
            var ev = new[] { AnalyticsEvent.SessionStart(1000), AnalyticsEvent.TutorialStep(1001, "whip", 1) };
            _http.Reply(200, "{\"accepted\":2,\"dropped\":0}");
            var r = await _api.SendAnalyticsAsync("android", "1.2.3", ev);
            Assert.Equal(2, r.Accepted);
            var req = Assert.Single(_http.Requests);
            Assert.Equal("/v1/analytics/events", req.Path);
            Assert.Equal(Canon("{\"platform\":\"android\",\"appVersion\":\"1.2.3\",\"events\":[{\"name\":\"session_start\",\"at\":1000,\"props\":{}},{\"name\":\"tutorial_step\",\"at\":1001,\"props\":{\"step\":\"whip\",\"index\":1}}]}"), Canon(req.Body));

            _http.Requests.Clear();
            _http.Reply(500, "{\"error\":{\"code\":\"INTERNAL\"}}");
            await Assert.ThrowsAsync<ServerException>(() => _api.SendAnalyticsAsync("ios", "1", ev));
            Assert.Single(_http.Requests);

            _http.Reply(429, "{\"error\":{\"code\":\"RATE_LIMITED\",\"message\":\"daily analytics quota exceeded\"}}");
            await Assert.ThrowsAsync<RateLimitedException>(() => _api.SendAnalyticsAsync("ios", "1", ev));
        }

        [Fact]
        public void EventFactoriesRejectBadValues()
        {
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.ScreenView(0, "ホーム"));
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.ScreenView(0, "a b"));
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.RaceStart(0, "derby"));
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.PurchaseFlow(0, "done", "coin_160"));
            Assert.Equal("purchase_flow", AnalyticsEvent.PurchaseFlow(0, "cancel", "coin_160").Name);
        }

        // ------------------------------------------------------------------ AnalyticsClient

        private sealed class MemStore : IAnalyticsStore
        {
            public string Json;
            public string Load() => Json;
            public void Save(string json) { Json = json; }
        }

        private sealed class FakeSend
        {
            public readonly List<List<AnalyticsEvent>> Batches = new List<List<AnalyticsEvent>>();
            public readonly Queue<Func<IReadOnlyList<AnalyticsEvent>, AnalyticsIngestResult>> Replies = new Queue<Func<IReadOnlyList<AnalyticsEvent>, AnalyticsIngestResult>>();
            public FakeSend Ok() { Replies.Enqueue(b => new AnalyticsIngestResult { Accepted = b.Count }); return this; }
            public FakeSend Throw(Exception e) { Replies.Enqueue(_ => throw e); return this; }
            public Task<AnalyticsIngestResult> Send(string platform, string appVersion, IReadOnlyList<AnalyticsEvent> events, CancellationToken ct)
            {
                Batches.Add(events.ToList());
                var f = Replies.Count > 0 ? Replies.Dequeue() : (b => new AnalyticsIngestResult { Accepted = b.Count });
                return Task.FromResult(f(events));
            }
        }

        private static readonly long T0 = 1_762_311_600_000; // 2025-11-05T03:00Z

        [Fact]
        public async Task FlushesFullBatchesImmediatelyAndTheRestOnTheInterval()
        {
            var s = new FakeSend();
            var a = new AnalyticsClient(s.Send, new AnalyticsOptions { Platform = "ios", AppVersion = "1.0.0" }, null, T0);
            for (int i = 0; i < 55; i++) a.Track(AnalyticsEvent.ScreenView(T0, "home"));
            Assert.True(a.Update(T0));            // 55 >= 50 → flush now
            await WaitIdle(a);
            Assert.Equal(50, s.Batches[0].Count);
            Assert.Equal(5, a.Pending);
            Assert.False(a.Update(T0 + 1_000));   // 5 waiting, interval not over
            Assert.True(a.Update(T0 + 31_000));
            await WaitIdle(a);
            Assert.Equal(0, a.Pending);
            Assert.Equal(55, a.Sent);
        }

        [Fact]
        public async Task KeepsEventsAndBacksOffOnNetworkFailure()
        {
            var s = new FakeSend().Throw(new NetworkException("offline", new Exception())).Throw(new NetworkException("offline", new Exception())).Ok();
            var a = new AnalyticsClient(s.Send, new AnalyticsOptions(), null, T0);
            a.Track(AnalyticsEvent.SessionStart(T0));
            Assert.False(await a.FlushOnceAsync(T0));
            Assert.Equal(1, a.Pending);
            Assert.False(a.Update(T0 + 4_000));   // first backoff 5s
            Assert.False(await a.FlushOnceAsync(T0 + 5_000));
            Assert.False(a.Update(T0 + 5_000 + 9_000)); // second backoff 10s
            Assert.True(a.Update(T0 + 5_000 + 10_000 + 31_000));
            await WaitIdle(a);
            Assert.Equal(0, a.Pending);
        }

        [Fact]
        public async Task RateLimitWaitsAtLeastAMinute()
        {
            var s = new FakeSend().Throw(new RateLimitedException("RATE_LIMITED", "quota", 429)).Ok();
            var a = new AnalyticsClient(s.Send, new AnalyticsOptions(), null, T0);
            for (int i = 0; i < 50; i++) a.Track(AnalyticsEvent.SessionStart(T0));
            Assert.False(await a.FlushOnceAsync(T0));
            Assert.False(a.Update(T0 + 59_000));
            Assert.True(a.Update(T0 + 60_000));
            await WaitIdle(a);
            Assert.Equal(0, a.Pending);
        }

        [Fact]
        public async Task DropsABatchTheServerRejectsAsInvalid()
        {
            var s = new FakeSend().Throw(new ValidationException(ApiErrorCode.BadRequest, "BAD_REQUEST", "events.0: invalid", 400));
            var a = new AnalyticsClient(s.Send, new AnalyticsOptions(), null, T0);
            a.Track(AnalyticsEvent.SessionStart(T0));
            Assert.True(await a.FlushOnceAsync(T0));
            Assert.Equal(0, a.Pending);
            Assert.Equal(1, a.Dropped);
        }

        [Fact]
        public async Task PersistsUnsentEventsAcrossRestartsAndDropsStaleOnes()
        {
            var store = new MemStore();
            var a = new AnalyticsClient(new FakeSend().Throw(new NetworkException("offline", new Exception())).Send, new AnalyticsOptions(), store, T0);
            a.Track(AnalyticsEvent.SessionStart(T0 - 8L * 86_400_000)); // older than 7 days
            a.Track(AnalyticsEvent.TutorialStep(T0, "gate", 0));
            await a.FlushOnceAsync(T0);
            Assert.Contains("tutorial_step", store.Json);

            var s2 = new FakeSend();
            var b = new AnalyticsClient(s2.Send, new AnalyticsOptions(), store, T0 + 1_000);
            Assert.Equal(1, b.Pending); // the stale one was dropped by the first client's flush
            await b.FlushAllAsync(T0 + 1_000);
            Assert.Equal("tutorial_step", Assert.Single(Assert.Single(s2.Batches)).Name);
            Assert.Equal("[]", store.Json);
        }

        [Fact]
        public void CapsTheQueue()
        {
            var a = new AnalyticsClient(new FakeSend().Send, new AnalyticsOptions { MaxQueue = 3 }, null, T0);
            for (int i = 0; i < 5; i++) a.Track(AnalyticsEvent.SessionStart(T0 + i));
            Assert.Equal(3, a.Pending);
            Assert.Equal(2, a.Dropped);
        }

        [Fact]
        public async Task ApiClientOverloadPostsToTheEventsEndpoint()
        {
            _http.Reply(200, "{\"accepted\":1,\"dropped\":0}");
            var a = new AnalyticsClient(_api, new AnalyticsOptions { Platform = "android", AppVersion = "2.0.0" }, null, T0);
            a.Track(AnalyticsEvent.PushOpen(T0, "friend_request"));
            Assert.True(await a.FlushOnceAsync(T0));
            Assert.Equal("/v1/analytics/events", Assert.Single(_http.Requests).Path);
        }

        private static async Task WaitIdle(AnalyticsClient a)
        {
            for (int i = 0; i < 100 && a.Flushing; i++) await Task.Delay(5);
        }
    }
}
