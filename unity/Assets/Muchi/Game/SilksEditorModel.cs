using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    /// <summary>Tabs of the 勝負服エディタ (the part list under the live preview).</summary>
    public enum SilksTab { Pattern, Colors, Sleeve, Cap }

    /// <summary>One card in the part list.</summary>
    public sealed class SilksPartCard
    {
        public SilksPart Part;
        public bool Selected;
        /// <summary>Not owned but selected in the draft: the 試着中 label.</summary>
        public bool TryingOn;
        public bool Locked => !Part.Owned;
        /// <summary>Too close to the other colour of the slot being edited (drawn dimmed; the server refuses it on save).</summary>
        public bool LowContrast;
        /// <summary>Lock line: the server's "コイン200で購入" / "実績「…」の2段目で解放" / "レースを50回走ると解放".</summary>
        public string LockLine => Locked ? Part.SourceLabel : null;
    }

    /// <summary>One line of the purchase confirmation of a part (the existing cosmetic purchase flow).</summary>
    public sealed class SilksPurchaseLine
    {
        public string ItemId, Name, PriceText, CurrencyNote;
        public int Price;
        public bool PaidOnly;
    }

    /// <summary>
    /// 勝負服エディタ (REQ-SILK-001..016, contracts/protocol.md §35). The draft is edited locally and drawn on the jockey with the
    /// recolour masks (Codex: docs/handoff-codex-round14-silks-editor.md); any part can be tried on (試着中) without owning it.
    /// Saving needs every part owned: otherwise <see cref="SaveAsync"/> returns the parts still to get, and each is bought one by
    /// one through <see cref="BuyAsync"/> (fixed price, paid coins first, 有償限定 on paid coins only; never random).
    /// Readability (lowContrastPairs) and the reserved-silks check come from the server; the model never computes contrast.
    /// </summary>
    public sealed class SilksEditorModel : ScreenModel
    {
        public const string TextTitle = "勝負服エディタ";
        public const string TextTryingOn = "試着中";
        public const string TextOwned = "所持";
        public const string TextSave = "保存する";
        public const string TextSaved = "勝負服を保存しました";
        public const string TextNeedParts = "持っていないパーツがあります。入手すると保存できます";
        public const string TextPaidOnly = "有償限定（有償コインのみ）";
        public const string TextPaidFirst = "有償コインから先に使われます";
        public const string TextBought = "パーツを入手しました";
        public const string TextPresetEmpty = "空き";
        public const string TextPresetSaved = "プリセットに保存しました";
        public const string TextPresetUnusable = "使えないパーツがあります";
        public const string TextOffline = "勝負服の編集はオンラインで行えます";
        public const string TextLooksOnly = "見た目のみ。ランク戦の能力には影響しません";

        public SilksEditorModel(GameBackend backend, IKeyValueStore store = null) : base(backend, store ?? backend?.Store) { }

        public SilksEditorView View { get; private set; }
        public SilksCodeTables Tables { get; private set; }
        /// <summary>The design being edited (drawn live).</summary>
        public SilksDesign Draft { get; private set; }
        public SilksTab Tab = SilksTab.Pattern;
        /// <summary>Colors tab: which colour is edited — 0..2 body, 3..4 cap.</summary>
        public int ColorSlot;
        /// <summary>Last answer of POST /v1/silks/preview for the draft (locked parts, total price, problems).</summary>
        public SilksPreview Preview { get; private set; }
        private readonly Dictionary<string, string> _buyKeys = new Dictionary<string, string>();

        public async Task<ActionResult> LoadAsync(CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline(TextOffline);
            try
            {
                View = await B.Api.GetSilksEditorAsync(ct);
                Tables = SilksCodeTables.From(View);
                Draft = (View.Current ?? new SilksDesign()).Clone();
                Online = true;
                return ActionResult.Success();
            }
            catch (ApiException e) { return Fail(e); }
        }

        /// <summary>The code of the draft (what other players will receive once saved).</summary>
        public string DraftCode { get { try { return Draft == null ? null : SilksCode.Encode(Draft, Tables); } catch (ArgumentException) { return null; } } }
        public bool Dirty => View != null && Draft != null && !Draft.SameAs(View.Current);

        private int BodyColors => View?.Part("pattern", Draft.Pattern)?.ColorCount ?? Draft.Colors.Length;

        /// <summary>The parts of the draft that are not owned (試着中).</summary>
        public List<SilksPart> TryingOn
        {
            get
            {
                var outp = new List<SilksPart>();
                if (View == null || Draft == null) return outp;
                void Add(string type, string id) { var p = View.Part(type, id); if (p != null && !p.Owned && !outp.Contains(p)) outp.Add(p); }
                Add("pattern", Draft.Pattern);
                foreach (var c in Draft.Colors.Concat(Draft.CapColors)) Add("color", c);
                Add("sleeve", Draft.Sleeve);
                Add("cap", Draft.Cap);
                return outp;
            }
        }

        public bool IsTryingOn => TryingOn.Count > 0;

        /// <summary>Cards of the current tab.</summary>
        public List<SilksPartCard> Cards()
        {
            if (View == null) return new List<SilksPartCard>();
            switch (Tab)
            {
                case SilksTab.Pattern: return View.Patterns.Select(p => Card(p, Draft.Pattern == p.Id, false)).ToList();
                case SilksTab.Sleeve: return View.Sleeves.Select(p => Card(p, Draft.Sleeve == p.Id, false)).ToList();
                case SilksTab.Cap: return View.Caps.Select(p => Card(p, Draft.Cap == p.Id, false)).ToList();
                default:
                    var cur = SlotColor(ColorSlot);
                    var other = PairedColor(ColorSlot);
                    return View.Colors.Select(p => Card(p, cur == p.Id, other != null && View.IsLowContrast(p.Id, other))).ToList();
            }
        }

        private static SilksPartCard Card(SilksPart p, bool selected, bool low) => new SilksPartCard { Part = p, Selected = selected, TryingOn = selected && !p.Owned, LowContrast = low };

        private string SlotColor(int slot) => slot < 3 ? (slot < Draft.Colors.Length ? Draft.Colors[slot] : null) : Draft.CapColors[slot - 3];
        /// <summary>Readability pairs: body 1↔2 and cap 1↔2 (protocol §35.3).</summary>
        private string PairedColor(int slot) => slot == 0 ? SlotColor(1) : slot == 1 ? SlotColor(0) : slot == 3 ? SlotColor(4) : slot == 4 ? SlotColor(3) : null;

        /// <summary>Pick a part on the current tab (owned or not: trying on is always allowed).</summary>
        public void Pick(string id)
        {
            if (View == null) return;
            Preview = null;
            switch (Tab)
            {
                case SilksTab.Pattern:
                    Draft.Pattern = id;
                    int n = BodyColors;
                    if (Draft.Colors.Length != n)
                    {
                        var c = Draft.Colors.ToList();
                        while (c.Count < n) c.Add(View.Colors.First(x => x.Owned && !c.Contains(x.Id)).Id);
                        Draft.Colors = c.Take(n).ToArray();
                    }
                    if (ColorSlot == 2 && n < 3) ColorSlot = 0;
                    break;
                case SilksTab.Sleeve: Draft.Sleeve = id; break;
                case SilksTab.Cap: Draft.Cap = id; break;
                default:
                    if (ColorSlot < 3) { if (ColorSlot < Draft.Colors.Length) Draft.Colors[ColorSlot] = id; }
                    else Draft.CapColors[ColorSlot - 3] = id;
                    break;
            }
        }

        public void Revert() { if (View != null) { Draft = View.Current.Clone(); Preview = null; } }

        /// <summary>REQ-SILK-006: ask the server about the draft (locked parts with prices, readability, reserved silks).</summary>
        public async Task<ActionResult> PreviewAsync(CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline(TextOffline);
            try { Preview = await B.Api.PreviewSilksAsync(Draft, ct); return ActionResult.Success(); }
            catch (ApiException e) { return Fail(e); }
        }

        /// <summary>Save the draft. With parts still to get it does not call the server and says so (buy them first).</summary>
        public async Task<ActionResult> SaveAsync(CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline(TextOffline);
            if (IsTryingOn) { Message = TextNeedParts; return ActionResult.Error(TextNeedParts); }
            try
            {
                var r = await B.Api.SaveSilksAsync(Draft, ct);
                View.Current = r.Design.Clone();
                View.CurrentCode = r.Code;
                View.CurrentSilks = r.Silks;
                Draft = r.Design.Clone();
                Message = TextSaved;
                return ActionResult.Success(TextSaved);
            }
            catch (ApiException e) { return Fail(e); }
        }

        /// <summary>Confirmation lines for buying the tried-on parts that are sold for coins (one purchase per part).</summary>
        public List<SilksPurchaseLine> PurchaseLines() => TryingOn.Where(p => p.Shop != null && p.Shop.ForSale).Select(Line).ToList();

        public static SilksPurchaseLine Line(SilksPart p) => new SilksPurchaseLine
        {
            ItemId = p.Shop.ItemId, Name = p.Name, Price = p.Shop.Price, PaidOnly = p.Shop.PaidOnly,
            PriceText = Loc.T((p.Shop.PaidOnly ? "有償コイン" : "コイン") + p.Shop.Price + "枚"),
            CurrencyNote = p.Shop.PaidOnly ? TextPaidOnly : TextPaidFirst,
        };

        /// <summary>REQ-SILK-005: buy one part (after the confirmation). The idempotency key is kept until it succeeds, so a retry never charges twice.</summary>
        public async Task<ActionResult> BuyAsync(string itemId, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline(TextOffline);
            if (!_buyKeys.TryGetValue(itemId, out var key)) _buyKeys[itemId] = key = B.Api.NewIdempotencyKey();
            try
            {
                var r = await B.Api.BuySilksPartAsync(itemId, key, ct);
                _buyKeys.Remove(itemId);
                var part = View.Part(r.PartType, r.PartId);
                if (part != null) part.Owned = true;
                if (r.Wallet != null) View.Wallet = r.Wallet;
                Preview = null;
                return ActionResult.Success(TextBought);
            }
            catch (ApiException e) { return Fail(e); }
        }

        // ---- presets (REQ-SILK-011)

        /// <summary>All slots (MaxPresets), null where empty.</summary>
        public List<SilksPreset> Slots()
        {
            var outp = new List<SilksPreset>();
            if (View == null) return outp;
            for (int i = 0; i < View.MaxPresets; i++) outp.Add(View.Presets.Find(p => p.Slot == i));
            return outp;
        }

        public string SlotLabel(int slot) { var p = Slots().ElementAtOrDefault(slot); return p == null ? TextPresetEmpty : p.Usable ? p.Name : p.Name + "（" + Loc.T(TextPresetUnusable) + "）"; }

        public async Task<ActionResult> SavePresetAsync(int? slot, string name, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline(TextOffline);
            if (IsTryingOn) { Message = TextNeedParts; return ActionResult.Error(TextNeedParts); }
            try
            {
                var r = slot.HasValue && View.Presets.Any(p => p.Slot == slot.Value)
                    ? await B.Api.UpdateSilksPresetAsync(slot.Value, Draft, name, ct)
                    : await B.Api.SaveSilksPresetAsync(Draft, name, ct);
                View.Presets = r.Presets;
                return ActionResult.Success(TextPresetSaved);
            }
            catch (ApiException e) { return Fail(e); }
        }

        /// <summary>Load a preset into the draft (even an unusable one, to try it on); ApplyPresetAsync equips it on the server.</summary>
        public bool LoadPreset(int slot)
        {
            var p = Slots().ElementAtOrDefault(slot);
            if (p?.Design == null) return false;
            Draft = p.Design.Clone();
            Preview = null;
            return true;
        }

        public async Task<ActionResult> ApplyPresetAsync(int slot, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline(TextOffline);
            try
            {
                var r = await B.Api.ApplySilksPresetAsync(slot, ct);
                View.Current = r.Design.Clone();
                View.CurrentCode = r.Code;
                Draft = r.Design.Clone();
                return ActionResult.Success(TextSaved);
            }
            catch (ApiException e) { return Fail(e); }
        }

        public async Task<ActionResult> DeletePresetAsync(int slot, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline(TextOffline);
            try { View.Presets = (await B.Api.DeleteSilksPresetAsync(slot, ct)).Presets; return ActionResult.Success(); }
            catch (ApiException e) { return Fail(e); }
        }

        /// <summary>REQ-SILK-010: the refund reset notice (server text), shown once.</summary>
        public string ResetNotice => View?.ResetNotice;

        public async Task MarkNoticeSeenAsync(CancellationToken ct = default)
        {
            if (View?.ResetNotice == null || !ServerAvailable) return;
            try { await B.Api.MarkSilksNoticeSeenAsync(ct); View.ResetNotice = null; } catch (ApiException) { /* shown again next time */ }
        }
    }
}
