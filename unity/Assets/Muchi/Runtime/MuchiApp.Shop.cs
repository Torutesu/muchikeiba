using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using Muchi.Game;
using Muchi.Unity;
using UnityEngine;
using UnityEngine.UI;

namespace Muchi.Client
{
    // U1 money screens (docs/quality/unity-shop.md), on the screen kit and the game-layer models:
    //   shop (ShopModel: tabs, wallet, coin packs from the server list, おすすめ cards, the daily pack's claim)
    //   coin-shortfall sheet (CoinShortfallModel), purchase confirmation with the age gate (PurchaseConfirmModel),
    //   receipt with one next step (PurchaseReceiptModel), scout ways + confirmation + odds (GachaBackend, ScoutConfirmModel,
    //   ItemsBackend for tickets), season pass (SeasonPassModel + ShopModel pass products, the try-on on the player's silks
    //   from SilksEditorModel, the standout claim moment).
    // Every rectangle comes from Muchi.Game.ShopLayout (the layout audit in GameChecks checks those boxes). Texts are the
    // models' / server's; the screens add only button labels. Japanese is shown through Loc's English table in English.
    public sealed partial class MuchiApp
    {
        // ---- state of the money screens (each screen is a method group so currentScreen can be compared after a load)
        ShopModel shopModel;
        bool shopLoading;
        string shopTab = "recommended", shopNote;
        AllowanceModel shopAllowance;
        SeasonPassModel passModel;
        SilksEditorModel passSilks;
        bool passLoading;
        string passPick;
        int passPageStart;
        GachaBackend shopGacha;
        ItemsBackend shopItems;
        ScoutOptions scoutOptions;
        string scoutBannerId, scoutMessage;
        bool scoutLoading, scoutWantSr;
        ScoutConfirmModel scoutConfirm;
        string oddsKicker, oddsTitle, oddsNotice;
        List<(string rarity, string rate)> oddsRows;
        Action oddsBack;
        CoinShortfallModel shortfall;
        Action shortfallRetry, shortfallBack;
        PurchaseConfirmModel purchase;
        string purchaseProductId;
        Action purchaseBack, purchaseAfter;
        bool purchaseBusy, ageGuardian;
        int ageYear, ageMonth;
        PurchaseReceiptModel receipt;
        Action receiptBack;
        string lockedTitle, lockedPrice, lockedKind;
        Action lockedBack;

        // ---------------------------------------------------------------- kit at a layout box

        /// <summary>Japanese source text in the player's language (Loc's English table; Japanese unchanged).</summary>
        static string ShopT(string ja) => ja == null ? null : LocaleService.IsJapanese ? ja : (Loc.English.Translate(ja) ?? ja);
        Text ShopText(LayoutBox b, string value, Color? color = null, TextAnchor align = TextAnchor.UpperLeft)
        {
            var t = Body(ShopT(value) ?? "", b.X, b.Y, b.W, b.H, b.Size, color);
            t.alignment = align;
            return t;
        }
        Text ShopKicker(LayoutBox b, string value) => Kicker(ShopT(value), b.X, b.Y, b.W);
        RectTransform ShopCard(LayoutBox b) => Card("Shop / " + b.Name, b.X, b.Y, b.W, b.H);
        Button ShopCta(LayoutBox b, string label, Action action, bool enabled = true) { var x = Cta(ShopT(label), b.X, b.Y, b.W, action); if (!enabled) ShopDisable(x); return x; }
        Button ShopGhost(LayoutBox b, string label, Action action, bool enabled = true) { var x = Ghost(ShopT(label), b.X, b.Y, b.W, action); if (!enabled) ShopDisable(x); return x; }
        static void ShopDisable(Button b)
        {
            b.interactable = false;
            foreach (var g in b.GetComponentsInChildren<Graphic>()) { var c = g.color; c.a *= .45f; g.color = c; }
        }
        void ShopFrame(ScreenLayout l, string kicker, string title, string sub, Action back)
        {
            ShopKicker(l["head kicker"], kicker);
            ShopText(l["head title"], title, Color.white).fontStyle = FontStyle.Bold;
            ShopText(l["head sub"], sub, KitMuted);
            ShopGhost(l["back"], "戻る", back);
        }
        static string Yen(int yen) => "¥" + yen.ToString("N0", CultureInfo.InvariantCulture);
        void InvalidateMoney() { shopModel = null; passModel = null; scoutOptions = null; }

        // ---------------------------------------------------------------- shop

        /// <summary>Opens the shop on a tab ("recommended" | "coins" | "cosmetics" | "pass"); the pass tab is the pass screen.</summary>
        void ShopStore(string tab)
        {
            shopTab = ShopModel.Tabs.Contains(tab) ? tab : "recommended";
            shopModel = null; shopNote = null;
            if (shopTab == "pass") { ShopSeasonPass(); return; }
            ShopStoreScreen();
        }

        void EnsureShopModel(Action screen)
        {
            if (shopModel != null || shopLoading) return;
            shopModel = new ShopModel(backend, MuchiServices.Track, () => MuchiServices.NowMs);
            shopLoading = true;
            LoadScreenModel(async () => { try { await shopModel.LoadAsync(); } finally { shopLoading = false; } }, screen);
        }

        void ShopStoreScreen()
        {
            currentScreen = ShopStoreScreen; Clear(); SetArt("Art/home-paddock");
            EnsureShopModel(ShopStoreScreen);
            var m = shopModel;
            bool ready = m.Products != null;
            var packs = ready && shopTab == "coins" ? m.CoinPacks.Take(ShopLayout.MaxCoinPacks).ToList() : new List<Muchi.Game.ProductCard>();
            var cards = ready && shopTab == "recommended" ? m.Cards("recommended").Take(ShopLayout.MaxRecommended).ToList() : new List<Muchi.Game.ProductCard>();
            var l = ShopLayout.Shop(shopTab == "cosmetics" ? "looks" : shopTab, shopTab == "coins" ? packs.Count : cards.Count);
            ShopFrame(l, "ショップ", ShopT("ムチ一閃ショップ") + "　/　" + ShopT(ShopModel.TabTitles[shopTab]), "中身は数量で表示します　·　有償コインと無償コインは分けて表示します", Home);
            ShopCard(l["panel"]);
            for (int i = 0; i < ShopModel.Tabs.Length; i++)
            {
                string id = ShopModel.Tabs[i];
                if (id == shopTab) ShopText(l["tab " + i], ShopModel.TabTitles[id], cyan, TextAnchor.MiddleCenter).fontStyle = FontStyle.Bold;
                else ShopGhost(l["tab " + i], ShopModel.TabTitles[id], () => ShopStore(id));
            }
            ShopText(l["wallet"], ShopT(m.PaidLine) + "　·　" + ShopT(m.FreeLine), gold, TextAnchor.UpperRight);
            string note = m.DeletionBanner ?? m.DebtLine;
            if (note != null) ShopText(l["note"], note, new Color(1f, .76f, .7f));
            else if (m.FirstPurchaseNote != null && shopTab != "cosmetics") ShopText(l["note"], ShopT("はじめての購入") + "　" + ShopT(m.FirstPurchaseNote), cyan);

            if (!ready) ShopText(l["message"], shopLoading ? "読み込み中…" : m.Message ?? UxText.Offline, KitSoft);
            else if (shopTab == "coins") for (int i = 0; i < packs.Count; i++) ShopPack(l, i, packs[i]);
            else if (shopTab == "recommended") for (int i = 0; i < cards.Count; i++) ShopRecommended(l, i, cards[i]);
            if (shopTab == "cosmetics")
            {
                ShopCard(l["looks"]);
                ShopText(l["looks line"], "見た目は試着してから買えます（確率なしの直販）", Color.white);
                ShopGhost(l["looks silks"], "勝負服と馬の見た目", Wardrobe);
                ShopGhost(l["looks course"], "コースの見た目", CourseThemes);
                ShopText(l["looks note"], "見た目のみ。ランク戦の能力には影響しません", KitMuted);
            }
            if (ready && (shopNote ?? m.Message) != null) ShopText(l["message"], shopNote ?? m.Message, KitSoft);
            var legal = m.LegalLinks.Select(x => x.Title).Where(x => !string.IsNullOrEmpty(x)).ToList();
            if (m.PaidFirstNote != null) legal.Add(m.PaidFirstNote);
            if (legal.Count > 0) ShopText(l["legal"], string.Join("　·　", legal.Select(ShopT)), KitMuted);
            ShopText(l["checkout"], "決済の前に商品と年齢区分を確認します", KitMuted);
        }

        void ShopPack(ScreenLayout l, int i, Muchi.Game.ProductCard p)
        {
            string k = "pack " + i;
            ShopCard(l[k]);
            ShopText(l[k + " price"], p.PriceText, gold).fontStyle = FontStyle.Bold;
            ShopText(l[k + " coins"], p.Lines.FirstOrDefault() ?? p.Name, Color.white).fontStyle = FontStyle.Bold;
            ShopText(l[k + " bonus"], p.BonusLabel ?? "はじめての購入ボーナスは受け取り済み", p.BonusLabel != null ? cyan : KitMuted);
            ShopGhost(l[k + " buy"], "購入を確認", () => ShopPurchaseConfirm(p.Id, ShopStoreScreen), p.Purchasable);
        }

        void ShopRecommended(ScreenLayout l, int i, Muchi.Game.ProductCard c)
        {
            string k = "card " + i;
            ShopCard(l[k]);
            ShopText(l[k + " name"], c.Name, Color.white).fontStyle = FontStyle.Bold;
            ShopText(l[k + " price"], c.PriceText, gold, TextAnchor.UpperRight).fontStyle = FontStyle.Bold;
            ShopText(l[k + " lines"], string.Join("　·　", c.Lines.Select(ShopT)), Color.white);
            var tags = new List<string>();
            if (c.BonusLabel != null) tags.Add(c.BonusLabel);
            if (c.OneTimeText != null) tags.Add(c.OneTimeText);
            if (c.PeriodText != null) tags.Add(c.PeriodText);
            if (c.DisabledReason != null) tags.Add(c.DisabledReason);
            ShopText(l[k + " tags"], string.Join("　·　", tags.Select(ShopT)), c.DisabledReason != null ? KitMuted : cyan);
            if (c.Kind == "season_pass") ShopGhost(l[k + " buy"], "パスを見る", ShopSeasonPass);
            else if (c.Kind == "allowance" && shopModel.AllowanceClaimable) ShopGhost(l[k + " buy"], "今日の分を受け取る", () => ShopClaimAllowance(ShopStoreScreen));
            else ShopGhost(l[k + " buy"], c.Owned ? "購入済み" : "購入を確認", () => ShopPurchaseConfirm(c.Id, ShopStoreScreen), c.Purchasable);
        }

        /// <summary>Today's 厩舎手当 coins (once per game day; the claim key is kept by AllowanceModel until the server answers).</summary>
        async void ShopClaimAllowance(Action back)
        {
            shopAllowance ??= new AllowanceModel(backend, () => MuchiServices.NowMs);
            try
            {
                await shopAllowance.LoadAsync();
                var r = await shopAllowance.ClaimAsync();
                shopNote = r.Message;
            }
            catch (Exception e) { shopNote = e.Message; }
            InvalidateMoney();
            if (!inRace) back();
        }

        // ---------------------------------------------------------------- coin shortfall (T6)

        /// <summary>Shows the sheet the model holds (it is never shown in a race, while matching, in the tutorial or after a loss).</summary>
        void ShopShortfall(CoinShortfallModel m, Action retry, Action back)
        {
            shortfall = m; shortfallRetry = retry; shortfallBack = back;
            if (m == null || !m.Visible) { back?.Invoke(); return; }
            ShopShortfallScreen();
        }

        void ShopShortfallScreen()
        {
            var m = shortfall;
            if (m == null || !m.Visible) { (shortfallBack ?? Home)(); return; }
            currentScreen = ShopShortfallScreen; Clear(); SetArt("Art/scout-reveal");
            Panel("Shortfall veil", 0, 0, 1600, 900, new Color(.01f, .035f, .07f, .55f));
            var pack = m.Pack;
            var l = ShopLayout.Shortfall(pack != null);
            ShopCard(l["dialog"]);
            ShopKicker(l["kicker"], m.Shortfall.CoinKind == "paid" ? "有償コイン　/　足りない枚数" : m.Shortfall.CoinKind == "free" ? "無償コイン　/　足りない枚数" : "コイン　/　足りない枚数");
            ShopText(l["headline"], m.Headline, Color.white).fontStyle = FontStyle.Bold;
            if (m.Notes.Count > 0) ShopText(l["notes"], string.Join("\n", m.Notes.Select(ShopT)), KitSoft);
            if (pack != null)
            {
                ShopCard(l["pack"]);
                var art = l["pack art"];
                ArtImage("Art/Cosmetics/stable-plaque", art.X, art.Y, art.W, art.H);
                ShopText(l["pack name"], pack.Name, Color.white).fontStyle = FontStyle.Bold;
                ShopText(l["pack price"], pack.PriceText, gold, TextAnchor.UpperRight).fontStyle = FontStyle.Bold;
                ShopText(l["pack contents"], string.Join("　·　", pack.Lines.Select(ShopT)), Color.white);
                if (pack.BonusLabel != null) ShopText(l["pack bonus"], pack.BonusLabel, cyan);
                ShopText(l["pack line"], m.Line, KitSoft);
                ShopGhost(l["pack choose"], CoinShortfallModel.ChooseLabel, () =>
                {
                    var id = m.Choose();
                    if (id == null) return;
                    ShopPurchaseConfirm(id, ShopShortfallScreen, () => { m.AfterPurchase(PurchaseStage.Completed); (shortfallRetry ?? shortfallBack ?? Home)(); });
                }, pack.Purchasable);
            }
            else { ShopCard(l["none"]); ShopText(l["none line"], m.Line, Color.white); }
            ShopText(l["footer"], "購入するとこの画面の前の操作に戻ります　·　有償コインから先に使われます", KitMuted);
            ShopCta(l["close"], CoinShortfallModel.CloseLabel, () => { m.Close(); (shortfallBack ?? Home)(); });
            m.Shown();
        }

        // ---------------------------------------------------------------- purchase confirmation and the age gate

        /// <summary>
        /// The purchase confirmation of a server product (purchase-intent first; the birth month only when the server asks, the
        /// guardian consent only under 18). <paramref name="after"/> runs instead of the receipt (the shortfall sheet's pull).
        /// </summary>
        void ShopPurchaseConfirm(string productId, Action back, Action after = null)
        {
            purchase = new PurchaseConfirmModel(backend, MuchiServices.Track, () => MuchiServices.NowMs);
            purchaseProductId = productId; purchaseBack = back; purchaseAfter = after;
            ageYear = 0; ageMonth = 0; ageGuardian = false;
            ShopPurchaseRun(() => purchase.OpenAsync(productId));
        }

        async void ShopPurchaseRun(Func<Task<PurchaseStage>> step)
        {
            purchaseBusy = true;
            if (!inRace) ShopPurchaseScreen();
            var model = purchase;
            PurchaseStage stage;
            try { stage = await step(); }
            catch (Exception e) { Debug.LogWarning("purchase: " + e.Message); stage = PurchaseStage.Error; }
            purchaseBusy = false;
            if (model != purchase || inRace) return;
            if (stage == PurchaseStage.Completed)
            {
                InvalidateMoney();
                if (purchaseAfter != null) { var a = purchaseAfter; purchaseAfter = null; a(); return; }
                if (model.Granted?.Receipt != null) { ShopReceipt(new PurchaseReceiptModel(model.Granted.Receipt, MuchiServices.Track, () => MuchiServices.NowMs), purchaseBack); return; }
                shopNote = model.Message;
                (purchaseBack ?? Home)();
                return;
            }
            if (currentScreen == (Action)ShopPurchaseScreen) ShopPurchaseScreen();
        }

        void ShopPurchaseScreen()
        {
            var m = purchase;
            if (m == null) { Home(); return; }
            currentScreen = ShopPurchaseScreen; Clear(); SetArt("Art/home-paddock");
            Panel("Purchase veil", 0, 0, 1600, 900, new Color(.01f, .035f, .07f, .58f));
            var stage = purchaseBusy ? PurchaseStage.Checking : m.Stage;
            var l = ShopLayout.PurchaseConfirm(stage);
            ShopCard(l["dialog"]);
            ShopKicker(l["kicker"], "購入の確認");
            ShopText(l["sub"], "決済の前に、商品と条件を確認します。", KitMuted);
            var p = m.Intent?.Product;
            var card = p == null ? shopModel?.Products?.Products.FirstOrDefault(x => x.Id == purchaseProductId) : null;
            string name = p?.Name ?? card?.Name ?? purchaseProductId;
            int yen = p?.PriceYen ?? card?.PriceYen ?? 0;
            ShopText(l["name"], name, Color.white).fontStyle = FontStyle.Bold;
            if (yen > 0) ShopText(l["price"], Yen(yen) + ShopT("（税込）"), gold, TextAnchor.UpperRight).fontStyle = FontStyle.Bold;
            ShopText(l["lines"], string.Join("\n", m.Lines.Skip(1).Select(ShopT)), Color.white);
            var rule = l["rule"]; Panel("Purchase rule", rule.X, rule.Y, rule.W, rule.H, new Color(.35f, .55f, .66f, .6f));
            ShopKicker(l["state"], StageKicker(stage));
            ShopText(l["message"], m.Message ?? (stage == PurchaseStage.NeedsBirthMonth ? "生まれた年と月を選んでください" : null), Color.white);
            bool dev = backend.Settings.UsesDevAuth;
            switch (stage)
            {
                case PurchaseStage.NeedsBirthMonth:
                case PurchaseStage.NeedsGuardian:
                    ShopAgeForm(l, stage);
                    break;
                case PurchaseStage.Ready:
                    ShopText(l["lock"], dev ? "開発用の確認です。ストアの決済は行いません。" : "このビルドではストアの決済はまだつながっていません。購入は完了しません。", KitMuted);
                    break;
                default:
                    if (stage == PurchaseStage.StoreFailed || stage == PurchaseStage.Pending) ShopText(l["lock"], "購入の記録は「その他」→「購入履歴」でいつでも確かめられます", KitMuted);
                    break;
            }
            ShopGhost(l["close"], "閉じる", () => { purchase = null; (purchaseBack ?? Home)(); });
            var go = l["go"];
            switch (stage)
            {
                case PurchaseStage.NeedsBirthMonth:
                    ShopCta(go, "登録して確認する", () => { int y = ageYear, mo = ageMonth; ShopPurchaseRun(() => m.SubmitBirthMonthAsync(y, mo)); }, ageYear > 0 && ageMonth > 0);
                    break;
                case PurchaseStage.NeedsGuardian:
                    ShopCta(go, "同意して確認する", () => ShopPurchaseRun(() => m.SubmitGuardianConsentAsync(true)), ageGuardian);
                    break;
                case PurchaseStage.Ready:
                    // no store SDK is wired in this build: only the local development server takes the fake store's receipt
                    ShopCta(go, dev ? "購入する（開発用・決済なし）" : "購入する", () =>
                    {
                        if (!m.BeginStore()) return;
                        ShopPurchaseRun(() => m.StoreFinishedAsync(StoreOutcome.Purchased, StorePlatform.Fake, "dev-" + Guid.NewGuid().ToString("N")));
                    }, dev);
                    break;
                case PurchaseStage.Checking:
                case PurchaseStage.Granting:
                case PurchaseStage.Pending:
                case PurchaseStage.InStore:
                    ShopCta(go, "確認中…", () => { }, false);
                    break;
                default:
                    ShopCta(go, "もう一度確かめる", () => ShopPurchaseRun(() => m.OpenAsync(purchaseProductId)));
                    break;
            }
        }

        static string StageKicker(PurchaseStage s)
        {
            switch (s)
            {
                case PurchaseStage.Ready: return "年齢確認済み";
                case PurchaseStage.NeedsBirthMonth: return "年齢区分　/　初回の購入時に1回だけ";
                case PurchaseStage.NeedsGuardian: return "保護者の同意";
                case PurchaseStage.Offline: return "オフライン";
                case PurchaseStage.Blocked:
                case PurchaseStage.Error: return "購入できません";
                case PurchaseStage.StoreFailed: return "購入は完了していません";
                default: return "確認中";
            }
        }

        /// <summary>Birth year and month by steppers (no value is chosen for the player), and the guardian's consent under 18.</summary>
        void ShopAgeForm(ScreenLayout l, PurchaseStage stage)
        {
            int nowYear = DateTimeOffset.FromUnixTimeMilliseconds(MuchiServices.NowMs + 9L * 3600 * 1000).UtcDateTime.Year;
            ShopText(l["year"], ageYear == 0 ? "----年" : ageYear.ToString(CultureInfo.InvariantCulture) + "年", Color.white).fontStyle = FontStyle.Bold;
            ShopText(l["month"], ageMonth == 0 ? "--月" : ageMonth.ToString(CultureInfo.InvariantCulture) + "月", Color.white).fontStyle = FontStyle.Bold;
            void Year(int d) { ageYear = ageYear == 0 ? nowYear - 16 : Mathf.Clamp(ageYear + d, 1900, nowYear); ShopPurchaseScreen(); }
            void Month(int d) { ageMonth = ageMonth == 0 ? 1 : (ageMonth - 1 + d + 12) % 12 + 1; ShopPurchaseScreen(); }
            Ghost("◀", l["year down"].X, l["year down"].Y, l["year down"].W, () => Year(-1));
            Ghost("▶", l["year up"].X, l["year up"].Y, l["year up"].W, () => Year(1));
            Ghost("◀", l["month down"].X, l["month down"].Y, l["month down"].W, () => Month(-1));
            Ghost("▶", l["month up"].X, l["month up"].Y, l["month up"].W, () => Month(1));
            if (stage != PurchaseStage.NeedsGuardian) return;
            ShopGhost(l["guardian"], (ageGuardian ? "☑　" : "☐　") + ShopT("保護者の同意を得ました"), () => { ageGuardian = !ageGuardian; ShopPurchaseScreen(); });
            ShopText(l["guardian note"], "18歳未満の方は、保護者の同意が必要です。", KitMuted);
        }

        /// <summary>A cosmetic shown with a proposed price and no server product yet: said plainly, nothing can be bought.</summary>
        void ShopLockedReview(string title, string price, string kind)
        {
            if (currentScreen != (Action)ShopLockedScreen) lockedBack = currentScreen;
            lockedTitle = title; lockedPrice = price; lockedKind = kind;
            ShopLockedScreen();
        }

        void ShopLockedScreen()
        {
            currentScreen = ShopLockedScreen; Clear(); SetArt("Art/home-paddock");
            Panel("Purchase veil", 0, 0, 1600, 900, new Color(.01f, .035f, .07f, .58f));
            var l = ShopLayout.LockedReview();
            ShopCard(l["dialog"]);
            ShopKicker(l["kicker"], "購入の確認");
            Body(LocaleService.Text(lockedTitle), l["name"].X, l["name"].Y, l["name"].W, l["name"].H, l["name"].Size, Color.white).fontStyle = FontStyle.Bold;
            Body(LocaleService.Text(lockedKind) + "  ·  " + LocaleService.Text(lockedPrice), l["price"].X, l["price"].Y, l["price"].W, l["price"].H, l["price"].Size, gold);
            ShopText(l["lock"], "この見た目はまだストアに並んでいません。表示の価格は案です。購入はできません。", KitSoft);
            ShopGhost(l["close"], "閉じる", () => (lockedBack ?? Home)());
        }

        // ---------------------------------------------------------------- receipt

        void ShopReceipt(PurchaseReceiptModel m, Action back) { receipt = m; receiptBack = back; ShopReceiptScreen(); }

        void ShopReceiptScreen()
        {
            var m = receipt;
            if (m == null) { Home(); return; }
            currentScreen = ShopReceiptScreen; Clear(); SetArt("Art/home-paddock");
            Panel("Receipt veil", 0, 0, 1600, 900, new Color(.01f, .035f, .07f, .58f));
            var rows = m.Rows.Take(ShopLayout.MaxReceiptLines).ToList();
            var l = ShopLayout.Receipt(rows.Count, m.NextLabel != null);
            ShopCard(l["dialog"]);
            ShopKicker(l["kicker"], m.Kicker);
            ShopText(l["name"], m.Receipt.Name, Color.white).fontStyle = FontStyle.Bold;
            ShopText(l["price"], m.PriceLine, gold, TextAnchor.UpperRight).fontStyle = FontStyle.Bold;
            for (int i = 0; i < rows.Count; i++)
            {
                ShopText(l["row " + i + " mark"], "✓", cyan).fontStyle = FontStyle.Bold;
                ShopText(l["row " + i], rows[i].label, rows[i].coins ? gold : Color.white).fontStyle = FontStyle.Bold;
                if (rows[i].sub != null) ShopText(l["row " + i + " sub"], rows[i].sub, KitMuted);
            }
            ShopText(l["wallet"], m.WalletLine, Color.white);
            if (m.Receipt.Notes.Count > 0) ShopText(l["notes"], string.Join("\n", m.Receipt.Notes.Select(ShopT)), KitMuted);
            ShopGhost(l["close"], "閉じる", () => (receiptBack ?? (() => ShopStore("recommended")))());
            if (m.NextLabel != null) ShopCta(l["next"], m.NextLabel, () => ShopReceiptNext(m.TakeNext()));
            m.Shown();
        }

        /// <summary>The receipt's one next step: the screen that uses what was just bought.</summary>
        void ShopReceiptNext(PurchaseReceiptModel.Target t)
        {
            switch (t)
            {
                case PurchaseReceiptModel.Target.ScoutSrTicket: scoutWantSr = true; ShopScoutWays(); break;
                case PurchaseReceiptModel.Target.Scout: ShopScoutWays(); break;
                case PurchaseReceiptModel.Target.SeasonPass: ShopSeasonPass(); break;
                case PurchaseReceiptModel.Target.AllowanceClaim: ShopClaimAllowance(() => ShopStore("recommended")); break;
                case PurchaseReceiptModel.Target.SilksEditor: Wardrobe(); break;
                default: (receiptBack ?? Home)(); break;
            }
        }

        // ---------------------------------------------------------------- scout: ways, confirmation, odds

        /// <summary>The ways to pull on the open banner, tickets included (they are offered where they are used).</summary>
        void ShopScoutWays() { scoutOptions = null; scoutMessage = null; ShopWaysScreen(); }

        void ShopWaysScreen()
        {
            currentScreen = ShopWaysScreen; Clear(); SetArt("Art/scout-reveal");
            if (scoutOptions == null && !scoutLoading)
            {
                scoutLoading = true;
                LoadScreenModel(async () =>
                {
                    try
                    {
                        shopGacha ??= new GachaBackend(backend, () => MuchiServices.NowMs);
                        var list = await shopGacha.BannersAsync();
                        var row = list.Rows.FirstOrDefault(r => !r.Upcoming);
                        scoutBannerId = row?.Banner.Id;
                        var (o, msg) = await shopGacha.ScoutOptionsAsync(scoutBannerId);
                        scoutOptions = o; scoutMessage = msg;
                    }
                    finally { scoutLoading = false; }
                    if (scoutWantSr && scoutOptions != null) { scoutWantSr = false; var sr = ScoutConfirmModel.ForSrTicket(scoutOptions, MuchiServices.Track, () => MuchiServices.NowMs); if (sr != null) { scoutConfirm = sr; currentScreen = ShopScoutConfirmScreen; ShopScoutConfirmScreen(); } }
                }, ShopWaysScreen);
            }
            var o = scoutOptions;
            var ways = o?.Ways.Take(ShopLayout.MaxWays - (o.SrPlusOwned > 0 ? 1 : 0)).ToList() ?? new List<ScoutWay>();
            int n = ways.Count + (o != null && o.SrPlusOwned > 0 ? 1 : 0);
            var l = ShopLayout.ScoutWays(n);
            ShopCard(l["panel"]);
            ShopKicker(l["kicker"], o?.Name ?? "スカウト");
            ShopText(l["title"], "スカウト", Color.white).fontStyle = FontStyle.Bold;
            if (o != null) ShopText(l["wallet"], "◈ 有償 " + o.WalletPaid.ToString("N0", CultureInfo.InvariantCulture) + "　·　◎ 無償 " + o.WalletFree.ToString("N0", CultureInfo.InvariantCulture), gold);
            for (int i = 0; i < ways.Count; i++)
            {
                var w = ways[i];
                ShopGhost(l["way " + i], w.Label, () => ShopRoute(w));
            }
            if (o != null && o.SrPlusOwned > 0)
                ShopGhost(l["way " + ways.Count], o.SrPlusName + "を使う", () => { scoutConfirm = ScoutConfirmModel.ForSrTicket(o, MuchiServices.Track, () => MuchiServices.NowMs); if (scoutConfirm != null) ShopScoutConfirmScreen(); });
            ShopText(l["message"], scoutLoading ? "読み込み中…" : scoutMessage ?? o?.Notice, KitSoft);
            ShopGhost(l["odds"], "提供割合を見る", () => ShopOdds(scoutBannerId, null, ShopWaysScreen), scoutBannerId != null);
            ShopGhost(l["back"], "戻る", Scout);
        }

        /// <summary>A tap on a way: confirm, the shortfall sheet, or the server's line when it cannot be taken now.</summary>
        void ShopRoute(ScoutWay w)
        {
            switch (ScoutConfirmModel.RouteFor(w))
            {
                case ScoutConfirmModel.Route.Confirm:
                    scoutConfirm = ScoutConfirmModel.For(scoutOptions, w.Id, MuchiServices.Track, () => MuchiServices.NowMs);
                    if (scoutConfirm != null) ShopScoutConfirmScreen();
                    break;
                case ScoutConfirmModel.Route.Shortfall:
                    ShopShortfallPreview(scoutBannerId, w.Count);
                    break;
                default:
                    scoutMessage = w.Line; ShopWaysScreen();
                    break;
            }
        }

        async void ShopShortfallPreview(string bannerId, int count)
        {
            var m = new CoinShortfallModel(backend, MuchiServices.Track, () => MuchiServices.NowMs);
            bool shown;
            try { shown = await m.PreviewAsync(ShortfallOrigin.Gacha(bannerId, count), ShortfallContext.ScoutConfirm); }
            catch (Exception e) { Debug.LogWarning("shortfall: " + e.Message); shown = false; }
            if (inRace) return;
            if (shown) ShopShortfall(m, ShopScoutWays, ShopWaysScreen);
            else { scoutMessage = BannerListModel.ErrorText(Muchi.Client.ApiErrorCode.InsufficientCoins); ShopWaysScreen(); }
        }

        void ShopScoutConfirmScreen()
        {
            var m = scoutConfirm;
            if (m == null) { ShopWaysScreen(); return; }
            currentScreen = ShopScoutConfirmScreen; Clear(); SetArt("Art/scout-reveal");
            Panel("Scout veil", 0, 0, 1600, 900, new Color(.01f, .035f, .07f, .55f));
            var l = ShopLayout.ScoutConfirm(m.Coins);
            ShopCard(l["dialog"]);
            ShopKicker(l["kicker"], m.Kicker);
            ShopText(l["title"], m.Title, Color.white).fontStyle = FontStyle.Bold;
            ShopText(l["spend"], m.SpendLine, gold).fontStyle = FontStyle.Bold;
            if (m.Coins)
            {
                // the split as a bar: paid (◈) then free (◎), in the order the wallet spends them
                var bar = l["bar paid"];
                Panel("Spend bar", bar.X, bar.Y, bar.W, bar.H, new Color(1, 1, 1, .12f));
                if (m.PaidFraction > 0) Panel("Spend paid", bar.X, bar.Y, bar.W * m.PaidFraction, bar.H, gold);
                if (m.FreeFraction > 0) Panel("Spend free", bar.X + bar.W * m.PaidFraction, bar.Y, bar.W * m.FreeFraction, bar.H, cyan);
                ShopText(l["split"], m.SplitLine, Color.white);
                ShopText(l["notice"], m.Notice, KitSoft);
            }
            ShopText(l["after"], m.AfterLine, KitMuted);
            if (m.PityLine != null) ShopText(l["pity"], m.PityLine, cyan);
            ShopGhost(l["odds"], m.OddsLabel, () => ShopOdds(m.SrTicket ? null : scoutBannerId, m.SrTicket ? m.Way.ItemId : null, ShopScoutConfirmScreen));
            ShopGhost(l["close"], "閉じる", () => { m.Cancel(); ShopWaysScreen(); });
            ShopCta(l["pull"], m.PullLabel, () => { if (m.Pull()) ShopPull(m); });
            m.Shown();
        }

        /// <summary>The pull itself (the server decides again): a coin pull, a banner ticket or the SR+ ticket.</summary>
        async void ShopPull(ScoutConfirmModel m)
        {
            string banner = scoutBannerId;
            if (m.Coins)
            {
                shopGacha ??= new GachaBackend(backend, () => MuchiServices.NowMs);
                var (reveal, _, message) = await shopGacha.DrawAsync(banner, m.Way.Count, backend.HorseName);
                if (inRace) return;
                scoutOptions = null;
                if (reveal != null) { ShopRevealMoment(reveal); return; }
                if (shopGacha.LastShortfall != null)
                {
                    var sf = new CoinShortfallModel(backend, MuchiServices.Track, () => MuchiServices.NowMs);
                    if (sf.FromError(shopGacha.LastShortfall, ShortfallContext.ScoutConfirm, ShortfallOrigin.Gacha(banner, m.Way.Count))) { ShopShortfall(sf, ShopScoutWays, ShopScoutWays); return; }
                }
                scoutMessage = message; ShopWaysScreen();
                return;
            }
            shopItems ??= new ItemsBackend(backend);
            var r = await shopItems.UseTicketAsync(m.Way.ItemId, m.SrTicket ? null : banner);
            if (inRace) return;
            scoutOptions = null;
            if (!r.Ok) { scoutMessage = r.Message; ShopWaysScreen(); return; }
            var got = shopItems.LastTicket?.Result;
            string name = got == null ? r.Message : backend.HorseName(got.HorseId) ?? got.TemplateId;
            Moment(ShopT(got != null ? RarityStyle.Of(got.Rarity).SpokenText : "スカウト"), ShopT(name), ShopT(m.SrTicket ? "SR以上の馬が1頭来ました" : "スカウト券で1頭来ました"), "Art/scout-reveal", "OK", ShopScoutWays);
        }

        /// <summary>The scout's result as the shared moment: the best horse, then the summary line (new / duplicates → material).</summary>
        void ShopRevealMoment(GachaRevealModel reveal)
        {
            reveal.SkipAll();
            var best = reveal.RevealOrder.LastOrDefault();
            if (best == null) { ShopScoutWays(); return; }
            // over the confirmation as it is (no reload under the moment: a redraw would clear it); OK opens the refreshed ways
            Moment(ShopT(best.Style.SpokenText), ShopT(best.Name), ShopT(reveal.SummaryLine), "Art/scout-reveal", "OK", ShopScoutWays);
        }

        /// <summary>The rates: a banner's (GET /v1/gacha/:id/odds) or the SR+ ticket's own table.</summary>
        async void ShopOdds(string bannerId, string ticketItemId, Action back)
        {
            oddsBack = back; oddsRows = null; oddsKicker = "提供割合"; oddsTitle = null; oddsNotice = null;
            ShopOddsScreen();
            try
            {
                Dictionary<string, RarityTotal> totals;
                if (ticketItemId != null) { var t = await backend.Api.GetTicketOddsAsync(ticketItemId); oddsTitle = t.Name; oddsNotice = t.Notice; totals = t.RarityTotals; }
                else { var o = await backend.Api.GetOddsAsync(bannerId); oddsTitle = o.Name; totals = o.RarityTotals; if (o.PityPullsRequired > 0) oddsNotice = "交換ptが" + o.PityPullsRequired.ToString(CultureInfo.InvariantCulture) + "たまると、対象の馬と交換できます"; }
                oddsRows = totals.OrderByDescending(kv => GameBackend.RarityRank(kv.Key)).Select(kv => (RarityStyle.Of(kv.Key).Shape + " " + kv.Key, kv.Value.Rate)).ToList();
            }
            catch (Exception e) { oddsNotice = e is ApiException a ? UxText.For(a) : UxText.Offline; oddsRows = new List<(string, string)>(); }
            if (!inRace && currentScreen == (Action)ShopOddsScreen) ShopOddsScreen();
        }

        void ShopOddsScreen()
        {
            currentScreen = ShopOddsScreen; Clear(); SetArt("Art/scout-reveal");
            Panel("Odds veil", 0, 0, 1600, 900, new Color(.01f, .035f, .07f, .55f));
            var rows = oddsRows ?? new List<(string rarity, string rate)>();
            var l = ShopLayout.Odds(rows.Count);
            ShopCard(l["dialog"]);
            ShopKicker(l["kicker"], oddsKicker);
            ShopText(l["title"], oddsTitle ?? (oddsRows == null ? "読み込み中…" : ""), Color.white).fontStyle = FontStyle.Bold;
            for (int i = 0; i < Math.Min(rows.Count, ShopLayout.MaxOddsRows); i++)
            {
                bool top = rows[i].rarity.EndsWith("SSR", StringComparison.Ordinal);
                ShopText(l["rarity " + i], rows[i].rarity, top ? gold : cyan).fontStyle = FontStyle.Bold;
                ShopText(l["rate " + i], rows[i].rate, Color.white);
            }
            if (oddsNotice != null) ShopText(l["notice"], oddsNotice, KitSoft);
            ShopCta(l["close"], "閉じる", () => (oddsBack ?? ShopWaysScreen)());
        }

        // ---------------------------------------------------------------- season pass

        void ShopSeasonPass() { passModel = null; shopNote = null; passPageStart = 0; ShopPassScreen(); }

        void EnsurePassModels()
        {
            EnsureShopModel(ShopPassScreen);
            if (passModel != null || passLoading) return;
            passModel = new SeasonPassModel(backend, () => MuchiServices.NowMs);
            passSilks ??= new SilksEditorModel(backend);
            passLoading = true;
            var silks = passSilks;
            LoadScreenModel(async () =>
            {
                try { await passModel.LoadAsync(); if (silks.View == null) await silks.LoadAsync(); }
                finally { passLoading = false; }
            }, ShopPassScreen);
        }

        void ShopPassScreen()
        {
            currentScreen = ShopPassScreen; Clear(); SetArt("Art/home-paddock");
            EnsurePassModels();
            var pm = passModel;
            var v = pm.View;
            var standouts = pm.Standouts;
            int max = v?.MaxLevel ?? 30;
            var l = ShopLayout.SeasonPass(standouts.Count, max);
            ShopFrame(l, "シーズンパス", v != null ? ShopT("シーズン") + " " + v.SeasonId : "シーズンパス",
                shopNote ?? (v != null ? ShopT(pm.PeriodLine) + "　·　" + ShopT("レースでXPを獲得") : passLoading ? "読み込み中…" : pm.Message ?? UxText.Offline), Home);
            ShopCard(l["preview"]);
            if (v == null) return;

            // ---- left: a standout painted on the player's own silks (try-on: nothing is saved)
            var next = v.NextStandout == null ? null : standouts.FirstOrDefault(x => x.Track == v.NextStandout.Track && x.Level == v.NextStandout.Level);
            PassStandout pick = passPick == "set" ? null : standouts.FirstOrDefault(x => Key(x) == passPick) ?? next ?? standouts.FirstOrDefault(x => x.Claimable) ?? standouts.LastOrDefault();
            bool set = pick == null && standouts.Count > 0;
            ShopKicker(l["preview kicker"], set ? "有料ラインのセット" : "特別な段");
            var mine = passSilks?.View?.Current ?? new SilksDesign();
            var design = set ? pm.PreviewSet(mine) : pm.PreviewDesign(mine, pick);
            ShopSilksPlate(l["silks"], design);
            ShopText(l["silks parts"], ShopT("柄") + " " + PartName("pattern", design.Pattern) + "　·　" + ShopT("袖") + " " + PartName("sleeve", design.Sleeve) + "　·　" + ShopT("帽子") + " " + PartName("cap", design.Cap), KitSoft);
            ShopText(l["try-on note"], "あなたの勝負服で試着中（保存はされません）", KitMuted);
            var chips = standouts.Take(ShopLayout.PassChips - 1).Select(x => (key: Key(x), label: x.Level.ToString(CultureInfo.InvariantCulture))).ToList();
            if (standouts.Count > 0) chips.Add(("set", ShopT("セット")));
            for (int i = 0; i < chips.Count; i++)
            {
                var c = chips[i];
                bool on = set ? c.key == "set" : pick != null && c.key == Key(pick);
                var b = Ghost(c.label, l["chip " + i].X, l["chip " + i].Y, l["chip " + i].W, () => { passPick = c.key; ShopPassScreen(); });
                var t = b.GetComponentInChildren<Text>(); if (t != null && on) t.color = cyan;
            }
            if (set)
            {
                int n = standouts.Count(x => x.Premium);
                ShopText(l["pick where"], "有料ラインの特別な段 " + n.ToString(CultureInfo.InvariantCulture) + "点", gold);
                ShopText(l["pick label"], "どれも見た目だけです", Color.white).fontStyle = FontStyle.Bold;
                ShopText(l["pick state"], "ランク戦の能力は変わりません", KitMuted);
            }
            else if (pick != null)
            {
                ShopText(l["pick where"], "ティア" + pick.Level.ToString(CultureInfo.InvariantCulture) + (pick.Premium ? "・有料ライン" : "・無料ライン"), pick.Premium ? gold : cyan);
                ShopText(l["pick label"], pick.Label, Color.white).fontStyle = FontStyle.Bold;
                ShopText(l["pick state"], pm.StandoutState(pick), pick.Claimable ? cyan : KitSoft);
            }
            ShopGhost(l["try-on"], "勝負服と馬の見た目へ", Wardrobe);

            // ---- level, XP and the road of the season's tiers with the standout marks
            ShopKicker(l["level kicker"], "レベル");
            ShopText(l["level"], v.Level.ToString(CultureInfo.InvariantCulture), gold).fontStyle = FontStyle.Bold;
            ShopText(l["xp"], pm.XpLine, KitMuted);
            var road = l["road"];
            Panel("Pass road", road.X, road.Y, road.W, road.H, new Color(1, 1, 1, .10f));
            float done = Mathf.Clamp01((v.Level + (v.Level < max && v.XpPerLevel > 0 ? (v.Xp % v.XpPerLevel) / (float)v.XpPerLevel : 0f)) / Math.Max(1, max));
            if (done > 0) Panel("Pass road fill", road.X, road.Y, road.W * done, road.H, new Color(0, .8f, .95f, .55f));
            foreach (var x in standouts)
            {
                float mx = ShopLayout.RoadX(x.Level, max);
                Panel("Pass mark " + x.Level, mx - 4, road.Y - 6, 8, road.H + 12, x.Premium ? gold : cyan);
                var t = Body(x.Level.ToString(CultureInfo.InvariantCulture), mx - 20, 210, 40, 24, 16, next != null && Key(next) == Key(x) ? Color.white : KitMuted);
                t.alignment = TextAnchor.UpperCenter;
            }
            ShopText(l["next"], pm.NextStandoutLine ?? (standouts.Count > 0 ? "特別な段はすべて到達しました" : null), gold).fontStyle = FontStyle.Bold;

            // ---- one page of six tiers: the free line on top, the paid line under it
            var rows = pm.Rows;
            if (passPageStart <= 0) passPageStart = ShopLayout.PageStart(Math.Min(v.Level + 1, max));
            int start = passPageStart, last = Math.Min(max, start + ShopLayout.PassPageSize - 1);
            ShopGhost(l["page prev"], "◀", () => { passPageStart = Math.Max(1, start - ShopLayout.PassPageSize); ShopPassScreen(); }, start > 1);
            ShopGhost(l["page next"], "▶", () => { passPageStart = start + ShopLayout.PassPageSize; ShopPassScreen(); }, last < max);
            ShopText(l["page"], ShopT("ティア") + " " + start.ToString(CultureInfo.InvariantCulture) + "–" + last.ToString(CultureInfo.InvariantCulture) + "　·　" + ShopT("上：無料報酬　下：有料報酬"), KitMuted);
            bool claimable = rows.Any(r => r.FreeClaimable || r.PremiumClaimable);
            if (claimable && !pm.Owned) ShopGhost(l["claim all"], "まとめて受け取る", ShopPassClaimAll);
            for (int c = 0; c < ShopLayout.PassPageSize; c++)
            {
                int lv = start + c;
                if (lv > max || lv > rows.Count) break;
                ShopPassCell(l, c, 0, rows[lv - 1]);
                ShopPassCell(l, c, 1, rows[lv - 1]);
            }

            // ---- the totals, the price line, the products (every content visible before buying)
            var products = shopModel?.PassProducts ?? new List<Muchi.Game.ProductCard>();
            var total = shopModel?.PassTotalLine(v);
            if (total != null) ShopText(l["total"], total, cyan);
            if (products.Count > 0) ShopText(l["price line"], string.Join("　·　", products.Select(p => ShopT(p.Name) + " " + p.PriceText)) + "　/　" + ShopT("今シーズン限り・自動更新なし"), gold);
            if (!pm.Owned) ShopCta(l["buy"], "有料ラインを開ける", () => ShopPurchaseConfirm(pm.PurchaseProductId, ShopPassScreen), pm.CanBuy);
            else if (claimable) ShopCta(l["buy"], "まとめて受け取る", ShopPassClaimAll);
            else ShopCta(l["buy"], "購入済み", () => { }, false);
            if (products.Count > 1)
            {
                var plus = products[1];
                ShopGhost(l["plus"], plus.Owned ? "今シーズンは購入済み" : "パス＋にする", () => ShopPurchaseConfirm(plus.Id, ShopPassScreen), plus.Purchasable && !pm.Owned);
            }
            var allowance = shopModel?.PassScreenAllowance;
            if (allowance != null)
            {
                if (shopModel.AllowanceClaimable) ShopGhost(l["allowance"], "今日の分を受け取る", () => ShopClaimAllowance(ShopPassScreen));
                else ShopGhost(l["allowance"], ShopT(allowance.Name) + " " + allowance.PriceText, () => ShopPurchaseConfirm(allowance.Id, ShopPassScreen), allowance.Purchasable);
            }
        }

        static string Key(PassStandout x) => x == null ? null : x.Track + ":" + x.Level.ToString(CultureInfo.InvariantCulture);
        string PartName(string type, string id) => ShopT(passSilks?.View?.Part(type, id)?.Name ?? id);

        /// <summary>One tier cell: tier number, what it pays (a standout names its part), and its one action.</summary>
        void ShopPassCell(ScreenLayout l, int c, int r, PassLevelRow row)
        {
            bool premium = r == 1;
            var standout = premium ? row.PremiumStandout : row.FreeStandout;
            string text = premium ? row.PremiumText : row.FreeText;
            bool claimed = premium ? row.PremiumClaimed : row.FreeClaimed, can = premium ? row.PremiumClaimable : row.FreeClaimable;
            string k = "cell " + c + " " + r;
            var cell = l[k];
            ShopCard(cell);
            if (standout != null) Panel("Standout glow " + k, cell.X, cell.Y + 3, cell.W, cell.H - 3, premium ? new Color(1, .83f, .08f, .10f) : new Color(0, .8f, .95f, .10f));
            ShopText(l[k + " tier"], ShopT("ティア") + " " + row.Level.ToString(CultureInfo.InvariantCulture) + (standout != null ? "　" + ShopT("特別") : ""), standout != null ? (premium ? gold : cyan) : KitMuted);
            string what = standout != null ? standout.Label : text == null ? "—" : string.Join("\n", text.Split('・').Take(2).Select(ShopT));
            var wt = ShopText(l[k + " reward"], what, Color.white);
            wt.verticalOverflow = VerticalWrapMode.Truncate;
            var act = l[k + " act"];
            if (can) ShopGhost(act, "受け取る", () => ShopPassClaim(premium ? PassTrack.Premium : PassTrack.Free, row.Level));
            else if (standout != null && !claimed) ShopGhost(act, "試着", () => { passPick = Key(standout); ShopPassScreen(); });
            else if (claimed) Body(ShopT("受け取り済み"), act.X, act.Y + 20, act.W, 24, 16, KitMuted);
            else if (premium && text != null && !passModel.Owned && !row.Locked) Body(ShopT("パスで受け取れます"), act.X, act.Y + 20, act.W, 24, 16, KitMuted);
            if (row.Locked) Panel("Locked " + k, cell.X, cell.Y, cell.W, cell.H, new Color(0, .02f, .05f, .38f));
        }

        async void ShopPassClaim(PassTrack track, int level)
        {
            var r = await passModel.ClaimAsync(track, level);
            ShopAfterClaim(r);
        }

        async void ShopPassClaimAll()
        {
            var r = await passModel.ClaimAllAsync();
            ShopAfterClaim(r);
        }

        /// <summary>After a claim: the screen again, and the standout's moment once when one came (the highest when several).</summary>
        void ShopAfterClaim(ActionResult r)
        {
            if (inRace || currentScreen != (Action)ShopPassScreen) return;
            shopNote = r.Message;
            // the claim reloaded the pass view already; nothing else is refetched, so no redraw clears the moment below
            ShopPassScreen();
            var mo = passModel?.TakeMoment();
            if (mo == null) return;
            string key = (mo.Look != null && passModel.Standouts.Any(x => x.Level == mo.Level && x.ItemId == mo.ItemId)) ? Key(passModel.Standouts.First(x => x.Level == mo.Level && x.ItemId == mo.ItemId)) : null;
            Moment(ShopT(mo.Kicker), ShopT(mo.Title), ShopT(mo.Sub), "Art/Cosmetics/silk-jacket", ShopT(mo.ActionLabel), () => { if (key != null) passPick = key; ShopPassScreen(); });
        }

        /// <summary>
        /// The silks drawn from the design (cap, body, the pattern's second colour, sleeves) with the editor's colour hexes, so a
        /// standout is seen on the player's own colours. The full painted render lives in the silks editor; this is its plate.
        /// </summary>
        void ShopSilksPlate(LayoutBox b, SilksDesign d)
        {
            Color C(string id)
            {
                var hex = passSilks?.View?.Part("color", id)?.Hex;
                if (hex != null && ColorUtility.TryParseHtmlString(hex.StartsWith("#") ? hex : "#" + hex, out var c)) return c;
                switch (id) { case "white": return Color.white; case "black": return new Color(.08f, .08f, .1f); case "navy": return new Color(.08f, .14f, .36f); case "red": return new Color(.75f, .1f, .14f); case "gold": return gold; case "green": return new Color(.06f, .48f, .37f); default: return new Color(.6f, .64f, .7f); }
            }
            string Col(int i) => d.Colors.Length == 0 ? "white" : d.Colors[Math.Min(i, d.Colors.Length - 1)];
            float cx = b.X + b.W / 2;
            Panel("Silks backdrop", b.X, b.Y, b.W, b.H, new Color(0, .8f, .95f, .06f));
            string capA = d.CapColors.Length > 0 ? d.CapColors[0] : Col(0), capB = d.CapColors.Length > 1 ? d.CapColors[1] : Col(1);
            Panel("Silks cap", cx - 40, b.Y + 8, 80, 34, C(capA));
            if (d.Cap != "plain") Panel("Silks cap band", cx - 8, b.Y + 8, 16, 34, C(capB));
            Panel("Silks brim", cx - 50, b.Y + 40, 100, 8, C(capB));
            Panel("Silks body", cx - 80, b.Y + 58, 160, 140, C(Col(0)));
            if (d.Pattern != "plain")
            {
                if (d.Pattern.Contains("hoop")) { Panel("Silks hoop 1", cx - 80, b.Y + 88, 160, 24, C(Col(1))); Panel("Silks hoop 2", cx - 80, b.Y + 140, 160, 24, C(Col(1))); }
                else { Panel("Silks band", cx - 22, b.Y + 58, 44, 140, C(Col(1))); if (d.Colors.Length > 2) Panel("Silks band 2", cx - 6, b.Y + 58, 12, 140, C(Col(2))); }
            }
            var sleeve = C(d.Sleeve == "match" ? Col(0) : Col(1));
            Panel("Silks sleeve L", cx - 122, b.Y + 64, 40, 110, sleeve);
            Panel("Silks sleeve R", cx + 82, b.Y + 64, 40, 110, sleeve);
            if (d.Sleeve != "match") { Panel("Silks cuff L", cx - 122, b.Y + 158, 40, 16, C(Col(0))); Panel("Silks cuff R", cx + 82, b.Y + 158, 40, 16, C(Col(0))); }
        }
    }
}
