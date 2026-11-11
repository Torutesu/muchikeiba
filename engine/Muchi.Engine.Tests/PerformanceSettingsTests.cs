using System.Security.Cryptography;
using System.Text;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>
    /// 画質・省電力・通信量の設定 (REQ-PERF-001..018, contracts/protocol.md §56): the settings and their stored form, device
    /// classes, the render values (battery saver, reduce motion), the data-saver download policy with low variants, the
    /// storage screen and "clear cache" (never a required or in-flight file), the KPI, and that no setting changes a race.
    /// </summary>
    public class PerformanceSettingsTests : IDisposable
    {
        private readonly string _dir = Path.Combine(Path.GetTempPath(), "muchi-perf-" + Guid.NewGuid().ToString("N"));
        public void Dispose() { try { Directory.Delete(_dir, true); } catch (IOException) { } }

        static string Sha(byte[] b) { using var h = SHA256.Create(); return AssetCache.Hex(h.ComputeHash(b)); }
        static byte[] Bytes(string s, int repeat) => Encoding.UTF8.GetBytes(string.Concat(Enumerable.Repeat(s, repeat)));

        // ------------------------------------------------------------------ settings (REQ-PERF-001/011)

        [Fact]
        public void DefaultsRoundTripAndCorruptValuesFallBack()
        {
            var d = PerformanceSettings.Defaults;
            Assert.Equal(GraphicsQuality.Auto, d.Graphics);
            Assert.Equal(FrameRateCap.Auto, d.FrameRate);
            Assert.False(d.BatterySaver); Assert.False(d.DataSaver);
            var s = new PerformanceSettings { Graphics = GraphicsQuality.High, FrameRate = FrameRateCap.Fps30, BatterySaver = true, DataSaver = true };
            Assert.Equal("{\"graphics\":\"high\",\"frameRate\":\"30\",\"batterySaver\":true,\"dataSaver\":true}", s.ToJson());
            Assert.True(PerformanceSettings.Parse(s.ToJson()).SameValues(s));
            foreach (var bad in new[] { null, "", "not json", "[]", "{\"graphics\":\"ultra\",\"frameRate\":120,\"batterySaver\":\"yes\",\"dataSaver\":1}" })
                Assert.True(PerformanceSettings.Parse(bad).SameValues(PerformanceSettings.Defaults), "falls back for " + bad);
        }

        [Fact]
        public void ApplyAcceptsOnlyKnownWireValues()
        {
            var s = PerformanceSettings.Defaults;
            Assert.True(s.Apply("graphics", "low")); Assert.Equal("low", s.Value("graphics"));
            Assert.True(s.Apply("frameRate", "60")); Assert.Equal("60", s.Value("frameRate"));
            Assert.True(s.Apply("batterySaver", "on")); Assert.Equal("on", s.Value("batterySaver"));
            Assert.True(s.Apply("dataSaver", "on")); Assert.Equal("on", s.Value("dataSaver"));
            var before = s.ToJson();
            Assert.False(s.Apply("graphics", "30"));
            Assert.False(s.Apply("frameRate", "120"));
            Assert.False(s.Apply("batterySaver", "true"));
            Assert.False(s.Apply("resolution", "high"));
            Assert.Equal(before, s.ToJson());
        }

        // ------------------------------------------------------------------ device class (REQ-PERF-002)

        [Theory]
        [InlineData(2048, 8, 0, false, DeviceClass.Low)]   // little memory
        [InlineData(8192, 2, 0, false, DeviceClass.Low)]   // two cores
        [InlineData(8192, 8, 256, false, DeviceClass.Low)] // a tiny GPU
        [InlineData(8192, 8, 0, true, DeviceClass.Low)]    // software rendering
        [InlineData(4096, 6, 0, false, DeviceClass.Mid)]
        [InlineData(6144, 4, 0, false, DeviceClass.Mid)]   // memory but few cores
        [InlineData(8192, 8, 1024, false, DeviceClass.Mid)] // a known mid GPU
        [InlineData(6144, 6, 0, false, DeviceClass.High)]  // unknown GPU memory does not hold a phone back
        [InlineData(12288, 8, 4096, false, DeviceClass.High)]
        public void ClassifiesDevices(int memMb, int cores, int gpuMb, bool software, DeviceClass want)
            => Assert.Equal(want, DeviceClassifier.Classify(new DeviceProfile { SystemMemoryMb = memMb, ProcessorCount = cores, GraphicsMemoryMb = gpuMb, SoftwareRenderer = software }));

        // ------------------------------------------------------------------ render values (REQ-PERF-003/004/016)

        static RenderProfile R(PerformanceSettings s, DeviceClass c = DeviceClass.Mid, bool inRace = false, bool lowPower = false, bool reduce = false, int hz = 60)
            => RenderProfile.Resolve(s, new PerformanceContext { DeviceClass = c, InRace = inRace, OsLowPowerMode = lowPower, ReduceMotion = reduce, MaxRefreshHz = hz });

        [Fact]
        public void AutoFollowsTheDeviceClass()
        {
            var d = PerformanceSettings.Defaults;
            var low = R(d, DeviceClass.Low); var mid = R(d, DeviceClass.Mid); var high = R(d, DeviceClass.High);
            Assert.Equal((QualityTier.Low, 0, 30, 0.70f, ShadowQuality.Off, 0), (low.Tier, low.UrpQualityLevel, low.TargetFrameRate, low.RenderScale, low.Shadows, low.Msaa));
            Assert.Equal((QualityTier.Medium, 1, 60, 0.85f, ShadowQuality.Hard, 2), (mid.Tier, mid.UrpQualityLevel, mid.TargetFrameRate, mid.RenderScale, mid.Shadows, mid.Msaa));
            Assert.Equal((QualityTier.High, 2, 60, 1.00f, ShadowQuality.Soft, 4), (high.Tier, high.UrpQualityLevel, high.TargetFrameRate, high.RenderScale, high.Shadows, high.Msaa));
            Assert.False(low.SpeedLines); Assert.True(mid.SpeedLines && mid.FovKick && mid.AmbientMotion && mid.PostProcessing);
            Assert.Equal(30, R(d, DeviceClass.High, hz: 50).TargetFrameRate); // a 50 Hz display
            Assert.Equal(33, low.FrameIntervalMs); Assert.Equal(16, mid.FrameIntervalMs);
        }

        [Fact]
        public void ExplicitChoicesOverrideTheClass()
        {
            var s = new PerformanceSettings { Graphics = GraphicsQuality.High, FrameRate = FrameRateCap.Fps60 };
            var p = R(s, DeviceClass.Low);
            Assert.Equal(QualityTier.High, p.Tier); Assert.Equal(60, p.TargetFrameRate);
            s = new PerformanceSettings { Graphics = GraphicsQuality.Low, FrameRate = FrameRateCap.Fps30 };
            p = R(s, DeviceClass.High);
            Assert.Equal(QualityTier.Low, p.Tier); Assert.Equal(30, p.TargetFrameRate);
        }

        [Fact]
        public void BatterySaverLowersMenusNotRaces()
        {
            var s = new PerformanceSettings { Graphics = GraphicsQuality.High, FrameRate = FrameRateCap.Fps60, BatterySaver = true };
            var menu = R(s, DeviceClass.High, inRace: false);
            var race = R(s, DeviceClass.High, inRace: true);
            Assert.Equal(30, menu.TargetFrameRate);
            Assert.Equal(60, race.TargetFrameRate); // REQ-PERF-004: the race keeps its cap
            foreach (var p in new[] { menu, race })
            {
                Assert.True(p.BatterySaverActive);
                Assert.Equal(0.5f, p.ParticleScale); Assert.False(p.PostProcessing); Assert.Equal(ShadowQuality.Hard, p.Shadows); Assert.Equal(0.85f, p.RenderScale);
                Assert.False(p.SpeedLines); Assert.False(p.AmbientMotion);
                Assert.True(p.FovKick); // weight, not motion: the FOV kick is the accessibility setting's
            }
            // the OS low-power mode counts as the battery saver without changing the setting
            var os = R(new PerformanceSettings { Graphics = GraphicsQuality.High }, DeviceClass.High, lowPower: true);
            Assert.True(os.BatterySaverActive); Assert.Equal(30, os.TargetFrameRate);
            Assert.False(R(PerformanceSettings.Defaults, DeviceClass.High).BatterySaverActive);
        }

        [Fact]
        public void ReduceMotionAndBatterySaverComposeWithoutOverridingEachOther()
        {
            var plain = R(PerformanceSettings.Defaults, DeviceClass.High);
            var reduced = R(PerformanceSettings.Defaults, DeviceClass.High, reduce: true);
            // reduce motion removes motion, never weight: same fps, scale, shadows, particles
            Assert.Equal((plain.TargetFrameRate, plain.RenderScale, plain.Shadows, plain.ParticleScale, plain.PostProcessing), (reduced.TargetFrameRate, reduced.RenderScale, reduced.Shadows, reduced.ParticleScale, reduced.PostProcessing));
            Assert.False(reduced.SpeedLines || reduced.FovKick || reduced.AmbientMotion);
            // battery saver does not turn reduce motion on (the camera shake / gauge blink stay MotionPolicy's)
            var saver = new PerformanceSettings { BatterySaver = true };
            Assert.False(MotionPolicy.For(false).Reduced);
            var both = R(saver, DeviceClass.High, reduce: true);
            var saverOnly = R(saver, DeviceClass.High);
            Assert.Equal((saverOnly.TargetFrameRate, saverOnly.RenderScale, saverOnly.ParticleScale), (both.TargetFrameRate, both.RenderScale, both.ParticleScale));
            Assert.False(both.SpeedLines || both.FovKick || both.AmbientMotion); // both effects apply
        }

        // ------------------------------------------------------------------ race determinism (REQ-PERF-010)

        /// <summary>
        /// Every combination of the four settings × device class × OS low-power mode drives the same race through the
        /// fixed-step OfflineRace at that profile's frame interval (with a little jitter, as real frames have), inputs on
        /// fixed ticks: every run ends with the same result hash. The settings never reach the engine.
        /// </summary>
        [Fact]
        public void RaceHashIsTheSameForEverySetting()
        {
            var cfg = TestUtil.Cfg(TestUtil.CornerTrack(1200), TestUtil.Ruleset(), Enumerable.Range(0, 6).Select(i => TestUtil.H("h" + i, 480 + i * 7)).ToList(), humans: 1, seed: 5601);
            Assert.Equal(20, cfg.Net.TickHz);
            var script = new Dictionary<int, byte> { [cfg.Ruleset.GateOpenTick + 1] = Cmd.Start, [300] = Cmd.LaneOut, [700] = Cmd.Whip, [760] = Cmd.Whip, [820] = Cmd.Whip, [900] = Cmd.ReinPress, [960] = Cmd.ReinRelease };
            string Run(int frameMs, int jitterSeed)
            {
                var race = new OfflineRace(cfg, 0);
                race.Stepped += r => { if (script.TryGetValue(r.Sim.Tick, out var c)) r.Input(c); };
                var rng = new Random(jitterSeed);
                long t = 1000;
                race.Start(t);
                if (script.TryGetValue(0, out var c0)) race.Input(c0);
                for (int i = 0; i < 200_000 && !race.IsFinished; i++) { t += frameMs + rng.Next(-2, 3); race.Update(t); }
                Assert.True(race.IsFinished);
                return race.ResultHash;
            }

            var reference = new RaceSim(cfg);
            while (!reference.IsFinished) { var cmds = new byte[cfg.Entrants.Count]; if (script.TryGetValue(reference.Tick, out var c)) cmds[0] = c; reference.Step(cmds); }
            string want = reference.Result.Hash;

            int n = 0;
            foreach (GraphicsQuality g in Enum.GetValues(typeof(GraphicsQuality)))
            foreach (FrameRateCap f in Enum.GetValues(typeof(FrameRateCap)))
            foreach (bool saver in new[] { false, true })
            foreach (bool data in new[] { false, true })
            foreach (DeviceClass dc in Enum.GetValues(typeof(DeviceClass)))
            {
                var s = new PerformanceSettings { Graphics = g, FrameRate = f, BatterySaver = saver, DataSaver = data };
                var p = RenderProfile.Resolve(s, new PerformanceContext { DeviceClass = dc, InRace = true, OsLowPowerMode = n % 2 == 1, ReduceMotion = n % 3 == 0 });
                Assert.Equal(want, Run(p.FrameIntervalMs, n));
                n++;
            }
            Assert.Equal(4 * 3 * 2 * 2 * 3, n);
            // a menu-rate (battery saver, 30 fps) and a stuttering 60 fps run: still the same race
            Assert.Equal(want, Run(33, 999));
            Assert.Equal(want, Run(16, 1000));
        }

        // ------------------------------------------------------------------ catalog low variants (REQ-PERF-012)

        static string EntryJson(string key, byte[] data, string group, bool required, byte[] low = null)
        {
            var x = JsonNode.Obj();
            x.Set("key", key); x.Set("file", key + ".bundle"); x.Set("sha256", Sha(data)); x.Set("size", data.Length); x.Set("group", group); x.Set("required", required);
            if (low != null) x.Set("low", JsonNode.Obj().Set("file", key + ".low.bundle").Set("sha256", Sha(low)).Set("size", low.Length));
            return x.ToString();
        }

        static AssetCatalog Catalog(params string[] entries)
            => AssetCatalog.Parse("{\"catalogVersion\":3,\"manifestVersion\":2,\"platform\":\"ios\",\"hash\":\"h3\",\"baseUrl\":\"https://cdn.test\",\"urlTemplate\":\"{base}/{platform}/{sha256}/{file}\",\"entries\":[" + string.Join(",", entries) + "]}");

        static readonly byte[] Venue = Bytes("aoba-venue-full-", 900), VenueLow = Bytes("aoba-low-", 200);
        static readonly byte[] Coat = Bytes("bay-coat-", 400), CoatLow = Bytes("bay-l-", 100);
        static readonly byte[] Voice = Bytes("voice-name-", 120);
        static readonly byte[] Default = Bytes("default-coat-", 100);

        static AssetCatalog Standard() => Catalog(
            EntryJson("horse/coat/default", Default, "boot", true),
            EntryJson("scene/venue/aoba", Venue, "race", false, VenueLow),
            EntryJson("horse/coat/bay", Coat, "home", false, CoatLow),
            EntryJson("voice/ja/name/akatsuki", Voice, "ondemand", false));

        [Fact]
        public void CatalogParsesLowVariantsDefensively()
        {
            var c = Standard();
            var v = c.Find("scene/venue/aoba");
            Assert.NotNull(v.Low);
            Assert.Equal("scene/venue/aoba.low.bundle", v.Low.File);
            Assert.Equal(VenueLow.Length, v.Low.Size);
            Assert.Null(c.Find("voice/ja/name/akatsuki").Low);
            Assert.Contains(Sha(VenueLow), c.ReferencedHashes()); // eviction keeps low variants
            // a low variant on a required entry, larger than the file, or malformed is ignored (the entry stays)
            var bad = Catalog(
                EntryJson("horse/coat/default", Default, "boot", true, Bytes("x", 10)),
                EntryJson("horse/coat/bay", Coat, "home", false, Bytes("bigger-than-the-file-", 400)),
                EntryJson("scene/venue/aoba", Venue, "race", false, Venue));
            Assert.Equal(3, bad.Entries.Count);
            Assert.All(bad.Entries, e => Assert.Null(e.Low));
            var lowEntry = v.LowEntry();
            Assert.Equal(("scene/venue/aoba", Sha(VenueLow), (long)VenueLow.Length, true), (lowEntry.Key, lowEntry.Sha256, lowEntry.Size, lowEntry.IsLowVariant));
        }

        // ------------------------------------------------------------------ data saver policy (REQ-PERF-005..008)

        [Fact]
        public void DataSaverHoldsOptionalDownloadsForWifiAndPicksLowVariants()
        {
            var c = Standard();
            var off = AssetDownloadPolicy.For(PerformanceSettings.Defaults);
            var on = AssetDownloadPolicy.For(new PerformanceSettings { DataSaver = true });
            // off: the §16 behaviour, normal files, any connection
            var p = off.Plan(c.Entries, AssetNetwork.Cellular);
            Assert.Equal(4, p.Now.Count); Assert.Empty(p.WaitForWifi);
            Assert.All(p.Now, e => Assert.False(e.IsLowVariant));
            Assert.False(off.HoldsOptional(AssetNetwork.Cellular));
            // on + cellular: required now, optional wait for Wi-Fi
            p = on.Plan(c.Entries, AssetNetwork.Cellular);
            Assert.Equal(new[] { "horse/coat/default" }, p.Now.Select(e => e.Key));
            Assert.Equal(3, p.WaitForWifi.Count);
            Assert.True(on.HoldsOptional(AssetNetwork.Cellular));
            // on + Wi-Fi: everything, low variants where they exist
            p = on.Plan(c.Entries, AssetNetwork.Wifi);
            Assert.Equal(4, p.Now.Count);
            Assert.Equal(new[] { false, true, true, false }, p.Now.Select(e => e.IsLowVariant));
            Assert.Equal(Sha(VenueLow), p.Now.First(e => e.Key == "scene/venue/aoba").Sha256);
            // offline: nothing
            Assert.Equal(AssetDecision.Offline, on.Decide(c.Entries[0], AssetNetwork.None));
            // required never takes a low variant
            Assert.False(on.UseLow(c.Find("horse/coat/default")));
        }

        sealed class MemCdn : IAssetHttp
        {
            public readonly Dictionary<string, byte[]> Files = new Dictionary<string, byte[]>();
            public readonly List<string> Urls = new List<string>();
            public TaskCompletionSource<bool> Gate;
            public async Task<int> GetAsync(AssetHttpRequest r, Func<AssetHttpHead, Stream> openBody, CancellationToken ct)
            {
                lock (Urls) Urls.Add(r.Url);
                if (Gate != null) await Gate.Task.WaitAsync(ct); else await Task.Yield();
                if (!Files.TryGetValue(r.Url, out var data)) { openBody(new AssetHttpHead { Status = 404 }); return 404; }
                var sink = openBody(new AssetHttpHead { Status = 200, ContentLength = data.Length });
                sink?.Write(data, 0, data.Length);
                return 200;
            }
        }

        (MemCdn cdn, AssetCache cache, AssetDownloader dl) Setup(AssetCatalog c)
        {
            var cdn = new MemCdn();
            foreach (var e in c.Entries)
            {
                byte[] data = e.Key == "scene/venue/aoba" ? Venue : e.Key == "horse/coat/bay" ? Coat : e.Key == "voice/ja/name/akatsuki" ? Voice : Default;
                cdn.Files[c.UrlFor(e)] = data;
                if (e.Low != null) cdn.Files[c.UrlFor(e.LowEntry())] = e.Key == "scene/venue/aoba" ? VenueLow : CoatLow;
            }
            var cache = new AssetCache(_dir, () => long.MaxValue);
            var dl = new AssetDownloader(cdn, cache, new AssetDownloaderOptions { ReserveBytes = 0, HashOnThreadPool = false, MaxAttempts = 2 });
            return (cdn, cache, dl);
        }

        [Fact]
        public async Task LowVariantDownloadsResolveUntilTheNormalFileArrives()
        {
            var c = Standard();
            var (cdn, cache, dl) = Setup(c);
            var on = AssetDownloadPolicy.For(new PerformanceSettings { DataSaver = true });
            var r = await dl.DownloadAsync(c, on.Plan(c.Entries, AssetNetwork.Wifi).Now);
            Assert.True(r.AllOk);
            Assert.True(cache.HasBlob(Sha(VenueLow), VenueLow.Length));
            Assert.False(cache.HasBlob(Sha(Venue), Venue.Length));
            var res = new AssetResolver(c, cache, null);
            var loc = res.Resolve("scene/venue/aoba");
            Assert.Equal(AssetSource.Downloaded, loc.Source); Assert.True(loc.LowRes);
            Assert.Equal(cache.BlobPath(Sha(VenueLow)), loc.Path);
            // the data saver goes off: the low file stays and shows until the normal one is fetched (REQ-PERF-009)
            var off = AssetDownloadPolicy.Default;
            await dl.DownloadAsync(c, off.Plan(c.Entries, AssetNetwork.Wifi).Now);
            loc = new AssetResolver(c, cache, null).Resolve("scene/venue/aoba");
            Assert.False(loc.LowRes); Assert.Equal(cache.BlobPath(Sha(Venue)), loc.Path);
            Assert.True(cache.HasBlob(Sha(VenueLow), VenueLow.Length)); // not deleted by switching
            Assert.Equal(0, dl.EvictStale(c).Files); // and not stale
        }

        [Fact]
        public async Task EnsureOnDemandRespectsTheDataSaver()
        {
            var c = Standard();
            var (cdn, cache, dl) = Setup(c);
            var on = AssetDownloadPolicy.For(new PerformanceSettings { DataSaver = true });
            Assert.Null(await dl.EnsureAsync(c, "voice/ja/name/akatsuki", on, AssetNetwork.Cellular));
            Assert.Empty(cdn.Urls); // nothing over cellular
            Assert.NotNull(await dl.EnsureAsync(c, "horse/coat/default", on, AssetNetwork.Cellular)); // required: always
            Assert.Equal(cache.BlobPath(Sha(CoatLow)), await dl.EnsureAsync(c, "horse/coat/bay", on, AssetNetwork.Wifi));
            // already on the device (low): returned on cellular without a transfer
            int before = cdn.Urls.Count;
            Assert.Equal(cache.BlobPath(Sha(CoatLow)), await dl.EnsureAsync(c, "horse/coat/bay", on, AssetNetwork.Cellular));
            Assert.Equal(before, cdn.Urls.Count);
            // data saver off on cellular: the normal file (the §16 behaviour)
            Assert.Equal(cache.BlobPath(Sha(Coat)), await dl.EnsureAsync(c, "horse/coat/bay", AssetDownloadPolicy.Default, AssetNetwork.Cellular));
        }

        // ------------------------------------------------------------------ storage and clear cache (REQ-PERF-008/013/014)

        [Fact]
        public void MeasureCountsEachFileOnceInItsRow()
        {
            var c = Standard();
            var blobs = new Dictionary<string, long>
            {
                [Sha(Default)] = Default.Length, [Sha(Venue)] = Venue.Length, [Sha(CoatLow)] = CoatLow.Length, [Sha(Voice)] = Voice.Length, [new string('a', 64)] = 777,
            };
            var r = AssetStorage.Measure(c, blobs, 55, 1);
            Assert.Equal(Default.Length, r.Row("required").Bytes);
            Assert.Equal(Venue.Length, r.Row("screens").Bytes);
            Assert.Equal(Voice.Length, r.Row("ondemand").Bytes);
            Assert.Equal(CoatLow.Length, r.Row("low").Bytes);
            Assert.Equal(777, r.Row("stale").Bytes);
            Assert.Equal(55, r.Row("partial").Bytes);
            Assert.Equal(Default.Length + Venue.Length + Voice.Length + CoatLow.Length + 777 + 55, r.TotalBytes);
            Assert.Equal(r.TotalBytes - Default.Length, r.ClearableBytes);
        }

        [Fact]
        public async Task PredownloadSizeIsWhatIsStillMissingInTheCurrentVersion()
        {
            var c = Standard();
            var (cdn, cache, dl) = Setup(c);
            var on = AssetDownloadPolicy.For(new PerformanceSettings { DataSaver = true });
            long fullAll = Venue.Length + Coat.Length + Voice.Length, lowAll = VenueLow.Length + CoatLow.Length + Voice.Length;
            Assert.Equal(fullAll, AssetStorage.Measure(c, cache, AssetDownloadPolicy.Default).PredownloadBytes);
            Assert.Equal(lowAll, AssetStorage.Measure(c, cache, on).PredownloadBytes);
            await dl.DownloadAsync(c, AssetStorage.PredownloadSet(c, on));
            Assert.Equal(0, AssetStorage.Measure(c, cache, on).PredownloadBytes);
            int urls = cdn.Urls.Count;
            await dl.DownloadAsync(c, AssetStorage.PredownloadSet(c, on)); // pressing again fetches nothing
            Assert.Equal(urls, cdn.Urls.Count);
            Assert.DoesNotContain(AssetStorage.PredownloadSet(c, on), e => e.Required);
        }

        [Fact]
        public async Task ClearCacheNeverDeletesRequiredOrInflightFiles()
        {
            var c = Standard();
            var (cdn, cache, dl) = Setup(c);
            await dl.DownloadAsync(c, c.Entries.Where(e => e.Key != "horse/coat/bay")); // default, venue, voice
            await dl.DownloadAsync(c, new[] { c.Find("horse/coat/bay").LowEntry() });
            Directory.CreateDirectory(Path.Combine(cache.Root, "blobs", "ab"));
            File.WriteAllText(Path.Combine(cache.Root, "blobs", "ab", "stale-file-x"), "x"); // something the catalog no longer has
            // a download in flight (the full coat) while the player clears the cache
            cdn.Gate = new TaskCompletionSource<bool>();
            var pending = dl.DownloadAsync(c, new[] { c.Find("horse/coat/bay") });
            for (int i = 0; i < 100 && dl.InflightHashes().Count == 0; i++) await Task.Delay(5);
            Assert.Contains(Sha(Coat), dl.InflightHashes());
            var before = AssetStorage.Measure(c, cache);
            var freed = dl.ClearOptional(c);
            Assert.True(cache.HasBlob(Sha(Default), Default.Length), "required stays");
            Assert.False(cache.HasBlob(Sha(Venue), Venue.Length));
            Assert.False(cache.HasBlob(Sha(Voice), Voice.Length));
            Assert.False(cache.HasBlob(Sha(CoatLow), CoatLow.Length));
            Assert.Equal(Venue.Length + Voice.Length + CoatLow.Length + 1, freed.Bytes); // the in-flight partial file is kept
            Assert.Equal(before.Row("screens").Bytes + before.Row("ondemand").Bytes + before.Row("low").Bytes + before.Row("stale").Bytes, freed.Bytes);
            cdn.Gate.SetResult(true);
            var r = await pending;
            Assert.True(r.AllOk, "the in-flight file finished and was kept");
            Assert.True(cache.HasBlob(Sha(Coat), Coat.Length));
            var after = AssetStorage.Measure(c, cache);
            Assert.Equal(Default.Length, after.Row("required").Bytes);
            Assert.Equal(0, after.Row("stale").Bytes + after.Row("low").Bytes + after.Row("ondemand").Bytes);
        }

        // ------------------------------------------------------------------ KPI (REQ-PERF-015)

        [Fact]
        public void KpiEventsCarryOnlyTheSettingValueClassAndBucket()
        {
            var e = AnalyticsEvent.PerfSettingChange(5, "graphics", "low", DeviceClass.High);
            Assert.Equal("perf_setting_change", e.Name);
            Assert.Equal("{\"setting\":\"graphics\",\"value\":\"low\",\"deviceClass\":\"high\"}", e.PropsJson);
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.PerfSettingChange(5, "graphics", "30", DeviceClass.Mid));
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.PerfSettingChange(5, "volume", "on", DeviceClass.Mid));
            var p = AnalyticsEvent.AssetPredownload(5, 120_000_000, true);
            Assert.Equal("{\"bucket\":\"50_200mb\",\"variant\":\"low\"}", p.PropsJson);
            Assert.Equal(new[] { "lt_10mb", "10_50mb", "50_200mb", "200mb_1gb", "gte_1gb" },
                new long[] { 0, 10_000_000, 199_999_999, 200_000_000, 1_000_000_000 }.Select(AssetStorage.BytesBucket));
            Assert.Equal("12.3MB", AssetStorage.FormatBytes(12_300_000));
        }
    }
}
