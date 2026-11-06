// Regression checks for the Round 7 client QA findings: stale league tables after a failed reload, retries after a lost
// reply (tournament withdrawal, stud unlisting), the previewed stud fee (FEE_CHANGED) and rider controls while
// spectating. A routed fake server stands in for the API; no network.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;
using Muchi.Net;

static class QaRound7Checks
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
    }
    sealed class Tokens : IAuthTokenProvider { public Task<string> GetTokenAsync(bool f, CancellationToken ct) => Task.FromResult("tok"); }

    /// <summary>A room that answers hello with a spectator start (you = -1).</summary>
    sealed class SpectatorRoom : ITransportFactory
    {
        private readonly string _start;
        public readonly List<string> Sent = new List<string>();
        public SpectatorRoom(string start) { _start = start; }
        public IConnection Open(string url, Action onOpen, Action<string> onMessage, Action onClosed)
        {
            var c = new Conn(this, onMessage);
            onOpen();
            return c;
        }
        sealed class Conn : IConnection
        {
            private readonly SpectatorRoom _r; private readonly Action<string> _m;
            public Conn(SpectatorRoom r, Action<string> m) { _r = r; _m = m; }
            public void Send(string message) { _r.Sent.Add(message); if (message.Contains("\"t\":\"hello\"")) _m(_r._start); }
            public void Close() { }
        }
    }

    const string Horses = "[{\"id\":\"h1\",\"name\":\"アカツキ\",\"rarity\":\"SR\",\"sex\":\"female\",\"status\":\"retired\",\"named\":true},"
        + "{\"id\":\"h2\",\"name\":\"クロガネ\",\"rarity\":\"SR\",\"sex\":\"male\",\"status\":\"retired\",\"named\":true},"
        + "{\"id\":\"h3\",\"name\":\"ナツ\",\"rarity\":\"R\",\"sex\":\"male\",\"status\":\"active\",\"named\":true}]";
    const string PlayerJson = "{\"id\":\"p1\",\"wallet\":{\"paid\":0,\"free\":500,\"total\":500,\"debt\":0},\"season\":{\"id\":\"2026-11\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":" + Horses + ",\"equipment\":{\"tack\":{},\"decor\":[]}}";
    const string Listing = "{\"ownerId\":\"o\",\"ownerName\":\"騎手O\",\"horseId\":\"h7\",\"name\":\"ギンガノカナタ\",\"rarity\":\"SSR\",\"line\":\"hoshi\",\"style\":\"senko\",\"visibility\":\"friends\",\"fee\":50,\"dailyLimit\":2,\"listedAt\":1}";
    const string MyListing = "{\"ownerId\":\"p1\",\"ownerName\":\"ME\",\"horseId\":\"h2\",\"name\":\"クロガネ\",\"rarity\":\"SR\",\"line\":\"kaze\",\"style\":\"nige\",\"visibility\":\"friends\",\"fee\":10,\"dailyLimit\":1,\"listedAt\":1}";
    const string Today = "\"today\":{\"perDay\":1,\"used\":0,\"extraPerDay\":1,\"extraUsed\":0,\"materialItemId\":\"breeding_material\",\"materialCost\":1,\"materialOwned\":0}";
    static string Mine(bool listed) => "{\"listings\":[" + (listed ? MyListing : "") + "],\"today\":{\"earned\":0,\"earnCap\":300,\"borrowed\":0,\"borrowPerDay\":2},\"limits\":{\"feeMax\":100,\"dailyLimitMax\":3,\"maxListings\":3},\"pendingPayments\":0,\"history\":[]}";
    const string LeagueJson = "{\"teamId\":\"t1\",\"season\":\"2026-11\",\"divisionId\":\"d2\",\"divisionName\":\"二部\",\"divisions\":[{\"id\":\"d1\",\"name\":\"一部\",\"tier\":1},{\"id\":\"d2\",\"name\":\"二部\",\"tier\":2}],"
        + "\"row\":null,\"place\":2,\"currentWeek\":1,\"table\":[{\"teamId\":\"t0\",\"name\":\"A\",\"place\":1},{\"teamId\":\"t1\",\"name\":\"B\",\"place\":2}],\"matches\":[],\"final\":null}";
    const string BoardJson = "{\"seasonId\":\"2026-11\",\"board\":\"league-d1\",\"divisionId\":\"d1\",\"divisionName\":\"一部\",\"generatedAt\":1,\"total\":1,\"currentWeek\":1,\"final\":false,\"entries\":[{\"teamId\":\"x\",\"name\":\"X\",\"place\":1}],\"weeks\":[]}";

    static HttpResponse Ok(string body) => new HttpResponse(200, body);
    static HttpResponse Err(int status, string code) => new HttpResponse(status, "{\"error\":{\"code\":\"" + code + "\",\"message\":\"" + code.ToLowerInvariant() + "\"}}");

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        var s = new FakeServer();
        s.Routes["POST /v1/player/bootstrap"] = _ => Ok(PlayerJson);
        s.Routes["GET /v1/player"] = _ => Ok(PlayerJson);
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var kv = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, ruleset);
        await b.InitializeAsync();

        // 6. league: a failed reload must not keep showing the previous table / another division's board
        bool leagueUp = true;
        s.Routes["GET /v1/league/me"] = _ => leagueUp ? Ok(LeagueJson) : Err(503, "INTERNAL");
        s.Routes["GET /v1/leaderboards/current/league-d1"] = _ => leagueUp ? Ok(BoardJson) : Err(503, "INTERNAL");
        var league = new LeagueModel(b);
        await league.LoadAsync();
        await league.DivisionAsync("d1");
        check(league.Online && league.InLeague && league.Headline.StartsWith("二部") && league.Board?.DivisionId == "d1", "league: loads my table and another division's board");
        leagueUp = false;
        await league.LoadAsync();
        check(!league.Online && league.Mine == null && league.Board == null, "league: a failed reload clears Mine and Board (no stale table)");
        check(league.Headline == league.Message && !string.IsNullOrEmpty(league.Message) && !league.Headline.Contains("二部"), "league: the headline shows the error message");
        leagueUp = true;
        await league.LoadAsync();
        await league.DivisionAsync("d1");
        leagueUp = false;
        var div = await league.DivisionAsync("d1");
        check(!div.Ok && league.Board == null, "league: a failed division reload clears the board");

        // 8a. tournament withdrawal retried after a lost reply: removed:false is the outcome asked for
        s.Routes["POST /v1/tournaments/cup/unregister"] = _ => Ok("{\"removed\":false}");
        var t = new TournamentsBackend(b);
        var un = await t.UnregisterAsync("cup");
        check(un.Ok && un.Message.Contains("取り消し"), "tournament: withdrawing when already withdrawn is a success");
        s.Routes["POST /v1/tournaments/cup/unregister"] = _ => Ok("{\"removed\":true}");
        check((await t.UnregisterAsync("cup")).Ok, "tournament: withdrawal succeeds");

        // 8b. stud unlisting retried after a lost reply: NOT_FOUND is a success once the listing is gone
        bool listed = true;
        s.Routes["GET /v1/stud/browse?scope=friends"] = _ => Ok("{\"scope\":\"friends\",\"listings\":[" + Listing + "]}");
        s.Routes["GET /v1/stud/browse?scope=public"] = _ => Ok("{\"scope\":\"public\",\"listings\":[]}");
        s.Routes["GET /v1/stud/mine"] = _ => Ok(Mine(listed));
        var m = new BreedingModel(b, kv);
        await m.LoadAsync();
        check(m.Mine?.Listings.Count == 1, "stud: my listing shown");
        listed = false;
        s.Routes["DELETE /v1/stud/listings/h2"] = _ => Err(404, "NOT_FOUND");
        var unlist = await m.UnlistMyStallionAsync("h2");
        check(unlist.Ok && m.Mine.Listings.Count == 0, "stud: unlisting an already removed stallion succeeds and refreshes Mine");
        listed = true;
        var still = await m.UnlistMyStallionAsync("h2");
        check(!still.Ok && m.Mine.Listings.Count == 1, "stud: NOT_FOUND while the listing is still there stays an error");

        // 11. stud breeding sends the previewed fee; FEE_CHANGED asks for a new preview
        s.Routes["POST /v1/stud/preview"] = _ => Ok("{\"stats\":{},\"nick\":false,\"inbreedingCount\":0,\"styles\":{},\"distance\":{\"minM\":1400,\"maxM\":2400},\"surface\":\"turf\",\"goingAptitude\":{\"any\":1000},\"atavism\":{\"chancePermille\":0,\"candidates\":[]}," + Today
            + ",\"stud\":{\"ownerId\":\"o\",\"horseId\":\"h7\",\"name\":\"ギンガノカナタ\",\"fee\":50,\"feeCurrency\":\"free\",\"remainingToday\":2,\"borrowed\":0,\"borrowPerDay\":2,\"canPay\":true,\"heldFree\":90}}");
        s.Routes["POST /v1/stud/breed"] = _ => Err(409, BreedingModel.FeeChanged);
        m.SelectSire(m.Sires.First(x => x.IsStud).Key); m.SelectDam("h1");
        await m.PreviewAsync();
        check(m.HeldFreeNote != null && m.HeldFreeNote.Contains("90日間") && m.HeldFreeNote.Contains("◎90"), "stud preview: held purchase-bonus coins are explained");
        var bred = await m.BreedAsync();
        var breedReq = s.Sent.Last(r => r.Path == "/v1/stud/breed");
        check(breedReq.Body.Contains("\"expectedFee\":50"), "stud breed sends the previewed fee (expectedFee)");
        check(!bred.Ok && bred.Message == BreedingModel.FeeChangedMessage && m.Preview == null && m.Offer == null && m.Step == 0, "stud breed: FEE_CHANGED shows a friendly message and asks for a new preview");
        check(kv.Get(BreedingModel.KeyPending + ":" + m.Sire.Key + ":h1") == null, "stud breed: FEE_CHANGED drops the pending key (nothing was charged)");
        await api.StudBreedAsync("o", "h7", "h1", "k1").ContinueWith(_ => { });
        check(!s.Sent.Last(r => r.Path == "/v1/stud/breed").Body.Contains("expectedFee"), "stud breed: no expectedFee unless given (older servers)");

        // 9. spectating: no rider controls, the driver ignores input
        var cfg = RaceFactory.Tutorial(ruleset);
        var start = JsonNode.Obj();
        start.Set("t", "start"); start.Set("you", -1); start.Set("startAtMs", 0); start.Set("config", ProtocolCodec.ConfigToJson(cfg));
        var room = new SpectatorRoom(start.ToString());
        var spec = new OnlineRaceDriver(new SpectatorSession(room, "wss://x", new SpectatorTicket { RaceId = cfg.RaceId, Ticket = "spec" }).Session);
        for (long now = 0; now <= 200; now += 50) spec.Update(now);
        var hud = HudModel.Build(spec, 200);
        check(spec.Sim != null && spec.PlayerSlot < 0 && !hud.RiderControls, "spectating: rider controls (SPUR / REIN / lanes) are hidden");
        var tut = b.CreateTutorialRace();
        tut.Update(0);
        check(HudModel.Build(tut, 0).RiderControls, "riding: rider controls are shown");
        spec.Dispose();
    }
}
