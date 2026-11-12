// 目標の階段 (REQ-GOAL-001..012, contracts/protocol.md「目標の階段」): GoalLadderModel over a routed fake server with the real
// server's JSON. The rungs on home (today / the beginner path / the week / the season), the rows with what each reward does
// for the horses, the class ladder and the partner's usable strength (why climb), one keyed claim with its moment, offline
// reuse of today's ladder only, English for every line, and no urgency or shop words.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class GoalLadderChecks
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

    const long Now = 1796698800000L; // 2026-12-08 12:00 JST
    const string Player = "{\"id\":\"g\",\"wallet\":{\"paid\":0,\"free\":0,\"total\":0,\"debt\":0},\"season\":{\"id\":\"2026-12\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[],\"equipment\":{\"tack\":{},\"decor\":[]},\"deletion\":{\"status\":\"none\"}}";
    const string Busy = "{\"error\":{\"code\":\"INTERNAL\",\"message\":\"x\"}}";
    const string Nothing = "{\"error\":{\"code\":\"NOT_ELIGIBLE\",\"message\":\"nothing to claim\"}}";
    // the real server (PlayerService.goals / claimGoals) after 10 ranked races, and a fresh player
    const string View = "{\"day\":\"2026-12-08\",\"now\":1796698800000,\"today\":{\"open\":true,\"items\":[{\"id\":\"race3\",\"table\":\"daily\",\"kind\":\"races\",\"progress\":3,\"target\":3,\"reward\":{\"freeCoins\":15},\"claimed\":false,\"claimable\":true},{\"id\":\"win1\",\"table\":\"daily\",\"kind\":\"wins\",\"progress\":1,\"target\":1,\"reward\":{\"freeCoins\":30},\"claimed\":false,\"claimable\":true},{\"id\":\"top3x2\",\"table\":\"daily\",\"kind\":\"top3\",\"progress\":2,\"target\":2,\"reward\":{\"items\":[{\"itemId\":\"breeding_material\",\"qty\":1}]},\"claimed\":false,\"claimable\":true},{\"id\":\"train1\",\"table\":\"daily\",\"kind\":\"training\",\"progress\":0,\"target\":1,\"reward\":{\"items\":[{\"itemId\":\"training_apple\",\"qty\":1}]},\"claimed\":false,\"claimable\":false},{\"id\":\"first_win\",\"table\":\"first_win\",\"kind\":\"first_win\",\"progress\":1,\"target\":1,\"reward\":{\"freeCoins\":30},\"claimed\":true,\"claimable\":false}],\"done\":4,\"total\":5,\"claimable\":3,\"complete\":false,\"resetAt\":1796756400000,\"loginBonus\":{\"open\":true,\"claimedToday\":false}},\"path\":{\"step\":1,\"steps\":10,\"done\":0,\"current\":{\"id\":\"bm_scout\",\"table\":\"beginner\",\"kind\":\"gacha\",\"progress\":0,\"target\":1,\"reward\":{\"freeCoins\":50},\"claimed\":false,\"claimable\":false},\"finalReward\":{\"items\":[{\"itemId\":\"gacha_ticket_10\",\"qty\":1}]}},\"week\":null,\"season\":{\"open\":true,\"seasonId\":\"2026-12\",\"endsAt\":1798729200000,\"classId\":\"C\",\"nextClassId\":\"B\",\"points\":165,\"races\":10,\"line\":300,\"left\":135,\"demoteBelow\":null,\"status\":\"climbing\",\"pace\":{\"races\":10,\"pace10\":165,\"racesToLine\":9,\"minRaces\":3},\"power\":{\"horseId\":\"h1\",\"partner\":true,\"total\":3320,\"cap\":2800,\"usable\":2800,\"nextCap\":3200,\"nextUsable\":3200,\"held\":520},\"ladder\":[{\"classId\":\"C\",\"statCap\":2800,\"promotePoints\":300,\"demoteBelowPoints\":null,\"current\":true,\"reached\":true,\"rewards\":{\"top\":{\"maxRank\":10,\"reward\":{\"freeCoins\":300}},\"floor\":{\"freeCoins\":50}}},{\"classId\":\"B\",\"statCap\":3200,\"promotePoints\":400,\"demoteBelowPoints\":50,\"current\":false,\"reached\":false,\"rewards\":{\"top\":{\"maxRank\":10,\"reward\":{\"freeCoins\":500}},\"floor\":{\"freeCoins\":80}}},{\"classId\":\"A\",\"statCap\":3600,\"promotePoints\":500,\"demoteBelowPoints\":80,\"current\":false,\"reached\":false,\"rewards\":{\"top\":{\"maxRank\":10,\"reward\":{\"freeCoins\":800,\"items\":[{\"itemId\":\"gacha_ticket\",\"qty\":1}]}},\"floor\":{\"freeCoins\":120}}},{\"classId\":\"S\",\"statCap\":4000,\"promotePoints\":null,\"demoteBelowPoints\":100,\"current\":false,\"reached\":false,\"rewards\":{\"top\":{\"maxRank\":1,\"reward\":{\"freeCoins\":3000,\"items\":[{\"itemId\":\"ticket_sr_plus\",\"qty\":1}]}},\"floor\":{\"freeCoins\":200}}}],\"missions\":[{\"id\":\"sm_races10\",\"table\":\"season\",\"kind\":\"ranked_races\",\"progress\":10,\"target\":10,\"reward\":{\"passXp\":100},\"claimed\":false,\"claimable\":true},{\"id\":\"sm_races30\",\"table\":\"season\",\"kind\":\"ranked_races\",\"progress\":10,\"target\":30,\"reward\":{\"passXp\":200},\"claimed\":false,\"claimable\":false},{\"id\":\"sm_wins5\",\"table\":\"season\",\"kind\":\"wins\",\"progress\":2,\"target\":5,\"reward\":{\"passXp\":150},\"claimed\":false,\"claimable\":false},{\"id\":\"sm_top3_15\",\"table\":\"season\",\"kind\":\"top3\",\"progress\":6,\"target\":15,\"reward\":{\"passXp\":150},\"claimed\":false,\"claimable\":false},{\"id\":\"sm_promotion\",\"table\":\"season\",\"kind\":\"promotion_line\",\"progress\":165,\"target\":300,\"reward\":{\"passXp\":300},\"claimed\":false,\"claimable\":false}],\"pass\":{\"level\":2,\"maxLevel\":30,\"freeClaimable\":2},\"promotion\":null},\"claimable\":4}";
    const string Claim = "{\"claimed\":[{\"id\":\"race3\",\"table\":\"daily\",\"reward\":{\"freeCoins\":15}},{\"id\":\"win1\",\"table\":\"daily\",\"reward\":{\"freeCoins\":30}},{\"id\":\"top3x2\",\"table\":\"daily\",\"reward\":{\"items\":[{\"itemId\":\"breeding_material\",\"qty\":1}]}},{\"id\":\"sm_races10\",\"table\":\"season\",\"reward\":{\"passXp\":100}}],\"total\":{\"freeCoins\":45,\"passXp\":100,\"items\":[{\"itemId\":\"breeding_material\",\"qty\":1}]},\"ladder\":{\"day\":\"2026-12-08\",\"now\":1796698800000,\"today\":{\"open\":true,\"items\":[{\"id\":\"race3\",\"table\":\"daily\",\"kind\":\"races\",\"progress\":3,\"target\":3,\"reward\":{\"freeCoins\":15},\"claimed\":true,\"claimable\":false},{\"id\":\"win1\",\"table\":\"daily\",\"kind\":\"wins\",\"progress\":1,\"target\":1,\"reward\":{\"freeCoins\":30},\"claimed\":true,\"claimable\":false},{\"id\":\"top3x2\",\"table\":\"daily\",\"kind\":\"top3\",\"progress\":2,\"target\":2,\"reward\":{\"items\":[{\"itemId\":\"breeding_material\",\"qty\":1}]},\"claimed\":true,\"claimable\":false},{\"id\":\"train1\",\"table\":\"daily\",\"kind\":\"training\",\"progress\":0,\"target\":1,\"reward\":{\"items\":[{\"itemId\":\"training_apple\",\"qty\":1}]},\"claimed\":false,\"claimable\":false},{\"id\":\"first_win\",\"table\":\"first_win\",\"kind\":\"first_win\",\"progress\":1,\"target\":1,\"reward\":{\"freeCoins\":30},\"claimed\":true,\"claimable\":false}],\"done\":4,\"total\":5,\"claimable\":0,\"complete\":false,\"resetAt\":1796756400000,\"loginBonus\":{\"open\":true,\"claimedToday\":false}},\"path\":{\"step\":1,\"steps\":10,\"done\":0,\"current\":{\"id\":\"bm_scout\",\"table\":\"beginner\",\"kind\":\"gacha\",\"progress\":0,\"target\":1,\"reward\":{\"freeCoins\":50},\"claimed\":false,\"claimable\":false},\"finalReward\":{\"items\":[{\"itemId\":\"gacha_ticket_10\",\"qty\":1}]}},\"week\":null,\"season\":{\"open\":true,\"seasonId\":\"2026-12\",\"endsAt\":1798729200000,\"classId\":\"C\",\"nextClassId\":\"B\",\"points\":165,\"races\":10,\"line\":300,\"left\":135,\"demoteBelow\":null,\"status\":\"climbing\",\"pace\":{\"races\":10,\"pace10\":165,\"racesToLine\":9,\"minRaces\":3},\"power\":{\"horseId\":\"h1\",\"partner\":true,\"total\":3320,\"cap\":2800,\"usable\":2800,\"nextCap\":3200,\"nextUsable\":3200,\"held\":520},\"ladder\":[{\"classId\":\"C\",\"statCap\":2800,\"promotePoints\":300,\"demoteBelowPoints\":null,\"current\":true,\"reached\":true,\"rewards\":{\"top\":{\"maxRank\":10,\"reward\":{\"freeCoins\":300}},\"floor\":{\"freeCoins\":50}}},{\"classId\":\"B\",\"statCap\":3200,\"promotePoints\":400,\"demoteBelowPoints\":50,\"current\":false,\"reached\":false,\"rewards\":{\"top\":{\"maxRank\":10,\"reward\":{\"freeCoins\":500}},\"floor\":{\"freeCoins\":80}}},{\"classId\":\"A\",\"statCap\":3600,\"promotePoints\":500,\"demoteBelowPoints\":80,\"current\":false,\"reached\":false,\"rewards\":{\"top\":{\"maxRank\":10,\"reward\":{\"freeCoins\":800,\"items\":[{\"itemId\":\"gacha_ticket\",\"qty\":1}]}},\"floor\":{\"freeCoins\":120}}},{\"classId\":\"S\",\"statCap\":4000,\"promotePoints\":null,\"demoteBelowPoints\":100,\"current\":false,\"reached\":false,\"rewards\":{\"top\":{\"maxRank\":1,\"reward\":{\"freeCoins\":3000,\"items\":[{\"itemId\":\"ticket_sr_plus\",\"qty\":1}]}},\"floor\":{\"freeCoins\":200}}}],\"missions\":[{\"id\":\"sm_races10\",\"table\":\"season\",\"kind\":\"ranked_races\",\"progress\":10,\"target\":10,\"reward\":{\"passXp\":100},\"claimed\":true,\"claimable\":false},{\"id\":\"sm_races30\",\"table\":\"season\",\"kind\":\"ranked_races\",\"progress\":10,\"target\":30,\"reward\":{\"passXp\":200},\"claimed\":false,\"claimable\":false},{\"id\":\"sm_wins5\",\"table\":\"season\",\"kind\":\"wins\",\"progress\":2,\"target\":5,\"reward\":{\"passXp\":150},\"claimed\":false,\"claimable\":false},{\"id\":\"sm_top3_15\",\"table\":\"season\",\"kind\":\"top3\",\"progress\":6,\"target\":15,\"reward\":{\"passXp\":150},\"claimed\":false,\"claimable\":false},{\"id\":\"sm_promotion\",\"table\":\"season\",\"kind\":\"promotion_line\",\"progress\":165,\"target\":300,\"reward\":{\"passXp\":300},\"claimed\":false,\"claimable\":false}],\"pass\":{\"level\":3,\"maxLevel\":30,\"freeClaimable\":3},\"promotion\":null},\"claimable\":0}}";
    const string Fresh = "{\"day\":\"2026-12-08\",\"now\":1796698800000,\"today\":{\"open\":false,\"items\":[],\"done\":0,\"total\":0,\"claimable\":0,\"complete\":false,\"resetAt\":1796756400000,\"loginBonus\":{\"open\":false,\"claimedToday\":false}},\"path\":{\"step\":1,\"steps\":10,\"done\":0,\"current\":{\"id\":\"bm_scout\",\"table\":\"beginner\",\"kind\":\"gacha\",\"progress\":0,\"target\":1,\"reward\":{\"freeCoins\":50},\"claimed\":false,\"claimable\":false},\"finalReward\":{\"items\":[{\"itemId\":\"gacha_ticket_10\",\"qty\":1}]}},\"week\":null,\"season\":{\"open\":false,\"seasonId\":\"2026-12\",\"endsAt\":1798729200000,\"classId\":\"C\",\"nextClassId\":\"B\",\"points\":0,\"races\":0,\"line\":300,\"left\":300,\"demoteBelow\":null,\"status\":\"rookie\",\"pace\":{\"races\":0,\"pace10\":null,\"racesToLine\":null,\"minRaces\":3},\"power\":{\"horseId\":\"h1\",\"partner\":true,\"total\":3320,\"cap\":2800,\"usable\":2800,\"nextCap\":3200,\"nextUsable\":3200,\"held\":520},\"ladder\":[{\"classId\":\"C\",\"statCap\":2800,\"promotePoints\":300,\"demoteBelowPoints\":null,\"current\":true,\"reached\":true,\"rewards\":{\"top\":{\"maxRank\":10,\"reward\":{\"freeCoins\":300}},\"floor\":{\"freeCoins\":50}}},{\"classId\":\"B\",\"statCap\":3200,\"promotePoints\":400,\"demoteBelowPoints\":50,\"current\":false,\"reached\":false,\"rewards\":{\"top\":{\"maxRank\":10,\"reward\":{\"freeCoins\":500}},\"floor\":{\"freeCoins\":80}}},{\"classId\":\"A\",\"statCap\":3600,\"promotePoints\":500,\"demoteBelowPoints\":80,\"current\":false,\"reached\":false,\"rewards\":{\"top\":{\"maxRank\":10,\"reward\":{\"freeCoins\":800,\"items\":[{\"itemId\":\"gacha_ticket\",\"qty\":1}]}},\"floor\":{\"freeCoins\":120}}},{\"classId\":\"S\",\"statCap\":4000,\"promotePoints\":null,\"demoteBelowPoints\":100,\"current\":false,\"reached\":false,\"rewards\":{\"top\":{\"maxRank\":1,\"reward\":{\"freeCoins\":3000,\"items\":[{\"itemId\":\"ticket_sr_plus\",\"qty\":1}]}},\"floor\":{\"freeCoins\":200}}}],\"missions\":[{\"id\":\"sm_races10\",\"table\":\"season\",\"kind\":\"ranked_races\",\"progress\":0,\"target\":10,\"reward\":{\"passXp\":100},\"claimed\":false,\"claimable\":false},{\"id\":\"sm_races30\",\"table\":\"season\",\"kind\":\"ranked_races\",\"progress\":0,\"target\":30,\"reward\":{\"passXp\":200},\"claimed\":false,\"claimable\":false},{\"id\":\"sm_wins5\",\"table\":\"season\",\"kind\":\"wins\",\"progress\":0,\"target\":5,\"reward\":{\"passXp\":150},\"claimed\":false,\"claimable\":false},{\"id\":\"sm_top3_15\",\"table\":\"season\",\"kind\":\"top3\",\"progress\":0,\"target\":15,\"reward\":{\"passXp\":150},\"claimed\":false,\"claimable\":false},{\"id\":\"sm_promotion\",\"table\":\"season\",\"kind\":\"promotion_line\",\"progress\":0,\"target\":300,\"reward\":{\"passXp\":300},\"claimed\":false,\"claimable\":false}],\"pass\":{\"level\":0,\"maxLevel\":30,\"freeClaimable\":0},\"promotion\":null},\"claimable\":0}";

    public static async Task Run(Action<bool, string> check, string root, RulesetParams ruleset)
    {
        var s = new FakeServer();
        bool down = false, claimed = false;
        s.Routes["POST /v1/player/bootstrap"] = _ => new HttpResponse(200, Player);
        s.Routes["GET /v1/player"] = _ => new HttpResponse(200, Player);
        s.Routes["GET /v1/home/goals"] = _ => down ? new HttpResponse(503, Busy) : new HttpResponse(200, View);
        s.Routes["POST /v1/home/goals/claim"] = _ => { if (claimed) return new HttpResponse(409, Nothing); claimed = true; return new HttpResponse(200, Claim); };
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var kv = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, ruleset);
        await b.InitializeAsync();
        var prevRule = GameDay.Rule;
        GameDay.Use(new DayRolloverInfo { HourJst = 4, PreviousHourJst = 0, EffectiveAtMs = 1796065200000 });
        try
        {
            long now = Now;
            var m = new GoalLadderModel(b, () => now);
            check((await m.LoadAsync()).Ok && m.Online, "goals: the server's ladder");
            check(m.Rungs.Select(r => r.Key).SequenceEqual(new[] { "today", "path", "season" }), "goals: a player with beginner steps left sees today / the path / the season (" + string.Join(",", m.Rungs.Select(r => r.Key)) + ")");
            var today = m.Rungs[0];
            check(today.Figure == "4/5" && today.Ready && today.Main == "受け取れる報酬があります", "goals: today's rung — honest figure and the claim dot (" + today.Figure + " " + today.Main + ")");
            check(m.Rungs[1].Main == "スカウトを1回" && m.Rungs[1].Sub.StartsWith("最後に 10連スカウト券"), "goals: the path names the next step and the last reward (" + m.Rungs[1].Sub + ")");
            var season = m.Rungs[2];
            check(season.Main == "C級　·　昇級まで あと135pt" && season.Figure == "165/300" && season.Ready, "goals: the season rung (" + season.Main + ")");
            check(m.PaceLine == "いまのペースで あと約9戦", "goals: the pace is the server's own estimate (" + m.PaceLine + ")");
            check(m.PowerLine == "相棒の力 2,800 / 3,320（C級の上限 2,800）" && m.WhyClimbLine == "B級なら 3,200 まで出せます", "goals: why climb — the partner's usable strength now and in B (" + m.WhyClimbLine + ")");
            check(m.Ladder.Count == 4 && m.Ladder[0].Current && m.Ladder[3].LineText == "最上位" && m.Ladder[3].RewardText.StartsWith("1位 "), "goals: the class ladder with caps, lines and the top reward band");
            var top3 = m.Today.First(r => r.Id == "top3x2");
            check(top3.PurposeText == "配合で良い仔を狙う・馬の覚醒に使う" && m.Today.First(r => r.Id == "train1").PurposeText == "次の調教の伸びが少し良くなる", "goals: each reward says what it does for the horses");
            var fw = m.Today.First(r => r.Id == "first_win");
            check(fw.Auto && !fw.Claimable, "goals: the first-win bonus is shown, never claimed (paid on the win)");
            check(m.SeasonMissions[0].PurposeText == "シーズンパスのレベルが上がる" && m.SeasonMissions[0].Claimable, "goals: season missions are on the ladder with their use");
            check(m.ClaimText == "まとめて受け取る（4件）", "goals: one claim text (" + m.ClaimText + ")");

            var c = await m.ClaimAllAsync();
            var post = s.Sent.Last(r => r.Path == "/v1/home/goals/claim");
            check(c.Ok && post.Method == "POST" && post.Headers.ContainsKey("idempotency-key"), "goals: the claim is one keyed POST");
            check(m.LastClaimLines.Count == 3 && m.LastClaimLines[0] == "無償コイン 45枚" && m.LastClaimLines[2] == "パスXP 100", "goals: the claim moment lists what arrived (" + string.Join(" / ", m.LastClaimLines) + ")");
            check(m.View.Claimable == 0 && m.ClaimText == null, "goals: the ladder after the claim has nothing left to claim");
            check(!(await m.ClaimAllAsync()).Ok, "goals: nothing left to claim → refused on the device");

            // offline: today's last ladder (never yesterday's)
            m.Use(GoalLadderView.FromJson(View), View);
            down = true;
            var off = await m.LoadAsync();
            check(!off.Ok && !m.Online && m.View != null && m.Rungs.Count == 3, "goals: offline reuses today's ladder");
            now += 86_400_000L;
            var m2 = new GoalLadderModel(b, () => now);
            await m2.LoadAsync();
            check(m2.View == null && m2.Rungs.Count == 0, "goals: offline on another game day shows nothing rather than stale figures");
            down = false;

            // a fresh player: no daily set yet → the path and the rookie season only
            var f = new GoalLadderModel(b, () => Now);
            f.Use(GoalLadderView.FromJson(Fresh));
            check(f.Rungs.Select(r => r.Key).SequenceEqual(new[] { "path", "season" }) && f.Rungs[1].Main.StartsWith("ルーキー"), "goals: a new player sees the path and the rookie season");

            // wording: no urgency, no shop; and every line in English
            var all = m.Rungs.SelectMany(r => new[] { r.Label, r.Main, r.Figure, r.Sub }).Concat(m.Today.SelectMany(r => new[] { r.Title, r.RewardText, r.PurposeText }))
                .Concat(m.SeasonMissions.SelectMany(r => new[] { r.Title, r.PurposeText })).Concat(m.Ladder.SelectMany(r => new[] { r.Title, r.CapText, r.LineText, r.RewardText }))
                .Concat(new[] { m.PowerLine, m.WhyClimbLine, m.PaceLine, "まとめて受け取る（4件）" }).Concat(m.LastClaimLines).Concat(f.Rungs.SelectMany(r => new[] { r.Main, r.Sub }))
                .Concat(GoalLadderModel.KindTitles.Values).Where(x => !string.IsNullOrEmpty(x)).ToList();
            var text = string.Join("", all);
            check(!text.Contains("今だけ") && !text.Contains("残りわずか") && !text.Contains("お得") && !text.Contains("倍") && !text.Contains("ショップ") && !text.Contains("購入"), "goals: no urgency words, no shop or purchase");
            Loc.LoadEnglish(File.ReadAllText(Path.Combine(root, "engine", "Muchi.Client", "Resources", "Muchi", "server-en.json")));
            Loc.LoadEnglish(File.ReadAllText(Path.Combine(root, "engine", "Muchi.Client", "Resources", "Muchi", "ui-en.json")));
            Loc.SetLocale("en");
            try
            {
                var miss = all.Where(x => Loc.HasJapanese(Loc.T(x))).Distinct().ToList();
                check(miss.Count == 0, "goals: every line has English (" + all.Count + " lines" + (miss.Count > 0 ? "; missing: " + string.Join(" | ", miss.Take(40)) : "") + ")");
            }
            finally { Loc.SetLocale("ja"); }
        }
        finally { GameDay.Use(prevRule); }
    }
}
