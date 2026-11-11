using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-MNT-004..014: maintenance / upgrade-required handling in ApiClient (contracts/protocol.md §46).</summary>
    public class MaintenanceTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public MaintenanceTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test", Platform = "ios", AppVersion = "1.1.0" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        // shaped like the server's answers (server/test/maintenance.test.ts)
        internal const string Maint503 = "{\"error\":{\"code\":\"MAINTENANCE\",\"message\":\"メンテナンス中です\",\"details\":{\"windowId\":\"m-1112\",\"group\":\"gacha\",\"scope\":[\"shop\",\"gacha\"],\"startAt\":1794416400000,\"endAt\":1794430800000,\"endsAtJst\":\"11/12 06:00\",\"retryAfterSec\":12600,\"message\":\"11/12 2:00〜6:00 にメンテナンスを行います。\"}}}";
        internal const string Upgrade426 = "{\"error\":{\"code\":\"UPGRADE_REQUIRED\",\"message\":\"アプリを最新版に更新してください\",\"details\":{\"reason\":\"version\",\"platform\":\"ios\",\"version\":\"1.1.0\",\"minVersion\":\"1.2.0\",\"recommendedVersion\":\"1.3.0\",\"storeUrl\":\"https://apps.apple.com/jp/app/id1234567890\"}}}";
        internal const string Status = "{\"serverNowMs\":1794330000000,\"active\":[],\"upcoming\":[{\"id\":\"m-1112\",\"scope\":\"all\",\"startAt\":1794416400000,\"endAt\":1794430800000,\"announceAt\":1794330000000,\"startJst\":\"11/12 02:00\",\"endJst\":\"11/12 06:00\",\"message\":\"11/12 2:00〜6:00 にメンテナンスを行います。\",\"status\":\"announced\"}],\"client\":{\"platform\":\"ios\",\"version\":\"1.2.1\",\"status\":\"recommended\",\"minVersion\":\"1.2.0\",\"recommendedVersion\":\"1.3.0\",\"storeUrl\":\"https://apps.apple.com/jp/app/id1234567890\",\"minEngineLevel\":1}}";

        [Fact]
        public async Task EveryRequestCarriesThePlatformVersionAndEngineLevel()
        {
            _http.Reply(200, "{\"ok\":true}");
            await _api.HealthAsync();
            var h = _http.Requests[0].Headers;
            Assert.Equal("ios", h["x-client-platform"]);
            Assert.Equal("1.1.0", h["x-client-version"]);
            Assert.Equal(EngineInfo.Level.ToString(), h["x-engine-level"]);
        }

        [Fact]
        public async Task MaintenanceIsNotRetriedAndRaisesTheEventOnce()
        {
            MaintenanceInfo seen = null;
            int events = 0;
            _api.MaintenanceDetected += i => { seen = i; events++; };
            _http.Reply(503, Maint503);
            var e = await Assert.ThrowsAsync<MaintenanceException>(() => _api.GetGachaStatusAsync());
            Assert.Single(_http.Requests); // a GET is normally retried on 5xx — not on MAINTENANCE
            Assert.Equal(ApiErrorCode.Maintenance, e.Code);
            Assert.Equal("m-1112", e.Info.WindowId);
            Assert.Equal("gacha", e.Info.Group);
            Assert.Equal(new[] { "shop", "gacha" }, e.Info.Scope);
            Assert.False(e.Info.All);
            Assert.Equal("11/12 06:00", e.Info.EndsAtJst);
            Assert.Equal(12600, e.Info.RetryAfterSec);
            Assert.Equal(1, events);
            Assert.Same(e.Info, seen);
            Assert.Equal(OutageKind.Maintenance, _api.Outage);
            Assert.Same(e.Info, _api.LastMaintenance);
        }

        [Fact]
        public async Task OtherServerErrorsAreStillRetried()
        {
            _http.Reply(503, "{\"error\":{\"code\":\"VERIFIER_UNAVAILABLE\"}}").Reply(200, "{\"ok\":true}");
            Assert.True(await _api.HealthAsync());
            Assert.Equal(2, _http.Requests.Count);
            Assert.Equal(OutageKind.None, _api.Outage);
        }

        [Fact]
        public async Task UpgradeRequiredCarriesTheStoreUrl()
        {
            UpgradeInfo seen = null;
            _api.UpgradeRequired += i => seen = i;
            _http.Reply(426, Upgrade426);
            var e = await Assert.ThrowsAsync<UpgradeRequiredException>(() => _api.GetPlayerAsync());
            Assert.Single(_http.Requests);
            Assert.Equal("version", e.Info.Reason);
            Assert.Equal("1.2.0", e.Info.MinVersion);
            Assert.Equal("https://apps.apple.com/jp/app/id1234567890", e.Info.StoreUrl);
            Assert.Same(e.Info, seen);
            Assert.Equal(OutageKind.UpgradeRequired, _api.Outage);
        }

        [Fact]
        public async Task OfflineAndMaintenanceAreDifferent()
        {
            _http.Fail(new IOException("down")).Fail(new IOException("down")).Fail(new IOException("down")).Fail(new IOException("down"));
            await Assert.ThrowsAsync<NetworkException>(() => _api.HealthAsync());
            Assert.Equal(OutageKind.Offline, _api.Outage);
            Assert.Null(_api.LastMaintenance);
            _http.Reply(503, Maint503);
            await Assert.ThrowsAsync<MaintenanceException>(() => _api.HealthAsync());
            Assert.Equal(OutageKind.Maintenance, _api.Outage);
            _http.Reply(200, "{\"ok\":true}");
            await _api.HealthAsync();
            Assert.Equal(OutageKind.None, _api.Outage);
            Assert.Null(_api.LastMaintenance);
        }

        [Fact]
        public async Task StatusParsesWindowsAndTheClientStanding()
        {
            _http.Reply(200, Status);
            var s = await _api.GetMaintenanceAsync();
            Assert.Equal("/v1/maintenance", _http.Requests[0].Path);
            Assert.False(_http.Requests[0].Headers.ContainsKey("authorization"));
            Assert.Empty(s.Active);
            var w = Assert.Single(s.Upcoming);
            Assert.True(w.All);
            Assert.False(w.Active);
            Assert.Equal("11/12 02:00", w.StartJst);
            Assert.True(s.Client.Recommended);
            Assert.False(s.Client.Required);
            Assert.Equal("1.3.0", s.Client.RecommendedVersion);
        }

        [Fact]
        public void VersionsCompareNumerically()
        {
            Assert.Equal(1, ClientVersion.Compare("1.10.0", "1.9.9"));
            Assert.Equal(0, ClientVersion.Compare("2.0.0", "2.0.0"));
            Assert.Equal(-1, ClientVersion.Compare("garbage", "0.0.0"));
            Assert.Null(ClientVersion.Parse("1.2"));
            Assert.Null(ClientVersion.Parse("1.2.x"));
        }

        [Fact]
        public void WireCodesAndCloseCodeAreKnown()
        {
            Assert.Equal(ApiErrorCode.Maintenance, ApiErrorCodes.Parse("MAINTENANCE"));
            Assert.Equal(ApiErrorCode.UpgradeRequired, ApiErrorCodes.Parse("UPGRADE_REQUIRED"));
            Assert.Equal("VERSION_MISMATCH", CloseCodes.FatalReason(CloseCodes.VersionMismatch));
            Assert.Equal(4026, CloseCodes.VersionMismatch);
        }

        [Fact]
        public void HelloCarriesTheEngineLevel()
        {
            var t = new CapturingTransport();
            var c = new LockstepClient(t, "r1", "tok");
            c.Connect();
            var hello = JsonNode.Parse(t.Sent[0]);
            Assert.Equal("hello", hello.Get("t").AsString());
            Assert.Equal(EngineInfo.Level, hello.Get("engine").AsInt());
        }

        private sealed class CapturingTransport : ITransport
        {
            public readonly List<string> Sent = new List<string>();
            public void Send(string message) => Sent.Add(message);
        }
    }
}
