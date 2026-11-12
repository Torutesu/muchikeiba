// ログイン中の端末とセキュリティ (REQ-DEV-001..020, contracts/protocol.md §70, docs/handoff-codex-round23-devices.md).
// Pure C# (no UnityEngine). Settings (the account panel) › 「ログイン中の端末」: the signed-in sessions (this device first),
// a confirm sheet before every sign-out, 「この端末以外をすべてログアウト」, the security log, and the check-in the app sends
// at launch / resume / sign-in. Neutral wording only (never 「不正」「危険」「今すぐ」). Texts are Japanese; the view shows Loc.T.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    public interface IDeviceSessionsApi
    {
        Task<DeviceSessionList> CheckinDeviceAsync(DeviceCheckin device, string installId = null, CancellationToken ct = default);
        Task<DeviceSessionList> GetDevicesAsync(CancellationToken ct = default);
        Task<DeviceSignOutResult> SignOutDeviceAsync(string sessionId, CancellationToken ct = default);
        Task<DeviceSignOutResult> SignOutOtherDevicesAsync(CancellationToken ct = default);
        Task<SecurityLog> GetSecurityLogAsync(CancellationToken ct = default);
    }

    public sealed class ApiDeviceSessions : IDeviceSessionsApi
    {
        private readonly ApiClient _api;
        public ApiDeviceSessions(ApiClient api) { _api = api ?? throw new ArgumentNullException(nameof(api)); }
        public Task<DeviceSessionList> CheckinDeviceAsync(DeviceCheckin device, string installId = null, CancellationToken ct = default) => _api.CheckinDeviceAsync(device, installId, ct);
        public Task<DeviceSessionList> GetDevicesAsync(CancellationToken ct = default) => _api.GetDevicesAsync(ct);
        public Task<DeviceSignOutResult> SignOutDeviceAsync(string sessionId, CancellationToken ct = default) => _api.SignOutDeviceAsync(sessionId, ct);
        public Task<DeviceSignOutResult> SignOutOtherDevicesAsync(CancellationToken ct = default) => _api.SignOutOtherDevicesAsync(ct);
        public Task<SecurityLog> GetSecurityLogAsync(CancellationToken ct = default) => _api.GetSecurityLogAsync(ct);
    }

    /// <summary>The confirm sheet before a sign-out (one device, or all the others).</summary>
    public sealed class DeviceSignOutConfirm
    {
        /// <summary>Null = 「この端末以外をすべてログアウト」.</summary>
        public string SessionId;
        public string Title, Body, AnonymousNote;
    }

    public sealed class DeviceSessionsModel
    {
        public const string Title = "ログイン中の端末";
        public const string EntryLabel = "ログイン中の端末";
        public const string ThisDevice = "この端末";
        public const string SignOutCta = "ログアウト";
        public const string SignOutOthersCta = "この端末以外をすべてログアウト";
        public const string ConfirmCta = "ログアウトする";
        public const string CancelCta = "やめる";
        public const string LogLink = "セキュリティの記録";
        public const string LogTitle = "セキュリティの記録";
        public const string HelpLink = "ヘルプ";
        public const string ConfirmOneTitle = "{device}をログアウトしますか？";
        public const string ConfirmOthersTitle = "この端末以外をすべてログアウトしますか？";
        public const string ConfirmBody = "その端末は次に通信した時にログアウトされます。";
        public const string ConfirmOthersBody = "この端末より前にログインした端末も、一覧にない端末も、すべてログアウトされます。";
        public const string AnonymousNote = "その端末ではこのアカウントに戻れなくなります（Apple・Googleの連携か引き継ぎコードがあれば戻れます）。";
        public const string SignedOutText = "ログアウトしました";
        public const string NothingText = "ログアウトする端末はありません";
        public const string TooSoonText = "この端末でログインしてから{hours}時間たつと、前からある端末もログアウトできます";
        public const string LimitText = "今日はこれ以上ログアウトできません";
        public const string OfflineText = "オフラインです。通信できる場所でお試しください";
        public const string UnavailableText = "この機能は現在ご利用いただけません";
        public const string ErrorFallback = "ログアウトできませんでした。時間をおいてお試しください";
        public const string EmptyLogText = "まだ記録はありません";
        public const string LastSeenText = "最後の利用：{date}";
        // REQ-DEV-008: the device after 401 SESSION_REVOKED (MaintenanceModel shows it in place of the game)
        public const string RevokedTitle = "この端末はログアウトされました";
        public const string RevokedBody = "別の端末かサポートからログアウトの操作がありました。Apple・Googleで連携している場合は、もう一度ログインすると続きから遊べます。心当たりがない場合はお問い合わせください。";
        public const string RevokedSignInCta = "ログインする";
        public const string RevokedNewCta = "新しく始める";
        public const string RevokedContactCta = "お問い合わせ";

        private readonly IDeviceSessionsApi _api;
        private readonly Func<bool> _online;
        private readonly Func<long> _clock;
        private readonly Action<AnalyticsEvent> _track;

        public DeviceSessionsModel(IDeviceSessionsApi api, Func<bool> online = null, Func<long> clock = null, Action<AnalyticsEvent> track = null)
        {
            _api = api ?? throw new ArgumentNullException(nameof(api));
            _online = online ?? (() => true);
            _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            _track = track;
        }

        public DeviceSessionList List { get; private set; }
        public SecurityLog Log { get; private set; }
        public DeviceSignOutConfirm Confirm { get; private set; }
        public bool Busy { get; private set; }
        public string Message { get; private set; }
        /// <summary>False: the server has the feature off (hide the entry).</summary>
        public bool Visible => List == null || List.Enabled;
        public DeviceSession Current => List?.CurrentSession;
        public IReadOnlyList<DeviceSession> Others => List?.Others ?? new List<DeviceSession>();
        public bool CanSignOutOthers => List != null && List.SignOutOthers.Allowed;

        /// <summary>The row title (「iPhone（iOS 18）」), the region and the last-seen line, Japanese (the view shows Loc.T).</summary>
        public static string RowTitle(DeviceSession s) => DeviceLabel.Name(s);
        public static string RowDetail(DeviceSession s)
        {
            var parts = new List<string>();
            var r = DeviceLabel.Region(s?.Region);
            if (r != null) parts.Add(r);
            if (s != null && s.LastSeenAt > 0) parts.Add(LastSeenText.Replace("{date}", JstDate(s.LastSeenAt)));
            return string.Join("・", parts);
        }
        /// <summary>"11/12" (JST) — dates only; the server rounds times to the hour anyway.</summary>
        public static string TooSoon(int hours) => TooSoonText.Replace("{hours}", hours.ToString(CultureInfo.InvariantCulture));
        public static string JstDate(long ms) => DateTimeOffset.FromUnixTimeMilliseconds(ms).ToOffset(TimeSpan.FromHours(9)).ToString("M/d", CultureInfo.InvariantCulture);

        /// <summary>Launch, resume, sign-in and after linking / unlinking (fire and forget; the list does not depend on it).</summary>
        public async Task CheckinAsync(DeviceCheckin device, string installId, CancellationToken ct = default)
        {
            if (!_online()) return;
            try { var l = await _api.CheckinDeviceAsync(device, installId, ct); if (List != null) List = l; }
            catch (ApiException) { } // offline (NetworkException) or refused: the next launch checks in again
        }

        public async Task LoadAsync(CancellationToken ct = default)
        {
            Message = null;
            if (!_online()) { Message = OfflineText; return; }
            Busy = true;
            try
            {
                List = await _api.GetDevicesAsync(ct);
                if (!List.Enabled) Message = UnavailableText;
                else _track?.Invoke(AnalyticsEvent.DeviceListView(_clock(), "devices", Math.Min(200, List.Sessions.Count)));
            }
            catch (NetworkException) { Message = OfflineText; }
            catch (ApiException) { Message = ErrorFallback; }
            finally { Busy = false; }
        }

        public async Task LoadLogAsync(CancellationToken ct = default)
        {
            Message = null;
            if (!_online()) { Message = OfflineText; return; }
            Busy = true;
            try { Log = await _api.GetSecurityLogAsync(ct); _track?.Invoke(AnalyticsEvent.DeviceListView(_clock(), "log", Math.Min(200, Log.Items.Count))); }
            catch (NetworkException) { Message = OfflineText; }
            catch (ApiException) { Message = ErrorFallback; }
            finally { Busy = false; }
        }

        /// <summary>The 「ログアウト」 button of a row: the confirm sheet, or the reason it cannot be done yet.</summary>
        public bool AskSignOut(string sessionId)
        {
            Message = null;
            var s = List?.Sessions.FirstOrDefault((x) => x.SessionId == sessionId);
            if (s == null || s.Current) return false;
            if (!s.CanSignOut)
            {
                Message = s.AvailableAt.HasValue ? TooSoon(List.TrustAfterHours) : ErrorFallback;
                return false;
            }
            Confirm = new DeviceSignOutConfirm
            {
                SessionId = sessionId, Title = ConfirmOneTitle.Replace("{device}", DeviceLabel.Name(s)), Body = ConfirmBody,
                AnonymousNote = List.AnonymousOnly ? AnonymousNote : null,
            };
            return true;
        }

        /// <summary>「この端末以外をすべてログアウト」: the confirm sheet, or the reason it cannot be done yet.</summary>
        public bool AskSignOutOthers()
        {
            Message = null;
            if (List == null || List.SignOutOthers.Count == 0) { Message = NothingText; return false; }
            if (!List.SignOutOthers.Allowed) { Message = TooSoon(List.TrustAfterHours); return false; }
            Confirm = new DeviceSignOutConfirm { SessionId = null, Title = ConfirmOthersTitle, Body = ConfirmBody + ConfirmOthersBody, AnonymousNote = List.AnonymousOnly ? AnonymousNote : null };
            return true;
        }

        public void CancelConfirm() => Confirm = null;

        /// <summary>「ログアウトする」 on the sheet.</summary>
        public async Task<bool> ConfirmSignOutAsync(CancellationToken ct = default)
        {
            var c = Confirm;
            if (c == null || Busy) return false;
            if (!_online()) { Message = OfflineText; return false; }
            Busy = true;
            try
            {
                var r = c.SessionId == null ? await _api.SignOutOtherDevicesAsync(ct) : await _api.SignOutDeviceAsync(c.SessionId, ct);
                List = r.Devices;
                Message = r.SignedOut > 0 ? SignedOutText : c.SessionId == null ? NothingText : SignedOutText;
                Confirm = null;
                return true;
            }
            catch (DeviceSignOutException e) when (e.Code == ApiErrorCode.DeviceSignoutTooSoon)
            {
                Message = TooSoon(e.TrustAfterHours > 0 ? e.TrustAfterHours : List?.TrustAfterHours ?? 24);
            }
            catch (RateLimitedException) { Message = LimitText; }
            catch (NotFoundException) { Message = UnavailableText; }
            catch (NetworkException) { Message = OfflineText; }
            catch (ApiException) { Message = ErrorFallback; }
            finally { Busy = false; }
            Confirm = null;
            return false;
        }

        /// <summary>AccountChangeReset: the cached list and log belong to the old account.</summary>
        public void ForgetAll() { List = null; Log = null; Confirm = null; Message = null; }
    }
}
