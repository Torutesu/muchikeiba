using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-DEV-001..020: ログイン中の端末とセキュリティ (server/src/domain/devices.ts, contracts/protocol.md §70).
    // The app checks in at launch / resume / sign-in with a coarse label (platform, OS major, model family, app version) and
    // its install id header (the server keeps only a per-account hash). The list shows the signed-in sessions; other devices
    // are signed out on the server (their next request answers 401 SESSION_REVOKED — never retried). Display only: nothing
    // here moves coins or items. Nothing in this file logs a token or the install id.

    /// <summary>Platforms the check-in sends (`platform`).</summary>
    public static class DevicePlatforms
    {
        public const string Ios = "ios", Android = "android", Other = "other";
        public static readonly string[] All = { Ios, Android, Other };
    }

    /// <summary>Kinds of security log rows (`kind`).</summary>
    public static class SecurityEventKinds
    {
        public const string NewDevice = "new_device", SignoutDevice = "signout_device", SignoutOthers = "signout_others", SignoutSupport = "signout_support",
            TransferIssued = "transfer_issued", TransferRevoked = "transfer_revoked", TransferRedeemed = "transfer_redeemed", LinkAdded = "link_added", LinkRemoved = "link_removed";
        public static readonly string[] All = { NewDevice, SignoutDevice, SignoutOthers, SignoutSupport, TransferIssued, TransferRevoked, TransferRedeemed, LinkAdded, LinkRemoved };
    }

    /// <summary>What the app sends at check-in. <see cref="ModelFamily"/> drops digits the same way the server does.</summary>
    public sealed class DeviceCheckin
    {
        public string Platform = DevicePlatforms.Other, Model, AppVersion;
        public int? OsMajor;

        /// <summary>The model family: letters and single spaces only, at most 24 (`iPhone15,2` → `iPhone`). Null when nothing is left.</summary>
        public static string ModelFamily(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return null;
            var b = new StringBuilder(raw.Length);
            bool space = false;
            foreach (var ch in raw)
            {
                bool letter = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
                if (letter) { if (space && b.Length > 0) b.Append(' '); b.Append(ch); space = false; }
                else space = true;
            }
            var s = b.ToString();
            if (s.Length > 24) s = s.Substring(0, 24).TrimEnd();
            return s.Length > 0 ? s : null;
        }

        /// <summary>The OS major from a version string ("18.1.2" → 18; null when it does not start with a number 0..99).</summary>
        public static int? MajorOf(string version)
        {
            if (string.IsNullOrEmpty(version)) return null;
            int n = 0, digits = 0;
            foreach (var ch in version) { if (ch < '0' || ch > '9') break; n = n * 10 + (ch - '0'); if (++digits > 2) return null; }
            return digits == 0 ? (int?)null : n;
        }

        internal JsonNode ToJson()
        {
            var o = JsonNode.Obj().Set("platform", Array.IndexOf(DevicePlatforms.All, Platform) >= 0 ? Platform : DevicePlatforms.Other);
            if (OsMajor.HasValue && OsMajor.Value >= 0 && OsMajor.Value <= 99) o.Set("osMajor", OsMajor.Value);
            var m = ModelFamily(Model);
            if (m != null) o.Set("model", m);
            if (!string.IsNullOrEmpty(AppVersion)) o.Set("appVersion", AppVersion);
            return o;
        }
    }

    /// <summary>The names the screens show (Japanese, or English when <see cref="Loc.IsEnglish"/>). Model names are never translated.</summary>
    public static class DeviceLabel
    {
        private static string OsName(string platform) => platform == DevicePlatforms.Ios ? "iOS" : platform == DevicePlatforms.Android ? "Android" : null;

        /// <summary>「iPhone（iOS 18）」 / "iPhone (iOS 18)"; without a model 「iOSの端末」 / "iOS device"; unknown platform 「端末」 / "Device".</summary>
        public static string Name(string platform, int? osMajor, string model)
        {
            bool en = Loc.IsEnglish;
            var os = OsName(platform);
            var osText = os == null ? null : osMajor.HasValue ? os + " " + osMajor.Value : os;
            if (!string.IsNullOrEmpty(model)) return osText == null ? model : en ? model + " (" + osText + ")" : model + "（" + osText + "）";
            if (osText != null) return en ? osText + " device" : osText + "の端末";
            return en ? "Device" : "端末";
        }

        public static string Name(DeviceSession s) => s == null ? null : Name(s.Platform, s.OsMajor, s.Model);

        /// <summary>The country of a two-letter code (日本 / Japan for JP; the code itself otherwise; null for none).</summary>
        public static string Region(string code)
        {
            if (string.IsNullOrEmpty(code)) return null;
            if (code == "JP") return Loc.IsEnglish ? "Japan" : "日本";
            return code;
        }
    }

    /// <summary>One signed-in session. <see cref="AvailableAt"/> = when it may be signed out (null = now, or the current one).</summary>
    public sealed class DeviceSession
    {
        public string SessionId, Platform, Model, AppVersion, Region;
        public int? OsMajor;
        public bool Current, CanSignOut;
        public long FirstSeenAt, LastSeenAt;
        public long? AvailableAt;

        internal static DeviceSession Parse(JsonNode o) => new DeviceSession
        {
            SessionId = J.Str(o, "sessionId"), Current = J.Bool(o, "current"), Platform = J.Str(o, "platform"), OsMajor = J.IntN(o, "osMajor"),
            Model = J.Str(o, "model"), AppVersion = J.Str(o, "appVersion"), Region = J.Str(o, "region"),
            FirstSeenAt = J.Long(o, "firstSeenAt"), LastSeenAt = J.Long(o, "lastSeenAt"), CanSignOut = J.Bool(o, "canSignOut"), AvailableAt = J.LongN(o, "availableAt"),
        };
    }

    public sealed class SignOutOthersInfo
    {
        public bool Allowed;
        public long? AvailableAt;
        public int Count;
        internal static SignOutOthersInfo Parse(JsonNode o) => new SignOutOthersInfo { Allowed = J.Bool(o, "allowed"), AvailableAt = J.LongN(o, "availableAt"), Count = J.Int(o, "count") };
    }

    /// <summary>GET /v1/account/devices (and the check-in's answer, which adds <see cref="Recorded"/> / <see cref="NewDevice"/>).</summary>
    public sealed class DeviceSessionList
    {
        public bool Enabled, AnonymousOnly, Recorded, NewDevice;
        public string Current;
        public List<DeviceSession> Sessions = new List<DeviceSession>();
        public SignOutOthersInfo SignOutOthers = new SignOutOthersInfo();
        public int RevokesToday, RevokesPerDay, TrustAfterHours;
        public long? LastTransferredAt;

        public DeviceSession CurrentSession => Sessions.Find((s) => s.Current);
        public List<DeviceSession> Others => Sessions.FindAll((s) => !s.Current);

        public static DeviceSessionList Parse(JsonNode o) => o == null ? new DeviceSessionList() : new DeviceSessionList
        {
            Enabled = J.Bool(o, "enabled"), Current = J.Str(o, "current"), Sessions = J.List(o, "sessions", DeviceSession.Parse),
            SignOutOthers = SignOutOthersInfo.Parse(J.Opt(o, "signOutOthers")), RevokesToday = J.Int(o, "revokesToday"), RevokesPerDay = J.Int(o, "revokesPerDay"),
            TrustAfterHours = J.Int(o, "trustAfterHours"), AnonymousOnly = J.Bool(o, "anonymousOnly"), LastTransferredAt = J.LongN(o, "lastTransferredAt"),
            Recorded = J.Bool(o, "recorded"), NewDevice = J.Bool(o, "newDevice"),
        };
    }

    public sealed class DeviceSignOutResult
    {
        public int SignedOut;
        public DeviceSessionList Devices;
        internal static DeviceSignOutResult Parse(JsonNode o) => new DeviceSignOutResult { SignedOut = J.Int(o, "signedOut"), Devices = DeviceSessionList.Parse(J.Opt(o, "devices")) };
    }

    /// <summary>One security log row. <see cref="Text"/> arrives in the request language.</summary>
    public sealed class SecurityLogItem
    {
        public long At;
        public string Kind, Text, Mode, By, Provider;
        public int? Count;
        /// <summary>The device of new_device / signout_device rows (null for the others).</summary>
        public DeviceSession Device;

        internal static SecurityLogItem Parse(JsonNode o)
        {
            var d = J.Opt(o, "device");
            return new SecurityLogItem
            {
                At = J.Long(o, "at"), Kind = J.Str(o, "kind"), Text = J.Str(o, "text"), Mode = J.Str(o, "mode"), By = J.Str(o, "by"), Provider = J.Str(o, "provider"),
                Count = J.IntN(o, "count"),
                Device = d == null ? null : new DeviceSession { Platform = J.Str(d, "platform"), OsMajor = J.IntN(d, "osMajor"), Model = J.Str(d, "model"), Region = J.Str(d, "region") },
            };
        }
    }

    public sealed class SecurityLog
    {
        public bool Enabled;
        public int LogDays;
        public List<SecurityLogItem> Items = new List<SecurityLogItem>();
        public static SecurityLog Parse(JsonNode o) => o == null ? new SecurityLog() : new SecurityLog { Enabled = J.Bool(o, "enabled"), LogDays = J.Int(o, "logDays"), Items = J.List(o, "items", SecurityLogItem.Parse) };
    }

    /// <summary>401 SESSION_REVOKED: this session was signed out from another device or by support. Never retried; sign out and show the notice.</summary>
    public sealed class SessionRevokedException : ApiException
    {
        public SessionRevokedException(string wire, string message, int status) : base(ApiErrorCode.SessionRevoked, wire, message, status) { }
    }

    /// <summary>A refused sign-out: DEVICE_SIGNOUT_TOO_SOON (<see cref="AvailableAt"/>) or DEVICE_IS_CURRENT.</summary>
    public sealed class DeviceSignOutException : ApiException
    {
        public long? AvailableAt { get; }
        public int TrustAfterHours { get; }
        public DeviceSignOutException(ApiErrorCode c, string wire, string message, int status, JsonNode details) : base(c, wire, message, status)
        {
            AvailableAt = details == null ? null : J.LongN(details, "availableAt");
            TrustAfterHours = details == null ? 0 : J.Int(details, "trustAfterHours");
        }
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-DEV-008: raised once per response that says this session was signed out (from another device or by support).</summary>
        public event Action SessionRevoked;
        internal void NoteSessionRevoked() => SessionRevoked?.Invoke();

        /// <summary>
        /// Launch, resume, sign-in and after linking / unlinking Apple or Google. <paramref name="installId"/> goes in the
        /// x-install-id header (the server keeps a per-account hash only). Safe to retry (an unchanged check-in writes nothing).
        /// </summary>
        public Task<DeviceSessionList> CheckinDeviceAsync(DeviceCheckin device, string installId = null, CancellationToken ct = default)
        {
            if (device == null) throw new ArgumentNullException(nameof(device));
            var h = string.IsNullOrEmpty(installId) ? null : new Dictionary<string, string> { ["x-install-id"] = installId };
            return Call("POST", "/v1/account/devices/checkin", device.ToJson(), true, null, true, DeviceSessionList.Parse, ct, h);
        }

        public Task<DeviceSessionList> GetDevicesAsync(CancellationToken ct = default)
            => Call("GET", "/v1/account/devices", null, true, null, true, DeviceSessionList.Parse, ct);

        /// <summary>Signs out one other device (after the confirm sheet). Not retried: the answer to a retry is the same anyway (idempotent), but a 429 is not worth waiting for.</summary>
        public Task<DeviceSignOutResult> SignOutDeviceAsync(string sessionId, CancellationToken ct = default)
        {
            if (string.IsNullOrEmpty(sessionId)) throw new ArgumentException("a session id is required");
            return Call("POST", "/v1/account/devices/" + Uri.EscapeDataString(sessionId) + "/signout", JsonNode.Obj().Set("confirm", true), true, null, false, DeviceSignOutResult.Parse, ct);
        }

        /// <summary>Signs out every device except this one (after the confirm sheet). Not retried.</summary>
        public Task<DeviceSignOutResult> SignOutOtherDevicesAsync(CancellationToken ct = default)
            => Call("POST", "/v1/account/devices/signout-others", JsonNode.Obj().Set("confirm", true), true, null, false, DeviceSignOutResult.Parse, ct);

        public Task<SecurityLog> GetSecurityLogAsync(CancellationToken ct = default)
            => Call("GET", "/v1/account/security-log", null, true, null, true, SecurityLog.Parse, ct);
    }
}
