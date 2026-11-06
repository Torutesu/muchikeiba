using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    /// <summary>One product card, every text from the server (REQ-UXS-022): the client never builds bonus wording.</summary>
    public sealed class ProductCard
    {
        public string Id, Name, Tab, PriceText;
        public int PriceYen;
        /// <summary>Contents in display order ("有償コイン100枚", "30日間、毎日 無償コイン30枚…").</summary>
        public List<string> Lines = new List<string>();
        /// <summary>The first-purchase bonus line, only while this pack still has it ("はじめての購入時のみ：無償コイン100枚をプレゼント").</summary>
        public string BonusLabel;
        /// <summary>"1回限り" / "各クラス1回" / null.</summary>
        public string OneTimeText;
        /// <summary>"シーズン終了まで（11月30日 23:59まで）・自動更新なし" / "30日間・自動更新なし" / null.</summary>
        public string PeriodText;
        /// <summary>Notice texts for this product (NoticeKeys resolved; legal links are listed separately at the bottom).</summary>
        public List<string> Notices = new List<string>();
        public bool Purchasable;
        /// <summary>Why the buy button is disabled (deletion pending, unsettled refund, offline, allowance already running).</summary>
        public string DisabledReason;
    }

    /// <summary>Where a one-time offer sheet may appear (06 §5.1). Never during a race, matching, the tutorial or right after a loss.</summary>
    public enum OfferContext { AfterResultClosed, PassScreen, SeasonStart, AfterPromotion }

    /// <summary>
    /// REQ-UXU-010 / REQ-UXS-017/022: the shop. Tabs おすすめ／コイン／見た目／パス (見た目 = ItemsBackend), wallet with paid and
    /// free on separate lines, the T1 first-purchase note, product cards from the server's display data, legal links at the
    /// bottom. Offers: a one-time sheet only while the server says <c>showPopup</c> and only in its context; marked viewed
    /// locally first (never twice, even if the call fails) and then on the server (KPI offer_view). End times are real
    /// period ends only, counted down with <see cref="GameDay"/> between fetches. While the account is scheduled for
    /// deletion every buy button, offer and the allowance claim are disabled with the deletion banner (G6).
    /// </summary>
    public sealed class ShopModel : ScreenModel
    {
        public const string KeyOffersShown = "muchi.offers.shown";
        public static readonly string[] Tabs = { "recommended", "coins", "cosmetics", "pass" };
        public static readonly IReadOnlyDictionary<string, string> TabTitles = new Dictionary<string, string> { ["recommended"] = "おすすめ", ["coins"] = "コイン", ["cosmetics"] = "見た目", ["pass"] = "パス" };
        /// <summary>Words the client must never show next to a price (03 / 06 §5.5: 有利誤認, 二重価格).</summary>
        public static readonly string[] ForbiddenWords = { "倍", "×2", "x2", "2x", "お得", "通常価格" };

        private readonly NowMs _now;
        private readonly Action<AnalyticsEvent> _track;

        public ShopModel(GameBackend backend, Action<AnalyticsEvent> track = null, NowMs now = null) : base(backend, backend?.Store)
        {
            _track = track;
            _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        public ProductList Products { get; private set; }
        public ShopOffers Offers { get; private set; }
        public bool Loading { get; private set; }
        /// <summary>The account is scheduled for deletion (from the player or a DELETION_PENDING answer).</summary>
        public bool DeletionPending { get; private set; }
        public string DeletionBanner => DeletionPending ? DeletionGuard.Banner(B.Player?.Deletion?.DeleteAt) : null;
        public bool Debt => (B.Player?.Wallet?.Debt ?? 0) > 0;
        /// <summary>Buy buttons are enabled at all.</summary>
        public bool CanPurchase => ServerAvailable && !DeletionPending && !Debt && Products != null;

        /// <summary>"有償コイン 100" and "無償コイン 195" (never one total, G3).</summary>
        public string PaidLine => "有償コイン " + (B.Player?.Wallet?.Paid ?? 0).ToString("N0", CultureInfo.InvariantCulture);
        public string FreeLine => "無償コイン " + (B.Player?.Wallet?.Free ?? 0).ToString("N0", CultureInfo.InvariantCulture);
        public string DebtLine => Debt ? "未精算の返金 " + B.Player.Wallet.Debt.ToString("N0", CultureInfo.InvariantCulture) + "（購入・スカウトを止めています）" : null;
        /// <summary>T1: "コインのパックは、はじめて購入したときだけ、同じ枚数の無償コインを…" while any pack still has its bonus.</summary>
        public string FirstPurchaseNote
        {
            get
            {
                var fp = Offers?.FirstPurchase;
                if (fp == null || !fp.Available) return null;
                return Products != null && fp.NoticeKey != null && Products.Notices.TryGetValue(fp.NoticeKey, out var t) ? t : null;
            }
        }
        /// <summary>"有償コインから先に使われます".</summary>
        public string PaidFirstNote => Products?.Notice;
        public List<LegalLink> LegalLinks => Products?.LegalLinks ?? new List<LegalLink>();

        public async Task LoadAsync(CancellationToken ct = default)
        {
            Message = null; Online = false;
            DeletionPending = DeletionGuard.Pending(B);
            if (!ServerAvailable) { Offline("購入にはサーバーが必要です"); Message = UxText.Offline; return; }
            Loading = true;
            try
            {
                Products = await B.Api.GetProductsAsync(ct);
                Online = true;
                if (!DeletionPending) await LoadOffersAsync(ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (ApiException e) { Message = UxText.For(e); }
            finally { Loading = false; }
        }

        /// <summary>Refetch the offers (after a race result closed: the starter offer's trigger is recorded by this call on the server).</summary>
        public async Task LoadOffersAsync(CancellationToken ct = default)
        {
            if (!ServerAvailable) return;
            try { Offers = await B.Api.GetShopOffersAsync(ct); }
            catch (PurchaseBlockedException e) when (e.Code == ApiErrorCode.DeletionPending) { DeletionPending = true; Offers = null; }
            catch (ApiException e) { Message = UxText.For(e); }
        }

        // ------------------------------------------------------------------ cards

        /// <summary>
        /// The product list is the same for everyone; whether this player still gets a pack's bonus comes from the offers
        /// (T1 productIds). Before the offers are known the label (which itself says "はじめての購入時のみ") is shown.
        /// </summary>
        private bool PackHasBonus(Product p)
        {
            if (p.FirstPurchaseBonus == null) return false;
            var fp = Offers?.FirstPurchase;
            if (Offers == null || fp == null) return true;
            return fp.Available && fp.ProductIds.Contains(p.Id);
        }

        /// <summary>Products of a tab ("cosmetics" is ItemsBackend's). Promotion packs are on おすすめ only while their T4 offer is live.</summary>
        public List<ProductCard> Cards(string tab)
        {
            if (Products == null || tab == "cosmetics") return new List<ProductCard>();
            var live = new HashSet<string>(LiveOffers.Select(o => o.ProductId));
            return Products.Products
                .Where(p => p.Tab == tab)
                .Where(p => p.ClassId == null || live.Contains(p.Id))
                .Select(Card).ToList();
        }

        public ProductCard Card(Product p)
        {
            var c = new ProductCard
            {
                Id = p.Id, Name = p.Name ?? p.Id, Tab = p.Tab, PriceYen = p.PriceYen, PriceText = "¥" + p.PriceYen.ToString("N0", CultureInfo.InvariantCulture),
                Lines = p.Contents.Select(x => x.Label).Where(x => !string.IsNullOrEmpty(x)).ToList(),
                BonusLabel = PackHasBonus(p) ? p.FirstPurchaseBonus.Label : null,
                OneTimeText = !p.OneTime ? null : p.OneTimeScope == "class" ? "各クラス1回" : "1回限り",
                PeriodText = PeriodText(p),
            };
            foreach (var k in p.NoticeKeys)
                if (!k.StartsWith("legal.", StringComparison.Ordinal) && k != "shop.paid_first" && Products.Notices.TryGetValue(k, out var t)) c.Notices.Add(t);
            c.DisabledReason = !ServerAvailable ? UxText.Offline : DeletionPending ? DeletionBanner : Debt ? UxText.Errors["UNSETTLED_DEBT"]
                : p.Allowance != null && Offers?.Allowance != null && Offers.Allowance.Queued != null ? "次の厩舎手当が予約済みです" : null;
            c.Purchasable = c.DisabledReason == null && Products != null;
            return c;
        }

        private string PeriodText(Product p)
        {
            if (p.Period == null) return null;
            string renew = p.AutoRenew ? "" : "・自動更新なし";
            if (p.Period.Kind == "days") return (p.Period.Days ?? p.Allowance?.Days ?? 0) + "日間" + renew;
            if (p.Period.Kind == "season")
            {
                var o = Offers?.Offers.FirstOrDefault(x => x.ProductId == p.Id && x.EndsAt.HasValue);
                return "シーズン終了まで" + (o != null ? "（" + GameDay.UntilLabel(o.EndsAt.Value) + "）" : "") + renew;
            }
            return null;
        }

        /// <summary>Every text the shop would draw that contains a forbidden multiplier / price-comparison word (expected: none).</summary>
        public List<string> WordingProblems()
        {
            var texts = new List<string>();
            foreach (var tab in Tabs) foreach (var c in Cards(tab)) { texts.Add(c.Name); texts.AddRange(c.Lines); texts.Add(c.BonusLabel); texts.Add(c.PeriodText); texts.AddRange(c.Notices); }
            texts.Add(FirstPurchaseNote); texts.Add(PaidFirstNote);
            return texts.Where(t => t != null && ForbiddenWords.Any(w => t.Contains(w))).ToList();
        }

        // ------------------------------------------------------------------ offers (REQ-UXS-017)

        private HashSet<string> ShownLocally => new HashSet<string>((Kv.Get(KeyOffersShown) ?? "").Split(',').Where(s => s.Length > 0));

        /// <summary>Offers not expired at the device's now (EndsAt counted with game days; null EndsAt = no end).</summary>
        public List<ShopOffer> LiveOffers => DeletionPending || Offers == null ? new List<ShopOffer>() : Offers.Offers.Where(o => !o.EndsAt.HasValue || o.EndsAt.Value > _now()).ToList();

        /// <summary>Game days left for an offer at the device's now (the server's remainingDays at fetch, kept honest across midnight); null = no end.</summary>
        public int? RemainingDays(ShopOffer o) => o?.EndsAt == null ? (int?)null : GameDay.DaysUntil(o.EndsAt.Value, _now());

        /// <summary>"あと6日（11月30日 23:59まで）" for a real period end; null when there is none or it has passed.</summary>
        public string Countdown(ShopOffer o)
        {
            var d = RemainingDays(o);
            if (d == null || d.Value <= 0) return null;
            return GameDay.RemainingLabel(d.Value) + "（" + GameDay.UntilLabel(o.EndsAt.Value) + "）";
        }

        private static bool Fits(ShopOffer o, OfferContext ctx)
        {
            switch (o.Touchpoint)
            {
                case "T2": return ctx == OfferContext.AfterResultClosed;
                case "T3": return ctx == OfferContext.PassScreen || ctx == OfferContext.SeasonStart;
                case "T4": return ctx == OfferContext.AfterPromotion;
                default: return false; // "shop" offers live on the おすすめ tab only
            }
        }

        /// <summary>The one-time sheet to show now in <paramref name="ctx"/>, or null (at most one; never while deletion is pending).</summary>
        public ShopOffer PopupFor(OfferContext ctx)
        {
            var shown = ShownLocally;
            return LiveOffers.FirstOrDefault(o => o.ShowPopup && o.Placement == "popup" && !o.ViewedAt.HasValue && !shown.Contains(o.Id) && Fits(o, ctx));
        }

        /// <summary>The sheet was drawn: remember it on the device first, then on the server (retried; idempotent), KPI offer_view.</summary>
        public async Task MarkShownAsync(ShopOffer o, CancellationToken ct = default)
        {
            if (o == null) return;
            var shown = ShownLocally;
            if (shown.Add(o.Id)) Kv.Set(KeyOffersShown, string.Join(",", shown));
            if (IsTrigger(o.Touchpoint)) _track?.Invoke(AnalyticsEvent.OfferView(_now(), o.Id, o.Touchpoint));
            if (!ServerAvailable) return;
            try { var v = await B.Api.MarkOfferViewedAsync(o.Id, ct); o.ViewedAt = v.ViewedAt; o.ShowPopup = false; }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (ApiException) { /* kept locally; the next fetch still says viewedAt=null but the sheet is not shown again */ }
        }

        /// <summary>The player tapped through to the product (KPI offer_click). Returns the product id to open in the purchase confirmation.</summary>
        public string Click(ShopOffer o)
        {
            if (o == null) return null;
            if (IsTrigger(o.Touchpoint)) _track?.Invoke(AnalyticsEvent.OfferClick(_now(), o.Id, o.Touchpoint));
            return o.ProductId;
        }

        private static bool IsTrigger(string t) => t != null && AnalyticsEvent.OfferTriggers.Contains(t);
    }

    /// <summary>
    /// REQ-UXS-018: 厩舎手当 (30 days, no auto-renew): today's claim once per game day. The claim key is kept on the device for the
    /// game day until the server answers (a retry never pays twice). Blocked while the deletion is pending.
    /// </summary>
    public sealed class AllowanceModel : ScreenModel
    {
        public const string KeyPending = "muchi.allowance.key";
        private readonly NowMs _now;
        public AllowanceModel(GameBackend backend, NowMs now = null) : base(backend, backend?.Store) { _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()); }

        public AllowanceView View { get; private set; } = new AllowanceView();
        public bool DeletionPending { get; private set; }
        /// <summary>The view was fetched on an earlier game day (a new day may be claimable: refetch).</summary>
        public bool Stale => _loadedDay != null && _loadedDay != GameDay.Key(_now());
        private string _loadedDay;

        public bool CanClaim => ServerAvailable && !DeletionPending && View.CanClaim && !Stale;
        /// <summary>"厩舎手当 5/30日目・残り26日（12月24日まで）" / "次の手当: 12月25日から" / null when none.</summary>
        public string StatusLine
        {
            get
            {
                if (View.Active) return "厩舎手当 " + View.Day + "/" + View.Days + "日目・残り" + View.DaysLeft + "日（" + KeyLabel(View.EndDate) + "まで）" + (View.ClaimedToday ? "・今日は受取済み" : "");
                if (View.Queued != null) return "次の厩舎手当：" + KeyLabel(View.Queued.StartDate) + "から";
                return null;
            }
        }

        /// <summary>"12月24日" from a game day key.</summary>
        public static string KeyLabel(string key) => GameDay.TryParseKey(key, out var d) ? d.Month + "月" + d.Day + "日" : key ?? "";

        public async Task LoadAsync(CancellationToken ct = default)
        {
            Message = null; Online = false;
            DeletionPending = DeletionGuard.Pending(B);
            if (!ServerAvailable) { Offline("厩舎手当の受け取りにはサーバーが必要です"); Message = UxText.Offline; return; }
            try { View = await B.Api.GetAllowanceAsync(ct); _loadedDay = GameDay.Key(_now()); Online = true; }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (ApiException e) { Message = UxText.For(e); }
        }

        public async Task<ActionResult> ClaimAsync(CancellationToken ct = default)
        {
            Message = null;
            if (!ServerAvailable) return Offline("厩舎手当の受け取りにはサーバーが必要です");
            if (DeletionPending) return ActionResult.Error(Message = DeletionGuard.Banner(B));
            if (Stale) await LoadAsync(ct);
            if (!View.Active) return ActionResult.Error(Message = "受け取れる厩舎手当がありません");
            if (View.ClaimedToday) return ActionResult.Error(Message = "今日の分は受取済みです。明日 " + GameDay.RolloverHourJst + ":00 に更新");
            string day = GameDay.Key(_now());
            var stored = (Kv.Get(KeyPending) ?? "").Split('|');
            string key = stored.Length == 2 && stored[0] == day ? stored[1] : null;
            if (key == null) { key = B.Api.NewIdempotencyKey(); Kv.Set(KeyPending, day + "|" + key); }
            try
            {
                var r = await B.Api.ClaimAllowanceAsync(key, ct);
                Kv.Set(KeyPending, "");
                View = r.Allowance; _loadedDay = day;
                await B.RefreshAsync(ct);
                Message = "無償コイン" + r.FreeCoins + "枚を受け取りました";
                return ActionResult.Success(Message);
            }
            catch (PurchaseBlockedException e) when (e.Code == ApiErrorCode.DeletionPending)
            {
                Kv.Set(KeyPending, ""); DeletionPending = true;
                return ActionResult.Error(Message = UxText.For(e));
            }
            catch (ConflictException e) when (e.Code == ApiErrorCode.AlreadyClaimed || e.Code == ApiErrorCode.NotEligible)
            {
                Kv.Set(KeyPending, "");
                await LoadAsync(ct);
                return ActionResult.Error(Message = UxText.For(e));
            }
            catch (ApiException e)
            {
                if (!GameBackend.IsTransient(e)) Kv.Set(KeyPending, "");
                return ActionResult.Error(Message = UxText.For(e));
            }
        }
    }

    public enum PurchaseStage { Idle, Checking, NeedsBirthMonth, NeedsGuardian, Ready, InStore, Granting, Completed, Pending, StoreFailed, Blocked, Offline, Error }

    /// <summary>What the store sheet reported (the store SDK is not wired yet; the screen passes its outcome here).</summary>
    public enum StoreOutcome { Purchased, Cancelled, Failed, Deferred }

    /// <summary>
    /// REQ-UXU-010 purchase confirmation (06 §6.8 / G7): ask the server first (purchase-intent); the birth month only when it
    /// answers AGE_REQUIRED (year and month, once), the guardian consent only for under-18s; show product, price, contents,
    /// the first-purchase bonus line, this month's remaining limit, "このパスは◯日で終わります" for a pass in its last week and
    /// "自動更新なし". AGE_LIMIT_EXCEEDED / ALREADY_PURCHASED / UNSETTLED_DEBT / DELETION_PENDING block with one sentence. After the
    /// store: the receipt is kept on the device until the server granted it (re-sending is safe, the server de-duplicates).
    /// </summary>
    public sealed class PurchaseConfirmModel : ScreenModel
    {
        public const string KeyPendingReceipt = "muchi.purchase.receipt";
        private readonly Action<AnalyticsEvent> _track;
        private readonly NowMs _now;

        public PurchaseConfirmModel(GameBackend backend, Action<AnalyticsEvent> track = null, NowMs now = null) : base(backend, backend?.Store)
        {
            _track = track;
            _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        public PurchaseStage Stage { get; private set; } = PurchaseStage.Idle;
        public string ProductId { get; private set; }
        public PurchaseIntent Intent { get; private set; }
        public PurchaseResult Granted { get; private set; }
        private int _year, _month;

        /// <summary>Lines of the confirmation sheet (server texts).</summary>
        public List<string> Lines
        {
            get
            {
                var l = new List<string>();
                var p = Intent?.Product;
                if (p == null) return l;
                l.Add((p.Name ?? p.Id) + "  ¥" + p.PriceYen.ToString("N0", CultureInfo.InvariantCulture));
                l.AddRange(p.Contents.Select(c => c.Label).Where(x => !string.IsNullOrEmpty(x)));
                if (Intent.FirstPurchaseBonus != null) l.Add(Intent.FirstPurchaseBonus.Label);
                if (Intent.Pass != null && Intent.Pass.LastWeek) l.Add("このパスは" + Intent.Pass.RemainingDays + "日で終わります");
                if (Intent.Pass != null || Intent.Allowance != null) l.Add("自動更新なし");
                if (Intent.Allowance != null) l.Add(Intent.Allowance.Days + "日間、毎日 無償コイン" + Intent.Allowance.DailyFreeCoins + "枚（1日1回受け取り）");
                if (Intent.RemainingYen.HasValue) l.Add("今月あと ¥" + Intent.RemainingYen.Value.ToString("N0", CultureInfo.InvariantCulture) + " まで購入できます");
                return l;
            }
        }

        /// <summary>The product cannot be bought because a deletion is scheduled: no server call (G6).</summary>
        public async Task<PurchaseStage> OpenAsync(string productId, CancellationToken ct = default)
        {
            ProductId = productId; Intent = null; Granted = null; Message = null;
            if (!ServerAvailable) { Message = UxText.Offline; return Stage = PurchaseStage.Offline; }
            if (DeletionGuard.Pending(B)) { Message = DeletionGuard.Banner(B); return Stage = PurchaseStage.Blocked; }
            Track("open");
            return await CheckAsync(ct);
        }

        private async Task<PurchaseStage> CheckAsync(CancellationToken ct)
        {
            Stage = PurchaseStage.Checking;
            try
            {
                Intent = await B.Api.PurchaseIntentAsync(ProductId, ct);
                Message = null;
                return Stage = PurchaseStage.Ready;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (PurchaseBlockedException e)
            {
                Message = UxText.For(e);
                switch (e.Code)
                {
                    case ApiErrorCode.AgeRequired: return Stage = PurchaseStage.NeedsBirthMonth;
                    case ApiErrorCode.GuardianConsentRequired: return Stage = PurchaseStage.NeedsGuardian;
                    default: return Stage = PurchaseStage.Blocked;
                }
            }
            catch (NetworkException) { Message = UxText.Offline; return Stage = PurchaseStage.Offline; }
            catch (ApiException e) { Message = UxText.For(e); return Stage = PurchaseStage.Error; }
        }

        /// <summary>Birth year and month (asked only in <see cref="PurchaseStage.NeedsBirthMonth"/>). Under 18 → the guardian step.</summary>
        public async Task<PurchaseStage> SubmitBirthMonthAsync(int year, int month, CancellationToken ct = default)
        {
            if (Stage != PurchaseStage.NeedsBirthMonth) return Stage;
            int nowYear = DateTimeOffset.FromUnixTimeMilliseconds(_now() + 9L * 3600 * 1000).UtcDateTime.Year;
            if (month < 1 || month > 12 || year < 1900 || year > nowYear) { Message = "生年月を正しく入力してください"; return Stage; }
            _year = year; _month = month;
            try
            {
                var a = await B.Api.SetAgeAsync(year, month, false, ct);
                if (a.Age < 18) { Message = UxText.Errors["GUARDIAN_CONSENT_REQUIRED"]; return Stage = PurchaseStage.NeedsGuardian; }
            }
            catch (ApiException e) { Message = UxText.For(e); return Stage = e is NetworkException ? PurchaseStage.Offline : PurchaseStage.Error; }
            return await CheckAsync(ct);
        }

        /// <summary>保護者の同意 (shown only in <see cref="PurchaseStage.NeedsGuardian"/>).</summary>
        public async Task<PurchaseStage> SubmitGuardianConsentAsync(bool consent, CancellationToken ct = default)
        {
            if (Stage != PurchaseStage.NeedsGuardian) return Stage;
            if (!consent) { Message = UxText.Errors["GUARDIAN_CONSENT_REQUIRED"]; return Stage; }
            if (_year == 0) { Message = "生年月を入力してください"; return Stage = PurchaseStage.NeedsBirthMonth; }
            try { await B.Api.SetAgeAsync(_year, _month, true, ct); }
            catch (ApiException e) { Message = UxText.For(e); return Stage = e is NetworkException ? PurchaseStage.Offline : PurchaseStage.Error; }
            return await CheckAsync(ct);
        }

        /// <summary>The buy button: the screen opens the store sheet now (only from <see cref="PurchaseStage.Ready"/>).</summary>
        public bool BeginStore()
        {
            if (Stage != PurchaseStage.Ready || DeletionGuard.Pending(B)) return false;
            Stage = PurchaseStage.InStore;
            return true;
        }

        /// <summary>
        /// The store's answer. Purchased: the receipt is stored, then sent (re-sent on <see cref="ResumePendingAsync"/> after a
        /// crash). Cancelled → back to the sheet. Failed → "購入は完了していません" + retry. Deferred → "確認中…".
        /// </summary>
        public async Task<PurchaseStage> StoreFinishedAsync(StoreOutcome outcome, StorePlatform platform = StorePlatform.Fake, string receipt = null, CancellationToken ct = default)
        {
            if (Stage != PurchaseStage.InStore && Stage != PurchaseStage.StoreFailed) return Stage;
            switch (outcome)
            {
                case StoreOutcome.Cancelled: Track("cancel"); Message = null; return Stage = PurchaseStage.Ready;
                case StoreOutcome.Failed: Track("fail"); Message = UxText.NotPurchased; return Stage = PurchaseStage.StoreFailed;
                case StoreOutcome.Deferred: Message = UxText.PurchasePending; return Stage = PurchaseStage.Pending;
            }
            Track("store_success");
            Kv.Set(KeyPendingReceipt, ((int)platform).ToString(CultureInfo.InvariantCulture) + "|" + ProductId + "|" + receipt);
            return await GrantAsync(platform, ProductId, receipt, ct);
        }

        /// <summary>A receipt kept from an earlier session (crash before the grant): send it again (the server answers Duplicate when done).</summary>
        public async Task<PurchaseStage> ResumePendingAsync(CancellationToken ct = default)
        {
            var parts = (Kv.Get(KeyPendingReceipt) ?? "").Split(new[] { '|' }, 3);
            if (parts.Length != 3 || !ServerAvailable) return Stage;
            ProductId = parts[1];
            return await GrantAsync((StorePlatform)int.Parse(parts[0], CultureInfo.InvariantCulture), parts[1], parts[2], ct);
        }

        public bool HasPendingReceipt => !string.IsNullOrEmpty(Kv.Get(KeyPendingReceipt));

        private async Task<PurchaseStage> GrantAsync(StorePlatform platform, string productId, string receipt, CancellationToken ct)
        {
            Stage = PurchaseStage.Granting;
            try
            {
                Granted = await B.Api.PurchaseAsync(platform, productId, receipt, ct);
                Kv.Set(KeyPendingReceipt, "");
                await B.RefreshAsync(ct);
                Message = "購入が完了しました";
                return Stage = PurchaseStage.Completed;
            }
            catch (ApiException e) when (GameBackend.IsTransient(e))
            {
                Message = UxText.PurchasePending; // the receipt is kept: sent again on the next launch / retry
                return Stage = PurchaseStage.Pending;
            }
            catch (ApiException e)
            {
                Kv.Set(KeyPendingReceipt, "");
                Message = UxText.For(e);
                return Stage = PurchaseStage.Error;
            }
        }

        private void Track(string stage)
        {
            if (_track == null || string.IsNullOrEmpty(ProductId)) return;
            try { _track(AnalyticsEvent.PurchaseFlow(_now(), stage, ProductId)); } catch (ArgumentException) { /* odd product id: skip the event */ }
        }
    }
}
