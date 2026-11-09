// 支部の共同目標 (REQ-TGOAL-*, contracts/protocol.md §32): TeamGoalModel over a routed fake server (the JSON comes from the
// real server's TeamsService.goal). Milestone bar positions, my contribution against the minimum and the daily cap, the
// contributor list (names as typed), the week result sheet shown once per week, the goal row of the team feed (not
// reportable), no button that adds to the goal, and every text the models build in English.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class TeamGoalChecks
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
    static HttpResponse Ok(string body) => new HttpResponse(200, body);

    const long Now = 1796875200000L; // 2026-12-15 13:00 JST (week 2026-12-14)
    const string PlayerJson = "{\"id\":\"a\",\"profile\":{\"displayName\":\"騎手A\"},\"wallet\":{\"paid\":0,\"free\":500,\"total\":500,\"debt\":0},\"deletion\":{\"status\":\"none\",\"requestedAt\":null,\"deleteAt\":null}}";
    const string View = "{\"teamId\":\"tixmuqc4zk\",\"teamName\":\"あおばRC\",\"enabled\":true,\"current\":{\"week\":\"2026-12-14\",\"endsAt\":1797793200000,\"goalId\":\"races_sum\",\"kind\":\"races\",\"label\":\"支部で合計60レース\",\"scale\":3,\"progress\":21,\"tier\":1,\"minContribution\":3,"
        + "\"milestones\":[{\"tier\":1,\"target\":18,\"reached\":true,\"reward\":{\"freeCoins\":5}},{\"tier\":2,\"target\":36,\"reached\":false,\"reward\":{\"freeCoins\":10,\"items\":[{\"itemId\":\"breeding_material\",\"qty\":1}]}},{\"tier\":3,\"target\":60,\"reached\":false,\"reward\":{\"freeCoins\":20,\"items\":[{\"itemId\":\"breeding_material\",\"qty\":1}]}}],"
        + "\"my\":{\"contribution\":10,\"today\":10,\"dailyCap\":10,\"qualified\":true},\"top\":[{\"playerId\":\"a\",\"displayName\":\"騎手A\",\"n\":10},{\"playerId\":\"b\",\"displayName\":\"決勝\",\"n\":9},{\"playerId\":\"lead\",\"displayName\":\"騎手LEAD\",\"n\":2}],\"contributors\":3},"
        + "\"lastWeek\":{\"week\":\"2026-12-07\",\"goalId\":\"races_sum\",\"kind\":\"races\",\"label\":\"支部で合計60レース\",\"targets\":[18,36,60],\"progress\":38,\"tier\":2,\"reward\":{\"freeCoins\":10,\"items\":[{\"itemId\":\"breeding_material\",\"qty\":1}]},"
        + "\"top\":[{\"playerId\":\"a\",\"displayName\":\"騎手A\",\"n\":20},{\"playerId\":\"b\",\"displayName\":\"決勝\",\"n\":16}],\"eligible\":true,\"paid\":true},"
        + "\"player\":{\"enabled\":true,\"sentToday\":{\"races\":10,\"wins\":0,\"ta_pb\":0},\"pending\":0,\"lastReward\":null}}";
    const string NoTeam = "{\"teamId\":null,\"teamName\":null,\"enabled\":true,\"current\":null,\"lastWeek\":null,\"player\":{\"enabled\":true,\"sentToday\":{\"races\":0,\"wins\":0,\"ta_pb\":0},\"pending\":0,\"lastReward\":null}}";
    const string GoalItem = "{\"seq\":2,\"at\":1796787360000,\"kind\":\"goal\",\"playerId\":\"\",\"displayName\":\"\",\"mine\":false,\"stampId\":null,\"stampAsset\":null,\"race\":null,\"goal\":{\"week\":\"2026-12-07\",\"goalId\":\"races_sum\",\"label\":\"支部で合計60レース\",\"tier\":2,\"target\":36,\"tiers\":3},\"reactions\":[],\"myReaction\":null}";

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        var s = new FakeServer();
        s.Routes["POST /v1/player/bootstrap"] = _ => Ok(PlayerJson);
        s.Routes["GET /v1/player"] = _ => Ok(PlayerJson);
        string view = View;
        s.Routes["GET /v1/teams/me/goal"] = _ => Ok(view);
        s.Routes["GET /v1/stamps"] = _ => Ok("{\"version\":1,\"limits\":{},\"stamps\":[]}");
        s.Routes["GET /v1/teams/me/feed"] = _ => Ok("{\"teamId\":\"tixmuqc4zk\",\"items\":[" + GoalItem + "],\"nextBefore\":null,\"latestSeq\":2,\"muted\":[]}");
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var kv = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, ruleset);
        await b.InitializeAsync();

        long t = Now;
        var m = new TeamGoalModel(b, () => t);
        var load = await m.LoadAsync();
        check(load.Ok && m.InTeam && m.HasGoal && m.EmptyText == null, "team goal: loads my team's week");
        var ms = m.Milestones;
        check(ms.Count == 3 && Math.Abs(ms[0].Position - 0.3f) < 1e-4 && Math.Abs(ms[1].Position - 0.6f) < 1e-4 && ms[2].Position == 1f && ms[0].Reached && !ms[1].Reached,
            "team goal: one marker per milestone at target / last target");
        check(Math.Abs(m.ProgressFraction - 0.35f) < 1e-4 && m.ProgressText == "進み具合 21 / 60レース" && m.NextText == "次の段まで あと15レース", "team goal: bar fill and next milestone (" + m.NextText + ")");
        check(ms[1].TierText == "2段目" && ms[1].TargetText == "36レース" && ms[1].RewardText == "無償コイン10枚・配合素材×1", "team goal: tier reward lines (" + ms[1].RewardText + ")");
        check(m.MyText == "あなたの貢献 10レース（報酬は3レースから）" && m.QualifiedText == "報酬の対象です" && m.TodayText == "今日 10 / 10（1日の上限）" && m.CappedText != null,
            "team goal: my contribution, the minimum and the per-member daily cap");
        check(m.EndsText == "12月21日 4:00 締め" && !m.Closing, "team goal: closes Monday 4:00 JST (" + m.EndsText + ")");
        var rows = m.Contributors;
        check(rows.Count == 3 && rows[0].Mine && rows[0].Name == "騎手A" && rows[1].Name == "決勝" && rows[1].CountText == "9レース", "team goal: contributor list with names as typed");
        check(!typeof(TeamGoalModel).GetMethods().Any(x => x.Name.Contains("Contribute") || x.Name.Contains("Add")), "team goal: the client has no way to add to the goal (server-confirmed results only)");
        check(!TeamGoalModel.RulesText.Contains("倍") && !TeamGoalModel.RulesText.Contains("今だけ") && TeamGoalModel.RulesText.Contains("無償"), "team goal: rules wording (free, no lottery, no urgency)");

        // week result sheet: once per closed week, kept on the device
        var sheet = m.Result;
        check(sheet != null && sheet.TierText == "2段目に到達" && sheet.MineText == "報酬はプレゼントボックスに届きました" && sheet.RewardText == "無償コイン10枚・配合素材×1" && sheet.Top.Count == 2, "team goal: week result sheet");
        m.DismissResult();
        check(m.Result == null && kv.Get(TeamGoalModel.KeySeenWeek) == "2026-12-07", "team goal: the result sheet is shown once per week");
        view = View.Replace("\"eligible\":true,\"paid\":true", "\"eligible\":false,\"paid\":false").Replace("2026-12-07", "2026-11-30");
        await m.LoadAsync();
        check(m.Result != null && m.Result.MineText == "貢献が最低限に届かず、今回は対象外でした", "team goal: a new week's sheet says why there was no reward");
        t = 1797793200000L;
        check(m.Closing, "team goal: counting state after the week ended");

        // not in a team / offline
        view = NoTeam;
        await m.LoadAsync();
        check(!m.InTeam && !m.HasGoal && m.EmptyText == "支部に入ると共同目標に参加できます" && m.Result == null, "team goal: outside a team the panel invites to join");
        var off = new GameBackend(new GameSettings { OfflineOnly = true }, null, null, new MemoryKeyValueStore(), ruleset);
        var om = new TeamGoalModel(off, () => Now);
        check(!(await om.LoadAsync()).Ok && om.EmptyText == UxText.Offline, "team goal: offline");

        // the team feed's goal row
        var feed = new TeamFeedModel(b, () => Now);
        await feed.LoadAsync();
        var row = feed.Rows.FirstOrDefault();
        check(row != null && row.IsGoal && !row.CanCheer && !row.Mine && row.Line == "共同目標「支部で合計60レース」が2段目に到達！", "team feed: goal row line (" + row?.Line + ")");
        check(!(await feed.ReportAsync(2, FeedReportReason.Spam)).Ok, "team feed: a goal row cannot be reported");

        // English: every text the models build (server texts arrive in English; the label below is the Japanese one)
        view = View;
        await m.LoadAsync();
        Loc.SetLocale("en");
        try
        {
            var built = new List<string> { m.ProgressText, m.NextText, m.MyText, m.QualifiedText, m.TodayText, m.CappedText, m.EndsText, TeamGoalModel.RulesText, row.Line,
                "最後の段に到達しました", "あと2レースで報酬の対象", "次の段まで あと3勝", "あなたの貢献 1回更新（報酬は1回更新から）", "共同目標はオンラインで見られます", "共同目標は準備中です", "支部に入ると共同目標に参加できます",
                "段に届きませんでした", "次の週も支部のみんなで挑戦しましょう", "受け取りの準備中です", "貢献が最低限に届かず、今回は対象外でした", "報酬はプレゼントボックスに届きました", "今日の上限に届きました。4:00に戻ります" };
            foreach (var x in m.Milestones) { built.Add(x.TierText); built.Add(x.TargetText); built.Add(x.RewardText); }
            foreach (var x in m.Contributors) built.Add(x.CountText);
            var r = m.Result;
            if (r != null) { built.Add(r.TierText); built.Add(r.RewardText); built.Add(r.MineText); }
            var bad = built.Where(x => x != null && Loc.HasJapanese(Loc.T(x))).ToList();
            check(Loc.English.Count > 0 && bad.Count == 0, "team goal: every text the models build reads in English (" + built.Count + ")" + (bad.Count > 0 ? ": " + string.Join(" | ", bad) : ""));
            check(Loc.T(m.NextText) == "15 races more to the next milestone", "team goal in English: " + Loc.T(m.NextText));
            check(Loc.T(m.ProgressText) == "Progress 21 / 60 races" && Loc.T(row.Line) == "Branch goal \"60 races as a branch\": milestone 2 reached!", "team goal in English: " + Loc.T(m.ProgressText) + " / " + Loc.T(row.Line));
        }
        finally { Loc.SetLocale("ja"); }
    }
}
