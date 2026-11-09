// マイリプレイ (REQ-MYRP-001..016, contracts/protocol.md §37): MyReplaysModel over a routed fake server. The list cards
// (typed titles kept as typed, moments, real keep-until dates), save / rename / favourite / public / delete, the player on
// a real re-simulated race (speed, camera, last 200 m), 「再生できません」 for a retired ruleset or a hash mismatch, and KPI.
using System.Linq;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;
using Muchi.Net;

static class MyReplaysChecks
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

    const string PlayerJson = "{\"id\":\"a\",\"wallet\":{\"paid\":0,\"free\":500,\"total\":500,\"debt\":0},\"season\":{\"id\":\"2026-12\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[{\"id\":\"h1\",\"name\":\"アイボウ\",\"rarity\":\"SR\",\"status\":\"active\",\"base\":{\"speed\":700}}],\"equipment\":{\"tack\":{},\"decor\":[]}}";
    const string H64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    static string Saved(string id, string title, bool fav, bool pub, bool playable = true, string reason = null, long savedAt = 1796695300000) =>
        "{\"raceId\":\"" + id + "\",\"at\":1796695200000,\"mode\":\"ranked\",\"trackId\":\"kirameki_turf_2000\",\"place\":1,\"fieldSize\":12,\"slot\":0,\"resultHash\":\"" + H64 + "\",\"rulesetVersion\":\"1.3.0\",\"moment\":\"win\",\"replayTitle\":" + (title == null ? "null" : "\"" + title + "\"") +
        ",\"favorite\":" + (fav ? "true" : "false") + ",\"public\":" + (pub ? "true" : "false") + ",\"savedAt\":" + savedAt + ",\"sizeBytes\":18000,\"playable\":" + (playable ? "true" : "false") + ",\"reason\":" + (reason == null ? "null" : "\"" + reason + "\"") + "}";
    const string Moment = "{\"raceId\":\"r2\",\"at\":1796696200000,\"mode\":\"ranked\",\"trackId\":\"aoba_turf_1600\",\"place\":2,\"fieldSize\":12,\"slot\":1,\"resultHash\":\"" + H64 + "\",\"rulesetVersion\":\"1.3.0\",\"moment\":\"photo\",\"saved\":false,\"expiresAt\":1799115400000}";
    static string View(int used, string saved, string moments) => "{\"enabled\":true,\"maxSaved\":20,\"used\":" + used + ",\"titleMaxChars\":24,\"saved\":[" + saved + "],\"moments\":[" + moments + "],\"recent\":[]}";

    static HttpResponse Ok(string body) => new HttpResponse(200, body);

    /// <summary>A real ridden practice race and its §37 data (hash from the live run).</summary>
    static string Data(RulesetParams rs, bool playable = true, string reason = null, string hashOverride = null)
    {
        var cfg = RaceFactory.Practice(rs, RaceFactory.DefaultPartner("アイボウ"), 42);
        var race = new OfflineRace(cfg, 0);
        while (!race.IsFinished)
        {
            if (race.Sim.Tick == race.Sim.P.GateOpenTick) race.Input(Cmd.Start);
            race.StepOnce();
        }
        var log = new ReplayLog { Config = cfg, EndTick = race.Sim.Tick, Inputs = race.AllInputs().ToList() };
        var ents = JsonNode.Arr();
        for (int i = 0; i < cfg.Entrants.Count; i++) ents.Add(JsonNode.Obj().Set("slot", i).Set("horseName", cfg.Entrants[i].Horse.Name).Set("owner", i == 0 ? "you" : "cpu"));
        return JsonNode.Obj().Set("raceId", "r1").Set("owner", "me").Set("replayTitle", "差し切った日").Set("resultHash", hashOverride ?? race.Sim.Result.Hash).Set("focusSlot", 0)
            .Set("rulesetVersion", rs.RulesetVersion).Set("playable", playable).Set("reason", reason == null ? JsonNode.Null() : JsonNode.Str(reason))
            .Set("entrants", ents).Set("replayLog", ProtocolCodec.ReplayLogToJson(log)).ToString();
    }

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        var s = new FakeServer();
        s.Routes["POST /v1/player/bootstrap"] = _ => Ok(PlayerJson);
        s.Routes["GET /v1/player"] = _ => Ok(PlayerJson);
        string view = View(2, Saved("r1", "1着", true, false) + "," + Saved("r0", null, false, true, false, "ruleset_retired", 1796600000000), Moment);
        s.Routes["GET /v1/replays"] = _ => Ok(view);
        s.Routes["POST /v1/replays"] = r => r.Headers.ContainsKey("idempotency-key") ? Ok("{\"saved\":" + Saved("r2", null, false, false) + ",\"alreadySaved\":false,\"view\":" + View(3, Saved("r1", "1着", true, false) + "," + Saved("r2", null, false, false), "") + "}") : new HttpResponse(400, "{\"error\":{\"code\":\"IDEMPOTENCY_KEY_REQUIRED\"}}");
        s.Routes["PATCH /v1/replays/r1"] = r => Ok("{\"saved\":" + Saved("r1", r.Body.Contains("\"replayTitle\":null") ? null : "名勝負", !r.Body.Contains("\"favorite\":false"), r.Body.Contains("\"public\":true")) + "}");
        s.Routes["DELETE /v1/replays/r0"] = _ => Ok("{\"deleted\":true,\"view\":" + View(1, Saved("r1", "1着", true, false), Moment) + "}");
        string data = Data(ruleset);
        s.Routes["GET /v1/replays/r1/data"] = _ => Ok(data);
        s.Routes["GET /v1/replays/r0/data"] = _ => Ok(Data(ruleset, false, "ruleset_retired"));
        s.Routes["GET /v1/replays/rx/data"] = _ => Ok(Data(ruleset, true, null, H64));
        s.Routes["GET /v1/friends/f/replays/r9/data"] = _ => new HttpResponse(404, "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"no such player\"}}");
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, new MemoryKeyValueStore(), ruleset);
        await b.InitializeAsync();
        var events = new List<AnalyticsEvent>();
        var m = new MyReplaysModel(b, id => id == "kirameki_turf_2000" ? "きらめき 芝2000m" : id == "aoba_turf_1600" ? "青葉 芝1600m" : id, events.Add, () => 1796700000000L);

        var load = await m.LoadAsync();
        check(load.Ok && m.Enabled && m.CountText == "保存 2/20" && !m.Full, "my replays: list loads (" + m.CountText + ")");
        var cards = m.SavedCards;
        check(cards[0].Title == "1着" && cards[0].TitleIsTyped && cards[0].Favorite && cards[0].MomentText == "勝利" && cards[0].ResultText == "1着 / 12頭" && cards[0].DateText == "12/8", "my replays: a typed title stays as typed (「1着」), result, date, moment");
        check(cards[1].Title == "きらめき 芝2000m 1着" && !cards[1].TitleIsTyped && !cards[1].Playable && cards[1].UnplayableText == "古いルールのレースのため、再生できません", "my replays: no title → course + place; retired ruleset → 「再生できません」");
        var mo = m.MomentCards.Single();
        check(mo.MomentText == "写真判定" && mo.KeepUntilText == MyReplaysModel.Date(1799115400000 - 1) + "まで保存できます" && !mo.Saved, "my replays: best moment with its real keep-until date (" + mo.KeepUntilText + ")");
        check(m.TitleProblem(new string('あ', 25)) == "タイトルは1〜24文字です" && m.TitleProblem("  ") != null && m.TitleProblem("名勝負") == null, "my replays: the rename sheet checks the length locally");

        var save = await m.SaveAsync("r2");
        check(save.Ok && m.View.Used == 3 && s.Sent.Last(x => x.Method == "POST").Headers.ContainsKey("idempotency-key"), "my replays: 残す saves a moment with an idempotency key");
        var ren = await m.RenameAsync("r1", "名勝負");
        check(ren.Ok && m.View.Saved.First(x => x.RaceId == "r1").ReplayTitle == "名勝負", "my replays: rename");
        var clr = await m.RenameAsync("r1", "");
        check(clr.Ok && s.Sent.Last().Body.Contains("\"replayTitle\":null"), "my replays: an empty name clears the title");
        var pub = await m.SetPublicAsync("r1", true);
        check(pub.Ok && m.View.Saved.First(x => x.RaceId == "r1").Public && MyReplaysModel.TextPublicNote.Contains("馬の名前だけ"), "my replays: public toggle with the privacy note");
        var del = await m.DeleteAsync("r0");
        check(del.Ok && m.View.Used == 1, "my replays: delete");

        var p = await m.OpenAsync("r1");
        check(p != null && p.Playable && p.OwnSlot == 0, "my replays: the player re-simulates the race and verifies the hash (" + p?.Reason + ")");
        p.SetSpeed(2); p.Advance(1000);
        check(p.TimeMs == 2000 && MyReplaysModel.SpeedLabel(p.Speed) == "2×" && MyReplaysModel.SpeedLabel(0.5) == "0.5×", "my replays: 2× speed");
        p.SetCamera(3); p.JumpToFinalStretch();
        var f = p.Frame();
        check(f.CameraSlot == 3 && f.RemainingM <= 200.01 && f.RemainingM > 150, "my replays: camera on another horse, jump to its last 200 m (" + f.RemainingM.ToString("0.0") + " m)");
        var labels = MyReplaysModel.CameraLabels(ReplayData.FromJson(data));
        check(labels[0] == "アイボウ（あなた）" && labels.Count == 12, "my replays: camera labels are horse names only");
        var retired = await m.OpenAsync("r0");
        check(retired != null && !retired.Playable && m.Message == "古いルールのレースのため、再生できません", "my replays: a retired ruleset is never played");
        var wrong = await m.OpenAsync("rx");
        check(wrong != null && !wrong.Playable && wrong.Reason == ReplayUnplayable.HashMismatch && m.Message.Contains("再現できない"), "my replays: a different hash is never played");
        var hidden = await m.OpenFriendAsync("f", "r9");
        check(hidden == null && m.Message == "このリプレイは見られません", "my replays: a hidden friend replay says only that it cannot be viewed");

        m.Shared(false); m.Shared(true);
        check(events.Count == 2 && events.All(e => e.Name == "replay_share"), "my replays: replay_share KPI (my_replays / friend_replay)");
        check(!MyReplaysModel.TextFull.Contains("購入") && !MyReplaysModel.TextFull.Contains("ショップ"), "my replays: the full-list text never sells slots");

        // English: the game layer's texts come out in English; a typed title stays as typed
        Loc.SetLocale("en");
        try
        {
            var en = m.SavedCards[0];
            check(en.Title == "1着" && en.ResultText == "1st / 12" && en.MomentText == "Win", "my replays (en): typed title untouched, result / moment in English (" + en.ResultText + " / " + en.MomentText + ")");
            check(!Loc.HasJapanese(MyReplaysModel.Unplayable("hash_mismatch")) && !Loc.HasJapanese(m.CountText ?? "") && !Loc.HasJapanese(Loc.T(MyReplaysModel.TextPublicNote)), "my replays (en): unplayable, count and public note translated");
        }
        finally { Loc.SetLocale("ja"); }
    }
}
