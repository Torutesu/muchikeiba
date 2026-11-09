// 実況パック (REQ-CMT-001..014, contracts/protocol.md §36): CommentaryPackModel over a routed fake server. The list
// (owned / price / equipped / achievement progress), equipping, the calm purchase confirm, buying (one idempotency key
// per pack, the T6 shortfall on lack of coins), the 10-second sample of an unowned pack, the race templates, offline.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class CommentaryPackChecks
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

    static string Pack(string id, string name, string acquire, int? price, bool owned, bool equipped, string unlock = "null", string english = "own")
        => "{\"id\":\"" + id + "\",\"name\":\"" + name + "\",\"description\":\"d\",\"acquire\":\"" + acquire + "\",\"price\":" + (price?.ToString() ?? "null")
        + ",\"currency\":" + (price.HasValue ? "\"any\"" : "null") + ",\"forSale\":" + (price.HasValue ? "true" : "false") + ",\"owned\":" + (owned ? "true" : "false")
        + ",\"equipped\":" + (equipped ? "true" : "false") + ",\"unlock\":" + unlock + ",\"english\":\"" + english + "\",\"englishNote\":" + (english == "own" ? "null" : "\"英語では標準の実況で話します\"") + "}";

    static string View(string equipped, bool ochitsukiOwned) =>
        "{\"equipped\":\"" + equipped + "\",\"standardPackId\":\"standard\",\"sample\":{\"seed\":3614,\"seconds\":10,\"trackId\":\"aoba_turf_1600\",\"fieldSize\":8},"
        + "\"notice\":\"実況の話し方だけが変わります。レースの結果・能力には影響しません。\",\"packs\":["
        + Pack("standard", "標準", "default", null, true, equipped == "standard") + ","
        + Pack("nekketsu", "熱血", "achievement", null, false, false, "{\"achievementId\":\"races\",\"tier\":1,\"label\":\"実績「出走の記録」1段目で入手\",\"progress\":3,\"target\":10}") + ","
        + Pack("ochitsuki", "落ち着いた解説", "coins", 300, ochitsukiOwned, equipped == "ochitsuki") + ","
        + Pack("kofuu", "古風な名調子", "coins", 300, false, false, "null", "standard") + "]}";

    const string Player = "{\"id\":\"a\",\"wallet\":{\"paid\":0,\"free\":400,\"total\":400,\"debt\":0},\"season\":{\"id\":\"2026-12\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[],\"equipment\":{\"tack\":{},\"decor\":[]}}";

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset, string root)
    {
        string res(string f) => File.ReadAllText(Path.Combine(root, "engine", "Muchi.Client", "Resources", "Muchi", f));
        var catalog = CommentaryPackCatalog.Parse(res("commentary-packs.json"));
        var ja = CommentaryTemplates.Parse(res("commentary-ja.json"));

        var s = new FakeServer();
        string equipped = "standard"; bool owned = false; int buys = 0; bool poor = false;
        var keys = new List<string>();
        s.Routes["POST /v1/player/bootstrap"] = _ => new HttpResponse(200, Player);
        s.Routes["GET /v1/commentary/packs"] = _ => new HttpResponse(200, View(equipped, owned));
        s.Routes["PUT /v1/commentary/equipped"] = r =>
        {
            string id = r.Body.Contains("ochitsuki") ? "ochitsuki" : r.Body.Contains("standard") ? "standard" : "kofuu";
            if (id != "standard" && !(id == "ochitsuki" && owned)) return new HttpResponse(409, "{\"error\":{\"code\":\"NOT_ELIGIBLE\",\"message\":\"not owned\"}}");
            equipped = id;
            return new HttpResponse(200, View(equipped, owned));
        };
        s.Routes["POST /v1/commentary/packs/ochitsuki/buy"] = r =>
        {
            keys.Add(r.Headers.TryGetValue("idempotency-key", out var k) ? k : null);
            if (poor) return new HttpResponse(409, "{\"error\":{\"code\":\"INSUFFICIENT_COINS\",\"message\":\"need 300, have 120\",\"details\":{\"coinKind\":\"any\",\"need\":300,\"have\":120,\"shortfall\":{\"short\":true,\"coinKind\":\"any\",\"need\":300,\"have\":120,\"shortfall\":180,\"headline\":\"コインが180枚足りません\",\"status\":\"covered\",\"blockedCode\":null,\"ageCheck\":false,\"line\":\"x\",\"notes\":[],\"offer\":null}}}}");
            if (buys++ == 0) return new HttpResponse(503, "{\"error\":{\"code\":\"UNAVAILABLE\",\"message\":\"try again\"}}");
            owned = true;
            if (r.Body.Contains("\"equip\":true")) equipped = "ochitsuki";
            return new HttpResponse(200, "{\"packId\":\"ochitsuki\",\"spent\":{\"paid\":0,\"free\":300},\"wallet\":{\"paid\":0,\"free\":100,\"total\":100,\"debt\":0},\"view\":" + View(equipped, owned) + "}");
        };
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var kv = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, ruleset);
        await b.InitializeAsync();
        check(b.Player.CommentaryPack == "standard", "packs: a player without `commentaryPack` (older server) speaks the standard");

        var m = new CommentaryPackModel(b, catalog);
        check((await m.LoadAsync()).Ok && m.Equipped == "standard", "packs: loads the list");
        var cards = m.Cards();
        check(cards.Count == 4 && cards[0].Status == "装備中" && cards[1].Status == "実績で入手（3/10）" && cards[1].UnlockLabel.Contains("出走の記録") && !cards[1].CanBuy
            && cards[2].Status == "300コイン" && cards[2].CanBuy && !cards[2].CanEquip && cards.TrueForAll(c => c.Playable),
            "packs: equipped / achievement progress / price; the achievement pack is never for sale; every pack is playable from the device catalog");

        // try before buy: an unowned pack plays its own 10-second sample, the same each time
        var sample = m.Sample("kofuu", ja);
        var again = m.Sample("kofuu", ja);
        check(sample != null && sample.Lines.Count >= 3 && sample.TotalTicks <= 200 && sample.Lines.Exists(l => l.VariantId.StartsWith("kofuu_"))
            && string.Join("|", sample.Lines.ConvertAll(l => l.Text)) == string.Join("|", again.Lines.ConvertAll(l => l.Text)),
            "packs: the sample of a pack not owned is ≤ 10 s of its own lines and the same every time");
        var ev = m.SampleEvent("kofuu", 1);
        check(ev.Name == "commentary_pack_sample", "packs: commentary_pack_sample KPI for the sample");

        // equip a pack not owned: refused by the server, nothing changes on the device
        var no = await m.EquipAsync("kofuu", CommentaryEquipSource.Shop);
        check(!no.Ok && m.Equipped == "standard", "packs: equipping a pack not owned is refused");

        var sheet = m.PurchaseConfirm("ochitsuki");
        string all = sheet.Title + sheet.Body + sheet.Notice;
        check(sheet != null && sheet.Price == 300 && sheet.Title == "落ち着いた解説を購入しますか？" && sheet.Body.Contains("300コイン") && sheet.CancelLabel == "やめる"
            && !all.Contains("倍") && !all.Contains("今だけ") && !all.Contains("お得") && !all.Contains("残りわずか") && m.PurchaseConfirm("nekketsu") == null && m.PurchaseConfirm("standard") == null,
            "packs: a calm confirm with the server's price (no pressure words); no sheet for packs that are not sold");

        poor = true;
        var fail = await m.BuyAsync("ochitsuki");
        check(!fail.Ok && m.Shortfall != null && m.Shortfall.Amount == 180, "packs: not enough coins gives the T6 shortfall");
        poor = false;
        var r1 = await m.BuyAsync("ochitsuki");
        var r2 = await m.BuyAsync("ochitsuki");
        check(!r1.Ok && r2.Ok && keys.Count == 3 && keys[1] == keys[2] && keys[0] != keys[1], "packs: a retried purchase reuses its idempotency key (never charged twice); a refused one starts a new key");
        check(m.Equipped == "ochitsuki" && b.Player.CommentaryPack == "ochitsuki" && kv.Get(CommentaryPackModel.KeyEquipped) == "ochitsuki", "packs: bought and equipped; the device remembers it for offline races");

        var t = m.TemplatesForRace(ja);
        check(t.PackId == "ochitsuki" && t.Phrases["spurt"].Variants[0].Id.StartsWith("ochitsuki_"), "packs: the next race speaks the equipped pack");
        check(CommentaryPackModel.TemplatesFor(ja, catalog, "unknown_pack") == ja && CommentaryPackModel.TemplatesFor(ja, catalog, "standard") == ja,
            "packs: a pack missing from the device catalog falls back to the standard");

        var back = await m.EquipAsync("standard");
        check(back.Ok && m.Equipped == "standard", "packs: back to the standard");

        // offline: the device's last choice, only the standard or the current pack can be chosen
        var off = new GameBackend(new GameSettings { OfflineOnly = true }, null, null, kv, ruleset);
        kv.Set(CommentaryPackModel.KeyEquipped, "ochitsuki");
        var mo = new CommentaryPackModel(off, catalog, kv);
        await mo.LoadAsync();
        check(mo.Equipped == "ochitsuki" && mo.TemplatesForRace(ja).PackId == "ochitsuki", "packs: offline races speak the device's last pack");
        check(!(await mo.BuyAsync("kofuu")).Ok && !(await mo.EquipAsync("kofuu")).Ok && (await mo.EquipAsync("standard")).Ok, "packs: offline cannot buy or equip a new pack, can go back to the standard");

        // English: names come from the server; the UI strings translate
        Loc.LoadEnglish(res("ui-en.json"));
        Loc.SetLocale(Loc.En);
        try
        {
            check(Loc.T(CommentaryPackModel.TextTitle) == "Commentary Packs" && CommentaryPackModel.Fmt(CommentaryPackModel.TextPrice, "n", 300) == "300 coins"
                && CommentaryPackModel.Fmt(CommentaryPackModel.Fmt(CommentaryPackModel.TextUnlock, "n", 3, false), "m", 10) == "Achievement unlock (3/10)" && CommentaryPackModel.Fmt(CommentaryPackModel.TextConfirmTitle, "name", "Calm Analyst") == "Buy Calm Analyst?",
                "packs: English UI strings");
        }
        finally { Loc.SetLocale(Loc.Ja); }
    }
}
