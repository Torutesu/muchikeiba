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

    /// <summary>Outcome of a screen action: ok, or a message the screen shows (server error text, offline notice…).</summary>
    public sealed class ActionResult
    {
        public bool Ok;
        public string Message;
        public static ActionResult Success(string message = null) => new ActionResult { Ok = true, Message = message };
        public static ActionResult Error(string message) => new ActionResult { Ok = false, Message = message };
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
            catch (ApiException e) { GoOffline(e.Message); }
            catch (Exception e) when (!(e is OperationCanceledException)) { GoOffline(e.Message); }
        }

        private void GoOffline(string reason) { Online = false; OfflineReason = reason; Player = null; }

        public async Task RefreshAsync(CancellationToken ct = default)
        {
            if (!Online) return;
            try { Player = await _api.GetPlayerAsync(ct); }
            catch (NetworkException) { /* keep the last view */ }
        }

        /// <summary>The partner used for races: the first named active horse, else the best active horse.</summary>
        public Horse Partner
        {
            get
            {
                if (Player == null || Player.Horses.Count == 0) return null;
                var active = Player.Horses.Where(h => h.IsActive || h.Status == null).ToList();
                if (active.Count == 0) return null;
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

        /// <summary>Runs the one free tutorial 10-pull (server) so the player has a first partner. Idempotent.</summary>
        public async Task<ActionResult> EnsureFirstScoutAsync(CancellationToken ct = default)
        {
            if (!Online) return ActionResult.Success();
            if (Player != null && Player.TutorialGachaUsed) return ActionResult.Success();
            try
            {
                FirstScout = await _api.TutorialDrawAsync(null, ct);
                FirstScoutRevealed = false;
                await RefreshAsync(ct);
                return ActionResult.Success();
            }
            catch (ApiException e) { return ActionResult.Error(e.Message); }
        }

        /// <summary>
        /// Names the first partner. Online: draws the tutorial scout first if needed, then names the best horse
        /// (server validates katakana 2–9 and the NG list; its message is returned on failure). Offline: local only.
        /// </summary>
        public async Task<ActionResult> NamePartnerAsync(string name, CancellationToken ct = default)
        {
            name = (name ?? "").Trim();
            if (name.Length == 0) return ActionResult.Error("NAME REQUIRED");
            if (!Online)
            {
                _kv.Set(KeyPartnerName, name);
                return ActionResult.Success();
            }
            var scout = await EnsureFirstScoutAsync(ct);
            if (!scout.Ok) return scout;
            var partner = Partner;
            if (partner == null) return ActionResult.Error("No horse to name yet.");
            try
            {
                await _api.NameHorseAsync(partner.Id, name, ct);
                _kv.Set(KeyPartnerName, name);
                await RefreshAsync(ct);
                return ActionResult.Success();
            }
            catch (ApiException e) { return ActionResult.Error(e.Message); }
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

        /// <summary>Offline first ride (tutorial preset; auto start).</summary>
        public IRaceDriver CreateTutorialRace() => new OfflineRaceDriver(RaceFactory.Tutorial(_ruleset), OfflinePresets.TutorialPlayerSlot, autoStart: true);

        /// <summary>Offline practice race with the partner (server horse when known).</summary>
        public IRaceDriver CreatePracticeRace(ulong seed)
        {
            var spec = Partner != null ? RaceFactory.FromServer(Partner) : RaceFactory.DefaultPartner(_kv.Get(KeyPartnerName));
            return new OfflineRaceDriver(RaceFactory.Practice(_ruleset, spec, seed), 0, autoStart: false);
        }

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
        }

        private async Task SafeCancelMatch()
        {
            try { await _api.CancelMatchAsync(); } catch (ApiException) { }
        }

        public IRaceDriver Connect(RaceAssignment a)
        {
            var session = new RaceSession(_sockets ?? new WebSocketTransportFactory(), _settings.WebSocketUrl(a.WsPath), a.RaceId, a.Ticket);
            return new OnlineRaceDriver(session);
        }
    }
}
