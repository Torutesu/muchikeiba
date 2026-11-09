// かんたん操作 (REQ-ASSIST-001..012, contracts/protocol.md §27): AssistModel over a routed fake server. Default off, the
// three options, saving a level (the next practice race rides with it), the one-time suggestion only when the server
// says it is due and never in the FTUE, the HUD chip, and the tutorial never assisted.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class AssistChecks
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

    static string View(string level, bool due, bool shown = false) =>
        "{\"level\":\"" + level + "\",\"promptDue\":" + (due ? "true" : "false") + ",\"lastPlaceStreak\":3,\"promptShown\":" + (shown ? "true" : "false")
        + ",\"levels\":[\"off\",\"whip\",\"full\"],\"rules\":{\"ranked\":\"allowed\",\"cappedBelowSkilled\":true,\"shownToOpponents\":false,\"tutorial\":\"off\"}}";
    const string PlayerNoAssist = "{\"id\":\"a\",\"wallet\":{\"paid\":0,\"free\":0,\"total\":0,\"debt\":0},\"season\":{\"id\":\"2026-12\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[],\"equipment\":{\"tack\":{},\"decor\":[]}}";

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        var s = new FakeServer();
        string level = "off"; bool due = true, shown = false;
        s.Routes["POST /v1/player/bootstrap"] = _ => new HttpResponse(200, PlayerNoAssist);
        s.Routes["GET /v1/player/assist"] = _ => new HttpResponse(200, View(level, due && !shown && level == "off", shown));
        s.Routes["PUT /v1/player/assist"] = r =>
        {
            level = r.Body.Contains("\"full\"") ? "full" : r.Body.Contains("\"whip\"") ? "whip" : "off";
            if (r.Body.Contains("\"prompt\"")) shown = true;
            return new HttpResponse(200, View(level, false, shown));
        };
        s.Routes["POST /v1/player/assist/prompt-seen"] = _ => { shown = true; return new HttpResponse(200, View(level, false, true)); };
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var kv = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, ruleset);
        await b.InitializeAsync();
        check(b.AssistLevel == AssistLevel.Off && b.Player.Assist.Level == AssistLevel.Off, "assist: off by default (no `assist` from an older server is off too)");

        var m = new AssistModel(b);
        var load = await m.LoadAsync();
        check(load.Ok && m.Level == AssistLevel.Off && m.HudLabel == null, "assist: loads the server setting");
        var opts = m.Options;
        check(opts.Count == 3 && opts[0].Selected && opts[1].Label == "ムチだけおまかせ" && opts[2].Label == "ぜんぶおまかせ" && opts.TrueForAll(o => !string.IsNullOrEmpty(o.Description)),
            "assist: three options (off / whip / full) with a line each");
        check(m.ShouldShowPrompt(inFtue: false) && !m.ShouldShowPrompt(inFtue: true), "assist: the suggestion shows only when due and never in the FTUE");
        var sheet = m.Prompt();
        check(sheet.Options.Count == 2 && sheet.DismissLabel == "今はいい" && sheet.Note.Contains("相手には表示されません") && !(sheet.Title + sheet.Body).Contains("倍") && !(sheet.Title + sheet.Body).Contains("今だけ"),
            "assist: the sheet offers whip / full and a plain 「今はいい」, states the policy, no pressure words");
        await m.MarkPromptShownAsync();
        check(!m.ShouldShowPrompt(false) && s.Sent.Exists(r => r.Path == "/v1/player/assist/prompt-seen"), "assist: shown once (prompt-seen sent, not due any more)");

        var set = await m.SetAsync(AssistLevel.Whip, AssistSource.Prompt);
        check(set.Ok && b.AssistLevel == AssistLevel.Whip && m.HudLabel == "かんたん操作 ON" && s.Sent.Exists(r => r.Method == "PUT" && r.Body.Contains("\"whip\"") && r.Body.Contains("\"prompt\"")),
            "assist: choosing from the sheet saves the level with source prompt");

        // the next practice race rides with it; the HUD shows the chip; the tutorial never does
        var d = b.CreatePracticeRace(7);
        var off = (OfflineRaceDriver)d;
        check(off.Race.EffectiveAssist == AssistLevel.Whip, "assist: a practice race rides with the saved level");
        long now = 0;
        d.Update(now);
        while (!d.Done && now < 400_000) { now += 50; d.Update(now); }
        var hud = HudModel.Build(d, now);
        check(hud.Assist == AssistLevel.Whip && hud.AssistLabel == "かんたん操作 ON" && hud.WhipAuto && !hud.SteeringAuto, "assist: HUD chip 「かんたん操作 ON」, whip drawn as automatic");
        check(off.Race.RecordedInputs.Count(x => (x.Cmd & Cmd.Whip) != 0) > 0, "assist: the whip assist whipped through the normal input path");
        var tut = b.CreateTutorialRace(1);
        var th = HudModel.Build(tut, 0);
        check(((OfflineRaceDriver)tut).Race.Assistant == null && th.AssistLabel == null && AssistModel.RidingLevel(tut) == AssistLevel.Off, "assist: the tutorial is never assisted (REQ-ASSIST-006)");

        await m.SetAsync(AssistLevel.Full);
        var full = (OfflineRaceDriver)b.CreatePracticeRace(8);
        check(full.Race.EffectiveAssist == AssistLevel.Full && HudModel.Build(full, 0).SteeringAuto, "assist: full auto drives steering too");
        await m.SetAsync(AssistLevel.Off);
        var plain = (OfflineRaceDriver)b.CreatePracticeRace(9);
        check(plain.Race.Assistant == null && HudModel.Build(plain, 0).AssistLabel == null, "assist: off attaches nothing");

        // offline: the choice is kept on the device and rides the next offline race
        var ob = new GameBackend(new GameSettings { OfflineOnly = true }, null, null, new MemoryKeyValueStore(), ruleset);
        await ob.InitializeAsync();
        var om = new AssistModel(ob);
        var r = await om.SetAsync(AssistLevel.Full);
        check(r.Ok && ob.AssistLevel == AssistLevel.Full && ((OfflineRaceDriver)ob.CreatePracticeRace(1)).Race.EffectiveAssist == AssistLevel.Full, "assist: offline the choice stays on the device");

        // English (REQ-L10N): the options and the HUD chip
        Loc.SetLocale("en");
        try
        {
            var en = AssistModel.OptionsFor(AssistLevel.Off);
            check(en[1].Label == "Auto Whip" && en[2].Label == "Full Auto" && AssistLevels.HudLabel(AssistLevel.Full) == "Easy Controls ON" && !Loc.HasJapanese(new AssistModel(ob).Prompt().Body),
                "assist: English options, sheet and HUD chip");
        }
        finally { Loc.SetLocale("ja"); }
    }
}
