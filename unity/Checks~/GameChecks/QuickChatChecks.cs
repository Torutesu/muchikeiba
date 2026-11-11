// 支部の定型チャット (REQ-QCHAT-015, contracts/protocol.md §52): QuickChatModel over a routed fake server. Tabs and phrases,
// slots filled only from the server's options (single option chosen already), the preview, the send body (phrase id +
// refs, no text), the cooldown and daily limit, server errors as sentences, rows with mentions / anonymous authors, the
// device mute hiding rows at once, cheering with a stamp, and no urgency or betting words in the model's own texts.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class QuickChatChecks
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
    const string Player = "{\"id\":\"me\",\"displayName\":\"シノノメ\",\"wallet\":{\"paid\":0,\"free\":0,\"total\":0,\"debt\":0},\"season\":{\"id\":\"2026-12\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[],\"equipment\":{\"tack\":{},\"decor\":[]},\"deletion\":{\"status\":\"none\"}}";
    // the real server's answer (TeamsService.quickChat, Japanese)
    const string Picker = "{\"enabled\":true,\"teamId\":\"tabc123456\",\"deleting\":false,\"limits\":{\"postIntervalMs\":15000,\"postsPerDay\":30,\"mentionsPerDay\":10,\"repeatWindowMs\":600000},"
        + "\"phrases\":[{\"id\":\"otsukare\",\"category\":\"greet\",\"slots\":[],\"mention\":false,\"qchatTemplate\":\"おつかれさま！\"},"
        + "{\"id\":\"nice_player\",\"category\":\"cheer\",\"slots\":[\"player\"],\"mention\":true,\"qchatTemplate\":\"{player}さんナイス！\"},"
        + "{\"id\":\"run_together\",\"category\":\"invite\",\"slots\":[\"course\"],\"mention\":false,\"qchatTemplate\":\"{course}で一緒に走ろう\"},"
        + "{\"id\":\"time_report\",\"category\":\"race\",\"slots\":[\"time\"],\"mention\":false,\"qchatTemplate\":\"タイムアタック {time} が出た！\"}],"
        + "\"options\":{\"course\":[{\"ref\":\"aoba_turf_1600\",\"qchatValue\":\"青葉競馬場 芝1600m\"},{\"ref\":\"kirameki_turf_2000\",\"qchatValue\":\"きらめき競馬場 芝2000m\"}],\"horse\":[],\"race\":[],\"time\":[],\"cup\":[],"
        + "\"player\":[{\"ref\":\"lead\",\"qchatValue\":\"アオバ\"}]},\"usage\":{\"postsToday\":0,\"mentionsToday\":0,\"nextPostAt\":1796698800000}}";
    const string Feed = "{\"teamId\":\"tabc123456\",\"items\":["
        + "{\"seq\":3,\"at\":1796698700000,\"kind\":\"qchat\",\"playerId\":\"lead\",\"displayName\":\"アオバ\",\"mine\":false,\"qchat\":{\"phraseId\":\"nice_player\",\"category\":\"cheer\",\"mention\":true,\"mentionsMe\":true,\"anon\":false,\"qchatText\":\"シノノメさんナイス！\",\"slots\":[{\"name\":\"player\",\"ref\":\"me\",\"qchatValue\":\"シノノメ\"}],\"report\":{\"kind\":\"team_feed\",\"teamId\":\"tabc123456\",\"seq\":3}},\"reactions\":[],\"myReaction\":null},"
        + "{\"seq\":2,\"at\":1796698600000,\"kind\":\"stamp\",\"playerId\":\"lead\",\"displayName\":\"アオバ\",\"mine\":false,\"stampId\":\"cheer\",\"qchat\":null,\"reactions\":[],\"myReaction\":null},"
        + "{\"seq\":1,\"at\":1796698500000,\"kind\":\"qchat\",\"playerId\":\"\",\"displayName\":\"元メンバー\",\"mine\":false,\"qchat\":{\"phraseId\":\"otsukare\",\"category\":\"greet\",\"mention\":false,\"mentionsMe\":false,\"anon\":true,\"qchatText\":\"おつかれさま！\",\"slots\":[],\"report\":{\"kind\":\"team_feed\",\"teamId\":\"tabc123456\",\"seq\":1}},\"reactions\":[],\"myReaction\":null}],"
        + "\"nextBefore\":null,\"latestSeq\":3,\"muted\":[]}";

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset, string root)
    {
        Loc.LoadEnglish(File.ReadAllText(Path.Combine(root, "engine", "Muchi.Client", "Resources", "Muchi", "ui-en.json")));
        var s = new FakeServer();
        string postReply = "{\"teamId\":\"tabc123456\",\"seq\":4,\"at\":1796698800000,\"phraseId\":\"run_together\"}";
        int postStatus = 200;
        s.Routes["POST /v1/player/bootstrap"] = _ => new HttpResponse(200, Player);
        s.Routes["GET /v1/player"] = _ => new HttpResponse(200, Player);
        s.Routes["GET /v1/teams/me/quick-chat"] = _ => new HttpResponse(200, Picker);
        s.Routes["GET /v1/teams/me/feed"] = _ => new HttpResponse(200, Feed);
        s.Routes["POST /v1/teams/me/feed/quick-chat"] = _ => new HttpResponse(postStatus, postReply);
        s.Routes["PUT /v1/teams/me/feed/3/reaction"] = _ => new HttpResponse(200, "{\"teamId\":\"tabc123456\",\"seq\":3,\"myReaction\":\"nice\"}");
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var kv = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, ruleset);
        await b.InitializeAsync();
        long now = Now;
        var m = new QuickChatModel(b, () => now);
        var load = await m.LoadAsync();
        check(load.Ok && m.Online && m.InTeam && m.Tabs.Count == 5 && m.Tabs[0].Selected && m.Tabs[0].Label == "あいさつ", "qchat: loaded, five tabs, あいさつ first");
        check(m.Phrases.Count == 1 && m.Phrases[0].Preview == "おつかれさま！" && m.SendDisabledReason == QuickChatModel.ChooseSlotsText, "qchat: phrases of the tab; nothing selected yet");
        // rows: quick chat only, newest first, mention to me, anonymous author
        var rows = m.Rows;
        check(rows.Count == 2 && rows[0].MentionsMe && rows[0].Text == "シノノメさんナイス！" && rows[0].CanCheer && rows[0].CanMute, "qchat: rows are the phrases; a mention of me is marked");
        check(rows[1].Anon && rows[1].Name == "元メンバー" && !rows[1].CanMute && rows[1].CanReport, "qchat: a leaver's phrase is anonymous (nothing to mute)");

        // a phrase whose slot has no option is not available and says why
        m.SelectCategory("race");
        check(!m.Phrases[0].Available && m.Phrases[0].DisabledReason.Contains("タイムアタック"), "qchat: no time-attack record → the phrase says why (" + m.Phrases[0].DisabledReason + ")");
        // a single option is chosen already
        m.SelectCategory("cheer");
        m.SelectPhrase("nice_player");
        check(m.Preview == "アオバさんナイス！" && m.SendDisabledReason == null, "qchat: the only member is chosen already; preview filled");
        // two options: choose one; an unknown ref is refused
        m.SelectCategory("invite");
        m.SelectPhrase("run_together");
        check(m.Preview == "＿＿で一緒に走ろう" && m.SendDisabledReason == QuickChatModel.ChooseSlotsText, "qchat: blanks until a value is chosen");
        check(!m.Choose("course", "mars_turf_9000") && m.Choose("course", "kirameki_turf_2000") && m.Preview == "きらめき競馬場 芝2000mで一緒に走ろう", "qchat: only the server's options can be chosen");
        var sent = await m.SendAsync();
        var body = s.Sent.Last(r => r.Path == "/v1/teams/me/feed/quick-chat").Body;
        check(sent.Ok && body == "{\"phraseId\":\"run_together\",\"slots\":{\"course\":\"kirameki_turf_2000\"}}", "qchat: the post carries the phrase id and the refs only (" + body + ")");
        check(m.Rows[0].Mine && m.Rows[0].Name == "あなた" && m.Rows[0].Text == "きらめき競馬場 芝2000mで一緒に走ろう" && m.SelectedPhraseId == null, "qchat: my phrase on top; the picker resets");
        // cooldown: 15 s
        m.SelectCategory("greet"); m.SelectPhrase("otsukare");
        check(m.SendDisabledReason == "あと15秒で送れます", "qchat: local cooldown (" + m.SendDisabledReason + ")");
        now += 15_000;
        postStatus = 429; postReply = "{\"error\":{\"code\":\"RATE_LIMITED\",\"message\":\"the same phrase again\"}}";
        var limited = await m.SendAsync();
        check(!limited.Ok && m.Message == QuickChatModel.RateLimitedText, "qchat: RATE_LIMITED as a sentence");
        now += 15_000;
        postStatus = 409; postReply = "{\"error\":{\"code\":\"NOT_ELIGIBLE\",\"message\":\"x\"}}";
        m.SelectCategory("cheer"); m.SelectPhrase("nice_player");
        var ne = await m.SendAsync();
        check(!ne.Ok && m.Message == QuickChatModel.NotEligibleText, "qchat: NOT_ELIGIBLE (e.g. a block relation) without saying who");
        // cheer a teammate's phrase
        var cheer = await m.CheerAsync(3, "nice");
        check(cheer.Ok && m.Rows.First(r => r.Seq == 3).MyReaction == "nice", "qchat: cheer with a stamp");
        // the device mute hides the member's phrases at once (the server hides them both ways)
        kv.Set(TeamFeedModel.KeyMuted, "lead");
        check(m.Rows.All(r => r.PlayerId != "lead"), "qchat: the device mute hides rows at once");
        // the model's own texts: no urgency, no betting words
        var own = string.Join("", new[] { QuickChatModel.Title, QuickChatModel.Rule, QuickChatModel.NotInTeam, QuickChatModel.EmptyText, QuickChatModel.RateLimitedText, QuickChatModel.DailyLimitText, QuickChatModel.NotEligibleText, QuickChatModel.ChooseSlotsText, QuickChatModel.NoOptionsText }
            .Concat(QuickChatModel.CategoryLabels.Values).Concat(QuickChatModel.SlotLabels.Values));
        check(!own.Contains("今だけ") && !own.Contains("お得") && !own.Contains("倍") && !own.Contains("残りわずか") && !own.Contains("馬券") && !own.Contains("オッズ"), "qchat: no urgency or betting words in the model's texts");
        // every model text has English in ui-en.json (the view shows Loc.T(label))
        var missing = new[] { QuickChatModel.Title, QuickChatModel.Rule, QuickChatModel.NotInTeam, QuickChatModel.EmptyText, QuickChatModel.RateLimitedText, QuickChatModel.DailyLimitText, QuickChatModel.NotEligibleText, QuickChatModel.ChooseSlotsText, QuickChatModel.NoOptionsText, QuickChatModel.CheerRateText, QuickChatModel.ReportedText, "あと15秒で送れます" }
            .Concat(QuickChatModel.CategoryLabels.Values).Concat(QuickChatModel.SlotLabels.Values).Where(t => Loc.English.Translate(t) == null).ToList();
        check(missing.Count == 0, "qchat: every model text has English (" + string.Join(" | ", missing) + ")");
    }
}
