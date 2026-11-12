// ログイン中の端末とセキュリティ (REQ-DEV-001..020, contracts/protocol.md §70): DeviceSessionsModel over a fake API (list, confirm
// sheets, sign-outs and their refusals, the log, KPI), the SESSION_REVOKED screen in MaintenanceModel through the ApiClient's one
// place, AccountChangeReset forgetting the cached list, English UI text.
using Muchi.Client;
using Muchi.Game;
using Muchi.Net;

static class DevicesChecks
{
    sealed class FakeApi : IDeviceSessionsApi
    {
        public readonly List<string> Calls = new List<string>();
        public DeviceSessionList List = Sample();
        public Queue<Exception> Errors = new Queue<Exception>();
        public Task<DeviceSessionList> CheckinDeviceAsync(DeviceCheckin device, string installId = null, CancellationToken ct = default) { Calls.Add("checkin:" + device.Platform + ":" + installId); return Task.FromResult(List); }
        public Task<DeviceSessionList> GetDevicesAsync(CancellationToken ct = default) { Calls.Add("list"); return Task.FromResult(List); }
        public Task<DeviceSignOutResult> SignOutDeviceAsync(string sessionId, CancellationToken ct = default)
        {
            Calls.Add("signout:" + sessionId);
            if (Errors.Count > 0) throw Errors.Dequeue();
            List.Sessions.RemoveAll((s) => s.SessionId == sessionId);
            return Task.FromResult(new DeviceSignOutResult { SignedOut = 1, Devices = List });
        }
        public Task<DeviceSignOutResult> SignOutOtherDevicesAsync(CancellationToken ct = default)
        {
            Calls.Add("others");
            if (Errors.Count > 0) throw Errors.Dequeue();
            int n = List.Sessions.RemoveAll((s) => !s.Current);
            List.SignOutOthers = new SignOutOthersInfo { Allowed = false, Count = 0 };
            return Task.FromResult(new DeviceSignOutResult { SignedOut = n, Devices = List });
        }
        public Task<SecurityLog> GetSecurityLogAsync(CancellationToken ct = default)
        {
            Calls.Add("log");
            return Task.FromResult(new SecurityLog { Enabled = true, LogDays = 180, Items = { new SecurityLogItem { Kind = SecurityEventKinds.NewDevice, Text = "新しい端末でログインがありました", At = 1794380400000 } } });
        }
    }

    static DeviceSessionList Sample() => new DeviceSessionList
    {
        Enabled = true, Current = "s_a", TrustAfterHours = 24, RevokesPerDay = 10, AnonymousOnly = true,
        SignOutOthers = new SignOutOthersInfo { Allowed = true, Count = 2 },
        Sessions =
        {
            new DeviceSession { SessionId = "s_a", Current = true, Platform = "ios", OsMajor = 18, Model = "iPhone", Region = "JP", LastSeenAt = 1794380400000 },
            new DeviceSession { SessionId = "s_b", Platform = "android", OsMajor = 15, Model = "Pixel", Region = "KR", LastSeenAt = 1794200000000, CanSignOut = true },
            new DeviceSession { SessionId = "s_c", Platform = "ios", Model = "iPad", LastSeenAt = 1794100000000, CanSignOut = false, AvailableAt = 1794466800000 },
        },
    };

    sealed class Server401 : IHttp
    {
        public string Code = "SESSION_REVOKED";
        public Task<HttpResponse> SendAsync(HttpRequest request, CancellationToken ct) => Task.FromResult(new HttpResponse(401, "{\"error\":{\"code\":\"" + Code + "\",\"message\":\"x\"}}"));
    }
    sealed class Token : IAuthTokenProvider { public Task<string> GetTokenAsync(bool forceRefresh, CancellationToken ct) => Task.FromResult("t"); }

    public static async Task Run(Action<bool, string> check, string root)
    {
        foreach (var f in new[] { "server-en.json", "ui-en.json" }) Loc.LoadEnglish(File.ReadAllText(Path.Combine(root, "engine", "Muchi.Client", "Resources", "Muchi", f)));
        var api = new FakeApi();
        var events = new List<AnalyticsEvent>();
        bool online = true;
        var m = new DeviceSessionsModel(api, () => online, () => 1794380400000, events.Add);

        await m.LoadAsync();
        check(m.Visible && m.Current?.SessionId == "s_a" && m.Others.Count == 2, "devices: this device first, two others");
        check(DeviceSessionsModel.RowTitle(m.Current) == "iPhone（iOS 18）" && DeviceSessionsModel.RowDetail(m.Others[0]) == "KR・最後の利用：11/9", "devices: row title and detail (region, last used date in JST)");
        check(events.Count == 1 && events[0].Name == "device_list_view", "devices: device_list_view once per load");

        // a row that may not be signed out yet says why; the current row has no button
        check(!m.AskSignOut("s_c") && m.Message == DeviceSessionsModel.TooSoon(24) && m.Confirm == null, "devices: an older device before 24 h → the reason, no sheet");
        check(!m.AskSignOut("s_a") && m.Confirm == null, "devices: this device has no sign-out");

        // confirm sheet → sign out
        check(m.AskSignOut("s_b") && m.Confirm!.Title == "Pixel（Android 15）をログアウトしますか？" && m.Confirm.AnonymousNote == DeviceSessionsModel.AnonymousNote, "devices: confirm sheet names the device and warns an anonymous account");
        m.CancelConfirm();
        check(m.Confirm == null && !api.Calls.Contains("signout:s_b"), "devices: やめる sends nothing");
        m.AskSignOut("s_b");
        check(await m.ConfirmSignOutAsync() && m.Message == DeviceSessionsModel.SignedOutText && m.Others.Count == 1 && api.Calls.Contains("signout:s_b"), "devices: ログアウトする signs the device out and refreshes the list");

        // refusals from the server
        api.List = Sample();
        await m.LoadAsync();
        api.Errors.Enqueue(new DeviceSignOutException(ApiErrorCode.DeviceSignoutTooSoon, "DEVICE_SIGNOUT_TOO_SOON", "x", 403, JsonNode.Parse("{\"availableAt\":1,\"trustAfterHours\":24}")));
        m.AskSignOut("s_b");
        check(!await m.ConfirmSignOutAsync() && m.Message == DeviceSessionsModel.TooSoon(24) && m.Confirm == null, "devices: DEVICE_SIGNOUT_TOO_SOON → the 24 h line");
        api.Errors.Enqueue(new RateLimitedException("RATE_LIMITED", "x", 429));
        m.AskSignOut("s_b");
        check(!await m.ConfirmSignOutAsync() && m.Message == DeviceSessionsModel.LimitText, "devices: RATE_LIMITED → today's limit");
        online = false;
        m.AskSignOut("s_b");
        check(!await m.ConfirmSignOutAsync() && m.Message == DeviceSessionsModel.OfflineText, "devices: offline → nothing sent");
        online = true;

        // all the others
        check(m.AskSignOutOthers() && m.Confirm!.SessionId == null && m.Confirm.Body.Contains("一覧にない端末"), "devices: 「この端末以外をすべてログアウト」 sheet says unlisted devices go too");
        check(await m.ConfirmSignOutAsync() && m.Others.Count == 0, "devices: all other devices signed out");
        check(!m.AskSignOutOthers() && m.Message == DeviceSessionsModel.NothingText, "devices: nobody left → no sheet");
        api.List = Sample();
        api.List.SignOutOthers = new SignOutOthersInfo { Allowed = false, AvailableAt = 1794466800000, Count = 2 };
        await m.LoadAsync();
        check(!m.AskSignOutOthers() && m.Message == DeviceSessionsModel.TooSoon(24), "devices: a young device cannot sign out older ones yet");

        await m.LoadLogAsync();
        check(m.Log!.Items.Count == 1 && events.Last().Name == "device_list_view", "devices: the security log and its device_list_view");
        await m.CheckinAsync(new DeviceCheckin { Platform = DevicePlatforms.Android, Model = "Pixel 9" }, "install-1");
        check(api.Calls.Contains("checkin:android:install-1"), "devices: the check-in sends the platform and the install id");

        // SESSION_REVOKED through the ApiClient's one place → the strongest screen, and the account-change reset
        var client = new ApiClient(new Server401(), new Token(), new ApiClientOptions { BaseUrl = "https://x" });
        var maint = new MaintenanceModel(null, "ios");
        maint.Attach(client);
        var reset = new AccountChangeReset { Devices = m };
        reset.Watch(maint);
        try { await client.GetDevicesAsync(); check(false, "SESSION_REVOKED throws"); } catch (SessionRevokedException) { }
        try { await client.GetDevicesAsync(); } catch (SessionRevokedException) { }
        check(maint.Screen == MaintenanceScreen.SessionRevoked && maint.AccountGone && maint.Title == DeviceSessionsModel.RevokedTitle, "revoked: the full-screen notice");
        check(reset.Resets == 1 && m.List == null && m.Log == null, "revoked: AccountChangeReset once, the cached device list forgotten");
        maint.OnMaintenance(new MaintenanceInfo { WindowId = "m1", Group = "gacha", Scope = { "all" } });
        maint.OnOffline();
        check(maint.Screen == MaintenanceScreen.SessionRevoked, "revoked: maintenance and offline never replace it");
        maint.OnSessionReplaced();
        check(maint.Screen == MaintenanceScreen.SessionReplaced, "revoked: SESSION_REPLACED (the account moved) wins over it");
        maint.OnSessionRevoked();
        check(maint.Screen == MaintenanceScreen.SessionReplaced, "revoked: … and is not replaced by it");
        var m2 = new MaintenanceModel(null, "ios");
        m2.OnSessionRevoked();
        m2.LeaveSessionRevoked();
        check(m2.Screen == MaintenanceScreen.None, "revoked: signing in again leaves the screen");

        // English
        try
        {
            Loc.SetLocale("en");
            check(Loc.T(DeviceSessionsModel.RevokedTitle) == "This device was signed out" && !Loc.HasJapanese(Loc.T(DeviceSessionsModel.RevokedBody)), "English: the revoked screen");
            check(Loc.T("Pixel (Android 15)をログアウトしますか？").StartsWith("Sign out ") && Loc.T(DeviceSessionsModel.TooSoon(24)).StartsWith("24 hours"), "English: the confirm title and the 24 h line");
            check(DeviceLabel.Name("ios", 18, null) == "iOS 18 device" && Loc.T(ActivityModel.Labels[ActivityKinds.NewDevice]) == "Account", "English: labels");
        }
        finally { Loc.SetLocale("ja"); }
    }
}
