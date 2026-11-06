// マイ厩舎 view model (REQ-STABLE-*): layout editing with the server's rules, visiting, likes (caps, no coins) and the
// empty / loading / error / offline states. A routed fake server stands in for the API; no network.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class StableChecks
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

    const string Horses = "[{\"id\":\"h1\",\"name\":\"アカツキ\",\"rarity\":\"SR\",\"sex\":\"female\",\"status\":\"active\",\"named\":true},"
        + "{\"id\":\"h2\",\"name\":\"クロガネ\",\"rarity\":\"SR\",\"sex\":\"male\",\"status\":\"active\",\"named\":true},"
        + "{\"id\":\"h3\",\"name\":\"ナツ\",\"rarity\":\"R\",\"sex\":\"male\",\"status\":\"retired\",\"named\":true}]";
    const string PlayerJson = "{\"id\":\"me\",\"wallet\":{\"paid\":0,\"free\":500,\"total\":500,\"debt\":0},\"season\":{\"id\":\"2026-11\",\"classId\":\"C\",\"points\":0},\"profile\":{\"displayName\":\"騎手M\",\"titleId\":null},\"items\":{},\"horses\":" + Horses + ",\"equipment\":{\"tack\":{},\"decor\":[]}}";
    const string Themes = "\"themes\":[{\"id\":\"standard\",\"name\":\"いつもの厩舎\",\"key\":\"stable/theme/standard\",\"slots\":3,\"unlocked\":true,\"unlockLikes\":null,\"unlockItem\":null},"
        + "{\"id\":\"cedar\",\"name\":\"杉板の厩舎\",\"key\":\"stable/theme/cedar\",\"slots\":4,\"unlocked\":false,\"unlockLikes\":10,\"unlockItem\":null}]";
    const string Decor = "\"decor\":[{\"itemId\":\"decor_flower_box\",\"name\":\"花のプランター\",\"key\":\"decor/flower_box\",\"owned\":true,\"price\":200,\"currency\":\"any\"},"
        + "{\"itemId\":\"decor_golden_horseshoe\",\"name\":\"金の蹄鉄\",\"key\":\"decor/golden_horseshoe\",\"owned\":true,\"price\":1000,\"currency\":\"paidOnly\"},"
        + "{\"itemId\":\"decor_trophy_shelf\",\"name\":\"トロフィー棚\",\"key\":\"decor/trophy_shelf\",\"owned\":false,\"price\":500,\"currency\":\"any\"}]";
    const string Snapshot = "{\"v\":1,\"playerId\":\"f\",\"displayName\":\"騎手F\",\"titleId\":null,\"classId\":\"C\",\"name\":\"ほしぞら厩舎\","
        + "\"theme\":{\"id\":\"standard\",\"name\":\"いつもの厩舎\",\"key\":\"stable/theme/standard\"},\"slots\":[{\"itemId\":\"decor_flower_box\",\"name\":\"花のプランター\",\"key\":\"decor/flower_box\"},null,null],"
        + "\"horses\":[],\"autoHorses\":true,\"trophies\":{\"titleIds\":[],\"races\":0,\"wins\":0,\"top3\":0,\"tournamentWins\":0,\"tournamentPodiums\":0},\"likes\":4,\"updatedAt\":1}";

    static HttpResponse Ok(string body) => new HttpResponse(200, body);
    static HttpResponse Err(int status, string code) => new HttpResponse(status, "{\"error\":{\"code\":\"" + code + "\",\"message\":\"" + code + "\"}}");

    static string Mine(bool saved, string layout) => "{\"saved\":" + (saved ? "true" : "false") + ",\"layout\":" + layout + "," + Themes + "," + Decor
        + ",\"featuredMax\":2,\"nameMaxChars\":12,\"likes\":{\"received\":3,\"givenToday\":0,\"perDay\":5,\"perTargetPerDay\":1},\"preview\":null,\"notice\":\"いいねにコインは付きません\"}";

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        var s = new FakeServer();
        s.Routes["POST /v1/player/bootstrap"] = _ => Ok(PlayerJson);
        s.Routes["GET /v1/player"] = _ => Ok(PlayerJson);
        int mineCalls = 0;
        s.Routes["GET /v1/stable"] = _ => ++mineCalls == 1 ? Err(503, "INTERNAL") : Ok(Mine(false, "{\"theme\":\"standard\",\"name\":null,\"slots\":[\"decor_flower_box\"],\"featuredHorseIds\":[],\"updatedAt\":null}"));
        string savedBody = null;
        s.Routes["PUT /v1/stable"] = r => { savedBody = r.Body; return Ok("{\"layout\":{\"theme\":\"standard\",\"name\":\"ほしぞら厩舎\",\"slots\":[\"decor_golden_horseshoe\",\"decor_flower_box\"],\"featuredHorseIds\":[\"h2\"],\"updatedAt\":9},\"snapshot\":" + Snapshot.Replace("\"f\"", "\"me\"") + "}"); };
        s.Routes["GET /v1/stable/visits"] = _ => Ok("{\"friends\":[{\"playerId\":\"f\",\"displayName\":\"騎手F\",\"titleId\":null,\"name\":\"ほしぞら厩舎\",\"themeKey\":\"stable/theme/standard\",\"likes\":4,\"decorCount\":1,\"horseCount\":0,\"updatedAt\":1}],\"recommended\":[]}");
        s.Routes["GET /v1/stable/f"] = _ => Ok("{\"stable\":" + Snapshot + ",\"viewer\":{\"relation\":\"friend\",\"likedToday\":0,\"likesLeftToday\":5,\"canLike\":true}}");
        s.Routes["GET /v1/stable/x"] = _ => Ok("{\"stable\":" + Snapshot.Replace("\"f\"", "\"x\"") + ",\"viewer\":{\"relation\":\"other\",\"likedToday\":0,\"likesLeftToday\":4,\"canLike\":true}}");
        s.Routes["GET /v1/stable/ghost"] = _ => Err(404, "NOT_FOUND");
        int likeCalls = 0;
        s.Routes["POST /v1/stable/f/like"] = _ => ++likeCalls == 1 ? Err(503, "INTERNAL") : Ok("{\"playerId\":\"f\",\"likes\":5,\"remainingToday\":4}");
        s.Routes["POST /v1/stable/x/like"] = _ => Err(409, "LIKE_LIMIT");
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var kv = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, ruleset);
        await b.InitializeAsync();

        var m = new StableModel(b, kv);
        check(m.State == StableLoad.Idle, "stable: idle before loading");
        await m.LoadAsync();
        check(m.State == StableLoad.Error && m.Message != null, "stable: a server error shows the error state");
        await m.LoadAsync();
        check(m.State == StableLoad.Empty && m.Online && m.Draft.Slots.Count == 3 && m.Draft.Slots[0] == "decor_flower_box", "stable: never saved → empty state with the equipped decor in a 3-slot room");
        check(m.PlateName == "騎手Mの厩舎", "stable: default plate name from the display name");
        check(m.Palette.Count == 1 && m.Palette[0].ItemId == "decor_golden_horseshoe" && m.ShopDecor.Count == 1, "stable: palette = owned, unplaced decor; unowned decor links to the shop");
        check(!m.Place(1, "decor_trophy_shelf").Ok && !m.Place(9, "decor_flower_box").Ok && !m.Place(0, "tack_bridle_gold").Ok, "stable: unowned decor, a missing slot and non-decor are refused");
        check(!m.SelectTheme("cedar").Ok && m.Draft.Theme == "standard" && StableModel.LockedLabel(m.Mine.Themes[1]) == "いいね 10 で解放", "stable: locked theme refused with its unlock condition");
        check(m.Place(0, "decor_golden_horseshoe").Ok && m.Place(1, "decor_flower_box").Ok, "stable: place decor");
        check(m.Draft.Slots[0] == "decor_golden_horseshoe" && m.Draft.Slots[1] == "decor_flower_box" && m.Draft.Slots[2] == null, "stable: placing an item moves it (no duplicates)");
        check(m.ToggleFeatured("h1").Ok && m.ToggleFeatured("h2").Ok && m.ToggleFeatured("h1").Ok && m.Draft.FeaturedHorseIds.SequenceEqual(new[] { "h2" }), "stable: featured horses toggle on and off");
        check(!m.ToggleFeatured("h3").Ok, "stable: retired horses cannot stand in the 馬房");
        m.SetName("あ".PadRight(13, 'あ'));
        check(m.Validate().Any(p => p.Contains("表札")) && !m.CanSave, "stable: a too-long plate name is caught before sending");
        m.SetName("https://x");
        check(m.Validate().Any(p => p.Contains("URL")), "stable: URLs in the plate name are caught");
        m.SetName("ほしぞら厩舎");
        check(m.Validate().Count == 0 && m.CanSave && m.Dirty, "stable: valid draft can be saved");
        int sentBefore = s.Sent.Count;
        var save = await m.SaveAsync();
        check(save.Ok && m.State == StableLoad.Ready && !m.Dirty && m.Mine.Saved && m.Mine.Preview?.PlayerId == "me", "stable: save → ready, preview = public copy");
        check(savedBody != null && savedBody.Contains("\"slots\":[\"decor_golden_horseshoe\",\"decor_flower_box\"]") && savedBody.Contains("\"featuredHorseIds\":[\"h2\"]"), "stable: trailing empty slots are trimmed in the request");

        await m.LoadVisitsAsync();
        check(m.VisitsState == StableLoad.Ready && m.Visits.Friends.Count == 1 && m.Visits.Friends[0].PlateName == "ほしぞら厩舎", "stable: friends' stables listed");
        await m.VisitAsync("ghost");
        check(m.VisitState == StableLoad.Empty && !m.CanLike, "stable: a stable that is not open yet shows the empty state");
        await m.VisitAsync("f");
        check(m.VisitState == StableLoad.Ready && m.CanLike && m.Visiting.Stable.Likes == 4, "stable: visiting a friend's stable");
        var l1 = await m.LikeAsync();
        string slot = StableModel.KeyPendingLike + ":f";
        string kept = kv.Get(slot);
        check(!l1.Ok && !string.IsNullOrEmpty(kept), "stable: a 5xx keeps the like's idempotency key");
        var l2 = await m.LikeAsync();
        var keys = s.Sent.Where(r => r.Path == "/v1/stable/f/like").Select(r => r.Headers["idempotency-key"]).ToList();
        check(l2.Ok && keys.Count == 2 && keys[0] == keys[1] && kv.Get(slot) == null, "stable: the retry reuses the key (counted once) and clears it");
        check(m.Visiting.Stable.Likes == 5 && !m.CanLike && m.Visiting.Viewer.LikesLeftToday == 4 && m.Visits.Friends[0].Likes == 5, "stable: like updates the count; one like per stable per day");
        check(!(await m.LikeAsync()).Ok && s.Sent.Count(r => r.Path == "/v1/stable/f/like") == 2, "stable: a second like on the same stable is refused locally");
        await m.VisitAsync("x");
        var l3 = await m.LikeAsync();
        check(!l3.Ok && m.Visiting.Viewer.LikesLeftToday == 0 && !m.CanLike && m.Message.Contains("使い切り") && kv.Get(StableModel.KeyPendingLike + ":x") == null, "stable: LIKE_LIMIT → no likes left today, key dropped");
        check(StableModel.NoCoinsNote.Contains("コインは付きません"), "stable: the screen states that likes give no coins");
        check(s.Sent.All(r => !(r.Body ?? "").Contains("coin")), "stable: no request carries coins");

        // offline: explains and sends nothing
        var off = new GameBackend(new GameSettings { OfflineOnly = true }, null, null, new MemoryKeyValueStore(), ruleset);
        await off.InitializeAsync();
        var mo = new StableModel(off, null);
        await mo.LoadAsync();
        await mo.LoadVisitsAsync();
        check(mo.State == StableLoad.Offline && mo.VisitsState == StableLoad.Offline && mo.Message.StartsWith("OFFLINE") && !(await mo.SaveAsync()).Ok && !(await mo.LikeAsync()).Ok, "stable: offline explains and refuses");
    }
}
