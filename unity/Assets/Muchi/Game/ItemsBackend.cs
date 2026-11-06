using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    /// <summary>One row of the wardrobe / cosmetics store / stable decor screens.</summary>
    public sealed class WardrobeItem
    {
        public string Id, Name, Kind, Slot, Pattern, Asset, Icon;
        public int Price;
        public bool PaidOnly, Owned, Equipped;
        /// <summary>Resources path of Codex's art for this item (CosmeticArt), never null.</summary>
        public string ArtPath;
    }

    /// <summary>View model behind the wardrobe, store-cosmetics and stable screens (REQ-ITEM-004..007).</summary>
    public sealed class WardrobeModel
    {
        /// <summary>True when the server is unreachable: the catalogue is the bundled preview and nothing can be bought.</summary>
        public bool LocalOnly;
        public string Notice;
        public int DecorSlots;
        public Equipment Equipment = new Equipment();
        public List<WardrobeItem> Items = new List<WardrobeItem>();
        public int FreeCoins, PaidCoins;
        public int GachaTickets, SrPlusTickets, BreedingMaterial;
        public IEnumerable<WardrobeItem> OfKind(string kind) => Items.Where(i => i.Kind == kind);
    }

    /// <summary>
    /// Maps cosmetic asset keys (contracts/assets.md: tack/*, decor/*, silks/pattern/*) onto Codex's flat cosmetics art
    /// (Assets/Resources/Art/Cosmetics). The prototype art has one bridle, one saddle cloth, one plaque and one silk jacket;
    /// every key of a kind uses its kind's art until dedicated art exists (documented in docs/handoff-unity-3d.md).
    /// </summary>
    public static class CosmeticArt
    {
        public const string Folder = "Art/Cosmetics/";
        private static readonly Dictionary<string, string> ExactKeys = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["decor/stable_plaque"] = Folder + "stable-plaque",
        };
        private static readonly (string prefix, string art)[] Prefixes =
        {
            ("tack/bridle", Folder + "bridle"),
            ("tack/saddlecloth", Folder + "saddlecloth"),
            ("silks/pattern/", Folder + "silk-jacket"),
            ("decor/", Folder + "stable-plaque"),
            ("tack/", Folder + "bridle"),
        };

        /// <summary>Resources path (no extension) for an asset key; unknown kinds fall back to the plaque.</summary>
        public static string ArtFor(string assetKey)
        {
            if (assetKey != null && ExactKeys.TryGetValue(assetKey, out var exact)) return exact;
            foreach (var (prefix, art) in Prefixes) if (assetKey != null && assetKey.StartsWith(prefix, StringComparison.Ordinal)) return art;
            return Folder + "stable-plaque";
        }

        /// <summary>Every tack/* and decor/* key of the manifest must resolve to an existing art file.</summary>
        public static List<string> CoverageProblems(IEnumerable<string> manifestKeys, Func<string, bool> artExists)
        {
            var problems = new List<string>();
            foreach (var k in manifestKeys)
            {
                if (!k.StartsWith("tack/", StringComparison.Ordinal) && !k.StartsWith("decor/", StringComparison.Ordinal)) continue;
                var art = ArtFor(k);
                if (!artExists(art)) problems.Add(k + ": art " + art + " is missing");
            }
            return problems;
        }
    }

    /// <summary>
    /// Server calls for tickets, the cosmetics shop and equipment, with an offline fallback (the bundled preview catalogue,
    /// nothing purchasable). All writes are keyed on the server, so retries never charge twice.
    /// </summary>
    public sealed class ItemsBackend
    {
        public const string GachaTicket = "gacha_ticket", SrPlusTicket = "ticket_sr_plus", BreedingMaterialItem = "breeding_material";

        /// <summary>Preview shown offline (same ids/prices as server/master/items.json; marked LOCAL ONLY on screen).</summary>
        public static readonly WardrobeItem[] OfflinePreview =
        {
            new WardrobeItem { Id = "costume_silks_laurel", Name = "勝負服「月桂冠」", Kind = "silks", Pattern = "laurel", Asset = "silks/pattern/laurel", Price = 600 },
            new WardrobeItem { Id = "tack_bridle_classic", Name = "クラシック頭絡", Kind = "tack", Slot = "bridle", Asset = "tack/bridle_classic", Price = 300 },
            new WardrobeItem { Id = "tack_saddlecloth_navy", Name = "紺のゼッケン布", Kind = "tack", Slot = "saddlecloth", Asset = "tack/saddlecloth_navy", Price = 300 },
            new WardrobeItem { Id = "decor_stable_plaque", Name = "厩舎の表札", Kind = "decor", Asset = "decor/stable_plaque", Price = 200 },
        };

        private readonly GameBackend _b;

        public ItemsBackend(GameBackend backend) { _b = backend ?? throw new ArgumentNullException(nameof(backend)); }

        private static WardrobeItem FromServer(CosmeticItem c) => new WardrobeItem
        {
            Id = c.Id, Name = c.Name, Kind = c.Kind, Slot = c.Slot, Pattern = c.Pattern, Asset = c.Asset, Icon = c.Icon, Price = c.Price,
            PaidOnly = c.PaidOnly, Owned = c.Owned, Equipped = c.Equipped, ArtPath = CosmeticArt.ArtFor(c.Asset),
        };

        public async Task<WardrobeModel> WardrobeAsync(CancellationToken ct = default)
        {
            if (_b.Online)
            {
                try
                {
                    var c = await _b.Api.GetCosmeticsAsync(ct);
                    var m = new WardrobeModel { Notice = c.Notice, DecorSlots = c.DecorSlots, Equipment = c.Equipment, Items = c.Items.Select(FromServer).ToList() };
                    Fill(m);
                    return Current = m;
                }
                // Any API failure (network, 5xx, auth, an unknown wire code) shows the preview instead of an empty screen.
                catch (ApiException) { /* fall through to the preview */ }
            }
            return Current = new WardrobeModel
            {
                LocalOnly = true, DecorSlots = 3, Notice = "OFFLINE  /  preview only",
                Items = OfflinePreview.Select(i => new WardrobeItem { Id = i.Id, Name = i.Name, Kind = i.Kind, Slot = i.Slot, Pattern = i.Pattern, Asset = i.Asset, Price = i.Price, ArtPath = CosmeticArt.ArtFor(i.Asset) }).ToList(),
            };
        }

        private void Fill(WardrobeModel m)
        {
            var p = _b.Player;
            if (p == null) return;
            if (p.Wallet != null) { m.FreeCoins = p.Wallet.Free; m.PaidCoins = p.Wallet.Paid; }
            m.GachaTickets = Count(p, GachaTicket);
            m.SrPlusTickets = Count(p, SrPlusTicket);
            m.BreedingMaterial = Count(p, BreedingMaterialItem);
        }

        private static int Count(PlayerView p, string id) => p.Items != null && p.Items.TryGetValue(id, out var n) ? n : 0;

        /// <summary>The wardrobe last loaded by <see cref="WardrobeAsync"/>; purchases and equips update it in place.</summary>
        public WardrobeModel Current { get; private set; }

        /// <summary>KV key of the pending ticket-use idempotency key for (item, banner).</summary>
        public static string TicketKeyFor(string itemId, string bannerId) => "muchi.items.ticket.idem." + itemId + "|" + (bannerId ?? "");

        public async Task<ActionResult> BuyAsync(string itemId, CancellationToken ct = default)
        {
            if (!_b.Online) return ActionResult.Error("OFFLINE  /  purchases need the server");
            try
            {
                var r = await _b.Api.BuyCosmeticAsync(itemId, null, ct);
                ApplyPurchase(r);
                await RefreshQuietlyAsync(ct);
                return ActionResult.Success("PURCHASED  /  paid " + r.SpentPaid + "  free " + r.SpentFree);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (ApiException e) { return ActionResult.Error(e.WireCode + "  /  " + e.Message); }
        }

        /// <summary>The purchase response is authoritative: wallet and ownership show at once, even if the refresh fails.</summary>
        private void ApplyPurchase(CosmeticPurchase r)
        {
            if (r == null) return;
            var p = _b.Player;
            if (p != null && r.Wallet != null) p.Wallet = r.Wallet;
            var m = Current;
            if (m == null || m.LocalOnly) return;
            if (r.Wallet != null) { m.FreeCoins = r.Wallet.Free; m.PaidCoins = r.Wallet.Paid; }
            foreach (var i in m.Items) if (i.Id == r.ItemId) i.Owned = true;
        }

        private void ApplyEquipment(Equipment e)
        {
            if (e == null) return;
            if (_b.Player != null) _b.Player.Equipment = e;
            var m = Current;
            if (m == null || m.LocalOnly) return;
            m.Equipment = e;
            var tack = new HashSet<string>(e.Tack.Values.Where(v => v != null));
            var decor = new HashSet<string>(e.Decor.Where(v => v != null));
            foreach (var i in m.Items)
            {
                if (i.Kind == "tack") i.Equipped = tack.Contains(i.Id);
                else if (i.Kind == "decor") i.Equipped = decor.Contains(i.Id);
            }
        }

        /// <summary>The write already succeeded; a failed follow-up refresh must not turn it into an error.</summary>
        private async Task RefreshQuietlyAsync(CancellationToken ct)
        {
            try { await _b.RefreshAsync(ct); }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (ApiException) { /* keep the applied response */ }
        }

        /// <summary>Equip tack into a slot ("bridle" / "saddlecloth"); itemId null unequips.</summary>
        public Task<ActionResult> EquipTackAsync(string slot, string itemId, CancellationToken ct = default)
        {
            var patch = new EquipmentPatch();
            if (itemId == null) patch.ClearTack = new List<string> { slot };
            else patch.Tack = new Dictionary<string, string> { [slot] = itemId };
            return EquipAsync(patch, ct);
        }

        /// <summary>Replace the stable decor slots (null = empty slot).</summary>
        public Task<ActionResult> SetDecorAsync(IList<string> decor, CancellationToken ct = default)
            => EquipAsync(new EquipmentPatch { Decor = decor.ToList() }, ct);

        private async Task<ActionResult> EquipAsync(EquipmentPatch patch, CancellationToken ct)
        {
            if (!_b.Online) return ActionResult.Error("OFFLINE  /  equipment is saved on the server");
            try
            {
                ApplyEquipment(await _b.Api.SetEquipmentAsync(patch, ct));
                await RefreshQuietlyAsync(ct);
                return ActionResult.Success();
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (ApiException e) { return ActionResult.Error(e.WireCode + "  /  " + e.Message); }
        }

        /// <summary>
        /// Use a ticket (gacha ticket needs bannerId). The pulled horse is in <see cref="LastTicket"/>.
        /// The idempotency key is kept per (item, banner) in the device store until the server answers definitely
        /// (success or a 4xx rejection), so a retry after a timeout, crash or app restart never consumes a second ticket.
        /// </summary>
        public async Task<ActionResult> UseTicketAsync(string itemId, string bannerId = null, CancellationToken ct = default)
        {
            if (!_b.Online) return ActionResult.Error("OFFLINE  /  tickets are used on the server");
            var kv = _b.Store;
            string slot = TicketKeyFor(itemId, bannerId);
            string key = kv.Get(slot);
            if (string.IsNullOrEmpty(key)) { key = _b.Api.NewIdempotencyKey(); kv.Set(slot, key); }
            try
            {
                LastTicket = await _b.Api.UseTicketAsync(itemId, bannerId, key, ct);
                kv.Set(slot, null);
                await RefreshQuietlyAsync(ct);
                return ActionResult.Success(LastTicket.Result.Rarity + "  /  " + (_b.HorseName(LastTicket.Result.HorseId) ?? LastTicket.Result.TemplateId));
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (ApiException e)
            {
                if (IsDefiniteRejection(e)) kv.Set(slot, null);
                return ActionResult.Error(e.WireCode + "  /  " + e.Message);
            }
        }

        /// <summary>The server refused the request itself (4xx other than timeout / rate limit / auth): the key was not used.</summary>
        public static bool IsDefiniteRejection(ApiException e) => e.Status >= 400 && e.Status < 500 && e.Status != 401 && e.Status != 408 && e.Status != 429;

        public TicketResult LastTicket { get; private set; }
    }
}
