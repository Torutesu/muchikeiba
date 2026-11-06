using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    /// <summary>
    /// One client analytics event (REQ-KPI-003). Only events the server cannot observe itself are accepted;
    /// purchases, gacha, race results etc. are recorded server-side. Build them with the factory methods.
    /// </summary>
    public sealed class AnalyticsEvent
    {
        public readonly string Name;
        /// <summary>Unix time in milliseconds when it happened (the server drops events older than 7 days).</summary>
        public readonly long AtMs;
        private readonly JsonNode _props;

        private static readonly Regex Ident = new Regex("^[A-Za-z0-9_\\-.:]{1,64}$");

        private AnalyticsEvent(string name, long atMs, JsonNode props) { Name = name; AtMs = atMs; _props = props ?? JsonNode.Obj(); }

        private static string Id(string v, int max, string what)
        {
            if (v == null || v.Length > max || !Ident.IsMatch(v)) throw new ArgumentException(what + " must be 1-" + max + " chars of [A-Za-z0-9_-.:]");
            return v;
        }

        public static AnalyticsEvent SessionStart(long atMs) => new AnalyticsEvent("session_start", atMs, null);
        public static AnalyticsEvent SessionEnd(long atMs, long durationMs)
            => new AnalyticsEvent("session_end", atMs, JsonNode.Obj().Set("durationMs", Math.Max(0, Math.Min(durationMs, 86_400_000L))));
        /// <summary>Tutorial funnel: call once per step reached (index 0, 1, 2…).</summary>
        public static AnalyticsEvent TutorialStep(long atMs, string step, int index)
            => new AnalyticsEvent("tutorial_step", atMs, JsonNode.Obj().Set("step", Id(step, 32, "step")).Set("index", Math.Max(0, Math.Min(index, 100))));
        public static AnalyticsEvent ScreenView(long atMs, string screen) => new AnalyticsEvent("screen_view", atMs, JsonNode.Obj().Set("screen", Id(screen, 32, "screen")));
        /// <summary>mode: ranked | friend | tutorial | offline | time_attack.</summary>
        public static AnalyticsEvent RaceStart(long atMs, string mode)
        {
            if (mode != "ranked" && mode != "friend" && mode != "tutorial" && mode != "offline" && mode != "time_attack") throw new ArgumentException("unknown race mode " + mode);
            return new AnalyticsEvent("race_start", atMs, JsonNode.Obj().Set("mode", mode));
        }
        /// <summary>stage: open | cancel | fail | store_success (the server records the verified purchase itself).</summary>
        public static AnalyticsEvent PurchaseFlow(long atMs, string stage, string productId)
        {
            if (stage != "open" && stage != "cancel" && stage != "fail" && stage != "store_success") throw new ArgumentException("unknown purchase stage " + stage);
            return new AnalyticsEvent("purchase_flow", atMs, JsonNode.Obj().Set("stage", stage).Set("productId", Id(productId, 64, "productId")));
        }
        /// <summary>The player opened the app from a push (templateId comes from the push data payload).</summary>
        public static AnalyticsEvent PushOpen(long atMs, string templateId) => new AnalyticsEvent("push_open", atMs, JsonNode.Obj().Set("templateId", Id(templateId, 32, "templateId")));
        public static AnalyticsEvent PushPermission(long atMs, bool granted) => new AnalyticsEvent("push_permission", atMs, JsonNode.Obj().Set("granted", granted));

        // ---- REQ-UXS-030 (server/src/domain/kpi.ts clientEventSchema)

        /// <summary>The fixed FTUE step list (protocol §8.7); the server checks that index = position + 1.</summary>
        public static readonly IReadOnlyList<string> FtueSteps = new[] { "consent", "race1_start", "race1_whip", "race1_win", "named", "gacha_done", "race2_done", "home" };
        /// <summary>§5.1 offer triggers.</summary>
        public static readonly IReadOnlyList<string> OfferTriggers = new[] { "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8" };
        /// <summary>race_quit modes (a superset of race_start's).</summary>
        public static readonly IReadOnlyList<string> QuitModes = new[] { "ranked", "friend", "tutorial", "offline", "time_attack", "event", "tournament" };

        private static int IndexIn(IReadOnlyList<string> list, string v)
        {
            for (int i = 0; i < list.Count; i++) if (list[i] == v) return i;
            return -1;
        }

        /// <summary>
        /// REQ-UXS-030: one step of the fixed FTUE funnel (<see cref="FtueSteps"/>), with the index the server expects.
        /// <paramref name="value"/> is optional (race1_win: retries before the win; 0..1,000,000).
        /// </summary>
        public static AnalyticsEvent FtueStep(long atMs, string step, int? value = null)
        {
            int i = IndexIn(FtueSteps, step);
            if (i < 0) throw new ArgumentException("unknown FTUE step " + step);
            var p = JsonNode.Obj().Set("step", step).Set("index", i + 1);
            if (value.HasValue) p.Set("value", Math.Max(0, Math.Min(value.Value, 1_000_000)));
            return new AnalyticsEvent("tutorial_step", atMs, p);
        }

        /// <summary>A home feature opened for the player (REQ-UXS-014 unlock key, e.g. "shop").</summary>
        public static AnalyticsEvent FeatureUnlock(long atMs, string feature) => new AnalyticsEvent("feature_unlock", atMs, JsonNode.Obj().Set("feature", Id(feature, 32, "feature")));

        /// <summary>A one-time offer sheet was shown (trigger T1..T8 = the §5.1 touchpoint).</summary>
        public static AnalyticsEvent OfferView(long atMs, string offerId, string trigger) => Offer("offer_view", atMs, offerId, trigger);
        /// <summary>The player tapped through an offer.</summary>
        public static AnalyticsEvent OfferClick(long atMs, string offerId, string trigger) => Offer("offer_click", atMs, offerId, trigger);

        private static AnalyticsEvent Offer(string name, long atMs, string offerId, string trigger)
        {
            if (IndexIn(OfferTriggers, trigger) < 0) throw new ArgumentException("unknown offer trigger " + trigger);
            return new AnalyticsEvent(name, atMs, JsonNode.Obj().Set("offerId", Id(offerId, 64, "offerId")).Set("trigger", trigger));
        }

        /// <summary>The player left a race before the finish; remainingM is clamped to 0..10,000.</summary>
        public static AnalyticsEvent RaceQuit(long atMs, string mode, int remainingM)
        {
            if (IndexIn(QuitModes, mode) < 0) throw new ArgumentException("unknown race mode " + mode);
            return new AnalyticsEvent("race_quit", atMs, JsonNode.Obj().Set("mode", mode).Set("remainingM", Math.Max(0, Math.Min(remainingM, 10_000))));
        }

        /// <summary>
        /// The anonymous account was linked to Apple/Google (REQ-API-005; send only on LinkResult.Linked). provider: apple | google,
        /// or the Firebase provider ids apple.com / google.com.
        /// </summary>
        public static AnalyticsEvent AccountLink(long atMs, string provider)
        {
            string p = provider == "apple.com" ? "apple" : provider == "google.com" ? "google" : provider;
            if (p != "apple" && p != "google") throw new ArgumentException("unknown provider " + provider);
            return new AnalyticsEvent("account_link", atMs, JsonNode.Obj().Set("provider", p));
        }

        /// <summary>A replay was handed to the OS share sheet (REQ-UXS-072). kind: replay_video | replay_image.</summary>
        public static AnalyticsEvent Share(long atMs, string kind)
        {
            if (kind != "replay_video" && kind != "replay_image") throw new ArgumentException("unknown share kind " + kind);
            return new AnalyticsEvent("share", atMs, JsonNode.Obj().Set("kind", kind));
        }

        // ---- REQ-AD-010 rewarded ads (the reward itself is the server event ad_reward; never sent from here)
        private static readonly string[] AdSurfaces = { "home", "result", "time_attack", "shop" };
        private static readonly string[] AdOutcomes = { "shown", "no_fill", "failed", "closed_early" };

        /// <summary>An ad offer card was put on screen (once per card per screen visit).</summary>
        public static AnalyticsEvent AdOfferView(long atMs, string placementId, string surface)
        {
            if (IndexIn(AdSurfaces, surface) < 0) throw new ArgumentException("unknown ad surface " + surface);
            return new AnalyticsEvent("ad_offer_view", atMs, JsonNode.Obj().Set("placementId", Id(placementId, 32, "placementId")).Set("surface", surface));
        }

        /// <summary>The player tapped the card and the SDK answered: shown | no_fill | failed | closed_early.</summary>
        public static AnalyticsEvent AdStart(long atMs, string placementId, string surface, string outcome)
        {
            if (IndexIn(AdSurfaces, surface) < 0) throw new ArgumentException("unknown ad surface " + surface);
            if (IndexIn(AdOutcomes, outcome) < 0) throw new ArgumentException("unknown ad outcome " + outcome);
            return new AnalyticsEvent("ad_start", atMs, JsonNode.Obj().Set("placementId", Id(placementId, 32, "placementId")).Set("surface", surface).Set("outcome", outcome));
        }

        internal JsonNode ToJson()
        {
            var o = JsonNode.Obj();
            o.Set("name", Name);
            o.Set("at", AtMs);
            o.Set("props", _props);
            return o;
        }

        internal static AnalyticsEvent FromJson(JsonNode o)
            => new AnalyticsEvent(J.Str(o, "name"), J.Long(o, "at"), J.Opt(o, "props") ?? JsonNode.Obj());
    }

    /// <summary>Keeps unsent events across app restarts (Unity: a file under Application.persistentDataPath, or PlayerPrefs).</summary>
    public interface IAnalyticsStore
    {
        /// <summary>The last saved JSON, or null when nothing was saved.</summary>
        string Load();
        void Save(string json);
    }

    public sealed class AnalyticsOptions
    {
        /// <summary>"ios" | "android" | "editor".</summary>
        public string Platform = "ios";
        public string AppVersion = "0.0.0";
        public long FlushIntervalMs = 30_000;
        /// <summary>Server maximum is 50 per request.</summary>
        public int MaxBatch = 50;
        /// <summary>Oldest events are dropped beyond this (offline for a long time).</summary>
        public int MaxQueue = 1000;
        /// <summary>The server ignores events older than 7 days; drop them locally a little earlier.</summary>
        public long MaxAgeMs = 7L * 86_400_000 - 3_600_000;
        public long BaseBackoffMs = 5_000;
        public long MaxBackoffMs = 600_000;
        /// <summary>Wait at least this long after a 429 RATE_LIMITED.</summary>
        public long RateLimitBackoffMs = 60_000;
    }

    public delegate Task<AnalyticsIngestResult> AnalyticsSend(string platform, string appVersion, IReadOnlyList<AnalyticsEvent> events, CancellationToken ct);

    /// <summary>
    /// Batching analytics client (REQ-KPI-003/004). Queue events with <see cref="Track"/>, call
    /// <see cref="Update"/> every frame (or every few seconds) with the current Unix time in ms; it flushes when
    /// the interval has passed or a full batch is waiting. Unsent events are persisted through
    /// <see cref="IAnalyticsStore"/> and retried with exponential backoff. A batch the server rejects as invalid
    /// (400) is dropped so one bad event cannot block the queue forever.
    /// </summary>
    public sealed class AnalyticsClient
    {
        private readonly AnalyticsSend _send;
        private readonly AnalyticsOptions _opt;
        private readonly IAnalyticsStore _store;
        private readonly object _gate = new object();
        private readonly List<AnalyticsEvent> _queue = new List<AnalyticsEvent>();
        private Task<bool> _inFlight;
        private long _nextFlushAt, _retryAt;
        private int _failures;

        public int Sent { get; private set; }
        /// <summary>Events dropped locally (too old, queue overflow) or rejected by the server.</summary>
        public int Dropped { get; private set; }

        public AnalyticsClient(ApiClient api, AnalyticsOptions options, IAnalyticsStore store = null, long nowMs = 0)
            : this((api ?? throw new ArgumentNullException(nameof(api))).SendAnalyticsAsync, options, store, nowMs) { }

        public AnalyticsClient(AnalyticsSend send, AnalyticsOptions options, IAnalyticsStore store = null, long nowMs = 0)
        {
            _send = send ?? throw new ArgumentNullException(nameof(send));
            _opt = options ?? new AnalyticsOptions();
            _store = store;
            _nextFlushAt = nowMs + _opt.FlushIntervalMs;
            Restore();
        }

        /// <summary>
        /// Raised when the store failed to save or load (the queue stays in memory). Persisting runs on the thread
        /// that drives this client (call it from the Unity main thread so PlayerPrefs/File work).
        /// </summary>
        public event Action<Exception> StorageError;
        public Exception LastStorageError { get; private set; }

        public int Pending { get { lock (_gate) return _queue.Count; } }
        public bool Flushing { get { lock (_gate) return _inFlight != null && !_inFlight.IsCompleted; } }

        public void Track(AnalyticsEvent e)
        {
            if (e == null) throw new ArgumentNullException(nameof(e));
            lock (_gate)
            {
                _queue.Add(e);
                if (_queue.Count > _opt.MaxQueue)
                {
                    int over = _queue.Count - _opt.MaxQueue;
                    _queue.RemoveRange(0, over);
                    Dropped += over;
                }
                Persist();
            }
        }

        /// <summary>Starts a flush in the background when one is due. Returns true if it started one.</summary>
        public bool Update(long nowMs)
        {
            lock (_gate)
            {
                if (_inFlight != null && !_inFlight.IsCompleted) return false;
                if (_queue.Count == 0 || nowMs < _retryAt) return false;
                if (_queue.Count < _opt.MaxBatch && nowMs < _nextFlushAt) return false;
                _inFlight = FlushCoreAsync(nowMs, CancellationToken.None);
                return true;
            }
        }

        /// <summary>The flush already in flight, or a new one. Only one request is ever outstanding.</summary>
        private Task<bool> StartOrJoin(long nowMs, CancellationToken ct)
        {
            lock (_gate)
            {
                if (_inFlight != null && !_inFlight.IsCompleted) return _inFlight;
                _inFlight = FlushCoreAsync(nowMs, ct);
                return _inFlight;
            }
        }

        /// <summary>Sends everything now (e.g. when the app goes to the background), batch by batch, until empty or a failure.</summary>
        public async Task FlushAllAsync(long nowMs, CancellationToken ct = default)
        {
            while (Pending > 0)
            {
                if (!await StartOrJoin(nowMs, ct)) return;
            }
        }

        /// <summary>
        /// One request with up to MaxBatch events (or waits for the one already in flight). Returns true when the
        /// batch left the queue (sent or rejected).
        /// </summary>
        public Task<bool> FlushOnceAsync(long nowMs, CancellationToken ct = default) => StartOrJoin(nowMs, ct);

        private async Task<bool> FlushCoreAsync(long nowMs, CancellationToken ct)
        {
            List<AnalyticsEvent> batch;
            lock (_gate)
            {
                int stale = _queue.RemoveAll(x => x.AtMs < nowMs - _opt.MaxAgeMs);
                Dropped += stale;
                if (stale > 0) Persist();
                if (_queue.Count == 0) return false;
                batch = _queue.GetRange(0, Math.Min(_opt.MaxBatch, _queue.Count));
            }
            try
            {
                var r = await _send(_opt.Platform, _opt.AppVersion, batch, ct);
                lock (_gate)
                {
                    Remove(batch);
                    Sent += r.Accepted;
                    Dropped += r.Dropped;
                    _failures = 0;
                    _retryAt = 0;
                    _nextFlushAt = nowMs + _opt.FlushIntervalMs;
                    Persist();
                }
                return true;
            }
            catch (ValidationException)
            {
                lock (_gate)
                {
                    Remove(batch);
                    Dropped += batch.Count;
                    Persist();
                }
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
                // network / 5xx / auth: keep the events and try later
                lock (_gate) _retryAt = nowMs + Backoff(++_failures);
                return false;
            }
        }

        private long Backoff(int failures)
        {
            long b = _opt.BaseBackoffMs;
            for (int i = 1; i < failures && b < _opt.MaxBackoffMs; i++) b *= 2;
            return Math.Min(b, _opt.MaxBackoffMs);
        }

        private void Remove(List<AnalyticsEvent> batch)
        {
            var set = new HashSet<AnalyticsEvent>(batch);
            _queue.RemoveAll(set.Contains);
        }

        private void Persist()
        {
            if (_store == null) return;
            var arr = JsonNode.Arr();
            foreach (var e in _queue) arr.Add(e.ToJson());
            try { _store.Save(arr.ToString()); }
            catch (Exception e) { ReportStorageError(e); }
        }

        private void ReportStorageError(Exception e)
        {
            LastStorageError = e;
            try { StorageError?.Invoke(e); } catch (Exception) { /* a faulty handler must not break analytics */ }
        }

        private void Restore()
        {
            if (_store == null) return;
            string json;
            try { json = _store.Load(); } catch (Exception e) { ReportStorageError(e); return; }
            if (string.IsNullOrEmpty(json)) return;
            try
            {
                var arr = JsonNode.Parse(json);
                if (arr.Kind != JsonKind.Array) return;
                foreach (var it in arr.Items)
                {
                    var e = AnalyticsEvent.FromJson(it);
                    if (!string.IsNullOrEmpty(e.Name)) _queue.Add(e);
                }
            }
            catch (FormatException) { /* corrupt file: start empty */ }
        }
    }
}
