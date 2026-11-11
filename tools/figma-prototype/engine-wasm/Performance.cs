// Round 19: 画質・省電力・通信量 (REQ-PERF-*, contracts/protocol.md §56) for the web prototype: the real Muchi.Client
// PerformanceSettings / DeviceClassifier / RenderProfile decide what the prototype draws (pixel ratio, shadows, frame cap,
// speed lines, FOV kick, ambient motion), and AssetStorage / AssetDownloadPolicy compute the storage screen over a demo
// catalog (the prototype downloads nothing: which files are "on the device" is kept in the page's storage).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices.JavaScript;
using Muchi.Client;
using Muchi.Net;

public static partial class MuchiRace
{
    private static JsonNode F(float v) => JsonNode.NumRaw(v.ToString("0.###", CultureInfo.InvariantCulture));
    private static int PI(JsonNode o, string k, int def = 0) => o.TryGet(k, out var v) && v.Kind == JsonKind.Number ? v.AsInt() : def;
    private static bool PB(JsonNode o, string k) => o.TryGet(k, out var v) && v.Kind == JsonKind.Bool && v.AsBool();
    private static string PS(JsonNode o, string k) => o.TryGet(k, out var v) && v.Kind == JsonKind.String ? v.AsString() : null;

    /// <summary>{memoryMb, cores, gpuMb, software, refreshHz} → "low" | "mid" | "high".</summary>
    [JSExport]
    public static string PerfClassify(string profileJson)
    {
        var o = JsonNode.Parse(profileJson);
        return PerformanceSettings.Wire(DeviceClassifier.Classify(new DeviceProfile
        {
            SystemMemoryMb = PI(o, "memoryMb"), ProcessorCount = PI(o, "cores"), GraphicsMemoryMb = PI(o, "gpuMb"),
            SoftwareRenderer = PB(o, "software"), MaxRefreshHz = PI(o, "refreshHz"),
        }));
    }

    /// <summary>The stored settings JSON (PerformanceSettings.ToJson) + {deviceClass, inRace, lowPower, reduceMotion, refreshHz} → RenderProfile.</summary>
    [JSExport]
    public static string PerfResolve(string settingsJson, string contextJson)
    {
        var s = PerformanceSettings.Parse(settingsJson);
        var c = JsonNode.Parse(contextJson);
        string dc = PS(c, "deviceClass");
        var p = RenderProfile.Resolve(s, new PerformanceContext
        {
            DeviceClass = dc == "low" ? DeviceClass.Low : dc == "high" ? DeviceClass.High : DeviceClass.Mid,
            InRace = PB(c, "inRace"), OsLowPowerMode = PB(c, "lowPower"), ReduceMotion = PB(c, "reduceMotion"), MaxRefreshHz = PI(c, "refreshHz", 60),
        });
        return JsonNode.Obj()
            .Set("settings", JsonNode.Parse(s.ToJson()))
            .Set("tier", PerformanceSettings.Wire(p.Tier)).Set("urpQualityLevel", p.UrpQualityLevel).Set("targetFrameRate", p.TargetFrameRate)
            .Set("frameIntervalMs", p.FrameIntervalMs).Set("renderScale", F(p.RenderScale)).Set("shadows", p.Shadows.ToString().ToLowerInvariant())
            .Set("msaa", p.Msaa).Set("particleScale", F(p.ParticleScale)).Set("postProcessing", p.PostProcessing).Set("crowdDensity", F(p.CrowdDensity))
            .Set("speedLines", p.SpeedLines).Set("fovKick", p.FovKick).Set("ambientMotion", p.AmbientMotion).Set("batterySaverActive", p.BatterySaverActive)
            .ToString();
    }

    /// <summary>
    /// The storage screen over a catalog (the server's platform view shape) and the files on the "device"
    /// ({sha256: length}): rows, total, what 「すべてダウンロード」 still fetches (bytes and the files, in the data saver's
    /// version), what 「キャッシュを削除」 keeps (the required files), and the asset_predownload bucket.
    /// </summary>
    [JSExport]
    public static string StorageReport(string catalogJson, string blobsJson, double partialBytes, bool dataSaver)
    {
        var catalog = AssetCatalog.Parse(catalogJson);
        var blobs = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (var kv in JsonNode.Parse(blobsJson).Props) blobs[kv.Key] = kv.Value.AsLong();
        var r = AssetStorage.Measure(catalog, blobs, (long)partialBytes);
        var policy = new AssetDownloadPolicy(dataSaver);
        var missing = AssetStorage.PredownloadSet(catalog, policy).Where(e => !blobs.ContainsKey(e.Sha256)).GroupBy(e => e.Sha256).Select(g => g.First()).ToList();
        long pending = missing.Sum(e => e.Size);
        var rows = JsonNode.Arr();
        foreach (var row in r.Rows) rows.Add(JsonNode.Obj().Set("kind", row.Kind).Set("bytes", row.Bytes).Set("files", row.Files).Set("size", AssetStorage.FormatBytes(row.Bytes)));
        var fetch = JsonNode.Obj();
        foreach (var e in missing) fetch.Set(e.Sha256, e.Size);
        var keep = JsonNode.Arr();
        foreach (var k in AssetStorage.KeepOnClear(catalog).OrderBy(x => x, StringComparer.Ordinal)) keep.Add(JsonNode.Str(k));
        return JsonNode.Obj().Set("rows", rows).Set("totalBytes", r.TotalBytes).Set("total", AssetStorage.FormatBytes(r.TotalBytes))
            .Set("clearableBytes", r.ClearableBytes).Set("clearable", AssetStorage.FormatBytes(r.ClearableBytes))
            .Set("predownloadBytes", pending).Set("predownload", AssetStorage.FormatBytes(pending)).Set("fetch", fetch).Set("keep", keep)
            .Set("bucket", AssetStorage.BytesBucket(pending)).ToString();
    }
}
