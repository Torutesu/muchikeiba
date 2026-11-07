// Round 12: T6 コイン不足の案内 (CoinShortfallModel, REQ-SHORT-004..009, contracts/protocol.md §29) and the R8 gap re-check:
// a bought once-only pack / running daily pack is never drawn as buyable by ShopModel.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class ShortfallChecks
{
    sealed class FakeServer : IHttp
    {
        public readonly List<HttpRequest> Sent = new List<HttpRequest>();
        public readonly Dictionary<string, Func<HttpRequest, HttpResponse>> Routes = new Dictionary<string, Func<HttpRequest, HttpResponse>>();
        public Task<HttpResponse> SendAsync(HttpRequest r, CancellationToken ct)
        {
            Sent.Add(r);
            if (Routes.TryGetValue(r.Method + " " + r.Path, out var h)) return Task.FromResult(h(r));
            return Task.FromResult(new HttpResponse(404, "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"no route " + r.Method + " " + r.Path + "\"}}"));
        }
        public int Count(string method, string path) => Sent.Count(r => r.Method == method && r.Path == path);
    }
    sealed class Tokens : IAuthTokenProvider { public Task<string> GetTokenAsync(bool f, CancellationToken ct) => Task.FromResult("tok"); }

    static HttpResponse Ok(string body) => new HttpResponse(200, body);
    const long Now = 1795575600000L; // 2026-11-25 12:00 JST
    static string Player(int paid, int free) => "{\"id\":\"me\",\"profile\":{\"displayName\":\"アオバ\"},\"wallet\":{\"paid\":" + paid + ",\"free\":" + free + ",\"total\":" + (paid + free) + ",\"debt\":0},\"deletion\":{\"status\":\"none\",\"requestedAt\":null,\"deleteAt\":null}}";

    const string Short = "{\"short\":true,\"coinKind\":\"paid\",\"need\":1500,\"have\":300,\"shortfall\":1200,\"headline\":\"有償コインが1,200枚足りません\","
        + "\"status\":\"covered\",\"blockedCode\":null,\"ageCheck\":false,\"line\":\"コイン1,660（¥2,400）で足ります\",\"notes\":[\"有償コインだけで支払います（無償コインは使えません）\"],"
        + "\"offer\":{\"offerId\":\"shortfall\",\"touchpoint\":\"T6\",\"productId\":\"coin_2400\",\"name\":\"コイン1,660\",\"priceYen\":2400,\"paidCoins\":1660,\"covers\":true,"
        + "\"contents\":[{\"type\":\"paid_coins\",\"qty\":1660,\"label\":\"有償コイン1,660枚\"}],"
        + "\"firstPurchaseBonus\":{\"coins\":1660,\"currency\":\"free\",\"label\":\"はじめての購入時のみ：無償コイン1,660枚をプレゼント\"},\"oneTime\":false}}";
    const string FreeOnly = "{\"short\":true,\"coinKind\":\"free\",\"need\":300,\"have\":0,\"shortfall\":300,\"headline\":\"無償コインが300枚足りません\",\"status\":\"free_only\",\"blockedCode\":null,\"ageCheck\":false,"
        + "\"line\":\"無償コインだけで支払う項目です（購入したコインでは支払えません）\",\"notes\":[],\"offer\":null}";
    const string NotShort = "{\"short\":false,\"coinKind\":\"any\",\"need\":100,\"have\":500,\"shortfall\":0,\"headline\":null,\"status\":\"not_short\",\"blockedCode\":null,\"ageCheck\":false,\"line\":null,\"notes\":[],\"offer\":null}";
    const string Intent = "{\"product\":{\"id\":\"coin_2400\",\"kind\":\"coins\",\"name\":\"コイン1,660\",\"priceYen\":2400,\"paidCoins\":1660,\"contents\":[{\"type\":\"paid_coins\",\"qty\":1660,\"label\":\"有償コイン1,660枚\"}]},\"monthSpentYen\":0,\"monthlyLimitYen\":null,\"remainingYen\":null,\"firstPurchaseBonus\":null}";
    static string DrawRefused(string shortfall) => "{\"error\":{\"code\":\"INSUFFICIENT_COINS\",\"message\":\"need 1500, have 300\",\"details\":{\"coinKind\":\"paid\",\"need\":1500,\"have\":300,\"shortfall\":" + shortfall + "}}}";

    static (FakeServer s, GameBackend b) Setup(RulesetParams rs, Func<string> player)
    {
        var s = new FakeServer();
        s.Routes["POST /v1/player/bootstrap"] = _ => Ok(player());
        s.Routes["GET /v1/player"] = _ => Ok(player());
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, new MemoryKeyValueStore(), rs);
        b.InitializeAsync().GetAwaiter().GetResult();
        return (s, b);
    }

    public static async Task Run(Action<bool, string> check, RulesetParams rs)
    {
        await SheetAfterRefusedPull(check, rs);
        await WhereItMayAppear(check, rs);
        await Preview(check, rs);
        await BoughtPacksNotBuyable(check, rs);
    }

    static async Task SheetAfterRefusedPull(Action<bool, string> check, RulesetParams rs)
    {
        int paid = 300;
        var (s, b) = Setup(rs, () => Player(paid, 5000));
        s.Routes["POST /v1/gacha/stepup_paid/draw"] = _ => paid >= 1500 ? Ok("{\"bannerId\":\"stepup_paid\",\"results\":[{\"templateId\":\"t_akatsuki\",\"rarity\":\"SSR\",\"horseId\":\"h9\",\"duplicate\":false,\"material\":0,\"guaranteed\":true}],\"spent\":{\"paid\":1500,\"free\":0},\"pityPoints\":10}") : new HttpResponse(409, DrawRefused(Short));
        s.Routes["POST /v1/shop/purchase-intent"] = _ => Ok(Intent);
        s.Routes["POST /v1/shop/purchase"] = _ => { paid += 1660; return Ok("{\"record\":{\"txId\":\"tx1\",\"productId\":\"coin_2400\"},\"duplicate\":false,\"wallet\":{\"paid\":" + paid + ",\"free\":5000,\"total\":" + (paid + 5000) + ",\"debt\":0}}"); };
        var gacha = new GachaBackend(b, () => Now);
        var (reveal, err, _) = await gacha.DrawAsync("stepup_paid", 10);
        check(reveal == null && err == ApiErrorCode.InsufficientCoins && gacha.LastShortfall?.Shortfall?.Amount == 1200, "a refused paid step-up pull keeps the server's shortfall (1,200 paid coins)");

        var kpi = new List<AnalyticsEvent>();
        var sheet = new CoinShortfallModel(b, kpi.Add, () => Now);
        check(sheet.FromError(gacha.LastShortfall, ShortfallContext.ScoutConfirm, ShortfallOrigin.Gacha("stepup_paid", 10)), "scout confirmation: the sheet is shown");
        check(sheet.Headline == "有償コインが1,200枚足りません" && sheet.Line == "コイン1,660（¥2,400）で足ります" && sheet.Notes.Single() == "有償コインだけで支払います（無償コインは使えません）",
            "headline, line and the paid-only note are the server's texts");
        var card = sheet.Pack;
        check(card != null && card.Id == "coin_2400" && card.PriceText == "¥2,400" && card.Lines.Single() == "有償コイン1,660枚" && card.BonusLabel == "はじめての購入時のみ：無償コイン1,660枚をプレゼント" && card.Purchasable,
            "ONE pack card: price, contents and the shop's own first-purchase line");
        var all = new[] { sheet.Headline, sheet.Line, card.Name, card.BonusLabel }.Concat(card.Lines).Concat(sheet.Notes);
        check(all.All(t => !ShopModel.ForbiddenWords.Any(w => t.Contains(w)) && !t.Contains("今だけ") && !t.Contains("残りわずか")), "no multiplier / deal / urgency words on the sheet");
        sheet.Shown(); sheet.Shown();
        check(kpi.Count(e => e.Name == "offer_view") == 1, "offer_view once per shortfall shown (T6, offerId shortfall)");
        var productId = sheet.Choose();
        sheet.Choose();
        check(productId == "coin_2400" && kpi.Count(e => e.Name == "offer_click") == 1, "choosing the pack: offer_click once, the product id for the purchase confirmation");

        // the existing purchase confirmation, then back to the pull
        var pc = new PurchaseConfirmModel(b, kpi.Add, () => Now);
        check(await pc.OpenAsync(productId) == PurchaseStage.Ready && pc.BeginStore(), "the pack opens the normal purchase confirmation");
        check(sheet.AfterPurchase(PurchaseStage.InStore) == null && sheet.Visible, "until the purchase completes the sheet stays");
        var stage = await pc.StoreFinishedAsync(StoreOutcome.Purchased, StorePlatform.Fake, "rcpt-sf");
        var back = sheet.AfterPurchase(stage);
        check(stage == PurchaseStage.Completed && back != null && back.Kind == "gacha" && back.BannerId == "stepup_paid" && back.Count == 10 && !sheet.Visible, "purchase completed → back to the original pull");
        var (again, err2, _) = await gacha.DrawAsync(back.BannerId, back.Count);
        check(again != null && err2 == null && gacha.LastShortfall == null, "the original pull goes through after the purchase");
    }

    static async Task WhereItMayAppear(Action<bool, string> check, RulesetParams rs)
    {
        var (s, b) = Setup(rs, () => Player(0, 0));
        var e = (InsufficientCoinsException)ApiClient_ParseRefusal(Short);
        var kpi = new List<AnalyticsEvent>();
        foreach (var ctx in new[] { ShortfallContext.Race, ShortfallContext.Matchmaking, ShortfallContext.Tutorial, ShortfallContext.AfterLoss })
        {
            var m = new CoinShortfallModel(b, kpi.Add, () => Now);
            bool shown = m.FromError(e, ctx, ShortfallOrigin.Gacha("standard", 10));
            m.Shown();
            check(!shown && !m.Visible && m.Pack == null && m.Choose() == null && !CoinShortfallModel.Allowed(ctx), "never shown: " + ctx);
            check(!await m.PreviewAsync(ShortfallOrigin.Gacha("standard", 10), ctx) && s.Count("GET", "/v1/shop/shortfall?for=gacha&bannerId=standard&count=10") == 0, "no preview request either: " + ctx);
        }
        check(kpi.Count == 0, "no offer_view / offer_click outside the allowed screens");
        check(CoinShortfallModel.Allowed(ShortfallContext.ScoutConfirm) && CoinShortfallModel.Allowed(ShortfallContext.CosmeticShop) && CoinShortfallModel.Allowed(ShortfallContext.Shop), "allowed: scout confirmation, cosmetics, shop");

        var free = new CoinShortfallModel(b, kpi.Add, () => Now);
        check(free.FromError((InsufficientCoinsException)ApiClient_ParseRefusal(FreeOnly), ShortfallContext.Shop, null) && free.Pack == null && free.Choose() == null
            && free.Line == "無償コインだけで支払う項目です（購入したコインでは支払えません）", "free-only payment: the shortfall is said, no pack is offered");
        var old = new CoinShortfallModel(b, kpi.Add, () => Now);
        check(!old.FromError(new InsufficientCoinsException("INSUFFICIENT_COINS", "x", 409), ShortfallContext.ScoutConfirm, null), "an older server (no details): no sheet; the caller shows its own message");
    }

    static async Task Preview(Action<bool, string> check, RulesetParams rs)
    {
        var (s, b) = Setup(rs, () => Player(300, 0));
        string answer = Short;
        s.Routes["GET /v1/shop/shortfall?for=gacha&bannerId=stepup_paid&count=10"] = _ => Ok(answer);
        s.Routes["GET /v1/shop/shortfall?for=cosmetic&itemId=tack_bridle_gold"] = _ => Ok(NotShort);
        var kpi = new List<AnalyticsEvent>();
        var m = new CoinShortfallModel(b, kpi.Add, () => Now);
        check(await m.PreviewAsync(ShortfallOrigin.Gacha("stepup_paid", 10), ShortfallContext.ScoutConfirm) && m.Headline == "有償コインが1,200枚足りません", "scout confirmation asks before the pull and shows the sheet instead of trying");
        check(!await m.PreviewAsync(ShortfallOrigin.Cosmetic("tack_bridle_gold"), ShortfallContext.CosmeticShop) && !m.Visible, "enough coins: no sheet, the purchase goes ahead");
        s.Routes.Remove("GET /v1/shop/shortfall?for=gacha&bannerId=stepup_paid&count=10");
        check(!await m.PreviewAsync(ShortfallOrigin.Gacha("stepup_paid", 10), ShortfallContext.ScoutConfirm), "a failed preview shows nothing (the pull itself will answer)");
        check(kpi.Count == 0, "previews alone send no KPI (only Shown / Choose do)");
    }

    /// <summary>R8 gap, re-checked on the game layer: a bought starter / promotion pack is not on おすすめ, a running 厩舎手当 is not buyable.</summary>
    static async Task BoughtPacksNotBuyable(Action<bool, string> check, RulesetParams rs)
    {
        var (s, b) = Setup(rs, () => Player(0, 0));
        const string Products = "{\"personalized\":true,\"seasonId\":\"2026-11\",\"products\":["
            + "{\"id\":\"starter_pack\",\"kind\":\"starter\",\"name\":\"スターターパック\",\"tab\":\"recommended\",\"priceYen\":480,\"paidCoins\":300,\"once\":true,\"oneTime\":true,\"oneTimeScope\":\"account\",\"contents\":[],\"noticeKeys\":[],\"owned\":true,\"ownedReason\":\"once\",\"purchasedThisSeason\":null},"
            + "{\"id\":\"promo_pack_B\",\"kind\":\"promotion\",\"name\":\"昇級記念パック（B級）\",\"tab\":\"recommended\",\"priceYen\":1500,\"paidCoins\":1020,\"once\":true,\"oneTime\":true,\"oneTimeScope\":\"class\",\"classId\":\"B\",\"contents\":[],\"noticeKeys\":[],\"owned\":true,\"ownedReason\":\"once\",\"purchasedThisSeason\":null},"
            + "{\"id\":\"stable_allowance_30d\",\"kind\":\"allowance\",\"name\":\"厩舎手当（30日）\",\"tab\":\"recommended\",\"priceYen\":480,\"paidCoins\":100,\"allowance\":{\"days\":30,\"dailyFreeCoins\":30},\"contents\":[],\"noticeKeys\":[],\"owned\":true,\"ownedReason\":\"allowance\",\"purchasedThisSeason\":null}"
            + "],\"notices\":{},\"legalLinks\":[],\"notice\":\"有償コインから先に使われます\"}";
        s.Routes["GET /v1/shop/products?mine=1"] = _ => Ok(Products);
        s.Routes["GET /v1/shop/offers"] = _ => Ok("{\"offers\":[],\"firstPurchase\":{\"available\":false,\"productIds\":[],\"noticeKey\":\"shop.first_purchase_bonus\"},\"allowance\":{\"active\":true,\"claimedToday\":false,\"productId\":\"stable_allowance_30d\",\"day\":3,\"days\":30,\"daysLeft\":28}}");
        var shop = new ShopModel(b, null, () => Now);
        await shop.LoadAsync();
        var rec = shop.Cards("recommended");
        check(!rec.Any(c => c.Id == "starter_pack" || c.Id == "promo_pack_B"), "bought once-only packs are not drawn on おすすめ");
        var a = rec.Single(c => c.Id == "stable_allowance_30d");
        check(!a.Purchasable && a.Owned && a.DisabledReason == "厩舎手当の受け取り期間中です（終わると購入できます）", "a running 厩舎手当 is owned, not buyable, with the reason");
    }

    /// <summary>The InsufficientCoinsException the API client builds from a 409 body (same parse as a real refusal).</summary>
    static ApiException ApiClient_ParseRefusal(string shortfall)
    {
        var o = Muchi.Net.JsonNode.Parse(DrawRefused(shortfall));
        var e = o.Get("error");
        return ApiErrorCodes.Create(e.Get("code").AsString(), e.Get("message").AsString(), 409, e.Get("details"));
    }
}
