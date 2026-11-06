// Regression checks for the Round 6 client QA findings (ranked entry on token failure, room ground, items, leaderboard
// season, Firebase startup wiring). A routed fake server stands in for the API; no network.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class QaRound6Checks
{
    /// <summary>Routes requests by "METHOD /path" to a handler; records every request that reached the transport.</summary>
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
        public bool Saw(string methodPath) => Sent.Any(r => r.Method + " " + r.Path == methodPath);
    }

    /// <summary>A token provider that fails the way an SDK does (a plain exception, not an ApiException).</summary>
    sealed class FlakyTokens : IAuthTokenProvider
    {
        public bool Fail;
        public Task<string> GetTokenAsync(bool forceRefresh, CancellationToken ct)
            => Fail ? Task.FromException<string>(new InvalidOperationException("firebase: not signed in")) : Task.FromResult("tok");
    }

    const string PlayerJson = "{\"id\":\"p1\",\"wallet\":{\"paid\":0,\"free\":1000,\"total\":1000,\"debt\":0}," +
        "\"season\":{\"id\":\"2026-10\",\"classId\":\"C\",\"points\":0},\"items\":{\"gacha_ticket\":2}," +
        "\"horses\":[{\"id\":\"h1\",\"name\":\"アカツキ\",\"rarity\":\"SR\",\"status\":\"active\",\"named\":true}]," +
        "\"equipment\":{\"tack\":{},\"decor\":[]}}";

    const string CosmeticsJson = "{\"decorSlots\":3,\"equipment\":{\"tack\":{},\"decor\":[]},\"items\":[" +
        "{\"id\":\"tack_bridle_classic\",\"name\":\"クラシック頭絡\",\"kind\":\"tack\",\"slot\":\"bridle\",\"asset\":\"tack/bridle_classic\",\"price\":300,\"owned\":false,\"equipped\":false}," +
        "{\"id\":\"decor_stable_plaque\",\"name\":\"厩舎の表札\",\"kind\":\"decor\",\"asset\":\"decor/stable_plaque\",\"price\":200,\"owned\":true,\"equipped\":false}]}";

    static HttpResponse Ok(string body) => new HttpResponse(200, body);
    static HttpResponse Err(int status, string code) => new HttpResponse(status, "{\"error\":{\"code\":\"" + code + "\",\"message\":\"" + code.ToLowerInvariant() + "\"}}");

    static async Task<(GameBackend b, FakeServer s, FlakyTokens t, MemoryKeyValueStore kv)> Online(RulesetParams ruleset)
    {
        var s = new FakeServer();
        s.Routes["POST /v1/player/bootstrap"] = _ => Ok(PlayerJson);
        s.Routes["GET /v1/player"] = _ => Ok(PlayerJson);
        var t = new FlakyTokens();
        var api = new ApiClient(s, t, new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var kv = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake", MatchPollMs = 10, MatchTimeoutMs = 2000 }, api, null, kv, ruleset);
        await b.InitializeAsync();
        return (b, s, t, kv);
    }

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset, string root)
    {
        // #1 token acquisition failure during ranked entry: an error result, nothing sent, never stuck on Matching.
        {
            var (b, s, t, _) = await Online(ruleset);
            check(b.Online, "fake server: bootstrap online");
            t.Fail = true;
            int before = s.Sent.Count;
            var entry = b.StartRankedAsync(null);
            var done = await Task.WhenAny(entry, Task.Delay(3000)) == entry;
            var (d, message) = done ? entry.Result : (null, null);
            check(done && d == null && message != null && message.StartsWith("NETWORK"), "ranked entry with a failing sign-in token returns a NETWORK error, not an escaped exception (" + message + ")");
            check(!s.Sent.Skip(before).Any(r => r.Path == "/v1/match/enqueue"), "…and no unauthenticated enqueue was sent");
            bool typed = false;
            try { await b.Api.GetPlayerAsync(); } catch (NetworkException) { typed = true; } catch (Exception) { }
            check(typed, "ApiClient maps a non-API token provider failure to NetworkException (screens' offline paths catch it)");
        }

        // #3 room conditions keep the day's ground until the player picks one; #9 dirt courses keep dirt going names.
        {
            var kv = new MemoryKeyValueStore();
            var off = new GameBackend(new GameSettings { OfflineOnly = true }, null, null, kv, ruleset);
            await off.InitializeAsync();
            var room = new RoomConditionsModel(off, kv);
            await room.LoadAsync();
            check(room.GroundAuto && room.ToConditions().Going == null, "room conditions: ground is automatic by default (going null)");
            room.Weather = 3; room.Wind = 2;
            check(room.ToConditions().Going == null, "…changing weather / wind keeps the automatic ground");
            await room.SaveAsync();
            var again = new RoomConditionsModel(off, kv);
            await again.LoadAsync();
            check(again.GroundAuto && again.ToConditions().Going == null, "…and it stays automatic after a reload");
            again.SelectGround(2);
            check(!again.GroundAuto && again.ToConditions().Going == "yielding", "picking SOFT sends going=yielding on turf");
            again.TrackId = "aoba_dirt_1400";
            check(again.ToConditions().Going == "muddy", "…and going=muddy on a dirt course");
            await again.ResetAsync();
            check(again.GroundAuto && again.ToConditions().Going == null, "reset → automatic ground again");

            var (b, s, _, kv2) = await Online(ruleset);
            string room1 = "{\"room\":{\"trackId\":\"minato_dirt_1800\",\"going\":\"sloppy\",\"night\":null,\"weather\":\"rain\",\"temperatureC\":14,\"windKmh\":0}}";
            string lastPut = null;
            s.Routes["GET /v1/presets"] = _ => Ok(room1);
            s.Routes["PUT /v1/presets/room"] = r => { lastPut = r.Body; return Ok("{\"room\":" + r.Body + "}"); };
            var dirt = new RoomConditionsModel(b, kv2);
            await dirt.LoadAsync();
            await dirt.SaveAsync();
            check(lastPut != null && lastPut.Contains("\"going\":\"sloppy\"") && dirt.ToConditions().Going == "sloppy", "a dirt room (sloppy) loaded and saved keeps going=sloppy, not the turf name (" + lastPut + ")");
            s.Routes["GET /v1/presets"] = _ => Ok("{\"room\":{\"trackId\":null,\"going\":null,\"night\":null,\"weather\":\"cloudy\",\"temperatureC\":18,\"windKmh\":5}}");
            await dirt.LoadAsync();
            await dirt.SaveAsync();
            check(lastPut != null && lastPut.Contains("\"going\":null"), "a server room with automatic ground saves back going=null (" + lastPut + ")");
        }

        // #4 purchases / equips apply the server's answer at once; #6 any API failure shows the offline wardrobe.
        {
            var (b, s, _, _) = await Online(ruleset);
            var items = new ItemsBackend(b);
            s.Routes["GET /v1/shop/cosmetics"] = _ => Err(500, "INTERNAL");
            var w0 = await items.WardrobeAsync();
            check(w0.LocalOnly && w0.Items.Count == ItemsBackend.OfflinePreview.Length, "wardrobe falls back to the preview on a 5xx, not only on a network error");
            s.Routes["GET /v1/shop/cosmetics"] = _ => Err(401, "UNAUTHORIZED");
            check((await items.WardrobeAsync()).LocalOnly, "…and on an auth error");

            s.Routes["GET /v1/shop/cosmetics"] = _ => Ok(CosmeticsJson);
            var w = await items.WardrobeAsync();
            check(!w.LocalOnly && w.Items.Count == 2, "wardrobe loads from the fake server");
            s.Routes["POST /v1/shop/cosmetics/tack_bridle_classic/buy"] = _ => Ok("{\"itemId\":\"tack_bridle_classic\",\"spent\":{\"paid\":0,\"free\":300},\"wallet\":{\"paid\":0,\"free\":700,\"total\":700,\"debt\":0}}");
            s.Routes["GET /v1/player"] = _ => Err(503, "INTERNAL");
            var buy = await items.BuyAsync("tack_bridle_classic");
            check(buy.Ok, "a purchase that succeeded stays a success when the follow-up refresh fails (" + buy.Message + ")");
            check(b.Player.Wallet.Free == 700 && w.FreeCoins == 700, "…the returned wallet is shown at once (700 free)");
            check(w.Items.First(i => i.Id == "tack_bridle_classic").Owned, "…and the item is marked owned");
            s.Routes["PUT /v1/player/equipment"] = _ => Ok("{\"equipment\":{\"tack\":{\"bridle\":\"tack_bridle_classic\"},\"decor\":[\"decor_stable_plaque\",null,null]}}");
            s.Routes["GET /v1/player"] = _ => throw new IOException("offline");
            var eq = await items.EquipTackAsync("bridle", "tack_bridle_classic");
            check(eq.Ok && b.Player.Equipment.Tack.TryGetValue("bridle", out var br) && br == "tack_bridle_classic", "equipping applies the returned equipment to the player view");
            check(w.Items.First(i => i.Id == "tack_bridle_classic").Equipped && w.Items.First(i => i.Id == "decor_stable_plaque").Equipped, "…and marks the wardrobe rows equipped");
        }

        // #5 ticket use: one idempotency key per (item, banner) until a definite answer, kept across restarts.
        {
            var (b, s, _, kv) = await Online(ruleset);
            var keys = new List<string>();
            int mode = 0; // 0 = connection drops, 1 = success, 2 = INSUFFICIENT_ITEMS
            s.Routes["POST /v1/items/tickets/gacha_ticket/use"] = r =>
            {
                keys.Add(r.Headers.TryGetValue("idempotency-key", out var k) ? k : null);
                if (mode == 0) throw new IOException("timeout");
                if (mode == 2) return Err(409, "INSUFFICIENT_ITEMS");
                return Ok("{\"itemId\":\"gacha_ticket\",\"bannerId\":\"standard\",\"result\":{\"templateId\":\"t1\",\"rarity\":\"R\",\"horseId\":\"h2\"},\"remaining\":1}");
            };
            check(!(await new ItemsBackend(b).UseTicketAsync(ItemsBackend.GachaTicket, "standard")).Ok, "ticket use with a dropped connection reports an error");
            check(kv.Get(ItemsBackend.TicketKeyFor(ItemsBackend.GachaTicket, "standard")) == keys[0], "…and keeps its idempotency key on the device");
            mode = 1;
            var ok = await new ItemsBackend(b).UseTicketAsync(ItemsBackend.GachaTicket, "standard"); // a new screen / app restart
            check(ok.Ok && keys.Count == 2 && keys[1] == keys[0], "the retry (even after a restart) reuses the same key, so one ticket is used (" + ok.Message + ")");
            check(string.IsNullOrEmpty(kv.Get(ItemsBackend.TicketKeyFor(ItemsBackend.GachaTicket, "standard"))), "…and the key is cleared after success");
            await new ItemsBackend(b).UseTicketAsync(ItemsBackend.GachaTicket, "standard");
            check(keys.Count == 3 && keys[2] != keys[0], "the next ticket use gets a fresh key");
            mode = 2;
            var no = await new ItemsBackend(b).UseTicketAsync(ItemsBackend.GachaTicket, "standard");
            check(!no.Ok && no.Message.StartsWith("INSUFFICIENT_ITEMS") && string.IsNullOrEmpty(kv.Get(ItemsBackend.TicketKeyFor(ItemsBackend.GachaTicket, "standard"))), "a definite 4xx rejection clears the key");
            check(ItemsBackend.TicketKeyFor("gacha_ticket", "standard") != ItemsBackend.TicketKeyFor("gacha_ticket", "event"), "keys are per banner");
        }

        // #8 the leaderboard asks for the current season, not the cached player's season id.
        {
            var (b, s, _, _) = await Online(ruleset);
            s.Routes["GET /v1/leaderboards/me"] = _ => Ok("{}");
            s.Routes["GET /v1/leaderboards/current/class-C"] = _ => Ok("{\"entries\":[]}");
            var lb = new LeaderboardModel(b);
            await lb.LoadAsync();
            check(b.Player.SeasonId == "2026-10" && s.Saw("GET /v1/leaderboards/current/class-C") && !s.Sent.Any(r => r.Path.Contains("2026-10")), "leaderboard requests season \"current\" (cached player season 2026-10 is not used)");
            check(lb.Online, "…and loads it");
        }

        // #7 Firebase startup wiring (the MUCHI_FIREBASE build is type-checked by unity/Checks~/UnityFirebase).
        {
            string app = File.ReadAllText(Path.Combine(root, "unity", "Assets", "Muchi", "Runtime", "MuchiApp.cs"));
            int prepare = app.IndexOf("MuchiFirebase.Prepare()", StringComparison.Ordinal), create = app.IndexOf("MuchiServices.Create()", StringComparison.Ordinal);
            check(prepare >= 0 && create > prepare, "MuchiApp sets MuchiServices.FirebaseTokens (MuchiFirebase.Prepare) before creating the backend");
            check(app.Contains("MuchiFirebase.InitializeAsync()"), "MuchiApp waits for Firebase dependencies before bootstrap");
        }
    }
}
