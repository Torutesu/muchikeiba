// メンテナンス・強制アップデート (REQ-MNT-004..016, contracts/protocol.md §46): MaintenanceModel over a fake API and a fake
// HTTP. 503 / 426 reach the model through ApiClient's one place (events), scope "all" covers the game and a scoped window
// only the feature, offline is not maintenance, reload leaves the screen when the window is over, the update screen stays
// while the version is below the minimum, the recommended sheet once per version, KPI once per window × group.
using Muchi.Client;
using Muchi.Game;

static class MaintenanceChecks
{
    sealed class FakeApi : IMaintenanceApi
    {
        public MaintenanceStatus Next;
        public bool Offline;
        public int Calls;
        public Task<MaintenanceStatus> GetMaintenanceAsync(CancellationToken ct = default)
        {
            Calls++;
            if (Offline) throw new NetworkException("down", new IOException("down"));
            return Task.FromResult(Next);
        }
    }

    sealed class ScriptHttp : IHttp
    {
        public readonly Queue<HttpResponse> Replies = new Queue<HttpResponse>();
        public int Sent;
        public Task<HttpResponse> SendAsync(HttpRequest r, CancellationToken ct) { Sent++; return Task.FromResult(Replies.Dequeue()); }
    }

    sealed class NoDelay : IDelay { public Task Delay(int ms, CancellationToken ct) => Task.CompletedTask; }

    static MaintenanceStatus Status(string clientStatus, params MaintenanceWindowView[] active) => new MaintenanceStatus
    {
        Active = active.ToList(),
        Client = new ClientVersionStatus { Platform = "ios", Version = "1.2.1", Status = clientStatus, MinVersion = "1.2.0", RecommendedVersion = "1.3.0", StoreUrl = "https://apps.apple.com/jp/app/id1234567890" },
    };
    static MaintenanceWindowView All(string id) => new MaintenanceWindowView { Id = id, Scope = new List<string> { "all" }, StartJst = "11/12 02:00", EndJst = "11/12 06:00", Message = "11/12 2:00〜6:00 にメンテナンスを行います。", Status = "active" };

    public static async Task Run(Action<bool, string> check)
    {
        // ---- 503 / 426 through ApiClient's one place
        var http = new ScriptHttp();
        var client = new ApiClient(http, null, new ApiClientOptions { BaseUrl = "https://x", DevUserId = "p1", Platform = "ios", AppVersion = "1.1.0" }, new NoDelay());
        var fake = new FakeApi { Next = Status("ok") };
        var events = new List<AnalyticsEvent>();
        var m = new MaintenanceModel(fake, "ios", e => events.Add(e), () => 1);
        m.Attach(client);

        http.Replies.Enqueue(new HttpResponse(503, "{\"error\":{\"code\":\"MAINTENANCE\",\"message\":\"メンテナンス中です\",\"details\":{\"windowId\":\"m-gacha\",\"group\":\"gacha\",\"scope\":[\"gacha\"],\"endsAtJst\":\"11/12 06:00\",\"retryAfterSec\":60,\"message\":\"スカウトのメンテナンスです\"}}}"));
        try { await client.GetGachaStatusAsync(); check(false, "503 throws"); } catch (MaintenanceException) { }
        check(http.Sent == 1, "503 MAINTENANCE is not retried");
        check(m.Screen == MaintenanceScreen.None && m.PartialNotice?.Group == "gacha" && m.EndsAt == "11/12 06:00", "a scoped window: a notice over that feature, not the full screen");
        check(MaintenanceModel.GroupsText(m.PartialNotice.Scope) == "スカウト", "closed features read as names (" + MaintenanceModel.GroupsText(m.PartialNotice.Scope) + ")");
        http.Replies.Enqueue(new HttpResponse(503, "{\"error\":{\"code\":\"MAINTENANCE\",\"details\":{\"windowId\":\"m-gacha\",\"group\":\"gacha\",\"scope\":[\"gacha\"],\"endsAtJst\":\"11/12 06:00\"}}}"));
        try { await client.GetGachaStatusAsync(); } catch (MaintenanceException) { }
        check(events.Count(e => e.Name == "maintenance_block") == 1, "maintenance_block once per window × group");
        m.DismissPartial();

        http.Replies.Enqueue(new HttpResponse(503, "{\"error\":{\"code\":\"MAINTENANCE\",\"details\":{\"windowId\":\"m-all\",\"group\":\"core\",\"scope\":\"all\",\"endsAtJst\":\"11/12 06:00\",\"message\":\"11/12 2:00〜6:00 にメンテナンスを行います。\"}}}"));
        try { await client.GetPlayerAsync(); } catch (MaintenanceException) { }
        check(m.Screen == MaintenanceScreen.Maintenance && m.Title == MaintenanceModel.MaintenanceTitle && m.Body.Contains("2:00") && m.EndsAt == "11/12 06:00", "scope all: the maintenance screen with the message and the end time");
        check(client.Outage == OutageKind.Maintenance, "ApiClient.Outage = Maintenance");
        m.OnOffline();
        check(m.Screen == MaintenanceScreen.Maintenance, "offline never replaces the maintenance screen");

        // reload while the window runs, then after it ended
        fake.Next = Status("ok", All("m-all"));
        await m.RefreshAsync();
        check(m.Screen == MaintenanceScreen.Maintenance && m.Banner?.Id == "m-all" && m.BannerTitle == MaintenanceModel.BannerActiveLabel, "reload during the window: still the maintenance screen");
        fake.Next = Status("ok");
        await m.RefreshAsync();
        check(m.Screen == MaintenanceScreen.None && m.Info == null && m.Banner == null, "reload after the window: back to the game");

        // offline is its own screen
        fake.Offline = true;
        await m.RefreshAsync();
        check(m.Screen == MaintenanceScreen.Offline && m.Title == UxText.Offline, "no answer: the offline notice, not maintenance");
        fake.Offline = false;
        await m.RefreshAsync();
        check(m.Screen == MaintenanceScreen.None, "back online: the notice goes");

        // upcoming window: home strip
        fake.Next = Status("ok");
        fake.Next.Upcoming.Add(new MaintenanceWindowView { Id = "m-next", Scope = new List<string> { "all" }, StartJst = "11/12 02:00", EndJst = "11/12 06:00", Message = "x", Status = "announced" });
        await m.RefreshAsync();
        check(m.Banner?.Id == "m-next" && m.BannerTitle == MaintenanceModel.BannerLabel && m.BannerTimes == "11/12 02:00〜11/12 06:00", "announced window: the home strip with its times (" + m.BannerTimes + ")");

        // recommended update: once per version
        fake.Next = Status("recommended");
        await m.RefreshAsync();
        check(m.ShowRecommend && events.Count(e => e.Name == "upgrade_prompt") == 1, "recommended: the sheet and upgrade_prompt shown");
        m.Later();
        check(!m.ShowRecommend && m.DismissedVersion == "1.3.0", "あとで: hidden, the dismissed version is kept");
        await m.RefreshAsync();
        check(!m.ShowRecommend, "not shown again for the same recommended version");

        // 426: the update screen, store button
        http.Replies.Enqueue(new HttpResponse(426, "{\"error\":{\"code\":\"UPGRADE_REQUIRED\",\"message\":\"アプリを最新版に更新してください\",\"details\":{\"reason\":\"version\",\"platform\":\"ios\",\"minVersion\":\"1.2.0\",\"storeUrl\":\"https://apps.apple.com/jp/app/id1234567890\"}}}"));
        try { await client.GetPlayerAsync(); } catch (UpgradeRequiredException) { }
        check(m.Screen == MaintenanceScreen.UpdateRequired && m.Title == MaintenanceModel.UpdateTitle && m.Body == MaintenanceModel.UpdateBody, "426: the update screen");
        int prompts = events.Count(e => e.Name == "upgrade_prompt");
        check(m.OpenStore() == "https://apps.apple.com/jp/app/id1234567890" && events.Count(e => e.Name == "upgrade_prompt") == prompts + 1, "store button: the store URL and upgrade_prompt store");
        fake.Next = Status("required", All("m-x"));
        await m.RefreshAsync();
        check(m.Screen == MaintenanceScreen.UpdateRequired, "the update screen stays while the version is below the minimum (even during a window)");
        fake.Next = Status("ok");
        await m.RefreshAsync();
        check(m.Screen == MaintenanceScreen.None, "the minimum was lowered: the update screen goes");

        // engine mismatch reads differently
        m.OnUpgrade(new UpgradeInfo { Reason = "engine" });
        check(m.Body == MaintenanceModel.EngineBody, "engine: race-specific text");

        // R19 integration (REQ-TRF-010 × REQ-MNT-014): 401 SESSION_REPLACED reaches the same model through ApiClient's one place,
        // never retried; it is the strongest screen (the account lives on another device now): maintenance, update and offline
        // do not replace it and a reload does not leave it — only starting new or redeeming a code does (LeaveSessionReplaced)
        {
            var http2 = new ScriptHttp();
            var c2 = new ApiClient(http2, null, new ApiClientOptions { BaseUrl = "https://x", DevUserId = "p1", Platform = "ios", AppVersion = "1.2.1" }, new NoDelay());
            var m2 = new MaintenanceModel(new FakeApi { Next = Status("ok") }, "ios", null, () => 1);
            m2.Attach(c2);
            http2.Replies.Enqueue(new HttpResponse(401, "{\"error\":{\"code\":\"SESSION_REPLACED\",\"message\":\"moved\"}}"));
            try { await c2.GetPlayerAsync(); check(false, "401 SESSION_REPLACED throws"); } catch (SessionReplacedException) { }
            check(http2.Sent == 1, "SESSION_REPLACED is not retried (no token refresh)");
            check(m2.Screen == MaintenanceScreen.SessionReplaced && m2.Title == TransferCodeModel.ReplacedTitle && m2.Body == TransferCodeModel.ReplacedBody, "SESSION_REPLACED: the moved-to-another-device screen");
            m2.OnMaintenance(new MaintenanceInfo { WindowId = "w", Group = "core", Scope = new List<string> { "all" } });
            m2.OnUpgrade(new UpgradeInfo { Reason = "version" });
            m2.OnOffline();
            await m2.RefreshAsync();
            check(m2.Screen == MaintenanceScreen.SessionReplaced, "maintenance, update, offline and a reload never replace it");
            m2.LeaveSessionReplaced();
            check(m2.Screen == MaintenanceScreen.None, "starting new / redeeming leaves it");
        }

        // English
        Loc.SetLocale("en");
        try
        {
            foreach (var s in new[] { MaintenanceModel.MaintenanceTitle, MaintenanceModel.MaintenanceBody, MaintenanceModel.PartialTitle, MaintenanceModel.PartialBody, MaintenanceModel.EndsLabel, MaintenanceModel.ClosedLabel, MaintenanceModel.PurchaseNote, MaintenanceModel.ReloadCta, MaintenanceModel.UpdateTitle, MaintenanceModel.UpdateBody, MaintenanceModel.EngineBody, MaintenanceModel.StoreCta, MaintenanceModel.RecommendTitle, MaintenanceModel.LaterCta, MaintenanceModel.BannerLabel, MaintenanceModel.GroupsText(new[] { "gacha", "shop" }) })
                check(!Loc.HasJapanese(Loc.T(s)), "English: " + Loc.T(s));
        }
        finally { Loc.SetLocale("ja"); }
    }
}
