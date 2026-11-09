using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    /// <summary>Where the app is when a coin shortfall could be shown (06 §5.1).</summary>
    public enum ShortfallContext
    {
        /// <summary>The scout confirmation (before a pull) or the scout screen after a refused pull.</summary>
        ScoutConfirm,
        /// <summary>見た目 (cosmetics) shop / try-on, after a refused purchase or before it.</summary>
        CosmeticShop,
        /// <summary>The shop itself.</summary>
        Shop,
        /// <summary>In a race (also spectating and replays): never.</summary>
        Race,
        /// <summary>Waiting for a match: never.</summary>
        Matchmaking,
        /// <summary>Tutorial / first session (FTUE): never.</summary>
        Tutorial,
        /// <summary>The result screen right after a loss: never (06 §5.1; the shortfall waits until the player acts again).</summary>
        AfterLoss,
    }

    /// <summary>What the player was doing when the coins ran short: the purchase returns here.</summary>
    public sealed class ShortfallOrigin
    {
        /// <summary>"gacha" | "cosmetic".</summary>
        public string Kind;
        public string BannerId, ItemId;
        public int Count;
        public static ShortfallOrigin Gacha(string bannerId, int count) => new ShortfallOrigin { Kind = "gacha", BannerId = bannerId, Count = count };
        public static ShortfallOrigin Cosmetic(string itemId) => new ShortfallOrigin { Kind = "cosmetic", ItemId = itemId };
    }

    /// <summary>
    /// T6 コイン不足の案内 (REQ-SHORT-006..009, contracts/protocol.md §29): the sheet 「コインが1,200枚足りません」 → ONE pack card →
    /// the existing purchase confirmation (<see cref="PurchaseConfirmModel"/>) → back to the original action. Every text comes from the
    /// server (headline, line, notes, the pack's contents and its first-purchase line); the client adds only the buttons.
    /// Never shown in a race, while matching, in the tutorial or on the result screen right after a loss (<see cref="Allowed"/>).
    /// KPI: offer_view when the sheet is drawn, offer_click when the pack is chosen (offerId "shortfall", trigger "T6"), once per
    /// shortfall shown.
    /// </summary>
    public sealed class CoinShortfallModel : ScreenModel
    {
        public const string OfferId = "shortfall";
        public const string Trigger = "T6";
        public const string CloseLabel = "閉じる";
        public const string ChooseLabel = "購入を確認";
        private readonly Action<AnalyticsEvent> _track;
        private readonly NowMs _now;
        private bool _viewSent, _clickSent;

        public CoinShortfallModel(GameBackend backend, Action<AnalyticsEvent> track = null, NowMs now = null) : base(backend, backend?.Store)
        {
            _track = track;
            _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        /// <summary>06 §5.1: the contexts where the shortfall sheet may appear at all.</summary>
        public static bool Allowed(ShortfallContext c) => c == ShortfallContext.ScoutConfirm || c == ShortfallContext.CosmeticShop || c == ShortfallContext.Shop;

        public CoinShortfall Shortfall { get; private set; }
        public ShortfallOrigin Origin { get; private set; }
        public ShortfallContext Context { get; private set; }

        /// <summary>The sheet is to be drawn now.</summary>
        public bool Visible => Shortfall != null && Shortfall.Short && Allowed(Context);
        /// <summary>"有償コインが1,200枚足りません" (server text).</summary>
        public string Headline => Visible ? Shortfall.Headline : null;
        /// <summary>"コイン1,660（¥2,400）で足ります" / "いちばん大きい…でも、あと◯枚足りません" / the reason nothing can be bought.</summary>
        public string Line => Visible ? Shortfall.Line : null;
        public List<string> Notes => Visible ? Shortfall.Notes : new List<string>();
        /// <summary>The single pack card (null when nothing can be offered: free-only payment, monthly limit, unsettled refund …).</summary>
        public ProductCard Pack
        {
            get
            {
                if (!Visible || !Shortfall.HasOffer) return null;
                var o = Shortfall.Offer;
                return new ProductCard
                {
                    Id = o.ProductId, Name = o.Name ?? o.ProductId, PriceYen = o.PriceYen, PriceText = "¥" + o.PriceYen.ToString("N0", CultureInfo.InvariantCulture),
                    Lines = o.Contents.Select(c => c.Label).Where(x => !string.IsNullOrEmpty(x)).ToList(),
                    BonusLabel = o.FirstPurchaseBonus?.Label, OneTimeText = o.OneTime ? "1回限り" : null,
                    Purchasable = ServerAvailable && !DeletionGuard.Pending(B),
                    DisabledReason = !ServerAvailable ? UxText.Offline : DeletionGuard.Pending(B) ? DeletionGuard.Banner(B) : null,
                };
            }
        }

        /// <summary>
        /// A refused spend: show the shortfall the server attached (none from an older server: the caller shows its own message).
        /// Returns whether the sheet is visible.
        /// </summary>
        public bool FromError(InsufficientCoinsException e, ShortfallContext ctx, ShortfallOrigin origin)
        {
            Reset(ctx, origin);
            Shortfall = e?.Shortfall;
            return Visible;
        }

        /// <summary>
        /// Before trying (the scout confirmation): asks GET /v1/shop/shortfall. Not short → <see cref="Visible"/> false and the pull
        /// goes ahead. Offline / errors → no sheet (the pull itself will answer).
        /// </summary>
        public async Task<bool> PreviewAsync(ShortfallOrigin origin, ShortfallContext ctx, CancellationToken ct = default)
        {
            Reset(ctx, origin);
            if (!Allowed(ctx) || !ServerAvailable || origin == null) return false;
            try
            {
                Shortfall = origin.Kind == "cosmetic" ? await B.Api.GetCoinShortfallForCosmeticAsync(origin.ItemId, ct) : await B.Api.GetCoinShortfallForGachaAsync(origin.BannerId, origin.Count, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (ApiException) { Shortfall = null; }
            return Visible;
        }

        private void Reset(ShortfallContext ctx, ShortfallOrigin origin)
        {
            Context = ctx; Origin = origin; Shortfall = null; Message = null; _viewSent = false; _clickSent = false;
        }

        /// <summary>The sheet was drawn: KPI offer_view (once per shortfall shown).</summary>
        public void Shown()
        {
            if (!Visible || _viewSent) return;
            _viewSent = true;
            _track?.Invoke(AnalyticsEvent.OfferView(_now(), OfferId, Trigger));
        }

        /// <summary>The pack was tapped: KPI offer_click; returns the product id to open in <see cref="PurchaseConfirmModel.OpenAsync"/>.</summary>
        public string Choose()
        {
            var p = Pack;
            if (p == null || !p.Purchasable) return null;
            if (!_clickSent) { _clickSent = true; _track?.Invoke(AnalyticsEvent.OfferClick(_now(), OfferId, Trigger)); }
            return p.Id;
        }

        /// <summary>The sheet was closed without buying.</summary>
        public void Close() { Shortfall = null; }

        /// <summary>
        /// The purchase confirmation finished. Completed → the origin to go back to (the screen repeats that pull / purchase); the
        /// sheet is gone. Any other stage keeps the sheet (cancelled, pending, refused) and returns null.
        /// </summary>
        public ShortfallOrigin AfterPurchase(PurchaseStage stage)
        {
            if (stage != PurchaseStage.Completed) return null;
            var o = Origin;
            Shortfall = null;
            return o;
        }
    }
}
