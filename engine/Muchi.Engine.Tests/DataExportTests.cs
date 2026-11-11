using System;
using System.Threading.Tasks;
using Muchi.Client;
using Xunit;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-DEX-018: /v1/player/data-export client methods (contracts/protocol.md §51).</summary>
    public class DataExportTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public DataExportTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test/" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        // shaped like the real server's answer (DataExportService.view) for a ready export
        internal const string Ready = "{\"enabled\":true,\"status\":\"ready\",\"statusText\":\"Ready to download\",\"requestId\":\"dex_abc123\",\"requestedAt\":1794790800000,\"readyAt\":1794790860000,\"expiresAt\":1795395660000,\"sizeBytes\":48211,\"canRequest\":false,\"nextAvailableAt\":null,\"keepDays\":7,\"deletionScheduled\":false,\"deletionNote\":null,\"linkNote\":\"Download links stop working after 10 minutes. Do not send the links to anyone else.\",\"notice\":\"Download a copy…\",\"download\":{\"json\":{\"url\":\"/v1/data-export/file?p=u1&r=dex_abc123&f=json&e=1794791460000&s=abc\"},\"summary\":{\"url\":\"/v1/data-export/file?p=u1&r=dex_abc123&f=summary&e=1794791460000&s=def\"},\"linkExpiresAt\":1794791460000}}";

        [Fact]
        public async Task ParsesAReadyExportAndBuildsAbsoluteLinks()
        {
            _http.Reply(200, Ready);
            var v = await _api.GetDataExportAsync();
            Assert.Equal("GET", _http.Requests[0].Method);
            Assert.Equal("/v1/player/data-export", _http.Requests[0].Path);
            Assert.True(v.Ready);
            Assert.Equal("dex_abc123", v.RequestId);
            Assert.Equal(48211, v.SizeBytes);
            Assert.Equal(1794791460000, v.LinkExpiresAt);
            Assert.Null(v.NextAvailableAt);
            Assert.Equal("https://api.example.test/v1/data-export/file?p=u1&r=dex_abc123&f=json&e=1794791460000&s=abc", _api.DataExportFileUrl(v.JsonPath));
            Assert.Null(_api.DataExportFileUrl(null));
            Assert.Throws<ArgumentException>(() => _api.DataExportFileUrl("https://evil.example/x"));
        }

        [Fact]
        public async Task RequestCarriesAnIdempotencyKeyAndNoBody()
        {
            _http.Reply(200, "{\"enabled\":true,\"status\":\"queued\",\"requestId\":\"dex_q\",\"canRequest\":false,\"created\":true,\"download\":null}");
            var v = await _api.RequestDataExportAsync();
            Assert.Equal("POST", _http.Requests[0].Method);
            Assert.True(_http.Requests[0].Headers.ContainsKey("idempotency-key"));
            Assert.Null(_http.Requests[0].Body);
            Assert.True(v.Created);
            Assert.True(DataExportStatuses.Preparing(v.Status));
            Assert.False(v.Ready);
        }

        [Fact]
        public async Task CooldownIsTypedWithTheDate()
        {
            _http.Reply(429, "{\"error\":{\"code\":\"DATA_EXPORT_COOLDOWN\",\"message\":\"later\",\"details\":{\"availableAt\":1795395600000}}}");
            var e = await Assert.ThrowsAsync<DataExportCooldownException>(() => _api.RequestDataExportAsync("k1"));
            Assert.Equal(1795395600000, e.AvailableAt);
            Assert.Equal(ApiErrorCode.DataExportCooldown, e.Code);
            Assert.Equal(ApiErrorCode.LinkExpired, ApiErrorCodes.Parse("LINK_EXPIRED"));
            Assert.Equal(ApiErrorCode.LinkInvalid, ApiErrorCodes.Parse("LINK_INVALID"));
        }

        [Fact]
        public void ActivityKnowsTheNewKindAndScreen()
        {
            Assert.Contains("data_export_ready", ActivityKinds.All);
            Assert.Contains("privacy", ActivityScreens.All);
        }
    }
}
