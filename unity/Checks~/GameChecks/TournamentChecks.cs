// Tournaments (REQ-TOUR-*) and spectating (REQ-SPEC-*) through the game layer: offline notices, list/bracket models,
// registration with the partner, joining a running heat and watching a race. A routed fake server; no network.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class TournamentChecks
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
    sealed class NoSockets : ITransportFactory
    {
        public int Opened;
        public string LastUrl;
        public IConnection Open(string url, Action onOpen, Action<string> onMessage, Action<int> onClosed) { Opened++; LastUrl = url; return new Conn(); }
        sealed class Conn : IConnection { public void Send(string m) { } public void Close() { } }
    }

    const string PlayerJson = "{\"id\":\"p1\",\"wallet\":{\"paid\":0,\"free\":10,\"total\":10,\"debt\":0},\"season\":{\"id\":\"2026-11\",\"classId\":\"C\",\"points\":0}," +
        "\"horses\":[{\"id\":\"h1\",\"name\":\"アカツキ\",\"rarity\":\"SR\",\"status\":\"active\",\"named\":true}]}";
    const string ListJson = "{\"tournaments\":[{\"id\":\"cup\",\"name\":\"霜月杯\",\"status\":\"registration\",\"registrationOpensAtMs\":1,\"registrationClosesAtMs\":2,\"startsAtMs\":3,\"entrants\":3,\"maxEntrants\":64,\"heatSize\":12,\"finishedAt\":null}," +
        "{\"id\":\"old\",\"name\":\"神無月杯\",\"status\":\"finished\",\"registrationOpensAtMs\":1,\"registrationClosesAtMs\":2,\"startsAtMs\":3,\"entrants\":40,\"maxEntrants\":64,\"heatSize\":12,\"finishedAt\":9}],\"generatedAt\":5}";
    const string DetailJson = "{\"id\":\"cup\",\"name\":\"霜月杯\",\"status\":\"running\",\"rounds\":[{\"index\":0,\"final\":false,\"startAtMs\":3,\"done\":false,\"heats\":[" +
        "{\"id\":\"0-0\",\"raceId\":\"r_1\",\"status\":\"finished\",\"startAtMs\":3,\"trackId\":\"aoba_dirt_1400\",\"players\":[{\"playerId\":\"a\",\"displayName\":\"A\"},{\"playerId\":\"b\",\"displayName\":\"B\"}]," +
        "\"results\":[{\"playerId\":\"b\",\"place\":1,\"noShow\":false,\"advanced\":true,\"displayName\":\"B\"},{\"playerId\":\"a\",\"place\":2,\"noShow\":true,\"advanced\":false,\"displayName\":\"A\"}]}," +
        "{\"id\":\"0-1\",\"raceId\":\"r_2\",\"status\":\"created\",\"startAtMs\":3,\"trackId\":\"aoba_dirt_1400\",\"players\":[{\"playerId\":\"p1\",\"displayName\":\"ME\"},{\"playerId\":\"c\",\"displayName\":\"C\"}],\"results\":null}]}],\"standings\":null}";
    const string MeJson = "{\"tournamentId\":\"cup\",\"status\":\"running\",\"registered\":true,\"horseId\":\"h1\",\"heat\":{\"round\":0,\"final\":false,\"heatId\":\"0-1\",\"raceId\":\"r_2\",\"startAtMs\":3,\"status\":\"created\",\"trackId\":\"aoba_dirt_1400\"," +
        "\"assignment\":{\"raceId\":\"r_2\",\"slot\":0,\"ticket\":\"tk\",\"startAtMs\":3,\"wsPath\":\"/v1/race/r_2/ws\"}},\"eliminated\":false,\"standing\":null,\"prize\":null,\"prizePaid\":false}";
    const string LiveJson = "{\"friends\":[{\"raceId\":\"r_f\",\"mode\":\"friend\",\"startAtMs\":5,\"trackId\":\"t\",\"visibility\":\"friends\",\"rating\":1500,\"delayMs\":0,\"title\":null,\"players\":2,\"friends\":[\"pal\"],\"you\":false}]," +
        "\"featured\":[{\"raceId\":\"r_2\",\"mode\":\"tournament\",\"startAtMs\":6,\"trackId\":\"t\",\"visibility\":\"public\",\"rating\":1700,\"delayMs\":10000,\"title\":\"霜月杯 1回戦 第2組\",\"tournamentId\":\"cup\",\"players\":2,\"friends\":[],\"you\":true}],\"generatedAt\":7}";

    static HttpResponse Ok(string body) => new HttpResponse(200, body);

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        // offline: both screens say so; nothing to join
        var off = new GameBackend(new GameSettings { OfflineOnly = true }, null, null, new MemoryKeyValueStore(), ruleset);
        await off.InitializeAsync();
        var ot = new TournamentsBackend(off);
        var ol = await ot.ListAsync();
        check(ol.LocalOnly && ol.Rows.Count == 0 && ol.Notice == TournamentsBackend.OfflineNotice, "tournaments offline: notice, no rows");
        check((await ot.LiveAsync()).LocalOnly && !(await ot.RegisterAsync("cup")).Ok && (await ot.WatchAsync("r_1")).driver == null, "offline: no live races, no registration, no watching");

        // online
        var s = new FakeServer();
        s.Routes["POST /v1/player/bootstrap"] = _ => Ok(PlayerJson);
        s.Routes["GET /v1/tournaments"] = _ => Ok(ListJson);
        s.Routes["GET /v1/tournaments/cup"] = _ => Ok(DetailJson);
        s.Routes["GET /v1/tournaments/cup/me"] = _ => Ok(MeJson);
        s.Routes["POST /v1/tournaments/cup/register"] = _ => Ok("{\"registered\":true,\"existing\":false,\"tournamentId\":\"cup\",\"status\":\"registration\",\"horseId\":\"h1\",\"heat\":null}");
        s.Routes["GET /v1/races/live"] = _ => Ok(LiveJson);
        s.Routes["POST /v1/race/r_2/spectate"] = _ => Ok("{\"raceId\":\"r_2\",\"ticket\":\"spec\",\"wsPath\":\"/v1/race/r_2/ws\",\"startAtMs\":6,\"delayMs\":10000,\"mode\":\"tournament\"}");
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var sockets = new NoSockets();
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, sockets, new MemoryKeyValueStore(), ruleset);
        await b.InitializeAsync();
        var t = new TournamentsBackend(b);
        var list = await t.ListAsync();
        check(list.Rows.Select(r => r.StatusLabel).SequenceEqual(new[] { "受付中", "終了" }) && list.Rows[0].CanRegister && !list.Rows[1].CanRegister, "tournament list: status chips, only open ones can be entered");
        var reg = await t.RegisterAsync("cup");
        var regReq = s.Sent.Last(r => r.Path == "/v1/tournaments/cup/register");
        check(reg.Ok && regReq.Body.Contains("\"horseId\":\"h1\""), "registration sends the partner horse");
        var d = await t.DetailAsync("cup");
        check(d.Heats.Count == 2 && d.Heats[0].Title == "1回戦 第1組" && d.Heats[1].Title == "1回戦 第2組", "bracket: heat titles");
        check(d.Heats[0].Lines[0] == "▶ 1着 B" && d.Heats[0].Lines[1] == "  2着 A（不参加）" && !d.Heats[0].Watchable, "bracket: finished heat shows places, advancers and no-shows");
        check(d.Heats[1].Watchable && d.Heats[1].Lines.SequenceEqual(new[] { "ME", "C" }), "bracket: a running heat is watchable");
        check(d.JoinNow != null && d.JoinNow.Ticket == "tk", "my running heat offers JOIN with its ticket");
        var (heat, msg) = await t.JoinHeatAsync("cup");
        check(heat != null && msg == null && heat.Online, "joining my running heat opens an online race driver");
        var live = await t.LiveAsync();
        check(live.Rows.Count == 2 && live.Rows[0].Friends && live.Rows[0].Subtitle.Contains("ライブ") && live.Rows[1].Title == "霜月杯 1回戦 第2組" && live.Rows[1].Subtitle.Contains("10秒遅れ"), "watch list: friends first (live), then featured (10 s delay)");
        var (watch, wmsg) = await t.WatchAsync("r_2");
        check(watch != null && wmsg == null && watch.Online, "watching opens a read-only race driver");
        check(TournamentsBackend.ModeLabel("tournament") == "大会" && TournamentsBackend.StatusLabel("paying") == "表彰中", "labels");
    }
}
