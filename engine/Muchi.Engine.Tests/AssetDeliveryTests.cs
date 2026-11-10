using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-DLV-001..010: catalog fetch/cache (ETag/304, offline), downloader (corruption, resume, quota, concurrency, eviction), resolution.</summary>
    public class AssetDeliveryTests : IDisposable
    {
        private readonly string _dir = Path.Combine(Path.GetTempPath(), "muchi-dlv-" + Guid.NewGuid().ToString("N"));
        public void Dispose() { try { Directory.Delete(_dir, true); } catch (IOException) { } }

        internal static string Sha(byte[] b) { using var h = SHA256.Create(); return AssetCache.Hex(h.ComputeHash(b)); }
        internal static byte[] Bytes(string s, int repeat = 1) => Encoding.UTF8.GetBytes(string.Concat(Enumerable.Repeat(s, repeat)));

        sealed class NoDelay : IDelay
        {
            public readonly List<int> Delays = new List<int>();
            public Task Delay(int ms, CancellationToken ct) { lock (Delays) Delays.Add(ms); return Task.CompletedTask; }
        }

        /// <summary>A CDN in memory: Range support and per-URL misbehaviour.</summary>
        sealed class FakeCdn : IAssetHttp
        {
            public readonly ConcurrentDictionary<string, byte[]> Files = new ConcurrentDictionary<string, byte[]>();
            public readonly ConcurrentQueue<AssetHttpRequest> Requests = new ConcurrentQueue<AssetHttpRequest>();
            /// <summary>Per URL: behaviours used for the next requests (then normal).</summary>
            public readonly ConcurrentDictionary<string, ConcurrentQueue<string>> Script = new ConcurrentDictionary<string, ConcurrentQueue<string>>();
            public bool IgnoreRange;
            public bool Offline;
            public TaskCompletionSource<bool> Gate;
            public int Active, MaxActive;

            public void Then(string url, params string[] steps) { var q = Script.GetOrAdd(url, _ => new ConcurrentQueue<string>()); foreach (var s in steps) q.Enqueue(s); }

            public async Task<int> GetAsync(AssetHttpRequest r, Func<AssetHttpHead, Stream> openBody, CancellationToken ct)
            {
                Requests.Enqueue(r);
                int now = Interlocked.Increment(ref Active);
                lock (this) MaxActive = Math.Max(MaxActive, now);
                try
                {
                    if (Gate != null) await Gate.Task.WaitAsync(ct); // a real transport aborts on cancel
                    else await Task.Yield();
                    if (Offline) throw new IOException("no route to host");
                    string step = Script.TryGetValue(r.Url, out var q) && q.TryDequeue(out var s) ? s : "ok";
                    if (step.StartsWith("status:")) { int st = int.Parse(step.Substring(7)); openBody(new AssetHttpHead { Status = st }); return st; }
                    if (step == "noresponse") throw new IOException("connection reset");
                    if (!Files.TryGetValue(r.Url, out var data)) { openBody(new AssetHttpHead { Status = 404 }); return 404; }
                    if (step == "corrupt") { data = (byte[])data.Clone(); data[data.Length / 2] ^= 0xff; }
                    bool ranged = r.RangeStart > 0 && !IgnoreRange;
                    if (ranged && r.RangeStart >= data.Length) { openBody(new AssetHttpHead { Status = 416 }); return 416; }
                    int from = ranged ? (int)r.RangeStart : 0;
                    int status = ranged ? 206 : 200;
                    var sink = openBody(new AssetHttpHead { Status = status, ContentLength = data.Length - from });
                    int len = data.Length - from;
                    if (step == "cut") { sink?.Write(data, from, len / 2); throw new IOException("connection reset mid-body"); }
                    if (step == "short") { sink?.Write(data, from, len / 2); return status; } // closed early without error
                    sink?.Write(data, from, len);
                    return status;
                }
                finally { Interlocked.Decrement(ref Active); }
            }
        }

        const string Base = "https://cdn.test";

        static AssetCatalog Catalog(int version, params (string key, byte[] data, string group, bool required)[] entries)
        {
            var o = JsonNode.Obj();
            o.Set("catalogVersion", version); o.Set("manifestVersion", 2); o.Set("platform", "ios"); o.Set("hash", "h" + version);
            o.Set("baseUrl", Base); o.Set("urlTemplate", "{base}/{platform}/{sha256}/{file}");
            var arr = JsonNode.Arr();
            foreach (var e in entries)
            {
                var x = JsonNode.Obj();
                x.Set("key", e.key); x.Set("file", e.key + ".bundle"); x.Set("sha256", Sha(e.data)); x.Set("size", e.data.Length); x.Set("group", e.group); x.Set("required", e.required);
                arr.Add(x);
            }
            o.Set("entries", arr);
            return AssetCatalog.Parse(o.ToString());
        }

        static void Publish(FakeCdn cdn, AssetCatalog c, params (string key, byte[] data, string group, bool required)[] entries)
        {
            foreach (var e in entries) cdn.Files[c.UrlFor(c.Find(e.key))] = e.data;
        }

        (FakeCdn cdn, AssetCache cache, AssetDownloader dl, NoDelay delay) Setup(int parallel = 4, Func<long> free = null, long maxCache = 0)
        {
            var cdn = new FakeCdn();
            var cache = new AssetCache(_dir, free ?? (() => long.MaxValue));
            var delay = new NoDelay();
            var dl = new AssetDownloader(cdn, cache, new AssetDownloaderOptions { MaxParallel = parallel, MaxAttempts = 4, ReserveBytes = 0, MaxCacheBytes = maxCache, HashOnThreadPool = false }, delay);
            return (cdn, cache, dl, delay);
        }

        static readonly (string, byte[], string, bool) Coat = ("horse/coat/bay", Bytes("bay-coat-", 400), AssetGroups.Race, false);
        static readonly (string, byte[], string, bool) Default = ("horse/coat/default", Bytes("default-coat-", 100), AssetGroups.Boot, true);
        static readonly (string, byte[], string, bool) Whip = ("sfx/race/whip", Bytes("whip-", 300), AssetGroups.Ftue, true);
        static readonly (string, byte[], string, bool) Venue = ("scene/venue/aoba", Bytes("aoba-scene-", 900), AssetGroups.Ftue, false);

        [Fact]
        public async Task DownloadsVerifiesAndReportsProgressPerGroup()
        {
            var (cdn, cache, dl, _) = Setup();
            var c = Catalog(1, Coat, Default, Whip, Venue);
            Publish(cdn, c, Coat, Default, Whip, Venue);
            var seen = new ConcurrentDictionary<string, AssetGroupProgress>();
            var r = await dl.DownloadGroupsAsync(c, new[] { AssetGroups.Boot, AssetGroups.Ftue }, false, p => seen[p.Group] = p);
            Assert.True(r.AllOk);
            Assert.Equal(3, r.Count(AssetFileState.Downloaded));
            Assert.False(r.Keys.ContainsKey("horse/coat/bay")); // race group not asked for
            Assert.Equal(Default.Item2.Length + Whip.Item2.Length + Venue.Item2.Length, r.BytesDownloaded);
            Assert.True(seen[AssetGroups.Ftue].Finished && seen[AssetGroups.Ftue].Fraction == 1f && seen[AssetGroups.Ftue].TotalFiles == 2);
            Assert.Equal(Whip.Item2.Length + Venue.Item2.Length, seen[AssetGroups.Ftue].TotalBytes);
            Assert.True(seen[AssetGroups.Boot].DoneFiles == 1);
            Assert.True(cache.HasBlob(Sha(Whip.Item2), Whip.Item2.Length));
            Assert.Equal(Whip.Item2, File.ReadAllBytes(cache.BlobPath(Sha(Whip.Item2))));
            Assert.Empty(Directory.GetFiles(Path.Combine(_dir, "partial")));
            // second run: everything cached, nothing requested
            int before = cdn.Requests.Count;
            var again = await dl.DownloadGroupsAsync(c, new[] { AssetGroups.Boot, AssetGroups.Ftue }, false);
            Assert.Equal(3, again.Count(AssetFileState.Cached));
            Assert.Equal(before, cdn.Requests.Count);
            Assert.Equal(0, dl.PendingBytes(c.InGroups(new[] { AssetGroups.Boot, AssetGroups.Ftue })));
            Assert.Equal(Coat.Item2.Length, dl.PendingBytes(c.Entries));
        }

        [Fact]
        public async Task CorruptBodyIsRetriedAndNeverCommitted()
        {
            var (cdn, cache, dl, delay) = Setup();
            var c = Catalog(1, Coat);
            Publish(cdn, c, Coat);
            string url = c.UrlFor(c.Find("horse/coat/bay"));
            cdn.Then(url, "corrupt");
            var r = await dl.DownloadAsync(c, c.Entries);
            Assert.Equal(AssetFileState.Downloaded, r.Keys["horse/coat/bay"]);
            Assert.Equal(2, cdn.Requests.Count);
            Assert.NotEmpty(delay.Delays); // backoff between attempts

            var (cdn2, cache2, dl2, _) = Setup();
            cache2.DeleteBlob(Sha(Coat.Item2));
            Publish(cdn2, c, Coat);
            cdn2.Then(url, "corrupt", "corrupt", "corrupt", "corrupt");
            var bad = await dl2.DownloadAsync(c, c.Entries);
            Assert.Equal(AssetFileState.Corrupt, bad.Keys["horse/coat/bay"]);
            Assert.False(cache2.HasBlob(Sha(Coat.Item2), Coat.Item2.Length));
            Assert.Equal(0, cache2.PartialLength(Sha(Coat.Item2)));
            Assert.False(bad.Offline);
            // the resolver degrades to the kind's fallback
            var res = new AssetResolver(c, cache2, k => k == "horse/coat/default");
            Assert.Equal("horse/coat/default", res.Resolve("horse/coat/bay").Key);
        }

        [Fact]
        public async Task BrokenTransferResumesWithRange()
        {
            var (cdn, cache, dl, _) = Setup();
            var c = Catalog(1, Venue);
            Publish(cdn, c, Venue);
            string url = c.UrlFor(c.Find("scene/venue/aoba"));
            cdn.Then(url, "cut", "short");
            long last = 0;
            var r = await dl.DownloadAsync(c, c.Entries, p => last = p.DoneBytes);
            Assert.Equal(AssetFileState.Downloaded, r.Keys["scene/venue/aoba"]);
            var reqs = cdn.Requests.ToArray();
            Assert.Equal(3, reqs.Length);
            Assert.Equal(0, reqs[0].RangeStart);
            int size = Venue.Item2.Length;
            Assert.Equal(size / 2, reqs[1].RangeStart);
            Assert.True(reqs[2].RangeStart > reqs[1].RangeStart);
            Assert.Equal(size, r.BytesDownloaded); // every byte fetched once
            Assert.Equal(size, last);
            Assert.Equal(Venue.Item2, File.ReadAllBytes(cache.BlobPath(Sha(Venue.Item2))));
        }

        [Fact]
        public async Task PartialFileFromAPreviousSessionIsResumedOrRestarted()
        {
            var (cdn, cache, dl, _) = Setup();
            var c = Catalog(1, Venue);
            Publish(cdn, c, Venue);
            string sha = Sha(Venue.Item2);
            File.WriteAllBytes(cache.PartPath(sha), Venue.Item2.Take(100).ToArray()); // app was killed mid-download
            Assert.Equal(Venue.Item2.Length - 100, dl.PendingBytes(c.Entries));
            var r = await dl.DownloadAsync(c, c.Entries);
            Assert.Equal(AssetFileState.Downloaded, r.Keys["scene/venue/aoba"]);
            Assert.Equal(100, cdn.Requests.Single().RangeStart);
            Assert.Equal(Venue.Item2.Length - 100, r.BytesDownloaded);

            // a CDN that ignores Range (200): the partial file is replaced, not appended to
            cache.DeleteBlob(sha);
            File.WriteAllBytes(cache.PartPath(sha), Venue.Item2.Take(100).ToArray());
            cdn.IgnoreRange = true;
            r = await dl.DownloadAsync(c, c.Entries);
            Assert.Equal(AssetFileState.Downloaded, r.Keys["scene/venue/aoba"]);
            Assert.Equal(Venue.Item2, File.ReadAllBytes(cache.BlobPath(sha)));

            // a stale partial longer than the file → 416 → start over
            cache.DeleteBlob(sha);
            cdn.IgnoreRange = false;
            File.WriteAllBytes(cache.PartPath(sha), Venue.Item2.Take(Venue.Item2.Length - 1).ToArray());
            cdn.Then(c.UrlFor(c.Find("scene/venue/aoba")), "status:416");
            r = await dl.DownloadAsync(c, c.Entries);
            Assert.Equal(AssetFileState.Downloaded, r.Keys["scene/venue/aoba"]);
        }

        [Fact]
        public async Task ServerErrorsRetryNotFoundDoesNot()
        {
            var (cdn, _, dl, _) = Setup();
            var c = Catalog(1, Coat, Whip);
            Publish(cdn, c, Coat);
            cdn.Then(c.UrlFor(c.Find("horse/coat/bay")), "status:503", "noresponse", "status:429");
            var r = await dl.DownloadAsync(c, c.Entries);
            Assert.Equal(AssetFileState.Downloaded, r.Keys["horse/coat/bay"]);
            Assert.Equal(AssetFileState.NotFound, r.Keys["sfx/race/whip"]); // not uploaded yet → placeholder, no retry storm
            Assert.Single(cdn.Requests, q => q.Url.Contains(Sha(Whip.Item2)));
        }

        [Fact]
        public async Task QuotaKeepsRequiredFirstAndSkipsWhatDoesNotFit()
        {
            long free = Default.Item2.Length + Whip.Item2.Length + 10; // room for the required ones only
            var (cdn, cache, dl, _) = Setup(free: () => free);
            var c = Catalog(1, Coat, Default, Whip, Venue);
            Publish(cdn, c, Coat, Default, Whip, Venue);
            var r = await dl.DownloadAsync(c, c.Entries);
            Assert.True(r.QuotaExceeded);
            Assert.Equal(AssetFileState.Downloaded, r.Keys["horse/coat/default"]);
            Assert.Equal(AssetFileState.Downloaded, r.Keys["sfx/race/whip"]);
            Assert.Equal(AssetFileState.SkippedQuota, r.Keys["scene/venue/aoba"]);
            Assert.Equal(AssetFileState.SkippedQuota, r.Keys["horse/coat/bay"]);
            Assert.DoesNotContain(cdn.Requests, q => q.Url.Contains(Sha(Coat.Item2)));
            Assert.Empty(Directory.GetFiles(Path.Combine(_dir, "partial"))); // nothing half-written

            // MaxCacheBytes caps the cache even with a big disk; stale files are evicted to make room
            var (cdn2, cache2, dl2, _) = Setup(maxCache: Coat.Item2.Length + 5);
            File.WriteAllBytes(Path.Combine(_dir, "stale.bin"), new byte[1]); // unrelated file outside blobs/: untouched
            string staleSha = Sha(Bytes("old-version"));
            Directory.CreateDirectory(Path.GetDirectoryName(cache2.BlobPath(staleSha)));
            File.WriteAllBytes(cache2.BlobPath(staleSha), new byte[Coat.Item2.Length]);
            var only = Catalog(2, Coat);
            Publish(cdn2, only, Coat);
            foreach (var e in new[] { "horse/coat/default", "sfx/race/whip", "scene/venue/aoba" }) cache2.DeleteBlob(c.Find(e).Sha256);
            var r2 = await dl2.DownloadAsync(only, only.Entries);
            Assert.Equal(AssetFileState.Downloaded, r2.Keys["horse/coat/bay"]);
            Assert.Equal(1, r2.Evicted.Files);
            Assert.False(File.Exists(cache2.BlobPath(staleSha)));
            Assert.True(File.Exists(Path.Combine(_dir, "stale.bin")));
        }

        [Fact]
        public async Task DiskWriteFailureIsReportedAsDiskFullWithoutRetries()
        {
            var (cdn, cache, dl, _) = Setup();
            var c = Catalog(1, Coat);
            Publish(cdn, c, Coat);
            Directory.CreateDirectory(cache.PartPath(Sha(Coat.Item2))); // cannot be opened as a file
            var r = await dl.DownloadAsync(c, c.Entries);
            Assert.Equal(AssetFileState.DiskFull, r.Keys["horse/coat/bay"]);
            Assert.True(r.QuotaExceeded);
            Assert.Single(cdn.Requests);
        }

        [Fact]
        public async Task ParallelismIsLimitedAndConcurrentCallsShareOneTransfer()
        {
            var (cdn, cache, dl, _) = Setup(parallel: 2);
            var entries = Enumerable.Range(0, 6).Select(i => ("item/i" + i, Bytes("item" + i + "-", 50 + i), AssetGroups.Shop, false)).ToArray();
            var c = Catalog(1, entries);
            Publish(cdn, c, entries);
            cdn.Gate = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            var a = dl.DownloadAsync(c, c.Entries);
            var b = dl.DownloadAsync(c, c.Entries); // same files from another screen
            var one = dl.EnsureAsync(c, "item/i3");
            await Task.Delay(50);
            Assert.True(cdn.Active <= 2, "active " + cdn.Active);
            cdn.Gate.SetResult(true);
            var ra = await a; var rb = await b; var path = await one;
            Assert.True(ra.AllOk && rb.AllOk);
            Assert.True(cdn.MaxActive <= 2, "max active " + cdn.MaxActive);
            Assert.Equal(6, cdn.Requests.Count); // one GET per file in total
            Assert.Equal(cache.BlobPath(c.Find("item/i3").Sha256), path);
            Assert.Null(await dl.EnsureAsync(c, "item/not_in_catalog"));
        }

        [Fact]
        public async Task OwnerCancelDoesNotCancelAJoinedCallerOfTheSameFile()
        {
            // QA r9: the shared transfer ran on the token of the caller that started it, so a screen leaving (cancel)
            // failed the same file for another screen that still wanted it.
            var (cdn, cache, dl, _) = Setup(parallel: 1);
            var c = Catalog(1, Coat);
            Publish(cdn, c, Coat);
            cdn.Gate = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            using var ownerCts = new CancellationTokenSource();
            var owner = dl.DownloadAsync(c, c.Entries, null, ownerCts.Token);
            var joiner = dl.EnsureAsync(c, "horse/coat/bay");
            try
            {
                await Task.Delay(30);
                ownerCts.Cancel();
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() => owner);
            }
            finally { cdn.Gate.TrySetResult(true); }
            var path = await joiner;
            Assert.Equal(cache.BlobPath(c.Find("horse/coat/bay").Sha256), path);
            Assert.True(cache.HasBlob(Sha(Coat.Item2), Coat.Item2.Length));
        }

        [Fact]
        public async Task JoinedCallerCanCancelItsWaitWithoutStoppingTheOwner()
        {
            var (cdn, cache, dl, _) = Setup(parallel: 1);
            var c = Catalog(1, Coat);
            Publish(cdn, c, Coat);
            cdn.Gate = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            var owner = dl.DownloadAsync(c, c.Entries);
            using var joinCts = new CancellationTokenSource();
            // Both calls register synchronously (the owner is parked on the gate, the joiner on the shared transfer), so
            // no wall-clock wait is needed. CI r16: a fixed 30 ms + 10 s bound failed on a starved thread pool.
            var joiner = dl.EnsureAsync(c, "horse/coat/bay", joinCts.Token);
            try
            {
                joinCts.Cancel();
                // the joiner's own cancel is honoured while the owner's transfer is still held by the gate (the test
                // controls it); the generous bound only stops a regression from hanging the run
                var done = await Task.WhenAny(joiner, Task.Delay(TimeSpan.FromMinutes(2)));
                Assert.Same(joiner, done);
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() => joiner);
                Assert.False(owner.IsCompleted, "the owner's transfer is still held, not stopped by the joiner");
            }
            finally { cdn.Gate.TrySetResult(true); }
            Assert.True((await owner).AllOk);
            Assert.Single(cdn.Requests); // one transfer: the joiner joined the owner's and never started its own
        }

        [Fact]
        public async Task ABlobOfTheWrongSizeIsReplacedOnCommit()
        {
            // QA r9: CommitPart kept an existing (truncated) blob and threw the verified download away, so the key was
            // reported Downloaded but never resolved and was fetched again on every run.
            var (cdn, cache, dl, _) = Setup();
            var c = Catalog(1, Coat);
            Publish(cdn, c, Coat);
            string sha = Sha(Coat.Item2);
            Directory.CreateDirectory(Path.GetDirectoryName(cache.BlobPath(sha))!);
            File.WriteAllBytes(cache.BlobPath(sha), Coat.Item2.Take(10).ToArray());
            var r = await dl.DownloadAsync(c, c.Entries);
            Assert.True(r.AllOk);
            Assert.True(cache.HasBlob(sha, Coat.Item2.Length));
            Assert.Equal(sha, Sha(File.ReadAllBytes(cache.BlobPath(sha))));
        }

        [Fact]
        public async Task NewCatalogVersionEvictsStaleFiles()
        {
            var (cdn, cache, dl, _) = Setup();
            var v1 = Catalog(1, Coat, Whip);
            Publish(cdn, v1, Coat, Whip);
            Assert.True((await dl.DownloadAsync(v1, v1.Entries)).AllOk);
            var newCoat = ("horse/coat/bay", Bytes("bay-coat-v2-", 300), AssetGroups.Race, false); // re-made art, same key
            var v2 = Catalog(2, newCoat, Whip);
            Publish(cdn, v2, newCoat, Whip);
            var ev = dl.EvictStale(v2);
            Assert.Equal(1, ev.Files);
            Assert.Equal(Coat.Item2.Length, ev.Bytes);
            Assert.False(File.Exists(cache.BlobPath(Sha(Coat.Item2))));
            Assert.True(cache.HasBlob(Sha(Whip.Item2), Whip.Item2.Length)); // unchanged file kept
            var res = new AssetResolver(v2, cache, _ => false);
            Assert.False(res.IsDownloaded("horse/coat/bay"));
            await dl.DownloadAsync(v2, v2.Entries);
            Assert.Equal(AssetSource.Downloaded, res.Resolve("horse/coat/bay").Source);
        }

        [Fact]
        public async Task OfflineAndNoCdnDegradeToPlaceholders()
        {
            var (cdn, cache, dl, _) = Setup();
            var c = Catalog(1, Coat, Whip);
            Publish(cdn, c, Coat, Whip);
            cdn.Offline = true;
            var r = await dl.DownloadAsync(c, c.Entries);
            Assert.True(r.Offline);
            Assert.Equal(2, r.Count(AssetFileState.Failed));

            var noCdn = AssetCatalog.Parse(c.Raw.Replace("\"baseUrl\":\"" + Base + "\"", "\"baseUrl\":\"\""));
            Assert.False(noCdn.HasCdn);
            int before = cdn.Requests.Count;
            var r2 = await dl.DownloadAsync(noCdn, noCdn.Entries);
            Assert.True(r2.Offline);
            Assert.Equal(before, cdn.Requests.Count);

            var res = new AssetResolver(c, cache, k => k == "sfx/race/default");
            var whip = res.Resolve("sfx/race/whip");
            Assert.Equal("sfx/race/default", whip.Key);
            Assert.True(whip.IsFallback);
            Assert.Equal(AssetSource.Bundled, whip.Source);
            Assert.Null(res.Resolve("horse/coat/bay").Key); // no art and no default bundled → show nothing, never throw
        }

        [Fact]
        public void ResolverPrefersDownloadedOverBundled()
        {
            var cache = new AssetCache(_dir);
            var c = Catalog(1, Coat);
            string sha = Sha(Coat.Item2);
            Directory.CreateDirectory(Path.GetDirectoryName(cache.BlobPath(sha)));
            File.WriteAllBytes(cache.BlobPath(sha), Coat.Item2);
            var loc = new AssetResolver(c, cache, _ => true).Resolve("horse/coat/bay");
            Assert.Equal(AssetSource.Downloaded, loc.Source);
            Assert.Equal(cache.BlobPath(sha), loc.Path);
            Assert.False(loc.IsFallback);
            Assert.Equal(AssetSource.Bundled, new AssetResolver(c, cache, _ => true).Resolve("horse/coat/gray").Source);
        }

        [Fact]
        public void CatalogParsingDropsMalformedEntriesAndExpandsUrls()
        {
            var c = Catalog(3, Coat);
            Assert.Equal(Base + "/ios/" + Sha(Coat.Item2) + "/horse/coat/bay.bundle", c.UrlFor(c.Find("horse/coat/bay")));
            string evil = c.Raw.Replace("\"file\":\"horse/coat/bay.bundle\"", "\"file\":\"../../etc/passwd\"");
            Assert.Empty(AssetCatalog.Parse(evil).Entries);
            string badSha = c.Raw.Replace(Sha(Coat.Item2), "XYZ");
            Assert.Empty(AssetCatalog.Parse(badSha).Entries);
            Assert.Throws<FormatException>(() => AssetCatalog.Parse("{\"error\":{}}"));
            var p = AssetPolicy.Parse(JsonNode.Parse("{\"tutorialMaxWaitMs\":60000,\"maxParallel\":99}"));
            Assert.Equal(AssetPolicy.TutorialMaxWaitHardMs, p.TutorialMaxWaitMs); // client-side cap: the aha is never held hostage
            Assert.Equal(8, p.MaxParallel);
        }

        // ------------------------------------------------------------------ catalog fetch + cache

        sealed class FakeApi : IHttp
        {
            public readonly List<HttpRequest> Sent = new List<HttpRequest>();
            public Func<HttpRequest, HttpResponse> Handler;
            public Task<HttpResponse> SendAsync(HttpRequest r, CancellationToken ct) { Sent.Add(r); return Task.FromResult(Handler(r)); }
        }

        [Fact]
        public async Task CatalogStoreUsesEtagPersistsAndFallsBackOffline()
        {
            var cache = new AssetCache(_dir);
            var cat = Catalog(5, Coat);
            var api = new FakeApi();
            api.Handler = r => r.Headers.TryGetValue("if-none-match", out var inm) && inm == "\"h5\"" ? new HttpResponse(304, "") : new HttpResponse(200, cat.Raw);
            var store = new AssetCatalogStore(api, cache, AssetPlatforms.Ios, delay: new NoDelay());
            var c1 = await store.RefreshAsync();
            Assert.Equal(CatalogSource.Network, store.Source);
            Assert.Equal("/v1/assets/catalog?platform=ios", api.Sent[0].Path);
            Assert.False(api.Sent[0].Headers.ContainsKey("if-none-match"));
            Assert.Equal(5, c1.CatalogVersion);
            Assert.True(File.Exists(cache.CatalogPath("ios")));
            Assert.False(File.Exists(cache.CatalogPath("ios") + ".tmp"));

            var c2 = await store.RefreshAsync();
            Assert.Equal(CatalogSource.NotModified, store.Source);
            Assert.Equal("\"h5\"", api.Sent[1].Headers["if-none-match"]);
            Assert.Same(c1, c2);
            Assert.False(store.IsStale(5));
            Assert.True(store.IsStale(6)); // GET /v1/config reported a newer catalogVersion

            // app restart, offline: the persisted catalog is used
            var offline = new FakeApi { Handler = _ => throw new IOException("offline") };
            var s2 = new AssetCatalogStore(offline, cache, AssetPlatforms.Ios, delay: new NoDelay());
            var c3 = await s2.RefreshAsync();
            Assert.Equal(CatalogSource.Cached, s2.Source);
            Assert.True(s2.Offline);
            Assert.Equal(5, c3.CatalogVersion);
            Assert.Equal(3, offline.Sent.Count); // first try + 2 retries
            Assert.Equal("\"h5\"", offline.Sent[0].Headers["if-none-match"]);

            // a garbage 200 keeps the last good catalog; an old server without the route (404) too
            var garbage = new AssetCatalogStore(new FakeApi { Handler = _ => new HttpResponse(200, "<html>") }, cache, AssetPlatforms.Ios);
            Assert.Equal(5, (await garbage.RefreshAsync()).CatalogVersion);
            Assert.Equal(CatalogSource.Cached, garbage.Source);
            var old = new AssetCatalogStore(new FakeApi { Handler = _ => new HttpResponse(404, "{}") }, cache, AssetPlatforms.Ios);
            Assert.Equal(5, (await old.RefreshAsync()).CatalogVersion);

            // nothing cached + offline → empty catalog (bundled assets and fallbacks only)
            var fresh = new AssetCatalogStore(offline, new AssetCache(Path.Combine(_dir, "other")), AssetPlatforms.Android, delay: new NoDelay());
            var empty = await fresh.RefreshAsync();
            Assert.Equal(CatalogSource.Empty, fresh.Source);
            Assert.Empty(empty.Entries);
            Assert.False(empty.HasCdn);

            // a newer catalog replaces the persisted one atomically
            var v6 = Catalog(6, Coat, Whip);
            var s3 = new AssetCatalogStore(new FakeApi { Handler = _ => new HttpResponse(200, v6.Raw) }, cache, AssetPlatforms.Ios);
            await s3.RefreshAsync();
            Assert.Equal(6, s3.LoadCached().CatalogVersion);
            Assert.Equal(2, s3.LoadCached().Entries.Count);
        }

        [Fact]
        public void CorruptPersistedCatalogIsIgnored()
        {
            var cache = new AssetCache(_dir);
            File.WriteAllText(cache.CatalogPath("ios"), "{\"catalogVersion\":");
            Assert.Null(new AssetCatalogStore(null, cache, AssetPlatforms.Ios).LoadCached());
            AssetCache.WriteAllTextAtomic(cache.CatalogPath("ios"), Catalog(2).Raw);
            Assert.Equal(2, new AssetCatalogStore(null, cache, AssetPlatforms.Ios).LoadCached().CatalogVersion);
        }

        [Fact]
        public void ManifestDefaultsCanAllBeResolvedWhenBundled()
        {
            // REQ-ASSET-002 through the delivery path: with only the <kind>/default assets bundled, every manifest key resolves.
            var keys = AssetKeys.ParseManifestKeys(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "contracts", "assets.manifest.json")));
            var res = new AssetResolver(AssetCatalog.Empty("ios"), new AssetCache(_dir), k => k.EndsWith("/default", StringComparison.Ordinal));
            foreach (var k in keys) Assert.NotNull(res.Resolve(k).Key);
        }
    }
}
