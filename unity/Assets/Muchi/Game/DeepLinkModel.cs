using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    /// <summary>The link endpoints the game uses (ApiDeepLinkApi in the app, a fake in the checks).</summary>
    public interface IDeepLinkApi
    {
        Task<ResolvedLink> ResolveAsync(string token, CancellationToken ct);
        Task<CreatedLink> CreateAsync(string type, IDictionary<string, string> target, CancellationToken ct);
    }

    public sealed class ApiDeepLinkApi : IDeepLinkApi
    {
        private readonly ApiClient _api;
        public ApiDeepLinkApi(ApiClient api) { _api = api ?? throw new ArgumentNullException(nameof(api)); }
        public Task<ResolvedLink> ResolveAsync(string token, CancellationToken ct) => _api.ResolveLinkAsync(token, ct);
        public Task<CreatedLink> CreateAsync(string type, IDictionary<string, string> target, CancellationToken ct) => _api.CreateLinkAsync(type, target, ct);
    }

    /// <summary>
    /// Where a resolved link goes. The screen always opens on a confirmation (join with which horse / send the request / enter
    /// the invite code / view): the link itself never joins, redeems, requests or spends anything.
    /// </summary>
    public sealed class DeepLinkRoute
    {
        public string Screen, Type;
        public ResolvedLink Link;
        /// <summary>Always true: the opened screen asks before anything happens (REQ-LINK-023).</summary>
        public bool RequiresConfirm => true;
    }

    /// <summary>
    /// ディープリンク (REQ-LINK-001..013/021/023, contracts/protocol.md §63): receives links from the OS (universal / app links,
    /// the muchi:// scheme), from the Android install referrer on the first launch, or typed into 「リンクを開く」, resolves them on
    /// the server and says which screen to open.
    /// Rules the model keeps:
    ///  - during the FTUE (and offline) the link waits — one slot, the newest link wins, kept across restarts in
    ///    <see cref="IKeyValueStore"/> — and opens after the FTUE ends (<see cref="TryOpenAsync"/> is called on every home visit);
    ///  - nothing is spent, joined, redeemed or requested automatically: <see cref="DeepLinkRoute.RequiresConfirm"/>;
    ///  - every reason a link does not open is one neutral notice (the server says no more either);
    ///  - the token is never logged and never sent to analytics (only how it arrived and its type).
    /// The clipboard is never read (iOS deferred links: the player types the code shown on the web page).
    /// </summary>
    public sealed class DeepLinkModel
    {
        public const string KeyPending = "muchi.deeplink.pending";
        public const string KeyPendingEntry = "muchi.deeplink.pendingEntry";
        public const string KeyReferrerRead = "muchi.deeplink.referrerRead";

        public const string TextUnavailable = "このリンクは開けません";
        public const string TextFriendsOnly = "このリプレイはフレンドだけが見られます";
        public const string TextMaintenance = "メンテナンス中です。終わってからもう一度開いてください";
        public const string TextUpdate = "このリンクを開くにはアプリの更新が必要です";
        public const string TextWait = "しばらくしてからお試しください";
        public const string TextQueued = "チュートリアルの後で開きます";
        public const string TextInvalid = "リンクの形が正しくありません";

        private readonly IDeepLinkApi _api;
        private readonly IKeyValueStore _kv;
        private readonly Func<bool> _ftueDone;
        private readonly Action<AnalyticsEvent> _track;
        private readonly Func<long> _clock;
        private readonly string _scheme;

        public DeepLinkModel(IDeepLinkApi api, IKeyValueStore store, Func<bool> ftueDone, Action<AnalyticsEvent> track = null, Func<long> clock = null, string scheme = DeepLinkParser.DefaultScheme)
        {
            _api = api ?? throw new ArgumentNullException(nameof(api));
            _kv = store ?? new MemoryKeyValueStore();
            _ftueDone = ftueDone ?? (() => true);
            _track = track;
            _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            _scheme = scheme;
        }

        /// <summary>The waiting token (null = none).</summary>
        public string Pending => string.IsNullOrEmpty(_kv.Get(KeyPending)) ? null : _kv.Get(KeyPending);
        /// <summary>A link is waiting for the FTUE to end.</summary>
        public bool Queued => Pending != null && !_ftueDone();
        public string Notice { get; private set; }
        public DeepLinkRoute LastRoute { get; private set; }
        public bool Busy { get; private set; }

        /// <summary>A link from the OS or typed by the player. False when it is not a link at all (nothing is kept).</summary>
        public bool Receive(string raw, string entry = null)
        {
            var token = DeepLinkParser.Parse(raw, _scheme, out var parsedEntry);
            if (token == null) { Notice = TextInvalid; return false; }
            _kv.Set(KeyPending, token);
            _kv.Set(KeyPendingEntry, entry ?? parsedEntry);
            Notice = _ftueDone() ? null : TextQueued;
            return true;
        }

        /// <summary>REQ-LINK-011 (Android): the Play install referrer, read once on the first launch.</summary>
        public bool ReceiveInstallReferrer(string referrer)
        {
            if (_kv.Get(KeyReferrerRead) == "1") return false;
            _kv.Set(KeyReferrerRead, "1");
            var token = DeepLinkParser.FromInstallReferrer(referrer);
            return token != null && Receive(token, DeepLinkEntries.Referrer);
        }

        /// <summary>
        /// Resolves the waiting link when the FTUE is over and the device is online (else it keeps waiting). A route to open, or
        /// null with <see cref="Notice"/> set. A network failure keeps the link for the next try.
        /// </summary>
        public async Task<DeepLinkRoute> TryOpenAsync(bool online, CancellationToken ct = default)
        {
            var token = Pending;
            if (token == null || Busy || !_ftueDone() || !online) return null;
            Busy = true;
            try
            {
                ResolvedLink r;
                try { r = await _api.ResolveAsync(token, ct); }
                catch (ApiException e) when (e.Code == ApiErrorCode.RateLimited) { Clear(); Notice = TextWait; return null; }
                catch (ApiException e) when (e.Code == ApiErrorCode.Network || e.Code == ApiErrorCode.Internal || e.Code == ApiErrorCode.Maintenance) { return null; } // try again later
                var entry = _kv.Get(KeyPendingEntry) ?? DeepLinkEntries.Typed;
                Clear();
                _track?.Invoke(AnalyticsEvent.DeepLinkOpen(_clock(), entry, r.Ok ? r.Type : null));
                switch (r.State)
                {
                    case LinkStates.Ok:
                        var screen = r.Screen ?? DeepLinkRoutes.ScreenOf(r.Type);
                        if (screen == null) { Notice = TextUpdate; return null; } // a type this build does not know
                        Notice = null;
                        return LastRoute = new DeepLinkRoute { Screen = screen, Type = r.Type, Link = r };
                    case LinkStates.FriendsOnly: Notice = TextFriendsOnly; return null;
                    case LinkStates.Maintenance: Notice = TextMaintenance; return null;
                    case LinkStates.UpdateRequired: Notice = TextUpdate; return null;
                    default: Notice = TextUnavailable; return null;
                }
            }
            finally { Busy = false; }
        }

        private void Clear() { _kv.Set(KeyPending, ""); _kv.Set(KeyPendingEntry, ""); }

        /// <summary>
        /// R21 integration (§54 × §63): the signed-in account changed on this device (SESSION_REPLACED, a redeemed transfer code):
        /// the link that was waiting is dropped (it came for the old account); the install referrer is not read again.
        /// </summary>
        public void ForgetPending() { Clear(); LastRoute = null; Notice = null; }

        /// <summary>REQ-LINK-003/024: a link for the share sheet (the server's text, no rewards or names). False when not shared.</summary>
        public async Task<CreatedLink> CreateAsync(string type, IDictionary<string, string> target = null, CancellationToken ct = default)
        {
            try { Notice = null; return await _api.CreateAsync(type, target, ct); }
            catch (ApiException e) when (e.Code == ApiErrorCode.LinkLimit) { Notice = "今日はこれ以上リンクを作れません"; return null; }
            catch (ApiException e) when (e.Code == ApiErrorCode.NotFound) { Notice = "共有できるものがありません"; return null; }
        }

        public async Task<bool> ShareAsync(IShareSheet sheet, string type, IDictionary<string, string> target = null, CancellationToken ct = default)
        {
            var link = await CreateAsync(type, target, ct);
            return link != null && await sheet.ShareAsync(null, link.ShareText, ct);
        }
    }

    /// <summary>The rematch endpoints (ApiRematchApi in the app, a fake in the checks).</summary>
    public interface IRematchApi
    {
        Task<RematchView> PressAsync(string raceId, string horseId, CancellationToken ct);
        Task<RematchView> StatusAsync(string raceId, CancellationToken ct);
        Task<RematchView> DeclineAsync(string raceId, CancellationToken ct);
    }

    public sealed class ApiRematchApi : IRematchApi
    {
        private readonly ApiClient _api;
        public ApiRematchApi(ApiClient api) { _api = api ?? throw new ArgumentNullException(nameof(api)); }
        public Task<RematchView> PressAsync(string raceId, string horseId, CancellationToken ct) => _api.RematchPressAsync(raceId, horseId, ct);
        public Task<RematchView> StatusAsync(string raceId, CancellationToken ct) => _api.RematchStatusAsync(raceId, ct);
        public Task<RematchView> DeclineAsync(string raceId, CancellationToken ct) => _api.RematchDeclineAsync(raceId, ct);
    }

    /// <summary>
    /// 再戦 on the friend-room result (REQ-LINK-014..019): press (again = pick the horse again; a second tap while a call is in flight
    /// is ignored), wait with the real deadline from the server, poll until the window closes, then go to the new room — or say
    /// that it did not open (one neutral line for being left out, never why). Friend-room rules: nothing ranked, nothing spent.
    /// </summary>
    public sealed class RematchModel
    {
        private readonly IRematchApi _api;
        private readonly Func<long> _clock;
        public string RaceId { get; }
        public RematchView View { get; private set; }
        public bool Busy { get; private set; }
        public string Error { get; private set; }

        public RematchModel(IRematchApi api, string raceId, Func<long> clock = null)
        {
            _api = api ?? throw new ArgumentNullException(nameof(api));
            RaceId = raceId;
            _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        public bool Pressed => View?.You == RematchStates.Pressed;
        public bool CanPress => !Busy && (View == null || View.State == RematchStates.Waiting);
        public string ButtonLabel => Pressed ? "待っています" : "再戦 »";
        /// <summary>Poll (GET) about once a second while waiting after pressing; stop once opened / closed.</summary>
        public bool ShouldPoll => View != null && View.State == RematchStates.Waiting && Pressed;
        public string RoomPassphrase => View != null && View.Opened ? View.RoomPassphrase : null;

        public string StatusText
        {
            get
            {
                if (View == null) return "";
                switch (View.State)
                {
                    case RematchStates.Waiting:
                        return Pressed ? "再戦を待っています（" + View.Pressed + "/" + View.Eligible + "人・あと" + View.SecondsLeft(_clock()) + "秒）" : "";
                    case RematchStates.Opened: return "新しい部屋ができました";
                    default:
                        return View.Reason == RematchStates.TooFew ? "人数がそろわず、再戦は開きませんでした"
                            : View.Reason == RematchStates.Expired ? "再戦の受付は終わりました" : "この再戦には入れませんでした";
                }
            }
        }

        private async Task Run(Func<Task<RematchView>> f)
        {
            if (Busy) return; // double tap / overlapping polls
            Busy = true;
            try { View = await f(); Error = null; }
            catch (ApiException e) when (e.Code == ApiErrorCode.NotFound) { Error = "再戦の受付は終わりました"; }
            catch (ApiException e) when (e.Code == ApiErrorCode.AlreadyInRace || e.Code == ApiErrorCode.Banned) { Error = "今は再戦できません"; }
            catch (ApiException e) when (e.Code == ApiErrorCode.Network) { Error = "通信できませんでした"; }
            finally { Busy = false; }
        }

        public Task PressAsync(string horseId, CancellationToken ct = default) => CanPress ? Run(() => _api.PressAsync(RaceId, horseId, ct)) : Task.CompletedTask;
        public Task PollAsync(CancellationToken ct = default) => Run(() => _api.StatusAsync(RaceId, ct));
        public Task DeclineAsync(CancellationToken ct = default) => Run(() => _api.DeclineAsync(RaceId, ct));
    }
}
