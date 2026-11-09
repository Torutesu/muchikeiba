using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;
using Muchi.Engine;

namespace Muchi.Game
{
    /// <summary>Small persistent key/value store (PlayerPrefs in Unity, a dictionary in checks).</summary>
    public interface IKeyValueStore
    {
        string Get(string key);
        void Set(string key, string value);
    }

    public sealed class MemoryKeyValueStore : IKeyValueStore
    {
        private readonly Dictionary<string, string> _d = new Dictionary<string, string>();
        public string Get(string key) => _d.TryGetValue(key, out var v) ? v : null;
        public void Set(string key, string value) => _d[key] = value;
    }

    /// <summary>What the home/stable screens show, from the server when online, from local data offline.</summary>
    public sealed class ProfileModel
    {
        public bool Online;
        public string DisplayName = "JOCKEY";
        public string ClassId = "C", SeasonId = "";
        public int SeasonPoints, Rating;
        public int FreeCoins, PaidCoins, Debt;
        public string PartnerId, PartnerName = "アカツキ", PartnerRarity = "SR", PartnerStyle = "sashi", PartnerSurface = "turf";
        public int PartnerDistMinM = 1600, PartnerDistMaxM = 2400;
        public Stats PartnerStats = new Stats { Speed = 560, Stamina = 540, Burst = 580, Guts = 520, Temper = 600 };
        public int HorseCount;
        public bool TutorialScoutAvailable = true;
    }

    /// <summary>
    /// Outcome of a screen action: ok, or a message the screen shows (server error text, offline notice…). The message is
    /// in the app's language (REQ-L10N-010: <see cref="Loc.T"/>; Japanese unchanged).
    /// </summary>
    public sealed class ActionResult
    {
        public bool Ok;
        public string Message;
        public static ActionResult Success(string message = null) => new ActionResult { Ok = true, Message = Loc.T(message) };
        public static ActionResult Error(string message) => new ActionResult { Ok = false, Message = Loc.T(message) };
    }

    /// <summary>
    /// Server-backed game state for Codex's screens, with a graceful offline mode: if the server cannot be
    /// reached at start-up (or settings say offlineOnly) every call returns local data and races run offline.
    /// All methods are async and must be awaited from the main thread (continuations stay on it in Unity).
    /// </summary>
    public sealed class GameBackend
    {
        public const string KeyPartnerName = "muchi.partner";
        public const string KeyScoutUsed = "muchi.tutorial.scout.used";
        /// <summary>How many tutorial races this device has started (REQ-UXS-004: the 3rd is assisted to a win).</summary>
        public const string KeyTutorialAttempts = "muchi.tutorial.attempts";

        private readonly GameSettings _settings;
        private readonly ApiClient _api;
        private readonly ITransportFactory _sockets;
        private readonly IKeyValueStore _kv;
        private readonly RulesetParams _ruleset;

        public bool Online { get; private set; }
        public string OfflineReason { get; private set; }
        public PlayerView Player { get; private set; }
        /// <summary>The tutorial 10-pull drawn for the first partner (shown on the scout reveal).</summary>
        public DrawResult FirstScout { get; private set; }
        public bool FirstScoutRevealed { get; set; }
        public GameSettings Settings => _settings;
        public ApiClient Api => _api;
        public RulesetParams Ruleset => _ruleset;
        /// <summary>The device key/value store (PlayerPrefs in Unity) for small client state such as pending idempotency keys.</summary>
        public IKeyValueStore Store => _kv;

        public GameBackend(GameSettings settings, ApiClient api, ITransportFactory sockets, IKeyValueStore store, RulesetParams ruleset)
        {
            _settings = settings ?? new GameSettings();
            _api = api;
            _sockets = sockets;
            _kv = store ?? new MemoryKeyValueStore();
            _ruleset = ruleset ?? throw new ArgumentNullException(nameof(ruleset));
        }

        public async Task InitializeAsync(CancellationToken ct = default)
        {
            if (_settings.OfflineOnly || _api == null) { GoOffline(_settings.OfflineOnly ? "offlineOnly" : "no server configured"); return; }
            try
            {
                Player = await _api.BootstrapAsync(ct);
                Online = true;
                OfflineReason = null;
            }
            catch (ApiException e) { GoOffline(e.Message); return; }
            catch (Exception e) when (!(e is OperationCanceledException)) { GoOffline(e.Message); return; }
            await LoadConfigAsync(ct);
        }

        /// <summary>The active remote config (null until loaded or from a server that did not answer).</summary>
        public ConfigInfo Config { get; private set; }

        /// <summary>
        /// REQ-DAY-006: GET /v1/config and install its game-day rule in <see cref="GameDay"/> (no constant on the device).
        /// Best effort: without an answer the last rule stays (midnight before the first one).
        /// </summary>
        public async Task LoadConfigAsync(CancellationToken ct = default)
        {
            if (_api == null) return;
            try
            {
                Config = await _api.GetConfigAsync(ct);
                GameDay.Use(Config.DayRollover);
            }
            catch (Exception e) when (!(e is OperationCanceledException)) { /* keep the last rule */ }
        }

        private void GoOffline(string reason) { Online = false; OfflineReason = reason; Player = null; }

        public async Task RefreshAsync(CancellationToken ct = default)
        {
            if (!Online) return;
            try { Player = await _api.GetPlayerAsync(ct); }
            catch (NetworkException) { /* keep the last view */ }
        }

        /// <summary>The partner used for races: the granted first partner (REQ-UXS-002), else the first named active horse, else the best active horse.</summary>
        public Horse Partner
        {
            get
            {
                if (Player == null || Player.Horses.Count == 0) return null;
                var active = Player.Horses.Where(h => h.IsActive || h.Status == null).ToList();
                if (active.Count == 0) return null;
                // REQ-UXS-002: the horse ridden in the tutorial and granted by POST /v1/player/partner comes first
                var granted = Player.PartnerHorseId == null ? null : active.FirstOrDefault(h => h.Id == Player.PartnerHorseId);
                if (granted != null) return granted;
                return active.Where(h => h.Named).OrderByDescending(h => RarityRank(h.Rarity)).FirstOrDefault()
                    ?? active.OrderByDescending(h => RarityRank(h.Rarity)).ThenBy(h => h.Id, StringComparer.Ordinal).First();
            }
        }

        public static int RarityRank(string r) => r == "SSR" ? 3 : r == "SR" ? 2 : r == "R" ? 1 : 0;

        public ProfileModel Profile()
        {
            var p = new ProfileModel { Online = Online };
            string localName = _kv.Get(KeyPartnerName);
            if (!string.IsNullOrEmpty(localName)) p.PartnerName = localName;
            p.TutorialScoutAvailable = _kv.Get(KeyScoutUsed) != "1";
            if (!Online || Player == null) return p;
            p.DisplayName = Player.DisplayName ?? p.DisplayName;
            p.ClassId = Player.ClassId ?? p.ClassId;
            p.SeasonId = Player.SeasonId ?? "";
            p.SeasonPoints = Player.SeasonPoints;
            p.Rating = Player.Rating;
            if (Player.Wallet != null) { p.FreeCoins = Player.Wallet.Free; p.PaidCoins = Player.Wallet.Paid; p.Debt = Player.Wallet.Debt; }
            p.HorseCount = Player.Horses.Count;
            p.TutorialScoutAvailable = !Player.TutorialGachaUsed || (FirstScout != null && !FirstScoutRevealed);
            var h = Partner;
            if (h != null)
            {
                p.PartnerId = h.Id;
                p.PartnerName = h.Name ?? p.PartnerName;
                p.PartnerRarity = h.Rarity ?? p.PartnerRarity;
                p.PartnerStyle = h.Style ?? p.PartnerStyle;
                p.PartnerSurface = h.Surface ?? p.PartnerSurface;
                p.PartnerDistMinM = h.DistMinM; p.PartnerDistMaxM = h.DistMaxM;
                p.PartnerStats = h.Base ?? p.PartnerStats;
            }
            return p;
        }

        /// <summary>Idempotency key of the tutorial 10-pull, kept until the reveal so a retry (or a relaunch) gets the same pulls.</summary>
        public const string KeyFirstScoutIdem = "muchi.ftue.scout.key";
        /// <summary>Idempotency key of the partner grant, kept until the server answered definitely.</summary>
        public const string KeyPartnerIdem = "muchi.ftue.partner.key";
        /// <summary>A name chosen offline, granted with the partner once the server is reachable.</summary>
        public const string KeyPendingPartnerName = "muchi.ftue.partner.pending";

        /// <summary>
        /// Runs the one free tutorial 10-pull (server, REQ-GACHA-010). Its own step after naming (06 §2.3, REQ-UXU-003):
        /// it never names anything. Keyed: the key is kept on the device until the pulls were shown
        /// (<see cref="FirstScoutShown"/>), so a timeout or an app kill between the draw and the reveal gets the very same
        /// pulls back from the server's idempotency cache instead of losing them.
        /// </summary>
        public async Task<ActionResult> EnsureFirstScoutAsync(CancellationToken ct = default)
        {
            if (!Online) return ActionResult.Success();
            if (FirstScout != null) return ActionResult.Success();
            string key = _kv.Get(KeyFirstScoutIdem);
            if (Player != null && Player.TutorialGachaUsed && string.IsNullOrEmpty(key)) return ActionResult.Success();
            if (string.IsNullOrEmpty(key)) { key = _api.NewIdempotencyKey(); _kv.Set(KeyFirstScoutIdem, key); }
            try
            {
                FirstScout = await _api.TutorialDrawAsync(key, ct);
                FirstScoutRevealed = false;
                await RefreshAsync(ct);
                return ActionResult.Success();
            }
            catch (ConflictException e) when (e.Code == ApiErrorCode.TutorialGachaUsed)
            {
                // drawn earlier and the stored answer is gone: the horses are in the stable, there is nothing to reveal
                _kv.Set(KeyFirstScoutIdem, "");
                await RefreshAsync(ct);
                return ActionResult.Success();
            }
            catch (ApiException e)
            {
                if (!IsTransient(e)) _kv.Set(KeyFirstScoutIdem, "");
                return ActionResult.Error(UxText.For(e));
            }
        }

        /// <summary>The reveal was shown: the draw's key is no longer needed.</summary>
        public void FirstScoutShown() { FirstScoutRevealed = true; _kv.Set(KeyFirstScoutIdem, ""); }

        /// <summary>No definite answer (timeout, dropped connection, 5xx): a retry must reuse the same idempotency key.</summary>
        public static bool IsTransient(ApiException e) => e is NetworkException || e is ServerException || e is RateLimitedException;

        /// <summary>
        /// REQ-UXS-002 / REQ-UXU-003: names the horse ridden in the tutorial and grants it as the first partner
        /// (<c>t_partner</c>, once). It does not draw the free 10-pull any more: that is <see cref="EnsureFirstScoutAsync"/>,
        /// a separate screen after naming. Keyed with a key kept on the device until the server answered definitely, so a
        /// retry after a timeout or a relaunch never grants twice. INVALID_NAME / NG_NAME: the sentence is returned and
        /// nothing was granted. PARTNER_ALREADY_GRANTED (e.g. granted on another device): the partner exists → ok.
        /// Partner already granted: renames it. Offline: the name is kept and granted by <see cref="SyncPendingPartnerAsync"/>.
        /// </summary>
        public async Task<ActionResult> NamePartnerAsync(string name, CancellationToken ct = default)
        {
            name = (name ?? "").Trim();
            if (name.Length == 0) return ActionResult.Error("名前を入力してください");
            if (!Online)
            {
                _kv.Set(KeyPartnerName, name);
                _kv.Set(KeyPendingPartnerName, name);
                return ActionResult.Success();
            }
            if (Player != null && Player.PartnerHorseId != null)
            {
                try { await _api.NameHorseAsync(Player.PartnerHorseId, name, ct); }
                catch (ApiException e) { return ActionResult.Error(UxText.For(e)); }
                _kv.Set(KeyPartnerName, name); _kv.Set(KeyPendingPartnerName, "");
                await RefreshAsync(ct);
                return ActionResult.Success();
            }
            string key = _kv.Get(KeyPartnerIdem);
            if (string.IsNullOrEmpty(key)) { key = _api.NewIdempotencyKey(); _kv.Set(KeyPartnerIdem, key); }
            try
            {
                var h = await _api.GrantPartnerAsync(name, key, ct);
                _kv.Set(KeyPartnerIdem, ""); _kv.Set(KeyPendingPartnerName, "");
                _kv.Set(KeyPartnerName, h?.Name ?? name);
                await RefreshAsync(ct);
                return ActionResult.Success();
            }
            catch (ConflictException e) when (e.Code == ApiErrorCode.PartnerAlreadyGranted)
            {
                _kv.Set(KeyPartnerIdem, ""); _kv.Set(KeyPendingPartnerName, "");
                await RefreshAsync(ct);
                return ActionResult.Success();
            }
            catch (ApiException e)
            {
                // a definite refusal (bad name …) granted nothing, so the next attempt gets a new key; a timeout / 5xx keeps it
                if (!IsTransient(e)) _kv.Set(KeyPartnerIdem, "");
                return ActionResult.Error(UxText.For(e));
            }
        }

        /// <summary>A name chosen offline still waits for the partner grant.</summary>
        public string PendingPartnerName => string.IsNullOrEmpty(_kv.Get(KeyPendingPartnerName)) ? null : _kv.Get(KeyPendingPartnerName);

        /// <summary>Grant the partner named offline (no-op when nothing is pending or still offline).</summary>
        public async Task<ActionResult> SyncPendingPartnerAsync(CancellationToken ct = default)
        {
            var pending = PendingPartnerName;
            if (!Online || pending == null) return ActionResult.Success();
            return await NamePartnerAsync(pending, ct);
        }

        /// <summary>The scout reveal: online the real tutorial pulls (best first), offline nothing (fixed art preview).</summary>
        public List<PullResult> ScoutReveal()
        {
            if (FirstScout == null) return new List<PullResult>();
            return FirstScout.Results.OrderByDescending(r => RarityRank(r.Rarity)).ToList();
        }

        public string HorseName(string horseId) => Player?.Horses.FirstOrDefault(h => h.Id == horseId)?.Name;

        public void MarkScoutUsed() => _kv.Set(KeyScoutUsed, "1");

        public async Task<List<Product>> ProductsAsync(CancellationToken ct = default)
        {
            if (!Online) return null;
            try { return (await _api.GetProductsAsync(ct)).Products; }
            catch (ApiException) { return null; }
        }

        /// <summary>Pre-purchase check (age, monthly limit, once-only). No billing is started.</summary>
        public async Task<ActionResult> PurchaseCheckAsync(string productId, CancellationToken ct = default)
        {
            if (!Online) return ActionResult.Error("OFFLINE  /  purchase checks need the server");
            try
            {
                var i = await _api.PurchaseIntentAsync(productId, ct);
                string limit = i.MonthlyLimitYen.HasValue ? "  /  monthly limit ¥" + i.MonthlyLimitYen.Value + " (remaining ¥" + i.RemainingYen + ")" : "";
                return ActionResult.Success("PURCHASE ALLOWED  /  spent this month ¥" + i.MonthSpentYen + limit);
            }
            catch (ApiException e) { return ActionResult.Error(e.WireCode + "  /  " + e.Message); }
        }

        public async Task<SeasonPassView> SeasonPassAsync(CancellationToken ct = default)
        {
            if (!Online) return null;
            try { return await _api.GetSeasonPassAsync(ct); }
            catch (ApiException) { return null; }
        }

        /// <summary>Tutorial races started on this device so far.</summary>
        public int TutorialAttempts => int.TryParse(_kv.Get(KeyTutorialAttempts), out var n) && n > 0 ? n : 0;

        /// <summary>
        /// Offline first ride (tutorial preset; auto start; the whip is the only control). <paramref name="attempt"/>
        /// is the 1-based try number; omitted, the device's count + 1 is used and stored. From the 3rd try the
        /// tutorial is assisted to a win (REQ-UXS-004). Offline only: never reaches ranked results.
        /// </summary>
        public IRaceDriver CreateTutorialRace(int? attempt = null)
        {
            int n = attempt ?? TutorialAttempts + 1;
            if (attempt == null) _kv.Set(KeyTutorialAttempts, n.ToString(System.Globalization.CultureInfo.InvariantCulture));
            return new OfflineRaceDriver(OfflinePresets.TutorialRace(_ruleset, n));
        }

        /// <summary>Offline practice race with the partner (server horse when known).</summary>
        public IRaceDriver CreatePracticeRace(ulong seed)
        {
            var spec = Partner != null ? RaceFactory.FromServer(Partner) : RaceFactory.DefaultPartner(_kv.Get(KeyPartnerName));
            return AssistModel.Attach(new OfflineRaceDriver(RaceFactory.Practice(_ruleset, spec, seed), 0, autoStart: false), AssistLevel);
        }

        /// <summary>
        /// REQ-ASSIST-008: the かんたん操作 level races start with — the server setting (`assist` in GET /v1/player) or
        /// what <see cref="AssistModel"/> last stored; offline the device's last known choice. Off by default. The tutorial
        /// never uses it (<see cref="CreateTutorialRace"/> does not attach it, and the client ignores it there anyway).
        /// </summary>
        public AssistLevel AssistLevel
        {
            get => _assist ?? (Player?.Assist != null ? Player.Assist.Level : AssistLevels.Parse(_kv.Get(AssistModel.KeyLevel)));
            set { _assist = value; _kv.Set(AssistModel.KeyLevel, AssistLevels.Wire(value)); }
        }
        private AssistLevel? _assist;

        /// <summary>
        /// Ranked race: enqueue the partner, poll until matched (CPU fill after ~15 s), then connect.
        /// Returns null with a message when offline, no partner, cancelled or timed out.
        /// </summary>
        public async Task<(IRaceDriver driver, string message)> StartRankedAsync(Func<bool> cancelled, CancellationToken ct = default)
        {
            if (!Online) return (null, "OFFLINE");
            var partner = Partner;
            if (partner == null) return (null, "NO PARTNER  /  finish the first scout");
            try
            {
                var st = await _api.EnqueueRankedAsync(partner.Id, ct);
                var started = DateTime.UtcNow;
                while (st.State != MatchState.Matched)
                {
                    if (cancelled != null && cancelled()) { await SafeCancelMatch(); return (null, "CANCELLED"); }
                    if ((DateTime.UtcNow - started).TotalMilliseconds > _settings.MatchTimeoutMs) { await SafeCancelMatch(); return (null, "MATCH TIMEOUT"); }
                    await Task.Delay(_settings.MatchPollMs, ct);
                    st = await _api.GetMatchStatusAsync(ct);
                }
                return (Connect(st.Assignment), null);
            }
            catch (ApiException e) { return (null, e.WireCode + "  /  " + e.Message); }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { await SafeCancelMatch(); return (null, "CANCELLED"); }
            catch (Exception e) { await SafeCancelMatch(); return (null, "ERROR  /  " + e.Message); } // e.g. a token provider error; never leave the caller hanging
        }

        private async Task SafeCancelMatch()
        {
            try { await _api.CancelMatchAsync(); } catch (Exception) { /* best effort */ }
        }

        public IRaceDriver Connect(RaceAssignment a)
        {
            var session = new RaceSession(_sockets ?? new WebSocketTransportFactory(), _settings.WebSocketUrl(a.WsPath), a.RaceId, a.Ticket);
            return AssistModel.Attach(new OnlineRaceDriver(session), AssistLevel);
        }

        /// <summary>
        /// REQ-SPEC-002: watch a live race with a spectator ticket. The driver renders like a player's race (same
        /// simulation, delayed stream); PlayerSlot is -1 and inputs are ignored.
        /// </summary>
        public IRaceDriver ConnectSpectator(SpectatorTicket t)
        {
            var spectator = new SpectatorSession(_sockets ?? new WebSocketTransportFactory(), _settings.WebSocketUrl(t.WsPath), t);
            return new OnlineRaceDriver(spectator.Session);
        }
    }
}
