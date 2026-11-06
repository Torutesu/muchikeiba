// Boot / FTUE download screen (REQ-DLV-009, AssetPreloadModel): sizes, cellular warning, the tutorial never waits for
// optional assets nor longer than the policy's wait budget, offline start with placeholders. Fake API + fake CDN, no network.
using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Muchi.Client;
using Muchi.Game;
using Muchi.Net;

static class AssetDeliveryChecks
{
    sealed class Api : IHttp
    {
        public Func<HttpRequest, HttpResponse> Handler = _ => new HttpResponse(404, "{}");
        public Task<HttpResponse> SendAsync(HttpRequest r, CancellationToken ct) => Task.FromResult(Handler(r));
    }

    sealed class Cdn : IAssetHttp
    {
        public readonly ConcurrentDictionary<string, byte[]> Files = new ConcurrentDictionary<string, byte[]>();
        public readonly ConcurrentQueue<string> Requested = new ConcurrentQueue<string>();
        /// <summary>URLs containing this text wait until released (a slow CDN).</summary>
        public string SlowMatch;
        public readonly TaskCompletionSource<bool> Release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        public async Task<int> GetAsync(AssetHttpRequest r, Func<AssetHttpHead, Stream> open, CancellationToken ct)
        {
            Requested.Enqueue(r.Url);
            if (SlowMatch != null && r.Url.Contains(SlowMatch)) await Release.Task;
            else await Task.Yield();
            if (!Files.TryGetValue(r.Url, out var d)) { open(new AssetHttpHead { Status = 404 }); return 404; }
            open(new AssetHttpHead { Status = 200, ContentLength = d.Length })?.Write(d, 0, d.Length);
            return 200;
        }
    }

    sealed class NoDelay : IDelay { public Task Delay(int ms, CancellationToken ct) => Task.CompletedTask; }

    static string Sha(byte[] b) { using var h = SHA256.Create(); return AssetCache.Hex(h.ComputeHash(b)); }

    /// <summary>A catalog JSON as the server sends it, and the CDN holding its files.</summary>
    static (string json, Cdn cdn) Serve(long cellularWarnBytes, int tutorialMaxWaitMs, params (string key, int size, string group, bool required)[] entries)
    {
        var cdn = new Cdn();
        var o = JsonNode.Obj();
        o.Set("catalogVersion", 3); o.Set("manifestVersion", 2); o.Set("platform", "android"); o.Set("hash", "cat3");
        o.Set("baseUrl", "https://cdn.test"); o.Set("urlTemplate", "{base}/{platform}/{sha256}/{file}");
        var pol = JsonNode.Obj();
        pol.Set("ftueBlockingMaxBytes", 3_000_000); pol.Set("cellularWarnBytes", cellularWarnBytes); pol.Set("tutorialMaxWaitMs", tutorialMaxWaitMs); pol.Set("maxParallel", 4);
        o.Set("policy", pol);
        var arr = JsonNode.Arr();
        foreach (var e in entries)
        {
            var data = Encoding.UTF8.GetBytes(e.key + new string('x', e.size - e.key.Length));
            var x = JsonNode.Obj();
            x.Set("key", e.key); x.Set("file", e.key + ".bundle"); x.Set("sha256", Sha(data)); x.Set("size", data.Length); x.Set("group", e.group); x.Set("required", e.required);
            arr.Add(x);
            cdn.Files["https://cdn.test/android/" + Sha(data) + "/" + e.key + ".bundle"] = data;
        }
        o.Set("entries", arr);
        return (o.ToString(), cdn);
    }

    static readonly (string, int, string, bool)[] Entries =
    {
        ("horse/coat/default", 20_000, AssetGroups.Boot, true),
        ("sfx/race/default", 5_000, AssetGroups.Boot, true),
        ("sfx/race/whip", 8_000, AssetGroups.Ftue, true),
        ("scene/venue/aoba", 400_000, AssetGroups.Ftue, false),
        ("scene/venue/minato", 600_000, AssetGroups.Race, false),
        ("banner/gacha/standard", 90_000, AssetGroups.Shop, false),
        ("voice/ja/name/n47ab6ba076960abe", 7_000, AssetGroups.OnDemand, false),
    };

    static string NewDir() => Path.Combine(Path.GetTempPath(), "muchi-preload-" + Guid.NewGuid().ToString("N"));

    static AssetPreloadModel Model(string json, Cdn cdn, string dir, Func<NetworkReach> net, Func<long> clock, Func<string, bool> bundled = null, Api api = null)
    {
        api ??= new Api { Handler = _ => new HttpResponse(200, json) };
        var cache = new AssetCache(dir, () => long.MaxValue);
        var store = new AssetCatalogStore(api, cache, AssetPlatforms.Android, delay: new NoDelay());
        var dl = new AssetDownloader(cdn, cache, new AssetDownloaderOptions { ReserveBytes = 0, HashOnThreadPool = false }, new NoDelay());
        return new AssetPreloadModel(store, dl, net, bundled, clock);
    }

    public static async Task Run(Action<bool, string> check)
    {
        // ---- Wi-Fi: sizes, blocking set first, background starts by itself, ondemand never preloaded
        {
            var (json, cdn) = Serve(50_000_000, 3000, Entries);
            long now = 0;
            var m = Model(json, cdn, NewDir(), () => NetworkReach.Wifi, () => now, k => k == "sfx/race/default");
            check(!m.CanStartTutorial && m.StatusLine == AssetPreloadModel.TextChecking, "before the catalog: checking, tutorial not started yet");
            await m.PrepareAsync();
            check(m.BlockingBytes == 28_000, "blocking = required boot/ftue minus bundled (" + m.BlockingSizeLabel + ")");
            check(m.BackgroundBytes == 1_090_000 && m.BackgroundSizeLabel == "1.1MB", "background = optional boot..shop, not ondemand (" + m.BackgroundSizeLabel + ")");
            check(!m.ShowCellularWarning && !m.NeedsConsent, "no cellular dialog on Wi-Fi");
            await m.BlockingTask;
            check(m.BlockingDone && m.CanStartTutorial && m.Phase == PreloadPhase.Ready && m.StatusLine == AssetPreloadModel.TextReady, "blocking set done → tutorial can start (" + m.StatusLine + ")");
            check(m.GroupProgress(AssetGroups.Boot)?.Fraction == 1f, "boot group progress reaches 100%");
            await m.BackgroundTask;
            check(m.Background == BackgroundState.Done && m.BackgroundReport.AllOk, "background set downloaded after the blocking one");
            check(!cdn.Requested.Any(u => u.Contains("voice/ja/name")) && !cdn.Requested.Any(u => u.Contains("sfx/race/default")), "ondemand and bundled keys are not preloaded");
            var res = m.Resolver.Resolve("scene/venue/minato");
            check(res.Source == AssetSource.Downloaded && File.Exists(res.Path), "resolver serves the downloaded file (" + res + ")");
            check(m.Resolver.Resolve("scene/venue/kirameki").Key == null, "no art + no default for scene/venue → nothing, no crash");
            check(m.Resolver.Resolve("sfx/race/countdown").Key == "sfx/race/default", "missing sfx → bundled sfx/race/default");
        }

        // ---- cellular over the threshold: dialog with the size; blocking set still downloads; deferred until consent or Wi-Fi
        {
            var (json, cdn) = Serve(1_000_000, 3000, Entries);
            var net = NetworkReach.Cellular;
            long now = 0;
            var m = Model(json, cdn, NewDir(), () => net, () => now);
            await m.PrepareAsync();
            check(m.ShowCellularWarning && m.NeedsConsent && m.Background == BackgroundState.Deferred, "cellular + 1.1MB > 1MB → Wi-Fi warning, background deferred");
            check(m.CellularWarningText.Contains("1.1MB") && m.CellularWarningText.Contains("Wi-Fi"), "warning shows the size (" + m.CellularWarningText + ")");
            await m.BlockingTask;
            check(m.CanStartTutorial, "tutorial is not held by the cellular dialog");
            m.DeferToWifi();
            check(!m.NeedsConsent && m.Background == BackgroundState.Deferred, "「あとで」: dialog closes, background stays deferred");
            check(!cdn.Requested.Any(u => u.Contains("minato")), "nothing optional downloaded on cellular without consent");
            net = NetworkReach.Wifi;
            m.OnNetworkChanged();
            await m.BackgroundTask;
            check(m.Background == BackgroundState.Done && cdn.Requested.Any(u => u.Contains("minato")), "background resumes by itself on Wi-Fi");

            var (json2, cdn2) = Serve(1_000_000, 3000, Entries);
            var m2 = Model(json2, cdn2, NewDir(), () => NetworkReach.Cellular, () => now);
            await m2.PrepareAsync();
            m2.AcceptCellular();
            await m2.BackgroundTask;
            check(m2.Background == BackgroundState.Done && m2.BackgroundReport.AllOk, "「今すぐ」 on cellular downloads the background set");
        }

        // ---- slow CDN: optional assets never gate; required ones gate at most tutorialMaxWaitMs (server 60 s → capped 5 s)
        {
            var (json, cdn) = Serve(50_000_000, 3000, Entries);
            cdn.SlowMatch = "scene/venue/aoba"; // optional ftue asset stuck
            long now = 0;
            var m = Model(json, cdn, NewDir(), () => NetworkReach.Wifi, () => now);
            await m.PrepareAsync();
            await m.BlockingTask;
            check(m.CanStartTutorial && m.Background == BackgroundState.Running, "an optional FTUE asset still downloading does not hold the tutorial");
            cdn.Release.SetResult(true);
            await m.BackgroundTask;

            var (json2, cdn2) = Serve(50_000_000, 60_000, Entries);
            cdn2.SlowMatch = "sfx/race/whip"; // a required one stuck
            now = 0;
            var m2 = Model(json2, cdn2, NewDir(), () => NetworkReach.Wifi, () => now);
            await m2.PrepareAsync();
            check(m2.Policy.TutorialMaxWaitMs == AssetPolicy.TutorialMaxWaitHardMs, "server wait budget 60 s is capped at " + AssetPolicy.TutorialMaxWaitHardMs + " ms on the client");
            now = 4_999;
            check(!m2.CanStartTutorial && m2.Phase == PreloadPhase.Downloading, "required asset pending: wait (" + m2.StatusLine + ")");
            now = 5_000;
            check(m2.CanStartTutorial && m2.StartedWithPlaceholders, "after the wait budget the tutorial starts with placeholders");
            check(m2.Resolver.Resolve("sfx/race/whip").Key == null || m2.Resolver.Resolve("sfx/race/whip").IsFallback, "the pending key resolves to its fallback meanwhile");
            cdn2.Release.SetResult(true);
            await m2.BlockingTask;
            check(m2.BlockingDone && m2.Resolver.Resolve("sfx/race/whip").Source == AssetSource.Downloaded, "…and to the real file once it lands");
            await m2.BackgroundTask;
        }

        // ---- offline first launch: no catalog at all → start at once with placeholders; later launch offline uses the cached catalog
        {
            var (json, cdn) = Serve(50_000_000, 3000, Entries);
            string dir = NewDir();
            long now = 0;
            var down = new Api { Handler = _ => throw new IOException("offline") };
            var m = Model(json, cdn, dir, () => NetworkReach.None, () => now, k => k.EndsWith("/default"), down);
            await m.PrepareAsync();
            check(m.Phase == PreloadPhase.Offline && m.CanStartTutorial && m.StatusLine == AssetPreloadModel.TextOffline, "offline first launch: tutorial starts immediately (" + m.StatusLine + ")");
            check(m.Resolver.Resolve("horse/coat/bay").Key == "horse/coat/default", "offline: horse/coat/bay → bundled horse/coat/default");
            check(cdn.Requested.IsEmpty, "offline: no download attempted");

            var online = Model(json, cdn, dir, () => NetworkReach.Wifi, () => now);
            await online.PrepareAsync();
            await online.BlockingTask; await online.BackgroundTask;
            var again = Model(json, cdn, dir, () => NetworkReach.None, () => now, null, down);
            await again.PrepareAsync();
            check(again.Catalog.CatalogVersion == 3 && again.BlockingBytes == 0 && again.CanStartTutorial, "offline relaunch uses the cached catalog and the downloaded files");
            check(again.Resolver.Resolve("scene/venue/minato").Source == AssetSource.Downloaded, "offline relaunch: downloaded art is still used");
        }

        check(AssetPreloadModel.FormatBytes(850_000) == "850KB" && AssetPreloadModel.FormatBytes(12_340_000) == "12.3MB" && AssetPreloadModel.FormatBytes(1_500_000_000) == "1.50GB", "size labels (KB / MB / GB)");
    }
}
