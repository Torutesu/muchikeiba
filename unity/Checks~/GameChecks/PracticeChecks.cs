// 練習レース (REQ-PRAC-001..018, contracts/protocol.md §50): PracticeModel over a routed fake server. The catalog stored for
// offline use, the built-in fallback, FTUE gating, the setup choices, a whole race on the device with the practice clock, the
// whip band and its a11y colour, restart with the same seed (same race) and the ghost, the result lines (no reward, no replay
// save / share buttons), KPI practice_start / practice_finish, and the English of every practice text.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class PracticeChecks
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

    const string Player = "{\"id\":\"n\",\"wallet\":{\"paid\":0,\"free\":0,\"total\":0,\"debt\":0},\"season\":{\"id\":\"2026-12\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[],\"equipment\":{\"tack\":{},\"decor\":[]},\"deletion\":{\"status\":\"none\"}}";

    /// <summary>Drives the model's race with 25 ms frames, START at the gate, whips from <paramref name="whipFromM"/> out every 25 ticks.</summary>
    static PracticeFrame Drive(PracticeModel p, ref long real, int whipFromM, List<PracticeFrame> frames = null)
    {
        var d = p.Driver;
        int lastWhip = -1000;
        PracticeFrame f = null;
        while (!d.Done)
        {
            var me = d.Sim.GetHorse(d.PlayerSlot);
            if (d.Sim.Tick >= d.Sim.P.GateOpenTick && !me.Departed) d.Input(Cmd.Start);
            if (me.Departed && !me.Finished && RaceFeel.RemainingMm(d.Sim, me) <= whipFromM * 1000L && d.Sim.Tick - lastWhip >= 25) { d.Input(Cmd.Whip); lastWhip = d.Sim.Tick; }
            real += 25;
            f = p.Frame(real);
            frames?.Add(f);
        }
        return f;
    }

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset, string root)
    {
        var sampleJson = File.ReadAllText(Path.Combine(root, "contracts", "practice-catalog.sample.json"));
        var s = new FakeServer();
        bool down = false;
        s.Routes["POST /v1/player/bootstrap"] = _ => new HttpResponse(200, Player);
        s.Routes["GET /v1/player"] = _ => new HttpResponse(200, Player);
        s.Routes["GET /v1/practice/catalog"] = _ => down ? new HttpResponse(503, "{\"error\":{\"code\":\"INTERNAL\",\"message\":\"x\"}}") : new HttpResponse(200, sampleJson);
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var kv = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, ruleset);
        await b.InitializeAsync();
        var events = new List<AnalyticsEvent>();
        long clock = 1796698800000L;
        bool inFtue = true;
        var p = new PracticeModel(b, () => inFtue, events.Add, () => clock);

        // ---- FTUE gating (§50.8)
        check(!p.Available, "practice is closed during the FTUE (it never competes with the first-race flow)");
        var load = await p.LoadAsync();
        check(load.Ok && p.Online && p.Catalog.Courses.Count == 8, "the catalog comes from GET /v1/practice/catalog");
        check(kv.Get(PracticeCatalog.StorageKey) == p.Catalog.Raw, "…and is stored on the device for offline use");
        check(p.StartRace() == null && p.Message == PracticeModel.FtueLocked, "starting during the FTUE is refused with the reason");
        inFtue = false;
        check(p.Available, "after the FTUE practice is open any time");

        // ---- setup choices
        check(p.Horses.Count == 3 && p.Horses.Exists(h => h.Partner && h.Selected), "own horses listed, the partner chosen first");
        check(p.Setup.TrackId == "kirameki_turf_2000" && p.Setup.FieldSize == 8 && p.Setup.StrengthId == "normal", "default: the practice course, 8 runners, normal");
        check(p.Strengths.Count == 4 && p.Strengths[0].Label == "やさしい" && p.Strengths[0].Detail == "初心者マッチと同じ相手", "strengths with their notes");
        check(p.FieldSizes.Count == 11 && p.FieldSizes[0].Label == "2頭" && p.FieldSizes[10].Label == "12頭", "field sizes 2..12");
        var unlit = p.Catalog.Courses.Find(c => !c.Lights);
        var lit = p.Catalog.Courses.Find(c => c.Lights);
        p.SelectCourse(unlit.TrackId);
        p.SelectNight(true);
        check(!p.NightAvailable && !p.Setup.Night, "night is offered only on courses with lights");
        p.SelectCourse(lit.TrackId);
        p.SelectNight(true);
        check(p.NightAvailable && p.Setup.Night && p.Setup.Going == lit.TodayGoing, "a lit course takes night; a new course starts on today's going");
        check(p.Goings.Count == 4 && p.Goings.Exists(g => g.Selected), "the four goings of the course's surface");
        p.SelectGoing("sloppy");
        if (lit.Surface == "turf") check(p.Problem == PracticeTexts.GoingMismatch && !p.CanStart, "a going of the other surface cannot start");
        p.SelectGoing(lit.Goings[0]);
        p.SelectFieldSize(13);
        check(p.Problem == "頭数は2〜12頭です", "13 runners refused with the range");
        p.SelectFieldSize(6);
        p.SelectStrength("strong");
        check(p.Problem == null && p.CanStart, "a valid setup can start");
        check(PracticeSetup.Decode(kv.Get(PracticeModel.KeySetup)).Encode() == p.Setup.Encode(), "the last valid setup is remembered on the device");
        p.SelectCourse("kirameki_turf_2000");
        p.SelectGoing("good");

        // ---- a race on the device
        p.SetOptions(whipWindow: true, slowFinal: true, ghost: true);
        var d = p.StartRace(seed: 2026);
        check(d != null && d.Config.Mode == RaceMode.Friend && PracticeSession.IsPractice(d.Config), "the race is an offline practice config (friend mode, practice_ id)");
        check(d.Config.Entrants.Count == 6, "6 runners");
        check(PhotoModeModel.CanPause(d) == false || d.Phase == RacePhase.Racing, "photo pause is offered once racing");
        check(events.Count == 1 && events[0].Name == "practice_start", "KPI practice_start on start");
        long real = clock;
        var frames = new List<PracticeFrame>();
        Drive(p, ref real, p.Session.Advice.Whip.StartRemainingM, frames);
        check(frames.Exists(f => f.BandFromM == p.Session.Advice.Whip.StartRemainingM + 50 && f.BandToM == Math.Max(0, p.Session.Advice.Whip.StartRemainingM - 150)), "the whip band = the advice check range");
        check(frames.Exists(f => f.InBand) && frames.Exists(f => !f.InBand), "the band lights only while the horse is inside it");
        check(frames.Exists(f => f.Slow), "slow motion ran in the last 400 m");
        check(frames.TrueForAll(f => f.BandColor == null || f.BandColor == AccessibilityTokens.Color(ColorMode.Standard, AccessibilityTokens.WhipChance)), "the band colour is the a11y token cue.whipChance");
        check(frames.TrueForAll(f => f.GhostLabel == null), "no ghost on the first attempt");
        check(PhotoModeModel.CanPause(d) == false && p.CanTakePhoto, "after the finish the result offers a photo");
        var r1 = p.Result();
        check(r1 != null && r1.Finished && r1.Place >= 1 && r1.Runners == 6, "the result: place out of 6");
        check(r1.Lines[r1.Lines.Count - 1] == PracticeTexts.NoReward, "「報酬はありません（練習）」 is always the last line");
        check(r1.Lines.Exists(l => l.StartsWith("ムチはアドバイスどおり")), "the advice comparison line (§39 CheckWhipTip)");
        check(string.Join(",", r1.Buttons) == "same_seed,new_seed,change,photo", "buttons: again / new rivals / change / photo — no save replay, no share card");
        check(events.FindAll(e => e.Name == "practice_finish").Count == 1, "KPI practice_finish once per attempt");
        p.Result();
        check(events.FindAll(e => e.Name == "practice_finish").Count == 1, "…even when the result is read again");
        var hash1 = d.Race.ResultHash;

        // ---- same seed again: the same race, with the ghost of attempt 1
        var d2 = p.Restart(PracticeRestart.SameSeed);
        check(events[events.Count - 1].Name == "practice_start", "KPI practice_start on the restart");
        var frames2 = new List<PracticeFrame>();
        Drive(p, ref real, p.Session.Advice.Whip.StartRemainingM, frames2);
        check(d2.Race.ResultHash == hash1, "same seed + same rider = the same race (slow motion and the ghost change nothing)");
        check(frames2.Exists(f => f.GhostLabel != null && f.GhostLabel.Contains("前回")), "the ghost of attempt 1 runs beside the player");
        var r2 = p.Result();
        check(r2.Lines.Contains(PracticeTexts.GhostSame), "the ghost delta line (the same time)");

        // ---- new seed: other rivals; the ghost option off drops the ghost
        p.SetOptions(whipWindow: false, slowFinal: false, ghost: false);
        var d3 = p.Restart(PracticeRestart.NewSeed);
        check(p.Session.Ghost == null, "ghost off: no ghost");
        var frames3 = new List<PracticeFrame>();
        Drive(p, ref real, 0, frames3);
        check(frames3.TrueForAll(f => f.BandFromM == null && !f.Slow), "options off: no band, no slow motion");
        var r3 = p.Result();
        check(!r3.Lines.Exists(l => l.Contains("アドバイス")), "with the whip guide off there is no advice line");

        // ---- reduced motion (§41): instant switches
        check(p.TransitionMs(300) == 300, "transitions animate by default");
        b.Accessibility.ReduceMotion = true;
        check(p.TransitionMs(300) == 0, "reduced motion: the slow-motion switch and the band are instant");
        b.Accessibility.ReduceMotion = false;
        var input = new RaceInput();
        b.Accessibility.WhipInput = WhipInput.Hold;
        p.ApplyAccessibility(input);
        check(input.WhipMode == WhipInput.Hold, "the whip hold of the accessibility settings rides practice too");
        b.Accessibility.WhipInput = WhipInput.Tap;

        // ---- offline: the stored catalog, then the built-in fallback
        down = true;
        var p2 = new PracticeModel(b, () => false, null, () => clock);
        await p2.LoadAsync();
        check(!p2.Online && p2.Catalog.Courses.Count == 8 && !p2.Catalog.IsFallback, "offline: the stored catalog");
        var empty = new GameBackend(new GameSettings { BaseUrl = "http://fake", OfflineOnly = true }, api, null, new MemoryKeyValueStore(), ruleset);
        await empty.InitializeAsync();
        var p3 = new PracticeModel(empty, () => false, null, () => clock);
        await p3.LoadAsync();
        check(p3.Catalog.IsFallback && p3.Catalog.Courses.Count == 1 && p3.Catalog.Horses.Count == 1, "never online: the built-in course and the default partner");
        var d4 = p3.StartRace(seed: 7);
        long real4 = clock;
        Drive(p3, ref real4, 400);
        check(d4.Done && p3.Result().Finished, "the fallback races to the line offline");
        down = false;
        check(!s.Sent.Exists(r => r.Path.StartsWith("/v1/practice/") && r.Method != "GET"), "nothing is ever sent to the server about a practice race");

        // ---- English (REQ-PRAC-018)
        Loc.LoadEnglish(File.ReadAllText(Path.Combine(root, "engine", "Muchi.Client", "Resources", "Muchi", "server-en.json")));
        Loc.LoadEnglish(File.ReadAllText(Path.Combine(root, "engine", "Muchi.Client", "Resources", "Muchi", "ui-en.json")));
        Loc.SetLocale("en");
        try
        {
            var texts = new List<string>
            {
                PracticeTexts.Title, PracticeTexts.NoReward, PracticeTexts.NoCatalog, PracticeTexts.PickHorse, PracticeTexts.PickCourse, PracticeTexts.GoingMismatch,
                PracticeTexts.NightNeedsLights, PracticeTexts.Field(2, 12), PracticeTexts.PickStrength, PracticeTexts.GhostDelta(-420), PracticeTexts.GhostDelta(1500), PracticeTexts.GhostSame, PracticeTexts.WhipBand,
                PracticeModel.ButtonSameSeed, PracticeModel.ButtonNewSeed, PracticeModel.ButtonChange, PracticeModel.ButtonPhoto, PracticeModel.Lead,
                PracticeModel.OptionWhip, PracticeModel.OptionSlow, PracticeModel.OptionGhost, PracticeModel.FtueLocked, "ナイターあり", "今日の馬場", "前回", "8頭", "3着 / 8頭",
            };
            foreach (var st in PracticeCatalog.DefaultStrengths()) { texts.Add(st.Name); texts.Add(st.Note); }
            foreach (var c in p.Catalog.Courses) texts.Add(c.Name);
            var missing = texts.FindAll(t => Loc.HasJapanese(Loc.T(t)));
            check(missing.Count == 0, "every practice text has English" + (missing.Count > 0 ? ": " + string.Join(" / ", missing) : ""));
            check(Loc.T(PracticeTexts.GhostDelta(-420)) == "0.42 s faster than last time", "the ghost delta in English");
            check(p.Result().Lines.TrueForAll(l => !Loc.HasJapanese(l)), "the result lines come out in English");
        }
        finally { Loc.SetLocale("ja"); }
    }
}
