using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Muchi.Net;

namespace Muchi.Client
{
    // 画質・省電力・通信量の設定 (REQ-PERF-001..018, contracts/protocol.md §56, docs/handoff-codex-round19-performance-settings.md).
    // Device-local presentation and download settings. Nothing here reaches Muchi.Engine: the race steps at its fixed 20 Hz
    // from the clock whatever the frame rate, so a setting changes how often and how finely a frame is drawn and which
    // asset files are fetched, never a race result (PerformanceSettingsTests.RaceHashIsTheSameForEverySetting).

    public enum GraphicsQuality { Auto = 0, Low = 1, Medium = 2, High = 3 }
    public enum FrameRateCap { Auto = 0, Fps30 = 30, Fps60 = 60 }
    /// <summary>REQ-PERF-002: picks the auto defaults only (never matchmaking, ratings or rewards).</summary>
    public enum DeviceClass { Low = 0, Mid = 1, High = 2 }
    /// <summary>The resolved quality step (also the URP quality level index).</summary>
    public enum QualityTier { Low = 0, Medium = 1, High = 2 }
    public enum ShadowQuality { Off = 0, Hard = 1, Soft = 2 }
    /// <summary>What the device is connected through, as the download policy sees it (Unity: Application.internetReachability).</summary>
    public enum AssetNetwork { None = 0, Cellular = 1, Wifi = 2 }

    /// <summary>REQ-PERF-001: the four device settings (stored on the device only, §56.6).</summary>
    public sealed class PerformanceSettings
    {
        public const string KeyGraphics = "graphics", KeyFrameRate = "frameRate", KeyBatterySaver = "batterySaver", KeyDataSaver = "dataSaver";
        public static readonly string[] Keys = { KeyGraphics, KeyFrameRate, KeyBatterySaver, KeyDataSaver };

        public GraphicsQuality Graphics = GraphicsQuality.Auto;
        public FrameRateCap FrameRate = FrameRateCap.Auto;
        public bool BatterySaver;
        public bool DataSaver;

        /// <summary>auto / auto / off / off.</summary>
        public static PerformanceSettings Defaults => new PerformanceSettings();
        public PerformanceSettings Clone() => (PerformanceSettings)MemberwiseClone();
        public bool SameValues(PerformanceSettings o) => o != null && Graphics == o.Graphics && FrameRate == o.FrameRate && BatterySaver == o.BatterySaver && DataSaver == o.DataSaver;

        public static string Wire(GraphicsQuality g) => g == GraphicsQuality.Low ? "low" : g == GraphicsQuality.Medium ? "medium" : g == GraphicsQuality.High ? "high" : "auto";
        public static string Wire(FrameRateCap f) => f == FrameRateCap.Fps30 ? "30" : f == FrameRateCap.Fps60 ? "60" : "auto";
        public static string Wire(DeviceClass c) => c == DeviceClass.Low ? "low" : c == DeviceClass.High ? "high" : "mid";
        public static string Wire(QualityTier t) => t == QualityTier.Low ? "low" : t == QualityTier.High ? "high" : "medium";
        public static GraphicsQuality ParseGraphics(string s) => s == "low" ? GraphicsQuality.Low : s == "medium" ? GraphicsQuality.Medium : s == "high" ? GraphicsQuality.High : GraphicsQuality.Auto;
        public static FrameRateCap ParseFrameRate(string s) => s == "30" ? FrameRateCap.Fps30 : s == "60" ? FrameRateCap.Fps60 : FrameRateCap.Auto;

        /// <summary>The wire value of one key ("auto", "medium", "30", "on"…), as the KPI and the settings rows use it.</summary>
        public string Value(string key)
        {
            switch (key)
            {
                case KeyGraphics: return Wire(Graphics);
                case KeyFrameRate: return Wire(FrameRate);
                case KeyBatterySaver: return BatterySaver ? "on" : "off";
                case KeyDataSaver: return DataSaver ? "on" : "off";
                default: return null;
            }
        }

        /// <summary>Sets one key from a wire value. False for an unknown key or value (nothing changes).</summary>
        public bool Apply(string key, string value)
        {
            switch (key)
            {
                case KeyGraphics: if (value != "auto" && value != "low" && value != "medium" && value != "high") return false; Graphics = ParseGraphics(value); return true;
                case KeyFrameRate: if (value != "auto" && value != "30" && value != "60") return false; FrameRate = ParseFrameRate(value); return true;
                case KeyBatterySaver: if (value != "on" && value != "off") return false; BatterySaver = value == "on"; return true;
                case KeyDataSaver: if (value != "on" && value != "off") return false; DataSaver = value == "on"; return true;
                default: return false;
            }
        }

        /// <summary>Unknown, missing or corrupt values fall back to the defaults.</summary>
        public static PerformanceSettings Parse(string json)
        {
            var s = new PerformanceSettings();
            if (string.IsNullOrWhiteSpace(json)) return s;
            JsonNode o;
            try { o = JsonNode.Parse(json); } catch (FormatException) { return s; }
            if (o == null || o.Kind != JsonKind.Object) return s;
            s.Graphics = ParseGraphics(StrOf(o, KeyGraphics));
            s.FrameRate = ParseFrameRate(StrOf(o, KeyFrameRate));
            s.BatterySaver = BoolOf(o, KeyBatterySaver);
            s.DataSaver = BoolOf(o, KeyDataSaver);
            return s;
        }

        private static string StrOf(JsonNode o, string k) { var v = J.Opt(o, k); return v != null && v.Kind == JsonKind.String ? v.AsString() : null; }
        private static bool BoolOf(JsonNode o, string k) { var v = J.Opt(o, k); return v != null && v.Kind == JsonKind.Bool && v.AsBool(); }

        public string ToJson()
            => JsonNode.Obj().Set(KeyGraphics, Wire(Graphics)).Set(KeyFrameRate, Wire(FrameRate)).Set(KeyBatterySaver, BatterySaver).Set(KeyDataSaver, DataSaver).ToString();
    }

    /// <summary>What the device reports about itself (Unity: SystemInfo + Screen; see the handoff).</summary>
    public sealed class DeviceProfile
    {
        public int SystemMemoryMb;
        public int ProcessorCount;
        /// <summary>0 = unknown (many mobile drivers report nothing useful).</summary>
        public int GraphicsMemoryMb;
        /// <summary>A software rasteriser (SwiftShader, llvmpipe…).</summary>
        public bool SoftwareRenderer;
        /// <summary>The display's maximum refresh rate; 0 = unknown (treated as 60).</summary>
        public int MaxRefreshHz;
    }

    /// <summary>Device hooks the game layer reads (Codex implements it on SystemInfo and the OS low-power notification).</summary>
    public interface IDeviceInfo
    {
        DeviceProfile Profile { get; }
        /// <summary>iOS Low Power Mode / Android Battery Saver is on.</summary>
        bool LowPowerMode { get; }
    }

    /// <summary>A fixed device (tests, the editor, the prototype).</summary>
    public sealed class StaticDeviceInfo : IDeviceInfo
    {
        public DeviceProfile Profile { get; set; } = new DeviceProfile { SystemMemoryMb = 4096, ProcessorCount = 6, MaxRefreshHz = 60 };
        public bool LowPowerMode { get; set; }
    }

    /// <summary>REQ-PERF-002: low / mid / high from memory, cores, GPU memory and a software renderer (§56.2).</summary>
    public static class DeviceClassifier
    {
        public const int LowMemoryMb = 3000, LowCores = 4, LowGpuMb = 512;
        public const int HighMemoryMb = 6000, HighCores = 6, HighGpuMb = 2048;

        public static DeviceClass Classify(DeviceProfile p)
        {
            if (p == null) return DeviceClass.Mid;
            if (p.SoftwareRenderer || p.SystemMemoryMb > 0 && p.SystemMemoryMb < LowMemoryMb || p.ProcessorCount > 0 && p.ProcessorCount < LowCores
                || p.GraphicsMemoryMb > 0 && p.GraphicsMemoryMb < LowGpuMb) return DeviceClass.Low;
            if (p.SystemMemoryMb >= HighMemoryMb && p.ProcessorCount >= HighCores && (p.GraphicsMemoryMb <= 0 || p.GraphicsMemoryMb >= HighGpuMb)) return DeviceClass.High;
            return DeviceClass.Mid;
        }

        public static QualityTier AutoTier(DeviceClass c) => c == DeviceClass.Low ? QualityTier.Low : c == DeviceClass.High ? QualityTier.High : QualityTier.Medium;
    }

    /// <summary>The situation a frame is drawn in (changes at runtime: entering a race, the OS low-power switch).</summary>
    public sealed class PerformanceContext
    {
        public DeviceClass DeviceClass = DeviceClass.Mid;
        public bool InRace;
        public bool OsLowPowerMode;
        /// <summary>§41.6 reduce motion (an accessibility setting; composes with these, never overridden by them).</summary>
        public bool ReduceMotion;
        public int MaxRefreshHz = 60;
    }

    /// <summary>
    /// REQ-PERF-003/004/016: the values Unity binds — QualitySettings level, Application.targetFrameRate, the URP asset's
    /// renderScale / MSAA / shadows, particle and crowd budgets, and which effects run. Presentation only.
    /// </summary>
    public sealed class RenderProfile
    {
        public QualityTier Tier;
        /// <summary>QualitySettings.SetQualityLevel index (0 low, 1 medium, 2 high in the project's URP list).</summary>
        public int UrpQualityLevel;
        /// <summary>Application.targetFrameRate (30 or 60).</summary>
        public int TargetFrameRate;
        public float RenderScale;
        public ShadowQuality Shadows;
        /// <summary>0 (off), 2 or 4.</summary>
        public int Msaa;
        public float ParticleScale;
        public bool PostProcessing;
        public float CrowdDensity;
        public bool SpeedLines;
        public bool FovKick;
        /// <summary>Slow ambient motion of menu art (the home key art's drift).</summary>
        public bool AmbientMotion;
        /// <summary>The setting is on or the OS is in low-power mode.</summary>
        public bool BatterySaverActive;
        /// <summary>Milliseconds between drawn frames at the target rate (33 or 16; rendering loops and tests).</summary>
        public int FrameIntervalMs => TargetFrameRate <= 30 ? 33 : 16;

        private static readonly (int urp, float scale, ShadowQuality sh, int msaa, float particles, bool post, float crowd)[] Table =
        {
            (0, 0.70f, ShadowQuality.Off, 0, 0.35f, false, 0.3f),   // low
            (1, 0.85f, ShadowQuality.Hard, 2, 0.70f, true, 0.6f),   // medium
            (2, 1.00f, ShadowQuality.Soft, 4, 1.00f, true, 1.0f),   // high
        };

        public const int BatterySaverMenuFps = 30;
        public const float BatterySaverMaxScale = 0.85f;
        public const float BatterySaverParticles = 0.5f;

        /// <summary>The tier a setting resolves to on a device class (auto → the class's tier).</summary>
        public static QualityTier TierFor(GraphicsQuality g, DeviceClass c)
            => g == GraphicsQuality.Low ? QualityTier.Low : g == GraphicsQuality.Medium ? QualityTier.Medium : g == GraphicsQuality.High ? QualityTier.High : DeviceClassifier.AutoTier(c);

        /// <summary>The frame cap before the battery saver: auto → 30 on low-class devices, else 60; never above a display under 60 Hz.</summary>
        public static int CapFor(FrameRateCap f, DeviceClass c, int maxRefreshHz)
        {
            int cap = f == FrameRateCap.Fps30 ? 30 : f == FrameRateCap.Fps60 ? 60 : c == DeviceClass.Low ? 30 : 60;
            if (maxRefreshHz > 0 && maxRefreshHz < 60) cap = 30;
            return cap;
        }

        public static RenderProfile Resolve(PerformanceSettings s, PerformanceContext ctx)
        {
            s = s ?? PerformanceSettings.Defaults;
            ctx = ctx ?? new PerformanceContext();
            var tier = TierFor(s.Graphics, ctx.DeviceClass);
            var row = Table[(int)tier];
            bool saver = s.BatterySaver || ctx.OsLowPowerMode;
            int fps = CapFor(s.FrameRate, ctx.DeviceClass, ctx.MaxRefreshHz);
            var p = new RenderProfile
            {
                Tier = tier, UrpQualityLevel = row.urp, TargetFrameRate = fps, RenderScale = row.scale, Shadows = row.sh, Msaa = row.msaa,
                ParticleScale = row.particles, PostProcessing = row.post, CrowdDensity = row.crowd, BatterySaverActive = saver,
            };
            if (saver)
            {
                if (!ctx.InRace) p.TargetFrameRate = Math.Min(p.TargetFrameRate, BatterySaverMenuFps); // the race keeps its cap (REQ-PERF-004)
                p.ParticleScale = row.particles * BatterySaverParticles;
                p.PostProcessing = false;
                if (p.Shadows == ShadowQuality.Soft) p.Shadows = ShadowQuality.Hard;
                p.RenderScale = Math.Min(p.RenderScale, BatterySaverMaxScale);
            }
            // REQ-PERF-016: motion is the accessibility setting's; weight is ours. Each only ever removes effects.
            var motion = MotionPolicy.For(ctx.ReduceMotion);
            p.SpeedLines = motion.SpeedLines && tier != QualityTier.Low && !saver;
            p.FovKick = motion.FovKickScale > 0f;
            p.AmbientMotion = motion.BackgroundDrift && !saver;
            return p;
        }
    }

    // ============================================================================================ data saver (§56.4)

    /// <summary>Where one entry stands under the policy.</summary>
    public enum AssetDecision { Download, WaitForWifi, Offline }

    public sealed class AssetDownloadPlan
    {
        /// <summary>Entries to fetch now, already mapped to the version to fetch (<see cref="AssetDownloadPolicy.Pick"/>).</summary>
        public readonly List<AssetEntry> Now = new List<AssetEntry>();
        /// <summary>Optional entries held back until Wi-Fi (data saver on cellular), mapped likewise.</summary>
        public readonly List<AssetEntry> WaitForWifi = new List<AssetEntry>();
    }

    /// <summary>
    /// REQ-PERF-005..009: which files to fetch over which connection. Required entries always (any connection: the
    /// tutorial never waits on a setting); optional ones only on Wi-Fi while the data saver is on, and their low variant
    /// when the catalog has one. With the data saver off it changes nothing (the §16 behaviour, cellular dialog included).
    /// </summary>
    public sealed class AssetDownloadPolicy
    {
        public bool DataSaver { get; }
        public AssetDownloadPolicy(bool dataSaver) { DataSaver = dataSaver; }
        public static readonly AssetDownloadPolicy Default = new AssetDownloadPolicy(false);
        public static AssetDownloadPolicy For(PerformanceSettings s) => new AssetDownloadPolicy(s != null && s.DataSaver);

        public bool UseLow(AssetEntry e) => DataSaver && e != null && !e.Required && e.Low != null;

        /// <summary>The version of <paramref name="e"/> to fetch (its low variant under the data saver, else itself).</summary>
        public AssetEntry Pick(AssetEntry e) => UseLow(e) ? e.LowEntry() : e;

        public AssetDecision Decide(AssetEntry e, AssetNetwork net)
        {
            if (net == AssetNetwork.None) return AssetDecision.Offline;
            if (e != null && e.Required) return AssetDecision.Download;
            if (net == AssetNetwork.Cellular && DataSaver) return AssetDecision.WaitForWifi;
            return AssetDecision.Download;
        }

        /// <summary>Optional downloads are held for Wi-Fi on this connection (no cellular dialog is then needed).</summary>
        public bool HoldsOptional(AssetNetwork net) => DataSaver && net == AssetNetwork.Cellular;

        public AssetDownloadPlan Plan(IEnumerable<AssetEntry> entries, AssetNetwork net)
        {
            var plan = new AssetDownloadPlan();
            foreach (var e in entries ?? Enumerable.Empty<AssetEntry>())
            {
                if (e == null) continue;
                var d = Decide(e, net);
                if (d == AssetDecision.Download) plan.Now.Add(Pick(e));
                else plan.WaitForWifi.Add(Pick(e));
            }
            return plan;
        }
    }

    // ============================================================================================ storage (§56.8)

    public sealed class StorageRow
    {
        /// <summary>required | screens | ondemand | low | partial | stale.</summary>
        public string Kind;
        public long Bytes;
        public int Files;
    }

    public sealed class StorageReport
    {
        public static readonly string[] Kinds = { "required", "screens", "ondemand", "low", "partial", "stale" };
        public readonly List<StorageRow> Rows = Kinds.Select(k => new StorageRow { Kind = k }).ToList();
        public StorageRow Row(string kind) => Rows.First(r => r.Kind == kind);
        public long TotalBytes => Rows.Sum(r => r.Bytes);
        /// <summary>What "clear cache" frees (everything but the required files).</summary>
        public long ClearableBytes => TotalBytes - Row("required").Bytes;
        /// <summary>Bytes the "download all" button would still fetch (current data-saver version).</summary>
        public long PredownloadBytes;
    }

    /// <summary>REQ-PERF-008/013/014: usage by row, the "download all" set and its size, the KPI size bucket.</summary>
    public static class AssetStorage
    {
        /// <summary>
        /// Usage of the files on the device. <paramref name="blobs"/>: content hash → length of each verified file. A hash is
        /// counted once: required (any required entry uses it) → screens / ondemand (an entry's normal version) → low
        /// (only a low variant uses it) → stale (the catalog no longer references it).
        /// </summary>
        public static StorageReport Measure(AssetCatalog catalog, IReadOnlyDictionary<string, long> blobs, long partialBytes, int partialFiles = 0)
        {
            catalog = catalog ?? AssetCatalog.Empty("");
            var r = new StorageReport();
            var required = new HashSet<string>(catalog.Entries.Where(e => e.Required).Select(e => e.Sha256), StringComparer.Ordinal);
            var full = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var e in catalog.Entries)
            {
                string k = e.Group == AssetGroups.OnDemand ? "ondemand" : "screens";
                if (!full.TryGetValue(e.Sha256, out var prev) || prev == "ondemand") full[e.Sha256] = k; // a screen group wins over ondemand
            }
            var low = new HashSet<string>(catalog.Entries.Where(e => e.Low != null).Select(e => e.Low.Sha256), StringComparer.Ordinal);
            foreach (var kv in blobs ?? new Dictionary<string, long>())
            {
                string kind = required.Contains(kv.Key) ? "required" : full.TryGetValue(kv.Key, out var g) ? g : low.Contains(kv.Key) ? "low" : "stale";
                var row = r.Row(kind);
                row.Bytes += kv.Value; row.Files++;
            }
            var part = r.Row("partial");
            part.Bytes = partialBytes; part.Files = partialFiles;
            return r;
        }

        /// <summary><see cref="Measure(AssetCatalog, IReadOnlyDictionary{string, long}, long, int)"/> over a cache on disk, with the "download all" size.</summary>
        public static StorageReport Measure(AssetCatalog catalog, AssetCache cache, AssetDownloadPolicy policy = null)
        {
            var blobs = new Dictionary<string, long>(StringComparer.Ordinal);
            long partBytes = 0; int partFiles = 0;
            if (cache != null)
            {
                foreach (var (sha, len) in cache.ListBlobs()) blobs[sha] = len;
                foreach (var (_, len) in cache.ListPartials()) { partBytes += len; partFiles++; }
            }
            var r = Measure(catalog, blobs, partBytes, partFiles);
            if (cache != null) r.PredownloadBytes = PendingBytes(PredownloadSet(catalog, policy), cache);
            return r;
        }

        /// <summary>Every optional entry (ondemand included), mapped to the version the policy fetches.</summary>
        public static List<AssetEntry> PredownloadSet(AssetCatalog catalog, AssetDownloadPolicy policy)
        {
            policy = policy ?? AssetDownloadPolicy.Default;
            return (catalog?.Entries ?? new List<AssetEntry>()).Where(e => !e.Required).Select(policy.Pick).ToList();
        }

        /// <summary>Bytes still missing for these entries (one count per content hash; a partial file counts as fetched so far).</summary>
        public static long PendingBytes(IEnumerable<AssetEntry> entries, AssetCache cache)
        {
            long n = 0;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var e in entries)
            {
                if (e == null || !seen.Add(e.Sha256)) continue;
                if (cache.HasBlob(e.Sha256, e.Size)) continue;
                n += Math.Max(0, e.Size - Math.Min(e.Size, cache.PartialLength(e.Sha256)));
            }
            return n;
        }

        /// <summary>The hashes "clear cache" keeps: every required file of the current catalog (REQ-PERF-014).</summary>
        public static HashSet<string> KeepOnClear(AssetCatalog catalog)
            => new HashSet<string>((catalog?.Entries ?? new List<AssetEntry>()).Where(e => e.Required).Select(e => e.Sha256), StringComparer.Ordinal);

        /// <summary>REQ-PERF-015: the asset_predownload size bucket (decimal megabytes, like the stores).</summary>
        public static string BytesBucket(long bytes)
        {
            if (bytes < 10_000_000) return "lt_10mb";
            if (bytes < 50_000_000) return "10_50mb";
            if (bytes < 200_000_000) return "50_200mb";
            if (bytes < 1_000_000_000) return "200mb_1gb";
            return "gte_1gb";
        }

        /// <summary>"12.3MB" / "850KB" / "1.20GB" (decimal units; the same as AssetPreloadModel.FormatBytes).</summary>
        public static string FormatBytes(long n)
        {
            if (n <= 0) return "0MB";
            if (n < 1_000_000) return Math.Max(1, (int)Math.Round(n / 1000.0)).ToString(CultureInfo.InvariantCulture) + "KB";
            if (n < 1_000_000_000) return (n / 1_000_000.0).ToString("0.0", CultureInfo.InvariantCulture) + "MB";
            return (n / 1_000_000_000.0).ToString("0.00", CultureInfo.InvariantCulture) + "GB";
        }
    }

    public sealed partial class AnalyticsEvent
    {
        /// <summary>REQ-PERF-015: the player changed a device setting (never for the automatic defaults or the same value).</summary>
        public static AnalyticsEvent PerfSettingChange(long atMs, string setting, string value, DeviceClass deviceClass)
        {
            if (Array.IndexOf(PerformanceSettings.Keys, setting) < 0) throw new ArgumentException("unknown setting " + setting);
            if (!PerformanceSettings.Defaults.Apply(setting, value)) throw new ArgumentException("value " + value + " is not valid for " + setting);
            return new AnalyticsEvent("perf_setting_change", atMs, JsonNode.Obj().Set("setting", setting).Set("value", value).Set("deviceClass", PerformanceSettings.Wire(deviceClass)));
        }

        /// <summary>REQ-PERF-015: "download all" started (the size still to fetch as a bucket, and the version fetched).</summary>
        public static AnalyticsEvent AssetPredownload(long atMs, long pendingBytes, bool lowVariant)
            => new AnalyticsEvent("asset_predownload", atMs, JsonNode.Obj().Set("bucket", AssetStorage.BytesBucket(pendingBytes)).Set("variant", lowVariant ? "low" : "full"));
    }
}
