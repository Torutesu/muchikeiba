using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace Muchi.Client
{
    // ============================================================================================ transport

    public sealed class AssetHttpRequest
    {
        /// <summary>Absolute URL (AssetCatalog.UrlFor).</summary>
        public string Url;
        /// <summary>&gt; 0: send "Range: bytes=&lt;RangeStart&gt;-" (resume). The server may still answer 200 with the whole file.</summary>
        public long RangeStart;
        public override string ToString() => "GET " + Url + (RangeStart > 0 ? " (from " + RangeStart + ")" : "");
    }

    public sealed class AssetHttpHead
    {
        public int Status;
        /// <summary>Content-Length of this response, -1 when unknown.</summary>
        public long ContentLength = -1;
    }

    /// <summary>
    /// Binary GET for asset files. Codex implements it on UnityWebRequest + DownloadHandlerScript (UnityAssetHttp);
    /// <see cref="HttpClientAssetHttp"/> works outside Unity.
    /// Contract: once the status line and headers arrived call <c>openBody(head)</c> exactly once and write the body
    /// into the stream it returns (null → read and discard the body); do not dispose that stream. Return the status.
    /// Throw (any exception) when the transfer breaks: bytes already written stay in the partial file and are resumed.
    /// </summary>
    public interface IAssetHttp
    {
        Task<int> GetAsync(AssetHttpRequest request, Func<AssetHttpHead, Stream> openBody, CancellationToken ct);
    }

    /// <summary><see cref="IAssetHttp"/> on System.Net.Http (editor tools, bots, checks).</summary>
    public sealed class HttpClientAssetHttp : IAssetHttp
    {
        private readonly HttpClient _client;
        public HttpClientAssetHttp(HttpClient client = null) { _client = client ?? new HttpClient(); }

        public async Task<int> GetAsync(AssetHttpRequest request, Func<AssetHttpHead, Stream> openBody, CancellationToken ct)
        {
            using (var msg = new HttpRequestMessage(HttpMethod.Get, request.Url))
            {
                if (request.RangeStart > 0) msg.Headers.Range = new System.Net.Http.Headers.RangeHeaderValue(request.RangeStart, null);
                using (var res = await _client.SendAsync(msg, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false))
                {
                    int status = (int)res.StatusCode;
                    var sink = openBody(new AssetHttpHead { Status = status, ContentLength = res.Content.Headers.ContentLength ?? -1 });
                    using (var body = await res.Content.ReadAsStreamAsync().ConfigureAwait(false))
                    {
                        var buf = new byte[64 * 1024];
                        int n;
                        while ((n = await body.ReadAsync(buf, 0, buf.Length, ct).ConfigureAwait(false)) > 0)
                            if (sink != null) sink.Write(buf, 0, n);
                    }
                    return status;
                }
            }
        }
    }

    // ============================================================================================ results

    public enum AssetFileState { Pending, Cached, Downloaded, Failed, NotFound, Corrupt, SkippedQuota, DiskFull, Cancelled }

    /// <summary>Progress of one preload group (bytes de-duplicated by content hash; resumed bytes count as done).</summary>
    public sealed class AssetGroupProgress
    {
        public string Group;
        public long TotalBytes;
        public long DoneBytes;
        public int TotalFiles;
        public int DoneFiles;
        public int FailedFiles;
        public float Fraction => TotalBytes <= 0 ? 1f : (float)Math.Min(1.0, (double)DoneBytes / TotalBytes);
        public bool Finished => DoneFiles + FailedFiles >= TotalFiles;
        public AssetGroupProgress Clone() => (AssetGroupProgress)MemberwiseClone();
    }

    public sealed class AssetDownloadReport
    {
        /// <summary>Per key: what happened to its file.</summary>
        public readonly Dictionary<string, AssetFileState> Keys = new Dictionary<string, AssetFileState>(StringComparer.Ordinal);
        public long BytesDownloaded;
        /// <summary>Some files were not started because the disk (or MaxCacheBytes) could not hold them.</summary>
        public bool QuotaExceeded;
        /// <summary>Every failure was a network failure (no response at all): the device is probably offline.</summary>
        public bool Offline;
        public EvictionResult Evicted = new EvictionResult();

        public IEnumerable<string> KeysIn(AssetFileState s) => Keys.Where(kv => kv.Value == s).Select(kv => kv.Key);
        public int Count(AssetFileState s) => Keys.Count(kv => kv.Value == s);
        public bool AllOk => Keys.Values.All(v => v == AssetFileState.Cached || v == AssetFileState.Downloaded);
    }

    public sealed class AssetDownloaderOptions
    {
        /// <summary>Concurrent downloads (catalog.policy.maxParallel overrides when the downloader is built with it).</summary>
        public int MaxParallel = 4;
        /// <summary>Attempts per file (network errors, 5xx/429, truncated or corrupt bodies).</summary>
        public int MaxAttempts = 4;
        public RetryPolicy Retry = new RetryPolicy { BaseDelayMs = 500, MaxDelayMs = 8000 };
        /// <summary>Free space always left on the volume.</summary>
        public long ReserveBytes = 50L * 1024 * 1024;
        /// <summary>Upper bound for the whole cache; 0 = only the free space limits it.</summary>
        public long MaxCacheBytes;
        /// <summary>Hash files on the thread pool (keeps Unity's main thread free). Off in single-threaded tests.</summary>
        public bool HashOnThreadPool = true;
    }

    // ============================================================================================ downloader

    /// <summary>
    /// Downloads catalog entries into the <see cref="AssetCache"/> (REQ-DLV-006): limited parallelism, resume with
    /// Range after a broken transfer, retry with backoff, SHA-256 verification before the atomic rename, disk-quota
    /// planning (required entries first; what does not fit is skipped, never half-written), eviction of stale versions,
    /// and progress per preload group. Concurrent calls for the same file share one transfer. Never throws for network,
    /// server or disk problems: the report says which keys are missing, and those resolve to placeholders
    /// (<see cref="AssetResolver"/>).
    /// </summary>
    public sealed class AssetDownloader
    {
        private readonly IAssetHttp _http;
        private readonly AssetCache _cache;
        private readonly AssetDownloaderOptions _opt;
        private readonly IDelay _delay;
        private readonly SemaphoreSlim _slots;
        private readonly object _gate = new object();
        private readonly Dictionary<string, Inflight> _inflight = new Dictionary<string, Inflight>(StringComparer.Ordinal);

        public AssetCache Cache => _cache;

        public AssetDownloader(IAssetHttp http, AssetCache cache, AssetDownloaderOptions options = null, IDelay delay = null)
        {
            _http = http ?? throw new ArgumentNullException(nameof(http));
            _cache = cache ?? throw new ArgumentNullException(nameof(cache));
            _opt = options ?? new AssetDownloaderOptions();
            _delay = delay ?? TaskDelay.Instance;
            _slots = new SemaphoreSlim(Math.Max(1, _opt.MaxParallel));
        }

        private sealed class Inflight
        {
            public readonly TaskCompletionSource<FileOutcome> Done = new TaskCompletionSource<FileOutcome>(TaskCreationOptions.RunContinuationsAsynchronously);
            public long Bytes;
            public readonly List<Action<long>> Listeners = new List<Action<long>>();
        }

        private struct FileOutcome
        {
            public AssetFileState State;
            public long Downloaded;
            public bool NetworkOnly;
        }

        private sealed class Blob
        {
            public string Sha;
            public long Size;
            public AssetEntry First;
            public bool Required;
            public int Order;
            public readonly List<AssetEntry> Entries = new List<AssetEntry>();
            public readonly HashSet<string> Groups = new HashSet<string>();
        }

        /// <summary>Bytes still to download for these entries (missing files minus what partial downloads already hold).</summary>
        public long PendingBytes(IEnumerable<AssetEntry> entries)
        {
            long n = 0;
            foreach (var b in Blobs(entries))
                if (!_cache.HasBlob(b.Sha, b.Size)) n += Math.Max(0, b.Size - Math.Min(b.Size, _cache.PartialLength(b.Sha)));
            return n;
        }

        /// <summary>Deletes cached files the catalog no longer references (old versions of re-made assets).</summary>
        public EvictionResult EvictStale(AssetCatalog catalog)
        {
            var keep = catalog.ReferencedHashes();
            lock (_gate) foreach (var k in _inflight.Keys) keep.Add(k);
            return _cache.Evict(keep);
        }

        /// <summary>Downloads every entry of the given groups (all of them, or only the required ones).</summary>
        public Task<AssetDownloadReport> DownloadGroupsAsync(AssetCatalog catalog, IEnumerable<string> groups, bool requiredOnly, Action<AssetGroupProgress> progress = null, CancellationToken ct = default)
            => DownloadAsync(catalog, catalog.InGroups(groups, requiredOnly), progress, ct);

        /// <summary>One key on demand (e.g. a banner or a voice name the screen needs now). Returns its file path or null.</summary>
        public async Task<string> EnsureAsync(AssetCatalog catalog, string key, CancellationToken ct = default)
        {
            var e = catalog.Find(key);
            if (e == null) return null;
            var r = await DownloadAsync(catalog, new[] { e }, null, ct);
            return r.Keys.TryGetValue(key, out var s) && (s == AssetFileState.Cached || s == AssetFileState.Downloaded) ? _cache.BlobPath(e.Sha256) : null;
        }

        public async Task<AssetDownloadReport> DownloadAsync(AssetCatalog catalog, IEnumerable<AssetEntry> entries, Action<AssetGroupProgress> progress = null, CancellationToken ct = default)
        {
            var report = new AssetDownloadReport();
            var blobs = Blobs(entries).ToList();
            var tracker = new ProgressTracker(progress);
            foreach (var b in blobs) tracker.Add(b.Sha, b.Size, b.Groups);

            // 1. already cached
            var missing = new List<Blob>();
            foreach (var b in blobs)
            {
                if (_cache.HasBlob(b.Sha, b.Size)) { Mark(report, b, AssetFileState.Cached); tracker.Finish(b.Sha, true); }
                else { missing.Add(b); tracker.Set(b.Sha, Math.Min(b.Size, _cache.PartialLength(b.Sha))); }
            }
            tracker.Flush();
            if (missing.Count == 0) return report;
            if (!catalog.HasCdn)
            {
                foreach (var b in missing) { Mark(report, b, AssetFileState.Failed); tracker.Finish(b.Sha, false); }
                report.Offline = true;
                tracker.Flush();
                return report;
            }

            // 2. quota: what fits, required first, then group order, small files first
            missing.Sort((x, y) => x.Required != y.Required ? (x.Required ? -1 : 1) : x.Order != y.Order ? x.Order.CompareTo(y.Order) : x.Size.CompareTo(y.Size));
            long Need(Blob b) => Math.Max(0, b.Size - Math.Min(b.Size, _cache.PartialLength(b.Sha)));
            long budget = Budget();
            if (missing.Sum(Need) > budget)
            {
                report.Evicted = EvictStale(catalog);
                budget = Budget();
            }
            var start = new List<Blob>();
            foreach (var b in missing)
            {
                long need = Need(b);
                if (need <= budget) { budget -= need; start.Add(b); }
                else { Mark(report, b, AssetFileState.SkippedQuota); report.QuotaExceeded = true; tracker.Finish(b.Sha, false); }
            }
            tracker.Flush();

            // 3. transfers (shared with concurrent callers), limited by the semaphore inside FetchShared
            var tasks = start.Select(async b =>
            {
                var o = await FetchShared(catalog, b, d => { tracker.Add(b.Sha, d); tracker.Flush(); }, ct);
                lock (report) { Mark(report, b, o.State); report.BytesDownloaded += o.Downloaded; }
                tracker.Finish(b.Sha, o.State == AssetFileState.Downloaded || o.State == AssetFileState.Cached);
                tracker.Flush();
                return o;
            }).ToList();
            var outcomes = await Task.WhenAll(tasks);
            var failed = outcomes.Where(o => o.State != AssetFileState.Downloaded && o.State != AssetFileState.Cached && o.State != AssetFileState.Cancelled).ToList();
            report.Offline = failed.Count > 0 && failed.All(o => o.NetworkOnly) && outcomes.All(o => o.State != AssetFileState.Downloaded);
            if (outcomes.Any(o => o.State == AssetFileState.DiskFull)) report.QuotaExceeded = true;
            ct.ThrowIfCancellationRequested();
            return report;
        }

        private long Budget()
        {
            long free = _cache.AvailableBytes();
            long b = free == long.MaxValue ? long.MaxValue : free - _opt.ReserveBytes;
            if (_opt.MaxCacheBytes > 0) b = Math.Min(b, _opt.MaxCacheBytes - _cache.UsedBytes());
            return Math.Max(0, b);
        }

        private static void Mark(AssetDownloadReport r, Blob b, AssetFileState s) { foreach (var e in b.Entries) r.Keys[e.Key] = s; }

        private static IEnumerable<Blob> Blobs(IEnumerable<AssetEntry> entries)
        {
            var map = new Dictionary<string, Blob>(StringComparer.Ordinal);
            var order = new List<Blob>();
            foreach (var e in entries)
            {
                if (e == null || !e.IsWellFormed()) continue;
                if (!map.TryGetValue(e.Sha256, out var b))
                {
                    b = new Blob { Sha = e.Sha256, Size = e.Size, First = e, Order = AssetGroups.IndexOf(e.Group) };
                    map[e.Sha256] = b;
                    order.Add(b);
                }
                b.Entries.Add(e);
                b.Groups.Add(e.Group);
                b.Required |= e.Required;
                b.Order = Math.Min(b.Order, AssetGroups.IndexOf(e.Group));
            }
            return order;
        }

        /// <summary>One transfer per content hash: a second caller (another group, an EnsureAsync) joins the running one.
        /// The transfer runs with the token of the caller that started it.</summary>
        private Task<FileOutcome> FetchShared(AssetCatalog catalog, Blob b, Action<long> onDelta, CancellationToken ct)
        {
            Inflight f;
            bool owner = false;
            lock (_gate)
            {
                if (!_inflight.TryGetValue(b.Sha, out f))
                {
                    f = new Inflight();
                    _inflight[b.Sha] = f;
                    owner = true;
                }
                f.Listeners.Add(onDelta);
            }
            if (owner) _ = Run(catalog, b, f, ct);
            return f.Done.Task;
        }

        private async Task Run(AssetCatalog catalog, Blob b, Inflight f, CancellationToken ct)
        {
            FileOutcome o;
            try
            {
                await _slots.WaitAsync(ct);
                try { o = await Transfer(catalog, b, d => Broadcast(f, d), ct); }
                finally { _slots.Release(); }
            }
            catch (OperationCanceledException) { o = new FileOutcome { State = AssetFileState.Cancelled }; }
            catch (Exception) { o = new FileOutcome { State = AssetFileState.Failed }; } // never leave joiners waiting
            lock (_gate) _inflight.Remove(b.Sha);
            f.Done.TrySetResult(o);
        }

        private void Broadcast(Inflight f, long delta)
        {
            Action<long>[] ls;
            lock (_gate) { f.Bytes += delta; ls = f.Listeners.ToArray(); }
            foreach (var l in ls) l(delta);
        }

        /// <summary>Counts bytes and remembers a failed disk write (so a full disk is not retried as a network error).</summary>
        private sealed class SinkStream : Stream
        {
            private readonly Stream _inner;
            private readonly Action<long> _onBytes;
            public bool WriteFailed;
            public IOException WriteError;
            public SinkStream(Stream inner, Action<long> onBytes) { _inner = inner; _onBytes = onBytes; }
            public override void Write(byte[] buffer, int offset, int count)
            {
                try { _inner.Write(buffer, offset, count); }
                catch (IOException e) { WriteFailed = true; WriteError = e; throw; }
                _onBytes(count);
            }
            public override bool CanRead => false;
            public override bool CanSeek => false;
            public override bool CanWrite => true;
            public override long Length => _inner.Length;
            public override long Position { get => _inner.Position; set => throw new NotSupportedException(); }
            public override void Flush() => _inner.Flush();
            public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
            public override void SetLength(long value) => throw new NotSupportedException();
            protected override void Dispose(bool disposing)
            {
                if (disposing)
                {
                    try { _inner.Dispose(); } // flushes: a full disk can surface here too
                    catch (IOException e) { WriteFailed = true; WriteError = e; }
                }
                base.Dispose(disposing);
            }
        }

        private async Task<FileOutcome> Transfer(AssetCatalog catalog, Blob b, Action<long> onDelta, CancellationToken ct)
        {
            string sha = b.Sha;
            string url = catalog.UrlFor(b.First);
            long downloaded = 0;
            bool networkOnly = true;
            for (int attempt = 0; attempt < Math.Max(1, _opt.MaxAttempts); attempt++)
            {
                ct.ThrowIfCancellationRequested();
                if (_cache.HasBlob(sha, b.Size)) return new FileOutcome { State = AssetFileState.Cached, Downloaded = downloaded };
                long have = _cache.PartialLength(sha);
                if (have > b.Size) { _cache.DeletePart(sha); onDelta(-b.Size); have = 0; }
                if (have == b.Size)
                {
                    var v = await Verify(sha);
                    if (v) { _cache.CommitPart(sha); return new FileOutcome { State = AssetFileState.Downloaded, Downloaded = downloaded }; }
                    _cache.DeletePart(sha); onDelta(-have); have = 0; networkOnly = false;
                }

                SinkStream sink = null;
                bool headSeen = false, diskError = false;
                int status;
                bool broke = false;
                try
                {
                    status = await _http.GetAsync(new AssetHttpRequest { Url = url, RangeStart = have }, head =>
                    {
                        if (headSeen) return null; // contract: openBody once
                        headSeen = true;
                        bool append = head.Status == 206 && have > 0;
                        bool whole = head.Status == 200 || head.Status == 206 && have == 0;
                        if (!append && !whole) return null;
                        if (!append && have > 0) onDelta(-have); // the server ignored the range: start over
                        FileStream fs;
                        try { fs = _cache.OpenPart(sha, append); }
                        catch (IOException) { diskError = true; throw; }
                        catch (UnauthorizedAccessException) { diskError = true; throw; }
                        sink = new SinkStream(fs, n => { downloaded += n; onDelta(n); });
                        return sink;
                    }, ct);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { sink?.Dispose(); throw; }
                catch (Exception)
                {
                    status = 0;
                    broke = true;
                }
                finally { sink?.Dispose(); }

                if (diskError || sink != null && sink.WriteFailed)
                {
                    long len = _cache.PartialLength(sha);
                    _cache.DeletePart(sha); onDelta(-Math.Min(len, b.Size));
                    return new FileOutcome { State = AssetFileState.DiskFull, Downloaded = downloaded };
                }
                if (headSeen) networkOnly = false; // the server answered
                if (broke)
                {
                    // no response, or the body stopped half way: keep the partial file, back off, resume
                    await Backoff(attempt, ct);
                    continue;
                }
                if (status == 200 || status == 206)
                {
                    long len = _cache.PartialLength(sha);
                    if (len < b.Size) { await Backoff(attempt, ct); continue; } // truncated: resume from here
                    if (len > b.Size || !await Verify(sha))
                    {
                        _cache.DeletePart(sha); onDelta(-Math.Min(len, b.Size));
                        if (attempt + 1 >= _opt.MaxAttempts) return new FileOutcome { State = AssetFileState.Corrupt, Downloaded = downloaded };
                        await Backoff(attempt, ct);
                        continue;
                    }
                    _cache.CommitPart(sha);
                    return new FileOutcome { State = AssetFileState.Downloaded, Downloaded = downloaded };
                }
                if (status == 416) { long len = _cache.PartialLength(sha); _cache.DeletePart(sha); onDelta(-Math.Min(len, b.Size)); continue; } // range no longer valid: start over
                if (status == 404 || status == 410 || status == 403) return new FileOutcome { State = AssetFileState.NotFound, Downloaded = downloaded };
                if (status >= 500 || status == 429 || status == 408) { await Backoff(attempt, ct); continue; }
                return new FileOutcome { State = AssetFileState.Failed, Downloaded = downloaded };
            }
            return new FileOutcome { State = AssetFileState.Failed, Downloaded = downloaded, NetworkOnly = networkOnly };
        }

        private Task Backoff(int attempt, CancellationToken ct)
            => attempt + 1 >= _opt.MaxAttempts ? Task.CompletedTask : _delay.Delay(_opt.Retry.DelayFor(attempt), ct);

        private async Task<bool> Verify(string sha)
        {
            string got = _opt.HashOnThreadPool ? await Task.Run(() => _cache.HashPart(sha)) : _cache.HashPart(sha);
            return string.Equals(got, sha, StringComparison.Ordinal);
        }

        /// <summary>Per-group byte/file counters; callbacks get a snapshot per changed group.</summary>
        private sealed class ProgressTracker
        {
            private readonly Action<AssetGroupProgress> _cb;
            private readonly object _lock = new object();
            private readonly Dictionary<string, AssetGroupProgress> _groups = new Dictionary<string, AssetGroupProgress>(StringComparer.Ordinal);
            private readonly Dictionary<string, (long size, long bytes, string[] groups, bool done)> _files = new Dictionary<string, (long, long, string[], bool)>(StringComparer.Ordinal);
            private readonly HashSet<string> _dirty = new HashSet<string>();

            public ProgressTracker(Action<AssetGroupProgress> cb) { _cb = cb; }

            public void Add(string sha, long size, IEnumerable<string> groups)
            {
                lock (_lock)
                {
                    var gs = groups.ToArray();
                    _files[sha] = (size, 0, gs, false);
                    foreach (var g in gs)
                    {
                        if (!_groups.TryGetValue(g, out var p)) _groups[g] = p = new AssetGroupProgress { Group = g };
                        p.TotalBytes += size; p.TotalFiles++;
                        _dirty.Add(g);
                    }
                }
            }

            public void Set(string sha, long bytes) { lock (_lock) Apply(sha, bytes - _files[sha].bytes); }
            public void Add(string sha, long delta) { lock (_lock) Apply(sha, delta); }

            private void Apply(string sha, long delta)
            {
                var f = _files[sha];
                if (f.done) return;
                long nb = Math.Max(0, Math.Min(f.size, f.bytes + delta));
                long d = nb - f.bytes;
                _files[sha] = (f.size, nb, f.groups, false);
                foreach (var g in f.groups) { _groups[g].DoneBytes += d; _dirty.Add(g); }
            }

            public void Finish(string sha, bool ok)
            {
                lock (_lock)
                {
                    var f = _files[sha];
                    if (f.done) return;
                    long d = ok ? f.size - f.bytes : 0;
                    _files[sha] = (f.size, ok ? f.size : f.bytes, f.groups, true);
                    foreach (var g in f.groups)
                    {
                        var p = _groups[g];
                        p.DoneBytes += d;
                        if (ok) p.DoneFiles++; else p.FailedFiles++;
                        _dirty.Add(g);
                    }
                }
            }

            public void Flush()
            {
                if (_cb == null) return;
                List<AssetGroupProgress> snap;
                lock (_lock)
                {
                    snap = _dirty.Select(g => _groups[g].Clone()).ToList();
                    _dirty.Clear();
                }
                foreach (var p in snap) _cb(p);
            }
        }
    }

    // ============================================================================================ resolution

    public enum AssetSource { None, Bundled, Downloaded }

    /// <summary>Where to load a key from after the fallback chain (REQ-ASSET-002).</summary>
    public sealed class AssetLocation
    {
        public string RequestedKey;
        /// <summary>The key to load (the requested one or &lt;kind&gt;/default); null = show nothing.</summary>
        public string Key;
        public AssetSource Source;
        /// <summary>File path for <see cref="AssetSource.Downloaded"/> (AssetBundle.LoadFromFileAsync / raw file).</summary>
        public string Path;
        public bool IsFallback => Key != null && Key != RequestedKey;
        public override string ToString() => RequestedKey + " → " + (Key ?? "(none)") + " [" + Source + "]";
    }

    /// <summary>
    /// Resolves asset keys against what is on the device: a verified downloaded file (preferred: it is the catalog's
    /// current version) or an asset bundled in the app (Resources / StreamingAssets, <paramref name="bundled"/>), through
    /// <see cref="AssetKeys.Resolve"/> so a key without art degrades to &lt;kind&gt;/default and then to nothing.
    /// </summary>
    public sealed class AssetResolver
    {
        private readonly AssetCatalog _catalog;
        private readonly AssetCache _cache;
        private readonly Func<string, bool> _bundled;

        public AssetResolver(AssetCatalog catalog, AssetCache cache, Func<string, bool> bundled)
        {
            _catalog = catalog ?? AssetCatalog.Empty("");
            _cache = cache;
            _bundled = bundled ?? (_ => false);
        }

        public bool IsDownloaded(string key)
        {
            var e = _catalog.Find(key);
            return e != null && _cache != null && _cache.HasBlob(e.Sha256, e.Size);
        }

        public bool Exists(string key) => IsDownloaded(key) || _bundled(key);

        public AssetLocation Resolve(string key)
        {
            var loc = new AssetLocation { RequestedKey = key, Key = AssetKeys.Resolve(key, Exists) };
            if (loc.Key == null) return loc;
            if (IsDownloaded(loc.Key)) { loc.Source = AssetSource.Downloaded; loc.Path = _cache.BlobPath(_catalog.Find(loc.Key).Sha256); }
            else loc.Source = AssetSource.Bundled;
            return loc;
        }
    }
}
