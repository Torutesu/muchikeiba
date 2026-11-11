// 個人データの開示・ダウンロード (REQ-DEX-001..020, contracts/protocol.md §51): DataExportModel over a routed fake server.
// Request → preparing (button off) → ready (two downloads, the expiry as a date), the cooldown date, a failed export,
// the deletion note, stale links, offline, and English for every text the model builds.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class DataExportChecks
{
    sealed class FakeServer : IHttp
    {
        public readonly List<HttpRequest> Sent = new List<HttpRequest>();
        public readonly Dictionary<string, Func<HttpRequest, HttpResponse>> Routes = new Dictionary<string, Func<HttpRequest, HttpResponse>>();
        public Task<HttpResponse> SendAsync(HttpRequest r, CancellationToken ct)
        {
            Sent.Add(r);
            if (Routes.TryGetValue(r.Method + " " + r.Path, out var h)) return Task.FromResult(h(r));
            return Task.FromResult(new HttpResponse(404, "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"no route\"}}"));
        }
    }
    sealed class Tokens : IAuthTokenProvider { public Task<string> GetTokenAsync(bool f, CancellationToken ct) => Task.FromResult("tok"); }

    const long Now = 1794790800000L; // 2026-11-16 10:00 JST (expiry / next request: 11-23)
    const string Player = "{\"id\":\"u1\",\"wallet\":{\"paid\":0,\"free\":0,\"total\":0,\"debt\":0},\"season\":{\"id\":\"2026-11\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[],\"equipment\":{\"tack\":{},\"decor\":[]},\"deletion\":{\"status\":\"none\"}}";
    const string None = "{\"enabled\":true,\"status\":\"none\",\"statusText\":\"まだリクエストしていません\",\"requestId\":null,\"canRequest\":true,\"nextAvailableAt\":null,\"keepDays\":7,\"deletionScheduled\":false,\"notice\":\"…\",\"download\":null}";
    const string Queued = "{\"enabled\":true,\"status\":\"queued\",\"statusText\":\"準備しています\",\"requestId\":\"dex_a\",\"canRequest\":false,\"nextAvailableAt\":null,\"keepDays\":7,\"deletionScheduled\":true,\"deletionNote\":\"アカウントの削除を予定しています。削除が終わるまではダウンロードできます。\",\"created\":true,\"download\":null}";
    const string Ready = "{\"enabled\":true,\"status\":\"ready\",\"statusText\":\"ダウンロードできます\",\"requestId\":\"dex_a\",\"expiresAt\":1795395600000,\"sizeBytes\":49152,\"canRequest\":false,\"nextAvailableAt\":null,\"keepDays\":7,\"linkNote\":\"…\",\"download\":{\"json\":{\"url\":\"/v1/data-export/file?p=u1&r=dex_a&f=json&e=1794791400000&s=x\"},\"summary\":{\"url\":\"/v1/data-export/file?p=u1&r=dex_a&f=summary&e=1794791400000&s=y\"},\"linkExpiresAt\":1794791400000}}";
    const string Expired = "{\"enabled\":true,\"status\":\"expired\",\"statusText\":\"ダウンロードの期限が過ぎました\",\"requestId\":\"dex_a\",\"canRequest\":false,\"nextAvailableAt\":1795395600000,\"keepDays\":7,\"download\":null}";
    const string Failed = "{\"enabled\":true,\"status\":\"failed\",\"statusText\":\"準備できませんでした。もう一度リクエストしてください\",\"requestId\":\"dex_a\",\"canRequest\":true,\"nextAvailableAt\":null,\"keepDays\":7,\"download\":null}";

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        var s = new FakeServer();
        string state = None;
        s.Routes["POST /v1/player/bootstrap"] = _ => new HttpResponse(200, Player);
        s.Routes["GET /v1/player"] = _ => new HttpResponse(200, Player);
        s.Routes["GET /v1/player/data-export"] = _ => new HttpResponse(200, state);
        s.Routes["POST /v1/player/data-export"] = _ => { state = Queued; return new HttpResponse(200, Queued); };
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, new MemoryKeyValueStore(), ruleset);
        await b.InitializeAsync();
        long now = Now;
        var m = new DataExportModel(b, () => now);

        var load = await m.LoadAsync();
        check(load.Ok && m.ButtonText == "データをリクエスト" && m.ButtonEnabled && !m.CanDownload && m.DateText == null, "dex: nothing requested → one enabled request button");
        var req = await m.RequestAsync();
        check(req.Ok && m.Preparing && !m.ButtonEnabled && m.ButtonText == "準備しています" && m.Note == DataExportModel.TextPreparingNote, "dex: requested → preparing, button off, the activity note");
        check(s.Sent.Any(r => r.Method == "POST" && r.Path == "/v1/player/data-export" && r.Headers.ContainsKey("idempotency-key")), "dex: the request carries an idempotency key");
        check(m.DeletionNote != null && m.DeletionNote.Contains("削除が終わるまで"), "dex: while the deletion is scheduled the screen says it still works");
        check(!(await m.RequestAsync()).Ok && s.Sent.Count(r => r.Method == "POST" && r.Path == "/v1/player/data-export") == 1, "dex: a second press while preparing sends nothing");

        state = Ready;
        await m.LoadAsync();
        check(m.CanDownload && m.ButtonEnabled && m.ButtonText == "データ（JSON）をダウンロード", "dex: ready → download button");
        check(m.DateText == "11月23日まで" && m.SizeText == "48 KB", "dex: the expiry as a JST date and the size (" + m.DateText + ", " + m.SizeText + ")");
        check(m.DownloadUrl("json") == "http://fake/v1/data-export/file?p=u1&r=dex_a&f=json&e=1794791400000&s=x" && m.DownloadUrl("summary").Contains("f=summary"), "dex: absolute links for the OS browser");
        now = 1794791400000;
        check(m.LinksStale && m.DownloadUrl("json") == null, "dex: a link past its minutes is not handed out (reload first)");

        state = Expired;
        await m.LoadAsync();
        check(!m.ButtonEnabled && m.ButtonText == "もう一度リクエスト" && m.DateText == "次のリクエストは11月23日から", "dex: expired inside the cooldown → the next date, never a countdown (" + m.DateText + ")");
        state = Failed;
        await m.LoadAsync();
        check(m.ButtonEnabled && m.Note == DataExportModel.TextFailedNote, "dex: failed → request again at once");

        s.Routes["POST /v1/player/data-export"] = _ => new HttpResponse(429, "{\"error\":{\"code\":\"DATA_EXPORT_COOLDOWN\",\"message\":\"later\",\"details\":{\"availableAt\":1795395600000}}}");
        var cd = await m.RequestAsync();
        check(!cd.Ok && !m.ButtonEnabled && m.DateText == "次のリクエストは11月23日から", "dex: a cooldown answer shows the date it opens");

        Loc.LoadEnglish(File.ReadAllText(Path.Combine(FindRoot(), "engine", "Muchi.Client", "Resources", "Muchi", "ui-en.json")));
        Loc.SetLocale("en");
        try
        {
            var texts = new[] { DataExportModel.TextTitle, DataExportModel.TextSection, DataExportModel.TextRequest, DataExportModel.TextPreparing, DataExportModel.TextRequestAgain,
                DataExportModel.TextDownloadJson, DataExportModel.TextDownloadSummary, DataExportModel.TextPreparingNote, DataExportModel.TextFailedNote, DataExportModel.TextOffline,
                DataExportModel.TextUnavailable, "次のリクエストは11月23日から", "11月23日まで" };
            var left = texts.Where(t => Loc.HasJapanese(Loc.T(t))).ToList();
            check(left.Count == 0, "dex: every model text has English (" + string.Join(" | ", left) + ")");
            check(Loc.T("次のリクエストは11月23日から") == "Next request from 11/23", "dex: the cooldown date in English (" + Loc.T("次のリクエストは11月23日から") + ")");
        }
        finally { Loc.SetLocale("ja"); }
        var all = string.Join("", new[] { DataExportModel.TextRequest, DataExportModel.TextPreparingNote, DataExportModel.TextFailedNote });
        check(!all.Contains("今だけ") && !all.Contains("残りわずか") && !all.Contains("お得"), "dex: no urgency words");
        // Round 18 integration: the activity entry has its label and icon (it was missing from ActivityModel)
        var line = ActivityModel.LineOf(new ActivityItem { Id = "1", Kind = ActivityKinds.DataExportReady, Screen = ActivityScreens.Privacy, Text = "データのダウンロードの準備ができました" });
        check(line.Label == "データ" && ActivityModel.Icons[ActivityKinds.DataExportReady] == "data", "dex: the activity entry is labelled (" + line.Label + ")");
    }

    static string FindRoot()
    {
        var d = new DirectoryInfo(AppContext.BaseDirectory);
        while (d != null && !File.Exists(Path.Combine(d.FullName, "contracts", "protocol.md"))) d = d.Parent;
        return d!.FullName;
    }
}
