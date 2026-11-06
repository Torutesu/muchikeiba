// Rewarded ads, game layer (REQ-AD-001..012, contracts/protocol.md §18): RewardedAdModel over a routed fake server and a
// fake IAdProvider. Where cards may appear (never tutorial / race / a result after 4th or worse / offline / not ready),
// one view at a time, the reward only from the server's session status (SSV), KPI ad_offer_view / ad_start.
using Muchi.Client;
using Muchi.Game;

static class RewardedAdChecks
{
    sealed class FakeServer : IHttp
    {
        public readonly List<HttpRequest> Sent = new List<HttpRequest>();
        public readonly Dictionary<string, Func<HttpRequest, HttpResponse>> Routes = new Dictionary<string, Func<HttpRequest, HttpResponse>>();
        public Task<HttpResponse> SendAsync(HttpRequest r, CancellationToken ct)
        {
            Sent.Add(r);
            if (Routes.TryGetValue(r.Method + " " + r.Path, out var h)) return Task.FromResult(h(r));
            return Task.FromResult(new HttpResponse(404, "{\"error\":{\"code\":\"NOT_FOUND\"}}"));
        }
        public int Count(string method, string path) => Sent.Count(r => r.Method == method && r.Path == path);
    }

    sealed class FakeAds : IAdProvider
    {
        public bool Ready = true;
        public AdShowOutcome Outcome = AdShowOutcome.Shown;
        public AdShowRequest Last;
        public int Shows, Preloads;
        public Action OnShow;
        public bool IsReady(string key) => Ready;
        public void Preload(string key, bool npa, bool tfua) => Preloads++;
        public Task<AdShowOutcome> ShowAsync(AdShowRequest r, CancellationToken ct) { Shows++; Last = r; OnShow?.Invoke(); return Task.FromResult(Outcome); }
    }
    sealed class NoDelay : IDelay { public int Waits; public Task Delay(int ms, CancellationToken ct) { Waits++; return Task.CompletedTask; } }
    sealed class Tokens : IAuthTokenProvider { public Task<string> GetTokenAsync(bool f, CancellationToken ct) => Task.FromResult("tok"); }
    sealed class Consent : IAdConsent { public bool Allow; public int Asked; public Task<bool> PersonalizedAllowedAsync(CancellationToken ct) { Asked++; return Task.FromResult(Allow); } }

    static string View(bool eligible = true, string reason = null, int homeLeft = 1, bool npa = true) =>
        "{\"enabled\":true,\"eligible\":" + (eligible ? "true" : "false") + ",\"reason\":" + (reason == null ? "null" : "\"" + reason + "\"") + ",\"pref\":\"auto\",\"payerQuietUntil\":null,"
        + "\"day\":\"2026-12-11\",\"globalCap\":3,\"globalUsed\":0,\"globalLeft\":3,\"startsLeft\":12,\"network\":\"admob\",\"placements\":["
        + "{\"id\":\"daily_coins\",\"surface\":\"home\",\"title\":\"動画を見て、無償コインを受け取る\",\"rewardLabel\":\"無償コイン10枚\",\"reward\":{\"freeCoins\":10},\"dailyCap\":1,\"used\":" + (1 - homeLeft) + ",\"left\":" + homeLeft + ",\"adUnitKey\":\"REWARDED_HOME\",\"available\":" + (eligible && homeLeft > 0 ? "true" : "false") + "},"
        + "{\"id\":\"result_coins\",\"surface\":\"result\",\"title\":\"動画を見て、もう少しコインを\",\"rewardLabel\":\"無償コイン10枚\",\"reward\":{\"freeCoins\":10},\"dailyCap\":1,\"used\":0,\"left\":1,\"adUnitKey\":\"REWARDED_RESULT\",\"available\":" + (eligible ? "true" : "false") + "},"
        + "{\"id\":\"ta_attempt\",\"surface\":\"time_attack\",\"title\":\"動画を見て、タイムアタックをもう1回\",\"rewardLabel\":\"タイムアタック1回\",\"reward\":{\"taAttempts\":1},\"dailyCap\":1,\"used\":0,\"left\":1,\"adUnitKey\":\"REWARDED_TA\",\"available\":" + (eligible ? "true" : "false") + "}],"
        + "\"adRequest\":{\"nonPersonalized\":" + (npa ? "true" : "false") + ",\"underAgeOfConsent\":false,\"ageKnown\":" + (npa ? "false" : "true") + "},\"open\":[]}";
    const string Start = "{\"sessionId\":\"ad_0123456789abcdef\",\"placementId\":\"daily_coins\",\"network\":\"admob\",\"adUnitKey\":\"REWARDED_HOME\",\"customData\":\"ad_0123456789abcdef\",\"userId\":\"p1\",\"expiresAt\":1,\"rewardLabel\":\"無償コイン10枚\",\"adRequest\":{\"nonPersonalized\":false,\"underAgeOfConsent\":false,\"ageKnown\":true}}";
    static string Session(string status) => "{\"sessionId\":\"ad_0123456789abcdef\",\"placementId\":\"daily_coins\",\"status\":\"" + status + "\",\"expiresAt\":1,"
        + (status == "rewarded" ? "\"reward\":{\"freeCoins\":10},\"rewardLabel\":\"無償コイン10枚\"" : "\"reward\":null,\"rewardLabel\":null") + ",\"reason\":null,\"wallet\":{\"paid\":0,\"free\":110,\"total\":110,\"debt\":0}}";

    static (ApiClient api, FakeServer srv) Client()
    {
        var srv = new FakeServer();
        var opt = new ApiClientOptions { BaseUrl = "https://api.test" };
        opt.Retry.MaxRetries = 0;
        return (new ApiClient(srv, new Tokens(), opt), srv);
    }
    static (AnalyticsClient client, List<AnalyticsEvent> sent) Analytics()
    {
        var sent = new List<AnalyticsEvent>();
        return (new AnalyticsClient((p, v, ev, ct) => { sent.AddRange(ev); return Task.FromResult(new AnalyticsIngestResult { Accepted = ev.Count }); }, new AnalyticsOptions()), sent);
    }

    public static async Task Run(Action<bool, string> check)
    {
        var (api, srv) = Client();
        var ads = new FakeAds();
        var (an, sent) = Analytics();
        var delay = new NoDelay();
        var consent = new Consent { Allow = false };
        var model = new RewardedAdModel(api, ads, an, consent, delay, () => 1_796_000_000_000);
        srv.Routes["GET /v1/ads"] = _ => new HttpResponse(200, View());
        await model.RefreshAsync();
        check(ads.Preloads == 3, "refresh preloads the ads that may be offered");

        // where a card may appear
        var home = model.OfferFor(AdContext.Home);
        check(home != null && home.PlacementId == "daily_coins" && home.RewardLabel == "無償コイン10枚" && home.LeftLabel == "今日あと1回", "home: the server's card (fixed amount, today's remaining)");
        check(!(home.Title + home.RewardLabel + home.Footnote + home.ButtonLabel).Contains("倍"), "no 「倍」 wording anywhere on the card");
        check(model.OfferFor(AdContext.Tutorial) == null && model.OfferFor(AdContext.Race) == null && model.OfferFor(AdContext.Other) == null, "never in the tutorial, matching / race, or other screens");
        check(model.OfferFor(AdContext.Result, lastPlace: 4) == null && model.OfferFor(AdContext.Result) == null, "never on a result screen after 4th or worse (06 §5.1)");
        check(model.OfferFor(AdContext.Result, lastPlace: 2)?.PlacementId == "result_coins", "result card after a top-3 finish");
        check(model.OfferFor(AdContext.TimeAttack)?.RewardLabel == "タイムアタック1回", "time attack card: one more attempt");
        check(model.OfferFor(AdContext.Home, online: false) == null, "offline: no card");
        ads.Ready = false;
        check(model.OfferFor(AdContext.Home) == null, "no card until the SDK has an ad ready (no visible loading wait)");
        ads.Ready = true;

        // KPI: offer view once per screen visit
        model.OnScreenEntered();
        model.NoteOfferShown(home); model.NoteOfferShown(home);
        model.OnScreenEntered();
        model.NoteOfferShown(home);

        // watch: shown → server rewarded after one pending poll
        srv.Routes["POST /v1/ads/daily_coins/start"] = _ => new HttpResponse(200, Start);
        int polls = 0;
        srv.Routes["GET /v1/ads/sessions/ad_0123456789abcdef"] = _ => new HttpResponse(200, Session(++polls < 2 ? "open" : "rewarded"));
        bool busyDuringShow = false;
        ads.OnShow = () => busyDuringShow = model.Busy && model.OfferFor(AdContext.Home) == null;
        var r = await model.WatchAsync(home, AdContext.Home);
        check(r.Status == AdWatchStatus.Rewarded && r.Message == "受け取りました：無償コイン10枚" && r.Wallet.Free == 110, "shown → the reward the server granted (SSV), with the wallet");
        check(ads.Last.CustomData == "ad_0123456789abcdef" && ads.Last.UserId == "p1" && ads.Last.AdUnitKey == "REWARDED_HOME", "SSV options: customData = session id, userId = player id");
        check(consent.Asked == 1 && ads.Last.NonPersonalized, "consent hook asked (ATT declined → non-personalised request)");
        check(busyDuringShow, "one view at a time: no other card while an ad is showing");
        check(polls == 2 && delay.Waits == 1, "polls the session until the server reports it");
        check(srv.Count("POST", "/v1/ads/daily_coins/start") == 1 && srv.Sent.Find(x => x.Path == "/v1/ads/daily_coins/start").Headers.ContainsKey("idempotency-key"), "one keyed start per tap");

        // the wrong screen cannot start a view
        check((await model.WatchAsync(home, AdContext.Race)).Status == AdWatchStatus.NotAllowed, "a card cannot be played from a race / another surface");

        // closed early, no fill, limit reached, rejected, slow callback
        ads.Outcome = AdShowOutcome.ClosedEarly;
        var r2 = await model.WatchAsync(home, AdContext.Home);
        check(r2.Status == AdWatchStatus.NotCompleted && r2.Message == "最後まで見ると受け取れます。", "closed early: nothing, and the reason");
        ads.Outcome = AdShowOutcome.NoFill;
        check((await model.WatchAsync(home, AdContext.Home)).Status == AdWatchStatus.Unavailable, "no fill: 今は動画を用意できません");
        ads.Outcome = AdShowOutcome.Shown;
        srv.Routes["GET /v1/ads/sessions/ad_0123456789abcdef"] = _ => new HttpResponse(200, Session("rejected"));
        check((await model.WatchAsync(home, AdContext.Home)).Status == AdWatchStatus.Rejected, "rejected by the server: no reward shown");
        srv.Routes["GET /v1/ads/sessions/ad_0123456789abcdef"] = _ => new HttpResponse(200, Session("open"));
        var slow = await model.WatchAsync(home, AdContext.Home);
        check(slow.Status == AdWatchStatus.Pending && slow.Message.Contains("届きしだい"), "slow callback: pending, reflected when it lands");
        srv.Routes["POST /v1/ads/daily_coins/start"] = _ => new HttpResponse(409, "{\"error\":{\"code\":\"AD_LIMIT_REACHED\",\"message\":\"x\"}}");
        srv.Routes["GET /v1/ads"] = _ => new HttpResponse(200, View(homeLeft: 0));
        var lim = await model.WatchAsync(home, AdContext.Home);
        check(lim.Status == AdWatchStatus.LimitReached && model.OfferFor(AdContext.Home) == null, "limit reached → card gone until tomorrow");

        // not eligible (FTUE / payer quiet) → no cards at all
        srv.Routes["GET /v1/ads"] = _ => new HttpResponse(200, View(eligible: false, reason: "payer_quiet"));
        await model.RefreshAsync();
        check(model.OfferFor(AdContext.Home) == null && model.OfferFor(AdContext.TimeAttack) == null, "not eligible (paid in the last 30 days) → no cards");
        check(RewardedAdModel.PreferenceLabel(model.View).Contains("30日"), "settings line explains the 30-day quiet period");

        await an.FlushAllAsync(1_796_000_001_000);
        check(sent.Count(e => e.Name == "ad_offer_view") == 2, "ad_offer_view once per card per screen visit");
        var starts = sent.Where(e => e.Name == "ad_start").ToList();
        check(starts.Count == 5, "ad_start for every SDK answer (shown, closed early, no fill, shown, shown)");
        check(!sent.Any(e => e.Name == "ad_reward"), "the reward is never a client event (server ad_reward from SSV)");
    }
}
