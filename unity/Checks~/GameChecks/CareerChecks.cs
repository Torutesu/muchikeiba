// 騎手の道 (REQ-CAREER-001..024, contracts/protocol.md §66): CareerModel over a routed fake server and the real engine. The
// map (chapters, nodes, stars as text and shapes, the next marker, locked races), the race detail (course, field, objectives
// with rewards), a keyed start that survives a 5xx retry, the race on an issued career config with the clear objective in the
// HUD, the device stars equal to the evaluator's, the server's verdict on the result screen (stars, rewards, the opened race,
// the story's closing line), a locked race refused on the device, and English.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;
using Muchi.Net;

static class CareerChecks
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
    // produced by the real server (CareerService) after one verified 3rd place with one whip on c1_debut (first two chapters)
    const string View = @"{""enabled"":true,""version"":1,""chapters"":[{""id"":""c1"",""art"":""dawn"",""title"":""はじめての一閃"",""subtitle"":""見習い騎手、最初の三戦"",""statCap"":2800,""unlocked"":true,""cleared"":false,""stars"":2,""maxStars"":9,""clearedRaces"":1,""races"":[{""id"":""c1_debut"",""chapterId"":""c1"",""title"":""デビュー戦"",""story"":{""before"":""厩舎の朝は早い。相棒の首をなでて、ゲートへ向かう。まずは最後まで走り切ろう。"",""after"":""鞍を下ろすと、調教師がうなずいた。「悪くない。次は直線の長いコースだ」""},""trackId"":""aoba_turf_1600"",""surface"":""turf"",""distanceM"":1600,""going"":""good"",""night"":false,""fieldSize"":6,""cpuCount"":5,""cpuLevel"":1,""cpuStatPermille"":800,""cpuStyles"":null,""statCap"":2800,""objectives"":[{""star"":1,""objective"":{""maxPlace"":3},""labels"":[{""kind"":""place"",""text"":""3着以内でゴール""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}},{""star"":2,""objective"":{""maxPlace"":1},""labels"":[{""kind"":""place"",""text"":""1着でゴール""}],""reward"":{""items"":[{""itemId"":""training_apple"",""qty"":1}]}},{""star"":3,""objective"":{""maxPlace"":3,""maxWhips"":3},""labels"":[{""kind"":""place"",""text"":""3着以内でゴール""},{""kind"":""whips"",""text"":""ムチ3回以内""}],""reward"":{""items"":[{""itemId"":""training_apple"",""qty"":1}]}}],""progress"":{""unlocked"":true,""cleared"":true,""clearedAt"":1793847600000,""stars"":[1,3],""attempts"":1,""bestPlace"":3,""bestTimeMs"":93000,""rewarded"":{""clear"":true,""star2"":false,""star3"":true}}},{""id"":""c1_straight"",""chapterId"":""c1"",""title"":""長い直線"",""story"":{""before"":""直線が長いぶん、ムチを入れる時間もある。焦らず、光るまで待つ。"",""after"":""最後の一完歩まで脚が残っていた。待てば、馬は応えてくれる。""},""trackId"":""kirameki_turf_2000"",""surface"":""turf"",""distanceM"":2000,""going"":""good"",""night"":false,""fieldSize"":6,""cpuCount"":5,""cpuLevel"":1,""cpuStatPermille"":850,""cpuStyles"":null,""statCap"":2800,""objectives"":[{""star"":1,""objective"":{""maxPlace"":3},""labels"":[{""kind"":""place"",""text"":""3着以内でゴール""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}},{""star"":2,""objective"":{""maxPlace"":1},""labels"":[{""kind"":""place"",""text"":""1着でゴール""}],""reward"":{""items"":[{""itemId"":""training_apple"",""qty"":1}]}},{""star"":3,""objective"":{""maxPlace"":2,""maxWhips"":2},""labels"":[{""kind"":""place"",""text"":""2着以内でゴール""},{""kind"":""whips"",""text"":""ムチ2回以内""}],""reward"":{""items"":[{""itemId"":""training_apple"",""qty"":1}]}}],""progress"":{""unlocked"":true,""cleared"":false,""clearedAt"":null,""stars"":[],""attempts"":0,""bestPlace"":null,""bestTimeMs"":null,""rewarded"":{""clear"":false,""star2"":false,""star3"":false}}},{""id"":""c1_firstwin"",""chapterId"":""c1"",""title"":""初勝利をつかめ"",""story"":{""before"":""今日は勝ちにいく。スタートを決めて、直線で一閃。"",""after"":""初めての勝利。相棒が鼻を鳴らした。騎手の道は、ここから始まる。""},""trackId"":""kirameki_turf_2000"",""surface"":""turf"",""distanceM"":2000,""going"":""good"",""night"":false,""fieldSize"":7,""cpuCount"":6,""cpuLevel"":2,""cpuStatPermille"":900,""cpuStyles"":null,""statCap"":2800,""objectives"":[{""star"":1,""objective"":{""maxPlace"":1},""labels"":[{""kind"":""place"",""text"":""1着でゴール""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}},{""star"":2,""objective"":{""maxPlace"":1,""maxWhips"":4},""labels"":[{""kind"":""place"",""text"":""1着でゴール""},{""kind"":""whips"",""text"":""ムチ4回以内""}],""reward"":{""items"":[{""itemId"":""training_apple"",""qty"":1}]}},{""star"":3,""objective"":{""maxPlace"":1,""maxWhips"":2},""labels"":[{""kind"":""place"",""text"":""1着でゴール""},{""kind"":""whips"",""text"":""ムチ2回以内""}],""reward"":{""items"":[{""itemId"":""training_apple"",""qty"":1}]}}],""progress"":{""unlocked"":false,""cleared"":false,""clearedAt"":null,""stars"":[],""attempts"":0,""bestPlace"":null,""bestTimeMs"":null,""rewarded"":{""clear"":false,""star2"":false,""star3"":false}}}]},{""id"":""c2"",""art"":""rain"",""title"":""雨の日の手綱"",""subtitle"":""重い馬場で、脚をためる"",""statCap"":2800,""unlocked"":false,""cleared"":false,""stars"":0,""maxStars"":9,""clearedRaces"":0,""races"":[{""id"":""c2_drizzle"",""chapterId"":""c2"",""title"":""小雨の青葉"",""story"":{""before"":""芝が水を含んでいる。いつもより早く疲れる。手綱を引いて、息を入れよう。"",""after"":""息を入れた分だけ、最後に伸びた。重い馬場では手綱がものを言う。""},""trackId"":""aoba_turf_1600"",""surface"":""turf"",""distanceM"":1600,""going"":""yielding"",""night"":false,""fieldSize"":7,""cpuCount"":6,""cpuLevel"":2,""cpuStatPermille"":950,""cpuStyles"":null,""statCap"":2800,""objectives"":[{""star"":1,""objective"":{""maxPlace"":3},""labels"":[{""kind"":""place"",""text"":""3着以内でゴール""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}},{""star"":2,""objective"":{""maxPlace"":2},""labels"":[{""kind"":""place"",""text"":""2着以内でゴール""}],""reward"":{""items"":[{""itemId"":""training_apple"",""qty"":1}]}},{""star"":3,""objective"":{""maxPlace"":1},""labels"":[{""kind"":""place"",""text"":""1着でゴール""}],""reward"":{""items"":[{""itemId"":""training_apple"",""qty"":1}]}}],""progress"":{""unlocked"":false,""cleared"":false,""clearedAt"":null,""stars"":[],""attempts"":0,""bestPlace"":null,""bestTimeMs"":null,""rewarded"":{""clear"":false,""star2"":false,""star3"":false}}},{""id"":""c2_frontrunners"",""chapterId"":""c2"",""title"":""前が速い"",""story"":{""before"":""今日の相手は前へ行きたい馬ばかり。無理に追いかけず、後ろで構える。"",""after"":""前の馬たちは重い馬場で脚を使い切った。待った者が笑う日もある。""},""trackId"":""kirameki_turf_2000"",""surface"":""turf"",""distanceM"":2000,""going"":""soft"",""night"":false,""fieldSize"":7,""cpuCount"":6,""cpuLevel"":2,""cpuStatPermille"":950,""cpuStyles"":[""nige"",""senko""],""statCap"":2800,""objectives"":[{""star"":1,""objective"":{""maxPlace"":3},""labels"":[{""kind"":""place"",""text"":""3着以内でゴール""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}},{""star"":2,""objective"":{""maxPlace"":1},""labels"":[{""kind"":""place"",""text"":""1着でゴール""}],""reward"":{""items"":[{""itemId"":""training_apple"",""qty"":1}]}},{""star"":3,""objective"":{""maxPlace"":3,""maxWhips"":3},""labels"":[{""kind"":""place"",""text"":""3着以内でゴール""},{""kind"":""whips"",""text"":""ムチ3回以内""}],""reward"":{""items"":[{""itemId"":""training_apple"",""qty"":1}]}}],""progress"":{""unlocked"":false,""cleared"":false,""clearedAt"":null,""stars"":[],""attempts"":0,""bestPlace"":null,""bestTimeMs"":null,""rewarded"":{""clear"":false,""star2"":false,""star3"":false}}},{""id"":""c2_storm"",""chapterId"":""c2"",""title"":""嵐のみなと"",""story"":{""before"":""2400mの重馬場。最後まで脚を残せるかは、道中の我慢しだい。"",""after"":""ずぶ濡れの勝負服で引き上げる。雨の日の乗り方が、少しわかった。""},""trackId"":""minato_turf_2400"",""surface"":""turf"",""distanceM"":2400,""going"":""soft"",""night"":false,""fieldSize"":8,""cpuCount"":7,""cpuLevel"":2,""cpuStatPermille"":950,""cpuStyles"":null,""statCap"":2800,""objectives"":[{""star"":1,""objective"":{""maxPlace"":2},""labels"":[{""kind"":""place"",""text"":""2着以内でゴール""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}},{""star"":2,""objective"":{""maxPlace"":1},""labels"":[{""kind"":""place"",""text"":""1着でゴール""}],""reward"":{""items"":[{""itemId"":""training_apple"",""qty"":1}]}},{""star"":3,""objective"":{""maxPlace"":1,""maxWhips"":3},""labels"":[{""kind"":""place"",""text"":""1着でゴール""},{""kind"":""whips"",""text"":""ムチ3回以内""}],""reward"":{""items"":[{""itemId"":""training_apple"",""qty"":1}]}}],""progress"":{""unlocked"":false,""cleared"":false,""clearedAt"":null,""stars"":[],""attempts"":0,""bestPlace"":null,""bestTimeMs"":null,""rewarded"":{""clear"":false,""star2"":false,""star3"":false}}}]}],""totalStars"":2,""maxStars"":51,""clearedRaces"":1,""totalRaces"":17,""nextRaceId"":""c1_straight"",""startsLeftToday"":199,""rules"":{""skills"":false,""normalized"":true,""ranked"":false,""leaderboards"":false,""missions"":false,""energy"":false,""paidContinue"":false,""paidSkip"":false,""rewardOnce"":true}}";
    const string Start = @"{""sessionId"":""k9qhl49w1guq21yw99o3"",""raceId"":""c1_debut"",""chapterId"":""c1"",""playerSlot"":0,""config"":null,""expiresAt"":1793848500000,""startsLeftToday"":199,""race"":{""id"":""c1_debut"",""chapterId"":""c1"",""title"":""デビュー戦"",""story"":{""before"":""厩舎の朝は早い。相棒の首をなでて、ゲートへ向かう。まずは最後まで走り切ろう。"",""after"":""鞍を下ろすと、調教師がうなずいた。「悪くない。次は直線の長いコースだ」""},""trackId"":""aoba_turf_1600"",""surface"":""turf"",""distanceM"":1600,""going"":""good"",""night"":false,""fieldSize"":6,""cpuCount"":5,""cpuLevel"":1,""cpuStatPermille"":800,""cpuStyles"":null,""statCap"":2800,""objectives"":[{""star"":1,""objective"":{""maxPlace"":3},""labels"":[{""kind"":""place"",""text"":""3着以内でゴール""}],""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}},{""star"":2,""objective"":{""maxPlace"":1},""labels"":[{""kind"":""place"",""text"":""1着でゴール""}],""reward"":{""items"":[{""itemId"":""training_apple"",""qty"":1}]}},{""star"":3,""objective"":{""maxPlace"":3,""maxWhips"":3},""labels"":[{""kind"":""place"",""text"":""3着以内でゴール""},{""kind"":""whips"",""text"":""ムチ3回以内""}],""reward"":{""items"":[{""itemId"":""training_apple"",""qty"":1}]}}]},""conditions"":{""maxPlace"":3},""token"":""tok""}";
    const string Submit = @"{""sessionId"":""k9qhl49w1guq21yw99o3"",""raceId"":""c1_debut"",""chapterId"":""c1"",""resultHash"":""aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"",""evaluation"":{""finished"":true,""place"":3,""timeMs"":93000,""whips"":1,""style"":""sashi"",""cleared"":true,""checks"":[{""kind"":""finish"",""target"":null,""actual"":1,""ok"":true},{""kind"":""place"",""target"":3,""actual"":3,""ok"":true}]},""cleared"":true,""firstClear"":true,""objectives"":[{""star"":1,""ok"":true,""newly"":true,""evaluation"":{""finished"":true,""place"":3,""timeMs"":93000,""whips"":1,""style"":""sashi"",""cleared"":true,""checks"":[{""kind"":""finish"",""target"":null,""actual"":1,""ok"":true},{""kind"":""place"",""target"":3,""actual"":3,""ok"":true}]}},{""star"":2,""ok"":false,""newly"":false,""evaluation"":{""finished"":true,""place"":3,""timeMs"":93000,""whips"":1,""style"":""sashi"",""cleared"":false,""checks"":[{""kind"":""finish"",""target"":null,""actual"":1,""ok"":true},{""kind"":""place"",""target"":1,""actual"":3,""ok"":false}]}},{""star"":3,""ok"":true,""newly"":true,""evaluation"":{""finished"":true,""place"":3,""timeMs"":93000,""whips"":1,""style"":""sashi"",""cleared"":true,""checks"":[{""kind"":""finish"",""target"":null,""actual"":1,""ok"":true},{""kind"":""place"",""target"":3,""actual"":3,""ok"":true},{""kind"":""whips"",""target"":3,""actual"":1,""ok"":true}]}}],""stars"":[1,3],""newStars"":[1,3],""rewards"":[{""kind"":""clear"",""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]}},{""kind"":""star3"",""reward"":{""items"":[{""itemId"":""training_apple"",""qty"":1}]}}],""unlockedRaceId"":""c1_straight"",""chapterCleared"":false,""totalStars"":2}";

    static HttpResponse Ok(string body) => new HttpResponse(200, body);

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset, string root)
    {
        var sample = JsonNode.Parse(File.ReadAllText(Path.Combine(root, "contracts", "career-configs.sample.json"))).Get("races")[0];
        var cfgJson = sample.Get("config");
        var cfg = ProtocolCodec.ParseConfig(cfgJson);
        int slot = sample.Get("playerSlot").AsInt();
        var s = new FakeServer();
        s.Routes["POST /v1/player/bootstrap"] = _ => Ok(PlayerJson);
        s.Routes["GET /v1/player"] = _ => Ok(PlayerJson);
        s.Routes["GET /v1/career"] = _ => Ok(View);
        int starts = 0;
        var start = JsonNode.Parse(Start);
        start.Set("config", cfgJson);
        start.Set("playerSlot", slot);
        s.Routes["POST /v1/career/races/c1_debut/start"] = _ => ++starts == 1 ? new HttpResponse(503, "{\"error\":{\"code\":\"INTERNAL\",\"message\":\"x\"}}") : Ok(start.ToString());
        s.Routes["POST /v1/career/races/c1_firstwin/start"] = _ => new HttpResponse(409, "{\"error\":{\"code\":\"CAREER_LOCKED\",\"message\":\"x\"}}");
        string lastSubmit = null;
        s.Routes["POST /v1/career/submit"] = r => { lastSubmit = r.Body; return Ok(Submit); };
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var kv = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, ruleset);
        await b.InitializeAsync();

        var m = new CareerModel(b);
        var load = await m.LoadAsync();
        var map = m.Map();
        check(load.Ok && m.Enabled && map.Count == 2 && m.HeaderStars == "星 2/51" && m.HeaderClears == "クリア 1/17", "career: map header (" + m.HeaderStars + " / " + m.HeaderClears + ")");
        var c1 = map[0];
        check(c1.Kicker == "第1章" && c1.Title == "はじめての一閃" && c1.StarsText == "星 2/9" && c1.CapText == "能力の上限 2,800" && c1.Unlocked && !c1.Cleared && !map[1].Unlocked, "career: chapter rows (" + c1.Kicker + " " + c1.Title + " " + c1.StarsText + " " + c1.CapText + ")");
        var n0 = c1.Races[0];
        check(n0.Cleared && n0.StarsText == "星 2/3" && n0.StarGlyphs == "★★☆" && n0.Index == "第1戦" && c1.Races[1].Next && c1.Races[1].Unlocked && !c1.Races[2].Unlocked, "career: nodes — stars as text and shapes, the next marker, a locked race");
        check(CareerModel.EntryVisible(false) && !CareerModel.EntryVisible(true), "career: the lobby entry appears after the FTUE only");

        // detail
        m.Select("c1_debut");
        var r0 = m.Selected;
        check(m.Phase == CareerPhase.Detail && CareerModel.CourseText(r0) == "芝1600m・良" && CareerModel.FieldText(r0) == "6頭立て・CPU Lv1" && !string.IsNullOrEmpty(r0.StoryBefore), "career: race detail course / field (" + CareerModel.CourseText(r0) + " / " + CareerModel.FieldText(r0) + ")");
        var dl = m.DetailLines();
        check(dl.Count == 3 && dl[0].Text == "星1　3着以内でゴール" && dl[0].Ok && dl[0].RewardText == "受け取り済み" && !dl[1].Ok && dl[1].RewardText == "報酬：りんごのおやつ×1" && dl[2].Ok, "career: objectives with stars and rewards (" + string.Join(" | ", dl.Select(l => l.Text + " " + l.RewardText)) + ")");
        check(m.ProgressText == "挑戦 1回・最高 3着" && m.LockedText == null && m.CanStart, "career: progress line (" + m.ProgressText + ")");
        check(CareerModel.FieldText(m.View.Race("c2_frontrunners")) == "7頭立て・CPU Lv2・相手は逃げ・先行" && CareerModel.CourseText(m.View.Race("c2_storm")) == "芝2400m・重", "career: the CPU style field and heavy ground (" + CareerModel.FieldText(m.View.Race("c2_frontrunners")) + ")");
        m.Select("c1_firstwin");
        check(m.LockedText == "前のレースをクリアすると開きます" && !m.CanStart, "career: a locked race says what opens it");
        var locked = await m.StartAsync("h1");
        check(!locked.Ok && !s.Sent.Any(x => x.Path.Contains("c1_firstwin")), "career: a locked race is refused on the device (no request)");
        check(CareerModel.RulesText.Contains("一度だけ") && CareerModel.RulesText.Contains("無料") && !CareerModel.RulesText.Contains("倍") && CareerModel.NotCountedText.Contains("ランク戦"), "career: the fairness and no-energy rules are stated as they are");

        // start: a 5xx keeps the key; the retry reuses it
        m.Select("c1_debut");
        var st1 = await m.StartAsync("h1");
        var st2 = await m.StartAsync("h1");
        var keys = s.Sent.Where(r => r.Path == "/v1/career/races/c1_debut/start").Select(r => r.Headers["idempotency-key"]).ToList();
        check(!st1.Ok && st2.Ok && keys.Count == 2 && keys[0] == keys[1] && s.Sent.Last(r => r.Path.EndsWith("/start")).Body == "{\"horseId\":\"h1\"}", "career: the start retry reuses its idempotency key");
        check(m.Phase == CareerPhase.Racing && m.Run != null && m.Run.PlayerSlot == slot && m.Run.Race.Config.Mode == RaceMode.Challenge && m.Run.Objectives.Count == 3 && CareerRun.IsCareer(m.Run.Race.Config), "career: racing the issued config with three objectives");
        var hud0 = m.HudLines();
        check(hud0.Count == 1 && hud0[0].Text == "3着以内でゴール" && hud0[0].Ok, "career: HUD shows the clear objective (" + string.Join(" | ", hud0.Select(l => l.Text + " " + l.Value)) + ")");

        // ride: START on the gate, one whip in the straight
        var race = m.Run.Race;
        bool whipped = false;
        while (!race.IsFinished)
        {
            var me = race.Sim.GetHorse(slot);
            var left = race.Sim.Track.Distance - me.Distance;
            if (race.Sim.Tick == race.Sim.P.GateOpenTick) race.Input(Cmd.Start);
            if (!whipped && me.Departed && left <= Fx.FromInt(300)) { whipped = true; race.Input(Cmd.Whip); }
            race.StepOnce();
        }
        var hud = m.HudLines();
        var sub = await m.SubmitAsync();
        var devEval = ChallengeEvaluator.Evaluate(m.Run.Objectives[0], cfg, slot, race.RecordedInputs, race.Sim.Result);
        check(m.DeviceStars != null && (m.DeviceStars.Contains(1) == devEval.Cleared), "career: the device stars are the evaluator's ([" + string.Join(",", m.DeviceStars ?? new int[0]) + "])");
        check(lastSubmit != null && lastSubmit.Contains("\"sessionId\":") && !lastSubmit.Contains("\"stars\"") && !lastSubmit.Contains("cleared"), "career: the submit sends the run, never a verdict");
        var lines = m.ResultLines();
        check(sub.Ok && m.Phase == CareerPhase.Result && m.Headline == "クリア" && m.ResultStarsText == "星 2/3" && m.ResultGlyphs == "★★☆" && lines[0].Ok && lines[0].Newly && !lines[1].Ok && lines[2].Ok,
            "career: the server's verdict — stars 1 and 3 (" + string.Join(" | ", lines.Select(l => l.Text + (l.Ok ? " ○" : " ×") + (l.Newly ? " NEW" : ""))) + ")");
        check(m.RewardLines.SequenceEqual(new[] { "報酬：配合素材×1", "報酬：りんごのおやつ×1" }) && m.UnlockLine == "次のレース「長い直線」が開きました" && m.ChapterLine == null && !string.IsNullOrEmpty(m.StoryAfter) && m.RetryNote == null,
            "career: rewards once, the opened race and the story's closing line (" + string.Join(" / ", m.RewardLines) + " / " + m.UnlockLine + ")");
        m.Continue();
        check(m.Phase == CareerPhase.Detail && m.Run == null, "career: back to the race detail (retry is free)");
        check(new[] { "CAREER_LOCKED", "CAREER_LIMIT_REACHED", "CAREER_SESSION_EXPIRED", "CAREER_SESSION_USED", "CAREER_RESULT_MISMATCH" }.All(UxText.Errors.ContainsKey), "career: error sentences for the career codes");

        // English (REQ-CAREER-021): every line the model builds
        Loc.SetLocale("en");
        try
        {
            var all = new List<string> { m.HeaderStars, m.HeaderClears, CareerModel.RulesText, CareerModel.NotCountedText, "騎手の道", m.Headline, "あと一歩", m.ResultStarsText, m.UnlockLine, "第1章 クリア",
                "何度でも無料でやり直せます", "前のレースをクリアすると開きます", "このレースはありません", "レースを選んでください", "馬を選んでください", "レースが終わっていません", "受け取り済み",
                "騎手の道はオンラインで遊べます。練習レースはオフラインでも遊べます", m.ProgressText, CareerModel.FieldText(m.View.Race("c2_frontrunners")), CareerModel.CourseText(m.View.Race("c2_storm")) };
            foreach (var row in map) { all.AddRange(new[] { row.Kicker, row.StarsText, row.CapText }); all.AddRange(row.Races.Select(x => x.Index)); all.AddRange(row.Races.Select(x => x.StarsText)); }
            all.AddRange(dl.Select(l => l.Text)); all.AddRange(dl.Select(l => l.RewardText)); all.AddRange(lines.Select(l => l.Text)); all.AddRange(m.RewardLines); all.AddRange(hud.Select(l => l.Value));
            all.AddRange(new[] { "CAREER_LOCKED", "CAREER_LIMIT_REACHED", "CAREER_SESSION_EXPIRED", "CAREER_SESSION_USED", "CAREER_RESULT_MISMATCH" }.Select(k => UxText.Errors[k]));
            var bad = all.Where(x => x != null && Loc.HasJapanese(Loc.T(x))).ToList();
            check(bad.Count == 0, "career: every line reads in English (" + all.Count(x => x != null) + ")" + (bad.Count > 0 ? ": " + string.Join(" | ", bad) : ""));
            check(Loc.T("星 2/3") == "Stars 2/3" && Loc.T("第1章") == "Chapter 1" && Loc.T("星1　3着以内でゴール").StartsWith("Star 1"), "career in English: " + Loc.T("星1　3着以内でゴール") + " / " + Loc.T("7頭立て・CPU Lv2・相手は逃げ・先行"));
        }
        finally { Loc.SetLocale("ja"); }
    }
}
