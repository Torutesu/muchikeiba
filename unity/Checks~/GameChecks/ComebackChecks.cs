// Returning players (REQ-CB-001..012): ComebackModel (welcome once, login track, missions, catch-up meter, real end date,
// deletion-pending block, keyed claims, one-time push opt-in) and WhatsNewModel (one-time home card). Routed fake server.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class ComebackChecks
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

    const string PlayerJson = "{\"id\":\"c\",\"wallet\":{\"paid\":0,\"free\":500,\"total\":500,\"debt\":0},\"season\":{\"id\":\"2026-11\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[],\"equipment\":{\"tack\":{},\"decor\":[]}}";
    const string PlayerDeleting = "{\"id\":\"c\",\"wallet\":{\"paid\":0,\"free\":500,\"total\":500,\"debt\":0},\"season\":{\"id\":\"2026-11\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[],\"equipment\":{\"tack\":{},\"decor\":[]},\"deletion\":{\"status\":\"scheduled\",\"requestedAt\":1,\"deleteAt\":1796482800000}}";
    // 2026-11-10 .. 11-23 (exclusive end 11-24 00:00 JST)
    static string Window(int claimed, bool claimable, bool blocked = false, bool welcome = true, int missionProgress = 0) =>
        "{\"id\":\"cb1_20261110\",\"tier\":\"short\",\"lapseDays\":7,\"startDay\":\"2026-11-10\",\"endDay\":\"2026-11-23\",\"endsAt\":1795446000000,"
        + "\"remainingDays\":14,\"day\":1,\"days\":14,\"showWelcome\":" + (welcome ? "true" : "false") + ",\"completed\":false,\"blocked\":" + (blocked ? "true" : "false") + ","
        + "\"login\":{\"claimed\":" + claimed + ",\"total\":7,\"claimableToday\":" + (claimable ? "true" : "false") + ",\"days\":["
        + "{\"day\":1,\"reward\":{\"freeCoins\":100},\"claimed\":" + (claimed >= 1 ? "true" : "false") + "},"
        + "{\"day\":2,\"reward\":{\"items\":[{\"itemId\":\"gacha_ticket\",\"qty\":1}]},\"claimed\":false}]},"
        + "\"missions\":[{\"id\":\"cb_race\",\"kind\":\"races\",\"feature\":\"skills\",\"title\":\"まずは1レース\",\"guide\":\"固有スキルが加わりました\",\"target\":1,\"progress\":" + missionProgress + ",\"reward\":{\"freeCoins\":50},\"claimed\":false,\"claimable\":" + (missionProgress >= 1 && !blocked ? "true" : "false") + "}],"
        + "\"catchUp\":{\"seasonId\":\"2026-11\",\"targetXp\":600,\"capXp\":500,\"grantedXp\":100,\"remainingXp\":400,\"bonusPerRace\":20,\"active\":" + (blocked ? "false" : "true") + "}}";

    static HttpResponse Ok(string body) => new HttpResponse(200, body);

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        var s = new FakeServer();
        string player = PlayerJson;
        s.Routes["POST /v1/player/bootstrap"] = _ => Ok(player);
        s.Routes["GET /v1/player"] = _ => Ok(player);
        string comeback = "{\"active\":true,\"push\":{\"category\":\"comeback\",\"enabled\":false},\"window\":" + Window(0, true) + "}";
        s.Routes["GET /v1/comeback"] = _ => Ok(comeback);
        int loginCalls = 0;
        s.Routes["POST /v1/comeback/login"] = _ => ++loginCalls == 1
            ? new HttpResponse(503, "{\"error\":{\"code\":\"INTERNAL\",\"message\":\"x\"}}")
            : Ok("{\"day\":1,\"reward\":{\"freeCoins\":100},\"window\":" + Window(1, false, false, true, 1) + "}");
        s.Routes["POST /v1/comeback/missions/cb_race/claim"] = _ => Ok("{\"missionId\":\"cb_race\",\"reward\":{\"freeCoins\":50},\"window\":" + Window(1, false) + "}");
        s.Routes["POST /v1/comeback/welcome"] = _ => Ok("{\"windowId\":\"cb1_20261110\",\"welcomedAt\":5}");
        s.Routes["PUT /v1/push/preferences"] = r => Ok("{\"categories\":{\"season\":true,\"friends\":true,\"invites\":true,\"events\":true,\"comeback\":" + (r.Body.Contains("\"comeback\":true") ? "true" : "false") + "},\"quietHours\":null,\"dailyCap\":2,\"devices\":1,\"topics\":{\"subscribe\":[],\"unsubscribe\":[]}}");
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var kv = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, ruleset);
        await b.InitializeAsync();

        long now = 1794279600000; // 2026-11-10 12:00 JST
        var m = new ComebackModel(b, () => now);
        await m.LoadAsync();
        check(m.Active && m.ShowWelcome, "comeback: a running window shows the welcome screen");
        check(m.WelcomeBody == "7日ぶりのご来場です。11月23日まで、復帰キャンペーンを用意しました", "comeback: welcome text uses the lapse and the real last day (" + m.WelcomeBody + ")");
        check(m.EndText == "11月23日まで" && m.RemainingText == "残り14日", "comeback: end shown as a date and game days left (no countdown timer)");
        check(m.Days.Count == 2 && m.Days[0].Today && !m.Days[1].Today && m.Days[0].RewardText == "無償コイン100枚", "comeback: login track cells, today's cell carries the claim");
        check(m.Missions.Count == 1 && m.Missions[0].Feature == "skills" && m.Missions[0].ProgressText == "0/1" && !m.Missions[0].Claimable, "comeback: mission row links to the feature it re-teaches");
        check(m.CatchUpText == "パスXP上乗せ中：1レースごとに +20（残り 400）" && Math.Abs(m.CatchUpProgress - 0.2f) < 1e-4, "comeback: catch-up meter");
        check(!(m.WelcomeBody + m.CatchUpText + m.LoginProgressText).Contains("倍"), "comeback: no '◯倍' wording");
        await m.MarkWelcomedAsync();
        check(!m.ShowWelcome && s.Sent.Any(r => r.Path == "/v1/comeback/welcome"), "comeback: the welcome is marked shown once");

        var first = await m.ClaimLoginAsync();
        string kept = kv.Get(ComebackModel.KeyPendingLogin);
        check(!first.Ok && !string.IsNullOrEmpty(kept), "comeback: a 5xx keeps the login claim's idempotency key");
        var second = await m.ClaimLoginAsync();
        var keys = s.Sent.Where(r => r.Path == "/v1/comeback/login").Select(r => r.Headers["idempotency-key"]).ToList();
        check(second.Ok && keys.Count == 2 && keys[0] == keys[1], "comeback: the retry reuses the key (never pays twice)");
        check(m.Toast == "復帰ログインボーナス 1日目：無償コイン100枚" && !m.CanClaimLogin && m.Days[0].Claimed, "comeback: toast and the track update from the claim's window");
        check(m.Missions[0].Claimable, "comeback: progress from the claim's window makes the mission claimable");
        var mc = await m.ClaimMissionAsync("cb_race");
        check(mc.Ok && m.Toast.StartsWith("まずは1レース：") && !m.Missions[0].Claimable, "comeback: mission claimed");
        check(!(await m.ClaimMissionAsync("nope")).Ok, "comeback: unknown / not claimable mission is refused locally");

        check(m.ShowPushOptIn, "comeback: the lapse-reminder opt-in is offered (category off by default)");
        await m.AnswerPushOptInAsync(true);
        var put = s.Sent.Last(r => r.Path == "/v1/push/preferences");
        check(put.Body.Contains("\"comeback\":true") && !m.ShowPushOptIn && m.View.PushEnabled, "comeback: yes turns the comeback category on, asked once");
        var m2 = new ComebackModel(b, () => now);
        comeback = "{\"active\":true,\"push\":{\"category\":\"comeback\",\"enabled\":false},\"window\":" + Window(1, false, false, false) + "}";
        await m2.LoadAsync();
        check(!m2.ShowPushOptIn, "comeback: the opt-in is not asked again on this device (even after a 'no' elsewhere)");

        // deletion pending: no claim buttons, the guard banner instead
        player = PlayerDeleting;
        await b.RefreshAsync();
        comeback = "{\"active\":true,\"push\":{\"category\":\"comeback\",\"enabled\":false},\"window\":" + Window(1, true, true, false, 1) + "}";
        var m3 = new ComebackModel(b, () => now);
        await m3.LoadAsync();
        check(m3.Blocked && !m3.CanClaimLogin && m3.Days.All(d => !d.Today) && m3.Missions.All(x => !x.Claimable), "comeback: deletion pending → nothing claimable");
        check(m3.BlockedText != null && m3.BlockedText.StartsWith("アカウント削除の予定があります"), "comeback: deletion banner text");
        int before = s.Sent.Count;
        check(!(await m3.ClaimLoginAsync()).Ok && s.Sent.Count == before, "comeback: blocked claim is not sent");

        comeback = "{\"active\":false,\"window\":null,\"push\":{\"category\":\"comeback\",\"enabled\":true}}";
        var none = new ComebackModel(b, () => now);
        await none.LoadAsync();
        check(!none.Active && none.Days.Count == 0 && none.WelcomeBody == null && !none.ShowPushOptIn, "comeback: no window → nothing shown");

        var off = new GameBackend(new GameSettings { OfflineOnly = true }, null, null, new MemoryKeyValueStore(), ruleset);
        await off.InitializeAsync();
        var mo = new ComebackModel(off);
        var ro = await mo.LoadAsync();
        check(!ro.Ok && !mo.Active, "comeback: offline → inactive with a notice");

        // ---------------------------------------------------------------- what's new
        s.Routes["GET /v1/whats-new"] = _ => Ok("{\"since\":1,\"upTo\":1795316400000,\"showCard\":true,\"more\":2,\"items\":["
            + "{\"id\":\"banner_pickup_ginga\",\"kind\":\"banner\",\"title\":\"ピックアップ：ギンガノカナタ\",\"body\":\"新しいスカウトが始まりました\",\"at\":1793458800000,\"feature\":\"scout\",\"bannerId\":\"pickup_ginga\",\"eventId\":null,\"endsAt\":1796050800000},"
            + "{\"id\":\"skills_v1\",\"kind\":\"feature\",\"title\":\"固有スキル\",\"body\":\"…\",\"at\":1793458800000,\"feature\":\"skills\",\"bannerId\":null,\"eventId\":null,\"endsAt\":null}]}");
        int seenCalls = 0;
        s.Routes["POST /v1/whats-new/seen"] = _ => ++seenCalls == 1 ? new HttpResponse(503, "{\"error\":{\"code\":\"INTERNAL\",\"message\":\"x\"}}") : Ok("{\"seenUpTo\":1795316400000}");
        player = PlayerJson;
        await b.RefreshAsync();
        var wn = new WhatsNewModel(b);
        await wn.LoadAsync();
        check(wn.ShowCard && wn.Lines.Count == 2 && wn.MoreText == "ほか2件", "what's new: card with lines and the remaining count");
        check(wn.Lines[0].Label == "スカウト" && wn.Lines[0].EndText == "11月30日まで" && wn.Lines[1].Label == "新機能" && wn.Lines[1].EndText == null, "what's new: labels by kind, real end dates only for banners/events");
        await wn.DismissAsync();
        check(!wn.ShowCard && kv.Get(WhatsNewModel.KeySeenUpTo) == "1795316400000", "what's new: dismissed (position kept on the device)");
        var wn2 = new WhatsNewModel(b);
        await wn2.LoadAsync();
        check(!wn2.ShowCard, "what's new: the failed server mark never shows the same card twice");
        var wo = new WhatsNewModel(off);
        await wo.LoadAsync();
        check(!wo.ShowCard, "what's new: nothing offline");
    }
}
