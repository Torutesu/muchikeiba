// Tournament + spectator end to end (REQ-TOUR-*, REQ-SPEC-*): an operator creates a mini tournament over the admin API
// (4 players, heats of 2, 1 advances → 2 heats + a final); four bots register, wait for their heat in
// /v1/tournaments/:id/me and race it over the real WebSocket; a fifth bot watches the first heat as a read-only
// spectator (delayed stream) and must end with the same final hash as the players. Then standings and the winner's
// prize/history are checked.
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Muchi.Engine;
using Muchi.Net;

sealed class TournamentReport
{
    public bool ok { get; set; }
    public string tournamentId { get; set; }
    public List<object> heats { get; set; } = new();
    public string spectatedRaceId { get; set; }
    public string spectatorLocalHash { get; set; }
    public string spectatorFinalHash { get; set; }
    public int spectatorDelayMs { get; set; }
    public int spectatorSent { get; set; }
    public List<string> standings { get; set; } = new();
    public string status { get; set; }
    public List<string> problems { get; set; } = new();
}

static class TournamentScenario
{
    public static async Task<TournamentReport> RunAsync(string baseUrl)
    {
        var rep = new TournamentReport();
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        string id = "it_" + (now % 100_000_000);
        rep.tournamentId = id;
        var admin = new HttpClient { BaseAddress = new Uri(baseUrl), Timeout = TimeSpan.FromSeconds(30) };
        admin.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", "dev-admin");
        long closes = now + 15_000;
        var def = new
        {
            id, name = "結合テスト杯", trackIds = new[] { "aoba_dirt_1400" },
            registrationOpensAtMs = now - 1_000, registrationClosesAtMs = closes, startsAtMs = closes + 35_000,
            heatSize = 2, fieldSize = 4, advancePerHeat = 1, maxEntrants = 8, minEntrants = 2,
            roundGapMs = 30_000, notifyBeforeMs = 60_000,
            prizes = new object[] { new { maxRank = 1, reward = new { freeCoins = 100 } } },
        };
        var cr = await admin.PostAsync("/v1/admin/tournaments", JsonContent.Create(new { tournament = def, reason = "integration test" }));
        if (!cr.IsSuccessStatusCode) { rep.problems.Add($"create: {(int)cr.StatusCode} {await cr.Content.ReadAsStringAsync()}"); return rep; }

        var bots = Enumerable.Range(0, 4).Select(i => new Bot(baseUrl, $"bot_tour_{now}_{i}")).ToArray();
        foreach (var b in bots) await b.SetupAsync();
        foreach (var b in bots)
        {
            var r = await b.PostAsync($"/v1/tournaments/{id}/register", new { horseId = b.HorseId });
            if (!r.GetProperty("registered").GetBoolean()) rep.problems.Add("not registered: " + b.Report.user);
        }
        var listed = await bots[0].GetJsonAsync("/v1/tournaments");
        if (!listed.GetProperty("tournaments").EnumerateArray().Any(t => t.GetProperty("id").GetString() == id && t.GetProperty("entrants").GetInt32() == 4)) rep.problems.Add("tournament not listed with 4 entrants");

        var watcher = new Bot(baseUrl, $"bot_tour_{now}_watch");
        await watcher.SetupAsync();
        var spectate = SpectateFirstHeatAsync(watcher, id, rep);

        var heatHashes = new Dictionary<string, HashSet<string>>();
        var results = await Task.WhenAll(bots.Select(b => RideAsync(b, id, rep, heatHashes)));
        await spectate;

        // the spectator saw exactly the players' race
        if (rep.spectatedRaceId == null) rep.problems.Add("spectator never found a heat");
        else
        {
            if (rep.spectatorFinalHash == null || rep.spectatorFinalHash != rep.spectatorLocalHash) rep.problems.Add($"spectator final {rep.spectatorFinalHash} != its own simulation {rep.spectatorLocalHash}");
            lock (heatHashes)
            {
                if (!heatHashes.TryGetValue(rep.spectatedRaceId, out var hs) || !hs.SetEquals(new[] { rep.spectatorLocalHash })) rep.problems.Add("spectator hash differs from the players' hash");
            }
            if (rep.spectatorDelayMs != 10_000) rep.problems.Add("tournament heats should stream 10 s behind, got " + rep.spectatorDelayMs);
            if (rep.spectatorSent != 1) rep.problems.Add($"spectator sent {rep.spectatorSent} messages (only hello allowed)");
        }

        // standings + prize
        JsonElement detail = default;
        for (int i = 0; i < 60; i++)
        {
            detail = await bots[0].GetJsonAsync($"/v1/tournaments/{id}");
            rep.status = detail.GetProperty("status").GetString();
            if (rep.status == "finished") break;
            await Task.Delay(1000);
        }
        if (rep.status != "finished") rep.problems.Add("tournament did not finish: " + rep.status);
        int heatsPlayed = detail.GetProperty("rounds").EnumerateArray().Sum(r => r.GetProperty("heats").GetArrayLength());
        if (heatsPlayed != 3) rep.problems.Add($"expected 2 heats + final, got {heatsPlayed} heats");
        if (detail.TryGetProperty("standings", out var st) && st.ValueKind == JsonValueKind.Array)
        {
            foreach (var s in st.EnumerateArray()) rep.standings.Add($"{s.GetProperty("rank").GetInt32()}:{s.GetProperty("playerId").GetString()}");
            var winner = st.EnumerateArray().First();
            var wb = bots.First(b => b.Report.user == winner.GetProperty("playerId").GetString());
            var hist = await wb.GetJsonAsync("/v1/tournaments/history/me");
            var h = hist.GetProperty("history").EnumerateArray().FirstOrDefault(x => x.GetProperty("tournamentId").GetString() == id);
            if (h.ValueKind != JsonValueKind.Object || h.GetProperty("rank").GetInt32() != 1 || h.GetProperty("reward").GetProperty("freeCoins").GetInt32() != 100) rep.problems.Add("winner's prize/history missing");
            if (rep.standings.Count != 4) rep.problems.Add("standings should list 4 players");
        }
        else rep.problems.Add("no standings");
        if (results.Any(r => !r)) rep.problems.Add("a heat did not confirm with the players' own hash");
        rep.ok = rep.problems.Count == 0;
        return rep;
    }

    /// <summary>Wait for each heat of this bot (via /me), race it, until eliminated or the tournament is decided.</summary>
    static async Task<bool> RideAsync(Bot b, string id, TournamentReport rep, Dictionary<string, HashSet<string>> heatHashes)
    {
        var played = new HashSet<string>();
        bool ok = true;
        var deadline = DateTime.UtcNow.AddMinutes(8);
        while (DateTime.UtcNow < deadline)
        {
            var me = await b.GetJsonAsync($"/v1/tournaments/{id}/me");
            if (me.GetProperty("standing").ValueKind == JsonValueKind.Object || me.GetProperty("eliminated").GetBoolean()) return ok;
            var heat = me.GetProperty("heat");
            if (heat.ValueKind == JsonValueKind.Object && heat.GetProperty("assignment").ValueKind == JsonValueKind.Object && !played.Contains(heat.GetProperty("heatId").GetString()))
            {
                played.Add(heat.GetProperty("heatId").GetString());
                b.Report.statuses.Clear();
                await b.PlayAsync(heat.GetProperty("assignment"));
                bool good = b.Report.status == "confirmed" && b.Report.serverHash == b.Report.localHash && b.Report.desyncs == 0;
                ok &= good;
                lock (heatHashes)
                {
                    if (!heatHashes.TryGetValue(b.Report.raceId, out var hs)) heatHashes[b.Report.raceId] = hs = new HashSet<string>();
                    hs.Add(b.Report.localHash);
                    rep.heats.Add(new { user = b.Report.user, raceId = b.Report.raceId, heat = heat.GetProperty("heatId").GetString(), status = b.Report.status, b.Report.localHash, b.Report.serverHash, good });
                }
                continue;
            }
            await Task.Delay(1000);
        }
        rep.problems.Add("timed out waiting for the tournament: " + b.Report.user);
        return false;
    }

    sealed class CountingTransport : ITransport
    {
        private readonly ClientWebSocket _ws;
        public int Sent;
        public CountingTransport(ClientWebSocket ws) { _ws = ws; }
        public void Send(string message)
        {
            Sent++;
            _ws.SendAsync(Encoding.UTF8.GetBytes(message), WebSocketMessageType.Text, true, CancellationToken.None).GetAwaiter().GetResult();
        }
    }

    /// <summary>Find the first running heat (bracket or live list), take a spectator ticket and watch it to the end.</summary>
    static async Task SpectateFirstHeatAsync(Bot w, string id, TournamentReport rep)
    {
        string raceId = null;
        for (int i = 0; i < 120 && raceId == null; i++)
        {
            var live = await w.GetJsonAsync("/v1/races/live");
            foreach (var r in live.GetProperty("featured").EnumerateArray())
                if (r.TryGetProperty("tournamentId", out var t) && t.ValueKind == JsonValueKind.String && t.GetString() == id) { raceId = r.GetProperty("raceId").GetString(); break; }
            if (raceId == null) await Task.Delay(1000);
        }
        if (raceId == null) return;
        rep.spectatedRaceId = raceId;
        var ticket = await w.PostAsync($"/v1/race/{raceId}/spectate", new { });
        using var ws = new ClientWebSocket();
        string baseUrl = w.BaseUrl;
        await ws.ConnectAsync(new Uri(baseUrl.Replace("http://", "ws://").Replace("https://", "wss://") + ticket.GetProperty("wsPath").GetString()), CancellationToken.None);
        var transport = new CountingTransport(ws);
        var client = new LockstepClient(transport, raceId, ticket.GetProperty("ticket").GetString());
        var done = new TaskCompletionSource();
        client.RaceFinal += (c, f) => { if (f.Status != FinalStatus.Verifying) done.TrySetResult(); };
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
        var winner = await Task.WhenAny(done.Task, Task.Delay(TimeSpan.FromSeconds(240)));
        if (winner != done.Task) rep.problems.Add("spectator timed out; errors: " + string.Join(",", client.Errors));
        try { await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None); } catch { }
        rep.spectatorDelayMs = client.SpectatorDelayMs;
        rep.spectatorLocalHash = client.Sim?.Result?.Hash;
        rep.spectatorFinalHash = client.Final?.Hash;
        rep.spectatorSent = transport.Sent;
        if (!client.IsSpectator) rep.problems.Add("room did not treat the watcher as a spectator");
    }
}
