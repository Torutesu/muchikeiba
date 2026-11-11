using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // クライアントのエラー報告 (REQ-CERR-002..013/020, contracts/protocol.md §60): a small first-party error pipeline, no
    // third-party SDK. ErrorReporter scrubs and fingerprints every item on the device (the same rules as the server,
    // contracts/client-errors.vectors.json), samples per category, collapses repeats, keeps the queue across restarts and
    // sends batches with an idempotent batch id. Nothing here touches coins, items or races.

    public static class ClientErrorCategories
    {
        public const string Exception = "exception", Api = "api", Desync = "desync", Asset = "asset", Stall = "stall";
        public static readonly IReadOnlyList<string> All = new[] { Exception, Api, Desync, Asset, Stall };
    }

    /// <summary>
    /// REQ-CERR-008: drops personal data from free text. The patterns are the TypeScript ones (server/src/domain/clientErrors.ts
    /// SCRUB_RULES) character for character: classes spelled out in ASCII, explicit word boundaries, no case folding.
    /// </summary>
    public static class ErrorScrubber
    {
        public const int MessageMax = 300, StackMax = 4000, StackLines = 40, TitleMax = 160;
        private const string WS = @" \t\r\n\f\v";
        private const string B0 = @"(?<![A-Za-z0-9_])";
        private const string B1 = @"(?![A-Za-z0-9_])";
        private const RegexOptions O = RegexOptions.CultureInvariant;

        private static readonly (Regex Re, string To)[] Rules =
        {
            (new Regex("[" + WS + @"]*\[0x[0-9a-fA-F]+\]", O), ""),
            (new Regex("[" + WS + @"]*in <[0-9a-fA-F]{6,}>(?::[0-9]+)?", O), ""),
            (new Regex(@"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}", O), "<email>"),
            (new Regex(B0 + @"(?:[Bb]earer|BEARER)[ \t]+[A-Za-z0-9._~+/=\-]+", O), "<token>"),
            (new Regex(B0 + @"eyJ[A-Za-z0-9_\-]*\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+", O), "<token>"),
            (new Regex(B0 + @"[A-Za-z][A-Za-z0-9+.\-]*://[^" + WS + @"""'<>()]+", O), "<url>"),
            (new Regex(@"(?:[A-Za-z]:)?(?:[^" + WS + @"\\/:""'()<>\[\]]*[\\/])+([^" + WS + @"\\/:""'()<>\[\]]+)", O), "$1"),
            (new Regex("\"[^\"\\n]*\"|'[^'\\n]*'|「[^」\\n]*」", O), "\"…\""),
            (new Regex(@"[^\x00-\x7F]+", O), "…"),
            (new Regex(B0 + "[0-9a-fA-F]{12,}" + B1, O), "<id>"),
            (new Regex(B0 + @"(?=[A-Za-z0-9_\-]*[0-9])[A-Za-z0-9_\-]{20,}" + B1, O), "<id>"),
            (new Regex(B0 + "[a-z]{1,4}_(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{3,}" + B1, O), "<id>"),
            (new Regex("[0-9]{5,}", O), "<n>"),
            (new Regex(@"[ \t]+", O), " "),
            (new Regex(@"\A[" + WS + @"]+|[" + WS + @"]+\z", O), ""),
        };
        private static readonly Regex Edges = new Regex(@"\A[" + WS + @"]+|[" + WS + @"]+\z", O);
        private static readonly Regex AnyWs = new Regex("[" + WS + "]+", O);
        private static readonly Regex Newlines = new Regex(@"[\r\n]+", O);
        private static readonly Regex LineSplit = new Regex(@"\r?\n", O);
        private static readonly Regex DeviceOk = new Regex(@"\A[A-Za-z0-9 ,._()\-]{1,40}\z", O);
        private static readonly Regex PrefixedId = new Regex(@"\A[a-z]{1,4}_(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]+\z", O);
        private static readonly Regex AllDigits = new Regex(@"\A[0-9]+\z", O);
        private static readonly Regex QueryCut = new Regex("[?#]", O);

        private static string Line(string s)
        {
            foreach (var (re, to) in Rules) s = re.Replace(s, to);
            return s;
        }

        /// <summary>One line, at most 300 chars.</summary>
        public static string Message(string s) => Truncate(Line(Newlines.Replace(s ?? "", " ")), MessageMax);

        /// <summary>At most 40 non-empty lines, 4,000 chars.</summary>
        public static string Stack(string s)
        {
            var lines = LineSplit.Split(s ?? "").Select(Line).Where(l => l.Length > 0).Take(StackLines);
            return Truncate(string.Join("\n", lines), StackMax);
        }

        /// <summary>Device model / OS version: short allow-listed text, else "other".</summary>
        public static string DeviceField(string v)
        {
            var s = AnyWs.Replace(Edges.Replace(v ?? "", ""), " ");
            if (s.Length == 0) return "";
            return DeviceOk.IsMatch(s) ? s : "other";
        }

        /// <summary>"/v1/horses/h_9f2k/goals?x=1" → "/v1/horses/:id/goals".</summary>
        public static string NormalizeRoute(string route)
        {
            var path = QueryCut.Split(route ?? "")[0];
            var segs = path.Split('/');
            for (int i = 0; i < segs.Length; i++)
            {
                var seg = segs[i];
                if (seg.Length == 0 || seg[0] == ':') continue;
                bool hasDigit = seg.Any(c => c >= '0' && c <= '9');
                if (PrefixedId.IsMatch(seg) || (hasDigit && seg.Length >= 6) || AllDigits.IsMatch(seg)) segs[i] = ":id";
            }
            return string.Join("/", segs);
        }

        public static string AssetGroup(string key) => string.Join("/", (key ?? "").Split('/').Take(2));

        internal static string Truncate(string s, int max) => s.Length <= max ? s : s.Substring(0, max - 1) + "…";

        /// <summary>Replaces characters outside <paramref name="allowed"/> with '_' and cuts to <paramref name="max"/> (wire identifiers).</summary>
        internal static string Ident(string s, int max, Func<char, bool> allowed, string fallback)
        {
            if (string.IsNullOrEmpty(s)) return fallback;
            var sb = new StringBuilder(Math.Min(s.Length, max));
            foreach (var c in s) { if (sb.Length >= max) break; sb.Append(allowed(c) ? c : '_'); }
            return sb.Length == 0 ? fallback : sb.ToString();
        }
        internal static bool AsciiAlnum(char c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
    }

    /// <summary>REQ-CERR-009: the fingerprint (FNV-1a 64 over UTF-8, 16 hex chars) of a scrubbed item; the server computes the same.</summary>
    public static class ErrorFingerprint
    {
        private const RegexOptions O = RegexOptions.CultureInvariant;
        private static readonly Regex Il = new Regex(@"\[0x[0-9a-fA-F]+\]", O);
        private static readonly Regex Build = new Regex("<[0-9a-fA-F]{6,}>", O);
        private static readonly Regex Offset = new Regex(@"\+[ \t]*0x[0-9a-fA-F]+", O);
        private static readonly Regex LineNo = new Regex(":[0-9]+", O);
        private static readonly Regex Digits = new Regex("[0-9]+", O);
        private static readonly Regex AnyWs = new Regex(@"[ \t\r\n\f\v]+", O);
        private static readonly Regex Edges = new Regex(@"\A[ \t\r\n\f\v]+|[ \t\r\n\f\v]+\z", O);

        public static string Fnv64(string text)
        {
            ulong h = 0xcbf29ce484222325UL;
            foreach (var b in Encoding.UTF8.GetBytes(text ?? ""))
            {
                h ^= b;
                unchecked { h *= 0x100000001b3UL; }
            }
            return h.ToString("x16", CultureInfo.InvariantCulture);
        }

        public static string MessageTemplate(string scrubbed) => Digits.Replace(scrubbed ?? "", "#");

        public static string FrameKey(string line)
        {
            var s = Il.Replace(line ?? "", "");
            s = Build.Replace(s, "");
            s = Offset.Replace(s, "");
            s = LineNo.Replace(s, "");
            s = Digits.Replace(s, "#");
            s = AnyWs.Replace(s, " ");
            return Edges.Replace(s, "");
        }

        public static List<string> TopFrames(string scrubbedStack, int n = 5)
            => (scrubbedStack ?? "").Split('\n').Select(FrameKey).Where(l => l.Length > 0).Take(n).ToList();

        /// <summary>The string the fingerprint hashes (§60.4). The item must already be scrubbed (<see cref="ClientErrorItem"/> factories do it).</summary>
        public static string Source(ClientErrorItem i)
        {
            switch (i.Category)
            {
                case ClientErrorCategories.Exception: return string.Join("|", "exception", i.Type, MessageTemplate(i.Message), string.Join(";", TopFrames(i.Stack)));
                case ClientErrorCategories.Api: return string.Join("|", "api", i.Method, ErrorScrubber.NormalizeRoute(i.Route), i.Status.ToString(CultureInfo.InvariantCulture), i.Code ?? "-");
                case ClientErrorCategories.Desync: return string.Join("|", "desync", i.Mode);
                case ClientErrorCategories.Asset: return string.Join("|", "asset", i.Reason, ErrorScrubber.AssetGroup(i.AssetKey));
                default: return string.Join("|", "stall", i.Kind, i.Screen);
            }
        }

        public static string Of(ClientErrorItem i) => Fnv64(Source(i));
    }

    /// <summary>
    /// One report (§60.1). Build it with the factories: they scrub free text and shape every identifier to what the server
    /// accepts. A desync carries the race id and tick only — never inputs, checksums or state.
    /// </summary>
    public sealed class ClientErrorItem
    {
        public string Category { get; private set; }
        public long AtMs { get; private set; }
        public int Count { get; internal set; } = 1;
        public int SampleRate { get; internal set; } = 1000;
        // exception
        public string Type { get; private set; }
        public string Message { get; private set; }
        public string Stack { get; private set; }
        public bool Handled { get; private set; }
        public string Screen { get; private set; }
        // api
        public string Method { get; private set; }
        public string Route { get; private set; }
        public int Status { get; private set; }
        public string Code { get; private set; }
        // api / asset
        public string Reason { get; private set; }
        // desync
        public string RaceId { get; private set; }
        public int Tick { get; private set; }
        public string Mode { get; private set; }
        public int? EngineLevel { get; private set; }
        // asset
        public string AssetKey { get; private set; }
        public int? AssetStatus { get; private set; }
        // stall
        public string Kind { get; private set; }
        public int DurationMs { get; private set; }

        private string _fp;
        /// <summary>The fingerprint of this (scrubbed) item.</summary>
        public string Fingerprint => _fp ?? (_fp = ErrorFingerprint.Of(this));

        private ClientErrorItem() { }

        private static bool IdentChar(char c) => ErrorScrubber.AsciiAlnum(c) || c == '_' || c == '.' || c == ':' || c == '-';
        private static string IdentOf(string s, int max, string fallback) => ErrorScrubber.Ident(s, max, IdentChar, fallback);

        public static ClientErrorItem Exception(long atMs, string type, string message, string stack, bool handled = false, string screen = null)
            => new ClientErrorItem
            {
                Category = ClientErrorCategories.Exception, AtMs = atMs,
                Type = ErrorScrubber.Ident(type, 80, c => ErrorScrubber.AsciiAlnum(c) || "_.$`<>+-".IndexOf(c) >= 0, "Exception"),
                Message = ErrorScrubber.Message(message), Stack = ErrorScrubber.Stack(stack), Handled = handled,
                Screen = string.IsNullOrEmpty(screen) ? null : IdentOf(screen, 40, null),
            };

        public static ClientErrorItem FromException(long atMs, Exception e, bool handled = false, string screen = null)
            => Exception(atMs, e?.GetType().Name ?? "Exception", e?.Message ?? "", e?.StackTrace ?? "", handled, screen);

        /// <summary>reason: network | timeout | http (status 0 = no response).</summary>
        public static ClientErrorItem Api(long atMs, string method, string route, int status, string code, string reason)
        {
            var m = (method ?? "GET").ToUpperInvariant();
            if (m != "GET" && m != "POST" && m != "PUT" && m != "DELETE" && m != "PATCH") m = "GET";
            var r = ErrorScrubber.NormalizeRoute(route ?? "/v1/");
            r = ErrorScrubber.Ident(r, 160, c => ErrorScrubber.AsciiAlnum(c) || "_.:/-".IndexOf(c) >= 0, "/v1/");
            if (!r.StartsWith("/v1/", StringComparison.Ordinal)) r = "/v1/";
            var why = reason == "network" || reason == "timeout" ? reason : "http";
            return new ClientErrorItem
            {
                Category = ClientErrorCategories.Api, AtMs = atMs, Method = m, Route = r, Status = Math.Max(0, Math.Min(599, status)),
                Code = string.IsNullOrEmpty(code) ? null : IdentOf(code, 40, null), Reason = why,
            };
        }

        /// <summary>A lockstep desync (the room's `desync` message): race id, tick and mode only.</summary>
        public static ClientErrorItem Desync(long atMs, string raceId, int tick, string mode, int? engineLevel = null)
            => new ClientErrorItem
            {
                Category = ClientErrorCategories.Desync, AtMs = atMs, RaceId = IdentOf(raceId, 80, "unknown"), Tick = Math.Max(0, Math.Min(100_000, tick)),
                Mode = IdentOf(mode, 32, "unknown"), EngineLevel = engineLevel,
            };

        /// <summary>reason: http | hash | disk | timeout | network | other.</summary>
        public static ClientErrorItem Asset(long atMs, string assetKey, string reason, int? status = null)
        {
            var why = Array.IndexOf(new[] { "http", "hash", "disk", "timeout", "network" }, reason) >= 0 ? reason : "other";
            return new ClientErrorItem
            {
                Category = ClientErrorCategories.Asset, AtMs = atMs, Reason = why, AssetStatus = status,
                AssetKey = ErrorScrubber.Ident(assetKey, 120, c => ErrorScrubber.AsciiAlnum(c) || "_./-".IndexOf(c) >= 0, "unknown"),
            };
        }

        /// <summary>kind: long_frame | anr.</summary>
        public static ClientErrorItem Stall(long atMs, string kind, int durationMs, string screen)
            => new ClientErrorItem
            {
                Category = ClientErrorCategories.Stall, AtMs = atMs, Kind = kind == "anr" ? "anr" : "long_frame",
                DurationMs = Math.Max(1, Math.Min(600_000, durationMs)), Screen = IdentOf(screen, 40, "unknown"),
            };

        public JsonNode ToJson()
        {
            var o = JsonNode.Obj();
            o.Set("category", Category);
            o.Set("at", AtMs);
            o.Set("count", Count);
            o.Set("sampleRate", SampleRate);
            switch (Category)
            {
                case ClientErrorCategories.Exception:
                    o.Set("type", Type); o.Set("message", Message); o.Set("stack", Stack); o.Set("handled", Handled);
                    if (Screen != null) o.Set("screen", Screen);
                    break;
                case ClientErrorCategories.Api:
                    o.Set("method", Method); o.Set("route", Route); o.Set("status", Status); if (Code != null) o.Set("code", Code); o.Set("reason", Reason);
                    break;
                case ClientErrorCategories.Desync:
                    o.Set("raceId", RaceId); o.Set("tick", Tick); o.Set("mode", Mode); if (EngineLevel.HasValue) o.Set("engineLevel", EngineLevel.Value);
                    break;
                case ClientErrorCategories.Asset:
                    o.Set("assetKey", AssetKey); o.Set("reason", Reason); if (AssetStatus.HasValue) o.Set("status", AssetStatus.Value);
                    break;
                default:
                    o.Set("kind", Kind); o.Set("durationMs", DurationMs); o.Set("screen", Screen);
                    break;
            }
            return o;
        }

        /// <summary>Reads a stored item back (already scrubbed; the factories run again so a tampered file stays in shape).</summary>
        public static ClientErrorItem FromJson(JsonNode o)
        {
            long at = J.Long(o, "at");
            ClientErrorItem i;
            switch (J.Str(o, "category"))
            {
                case ClientErrorCategories.Exception: i = Exception(at, J.Str(o, "type"), J.Str(o, "message"), J.Str(o, "stack"), J.Bool(o, "handled"), J.Str(o, "screen")); break;
                case ClientErrorCategories.Api: i = Api(at, J.Str(o, "method"), J.Str(o, "route"), J.Int(o, "status"), J.Str(o, "code"), J.Str(o, "reason")); break;
                case ClientErrorCategories.Desync: i = Desync(at, J.Str(o, "raceId"), J.Int(o, "tick"), J.Str(o, "mode"), J.IntN(o, "engineLevel")); break;
                case ClientErrorCategories.Asset: i = Asset(at, J.Str(o, "assetKey"), J.Str(o, "reason"), J.IntN(o, "status")); break;
                case ClientErrorCategories.Stall: i = Stall(at, J.Str(o, "kind"), J.Int(o, "durationMs"), J.Str(o, "screen")); break;
                default: return null;
            }
            i.Count = Math.Max(1, Math.Min(10_000, J.Int(o, "count", 1)));
            i.SampleRate = Math.Max(1, Math.Min(1000, J.Int(o, "sampleRate", 1000)));
            return i;
        }
    }

    /// <summary>Per-category sampling in permille (the server's `sampling`). Desync is always kept.</summary>
    public sealed class ClientErrorSampling
    {
        private readonly Dictionary<string, int> _rates;
        public ClientErrorSampling(IDictionary<string, int> rates = null)
        {
            _rates = new Dictionary<string, int> { ["exception"] = 1000, ["api"] = 200, ["desync"] = 1000, ["asset"] = 500, ["stall"] = 100 };
            if (rates != null) foreach (var kv in rates) if (_rates.ContainsKey(kv.Key)) _rates[kv.Key] = Math.Max(0, Math.Min(1000, kv.Value));
            _rates["desync"] = 1000; // fairness: never sampled out (the server refuses any other value too)
        }
        public int RateOf(string category) => _rates.TryGetValue(category ?? "", out var r) ? r : 0;
        public static ClientErrorSampling Parse(JsonNode o)
        {
            if (o == null || o.Kind != JsonKind.Object) return null;
            var d = new Dictionary<string, int>();
            foreach (var kv in o.Props) if (kv.Value.Kind == JsonKind.Number) d[kv.Key] = kv.Value.AsInt();
            return new ClientErrorSampling(d);
        }
    }

    public sealed class ClientErrorBatchResult
    {
        public int Accepted, Dropped;
        public bool Duplicate;
        /// <summary>False: the server keeps nothing (switched off, or no store) — stop sending for this run.</summary>
        public bool Enabled = true;
        public ClientErrorSampling Sampling;
        public int FlushIntervalSec;
        public static ClientErrorBatchResult Parse(JsonNode o) => new ClientErrorBatchResult
        {
            Accepted = J.Int(o, "accepted"), Dropped = J.Int(o, "dropped"), Duplicate = J.Bool(o, "duplicate"), Enabled = J.Bool(o, "enabled", true),
            Sampling = ClientErrorSampling.Parse(J.Opt(o, "sampling")), FlushIntervalSec = J.Int(o, "flushIntervalSec"),
        };
    }

    /// <summary>An API call that failed (ApiClient.RequestFailed). Status 0 = no response; reason network | timeout | http.</summary>
    public sealed class ApiFailure
    {
        public string Method, Path, Code, Reason;
        public int Status;
    }

    /// <summary>Keeps the unsent queue across app restarts (Unity: a file under Application.persistentDataPath).</summary>
    public interface IClientErrorStore
    {
        string Load();
        void Save(string json);
    }

    public sealed class ClientErrorOptions
    {
        /// <summary>"ios" | "android" | "editor".</summary>
        public string Platform = "ios";
        public string AppVersion = "0.0.0";
        /// <summary>Allowed as is (§60.3): e.g. "iOS 18.1" / SystemInfo.operatingSystem shortened by the app.</summary>
        public string OsVersion = "";
        /// <summary>Allowed as is (§60.3): e.g. "iPhone15,2" (SystemInfo.deviceModel).</summary>
        public string DeviceModel = "";
        /// <summary>A random id made on first launch; null = the reporter makes one and keeps it in the store.</summary>
        public string InstallId;
        public long FlushIntervalMs = 60_000;
        /// <summary>The server's default maximum is 20.</summary>
        public int MaxBatch = 20;
        /// <summary>Distinct items kept while offline (repeats collapse into one item's count).</summary>
        public int MaxQueue = 200;
        public long MaxAgeMs = 7L * 86_400_000;
        public long BaseBackoffMs = 10_000;
        public long MaxBackoffMs = 900_000;
        public long RateLimitBackoffMs = 300_000;
    }

    public delegate Task<ClientErrorBatchResult> ClientErrorSend(JsonNode batch, CancellationToken ct);

    /// <summary>
    /// Batching, offline-safe error reporter (REQ-CERR-002..013). <see cref="Report"/> from anywhere (thread-safe), call
    /// <see cref="Update"/> every few seconds from the main thread. Rules:
    ///  - every item is scrubbed by its factory; the reporter samples it (<see cref="Sampling"/>, desync always kept) and
    ///    collapses it into a queued item with the same fingerprint (count + 1);
    ///  - a batch gets its id once and keeps it until the server answered (a retry after a crash or timeout re-sends the
    ///    same id; the server answers duplicate and nothing is counted twice);
    ///  - 429 waits, 400 drops the batch (one bad item cannot block the queue), other failures back off;
    ///  - the server's `enabled: false` stops reporting for this run; its `sampling` is used from then on;
    ///  - <see cref="AllowsDiagnostics"/> (the §58 consent hook, default true) decides `attachPlayer` for each batch;
    ///    <see cref="FollowConsent"/> binds it to the analytics choice (§58.10);
    ///  - <see cref="AccountChanged"/> (SESSION_REPLACED, a redeemed transfer code, sign-out): everything recorded so far is
    ///    sent without a player id, so the old account's errors never land on the new one (§60.6, R20 integration);
    ///  - the reporter never reports its own sending failures (no loop).
    /// </summary>
    public sealed class ErrorReporter
    {
        private readonly ClientErrorSend _send;
        private readonly ClientErrorOptions _opt;
        private readonly IClientErrorStore _store;
        private readonly Func<double> _random;
        private readonly object _gate = new object();
        private readonly List<ClientErrorItem> _queue = new List<ClientErrorItem>();
        private InFlight _batch;
        private Task<bool> _task;
        private long _nextFlushAt, _retryAt;
        private int _failures;
        private string _installId;
        /// <summary>How many items at the front of the queue were recorded under a previous account (sent with attachPlayer false).</summary>
        private int _anonQueued;

        private sealed class InFlight { public string Id; public bool AttachPlayer; public List<ClientErrorItem> Items; }

        /// <summary>The §58 consent hook: false sends `attachPlayer: false` (the server keeps no player id). Default: true.</summary>
        public Func<bool> AllowsDiagnostics { get; set; } = () => true;

        /// <summary>
        /// R20 integration (§58.10): the consent hook follows the player's analytics choice (<see cref="ConsentState.AllowsDiagnostics"/>),
        /// read at every batch. No view yet (signed out, first launch) → true: such batches carry no auth, and the server
        /// checks the choice itself for signed-in ones.
        /// </summary>
        public void FollowConsent(Func<ConsentState> state)
        {
            if (state == null) throw new ArgumentNullException(nameof(state));
            AllowsDiagnostics = () => state()?.AllowsDiagnostics ?? true;
        }

        /// <summary>
        /// R20 integration (§54 × §60.6): the signed-in account changed on this device (401 SESSION_REPLACED, a redeemed
        /// transfer code, sign-out / new start). The unanswered batch keeps its id but goes without a player id, and every
        /// item queued so far is sent in batches of its own without a player id. Kept across restarts.
        /// </summary>
        public void AccountChanged()
        {
            lock (_gate)
            {
                if (_batch != null) _batch.AttachPlayer = false;
                _anonQueued = _queue.Count;
                Persist();
            }
        }
        public ClientErrorSampling Sampling { get; private set; } = new ClientErrorSampling();
        public bool Enabled { get; private set; } = true;
        public int Sent { get; private set; }
        /// <summary>Items dropped locally (sampled out, too old, queue full) or refused by the server.</summary>
        public int Dropped { get; private set; }
        public string InstallId { get { lock (_gate) return _installId; } }
        public Exception LastStorageError { get; private set; }

        public ErrorReporter(ApiClient api, ClientErrorOptions options, IClientErrorStore store = null, long nowMs = 0, Func<double> random = null)
            : this((api ?? throw new ArgumentNullException(nameof(api))).SendClientErrorsAsync, options, store, nowMs, random) { }

        public ErrorReporter(ClientErrorSend send, ClientErrorOptions options, IClientErrorStore store = null, long nowMs = 0, Func<double> random = null)
        {
            _send = send ?? throw new ArgumentNullException(nameof(send));
            _opt = options ?? new ClientErrorOptions();
            _store = store;
            var rng = new Random();
            _random = random ?? (() => { lock (rng) return rng.NextDouble(); });
            _nextFlushAt = nowMs + _opt.FlushIntervalMs;
            Restore();
            if (string.IsNullOrEmpty(_installId)) { _installId = ValidId(_opt.InstallId) ?? Guid.NewGuid().ToString("N"); Persist(); }
        }

        /// <summary>Items waiting (queued and in the unanswered batch).</summary>
        public int Pending { get { lock (_gate) return _queue.Count + (_batch?.Items.Count ?? 0); } }
        public IReadOnlyList<ClientErrorItem> Queued { get { lock (_gate) return _queue.ToList(); } }

        /// <summary>Samples, collapses and queues one item. Returns false when it was not kept.</summary>
        public bool Report(ClientErrorItem item)
        {
            if (item == null) return false;
            lock (_gate)
            {
                if (!Enabled) { Dropped++; return false; }
                int rate = Sampling.RateOf(item.Category);
                if (rate <= 0 || (rate < 1000 && _random() * 1000 >= rate)) { Dropped++; return false; }
                item.SampleRate = rate;
                var same = _queue.FirstOrDefault(x => x.Fingerprint == item.Fingerprint && x.SampleRate == rate);
                if (same != null) same.Count = Math.Min(10_000, same.Count + item.Count);
                else
                {
                    _queue.Add(item);
                    if (_queue.Count > _opt.MaxQueue) { _queue.RemoveAt(0); Dropped++; if (_anonQueued > 0) _anonQueued--; }
                }
                Persist();
                return true;
            }
        }

        public bool ReportException(long atMs, Exception e, bool handled = false, string screen = null) => Report(ClientErrorItem.FromException(atMs, e, handled, screen));
        public bool ReportDesync(long atMs, string raceId, int tick, string mode, int? engineLevel = null) => Report(ClientErrorItem.Desync(atMs, raceId, tick, mode, engineLevel));
        public bool ReportAsset(long atMs, string assetKey, string reason, int? status = null) => Report(ClientErrorItem.Asset(atMs, assetKey, reason, status));
        public bool ReportStall(long atMs, string kind, int durationMs, string screen) => Report(ClientErrorItem.Stall(atMs, kind, durationMs, screen));

        /// <summary>
        /// The files of an AssetDownloader run that failed for good: Failed → http, NotFound → http 404, Corrupt → hash,
        /// DiskFull → disk. A run where every failure was "no response" (<see cref="AssetDownloadReport.Offline"/>) is the
        /// device being offline, not an asset problem: nothing is reported. Returns how many items were queued.
        /// </summary>
        public int ReportAssetDownload(long atMs, AssetDownloadReport report)
        {
            if (report == null || report.Offline) return 0;
            int n = 0;
            foreach (var kv in report.Keys)
            {
                string reason; int? status = null;
                switch (kv.Value)
                {
                    case AssetFileState.Failed: reason = "http"; break;
                    case AssetFileState.NotFound: reason = "http"; status = 404; break;
                    case AssetFileState.Corrupt: reason = "hash"; break;
                    case AssetFileState.DiskFull: reason = "disk"; break;
                    default: continue;
                }
                if (ReportAsset(atMs, kv.Key, reason, status)) n++;
            }
            return n;
        }

        /// <summary>
        /// §60.1: the API failures worth reporting — no response, 5xx, 400 / 401 / 403 / 413 / 422. Business answers (404, 409,
        /// 410, 429, insufficient coins…) and this reporter's own endpoint are not reported.
        /// </summary>
        public static bool IsReportable(ApiFailure f)
        {
            if (f == null || f.Path == null) return false;
            var path = f.Path.Split('?')[0];
            if (path == "/v1/client-errors") return false;
            int s = f.Status;
            return s == 0 || s >= 500 || s == 400 || s == 401 || s == 403 || s == 413 || s == 422;
        }

        public bool ReportApi(long atMs, ApiFailure f)
            => IsReportable(f) && Report(ClientErrorItem.Api(atMs, f.Method, f.Path, f.Status, f.Code, f.Reason));

        /// <summary>Reports the client's failed calls (ApiClient.RequestFailed). <paramref name="clock"/> = Unix ms.</summary>
        public void AttachTo(ApiClient api, Func<long> clock)
        {
            if (api == null) throw new ArgumentNullException(nameof(api));
            api.RequestFailed += f => ReportApi(clock(), f);
        }

        /// <summary>Reports the room's desync messages for this race (race id and tick; never inputs).</summary>
        public void WatchRace(LockstepClient race, string mode, Func<long> clock)
        {
            if (race == null) throw new ArgumentNullException(nameof(race));
            race.Desync += (c, tick) => ReportDesync(clock(), c.RaceId, tick, mode, EngineInfo.Level);
        }

        /// <summary>Starts a send in the background when one is due. Returns true if it started one.</summary>
        public bool Update(long nowMs)
        {
            lock (_gate)
            {
                if (!Enabled || (_task != null && !_task.IsCompleted)) return false;
                if ((_queue.Count == 0 && _batch == null) || nowMs < _retryAt) return false;
                if (_batch == null && _queue.Count < _opt.MaxBatch && nowMs < _nextFlushAt) return false;
                _task = FlushCoreAsync(nowMs, CancellationToken.None);
                return true;
            }
        }

        /// <summary>Sends everything now (e.g. when the app goes to the background), until empty or a failure.</summary>
        public async Task FlushAllAsync(long nowMs, CancellationToken ct = default)
        {
            while (Pending > 0 && Enabled)
            {
                Task<bool> t;
                lock (_gate) t = _task != null && !_task.IsCompleted ? _task : (_task = FlushCoreAsync(nowMs, ct));
                if (!await t) return;
            }
        }

        private async Task<bool> FlushCoreAsync(long nowMs, CancellationToken ct)
        {
            InFlight b;
            lock (_gate)
            {
                long cutoff = nowMs - _opt.MaxAgeMs;
                _anonQueued -= _queue.Take(_anonQueued).Count(x => x.AtMs < cutoff);
                int stale = _queue.RemoveAll(x => x.AtMs < cutoff);
                Dropped += stale;
                if (_batch == null)
                {
                    if (_queue.Count == 0) { _anonQueued = 0; if (stale > 0) Persist(); return false; }
                    // a previous account's items go first, on their own and without a player id (AccountChanged)
                    bool anon = _anonQueued > 0;
                    var items = _queue.GetRange(0, Math.Min(_opt.MaxBatch, anon ? _anonQueued : _queue.Count));
                    _queue.RemoveRange(0, items.Count);
                    if (anon) _anonQueued -= items.Count;
                    _batch = new InFlight { Id = NewBatchId(), AttachPlayer = !anon && SafeAllows(), Items = items };
                }
                b = _batch;
                Persist();
            }
            try
            {
                var r = await _send(BatchJson(b), ct);
                lock (_gate)
                {
                    if (_batch == b) _batch = null;
                    Sent += r.Duplicate ? b.Items.Count : r.Accepted;
                    Dropped += r.Dropped;
                    _failures = 0; _retryAt = 0;
                    if (r.Sampling != null) Sampling = r.Sampling;
                    if (r.FlushIntervalSec > 0) _opt.FlushIntervalMs = r.FlushIntervalSec * 1000L;
                    _nextFlushAt = nowMs + _opt.FlushIntervalMs;
                    if (!r.Enabled) { Enabled = false; Dropped += _queue.Count; _queue.Clear(); _anonQueued = 0; }
                    Persist();
                }
                return true;
            }
            catch (ValidationException)
            {
                lock (_gate) { if (_batch == b) _batch = null; Dropped += b.Items.Count; Persist(); }
                return true;
            }
            catch (RateLimitedException)
            {
                lock (_gate) _retryAt = nowMs + Math.Max(_opt.RateLimitBackoffMs, Backoff(++_failures));
                return false;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception)
            {
                // network / 5xx / sign-in: keep the batch (same id) and try later; never reported (no loop)
                lock (_gate) _retryAt = nowMs + Backoff(++_failures);
                return false;
            }
        }

        private bool SafeAllows() { try { return AllowsDiagnostics?.Invoke() ?? true; } catch { return false; } }

        private JsonNode BatchJson(InFlight b)
        {
            var o = JsonNode.Obj();
            o.Set("batchId", b.Id);
            o.Set("platform", _opt.Platform == "android" || _opt.Platform == "editor" ? _opt.Platform : "ios");
            o.Set("appVersion", ErrorScrubber.Ident(_opt.AppVersion, 32, c => ErrorScrubber.AsciiAlnum(c) || ".+_-".IndexOf(c) >= 0, "0.0.0"));
            o.Set("osVersion", ErrorScrubber.DeviceField(_opt.OsVersion));
            o.Set("deviceModel", ErrorScrubber.DeviceField(_opt.DeviceModel));
            o.Set("installId", _installId);
            o.Set("attachPlayer", b.AttachPlayer && SafeAllows()); // consent withdrawn since the batch was made: no player id
            var arr = JsonNode.Arr();
            foreach (var i in b.Items) arr.Add(i.ToJson());
            o.Set("items", arr);
            return o;
        }

        /// <summary>A fresh id per batch (its own randomness: an injected sampling roll must never make two batches share an id).</summary>
        private static string NewBatchId() => "b_" + Guid.NewGuid().ToString("N").Substring(0, 16);

        private static string ValidId(string s) => !string.IsNullOrEmpty(s) && s.Length >= 8 && s.Length <= 64 && s.All(c => ErrorScrubber.AsciiAlnum(c) || c == '_' || c == '-') ? s : null;

        private long Backoff(int failures)
        {
            long b = _opt.BaseBackoffMs;
            for (int i = 1; i < failures && b < _opt.MaxBackoffMs; i++) b *= 2;
            return Math.Min(b, _opt.MaxBackoffMs);
        }

        private void Persist()
        {
            if (_store == null) return;
            try
            {
                var o = JsonNode.Obj();
                o.Set("v", 1);
                o.Set("installId", _installId);
                var q = JsonNode.Arr();
                foreach (var i in _queue) q.Add(i.ToJson());
                o.Set("queue", q);
                if (_anonQueued > 0) o.Set("anon", _anonQueued);
                if (_batch != null)
                {
                    var b = JsonNode.Obj();
                    b.Set("id", _batch.Id);
                    b.Set("attachPlayer", _batch.AttachPlayer);
                    var items = JsonNode.Arr();
                    foreach (var i in _batch.Items) items.Add(i.ToJson());
                    b.Set("items", items);
                    o.Set("batch", b);
                }
                _store.Save(o.ToString());
            }
            catch (Exception e) { LastStorageError = e; }
        }

        private void Restore()
        {
            if (_store == null) return;
            try
            {
                var s = _store.Load();
                if (string.IsNullOrEmpty(s)) return;
                var o = JsonNode.Parse(s);
                _installId = ValidId(J.Str(o, "installId"));
                foreach (var it in J.List(o, "queue", ClientErrorItem.FromJson)) if (it != null && _queue.Count < _opt.MaxQueue) _queue.Add(it);
                _anonQueued = Math.Max(0, Math.Min(_queue.Count, J.Int(o, "anon")));
                var b = J.Opt(o, "batch");
                var id = J.Str(b, "id");
                if (b != null && id != null && id.Length >= 8 && id.Length <= 64)
                {
                    var items = J.List(b, "items", ClientErrorItem.FromJson).Where(x => x != null).ToList();
                    if (items.Count > 0) _batch = new InFlight { Id = id, AttachPlayer = J.Bool(b, "attachPlayer", true), Items = items };
                }
            }
            catch (Exception e) { LastStorageError = e; _queue.Clear(); _batch = null; _anonQueued = 0; }
        }
    }

    /// <summary>
    /// Long frames and stalls (§60.1 `stall`): feed it every frame with the Unix ms. A gap of <see cref="LongFrameMs"/> or more
    /// is a long frame, <see cref="AnrMs"/> or more an ANR-like stall; one report per screen and kind per <see cref="CooldownMs"/>.
    /// Call <see cref="Pause"/> when the app goes to the background so the gap of being away is not counted.
    /// </summary>
    public sealed class StallDetector
    {
        public int LongFrameMs = 700, AnrMs = 5000;
        public long CooldownMs = 60_000;
        private long _last = -1;
        private readonly Dictionary<string, long> _lastReport = new Dictionary<string, long>();

        public void Pause() => _last = -1;

        /// <summary>Returns the stall to report (or null).</summary>
        public ClientErrorItem Frame(long nowMs, string screen)
        {
            long prev = _last;
            _last = nowMs;
            if (prev < 0) return null;
            long gap = nowMs - prev;
            if (gap < LongFrameMs) return null;
            string kind = gap >= AnrMs ? "anr" : "long_frame";
            string key = kind + "|" + (screen ?? "");
            if (_lastReport.TryGetValue(key, out var t) && nowMs - t < CooldownMs) return null;
            _lastReport[key] = nowMs;
            return ClientErrorItem.Stall(nowMs, kind, (int)Math.Min(gap, 600_000), screen);
        }
    }

    public sealed partial class ApiClient
    {
        /// <summary>
        /// REQ-CERR-002: raised once for every call that failed for good (after the retries): status 0 = no response
        /// (reason network / timeout), otherwise the HTTP status and error code. Maintenance / upgrade answers are not raised
        /// (they have their own events). ErrorReporter.AttachTo listens here.
        /// </summary>
        public event Action<ApiFailure> RequestFailed;

        private void NoteFailure(string method, string path, int status, string code, string reason)
        {
            var h = RequestFailed;
            if (h == null) return;
            try { h(new ApiFailure { Method = method, Path = path, Status = status, Code = code, Reason = reason }); }
            catch (Exception) { /* a listener must never break the call that failed */ }
        }

        private static bool IsTimeout(Exception e)
        {
            for (var x = e; x != null; x = x.InnerException)
                if (x is TimeoutException || x is TaskCanceledException || (x.Message != null && x.Message.IndexOf("timeout", StringComparison.OrdinalIgnoreCase) >= 0)) return true;
            return false;
        }

        /// <summary>
        /// POST /v1/client-errors (§60.2). Signed in when a token is available (the server treats a missing or bad token as
        /// anonymous); never retried here — the ErrorReporter keeps the batch (same id) and backs off.
        /// </summary>
        public Task<ClientErrorBatchResult> SendClientErrorsAsync(JsonNode batch, CancellationToken ct = default)
        {
            bool auth = _auth != null || !string.IsNullOrEmpty(_opt.DevUserId);
            return Call("POST", "/v1/client-errors", batch, auth, null, false, ClientErrorBatchResult.Parse, ct);
        }
    }
}
