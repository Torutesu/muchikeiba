// Checks for the Unity app's game layer (Assets/Muchi/Game) — runs with plain .NET, no Unity Editor.
//   dotnet run --project unity/Checks~/GameChecks                    offline checks
//   dotnet run --project unity/Checks~/GameChecks -- online <base>   + screens' server flow and a ranked race
using System.Diagnostics;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class Program
{
    static int failures;
    static string Root = FindRoot();

    static string FindRoot()
    {
        var d = new DirectoryInfo(AppContext.BaseDirectory);
        while (d != null && !File.Exists(Path.Combine(d.FullName, "contracts", "protocol.md"))) d = d.Parent;
        return d?.FullName ?? throw new Exception("repo root not found");
    }

    static void Check(bool ok, string what)
    {
        if (ok) Console.WriteLine("  ok    " + what);
        else { Console.WriteLine("  FAIL  " + what); failures++; }
    }

    static RulesetParams Ruleset() => RaceFactory.ParseRuleset(File.ReadAllText(Path.Combine(Root, "engine", "Muchi.Client", "Resources", "Muchi", "ruleset-params.default.json")));
    static CommentaryTemplates Commentary() => CommentaryTemplates.Parse(File.ReadAllText(Path.Combine(Root, "engine", "Muchi.Client", "Resources", "Muchi", "commentary-ja.json")));

    static async Task<int> Main(string[] args)
    {
        Console.WriteLine("== Muchi.Game offline checks");
        InputMapping();
        TutorialRaceThroughTheGlue();
        PracticeRaceAndCourseFrame();
        PartnerCatalogCoverage();
        SettingsAndOfflineBackend();
        await OfflineFallbackWhenServerUnreachable();
        await OfflineScreenModels();
        if (args.Length >= 2 && args[0] == "online")
        {
            Console.WriteLine("== Muchi.Game online checks against " + args[1]);
            await Online(args[1]);
        }
        Console.WriteLine(failures == 0 ? "GAME CHECKS OK" : "GAME CHECKS FAILED: " + failures);
        return failures == 0 ? 0 : 1;
    }

    // ---------------------------------------------------------------- input
    static void InputMapping()
    {
        var input = new RaceInput();
        var atGate = new HorseState { Departed = false };
        var running = new HorseState { Departed = true };
        input.Spur();
        Check(input.Collect(atGate) == Cmd.Start, "SPUR before departure sends START");
        input.Spur();
        Check(input.Collect(running) == Cmd.Whip, "SPUR after departure sends WHIP");
        input.Lane(-1);
        Check(input.Collect(running) == Cmd.LaneIn, "screen-left on a left-handed course = LANE_IN (inside rail is on the left)");
        input.LeftHanded = false; input.Lane(-1);
        Check(input.Collect(running) == Cmd.LaneOut, "screen-left on a right-handed course = LANE_OUT");
        input.SetRein(true);
        Check(input.Collect(running) == Cmd.ReinPress, "holding REIN sends REIN_PRESS once");
        Check(input.Collect(running) == 0, "…and nothing while still held");
        input.SetRein(false);
        Check(input.Collect(running) == Cmd.ReinRelease, "releasing sends REIN_RELEASE");
        Check(input.Collect(running) == 0, "no input = 0");
    }

    /// <summary>A rider policy like a player: start, rein mid-race on long courses, spaced whips late.</summary>
    static void Ride(IRaceDriver d, RaceInput input, int[] lastWhip)
    {
        var sim = d.Sim;
        if (sim == null || d.PlayerSlot < 0) return;
        var me = sim.GetHorse(d.PlayerSlot);
        int remaining = d.Config.Track.DistanceM - (int)(me.Distance.Raw >> 16);
        if (!me.Departed && sim.GateOpened) input.Spur();
        else if (me.Departed && remaining <= 400 && me.WhipsLeft > 0 && sim.Tick - lastWhip[0] >= 24) { input.Spur(); lastWhip[0] = sim.Tick; }
        d.Input(input.Collect(me));
    }

    // ---------------------------------------------------------------- tutorial (offline, the first ride)
    static void TutorialRaceThroughTheGlue()
    {
        var backend = new GameBackend(new GameSettings { OfflineOnly = true }, null, null, new MemoryKeyValueStore(), Ruleset());
        var d = (OfflineRaceDriver)backend.CreateTutorialRace();
        var input = new RaceInput();
        var feed = new CommentaryFeed(Commentary(), d.Config, d.PlayerSlot);
        long now = 1_000_000;
        int[] lastWhip = { -100 };
        int prevRemaining = int.MaxValue, prevWhips = int.MaxValue;
        bool hudOk = true, sawSubtitle = false;
        var subtitles = new List<string>();
        for (int frame = 0; frame < 60 * 120 && !d.Done; frame++)
        {
            Ride(d, input, lastWhip);
            d.Update(now);
            var hud = HudModel.Build(d, now);
            if (hud.HasRace)
            {
                hudOk &= hud.Rank >= 1 && hud.Rank <= hud.Runners && hud.StaminaPermille >= 0 && hud.StaminaPermille <= 1000;
                hudOk &= hud.RemainingM <= prevRemaining && hud.WhipsLeft <= prevWhips && hud.Progress.Length == hud.Runners;
                prevRemaining = hud.RemainingM; prevWhips = hud.WhipsLeft;
            }
            string sub = feed.Update(d.Sim);
            if (sub.Length > 0) { sawSubtitle = true; if (subtitles.Count == 0 || subtitles[^1] != sub) subtitles.Add(sub); }
            // the renderer's view: every runner has an interpolated pose on the course
            var frameCourse = CourseFrame.For(d.Config, d.Visuals);
            for (int s = 0; s < d.Sim.EntrantCount; s++)
                if (d.TryGetRender(s, now, out var from, out var to, out var alpha)) { var p = frameCourse.Horse(from, to, alpha); hudOk &= !double.IsNaN(p.X) && !double.IsNaN(p.Z); }
            now += 16;
        }
        Check(d.Done, "tutorial race finishes when driven frame by frame (16 ms frames)");
        Check(hudOk, "HUD stays consistent every frame (rank, stamina‰, remaining distance, whips, runner poses)");
        var final = HudModel.Build(d, now);
        Check(final.FinishPlace >= 1 && final.FinishPlace <= d.Sim.EntrantCount, "player's finishing place is known (" + final.FinishPlace + ")");
        Check(final.WhipsLeft < d.Config.Ruleset.MaxWhips, "SPUR presses reached the engine as whips (" + final.WhipsLeft + " left)");
        Check(sawSubtitle, "commentary produced subtitles (" + subtitles.Count + " lines, first: " + (subtitles.FirstOrDefault() ?? "-") + ")");
        // The recorded inputs replay to the identical result: the app's race is the engine's race.
        var replay = RaceReplay.Run(d.Config, d.Race.RecordedInputs.ToList());
        Check(replay.Result.Hash == d.Sim.Result.Hash, "offline race replays to the same result hash from its recorded inputs");
        Check(HudModel.FormatTime(83_456) == "1:23.4", "race clock format m:ss.f");
    }

    // ---------------------------------------------------------------- practice race + course placement
    static void PracticeRaceAndCourseFrame()
    {
        var rs = Ruleset();
        var cfg = RaceFactory.Practice(rs, RaceFactory.DefaultPartner("テスト"), 42);
        Check(cfg.Entrants.Count == 12, "practice race has 12 runners");
        var frame = CourseFrame.For(cfg, RaceVisuals.Fallback(cfg));
        var fin = frame.At(cfg.Track.DistanceM, 0);
        Check(Math.Abs(fin.X) < 1e-6 && Math.Abs(fin.Z - CourseFrame.DefaultFinishZ) < 1e-6 && Math.Abs(fin.YawDegrees) < 1e-6, "finish line is placed at (0, 420) facing +Z (grandstand side) " + fin);
        var outside = frame.At(cfg.Track.DistanceM, 5);
        Check(outside.X > 4.9, "left-handed course: outside lanes are to the right (+X) on the home straight");
        var line = frame.Line(0, 10, 0);
        double maxGap = 0;
        for (int i = 1; i < line.Count; i++) maxGap = Math.Max(maxGap, Math.Sqrt(Math.Pow(line[i].X - line[i - 1].X, 2) + Math.Pow(line[i].Z - line[i - 1].Z, 2)));
        Check(maxGap <= 10.0001, "rail polyline is continuous (max gap " + maxGap.ToString("0.###") + " m for 10 m steps)");
        var right = new CourseFrame(new TrackGeometry(cfg.Track, leftHanded: false), rs);
        Check(right.At(cfg.Track.DistanceM, 5).X < -4.9, "right-handed course: outside lanes are to the left (-X)");

        var d = new OfflineRaceDriver(cfg, 0, autoStart: false);
        var input = new RaceInput();
        long now = 0; int[] lastWhip = { -100 };
        while (!d.Done && now < 400_000) { Ride(d, input, lastWhip); d.Update(now); now += 33; }
        var hud = HudModel.Build(d, now);
        Check(d.Done && hud.FinishPlace >= 1, "offline practice race (2000 m, 12 runners) completes with a place (" + hud.FinishPlace + ", " + HudModel.FormatTime(hud.ElapsedMs) + ")");
    }

    // ---------------------------------------------------------------- asset contract → Codex's partner models
    static void PartnerCatalogCoverage()
    {
        string unityRes = Path.Combine(Root, "unity", "Assets", "Resources");
        var catalog = PartnerCatalog.Parse(File.ReadAllText(Path.Combine(unityRes, "Models", "Partners", "catalog.json")));
        using var manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(Root, "contracts", "assets.manifest.json")));
        var keys = manifest.RootElement.GetProperty("keys").EnumerateArray().Select(k => k.GetString()).ToList();
        using var visuals = JsonDocument.Parse(File.ReadAllText(Path.Combine(Root, "server", "master", "visuals.json")));
        var palette = PaletteIds(visuals.RootElement.GetProperty("palette")).ToList();
        var problems = catalog.CoverageProblems(keys, palette);
        foreach (var p in problems) Console.WriteLine("        " + p);
        Check(problems.Count == 0, "every horse/* and silks/* manifest key and palette colour maps to a partner model or a documented fallback (" + keys.Count(k => k.StartsWith("horse/") || k.StartsWith("silks/")) + " keys, " + palette.Count + " colours)");
        bool filesOk = true;
        foreach (var v in catalog.Variants)
        {
            filesOk &= File.Exists(Path.Combine(unityRes, v.Model + ".fbx"));
            if (v.OpponentLod != null) filesOk &= File.Exists(Path.Combine(unityRes, v.OpponentLod + ".fbx"));
        }
        Check(filesOk && catalog.Variants.Count == 25, "all 25 catalog models (+ opponent LODs) exist under Assets/Resources");
        foreach (var f in PartnerCatalog.Featured) Check(catalog.Get(f) != null, "wardrobe partner " + f + " is in the catalog");
        var pick = catalog.Resolve(new Appearance { Coat = "chestnut", Mane = "flaxen" }, new Silks { Colors = new[] { "white", "gold" } });
        Check(pick?.Id == "Partner_Palomino_Gold", "flaxen chestnut + white/gold silks → Partner_Palomino_Gold (neutral colour skipped)");
        Check(catalog.Resolve(null, null)?.Id == "Partner_Bay_Crimson", "missing looks fall back to Partner_Bay_Crimson");
    }

    static IEnumerable<string> PaletteIds(JsonElement palette)
    {
        if (palette.ValueKind == JsonValueKind.Array)
        {
            foreach (var e in palette.EnumerateArray())
                yield return e.ValueKind == JsonValueKind.String ? e.GetString() : e.GetProperty("id").GetString();
        }
        else foreach (var p in palette.EnumerateObject()) yield return p.Name;
    }

    // ---------------------------------------------------------------- settings / offline backend
    static void SettingsAndOfflineBackend()
    {
        var s = GameSettings.Parse("{\"environment\":\"staging\",\"baseUrl\":\"https://api-staging.example\",\"offlineOnly\":true,\"matchPollMs\":500}");
        Check(s.Environment == "staging" && !s.UsesDevAuth && s.OfflineOnly && s.MatchPollMs == 500, "server-config.json parses");
        Check(s.WebSocketUrl("/v1/race/r_1/ws") == "wss://api-staging.example/v1/race/r_1/ws", "https base → wss race URL");
        Check(new GameSettings { BaseUrl = "http://127.0.0.1:8787/" }.WebSocketUrl("/x") == "ws://127.0.0.1:8787/x", "http base → ws race URL");
        Check(GameSettings.Parse(File.ReadAllText(Path.Combine(Root, "unity", "Assets", "Resources", "Muchi", "server-config.json"))).UsesDevAuth, "bundled server-config.json targets local dev (npm run dev)");

        var kv = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { OfflineOnly = true }, null, null, kv, Ruleset());
        b.InitializeAsync().GetAwaiter().GetResult();
        Check(!b.Online && b.OfflineReason == "offlineOnly", "offlineOnly settings → offline mode");
        var r = b.NamePartnerAsync("アカツキ").GetAwaiter().GetResult();
        Check(r.Ok && b.Profile().PartnerName == "アカツキ", "offline naming is stored locally");
        Check(b.PurchaseCheckAsync("coin_160").GetAwaiter().GetResult().Ok == false, "offline purchase check explains it needs the server");
        Check(b.StartRankedAsync(null).GetAwaiter().GetResult().message == "OFFLINE", "offline ranked entry refuses (screen falls back to practice)");
    }

    sealed class DeadHttp : IHttp
    {
        public Task<HttpResponse> SendAsync(HttpRequest request, CancellationToken ct) => throw new IOException("connection refused");
    }

    static async Task OfflineFallbackWhenServerUnreachable()
    {
        var api = new ApiClient(new DeadHttp(), null, new ApiClientOptions { BaseUrl = "http://127.0.0.1:1", DevUserId = "x", Retry = new RetryPolicy { MaxRetries = 0 } });
        var b = new GameBackend(new GameSettings(), api, null, new MemoryKeyValueStore(), Ruleset());
        await b.InitializeAsync();
        Check(!b.Online && !string.IsNullOrEmpty(b.OfflineReason), "unreachable server → offline mode instead of a crash (" + b.OfflineReason + ")");
        Check(b.CreatePracticeRace(7) != null, "offline mode still races (practice)");
    }

    // ---------------------------------------------------------------- round 6 screen models offline (local fallback)
    static async Task OfflineScreenModels()
    {
        var kv = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { OfflineOnly = true }, null, null, kv, Ruleset());
        await b.InitializeAsync();
        var care = new CareModel(b, kv);
        await care.LoadAsync();
        Check(!care.Online && care.Bond == null && care.SelectedCard == 0, "care screen offline: local data, first card selected");
        var cr = await care.CareAsync(2);
        Check(cr.Ok && care.SelectedCard == 2 && kv.Get(CareModel.KeyLocalFeed) == "2", "offline care choice is kept on the device (muchi.care.feed)");
        var care2 = new CareModel(b, kv); await care2.LoadAsync();
        Check(care2.SelectedCard == 2 && !care2.AffectsRankedStats, "…and restored on the next visit; bond never affects ranked stats");

        var looks = new CourseLooksModel(b, kv);
        await looks.LoadAsync();
        Check(looks.Owned(0) && !looks.Owned(1) && looks.EquippedKey == "scene/look/greenfield", "offline course looks: standard owned, key scene/look/greenfield");
        Check(!(await looks.EquipAsync(2)).Ok && (await looks.EquipAsync(0)).Ok, "offline: premium look needs the server, standard look equips");

        var room = new RoomConditionsModel(b, kv);
        await room.LoadAsync();
        Check(room.Ground == 1 && room.Temperature == 1 && room.Weather == 0, "room conditions default to GOOD / 18 °C / SUNNY");
        room.Weather = 3; room.Ground = 2; room.Wind = 2;
        Check((await room.SaveAsync()).Ok, "offline room conditions save locally");
        var c = room.ToConditions();
        Check(c.Weather == "fog" && c.Going == "yielding" && c.TemperatureC == 18 && c.WindKmh == 10, "screen indices map to server ids (fog / yielding / 18 / 10)");
        var room2 = new RoomConditionsModel(b, kv); await room2.LoadAsync();
        Check(room2.Weather == 3 && room2.Ground == 2 && room2.Wind == 2, "…restored from the device (muchi.race.*)");
        Check(RoomConditionsModel.TurfStep("sloppy") == "soft" && RoomConditionsModel.TurfStep("fast") == "firm", "dirt going maps back onto the four ground buttons");

        var friends = new FriendsModel(b); await friends.LoadAsync();
        var teams = new TeamsModel(b); await teams.LoadAsync();
        var events = new EventsModel(b); await events.LoadAsync();
        var ta = new TimeAttackModel(b); await ta.LoadAsync("aoba_turf_1600");
        var lb = new LeaderboardModel(b); await lb.LoadAsync();
        Check(new ScreenModel[] { friends, teams, events, ta, lb }.All(m => !m.Online && m.Message != null && m.Message.StartsWith("OFFLINE")),
            "friends / teams / events / time attack / leaderboards explain they need the server offline");
        Check(!(await friends.SendAsync("ABCD")).Ok && !(await teams.JoinAsync("t_x")).Ok && !(await events.EnterAsync("e_x")).Ok, "offline social actions refuse with a message instead of throwing");
        var (taDriver, taMsg) = await ta.StartAsync("aoba_turf_1600");
        Check(taDriver == null && taMsg != null, "offline time attack does not start a session");
    }

    // ---------------------------------------------------------------- online: the screens' server flow + a ranked race
    sealed class NetHttp : IHttp
    {
        private readonly HttpClient _c;
        public NetHttp(string baseUrl) { _c = new HttpClient { BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/"), Timeout = TimeSpan.FromSeconds(20) }; }
        public async Task<HttpResponse> SendAsync(HttpRequest r, CancellationToken ct)
        {
            var m = new HttpRequestMessage(new HttpMethod(r.Method), r.Path.TrimStart('/'));
            if (r.Body != null) m.Content = new StringContent(r.Body, Encoding.UTF8, "application/json");
            foreach (var h in r.Headers) m.Headers.TryAddWithoutValidation(h.Key, h.Value);
            var res = await _c.SendAsync(m, ct);
            return new HttpResponse((int)res.StatusCode, await res.Content.ReadAsStringAsync(ct));
        }
    }

    static async Task Online(string baseUrl)
    {
        var settings = new GameSettings { BaseUrl = baseUrl, MatchPollMs = 500, MatchTimeoutMs = 60_000 };
        var api = new ApiClient(new NetHttp(baseUrl), null, new ApiClientOptions { BaseUrl = baseUrl, DevUserId = "unity_glue_" + DateTime.UtcNow.Ticks });
        var b = new GameBackend(settings, api, new WebSocketTransportFactory(), new MemoryKeyValueStore(), Ruleset());
        await b.InitializeAsync();
        Check(b.Online, "bootstrap → online");
        if (!b.Online) return;
        Check(b.Profile().TutorialScoutAvailable, "a new player has the free first scout available");

        var bad = await b.NamePartnerAsync("abc");
        Check(!bad.Ok && !string.IsNullOrEmpty(bad.Message), "server rejects a non-katakana name and the message reaches the screen (" + bad.Message + ")");
        Check(b.Player.TutorialGachaUsed && b.ScoutReveal().Count == 10, "naming drew the free tutorial 10-pull for the first partner");
        var ok = await b.NamePartnerAsync("ユニティタロウ");
        Check(ok.Ok && b.Profile().PartnerName == "ユニティタロウ", "the partner is named on the server");
        Check(b.Partner != null && b.Partner.Named, "partner = the named horse");

        var products = await b.ProductsAsync();
        Check(products != null && products.Any(p => p.Kind == "coins"), "shop lists coin products from the server (" + (products?.Count ?? 0) + ")");
        var check = await b.PurchaseCheckAsync("coin_160");
        Check(!string.IsNullOrEmpty(check.Message), "purchase check answers (" + check.Message + ")");
        Check(await b.SeasonPassAsync() != null, "season pass view loads");

        await OnlineScreens(b);

        int pointsBefore = b.Player.SeasonPoints;
        var sw = Stopwatch.StartNew();
        var (d, message) = await b.StartRankedAsync(null);
        Check(d != null, "ranked entry matched (" + (message ?? "ok") + ", " + sw.Elapsed.TotalSeconds.ToString("0.0") + " s)");
        if (d == null) return;
        var input = new RaceInput();
        int[] lastWhip = { -100 };
        bool prepared = false, poseOk = true;
        while (!d.Done && sw.Elapsed < TimeSpan.FromMinutes(4))
        {
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            Ride(d, input, lastWhip);
            d.Update(now);
            if (d.Config != null && d.Sim != null)
            {
                if (!prepared) { input.LeftHanded = d.Visuals?.Track == null || d.Visuals.Track.LeftHanded; prepared = true; }
                var frame = CourseFrame.For(d.Config, d.Visuals);
                for (int s = 0; s < d.Sim.EntrantCount; s++)
                    if (d.TryGetRender(s, now, out var f, out var t, out var a)) { var p = frame.Horse(f, t, a); poseOk &= !double.IsNaN(p.X); }
            }
            await Task.Delay(16);
        }
        var hud = HudModel.Build(d, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        Check(d.Phase == RacePhase.Confirmed, "ranked race reaches CONFIRMED through the room (phase " + d.Phase + (d.FailureReason != null ? ", " + d.FailureReason : "") + ")");
        Check(d.Final?.Hash != null && d.Final.Hash == d.Sim?.Result?.Hash, "server's final hash equals the app's own simulation");
        Check(prepared && poseOk, "start.visuals/config arrived and every runner renders on the course");
        Check(hud.FinishPlace >= 1, "result screen has the player's place (" + hud.FinishPlace + "/" + hud.Runners + ", " + HudModel.FormatTime(hud.ElapsedMs) + ")");
        await b.RefreshAsync();
        Check(b.Player.RankedRaces >= 1, "ranked race settled on the server (ranked races " + b.Player.RankedRaces + ", season pt " + pointsBefore + " → " + b.Player.SeasonPoints + ")");
        d.Dispose();
    }

    // round 6: care / course looks / room conditions / friends / teams / events / time attack / leaderboards
    static async Task OnlineScreens(GameBackend b)
    {
        var kv = new MemoryKeyValueStore();
        var care = new CareModel(b, kv);
        await care.LoadAsync();
        Check(care.Online && care.Bond != null && care.Level == 1 && !care.Bond.AffectsRankedStats, "care screen loads the partner's bond from the server (level " + care.Level + ")");
        var c1 = await care.CareAsync(0);
        Check(c1.Ok && care.Bond.Points > 0 && !care.Card(0).Ready, "care with GRAIN & APPLE: bond points up, that card rests (" + c1.Message + ")");
        var c2 = await care.CareAsync(0);
        Check(!c2.Ok && c2.Message.StartsWith("COOLDOWN"), "same card again → COOLDOWN message (" + c2.Message + ")");

        var looks = new CourseLooksModel(b, kv);
        await looks.LoadAsync();
        Check(looks.Online && looks.Owned(0) && looks.EquippedIndex == 0, "course looks load from the server (standard owned)");
        Check((await looks.EquipAsync(0)).Ok && looks.Presets.CourseLook == "greenfield", "equipping the standard look is stored on the server");
        var notOwned = await looks.EquipAsync(2);
        Check(looks.Owned(2) ? notOwned.Ok : !notOwned.Ok, "an unowned look is refused (" + (notOwned.Message ?? "ok") + ")");

        var room = new RoomConditionsModel(b, kv);
        await room.LoadAsync();
        room.Weather = 2; room.Ground = 3; room.Temperature = 0; room.Wind = 3;
        var saved = await room.SaveAsync();
        Check(saved.Ok, "room conditions saved to the server (" + saved.Message + ")");
        var room2 = new RoomConditionsModel(b, new MemoryKeyValueStore());
        await room2.LoadAsync();
        Check(room2.Online && room2.Weather == 2 && room2.Ground == 3 && room2.Temperature == 0 && room2.Wind == 3, "…and read back on another device (RAIN / HEAVY / 14 °C / 15 km/h)");
        Check((await room2.ResetAsync()).Ok && (await b.Api.GetPresetsAsync()).Room == null, "reset → automatic conditions");

        var friends = new FriendsModel(b); await friends.LoadAsync();
        Check(friends.Online && !string.IsNullOrEmpty(friends.MyCode) && friends.List.Friends.Count == 0, "friends screen: my friend code (" + friends.MyCode + ") and an empty list");
        var self = await friends.SendAsync(friends.MyCode);
        Check(!self.Ok, "sending a request to my own code is refused (" + self.Message + ")");

        var teams = new TeamsModel(b); await teams.LoadAsync();
        Check(teams.Online && !teams.InTeam, "teams screen: not in a team yet");
        Check((await teams.SearchAsync("")).Ok, "team search answers (" + teams.Search.Count + " teams)");

        var events = new EventsModel(b); await events.LoadAsync();
        Check(events.Online && events.Events != null, "events screen lists events (" + events.Events.Count + ")");

        var lb = new LeaderboardModel(b); await lb.LoadAsync();
        Check(lb.Online && lb.Mine != null, "leaderboard screen: my rank loads (" + (lb.Message ?? "snapshot ok") + ")");

        var ta = new TimeAttackModel(b); await ta.LoadAsync("aoba_turf_1600");
        Check(ta.Online && ta.Me != null, "time attack screen loads my records (attempts left " + ta.Me?.AttemptsLeft + ")");
        var (d, msg) = await ta.StartAsync("aoba_turf_1600");
        Check(d != null, "time attack session starts (" + (msg ?? "ok") + ")");
        if (d == null) return;
        var input = new RaceInput();
        int[] lastWhip = { -100 };
        long now = 5_000_000;
        for (int frame = 0; frame < 60 * 150 && !d.Done; frame++) { Ride(d, input, lastWhip); d.Update(now); now += 16; }
        Check(d.Done, "time attack run finishes locally");
        var sub = await ta.SubmitAsync();
        Check(sub.Ok && ta.Result != null && ta.Result.Finished && ta.Result.ResultHash == d.Sim.Result.Hash, "submitted run is re-simulated by the server to the same hash (" + sub.Message + ")");
    }
}
