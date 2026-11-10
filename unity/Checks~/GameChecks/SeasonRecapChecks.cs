// シーズンの振り返り (REQ-RECAP-001..016, contracts/protocol.md §43): SeasonRecapModel over a routed fake server with responses
// produced by the real server code. The list and its badge, opening (open reported once), paging to the end (complete
// reported once), skip, the short version, 「順位を隠す」 on the share set, recap_share, the reduced-motion hook and English.
using System.Linq;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class SeasonRecapChecks
{
    sealed class FakeServer : IHttp
    {
        public readonly List<HttpRequest> Sent = new List<HttpRequest>();
        public readonly Dictionary<string, Func<HttpRequest, HttpResponse>> Routes = new Dictionary<string, Func<HttpRequest, HttpResponse>>();
        public Task<HttpResponse> SendAsync(HttpRequest r, CancellationToken ct)
        {
            Sent.Add(r);
            if (Routes.TryGetValue(r.Method + " " + r.Path, out var h)) return Task.FromResult(h(r));
            return Task.FromResult(new HttpResponse(404, "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"no such recap\"}}"));
        }
    }
    sealed class Tokens : IAuthTokenProvider { public Task<string> GetTokenAsync(bool f, CancellationToken ct) => Task.FromResult("tok"); }

    const string PlayerJson = "{\"id\":\"a\",\"wallet\":{\"paid\":0,\"free\":500,\"total\":500,\"debt\":0},\"season\":{\"id\":\"2026-12\",\"classId\":\"B\",\"points\":0},\"items\":{},\"horses\":[{\"id\":\"h1\",\"name\":\"アイボウ\",\"rarity\":\"SR\",\"status\":\"active\",\"base\":{\"speed\":700}}],\"equipment\":{\"tack\":{},\"decor\":[]}}";
    const string List = "{\"enabled\":true,\"recaps\":[{\"id\":\"season:2026-11\",\"kind\":\"season\",\"periodId\":\"2026-11\",\"title\":\"2026年11月シーズン\",\"short\":false,\"builtAt\":1796054400000,\"opened\":false,\"completed\":false}],\"unseen\":\"season:2026-11\"}";
    const string View = "{\"id\":\"season:2026-11\",\"kind\":\"season\",\"periodId\":\"2026-11\",\"title\":\"2026年11月シーズン\",\"short\":false,\"sinceNote\":null,\"steps\":[{\"unit\":\"戦\",\"notes\":[\"3着以内 6回\"],\"key\":\"races\",\"label\":\"走ったレース\",\"value\":\"7\"},{\"unit\":\"勝\",\"notes\":[\"勝率 57%\"],\"key\":\"wins\",\"label\":\"勝利\",\"value\":\"4\"},{\"unit\":null,\"notes\":[\"12頭立て\"],\"key\":\"best_finish\",\"label\":\"最高着順\",\"value\":\"1着\"},{\"unit\":null,\"notes\":[\"最終順位 4位\",\"C級からB級へ昇格\"],\"key\":\"rank\",\"label\":\"到達したクラス\",\"value\":\"B級\"},{\"unit\":null,\"notes\":[\"7戦4勝\"],\"key\":\"horse\",\"label\":\"いちばん一緒に走った馬\",\"value\":null,\"horseName\":\"アイボウ\"},{\"unit\":null,\"notes\":[\"5戦\"],\"key\":\"style\",\"label\":\"よく使った脚質\",\"value\":\"差し\"},{\"unit\":null,\"notes\":[],\"key\":\"moments\",\"label\":\"名場面\",\"value\":null,\"moments\":[{\"kind\":\"promotion\",\"text\":\"C級からB級へ昇格\",\"horseName\":null},{\"kind\":\"first_win\",\"text\":\"シーズン初勝利（きらめき競馬場 芝2000m）\",\"horseName\":\"アイボウ\"},{\"kind\":\"streak\",\"text\":\"2連勝\",\"horseName\":null}]},{\"unit\":null,\"notes\":[],\"key\":\"end\",\"label\":\"おつかれさまでした\",\"value\":null}],\"shareCards\":[{\"card\":\"summary\",\"title\":\"2026年11月シーズン\",\"headline\":\"7\",\"unit\":\"戦\",\"lines\":[\"4勝・3着以内 6回\"],\"horseName\":null,\"rank\":false},{\"card\":\"horse\",\"title\":\"2026年11月シーズン\",\"headline\":\"\",\"unit\":null,\"lines\":[\"いちばん一緒に走った馬\",\"7戦4勝\"],\"horseName\":\"アイボウ\",\"rank\":false},{\"card\":\"moment\",\"title\":\"2026年11月シーズン\",\"headline\":\"\",\"unit\":null,\"lines\":[\"名場面\",\"シーズン初勝利（きらめき競馬場 芝2000m）\"],\"horseName\":\"アイボウ\",\"rank\":false},{\"card\":\"rank\",\"title\":\"2026年11月シーズン\",\"headline\":\"B級\",\"unit\":null,\"lines\":[\"最終順位 4位\"],\"horseName\":null,\"rank\":true}],\"openedAt\":null,\"completedAt\":null}";
    const string ViewEn = "{\"id\":\"season:2026-11\",\"kind\":\"season\",\"periodId\":\"2026-11\",\"title\":\"Season 11/2026\",\"short\":false,\"sinceNote\":null,\"steps\":[{\"unit\":\"races\",\"notes\":[\"Top 3: 6 times\"],\"key\":\"races\",\"label\":\"Races run\",\"value\":\"7\"},{\"unit\":\"wins\",\"notes\":[\"Win rate 57%\"],\"key\":\"wins\",\"label\":\"Wins\",\"value\":\"4\"},{\"unit\":null,\"notes\":[\"12 runners\"],\"key\":\"best_finish\",\"label\":\"Best finish\",\"value\":\"1st\"},{\"unit\":null,\"notes\":[\"Final position: 4th\",\"Promoted from Class C to Class B\"],\"key\":\"rank\",\"label\":\"Class reached\",\"value\":\"Class B\"},{\"unit\":null,\"notes\":[\"7 races, 4 wins\"],\"key\":\"horse\",\"label\":\"Your most-raced horse\",\"value\":null,\"horseName\":\"アイボウ\"},{\"unit\":null,\"notes\":[\"5 races\"],\"key\":\"style\",\"label\":\"Most-used running style\",\"value\":\"Closer\"},{\"unit\":null,\"notes\":[],\"key\":\"moments\",\"label\":\"Moments\",\"value\":null,\"moments\":[{\"kind\":\"promotion\",\"text\":\"Promoted from Class C to Class B\",\"horseName\":null},{\"kind\":\"first_win\",\"text\":\"First win of the season (Kirameki Racecourse, Turf 2000 m)\",\"horseName\":\"アイボウ\"},{\"kind\":\"streak\",\"text\":\"2 wins in a row\",\"horseName\":null}]},{\"unit\":null,\"notes\":[],\"key\":\"end\",\"label\":\"Well ridden.\",\"value\":null}],\"shareCards\":[{\"card\":\"summary\",\"title\":\"Season 11/2026\",\"headline\":\"7\",\"unit\":\"races\",\"lines\":[\"4 wins, Top 3: 6 times\"],\"horseName\":null,\"rank\":false},{\"card\":\"horse\",\"title\":\"Season 11/2026\",\"headline\":\"\",\"unit\":null,\"lines\":[\"Your most-raced horse\",\"7 races, 4 wins\"],\"horseName\":\"アイボウ\",\"rank\":false},{\"card\":\"moment\",\"title\":\"Season 11/2026\",\"headline\":\"\",\"unit\":null,\"lines\":[\"Moments\",\"First win of the season (Kirameki Racecourse, Turf 2000 m)\"],\"horseName\":\"アイボウ\",\"rank\":false},{\"card\":\"rank\",\"title\":\"Season 11/2026\",\"headline\":\"Class B\",\"unit\":null,\"lines\":[\"Final position: 4th\"],\"horseName\":null,\"rank\":true}],\"openedAt\":null,\"completedAt\":null}";
    const string Short = "{\"id\":\"season:2026-10\",\"kind\":\"season\",\"periodId\":\"2026-10\",\"title\":\"2026年10月シーズン\",\"short\":true,\"sinceNote\":\"2026-10-20からの記録です\",\"steps\":[{\"unit\":\"戦\",\"notes\":[],\"key\":\"races\",\"label\":\"走ったレース\",\"value\":\"1\"},{\"unit\":null,\"notes\":[\"12頭立て\"],\"key\":\"best_finish\",\"label\":\"最高着順\",\"value\":\"6着\"},{\"unit\":null,\"notes\":[],\"key\":\"end\",\"label\":\"次のシーズンも、あなたのペースで。\",\"value\":null}],\"shareCards\":[{\"card\":\"summary\",\"title\":\"2026年10月シーズン\",\"headline\":\"1\",\"unit\":\"戦\",\"lines\":[\"0勝・3着以内 0回\"],\"horseName\":null,\"rank\":false}],\"openedAt\":null,\"completedAt\":null}";

    static HttpResponse Ok(string body) => new HttpResponse(200, body);

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        var s = new FakeServer();
        long? opened = null, completed = null;
        s.Routes["POST /v1/player/bootstrap"] = _ => Ok(PlayerJson);
        s.Routes["GET /v1/player"] = _ => Ok(PlayerJson);
        s.Routes["GET /v1/recaps"] = _ => Ok(List);
        s.Routes["GET /v1/recaps/season%3A2026-11"] = _ => Ok(View);
        s.Routes["GET /v1/recaps/season%3A2026-10"] = _ => Ok(Short);
        Func<HttpRequest, HttpResponse> progress = r =>
        {
            if (r.Body.Contains("\"open\"")) opened ??= 1;
            else { completed ??= 2; opened ??= 2; }
            return Ok("{\"openedAt\":" + (opened?.ToString() ?? "null") + ",\"completedAt\":" + (completed?.ToString() ?? "null") + "}");
        };
        s.Routes["POST /v1/recaps/season%3A2026-11/progress"] = progress;
        s.Routes["POST /v1/recaps/season%3A2026-10/progress"] = progress;
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, new MemoryKeyValueStore(), ruleset);
        await b.InitializeAsync();
        var events = new List<AnalyticsEvent>();
        var m = new SeasonRecapModel(b, events.Add, () => 1796054400000L);

        var l = await m.LoadListAsync();
        check(l.Ok && m.Enabled && m.HasNew && m.Rows.Count == 1 && m.Rows[0].IsNew && m.Rows[0].Title == "2026年11月シーズン", "recap: the profile list and its badge");
        var o = await m.OpenAsync("season:2026-11");
        int opens() => s.Sent.Count(r => r.Path.EndsWith("/progress") && r.Body.Contains("\"open\""));
        int completes() => s.Sent.Count(r => r.Path.EndsWith("/progress") && r.Body.Contains("\"complete\""));
        check(o.Ok && m.Index == 0 && m.Current.Key == "races" && m.Current.BigText == "7" && m.Current.Unit == "戦" && opens() == 1 && m.OpenReported, "recap: opens on page 1 and reports open once (" + m.PositionText + ")");
        check(m.Pages.Select(p => p.Key).SequenceEqual(new[] { "races", "wins", "best_finish", "rank", "horse", "style", "moments", "end" }), "recap: the pages in the server's order");
        var horse = m.Pages.First(p => p.Key == "horse");
        check(horse.BigTextIsName && horse.BigText == "アイボウ" && horse.Notes[0] == "7戦4勝", "recap: the horse page shows the name as typed");
        check(m.Pages.First(p => p.Key == "moments").Moments.Count == 3, "recap: moments from the data (" + string.Join(" / ", m.Pages.First(p => p.Key == "moments").Moments.Select(x => x.Text)) + ")");
        m.Back();
        check(m.Index == 0 && !m.CanBack, "recap: back stops at page 1");
        for (int i = 0; i < 3; i++) await m.NextAsync();
        check(m.Current.Key == "rank" && completes() == 0, "recap: paging forward reports nothing until the end");
        await m.SkipToEndAsync();
        await m.NextAsync();
        check(m.AtEnd && m.Current.IsEnd && completes() == 1 && m.CompleteReported, "recap: 「最後まで」 reaches the end and reports complete once");
        var reopen = await m.OpenAsync("season:2026-11");
        check(reopen.Ok && opens() == 1 + 1 && m.Index == 0, "recap: reopening starts again at page 1 (the server keeps the first time)");

        // share: the ShareCard path, 「順位を隠す」 remembered, recap_share
        m.HideRank = false;
        var all = m.ShareCards();
        check(all.Select(c => c.Kind).SequenceEqual(new[] { "recap_summary", "recap_horse", "recap_moment", "recap_rank" }) && all.All(c => c.Watermark == ShareCard.GameTitle && c.ShareText.EndsWith(ShareCard.Hashtag)), "recap: four share cards on the ShareCard path");
        m.HideRank = true;
        var hidden = m.ShareCards();
        check(hidden.Count == 3 && hidden.All(c => c.Kind != "recap_rank") && new SeasonRecapModel(b).HideRank, "recap: 「順位を隠す」 drops the rank card and is remembered");
        m.Shared(hidden[1]);
        check(events.Count == 1 && events[0].Name == "recap_share" && events[0].PropsJson.Contains("\"card\":\"horse\"") && events[0].PropsJson.Contains("\"hideRank\":true"), "recap: recap_share names the card and the hide-rank choice");
        check(all.All(c => !c.ShareText.Contains("騎手") && !c.ShareText.Contains("コイン")), "recap: share text holds only the horse and the numbers");

        // short version
        var sh = await m.OpenAsync("season:2026-10");
        check(sh.Ok && m.View.Short && m.Pages.Count == 3 && m.View.SinceNote == "2026-10-20からの記録です" && m.Pages.Last().Label == "次のシーズンも、あなたのペースで。", "recap: the short version (3 pages, honest since-note)");

        // reduced motion hook (§41 not on this base yet)
        check(m.TransitionMs > 0 && m.CountUpMs > 0, "recap: motion on by default");
        SeasonRecapModel.ReducedMotion = () => true;
        check(m.TransitionMs == 0 && m.CountUpMs == 0, "recap: the reduced-motion hook cuts pages and count-ups");
        SeasonRecapModel.ReducedMotion = () => false;

        // English: the server's lines arrive translated; names stay as typed; the model's own texts have English
        var en = RecapView.FromJson(ViewEn);
        var p0 = SeasonRecapModel.ToPage(en.Steps[0]);
        check(p0.Label == "Races run" && p0.Unit == "races" && SeasonRecapModel.ToPage(en.Steps.First(x => x.Key == "horse")).BigText == "アイボウ", "recap: English pages keep the horse name");
        Loc.SetLocale("en");
        try
        {
            var texts = new[] { SeasonRecapModel.TextTitle, SeasonRecapModel.TextEmpty, SeasonRecapModel.TextNext, SeasonRecapModel.TextBack, SeasonRecapModel.TextSkip, SeasonRecapModel.TextShare, SeasonRecapModel.TextHideRank, SeasonRecapModel.TextPrivacy, SeasonRecapModel.TextYearBadge };
            check(texts.All(t => !Loc.HasJapanese(Loc.T(t))), "recap: every model text has English (" + string.Join(" / ", texts.Select(Loc.T)) + ")");
        }
        finally { Loc.SetLocale("ja"); }
        var words = string.Join("\n", new[] { SeasonRecapModel.TextTitle, SeasonRecapModel.TextEmpty, SeasonRecapModel.TextPrivacy, View });
        check(!new[] { "倍", "お得", "今だけ", "賭", "配当", "オッズ", "購入", "課金" }.Any(words.Contains), "recap: no betting words, no fake urgency, no spending");
    }
}
