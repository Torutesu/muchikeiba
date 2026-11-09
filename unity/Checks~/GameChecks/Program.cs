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
        CosmeticArtCoverage();
        SettingsAndOfflineBackend();
        await ItemsOffline();
        await OfflineFallbackWhenServerUnreachable();
        Console.WriteLine("== Firebase auth token provider");
        await AuthChecks.Run(Check);
        await OfflineScreenModels();
        Console.WriteLine("== QA round 6 client regressions");
        await QaRound6Checks.Run(Check, Ruleset(), Root);
        Console.WriteLine("== breeding screen (own / borrowed stallion, atavism, stud fee)");
        await BreedingChecks.Run(Check, Ruleset());
        Console.WriteLine("== マイ厩舎 (layout, visits, likes)");
        await StableChecks.Run(Check, Ruleset());
        Console.WriteLine("== tournaments and spectating");
        await TournamentChecks.Run(Check, Ruleset());
        Console.WriteLine("== QA round 7 client regressions");
        await QaRound7Checks.Run(Check, Ruleset());
        Console.WriteLine("== unique skills (horse detail, gacha, breeding, HUD cut-in, commentary)");
        await SkillChecks.Run(Check, Root);
        Console.WriteLine("== room close codes over a real WebSocket (replaced → no reconnect loop)");
        await CloseCodeChecks.Run(Check, Ruleset());
        Console.WriteLine("== scout reveal, banner calendar and pity meter (06 §6.5 / §7 item 7, REQ-GACHA-011..015)");
        GachaChecks.Run(Check);
        Console.WriteLine("== race feel, tutorial win rule, camera and result debrief (06 §2.3 / §6.3 / §6.4)");
        RaceFeelChecks.Run(Check, Ruleset());
        await Round8Checks.Run(Check, Ruleset());
        await Round8Checks.DayRollover(Check, Ruleset());
        Console.WriteLine("== round 9: replay share, account-link prompt, friend ghosts (06 §7 / §7.3)");
        await Round9Checks.Run(Check, Ruleset());
        Console.WriteLine("== round 10: 支部 cheer stamps (TeamFeedModel) and the bought pass in the shop");
        await Round10Checks.Run(Check, Ruleset());
        Console.WriteLine("== asset delivery: boot/FTUE download screen (sizes, Wi-Fi warning, never blocks the tutorial, offline)");
        await AssetDeliveryChecks.Run(Check);
        Console.WriteLine("== round 10: 友達招待 (my code + share, code entry, milestones, deep links; REQ-INV-*)");
        await InviteChecks.Run(Check);
        Console.WriteLine("== returning players: comeback welcome, login track, missions, catch-up, what's new (REQ-CB-001..012)");
        await ComebackChecks.Run(Check, Ruleset());
        Console.WriteLine("== rewarded ads: where cards may appear, one view at a time, reward only from the server (SSV), KPI");
        await RewardedAdChecks.Run(Check);
        Console.WriteLine("== round 11: English (Loc tables, composite lines, commentary, request language; REQ-L10N-009..012)");
        await L10nChecks.Run(Check, Root, Ruleset());
        Console.WriteLine("== round 13: 購入履歴・コイン履歴・ガチャ履歴 (header, tabs, paging, detail, 問い合わせ; REQ-HIST-*)");
        await HistoryChecks.Run(Check);
        Console.WriteLine("== round 11: 図鑑, 実績 and titles (CollectionModel / AchievementModel / TitleShowcaseModel; REQ-COL-*, REQ-ACH-*)");
        await CollectionChecks.Run(Check, Ruleset());
        Console.WriteLine("== 調教 (training: menus, timing mini-game, keyed start/finish, fairness wording)");
        await TrainingChecks.Run(Check, Ruleset());
        Console.WriteLine("== round 12: コイン不足の案内 T6 (CoinShortfallModel: one pack, where it may appear, KPI, back to the pull) and bought packs in the shop");
        await ShortfallChecks.Run(Check, Ruleset());
        Console.WriteLine("== プレゼントボックス (gift box: badge, real expiry text only, keyed claims, held entries, history, deletion)");
        await GiftBoxChecks.Run(Check, Ruleset());
        Console.WriteLine("== round 12: かんたん操作 (AssistModel, InputAssistant on a practice race, HUD chip, the one-time suggestion; REQ-ASSIST-*)");
        await AssistChecks.Run(Check, Ruleset());
        Console.WriteLine("== round 12: ライバル (home card, detail, week-result sheet, challenge, opt-out / block; REQ-RIVAL-*)");
        await RivalChecks.Run(Check, Ruleset());
        Console.WriteLine("== イベント交換所 (event exchange: point counter, stock, confirm sheet, keyed exchange, grace notice; REQ-EXCH-*)");
        await ExchangeChecks.Run(Check, Ruleset());
        Console.WriteLine("== 週替わりチャレンジ (weekly challenge: list, keyed start, race with the HUD condition, server verdict, badge, English)");
        await WeeklyChallengeChecks.Run(Check, Ruleset(), Root);
        Console.WriteLine("== round 13: 支部の共同目標 (TeamGoalModel: milestone bar, contributions, week result sheet, feed goal rows; REQ-TGOAL-*)");
        Loc.LoadEnglish(File.ReadAllText(Path.Combine(Root, "engine", "Muchi.Client", "Resources", "Muchi", "server-en.json")));
        Loc.LoadEnglish(File.ReadAllText(Path.Combine(Root, "engine", "Muchi.Client", "Resources", "Muchi", "ui-en.json")));
        await TeamGoalChecks.Run(Check, Ruleset());
        Console.WriteLine("== round 14: 殿堂・引退式 (HallModel: gallery, ceremony once, retire, friend's hall, progress, visibility; REQ-HOF-*)");
        await HallChecks.Run(Check, Ruleset());
        Console.WriteLine("== round 14: 勝負服エディタ (SilksEditorModel: try-on 試着中, keyed part purchase, readability, presets, refund notice; REQ-SILK-*)");
        await SilksEditorChecks.Run(Check, Ruleset());
        Console.WriteLine("== round 14: 実況パック (CommentaryPackModel: list, sample, equip, calm confirm, keyed buy, T6, race templates, offline; REQ-CMT-*)");
        await CommentaryPackChecks.Run(Check, Ruleset(), Root);
        Console.WriteLine("== round 14: マイリプレイ (list cards, save / rename / favourite / public / delete, ReplayPlayer, 再生できません; REQ-MYRP-*)");
        await MyReplaysChecks.Run(Check, Ruleset());
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
        var replay = RaceReplay.Run(d.Config, d.Race.AllInputs()); // player + the tutorial rival's director
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

    // ---------------------------------------------------------------- items & cosmetics (REQ-ITEM-*)
    static void CosmeticArtCoverage()
    {
        string unityRes = Path.Combine(Root, "unity", "Assets", "Resources");
        using var manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(Root, "contracts", "assets.manifest.json")));
        var keys = manifest.RootElement.GetProperty("keys").EnumerateArray().Select(k => k.GetString()).ToList();
        bool Exists(string art) => File.Exists(Path.Combine(unityRes, art + ".png")) || File.Exists(Path.Combine(unityRes, art + ".jpg"));
        var problems = CosmeticArt.CoverageProblems(keys, Exists);
        foreach (var p in problems) Console.WriteLine("        " + p);
        int n = keys.Count(k => k.StartsWith("tack/") || k.StartsWith("decor/"));
        Check(n > 0 && problems.Count == 0, "every tack/* and decor/* manifest key resolves to Codex's cosmetics art (" + n + " keys)");
        Check(CosmeticArt.ArtFor("silks/pattern/laurel") == "Art/Cosmetics/silk-jacket" && Exists(CosmeticArt.ArtFor("silks/pattern/laurel")), "a silks unlock shows the silk-jacket art");
        using var items = JsonDocument.Parse(File.ReadAllText(Path.Combine(Root, "server", "master", "items.json")));
        var masterIds = items.RootElement.GetProperty("cosmetics").EnumerateArray().Select(c => c.GetProperty("id").GetString()).ToHashSet();
        Check(ItemsBackend.OfflinePreview.All(i => masterIds.Contains(i.Id)), "the offline preview only shows items that exist in server/master/items.json");
    }

    static async Task ItemsOffline()
    {
        var b = new GameBackend(new GameSettings { OfflineOnly = true }, null, null, new MemoryKeyValueStore(), Ruleset());
        await b.InitializeAsync();
        var items = new ItemsBackend(b);
        var w = await items.WardrobeAsync();
        Check(w.LocalOnly && w.Items.Count == ItemsBackend.OfflinePreview.Length && w.Items.All(i => !i.Owned && i.ArtPath != null), "offline wardrobe = LOCAL ONLY preview with art for every item");
        Check(!(await items.BuyAsync("tack_bridle_classic")).Ok, "offline purchase explains it needs the server");
        Check(!(await items.EquipTackAsync("bridle", "tack_bridle_classic")).Ok, "offline equip explains it needs the server");
        Check(!(await items.UseTicketAsync(ItemsBackend.GachaTicket, "standard")).Ok, "offline ticket use explains it needs the server");
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
        room.Weather = 3; room.SelectGround(2); room.Wind = 2;
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
        var league = new LeagueModel(b); await league.LoadAsync();
        Check(new ScreenModel[] { friends, teams, events, ta, lb, league }.All(m => !m.Online && m.Message != null && m.Message.StartsWith("OFFLINE")),
            "friends / teams / events / time attack / leaderboards / team league explain they need the server offline");
        Check(!(await league.DivisionAsync("s1")).Ok && league.Headline.StartsWith("OFFLINE"), "offline team league: no division table, the headline says why");
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
        Check(!b.Player.TutorialGachaUsed && b.Player.PartnerHorseId == null, "a refused name granted nothing and drew no gacha (REQ-UXS-002)");
        var ok = await b.NamePartnerAsync("ユニティタロウ");
        Check(ok.Ok && b.Profile().PartnerName == "ユニティタロウ" && b.Player.PartnerHorseId != null, "the ridden horse is granted and named on the server (POST /v1/player/partner)");
        Check(b.Partner != null && b.Partner.Named && b.Partner.Id == b.Player.PartnerHorseId && b.Partner.TemplateId == "t_partner", "partner = the granted tutorial horse");
        Check(!b.Player.TutorialGachaUsed && b.Profile().TutorialScoutAvailable, "the welcome 10-pull is still to come (its own screen after naming)");
        var scout = await b.EnsureFirstScoutAsync();
        Check(scout.Ok && b.Player.TutorialGachaUsed && b.ScoutReveal().Count == 10, "the welcome scout draws the free tutorial 10-pull");
        b.FirstScoutShown();

        var products = await b.ProductsAsync();
        Check(products != null && products.Any(p => p.Kind == "coins"), "shop lists coin products from the server (" + (products?.Count ?? 0) + ")");
        var check = await b.PurchaseCheckAsync("coin_160");
        Check(!string.IsNullOrEmpty(check.Message), "purchase check answers (" + check.Message + ")");
        Check(await b.SeasonPassAsync() != null, "season pass view loads");

        // REQ-ITEM-*: wardrobe / cosmetics store / stable decor through the server
        var items = new ItemsBackend(b);
        var w = await items.WardrobeAsync();
        Check(!w.LocalOnly && w.Items.Count > 0 && w.DecorSlots > 0, "wardrobe loads the server's cosmetics (" + w.Items.Count + " items, " + w.DecorSlots + " decor slots)");
        var cheapest = w.Items.Where(i => !i.PaidOnly).OrderBy(i => i.Price).First();
        var buy = await items.BuyAsync(cheapest.Id);
        Check(!string.IsNullOrEmpty(buy.Message), "buying a cosmetic answers (" + buy.Message + ")");
        if (buy.Ok && cheapest.Kind == "decor")
        {
            var eq = await items.SetDecorAsync(new List<string> { cheapest.Id });
            Check(eq.Ok && b.Player.Equipment.Decor.Contains(cheapest.Id), "bought decor is placed in the stable");
        }
        var noTicket = await items.UseTicketAsync(ItemsBackend.GachaTicket, "standard");
        Check(!noTicket.Ok && noTicket.Message.StartsWith("INSUFFICIENT_ITEMS"), "using a ticket you do not have is refused with INSUFFICIENT_ITEMS (" + noTicket.Message + ")");
        await OnlineScreens(b);
        await GachaChecks.Online(Check, b);
        await OnlineInvite(b, baseUrl);

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
        // round 11 (REQ-COL-*, REQ-ACH-*): the race's CPU field is in the book as 出会った, the course as 走った; the book pays nothing
        var col = new CollectionModel(b);
        var cl = await col.LoadAsync();
        Check(cl.Ok && col.Book.Horses.Counts.Total > 0 && col.Book.Horses.Counts.Seen > 0 && !col.Book.CompletionRewards, "collection: the ranked race's CPU field is recorded as seen (" + (cl.Message ?? col.TabCountsText) + ")");
        col.SelectTab("courses");
        Check(col.Book.Courses.Counts.Obtained >= 1, "collection: the course raced is recorded");
        var ach = new AchievementModel(b);
        var al = await ach.LoadAsync();
        Check(al.Ok && ach.Rows.Count > 0 && ach.Rows.Exists(r => r.Id == "races" && r.Progress >= 1), "achievements load with the race counted (" + (al.Message ?? ach.TotalText) + ")");
    }

    // round 6: care / course looks / room conditions / friends / teams / events / time attack / leaderboards
    /// <summary>REQ-INV-*: this player's code is entered by a second, new player through the invite screen model.</summary>
    static async Task OnlineInvite(GameBackend b, string baseUrl)
    {
        var mine = new InviteModel(new ApiInviteApi(b.Api), new MemoryKeyValueStore());
        var loaded = await mine.LoadAsync();
        Check(loaded.Ok && mine.CodeText.Length == 9 && mine.View.Share.DeepLink == "muchi://invite/" + mine.View.Code, "invite screen loads my code and the deep link (" + (loaded.Message ?? mine.CodeText) + ")");
        var friendApi = new ApiClient(new NetHttp(baseUrl), null, new ApiClientOptions { BaseUrl = baseUrl, DevUserId = "unity_invitee_" + DateTime.UtcNow.Ticks });
        await friendApi.BootstrapAsync();
        await friendApi.GrantPartnerAsync("ショウタイ");
        var theirs = new InviteModel(new ApiInviteApi(friendApi), new MemoryKeyValueStore());
        await theirs.LoadAsync();
        Check(theirs.EntryVisible, "a new player after the tutorial can enter a code");
        theirs.HandleLink(mine.View.Share.Url);
        var r = await theirs.RedeemAsync();
        Check(r.Ok && !theirs.EntryVisible, "the friend redeems my code from the https link (" + r.Message + ")");
        await mine.LoadAsync();
        Check(mine.Rows.Count == 1 && mine.Rows[0].Counted && mine.Rows[0].Milestones.All(x => !x.reached), "…and appears in my invitees, nothing paid yet (milestones only)");
    }

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
        room.Weather = 2; room.SelectGround(3); room.Temperature = 0; room.Wind = 3;
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

        var league = new LeagueModel(b); await league.LoadAsync();
        Check(league.Online && !league.InTeam && league.Mine.Divisions.Count >= 2 && league.Headline.Contains("支部に入ると"), "team league screen: divisions listed, not in a team yet (" + league.Mine.Divisions.Count + " divisions)");
        var div = await league.DivisionAsync(league.Mine.Divisions[0].Id);
        Check(div.Ok || (div.Message ?? "").StartsWith("NO SNAPSHOT"), "team league: the top division's board answers (" + (div.Message ?? "ok") + ")");

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
