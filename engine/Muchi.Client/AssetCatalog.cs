using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    /// <summary>Platforms the asset catalog is built for (GET /v1/assets/catalog?platform=…).</summary>
    public static class AssetPlatforms
    {
        public const string Ios = "ios";
        public const string Android = "android";
    }

    /// <summary>Preload groups in download order (server ASSET_GROUPS, contracts/protocol.md §15).</summary>
    public static class AssetGroups
    {
        public const string Boot = "boot";
        public const string Ftue = "ftue";
        public const string Home = "home";
        public const string Race = "race";
        public const string Shop = "shop";
        public const string OnDemand = "ondemand";
        public static readonly string[] Order = { Boot, Ftue, Home, Race, Shop, OnDemand };
        public static int IndexOf(string g) { int i = Array.IndexOf(Order, g); return i < 0 ? Order.Length : i; }
    }

    /// <summary>One asset key → one file on the CDN (several keys may share a file).</summary>
    public sealed class AssetEntry
    {
        public string Key;
        /// <summary>Path of the file under the platform folder (e.g. "horse/coat/bay.bundle").</summary>
        public string File;
        /// <summary>64 lowercase hex: the content hash, verified after download and used as the cache name.</summary>
        public string Sha256;
        public long Size;
        public string Group;
        /// <summary>The group's screen waits for it (only boot/ftue). Everything else degrades to &lt;kind&gt;/default.</summary>
        public bool Required;

        public static AssetEntry Parse(JsonNode o) => new AssetEntry
        {
            Key = J.Str(o, "key"), File = J.Str(o, "file"), Sha256 = J.Str(o, "sha256"), Size = J.Long(o, "size"),
            Group = J.Str(o, "group") ?? AssetGroups.OnDemand, Required = J.Bool(o, "required"),
        };

        /// <summary>Defensive check of a server entry: valid key, 64-hex hash, positive size, relative path without "..".</summary>
        public bool IsWellFormed()
        {
            if (!AssetKeys.IsValid(Key) || Size <= 0 || string.IsNullOrEmpty(File) || File.Length > 200) return false;
            if (Sha256 == null || Sha256.Length != 64) return false;
            foreach (char c in Sha256) if (!(c >= '0' && c <= '9' || c >= 'a' && c <= 'f')) return false;
            if (File.StartsWith("/", StringComparison.Ordinal) || File.Contains("\\") || File.Contains(":")) return false;
            foreach (var seg in File.Split('/')) if (seg.Length == 0 || seg == "." || seg == "..") return false;
            return true;
        }
    }

    /// <summary>Server-tunable delivery policy (catalog.policy).</summary>
    public sealed class AssetPolicy
    {
        public long FtueBlockingMaxBytes = 3_000_000;
        /// <summary>On cellular, ask before downloading more than this.</summary>
        public long CellularWarnBytes = 50_000_000;
        /// <summary>The FTUE download screen never waits longer than this before starting the tutorial with placeholders.</summary>
        public int TutorialMaxWaitMs = 3000;
        public int MaxParallel = 4;
        /// <summary>Client-side hard cap whatever the server sends (docs/planning/06: first race within 5 s, aha ≤ 30 s).</summary>
        public const int TutorialMaxWaitHardMs = 5000;

        public static AssetPolicy Parse(JsonNode o)
        {
            var p = new AssetPolicy();
            if (o == null) return p;
            p.FtueBlockingMaxBytes = J.Long(o, "ftueBlockingMaxBytes", p.FtueBlockingMaxBytes);
            p.CellularWarnBytes = J.Long(o, "cellularWarnBytes", p.CellularWarnBytes);
            p.TutorialMaxWaitMs = Math.Max(0, Math.Min(TutorialMaxWaitHardMs, J.Int(o, "tutorialMaxWaitMs", p.TutorialMaxWaitMs)));
            p.MaxParallel = Math.Max(1, Math.Min(8, J.Int(o, "maxParallel", p.MaxParallel)));
            return p;
        }
    }

    /// <summary>
    /// The per-platform delivery catalog (REQ-DLV-001..004, contracts/protocol.md §15): for each asset key the CDN file,
    /// its SHA-256 and size, its preload group and whether that group's screen waits for it. Keys without an entry are
    /// simply not delivered yet: resolve them through <see cref="AssetResolver"/> and they fall back to &lt;kind&gt;/default.
    /// </summary>
    public sealed class AssetCatalog
    {
        public int CatalogVersion;
        public int ManifestVersion;
        public string Platform;
        /// <summary>Server hash of this view; sent back as If-None-Match.</summary>
        public string Hash;
        /// <summary>CDN base; "" when the deployment has no CDN (nothing is downloaded, bundled assets and fallbacks only).</summary>
        public string BaseUrl = "";
        public string UrlTemplate = "{base}/{platform}/{sha256}/{file}";
        public AssetPolicy Policy = new AssetPolicy();
        public List<AssetEntry> Entries = new List<AssetEntry>();
        /// <summary>The JSON this catalog was parsed from (persisted as the last good catalog).</summary>
        public string Raw;
        private Dictionary<string, AssetEntry> _byKey;

        public bool HasCdn => !string.IsNullOrEmpty(BaseUrl);

        public static AssetCatalog Empty(string platform) => new AssetCatalog { Platform = platform, CatalogVersion = 0, Hash = null };

        /// <summary>Parses a server catalog. Malformed entries are dropped (they resolve to the fallback instead).</summary>
        public static AssetCatalog Parse(string json)
        {
            var o = JsonNode.Parse(json);
            if (o.Kind != JsonKind.Object || !o.Has("entries")) throw new FormatException("not an asset catalog");
            var c = new AssetCatalog
            {
                CatalogVersion = J.Int(o, "catalogVersion"), ManifestVersion = J.Int(o, "manifestVersion"), Platform = J.Str(o, "platform"),
                Hash = J.Str(o, "hash"), BaseUrl = (J.Str(o, "baseUrl") ?? "").TrimEnd('/'), UrlTemplate = J.Str(o, "urlTemplate") ?? "{base}/{platform}/{sha256}/{file}",
                Policy = AssetPolicy.Parse(J.Opt(o, "policy")), Raw = json,
            };
            if (string.IsNullOrEmpty(c.Hash)) throw new FormatException("asset catalog without hash");
            foreach (var e in J.List(o, "entries", AssetEntry.Parse)) if (e.IsWellFormed()) c.Entries.Add(e);
            return c;
        }

        public AssetEntry Find(string key)
        {
            if (key == null) return null;
            if (_byKey == null)
            {
                var d = new Dictionary<string, AssetEntry>(StringComparer.Ordinal);
                foreach (var e in Entries) d[e.Key] = e;
                _byKey = d;
            }
            return _byKey.TryGetValue(key, out var x) ? x : null;
        }

        /// <summary>Download URL of an entry (same expansion as the server's assetUrl).</summary>
        public string UrlFor(AssetEntry e)
            => UrlTemplate.Replace("{base}", BaseUrl).Replace("{platform}", Platform ?? "").Replace("{sha256}", e.Sha256).Replace("{file}", e.File);

        public List<AssetEntry> InGroups(IEnumerable<string> groups, bool requiredOnly = false)
        {
            var set = new HashSet<string>(groups);
            var list = new List<AssetEntry>();
            foreach (var e in Entries) if (set.Contains(e.Group) && (!requiredOnly || e.Required)) list.Add(e);
            return list;
        }

        /// <summary>Every content hash the catalog references (what the cache keeps; the rest is stale).</summary>
        public HashSet<string> ReferencedHashes()
        {
            var s = new HashSet<string>(StringComparer.Ordinal);
            foreach (var e in Entries) s.Add(e.Sha256);
            return s;
        }
    }

    /// <summary>Where the current catalog came from.</summary>
    public enum CatalogSource { None, Network, NotModified, Cached, Empty }

    /// <summary>
    /// Fetches the catalog (GET /v1/assets/catalog?platform=…, If-None-Match with the cached hash) and keeps the last
    /// good one on disk (<see cref="AssetCache.WriteCatalog"/>, atomic). When the server cannot be reached the cached
    /// catalog is used (<see cref="Offline"/>); with nothing cached an empty catalog (bundled assets and fallbacks only).
    /// Never throws for network or server problems. Refetch when GET /v1/config's assetCatalogVersion differs
    /// (<see cref="IsStale"/>).
    /// </summary>
    public sealed class AssetCatalogStore
    {
        private readonly IHttp _http;
        private readonly AssetCache _cache;
        private readonly RetryPolicy _retry;
        private readonly IDelay _delay;

        public string Platform { get; }
        public AssetCatalog Current { get; private set; }
        public CatalogSource Source { get; private set; } = CatalogSource.None;
        /// <summary>The last refresh could not reach the server (cached or empty catalog in use).</summary>
        public bool Offline { get; private set; }
        /// <summary>Why the last refresh failed (null when it succeeded).</summary>
        public string LastError { get; private set; }

        public AssetCatalogStore(IHttp http, AssetCache cache, string platform, RetryPolicy retry = null, IDelay delay = null)
        {
            _http = http;
            _cache = cache ?? throw new ArgumentNullException(nameof(cache));
            Platform = platform ?? throw new ArgumentNullException(nameof(platform));
            _retry = retry ?? new RetryPolicy { MaxRetries = 2 };
            _delay = delay ?? TaskDelay.Instance;
        }

        public string Path => "/v1/assets/catalog?platform=" + Uri.EscapeDataString(Platform);

        /// <summary>The catalog persisted by the last successful fetch, or null.</summary>
        public AssetCatalog LoadCached()
        {
            string text = _cache.ReadCatalog(Platform);
            if (text == null) return null;
            try { var c = AssetCatalog.Parse(text); return c.Platform == null || c.Platform == Platform ? c : null; }
            catch (Exception) { return null; } // a corrupt file is ignored (the next fetch replaces it)
        }

        /// <summary>True when the server reports another catalogVersion than the one in use.</summary>
        public bool IsStale(int serverCatalogVersion) => Current == null || Current.CatalogVersion != serverCatalogVersion;

        public async Task<AssetCatalog> RefreshAsync(CancellationToken ct = default)
        {
            var cached = Current != null && Current.Hash != null ? Current : LoadCached();
            if (_http == null) return UseFallback(cached, "no server");
            bool conditional = cached != null;
            int attempt = 0;
            while (true)
            {
                ct.ThrowIfCancellationRequested();
                var req = new HttpRequest { Method = "GET", Path = Path };
                req.Headers["accept"] = "application/json";
                if (conditional) req.Headers["if-none-match"] = "\"" + cached.Hash + "\"";
                HttpResponse res = null;
                string error = null;
                try { res = await _http.SendAsync(req, ct); }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                catch (Exception e) { error = e.Message; }

                if (res != null && res.Status == 304)
                {
                    if (cached != null) { Set(cached, CatalogSource.NotModified, false, null); return cached; }
                    conditional = false; // 304 without a local copy: ask again unconditionally
                    continue;
                }
                if (res != null && res.Status >= 200 && res.Status < 300)
                {
                    AssetCatalog next = null;
                    try { next = AssetCatalog.Parse(res.Body ?? ""); }
                    catch (Exception e) { error = "bad catalog: " + e.Message; }
                    if (next != null)
                    {
                        if (next.Platform == null) next.Platform = Platform;
                        try { _cache.WriteCatalog(Platform, next.Raw); }
                        catch (Exception) { /* persisting is best effort; the catalog is still usable this session */ }
                        Set(next, CatalogSource.Network, false, null);
                        return next;
                    }
                    return UseFallback(cached, error);
                }
                if (res != null) error = "HTTP " + res.Status.ToString(CultureInfo.InvariantCulture);
                bool transient = res == null || res.Status >= 500 || res.Status == 429;
                if (transient && attempt < _retry.MaxRetries)
                {
                    await _delay.Delay(_retry.DelayFor(attempt++), ct);
                    continue;
                }
                return UseFallback(cached, error);
            }
        }

        private AssetCatalog UseFallback(AssetCatalog cached, string error)
        {
            if (cached != null) Set(cached, CatalogSource.Cached, true, error);
            else Set(AssetCatalog.Empty(Platform), CatalogSource.Empty, true, error);
            return Current;
        }

        private void Set(AssetCatalog c, CatalogSource s, bool offline, string error)
        {
            Current = c; Source = s; Offline = offline; LastError = error;
        }
    }
}
