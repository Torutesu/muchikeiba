// 次にやること (REQ-NEXT-001..014, contracts/protocol.md §45): NextActionModel over a routed fake server. The primary card and
// chips with their texts, the deadline as a date (never a countdown), dismiss for today (server + device), the offline
// fallback from the cached list, KPI view once per game day, and no urgency words or shop cards.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class NextActionChecks
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

    const long Now = 1796698800000L; // 2026-12-08 12:00 JST (after the 04:00 switch)
    const string Player = "{\"id\":\"n\",\"wallet\":{\"paid\":0,\"free\":0,\"total\":0,\"debt\":0},\"season\":{\"id\":\"2026-12\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[],\"equipment\":{\"tack\":{},\"decor\":[]},\"deletion\":{\"status\":\"none\"}}";
    // the real server's answer (PlayerService.nextActions after 3 races and a gift expiring in 2 days)
    const string View = "{\"enabled\":true,\"day\":\"2026-12-08\",\"onboarding\":false,\"primary\":{\"kind\":\"missions_claim\",\"count\":1,\"deadlineAt\":null,\"featureKey\":null,\"refId\":null,\"screen\":\"missions\",\"dismissible\":true},\"chips\":[{\"kind\":\"gift_expiring\",\"count\":1,\"deadlineAt\":1796871600000,\"featureKey\":null,\"refId\":null,\"screen\":\"gift_box\",\"dismissible\":true},{\"kind\":\"feature_unlocked\",\"count\":null,\"deadlineAt\":null,\"featureKey\":\"missions\",\"refId\":null,\"screen\":\"feature\",\"dismissible\":true}],\"dismissed\":[],\"nextDayAt\":1796756400000}";
    const string AfterDismiss = "{\"enabled\":true,\"day\":\"2026-12-08\",\"onboarding\":false,\"primary\":{\"kind\":\"gift_expiring\",\"count\":1,\"deadlineAt\":1796871600000,\"featureKey\":null,\"refId\":null,\"screen\":\"gift_box\",\"dismissible\":true},\"chips\":[{\"kind\":\"feature_unlocked\",\"count\":null,\"deadlineAt\":null,\"featureKey\":\"missions\",\"refId\":null,\"screen\":\"feature\",\"dismissible\":true}],\"dismissed\":[\"missions_claim\"],\"nextDayAt\":1796756400000}";

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        var s = new FakeServer();
        bool down = false;
        s.Routes["POST /v1/player/bootstrap"] = _ => new HttpResponse(200, Player);
        s.Routes["GET /v1/player"] = _ => new HttpResponse(200, Player);
        s.Routes["GET /v1/home/next"] = _ => down ? new HttpResponse(503, "{\"error\":{\"code\":\"INTERNAL\",\"message\":\"x\"}}") : new HttpResponse(200, View);
        s.Routes["POST /v1/home/next/dismiss"] = _ => new HttpResponse(200, AfterDismiss);
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var kv = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, ruleset);
        await b.InitializeAsync();
        var prevRule = GameDay.Rule;
        GameDay.Use(new DayRolloverInfo { HourJst = 4, PreviousHourJst = 0, EffectiveAtMs = 1796065200000 });
        try
        {
            var events = new List<AnalyticsEvent>();
            long now = Now;
            var m = new NextActionModel(b, events.Add, () => now);
            var load = await m.LoadAsync();
            check(load.Ok && m.Online && m.Primary.Kind == "missions_claim" && m.Chips.Count == 2, "next: the server's primary card and two chips");
            check(m.Primary.Title == "ミッションの報酬を受け取れます" && m.Primary.Detail == "達成したミッション 1件" && m.Primary.CtaText == "受け取りにいく" && m.Primary.DeadlineText == null, "next: primary texts; daily things have no deadline (" + m.Primary.Detail + ")");
            check(m.Chips[0].ChipText == "プレゼント 1件" && m.Chips[0].DeadlineText == GameDay.UntilLabel(1796871600000) && m.Chips[0].DeadlineText.EndsWith("まで"), "next: the gift chip and its real deadline as a date (" + m.Chips[0].DeadlineText + ")");
            check(m.Chips[1].ChipText == "ミッション" && m.Chips[1].Screen == "feature", "next: a newly opened feature is named with the unlock titles");
            check(m.ReportViews() == 3 && m.ReportViews() == 0 && events.Count(e => e.Name == "next_card_view") == 3, "next: next_card_view once per kind and game day");
            check(m.Tap(m.Chips[0]) == "gift_box" && events.Last().Name == "next_card_tap", "next: a tap reports next_card_tap and names the screen");

            var d = await m.DismissAsync("missions_claim");
            check(d.Ok && m.Primary.Kind == "gift_expiring" && s.Sent.Any(r => r.Path == "/v1/home/next/dismiss" && r.Body.Contains("missions_claim")), "next: dismiss asks the server and shows its next list");
            check(!(await m.DismissAsync("race")).Ok && !(await m.DismissAsync("first_race")).Ok, "next: race / first_race cannot be closed");

            // offline: the cached list, minus what was closed on the device today
            down = true;
            var off = await m.LoadAsync();
            check(!off.Ok && !m.Online && m.View.FromCache && m.Primary.Kind == "gift_expiring", "next: offline uses the last list (" + m.Primary.Kind + ")");
            s.Routes["POST /v1/home/next/dismiss"] = _ => new HttpResponse(503, "{\"error\":{\"code\":\"INTERNAL\",\"message\":\"x\"}}");
            var od = await m.DismissAsync("gift_expiring");
            check(od.Ok && m.Primary.Kind == "feature_unlocked", "next: a dismiss the server could not take still closes the card on the device");
            await m.DismissAsync("feature_unlocked");
            check(m.Primary.Kind == "race" && m.Chips.Count == 0, "next: closed offline stays closed on the device (" + m.Primary.Kind + ")");
            // the next game day: yesterday's reasons are stale → only the race card
            now = 1796756400000 + 1;
            await m.LoadAsync();
            check(m.Primary.Kind == "race" && m.Primary.Title == "次の1レースへ" && !m.Primary.Dismissible, "next: another game day offline = only the race card");

            // texts: every kind has a title, a CTA and a chip label; none says 「今だけ」/「残りわずか」 or opens the shop
            var all = NextKinds.All.Select(k => NextActionModel.Row(new NextItem { Kind = k, Screen = "x", Count = 2, DeadlineAt = Now + 86_400_000, FeatureKey = "rival" }, "primary")).ToList();
            check(all.All(r => r.Title != null && r.CtaText != null && r.ChipText != null), "next: every kind has its texts");
            var text = string.Join("", all.Select(r => r.Title + r.Detail + r.CtaText + r.ChipText + r.DeadlineText));
            check(!text.Contains("今だけ") && !text.Contains("残りわずか") && !text.Contains("お得") && !text.Contains("倍") && !text.Contains("ショップ") && !text.Contains("購入"), "next: no urgency words, no shop or purchase in any card");
            check(NextKinds.ChipOnly("scout_ticket") && !NextKinds.Dismissible("race"), "next: scout_ticket is a chip only; race cannot be closed");
        }
        finally { GameDay.Use(prevRule); }
    }
}
