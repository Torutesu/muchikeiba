// Breeding screen view model (REQ-BREED-*): own and borrowed stallions, atavism odds, the free-coin stud fee and the
// pending idempotency key. A routed fake server stands in for the API; no network.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class BreedingChecks
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

    const string Horses = "[{\"id\":\"h1\",\"name\":\"アカツキ\",\"rarity\":\"SR\",\"sex\":\"female\",\"status\":\"retired\",\"named\":true},"
        + "{\"id\":\"h2\",\"name\":\"クロガネ\",\"rarity\":\"SR\",\"sex\":\"male\",\"status\":\"retired\",\"named\":true},"
        + "{\"id\":\"h3\",\"name\":\"ナツ\",\"rarity\":\"R\",\"sex\":\"male\",\"status\":\"active\",\"named\":true}]";
    const string PlayerJson = "{\"id\":\"b\",\"wallet\":{\"paid\":0,\"free\":500,\"total\":500,\"debt\":0},\"season\":{\"id\":\"2026-11\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":" + Horses + ",\"equipment\":{\"tack\":{},\"decor\":[]}}";
    const string Listing = "{\"ownerId\":\"o\",\"ownerName\":\"騎手O\",\"horseId\":\"h7\",\"name\":\"ギンガノカナタ\",\"rarity\":\"SSR\",\"line\":\"hoshi\",\"style\":\"senko\",\"visibility\":\"friends\",\"fee\":50,\"dailyLimit\":2,\"listedAt\":1}";
    const string Today = "\"today\":{\"perDay\":1,\"used\":0,\"extraPerDay\":1,\"extraUsed\":0,\"materialItemId\":\"breeding_material\",\"materialCost\":1,\"materialOwned\":0}";
    const string Atavism = "\"atavism\":{\"chancePermille\":40,\"candidates\":[{\"trait\":\"style\",\"value\":\"nige\",\"from\":\"ハツユキソウ\",\"permille\":40}]}";
    const string Foal = "{\"id\":\"h9\",\"name\":\"ミメイ\",\"rarity\":\"SR\",\"sex\":\"female\",\"style\":\"nige\",\"status\":\"active\",\"sireId\":null,\"damId\":\"h1\",\"studSire\":{\"ownerId\":\"o\",\"horseId\":\"h7\"},\"atavism\":{\"trait\":\"style\",\"value\":\"nige\",\"from\":\"ハツユキソウ\"}}";

    static HttpResponse Ok(string body) => new HttpResponse(200, body);

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        var s = new FakeServer();
        s.Routes["POST /v1/player/bootstrap"] = _ => Ok(PlayerJson);
        s.Routes["GET /v1/player"] = _ => Ok(PlayerJson);
        s.Routes["GET /v1/stud/browse?scope=friends"] = _ => Ok("{\"scope\":\"friends\",\"listings\":[" + Listing + "]}");
        s.Routes["GET /v1/stud/browse?scope=public"] = _ => Ok("{\"scope\":\"public\",\"listings\":[" + Listing + "]}"); // same horse: shown once
        s.Routes["GET /v1/stud/mine"] = _ => Ok("{\"listings\":[],\"today\":{\"earned\":0,\"earnCap\":300,\"borrowed\":0,\"borrowPerDay\":2},\"limits\":{\"feeMax\":100,\"dailyLimitMax\":3,\"maxListings\":3},\"pendingPayments\":0,\"history\":[]}");
        s.Routes["POST /v1/breeding/preview"] = _ => Ok("{\"stats\":{},\"nick\":true,\"inbreedingCount\":0,\"styles\":{},\"distance\":{\"minM\":1400,\"maxM\":2400},\"surface\":\"turf\",\"goingAptitude\":{\"any\":1000}," + Atavism + "," + Today + "}");
        s.Routes["POST /v1/stud/preview"] = _ => Ok("{\"stats\":{},\"nick\":false,\"inbreedingCount\":1,\"styles\":{},\"distance\":{\"minM\":1400,\"maxM\":2400},\"surface\":\"turf\",\"goingAptitude\":{\"any\":1000}," + Atavism + "," + Today
            + ",\"stud\":{\"ownerId\":\"o\",\"horseId\":\"h7\",\"name\":\"ギンガノカナタ\",\"fee\":50,\"feeCurrency\":\"free\",\"remainingToday\":2,\"borrowed\":0,\"borrowPerDay\":2,\"canPay\":true}}");
        int studCalls = 0;
        s.Routes["POST /v1/stud/breed"] = _ => ++studCalls == 1
            ? new HttpResponse(503, "{\"error\":{\"code\":\"INTERNAL\",\"message\":\"x\"}}")
            : Ok("{\"opId\":\"op\",\"ownerId\":\"o\",\"horseId\":\"h7\",\"fee\":50,\"feeStatus\":\"pending\",\"nick\":false,\"inbreedingCount\":1,\"usedMaterial\":false,\"atavism\":{\"trait\":\"style\",\"value\":\"nige\",\"from\":\"ハツユキソウ\"},\"foal\":" + Foal + "}");
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var kv = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, ruleset);
        await b.InitializeAsync();

        var m = new BreedingModel(b, kv);
        await m.LoadAsync();
        check(m.Online, "breeding: loads online");
        check(m.Dams.Count == 1 && m.Dams[0].Id == "h1", "breeding: only retired mares are dams");
        check(m.Sires.Count == 2 && m.Sires.Count(x => x.IsStud) == 1, "breeding: own retired stallion + one stud listing (deduplicated across scopes)");
        check(m.Step == 0, "breeding: step 0 = choose parents");

        m.SelectSire("own:h2"); m.SelectDam("h1");
        var p = await m.PreviewAsync();
        check(p.Ok && m.Step == 1 && m.Offer == null && m.CompatibilityLabel.StartsWith("◎"), "breeding: own pair preview → step 1, nick shown, no fee");
        check(m.AtavismLines().Count == 1 && m.AtavismLines()[0].Contains("4.000%") && m.AtavismLines()[0].Contains("逃げ ← ハツユキソウ"), "breeding: atavism odds line from the server's numbers");

        m.SelectSire(m.Sires.First(x => x.IsStud).Key);
        await m.PreviewAsync();
        check(m.Offer != null && m.Offer.Fee == 50 && m.FeeLine.Contains("無償コインのみ"), "breeding: stud fee shown as free coins only");
        check(m.CompatibilityLabel.Contains("近親 1"), "breeding: inbreeding warning");
        check(m.CanBreed, "breeding: can breed (normal allowance left, fee affordable)");

        var first = await m.BreedAsync();
        string slot = BreedingModel.KeyPending + ":" + m.Sire.Key + ":h1";
        string kept = kv.Get(slot);
        check(!first.Ok && !string.IsNullOrEmpty(kept), "breeding: a 5xx keeps the pending idempotency key");
        var second = await m.BreedAsync();
        var keys = s.Sent.Where(r => r.Path == "/v1/stud/breed").Select(r => r.Headers["idempotency-key"]).ToList();
        check(second.Ok && keys.Count == 2 && keys[0] == keys[1], "breeding: the retry reuses the same key (never pays twice)");
        check(kv.Get(slot) == null, "breeding: key cleared after the server answered");
        check(m.Step == 2 && m.Foal.StudSire?.OwnerId == "o" && m.LastFeeStatus == "pending" && m.Message.Contains("隔世遺伝"), "breeding: step 2 shows the foal, its atavism and the pending fee");

        // offline: nothing is sent
        var off = new GameBackend(new GameSettings { OfflineOnly = true }, null, null, new MemoryKeyValueStore(), ruleset);
        await off.InitializeAsync();
        var mo = new BreedingModel(off, null);
        await mo.LoadAsync();
        check(!mo.Online && mo.Message.StartsWith("OFFLINE") && !(await mo.BreedAsync()).Ok, "breeding: offline explains and refuses");
    }
}
