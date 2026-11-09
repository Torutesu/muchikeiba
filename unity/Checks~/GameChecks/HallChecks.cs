// 殿堂・引退式 (REQ-HOF-001..016, contracts/protocol.md §34): HallModel over a routed fake server with responses produced by the
// real server code. The gallery (paged), a pending ceremony shown once and acknowledged, retiring → the ceremony sheet, a friend's
// hall, the same line for every refused visit, career progress, visibility, the wording rules (no shop link) and English.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class HallChecks
{
    sealed class FakeServer : IHttp
    {
        public readonly List<HttpRequest> Sent = new List<HttpRequest>();
        public readonly Dictionary<string, Func<HttpRequest, HttpResponse>> Routes = new Dictionary<string, Func<HttpRequest, HttpResponse>>();
        public Task<HttpResponse> SendAsync(HttpRequest r, CancellationToken ct)
        {
            Sent.Add(r);
            var path = r.Path.Split('?')[0];
            if (Routes.TryGetValue(r.Method + " " + r.Path, out var h) || Routes.TryGetValue(r.Method + " " + path, out h)) return Task.FromResult(h(r));
            return Task.FromResult(new HttpResponse(404, "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"no hall to show\"}}"));
        }
    }
    sealed class Tokens : IAuthTokenProvider { public Task<string> GetTokenAsync(bool f, CancellationToken ct) => Task.FromResult("tok"); }

    const string PlayerJson = "{\"id\":\"a\",\"wallet\":{\"paid\":0,\"free\":500,\"total\":500,\"debt\":0},\"season\":{\"id\":\"2026-11\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[{\"id\":\"h1\",\"name\":\"アカツキ\",\"rarity\":\"SR\",\"status\":\"active\",\"base\":{\"speed\":700}}],\"equipment\":{\"tack\":{},\"decor\":[]}}";
    const string Mine = "{\"entries\":[{\"horseId\":\"h3\",\"horseName\":\"ミナモノヒカリ\",\"rarity\":\"SSR\",\"sex\":\"female\",\"appearance\":{\"coat\":\"black\",\"face\":\"star_stripe\",\"legs\":[\"none\",\"none\",\"stocking\",\"none\"],\"mane\":\"dark\",\"build\":\"rangy\"},\"partner\":false,\"reasons\":[\"wins\"],\"inductedAt\":1794193200031,\"career\":{\"races\":11,\"wins\":11,\"places\":11,\"tournamentWins\":0,\"firstRaceAt\":1794193200023,\"lastRaceAt\":1794193200031},\"highlights\":[{\"kind\":\"wins\",\"text\":\"通算11戦11勝\",\"params\":{\"races\":11,\"wins\":11}},{\"kind\":\"biggest_win\",\"text\":\"最大の勝利：青葉競馬場 芝1600mのランク戦（12頭立て）\",\"params\":{\"course\":\"青葉競馬場 芝1600m\",\"mode\":\"ランク戦\",\"n\":12}},{\"kind\":\"career_span\",\"text\":\"現役1日・11戦\",\"params\":{\"days\":1,\"n\":11}}],\"frame\":true}],\"nextCursor\":\"1794193200031_h3\",\"total\":2,\"relation\":\"self\",\"visibility\":\"friends_team\",\"frame\":{\"itemId\":\"decor_hall_plaque_frame\",\"owned\":true},\"criteria\":{\"winsMin\":10,\"tournamentWin\":true,\"partnerRacesMin\":30},\"pendingCeremonies\":[{\"horseId\":\"h3\",\"horseName\":\"ミナモノヒカリ\",\"retiredAt\":1794193200031,\"partner\":false,\"career\":{\"races\":11,\"wins\":11,\"places\":11,\"tournamentWins\":0,\"firstRaceAt\":1794193200023,\"lastRaceAt\":1794193200031},\"highlights\":[{\"kind\":\"wins\",\"text\":\"通算11戦11勝\",\"params\":{\"races\":11,\"wins\":11}},{\"kind\":\"biggest_win\",\"text\":\"最大の勝利：青葉競馬場 芝1600mのランク戦（12頭立て）\",\"params\":{\"course\":\"青葉競馬場 芝1600m\",\"mode\":\"ランク戦\",\"n\":12}},{\"kind\":\"career_span\",\"text\":\"現役1日・11戦\",\"params\":{\"days\":1,\"n\":11}}],\"inducted\":true,\"reasons\":[\"wins\"],\"rewardItemId\":null,\"ackedAt\":null}],\"notice\":\"殿堂入りは確定したレースの成績だけで決まります（購入やアイテムでは決まりません）。\"}";
    const string MineNext = "{\"entries\":[{\"horseId\":\"h2\",\"horseName\":\"ソラノカナタ\",\"rarity\":\"SR\",\"sex\":\"female\",\"appearance\":{\"coat\":\"gray\",\"face\":\"star_stripe\",\"legs\":[\"none\",\"none\",\"stocking\",\"none\"],\"mane\":\"normal\",\"build\":\"powerful\"},\"partner\":false,\"reasons\":[\"wins\",\"tournament\"],\"inductedAt\":1794193200020,\"career\":{\"races\":14,\"wins\":10,\"places\":12,\"tournamentWins\":1,\"firstRaceAt\":1794193200011,\"lastRaceAt\":1794193200019},\"highlights\":[{\"kind\":\"tournament_win\",\"text\":\"大会「オータムカップ」優勝\",\"params\":{\"tournament\":\"オータムカップ\",\"n\":1}},{\"kind\":\"wins\",\"text\":\"通算14戦10勝\",\"params\":{\"races\":14,\"wins\":10}},{\"kind\":\"biggest_win\",\"text\":\"最大の勝利：青葉競馬場 芝1600mのランク戦（12頭立て）\",\"params\":{\"course\":\"青葉競馬場 芝1600m\",\"mode\":\"ランク戦\",\"n\":12}},{\"kind\":\"career_span\",\"text\":\"現役1日・14戦\",\"params\":{\"days\":1,\"n\":14}}],\"frame\":true}],\"nextCursor\":null,\"total\":1,\"relation\":\"self\",\"visibility\":\"friends_team\",\"frame\":{\"itemId\":\"decor_hall_plaque_frame\",\"owned\":true},\"criteria\":{\"winsMin\":10,\"tournamentWin\":true,\"partnerRacesMin\":30},\"pendingCeremonies\":[{\"horseId\":\"h2\",\"horseName\":\"ソラノカナタ\",\"retiredAt\":1794193200020,\"partner\":false,\"career\":{\"races\":14,\"wins\":10,\"places\":12,\"tournamentWins\":1,\"firstRaceAt\":1794193200011,\"lastRaceAt\":1794193200019},\"highlights\":[{\"kind\":\"tournament_win\",\"text\":\"大会「オータムカップ」優勝\",\"params\":{\"tournament\":\"オータムカップ\",\"n\":1}},{\"kind\":\"wins\",\"text\":\"通算14戦10勝\",\"params\":{\"races\":14,\"wins\":10}},{\"kind\":\"biggest_win\",\"text\":\"最大の勝利：青葉競馬場 芝1600mのランク戦（12頭立て）\",\"params\":{\"course\":\"青葉競馬場 芝1600m\",\"mode\":\"ランク戦\",\"n\":12}},{\"kind\":\"career_span\",\"text\":\"現役1日・14戦\",\"params\":{\"days\":1,\"n\":14}}],\"inducted\":true,\"reasons\":[\"wins\",\"tournament\"],\"rewardItemId\":\"decor_hall_plaque_frame\",\"ackedAt\":null}],\"notice\":\"殿堂入りは確定したレースの成績だけで決まります（購入やアイテムでは決まりません）。\"}";
    const string Visit = "{\"owner\":{\"playerId\":\"demo_hof_1\",\"displayName\":\"アオバ\",\"titleId\":null,\"silks\":{\"pattern\":\"plain\",\"colors\":[\"sky\",\"yellow\"],\"cap\":\"hooped\"}},\"relation\":\"friend\",\"entries\":[{\"horseId\":\"h3\",\"horseName\":\"ハルカゼダンサー\",\"rarity\":\"SR\",\"sex\":\"female\",\"appearance\":{\"coat\":\"gray\",\"face\":\"star_stripe\",\"legs\":[\"none\",\"none\",\"stocking\",\"none\"],\"mane\":\"normal\",\"build\":\"powerful\"},\"partner\":false,\"reasons\":[\"wins\",\"tournament\"],\"inductedAt\":1794193200076,\"career\":{\"races\":30,\"wins\":10,\"places\":18,\"tournamentWins\":1,\"firstRaceAt\":1794193200050,\"lastRaceAt\":1794193200075},\"highlights\":[{\"kind\":\"tournament_win\",\"text\":\"大会「春の陣」優勝\",\"params\":{\"tournament\":\"春の陣\",\"n\":1}},{\"kind\":\"wins\",\"text\":\"通算30戦10勝\",\"params\":{\"races\":30,\"wins\":10}},{\"kind\":\"biggest_win\",\"text\":\"最大の勝利：青葉競馬場 芝1600mのランク戦（12頭立て）\",\"params\":{\"course\":\"青葉競馬場 芝1600m\",\"mode\":\"ランク戦\",\"n\":12}},{\"kind\":\"career_span\",\"text\":\"現役1日・30戦\",\"params\":{\"days\":1,\"n\":30}}],\"frame\":true},{\"horseId\":\"h2\",\"horseName\":\"ギンノカケハシ\",\"rarity\":\"SR\",\"sex\":\"male\",\"appearance\":{\"coat\":\"bay\",\"face\":\"star_stripe\",\"legs\":[\"none\",\"stocking\",\"none\",\"none\"],\"mane\":\"normal\",\"build\":\"compact\"},\"partner\":false,\"reasons\":[\"tournament\"],\"inductedAt\":1794193200049,\"career\":{\"races\":10,\"wins\":4,\"places\":6,\"tournamentWins\":1,\"firstRaceAt\":1794193200041,\"lastRaceAt\":1794193200047},\"highlights\":[{\"kind\":\"tournament_win\",\"text\":\"大会「秋の陣」優勝\",\"params\":{\"tournament\":\"秋の陣\",\"n\":1}},{\"kind\":\"wins\",\"text\":\"通算10戦4勝\",\"params\":{\"races\":10,\"wins\":4}},{\"kind\":\"biggest_win\",\"text\":\"最大の勝利：青葉競馬場 芝1600mのランク戦（12頭立て）\",\"params\":{\"course\":\"青葉競馬場 芝1600m\",\"mode\":\"ランク戦\",\"n\":12}},{\"kind\":\"career_span\",\"text\":\"現役1日・10戦\",\"params\":{\"days\":1,\"n\":10}}],\"frame\":true},{\"horseId\":\"h1\",\"horseName\":\"アオバノツバサ\",\"rarity\":\"SSR\",\"sex\":\"female\",\"appearance\":{\"coat\":\"black\",\"face\":\"star_stripe\",\"legs\":[\"none\",\"none\",\"stocking\",\"none\"],\"mane\":\"dark\",\"build\":\"rangy\"},\"partner\":false,\"reasons\":[\"wins\"],\"inductedAt\":1794193200040,\"career\":{\"races\":21,\"wins\":12,\"places\":16,\"tournamentWins\":0,\"firstRaceAt\":1794193200033,\"lastRaceAt\":1794193200040},\"highlights\":[{\"kind\":\"wins\",\"text\":\"通算21戦12勝\",\"params\":{\"races\":21,\"wins\":12}},{\"kind\":\"biggest_win\",\"text\":\"最大の勝利：青葉競馬場 芝1600mのランク戦（12頭立て）\",\"params\":{\"course\":\"青葉競馬場 芝1600m\",\"mode\":\"ランク戦\",\"n\":12}},{\"kind\":\"career_span\",\"text\":\"現役1日・21戦\",\"params\":{\"days\":1,\"n\":21}}],\"frame\":true}],\"nextCursor\":null,\"total\":3,\"frame\":{\"itemId\":\"decor_hall_plaque_frame\",\"owned\":true}}";
    const string Career = "{\"horseId\":\"h1\",\"horseName\":\"アカツキ\",\"status\":\"active\",\"partner\":true,\"career\":{\"races\":5,\"wins\":3,\"places\":3,\"tournamentWins\":0,\"firstRaceAt\":1794193200006,\"lastRaceAt\":1794193200010,\"byMode\":{\"ranked\":{\"races\":5,\"wins\":3}},\"bestTa\":{},\"tournaments\":[],\"biggestWin\":{\"raceId\":\"proto_hof_mw8w5z7d_0\",\"mode\":\"ranked\",\"fieldSize\":12,\"humans\":4,\"trackId\":\"aoba_turf_1600\",\"at\":1794193200006},\"rivalWins\":0},\"progress\":{\"wins\":{\"have\":3,\"need\":10},\"tournamentWin\":false,\"partnerRaces\":{\"have\":5,\"need\":30}},\"qualifies\":false,\"reasons\":[],\"preview\":[{\"kind\":\"partner\",\"text\":\"最初の相棒として5戦をともに走った\",\"params\":{\"n\":5}},{\"kind\":\"wins\",\"text\":\"通算5戦3勝\",\"params\":{\"races\":5,\"wins\":3}},{\"kind\":\"biggest_win\",\"text\":\"最大の勝利：青葉競馬場 芝1600mのランク戦（12頭立て）\",\"params\":{\"course\":\"青葉競馬場 芝1600m\",\"mode\":\"ランク戦\",\"n\":12}},{\"kind\":\"career_span\",\"text\":\"現役1日・5戦\",\"params\":{\"days\":1,\"n\":5}}],\"ceremony\":null,\"entry\":null}";
    const string Retire = "{\"id\":\"h2\",\"name\":\"ソラノカナタ\",\"rarity\":\"SR\",\"status\":\"retired\",\"ceremony\":{\"horseId\":\"h2\",\"horseName\":\"ソラノカナタ\",\"retiredAt\":1794193200020,\"partner\":false,\"career\":{\"races\":14,\"wins\":10,\"places\":12,\"tournamentWins\":1,\"firstRaceAt\":1794193200011,\"lastRaceAt\":1794193200019},\"highlights\":[{\"kind\":\"tournament_win\",\"text\":\"大会「オータムカップ」優勝\",\"params\":{\"tournament\":\"オータムカップ\",\"n\":1}},{\"kind\":\"wins\",\"text\":\"通算14戦10勝\",\"params\":{\"races\":14,\"wins\":10}},{\"kind\":\"biggest_win\",\"text\":\"最大の勝利：青葉競馬場 芝1600mのランク戦（12頭立て）\",\"params\":{\"course\":\"青葉競馬場 芝1600m\",\"mode\":\"ランク戦\",\"n\":12}},{\"kind\":\"career_span\",\"text\":\"現役1日・14戦\",\"params\":{\"days\":1,\"n\":14}}],\"inducted\":true,\"reasons\":[\"wins\",\"tournament\"],\"rewardItemId\":\"decor_hall_plaque_frame\",\"ackedAt\":null}}";

    static HttpResponse Ok(string body) => new HttpResponse(200, body);

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        var s = new FakeServer();
        s.Routes["POST /v1/player/bootstrap"] = _ => Ok(PlayerJson);
        s.Routes["GET /v1/player"] = _ => Ok(PlayerJson);
        s.Routes["GET /v1/hall?limit=1"] = _ => Ok(Mine);
        s.Routes["GET /v1/hall"] = r => Ok(r.Path.Contains("cursor=") ? MineNext : Mine);
        s.Routes["GET /v1/hall/demo_hof_1"] = _ => Ok(Visit);
        s.Routes["GET /v1/horses/h1/career"] = _ => Ok(Career);
        s.Routes["POST /v1/horses/h2/retire"] = _ => Ok(Retire);
        s.Routes["POST /v1/hall/ceremonies/h3/ack"] = _ => Ok("{\"horseId\":\"h3\",\"ackedAt\":1,\"already\":false}");
        s.Routes["POST /v1/hall/ceremonies/h2/ack"] = _ => Ok("{\"horseId\":\"h2\",\"ackedAt\":1,\"already\":false}");
        s.Routes["PUT /v1/hall/settings"] = r => Ok(r.Body.Contains("\"friends\"") ? "{\"visibility\":\"friends\"}" : "{\"visibility\":\"friends_team\"}");
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, new MemoryKeyValueStore(), ruleset);
        await b.InitializeAsync();
        var m = new HallModel(b);

        var load = await m.LoadMineAsync();
        check(load.Ok && m.Page.IsMine && m.TitleText == "自分の殿堂" && m.CountText == "殿堂入り 2頭" && m.Cards.Count == 1, "hall: my gallery loads (" + m.CountText + ")");
        check(m.CriteriaText == "10勝以上・大会優勝・相棒で30戦以上 のどれかで殿堂入り", "hall: the criteria line (" + m.CriteriaText + ")");
        var card = m.Cards[0];
        check(card.HorseName == "ミナモノヒカリ" && card.Frame && card.CareerText == "11戦11勝・3着以内11回" && card.ReasonText == "11勝" && card.InductedText.EndsWith(" 殿堂入り") && card.Coat != null, "hall: a plaque card (" + card.CareerText + " / " + card.ReasonText + ")");
        var cer = m.Ceremony;
        check(cer != null && cer.HorseName == "ミナモノヒカリ" && cer.Inducted && cer.StampText == "殿堂入り" && cer.RewardText == null && cer.Highlights.Count > 0, "hall: the ceremony sheet (stamp, highlight lines, no second frame)");
        var dis = await m.DismissCeremonyAsync();
        check(dis.Ok && m.Ceremony == null && s.Sent.Any(r => r.Path == "/v1/hall/ceremonies/h3/ack"), "hall: closing the ceremony acknowledges it once");
        check(m.HasMore, "hall: more pages");
        await m.LoadMoreAsync();
        check(m.Cards.Count == 2 && m.Cards[1].HorseName == "ソラノカナタ" && !m.HasMore && s.Sent.Any(r => r.Path.StartsWith("/v1/hall?cursor=")), "hall: the next page appends with the cursor");

        // retire → the ceremony with the frame at the first induction
        var ret = await m.RetireAsync("h2");
        check(ret.Ok && m.Ceremony != null && m.Ceremony.Inducted && m.Ceremony.ReasonText == "10勝・大会優勝" && m.Ceremony.RewardText == "殿堂の額縁を受け取りました（マイ厩舎に飾れます）" && m.Ceremony.Highlights[0] == "大会「オータムカップ」優勝", "hall: retiring shows the ceremony (" + m.Ceremony?.ReasonText + ")");
        await m.DismissCeremonyAsync();
        check(s.Sent.Any(r => r.Path == "/v1/hall/ceremonies/h2/ack") && m.Ceremony == null, "hall: the retirement ceremony is acknowledged");
        check(HallModel.RetireConfirmText("アカツキ").Contains("配合には使えます"), "hall: the retire confirmation says breeding stays possible");

        // career progress
        await m.LoadCareerAsync("h1");
        check(m.ProgressText == "殿堂入りまで：10勝のうち3勝・大会優勝 まだ・相棒で30戦のうち5戦", "hall: progress toward the hall (" + m.ProgressText + ")");

        // a friend's hall; refused visits all read the same
        var v = await m.VisitAsync("demo_hof_1");
        check(v.Ok && !m.Page.IsMine && m.TitleText == "アオバの殿堂" && m.Cards.Count == 3 && m.Visibility == null, "hall: a friend's hall (" + m.TitleText + ")");
        var refused = await m.VisitAsync("stranger");
        check(!refused.Ok && refused.Message == "この殿堂は見られません" && m.Page == null, "hall: a refused visit says only that it can't be viewed");

        // visibility
        await m.LoadMineAsync();
        var vis = await m.SetVisibilityAsync("friends");
        var bad = await m.SetVisibilityAsync("everyone");
        check(vis.Ok && m.Visibility == "friends" && vis.Message == "公開範囲を「フレンドだけ」にしました" && !bad.Ok, "hall: visibility setting");
        check(HallModel.RulesText.Contains("購入やアイテムでは決まりません") && !HallModel.RulesText.Contains("倍") && !HallModel.RulesText.Contains("ショップ"), "hall: rules wording (results only, no shop link)");

        // English
        Loc.SetLocale("en");
        try
        {
            check(Loc.T(m.CriteriaText) == "Inducted on any of: 10+ wins, Tournament win, 30+ races as partner" || !Loc.HasJapanese(Loc.T(m.CriteriaText)), "hall: criteria in English (" + Loc.T(m.CriteriaText) + ")");
            check(!Loc.HasJapanese(Loc.T(HallModel.CareerText(new CareerLine { Races = 34, Wins = 11, Places = 20 }))) && !Loc.HasJapanese(Loc.T(m.CountText)) && !Loc.HasJapanese(Loc.T("アオバの殿堂")), "hall: lines in English (" + Loc.T(m.CountText) + ")");
            check(Loc.T("ミナモノヒカリ") == "Minamonohikari", "hall: horse names are not translated (katakana romanized as everywhere)");
        }
        finally { Loc.SetLocale("ja"); }
    }
}
