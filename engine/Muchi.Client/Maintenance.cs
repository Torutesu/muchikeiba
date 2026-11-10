using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // メンテナンス・強制アップデート (REQ-MNT-004..014, contracts/protocol.md §46). ApiClient handles 503 MAINTENANCE and
    // 426 UPGRADE_REQUIRED in one place (Call): no retry, a typed exception, an event, and Outage.

    /// <summary>What the app is cut off by right now (offline and maintenance are different screens).</summary>
    public enum OutageKind
    {
        /// <summary>The last request got an answer.</summary>
        None,
        /// <summary>No answer at all (no network, DNS, timeout) after the retries: show the offline notice.</summary>
        Offline,
        /// <summary>503 MAINTENANCE: a maintenance window covers what was asked.</summary>
        Maintenance,
        /// <summary>426 UPGRADE_REQUIRED: this app version (or engine level) is no longer supported.</summary>
        UpgradeRequired,
    }

    /// <summary>The details of a 503 MAINTENANCE (protocol §46.3).</summary>
    public sealed class MaintenanceInfo
    {
        public string WindowId, Group;
        /// <summary>"all" or the group names of the window.</summary>
        public List<string> Scope = new List<string>();
        public bool All => Scope.Count == 1 && Scope[0] == "all";
        public long StartAt, EndAt;
        /// <summary>"11/12 06:00" (JST) — the end time the screen prints. Never a countdown.</summary>
        public string EndsAtJst;
        public int RetryAfterSec;
        /// <summary>The window message (already English in English mode).</summary>
        public string Message;

        public static MaintenanceInfo Parse(JsonNode d)
        {
            var m = new MaintenanceInfo
            {
                WindowId = J.Str(d, "windowId"), Group = J.Str(d, "group"), StartAt = J.Long(d, "startAt"), EndAt = J.Long(d, "endAt"),
                EndsAtJst = J.Str(d, "endsAtJst"), RetryAfterSec = J.Int(d, "retryAfterSec"), Message = J.Str(d, "message"),
            };
            m.Scope = ParseScope(J.Opt(d, "scope"));
            return m;
        }

        internal static List<string> ParseScope(JsonNode s)
        {
            var out_ = new List<string>();
            if (s == null) return out_;
            if (s.Kind == JsonKind.String) out_.Add(s.AsString());
            else if (s.Kind == JsonKind.Array) foreach (var x in s.Items) out_.Add(x.AsString());
            return out_;
        }
    }

    /// <summary>The details of a 426 UPGRADE_REQUIRED (protocol §46.3).</summary>
    public sealed class UpgradeInfo
    {
        /// <summary>"version" (below the minimum app version) or "engine" (below the minimum race engine level).</summary>
        public string Reason;
        public string Platform, Version, MinVersion, RecommendedVersion;
        /// <summary>The store page to open (null when the server has none for this platform).</summary>
        public string StoreUrl;
        public int? EngineLevel, MinEngineLevel;

        public static UpgradeInfo Parse(JsonNode d) => new UpgradeInfo
        {
            Reason = J.Str(d, "reason") ?? "version", Platform = J.Str(d, "platform"), Version = J.Str(d, "version"),
            MinVersion = J.Str(d, "minVersion"), RecommendedVersion = J.Str(d, "recommendedVersion"), StoreUrl = J.Str(d, "storeUrl"),
            EngineLevel = J.IntN(d, "engineLevel"), MinEngineLevel = J.IntN(d, "minEngineLevel"),
        };
    }

    /// <summary>One window of GET /v1/maintenance (running or announced).</summary>
    public sealed class MaintenanceWindowView
    {
        public string Id, StartJst, EndJst, Message, Status;
        public List<string> Scope = new List<string>();
        public bool All => Scope.Count == 1 && Scope[0] == "all";
        public long StartAt, EndAt, AnnounceAt;
        public bool Active => Status == "active";

        internal static MaintenanceWindowView Parse(JsonNode o)
        {
            var w = new MaintenanceWindowView
            {
                Id = J.Str(o, "id"), StartAt = J.Long(o, "startAt"), EndAt = J.Long(o, "endAt"), AnnounceAt = J.Long(o, "announceAt"),
                StartJst = J.Str(o, "startJst"), EndJst = J.Str(o, "endJst"), Message = J.Str(o, "message"), Status = J.Str(o, "status"),
            };
            w.Scope = MaintenanceInfo.ParseScope(J.Opt(o, "scope"));
            return w;
        }
    }

    /// <summary>Where this app version stands (GET /v1/maintenance <c>client</c>).</summary>
    public sealed class ClientVersionStatus
    {
        public string Platform, Version, MinVersion, RecommendedVersion, StoreUrl;
        /// <summary>"ok" | "recommended" | "required" | "unknown".</summary>
        public string Status;
        public int MinEngineLevel;
        public bool Required => Status == "required";
        public bool Recommended => Status == "recommended";

        internal static ClientVersionStatus Parse(JsonNode o) => new ClientVersionStatus
        {
            Platform = J.Str(o, "platform"), Version = J.Str(o, "version"), Status = J.Str(o, "status") ?? "unknown",
            MinVersion = J.Str(o, "minVersion"), RecommendedVersion = J.Str(o, "recommendedVersion"), StoreUrl = J.Str(o, "storeUrl"),
            MinEngineLevel = J.Int(o, "minEngineLevel", 1),
        };
    }

    /// <summary>GET /v1/maintenance (public, never gated).</summary>
    public sealed class MaintenanceStatus
    {
        public long ServerNowMs;
        public List<MaintenanceWindowView> Active = new List<MaintenanceWindowView>();
        public List<MaintenanceWindowView> Upcoming = new List<MaintenanceWindowView>();
        public ClientVersionStatus Client = new ClientVersionStatus { Status = "unknown" };

        public static MaintenanceStatus Parse(JsonNode o) => new MaintenanceStatus
        {
            ServerNowMs = J.Long(o, "serverNowMs"),
            Active = J.List(o, "active", MaintenanceWindowView.Parse),
            Upcoming = J.List(o, "upcoming", MaintenanceWindowView.Parse),
            Client = J.Opt(o, "client") is JsonNode c ? ClientVersionStatus.Parse(c) : new ClientVersionStatus { Status = "unknown" },
        };
    }

    /// <summary>x.y.z versions, compared numerically like the server (1.10.0 &gt; 1.9.9). Unparseable sorts lowest.</summary>
    public static class ClientVersion
    {
        public static int[] Parse(string v)
        {
            if (string.IsNullOrEmpty(v)) return null;
            var parts = v.Trim().Split('.');
            if (parts.Length != 3) return null;
            var r = new int[3];
            for (int i = 0; i < 3; i++)
            {
                if (parts[i].Length == 0 || parts[i].Length > 4) return null;
                foreach (char ch in parts[i]) if (ch < '0' || ch > '9') return null;
                r[i] = int.Parse(parts[i], System.Globalization.CultureInfo.InvariantCulture);
            }
            return r;
        }

        public static int Compare(string a, string b)
        {
            var x = Parse(a) ?? new[] { -1, -1, -1 };
            var y = Parse(b) ?? new[] { -1, -1, -1 };
            for (int i = 0; i < 3; i++) if (x[i] != y[i]) return x[i] < y[i] ? -1 : 1;
            return 0;
        }
    }

    /// <summary>503 MAINTENANCE. Not retried; <see cref="Info"/> says until when and why.</summary>
    public sealed class MaintenanceException : ApiException
    {
        public MaintenanceInfo Info { get; }
        public MaintenanceException(string wire, string message, int status, MaintenanceInfo info) : base(ApiErrorCode.Maintenance, wire, message, status) { Info = info ?? new MaintenanceInfo(); }
    }

    /// <summary>426 UPGRADE_REQUIRED. Show the update screen with <see cref="UpgradeInfo.StoreUrl"/>.</summary>
    public sealed class UpgradeRequiredException : ApiException
    {
        public UpgradeInfo Info { get; }
        public UpgradeRequiredException(string wire, string message, int status, UpgradeInfo info) : base(ApiErrorCode.UpgradeRequired, wire, message, status) { Info = info ?? new UpgradeInfo { Reason = "version" }; }
    }

    public sealed partial class ApiClient
    {
        /// <summary>Raised (from the calling thread) every time a request meets 503 MAINTENANCE.</summary>
        public event Action<MaintenanceInfo> MaintenanceDetected;
        /// <summary>Raised every time a request meets 426 UPGRADE_REQUIRED.</summary>
        public event Action<UpgradeInfo> UpgradeRequired;

        /// <summary>Offline vs maintenance vs update required, from the last request (REQ-MNT-014).</summary>
        public OutageKind Outage { get; private set; } = OutageKind.None;
        /// <summary>The last 503 MAINTENANCE details (null once a request succeeds).</summary>
        public MaintenanceInfo LastMaintenance { get; private set; }
        /// <summary>The last 426 details (kept until a request succeeds).</summary>
        public UpgradeInfo LastUpgrade { get; private set; }

        /// <summary>Running and announced maintenance windows and where this app version stands. Public, never gated.</summary>
        public Task<MaintenanceStatus> GetMaintenanceAsync(CancellationToken ct = default)
            => Call("GET", "/v1/maintenance", null, false, null, true, MaintenanceStatus.Parse, ct);

        private void AddClientHeaders(HttpRequest req)
        {
            if (!string.IsNullOrEmpty(_opt.Platform)) req.Headers["x-client-platform"] = _opt.Platform;
            if (!string.IsNullOrEmpty(_opt.AppVersion)) req.Headers["x-client-version"] = _opt.AppVersion;
            req.Headers["x-engine-level"] = EngineInfo.Level.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        private void NoteOutage(OutageKind kind, ApiException e)
        {
            Outage = kind;
            if (kind == OutageKind.None) { LastMaintenance = null; LastUpgrade = null; return; }
            if (e is MaintenanceException m) { LastMaintenance = m.Info; MaintenanceDetected?.Invoke(m.Info); }
            else if (e is UpgradeRequiredException u) { LastUpgrade = u.Info; UpgradeRequired?.Invoke(u.Info); }
        }
    }
}
