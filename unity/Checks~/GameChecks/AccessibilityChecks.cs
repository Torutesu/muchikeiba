// アクセシビリティ設定 (REQ-A11Y-001..016, contracts/protocol.md §41): AccessibilityModel over a routed fake server.
// Defaults, the device copy applied before the server answers, a change applied at once and PUT as a full body, an
// offline change kept as unsent and sent by the next sync, a change from another device arriving, the rows of the
// settings screen, the tokens / text scale / motion the screens bind, and the whip hold through RaceInput on a real race.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class AccessibilityChecks
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
    const string PlayerOld = "{\"id\":\"a\",\"wallet\":{\"paid\":0,\"free\":0,\"total\":0,\"debt\":0},\"season\":{\"id\":\"2026-12\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[],\"equipment\":{\"tack\":{},\"decor\":[]}}";

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        var s = new FakeServer();
        string stored = "{\"textSize\":\"standard\",\"colorMode\":\"standard\",\"reduceMotion\":false,\"haptics\":true,\"subtitles\":true,\"oneHanded\":\"off\",\"whipInput\":\"tap\",\"rev\":0,\"updatedAt\":null}";
        int rev = 0;
        s.Routes["POST /v1/player/bootstrap"] = _ => new HttpResponse(200, PlayerOld);
        s.Routes["GET /v1/settings/accessibility"] = _ => new HttpResponse(200, stored);
        s.Routes["PUT /v1/settings/accessibility"] = r =>
        {
            var body = AccessibilitySettings.Parse(r.Body);
            var before = AccessibilitySettings.Parse(stored);
            if (!body.SameValues(before)) rev++;
            body.Rev = rev; body.UpdatedAt = 1797000000000L + rev;
            stored = body.ToLocalJson();
            return new HttpResponse(200, stored);
        };
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var kv = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, ruleset);
        await b.InitializeAsync();
        check(b.Player.Accessibility.SameValues(AccessibilitySettings.Defaults), "a11y: an older server without `accessibility` reads as the defaults");
        var m = new AccessibilityModel(b);
        check(m.TextScaleFactor == 1f && m.Haptics && m.Subtitles && m.WhipInput == WhipInput.Tap && m.Motion.CameraShakeScale == 1f && m.Color(AccessibilityTokens.GaugeLow) == "#ffd34f",
            "a11y: defaults — standard text and colours, motion on, haptics and subtitles on, tap");

        // rows of the screen
        var rows = m.Rows();
        check(rows.Count == 7 && rows.FindAll(r => r.Group == "display").Count == 3 && rows[0].Key == "textSize" && rows[0].Choices.Count == 3 && rows[0].Choices[0].Selected
              && rows.TrueForAll(r => !string.IsNullOrEmpty(r.Description) && r.Choices.FindAll(c => c.Selected).Count == 1),
            "a11y: seven rows (display / controls), one choice selected each, a line each");

        // a change: applied at once, a full PUT, rev from the server
        var changed = 0; b.AccessibilityChanged += _ => changed++;
        var r1 = await m.SetAsync("textSize", "largest");
        var put = s.Sent.FindLast(x => x.Method == "PUT");
        check(r1.Ok && m.Settings.TextSize == TextSize.Largest && Math.Abs(m.Px(16) - 20.8f) < 0.01f && m.Px(32) == 32f && changed >= 1,
            "a11y: text size applies at once (16 px body → 20.8 px, headings unchanged) and screens are told");
        check(put != null && put.Body.Contains("\"textSize\":\"largest\"") && put.Body.Contains("\"whipInput\":\"tap\"") && m.Settings.Rev == 1 && !m.Dirty,
            "a11y: the PUT carries all seven keys; saved (rev 1, nothing unsent)");
        int puts = s.Sent.FindAll(x => x.Method == "PUT").Count;
        await m.SetAsync("textSize", "largest");
        check(s.Sent.FindAll(x => x.Method == "PUT").Count == puts, "a11y: choosing the selected value again sends nothing");
        await m.SetAsync("colorMode", "cvd");
        check(m.Color(AccessibilityTokens.GaugeCritical) == "#cc6633" && m.Color(AccessibilityTokens.GaugeOk) == "#00d2ed" && m.CriticalHatch,
            "a11y: colour-vision mode swaps the gauge tokens (cyan kept) and adds the critical hatch");
        await m.SetAsync("reduceMotion", "on");
        check(m.Motion.Reduced && m.Motion.CameraShakeScale == 0f && m.Motion.RevealGlowMs(380) == 0 && !m.Motion.GaugeBlink, "a11y: reduce motion → no shake, no reveal glow wait, no blink");

        // offline: applied, kept as unsent, sent by the next sync (device wins)
        var ob = new GameBackend(new GameSettings { BaseUrl = "http://fake", OfflineOnly = true }, api, null, kv, ruleset);
        await ob.InitializeAsync();
        int sentBefore = s.Sent.Count;
        var om = new AccessibilityModel(ob);
        var off = await om.SetAsync("haptics", "off");
        check(off.Ok && !om.Haptics && om.Dirty && off.Message == AccessibilityModel.TextOffline && s.Sent.Count == sentBefore && om.Settings.TextSize == TextSize.Largest,
            "a11y: offline, the change applies on top of the device copy and is kept as unsent");
        var fresh = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, ruleset);
        check(!fresh.Accessibility.Haptics && fresh.Accessibility.TextSize == TextSize.Largest, "a11y: a restart reads the device copy before any server answer");
        await fresh.InitializeAsync();
        var fm = new AccessibilityModel(fresh);
        var sync = await fm.SyncAsync(useBootstrap: true);
        check(sync.Ok && !fm.Dirty && stored.Contains("\"haptics\":false") && fresh.Accessibility.Rev == rev, "a11y: back online, the unsent change is PUT (the device wins)");

        // another device changed it: a sync without unsent changes adopts the server's value
        stored = stored.Replace("\"subtitles\":true", "\"subtitles\":false");
        await fm.SyncAsync();
        check(!fm.Subtitles, "a11y: a change from another device arrives with the next sync");

        // the whip hold through RaceInput on a real race: the press is a tap, then spaced whips, at most MaxRepeats
        await fm.SetAsync("whipInput", "hold");
        var input = new RaceInput();
        fm.ApplyTo(input);
        check(input.WhipMode == WhipInput.Hold && fm.HoldHint(2) == "長押し あと2" && new AccessibilityModel(b).HoldHint(2) == null, "a11y: hold mode reaches the race input; the HUD hint (none in tap mode)");
        var driver = (OfflineRaceDriver)fresh.CreatePracticeRace(5);
        var sim = driver.Sim;
        int whips = 0, starts = 0; long now = 0;
        input.SetWhipHeld(false);
        while (!sim.GetHorse(0).Departed && now < 60_000)
        {
            input.SetWhipHeld(sim.Tick >= sim.P.GateOpenTick);
            byte c = input.Collect(sim, 0);
            if ((c & Cmd.Start) != 0) starts++;
            driver.Input(c); now += 50; driver.Update(now);
        }
        input.SetWhipHeld(false); input.Collect(sim, 0);
        for (int i = 0; i < 2000 && !sim.IsFinished && ((sim.Track.Distance - sim.GetHorse(0).Distance).Raw >> 16) > 500; i++) { driver.Input(input.Collect(sim, 0)); now += 50; driver.Update(now); }
        var ticks = new List<int>();
        input.SetWhipHeld(true);
        while (!sim.IsFinished && now < 600_000)
        {
            byte c = input.Collect(sim, 0);
            if ((c & Cmd.Whip) != 0) { whips++; ticks.Add(sim.Tick); }
            driver.Input(c); now += 16; driver.Update(now);
        }
        bool spaced = true;
        for (int i = 1; i < ticks.Count; i++) spaced &= ticks[i] - ticks[i - 1] >= WhipHold.Spacing(ruleset);
        check(starts == 1 && whips == 1 + WhipHold.MaxRepeats(ruleset) && spaced && input.HoldRepeatsLeft(ruleset) == 0,
            "a11y: holding sends one START, then one whip on the press and " + WhipHold.MaxRepeats(ruleset) + " spaced repeats (got " + whips + ")");
        input.Reset();
        check(input.HoldRepeatsLeft(ruleset) == WhipHold.MaxRepeats(ruleset), "a11y: the hold budget is per race (Reset)");
    }
}
