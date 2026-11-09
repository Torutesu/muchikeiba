// 週替わりチャレンジ (REQ-WCH-001..016, contracts/protocol.md §31): WeeklyChallengeModel over a routed fake server and the
// real engine. Home card and list lines, a keyed start that survives a 5xx retry, the race on the issued config (the
// golden challenge configs the server builds) with the condition in the HUD, the device verdict equal to the evaluator,
// the server's verdict on the result screen (fail by whips, clear with the reward and the weekly badge), and English.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class WeeklyChallengeChecks
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

    const string PlayerJson = "{\"id\":\"t\",\"wallet\":{\"paid\":0,\"free\":500,\"total\":500,\"debt\":0},\"season\":{\"id\":\"2026-12\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[{\"id\":\"h1\",\"name\":\"アイボウ\",\"rarity\":\"SR\",\"status\":\"active\",\"base\":{\"speed\":700}}],\"equipment\":{\"tack\":{},\"decor\":[]}}";
    const string Whip3Card = "{\"id\":\"wa_whip3\",\"title\":\"ムチは3発まで\",\"trackId\":\"kirameki_turf_2000\",\"surface\":\"turf\",\"distanceM\":2000,\"going\":\"good\",\"night\":false,\"cpuCount\":7,\"cpuLevel\":3,\"cpuStatPermille\":1000,\"conditions\":{\"maxWhips\":3,\"maxPlace\":3},\"labels\":[{\"kind\":\"place\",\"text\":\"3着以内でゴール\"},{\"kind\":\"whips\",\"text\":\"ムチ3回以内\"}],\"reward\":{\"items\":[{\"itemId\":\"breeding_material\",\"qty\":1}]},\"loan\":{\"templateId\":\"t_natsu\",\"name\":\"ナツノアラシ\",\"style\":\"senko\",\"statTotal\":3200}";
    static string View(int cleared, bool whip3Cleared, bool badge) =>
        "{\"enabled\":true,\"weekId\":\"2026-11-02\",\"startsAt\":1793545200000,\"endsAt\":1794150000000,\"serverNow\":1793847600000,\"challenges\":["
        + "{\"id\":\"wa_nige\",\"title\":\"逃げ切りの一閃\",\"trackId\":\"aoba_turf_1600\",\"surface\":\"turf\",\"distanceM\":1600,\"going\":\"good\",\"night\":false,\"cpuCount\":7,\"cpuLevel\":3,\"cpuStatPermille\":1000,\"conditions\":{\"style\":\"nige\",\"maxPlace\":1},\"labels\":[{\"kind\":\"style\",\"text\":\"逃げの馬で出走\"},{\"kind\":\"place\",\"text\":\"1着でゴール\"}],\"reward\":{\"freeCoins\":10},\"loan\":{\"templateId\":\"t_hinode\",\"name\":\"ヒノデエクスプレス\",\"style\":\"nige\",\"statTotal\":3200},\"progress\":{\"cleared\":true,\"clearedAt\":1793847600000,\"attempts\":2,\"bestPlace\":1,\"bestTimeMs\":92009}},"
        + Whip3Card + ",\"progress\":{\"cleared\":" + (whip3Cleared ? "true" : "false") + ",\"clearedAt\":null,\"attempts\":0,\"bestPlace\":null,\"bestTimeMs\":null}},"
        + "{\"id\":\"wm_sloppy\",\"title\":\"不良馬場を走り切れ\",\"trackId\":\"santalucera_dirt_1700\",\"surface\":\"dirt\",\"distanceM\":1700,\"going\":\"sloppy\",\"night\":true,\"cpuCount\":5,\"cpuLevel\":2,\"cpuStatPermille\":1000,\"conditions\":{\"maxTimeMs\":79000},\"labels\":[{\"kind\":\"time\",\"text\":\"1:19.0以内で完走\"}],\"reward\":{\"items\":[{\"itemId\":\"breeding_material\",\"qty\":1}]},\"loan\":{\"templateId\":\"t_kawarabi\",\"name\":\"カワラビ\",\"style\":\"sashi\",\"statTotal\":3200},\"progress\":{\"cleared\":true,\"clearedAt\":1,\"attempts\":1,\"bestPlace\":3,\"bestTimeMs\":76000}}],"
        + "\"clearedCount\":" + cleared + ",\"badge\":{\"id\":\"wch_badge_aoba\",\"name\":\"青葉の一閃章\",\"earned\":" + (badge ? "true" : "false") + ",\"earnedAt\":null},\"startsLeftToday\":28,\"next\":null,\"badges\":[],\"badgeCount\":" + (badge ? 1 : 0) + ","
        + "\"rules\":{\"statCap\":3200,\"normalized\":true,\"skills\":false,\"loanAtCap\":true,\"paidBoosts\":false,\"rewardOncePerWeek\":true}}";
    static string Result(bool cleared, int place, int whips, bool first, bool badge) =>
        "{\"sessionId\":\"w1\",\"weekId\":\"2026-11-02\",\"challengeId\":\"wa_whip3\",\"resultHash\":\"x\",\"evaluation\":{\"finished\":true,\"place\":" + place + ",\"timeMs\":87419,\"whips\":" + whips + ",\"style\":\"senko\",\"cleared\":" + (cleared ? "true" : "false") + ",\"checks\":["
        + "{\"kind\":\"finish\",\"target\":null,\"actual\":1,\"ok\":true},{\"kind\":\"place\",\"target\":3,\"actual\":" + place + ",\"ok\":" + (place <= 3 ? "true" : "false") + "},{\"kind\":\"whips\",\"target\":3,\"actual\":" + whips + ",\"ok\":" + (whips <= 3 ? "true" : "false") + "}]},"
        + "\"cleared\":" + (cleared ? "true" : "false") + ",\"firstClear\":" + (first ? "true" : "false") + ",\"reward\":" + (first ? "{\"items\":[{\"itemId\":\"breeding_material\",\"qty\":1}]}" : "null") + ",\"clearedCount\":" + (cleared ? 3 : 2) + ","
        + "\"badge\":{\"id\":\"wch_badge_aoba\",\"name\":\"青葉の一閃章\",\"earned\":" + (badge ? "true" : "false") + ",\"newlyEarned\":" + (badge ? "true" : "false") + "},\"credited\":true}";

    static HttpResponse Ok(string body) => new HttpResponse(200, body);

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset, string root)
    {
        var golden = File.ReadAllText(Path.Combine(root, "contracts", "golden", "ts-config-challenge-wa_whip3.json"));
        var cfg = Muchi.Net.ProtocolCodec.ParseConfig(golden);
        int slot = cfg.Entrants.FindIndex(e => e.Kind == EntrantKind.Human);
        var s = new FakeServer();
        s.Routes["POST /v1/player/bootstrap"] = _ => Ok(PlayerJson);
        s.Routes["GET /v1/player"] = _ => Ok(PlayerJson);
        string view = View(2, false, false);
        s.Routes["GET /v1/challenges/weekly"] = _ => Ok(view);
        int starts = 0;
        s.Routes["POST /v1/challenges/weekly/wa_whip3/start"] = _ => ++starts == 1
            ? new HttpResponse(503, "{\"error\":{\"code\":\"INTERNAL\",\"message\":\"x\"}}")
            : Ok("{\"sessionId\":\"w1\",\"weekId\":\"2026-11-02\",\"challengeId\":\"wa_whip3\",\"playerSlot\":" + slot + ",\"config\":" + golden + ",\"expiresAt\":1793848500000,\"startsLeftToday\":27,\"challenge\":" + Whip3Card + "},\"token\":\"tok\"}");
        string result = Result(false, 2, 4, false, false);
        string lastSubmit = null;
        s.Routes["POST /v1/challenges/weekly/submit"] = r => { lastSubmit = r.Body; return Ok(result); };
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var kv = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, ruleset);
        await b.InitializeAsync();

        var m = new WeeklyChallengeModel(b);
        var load = await m.LoadAsync();
        check(load.Ok && m.Enabled && m.HomeTitle == "今週のチャレンジ 2/3" && m.HomeSubtitle == "あと4日で入れ替え", "challenge: home card (" + m.HomeTitle + " / " + m.HomeSubtitle + ")");
        var cards = m.Cards;
        check(cards.Count == 3 && cards[0].CourseText == "芝1600m・良" && cards[0].FieldText == "8頭立て・CPU Lv3" && cards[0].RewardText == "無償コイン10枚" && cards[0].Cleared, "challenge: list card course / field / reward (" + cards[0].CourseText + ")");
        check(cards[0].LoanText == "貸し出し馬：ヒノデエクスプレス（逃げ）" && cards[0].ProgressText == "挑戦 2回・最高 1着" && cards[0].Conditions.Select(c => c.Text).SequenceEqual(new[] { "逃げの馬で出走", "1着でゴール" }), "challenge: loan horse, progress and the server's condition lines");
        check(cards[2].CourseText == "ダート1700m・不良・ナイター" && cards[1].RewardText == "配合素材×1", "challenge: heavy ground at night and the material reward (" + cards[2].CourseText + ")");
        check(WeeklyChallengeModel.RulesText.Contains("上限") && !WeeklyChallengeModel.RulesText.Contains("倍") && !(WeeklyChallengeModel.RulesText + WeeklyChallengeModel.BadgeNote).Contains("ショップ") && WeeklyChallengeModel.BadgeNote.Contains("見た目だけ"), "challenge: the fairness rules and the cosmetic badge are stated as they are");

        // start: a 5xx keeps the key; the retry reuses it (one start used)
        var st1 = await m.StartAsync("wa_whip3");
        var st2 = await m.StartAsync("wa_whip3");
        var keys = s.Sent.Where(r => r.Path == "/v1/challenges/weekly/wa_whip3/start").Select(r => r.Headers["idempotency-key"]).ToList();
        check(!st1.Ok && st2.Ok && keys.Count == 2 && keys[0] == keys[1] && s.Sent.Last(r => r.Path.EndsWith("/start")).Body == "{\"loan\":true}", "challenge: the start retry reuses its idempotency key, with the loan horse");
        check(m.Phase == ChallengePhase.Racing && m.Run != null && m.Run.PlayerSlot == slot && m.Run.Race.Config.Mode == RaceMode.Challenge, "challenge: racing the issued config in the player's slot");
        var hud0 = m.HudLines();
        check(hud0.Count == 2 && hud0[1].Value == "ムチ 0/3" && hud0.All(l => l.Ok), "challenge: HUD shows the conditions (" + string.Join(" | ", hud0.Select(l => l.Text + " " + l.Value)) + ")");

        // ride: START on the gate, 4 whips from 400 m out → the whip condition breaks in the HUD
        var race = m.Run.Race;
        int whips = 0, last = -100;
        while (!race.IsFinished)
        {
            var me = race.Sim.GetHorse(slot);
            var left = race.Sim.Track.Distance - me.Distance;
            if (race.Sim.Tick == race.Sim.P.GateOpenTick) race.Input(Cmd.Start);
            if (me.Departed && left <= Fx.FromInt(400) && whips < 4 && race.Sim.Tick - last >= 24) { whips++; last = race.Sim.Tick; race.Input(Cmd.Whip); }
            race.StepOnce();
        }
        var hud = m.HudLines();
        check(hud[1].Value == "ムチ 4/3" && !hud[1].Ok, "challenge: the HUD turns the whip line red once it can no longer be met");
        var sub = await m.SubmitAsync();
        check(m.DeviceVerdict != null && !m.DeviceVerdict.Cleared && m.DeviceVerdict.Whips == 4 && m.DeviceVerdict.Place == ChallengeEvaluator.Evaluate(m.Run.Conditions, cfg, slot, race.RecordedInputs, race.Sim.Result).Place, "challenge: the device verdict is the evaluator's");
        check(lastSubmit != null && lastSubmit.Contains("\"sessionId\":\"w1\"") && !lastSubmit.Contains("cleared"), "challenge: the submit sends the run, never a verdict");
        var lines = m.ResultLines();
        check(sub.Ok && m.Phase == ChallengePhase.Result && m.ResultHeadline == "チャレンジ失敗" && lines[0].Value == "2着" && lines[0].Ok && lines[1].Value == "ムチ 4回" && !lines[1].Ok && m.RewardLine == null, "challenge: the server's verdict — failed by whips (" + string.Join(" | ", lines.Select(l => l.Text + " " + l.Value + (l.Ok ? " ○" : " ×"))) + ")");
        m.Continue();
        check(m.Phase == ChallengePhase.List, "challenge: back to the list");

        // a clear that completes the week: reward and the badge
        result = Result(true, 1, 2, true, true);
        view = View(3, true, true);
        starts = 1;
        await m.StartAsync("wa_whip3");
        while (!m.Run.Race.IsFinished) { if (m.Run.Race.Sim.Tick == m.Run.Race.Sim.P.GateOpenTick) m.Run.Race.Input(Cmd.Start); m.Run.Race.StepOnce(); }
        var ok = await m.SubmitAsync();
        check(ok.Ok && m.Cleared && m.ResultHeadline == "チャレンジ達成" && m.RewardLine == "報酬：配合素材×1" && m.BadgeLine == "バッジ「青葉の一閃章」を獲得" && m.WeekLine == "今週 3/3 クリア" && m.BadgeEarned, "challenge: clear → reward, week line and the badge (" + m.RewardLine + " / " + m.BadgeLine + ")");
        check(UxText.Errors.ContainsKey("CHALLENGE_HORSE_INELIGIBLE") && UxText.Errors.ContainsKey("CHALLENGE_LIMIT_REACHED"), "challenge: error sentences for the challenge codes");

        // English (REQ-WCH-015): every line the model builds and the server's lines
        Loc.SetLocale("en");
        try
        {
            var all = new List<string> { m.HomeTitle, m.HomeSubtitle, "今日で入れ替え", WeeklyChallengeModel.RulesText, WeeklyChallengeModel.BadgeNote, "週替わりチャレンジ", "チャレンジ失敗", "完走できず", "完走", "現在 3位",
                "週替わりチャレンジはオンラインで遊べます", "このチャレンジは今週のものではありません", "馬を選んでください", "レースが終わっていません", "今週の報酬は受け取り済み", m.RewardLine, m.BadgeLine, m.WeekLine };
            foreach (var c in cards) all.AddRange(new[] { c.Title, c.CourseText, c.FieldText, c.RewardText, c.LoanText, c.ProgressText }.Concat(c.Conditions.Select(x => x.Text)));
            all.AddRange(hud.Select(l => l.Value)); all.AddRange(lines.Select(l => l.Value)); all.Add(m.ResultHeadline);
            all.AddRange(new[] { "CHALLENGE_LIMIT_REACHED", "CHALLENGE_HORSE_INELIGIBLE", "CHALLENGE_SESSION_EXPIRED", "CHALLENGE_SESSION_USED", "CHALLENGE_RESULT_MISMATCH" }.Select(k => UxText.Errors[k]));
            var bad = all.Where(x => x != null && Loc.HasJapanese(Loc.T(x))).ToList();
            check(bad.Count == 0, "challenge: every line reads in English (" + all.Count(x => x != null) + ")" + (bad.Count > 0 ? ": " + string.Join(" | ", bad) : ""));
            check(Loc.T("ダート1700m・不良・ナイター") == "Dirt 1700 m, Sloppy, Night" && Loc.T("ムチ 4/3") == "Whip 4/3" && Loc.T("貸し出し馬：ヒノデエクスプレス（逃げ）").StartsWith("Loan horse: "), "challenge in English: " + Loc.T("ダート1700m・不良・ナイター") + " / " + Loc.T("貸し出し馬：ヒノデエクスプレス（逃げ）"));
        }
        finally { Loc.SetLocale("ja"); }
    }
}
