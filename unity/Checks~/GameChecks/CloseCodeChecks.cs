// Regression checks for the Round 7 leftover "spectator reconnect loop": the room closes an older socket of the same
// player with 4000 ("replaced"). The Unity WebSocket transport must hand that close code to RaceSession, which then
// stops (FailureReason "REPLACED") instead of reconnecting and replacing the newer socket in turn. Runs a real
// WebSocket server on 127.0.0.1 (HttpListener); no other network.
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;
using Muchi.Net;

static class CloseCodeChecks
{
    /// <summary>
    /// A one-room WebSocket server: answers hello with <c>start</c>, then closes the socket with
    /// <c>closeCode</c> (null = drop the TCP connection without a close frame). Counts the connections.
    /// </summary>
    sealed class Room : IDisposable
    {
        private readonly HttpListener _http = new HttpListener();
        private readonly CancellationTokenSource _cts = new CancellationTokenSource();
        private readonly string _start;
        private readonly int? _closeCode;
        public int Connections;
        public readonly string Url;

        public Room(string start, int? closeCode)
        {
            _start = start; _closeCode = closeCode;
            var probe = new TcpListener(IPAddress.Loopback, 0);
            probe.Start();
            int port = ((IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();
            _http.Prefixes.Add("http://127.0.0.1:" + port + "/");
            _http.Start();
            Url = "ws://127.0.0.1:" + port + "/race";
            _ = Task.Run(AcceptLoop);
        }

        private async Task AcceptLoop()
        {
            while (!_cts.IsCancellationRequested)
            {
                HttpListenerContext ctx;
                try { ctx = await _http.GetContextAsync(); } catch { return; }
                Interlocked.Increment(ref Connections);
                _ = Task.Run(() => Serve(ctx));
            }
        }

        private async Task Serve(HttpListenerContext ctx)
        {
            try
            {
                var ws = (await ctx.AcceptWebSocketAsync(null)).WebSocket;
                var buf = new byte[1 << 16];
                var r = await ws.ReceiveAsync(new ArraySegment<byte>(buf), _cts.Token); // hello
                if (!Encoding.UTF8.GetString(buf, 0, r.Count).Contains("\"t\":\"hello\"")) return;
                await ws.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(_start)), WebSocketMessageType.Text, true, _cts.Token);
                await ws.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes("{\"t\":\"b\",\"from\":0,\"to\":10,\"in\":[]}")), WebSocketMessageType.Text, true, _cts.Token);
                await Task.Delay(100);
                if (_closeCode == null) { ws.Abort(); ctx.Response.Abort(); return; }
                await ws.CloseOutputAsync((WebSocketCloseStatus)_closeCode.Value, "test", _cts.Token);
                try { while ((await ws.ReceiveAsync(new ArraySegment<byte>(buf), _cts.Token)).MessageType != WebSocketMessageType.Close) { } } catch { }
            }
            catch { /* the client went away */ }
        }

        public void Dispose()
        {
            _cts.Cancel();
            try { _http.Stop(); _http.Close(); } catch { }
        }
    }

    static string Start(RaceConfig cfg, int you)
    {
        var o = JsonNode.Obj();
        o.Set("t", "start"); o.Set("you", you); o.Set("startAtMs", 0); o.Set("config", ProtocolCodec.ConfigToJson(cfg));
        return o.ToString();
    }

    /// <summary>Opens one socket with the Unity transport and returns the close code it reports (-1 = none in time).</summary>
    static async Task<int> CloseCodeOf(int? serverCode, RulesetParams ruleset)
    {
        using var room = new Room(Start(RaceFactory.Tutorial(ruleset), 0), serverCode);
        var closed = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        IConnection conn = null;
        conn = new WebSocketTransportFactory().Open(room.Url, () => conn?.Send("{\"t\":\"hello\"}"), _ => { }, code => closed.TrySetResult(code));
        if (await Task.WhenAny(closed.Task, Task.Delay(10_000)) != closed.Task) { conn.Close(); return -1; }
        return closed.Task.Result;
    }

    /// <summary>Drives a RaceSession (or a spectator's) over the Unity transport until it is terminal or the time is up.</summary>
    static async Task<(RaceSession s, int connections)> Drive(bool spectator, int? serverCode, RulesetParams ruleset, int ms)
    {
        var cfg = RaceFactory.Tutorial(ruleset);
        using var room = new Room(Start(cfg, spectator ? -1 : 0), serverCode);
        var opt = new RaceSessionOptions { ReconnectBaseMs = 50, ReconnectMaxMs = 100, MaxReconnectAttempts = 3 };
        var s = spectator
            ? new SpectatorSession(new WebSocketTransportFactory(), room.Url, new SpectatorTicket { RaceId = cfg.RaceId, Ticket = "spec" }, opt).Session
            : new RaceSession(new WebSocketTransportFactory(), room.Url, cfg.RaceId, "tok", opt);
        var clock = System.Diagnostics.Stopwatch.StartNew();
        s.Start(0);
        while (!s.IsTerminal && clock.ElapsedMilliseconds < ms) { s.Update(clock.ElapsedMilliseconds); await Task.Delay(10); }
        s.Dispose();
        return (s, room.Connections);
    }

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        int replaced = await CloseCodeOf(CloseCodes.Replaced, ruleset);
        check(replaced == 4000, "websocket transport reports the room's close code (4000 replaced; got " + replaced + ")");
        int full = await CloseCodeOf(CloseCodes.SpectatorsFull, ruleset);
        check(full == 4003, "websocket transport reports 4003 (spectators full; got " + full + ")");
        int dropped = await CloseCodeOf(null, ruleset);
        check(dropped == CloseCodes.Abnormal, "websocket transport reports 1006 for a socket dropped without a close frame (got " + dropped + ")");

        foreach (bool spectator in new[] { true, false })
        {
            string who = spectator ? "spectator" : "rider";
            var (s, n) = await Drive(spectator, CloseCodes.Replaced, ruleset, 10_000);
            check(s.State == RaceSessionState.Failed && s.FailureReason == "REPLACED" && n == 1 && s.ReconnectCount == 0,
                who + ": closed with 4000 (replaced by another device) stops with REPLACED and does not reconnect (" + s.State + ", " + s.FailureReason + ", connections " + n + ")");
        }
        var (lost, conns) = await Drive(true, CloseCodes.InternalError, ruleset, 5_000);
        check(conns > 1 && lost.ReconnectCount > 0, "spectator: a 1011 close is a lost connection and reconnects (connections " + conns + ")");
    }
}
