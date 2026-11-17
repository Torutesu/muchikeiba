// U1-A (docs/quality/unity-daily.md): the daily loop in Unity — home, 目標, 調教 and the claim moment. The screens are drawn by
// Runtime/MuchiApp.Daily.cs from DailyLayout (Assets/Muchi/Game/DailyLayout.cs), so these checks audit the very rectangles the
// screens draw: inside 1600×900, no two text rectangles overlapping, body text ≥ 16 px, text that fits its box, at most one
// skewed cyan CTA per screen; plus English for every line drawn and the two model additions (the claim moment's lines and the
// training stage-up moment's line).
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class DailyScreensChecks
{
    public static async Task Run(Action<bool, string> check, string root, RulesetParams ruleset)
    {
        var prevRule = GameDay.Rule;
        GameDay.Use(new DayRolloverInfo { HourJst = 4, PreviousHourJst = 0, EffectiveAtMs = 1796065200000 });
        try
        {
            await ClaimMoment(check, ruleset);
            await TrainingStageMoment(check, ruleset);
            var screens = await Screens(check, ruleset);
            Dump(screens);
            Audit(check, screens);
            English(check, screens);
            RuntimeDrawsOnlyTheLayout(check, root);
        }
        finally { GameDay.Use(prevRule); }
    }

    // ------------------------------------------------------------------------------------------------ the screens

    static GoalLadderModel Ladder(GameBackend b, string json, long now)
    {
        var m = new GoalLadderModel(b, () => now);
        m.Use(GoalLadderView.FromJson(json));
        return m;
    }

    static readonly ProfileModel Profile = new ProfileModel { Online = true, FreeCoins = 12822, PaidCoins = 1240, PartnerName = "アカツキ", PartnerRarity = "SR", HorseCount = 12 };

    /// <summary>Every daily screen in the states the fixtures of the model checks cover (new player, day 1 / 3 / 7 / 10, a busy
    /// ladder with claims, the training screen fresh / tired / out of slots / with the treat, the play and the result).</summary>
    static async Task<List<ScreenLayout>> Screens(Action<bool, string> check, RulesetParams ruleset)
    {
        var all = new List<ScreenLayout>();
        var b = await GoalsBackend(ruleset, () => GoalLadderChecks.Claim);
        var ladders = new (string name, string json, long now)[]
        {
            ("busy", GoalLadderChecks.View, 1796698800000L), ("fresh", GoalLadderChecks.Fresh, 1796698800000L), ("day1", FirstWeekChecks.Day1, 1794500702748L),
            ("day3", Week2Checks.Day3, 1796871600000L), ("day7", Week2Checks.Day7, 1797217200000L), ("day10", Week2Checks.Day10, 1797476400000L),
            ("day1-done", FirstWeekChecks.Day1.Replace("\"complete\":false", "\"complete\":true"), 1794500702748L),
        };
        var nexts = new NextCardRow[]
        {
            null,
            NextActionModel.Row(new NextItem { Kind = "gift_expiring", Count = 2, DeadlineAt = 1797217200000L, Dismissible = true }, "primary"),
            NextActionModel.Row(new NextItem { Kind = "feature_unlocked", FeatureKey = "time_attack" }, "primary"),
            NextActionModel.Row(new NextItem { Kind = "exchange_closing", Count = 1250, DeadlineAt = 1797217200000L, Dismissible = true }, "chip"),
        };
        int k = 0;
        foreach (var (name, json, now) in ladders)
        {
            var g = Ladder(b, json, now);
            var home = DailyLayout.Home(new DailyHomeInput
            {
                Goals = g, Next = nexts[k++ % nexts.Length], Profile = Profile, Online = true, TrainingSlotsLeft = k % 2 == 0 ? 2 : (int?)null,
                TrainingLock = "あと3戦で開放", Horses = 12, ModeLabel = "ONLINE  /  STAGING",
            });
            home.Screen = "home/" + name;
            all.Add(home);
            var goals = DailyLayout.Goals(g, Profile, now);
            goals.Screen = "goals/" + name;
            all.Add(goals);
            var cl = DailyLayout.ClassLadder(g, Profile);
            cl.Screen = "class-ladder/" + name;
            all.Add(cl);
        }
        var offline = DailyLayout.Home(new DailyHomeInput { Goals = new GoalLadderModel(b), Profile = new ProfileModel(), Online = false, ModeLabel = "OFFLINE  /  LOCAL DATA" });
        offline.Screen = "home/offline";
        all.Add(offline);
        check(offline["ladder"] == null && offline["partner.line"] != null && offline["race"] != null, "home offline: no ladder without the server's figures, the plate's plain line, the race still works");
        var emptyGoals = DailyLayout.Goals(new GoalLadderModel(b), Profile, 1796698800000L);
        emptyGoals.Screen = "goals/empty";
        all.Add(emptyGoals);

        // what home says, once each (quality pass: the ladder says 「受け取れる報酬があります」 once, on its claim line)
        var busy = all.First(x => x.Screen == "home/busy");
        check(busy.Boxes.Count(x => x.Text != null && x.Text.StartsWith(DailyLayout.Ready)) == 1 && busy["ladder.claim"] != null, "home: 「受け取れる報酬があります」 once, on the ladder's claim line");
        check(busy["rung.today.main"].Text == "今日の目標 4/5" && busy["rung.today.dot"] != null, "home: a ready rung keeps its own line and its gold dot (" + busy["rung.today.main"].Text + ")");
        check(busy["ladder"].Action == "goals" && busy["race"].Text == "レースへ" && busy["race"].Action == "race", "home: the ladder opens 目標, the CTA is 「レースへ」");
        var d7 = all.First(x => x.Screen == "home/day7");
        check(d7["partner.treat"] != null && d7["partner.treat"].Text.StartsWith("りんごのおやつで伸び 85% → 100%") && d7["partner.treat"].Action == "training", "home day 7: the partner plate's treat line opens 調教 (" + d7["partner.treat"]?.Text + ")");
        check(d7["partner.stage"] != null && d7["partner.growth"].Text.Contains("　調教 +"), "home day 7: the stage of five and the training growth on the plate (" + d7["partner.growth"].Text + ")");
        var gift = all.First(x => x.Screen == "home/fresh");
        check(gift["next.what"] != null && gift["next.dismiss"] != null && gift["next.deadline"] != null && gift.Boxes.Count(x => x.Kind == LayoutKind.Link && x.Id.StartsWith("next.")) == 1, "home: 次にやること is one line with its date and at most one link");
        var g3 = all.First(x => x.Screen == "goals/day3");
        check(g3["path.alt"] != null && g3["path.alt"].Text.StartsWith("ひとりでも："), "goals day 3: the solo way of the social step (" + g3["path.alt"]?.Text + ")");
        var g7 = all.First(x => x.Screen == "goals/day7");
        check(g7.Boxes.Count(x => x.Id.StartsWith("w2.") && x.Id.EndsWith(".day")) == 7 && g7["w2.goal"] != null, "goals day 7: the week-2 arc, seven day cells and its headline (" + g7["w2.goal"]?.Text + ")");
        check(all.First(x => x.Screen == "goals/busy")["claim"]?.Text == "まとめて受け取る（4件）", "goals: the one claim CTA");

        // 調教
        string treat = "\"bondLevel\":1,\"treat\":{\"itemId\":\"training_apple\",\"name\":\"りんごのおやつ\",\"owned\":2,\"fatigue\":55,\"fatigueAfter\":25,\"efficiencyPermille\":850,\"efficiencyAfterPermille\":1000,\"tired\":false,\"unblocks\":false},";
        string outlook = "{\"id\":\"hill\",\"blocked\":null,\"outlook\":{\"min\":5,\"max\":6,\"efficiencyPermille\":850,\"softPermille\":966}}";
        var views = new (string name, string json)[]
        {
            ("fresh", TrainingChecks.View()),
            ("treat", TrainingChecks.View(2, 55, "normal", null, "null", 2).Replace("\"bondLevel\":1,", treat).Replace("{\"id\":\"hill\",\"blocked\":null}", outlook)),
            ("tired", TrainingChecks.View(1, 85, "tired", "tired", "null", 1)),
            ("no-slots", TrainingChecks.View(0)),
        };
        TrainingModel last = null;
        foreach (var (name, json) in views)
        {
            var (t, _) = await TrainingSetup(ruleset, json);
            foreach (var sel in new[] { null, "hill", "pool" })
            {
                var lt = DailyLayout.Training(t, Profile, sel, 1796698800000L);
                lt.Screen = "training/" + name + (sel != null ? "+" + sel : "");
                all.Add(lt);
            }
            last = t;
        }
        var tr = all.First(x => x.Screen == "training/treat+hill");
        check(tr["treat.line"]?.Text == "りんごのおやつで伸び 85% → 100%" && tr["treat.give"] != null, "training: the treat line with its numbers and one button");
        check(tr["go"].Text == "坂路で調教" && !tr["go"].Disabled && all.First(x => x.Screen == "training/treat")["go"].Disabled, "training: the CTA names the chosen menu, disabled until one is chosen");
        check(all.First(x => x.Screen == "training/no-slots").Boxes.Where(x => x.Id.EndsWith(".blocked")).All(x => x.Text == "今日の調教はおしまい。4:00に戻ります"), "training: out of slots, each card says when it comes back");
        var none = new TrainingModel(new GameBackend(new GameSettings { OfflineOnly = true }, null, null, new MemoryKeyValueStore(), ruleset));
        await none.LoadAsync();
        var lo = DailyLayout.Training(none, Profile, null, 1796698800000L);
        lo.Screen = "training/offline";
        all.Add(lo);

        var (play, _) = await TrainingSetup(ruleset, TrainingChecks.View());
        await play.StartAsync("hill");
        var lp = DailyLayout.TrainingPlay(play);
        all.Add(lp);
        check(lp["whip"].Kind == LayoutKind.Cta && lp["head.kicker"].Text == "調教　/　坂路", "training play: 「追う」 is the screen's CTA");
        string up = TrainingChecks.Finish("done", 5, 10).Replace("\"total\":6,", "\"total\":24,").Replace("\"trainedTotal\":12,", "\"trainedTotal\":30,");
        foreach (var (name, finish, claimable) in new[] { ("up", up, true), ("plain", TrainingChecks.Finish("done", 5, 10), false), ("skipped", TrainingChecks.Finish("skipped", 0, 0), true) })
        {
            var (rm, _) = await TrainingSetup(ruleset, TrainingChecks.View(), finish);
            await rm.StartAsync("hill");
            rm.Skip();
            await rm.FinishAsync();
            var lr = DailyLayout.TrainingResult(rm, claimable);
            lr.Screen = "training-result/" + name;
            all.Add(lr);
        }
        check(all.First(x => x.Screen == "training-result/up")["result.stage"].Text == "成長段階が上がりました：成長期", "training result: the stage up is said (and the Moment plays)");
        var lf = DailyLayout.Features(Profile);
        all.Add(lf);
        return all;
    }

    /// <summary>MUCHI_LAYOUT_DUMP=dir writes each screen's boxes as JSON (tools/figma-prototype/test/render-unity-layout.py draws
    /// them over the Unity art for a side-by-side look with the prototype's screenshots). Off by default.</summary>
    static void Dump(List<ScreenLayout> screens)
    {
        var dir = Environment.GetEnvironmentVariable("MUCHI_LAYOUT_DUMP");
        if (string.IsNullOrEmpty(dir)) return;
        Directory.CreateDirectory(dir);
        foreach (var s in screens)
        {
            var boxes = s.Boxes.Select(b => new Dictionary<string, object>
            {
                ["id"] = b.Id, ["kind"] = b.Kind.ToString(), ["x"] = b.X, ["y"] = b.Y, ["w"] = b.W, ["h"] = b.H, ["size"] = b.Size, ["text"] = b.Text,
                ["tone"] = b.Tone, ["align"] = b.Align, ["fill"] = b.Fill, ["count"] = b.Count, ["on"] = b.On, ["wrap"] = b.Wrap, ["selected"] = b.Selected, ["disabled"] = b.Disabled,
            });
            File.WriteAllText(Path.Combine(dir, s.Screen.Replace('/', '_') + ".json"), System.Text.Json.JsonSerializer.Serialize(new { screen = s.Screen, boxes }));
        }
    }

    static void Audit(Action<bool, string> check, List<ScreenLayout> screens)
    {
        foreach (var group in screens.GroupBy(s => s.Screen.Split('/')[0]))
        {
            var problems = group.SelectMany(s => LayoutAudit.Problems(s)).ToList();
            check(problems.Count == 0, "layout " + group.Key + ": " + group.Count() + " states inside 1600×900, no text overlap, ≥ 16 px, fits, ≤ 1 CTA"
                + (problems.Count > 0 ? " — " + problems.Count + " problems: " + string.Join(" | ", problems.Take(8)) : ""));
        }
        // the audit itself catches what it claims to
        var bad = new ScreenLayout("bad");
        var f = bad.At(0, 0);
        f.Text("a", "重なる", 10, 10, 200, 20);
        f.Text("b", "重なる", 100, 15, 200, 20);
        f.Text("c", "小さい", 10, 100, 200, 12);
        f.Text("d", "とても長い一行のテキストは箱に入りません", 10, 200, 100, 20);
        f.Cta("e", "一", 10, 300, 300, "x");
        f.Cta("g", "二", 10, 400, 300, "x");
        f.Text("h", "外", 1590, 890, 40, 20);
        var found = LayoutAudit.Problems(bad);
        check(found.Any(p => p.Contains("overlap")) && found.Any(p => p.Contains("below 16")) && found.Any(p => p.Contains("too long")) && found.Any(p => p.Contains("CTAs")) && found.Any(p => p.Contains("outside")),
            "layout audit: catches overlap, small text, overflow, two CTAs and boxes off the canvas (" + found.Count + ")");
    }

    /// <summary>Every line the daily screens draw reads in English (Loc.T over the shipped tables), and fits in English too
    /// where the box is a fixed label (titles, buttons, kickers).</summary>
    static void English(Action<bool, string> check, List<ScreenLayout> screens)
    {
        Loc.SetLocale("en");
        try
        {
            var missing = screens.SelectMany(s => s.Boxes).Where(x => x.Text != null && Loc.HasJapanese(Loc.T(x.Text))).Select(x => x.Text).Distinct().ToList();
            check(missing.Count == 0, "daily screens: English for every line drawn (" + screens.Sum(s => s.Boxes.Count(x => x.Text != null)) + " texts" + (missing.Count > 0 ? "; missing: " + string.Join(" | ", missing.Take(40)) : "") + ")");
            var fixedBoxes = screens.SelectMany(s => s.Boxes.Where(x => x.Kind == LayoutKind.Cta || x.Kind == LayoutKind.Ghost || x.Kind == LayoutKind.Kicker).Select(x => (s, x)))
                .Where(p => LayoutAudit.Needed(p.x, Loc.T(p.x.Text)) > LayoutAudit.Room(p.x) * 1.02f).Select(p => p.s.Screen + ": " + Loc.T(p.x.Text)).Distinct().ToList();
            check(fixedBoxes.Count == 0, "daily screens: buttons and kickers fit in English too" + (fixedBoxes.Count > 0 ? " — " + string.Join(" | ", fixedBoxes.Take(8)) : ""));
        }
        finally { Loc.SetLocale("ja"); }
    }

    /// <summary>The Unity screens draw only DailyLayout's boxes: MuchiApp.Daily.cs holds no Japanese literal and no coordinate
    /// of its own for text (so the audit above is what the player sees).</summary>
    static void RuntimeDrawsOnlyTheLayout(Action<bool, string> check, string root)
    {
        var path = Path.Combine(root, "unity", "Assets", "Muchi", "Runtime", "MuchiApp.Daily.cs");
        var src = File.ReadAllLines(path).Where(l => !l.TrimStart().StartsWith("//")).Select(l => { int c = l.IndexOf("//", StringComparison.Ordinal); return c >= 0 && !l.Contains("\"//") ? l.Substring(0, c) : l; });
        var japanese = src.Where(l => Loc.HasJapanese(l)).ToList();
        check(japanese.Count == 0, "MuchiApp.Daily.cs: no Japanese literal — every text comes from DailyLayout / the models" + (japanese.Count > 0 ? ": " + string.Join(" | ", japanese.Take(4).Select(l => l.Trim())) : ""));
    }

    // ------------------------------------------------------------------------------------------------ model additions

    static async Task<GameBackend> GoalsBackend(RulesetParams ruleset, Func<string> claim)
    {
        var s = new GoalLadderChecks.FakeServer();
        s.Routes["POST /v1/player/bootstrap"] = _ => new HttpResponse(200, GoalLadderChecks.Player);
        s.Routes["GET /v1/player"] = _ => new HttpResponse(200, GoalLadderChecks.Player);
        s.Routes["GET /v1/home/goals"] = _ => new HttpResponse(200, GoalLadderChecks.View);
        s.Routes["POST /v1/home/goals/claim"] = _ => new HttpResponse(200, claim());
        var api = new ApiClient(s, new GoalLadderChecks.Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, new MemoryKeyValueStore(), ruleset);
        await b.InitializeAsync();
        return b;
    }

    /// <summary>The one claim moment: what arrived in one headline, and tomorrow's reason once today's set is done.</summary>
    static async Task ClaimMoment(Action<bool, string> check, RulesetParams ruleset)
    {
        long now = 1796698800000L;
        string claim = GoalLadderChecks.Claim;
        var b = await GoalsBackend(ruleset, () => claim);
        var m = new GoalLadderModel(b, () => now);
        check(m.ClaimMomentKicker == null && m.ClaimMomentHeadline == null, "claim moment: nothing before a claim");
        await m.LoadAsync();
        var r = await m.ClaimAllAsync();
        check(r.Ok && m.ClaimMomentKicker == "4件受け取りました", "claim moment: the kicker counts what was received (" + m.ClaimMomentKicker + ")");
        check(m.ClaimMomentHeadline == "無償コイン 45枚　ほか2つ", "claim moment: one headline — the first reward and how many more (" + m.ClaimMomentHeadline + ")");
        check(m.ClaimMomentLine == "今日の目標 4/5", "claim moment: today not done → the honest figure (" + m.ClaimMomentLine + ")");
        check(LayoutAudit.MomentProblems(m.ClaimMomentKicker, m.ClaimMomentHeadline, m.ClaimMomentLine).Count == 0, "claim moment: fits the kit's Moment (headline ≤ 1000 px at 40 px)");

        // today's set done: the line is tomorrow's reason (the server's facts)
        var m2 = new GoalLadderModel(await GoalsBackend(ruleset, () => claim.Replace("\"complete\":false", "\"complete\":true")
            .Replace("\"resetAt\":1796756400000,", "\"resetAt\":1796756400000,\"tomorrow\":{\"playerDay\":2,\"at\":1796756400000,\"loginBonus\":{\"track\":\"beginner\",\"day\":2,\"days\":7,\"reward\":{\"broodmare\":\"t_broodmare\"}},\"opens\":[\"breeding\"],\"trainingSlots\":3},")), () => now);
        await m2.LoadAsync();
        await m2.ClaimAllAsync();
        check(m2.ClaimMomentLine != null && m2.ClaimMomentLine.StartsWith("明日：") && m2.ClaimMomentLine == m2.TomorrowLine, "claim moment: today done → tomorrow's reason (" + m2.ClaimMomentLine + ")");

        // two kinds or fewer: both named
        var two = new GoalLadderModel(await GoalsBackend(ruleset, () => claim.Replace("\"total\":{\"freeCoins\":45,\"passXp\":100,\"items\":[{\"itemId\":\"breeding_material\",\"qty\":1}]}", "\"total\":{\"freeCoins\":45,\"items\":[{\"itemId\":\"training_apple\",\"qty\":1}]}")), () => now);
        await two.LoadAsync();
        await two.ClaimAllAsync();
        check(two.ClaimMomentHeadline == "無償コイン 45枚　·　りんごのおやつ ×1", "claim moment: two rewards are both named (" + two.ClaimMomentHeadline + ")");

        Loc.SetLocale("en");
        try
        {
            var lines = new[] { m.ClaimMomentKicker, m.ClaimMomentHeadline, m.ClaimMomentLine, m2.ClaimMomentLine, two.ClaimMomentHeadline };
            var bad = lines.Where(x => Loc.HasJapanese(Loc.T(x))).ToList();
            check(bad.Count == 0, "claim moment: English for every line (" + string.Join(" | ", lines.Select(Loc.T)) + ")");
        }
        finally { Loc.SetLocale("ja"); }
    }

    static async Task<(TrainingModel model, Dictionary<string, string> routes)> TrainingSetup(RulesetParams ruleset, string view, string finish = null)
    {
        var s = new TrainingChecks.FakeServer();
        var routes = new Dictionary<string, string> { ["view"] = view, ["finish"] = finish };
        s.Routes["POST /v1/player/bootstrap"] = _ => new HttpResponse(200, TrainingChecks.PlayerJson);
        s.Routes["GET /v1/player"] = _ => new HttpResponse(200, TrainingChecks.PlayerJson);
        s.Routes["GET /v1/training"] = _ => new HttpResponse(200, routes["view"]);
        s.Routes["POST /v1/training/start"] = _ => new HttpResponse(200, "{\"session\":" + TrainingChecks.Session + ",\"preview\":{\"min\":6,\"max\":6,\"minMilli\":6000,\"maxMilli\":6600},\"slotsLeft\":1,\"training\":" + TrainingChecks.View(1, 60, "normal", null, TrainingChecks.Session) + "}");
        s.Routes["POST /v1/training/tr_a/finish"] = _ => new HttpResponse(200, routes["finish"] ?? TrainingChecks.Finish("done", 5, 10));
        var api = new ApiClient(s, new TrainingChecks.Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, new MemoryKeyValueStore(), ruleset);
        await b.InitializeAsync();
        var m = new TrainingModel(b);
        await m.LoadAsync();
        return (m, routes);
    }

    /// <summary>The stage-up moment's line 「新馬　→　成長期」 (the stage before the session → after).</summary>
    static async Task TrainingStageMoment(Action<bool, string> check, RulesetParams ruleset)
    {
        // 6 → 30 of 240: 新馬 (0) → 成長期 (24 = 10 %)
        string up = TrainingChecks.Finish("done", 5, 10).Replace("\"total\":6,", "\"total\":24,").Replace("\"trainedTotal\":12,", "\"trainedTotal\":30,");
        var (m, _) = await TrainingSetup(ruleset, TrainingChecks.View(), up);
        await m.StartAsync("hill");
        m.Skip();
        await m.FinishAsync();
        check(m.StageUp && m.StageFromText == "新馬" && m.StageText == "成長期", "training: the stage before and after the session (" + m.StageFromText + " → " + m.StageText + ")");
        check(m.StageMomentLine == "新馬　→　成長期", "training: the stage-up moment's line (" + m.StageMomentLine + ")");
        check(m.StageNextText == "充実期まで あと30", "training: how far the next stage is after the session (" + m.StageNextText + ")");

        var (plain, _) = await TrainingSetup(ruleset, TrainingChecks.View());
        await plain.StartAsync("hill");
        plain.Skip();
        await plain.FinishAsync();
        check(!plain.StageUp && plain.StageMomentLine == null && plain.StageFromText == "新馬", "training: no stage up → no moment line");
        Loc.SetLocale("en");
        try { check(!Loc.HasJapanese(Loc.T(m.StageMomentLine)) && !Loc.HasJapanese(Loc.T(m.StageNextText)), "training: the moment line in English (" + Loc.T(m.StageMomentLine) + " / " + Loc.T(m.StageNextText) + ")"); }
        finally { Loc.SetLocale("ja"); }
    }
}
