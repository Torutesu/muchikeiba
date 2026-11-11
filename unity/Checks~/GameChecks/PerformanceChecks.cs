// 画質・省電力・通信量 (REQ-PERF-001..018, contracts/protocol.md §56): PerformanceSettingsModel (device copy, auto by class,
// race / OS low-power switches, Changed only on real changes, perf_setting_change only for a player's change), the boot
// download screen under the data saver (required always, optional held for Wi-Fi with no cellular dialog, low variants,
// a pause when Wi-Fi drops), and StorageModel (rows, the size before 「すべてダウンロード」, cellular confirm / Wi-Fi only,
// clear cache keeps required files), English UI text. Fake CDN, no network.
using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Muchi.Client;
using Muchi.Game;
using Muchi.Net;

static class PerformanceChecks
{
    sealed class Api : IHttp
    {
        public string Json;
        public Task<HttpResponse> SendAsync(HttpRequest r, CancellationToken ct) => Task.FromResult(new HttpResponse(200, Json));
    }

    sealed class Cdn : IAssetHttp
    {
        public readonly ConcurrentDictionary<string, byte[]> Files = new ConcurrentDictionary<string, byte[]>();
        public readonly ConcurrentQueue<string> Requested = new ConcurrentQueue<string>();
        public TaskCompletionSource<bool> Gate;
        public async Task<int> GetAsync(AssetHttpRequest r, Func<AssetHttpHead, Stream> open, CancellationToken ct)
        {
            Requested.Enqueue(r.Url);
            if (Gate != null && !r.Url.Contains("default") && !r.Url.Contains("whip")) await Gate.Task.WaitAsync(ct); else await Task.Yield();
            if (!Files.TryGetValue(r.Url, out var d)) { open(new AssetHttpHead { Status = 404 }); return 404; }
            open(new AssetHttpHead { Status = 200, ContentLength = d.Length })?.Write(d, 0, d.Length);
            return 200;
        }
    }

    sealed class NoDelay : IDelay { public Task Delay(int ms, CancellationToken ct) => Task.CompletedTask; }

    static string Sha(byte[] b) { using var h = SHA256.Create(); return AssetCache.Hex(h.ComputeHash(b)); }

    /// <summary>A catalog with low variants for the optional venue and banner, and its CDN.</summary>
    static (string json, Cdn cdn) Serve()
    {
        var cdn = new Cdn();
        var o = JsonNode.Obj();
        o.Set("catalogVersion", 4); o.Set("manifestVersion", 2); o.Set("platform", "android"); o.Set("hash", "cat4");
        o.Set("baseUrl", "https://cdn.test"); o.Set("urlTemplate", "{base}/{platform}/{sha256}/{file}");
        o.Set("policy", JsonNode.Obj().Set("ftueBlockingMaxBytes", 3_000_000).Set("cellularWarnBytes", 100_000).Set("tutorialMaxWaitMs", 3000).Set("maxParallel", 4));
        var arr = JsonNode.Arr();
        void Add(string key, int size, string group, bool required, int lowSize = 0)
        {
            var data = Encoding.UTF8.GetBytes(key + new string('x', size - key.Length));
            var x = JsonNode.Obj();
            x.Set("key", key); x.Set("file", key + ".bundle"); x.Set("sha256", Sha(data)); x.Set("size", data.Length); x.Set("group", group); x.Set("required", required);
            cdn.Files["https://cdn.test/android/" + Sha(data) + "/" + key + ".bundle"] = data;
            if (lowSize > 0)
            {
                var low = Encoding.UTF8.GetBytes(key + new string('l', lowSize - key.Length));
                x.Set("low", JsonNode.Obj().Set("file", key + ".low.bundle").Set("sha256", Sha(low)).Set("size", low.Length));
                cdn.Files["https://cdn.test/android/" + Sha(low) + "/" + key + ".low.bundle"] = low;
            }
            arr.Add(x);
        }
        Add("horse/coat/default", 20_000, AssetGroups.Boot, true);
        Add("sfx/race/whip", 8_000, AssetGroups.Ftue, true);
        Add("scene/venue/minato", 600_000, AssetGroups.Race, false, 150_000);
        Add("banner/gacha/standard", 90_000, AssetGroups.Shop, false, 30_000);
        Add("voice/ja/name/n47ab6ba076960abe", 7_000, AssetGroups.OnDemand, false);
        o.Set("entries", arr);
        return (o.ToString(), cdn);
    }

    static string NewDir() => Path.Combine(Path.GetTempPath(), "muchi-perf-" + Guid.NewGuid().ToString("N"));

    public static async Task Run(Action<bool, string> check)
    {
        // ---------------------------------------------------------------- settings model
        var kv = new MemoryKeyValueStore();
        var events = new List<AnalyticsEvent>();
        var device = new StaticDeviceInfo { Profile = new DeviceProfile { SystemMemoryMb = 2048, ProcessorCount = 8, MaxRefreshHz = 60 } };
        var m = new PerformanceSettingsModel(kv, device, e => events.Add(e), () => 1);
        check(m.DeviceClass == DeviceClass.Low && m.Profile.Tier == QualityTier.Low && m.TargetFrameRate == 30 && m.UrpQualityLevel == 0, "a 2 GB phone: auto = low quality, 30 fps");
        check(events.Count == 0 && kv.Get(PerformanceSettingsModel.KeyBlob) == null, "auto defaults send no KPI and store nothing");
        var rows = m.Rows();
        check(rows.Select(r => r.Key).SequenceEqual(new[] { "graphics", "frameRate", "batterySaver", "dataSaver" }) && rows[0].Choices.Count == 4 && rows[0].Choices[0].Selected, "four rows, auto selected");
        check(rows[0].AutoNote == "自動：低" && rows[1].AutoNote == "自動：30fps", "what auto means on this device: " + rows[0].AutoNote + " / " + rows[1].AutoNote);
        RenderProfile changed = null;
        int changes = 0;
        m.Changed += p => { changed = p; changes++; };
        check(m.Set("graphics", "high") && changed?.Tier == QualityTier.High && m.RenderScale == 1f, "graphics high applies at once");
        check(!m.Set("graphics", "high") && changes == 1, "the same value: no change, no event");
        check(!m.Set("graphics", "ultra") && !m.Set("frameRate", "on"), "unknown values are refused");
        check(events.Count == 1 && events[0].Name == "perf_setting_change" && events[0].PropsJson == "{\"setting\":\"graphics\",\"value\":\"high\",\"deviceClass\":\"low\"}", "perf_setting_change once, with the device class: " + (events.Count > 0 ? events[0].PropsJson : "none"));
        m.Set("frameRate", "60");
        check(m.TargetFrameRate == 60, "frame rate 60");
        m.Set("batterySaver", "on");
        check(m.TargetFrameRate == 30 && m.Profile.BatterySaverActive && !m.Profile.AmbientMotion, "battery saver: 30 fps in menus, no ambient motion");
        m.SetInRace(true);
        check(m.TargetFrameRate == 60, "battery saver keeps the race at its cap (60)");
        m.SetInRace(false);
        check(m.NowLine == "いまの表示：画質 高・30fps・描画 85%・省電力", "now line: " + m.NowLine);
        m.Set("batterySaver", "off");
        m.OnLowPowerModeChanged(true);
        check(m.Profile.BatterySaverActive && m.TargetFrameRate == 30 && m.LowPowerNote != null && !m.Settings.BatterySaver, "the OS low-power mode counts as the battery saver (the setting stays off)");
        m.OnLowPowerModeChanged(false);
        int policyChanges = 0;
        m.DownloadPolicyChanged += () => policyChanges++;
        m.Set("dataSaver", "on");
        check(policyChanges == 1 && m.DownloadPolicy.DataSaver, "data saver raises DownloadPolicyChanged");
        var again = new PerformanceSettingsModel(kv, device);
        check(again.Settings.SameValues(m.Settings) && again.Settings.Graphics == GraphicsQuality.High && again.Settings.DataSaver, "stored on the device and read back at start-up (no server)");
        var a11y = false;
        var withMotion = new PerformanceSettingsModel(new MemoryKeyValueStore(), new StaticDeviceInfo(), null, null, () => a11y);
        check(withMotion.Profile.SpeedLines, "speed lines on a mid device by default");
        a11y = true; withMotion.OnReduceMotionChanged();
        check(!withMotion.Profile.SpeedLines && !withMotion.Profile.FovKick && withMotion.TargetFrameRate == 60, "reduce motion removes motion effects, keeps the frame rate");

        // ---------------------------------------------------------------- boot download screen under the data saver
        {
            var (json, cdn) = Serve();
            var dir = NewDir();
            var cache = new AssetCache(dir, () => long.MaxValue);
            var store = new AssetCatalogStore(new Api { Json = json }, cache, AssetPlatforms.Android, delay: new NoDelay());
            var dl = new AssetDownloader(cdn, cache, new AssetDownloaderOptions { ReserveBytes = 0, HashOnThreadPool = false }, new NoDelay());
            var net = NetworkReach.Cellular;
            var saver = true;
            var pre = new AssetPreloadModel(store, dl, () => net, null, () => 0) { DownloadPolicy = () => new AssetDownloadPolicy(saver) };
            await pre.PrepareAsync();
            await pre.BlockingTask;
            check(pre.BlockingDone && pre.CanStartTutorial && cdn.Requested.Any(u => u.Contains("whip")), "data saver on cellular: the required files still download (the tutorial is not held)");
            check(pre.DataSaverHolds && !pre.ShowCellularWarning && !pre.NeedsConsent && pre.Background == BackgroundState.Deferred, "optional files wait for Wi-Fi, with no cellular dialog");
            check(pre.BackgroundBytes == 180_000 && !cdn.Requested.Any(u => u.Contains("minato") || u.Contains("banner")), "nothing optional over cellular; the plan uses the low variants (" + pre.BackgroundSizeLabel + ")");
            check(pre.StatusLine == AssetPreloadModel.TextDataSaverWaiting, "status says what waits: " + pre.StatusLine);
            pre.AcceptCellular();
            check(pre.Background == BackgroundState.Deferred, "no way to start optional downloads over cellular under the data saver");
            net = NetworkReach.Wifi; pre.OnNetworkChanged();
            await pre.BackgroundTask;
            check(pre.Background == BackgroundState.Done && cdn.Requested.Any(u => u.Contains("minato.low.bundle")) && !cdn.Requested.Any(u => u.Contains("minato.bundle")), "on Wi-Fi the low variants download");
            var loc = pre.Resolver.Resolve("scene/venue/minato");
            check(loc.Source == AssetSource.Downloaded && loc.LowRes, "the resolver shows the low variant: " + loc);

            // Wi-Fi drops while the optional set downloads: it pauses and resumes on Wi-Fi
            var (json2, cdn2) = Serve();
            var cache2 = new AssetCache(NewDir(), () => long.MaxValue);
            var dl2 = new AssetDownloader(cdn2, cache2, new AssetDownloaderOptions { ReserveBytes = 0, HashOnThreadPool = false }, new NoDelay());
            var net2 = NetworkReach.Wifi;
            var pre2 = new AssetPreloadModel(new AssetCatalogStore(new Api { Json = json2 }, cache2, AssetPlatforms.Android, delay: new NoDelay()), dl2, () => net2, null, () => 0) { DownloadPolicy = () => new AssetDownloadPolicy(true) };
            cdn2.Gate = new TaskCompletionSource<bool>();
            await pre2.PrepareAsync();
            await pre2.BlockingTask;
            check(pre2.Background == BackgroundState.Running, "on Wi-Fi the optional set starts");
            net2 = NetworkReach.Cellular; pre2.OnNetworkChanged();
            await pre2.BackgroundTask;
            check(pre2.Background == BackgroundState.Deferred && pre2.BackgroundBytes > 0, "Wi-Fi → cellular under the data saver: paused (" + pre2.Background + ")");
            cdn2.Gate = null;
            net2 = NetworkReach.Wifi; pre2.OnNetworkChanged();
            await pre2.BackgroundTask;
            check(pre2.Background == BackgroundState.Done, "and resumed on Wi-Fi");

            // data saver off: the §16 behaviour, normal files, the cellular dialog over the threshold
            var (json3, cdn3) = Serve();
            var cache3 = new AssetCache(NewDir(), () => long.MaxValue);
            var dl3 = new AssetDownloader(cdn3, cache3, new AssetDownloaderOptions { ReserveBytes = 0, HashOnThreadPool = false }, new NoDelay());
            var pre3 = new AssetPreloadModel(new AssetCatalogStore(new Api { Json = json3 }, cache3, AssetPlatforms.Android, delay: new NoDelay()), dl3, () => NetworkReach.Cellular, null, () => 0) { DownloadPolicy = () => new AssetDownloadPolicy(false) };
            await pre3.PrepareAsync();
            check(pre3.NeedsConsent && pre3.BackgroundBytes == 690_000, "data saver off: normal files and the cellular dialog as before");

            // ---------------------------------------------------------------- storage screen
            var kpi = new List<AnalyticsEvent>();
            var snet = NetworkReach.Cellular;
            var ssaver = true;
            var st = new StorageModel(dl, () => pre.Catalog, () => snet, () => new AssetDownloadPolicy(ssaver), e => kpi.Add(e), () => 7);
            var lines = st.Lines();
            check(lines.Count == 6 && lines[0].Kind == "required" && lines[0].Bytes == 28_000, "rows: required first (" + lines[0].SizeLabel + ")");
            check(st.Report.Row("low").Bytes == 180_000 && st.TotalLabel == "合計 208KB", "low variants counted; total " + st.TotalLabel);
            check(st.PredownloadBytes == 7_000 && st.PredownloadLabel == "あと 7KB", "download all: what is still missing (the voice name): " + st.PredownloadLabel);
            check(!st.CanPredownload && st.PredownloadBlockedReason == StorageModel.TextNeedsWifi, "cellular + data saver: Wi-Fi only");
            ssaver = false; st.Refresh();
            check(st.PredownloadBytes == 697_000 && st.CanPredownload, "data saver off: the normal files are still missing (" + st.PredownloadLabel + ")");
            await st.StartPredownloadAsync();
            check(st.State == PredownloadState.NeedsConfirm && st.CellularConfirmText.Contains("697KB") && kpi.Count == 0, "cellular: asks first with the size (" + st.CellularConfirmText + ")");
            st.CancelConfirm();
            check(st.State == PredownloadState.Idle && kpi.Count == 0, "やめる: nothing starts, no KPI");
            await st.StartPredownloadAsync(confirmed: true);
            await st.PredownloadTask;
            check(st.State == PredownloadState.Done && st.PredownloadBytes == 0 && st.Message == StorageModel.TextDone && st.Progress == 1f, "downloaded: nothing left (" + st.Message + ")");
            check(kpi.Count == 1 && kpi[0].PropsJson == "{\"bucket\":\"lt_10mb\",\"variant\":\"full\"}", "asset_predownload once: " + (kpi.Count > 0 ? kpi[0].PropsJson : "none"));
            check(st.ClearConfirmText != null && st.ClearConfirmText.Contains(StorageModel.Size(st.Report.ClearableBytes)), "clear asks first with the size: " + st.ClearConfirmText);
            var freed = st.ClearCache();
            check(freed.Bytes == 180_000 + 697_000 && st.Report.Row("required").Bytes == 28_000 && st.Report.ClearableBytes == 0, "clear cache: optional and low files go, required files stay (" + st.Message + ")");
            check(new AssetResolver(pre.Catalog, cache, null).Resolve("horse/coat/default").Source == AssetSource.Downloaded, "a required asset still resolves after clearing");
            check(st.ClearConfirmText == null && st.ClearCache().Bytes == 0 && st.Message == StorageModel.TextNothingToClear, "nothing left to clear");
            // QA: 「キャッシュを削除」 is not offered while 「すべてダウンロード」 runs (it would delete what the run just fetched)
            cdn.Gate = new TaskCompletionSource<bool>();
            var run = st.StartPredownloadAsync(confirmed: true);
            check(st.State == PredownloadState.Running && !st.CanClear && st.ClearConfirmText == null && st.ClearCache().Bytes == 0 && !st.CanPredownload, "no clearing and no second start while download-all runs");
            cdn.Gate.SetResult(true); cdn.Gate = null;
            await run;
            check(st.State == PredownloadState.Done && st.PredownloadBytes == 0 && kpi.Count == 2, "the second run finished (asset_predownload once per start)");
            try { Directory.Delete(dir, true); } catch (IOException) { }
        }

        // ---------------------------------------------------------------- English
        Loc.SetLocale("en");
        try
        {
            var en = new PerformanceSettingsModel(new MemoryKeyValueStore(), new StaticDeviceInfo());
            var texts = en.Rows().SelectMany(r => new[] { r.Label, r.Description, r.AutoNote }.Concat(r.Choices.Select(c => c.Label))).Where(t => t != null).ToList();
            texts.Add(en.NowLine);
            texts.AddRange(new[] { PerformanceSettingsModel.TextTitle, PerformanceSettingsModel.TextSubtitle, PerformanceSettingsModel.TextGroupDisplay, PerformanceSettingsModel.TextGroupData,
                PerformanceSettingsModel.TextOsLowPower, PerformanceSettingsModel.TextFairness, PerformanceSettingsModel.TextStorage,
                StorageModel.TextTitle, StorageModel.TextSubtitle, StorageModel.TextRequired, StorageModel.TextScreens, StorageModel.TextOnDemand, StorageModel.TextLowRows,
                StorageModel.TextPartial, StorageModel.TextStale, StorageModel.TextPredownload, StorageModel.TextAllDownloaded, StorageModel.TextNeedsWifi, StorageModel.TextOffline,
                StorageModel.TextDownloadNow, StorageModel.TextCancel, StorageModel.TextDone, StorageModel.TextQuota, StorageModel.TextFailed, StorageModel.TextClear, StorageModel.TextClearDo,
                StorageModel.TextNothingToClear, StorageModel.TextLowVariant, AssetPreloadModel.TextDataSaverWaiting }.Select(Loc.T));
            texts.Add(Loc.T(StorageModel.TextTotal).Replace("{size}", "1.0MB"));
            texts.Add(Loc.T(StorageModel.TextPredownloadSize).Replace("{size}", "1.0MB"));
            texts.Add(Loc.T(StorageModel.TextClearConfirm).Replace("{size}", "1.0MB"));
            texts.Add(Loc.T(StorageModel.TextCleared).Replace("{size}", "1.0MB"));
            var jp = texts.Where(Loc.HasJapanese).ToList();
            check(jp.Count == 0, "English: every settings / storage text (" + texts.Count + ")" + (jp.Count > 0 ? " missing: " + string.Join(" | ", jp) : ""));
            check(en.NowLine == "Now: graphics Medium · 60 fps · render 85%", "English now line: " + en.NowLine);
        }
        finally { Loc.SetLocale("ja"); }
    }
}
