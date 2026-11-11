// 馬ごとの目標 (REQ-HGOAL-001..016, contracts/protocol.md §53): HorseGoalsModel over a routed fake server. The goals panel rows
// (chapter, line, progress, current), the ribbon, pin / unpin (hidden for a retired horse or a finished chain), the home's pinned
// card from bootstrap and from the server, KPI hgoal_view (detail every open, home once per game day), the next-action kind's
// texts, English for every label, and no shop / urgency words.
using System.Linq;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class HorseGoalsChecks
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

    const long Now = 1796698800000L;
    const string Goal = "{\"id\":\"races:10\",\"kind\":\"races\",\"params\":{\"n\":10},\"text\":\"10戦を走る\",\"have\":7,\"need\":10,\"done\":false,\"completedAt\":null,\"current\":true}";
    const string PinJson = "{\"horseId\":\"h7\",\"horseName\":\"ミドリノカゼ\",\"goal\":" + Goal + ",\"doneCount\":1,\"total\":7}";
    const string Player = "{\"id\":\"g\",\"wallet\":{\"paid\":0,\"free\":0,\"total\":0,\"debt\":0},\"season\":{\"id\":\"2026-12\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[],\"equipment\":{\"tack\":{},\"decor\":[]},\"deletion\":{\"status\":\"none\"},\"horseGoalPin\":" + PinJson + "}";
    static string View(bool pinned, string status = "active", bool complete = false) =>
        "{\"v\":1,\"horseId\":\"h7\",\"horseName\":\"ミドリノカゼ\",\"status\":\"" + status + "\",\"pinned\":" + (pinned ? "true" : "false") + ",\"goals\":[" +
        "{\"id\":\"first_win\",\"kind\":\"first_win\",\"params\":{},\"text\":\"初勝利をあげる\",\"have\":1,\"need\":1,\"done\":true,\"completedAt\":1794000000000,\"current\":false}," +
        (complete ? Goal.Replace("\"have\":7", "\"have\":10").Replace("\"done\":false", "\"done\":true").Replace("\"current\":true", "\"current\":false") : Goal) +
        ",{\"id\":\"surface_win:turf\",\"kind\":\"surface_win\",\"params\":{\"surface\":\"turf\",\"n\":3},\"text\":\"芝で3勝する\",\"have\":1,\"need\":3,\"done\":" + (complete ? "true" : "false") + ",\"completedAt\":null,\"current\":false}" +
        "],\"doneCount\":" + (complete ? 3 : 1) + ",\"total\":3,\"chainComplete\":" + (complete ? "true" : "false") + ",\"chainCompletedAt\":null,\"notice\":\"目標は確定したレースの成績だけで進みます。達成の印は見た目だけです。\"}";

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        var s = new FakeServer();
        bool pinned = false; string status = "active"; bool complete = false;
        s.Routes["POST /v1/player/bootstrap"] = _ => new HttpResponse(200, Player);
        s.Routes["GET /v1/player"] = _ => new HttpResponse(200, Player);
        s.Routes["GET /v1/horses/h7/goals"] = _ => new HttpResponse(200, View(pinned, status, complete));
        s.Routes["PUT /v1/horse-goals/pin"] = r => { pinned = r.Body.Contains("\"h7\""); return new HttpResponse(200, "{\"pinned\":" + (pinned ? PinJson : "null") + "}"); };
        s.Routes["GET /v1/horse-goals/pinned"] = _ => new HttpResponse(200, "{\"pinned\":" + (pinned ? PinJson : "null") + "}");
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var kv = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, ruleset);
        await b.InitializeAsync();
        var events = new List<AnalyticsEvent>();
        long now = Now;
        var m = new HorseGoalsModel(b, events.Add, () => now);

        var load = await m.LoadAsync("h7");
        check(load.Ok && m.Rows.Count == 3 && m.HorseName == "ミドリノカゼ" && m.SummaryText == "目標 1 / 3", "hgoal: the panel loads the server's chain (" + m.SummaryText + ")");
        var r = m.Rows[1];
        check(r.StepText == "2" && r.ChapterText == "場数" && r.Text == "10戦を走る" && r.ProgressText == "7 / 10" && Math.Abs(r.Ratio - 0.7f) < 0.001f && r.Current && !r.Done, "hgoal: a row has its step, chapter, line, progress and the current mark");
        check(m.Rows[0].ProgressText == HorseGoalsModel.DoneLabel && m.Rows[0].Ratio == 1f, "hgoal: a done goal reads 達成");
        check(events.Count(e => e.Name == "hgoal_view") == 1, "hgoal: hgoal_view detail on open");
        check(m.CanPin && !m.IsPinned && !m.ChainComplete, "hgoal: an active horse with goals left can be pinned");

        var p = await m.TogglePinAsync();
        check(p.Ok && m.IsPinned && m.Pinned.HorseName == "ミドリノカゼ" && m.Pinned.GoalText == "10戦を走る" && m.Pinned.ProgressText == "7 / 10" && s.Sent.Last().Body.Contains("\"horseId\":\"h7\""), "hgoal: pin sends the horse and shows the home card");
        p = await m.TogglePinAsync();
        check(p.Ok && !m.IsPinned && m.Pinned == null && s.Sent.Last().Body.Contains("\"horseId\":null"), "hgoal: unpin sends null");

        // the home: the bootstrap pin, then the server's
        var home = new HorseGoalsModel(b, events.Add, () => now);
        home.UsePin(b.Player.HorseGoalPin);
        check(home.Pinned != null && home.Pinned.ChainText == "目標 1 / 7" && home.Pinned.Label == HorseGoalsModel.PinnedLabel, "hgoal: the bootstrap's pinned goal draws the home card");
        check(home.ReportHomeView() && !home.ReportHomeView(), "hgoal: hgoal_view home once per game day");
        now += 86_400_000;
        check(home.ReportHomeView(), "hgoal: hgoal_view home again the next game day");
        await home.LoadPinnedAsync();
        check(home.Pinned == null, "hgoal: the server's answer (nothing pinned now) wins over the bootstrap copy");

        // a retired horse / a finished chain: no pin button, the ribbon
        status = "retired"; complete = true;
        await m.LoadAsync("h7");
        check(!m.CanPin && m.ChainComplete && !(await m.TogglePinAsync()).Ok, "hgoal: a retired horse with a finished chain cannot be pinned; the ribbon shows");

        // next action kind, English, legal words
        var row = NextActionModel.Row(new NextItem { Kind = "horse_goal_near", Screen = "horse_goals", Count = 2, RefId = "h7", Dismissible = true }, "primary");
        check(row.Title == "馬の目標まで あと2" && row.ChipText == "馬の目標 あと2" && row.Screen == "horse_goals", "hgoal: the next-action card names the goal and opens the horse's goals");
        var labels = new List<string> { HorseGoalsModel.Title, HorseGoalsModel.RibbonText, HorseGoalsModel.PinLabel, HorseGoalsModel.UnpinLabel, HorseGoalsModel.PinnedLabel,
            HorseGoalsModel.DoneLabel, HorseGoalsModel.OfflineText, HorseGoalsModel.RulesText, "目標 1 / 3", row.Title, row.Detail, row.CtaText, row.ChipText, "10戦を走る", "芝で3勝する" };
        labels.AddRange(HorseGoalsModel.Chapters.Values);
        Loc.SetLocale("en");
        try
        {
            var missing = labels.Where(t => Loc.HasJapanese(Loc.T(t))).ToList();
            check(missing.Count == 0, "hgoal: every label has English (" + string.Join(" | ", missing) + ")");
        }
        finally { Loc.SetLocale("ja"); }
        var all = string.Join("", labels);
        check(!all.Contains("今だけ") && !all.Contains("残りわずか") && !all.Contains("倍") && !all.Contains("ショップ") && !all.Contains("購入") && BettingFree(all), "hgoal: no urgency, shop or betting words");
    }

    static bool BettingFree(string s) => !new[] { "馬券", "オッズ", "配当", "的中", "賭", "儲", "本命" }.Any(s.Contains);
}
