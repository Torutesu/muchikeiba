using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>
    /// Deterministic fake network: FIFO per direction, latency per message.
    /// </summary>
    internal sealed class FakeNet
    {
        public long Now;
        private long _seq;
        private readonly SortedDictionary<(long at, long seq), Action> _queue = new SortedDictionary<(long, long), Action>();

        public void Schedule(long at, Action a) => _queue.Add((at, _seq++), a);

        public void RunUntil(long t)
        {
            while (_queue.Count > 0)
            {
                var first = _queue.First();
                if (first.Key.at > t) break;
                _queue.Remove(first.Key);
                Now = Math.Max(Now, first.Key.at);
                first.Value();
            }
            Now = t;
        }
    }

    /// <summary>A FIFO pipe with a latency function (ms).</summary>
    internal sealed class Pipe
    {
        private readonly FakeNet _net;
        private readonly Func<long> _latency;
        private long _lastAt;
        public bool Open = true;

        public Pipe(FakeNet net, Func<long> latency) { _net = net; _latency = latency; }

        public void Send(Action deliver)
        {
            if (!Open) return;
            long at = Math.Max(_lastAt, _net.Now + _latency());
            _lastAt = at;
            _net.Schedule(at, () => { if (Open) deliver(); });
        }
    }

    /// <summary>
    /// Test double of the TS RaceRoomCore, implementing contracts/protocol.md §4 (REQ-NET-001..009).
    /// </summary>
    internal sealed class InMemoryRelay
    {
        public sealed class Conn
        {
            public int Slot;
            public Pipe ToClient;
            public Action<string> Deliver;
            public bool Connected;
            public long DisconnectedAt = -1;
            public bool TakenOver;
            public int LastSentTick = -1;
            public bool StartSent;
        }

        private readonly FakeNet _net;
        public readonly RaceConfig Config;
        public readonly string ConfigJson;
        public readonly long StartAtMs;
        public int Confirmed = -1;
        public bool Stopped;
        public readonly List<InputRecord> Log = new List<InputRecord>();
        public readonly Dictionary<int, Conn> Conns = new Dictionary<int, Conn>();
        private readonly Dictionary<int, byte[]> _pending = new Dictionary<int, byte[]>();
        private readonly Dictionary<int, Dictionary<int, string>> _checks = new Dictionary<int, Dictionary<int, string>>();
        private readonly HashSet<(int tick, int slot)> _desyncSent = new HashSet<(int, int)>();
        private readonly Dictionary<int, string> _results = new Dictionary<int, string>();
        private readonly Dictionary<int, int[]> _orders = new Dictionary<int, int[]>();
        public int ShiftedLateInputs;
        public int RejectedEarly;
        public string FinalStatus;
        public string FinalHash;
        public readonly List<string> Errors = new List<string>();

        public InMemoryRelay(FakeNet net, RaceConfig config, long startAtMs)
        {
            _net = net;
            Config = config;
            ConfigJson = ProtocolCodec.ConfigToJson(config).ToString();
            StartAtMs = startAtMs;
        }

        private int N => Config.Entrants.Count;
        private int MsPerTick => 1000 / Config.Net.TickHz;

        public void Attach(int slot, Pipe toClient, Action<string> deliver)
        {
            if (!Conns.TryGetValue(slot, out var c)) Conns[slot] = c = new Conn { Slot = slot };
            c.ToClient = toClient;
            c.Deliver = deliver;
        }

        public void Disconnect(int slot)
        {
            var c = Conns[slot];
            c.Connected = false;
            c.DisconnectedAt = _net.Now;
            c.ToClient.Open = false;
        }

        private void Send(Conn c, JsonNode m)
        {
            if (!c.Connected) return;
            string s = m.ToString();
            c.ToClient.Send(() => c.Deliver(s));
        }

        private void QueueInput(int tick, int slot, byte cmd)
        {
            if (!_pending.TryGetValue(tick, out var arr)) _pending[tick] = arr = new byte[N];
            arr[slot] |= cmd;
        }

        public void OnMessage(int slot, string json)
        {
            var c = Conns[slot];
            var m = JsonNode.Parse(json);
            switch (m.Get("t").AsString())
            {
                case "hello":
                {
                    c.Connected = true;
                    c.DisconnectedAt = -1;
                    int lastTick = m.Get("lastTick").AsInt();
                    var start = JsonNode.Obj();
                    start.Set("t", "start");
                    start.Set("you", slot);
                    start.Set("startAtMs", StartAtMs);
                    start.Set("config", JsonNode.Parse(ConfigJson));
                    Send(c, start);
                    c.LastSentTick = lastTick;
                    if (Confirmed > lastTick) SendBundle(c, lastTick + 1, Confirmed);
                    if (c.TakenOver)
                    {
                        c.TakenOver = false;
                        QueueInput(Confirmed + 1, slot, Cmd.HumanResume);
                    }
                    break;
                }
                case "in":
                {
                    int tick = m.Get("tick").AsInt();
                    byte cmd = (byte)(m.Get("cmd").AsInt() & Cmd.ClientMask);
                    if (tick > Confirmed + Config.Net.InputDelayTicks * 4)
                    {
                        RejectedEarly++;
                        var e = JsonNode.Obj(); e.Set("t", "err"); e.Set("code", "TOO_EARLY"); Send(c, e);
                        break;
                    }
                    if (tick <= Confirmed) { tick = Confirmed + 1; ShiftedLateInputs++; }
                    QueueInput(tick, slot, cmd);
                    break;
                }
                case "chk":
                {
                    int tick = m.Get("tick").AsInt();
                    if (!_checks.TryGetValue(tick, out var d)) _checks[tick] = d = new Dictionary<int, string>();
                    d[slot] = m.Get("h").AsString();
                    EvaluateChecks(tick);
                    break;
                }
                case "res":
                {
                    _results[slot] = m.Get("h").AsString();
                    _orders[slot] = m.Get("order").Items.Select(x => x.AsInt()).ToArray();
                    Stopped = true; // a client finished: no more ticks needed
                    TryFinalize();
                    break;
                }
                case "ping":
                {
                    var p = JsonNode.Obj(); p.Set("t", "pong"); p.Set("c", m.Get("c").AsLong()); p.Set("s", _net.Now); Send(c, p);
                    break;
                }
                default:
                    Errors.Add("unknown message");
                    break;
            }
        }

        private void EvaluateChecks(int tick)
        {
            var d = _checks[tick];
            if (d.Count < 2) return;
            var groups = d.GroupBy(kv => kv.Value).OrderByDescending(g => g.Count()).ToList();
            if (groups.Count < 2 || groups[0].Count() == groups[1].Count()) return;
            string majority = groups[0].Key;
            foreach (var kv in d)
            {
                if (kv.Value != majority && _desyncSent.Add((tick, kv.Key)))
                {
                    var m = JsonNode.Obj(); m.Set("t", "desync"); m.Set("tick", tick);
                    Send(Conns[kv.Key], m);
                }
            }
        }

        private void TryFinalize()
        {
            if (FinalStatus != null) return;
            var expected = Conns.Values.Where(c => c.Connected && !c.TakenOver).Select(c => c.Slot).ToList();
            if (!expected.All(_results.ContainsKey)) return;
            var groups = _results.GroupBy(kv => kv.Value).OrderByDescending(g => g.Count()).ToList();
            int reporting = _results.Count;
            var top = groups[0];
            bool ranked = Config.Mode == RaceMode.Ranked || Config.Mode == RaceMode.Event; // same rule as the TS room (REQ-EVENT-006)
            if (reporting >= 2 && top.Count() >= 2 && top.Count() * 3 >= reporting * 2) FinalStatus = "confirmed";
            else FinalStatus = ranked ? "verifying" : "confirmed";
            FinalHash = top.Key;
            var f = JsonNode.Obj();
            f.Set("t", "final");
            f.Set("status", FinalStatus);
            var ord = JsonNode.Arr();
            foreach (var s in _orders[top.First().Key]) ord.Add(JsonNode.Num(s));
            f.Set("order", ord);
            f.Set("h", FinalHash);
            foreach (var c in Conns.Values) Send(c, f);
        }

        private void SendBundle(Conn c, int from, int to)
        {
            var m = JsonNode.Obj();
            m.Set("t", "b");
            m.Set("from", from);
            m.Set("to", to);
            var arr = JsonNode.Arr();
            foreach (var r in Log)
                if (r.Tick >= from && r.Tick <= to)
                    arr.Add(JsonNode.Arr().Add(JsonNode.Num(r.Tick)).Add(JsonNode.Num(r.Slot)).Add(JsonNode.Num(r.Cmd)));
            m.Set("in", arr);
            Send(c, m);
            c.LastSentTick = to;
        }

        /// <summary>Confirm all ticks whose time has passed, insert takeovers, flush bundles.</summary>
        public void Advance()
        {
            if (Stopped) return;
            foreach (var c in Conns.Values)
            {
                if (!c.Connected && !c.TakenOver && c.DisconnectedAt >= 0 && _net.Now - c.DisconnectedAt >= Config.Net.DisconnectGraceMs)
                {
                    c.TakenOver = true;
                    QueueInput(Confirmed + 1, c.Slot, Cmd.CpuTakeover);
                }
            }
            long target = (_net.Now - StartAtMs) / MsPerTick - 1; // tick n confirmed once start + (n+1)*ms has passed
            while (Confirmed < target && Confirmed + 1 < Config.Ruleset.MaxTicks)
            {
                int t = Confirmed + 1;
                if (_pending.TryGetValue(t, out var arr))
                {
                    for (int s = 0; s < N; s++) if (arr[s] != 0) Log.Add(new InputRecord(t, s, arr[s]));
                    _pending.Remove(t);
                }
                Confirmed = t;
                if ((t + 1) % Config.Net.BundleIntervalTicks == 0)
                    foreach (var c in Conns.Values)
                        if (c.Connected && c.LastSentTick < t) SendBundle(c, c.LastSentTick + 1, t);
            }
        }

        public ReplayOutput Replay() => RaceReplay.Run(Config, Log);
    }

    /// <summary>A client wired to the relay through two FIFO pipes.</summary>
    internal sealed class TestClient : ITransport
    {
        public readonly int Slot;
        public LockstepClient Client;
        public Pipe Up, Down;
        private readonly FakeNet _net;
        private readonly InMemoryRelay _relay;
        private readonly Func<long> _latency;
        public Func<string, string> TamperIncoming;

        public TestClient(FakeNet net, InMemoryRelay relay, int slot, Func<long> latency)
        {
            _net = net; _relay = relay; Slot = slot; _latency = latency;
            Connect(new LockstepClient(this, relay.Config.RaceId, "tok" + slot));
        }

        public void Connect(LockstepClient client)
        {
            Client = client;
            Up = new Pipe(_net, _latency);
            Down = new Pipe(_net, _latency);
            _relay.Attach(Slot, Down, s => Client.HandleMessage(TamperIncoming != null ? TamperIncoming(s) : s, _net.Now));
            Client.Connect();
        }

        public void Send(string message)
        {
            Up.Send(() => _relay.OnMessage(Slot, message));
        }

        public void Drop()
        {
            Up.Open = false;
            _relay.Disconnect(Slot);
        }
    }
}
