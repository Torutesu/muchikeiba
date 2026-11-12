// Quality pass (raising & breeding, docs/quality/raising-breeding.md, contracts/protocol.md Q1): 馬カード (HorseProfileModel), the
// training outlook on the menu cards and the stage-up moment (TrainingModel), the breeding intent (rarity odds, what each parent
// passes on) and the foal reveal (BreedingModel). A routed fake server; no network. English for every label; no shop / urgency words.
using System.Linq;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class RaisingQualityChecks
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
        + "{\"id\":\"h2\",\"name\":\"サクラ\",\"rarity\":\"SR\",\"sex\":\"female\",\"style\":\"nige\",\"status\":\"retired\",\"named\":true},"
        + "{\"id\":\"h3\",\"name\":\"アイボウ\",\"rarity\":\"SR\",\"sex\":\"male\",\"style\":\"senko\",\"status\":\"active\",\"named\":true}]";
    const string PlayerJson = "{\"id\":\"q\",\"wallet\":{\"paid\":0,\"free\":500,\"total\":500,\"debt\":0},\"season\":{\"id\":\"2026-12\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":" + Horses + ",\"equipment\":{\"tack\":{},\"decor\":[]}}";
    const string Profile = "{\"horseId\":\"h3\",\"name\":\"アイボウ\",\"rarity\":\"SR\",\"sex\":\"male\",\"style\":\"senko\",\"status\":\"active\",\"surface\":\"turf\",\"distMinM\":1600,\"distMaxM\":2400,\"goingAptitude\":\"any\",\"partner\":true,"
        + "\"stats\":[{\"key\":\"speed\",\"base\":700,\"awakening\":20,\"trained\":0,\"race\":720,\"ranked\":600},{\"key\":\"stamina\",\"base\":650,\"awakening\":0,\"trained\":8,\"race\":658,\"ranked\":549},{\"key\":\"burst\",\"base\":720,\"awakening\":0,\"trained\":14,\"race\":734,\"ranked\":612},{\"key\":\"guts\",\"base\":600,\"awakening\":0,\"trained\":8,\"race\":608,\"ranked\":507},{\"key\":\"temper\",\"base\":640,\"awakening\":0,\"trained\":0,\"race\":640,\"ranked\":533}],"
        + "\"totals\":{\"base\":3310,\"effective\":3330,\"race\":3360,\"ranked\":2801,\"classId\":\"C\",\"cap\":2800,\"capped\":true,\"toCap\":0},"
        + "\"growth\":{\"trainedTotal\":30,\"potential\":240,\"perStatCap\":96,\"stage\":1,\"stageKey\":\"growing\",\"nextStageAt\":84,\"sessions\":5},"
        + "\"leaning\":{\"stat\":\"burst\",\"trained\":14,\"sharePermilleBefore\":216,\"sharePermilleNow\":218},"
        + "\"lineage\":{\"generation\":2,\"line\":\"x\",\"sireName\":\"アカツキ\",\"damName\":\"サクラ\",\"studSire\":false,\"bred\":true,\"skill\":{\"id\":\"sk1\",\"name\":\"末脚一閃\"},\"skillFrom\":\"dam\",\"atavism\":{\"trait\":\"style\",\"value\":\"nige\",\"from\":\"ハツユキソウ\"}},"
        + "\"career\":{\"races\":12,\"wins\":3,\"places\":6,\"rivalWins\":1,\"tournamentWins\":0,\"biggestWin\":null,\"firstRaceAt\":1},\"recentTraining\":[]}";

    static string TrainingView(string outlookHill) =>
        "{\"enabled\":true,\"slotsPerDay\":3,\"usedToday\":0,\"slotsLeft\":3,\"perHorsePerDay\":2,"
        + "\"menus\":[{\"id\":\"hill\",\"name\":\"坂路\",\"baseGain\":6,\"fatigue\":30,\"weights\":{\"burst\":2,\"guts\":1,\"stamina\":1},\"bondMultiplier\":1},{\"id\":\"pool\",\"name\":\"プール\",\"baseGain\":3,\"fatigue\":-20,\"weights\":{\"stamina\":2,\"temper\":1},\"bondMultiplier\":1}],"
        + "\"timing\":{\"beats\":5,\"durationMs\":6000,\"leadMs\":800,\"tailMs\":200,\"perfectMs\":60,\"goodMs\":150,\"perfectPoints\":2,\"goodPoints\":1,\"strayPenalty\":1,\"permillePerPoint\":10,\"maxTaps\":10,\"minTapGapMs\":80,\"maxScore\":10},"
        + "\"fatigue\":{\"max\":100,\"restAt\":80,\"recoveryPerDay\":40},\"items\":[],"
        + "\"horses\":[{\"horseId\":\"h3\",\"name\":\"アイボウ\",\"rarity\":\"SR\",\"trained\":{\"speed\":0,\"stamina\":4,\"burst\":10,\"guts\":4,\"temper\":0},\"trainedTotal\":22,\"potential\":240,\"perStatCap\":96,\"fatigue\":30,\"condition\":\"fresh\",\"bondLevel\":2,\"todayCount\":0,\"sessions\":4,\"log\":[],\"blocked\":null,"
        + "\"menus\":[{\"id\":\"hill\",\"blocked\":null" + outlookHill + "},{\"id\":\"pool\",\"blocked\":null}]}],\"open\":null,\"rules\":{\"rankedNormalized\":true,\"fatigueAffectsRaces\":false,\"inherited\":false,\"paidBoosts\":false}}";
    const string Session = "{\"sessionId\":\"tr_a\",\"horseId\":\"h3\",\"menuId\":\"hill\",\"startedAt\":1,\"expiresAt\":600001,\"beats\":[814,1916,3236,4273,4887],\"durationMs\":6000}";
    static string Finish() =>
        "{\"sessionId\":\"tr_a\",\"horseId\":\"h3\",\"menuId\":\"hill\",\"grade\":\"great\",\"timing\":{\"perfect\":5,\"good\":0,\"miss\":0,\"stray\":0,\"score\":10,\"bonusPermille\":100},"
        + "\"gain\":{\"speed\":0,\"stamina\":2,\"burst\":4,\"guts\":2,\"temper\":0},\"total\":8,\"capped\":false,\"breakdown\":{\"efficiencyPermille\":850,\"bondPermille\":10,\"timingPermille\":100,\"softPermille\":908},"
        + "\"trained\":{\"speed\":0,\"stamina\":6,\"burst\":14,\"guts\":6,\"temper\":0},\"trainedTotal\":30,\"potential\":240,\"fatigue\":60,\"settled\":\"done\",\"void\":false}";

    const string Stats = "\"stats\":{\"speed\":{\"min\":600,\"max\":720},\"stamina\":{\"min\":600,\"max\":720},\"burst\":{\"min\":600,\"max\":720},\"guts\":{\"min\":600,\"max\":720},\"temper\":{\"min\":600,\"max\":720}}";
    const string Preview = "{" + Stats + ",\"nick\":true,\"inbreedingCount\":0,\"styles\":{\"sashi\":47.5,\"nige\":47.5,\"senko\":2.5,\"oikomi\":2.5},\"distance\":{\"minM\":1400,\"maxM\":2400},\"surface\":\"turf\",\"goingAptitude\":{\"any\":1000},"
        + "\"atavism\":{\"chancePermille\":0,\"candidates\":[]},\"skill\":{\"nonePermille\":850,\"candidates\":[{\"id\":\"sk1\",\"name\":\"末脚一閃\",\"permille\":150,\"from\":[\"dam\"]}]},"
        + "\"rarity\":{\"R\":780000,\"SR\":205000,\"SSR\":15000},\"today\":{\"perDay\":1,\"used\":0,\"extraPerDay\":0,\"extraUsed\":0,\"materialItemId\":null,\"materialCost\":0,\"materialOwned\":0}}";
    const string Foal = "{\"id\":\"h9\",\"name\":\"ミメイ\",\"rarity\":\"SR\",\"sex\":\"female\",\"style\":\"sashi\",\"status\":\"active\",\"sireId\":\"h1\",\"damId\":\"h2\",\"skillId\":\"sk1\",\"base\":{\"speed\":720,\"stamina\":690,\"burst\":660,\"guts\":610,\"temper\":640}}";

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        var s = new FakeServer();
        s.Routes["POST /v1/player/bootstrap"] = _ => Ok(PlayerJson);
        s.Routes["GET /v1/player"] = _ => Ok(PlayerJson);
        s.Routes["GET /v1/horses/h3/profile"] = _ => Ok(Profile);
        string tview = TrainingView(",\"outlook\":{\"min\":5,\"max\":6,\"efficiencyPermille\":850,\"bondPermille\":10,\"softPermille\":1000}");
        s.Routes["GET /v1/training"] = _ => Ok(tview);
        s.Routes["POST /v1/training/start"] = _ => Ok("{\"session\":" + Session + ",\"preview\":{\"min\":5,\"max\":6,\"minMilli\":5100,\"maxMilli\":6000},\"slotsLeft\":2}");
        s.Routes["POST /v1/training/tr_a/finish"] = _ => Ok(Finish());
        s.Routes["GET /v1/stud/browse?scope=friends"] = _ => Ok("{\"scope\":\"friends\",\"listings\":[]}");
        s.Routes["GET /v1/stud/browse?scope=public"] = _ => Ok("{\"scope\":\"public\",\"listings\":[]}");
        s.Routes["GET /v1/stud/mine"] = _ => Ok("{\"listings\":[],\"today\":{\"earned\":0,\"earnCap\":300,\"borrowed\":0,\"borrowPerDay\":2},\"limits\":{\"feeMax\":100,\"dailyLimitMax\":3,\"maxListings\":3},\"pendingPayments\":0,\"history\":[]}");
        s.Routes["POST /v1/breeding/preview"] = _ => Ok(Preview);
        s.Routes["POST /v1/breeding"] = _ => Ok("{\"foal\":" + Foal + ",\"nick\":true,\"inbreedingCount\":0,\"usedMaterial\":false,\"atavism\":null,\"skillId\":\"sk1\"}");
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var kv = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, ruleset);
        await b.InitializeAsync();
        var labels = new List<string>();

        // ---- 馬カード
        var p = new HorseProfileModel(b, kv);
        var load = await p.LoadAsync("h3");
        check(load.Ok && p.Bars.Count == 5 && s.Sent.Any(r => r.Path == "/v1/horses/h3/profile" && r.Method == "GET"), "raising: the horse card loads GET /v1/horses/:id/profile (5 stat bars)");
        var burst = p.Bars.First(x => x.Key == "burst");
        check(burst.ValueText == "734" && burst.TrainedText == "+14" && burst.Leaning && Math.Abs(burst.BaseRatio + burst.AwakeningRatio + burst.TrainedRatio - 0.734f) < 0.0001f, "raising: a bar is base + awakening + training on the engine's scale; the leaning stat is marked");
        check(p.Bars.First(x => x.Key == "speed").TrainedText == null && p.Bars.First(x => x.Key == "speed").AwakeningRatio > 0, "raising: an untrained stat has no +; awakening is its own segment");
        check(p.StageText == "成長期" && p.NextStageText == "充実期まで あと54" && p.PotentialText == "素質 30 / 240", "raising: stage 成長期, the next stage and the potential (" + p.NextStageText + ")");
        check(Math.Abs(p.StageProgress - (30 - 24) / 60f) < 0.0001f, "raising: progress inside the stage (24 → 84)");
        check(p.RankedText == "ランク戦（C級 上限 2,800）：合計は上限にそろえ、配分はそのまま", "raising: the ranked line says what survives the cap (" + p.RankedText + ")");
        check(p.LeaningText == "得意：瞬発（21.6% → 21.8%）", "raising: the leaning line (" + p.LeaningText + ")");
        check(p.GenerationText == "第2世代" && p.SkillOriginText == "固有スキル「末脚一閃」：母から" && p.AtavismText == "隔世遺伝：逃げ（ハツユキソウ）", "raising: lineage — generation, where the skill came from, 隔世遺伝");
        check(p.CareerText == "12戦3勝・ライバルに1回先着" && p.TotalText == "能力合計 3,360", "raising: the career line and the total");
        labels.AddRange(new[] { HorseProfileModel.Title, HorseProfileModel.OfflineText, HorseProfileModel.RulesText, p.StageText, p.NextStageText, p.PotentialText, p.RankedText, p.LeaningText, p.GenerationText, p.CareerText, p.TotalText,
            "ランク戦（S級 上限 4,000）まで あと 120", "素質いっぱいまで伸びました", "まだ走っていません", "大会優勝2回", "固有スキル「末脚一閃」：父と母から", "固有スキル「末脚一閃」：生まれつき" });
        labels.AddRange(GrowthStages.Ja);

        // ---- training: the outlook on the cards, the stage-up moment
        var t = new TrainingModel(b, kv);
        await t.LoadAsync("h3");
        var hill = t.Cards.First(c => c.Id == "hill");
        check(hill.OutlookText == "+5〜+6" && hill.OutlookReason == "疲れ −15%・絆 +1%", "raising: the hill card shows this horse's outlook and why (" + hill.OutlookText + " " + hill.OutlookReason + ")");
        check(t.Cards.First(c => c.Id == "pool").OutlookText == null, "raising: a menu without an outlook (older server) shows none");
        await t.StartAsync("hill");
        t.BeginMiniGame(0); t.Skip();
        var fin = await t.FinishAsync();
        check(fin.Ok && t.StageUp && t.StageText == "成長期" && t.StageUpText == "成長段階が上がりました：成長期", "raising: 22 → 30 of 240 crosses into 成長期 (the result's moment)");
        labels.AddRange(new[] { hill.OutlookText, hill.OutlookReason, t.StageUpText, "伸びしろ 80%" });

        // ---- breeding: intent and reveal
        var m = new BreedingModel(b, kv);
        await m.LoadAsync();
        m.SelectSire("own:h1"); m.SelectDam("h2");
        await m.PreviewAsync();
        check(m.RarityLine == "仔のレア度の見込み　SSR 1.5%・SR 20.5%・R 78.0%", "raising: the rarity odds line is the server's numbers (" + m.RarityLine + ")");
        var sireGifts = m.ParentGifts("sire"); var damGifts = m.ParentGifts("dam");
        check(sireGifts.SequenceEqual(new[] { "脚質 差し 47.5%" }) && damGifts.SequenceEqual(new[] { "脚質 逃げ 47.5%", "固有スキル「末脚一閃」 15.000%" }), "raising: what each parent passes on (" + string.Join(" | ", sireGifts.Concat(damGifts)) + ")");
        var br = await m.BreedAsync();
        check(br.Ok && m.Reveal != null && m.RevealStep == 0 && !m.RevealDone, "raising: a breeding starts the reveal at step 0");
        m.NextRevealStep(); m.NextRevealStep();
        check(m.RevealStep == 2, "raising: a tap uncovers the next step");
        m.RevealAll();
        check(m.RevealDone, "raising: すべて見る jumps to the end");
        check(m.RevealVerdict == "期待以上が2つ" && m.RevealRarityText == "SR（見込み 20.5%）" && m.RevealStyleText == "脚質 差し：父から" && m.Reveal.SkillFrom == "dam", "raising: verdict, rarity against its chance, the style's and the skill's origin (" + m.RevealVerdict + " / " + m.RevealRarityText + ")");
        labels.AddRange(new[] { m.RarityLine, m.RevealVerdict, m.RevealRarityText, m.RevealStyleText, "見込みどおり", "脚質 逃げ：隔世遺伝", "脚質 先行：父と母から", "脚質 追込：新しい脚質", "脚質 差し：母から" });
        labels.AddRange(sireGifts.Concat(damGifts));

        Loc.SetLocale("en");
        try
        {
            var missing = labels.Where(x => x != null && Loc.HasJapanese(Loc.T(x).Replace("アカツキ", "").Replace("ハツユキソウ", "").Replace("末脚一閃", ""))).ToList();
            check(missing.Count == 0, "raising: every label has English (" + string.Join(" | ", missing.Select(x => x + " → " + Loc.T(x))) + ")");
        }
        finally { Loc.SetLocale("ja"); }
        var all = string.Join("", labels.Where(x => x != null));
        check(!all.Contains("今だけ") && !all.Contains("残りわずか") && !all.Contains("倍") && !all.Contains("お得") && !all.Contains("ショップ") && !all.Contains("購入") && !new[] { "馬券", "オッズ", "配当", "的中", "賭" }.Any(all.Contains), "raising: no urgency, shop or betting words");
    }
}
