// U1 raising screens (docs/quality/unity-raising.md): what the Unity screens for the horse card, breeding, the foal reveal, the
// pedigree tree and the race result read from the game layer, and the layout audit of those screens (RaisingLayout: no two text
// rects overlap, everything inside 1600×900, body text ≥ 16 px, at most one CTA, sample texts fit their boxes).
// A routed fake server; no network. English for every new label.
using System.Linq;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class RaisingScreenChecks
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
    static HttpResponse Ok(string body) => new HttpResponse(200, body);

    const string Horses = "[{\"id\":\"h1\",\"name\":\"アカツキ\",\"rarity\":\"SR\",\"sex\":\"male\",\"style\":\"sashi\",\"status\":\"retired\",\"named\":true},"
        + "{\"id\":\"h4\",\"name\":\"ハヤテ\",\"rarity\":\"R\",\"sex\":\"male\",\"style\":\"nige\",\"status\":\"retired\",\"named\":true},"
        + "{\"id\":\"h2\",\"name\":\"サクラ\",\"rarity\":\"SR\",\"sex\":\"female\",\"style\":\"nige\",\"status\":\"retired\",\"named\":true}]";
    static string PlayerJson(int free, int points) => "{\"id\":\"q\",\"wallet\":{\"paid\":0,\"free\":" + free + ",\"total\":" + free + ",\"debt\":0},\"season\":{\"id\":\"2026-12\",\"classId\":\"C\",\"points\":" + points + "},\"items\":{},\"horses\":" + Horses + ",\"equipment\":{\"tack\":{},\"decor\":[]}}";
    const string Stats = "\"stats\":{\"speed\":{\"min\":600,\"max\":720},\"stamina\":{\"min\":600,\"max\":720},\"burst\":{\"min\":600,\"max\":720},\"guts\":{\"min\":600,\"max\":720},\"temper\":{\"min\":600,\"max\":720}}";
    static string Preview(bool nick, int inbreeding, string today) => "{" + Stats + ",\"nick\":" + (nick ? "true" : "false") + ",\"inbreedingCount\":" + inbreeding + ",\"styles\":{\"sashi\":47.5,\"nige\":47.5,\"senko\":2.5,\"oikomi\":2.5},\"distance\":{\"minM\":1400,\"maxM\":2400},\"surface\":\"turf\",\"goingAptitude\":{\"any\":1000},"
        + "\"atavism\":{\"chancePermille\":0,\"candidates\":[]},\"skill\":{\"nonePermille\":850,\"candidates\":[{\"id\":\"sk1\",\"name\":\"末脚一閃\",\"permille\":150,\"from\":[\"dam\"]}]},"
        + "\"rarity\":{\"R\":780000,\"SR\":205000,\"SSR\":15000},\"today\":" + today + "}";
    const string TodayOpen = "{\"perDay\":1,\"used\":0,\"extraPerDay\":1,\"extraUsed\":0,\"materialItemId\":\"breed_material\",\"materialCost\":1,\"materialOwned\":2}";
    const string TodayUsed = "{\"perDay\":1,\"used\":1,\"extraPerDay\":1,\"extraUsed\":0,\"materialItemId\":\"breed_material\",\"materialCost\":1,\"materialOwned\":2}";
    const string Foal = "{\"id\":\"h9\",\"name\":\"ミメイ\",\"rarity\":\"SR\",\"sex\":\"female\",\"style\":\"sashi\",\"status\":\"active\",\"sireId\":\"h1\",\"damId\":\"h2\",\"skillId\":\"sk1\",\"base\":{\"speed\":720,\"stamina\":690,\"burst\":660,\"guts\":610,\"temper\":640}}";

    const string Rules = "\"rules\":{\"races\":3,\"needTop\":2,\"topPlace\":3,\"setbackPoints\":40,\"graceRaces\":10}";
    static string PromoView(string series) =>
        "{\"enabled\":true,\"seasonId\":\"2026-12\",\"classId\":\"C\",\"toClassId\":\"B\",\"line\":300,\"points\":320,\"earned\":320," + Rules +
        ",\"series\":" + series + ",\"passedThisSeason\":false,\"grace\":null,\"shieldUsedThisSeason\":false}";
    static string Series(string status, string pips, int results, string next, bool seen = false) =>
        "{\"id\":\"2026-12:C:1\",\"status\":\"" + status + "\",\"races\":3,\"needTop\":2,\"topPlace\":3,\"results\":[" +
        string.Join(",", Enumerable.Range(0, results).Select(i => "{\"raceId\":\"r" + i + "\",\"place\":2,\"top\":true,\"cpu\":false}")) +
        "],\"pips\":[" + pips + "],\"next\":" + next + ",\"tops\":" + results + ",\"misses\":0,\"startedAt\":1,\"endedAt\":null,\"setbackTo\":null,\"seen\":" + (seen ? "true" : "false") + "}";

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset, string root)
    {
        Loc.LoadEnglish(File.ReadAllText(Path.Combine(root, "engine", "Muchi.Client", "Resources", "Muchi", "ui-en.json")));
        var labels = new List<string>();
        var s = new FakeServer();
        int free = 500, points = 0;
        string today = TodayOpen, promo = PromoView("null");
        s.Routes["POST /v1/player/bootstrap"] = _ => Ok(PlayerJson(free, points));
        s.Routes["GET /v1/player"] = _ => Ok(PlayerJson(free, points));
        s.Routes["GET /v1/stud/browse?scope=friends"] = _ => Ok("{\"scope\":\"friends\",\"listings\":[]}");
        s.Routes["GET /v1/stud/browse?scope=public"] = _ => Ok("{\"scope\":\"public\",\"listings\":[]}");
        s.Routes["GET /v1/stud/mine"] = _ => Ok("{\"listings\":[],\"today\":{\"earned\":0,\"earnCap\":300,\"borrowed\":0,\"borrowPerDay\":2},\"limits\":{\"feeMax\":100,\"dailyLimitMax\":3,\"maxListings\":3},\"pendingPayments\":0,\"history\":[]}");
        s.Routes["POST /v1/breeding/preview"] = r => Ok(r.Body != null && r.Body.Contains("h4") ? Preview(false, 1, today) : Preview(true, 0, today));
        s.Routes["POST /v1/breeding"] = _ => Ok("{\"foal\":" + Foal + ",\"nick\":true,\"inbreedingCount\":0,\"usedMaterial\":false,\"atavism\":null,\"skillId\":\"sk1\",\"today\":" + TodayUsed + "}");
        s.Routes["GET /v1/promotion"] = _ => Ok(promo);
        s.Routes["POST /v1/promotion/ack"] = _ => Ok("{\"seriesId\":\"2026-12:C:1\",\"seen\":true}");
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var kv = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, ruleset);
        await b.InitializeAsync();

        // ---- breeding: the aim line on each parent candidate (SR以上 x%, ニックス, 近親), today's line, the short odds line
        var m = new BreedingModel(b, kv);
        await m.LoadAsync();
        m.SelectSire("own:h1"); m.SelectDam("h2");
        await m.PreviewAsync();
        await m.LoadAimsAsync();
        check(m.AimLine("sire", "own:h1") == "SR以上 22.0%　·　◎ ニックス", "raising screens: a sire candidate's aim against the chosen dam (" + m.AimLine("sire", "own:h1") + ")");
        check(m.AimLine("sire", "own:h4") == "SR以上 22.0%　·　近親", "raising screens: another sire's aim says 近親 when the pair shares an ancestor (" + m.AimLine("sire", "own:h4") + ")");
        check(m.AimLine("dam", "h2") == "SR以上 22.0%　·　◎ ニックス" && m.AimLine("dam", "nope") == null, "raising screens: a dam candidate's aim against the chosen sire; none for an unknown horse");
        check(m.TodayLine == "今日あと1回", "raising screens: today's breeding line (" + m.TodayLine + ")");
        check(m.RarityOddsText == "SSR 1.5%　·　SR 20.5%　·　R 78.0%", "raising screens: the short rarity odds line is the server's numbers (" + m.RarityOddsText + ")");
        check(m.CompatibilityText == "◎ ニックス（相性がよい）", "raising screens: the compatibility line (" + m.CompatibilityText + ")");
        check(m.DistanceText == "距離 1,400〜2,400m　·　芝", "raising screens: the foal's distance and surface (" + m.DistanceText + ")");
        labels.AddRange(new[] { m.AimLine("sire", "own:h1"), m.AimLine("sire", "own:h4"), m.TodayLine, m.RarityOddsText, m.CompatibilityText, m.DistanceText,
            "○ 通常の相性", "○ 通常の相性　·　近親 2（能力 −100）", "配合素材を1個使って、もう1回", "今日の配合はおしまい。4:00に戻ります", "距離 1,000〜1,600m　·　ダート", "距離 1,200〜2,000m　·　芝・ダートのどちらか" });

        // ---- the foal reveal
        var br = await m.BreedAsync();
        check(br.Ok && m.Reveal != null, "raising screens: a breeding opens the reveal");
        check(m.RevealSexStyleText == "牝馬　·　脚質 差し：父から", "raising screens: step 1, sex and style (" + m.RevealSexStyleText + ")");
        check(m.RevealSummaryText == "期待以上が2つ　·　能力合計 3,320　·　見込み 20.5%", "raising screens: step 3, verdict, total and the chance (" + m.RevealSummaryText + ")");
        check(m.RevealSkillText == "固有スキル「末脚一閃」を母から受け継ぎました", "raising screens: step 4, the skill and where it came from (" + m.RevealSkillText + ")");
        check(m.RevealParentsText == "父 アカツキ　·　母 サクラ", "raising screens: step 4, the parents (" + m.RevealParentsText + ")");
        check(m.AgainWithMaterialLine == "配合素材を1個使って、もう1回（残り 2個）", "raising screens: 「もう1回配合する」 is offered when material allows (" + m.AgainWithMaterialLine + ")");
        labels.AddRange(new[] { m.RevealSexStyleText, m.RevealSummaryText, m.RevealSkillText, m.RevealParentsText, m.AgainWithMaterialLine,
            "牡馬　·　脚質 逃げ：隔世遺伝", "見込みどおり　·　能力合計 3,000", "固有スキル「末脚一閃」を父と母から受け継ぎました", "固有スキル「末脚一閃」を父から受け継ぎました" });

        // ---- promotion on the result: popup (the outcome sheet) or card, never both; the card only for a series this race touched
        var gate = new SessionPrompts();
        var pm = new PromotionModel(b) { Prompts = gate };
        await pm.RefreshAsync();
        promo = PromoView(Series("active", "\"open\",\"open\",\"open\"", 0, "1"));
        await pm.AfterRankedResultAsync();
        var plan = ResultPromotionPlan.Build(pm, null);
        check(pm.TouchedByLastResult && plan.What == ResultPromotionPlan.Show.Card && plan.Title == "昇級戦 開始" && plan.Gold && plan.Marks == "···", "raising screens: the race that reached the line shows the start card (" + plan.Title + ")");
        check(plan.Kicker == "昇級戦　/　C級 → B級" && plan.Foot == "ライン 300pt　·　いま 320pt" && plan.Lead == PromotionModel.StartLead, "raising screens: the card's kicker, lead and foot");
        await pm.AfterRankedResultAsync(); // a race that did not count (another mode / same state)
        plan = ResultPromotionPlan.Build(pm, null);
        check(!pm.TouchedByLastResult && plan.What == ResultPromotionPlan.Show.None, "raising screens: a series this race did not touch shows nothing");
        promo = PromoView(Series("active", "\"top\",\"open\",\"open\"", 1, "2"));
        await pm.AfterRankedResultAsync();
        plan = ResultPromotionPlan.Build(pm, null);
        check(plan.What == ResultPromotionPlan.Show.Card && plan.Title == "昇級戦 2/3" && !plan.Gold && plan.Marks == "○··", "raising screens: progress card 「昇級戦 2/3」 (" + plan.Title + ")");
        promo = PromoView(Series("passed", "\"top\",\"top\",\"skip\"", 2, "null"));
        await pm.AfterRankedResultAsync();
        plan = ResultPromotionPlan.Build(pm, new PromotionRewardInfo { Name = "昇級の柄 B", Granted = false });
        check(pm.OutcomeSheetVisible && plan.What == ResultPromotionPlan.Show.Popup && plan.Title == "B級へ昇級確定", "raising screens: a decided series claims the popup and shows no card");
        check(plan.MomentLine == "シーズンの締めでB級に上がります　·　B級に上がると「昇級の柄 B」が届きます（無料）", "raising screens: the promotion reward in the moment, honest about when it arrives (" + plan.MomentLine + ")");
        var granted = ResultPromotionPlan.Build(pm, new PromotionRewardInfo { Name = "昇級の柄 B", Granted = true });
        check(granted.MomentLine == "シーズンの締めでB級に上がります　·　昇級の記念「昇級の柄 B」を受け取りました（無料）" && granted.MomentKicker == "昇級戦　/　突破" && granted.MomentButton == "つづける", "raising screens: a granted reward says so (" + granted.MomentLine + ")");
        var none = ResultPromotionPlan.Build(pm, null);
        check(none.MomentLine == "シーズンの締めでB級に上がります" && none.RewardLine == null, "raising screens: no reward known → no reward words");
        // the gate already taken by another prompt: the outcome stays on the card (inline), the sheet waits
        var gate2 = new SessionPrompts(); gate2.TryClaim(SessionPrompts.ConsentPrePrompt);
        var pm2 = new PromotionModel(b, new MemoryKeyValueStore()) { Prompts = gate2 };
        promo = PromoView(Series("active", "\"top\",\"top\",\"open\"", 2, "3"));
        await pm2.RefreshAsync();
        promo = PromoView(Series("passed", "\"top\",\"top\",\"skip\"", 2, "null"));
        await pm2.AfterRankedResultAsync();
        var inline = ResultPromotionPlan.Build(pm2, new PromotionRewardInfo { Name = "昇級の柄 B", Granted = false });
        check(!pm2.OutcomeSheetVisible && inline.What == ResultPromotionPlan.Show.Card && inline.Title == "B級へ昇級確定" && inline.RewardLine == "B級に上がると「昇級の柄 B」が届きます（無料）", "raising screens: gate taken → the outcome and the reward on the card only (" + inline.RewardLine + ")");
        labels.AddRange(new[] { plan.Title, plan.Kicker, plan.Foot, plan.MomentLine, granted.MomentLine, granted.MomentKicker, granted.MomentButton, inline.RewardLine, "昇級戦　/　届かず", "昇級ならず", "ポイントは260ptに戻りました", "クラスが上がるのはシーズンの締め", ResultPromotionPlan.RulesLink });

        // ---- the place-coin line: the server's values (wallet and points before / after the confirmed race)
        var before = ResultRewards.Snapshot(b.Player);
        free = 526; points = 30;
        await b.RefreshAsync();
        var rw = before.Settle(b.Player, online: true, confirmed: true, voided: false);
        check(rw.Known && rw.CoinsText == "+26" && rw.PointsText == "+30" && rw.Line == "着順の無償コイン +26・シーズンpt +30（サーバーの確定値）", "raising screens: the coins and points are the server's (" + rw.Line + ")");
        var practice = ResultRewards.Snapshot(null).Settle(null, online: false, confirmed: false, voided: false);
        check(!practice.Known && practice.CoinsText == "—" && practice.Line == "練習：コインとポイントはつきません", "raising screens: practice grants nothing");
        var verifying = before.Settle(b.Player, online: true, confirmed: false, voided: false);
        check(!verifying.Known && verifying.Line == "報酬は結果の照合のあとに入ります", "raising screens: while verifying no number is guessed");
        var voided = before.Settle(b.Player, online: true, confirmed: false, voided: true);
        check(!voided.Known && voided.Line == "無効のレース：報酬はありません", "raising screens: a void race grants nothing");
        var lost = ResultRewards.Snapshot(null).Settle(b.Player, online: true, confirmed: true, voided: false);
        check(!lost.Known && lost.Line == "報酬はホームの残高に入ります", "raising screens: no snapshot → no invented number");
        labels.AddRange(new[] { rw.Line, practice.Line, verifying.Line, voided.Line, lost.Line, "着順の無償コイン +0・シーズンpt +0（サーバーの確定値）" });

        // ---- the honest lesson row: fits its box, drops 会心 first, then by what the field says
        var L = RaisingLayout.Result(true);
        var rm = new RaceResultModel { HasResult = true, Place = 5, Runners = 12, DebriefLine = "最後の直線で伸びきれなかった", DebriefTip = "次は残り300mからムチを2回",
            FieldLine = "能力の差：相棒 3320 ／ この場のCPU 3600。調教で伸ばすと勝ちやすい", GoLesson = "仕掛けがあと0.5秒早ければ3着", PerfectLine = "会心のムチ 3/5",
            FieldCheck = new RankedFieldCheck { HorseWeaker = true } };
        var rl = ResultLines.Build(rm, false, L["tip"], L["lesson"]);
        check(rl.ReasonKicker == "敗因" && rl.Debrief == rm.DebriefLine && rl.Tip == "ヒント：次は残り300mからムチを2回", "raising screens: the reason kicker, the debrief and the tip");
        check(rl.Lesson != null && rl.Lesson.StartsWith("振り返り：能力の差") && RaisingLayout.Fits(rl.Lesson, L["lesson"]) && rl.Lesson.Contains("会心") && rl.Field == "horse", "raising screens: the full lesson row fits its three-line box (" + rl.Lesson + ")");
        var twoLines = new RaisingLayout.Box { Id = "lesson2", Kind = RaisingLayout.Kind.Text, X = 77, Y = 562, W = 520, H = 44, Size = 16 };
        var shortRow = ResultLines.Build(rm, false, L["tip"], twoLines);
        check(RaisingLayout.Fits(shortRow.Lesson, twoLines) && !shortRow.Lesson.Contains("会心") && shortRow.Lesson.Contains("能力の差"), "raising screens: in two lines 会心 goes first; the horse line stays when the horse is weaker (" + shortRow.Lesson + ")");
        var riding = new RaceResultModel { HasResult = true, Place = 5, FieldLine = "能力は互角以上（相棒 3197 ／ この場 3197）：差は乗り方", GoLesson = "仕掛けを前後に動かしても、着順は変わらなかった", PerfectLine = "会心のムチ 3/5", FieldCheck = new RankedFieldCheck { HorseWeaker = false } };
        var oneLine = new RaisingLayout.Box { Id = "lesson1", Kind = RaisingLayout.Kind.Text, X = 77, Y = 562, W = 520, H = 24, Size = 16 };
        var ridingRow = ResultLines.Build(riding, false, null, oneLine);
        check(ridingRow.Lesson == "振り返り：仕掛けを前後に動かしても、着順は変わらなかった" && ridingRow.Field == null, "raising screens: when the gap is the riding, the general line goes before the specific lesson (" + ridingRow.Lesson + ")");
        var beginner = ResultLines.Build(rm, true, L["tip"], L["lesson"]);
        check(beginner.Lesson != null && !beginner.Lesson.Contains("能力の差"), "raising screens: no 能力の差 line in a beginner match");
        var win = ResultLines.Build(new RaceResultModel { HasResult = true, Place = 1, Won = true, DebriefLine = "直線の一閃が届いた" }, false, L["tip"], L["lesson"]);
        check(win.ReasonKicker == "勝因" && win.Tip == null && win.Lesson == null, "raising screens: a win with no tip has no empty lines");
        labels.AddRange(new[] { rl.ReasonKicker, win.ReasonKicker, rl.Tip, rl.Lesson });

        // ---- the layout audit: every screen and state
        var screens = new List<RaisingLayout.Screen> { RaisingLayout.HorseCard(), RaisingLayout.Breeding(), RaisingLayout.FoalReveal(false, false), RaisingLayout.FoalReveal(true, true),
            RaisingLayout.Pedigree(), RaisingLayout.Result(false), RaisingLayout.Result(true) };
        // fill the long texts with the longest real samples from the fixtures above (Japanese; English is checked below)
        var hc = screens[0];
        hc.Sample("name", "アカツキノヒカリ"); hc.Sample("rarity", "SSR　·　差し　·　芝 1,600〜2,400m"); hc.Sample("ranked", "ランク戦（C級 上限 2,800）：合計は上限にそろえ、配分はそのまま");
        hc.Sample("rules", HorseProfileModel.RulesText); hc.Sample("next", "充実期まで あと30"); hc.Sample("career", "12戦3勝"); hc.Sample("extra", "ライバルに1回先着・大会優勝2回・3着以内6回");
        hc.Sample("parents", "父 アカツキ（借りた種牡馬）　·　母 サクラ"); hc.Sample("skill", "固有スキル「末脚一閃」：父と母から"); hc.Sample("leaning", "得意：瞬発（21.6% → 21.8%）");
        var bd = screens[1];
        bd.Sample("sire0.aim", m.AimLine("sire", "own:h4")); bd.Sample("compat", "○ 通常の相性　·　近親 2（能力 −100）"); bd.Sample("odds", m.RarityOddsText); bd.Sample("distance", "距離 1,200〜2,000m　·　芝・ダートのどちらか");
        bd.Sample("gifts", string.Join("\n", new[] { "父　アカツキ", "脚質 差し 47.5%", "固有スキル「末脚一閃」 15.000%", "母　サクラ", "脚質 逃げ 47.5%", "固有スキル「末脚一閃」 15.000%", "隔世遺伝 1.333%  逃げ ← ハツユキソウ", "隔世遺伝 0.500%  重馬場巧者 ← ミナモ" }));
        bd.Sample("today", "配合素材を1個使って、もう1回");
        var fr = screens[3];
        fr.Sample("sexstyle", m.RevealSexStyleText); fr.Sample("summary", m.RevealSummaryText); fr.Sample("skill", m.RevealSkillText); fr.Sample("again", m.AgainWithMaterialLine);
        var rs = screens[6];
        rs.Sample("debrief", "最後の直線で伸びきれなかった"); rs.Sample("tip", rl.Tip); rs.Sample("lesson", rl.Lesson); rs.Sample("rewards", rw.Line);
        rs.Sample("promoTitle", "B級へ昇級確定"); rs.Sample("promoReward", inline.RewardLine); rs.Sample("promoFoot", "ライン 300pt　·　いま 320pt");
        foreach (var sc in screens)
        {
            var problems = RaisingLayout.Audit(sc);
            check(problems.Count == 0, "raising layout: " + sc.Name + " — no overlapping text, inside 1600×900, body ≥ 16, ≤ 1 CTA, samples fit (" + string.Join(" | ", problems) + ")");
        }
        check(screens.All(sc => sc.Boxes.Count(x => x.Kind == RaisingLayout.Kind.Cta) == 1), "raising layout: every screen has exactly one CTA");
        // the audit itself catches what it is meant to catch
        var bad = new RaisingLayout.Screen("bad");
        bad.Add("a", RaisingLayout.Kind.Text, 10, 10, 200, 30, 20); bad.Add("b", RaisingLayout.Kind.Text, 100, 20, 200, 30, 14);
        bad.Add("c", RaisingLayout.Kind.Cta, 1500, 850, 300, 76, 27); bad.Add("d", RaisingLayout.Kind.Cta, 10, 400, 300, 76, 27);
        bad.Add("e", RaisingLayout.Kind.Text, 10, 600, 100, 24, 16).Sample = "とても長い説明の文がこの箱には入りきらない";
        var found = RaisingLayout.Audit(bad);
        check(found.Any(x => x.Contains("overlap")) && found.Any(x => x.Contains("outside")) && found.Any(x => x.Contains("< 16")) && found.Any(x => x.Contains("CTAs")) && found.Any(x => x.Contains("does not fit")), "raising layout: the audit finds overlap, outside, small body, two CTAs and overflow (" + found.Count + ")");

        // ---- English for every label the screens draw
        labels.AddRange(RaisingText.All);
        Loc.SetLocale("en");
        try
        {
            string[] names = { "アカツキ", "サクラ", "ハヤテ", "ハツユキソウ", "末脚一閃", "昇級の柄 B", "ミナモ" };
            var missing = labels.Where(x => x != null).Where(x => { var t = Loc.T(x); foreach (var n in names) t = t.Replace(n, ""); return Loc.HasJapanese(t); }).Distinct().ToList();
            check(missing.Count == 0, "raising screens: every label has English (" + string.Join(" | ", missing.Select(x => x + " → " + Loc.T(x))) + ")");
        }
        finally { Loc.SetLocale("ja"); }
        var all = string.Join("", labels.Where(x => x != null));
        check(!all.Contains("今だけ") && !all.Contains("残りわずか") && !all.Contains("お得") && !all.Contains("購入") && !new[] { "馬券", "オッズ", "配当", "的中", "賭" }.Any(all.Contains), "raising screens: no urgency, shop or betting words");
    }
}
