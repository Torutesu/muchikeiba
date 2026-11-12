// Quality integration (claude/quality-1): the quality passes working together in the Unity game layer.
//  a) home's 次にやること: NextActionModel.HomeLine is the first server item no other home element says (the goal ladder says
//     the missions and the season pass rewards with 「受け取れる報酬があります」, the menu says 調教, 「レースへ」 says the race and
//     the first-win bonus, the login bonus is automatic), else null (no line); one link at most (今日は閉じる);
//  e) the goal ladder's season rung counts the free pass rewards, names the pass on 目標, and links its cap line to the
//     horse card (HorseProfileModel) of the horse the power line is about.
// The same rule as the prototype's MuchiLogic.homeNextLine / ladderSeasonReady (tools/figma-prototype/test/quality-integration.test.mjs).
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class QualityIntegrationChecks
{
    const long Now = 1796698800000L; // 2026-12-08 12:00 JST
    static string Next(string items) => "{\"enabled\":true,\"onboarding\":false,\"day\":\"2026-12-08\",\"primary\":" + items + ",\"dismissed\":[],\"nextDayAt\":1796756400000}";
    const string Ladder = "{\"day\":\"2026-12-08\",\"now\":1796698800000,\"today\":{\"open\":false,\"items\":[],\"done\":0,\"total\":0,\"claimable\":0,\"complete\":false,\"resetAt\":1796756400000,\"loginBonus\":{\"open\":false,\"claimedToday\":false,\"next\":null}},\"path\":null,\"week\":null,"
        + "\"season\":{\"open\":true,\"seasonId\":\"2026-12\",\"endsAt\":1798729200000,\"classId\":\"C\",\"nextClassId\":\"B\",\"points\":165,\"races\":10,\"line\":300,\"left\":135,\"demoteBelow\":null,\"status\":\"climbing\",\"pace\":{\"races\":10,\"pace10\":165,\"racesToLine\":9,\"minRaces\":3},"
        + "\"power\":{\"horseId\":\"h1\",\"partner\":true,\"total\":3320,\"cap\":2800,\"usable\":2800,\"nextCap\":3200,\"nextUsable\":3200,\"held\":520},\"ladder\":[],"
        + "\"missions\":[{\"id\":\"sm_races30\",\"table\":\"season\",\"kind\":\"ranked_races\",\"progress\":10,\"target\":30,\"reward\":{\"passXp\":200},\"claimed\":false,\"claimable\":false}],\"pass\":{\"level\":2,\"maxLevel\":30,\"freeClaimable\":PASS},\"promotion\":null},\"claimable\":0}";

    sealed class NoServer : IHttp
    {
        public Task<HttpResponse> SendAsync(HttpRequest r, CancellationToken ct) => Task.FromResult(new HttpResponse(404, "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"no route\"}}"));
    }
    sealed class Tokens : IAuthTokenProvider { public Task<string> GetTokenAsync(bool f, CancellationToken ct) => Task.FromResult("tok"); }

    public static Task Run(Action<bool, string> check, string root, RulesetParams ruleset)
    {
        // a) the server order: missions_claim, pass_claim (both on the ladder), feature_unlocked (dismissible)
        var v = NextActionsView.FromJson(Next("{\"kind\":\"missions_claim\",\"screen\":\"missions\",\"count\":2,\"dismissible\":true},\"chips\":[{\"kind\":\"pass_claim\",\"screen\":\"season_pass\",\"count\":1,\"dismissible\":true},{\"kind\":\"feature_unlocked\",\"screen\":\"feature\",\"featureKey\":\"time_attack\",\"dismissible\":true}]"));
        check(v != null && v.Chips.Count == 2, "integration: the next list parses");
        foreach (var k in new[] { "missions_claim", "pass_claim", "login_bonus", "race", "first_race", "first_win", "training_slots", "rival_week", "weekly_challenge", "team_goal_near", "horse_goal_near", "missions_close" })
            check(NextActionModel.HomeCovered.Contains(k), "integration: " + k + " is said by another home element");
        var line = NextActionModel.HomeLine(v);
        check(line != null && line.Kind == "feature_unlocked", "integration: home's next line skips what the ladder says (" + line?.Kind + ")");
        check(NextActionModel.HomeLinks(line).SequenceEqual(new[] { "今日は閉じる" }), "integration: one link at most (今日は閉じる)");
        var covered = NextActionsView.FromJson(Next("{\"kind\":\"missions_claim\",\"screen\":\"missions\",\"count\":2,\"dismissible\":true},\"chips\":[{\"kind\":\"pass_claim\",\"screen\":\"season_pass\",\"count\":1,\"dismissible\":true}]"));
        check(NextActionModel.HomeLine(covered) == null, "integration: nothing home does not already say → no line");
        var gift = NextActionsView.FromJson(Next("{\"kind\":\"gift_expiring\",\"screen\":\"gift_box\",\"count\":1,\"deadlineAt\":1796856400000,\"dismissible\":false},\"chips\":[]"));
        var gl = NextActionModel.HomeLine(gift);
        check(gl != null && gl.Kind == "gift_expiring" && NextActionModel.HomeLinks(gl).Count == 0, "integration: not dismissible → no link (the line opens it)");
        check(NextActionModel.HomeLine(null) == null, "integration: no list → no line");

        // e) the ladder: the pass rewards on the season rung, the pass named on 目標, the cap linked to the horse card
        var api = new ApiClient(new NoServer(), new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, new MemoryKeyValueStore(), ruleset);
        var m = new GoalLadderModel(b, () => Now);
        m.Use(GoalLadderView.FromJson(Ladder.Replace("PASS", "2")));
        var season = m.Rungs.FirstOrDefault(r => r.Key == "season");
        check(season != null && season.Ready, "integration: free pass rewards make the season rung ready (次にやること no longer says them)");
        check(m.PassLine == "パス報酬 2段", "integration: 目標 names the pass rewards (" + m.PassLine + ")");
        check(m.CapCardHorseId == "h1" && m.CapCardLink == "馬カードで見る", "integration: the cap line links to the horse card of the ladder's horse");
        m.Use(GoalLadderView.FromJson(Ladder.Replace("PASS", "0")));
        season = m.Rungs.First(r => r.Key == "season");
        check(!season.Ready && m.PassLine == null, "integration: nothing to receive → no dot, no pass line");
        var lines = new[] { "パス報酬 2段", m.CapCardLink, "今日は閉じる", NextActionModel.Row(gift.Primary, "primary").Title };
        Loc.LoadEnglish(File.ReadAllText(Path.Combine(root, "engine", "Muchi.Client", "Resources", "Muchi", "ui-en.json")));
        Loc.SetLocale("en");
        try
        {
            var miss = lines.Where(x => Loc.HasJapanese(Loc.T(x))).ToList();
            check(miss.Count == 0, "integration: English for every new line" + (miss.Count > 0 ? " (missing: " + string.Join(" | ", miss) + ")" : ""));
        }
        finally { Loc.SetLocale("ja"); }
        return Task.CompletedTask;
    }
}
