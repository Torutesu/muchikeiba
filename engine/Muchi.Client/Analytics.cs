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
        private Task _inFlight;
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
                _inFlight = FlushOnceAsync(nowMs, CancellationToken.None);
                return true;
            }
        }

        /// <summary>Sends everything now (e.g. when the app goes to the background), batch by batch, until empty or a failure.</summary>
        public async Task FlushAllAsync(long nowMs, CancellationToken ct = default)
        {
            while (Pending > 0)
            {
                Task running;
                lock (_gate) running = _inFlight;
                if (running != null && !running.IsCompleted) { await running.ConfigureAwait(false); continue; }
                if (!await FlushOnceAsync(nowMs, ct).ConfigureAwait(false)) return;
            }
        }

        /// <summary>One request with up to MaxBatch events. Returns true when the batch left the queue (sent or rejected).</summary>
        public async Task<bool> FlushOnceAsync(long nowMs, CancellationToken ct = default)
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
                var r = await _send(_opt.Platform, _opt.AppVersion, batch, ct).ConfigureAwait(false);
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
            try { _store.Save(arr.ToString()); } catch (Exception) { /* storage is best-effort */ }
        }

        private void Restore()
        {
            if (_store == null) return;
            string json;
            try { json = _store.Load(); } catch (Exception) { return; }
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
