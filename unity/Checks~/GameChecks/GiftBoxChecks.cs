// プレゼントボックス (REQ-BOX-001..014, contracts/protocol.md §26): GiftBoxModel over a routed fake server. The home badge,
// the box sorted by the server, the expiry text only from a real expiresAt (「あと3日」, none for no expiry), keyed claims
// that survive a 5xx retry, a held entry with its reason, the history tab, and no buttons while a deletion is scheduled.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class GiftBoxChecks
{
    sealed class FakeServer : IHttp
    {
        public readonly List<HttpRequest> Sent = new List<HttpRequest>();
        public readonly Dictionary<string, Func<HttpRequest, HttpResponse>> Routes = new Dictionary<string, Func<HttpRequest, HttpResponse>>();
        public Task<HttpResponse> SendAsync(HttpRequest r, CancellationToken ct)
        {
            Sent.Add(r);
            string path = r.Path.Split('?')[0];
            if (Routes.TryGetValue(r.Method + " " + r.Path, out var h) || Routes.TryGetValue(r.Method + " " + path, out h)) return Task.FromResult(h(r));
            return Task.FromResult(new HttpResponse(404, "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"no route\"}}"));
        }
    }
    sealed class Tokens : IAuthTokenProvider { public Task<string> GetTokenAsync(bool f, CancellationToken ct) => Task.FromResult("tok"); }

    const long Now = 1794279600000L; // 2026-11-10 12:00 JST
    const long Day = 86_400_000L;
    static string Player(bool deleting) => "{\"id\":\"g\",\"wallet\":{\"paid\":0,\"free\":0,\"total\":0,\"debt\":0},\"season\":{\"id\":\"2026-11\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[],\"equipment\":{\"tack\":{},\"decor\":[]},"
        + "\"giftBox\":{\"unclaimed\":3,\"expiringSoon\":1},\"deletion\":" + (deleting ? "{\"status\":\"scheduled\",\"requestedAt\":1,\"deleteAt\":" + (Now + 14 * Day) + "}" : "{\"status\":\"none\"}") + "}";
    static string Entry(string id, string source, string title, long? expiresAt, string status = "unclaimed", string held = "null", int coins = 100) =>
        "{\"giftId\":\"" + id + "\",\"source\":\"" + source + "\",\"titleKey\":\"" + source + "\",\"title\":\"" + title + "\",\"rank\":" + (source == "tournament" ? "2" : "null") + ",\"contents\":{\"freeCoins\":" + coins + ",\"items\":[]},"
        + "\"lines\":[\"無償コイン" + coins + "枚\"],\"createdAt\":" + Now + ",\"expiresAt\":" + (expiresAt.HasValue ? expiresAt.Value.ToString() : "null") + ",\"status\":\"" + status + "\",\"doneAt\":" + (status == "unclaimed" ? "null" : Now.ToString()) + ",\"how\":null,\"held\":" + held + "}";
    static string Page(string tab, int unclaimed, params string[] entries) =>
        "{\"enabled\":true,\"tab\":\"" + tab + "\",\"badge\":{\"unclaimed\":" + unclaimed + ",\"expiringSoon\":1},\"maxUnclaimed\":500,\"total\":" + entries.Length + ",\"offset\":0,\"limit\":50,\"nextOffset\":null,"
        + "\"rules\":{\"defaultExpiryDays\":30,\"historyDays\":90,\"paidCoins\":false},\"entries\":[" + string.Join(",", entries) + "]}";

    static HttpResponse Ok(string body) => new HttpResponse(200, body);

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        var s = new FakeServer();
        bool deleting = false;
        s.Routes["POST /v1/player/bootstrap"] = _ => Ok(Player(deleting));
        s.Routes["GET /v1/player"] = _ => Ok(Player(deleting));
        string box = Page("box", 3,
            Entry("gift_2", "tournament", "大会の賞品", Now + 3 * Day - 60_000),
            Entry("gift_1", "ops_compensation", "メンテナンスのお詫び", Now + 90 * Day, coins: 300),
            Entry("gift_3", "ops_grant", "運営からの贈り物", null, coins: 50));
        s.Routes["GET /v1/gift-box?tab=box&offset=0&limit=50"] = _ => Ok(box);
        s.Routes["GET /v1/gift-box?tab=history&offset=0&limit=50"] = _ => Ok(Page("history", 1, Entry("gift_9", "invite", "招待ボーナス", Now - Day, "expired"), Entry("gift_8", "season", "シーズンの報酬", Now + Day, "claimed")));
        int alls = 0;
        s.Routes["POST /v1/gift-box/claim-all"] = _ => ++alls == 1
            ? new HttpResponse(503, "{\"error\":{\"code\":\"INTERNAL\",\"message\":\"x\"}}")
            : Ok("{\"claimed\":[{\"giftId\":\"gift_2\",\"source\":\"tournament\",\"freeCoins\":100,\"items\":[]},{\"giftId\":\"gift_1\",\"source\":\"ops_compensation\",\"freeCoins\":300,\"items\":[]}],"
                + "\"held\":[{\"giftId\":\"gift_3\",\"reason\":\"item_cap\",\"itemId\":\"gacha_ticket\"}],\"totals\":{\"freeCoins\":400,\"items\":{}},\"badge\":{\"unclaimed\":1,\"expiringSoon\":0},"
                + "\"wallet\":{\"paid\":0,\"free\":400,\"total\":400,\"debt\":0},\"items\":{}}");
        s.Routes["POST /v1/gift-box/gift_3/claim"] = _ => new HttpResponse(409, "{\"error\":{\"code\":\"GIFT_HOLD_CAP\",\"message\":\"over the limit 9999 of gacha_ticket\"}}");

        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var kv = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, ruleset);
        await b.InitializeAsync();
        check(b.Player.GiftBox.Unclaimed == 3 && b.Player.GiftBox.ExpiringSoon == 1, "gift box: the home envelope badge comes with the player (PlayerView.GiftBox)");

        var m = new GiftBoxModel(b, () => Now);
        var load = await m.LoadAsync();
        check(load.Ok && m.Rows.Count == 3 && m.Badge == 3 && m.Rows[0].GiftId == "gift_2", "gift box: loads the box in the server's order");
        check(m.Rows[0].ExpiryText == "あと3日" && m.Rows[0].ExpiringSoon && m.Rows[0].RankText == "2位", "gift box: the expiry text from the real expiresAt (" + m.Rows[0].ExpiryText + ")");
        check(m.Rows[1].ExpiryText == "あと90日" && m.Rows[1].IsCompensation && !m.Rows[1].ExpiringSoon, "gift box: compensation shows its 90 days");
        check(m.Rows[2].ExpiryText == null, "gift box: no expiry = no expiry text at all (never a made-up timer)");
        check(m.CanClaimAll && m.ClaimAllText == "まとめて受け取る（3件）" && m.Rows.All(r => r.CanClaim), "gift box: claim one / claim all are offered");
        var texts = string.Join("", m.Rows.Select(r => r.Title + r.ExpiryText + string.Join("", r.Lines))) + m.Notice + m.ClaimAllText;
        check(!texts.Contains("今だけ") && !texts.Contains("残りわずか") && !texts.Contains("倍") && !texts.Contains("有償コイン" + "1") && m.Notice.Contains("有償コインはプレゼントボックスに入りません"), "gift box: no urgency words; the notice says paid coins never go in");

        // claim all: a 5xx keeps the key, the retry reuses it; one entry is held with its reason
        var a1 = await m.ClaimAllAsync();
        var a2 = await m.ClaimAllAsync();
        var keys = s.Sent.Where(r => r.Path == "/v1/gift-box/claim-all").Select(r => r.Headers["idempotency-key"]).ToList();
        check(!a1.Ok && a2.Ok && keys.Count == 2 && keys[0] == keys[1], "gift box: the claim-all retry reuses its idempotency key (nothing received twice)");
        check(m.LastResult.TotalFreeCoins == 400 && m.ResultLines.Contains("無償コイン400枚") && m.ResultLines.Any(l => l.Contains("アイテムの持てる上限")), "gift box: the result panel lists what came in and what stayed (" + string.Join(" / ", m.ResultLines) + ")");
        check(m.Toast == "2件のプレゼントを受け取りました", "gift box: the toast counts the received gifts");
        check(kv.Get(GiftBoxModel.KeyPending) == "", "gift box: the pending key is cleared once answered");

        // one claim over the hold limit: an error sentence, the key is dropped (not transient)
        var one = await m.ClaimAsync("gift_3");
        check(!one.Ok && m.Message == UxText.Errors["GIFT_HOLD_CAP"] && kv.Get(GiftBoxModel.KeyPending) == "", "gift box: GIFT_HOLD_CAP reads as a sentence (" + m.Message + ")");

        // history tab
        var h = await m.LoadAsync("history");
        check(h.Ok && m.Tab == "history" && m.Rows[0].StatusText == "期限切れ" && m.Rows[1].StatusText == "受け取り済み" && m.Rows.All(r => !r.CanClaim && r.ExpiryText == null) && !m.CanClaimAll, "gift box: history rows show their status and no buttons");

        // deletion scheduled: no buttons, the banner instead
        deleting = true;
        await b.RefreshAsync();
        await m.LoadAsync();
        check(m.Blocked && m.BlockedText != null && m.Rows.All(r => !r.CanClaim) && !m.CanClaimAll, "gift box: nothing can be received while the account is scheduled for deletion");
        var blocked = await m.ClaimAllAsync();
        check(!blocked.Ok && s.Sent.Count(r => r.Path == "/v1/gift-box/claim-all") == 2, "gift box: a blocked claim sends nothing");
        check(GiftBoxModel.SourceLabels.Count == 8, "gift box: every source has a label");
    }
}
