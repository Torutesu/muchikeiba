using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;
using Muchi.Engine;

namespace Muchi.Game
{
    // 実況パック (commentary packs, REQ-CMT-001..014, contracts/protocol.md §36, docs/handoff-codex-round14-commentary-packs.md).
    // Pure C# (no UnityEngine). The pack list (owned / price / equipped) comes from the server; the wording comes from the
    // client copy of the catalog (Resources/Muchi/commentary-packs.json). The commentary itself only runs on the device:
    // a pack never changes a race. Spectators and replays speak the viewer's own equipped pack.

    /// <summary>One card of the pack list (settings / shop).</summary>
    public sealed class CommentaryPackCard
    {
        public string Id, Name, Description;
        /// <summary>装備中 / 持っている / 300コイン / 実績で入手（3/10）.</summary>
        public string Status;
        public string PriceLabel;
        /// <summary>How the pack is obtained, for packs not owned yet (achievement label), else null.</summary>
        public string UnlockLabel;
        public int UnlockProgress, UnlockTarget;
        /// <summary>English: the pack has no English lines (the standard English is spoken).</summary>
        public string EnglishNote;
        public bool Owned, Equipped, CanEquip, CanBuy;
        /// <summary>The pack is in the device's catalog (it can be sampled and spoken).</summary>
        public bool Playable;
    }

    /// <summary>The purchase confirm sheet (a calm confirm: price from the server, no pressure words, cancel as big as buy).</summary>
    public sealed class CommentaryPackPurchaseSheet
    {
        public string PackId, Title, Body, Notice, ConfirmLabel, CancelLabel;
        public int Price;
        public bool PaidOnly;
    }

    public sealed class CommentaryPackModel : ScreenModel
    {
        /// <summary>Last equipped pack on this device (offline races, before the first server answer).</summary>
        public const string KeyEquipped = "muchi.commentary.pack";

        public const string TextKicker = "実況パック";
        public const string TextTitle = "実況パック";
        public const string TextNotice = "実況の話し方だけが変わります。レースの結果・能力には影響しません。";
        public const string TextEquipped = "装備中";
        public const string TextOwned = "持っている";
        public const string TextPrice = "{n}コイン";
        public const string TextUnlock = "実績で入手（{n}/{m}）";
        public const string TextEquip = "装備する";
        public const string TextSample = "試聴する";
        public const string TextBuy = "購入する";
        public const string TextCancel = "やめる";
        public const string TextConfirmTitle = "{name}を購入しますか？";
        public const string TextConfirmBody = "{n}コインを使います。有償コインから先に使われます。";
        public const string TextConfirmBodyPaid = "有償コイン{n}枚を使います（無償コインは使えません）。";
        public const string TextBought = "実況パックを購入しました";
        public const string TextSaved = "実況パックを変更しました";
        public const string TextOffline = "実況パックの変更はオンラインで保存されます";
        public const string TextBuyOffline = "購入はオンラインのときにできます";
        public const string TextSampleTitle = "試聴";

        private readonly CommentaryPackCatalog _catalog;
        private readonly Dictionary<string, string> _buyKeys = new Dictionary<string, string>();

        public CommentaryPackModel(GameBackend backend, CommentaryPackCatalog catalog, IKeyValueStore store = null) : base(backend, store ?? backend?.Store)
        {
            _catalog = catalog;
        }

        /// <summary>Fills one {placeholder} of a Japanese template, then translates the whole line (Loc templates).</summary>
        public static string Fmt(string template, string name, object value, bool translate = true)
        {
            string s = template.Replace("{" + name + "}", Convert.ToString(value, CultureInfo.InvariantCulture));
            return translate ? Loc.T(s) : s;
        }

        public CommentaryPackCatalog Catalog => _catalog;
        public CommentaryPacksView View { get; private set; }
        /// <summary>The T6 sheet data when the last purchase failed for lack of coins (show CoinShortfallModel), else null.</summary>
        public CoinShortfall Shortfall { get; private set; }

        /// <summary>The pack used for races: the server's answer, else the device's last choice, else the standard.</summary>
        public string Equipped => View?.Equipped ?? EquippedOf(B, Kv);

        public static string EquippedOf(GameBackend b, IKeyValueStore kv)
            => b?.Player?.CommentaryPack ?? kv?.Get(KeyEquipped) ?? CommentaryPackCatalog.StandardPackId;

        /// <summary>The cards in catalog order (server list when online; the device catalog offline, standard owned only).</summary>
        public List<CommentaryPackCard> Cards()
        {
            var list = new List<CommentaryPackCard>();
            if (View != null)
            {
                foreach (var p in View.Packs) list.Add(Card(p));
                return list;
            }
            if (_catalog == null) return list;
            string eq = Equipped;
            foreach (var p in _catalog.Packs)
                list.Add(new CommentaryPackCard
                {
                    Id = p.Id, Name = Loc.T(p.Name), Description = Loc.T(p.Description), Owned = p.IsStandard || p.Id == eq, Equipped = p.Id == eq, Playable = true,
                    Status = p.Id == eq ? Loc.T(TextEquipped) : p.IsStandard ? Loc.T(TextOwned) : p.AcquireKind == "coins" ? Fmt(TextPrice, "n", p.Price) : null,
                    PriceLabel = p.AcquireKind == "coins" ? Fmt(TextPrice, "n", p.Price) : null, CanEquip = p.IsStandard && p.Id != eq,
                });
            return list;
        }

        private CommentaryPackCard Card(CommentaryPackInfo p)
        {
            string status = p.Equipped ? TextEquipped : p.Owned ? TextOwned : null;
            string price = p.ForSale && p.Price.HasValue ? Fmt(TextPrice, "n", p.Price.Value) : null;
            if (status == null && price != null) status = price;
            if (status == null && p.Unlock != null) status = Fmt(Fmt(TextUnlock, "n", p.Unlock.Progress, false), "m", p.Unlock.Target);
            return new CommentaryPackCard
            {
                Id = p.Id, Name = p.Name, Description = p.Description, Status = Loc.T(status), PriceLabel = price,
                UnlockLabel = !p.Owned ? p.Unlock?.Label : null, UnlockProgress = p.Unlock?.Progress ?? 0, UnlockTarget = p.Unlock?.Target ?? 0,
                EnglishNote = Loc.IsEnglish ? p.EnglishNote : null,
                Owned = p.Owned, Equipped = p.Equipped, CanEquip = p.Owned && !p.Equipped, CanBuy = !p.Owned && p.ForSale && p.Price.HasValue,
                Playable = _catalog?.Find(p.Id) != null,
            };
        }

        /// <summary>GET /v1/commentary/packs. Offline keeps the device's catalog and last choice.</summary>
        public async Task<ActionResult> LoadAsync(CancellationToken ct = default)
        {
            Message = null;
            if (!ServerAvailable) return ActionResult.Success();
            try
            {
                View = await B.Api.GetCommentaryPacksAsync(ct);
                Online = true;
                Kv.Set(KeyEquipped, View.Equipped);
                return ActionResult.Success();
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>
        /// Equips an owned pack. The next race speaks it; a race in progress keeps its pack. Offline, only the standard or
        /// the pack already on the device can be chosen, and the choice is saved with the next successful call.
        /// </summary>
        public async Task<ActionResult> EquipAsync(string packId, CommentaryEquipSource source = CommentaryEquipSource.Settings, CancellationToken ct = default)
        {
            if (!ServerAvailable)
            {
                if (packId != CommentaryPackCatalog.StandardPackId && packId != Equipped) return ActionResult.Error(TextOffline);
                Kv.Set(KeyEquipped, packId);
                return ActionResult.Success(TextOffline);
            }
            try
            {
                View = await B.Api.EquipCommentaryPackAsync(packId, source, ct);
                Online = true;
                Kv.Set(KeyEquipped, View.Equipped);
                if (B.Player != null) B.Player.CommentaryPack = View.Equipped;
                return ActionResult.Success(TextSaved);
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>The confirm sheet for a pack on sale (null when it is owned or not sold).</summary>
        public CommentaryPackPurchaseSheet PurchaseConfirm(string packId)
        {
            var p = View?.Find(packId);
            if (p == null || p.Owned || !p.ForSale || !p.Price.HasValue) return null;
            bool paidOnly = p.Currency == "paidOnly";
            return new CommentaryPackPurchaseSheet
            {
                PackId = p.Id, Price = p.Price.Value, PaidOnly = paidOnly,
                Title = Fmt(TextConfirmTitle, "name", p.Name), Body = Fmt(paidOnly ? TextConfirmBodyPaid : TextConfirmBody, "n", p.Price.Value),
                Notice = Loc.T(View.Notice ?? TextNotice), ConfirmLabel = Loc.T(TextBuy), CancelLabel = Loc.T(TextCancel),
            };
        }

        /// <summary>
        /// Buys a pack for coins (POST …/buy). A retry of the same pack reuses its idempotency key (never charged twice).
        /// Not enough coins: fails with <see cref="Shortfall"/> set for the T6 sheet.
        /// </summary>
        public async Task<ActionResult> BuyAsync(string packId, bool equip = true, CancellationToken ct = default)
        {
            Shortfall = null;
            if (!ServerAvailable) return ActionResult.Error(TextBuyOffline);
            if (!_buyKeys.TryGetValue(packId, out var key)) _buyKeys[packId] = key = B.Api.NewIdempotencyKey();
            try
            {
                var r = await B.Api.BuyCommentaryPackAsync(packId, equip, key, ct);
                _buyKeys.Remove(packId);
                View = r.View ?? View;
                Online = true;
                if (View != null) Kv.Set(KeyEquipped, View.Equipped);
                if (B.Player != null && View != null) B.Player.CommentaryPack = View.Equipped;
                return ActionResult.Success(TextBought);
            }
            catch (InsufficientCoinsException e) { _buyKeys.Remove(packId); Shortfall = e.Shortfall; Message = UxText.For(e); return ActionResult.Error(Message); }
            catch (ApiException e)
            {
                if (e.WireCode == "ALREADY_PURCHASED") { _buyKeys.Remove(packId); await LoadAsync(ct); }
                Message = UxText.For(e); return ActionResult.Error(Message);
            }
        }

        /// <summary>
        /// REQ-CMT-002: the templates a race speaks — the equipped pack over <paramref name="standard"/> (the language's
        /// commentary-ja/en.json). Falls back to the standard when the pack is not in the device catalog or fails the lint.
        /// The tutorial speaks the standard anyway (the Commentator checks the mode).
        /// </summary>
        public static CommentaryTemplates TemplatesFor(CommentaryTemplates standard, CommentaryPackCatalog catalog, string packId)
        {
            if (standard == null || catalog == null || string.IsNullOrEmpty(packId) || packId == CommentaryPackCatalog.StandardPackId) return standard;
            var p = catalog.Find(packId);
            if (p == null) return standard;
            try { return CommentaryPackCatalog.Apply(standard, p); }
            catch (FormatException) { return standard; }
        }

        public CommentaryTemplates TemplatesForRace(CommentaryTemplates standard) => TemplatesFor(standard, _catalog, Equipped);

        /// <summary>REQ-CMT-008: the 10-second sample of any pack (owned or not), in the current language's templates.</summary>
        public CommentarySampleResult Sample(string packId, CommentaryTemplates standard)
        {
            if (_catalog?.Sample == null || standard == null) return null;
            var p = _catalog.Find(packId);
            var t = p == null ? standard : TemplatesFor(standard, _catalog, packId);
            return CommentarySample.Build(_catalog.Sample, B.Ruleset, t);
        }

        /// <summary>KPI commentary_pack_sample (send with the analytics client when the sample starts).</summary>
        public AnalyticsEvent SampleEvent(string packId, long nowMs)
        {
            bool owned = View?.Find(packId)?.Owned ?? packId == CommentaryPackCatalog.StandardPackId;
            return AnalyticsEvent.CommentaryPackSample(nowMs, packId, owned);
        }
    }
}
