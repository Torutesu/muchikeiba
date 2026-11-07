// 調教 (REQ-TRAIN-001..014, contracts/protocol.md §25): TrainingModel over a routed fake server. Menu cards and why they
// are disabled, the mini-game (only taps the server would accept are recorded, the live score equals the server's
// scorer), keyed start / finish that survive a 5xx retry, an open session found on load finished as skipped, the item,
// and the fairness wording (no "倍", no shop link, ranked normalisation and "fatigue reaches no race" stated).
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class TrainingChecks
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

    const string PlayerJson = "{\"id\":\"t\",\"wallet\":{\"paid\":0,\"free\":500,\"total\":500,\"debt\":0},\"season\":{\"id\":\"2026-12\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[{\"id\":\"h1\",\"name\":\"アイボウ\",\"rarity\":\"SR\",\"status\":\"active\",\"base\":{\"speed\":700},\"trained\":{\"burst\":3}}],\"equipment\":{\"tack\":{},\"decor\":[]}}";

    static string Horse(int fatigue, string condition, int slotsLeft, string awaseBlocked = null, int owned = 0) =>
        "{\"horseId\":\"h1\",\"name\":\"アイボウ\",\"rarity\":\"SR\",\"trained\":{\"speed\":0,\"stamina\":2,\"burst\":3,\"guts\":1,\"temper\":0},\"trainedTotal\":6,\"potential\":240,\"perStatCap\":96,"
        + "\"fatigue\":" + fatigue + ",\"condition\":\"" + condition + "\",\"bondLevel\":1,\"todayCount\":1,\"sessions\":1,\"log\":[],\"blocked\":" + (slotsLeft > 0 ? "null" : "\"no_slots\"") + ","
        + "\"menus\":[{\"id\":\"hill\",\"blocked\":" + (awaseBlocked == null ? "null" : "\"" + awaseBlocked + "\"") + "},{\"id\":\"wood\",\"blocked\":null},{\"id\":\"pool\",\"blocked\":null},{\"id\":\"awase\",\"blocked\":" + (awaseBlocked == null ? "null" : "\"" + awaseBlocked + "\"") + "}]}";
    static string View(int slotsLeft = 2, int fatigue = 30, string condition = "fresh", string blocked = null, string open = "null", int owned = 0) =>
        "{\"enabled\":true,\"slotsPerDay\":3,\"usedToday\":" + (3 - slotsLeft) + ",\"slotsLeft\":" + slotsLeft + ",\"perHorsePerDay\":2,"
        + "\"menus\":[{\"id\":\"hill\",\"name\":\"坂路\",\"baseGain\":6,\"fatigue\":30,\"weights\":{\"burst\":2,\"guts\":1,\"stamina\":1},\"bondMultiplier\":1},{\"id\":\"wood\",\"name\":\"ウッド\",\"baseGain\":6,\"fatigue\":25,\"weights\":{\"speed\":2,\"stamina\":1,\"temper\":1},\"bondMultiplier\":1},{\"id\":\"pool\",\"name\":\"プール\",\"baseGain\":3,\"fatigue\":-20,\"weights\":{\"stamina\":2,\"temper\":1},\"bondMultiplier\":1},{\"id\":\"awase\",\"name\":\"併せ馬\",\"baseGain\":7,\"fatigue\":35,\"weights\":{\"guts\":2,\"speed\":1,\"burst\":1},\"bondMultiplier\":2}],"
        + "\"timing\":{\"beats\":5,\"durationMs\":6000,\"leadMs\":800,\"tailMs\":200,\"perfectMs\":60,\"goodMs\":150,\"perfectPoints\":2,\"goodPoints\":1,\"strayPenalty\":1,\"permillePerPoint\":10,\"maxTaps\":10,\"minTapGapMs\":80,\"maxScore\":10},"
        + "\"fatigue\":{\"max\":100,\"restAt\":80,\"recoveryPerDay\":40},\"items\":[{\"itemId\":\"training_apple\",\"name\":\"りんごのおやつ\",\"fatigueRelief\":30,\"owned\":" + owned + "}],"
        + "\"horses\":[" + Horse(fatigue, condition, slotsLeft, blocked, owned) + "],\"open\":" + open + ",\"rules\":{\"rankedNormalized\":true,\"fatigueAffectsRaces\":false,\"inherited\":false,\"paidBoosts\":false}}";
    const string Session = "{\"sessionId\":\"tr_a\",\"horseId\":\"h1\",\"menuId\":\"hill\",\"startedAt\":1,\"expiresAt\":600001,\"beats\":[814,1916,3236,4273,4887],\"durationMs\":6000}";
    static string Finish(string settled, int perfect, int score) =>
        "{\"sessionId\":\"tr_a\",\"horseId\":\"h1\",\"menuId\":\"hill\",\"grade\":\"" + (score >= 9 ? "great" : score >= 5 ? "good" : "normal") + "\",\"timing\":{\"perfect\":" + perfect + ",\"good\":0,\"miss\":" + (5 - perfect) + ",\"stray\":0,\"score\":" + score + ",\"bonusPermille\":" + (score * 10) + "},"
        + "\"gain\":{\"speed\":0,\"stamina\":2,\"burst\":3,\"guts\":1,\"temper\":0},\"total\":6,\"capped\":false,\"breakdown\":{\"efficiencyPermille\":1000,\"bondPermille\":0,\"timingPermille\":" + (score * 10) + ",\"softPermille\":1000},"
        + "\"trained\":{\"speed\":0,\"stamina\":4,\"burst\":6,\"guts\":2,\"temper\":0},\"trainedTotal\":12,\"potential\":240,\"fatigue\":60,\"settled\":\"" + settled + "\",\"void\":false,\"training\":" + View(1, 60, "normal") + "}";

    static HttpResponse Ok(string body) => new HttpResponse(200, body);

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        var s = new FakeServer();
        s.Routes["POST /v1/player/bootstrap"] = _ => Ok(PlayerJson);
        s.Routes["GET /v1/player"] = _ => Ok(PlayerJson);
        string view = View();
        s.Routes["GET /v1/training"] = _ => Ok(view);
        int starts = 0;
        s.Routes["POST /v1/training/start"] = _ => ++starts == 1
            ? new HttpResponse(503, "{\"error\":{\"code\":\"INTERNAL\",\"message\":\"x\"}}")
            : Ok("{\"session\":" + Session + ",\"preview\":{\"min\":6,\"max\":6,\"minMilli\":6000,\"maxMilli\":6600},\"slotsLeft\":1,\"training\":" + View(1, 60, "normal", null, Session) + "}");
        int finishes = 0;
        string lastFinishBody = null;
        s.Routes["POST /v1/training/tr_a/finish"] = r =>
        {
            lastFinishBody = r.Body;
            return ++finishes == 1 ? new HttpResponse(503, "{\"error\":{\"code\":\"INTERNAL\",\"message\":\"x\"}}") : Ok(Finish(r.Body.Contains("\"skipped\":true") ? "skipped" : "done", 5, 10));
        };
        s.Routes["POST /v1/training/items/training_apple/use"] = _ => Ok("{\"itemId\":\"training_apple\",\"horseId\":\"h1\",\"fatigueBefore\":60,\"fatigue\":30,\"remaining\":0,\"training\":" + View(1, 30) + "}");
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var kv = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, ruleset);
        await b.InitializeAsync();
        check(b.Partner != null && b.Partner.Trained.Burst == 3, "training: the player's horses carry the trained growth (Horse.Trained)");

        var m = new TrainingModel(b);
        var load = await m.LoadAsync();
        check(load.Ok && m.Enabled && m.HorseId == "h1" && m.Phase == TrainingPhase.Choose, "training: loads and selects the partner");
        check(m.SlotsText == "今日の調教 あと2回" && m.PotentialText == "素質 6 / 240" && m.FatigueText == "疲れ 30（好調）", "training: slots, potential and fatigue lines (" + m.SlotsText + " / " + m.PotentialText + " / " + m.FatigueText + ")");
        var cards = m.Cards;
        check(cards.Count == 4 && cards[0].Name == "坂路" && cards[0].FocusText == "瞬発・スタミナ・根性" && cards[0].FatigueText == "疲れ +30", "training: menu cards with the stats they grow (" + cards[0].FocusText + ")");
        check(cards[2].FatigueText == "疲れ −20（回復）" && cards[3].BondText == "絆が効く ×2" && cards.All(c => c.Enabled), "training: プール recovers, 併せ馬 uses the bond");
        check(TrainingModel.RulesText.Contains("クラスの上限") && TrainingModel.RulesText.Contains("疲れはどのレースにも影響しません") && !TrainingModel.RulesText.Contains("倍"), "training: the fairness rules are stated as they are");
        check(!(string.Join("", cards.Select(c => c.Name + c.FocusText + c.FatigueText + c.BondText)) + TrainingModel.RulesText).Contains("ショップ"), "training: no shop link / paid shortcut anywhere on the screen");

        // start: a 5xx keeps the key; the retry reuses it
        var st1 = await m.StartAsync("hill");
        var st2 = await m.StartAsync("hill");
        var startKeys = s.Sent.Where(r => r.Path == "/v1/training/start").Select(r => r.Headers["idempotency-key"]).ToList();
        check(!st1.Ok && st2.Ok && startKeys.Count == 2 && startKeys[0] == startKeys[1], "training: the start retry reuses its idempotency key (one slot used)");
        check(m.Phase == TrainingPhase.Ready && m.Session.Beats.Length == 5 && m.PreviewText == "見込み +6.0〜+6.6", "training: ready with the server's beats and the preview (" + m.PreviewText + ")");
        check(m.Tap(1000) == null, "training: no tap is recorded before the mini-game begins");

        // the mini-game: local monotonic clock from 10 000 ms
        m.BeginMiniGame(10_000);
        check(m.Phase == TrainingPhase.Playing && m.Elapsed(13_000) == 3000, "training: the beat track runs on the local clock");
        var j1 = m.Tap(10_000 + 820);
        var jDup = m.Tap(10_000 + 850); // < minTapGapMs after the previous tap: dropped like the server would refuse it
        var j2 = m.Tap(10_000 + 1916 + 100);
        m.Tap(10_000 + 3236); m.Tap(10_000 + 4273); m.Tap(10_000 + 4887);
        check(j1 == "perfect" && jDup == null && j2 == "good" && m.Taps.Count == 5, "training: judgements per tap; a tap the server would refuse is not recorded");
        var live = m.LiveScore;
        var server = TrainingScorer.Score(m.View.Timing, m.Session.Beats, m.Taps);
        check(live.Score == server.Score && live.Perfect == 4 && live.Good == 1 && live.Score == 9, "training: the live score is the server's scorer (◎4 ○1 → 9)");
        check(!m.MiniGameOver(10_000 + 5999) && m.MiniGameOver(10_000 + 6000), "training: the mini-game ends after its duration");

        // finish: a 5xx keeps the key and the taps; the retry sends the same
        var f1 = await m.FinishAsync();
        check(!f1.Ok && m.Phase == TrainingPhase.Submitting, "training: a 5xx on finish keeps the result pending");
        var f2 = await m.FinishAsync();
        var finKeys = s.Sent.Where(r => r.Path == "/v1/training/tr_a/finish").Select(r => r.Headers["idempotency-key"]).ToList();
        check(f2.Ok && finKeys.Count == 2 && finKeys[0] == finKeys[1] && lastFinishBody.Contains("\"taps\":[820,2016,3236,4273,4887]"), "training: the finish retry reuses its key and sends the recorded taps");
        check(m.Phase == TrainingPhase.Result && m.GradeText == "◎ 会心の追い切り" && m.ResultHeadline == "+6" && m.GainText == "スタミナ+2・瞬発+3・根性+1", "training: result headline, grade and the stat split (" + m.GainText + ")");
        check(m.TimingText == "ミニゲーム ◎5 ○0 ×0（+10%）" && m.SlotsText == "今日の調教 あと1回", "training: mini-game line and the refreshed slots");
        m.Continue();
        check(m.Phase == TrainingPhase.Choose, "training: back to the cards");

        // skip: no taps sent
        view = View(2);
        await m.LoadAsync();
        starts = 1; finishes = 1;
        await m.StartAsync("wood");
        m.Skip();
        await m.FinishAsync();
        check(lastFinishBody.Contains("\"skipped\":true") && lastFinishBody.Contains("\"taps\":[]") && m.TimingText == "ミニゲームなし", "training: skipping sends no taps and shows no mini-game line");

        // an open session found on load (app closed mid-game) is finished as skipped
        view = View(1, 60, "normal", null, Session);
        finishes = 1;
        var resumed = await m.LoadAsync();
        check(resumed.Ok && m.Phase == TrainingPhase.Result && lastFinishBody.Contains("\"skipped\":true"), "training: a left-over open session is finished as skipped on load");

        // tired: hard menus disabled with the reason; プール still available; the item
        view = View(1, 85, "tired", "tired", "null", owned: 1);
        await m.LoadAsync();
        var tired = m.Cards;
        check(!tired.First(c => c.Id == "hill").Enabled && tired.First(c => c.Id == "hill").BlockedText == "疲れがたまっています。プールか、1日休ませましょう" && tired.First(c => c.Id == "pool").Enabled && m.FatigueWarning, "training: a tired horse rests (only プール), with the reason");
        var bad = await m.StartAsync("hill");
        check(!bad.Ok && s.Sent.Count(r => r.Path == "/v1/training/start") == 3, "training: a disabled card is refused locally");
        check(m.CanUseItem, "training: the apple can be given to a tired horse");
        var use = await m.UseItemAsync();
        check(use.Ok && use.Message == "疲れ 60 → 30", "training: item use shows the fatigue change");

        // out of slots
        view = View(0);
        await m.LoadAsync();
        check(m.Cards.All(c => !c.Enabled && c.BlockedText == "今日の調教はおしまい。4:00に戻ります"), "training: no slots left → every card says when it comes back");

        // home and missions know the feature
        check(UnlockGate.Titles["training"] == "調教" && MissionBoardModel.KindTitles["training"] == "調教を1回" && HomeModel.TileKeys.Contains("training"), "training: unlock title, mission kind and the home tile");
        check(UxText.Errors.ContainsKey("TRAINING_TIRED") && UxText.Errors.ContainsKey("TRAINING_LIMIT"), "training: error sentences for the training codes");

        // English (REQ-L10N-010): every line the model builds (menu names come from the server, in English)
        Loc.SetLocale("en");
        try
        {
            var lines = new List<string> { "今日の調教 あと2回", "素質 6 / 240", "疲れ 30（好調）", "疲れ 85（お疲れ）", "瞬発・スタミナ・根性", "疲れ +30", "疲れ −20（回復）", "絆が効く ×2", "見込み +6.0〜+6.6",
                "◎ 会心の追い切り", "○ いい動き", "△ まずまず", "スタミナ+2・瞬発+3・根性+1", "ミニゲーム ◎5 ○0 ×0（+10%）", "ミニゲームなし", "伸びは次回へ持ち越し", "（小さな伸びは次回に加わります）",
                "疲れ 60 → 30", "疲れていません", "選べません", "調教が始まっていません", "調教はオンラインで行えます", "時間切れのため、ミニゲームなしで記録しました", TrainingModel.RulesText,
                UnlockGate.Titles["training"], MissionBoardModel.KindTitles["training"], "坂路", "りんごのおやつ" };
            lines.AddRange(new[] { "今日の調教はおしまい。4:00に戻ります", "この馬は今日はここまで。別の馬を選べます", "この馬は素質いっぱいまで伸びました", "疲れがたまっています。プールか、1日休ませましょう", "引退した馬は調教できません" });
            var badEn = lines.Where(x => x != null && Loc.HasJapanese(Loc.T(x))).ToList();
            check(badEn.Count == 0, "training: every line reads in English (" + lines.Count(x => x != null) + ")" + (badEn.Count > 0 ? ": " + string.Join(" | ", badEn) : ""));
            check(Loc.T("ミニゲーム ◎5 ○0 ×0（+10%）") == "Mini-game ◎5 ○0 ×0 (+10%)" && Loc.T("スタミナ+2・瞬発+3・根性+1") == "Stamina +2, Burst +3, Guts +1", "training in English: " + Loc.T("スタミナ+2・瞬発+3・根性+1"));
            check(new[] { "TRAINING_LIMIT", "TRAINING_TIRED", "TRAINING_POTENTIAL_FULL", "TRAINING_SESSION_EXPIRED", "TRAINING_INPUT_INVALID" }.All(k => !Loc.HasJapanese(Loc.T(UxText.Errors[k]))), "training: error sentences read in English");
        }
        finally { Loc.SetLocale("ja"); }

        // offline
        var off = new GameBackend(new GameSettings { BaseUrl = "http://fake", OfflineOnly = true }, api, null, new MemoryKeyValueStore(), ruleset);
        await off.InitializeAsync();
        var mo = new TrainingModel(off);
        var ol = await mo.LoadAsync();
        check(!ol.Ok && !mo.Enabled && mo.Cards.Count == 0, "training: offline shows the online-only notice and no cards");
    }
}
