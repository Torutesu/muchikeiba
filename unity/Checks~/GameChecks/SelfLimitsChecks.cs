// 使いすぎ・遊びすぎの防止 (REQ-LIMIT-001..022, contracts/protocol.md §67): SelfLimitsModel over a routed fake server.
// The rows (choices, a custom amount, 上限なし, what saving would do), a lower amount at once, a raise waiting with its cancel, the
// refused purchase sentence, the play-time sheet only at safe points (never mid-race), once per mark, the KPI with rounded minutes,
// stop → home / settings → the screen, the clock kept across a restart, and English.
using System.Linq;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class SelfLimitsChecks
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

    const long Jst = 9 * 3_600_000L;
    static long At(int d, int h, int mi = 0) => new DateTimeOffset(2026, 11, d, h, mi, 0, TimeSpan.Zero).ToUnixTimeMilliseconds() - Jst;

    static string View(int? limit, string pending, int? session, int? quiet) =>
        "{\"rev\":1,\"spending\":{\"limitYen\":" + (limit?.ToString() ?? "null") + ",\"ageLimitYen\":null,\"ageBand\":\"adult\",\"effectiveLimitYen\":" + (limit?.ToString() ?? "null")
        + ",\"binding\":\"" + (limit.HasValue ? "self" : "none") + "\",\"month\":\"2026-11\",\"monthSpentYen\":0,\"remainingYen\":null,\"pending\":" + (pending ?? "null")
        + ",\"choicesYen\":[1000,3000,5000,10000,30000],\"custom\":{\"minYen\":100,\"maxYen\":1000000,\"stepYen\":100},\"coolOffHours\":72,\"statusText\":\"s\",\"pendingText\":" + (pending == null ? "null" : "\"上限なしへの変更は 11/13 12:00 から効きます（取り消せます）\"") + ",\"rulesText\":[]},"
        + "\"playtime\":{\"sessionMin\":" + (session?.ToString() ?? "null") + ",\"dailyMin\":null,\"quietAfterHour\":" + (quiet?.ToString() ?? "null") + ",\"enabled\":" + (session.HasValue || quiet.HasValue ? "true" : "false")
        + ",\"choices\":{\"sessionMin\":[30,60,90,120],\"dailyMin\":[60,120,180,240],\"quietAfterHour\":[21,22,23,0]},\"rulesText\":[]},\"history\":[]}";

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        var s = new FakeServer();
        int? limit = null; string pending = null; int? session = null; int? quiet = null;
        string Player() => "{\"id\":\"p1\",\"wallet\":{\"paid\":0,\"free\":0,\"total\":0,\"debt\":0},\"season\":{\"id\":\"2026-11\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[],\"equipment\":{\"tack\":{},\"decor\":[]},\"deletion\":{\"status\":\"none\"},"
            + "\"selfLimits\":{\"playtime\":{\"sessionMin\":" + (session?.ToString() ?? "null") + ",\"dailyMin\":null,\"quietAfterHour\":" + (quiet?.ToString() ?? "null") + ",\"enabled\":true},\"spending\":{\"limitYen\":null,\"effectiveLimitYen\":null,\"pending\":null}}}";
        s.Routes["POST /v1/player/bootstrap"] = _ => new HttpResponse(200, Player());
        s.Routes["GET /v1/player"] = _ => new HttpResponse(200, Player());
        s.Routes["GET /v1/self-limits"] = _ => new HttpResponse(200, View(limit, pending, session, quiet));
        s.Routes["PUT /v1/self-limits/spending"] = r =>
        {
            var b = Muchi.Net.JsonNode.Parse(r.Body);
            int? v = b.Get("limitYen").IsNull ? (int?)null : b.Get("limitYen").AsInt();
            string applied;
            if (v.HasValue && (!limit.HasValue || v < limit)) { limit = v; pending = null; applied = "now"; }
            else { pending = "{\"limitYen\":" + (v?.ToString() ?? "null") + ",\"requestedAt\":1,\"effectiveAt\":2}"; applied = "pending"; }
            return new HttpResponse(200, "{\"applied\":\"" + applied + "\",\"view\":" + View(limit, pending, session, quiet) + "}");
        };
        s.Routes["DELETE /v1/self-limits/spending/pending"] = _ => { pending = null; return new HttpResponse(200, "{\"applied\":\"cancelled\",\"view\":" + View(limit, pending, session, quiet) + "}"); };
        s.Routes["PUT /v1/self-limits/playtime"] = r =>
        {
            var b = Muchi.Net.JsonNode.Parse(r.Body);
            if (b.Has("sessionMin")) session = b.Get("sessionMin").IsNull ? (int?)null : b.Get("sessionMin").AsInt();
            if (b.Has("quietAfterHour")) quiet = b.Get("quietAfterHour").IsNull ? (int?)null : b.Get("quietAfterHour").AsInt();
            return new HttpResponse(200, "{\"changed\":[],\"view\":" + View(limit, pending, session, quiet) + "}");
        };
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var kv = new MemoryKeyValueStore();
        var b0 = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, ruleset);
        await b0.InitializeAsync();
        var events = new List<AnalyticsEvent>();
        long now = At(10, 20);
        var m = new SelfLimitsModel(b0, events.Add, () => now, () => "ja");

        check((await m.LoadAsync()).Ok && m.SpendingRows.Count == 6 && m.SpendingRows.Last().Label == "上限なし" && m.SpendingRows.Last().Current, "limits: five amounts + 上限なし, none set");
        check(m.SpendingRows.First().WhenText == "すぐに効きます", "limits: a first limit applies at once");
        var r = await m.SetSpendingAsync(3000);
        check(r.Ok && m.View.Spending.LimitYen == 3000 && m.SpendingRows.Single(x => x.Current).Yen == 3000, "limits: lower → now");
        check(m.SpendingRows.First(x => x.Yen == 10000).WhenText == "72時間後に効きます" && m.SpendingRows.First(x => x.Yen == 1000).WhenText == "すぐに効きます", "limits: a raise says it waits 72 h, a lower amount says at once");
        check(!(await m.SetSpendingAsync(2550)).Ok && s.Sent.Count(x => x.Method == "PUT") == 1, "limits: an amount off the step is refused on the device (not sent)");
        check((await m.SetSpendingAsync(2500)).Ok && m.SpendingRows.Any(x => x.Yen == 2500 && x.Current), "limits: a custom amount shows as its own row");
        r = await m.SetSpendingAsync(null);
        check(r.Ok && m.CanCancelRaise && r.Message.Contains("取り消せます"), "limits: 上限なし waits (the pending text)");
        check((await m.CancelRaiseAsync()).Ok && !m.CanCancelRaise, "limits: cancel the waiting change");
        var ex = (SelfLimitExceededException)ApiErrorCodes.Create("SELF_LIMIT_EXCEEDED", "x", 409, Muchi.Net.JsonNode.Parse("{\"selfLimitYen\":3000,\"monthSpentYen\":2400,\"priceYen\":800,\"month\":\"2026-11\",\"settings\":\"self_limits\"}"));
        check(SelfLimitsModel.RefusedText(ex) == "自分で決めた今月の上限（¥3,000）を超えるため、購入できません" && UxText.For(ex).Contains("上限の設定"), "limits: the refused purchase sentence and the link");
        check(!SelfLimitsModel.RefusedText(ex).Contains("上げ"), "limits: the refusal never suggests raising the limit");

        // play-time: off → nothing; set a 30-minute session and 22:00
        m.OnForeground();
        now += 40 * 60_000L;
        check(m.AtPlace(PlaytimePlaces.RaceResult) == null, "playtime: off by default → no sheet");
        check((await m.SetPlaytimeAsync(new PlaytimeSettings { SessionMin = 30 }, true, false, false)).Ok && m.SessionRows.Single(x => x.Current).Value == 30 && m.QuietRows.First().Label == "使わない", "playtime: settings rows");
        check(m.AtPlace(PlaytimePlaces.Race) == null && !m.SheetVisible, "playtime: never mid-race");
        check(m.AtPlace(PlaytimePlaces.Matchmaking) == null && m.AtPlace(PlaytimePlaces.Purchase) == null, "playtime: never in matchmaking or a purchase");
        var d = m.AtPlace(PlaytimePlaces.RaceResult);
        check(d != null && m.SheetVisible && d.Lines.SequenceEqual(new[] { "遊びはじめて30分たちました" }) && d.Buttons.Continue == "続ける" && d.Buttons.Stop == "今日はここまで", "playtime: after the race result, one calm sheet");
        check(m.Answer("continue") == null && !m.SheetVisible && events.Last().Name == "playtime_reminder_shown" && events.Last().PropsJson.Contains("\"sessionMin\":40") && events.Last().PropsJson.Contains("\"choice\":\"continue\""), "playtime: continue → KPI with rounded minutes");
        check(m.AtPlace(PlaytimePlaces.Home) == null, "playtime: once per mark");
        // restart: the clock is kept (no time counted while closed); 60 min → the next mark
        m.OnBackground();
        var m2 = new SelfLimitsModel(b0, events.Add, () => now, () => "ja");
        await m2.LoadAsync();
        m2.OnForeground();
        check(m2.Clock.SessionMinutes == 40, "playtime: the clock survives a restart within 30 minutes (" + m2.Clock.SessionMinutes + ")");
        now += 25 * 60_000L;
        d = m2.AtPlace(PlaytimePlaces.Home);
        check(d != null && d.Lines[0] == "遊びはじめて60分たちました" && m2.Answer("stop") == "home", "playtime: the next mark on the home; stop → home");
        // English and the quiet-after hour
        await m2.SetPlaytimeAsync(new PlaytimeSettings { QuietAfterHour = 22 }, false, false, true);
        var en = new SelfLimitsModel(b0, events.Add, () => At(10, 22, 30), () => "en");
        await en.LoadAsync();
        en.OnForeground();
        d = en.AtPlace(PlaytimePlaces.RaceResult);
        check(d != null && d.Title == "Time for a short break?" && d.Lines[0] == "It is past 10 p.m." && en.Answer("settings") == "self_limits", "playtime: English sheet, settings → the screen");
        Loc.SetLocale("en");
        try
        {
            check(Loc.T(SelfLimitsModel.Title) == "Limits on spending and play time" && Loc.T("72時間後に効きます") == "Takes effect in 72 hours"
                && Loc.T(SelfLimitsModel.RefusedText(ex)) == "This would go over the monthly limit you set (¥3,000), so it cannot be bought", "limits: English labels and the refusal");
        }
        finally { Loc.SetLocale("ja"); }
    }
}
