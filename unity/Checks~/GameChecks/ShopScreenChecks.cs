// U1 money screens (docs/quality/unity-shop.md): what the Unity shop, scout confirmation, purchase and season pass screens read
// from the game layer, and the layout audit of those screens (ShopLayout: the boxes MuchiApp.Shop.cs draws at).
//   - the coin tab lists the server's packs (a pack retired by remote config is simply not in the list: 8 → 6 follows the server)
//   - the daily pack moves under the pass screen when the server lists it with tab "pass" (allowanceUnderPass), and leaves おすすめ
//   - the pass screen's totals line (a sum, the standout count, the reached tiers that open at once when bought)
//   - the scout ways come from the server (GachaBackend.ScoutOptionsAsync), offline says so
//   - every money screen state: inside 1600×900, clear of the language button, text ≥ 16 px, no text overlaps, one CTA
//   - every Japanese literal of MuchiApp.Shop.cs has English (ui-en.json through Loc, as the screens show it)
using System.Text.RegularExpressions;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class ShopScreenChecks
{
    sealed class FakeServer : IHttp
    {
        public readonly Dictionary<string, Func<HttpRequest, HttpResponse>> Routes = new Dictionary<string, Func<HttpRequest, HttpResponse>>();
        public readonly List<HttpRequest> Sent = new List<HttpRequest>();
        public Task<HttpResponse> SendAsync(HttpRequest r, CancellationToken ct)
        {
            Sent.Add(r);
            if (Routes.TryGetValue(r.Method + " " + r.Path, out var h)) return Task.FromResult(h(r));
            return Task.FromResult(new HttpResponse(404, "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"no route\"}}"));
        }
    }
    sealed class Tokens : IAuthTokenProvider { public Task<string> GetTokenAsync(bool f, CancellationToken ct) => Task.FromResult("tok"); }
    static HttpResponse Ok(string body) => new HttpResponse(200, body);
    const long Now = 1795575600000L; // 2026-11-25 12:00 JST
    const string Player = "{\"id\":\"me\",\"profile\":{\"displayName\":\"アオバ\"},\"wallet\":{\"paid\":100,\"free\":195,\"total\":295,\"debt\":0},\"deletion\":{\"status\":\"none\",\"requestedAt\":null,\"deleteAt\":null}}";

    static (FakeServer s, GameBackend b) Online(RulesetParams rs)
    {
        var s = new FakeServer();
        s.Routes["POST /v1/player/bootstrap"] = _ => Ok(Player);
        s.Routes["GET /v1/player"] = _ => Ok(Player);
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, new MemoryKeyValueStore(), rs);
        b.InitializeAsync().GetAwaiter().GetResult();
        return (s, b);
    }

    static string Coin(string id, int yen, int coins) => "{\"id\":\"" + id + "\",\"kind\":\"coins\",\"name\":\"コイン" + coins + "\",\"tab\":\"coins\",\"storeType\":\"consumable\",\"priceYen\":" + yen + ",\"paidCoins\":" + coins
        + ",\"autoRenew\":false,\"contents\":[{\"type\":\"paid_coins\",\"qty\":" + coins + ",\"label\":\"有償コイン" + coins + "枚\"}],\"firstPurchaseBonus\":{\"coins\":" + coins + ",\"currency\":\"free\",\"label\":\"はじめての購入時のみ：無償コイン" + coins + "枚をプレゼント\"},\"oneTime\":false,\"period\":null,\"noticeKeys\":[],\"owned\":false}";
    static string Allowance(string tab) => "{\"id\":\"stable_allowance_30d\",\"kind\":\"allowance\",\"name\":\"厩舎手当\",\"tab\":\"" + tab + "\",\"storeType\":\"consumable\",\"priceYen\":480,\"paidCoins\":100,\"autoRenew\":false,"
        + "\"contents\":[{\"type\":\"paid_coins\",\"qty\":100,\"label\":\"有償コイン100枚\"},{\"type\":\"daily_free_coins\",\"qty\":30,\"days\":30,\"total\":900,\"label\":\"30日間、毎日 無償コイン30枚\"}],\"oneTime\":false,\"period\":{\"kind\":\"days\",\"days\":30},\"noticeKeys\":[],\"allowance\":{\"days\":30,\"dailyFreeCoins\":30,\"autoRenew\":false},\"owned\":false}";
    const string Pass = "{\"id\":\"season_pass\",\"kind\":\"season_pass\",\"name\":\"シーズンパス\",\"tab\":\"pass\",\"storeType\":\"consumable\",\"priceYen\":1000,\"paidCoins\":0,\"autoRenew\":false,"
        + "\"contents\":[{\"type\":\"pass_premium\",\"label\":\"有料ライン30段\",\"levels\":30,\"total\":{\"freeCoins\":1500},\"totalLabel\":\"無償コイン1,500枚・配合素材30個\",\"standouts\":[{\"level\":10,\"itemId\":\"silkpart_color_shokou\",\"label\":\"勝負服の色「曙光」\"},{\"level\":20,\"itemId\":\"silkpart_sleeve_comet\",\"label\":\"勝負服の袖「流星」\"},{\"level\":30,\"itemId\":\"costume_silks_comet\",\"label\":\"勝負服の柄「流星群」\"}]}],"
        + "\"oneTime\":false,\"period\":{\"kind\":\"season\"},\"noticeKeys\":[],\"owned\":false,\"ownedReason\":null,\"purchasedThisSeason\":false}";
    const string PassPlus = "{\"id\":\"season_pass_plus\",\"kind\":\"season_pass\",\"name\":\"シーズンパス＋\",\"tab\":\"pass\",\"storeType\":\"consumable\",\"priceYen\":2400,\"paidCoins\":0,\"autoRenew\":false,"
        + "\"contents\":[{\"type\":\"pass_levels\",\"levels\":10,\"label\":\"すぐにレベル＋10\"}],\"oneTime\":false,\"period\":{\"kind\":\"season\"},\"noticeKeys\":[],\"owned\":false,\"ownedReason\":null,\"purchasedThisSeason\":false}";

    // the server's list with shopLayout {allowanceUnderPass, retiredProducts: [coin_800, coin_2400]} on / off
    static string List(bool newLayout)
    {
        var coins = new List<string> { Coin("coin_160", 160, 100), Coin("coin_480", 480, 310), Coin("coin_1500", 1500, 1020), Coin("coin_3800", 3800, 2680), Coin("coin_5000", 5000, 3600), Coin("coin_10000", 10000, 7400) };
        if (!newLayout) { coins.Insert(2, Coin("coin_800", 800, 530)); coins.Insert(4, Coin("coin_2400", 2400, 1660)); }
        // the server's order is not the price order: the client sorts
        coins.Reverse();
        return "{\"personalized\":true,\"seasonId\":\"2026-11\",\"products\":[" + string.Join(",", coins) + "," + Allowance(newLayout ? "pass" : "recommended") + "," + Pass + "," + PassPlus + "],"
            + "\"notices\":{},\"legalLinks\":[{\"key\":\"legal.tokushoho\",\"title\":\"特定商取引法に基づく表記\"}],\"notice\":\"有償コインから先に使われます\"}";
    }
    const string NoOffers = "{\"offers\":[],\"firstPurchase\":{\"available\":true,\"productIds\":[\"coin_160\"],\"noticeKey\":\"shop.first_purchase_bonus\"},\"allowance\":null}";
    const string AllowanceRunning = "{\"offers\":[],\"firstPurchase\":{\"available\":false,\"productIds\":[],\"noticeKey\":\"shop.first_purchase_bonus\"},\"allowance\":{\"active\":true,\"claimedToday\":false,\"productId\":\"stable_allowance_30d\",\"startDate\":\"2026-11-20\",\"endDate\":\"2026-12-19\",\"day\":6,\"days\":30,\"daysLeft\":25,\"dailyFreeCoins\":30,\"claimedDays\":5,\"queued\":null}}";

    public static async Task Run(Action<bool, string> check, RulesetParams rs, string root)
    {
        foreach (var f in new[] { "server-en.json", "ui-en.json" }) Loc.LoadEnglish(File.ReadAllText(Path.Combine(root, "engine", "Muchi.Client", "Resources", "Muchi", f)));
        await Products(check, rs);
        await ScoutWays(check, rs);
        Layout(check);
        English(check, root);
    }

    static async Task Products(Action<bool, string> check, RulesetParams rs)
    {
        var (s, b) = Online(rs);
        bool newLayout = false;
        string offers = NoOffers;
        s.Routes["GET /v1/shop/products?mine=1"] = _ => Ok(List(newLayout));
        s.Routes["GET /v1/shop/offers"] = _ => Ok(offers);
        var shop = new ShopModel(b, null, () => Now);
        await shop.LoadAsync();
        var packs = shop.CoinPacks;
        check(packs.Count == 8 && packs.Select(p => p.PriceYen).SequenceEqual(packs.Select(p => p.PriceYen).OrderBy(x => x)) && packs[0].Kind == "coins", "coin tab: the 8 packs the server lists, cheapest first");
        check(shop.Cards("recommended").Any(c => c.Kind == "allowance") && shop.PassScreenAllowance == null, "allowanceUnderPass off: 厩舎手当 on おすすめ, not on the pass screen");

        newLayout = true;
        await shop.LoadAsync();
        packs = shop.CoinPacks;
        check(packs.Count == 6 && !packs.Any(p => p.Id == "coin_800" || p.Id == "coin_2400") && packs.First().Id == "coin_160" && packs.Last().Id == "coin_10000",
            "retiredProducts: the packs the server leaves out are not shown (8 → 6), smallest and largest stay");
        check(!shop.Cards("recommended").Any(c => c.Kind == "allowance") && shop.PassScreenAllowance?.Id == "stable_allowance_30d" && shop.PassScreenAllowance.PriceText == "¥480",
            "allowanceUnderPass on: 厩舎手当 leaves おすすめ and is listed under the pass screen, same product and price");
        check(shop.PassProducts.Select(p => p.Id).SequenceEqual(new[] { "season_pass", "season_pass_plus" }) && shop.PassProducts.All(p => p.Purchasable), "the pass screen lists パス and パス＋ from the server, cheapest first");

        s.Routes["GET /v1/season-pass"] = _ => Ok(Round8Checks.SeasonPassStandouts);
        var pass = new SeasonPassModel(b, () => Now);
        await pass.LoadAsync();
        check(shop.PassTotalLine(pass.View) == "有料ライン 無償コイン1,500枚・配合素材30個　＋　特別な段の見た目3点", "totals line (pass owned): the server's sum and the standout looks by count");
        var st = pass.Standouts;
        check(pass.StandoutState(st[0]) == "受け取れます" && pass.StandoutState(st[2]) == "あと5段（24戦）" && pass.StandoutState(new PassStandout { Track = "premium", Owned = true }) == "受け取り済み・勝負服エディタで選べます",
            "standout state lines: claimable, how far (the server's count), received");
        s.Routes["GET /v1/season-pass"] = _ => Ok(Round8Checks.SeasonPassStandouts.Replace("\"active\":true", "\"active\":false"));
        await pass.LoadAsync();
        check(pass.StandoutState(new PassStandout { Track = "premium", Reached = true }) == "到達済み・パスを買うとすぐ受け取れます" && pass.StandoutState(new PassStandout { Track = "free", Reached = true }) == "受け取れます",
            "a reached premium standout without the pass: 「パスを買うとすぐ受け取れます」; a free one is claimable");
        check(shop.PassTotalLine(pass.View) == "有料ライン 無償コイン1,500枚・配合素材30個　＋　特別な段の見た目3点　·　届いている15段は購入後すぐ受け取れます", "totals line (not owned): the reached premium tiers open at once when bought");
        check(Loc.English.Translate("有料ライン Free coins 1,500　＋　特別な段の見た目3点　·　届いている15段は購入後すぐ受け取れます") == "Premium track Free coins 1,500  +  3 special-tier looks  ·  the 15 tiers you have reached open as soon as you buy",
            "totals line in English (the server's own label arrives in English when the request is English)");

        check(!shop.AllowanceClaimable, "no running daily pack: nothing to claim");
        offers = AllowanceRunning;
        await shop.LoadAsync();
        check(shop.AllowanceClaimable, "a running daily pack with today's share open: the claim is offered");
        var off = new ShopModel(OfflineBackend(rs), null, () => Now);
        await off.LoadAsync();
        check(off.CoinPacks.Count == 0 && off.PassScreenAllowance == null && off.PassProducts.Count == 0 && off.PassTotalLine(null) == null && !off.AllowanceClaimable, "offline: no packs, no pass products, nothing claimable");
    }

    static GameBackend OfflineBackend(RulesetParams rs)
    {
        var b = new GameBackend(new GameSettings { BaseUrl = "" }, null, null, new MemoryKeyValueStore(), rs);
        b.InitializeAsync().GetAwaiter().GetResult();
        return b;
    }

    static async Task ScoutWays(Action<bool, string> check, RulesetParams rs)
    {
        var (s, b) = Online(rs);
        s.Routes["GET /v1/gacha/pickup_ginga/options"] = _ => Ok(MonetizationQualityChecks.Options);
        var g = new GachaBackend(b, () => Now);
        var (o, msg) = await g.ScoutOptionsAsync("pickup_ginga");
        check(o != null && msg == null && o.Ways.Count == 3 && o.Way("ticket:gacha_ticket") != null && o.SrPlusOwned == 1, "scout ways from the server: coins, the ticket held, the SR+ ticket");
        var (none, why) = await g.ScoutOptionsAsync("gone");
        check(none == null && why == "スカウトできませんでした", "an unknown banner: a sentence, no ways");
        var (offline, notice) = await new GachaBackend(OfflineBackend(rs)).ScoutOptionsAsync("pickup_ginga");
        check(offline == null && notice == GachaBackend.OfflineNotice, "offline: the scout needs the server");
    }

    static void Layout(Action<bool, string> check)
    {
        var all = ShopLayout.All().ToList();
        var problems = all.SelectMany(l => l.Problems()).ToList();
        foreach (var p in problems.Take(12)) Console.WriteLine("        " + p);
        check(all.Count > 40 && problems.Count == 0, "layout audit: " + all.Count + " money screen states inside 1600×900, clear of the language button, text ≥ 16 px, no overlaps, one CTA");
        check(all.All(l => l.Boxes.Count(x => x.Kind == BoxKind.Cta) <= 1), "at most one call to action on every money screen");
        // the audit catches what it should
        var bad = new ShopScreenLayout("bad").Text("a", 0, 0, 100, 30, 14).Text("b", 50, 10, 100, 30, 20).Cta("x", 1500, 880, 200).Cta("y", 0, 400, 100).Text("c", 1400, 150, 100, 24, 16);
        var bp = bad.Problems();
        check(bp.Any(p => p.Contains("under 16")) && bp.Any(p => p.Contains("overlap")) && bp.Any(p => p.Contains("outside")) && bp.Any(p => p.Contains("calls to action")) && bp.Any(p => p.Contains("language button")),
            "the audit flags small text, overlaps, boxes off the canvas, two CTAs and text under the language button");
        check(ShopLayout.PageStart(1) == 1 && ShopLayout.PageStart(6) == 1 && ShopLayout.PageStart(7) == 7 && ShopLayout.PageStart(30) == 25 && ShopLayout.RoadX(30, 30) == 1340 && ShopLayout.RoadX(0, 30) == 640,
            "pass pages of six tiers; the road spans 640..1340");
    }

    // A whole Japanese literal in the money screens (the argument of a call / an assignment / a ternary branch); the pieces of a
    // `+` concatenation are checked as the whole lines the screens build (Composites below), as L10nChecks does.
    static readonly Regex Literal = new Regex(@"(?<=(=|return|\(|\?|:|,|=>)\s*)""((?:[^""\\]|\\.)*)""(?=\s*(;|,|\)|\}|:|\?\?))");
    static readonly string[] Composites =
    {
        "2010年", "3月", "◈ 有償 300　·　◎ 無償 2,144", "ティア12・有料ライン", "ティア15・無料ライン", "有料ラインの特別な段 3点", "交換ptが100たまると、対象の馬と交換できます",
        "受け取り済み・勝負服エディタで選べます", "到達済み・パスを買うとすぐ受け取れます", "あと5段（24戦）",
        "有料ライン Free coins 1,500　＋　特別な段の見た目3点", "有料ライン Free coins 1,500　·　届いている4段は購入後すぐ受け取れます",
    };
    static readonly Regex Japanese = new Regex("[぀-ヿ一-鿿]");

    static void English(Action<bool, string> check, string root)
    {
        var file = Path.Combine(root, "unity", "Assets", "Muchi", "Runtime", "MuchiApp.Shop.cs");
        var missing = new List<string>();
        int total = 0;
        foreach (var raw in File.ReadAllLines(file))
        {
            var line = raw.TrimStart();
            if (line.StartsWith("//")) continue;
            int c = line.IndexOf(" // ", StringComparison.Ordinal);
            if (c >= 0) line = line.Substring(0, c);
            foreach (Match m in Literal.Matches(line))
            {
                var s = Regex.Unescape(m.Groups[2].Value);
                if (!Japanese.IsMatch(s)) continue;
                total++;
                if (Loc.HasJapanese(Loc.English.Translate(s) ?? s)) missing.Add(s);
            }
        }
        foreach (var m in missing.Take(10)) Console.WriteLine("        no English: " + m);
        check(total > 20 && missing.Count == 0, "every Japanese literal of MuchiApp.Shop.cs has English (" + total + " checked)");
        var lines = Composites.Where(x => Loc.HasJapanese(Loc.English.Translate(x) ?? x)).ToList();
        foreach (var m in lines) Console.WriteLine("        no English: " + m);
        check(lines.Count == 0, "the lines the money screens build read in English (dates, wallet, tiers, standout states, totals)");
    }
}
