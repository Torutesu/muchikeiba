using System.Text.Json;
using Muchi.Client;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-DEV-001..020: /v1/account/devices client methods, the labels and SESSION_REVOKED (contracts/protocol.md §70).</summary>
    public class ApiClientDevicesTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly FakeAuth _auth = new FakeAuth();
        private readonly ApiClient _api;

        public ApiClientDevicesTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, _auth, opt, new FakeDelay(), new SeqIds());
        }

        // the shape of the real server's devicesView / securityLogView (server/src/domain/devices.ts)
        internal const string List = "{\"enabled\":true,\"current\":\"s_3f9a0c1d2e4b5a69\",\"sessions\":[" +
            "{\"sessionId\":\"s_3f9a0c1d2e4b5a69\",\"current\":true,\"platform\":\"ios\",\"osMajor\":18,\"model\":\"iPhone\",\"appVersion\":\"1.4.0\",\"region\":\"JP\",\"firstSeenAt\":1794376800000,\"lastSeenAt\":1794380400000,\"canSignOut\":false,\"availableAt\":null}," +
            "{\"sessionId\":\"s_7b21e0aa94c3d5f1\",\"current\":false,\"platform\":\"android\",\"osMajor\":15,\"model\":\"Pixel\",\"appVersion\":\"1.3.2\",\"region\":\"KR\",\"firstSeenAt\":1793000000000,\"lastSeenAt\":1794200000000,\"canSignOut\":false,\"availableAt\":1794466800000}]," +
            "\"signOutOthers\":{\"allowed\":false,\"availableAt\":1794466800000,\"count\":1},\"revokesToday\":0,\"revokesPerDay\":10,\"trustAfterHours\":24,\"anonymousOnly\":true,\"lastTransferredAt\":null,\"recorded\":true,\"newDevice\":false}";
        internal const string Log = "{\"enabled\":true,\"logDays\":180,\"items\":[" +
            "{\"at\":1794380400000,\"kind\":\"new_device\",\"text\":\"新しい端末でログインがありました\",\"device\":{\"platform\":\"android\",\"osMajor\":15,\"model\":\"Pixel\",\"region\":\"JP\"}}," +
            "{\"at\":1794300000000,\"kind\":\"transfer_issued\",\"text\":\"引き継ぎコードを発行しました（パスワードを設定）\",\"mode\":\"custom\"}," +
            "{\"at\":1794200000000,\"kind\":\"signout_others\",\"text\":\"この端末以外をすべてログアウトしました\",\"count\":2}]}";

        [Fact]
        public void LabelsAndModelFamilyMatchTheServer()
        {
            Assert.Equal("iPhone", DeviceCheckin.ModelFamily("iPhone15,2"));
            Assert.Equal("Pixel Pro", DeviceCheckin.ModelFamily("Pixel 8 Pro"));
            Assert.Equal("SM S B", DeviceCheckin.ModelFamily("SM-S918B"));
            Assert.Null(DeviceCheckin.ModelFamily("123"));
            Assert.Equal(24, DeviceCheckin.ModelFamily(new string('A', 60))!.Length);
            Assert.Equal(18, DeviceCheckin.MajorOf("18.1.2"));
            Assert.Null(DeviceCheckin.MajorOf("abc"));
            Assert.Null(DeviceCheckin.MajorOf("123.0"));
            Loc.SetLocale("ja");
            Assert.Equal("iPhone（iOS 18）", DeviceLabel.Name("ios", 18, "iPhone"));
            Assert.Equal("Androidの端末", DeviceLabel.Name("android", null, null));
            Assert.Equal("端末", DeviceLabel.Name("other", null, null));
            Assert.Equal("日本", DeviceLabel.Region("JP"));
            Assert.Equal("KR", DeviceLabel.Region("KR"));
            Assert.Null(DeviceLabel.Region(null));
            try
            {
                Loc.SetLocale("en");
                Assert.Equal("Pixel (Android 15)", DeviceLabel.Name("android", 15, "Pixel"));
                Assert.Equal("iOS 18 device", DeviceLabel.Name("ios", 18, null));
                Assert.Equal("Japan", DeviceLabel.Region("JP"));
            }
            finally { Loc.SetLocale("ja"); }
        }

        [Fact]
        public async Task CheckinSendsTheCoarseLabelAndTheInstallHeader()
        {
            _http.Reply(200, List);
            var r = await _api.CheckinDeviceAsync(new DeviceCheckin { Platform = DevicePlatforms.Ios, OsMajor = 18, Model = "iPhone15,2", AppVersion = "1.4.0" }, "install-aaaa-0001");
            var q = _http.Requests[0];
            Assert.Equal("POST", q.Method);
            Assert.Equal("/v1/account/devices/checkin", q.Path);
            Assert.Equal("install-aaaa-0001", q.Headers["x-install-id"]);
            using (var b = JsonDocument.Parse(q.Body))
            {
                Assert.Equal("ios", b.RootElement.GetProperty("platform").GetString());
                Assert.Equal("iPhone", b.RootElement.GetProperty("model").GetString()); // digits never leave the device
                Assert.Equal(18, b.RootElement.GetProperty("osMajor").GetInt32());
            }
            Assert.True(r.Recorded);
            Assert.Equal("s_3f9a0c1d2e4b5a69", r.CurrentSession!.SessionId);
            Assert.Single(r.Others);
            Assert.Equal(1794466800000, r.Others[0].AvailableAt);
            Assert.False(r.SignOutOthers.Allowed);
            Assert.True(r.AnonymousOnly);
            Assert.Equal(24, r.TrustAfterHours);
        }

        [Fact]
        public async Task SignOutsAreConfirmedAndNotRetried()
        {
            _http.Reply(200, "{\"signedOut\":1,\"devices\":" + List + "}").Reply(429, "{\"error\":{\"code\":\"RATE_LIMITED\",\"message\":\"今日はこれ以上ログアウトできません\"}}");
            var r = await _api.SignOutDeviceAsync("s_7b21e0aa94c3d5f1");
            Assert.Equal("/v1/account/devices/s_7b21e0aa94c3d5f1/signout", _http.Requests[0].Path);
            using (var b = JsonDocument.Parse(_http.Requests[0].Body)) Assert.True(b.RootElement.GetProperty("confirm").GetBoolean());
            Assert.Equal(1, r.SignedOut);
            Assert.Equal(2, r.Devices.Sessions.Count);
            await Assert.ThrowsAsync<RateLimitedException>(() => _api.SignOutOtherDevicesAsync());
            Assert.Equal(2, _http.Requests.Count); // the 429 was not retried
            Assert.Equal("/v1/account/devices/signout-others", _http.Requests[1].Path);
        }

        [Fact]
        public async Task RefusedSignOutsCarryTheirDetails()
        {
            _http.Reply(403, "{\"error\":{\"code\":\"DEVICE_SIGNOUT_TOO_SOON\",\"message\":\"x\",\"details\":{\"availableAt\":1794466800000,\"trustAfterHours\":24}}}")
                 .Reply(409, "{\"error\":{\"code\":\"DEVICE_IS_CURRENT\",\"message\":\"x\"}}");
            var e = await Assert.ThrowsAsync<DeviceSignOutException>(() => _api.SignOutDeviceAsync("s_3f9a0c1d2e4b5a69"));
            Assert.Equal(ApiErrorCode.DeviceSignoutTooSoon, e.Code);
            Assert.Equal(1794466800000, e.AvailableAt);
            Assert.Equal(24, e.TrustAfterHours);
            var c = await Assert.ThrowsAsync<DeviceSignOutException>(() => _api.SignOutDeviceAsync("s_3f9a0c1d2e4b5a69"));
            Assert.Equal(ApiErrorCode.DeviceIsCurrent, c.Code);
        }

        [Fact]
        public async Task SecurityLogParses()
        {
            _http.Reply(200, Log);
            var l = await _api.GetSecurityLogAsync();
            Assert.Equal("/v1/account/security-log", _http.Requests[0].Path);
            Assert.Equal(3, l.Items.Count);
            Assert.Equal(SecurityEventKinds.NewDevice, l.Items[0].Kind);
            Assert.Equal("Pixel", l.Items[0].Device!.Model);
            Assert.Equal("custom", l.Items[1].Mode);
            Assert.Equal(2, l.Items[2].Count);
            Assert.Null(l.Items[1].Device);
        }

        [Fact]
        public async Task SessionRevokedIsNotRetriedAndRaisesTheEvent()
        {
            int revoked = 0, replaced = 0;
            _api.SessionRevoked += () => revoked++;
            _api.SessionReplaced += () => replaced++;
            _http.Reply(401, "{\"error\":{\"code\":\"SESSION_REVOKED\",\"message\":\"この端末はログアウトされました\"}}");
            await Assert.ThrowsAsync<SessionRevokedException>(() => _api.GetDevicesAsync());
            Assert.Single(_http.Requests); // no token refresh round trip
            Assert.Equal(0, _auth.Forced);
            Assert.Equal((1, 0), (revoked, replaced));
        }

        [Fact]
        public void DeviceListViewEvent()
        {
            var e = AnalyticsEvent.DeviceListView(1794380400000, "log", 3);
            Assert.Equal("device_list_view", e.Name);
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.DeviceListView(0, "home", 1));
            Assert.Throws<ArgumentOutOfRangeException>(() => AnalyticsEvent.DeviceListView(0, "devices", 201));
            Assert.Contains(ActivityKinds.NewDevice, ActivityKinds.All);
            Assert.Contains(ActivityScreens.Devices, ActivityScreens.All);
        }
    }
}
