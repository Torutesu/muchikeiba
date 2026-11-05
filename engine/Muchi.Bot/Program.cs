// Muchi.Bot — headless player for cross-language integration tests.
// Plays real races against the TypeScript server (wrangler dev, DEV_MODE=1) over a real WebSocket,
// using the same LockstepClient + RaceSim the Unity app uses.
//
// usage: Muchi.Bot <baseUrl> tutorial
//        Muchi.Bot <baseUrl> ranked <players>
// Prints one JSON line per bot and exits 0 only if every bot ends with a confirmed result whose
// hash equals the hash its own simulation produced.
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Muchi.Engine;
using Muchi.Net;

if (args.Length < 2) { Console.Error.WriteLine("usage: Muchi.Bot <baseUrl> tutorial | ranked <players> | event <players> | timeattack"); return 2; }
string baseUrl = args[0].TrimEnd('/');
string mode = args[1];
int players = (mode == "ranked" || mode == "event") && args.Length >= 3 ? int.Parse(args[2]) : 1;

var bots = Enumerable.Range(0, players).Select(i => new Bot(baseUrl, $"bot_{mode}_{DateTime.UtcNow.Ticks}_{i}")).ToArray();
foreach (var b in bots) await b.SetupAsync();

if (mode == "timeattack")
{
    var ta = await TimeAttackScenario.RunAsync(bots[0]);
    Console.WriteLine(JsonSerializer.Serialize(ta));
    return ta.ok ? 0 : 1;
}

const string EventId = "sprint_cup_2026_11";
if (mode == "team")
{
    // REQ-TEAM-*: TeamDO + TeamDirectoryDO + LeaderboardDO over real Durable Objects (no race needed)
    var problems = new List<string>();
    var lead = bots[0];
    var created = await lead.PostAsync("/v1/teams", new { name = $"結合{DateTime.UtcNow.Ticks % 100000}", joinPolicy = "open", announcement = "テスト" });
    string teamId = created.GetProperty("teamId").GetString();
    var member = new Bot(baseUrl, $"bot_team_member_{DateTime.UtcNow.Ticks}");
    await member.SetupAsync();
    var joined = await member.PostAsync($"/v1/teams/{teamId}/join", new { });
    if (joined.GetProperty("status").GetString() != "joined") problems.Add("open join did not join");
    var me = await lead.GetJsonAsync("/v1/teams/me");
    if (me.GetProperty("team").GetProperty("members").GetArrayLength() != 2) problems.Add("member count");
    var search = await lead.GetJsonAsync("/v1/teams/search?q=" + Uri.EscapeDataString(created.GetProperty("name").GetString()));
    if (!search.EnumerateArray().Any(t => t.GetProperty("teamId").GetString() == teamId)) problems.Add("directory search did not find the team");
    await member.PostAsync("/v1/teams/me/leave", new { });
    var (st, body) = await member.SendRawAsync(HttpMethod.Post, $"/v1/teams/{teamId}/join", "{}");
    if (st != 409 || !body.Contains("TEAM_COOLDOWN")) problems.Add($"rejoin after leaving: {st} {body}");
    var (st2, body2) = await lead.SendRawAsync(HttpMethod.Post, "/v1/teams/me/leave", "{}");
    if (st2 != 200 || !body2.Contains("\"disbanded\":true")) problems.Add($"lone leader leave should disband: {st2} {body2}");
    Console.WriteLine(JsonSerializer.Serialize(new { ok = problems.Count == 0, teamId, problems }));
    return problems.Count == 0 ? 0 : 1;
}
if (mode == "tutorial")
{
    await bots[0].PlayAsync(await bots[0].PostAsync("/v1/race/tutorial", new { horseId = bots[0].HorseId }));
}
else if (mode == "event")
{
    // REQ-EVENT-*: free coins from the login bonus pay the (free-coin) entry fee; the event pool matches and
    // the room settles the race (a lone human is verified by the C# verifier, like ranked)
    foreach (var b in bots)
    {
        await b.PostAsync("/v1/rewards/login-bonus", new { });
        await b.RecordFreeCoinsBeforeEntryAsync();
        await b.PostAsync($"/v1/events/{EventId}/enqueue", new { horseId = b.HorseId });
    }
    var assignments = await Task.WhenAll(bots.Select(b => b.WaitMatchAsync()));
    await Task.WhenAll(bots.Select((b, i) => b.PlayAsync(assignments[i])));
    foreach (var b in bots) await b.CheckEventAsync(EventId);
}
else
{
    foreach (var b in bots) await b.PostAsync("/v1/match/enqueue", new { horseId = b.HorseId });
    var assignments = await Task.WhenAll(bots.Select(b => b.WaitMatchAsync()));
    await Task.WhenAll(bots.Select((b, i) => b.PlayAsync(assignments[i])));
}

bool ok = true;
foreach (var b in bots)
{
    Console.WriteLine(JsonSerializer.Serialize(b.Report));
    ok &= b.Report.status == "confirmed" && b.Report.serverHash == b.Report.localHash && b.Report.desyncs == 0;
    if (mode == "event") ok &= b.Report.eventPoints > 0 && b.Report.eventRaces == 1 && b.Report.problems.Count == 0;
}
return ok ? 0 : 1;

sealed class Report
{
    public string user { get; set; }
    public string raceId { get; set; }
    public int slot { get; set; }
    public int humans { get; set; }
    public string status { get; set; }
    public string localHash { get; set; }
    public string serverHash { get; set; }
    public int[] order { get; set; }
    public int desyncs { get; set; }
    public string[] errors { get; set; }
    public List<string> statuses { get; set; } = new();
    // event scenario
    public int eventPoints { get; set; }
    public int eventRaces { get; set; }
    public int freeCoins { get; set; }
    public List<string> problems { get; set; } = new();
}

sealed class Bot
{
    private readonly HttpClient _http;
    private readonly string _base;
    private int _idem;
    public string HorseId;
    public readonly Report Report = new();

    public Bot(string baseUrl, string user)
    {
        _base = baseUrl;
        _http = new HttpClient { BaseAddress = new Uri(baseUrl), Timeout = TimeSpan.FromSeconds(30) };
        // Deployed environments (staging smoke) have no DEV_MODE: authenticate with a real Firebase ID token
        // (the deploy workflow signs up an anonymous Firebase user and passes MUCHI_ID_TOKEN). Locally: x-dev-user.
        string idToken = Environment.GetEnvironmentVariable("MUCHI_ID_TOKEN");
        if (!string.IsNullOrEmpty(idToken)) _http.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", idToken);
        else _http.DefaultRequestHeaders.Add("x-dev-user", user);
        Report.user = user;
    }

    public async Task<JsonElement> PostAsync(string path, object body)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, path) { Content = JsonContent.Create(body) };
        req.Headers.Add("idempotency-key", $"k{_idem++}");
        var res = await _http.SendAsync(req);
        var text = await res.Content.ReadAsStringAsync();
        if (!res.IsSuccessStatusCode) throw new Exception($"POST {path} → {(int)res.StatusCode} {text}");
        return JsonDocument.Parse(text).RootElement.Clone();
    }

    /// <summary>
    /// After an event race: the settlement (applied by the race room after the final result) must have added
    /// event points, and the free-coin fee must have been consumed exactly once.
    /// </summary>
    private int _freeBeforeEntry = -1;

    public async Task RecordFreeCoinsBeforeEntryAsync()
    {
        var player = JsonDocument.Parse(await _http.GetStringAsync("/v1/player")).RootElement;
        _freeBeforeEntry = player.GetProperty("wallet").GetProperty("free").GetInt32();
    }

    public async Task CheckEventAsync(string eventId)
    {
        for (int i = 0; i < 30; i++)
        {
            var me = JsonDocument.Parse(await _http.GetStringAsync($"/v1/events/{eventId}/me")).RootElement;
            var ev = me.GetProperty("event");
            if (ev.ValueKind == JsonValueKind.Object && ev.TryGetProperty("me", out var p) && p.ValueKind == JsonValueKind.Object && p.GetProperty("races").GetInt32() > 0)
            {
                Report.eventPoints = p.GetProperty("points").GetInt32();
                Report.eventRaces = p.GetProperty("races").GetInt32();
                if (p.GetProperty("pending").GetBoolean()) Report.problems.Add("fee still held after the race");
                break;
            }
            await Task.Delay(500);
        }
        if (Report.eventRaces == 0) Report.problems.Add("event result was never applied");
        var player = JsonDocument.Parse(await _http.GetStringAsync("/v1/player")).RootElement;
        Report.freeCoins = player.GetProperty("wallet").GetProperty("free").GetInt32();
        // balance before entry − entry fee (30, master/events.json) + race coins for an event race (none);
        // read from the wallet instead of assuming the login-bonus amount, which is a tuning value
        int expected = _freeBeforeEntry - 30;
        if (Report.freeCoins != expected) Report.problems.Add($"free coins {Report.freeCoins}, expected {expected} ({_freeBeforeEntry} before entry − fee 30)");
    }

    public async Task<JsonElement> GetJsonAsync(string path) => JsonDocument.Parse(await _http.GetStringAsync(path)).RootElement.Clone();

    /// <summary>Raw request: status + body text (no throw), for checks on error responses.</summary>
    public async Task<(int status, string text)> SendRawAsync(HttpMethod method, string path, string jsonBody = null)
    {
        var req = new HttpRequestMessage(method, path);
        if (jsonBody != null) req.Content = new StringContent(jsonBody, Encoding.UTF8, "application/json");
        var res = await _http.SendAsync(req);
        return ((int)res.StatusCode, await res.Content.ReadAsStringAsync());
    }

    public async Task<JsonElement> GetAsync(string path)
    {
        var text = await _http.GetStringAsync(path);
        return JsonDocument.Parse(text).RootElement.Clone();
    }

    public async Task SetupAsync()
    {
        await PostAsync("/v1/player/bootstrap", new { });
        var tut = await PostAsync("/v1/gacha/tutorial", new { });
        foreach (var r in tut.GetProperty("results").EnumerateArray())
            if (r.TryGetProperty("horseId", out var h) && h.ValueKind == JsonValueKind.String) { HorseId = h.GetString(); break; }
        if (HorseId == null) throw new Exception("tutorial gacha gave no horse");
    }

    public async Task<JsonElement> WaitMatchAsync()
    {
        for (int i = 0; i < 60; i++)
        {
            var st = await GetAsync("/v1/match/status");
            if (st.GetProperty("state").GetString() == "matched") return st;
            await Task.Delay(1000);
        }
        throw new Exception("matchmaking timed out");
    }

    public async Task PlayAsync(JsonElement assignment)
    {
        string raceId = assignment.GetProperty("raceId").GetString();
        string ticket = assignment.GetProperty("ticket").GetString();
        string wsPath = assignment.GetProperty("wsPath").GetString();
        Report.raceId = raceId;

        using var ws = new ClientWebSocket();
        var wsUri = new Uri(_base.Replace("http://", "ws://").Replace("https://", "wss://") + wsPath);
        await ws.ConnectAsync(wsUri, CancellationToken.None);
        var transport = new WsTransport(ws);
        var client = new LockstepClient(transport, raceId, ticket);
        var done = new TaskCompletionSource();
        bool started = false, rested = false;
        int whips = 0, lastWhipTick = -100;

        client.RaceFinal += (c, f) =>
        {
            Report.statuses.Add(f.Status.ToString().ToLowerInvariant());
            if (f.Status != FinalStatus.Verifying) done.TrySetResult();
        };
        client.TicksAdvanced += (c, tick) =>
        {
            // A simple but non-trivial rider: start on the gate, hold the rein mid-race, whip in the stretch.
            var p = c.Config.Ruleset;
            var me = c.Sim.GetHorse(c.Slot);
            if (!started && tick >= p.GateOpenTick - 2) { started = true; c.QueueInput(Cmd.Start); }
            var left = c.Sim.Track.Distance - me.Distance;
            if (!rested && left < Fx.FromInt(1200) && left > Fx.FromInt(700)) { rested = true; c.QueueInput(Cmd.ReinPress); }
            if (rested && left <= Fx.FromInt(700) && whips == 0 && tick - lastWhipTick > 1) c.QueueInput(Cmd.ReinRelease);
            if (left <= Fx.FromInt(400) && whips < 6 && tick - lastWhipTick >= 24) { whips++; lastWhipTick = tick; c.QueueInput(Cmd.Whip); }
        };

        client.Connect();
        var recv = Task.Run(async () =>
        {
            var buf = new byte[1 << 16];
            var sb = new StringBuilder();
            while (ws.State == WebSocketState.Open && !done.Task.IsCompleted)
            {
                WebSocketReceiveResult r;
                try { r = await ws.ReceiveAsync(buf, CancellationToken.None); }
                catch (WebSocketException) { break; }
                if (r.MessageType == WebSocketMessageType.Close) break;
                sb.Append(Encoding.UTF8.GetString(buf, 0, r.Count));
                if (!r.EndOfMessage) continue;
                var msg = sb.ToString(); sb.Clear();
                lock (client) client.HandleMessage(msg, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            }
        });
        var winner = await Task.WhenAny(done.Task, Task.Delay(TimeSpan.FromSeconds(180)));
        if (winner != done.Task) Report.statuses.Add("timeout");
        try { await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None); } catch { }

        Report.slot = client.Slot;
        Report.humans = client.Config?.Entrants.Count(e => e.Kind == EntrantKind.Human) ?? 0;
        Report.localHash = client.Sim?.Result?.Hash;
        Report.serverHash = client.Final?.Hash;
        Report.order = client.Final?.Order;
        Report.status = Report.statuses.LastOrDefault();
        Report.desyncs = client.DesyncTicks.Count;
        Report.errors = client.Errors.ToArray();
    }
}

sealed class WsTransport : ITransport
{
    private readonly ClientWebSocket _ws;
    private readonly SemaphoreSlim _lock = new(1, 1);
    public WsTransport(ClientWebSocket ws) { _ws = ws; }
    public void Send(string message)
    {
        _lock.Wait();
        try { _ws.SendAsync(Encoding.UTF8.GetBytes(message), WebSocketMessageType.Text, true, CancellationToken.None).GetAwaiter().GetResult(); }
        finally { _lock.Release(); }
    }
}
