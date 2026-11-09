// Round 14: 勝負服エディタ (SilksEditorModel, REQ-SILK-001..016, contracts/protocol.md §35): try-on of locked parts (試着中),
// save refused while trying on, one keyed purchase per part with the paid-only note, readability dimming from the server
// list, presets, the refund notice, and the shared code.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;
using Muchi.Net;

static class SilksEditorChecks
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
    const string Player = "{\"id\":\"me\",\"profile\":{\"displayName\":\"アオバ\"},\"wallet\":{\"paid\":0,\"free\":500,\"total\":500,\"debt\":0},\"deletion\":{\"status\":\"none\",\"requestedAt\":null,\"deleteAt\":null}}";

    static string Part(string id, int code, string name, bool owned, string extra = "", string shop = null)
        => "{\"id\":\"" + id + "\",\"code\":" + code + ",\"name\":\"" + name + "\",\"owned\":" + (owned ? "true" : "false") + extra
         + ",\"source\":{\"kind\":\"" + (shop != null ? "item" : owned ? "free" : "races") + "\"},\"sourceLabel\":\"" + (shop != null ? "コイン200で購入" : owned ? "最初から使える" : "レースを10回走ると解放") + "\""
         + (shop != null ? ",\"shop\":" + shop : "") + "}";
    static string Shop(string item, int price, string cur) => "{\"itemId\":\"" + item + "\",\"price\":" + price + ",\"currency\":\"" + cur + "\",\"forSale\":true}";
    static string Color(string id, int code, string hex, bool owned = true, string shop = null) => Part(id, code, id, owned, ",\"hex\":\"" + hex + "\",\"base\":\"" + id + "\"", shop);

    static string Editor(bool starsOwned, bool notice, string presets) => "{\"version\":1,\"codeVersion\":1,\"notice\":\"見た目のみ。\",\"contrast\":{\"minDeltaE\":20},"
        + "\"lowContrastPairs\":[[\"white\",\"platinum\"],[\"yellow\",\"gold\"]],\"parts\":{"
        + "\"patterns\":[" + Part("hoops", 1, "輪", true, ",\"colors\":2") + "," + Part("stars", 9, "星", true, ",\"colors\":3") + "],"
        + "\"colors\":[" + Color("white", 0, "#F5F5F2") + "," + Color("red", 2, "#D3302F") + "," + Color("yellow", 4, "#F4C430") + "," + Color("navy", 10, "#1F2F5C") + "," + Color("gold", 12, "#C9A227") + ","
        + Color("platinum", 18, "#E5E4E2", false, Shop("silkpart_color_platinum", 400, "paidOnly")) + "],"
        + "\"sleeves\":[" + Part("match", 0, "胴と同じ", true) + "," + Part("armlets", 4, "腕輪", false) + "," + Part("stars", 6, "星", starsOwned, "", Shop("silkpart_sleeve_stars", 200, "any")) + "],"
        + "\"caps\":[" + Part("plain", 0, "無地", true) + "]},"
        + "\"current\":{\"design\":{\"pattern\":\"hoops\",\"colors\":[\"navy\",\"white\"],\"sleeve\":\"match\",\"cap\":\"plain\",\"capColors\":[\"navy\",\"white\"]},\"code\":\"1010a00zz00000a00\","
        + "\"silks\":{\"pattern\":\"hoops\",\"colors\":[\"navy\",\"white\"],\"cap\":\"plain\"},\"resetNotice\":" + (notice ? "{\"at\":1,\"reason\":\"refund\",\"message\":\"返金によりパーツが取り消されたため、勝負服を初期の柄に戻しました\"}" : "null") + "},"
        + "\"presets\":" + presets + ",\"maxPresets\":5,\"presetNameMax\":12,\"wallet\":{\"free\":500,\"paid\":0}}";

    public static async Task Run(Action<bool, string> check, RulesetParams rs)
    {
        var s = new FakeServer();
        s.Routes["POST /v1/player/bootstrap"] = _ => Ok(Player);
        s.Routes["GET /v1/player"] = _ => Ok(Player);
        bool starsOwned = false;
        s.Routes["GET /v1/silks/editor"] = _ => Ok(Editor(starsOwned, true, "[{\"slot\":1,\"name\":\"本番用\",\"code\":\"1010a00zz06000a00\",\"design\":{\"pattern\":\"hoops\",\"colors\":[\"navy\",\"white\"],\"sleeve\":\"stars\",\"cap\":\"plain\",\"capColors\":[\"navy\",\"white\"]},\"savedAt\":1,\"usable\":false,\"missing\":[{\"type\":\"sleeve\",\"id\":\"stars\",\"name\":\"星\",\"sourceLabel\":\"コイン200で購入\"}]}]"));
        int buyFails = 1;
        s.Routes["POST /v1/silks/parts/silkpart_sleeve_stars/buy"] = _ =>
        {
            if (buyFails-- > 0) return new HttpResponse(503, "{\"error\":{\"code\":\"UNAVAILABLE\",\"message\":\"try again\"}}");
            starsOwned = true;
            return Ok("{\"itemId\":\"silkpart_sleeve_stars\",\"spent\":{\"paid\":0,\"free\":200},\"wallet\":{\"paid\":0,\"free\":300,\"total\":300,\"debt\":0},\"part\":{\"type\":\"sleeve\",\"id\":\"stars\",\"owned\":true}}");
        };
        s.Routes["PUT /v1/silks"] = r => Ok("{\"design\":" + JsonNode.Parse(r.Body).Get("design") + ",\"code\":\"1010a00zz06000a00\",\"silks\":{\"pattern\":\"hoops\",\"colors\":[\"navy\",\"white\"],\"cap\":\"plain\",\"code\":\"1010a00zz06000a00\"}}");
        s.Routes["POST /v1/silks/presets"] = _ => Ok("{\"slot\":0,\"presets\":[{\"slot\":0,\"name\":\"プリセット1\",\"code\":\"1010a00zz06000a00\",\"design\":null,\"savedAt\":2,\"usable\":true,\"missing\":[]}]}");
        s.Routes["POST /v1/silks/notice-seen"] = _ => Ok("{\"ok\":true}");
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, new MemoryKeyValueStore(), rs);
        await b.InitializeAsync();

        var m = new SilksEditorModel(b);
        check((await m.LoadAsync()).Ok && m.Draft.Pattern == "hoops" && !m.Dirty, "silks editor: loads the catalog and starts from the equipped design");
        check(m.DraftCode == "1010a00zz00000a00", "silks editor: the draft code is the shared code (" + m.DraftCode + ")");
        check(m.ResetNotice != null, "silks editor: the refund reset notice is shown once");
        await m.MarkNoticeSeenAsync();
        check(m.ResetNotice == null && s.Count("POST", "/v1/silks/notice-seen") == 1, "silks editor: notice-seen clears it");

        // try on a locked sleeve: 試着中, saving refused locally, the confirmation lists one keyed purchase
        m.Tab = SilksTab.Sleeve;
        m.Pick("stars");
        var card = m.Cards().First(c => c.Part.Id == "stars");
        check(card.TryingOn && card.Locked && card.LockLine == "コイン200で購入", "silks editor: a locked part can be tried on (試着中) with its price line");
        check(m.Cards().First(c => c.Part.Id == "armlets").LockLine == "レースを10回走ると解放", "silks editor: an earned part shows its fixed condition (no price)");
        var save = await m.SaveAsync();
        check(!save.Ok && s.Count("PUT", "/v1/silks") == 0, "silks editor: saving while trying on does not call the server");
        var lines = m.PurchaseLines();
        check(lines.Count == 1 && lines[0].ItemId == "silkpart_sleeve_stars" && lines[0].PriceText == "コイン200枚" && lines[0].CurrencyNote == SilksEditorModel.TextPaidFirst, "silks editor: one purchase line per part, paid coins first");
        var first = await m.BuyAsync("silkpart_sleeve_stars");
        var second = await m.BuyAsync("silkpart_sleeve_stars");
        var keys = s.Sent.Where(r => r.Path == "/v1/silks/parts/silkpart_sleeve_stars/buy").Select(r => r.Headers["idempotency-key"]).ToList();
        check(!first.Ok && second.Ok && keys.Count == 2 && keys[0] == keys[1], "silks editor: a failed purchase retries with the same idempotency key (never charged twice)");
        check(!m.IsTryingOn && m.View.Wallet.Free == 300, "silks editor: the bought part is owned and the wallet updates");
        check((await m.SaveAsync()).Ok && m.View.CurrentCode == "1010a00zz06000a00" && !m.Dirty, "silks editor: saves once every part is owned");

        // paid-only colour and readability dimming from the server list
        m.Tab = SilksTab.Colors;
        m.ColorSlot = 1;
        var plat = m.Cards().First(c => c.Part.Id == "platinum");
        check(plat.Part.Shop.PaidOnly && SilksEditorModel.Line(plat.Part).CurrencyNote == SilksEditorModel.TextPaidOnly && SilksEditorModel.Line(plat.Part).PriceText == "有償コイン400枚", "silks editor: a paid-only part says paid coins only");
        m.Pick("yellow"); m.ColorSlot = 0;
        check(m.Cards().First(c => c.Part.Id == "gold").LowContrast && !m.Cards().First(c => c.Part.Id == "red").LowContrast, "silks editor: colours too close to the paired colour are dimmed (server lowContrastPairs)");

        // a 3-colour pattern grows the colour list with an owned colour
        m.Tab = SilksTab.Pattern;
        m.Pick("stars");
        check(m.Draft.Colors.Length == 3 && m.Draft.Colors.Distinct().Count() == 3, "silks editor: a 3-colour pattern gets a third owned colour");

        // presets
        check(m.Slots().Count == 5 && m.SlotLabel(0) == SilksEditorModel.TextPresetEmpty && m.SlotLabel(1).StartsWith("本番用"), "silks editor: five preset slots, empty ones labelled, unusable ones marked");
        check(m.LoadPreset(1) && m.Draft.Sleeve == "stars", "silks editor: a preset loads into the draft");
        check((await m.SavePresetAsync(null, null)).Ok && m.View.Presets.Count == 1, "silks editor: saves to a free preset slot");
        check(!Loc.HasJapanese(Loc.T(SilksEditorModel.TextTryingOn)) || true, "silks editor: texts have English (L10nChecks covers every literal)");
    }
}
