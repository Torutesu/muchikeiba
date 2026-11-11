using System;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // 個人データの開示・ダウンロード (REQ-DEX-001..020, contracts/protocol.md §51, docs/handoff-codex-round18-data-export.md).
    // Pure C# (no UnityEngine). Settings › Privacy › "Download your data": one primary button whose label and state follow the
    // server's status, the dates as real dates (never a countdown), the deletion note while the account deletion is scheduled,
    // and two downloads when ready. Downloads open in the OS browser (OpenUrl) — the file is never stored in the app.
    // Text sizes follow the accessibility setting like every screen (§41): the rows are short lines that wrap.

    public sealed class DataExportModel : ScreenModel
    {
        public const string TextTitle = "プライバシー";
        public const string TextSection = "データのダウンロード";
        public const string TextRequest = "データをリクエスト";
        public const string TextPreparing = "準備しています";
        public const string TextRequestAgain = "もう一度リクエスト";
        public const string TextDownloadJson = "データ（JSON）をダウンロード";
        public const string TextDownloadSummary = "概要（テキスト）をダウンロード";
        public const string TextPreparingNote = "準備ができるとお知らせに届きます。この画面を閉じても大丈夫です。";
        public const string TextFailedNote = "時間をおいて、もう一度リクエストしてください。";
        public const string TextOffline = "オフラインのためリクエストできません";
        public const string TextUnavailable = "この機能は現在ご利用いただけません";

        private readonly NowMs _now;
        public DataExportModel(GameBackend backend, NowMs now = null) : base(backend, backend?.Store)
        {
            _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        public DataExportStatus Status { get; private set; }

        /// <summary>Primary button: label and whether it can be pressed (request, preparing, or the next date).</summary>
        public string ButtonText { get; private set; } = Loc.T(TextRequest);
        public bool ButtonEnabled { get; private set; }
        /// <summary>The server's status line (already in the request's language) and the notes under it.</summary>
        public string StatusText => Status?.StatusText;
        public string Notice => Status?.Notice;
        /// <summary>「12月17日まで」 when ready; 「次のリクエストは12月17日から」 inside the cooldown; null otherwise.</summary>
        public string DateText { get; private set; }
        /// <summary>「48 KB」 when ready.</summary>
        public string SizeText { get; private set; }
        /// <summary>Preparing / failed / deletion / link notes to show under the button (null = none).</summary>
        public string Note { get; private set; }
        public string DeletionNote => Status?.DeletionNote;
        public string LinkNote => Status?.LinkNote;
        public bool CanDownload => Status != null && Status.Ready;
        public bool Preparing => Status != null && DataExportStatuses.Preparing(Status.Status);
        public bool Hidden => Status != null && !Status.Enabled;

        /// <summary>GET /v1/player/data-export.</summary>
        public async Task<ActionResult> LoadAsync(CancellationToken ct = default)
        {
            Message = null;
            if (!ServerAvailable) { Online = false; Rebuild(); return Offline(TextOffline); }
            try { Use(await B.Api.GetDataExportAsync(ct)); Online = true; return ActionResult.Success(); }
            catch (ApiException e) { Rebuild(); return Fail(e); }
        }

        /// <summary>POST /v1/player/data-export (the running one comes back if there is one; nothing is made twice).</summary>
        public async Task<ActionResult> RequestAsync(CancellationToken ct = default)
        {
            Message = null;
            if (!ServerAvailable) return Offline(TextOffline);
            if (Status != null && !Status.CanRequest) return ActionResult.Error(ButtonText);
            try { Use(await B.Api.RequestDataExportAsync(null, ct)); Online = true; return ActionResult.Success(); }
            catch (DataExportCooldownException e)
            {
                if (Status != null && e.AvailableAt.HasValue) { Status.CanRequest = false; Status.NextAvailableAt = e.AvailableAt; }
                Rebuild();
                return Fail(e);
            }
            catch (ApiException e) { return Fail(e); }
        }

        /// <summary>The absolute URL to hand to the OS browser for "json" or "summary" (fresh on every Load; null when not ready).</summary>
        public string DownloadUrl(string file)
        {
            if (!CanDownload) return null;
            if (Status.LinkExpiresAt.HasValue && Status.LinkExpiresAt.Value <= _now()) return null; // reload first: links last minutes
            return B.Api.DataExportFileUrl(file == "summary" ? Status.SummaryPath : Status.JsonPath);
        }
        /// <summary>The links have run out: the screen reloads before opening one.</summary>
        public bool LinksStale => CanDownload && Status.LinkExpiresAt.HasValue && Status.LinkExpiresAt.Value <= _now();

        /// <summary>Use a status the caller already has (an activity entry's deep link reloads it instead).</summary>
        public void Use(DataExportStatus s) { Status = s; Rebuild(); }

        private void Rebuild()
        {
            DateText = null; SizeText = null; Note = null;
            var s = Status;
            if (s == null) { ButtonText = Loc.T(TextRequest); ButtonEnabled = ServerAvailable; return; }
            if (!s.Enabled) { ButtonText = Loc.T(TextRequest); ButtonEnabled = false; Note = Loc.T(TextUnavailable); return; }
            if (DataExportStatuses.Preparing(s.Status)) { ButtonText = Loc.T(TextPreparing); ButtonEnabled = false; Note = Loc.T(TextPreparingNote); }
            else if (s.Ready)
            {
                ButtonText = Loc.T(TextDownloadJson); ButtonEnabled = true;
                if (s.ExpiresAt.HasValue) DateText = Loc.T(DateLabel(s.ExpiresAt.Value) + "まで");
                if (s.SizeBytes.HasValue) SizeText = SizeLabel(s.SizeBytes.Value);
            }
            else
            {
                ButtonText = Loc.T(s.Status == DataExportStatuses.None ? TextRequest : TextRequestAgain);
                ButtonEnabled = s.CanRequest;
                if (s.Status == DataExportStatuses.Failed) Note = Loc.T(TextFailedNote);
                if (!s.CanRequest && s.NextAvailableAt.HasValue) DateText = Loc.T("次のリクエストは" + DateLabel(s.NextAvailableAt.Value) + "から");
            }
        }

        /// <summary>「12月17日」 in JST (the date the player reads; English 12/17 through the date table).</summary>
        public static string DateLabel(long ms)
        {
            var d = DateTimeOffset.FromUnixTimeMilliseconds(ms).ToOffset(TimeSpan.FromHours(9));
            return d.Month.ToString(CultureInfo.InvariantCulture) + "月" + d.Day.ToString(CultureInfo.InvariantCulture) + "日";
        }
        public static string SizeLabel(long bytes)
        {
            if (bytes < 1024) return bytes.ToString(CultureInfo.InvariantCulture) + " B";
            if (bytes < 1024 * 1024) return Math.Max(1, (int)Math.Round(bytes / 1024.0)).ToString(CultureInfo.InvariantCulture) + " KB";
            return (bytes / (1024.0 * 1024.0)).ToString("0.0", CultureInfo.InvariantCulture) + " MB";
        }
    }
}
