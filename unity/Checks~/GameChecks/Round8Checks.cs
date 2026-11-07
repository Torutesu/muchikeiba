// Round 8 game layer (docs/planning/06, REQ-UXU-001..017 over REQ-UXS-*): FTUE flow with resume after a kill, unlock gating,
// login bonus, mission board, shop / offers / purchase confirmation, 厩舎手当, season pass, account deletion, the new KPI
// events and game-day countdowns. A routed fake server stands in for the API (bodies shaped like ApiClientRound8Tests,
// which were produced by the real server code); retries are off in the client so a 503 reaches the model as "no answer".
using System.Text.Json;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static partial class Round8Checks
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
        public List<HttpRequest> To(string method, string path) => Sent.Where(r => r.Method == method && r.Path == path).ToList();
        public int Count(string method, string path) => To(method, path).Count;
    }
    sealed class Tokens : IAuthTokenProvider { public Task<string> GetTokenAsync(bool f, CancellationToken ct) => Task.FromResult("tok"); }

    static HttpResponse Ok(string body) => new HttpResponse(200, body);
    static HttpResponse Err(int status, string code) => new HttpResponse(status, "{\"error\":{\"code\":\"" + code + "\",\"message\":\"" + code + "\"}}");
    /// <summary>Answers from the queue in order, then repeats the last one.</summary>
    static Func<HttpRequest, HttpResponse> Seq(params Func<HttpResponse>[] answers) { int i = 0; return _ => answers[Math.Min(i++, answers.Length - 1)](); }

    // 2026-11-25 12:00 JST and the end of the November season (2026-12-01 00:00 JST)
    const long Nov25Noon = 1795575600000L;
    const long SeasonEnd = 1796050800000L;
    static long now = Nov25Noon;

    const string Horse1 = "{\"id\":\"h1\",\"templateId\":\"t_partner\",\"name\":\"アイボウ\",\"rarity\":\"SR\",\"sex\":\"male\",\"style\":\"sashi\",\"status\":\"active\",\"named\":true}";
    const string Horse2 = "{\"id\":\"h2\",\"templateId\":\"t_kurogane\",\"name\":null,\"rarity\":\"SSR\",\"sex\":\"male\",\"style\":\"nige\",\"status\":\"active\",\"named\":false}";
    const string AllUnlocks = "{\"day\":1,\"races\":6,\"rankedRaces\":6,\"breedings\":0,\"features\":["
        + "{\"key\":\"race\",\"unlocked\":true,\"by\":\"always\",\"races\":null,\"days\":null,\"rankedRaces\":null,\"breedings\":null},"
        + "{\"key\":\"missions\",\"unlocked\":true,\"by\":\"races\",\"races\":2,\"days\":null,\"rankedRaces\":null,\"breedings\":null},"
        + "{\"key\":\"login_bonus\",\"unlocked\":true,\"by\":\"races\",\"races\":2,\"days\":null,\"rankedRaces\":null,\"breedings\":null},"
        + "{\"key\":\"shop\",\"unlocked\":true,\"by\":\"races\",\"races\":3,\"days\":null,\"rankedRaces\":null,\"breedings\":null},"
        + "{\"key\":\"season\",\"unlocked\":false,\"by\":null,\"races\":null,\"days\":null,\"rankedRaces\":8,\"breedings\":null},"
        + "{\"key\":\"breeding\",\"unlocked\":false,\"by\":null,\"races\":8,\"days\":2,\"rankedRaces\":null,\"breedings\":null},"
        + "{\"key\":\"my_stable\",\"unlocked\":false,\"by\":null,\"races\":null,\"days\":6,\"rankedRaces\":null,\"breedings\":null},"
        + "{\"key\":\"stud\",\"unlocked\":false,\"by\":null,\"races\":null,\"days\":null,\"rankedRaces\":null,\"breedings\":3}]}";
    const string Day1Unlocks = "{\"day\":1,\"races\":0,\"rankedRaces\":0,\"breedings\":0,\"features\":[{\"key\":\"race\",\"unlocked\":true,\"by\":\"always\",\"races\":null,\"days\":null,\"rankedRaces\":null,\"breedings\":null},"
        + "{\"key\":\"missions\",\"unlocked\":false,\"by\":null,\"races\":2,\"days\":null,\"rankedRaces\":null,\"breedings\":null},{\"key\":\"login_bonus\",\"unlocked\":false,\"by\":null,\"races\":2,\"days\":null,\"rankedRaces\":null,\"breedings\":null},"
        + "{\"key\":\"shop\",\"unlocked\":false,\"by\":null,\"races\":3,\"days\":null,\"rankedRaces\":null,\"breedings\":null}]}";

    sealed class P
    {
        public bool ConsentRequired = true; public string ConsentedTerms = null; public string Terms = "2026-11-01";
        public string PartnerId = null; public bool GachaUsed = false; public string Horses = "[]";
        public string Deletion = "{\"status\":\"none\",\"requestedAt\":null,\"deleteAt\":null}";
        public string Unlocks = Day1Unlocks; public string LastClaim = null; public int Debt = 0;
        public string Experiments = "{\"assignments\":{},\"values\":{}}";
        public string Json() => "{\"id\":\"u1\",\"wallet\":{\"paid\":100,\"free\":195,\"total\":295,\"debt\":" + Debt + "},"
            + "\"consent\":{\"termsVersion\":" + Q(ConsentedTerms) + ",\"privacyVersion\":" + Q(ConsentedTerms) + ",\"consentedAt\":null,\"current\":{\"termsVersion\":\"" + Terms + "\",\"privacyVersion\":\"" + Terms + "\"},\"required\":" + B(ConsentRequired) + "},"
            + "\"unlocks\":" + Unlocks + ",\"experiments\":" + Experiments + ",\"deletion\":" + Deletion + ","
            + "\"flags\":{\"tutorialGachaUsed\":" + B(GachaUsed) + ",\"partnerHorseId\":" + Q(PartnerId) + "},"
            + "\"loginBonus\":{\"streakDay\":0,\"lastClaimDate\":" + Q(LastClaim) + ",\"beginnerDay\":1},"
            + "\"season\":{\"id\":\"2026-11\",\"classId\":\"C\",\"points\":40},\"profile\":{\"displayName\":\"騎手M\",\"titleId\":null},\"items\":{},\"horses\":" + Horses + "}";
        static string Q(string s) => s == null ? "null" : "\"" + s + "\"";
        static string B(bool b) => b ? "true" : "false";
    }

    const string Draw = "{\"bannerId\":\"tutorial\",\"results\":[{\"templateId\":\"t_yukimi\",\"rarity\":\"R\",\"horseId\":\"h3\"},{\"templateId\":\"t_kurogane\",\"rarity\":\"SSR\",\"horseId\":\"h2\",\"guaranteed\":true},{\"templateId\":\"t_kaze\",\"rarity\":\"SR\",\"horseId\":\"h4\"}],\"pityPoints\":0}";
    const string Missions = "{\"missions\":[{\"id\":\"race3\",\"kind\":\"races\",\"target\":3,\"reward\":{\"freeCoins\":20},\"progress\":3,\"claimed\":false},{\"id\":\"win1\",\"kind\":\"wins\",\"target\":1,\"reward\":{\"freeCoins\":30},\"progress\":1,\"claimed\":false},{\"id\":\"top3x2\",\"kind\":\"top3\",\"target\":2,\"reward\":{\"items\":[{\"itemId\":\"breeding_material\",\"qty\":1}]},\"progress\":1,\"claimed\":false}],"
        + "\"beginner\":{\"completed\":false,\"steps\":[{\"id\":\"bm_scout\",\"step\":1,\"kind\":\"gacha\",\"target\":1,\"progress\":1,\"reward\":{\"freeCoins\":50},\"claimed\":false,\"locked\":false,\"claimable\":true},{\"id\":\"bm_silks\",\"step\":2,\"kind\":\"silks\",\"target\":1,\"progress\":1,\"reward\":{\"freeCoins\":50},\"claimed\":false,\"locked\":true,\"claimable\":false}]},"
        + "\"season\":{\"seasonId\":\"2026-11\",\"missions\":[{\"id\":\"sm_races10\",\"kind\":\"ranked_races\",\"target\":10,\"progress\":6,\"reward\":{\"passXp\":100},\"claimed\":false,\"available\":true,\"claimable\":false},{\"id\":\"sm_promotion\",\"kind\":\"promotion_line\",\"target\":null,\"progress\":0,\"reward\":{\"passXp\":300},\"claimed\":false,\"available\":false,\"claimable\":false}]},"
        + "\"firstWinBonus\":{\"modes\":[\"ranked\"],\"byWin\":[30,20,10],\"winsToday\":1,\"remaining\":2,\"next\":20}}";
    const string Products = "{\"products\":[{\"id\":\"coin_160\",\"kind\":\"coins\",\"name\":\"コイン100\",\"tab\":\"coins\",\"storeType\":\"consumable\",\"priceYen\":160,\"paidCoins\":100,\"autoRenew\":false,\"contents\":[{\"type\":\"paid_coins\",\"qty\":100,\"label\":\"有償コイン100枚\"}],\"firstPurchaseBonus\":{\"coins\":100,\"currency\":\"free\",\"label\":\"はじめての購入時のみ：無償コイン100枚をプレゼント\"},\"oneTime\":false,\"oneTimeScope\":null,\"period\":null,\"noticeKeys\":[\"shop.paid_first\",\"shop.first_purchase_bonus\",\"legal.tokushoho\",\"legal.shikin_kessai\"]},"
        + "{\"id\":\"coin_480\",\"kind\":\"coins\",\"name\":\"コイン310\",\"tab\":\"coins\",\"storeType\":\"consumable\",\"priceYen\":480,\"paidCoins\":310,\"autoRenew\":false,\"contents\":[{\"type\":\"paid_coins\",\"qty\":310,\"label\":\"有償コイン310枚\"}],\"firstPurchaseBonus\":{\"coins\":310,\"currency\":\"free\",\"label\":\"はじめての購入時のみ：無償コイン310枚をプレゼント\"},\"oneTime\":false,\"period\":null,\"noticeKeys\":[\"shop.paid_first\"]},"
        + "{\"id\":\"stable_allowance_30d\",\"kind\":\"allowance\",\"name\":\"厩舎手当（30日）\",\"tab\":\"recommended\",\"storeType\":\"consumable\",\"priceYen\":480,\"paidCoins\":100,\"allowance\":{\"days\":30,\"dailyFreeCoins\":30},\"autoRenew\":false,\"contents\":[{\"type\":\"paid_coins\",\"qty\":100,\"label\":\"有償コイン100枚\"},{\"type\":\"daily_free_coins\",\"qty\":30,\"days\":30,\"total\":900,\"label\":\"30日間、毎日 無償コイン30枚（1日1回受け取り）\"}],\"firstPurchaseBonus\":null,\"oneTime\":false,\"period\":{\"kind\":\"days\",\"days\":30},\"noticeKeys\":[\"shop.no_auto_renew\",\"legal.tokushoho\"]},"
        + "{\"id\":\"season_pass\",\"kind\":\"season_pass\",\"name\":\"シーズンパス\",\"tab\":\"pass\",\"storeType\":\"consumable\",\"priceYen\":1000,\"paidCoins\":0,\"autoRenew\":false,\"contents\":[{\"type\":\"pass_premium\",\"levels\":30,\"label\":\"シーズンパス有料ライン 全30段（各段：無償コイン50枚＋配合素材×1）\"}],\"firstPurchaseBonus\":null,\"oneTime\":false,\"period\":{\"kind\":\"season\"},\"noticeKeys\":[\"shop.no_auto_renew\"]},"
        + "{\"id\":\"promo_pack_B\",\"kind\":\"promotion\",\"name\":\"昇級記念パック（B級）\",\"tab\":\"recommended\",\"storeType\":\"non_consumable\",\"priceYen\":1500,\"paidCoins\":1020,\"once\":true,\"classId\":\"B\",\"autoRenew\":false,\"contents\":[{\"type\":\"paid_coins\",\"qty\":1020,\"label\":\"有償コイン1,020枚\"}],\"firstPurchaseBonus\":null,\"oneTime\":true,\"oneTimeScope\":\"class\",\"period\":null,\"noticeKeys\":[]}],"
        + "\"notices\":{\"shop.paid_first\":\"有償コインから先に使われます\",\"shop.first_purchase_bonus\":\"コインのパックは、はじめて購入したときだけ、同じ枚数の無償コインをプレゼントします（パックごとに1回）\",\"shop.no_auto_renew\":\"自動更新はありません\"},"
        + "\"legalLinks\":[{\"key\":\"legal.tokushoho\",\"title\":\"特定商取引法に基づく表記\"},{\"key\":\"legal.shikin_kessai\",\"title\":\"資金決済法に基づく表示\"},{\"key\":\"shop.paid_first\",\"title\":\"有償コインの使用順\"}],\"notice\":\"有償コインから先に使われます\"}";
    const string Offers = "{\"offers\":[{\"id\":\"starter_pack\",\"productId\":\"starter_pack\",\"touchpoint\":\"T2\",\"placement\":\"popup\",\"reason\":\"first_4th_or_worse\",\"triggeredAt\":1795575600000,\"viewedAt\":null,\"showPopup\":true,\"endsAt\":null,\"remainingDays\":null},"
        + "{\"id\":\"season_pass_2026_11\",\"productId\":\"season_pass\",\"touchpoint\":\"T3\",\"placement\":\"popup\",\"reason\":\"pass_level_up\",\"triggeredAt\":1795575600000,\"viewedAt\":null,\"showPopup\":true,\"endsAt\":1796050800000,\"remainingDays\":6},"
        + "{\"id\":\"stable_allowance_30d\",\"productId\":\"stable_allowance_30d\",\"touchpoint\":\"shop\",\"placement\":\"recommended\",\"reason\":null,\"triggeredAt\":null,\"viewedAt\":null,\"showPopup\":false,\"endsAt\":null,\"remainingDays\":null}],"
        + "\"firstPurchase\":{\"available\":true,\"productIds\":[\"coin_160\"],\"noticeKey\":\"shop.first_purchase_bonus\"},\"allowance\":{\"active\":false,\"claimedToday\":false,\"queued\":null}}";
    const string IntentCoin = "{\"product\":{\"id\":\"coin_160\",\"kind\":\"coins\",\"name\":\"コイン100\",\"priceYen\":160,\"paidCoins\":100,\"contents\":[{\"type\":\"paid_coins\",\"qty\":100,\"label\":\"有償コイン100枚\"}]},\"monthSpentYen\":0,\"monthlyLimitYen\":5000,\"remainingYen\":4840,\"firstPurchaseBonus\":{\"coins\":100,\"currency\":\"free\",\"label\":\"はじめての購入時のみ：無償コイン100枚をプレゼント\"}}";
    const string IntentPass = "{\"product\":{\"id\":\"season_pass\",\"kind\":\"season_pass\",\"name\":\"シーズンパス\",\"priceYen\":1000,\"paidCoins\":0},\"monthSpentYen\":0,\"monthlyLimitYen\":null,\"remainingYen\":null,\"firstPurchaseBonus\":null,\"pass\":{\"seasonId\":\"2026-11\",\"endsAt\":1796050800000,\"remainingDays\":6,\"lastWeek\":true,\"autoRenew\":false,\"levels\":0}}";
    const string Allowance = "{\"active\":true,\"productId\":\"stable_allowance_30d\",\"startDate\":\"2026-11-25\",\"endDate\":\"2026-12-24\",\"day\":1,\"days\":30,\"daysLeft\":30,\"dailyFreeCoins\":30,\"claimedToday\":false,\"claimedDays\":0,\"queued\":null}";
    const string AllowanceClaimed = "{\"freeCoins\":30,\"active\":true,\"productId\":\"stable_allowance_30d\",\"startDate\":\"2026-11-25\",\"endDate\":\"2026-12-24\",\"day\":1,\"days\":30,\"daysLeft\":30,\"dailyFreeCoins\":30,\"claimedToday\":true,\"claimedDays\":1,\"queued\":null,\"wallet\":{\"paid\":100,\"free\":225,\"total\":325,\"debt\":0}}";
    const string SeasonPass = "{\"seasonId\":\"2026-11\",\"level\":11,\"xp\":1120,\"xpPerLevel\":100,\"maxLevel\":30,\"xpToNextLevel\":80,\"racesToNextLevel\":4,\"active\":true,\"expiresAt\":1796050800000,\"seasonEndsAt\":1796050800000,\"remainingDays\":6,\"lastWeek\":true,\"autoRenew\":false,\"boostLevels\":0,\"owned\":[\"season_pass\"],\"purchasable\":[],\"claimed\":{\"free\":[1,2],\"premium\":[1]},\"rewards\":{\"free\":{\"every\":1,\"reward\":{\"freeCoins\":10}},\"premium\":{\"every\":1,\"reward\":{\"freeCoins\":50,\"items\":[{\"itemId\":\"breeding_material\",\"qty\":1}]}}},\"autoGrantAtSeasonEnd\":true,"
        + "\"lastSeason\":{\"seasonId\":\"2026-10\",\"xp\":3000,\"level\":30,\"premium\":true,\"boostXp\":0,\"granted\":{\"free\":[1,2],\"premium\":[1]},\"autoGranted\":{\"free\":[29,30],\"premium\":[29,30]},\"autoFreeCoins\":120,\"at\":1793467800000}}";
    const string SeasonPassFree = "{\"seasonId\":\"2026-11\",\"level\":3,\"xp\":300,\"xpPerLevel\":100,\"maxLevel\":30,\"xpToNextLevel\":100,\"racesToNextLevel\":5,\"active\":false,\"expiresAt\":0,\"seasonEndsAt\":1796050800000,\"remainingDays\":6,\"lastWeek\":true,\"autoRenew\":false,\"boostLevels\":0,\"owned\":[],\"purchasable\":[\"season_pass\",\"season_pass_plus\"],\"claimed\":{\"free\":[],\"premium\":[]},\"rewards\":{\"free\":{\"every\":1,\"reward\":{\"freeCoins\":10}},\"premium\":{\"every\":1,\"reward\":{\"freeCoins\":50}}},\"autoGrantAtSeasonEnd\":true,\"lastSeason\":null}";
    const string DeleteStep1 = "{\"status\":\"confirm_required\",\"confirmToken\":\"del_tok\",\"expiresAt\":1795576200000,\"cancelWindowDays\":14,\"forfeit\":{\"paidCoins\":100,\"freeCoins\":195,\"horses\":8,\"items\":2,\"allowanceDays\":29,\"seasonPass\":true},\"notice\":\"削除を確定すると14日後に…払い戻しはありません。\"}";
    const string DeleteStep2 = "{\"status\":\"scheduled\",\"requestedAt\":1795575600000,\"deleteAt\":1796785200000}";

    static (FakeServer s, GameBackend b, MemoryKeyValueStore kv) Setup(P player, RulesetParams rs, MemoryKeyValueStore kv = null, FakeServer s = null)
    {
        s ??= new FakeServer();
        s.Routes["POST /v1/player/bootstrap"] = _ => Ok(player.Json());
        s.Routes["GET /v1/player"] = _ => Ok(player.Json());
        kv ??= new MemoryKeyValueStore();
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, rs);
        b.InitializeAsync().GetAwaiter().GetResult();
        return (s, b, kv);
    }

    static GameBackend OfflineBackend(RulesetParams rs, MemoryKeyValueStore kv)
    {
        var b = new GameBackend(new GameSettings { OfflineOnly = true }, null, null, kv, rs);
        b.InitializeAsync().GetAwaiter().GetResult();
        return b;
    }

    /// <summary>Runs a tutorial race to the end, whipping at the given remaining metres (like the race screen at 60 fps).</summary>
    static RaceResultModel Ride(IRaceDriver d, params int[] whipAtM)
    {
        var obs = new RaceObserver(d);
        var input = new RaceInput();
        long t = 2_000_000; int k = 0;
        for (int f = 0; f < 60 * 300 && !d.Done; f++)
        {
            var sim = d.Sim;
            if (sim != null && d.PlayerSlot >= 0)
            {
                var me = sim.GetHorse(d.PlayerSlot);
                long rem = (sim.Track.Distance - me.Distance).ToMilli();
                if (!me.Departed && sim.GateOpened) input.Spur();
                else if (me.Departed && k < whipAtM.Length && rem <= whipAtM[k] * 1000L) { input.Spur(); k++; }
                d.Input(input.Collect(me));
            }
            d.Update(t);
            obs.Hud(t);
            t += 16;
        }
        var r = RaceResultModel.Build(d, obs);
        obs.Dispose();
        return r;
    }

    static JsonElement Props(HttpRequest r, int i) => JsonDocument.Parse(r.Body).RootElement.GetProperty("events")[i].GetProperty("props");

    public static async Task Run(Action<bool, string> check, RulesetParams rs)
    {
        Console.WriteLine("== round 8: KPI events (REQ-UXS-030) and game days (REQ-UXS-011)");
        await Analytics(check);
        GameDays(check);
        Console.WriteLine("== round 8: FTUE flow (consent → first race → partner → welcome scout → home), resume after a kill, offline");
        await Ftue(check, rs);
        await FtueOffline(check, rs);
        Console.WriteLine("== round 8: home unlocks, login bonus, missions");
        await HomeAndMissions(check, rs);
        Console.WriteLine("== round 8: shop, offers, purchase confirmation, 厩舎手当");
        await Shop(check, rs);
        await Purchase(check, rs);
        await AllowanceFlow(check, rs);
        Console.WriteLine("== round 8: season pass and account deletion");
        await Pass(check, rs);
        await Deletion(check, rs);
        Console.WriteLine("== round 8 client QA regressions (purchase receipts, FTUE resume, consent sync, deletion guard, KPI once)");
        await QaRun(check, rs);
    }

    // ------------------------------------------------------------------ KPI

    static async Task Analytics(Action<bool, string> check)
    {
        var s = new FakeServer();
        s.Routes["POST /v1/analytics/events"] = _ => Ok("{\"accepted\":7,\"rejected\":0}");
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake" });
        await api.SendAnalyticsAsync("ios", "1.0.0", new[]
        {
            AnalyticsEvent.FeatureUnlock(1, "season_pass"), AnalyticsEvent.OfferView(2, "starter_pack", "T2"), AnalyticsEvent.OfferClick(3, "season_pass_2026_11", "T3"),
            AnalyticsEvent.RaceQuit(4, "tournament", 12_345), AnalyticsEvent.AccountLink(5, "apple"), AnalyticsEvent.FtueStep(6, "race1_win", 2), AnalyticsEvent.FtueStep(7, "consent"),
        });
        var r = s.Sent.Single();
        var events = JsonDocument.Parse(r.Body).RootElement.GetProperty("events");
        check(events[0].GetProperty("name").GetString() == "feature_unlock" && Props(r, 0).GetProperty("feature").GetString() == "season_pass" && Props(r, 0).EnumerateObject().Count() == 1,
            "feature_unlock carries only { feature } (kpi.ts strict schema)");
        check(events[1].GetProperty("name").GetString() == "offer_view" && Props(r, 1).GetProperty("offerId").GetString() == "starter_pack" && Props(r, 1).GetProperty("trigger").GetString() == "T2"
            && events[2].GetProperty("name").GetString() == "offer_click" && Props(r, 2).GetProperty("trigger").GetString() == "T3", "offer_view / offer_click carry { offerId, trigger }");
        check(events[3].GetProperty("name").GetString() == "race_quit" && Props(r, 3).GetProperty("mode").GetString() == "tournament" && Props(r, 3).GetProperty("remainingM").GetInt32() == 10_000,
            "race_quit: tournament mode accepted, remainingM clamped to 10,000");
        check(events[4].GetProperty("name").GetString() == "account_link" && Props(r, 4).GetProperty("provider").GetString() == "apple", "account_link carries { provider }");
        check(Props(r, 5).GetProperty("step").GetString() == "race1_win" && Props(r, 5).GetProperty("index").GetInt32() == 4 && Props(r, 5).GetProperty("value").GetInt32() == 2
            && Props(r, 6).GetProperty("index").GetInt32() == 1 && !Props(r, 6).TryGetProperty("value", out _), "FTUE steps send the index the server checks (position + 1) and the optional value");
        bool threw(Action a) { try { a(); return false; } catch (ArgumentException) { return true; } }
        check(threw(() => AnalyticsEvent.OfferView(0, "x", "shop")) && threw(() => AnalyticsEvent.RaceQuit(0, "derby", 1)) && threw(() => AnalyticsEvent.AccountLink(0, "line"))
            && threw(() => AnalyticsEvent.FtueStep(0, "first_ride")) && threw(() => AnalyticsEvent.FeatureUnlock(0, "has space")), "values outside the server's enums are refused on the device");
    }

    // ------------------------------------------------------------------ game days

    static void GameDays(Action<bool, string> check)
    {
        long lastMsNov30 = SeasonEnd - 1; // 2026-11-30 23:59:59.999 JST
        check(GameDay.Key(lastMsNov30) == "2026-11-30" && GameDay.Key(SeasonEnd) == "2026-12-01", "game day rolls over at 00:00 JST (15:00 UTC)");
        check(GameDay.DaysUntil(SeasonEnd, lastMsNov30) == 1 && GameDay.DaysUntil(SeasonEnd, SeasonEnd) == 0 && GameDay.DaysUntil(SeasonEnd, SeasonEnd + 1) == 0,
            "last instant of the season = day 1 (今日まで); at the end 0");
        long nov25Start = SeasonEnd - 6 * GameDay.DayMs, nov24Last = nov25Start - 1;
        check(GameDay.DaysUntil(SeasonEnd, nov25Start) == 6 && GameDay.DaysUntil(SeasonEnd, nov24Last) == 7 && GameDay.DaysUntil(SeasonEnd, Nov25Noon) == 6,
            "remaining days change exactly at JST midnight (server gameDaysUntil)");
        check(GameDay.UntilLabel(SeasonEnd) == "11月30日 23:59まで" && GameDay.RemainingLabel(1) == "今日まで" && GameDay.RemainingLabel(6) == "あと6日" && GameDay.RemainingLabel(0) == null,
            "labels: 「11月30日 23:59まで」, 「あと6日」, 「今日まで」, none after the end");
        check(GameDay.DaysBetweenKeys("2026-11-25", "2026-12-24") == 29, "day keys across the month boundary");
    }

    // ------------------------------------------------------------------ FTUE

    static async Task Ftue(Action<bool, string> check, RulesetParams rs)
    {
        var player = new P();
        var (s, b, kv) = Setup(player, rs);
        var kpi = new List<AnalyticsEvent>();
        var flow = new OnboardingFlow(b, kpi.Add, () => now);
        check(await flow.ResumeAsync() == FtueStep.Consent && flow.ConsentRequired && !flow.ConsentUpdated, "new player: 同意してはじめる first");

        // CONSENT_VERSION_MISMATCH: refetch, send the new versions, the screen does not change
        s.Routes["POST /v1/player/consent"] = Seq(() => { player.Terms = "2026-11-20"; return Err(409, "CONSENT_VERSION_MISMATCH"); },
            () => { player.ConsentRequired = false; player.ConsentedTerms = player.Terms; return Ok("{\"termsVersion\":\"2026-11-20\",\"privacyVersion\":\"2026-11-20\",\"consentedAt\":1,\"current\":{\"termsVersion\":\"2026-11-20\",\"privacyVersion\":\"2026-11-20\"},\"required\":false}"); });
        var c = await flow.AcceptConsentAsync();
        var bodies = s.To("POST", "/v1/player/consent").Select(r => r.Body).ToList();
        check(c.Ok && bodies.Count == 2 && bodies[0].Contains("2026-11-01") && bodies[1].Contains("2026-11-20") && flow.Screen == FtueStep.FirstRace,
            "consent: a version bump while on the title is refetched and re-sent once, then the first race");
        check(kpi.Count == 1 && kpi[0].Name == "tutorial_step", "KPI consent once");

        // first race: lost twice, killed, resumed, the 3rd attempt is assisted to a win
        var r1 = Ride(flow.StartFirstRace());
        check(!flow.FinishFirstRace(r1).Ok && flow.Screen == FtueStep.FirstRace && r1.TutorialRetry && r1.PrimaryAction == "もう一度", "first race lost (no whip): もう一度, still on the race");
        var r2 = Ride(flow.StartFirstRace());
        flow.FinishFirstRace(r2);
        var (_, b2, _) = Setup(player, rs, kv, s); // app killed and relaunched
        var flow2 = new OnboardingFlow(b2, kpi.Add, () => now);
        check(await flow2.ResumeAsync() == FtueStep.FirstRace && b2.TutorialAttempts == 2, "relaunch during the retries: back on the first race, attempts kept (2)");
        var r3 = Ride(flow2.StartFirstRace());
        check(r3.Won && flow2.FinishFirstRace(r3).Ok && flow2.Screen == FtueStep.Naming, "3rd attempt assisted to a win → naming");
        check(kpi.Count(e => e.Name == "tutorial_step") == 3, "KPI race1_start sent once over three attempts, then race1_win (3 events so far)");

        // naming: local check, a timeout keeps the key across a kill, a refused name drops it
        int sentBefore = s.Sent.Count;
        check(!(await flow2.SubmitNameAsync("abc")).Ok && s.Sent.Count == sentBefore && flow2.Message.Contains("カタカナ"), "a non-kana name is caught on the device (nothing sent)");
        s.Routes["POST /v1/player/partner"] = Seq(() => Err(503, "INTERNAL"));
        var n1 = await flow2.SubmitNameAsync("ハヤテ");
        string keptKey = kv.Get(GameBackend.KeyPartnerIdem);
        check(!n1.Ok && !string.IsNullOrEmpty(keptKey) && flow2.Screen == FtueStep.Naming && n1.Message.StartsWith("通信に失敗"), "partner grant without an answer: still naming, key kept, a Japanese sentence");
        var (_, b3, _) = Setup(player, rs, kv, s);
        var flow3 = new OnboardingFlow(b3, kpi.Add, () => now);
        check(await flow3.ResumeAsync() == FtueStep.Naming, "relaunch after the timeout: naming again (not the race)");
        s.Routes["POST /v1/player/partner"] = Seq(() => Err(400, "NG_NAME"));
        var ng = await flow3.SubmitNameAsync("ハヤテ");
        var keys = s.To("POST", "/v1/player/partner").Select(r => r.Headers["idempotency-key"]).ToList();
        check(!ng.Ok && keys.Count == 2 && keys[0] == keys[1] && keys[0] == keptKey && string.IsNullOrEmpty(kv.Get(GameBackend.KeyPartnerIdem)) && ng.Message.Contains("使用できません"),
            "the retry after the relaunch reuses the key; NG_NAME (definite) drops it");
        s.Routes["POST /v1/player/partner"] = r => { player.PartnerId = "h1"; player.Horses = "[" + Horse1 + "]"; return Ok("{\"horse\":" + Horse1 + "}"); };
        var ok = await flow3.SubmitNameAsync("アイボウ");
        var last = s.To("POST", "/v1/player/partner").Last();
        check(ok.Ok && last.Headers["idempotency-key"] != keptKey && flow3.Screen == FtueStep.FirstScout && b3.Partner?.Id == "h1" && s.Count("POST", "/v1/gacha/tutorial") == 0,
            "the partner is granted (POST /v1/player/partner, a fresh key) and NO gacha was drawn while naming");

        // welcome scout: no answer, killed, the same key gets the same pulls; shown in draw order
        s.Routes["POST /v1/gacha/tutorial"] = Seq(() => Err(503, "INTERNAL"));
        check(!(await flow3.DrawFirstScoutAsync()).Ok && !string.IsNullOrEmpty(kv.Get(GameBackend.KeyFirstScoutIdem)), "welcome scout without an answer keeps its key");
        player.GachaUsed = true; // the server did draw
        var (_, b4, _) = Setup(player, rs, kv, s);
        var flow4 = new OnboardingFlow(b4, kpi.Add, () => now);
        check(await flow4.ResumeAsync() == FtueStep.FirstScout, "relaunch: the draw happened but was never shown → the scout screen again (not home)");
        s.Routes["POST /v1/gacha/tutorial"] = _ => Ok(Draw);
        var d = await flow4.DrawFirstScoutAsync();
        var scoutKeys = s.To("POST", "/v1/gacha/tutorial").Select(r => r.Headers["idempotency-key"]).Distinct().Count();
        check(d.Ok && scoutKeys == 1 && flow4.Pulls.Select(p => p.Rarity).SequenceEqual(new[] { "R", "SSR", "SR" }), "the same key returns the same pulls, in draw order (not sorted by rarity)");
        flow4.FinishFirstScout();
        check(flow4.Screen == FtueStep.Home && string.IsNullOrEmpty(kv.Get(GameBackend.KeyFirstScoutIdem)), "after the reveal: home, key cleared");
        flow4.EnterHome();
        var steps = kpi.Where(e => e.Name == "tutorial_step").Count();
        check(flow4.Screen == FtueStep.Done && steps == 6, "FTUE done; KPI steps consent, race1_start, race1_win, named, gacha_done, home sent once each (" + steps + ", whip is the screen's)");

        // reinstall: device state lost, the server knows the partner and the draw
        var fresh = new MemoryKeyValueStore();
        var (_, b5, _) = Setup(player, rs, fresh, s);
        var flow5 = new OnboardingFlow(b5, null, () => now);
        check(await flow5.ResumeAsync() == FtueStep.Home, "reinstall with partner + welcome scout done on the server: straight home (no replayed tutorial)");

        // version bump for a finished player: consent again, then back to where they were
        player.ConsentRequired = true; player.Terms = "2026-12-01";
        await b5.RefreshAsync();
        check(flow5.Screen == FtueStep.Consent && flow5.ConsentUpdated, "terms version raised: 「規約が更新されました」 before home");
        s.Routes["POST /v1/player/consent"] = _ => { player.ConsentRequired = false; player.ConsentedTerms = player.Terms; return Ok("{\"termsVersion\":\"2026-12-01\",\"privacyVersion\":\"2026-12-01\",\"current\":{\"termsVersion\":\"2026-12-01\",\"privacyVersion\":\"2026-12-01\"},\"required\":false}"); };
        await flow5.AcceptConsentAsync();
        check(flow5.Screen == FtueStep.Home, "after re-consent: back home");

        // a pre-round-8 player (free 10-pull drawn by the old naming flow, no granted partner) is not sent back into the FTUE
        var old = new P { ConsentRequired = false, ConsentedTerms = "2026-11-01", GachaUsed = true, Horses = "[" + Horse2 + "]" };
        var (_, b6, _) = Setup(old, rs);
        check(await new OnboardingFlow(b6, null, () => now).ResumeAsync() == FtueStep.Home, "an existing player from before the partner grant goes home");
    }

    static async Task FtueOffline(Action<bool, string> check, RulesetParams rs)
    {
        var kv = new MemoryKeyValueStore();
        var off = OfflineBackend(rs, kv);
        var flow = new OnboardingFlow(off, null, () => now);
        check(await flow.ResumeAsync() == FtueStep.Consent, "offline first launch: the consent screen still comes first");
        check((await flow.AcceptConsentAsync()).Ok && flow.HasPendingConsent && flow.Screen == FtueStep.FirstRace, "offline consent is kept on the device; the tutorial starts (device engine)");
        Ride(flow.StartFirstRace()); Ride(flow.StartFirstRace());
        var won = Ride(flow.StartFirstRace());
        flow.FinishFirstRace(won);
        check((await flow.SubmitNameAsync("イッセン")).Ok && off.PendingPartnerName == "イッセン" && flow.Screen == FtueStep.FirstScout, "offline naming is kept for the grant");
        check((await flow.DrawFirstScoutAsync()).Ok && flow.Pulls.Count == 0, "offline welcome scout: the fixed preview (nothing drawn)");

        // back online: consent and the partner are sent on the next launch
        var player = new P();
        var s = new FakeServer();
        s.Routes["POST /v1/player/consent"] = _ => { player.ConsentRequired = false; player.ConsentedTerms = player.Terms; return Ok("{\"termsVersion\":\"2026-11-01\",\"privacyVersion\":\"2026-11-01\",\"current\":{\"termsVersion\":\"2026-11-01\",\"privacyVersion\":\"2026-11-01\"},\"required\":false}"); };
        s.Routes["POST /v1/player/partner"] = r => { player.PartnerId = "h1"; player.Horses = "[" + Horse1.Replace("アイボウ", "イッセン") + "]"; return Ok("{\"horse\":" + Horse1.Replace("アイボウ", "イッセン") + "}"); };
        s.Routes["POST /v1/gacha/tutorial"] = _ => { player.GachaUsed = true; return Ok(Draw); };
        var (_, b, _) = Setup(player, rs, kv, s);
        var online = new OnboardingFlow(b, null, () => now);
        var screen = await online.ResumeAsync();
        check(s.Count("POST", "/v1/player/consent") == 1 && s.Count("POST", "/v1/player/partner") == 1 && s.To("POST", "/v1/player/partner")[0].Body.Contains("イッセン") && !online.HasPendingConsent && b.PendingPartnerName == null,
            "back online: the offline consent and partner name are sent once");
        check(screen == FtueStep.FirstScout && (await online.DrawFirstScoutAsync()).Ok && online.Pulls.Count == 3, "…and the real welcome scout is drawn now (it was only previewed offline)");

        // a name chosen offline that the server refuses: back to naming with the sentence, the offline name forgotten
        var kv2 = new MemoryKeyValueStore();
        var off2 = OfflineBackend(rs, kv2);
        var f2 = new OnboardingFlow(off2, null, () => now);
        await f2.AcceptConsentAsync();
        Ride(f2.StartFirstRace()); Ride(f2.StartFirstRace()); f2.FinishFirstRace(Ride(f2.StartFirstRace()));
        await f2.SubmitNameAsync("ゲンキ");
        var p2 = new P { ConsentRequired = false, ConsentedTerms = "2026-11-01" };
        var s2 = new FakeServer();
        s2.Routes["POST /v1/player/partner"] = _ => Err(400, "NG_NAME");
        var (_, b2, _) = Setup(p2, rs, kv2, s2);
        var on2 = new OnboardingFlow(b2, null, () => now);
        check(await on2.ResumeAsync() == FtueStep.Naming && b2.PendingPartnerName == null && on2.Message.Contains("使用できません"), "an offline name refused by the server: back to naming, asked again");
    }

    // ------------------------------------------------------------------ home / login bonus / missions

    static async Task HomeAndMissions(Action<bool, string> check, RulesetParams rs)
    {
        var player = new P { ConsentRequired = false, ConsentedTerms = "2026-11-01", PartnerId = "h1", GachaUsed = true, Horses = "[" + Horse1 + "]" };
        var (s, b, kv) = Setup(player, rs);
        var gate = new UnlockGate(b);
        check(gate.IsUnlocked("race") && gate.IsUnlocked("scout") && !gate.IsUnlocked("missions") && !gate.IsUnlocked("shop"), "day 1: レース・相棒・スカウト・厩舎 only");
        check(gate.LockLabel("shop") == "あと3戦で開放" && gate.LockLabel("missions") == "あと2戦で開放", "lock captions from the server thresholds: 「あと3戦で開放」");
        player.Unlocks = AllUnlocks; await b.RefreshAsync();
        check(gate.LockLabel("breeding") == "2日目 または あと2戦で開放" && gate.LockLabel("my_stable") == "6日目に開放" && gate.LockLabel("stud") == "配合あと3回で開放" && gate.LockLabel("season") == "初心者マッチあと2戦で開放",
            "any-of conditions: 「2日目 または あと2戦で開放」, 「6日目に開放」, 「配合あと3回で開放」");
        var kpi = new List<AnalyticsEvent>();
        var fresh = gate.TakeNewlyUnlocked(kpi.Add, now);
        check(fresh.SequenceEqual(new[] { "missions", "login_bonus", "shop" }) && kpi.Count == 3 && kpi.All(e => e.Name == "feature_unlock") && gate.TakeNewlyUnlocked(kpi.Add, now).Count == 0 && kpi.Count == 3,
            "newly opened features are reported once (guide + KPI feature_unlock), never again");
        var offGate = new UnlockGate(OfflineBackend(rs, kv));
        check(offGate.IsUnlocked("shop") && !offGate.IsUnlocked("breeding") && offGate.IsUnlocked("stable"), "offline: the last known unlocks are kept");

        // login bonus: automatic, keyed per game day
        s.Routes["POST /v1/rewards/login-bonus"] = Seq(() => Err(503, "INTERNAL"),
            () => { player.LastClaim = "2026-11-25"; return Ok("{\"day\":2,\"track\":\"beginner\",\"reward\":{\"day\":2,\"broodmare\":\"t_broodmare\"},\"beginnerDaysLeft\":5}"); });
        var lb = new LoginBonusModel(b, () => now);
        check(!await lb.AutoClaimAsync() && lb.Message != null && !string.IsNullOrEmpty(kv.Get(LoginBonusModel.KeyPending)), "login bonus without an answer: no toast, key kept");
        check(await lb.AutoClaimAsync() && lb.Toast == "はじめての7日間 2日目：繁殖牝馬1頭" && lb.ClaimedToday, "retry → 「はじめての7日間 2日目：繁殖牝馬1頭」 toast");
        var lbKeys = s.To("POST", "/v1/rewards/login-bonus").Select(r => r.Headers["idempotency-key"]).ToList();
        check(lbKeys.Count == 2 && lbKeys[0] == lbKeys[1], "the retry reused the idempotency key");
        check(!await lb.AutoClaimAsync() && s.Count("POST", "/v1/rewards/login-bonus") == 2, "already claimed this game day: nothing is sent");
        long tomorrow = SeasonEnd - 5 * GameDay.DayMs; // 2026-11-26 00:00 JST
        var lbNext = new LoginBonusModel(b, () => tomorrow);
        s.Routes["POST /v1/rewards/login-bonus"] = _ => Ok("{\"day\":3,\"reward\":{\"freeCoins\":10}}");
        check(await lbNext.AutoClaimAsync() && lbNext.Toast == "ログインボーナス 3日目：無償コイン10枚" && s.To("POST", "/v1/rewards/login-bonus").Last().Headers["idempotency-key"] != lbKeys[0],
            "at JST midnight the next day's bonus is claimed with a new key (normal track wording)");

        // mission board
        s.Routes["GET /v1/missions"] = _ => Ok(Missions);
        var m = new MissionBoardModel(b, () => now);
        await m.LoadAsync();
        check(m.DailyLine == "ミッション 2/3" && m.FirstWinLine == "初勝利ボーナス 残り2回（次は20コイン）" && m.NextBeginner?.Id == "bm_scout" && m.Season.Count == 1,
            "board: daily 2/3, first-win bonus line, next beginner step, unavailable season missions hidden");
        int before = s.Sent.Count;
        var locked = await m.ClaimAsync("bm_silks");
        check(!locked.Ok && s.Sent.Count == before && locked.Message.Contains("前の段"), "a locked beginner step is refused on the device (prevents NOT_ELIGIBLE)");
        check(!(await m.ClaimAsync("top3x2")).Ok && s.Sent.Count == before, "an unfinished mission has no claim");
        s.Routes["POST /v1/missions/race3/claim"] = Seq(() => Err(503, "INTERNAL"), () => Ok("{\"freeCoins\":20}"));
        var c1 = await m.ClaimAsync("race3");
        var c2 = await m.ClaimAsync("race3");
        var mk = s.To("POST", "/v1/missions/race3/claim").Select(r => r.Headers["idempotency-key"]).ToList();
        check(!c1.Ok && c2.Ok && mk.Count == 2 && mk[0] == mk[1] && c2.Message == "受け取りました：無償コイン20枚", "mission claim retry reuses its key; reward shown");
        s.Routes["POST /v1/missions/win1/claim"] = _ => Err(409, "ALREADY_CLAIMED");
        var dup = await m.ClaimAsync("win1");
        check(!dup.Ok && dup.Message == "受取済みです。" && string.IsNullOrEmpty(kv.Get(MissionBoardModel.KeyPendingClaim + ":win1:" + GameDay.Key(now))), "ALREADY_CLAIMED: refreshed, key dropped");

        var home = new HomeModel(b, null, () => now);
        await home.LoadAsync();
        check(home.PrimaryLabel == "レースへ" && home.TodayLines.Contains("ミッション 2/3") && home.TodayLines.Any(l => l.StartsWith("初心者ミッション")) && home.DeletionBanner == null && home.RaceEnabled,
            "home: レースへ, today's list (missions, beginner step), no deletion banner");
        player.Experiments = "{\"assignments\":{\"ab_home\":\"b\"},\"values\":{\"homePrimaryButton\":\"ranked_promotion\",\"firstWinBonus\":false}}";
        await b.RefreshAsync();
        check(home.PrimaryLabel.StartsWith("ランク戦") && home.Missions.FirstWinLine == null, "A/B: the ranked-promotion button and hidden first-win bonus follow the server values");
    }

    // ------------------------------------------------------------------ shop

    static async Task Shop(Action<bool, string> check, RulesetParams rs)
    {
        var player = new P { ConsentRequired = false, ConsentedTerms = "2026-11-01", PartnerId = "h1", GachaUsed = true, Horses = "[" + Horse1 + "]", Unlocks = AllUnlocks };
        var (s, b, kv) = Setup(player, rs);
        s.Routes["GET /v1/shop/products?mine=1"] = _ => Ok(Products);
        s.Routes["GET /v1/shop/offers"] = _ => Ok(Offers);
        s.Routes["POST /v1/shop/offers/starter_pack/view"] = _ => Ok("{\"offerId\":\"starter_pack\",\"viewedAt\":1796008800000}");
        var kpi = new List<AnalyticsEvent>();
        long t = now;
        var shop = new ShopModel(b, kpi.Add, () => t);
        await shop.LoadAsync();
        var coins = shop.Cards("coins");
        check(coins.Count == 2 && coins[0].BonusLabel == "はじめての購入時のみ：無償コイン100枚をプレゼント" && coins[1].BonusLabel == null && coins[0].Lines.SequenceEqual(new[] { "有償コイン100枚" }),
            "coin cards: server contents; the bonus line only on packs that still have it for this player (T1 productIds)");
        check(shop.WordingProblems().Count == 0 && shop.Cards("coins").Concat(shop.Cards("recommended")).Concat(shop.Cards("pass")).All(c => !(c.BonusLabel ?? "").Contains("倍")), "no 「倍」 / ×2 / お得 / 通常価格 anywhere in the shop's texts");
        check(shop.PaidLine == "有償コイン 100" && shop.FreeLine == "無償コイン 195" && shop.PaidFirstNote == "有償コインから先に使われます" && shop.FirstPurchaseNote.StartsWith("コインのパックは、はじめて"),
            "wallet on two lines, paid-first note, the T1 explanation");
        check(shop.LegalLinks.Select(l => l.Title).SequenceEqual(new[] { "特定商取引法に基づく表記", "資金決済法に基づく表示", "有償コインの使用順" }), "legal links at the bottom (特商法・資金決済法・使用順)");
        var rec = shop.Cards("recommended");
        check(rec.Count == 1 && rec[0].Id == "stable_allowance_30d" && rec[0].PeriodText == "30日間・自動更新なし" && rec[0].Notices.Contains("自動更新はありません"), "おすすめ: 厩舎手当 with its period; the promotion pack stays hidden without its T4 offer");
        check(shop.Cards("pass")[0].PeriodText == "シーズン終了まで（11月30日 23:59まで）・自動更新なし", "pass card: the real season end, no auto-renew");
        check(shop.PopupFor(OfferContext.PassScreen)?.Id == "season_pass_2026_11" && shop.PopupFor(OfferContext.AfterPromotion) == null, "offer contexts: T3 on the pass screen, nothing for a promotion that did not happen");
        var starter = shop.PopupFor(OfferContext.AfterResultClosed);
        check(starter?.Id == "starter_pack", "T2 starter sheet after the result screen closed");
        await shop.MarkShownAsync(starter);
        check(s.Count("POST", "/v1/shop/offers/starter_pack/view") == 1 && kpi.Count == 1 && kpi[0].Name == "offer_view" && shop.PopupFor(OfferContext.AfterResultClosed) == null, "shown once: marked viewed on the server, KPI offer_view, never again");
        await shop.LoadAsync(); // the server still lists it (e.g. the view call was lost) — the device remembers
        check(shop.PopupFor(OfferContext.AfterResultClosed) == null, "a refetch does not bring the sheet back");
        check(shop.Click(starter) == "starter_pack" && kpi.Last().Name == "offer_click", "tap-through: KPI offer_click, opens the product");
        var pass = shop.LiveOffers.First(o => o.Id == "season_pass_2026_11");
        check(shop.Countdown(pass) == "あと6日（11月30日 23:59まで）", "season offer: real end, 「あと6日」 at noon on Nov 25");
        t = SeasonEnd - 1;
        check(shop.Countdown(pass) == "今日まで（11月30日 23:59まで）" && shop.LiveOffers.Any(o => o.Id == pass.Id), "last minute of the season: 「今日まで」");
        t = SeasonEnd;
        check(shop.LiveOffers.All(o => o.Id != pass.Id) && shop.PopupFor(OfferContext.PassScreen) == null && shop.Countdown(pass) == null, "at 00:00 JST Dec 1 the season offer is gone (no stale timer)");

        // a server label with multiplier wording would be caught
        s.Routes["GET /v1/shop/products?mine=1"] = _ => Ok(Products.Replace("無償コイン310枚をプレゼント", "2倍！"));
        await shop.LoadAsync();
        check(shop.WordingProblems().Count == 0, "a pack without its bonus for this player does not show the label at all");
        s.Routes["GET /v1/shop/products?mine=1"] = _ => Ok(Products.Replace("無償コイン100枚をプレゼント", "2倍！"));
        await shop.LoadAsync();
        check(shop.WordingProblems().Contains("はじめての購入時のみ：2倍！"), "WordingProblems flags 「倍」 if the server data ever had it");

        // deletion pending: offers refused, every buy button off, no sheet
        player.Deletion = DeleteStep2;
        await b.RefreshAsync();
        s.Routes["GET /v1/shop/offers"] = _ => Err(403, "DELETION_PENDING");
        var blocked = new ShopModel(b, kpi.Add, () => now);
        await blocked.LoadAsync();
        check(blocked.DeletionPending && !blocked.CanPurchase && blocked.Cards("coins").All(c => !c.Purchasable && c.DisabledReason == blocked.DeletionBanner) && blocked.PopupFor(OfferContext.AfterResultClosed) == null
            && blocked.DeletionBanner == "アカウント削除の予定があります（12月9日）。取り消すと使えます" && s.Count("GET", "/v1/shop/offers") == 4,
            "deletion pending: banner with the date, all buy buttons disabled, no offer sheet, offers not even requested");
        player.Deletion = "{\"status\":\"none\"}"; player.Debt = 120;
        await b.RefreshAsync();
        var debt = new ShopModel(b, null, () => now);
        s.Routes["GET /v1/shop/offers"] = _ => Ok(Offers);
        await debt.LoadAsync();
        check(!debt.CanPurchase && debt.DebtLine.StartsWith("未精算の返金 120") && debt.Cards("coins").All(c => !c.Purchasable), "unsettled refund: buying stops with the reason");
        var offline = new ShopModel(OfflineBackend(rs, new MemoryKeyValueStore()));
        await offline.LoadAsync();
        check(offline.Message == UxText.Offline && !offline.CanPurchase, "offline shop: 「オフラインです…」, nothing to buy");
    }

    static async Task Purchase(Action<bool, string> check, RulesetParams rs)
    {
        var player = new P { ConsentRequired = false, ConsentedTerms = "2026-11-01", PartnerId = "h1", GachaUsed = true, Horses = "[" + Horse1 + "]", Unlocks = AllUnlocks };
        var (s, b, kv) = Setup(player, rs);
        bool ageSet = false, guardian = false;
        s.Routes["POST /v1/shop/purchase-intent"] = r => r.Body.Contains("season_pass") ? Ok(IntentPass) : !ageSet ? Err(403, "AGE_REQUIRED") : !guardian ? Err(403, "GUARDIAN_CONSENT_REQUIRED") : Ok(IntentCoin);
        s.Routes["PUT /v1/player/age"] = r => { ageSet = true; guardian = r.Body.Contains("\"guardianConsent\":true"); return Ok("{\"age\":14,\"band\":\"u16\",\"monthlyLimitYen\":5000}"); };
        var kpi = new List<AnalyticsEvent>();
        var pc = new PurchaseConfirmModel(b, kpi.Add, () => now);
        check(await pc.OpenAsync("coin_160") == PurchaseStage.NeedsBirthMonth && pc.Message == "生年月を入力してください。", "first purchase: the birth month is asked only because the server said AGE_REQUIRED");
        check(await pc.SubmitBirthMonthAsync(2012, 13) == PurchaseStage.NeedsBirthMonth && s.Count("PUT", "/v1/player/age") == 0, "a month outside 1–12 is caught on the device");
        check(await pc.SubmitBirthMonthAsync(2012, 5) == PurchaseStage.NeedsGuardian && s.To("PUT", "/v1/player/age")[0].Body.Contains("\"guardianConsent\":false"), "under 18: the guardian step appears only now (after the birth month)");
        check(await pc.SubmitGuardianConsentAsync(true) == PurchaseStage.Ready && pc.Lines.Contains("はじめての購入時のみ：無償コイン100枚をプレゼント") && pc.Lines.Contains("今月あと ¥4,840 まで購入できます"),
            "guardian consent → ready: price, contents, the bonus line, this month's remaining limit");
        var pc2 = new PurchaseConfirmModel(b, kpi.Add, () => now);
        await pc2.OpenAsync("season_pass");
        check(pc2.Stage == PurchaseStage.Ready && pc2.Lines.Contains("このパスは6日で終わります") && pc2.Lines.Contains("自動更新なし") && s.Count("PUT", "/v1/player/age") == 2, "pass in its last week: 「このパスは6日で終わります」・自動更新なし; no second birth-month question");
        s.Routes["POST /v1/shop/purchase-intent"] = _ => Err(403, "AGE_LIMIT_EXCEEDED");
        check(await new PurchaseConfirmModel(b).OpenAsync("coin_160") == PurchaseStage.Blocked, "AGE_LIMIT_EXCEEDED blocks with one sentence");
        s.Routes["POST /v1/shop/purchase-intent"] = _ => Ok(IntentCoin);

        // store: cancelled → back; purchased but no answer → pending with the receipt kept; next launch re-sends it
        var buy = new PurchaseConfirmModel(b, kpi.Add, () => now);
        await buy.OpenAsync("coin_160");
        check(buy.BeginStore() && await buy.StoreFinishedAsync(StoreOutcome.Cancelled) == PurchaseStage.Ready, "store cancelled → back to the confirmation");
        buy.BeginStore();
        check(await buy.StoreFinishedAsync(StoreOutcome.Failed) == PurchaseStage.StoreFailed && buy.Message == "購入は完了していません", "store failure: 「購入は完了していません」 + retry");
        s.Routes["POST /v1/shop/purchase"] = Seq(() => Err(503, "INTERNAL"), () => Ok("{\"record\":{\"txId\":\"tx1\",\"productId\":\"coin_160\"},\"duplicate\":true,\"wallet\":{\"paid\":200,\"free\":295,\"total\":495,\"debt\":0}}"));
        check(await buy.StoreFinishedAsync(StoreOutcome.Purchased, StorePlatform.Fake, "rcpt-1") == PurchaseStage.Pending && buy.HasPendingReceipt && buy.Message == UxText.PurchasePending,
            "purchased but the grant got no answer: 「確認中…」, receipt kept on the device");
        var relaunch = new PurchaseConfirmModel(b, kpi.Add, () => now);
        check(await relaunch.ResumePendingAsync() == PurchaseStage.Completed && !relaunch.HasPendingReceipt && s.To("POST", "/v1/shop/purchase").All(r => r.Body.Contains("rcpt-1")), "the next launch re-sends the same receipt (server de-duplicates) → completed");
        check(kpi.Select(e => e.Name).Distinct().SequenceEqual(new[] { "purchase_flow" }) && kpi.Count == 6, "purchase_flow KPI: open×3, cancel, fail, store_success");

        player.Deletion = DeleteStep2; await b.RefreshAsync();
        int n = s.Count("POST", "/v1/shop/purchase-intent");
        var del = new PurchaseConfirmModel(b);
        check(await del.OpenAsync("coin_160") == PurchaseStage.Blocked && del.Message.StartsWith("アカウント削除の予定") && s.Count("POST", "/v1/shop/purchase-intent") == n && !del.BeginStore(),
            "deletion pending: the confirmation is blocked before any request; the store cannot open");
    }

    static async Task AllowanceFlow(Action<bool, string> check, RulesetParams rs)
    {
        var player = new P { ConsentRequired = false, PartnerId = "h1", GachaUsed = true, Horses = "[" + Horse1 + "]", Unlocks = AllUnlocks };
        var (s, b, kv) = Setup(player, rs);
        bool claimed = false;
        s.Routes["GET /v1/shop/allowance"] = _ => Ok(claimed ? AllowanceClaimed : Allowance);
        s.Routes["POST /v1/shop/allowance/claim"] = Seq(() => Err(503, "INTERNAL"), () => { claimed = true; return Ok(AllowanceClaimed); });
        long t = now;
        var a = new AllowanceModel(b, () => t);
        await a.LoadAsync();
        check(a.CanClaim && a.StatusLine == "厩舎手当 1/30日目・残り30日（12月24日まで）", "allowance status from the server (game-day dates)");
        var r1 = await a.ClaimAsync();
        var r2 = await a.ClaimAsync();
        var keys = s.To("POST", "/v1/shop/allowance/claim").Select(r => r.Headers["idempotency-key"]).ToList();
        check(!r1.Ok && r2.Ok && keys.Count == 2 && keys[0] == keys[1] && r2.Message == "無償コイン30枚を受け取りました" && !a.CanClaim, "claim retry reuses the key (paid once); then claimed today");
        check(!(await a.ClaimAsync()).Ok && s.Count("POST", "/v1/shop/allowance/claim") == 2 && a.Message.Contains("明日 0:00"), "a second claim the same game day is refused on the device");
        t = SeasonEnd - 5 * GameDay.DayMs - 1; // 23:59:59.999 JST on Nov 25
        check(!a.Stale, "still the same game day one millisecond before midnight");
        t += 1;
        check(a.Stale && !a.CanClaim, "at 00:00 JST the view is stale: refetch before claiming");
        player.Deletion = DeleteStep2; await b.RefreshAsync();
        var blocked = new AllowanceModel(b, () => t);
        await blocked.LoadAsync();
        int n = s.Count("POST", "/v1/shop/allowance/claim");
        check(!blocked.CanClaim && !(await blocked.ClaimAsync()).Ok && s.Count("POST", "/v1/shop/allowance/claim") == n, "deletion pending: the allowance claim is blocked without a request");
    }

    // ------------------------------------------------------------------ pass / deletion

    static async Task Pass(Action<bool, string> check, RulesetParams rs)
    {
        var player = new P { ConsentRequired = false, PartnerId = "h1", GachaUsed = true, Horses = "[" + Horse1 + "]", Unlocks = AllUnlocks };
        var (s, b, kv) = Setup(player, rs);
        s.Routes["GET /v1/season-pass"] = _ => Ok(SeasonPass);
        long t = now;
        var p = new SeasonPassModel(b, () => t);
        await p.LoadAsync();
        var rows = p.Rows;
        check(rows.Count == 30 && rows[0].FreeClaimed && !rows[0].FreeClaimable && rows[2].FreeClaimable && rows[1].PremiumClaimable && rows[11].Locked && !rows[11].FreeClaimable,
            "30 levels from the server; claimed / claimable / locked per cell");
        check(p.XpLine == "Lv.11  次まで80XP（あと4戦）" && p.PeriodLine == "11月30日 23:59まで・自動更新なし" && p.PrimaryAction == "まとめて受け取る" && rows[0].PremiumText == "無償コイン50枚・breeding_material×1",
            "XP line, real end, no auto-renew, まとめて受け取る; rewards from the server values");
        check(p.LastSeasonNote == "前のシーズンで受け取っていなかった報酬（4件）を自動で受け取りました", "last season's automatic grant is announced");
        s.Routes["POST /v1/season-pass/claim"] = r => r.Body.Contains("\"level\":5") && r.Body.Contains("free") ? Err(409, "ALREADY_CLAIMED") : r.Body.Contains("\"level\":7") && r.Body.Contains("premium") ? Err(503, "INTERNAL") : Ok("{\"freeCoins\":10}");
        var all = await p.ClaimAllAsync();
        var claims = s.To("POST", "/v1/season-pass/claim");
        check(!all.Ok && all.Message.StartsWith("9件受け取りました。") && !string.IsNullOrEmpty(kv.Get(SeasonPassModel.KeyPendingClaim + ":2026-11:p:7")), "まとめて受け取る: ALREADY_CLAIMED is skipped, stops at a cell without an answer and keeps its key");
        s.Routes["POST /v1/season-pass/claim"] = _ => Ok("{\"freeCoins\":10}");
        await p.ClaimAsync(PassTrack.Premium, 7);
        var k7 = s.To("POST", "/v1/season-pass/claim").Where(r => r.Body.Contains("\"level\":7") && r.Body.Contains("premium")).Select(r => r.Headers["idempotency-key"]).Distinct().Count();
        check(k7 == 1, "retrying that cell reuses its key");
        t = SeasonEnd;
        check(p.Ended && p.Rows.All(r => !r.FreeClaimable && !r.PremiumClaimable) && !(await p.ClaimAsync(PassTrack.Free, 3)).Ok, "after the season end nothing is claimable (the close grants it)");

        s.Routes["GET /v1/season-pass"] = _ => Ok(SeasonPassFree);
        var free = new SeasonPassModel(b, () => now);
        await free.LoadAsync();
        check(free.PrimaryAction == "有料ラインを開ける" && free.PurchaseProductId == "season_pass" && free.CanBuy && free.Rows[0].PremiumText != null && !free.Rows[0].PremiumClaimable,
            "not owned: the premium line is fully visible, not claimable, 「有料ラインを開ける」");
        player.Deletion = DeleteStep2; await b.RefreshAsync();
        check(!free.CanBuy, "deletion pending: the pass cannot be bought");
    }

    static async Task Deletion(Action<bool, string> check, RulesetParams rs)
    {
        var player = new P { ConsentRequired = false, PartnerId = "h1", GachaUsed = true, Horses = "[" + Horse1 + "]", Unlocks = AllUnlocks };
        var (s, b, kv) = Setup(player, rs);
        s.Routes["DELETE /v1/player"] = r => r.Body == null || r.Body == "{}" ? Ok(DeleteStep1) : r.Body.Contains("del_tok") ? Ok(DeleteStep2) : Err(409, "DELETION_CONFIRM_INVALID");
        long t = now;
        var d = new AccountDeletionModel(b, () => t);
        check(d.Stage == DeletionStage.None, "no deletion scheduled");
        await d.RequestAsync();
        check(d.Stage == DeletionStage.Confirming && d.ForfeitLines.SequenceEqual(new[] { "有償コイン100枚", "無償コイン195枚", "馬8頭", "アイテム2個", "厩舎手当の残り29日分", "今シーズンのシーズンパス" }) && d.Notice.Contains("払い戻し"),
            "step 1: what is given up and the server's notice");
        t = 1795576200000L; // the token's expiry
        int n = s.Count("DELETE", "/v1/player");
        var late = await d.ConfirmAsync();
        check(!late.Ok && d.Stage == DeletionStage.None && s.Count("DELETE", "/v1/player") == n && late.Message.Contains("期限"), "expired token: back to the start without a request");
        t = now;
        await d.RequestAsync();
        var ok = await d.ConfirmAsync();
        check(ok.Ok && d.Stage == DeletionStage.Scheduled && d.ScheduledLine == "12月9日に削除されます（それまでは取り消せます）" && DeletionGuard.Pending(b), "step 2 schedules it: 「12月9日に削除されます」, the guard is on");
        check(new HomeModel(b).DeletionBanner == "アカウント削除の予定があります（12月9日）。取り消すと使えます", "home shows the pending banner");
        s.Routes["POST /v1/player/deletion/cancel"] = _ => Err(409, "CONFLICT");
        check(!(await d.CancelAsync()).Ok && d.Message == "削除が始まっています" && d.Stage == DeletionStage.Scheduled, "cancel after the deletion started: 「削除が始まっています」");
        s.Routes["POST /v1/player/deletion/cancel"] = _ => Ok("{\"status\":\"none\",\"requestedAt\":null,\"deleteAt\":null}");
        check((await d.CancelAsync()).Ok && d.Stage == DeletionStage.None && !DeletionGuard.Pending(b) && s.Count("POST", "/v1/player/deletion/cancel") == 2, "cancel → none; purchases unblocked");
        s.Routes["DELETE /v1/player"] = _ => Ok(DeleteStep1.Replace("del_tok", "del_other"));
        await d.RequestAsync();
        s.Routes["DELETE /v1/player"] = _ => Err(409, "DELETION_CONFIRM_INVALID");
        check(!(await d.ConfirmAsync()).Ok && d.Stage == DeletionStage.None, "DELETION_CONFIRM_INVALID → start over");
        var off = new AccountDeletionModel(OfflineBackend(rs, new MemoryKeyValueStore()));
        check(!(await off.RequestAsync()).Ok && off.Stage == DeletionStage.Offline, "offline: deletion needs the server");
    }
}
