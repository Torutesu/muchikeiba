// Round 10 game-layer checks: the 支部 cheer-stamp feed (TeamFeedModel, REQ-TEAMFEED-*) and the shop's pass card after the
// pass was bought (ShopModel on GET /v1/shop/products?mine=1).
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class Round10Checks
{
    sealed class FakeServer : IHttp
    {
        public readonly List<HttpRequest> Sent = new List<HttpRequest>();
        public readonly Dictionary<string, Func<HttpRequest, HttpResponse>> Routes = new Dictionary<string, Func<HttpRequest, HttpResponse>>();
        public Task<HttpResponse> SendAsync(HttpRequest r, CancellationToken ct)
        {
            Sent.Add(r);
            if (Routes.TryGetValue(r.Method + " " + r.Path, out var h)) return Task.FromResult(h(r));
            return Task.FromResult(new HttpResponse(404, "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"no route " + r.Method + " " + r.Path + "\"}}"));
        }
        public int Count(string method, string path) => Sent.Count(r => r.Method == method && r.Path == path);
    }
    sealed class Tokens : IAuthTokenProvider { public Task<string> GetTokenAsync(bool f, CancellationToken ct) => Task.FromResult("tok"); }

    static HttpResponse Ok(string body) => new HttpResponse(200, body);
    static HttpResponse Err(int status, string code) => new HttpResponse(status, "{\"error\":{\"code\":\"" + code + "\",\"message\":\"" + code + "\"}}");

    const long Now = 1795575600000L; // 2026-11-25 12:00 JST
    static string PlayerJson(string deletion = "{\"status\":\"none\",\"requestedAt\":null,\"deleteAt\":null}")
        => "{\"id\":\"me\",\"profile\":{\"displayName\":\"アオバ\"},\"wallet\":{\"paid\":100,\"free\":195,\"total\":295,\"debt\":0},\"deletion\":" + deletion + "}";

    const string Stamps = "{\"version\":1,\"limits\":{\"postIntervalMs\":10000,\"postsPerDay\":50,\"feedSize\":100,\"pageMax\":50},\"stamps\":["
        + "{\"id\":\"cheer\",\"label\":\"がんばれ！\",\"asset\":\"stamp/cheer\",\"unlock\":{\"kind\":\"default\"},\"unlockText\":\"最初から使える\",\"unlocked\":true},"
        + "{\"id\":\"nice\",\"label\":\"ナイス！\",\"asset\":\"stamp/nice\",\"unlock\":{\"kind\":\"default\"},\"unlockText\":\"最初から使える\",\"unlocked\":true},"
        + "{\"id\":\"whip\",\"label\":\"ムチ一閃！\",\"asset\":\"stamp/whip\",\"unlock\":{\"kind\":\"races\",\"count\":10},\"unlockText\":\"レースに10回出走で解放\",\"unlocked\":false},"
        + "{\"id\":\"carrot\",\"label\":\"にんじん！\",\"asset\":\"stamp/carrot\",\"unlock\":{\"kind\":\"cosmetic\",\"itemId\":\"stamp_carrot\"},\"unlockText\":\"見た目ショップで購入（200コイン）\",\"unlocked\":false}]}";
    static string Race(long seq, string player, string name, int place, string mode = "ranked", string my = null, string reactions = "[]")
        => "{\"seq\":" + seq + ",\"at\":" + (Now - 120_000) + ",\"kind\":\"race\",\"playerId\":\"" + player + "\",\"displayName\":\"" + name + "\",\"mine\":" + (player == "me" ? "true" : "false")
         + ",\"stampId\":null,\"stampAsset\":null,\"race\":{\"raceId\":\"r" + seq + "\",\"mode\":\"" + mode + "\",\"place\":" + place + ",\"fieldSize\":12,\"trackId\":\"kirameki_turf_2000\"},\"reactions\":" + reactions + ",\"myReaction\":" + (my == null ? "null" : "\"" + my + "\"") + "}";
    static string StampItem(long seq, string player, string name, string stamp)
        => "{\"seq\":" + seq + ",\"at\":" + (Now - 30_000) + ",\"kind\":\"stamp\",\"playerId\":\"" + player + "\",\"displayName\":\"" + name + "\",\"mine\":" + (player == "me" ? "true" : "false")
         + ",\"stampId\":\"" + stamp + "\",\"stampAsset\":\"stamp/" + stamp + "\",\"race\":null,\"reactions\":[],\"myReaction\":null}";

    static (FakeServer s, GameBackend b, MemoryKeyValueStore kv) Setup(RulesetParams rs, string player = null)
    {
        var s = new FakeServer();
        s.Routes["POST /v1/player/bootstrap"] = _ => Ok(player ?? PlayerJson());
        s.Routes["GET /v1/player"] = _ => Ok(player ?? PlayerJson());
        var kv = new MemoryKeyValueStore();
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, rs);
        b.InitializeAsync().GetAwaiter().GetResult();
        return (s, b, kv);
    }

    public static async Task Run(Action<bool, string> check, RulesetParams rs)
    {
        await Feed(check, rs);
        await MuteAndReport(check, rs);
        await Edges(check, rs);
        await ShopPassOwned(check, rs);
    }

    static async Task Feed(Action<bool, string> check, RulesetParams rs)
    {
        var (s, b, _) = Setup(rs);
        s.Routes["GET /v1/stamps"] = _ => Ok(Stamps);
        s.Routes["GET /v1/teams/me/feed"] = _ => Ok("{\"teamId\":\"tabc123456\",\"items\":[" + Race(3, "a", "ミドリ", 1) + "," + StampItem(2, "b", "クロ", "nice") + "," + Race(1, "me", "アオバ", 2, "tournament") + "],\"nextBefore\":1,\"latestSeq\":3,\"muted\":[]}");
        s.Routes["GET /v1/teams/me/feed?before=1"] = _ => Ok("{\"teamId\":\"tabc123456\",\"items\":[" + StampItem(0, "a", "ミドリ", "cheer") + "],\"nextBefore\":null,\"latestSeq\":3,\"muted\":[]}");
        long t = Now;
        var m = new TeamFeedModel(b, () => t);
        await m.LoadAsync();
        check(m.Online && m.InTeam && m.Rows.Count == 3 && m.HasOlder, "team feed: first page newest first, older items pageable");
        var rows = m.Rows;
        check(rows[0].Line == "ミドリさんがランク戦で1着！" && rows[0].CanCheer && rows[0].When == "2分前", "race row of a teammate: 「ランク戦で1着！」, can be cheered, relative time");
        check(rows[1].Line == "クロ：「ナイス！」" && rows[1].StampAsset == "stamp/nice" && !rows[1].CanCheer, "stamp row: label from the stamp set, asset stamp/<id>");
        check(rows[2].Line == "アオバさんが大会で2着" && !rows[2].CanCheer, "own tournament place: shown, not cheerable by me");
        var pal = m.Palette;
        check(pal.Count == 4 && pal[0].Unlocked && pal[2].LockText == "レースに10回出走で解放" && pal[3].ShopItemId == "stamp_carrot" && pal[2].ShopItemId == null,
            "palette: every stamp, locked ones with the server's unlock text; a cosmetic stamp links to the 見た目 shop");
        check(m.PostDisabledReason == null && m.CanPost(pal[0]) && !m.CanPost(pal[2]), "post enabled for unlocked stamps only");
        // a locked stamp never reaches the server
        var locked = await m.PostAsync("whip");
        check(!locked.Ok && m.Message == "レースに10回出走で解放" && s.Count("POST", "/v1/teams/me/feed/stamps") == 0, "locked stamp: the unlock text, no request");

        s.Routes["POST /v1/teams/me/feed/stamps"] = r => Ok("{\"teamId\":\"tabc123456\",\"seq\":4,\"at\":" + Now + ",\"stampId\":\"cheer\"}");
        var posted = await m.PostAsync("cheer");
        check(posted.Ok && m.Rows[0].Seq == 4 && m.Rows[0].Mine && m.Rows[0].Line == "アオバ：「がんばれ！」", "post: my stamp on top at once");
        check(m.CooldownMs == 10_000 && m.PostDisabledReason == "あと10秒で送れます" && !m.CanPost(pal[0]), "10 s cooldown shown on the palette");
        var tooFast = await m.PostAsync("nice");
        check(!tooFast.Ok && s.Count("POST", "/v1/teams/me/feed/stamps") == 1, "no second request inside the cooldown");
        t += 10_000;
        s.Routes["POST /v1/teams/me/feed/stamps"] = _ => Err(429, "RATE_LIMITED");
        var limited = await m.PostAsync("nice");
        check(!limited.Ok && m.Message == "スタンプは10秒に1回、1日50回までです。" && s.Count("POST", "/v1/teams/me/feed/stamps") == 2, "server RATE_LIMITED (daily 50): a sentence, the post is not retried");

        // cheer a teammate's race row; tap the same stamp again to take it back
        s.Routes["PUT /v1/teams/me/feed/3/reaction"] = r => Ok(r.Body.Contains("null") ? "{\"teamId\":\"t\",\"seq\":3,\"myReaction\":null}" : "{\"teamId\":\"t\",\"seq\":3,\"myReaction\":\"nice\"}");
        var cheer = await m.CheerAsync(3, "nice");
        var row = m.Rows.First(x => x.Seq == 3);
        check(cheer.Ok && row.MyReaction == "nice" && row.Reactions.Single().Count == 1 && row.Reactions.Single().Mine, "cheer: my reaction counted on the row");
        await m.CheerAsync(3, "nice");
        row = m.Rows.First(x => x.Seq == 3);
        check(row.MyReaction == null && row.Reactions.Count == 0, "the same stamp again takes the cheer back");
        check(!(await m.CheerAsync(1, "nice")).Ok && !(await m.CheerAsync(2, "nice")).Ok && s.Count("PUT", "/v1/teams/me/feed/1/reaction") == 0, "own race rows and stamp rows cannot be cheered");

        var older = await m.LoadOlderAsync();
        check(older.Ok && !m.HasOlder && m.Rows.Last().Seq == 0, "older page appended; no more pages after nextBefore null");
        check(TeamFeedModel.WhenText(Now - 30_000, Now) == "たった今" && TeamFeedModel.WhenText(Now - 3 * 3_600_000L, Now) == "3時間前" && TeamFeedModel.WhenText(Now - 3 * 86_400_000L, Now) == "11月22日", "relative times (JST date after a day)");
    }

    static async Task MuteAndReport(Action<bool, string> check, RulesetParams rs)
    {
        var (s, b, kv) = Setup(rs);
        s.Routes["GET /v1/stamps"] = _ => Ok(Stamps);
        s.Routes["GET /v1/teams/me/feed"] = _ => Ok("{\"teamId\":\"tabc123456\",\"items\":[" + Race(3, "a", "ミドリ", 1) + "," + StampItem(2, "b", "クロ", "nice") + "],\"nextBefore\":null,\"latestSeq\":3,\"muted\":[\"z\"]}");
        var m = new TeamFeedModel(b, () => Now);
        await m.LoadAsync();
        check(m.IsMuted("z"), "the server's mute list joins the device copy on load");
        // the server is down for the mute call: the local mute applies at once and is retried on the next load
        s.Routes["PUT /v1/teams/me/feed/mutes"] = _ => Err(503, "INTERNAL");
        await m.SetMutedAsync("b", true);
        check(m.IsMuted("b") && m.Rows.All(r => r.PlayerId != "b") && kv.Get(TeamFeedModel.KeyMutePending) == "+b", "mute: rows of the member disappear at once; a failed server call stays pending on the device");
        int puts = 0;
        s.Routes["PUT /v1/teams/me/feed/mutes"] = r => { puts++; return Ok("{\"muted\":[\"z\",\"b\"]}"); };
        await m.LoadAsync();
        check(puts == 1 && (kv.Get(TeamFeedModel.KeyMutePending) ?? "") == "" && m.Rows.All(r => r.PlayerId != "b"), "next load sends the pending mute; the member stays hidden");
        await m.SetMutedAsync("b", false);
        check(!m.IsMuted("b") && m.Rows.Any(r => r.PlayerId == "b") && puts == 2, "unmute brings the rows back and tells the server");
        check(!(await m.SetMutedAsync("me", true)).Ok, "cannot mute yourself");

        s.Routes["POST /v1/teams/me/feed/2/report"] = _ => Ok("{\"reported\":true,\"seq\":2}");
        var rep = await m.ReportAsync(2, FeedReportReason.Spam);
        check(rep.Ok && m.Rows.All(r => r.Seq != 2) && s.Count("POST", "/v1/teams/me/feed/2/report") == 1, "report: the row is hidden at once and sent for support");
        await m.LoadAsync();
        check(m.Rows.All(r => r.Seq != 2), "a reported row stays hidden on the device even if the server lists it again");
    }

    static async Task Edges(Action<bool, string> check, RulesetParams rs)
    {
        // not in a team
        var (s, b, _) = Setup(rs);
        s.Routes["GET /v1/stamps"] = _ => Ok(Stamps);
        s.Routes["GET /v1/teams/me/feed"] = _ => Err(404, "NOT_IN_TEAM");
        var m = new TeamFeedModel(b, () => Now);
        await m.LoadAsync();
        check(m.Online && !m.InTeam && m.Rows.Count == 0 && m.PostDisabledReason == "支部に入ると応援スタンプを送れます", "outside a team: an invitation to join, no error");

        // deletion scheduled: palette off with the deletion banner, no requests
        var (s2, b2, _) = Setup(rs, PlayerJson("{\"status\":\"scheduled\",\"requestedAt\":1,\"deleteAt\":1796050800000}"));
        s2.Routes["GET /v1/stamps"] = _ => Ok(Stamps);
        s2.Routes["GET /v1/teams/me/feed"] = _ => Ok("{\"teamId\":\"tabc123456\",\"items\":[" + Race(3, "a", "ミドリ", 1) + "],\"nextBefore\":null,\"latestSeq\":3,\"muted\":[]}");
        var d = new TeamFeedModel(b2, () => Now);
        await d.LoadAsync();
        var r1 = await d.PostAsync("cheer");
        var r2 = await d.CheerAsync(3, "cheer");
        check(!r1.Ok && !r2.Ok && d.PostDisabledReason.StartsWith("アカウント削除の予定があります") && s2.Count("POST", "/v1/teams/me/feed/stamps") == 0 && s2.Count("PUT", "/v1/teams/me/feed/3/reaction") == 0,
            "deletion scheduled: posting and cheering are off with the deletion banner");

        // offline
        var off = new GameBackend(new GameSettings { OfflineOnly = true }, null, null, new MemoryKeyValueStore(), rs);
        await off.InitializeAsync();
        var o = new TeamFeedModel(off, () => Now);
        await o.LoadAsync();
        check(!o.Online && o.Message == UxText.Offline && o.PostDisabledReason == UxText.Offline, "offline: the feed needs the server (message, palette off)");
    }

    const string PassProducts = "{\"personalized\":true,\"seasonId\":\"2026-11\",\"products\":["
        + "{\"id\":\"season_pass\",\"kind\":\"season_pass\",\"name\":\"シーズンパス\",\"tab\":\"pass\",\"storeType\":\"consumable\",\"priceYen\":1000,\"paidCoins\":0,\"autoRenew\":false,\"contents\":[{\"type\":\"pass\",\"label\":\"プレミアム報酬\"}],\"oneTime\":false,\"period\":{\"kind\":\"season\"},\"noticeKeys\":[],\"owned\":OWNED,\"ownedReason\":REASON,\"purchasedThisSeason\":OWNED},"
        + "{\"id\":\"season_pass_plus\",\"kind\":\"season_pass\",\"name\":\"シーズンパス＋\",\"tab\":\"pass\",\"storeType\":\"consumable\",\"priceYen\":2400,\"paidCoins\":0,\"autoRenew\":false,\"contents\":[{\"type\":\"pass\",\"label\":\"プレミアム報酬\"}],\"oneTime\":false,\"period\":{\"kind\":\"season\"},\"noticeKeys\":[],\"owned\":OWNED,\"ownedReason\":REASON,\"purchasedThisSeason\":false},"
        + "{\"id\":\"coin_160\",\"kind\":\"coins\",\"name\":\"コイン100\",\"tab\":\"coins\",\"storeType\":\"consumable\",\"priceYen\":160,\"paidCoins\":100,\"autoRenew\":false,\"contents\":[{\"type\":\"paid_coins\",\"qty\":100,\"label\":\"有償コイン100枚\"}],\"oneTime\":false,\"period\":null,\"noticeKeys\":[],\"owned\":false,\"ownedReason\":null,\"purchasedThisSeason\":null}],"
        + "\"notices\":{},\"legalLinks\":[],\"notice\":\"有償コインから先に使われます\"}";

    static async Task ShopPassOwned(Action<bool, string> check, RulesetParams rs)
    {
        var (s, b, _) = Setup(rs);
        bool bought = false;
        s.Routes["GET /v1/shop/products?mine=1"] = _ => Ok(PassProducts.Replace("OWNED", bought ? "true" : "false").Replace("REASON", bought ? "\"season_pass\"" : "null"));
        s.Routes["GET /v1/shop/offers"] = _ => Ok("{\"offers\":[],\"firstPurchase\":{\"available\":false,\"productIds\":[],\"noticeKey\":\"shop.first_purchase_bonus\"},\"allowance\":null}");
        var shop = new ShopModel(b, null, () => Now);
        await shop.LoadAsync();
        var pass = shop.Cards("pass");
        check(s.Count("GET", "/v1/shop/products?mine=1") == 1 && pass.Count == 2 && pass.All(c => c.Purchasable && !c.Owned), "before the purchase both pass cards are buyable (per-player list)");
        bought = true;
        await shop.LoadAsync();
        pass = shop.Cards("pass");
        check(!pass[0].Purchasable && pass[0].Owned && pass[0].DisabledReason == "今シーズンのパスは購入済みです", "after buying this season's pass its card shows 購入済み, not a buy button");
        check(!pass[1].Purchasable && pass[1].DisabledReason == "今シーズンはパスを購入済みです（パス・パス＋はどちらか1つ）", "Pass+ is closed too (one pass per season), with the reason");
        check(shop.Cards("coins").Single().Purchasable, "coin packs stay buyable");
    }
}
