using System;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-DEX-001..020: 個人データの開示・ダウンロード (server/src/domain/dataExport.ts, contracts/protocol.md §51).
    // Settings › Privacy › "Download your data": the signed-in player asks, the server prepares a JSON file and a readable
    // summary in the background, an activity entry says when it is ready, and the status carries short-lived download
    // links. Open the links in the OS browser / share sheet (DataExportFileUrl); never keep the file inside the app.

    public static class DataExportStatuses
    {
        public const string None = "none", Queued = "queued", Building = "building", Ready = "ready", Failed = "failed", Expired = "expired";
        public static readonly string[] All = { None, Queued, Building, Ready, Failed, Expired };
        /// <summary>Queued or building: the screen shows "preparing" and polls (or waits for the activity entry).</summary>
        public static bool Preparing(string s) => s == Queued || s == Building;
    }

    /// <summary>GET / POST /v1/player/data-export. Text fields (StatusText, Notice, notes) come in the request's language.</summary>
    public sealed class DataExportStatus
    {
        public bool Enabled, CanRequest, DeletionScheduled;
        /// <summary>Only on POST: false = the running request was returned (nothing new was made).</summary>
        public bool Created;
        public string Status, StatusText, RequestId, Notice, DeletionNote, LinkNote;
        public long? RequestedAt, ReadyAt, ExpiresAt, SizeBytes, NextAvailableAt;
        public int KeepDays;
        /// <summary>Relative paths (join with <see cref="ApiClient.DataExportFileUrl"/>); null unless Ready.</summary>
        public string JsonPath, SummaryPath;
        public long? LinkExpiresAt;

        public bool Ready => Status == DataExportStatuses.Ready && JsonPath != null;

        internal static DataExportStatus Parse(JsonNode o)
        {
            var d = J.Opt(o, "download");
            return new DataExportStatus
            {
                Enabled = J.Bool(o, "enabled"), Status = J.Str(o, "status") ?? DataExportStatuses.None, StatusText = J.Str(o, "statusText"),
                RequestId = J.Str(o, "requestId"), RequestedAt = J.LongN(o, "requestedAt"), ReadyAt = J.LongN(o, "readyAt"), ExpiresAt = J.LongN(o, "expiresAt"),
                SizeBytes = J.LongN(o, "sizeBytes"), CanRequest = J.Bool(o, "canRequest"), NextAvailableAt = J.LongN(o, "nextAvailableAt"), KeepDays = J.Int(o, "keepDays"),
                DeletionScheduled = J.Bool(o, "deletionScheduled"), DeletionNote = J.Str(o, "deletionNote"), LinkNote = J.Str(o, "linkNote"), Notice = J.Str(o, "notice"),
                Created = J.Bool(o, "created"),
                JsonPath = J.Str(J.Opt(d, "json"), "url"), SummaryPath = J.Str(J.Opt(d, "summary"), "url"), LinkExpiresAt = J.LongN(d, "linkExpiresAt"),
            };
        }
    }

    /// <summary>REQ-DEX-004: asked again inside the cooldown (429). AvailableAt = when a new request is accepted (ms).</summary>
    public sealed class DataExportCooldownException : ApiException
    {
        public long? AvailableAt { get; }
        public DataExportCooldownException(string wire, string message, int status, long? availableAt) : base(ApiErrorCode.DataExportCooldown, wire, message, status) { AvailableAt = availableAt; }
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-DEX-003: my data export's status (links are fresh on every call while it is ready).</summary>
        public Task<DataExportStatus> GetDataExportAsync(CancellationToken ct = default)
            => Call("GET", "/v1/player/data-export", null, true, null, true, DataExportStatus.Parse, ct);

        /// <summary>
        /// REQ-DEX-002/005: ask for a data export. Safe to retry (one key per call; a running request is returned as is).
        /// Throws <see cref="DataExportCooldownException"/> inside the cooldown, PurchaseBlockedException(DeletionPending) while the account is being deleted.
        /// </summary>
        public Task<DataExportStatus> RequestDataExportAsync(string idempotencyKey = null, CancellationToken ct = default)
            => Call("POST", "/v1/player/data-export", null, true, idempotencyKey ?? NewIdempotencyKey(), true, DataExportStatus.Parse, ct);

        /// <summary>REQ-DEX-010: the absolute URL of a download path from the status (for the OS browser). Null for null.</summary>
        public string DataExportFileUrl(string path)
        {
            if (string.IsNullOrEmpty(path)) return null;
            if (!path.StartsWith("/v1/data-export/file?", StringComparison.Ordinal)) throw new ArgumentException("not a data export path", nameof(path));
            return BaseUrl + path;
        }
    }
}
