// イベント交換所 (REQ-EXCH-001..012, contracts/protocol.md §30): ExchangeModel over a routed fake server with the real server's
// JSON. Point counter, cards with the stock fact ("残り 2 / 3"), why a card is disabled, the confirm sheet, a keyed confirm that
// survives a 5xx retry, the post-event notice from the real close instant, the leftover line, the rules wording (no purchase,
// nothing random, no shop link, no urgency words) and English.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class ExchangeChecks
{
    sealed class FakeServer : IHttp
    {
        public readonly List<HttpRequest> Sent = new List<HttpRequest>();
        public readonly Dictionary<string, Func<HttpRequest, HttpResponse>> Routes = new Dictionary<string, Func<HttpRequest, HttpResponse>>();
        public Task<HttpResponse> SendAsync(HttpRequest r, CancellationToken ct)
        {
            Sent.Add(r);
            if (Routes.TryGetValue(r.Method + " " + r.Path, out var h)) return Task.FromResult(h(r));
            return Task.FromResult(new HttpResponse(404, "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"no route\"}}"));
        }
    }
    sealed class Tokens : IAuthTokenProvider { public Task<string> GetTokenAsync(bool f, CancellationToken ct) => Task.FromResult("tok"); }

    const string PlayerJson = "{\"id\":\"t\",\"wallet\":{\"paid\":0,\"free\":500,\"total\":500,\"debt\":0},\"season\":{\"id\":\"2027-01\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[{\"id\":\"h1\",\"name\":\"アイボウ\",\"rarity\":\"SR\",\"status\":\"active\",\"base\":{\"speed\":700}}],\"equipment\":{\"tack\":{},\"decor\":[]}}";
    // produced by the real server (PlayerService.exchangeView / exchangeBuy) after three first places
    const string ViewJson = "{\"eventId\":\"newyear_cup_2027_01\",\"name\":\"新春交換祭杯\",\"status\":\"open\",\"startAtMs\":1798729200000,\"endAtMs\":1799679600000,\"closesAtMs\":1799953200000,\"graceDays\":3,\"points\":120,\"earned\":120,\"spent\":0,\"earn\":{\"byPlace\":[30,25,21,18,16,14,12,10,8,6,5,4],\"participation\":10,\"dailyCap\":150,\"earnedToday\":120,\"remainingToday\":30,\"resetsAtMs\":1798743600000},\"leftover\":{\"itemId\":\"breeding_material\",\"pointsPerUnit\":100,\"rounding\":\"up\",\"preview\":2,\"converted\":null},\"items\":[{\"id\":\"ex_hatsuyuki\",\"name\":\"ハツユキソウ\",\"kind\":\"horse\",\"price\":800,\"stock\":1,\"bought\":0,\"remaining\":1,\"owned\":false,\"reward\":{\"horse\":\"t_hatsuyuki\"},\"icon\":\"collection/portrait/t_hatsuyuki\",\"affordable\":false,\"maxQty\":0},{\"id\":\"ex_scout_ticket\",\"name\":\"スカウト券\",\"kind\":\"ticket\",\"price\":300,\"stock\":1,\"bought\":0,\"remaining\":1,\"owned\":false,\"reward\":{\"items\":[{\"itemId\":\"gacha_ticket\",\"qty\":1}]},\"icon\":\"item/gacha_ticket\",\"affordable\":false,\"maxQty\":0},{\"id\":\"ex_coins_50\",\"name\":\"無償コイン 50\",\"kind\":\"coins\",\"price\":150,\"stock\":2,\"bought\":0,\"remaining\":2,\"owned\":false,\"reward\":{\"freeCoins\":50},\"icon\":null,\"affordable\":false,\"maxQty\":0},{\"id\":\"ex_material\",\"name\":\"配合素材\",\"kind\":\"material\",\"price\":120,\"stock\":3,\"bought\":0,\"remaining\":3,\"owned\":false,\"reward\":{\"items\":[{\"itemId\":\"breeding_material\",\"qty\":1}]},\"icon\":\"item/breeding_material\",\"affordable\":true,\"maxQty\":1},{\"id\":\"ex_flower_box\",\"name\":\"花かご（厩舎の飾り）\",\"kind\":\"cosmetic\",\"price\":200,\"stock\":1,\"bought\":0,\"remaining\":1,\"owned\":false,\"reward\":{\"items\":[{\"itemId\":\"decor_flower_box\",\"qty\":1}]},\"icon\":\"item/decor_flower_box\",\"affordable\":false,\"maxQty\":0}],\"rules\":{\"purchasable\":false,\"random\":false,\"completionReward\":false,\"sources\":[\"event_race\"]}}";
    const string BuyJson = "{\"eventId\":\"newyear_cup_2027_01\",\"itemId\":\"ex_material\",\"kind\":\"material\",\"qty\":1,\"spent\":120,\"points\":0,\"bought\":1,\"remaining\":2,\"granted\":{\"freeCoins\":0,\"items\":[{\"itemId\":\"breeding_material\",\"qty\":1}],\"horse\":null},\"wallet\":{\"paid\":0,\"free\":0,\"total\":0,\"debt\":0}}";

    static HttpResponse Ok(string body) => new HttpResponse(200, body);

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        var s = new FakeServer();
        s.Routes["POST /v1/player/bootstrap"] = _ => Ok(PlayerJson);
        s.Routes["GET /v1/player"] = _ => Ok(PlayerJson);
        string view = ViewJson;
        s.Routes["GET /v1/events/newyear_cup_2027_01/exchange"] = _ => Ok(view);
        int buys = 0;
        string lastBody = null;
        string after = ViewJson.Replace("\"points\":120", "\"points\":0").Replace("\"bought\":0,\"remaining\":3,\"owned\":false,\"reward\":{\"items\":[{\"itemId\":\"breeding_material\"", "\"bought\":1,\"remaining\":2,\"owned\":false,\"reward\":{\"items\":[{\"itemId\":\"breeding_material\"").Replace("\"affordable\":true,\"maxQty\":1", "\"affordable\":false,\"maxQty\":0");
        s.Routes["POST /v1/events/newyear_cup_2027_01/exchange"] = r =>
        {
            lastBody = r.Body;
            return ++buys == 1 ? new HttpResponse(503, "{\"error\":{\"code\":\"INTERNAL\",\"message\":\"x\"}}") : Ok(BuyJson.Replace("\"wallet\":", "\"exchange\":" + after + ",\"wallet\":"));
        };
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var kv = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, ruleset);
        await b.InitializeAsync();

        var m = new ExchangeModel(b);
        var load = await m.LoadAsync("newyear_cup_2027_01");
        check(load.Ok && m.Points == 120, "exchange: loads the event's exchange");
        check(m.PointsText == "イベントポイント 120" && m.EarnTodayText == "今日あと 30 ポイントまで" && m.WinPointsText == "1着 40 ポイント", "exchange: point counter and today's cap (" + m.PointsText + " / " + m.EarnTodayText + ")");
        check(m.PeriodText == "イベントは 1月11日 23:59まで" && m.GraceNotice == null, "exchange: the period comes from the real end instant (" + m.PeriodText + ")");
        check(m.LeftoverText == "残りのポイントは交換の終了時に配合素材 2個になります（100ポイントごとに1個・切り上げ）", "exchange: the leftover rate and rounding are shown before the close");
        var cards = m.Cards;
        var mat = cards.First(c => c.Id == "ex_material");
        var horse = cards.First(c => c.Id == "ex_hatsuyuki");
        check(cards.Count == 5 && mat.Enabled && mat.StockText == "残り 3 / 3" && mat.PriceText == "120 ポイント" && mat.RewardText == "配合素材 ×1", "exchange: a card shows price, the stock fact and the reward (" + mat.StockText + ")");
        check(!horse.Enabled && horse.BlockedText == "ポイントが足りません" && horse.Icon == "collection/portrait/t_hatsuyuki" && cards.First(c => c.Id == "ex_coins_50").RewardText == "無償コイン50枚", "exchange: an unaffordable line says why; the horse uses its portrait");
        var allText = string.Join("", cards.Select(c => c.Name + c.PriceText + c.StockText + c.RewardText + c.BlockedText)) + m.PointsText + m.EarnTodayText + m.PeriodText + m.LeftoverText + ExchangeModel.RulesText;
        check(new[] { "倍", "今だけ", "残りわずか", "お得", "通常価格", "ショップ", "ガチャ" }.All(w => !allText.Contains(w)), "exchange: no multipliers, urgency words or shop links anywhere");
        check(ExchangeModel.RulesText.Contains("購入はできません") && ExchangeModel.RulesText.Contains("ランダムなものはありません"), "exchange: the rules say points cannot be bought and nothing is random");

        // confirm sheet
        check(!m.Select("ex_hatsuyuki").Ok && m.Pending == null, "exchange: a disabled card does not open the confirm sheet");
        var sel = m.Select("ex_material", 5);
        check(sel.Ok && m.PendingQty == 1 && m.PendingCostText == "交換に使うポイント 120" && m.PendingAfterText == "交換後のポイント 0" && m.PendingStockText == "残り 3 / 3 → 2 / 3", "exchange: the confirm sheet (qty clamped to the points) shows cost, points after and stock");
        var c1 = await m.ConfirmAsync();
        check(!c1.Ok && m.Pending != null, "exchange: a 5xx keeps the confirm pending");
        var c2 = await m.ConfirmAsync();
        var keys = s.Sent.Where(r => r.Path == "/v1/events/newyear_cup_2027_01/exchange" && r.Method == "POST").Select(r => r.Headers["idempotency-key"]).ToList();
        check(c2.Ok && keys.Count == 2 && keys[0] == keys[1] && lastBody.Contains("\"itemId\":\"ex_material\"") && lastBody.Contains("\"qty\":1"), "exchange: the retry reuses the idempotency key (never paid twice)");
        check(m.Points == 0 && m.Cards.First(c => c.Id == "ex_material").StockText == "残り 2 / 3" && m.Pending == null && m.LastResult.Spent == 120, "exchange: the response view replaces the grid");

        // after the event: grace notice from the real close instant, then closed with the conversion
        view = ViewJson.Replace("\"status\":\"open\"", "\"status\":\"grace\"").Replace("\"remainingToday\":30", "\"remainingToday\":0");
        await m.LoadAsync("newyear_cup_2027_01");
        check(m.GraceNotice == "イベントは終了しました。交換は 1月15日 3:59まで" && m.EarnTodayText == null && m.Cards.First(c => c.Id == "ex_material").Enabled, "exchange: grace — still open for exchange, with the real close time (" + m.GraceNotice + ")");
        view = ViewJson.Replace("\"status\":\"open\"", "\"status\":\"closed\"").Replace("\"points\":120", "\"points\":0").Replace("\"converted\":null", "\"converted\":{\"at\":1,\"points\":120,\"itemId\":\"breeding_material\",\"qty\":2}");
        await m.LoadAsync("newyear_cup_2027_01");
        check(m.GraceNotice == "交換は終了しました" && m.LeftoverText == "残りの 120 ポイントは配合素材 2個になりました" && m.Cards.All(c => !c.Enabled && c.BlockedText == "交換は終了しました"), "exchange: closed — every card disabled and the conversion shown");
        check(new[] { "EXCHANGE_NOT_OPEN", "EXCHANGE_CLOSED", "OUT_OF_STOCK", "INSUFFICIENT_POINTS" }.All(k => UxText.Errors.ContainsKey(k)), "exchange: error sentences for the exchange codes");

        // English (REQ-L10N-010)
        Loc.SetLocale("en");
        try
        {
            var lines = new List<string> { "イベントポイント 120", "今日あと 30 ポイントまで", "今日のポイントは上限です。4:00に戻ります", "1着 40 ポイント", "イベントは 1月11日 23:59まで", "イベントは終了しました。交換は 1月15日 3:59まで",
                "交換は終了しました", "残りの 120 ポイントは配合素材 2個になりました", "残りのポイントは交換の終了時に配合素材 2個になります（100ポイントごとに1個・切り上げ）", "交換所はまだ開いていません", "所持しています", "交換済み",
                "ポイントが足りません", "120 ポイント", "残り 2 / 3", "残り 3 / 3 → 2 / 3", "交換に使うポイント 120", "交換後のポイント 0", "交換するものを選んでください", "交換所はオンラインで使えます", "交換しました",
                ExchangeModel.NoUndoText, ExchangeModel.RulesText, "無償コイン50枚", "1月11日 0:00から" };
            lines.AddRange(new[] { "EXCHANGE_NOT_OPEN", "EXCHANGE_CLOSED", "OUT_OF_STOCK", "INSUFFICIENT_POINTS" }.Select(k => UxText.Errors[k]));
            var badEn = lines.Where(x => Loc.HasJapanese(Loc.T(x))).ToList();
            check(badEn.Count == 0, "exchange: every line reads in English (" + lines.Count + ")" + (badEn.Count > 0 ? ": " + string.Join(" | ", badEn) : ""));
            check(Loc.T("残り 2 / 3") == "2 / 3 left" && Loc.T("イベントポイント 120") == "Event points 120", "exchange in English: " + Loc.T("残り 2 / 3"));
        }
        finally { Loc.SetLocale("ja"); }

        // offline
        var off = new GameBackend(new GameSettings { BaseUrl = "http://fake", OfflineOnly = true }, api, null, new MemoryKeyValueStore(), ruleset);
        await off.InitializeAsync();
        var mo = new ExchangeModel(off);
        var ol = await mo.LoadAsync("newyear_cup_2027_01");
        check(!ol.Ok && mo.Cards.Count == 0 && mo.PointsText == null, "exchange: offline shows the online-only notice and no cards");
    }
}
