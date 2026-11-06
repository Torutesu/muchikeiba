using Muchi.Client;
using Muchi.Engine;
using Muchi.Verifier;

namespace Muchi.Engine.Tests
{
    /// <summary>Opens connections into the InMemoryRelay for one slot.</summary>
    internal sealed class RelayTransportFactory : ITransportFactory
    {
        private readonly FakeNet _net;
        private readonly InMemoryRelay _relay;
        private readonly int _slot;
        public Func<bool> Accept = () => true;
        public int Opens;
        public RelayConnection Current;

        public RelayTransportFactory(FakeNet net, InMemoryRelay relay, int slot) { _net = net; _relay = relay; _slot = slot; }

        public IConnection Open(string url, Action onOpen, Action<string> onMessage, Action<int> onClosed)
        {
            Opens++;
            var c = new RelayConnection(_net, _relay, _slot, onClosed);
            if (!Accept())
            {
                _net.Schedule(_net.Now + 30, () => onClosed(CloseCodes.Abnormal)); // connection refused
                return c;
            }
            Current = c;
            _relay.Attach(_slot, c.Down, onMessage);
            _net.Schedule(_net.Now + 30, onOpen);
            return c;
        }
    }

    internal sealed class RelayConnection : IConnection
    {
        private readonly InMemoryRelay _relay;
        private readonly int _slot;
        private readonly Action<int> _onClosed;
        public readonly Pipe Up, Down;
        private bool _closed;

        public RelayConnection(FakeNet net, InMemoryRelay relay, int slot, Action<int> onClosed)
        {
            _relay = relay; _slot = slot; _onClosed = onClosed;
            Up = new Pipe(net, () => 40);
            Down = new Pipe(net, () => 40);
        }

        public void Send(string message) => Up.Send(() => _relay.OnMessage(_slot, message));

        public void Close() => Kill(notify: false);

        /// <summary>Network drop (or the room closing the socket with <paramref name="code"/>): both directions stop and the client is told the socket closed.</summary>
        public void Kill(bool notify = true, int code = CloseCodes.Abnormal)
        {
            if (_closed) return;
            _closed = true;
            Up.Open = false;
            _relay.Disconnect(_slot);
            if (notify) _onClosed(code);
        }
    }

    public class RaceSessionTests
    {
        private sealed class World
        {
            public readonly FakeNet Net = new FakeNet();
            public readonly InMemoryRelay Relay;
            public readonly List<RaceSession> Sessions = new List<RaceSession>();
            public readonly List<RelayTransportFactory> Factories = new List<RelayTransportFactory>();
            public readonly List<List<RaceSessionState>> States = new List<List<RaceSessionState>>();
            private readonly Pcg32[] _rng;

            public World(int humans, ulong seed)
            {
                var hr = new Pcg32(seed, 5);
                var horses = Enumerable.Range(0, 12).Select(i => SampleRaces.RandomHorse(ref hr, "s" + i)).ToList();
                var cfg = SampleRaces.Config("rs_" + seed, seed, SampleRaces.Turf1600(), TestUtil.Ruleset(), horses, humans);
                Relay = new InMemoryRelay(Net, cfg, 1000);
                _rng = new Pcg32[humans];
                for (int s = 0; s < humans; s++)
                {
                    var f = new RelayTransportFactory(Net, Relay, s);
                    var session = new RaceSession(f, "wss://test/v1/race/x/ws", cfg.RaceId, "tok" + s);
                    var list = new List<RaceSessionState> { session.State };
                    session.StateChanged += (o, n) => list.Add(n);
                    Factories.Add(f);
                    Sessions.Add(session);
                    States.Add(list);
                    _rng[s] = new Pcg32(seed + (ulong)s, 3);
                    session.Start(0);
                }
            }

            public void Run(long untilMs, Action<long> each = null)
            {
                for (long t = 0; t <= untilMs; t += 5)
                {
                    Net.RunUntil(t);
                    Relay.Advance();
                    each?.Invoke(t);
                    for (int i = 0; i < Sessions.Count; i++)
                    {
                        var s = Sessions[i];
                        s.Update(t);
                        if (s.State == RaceSessionState.Racing) Play(s, ref _rng[i]);
                    }
                    if (Sessions.All(s => s.IsTerminal || s.State == RaceSessionState.Verifying) && Relay.FinalStatus != null && t > 2000) { Net.RunUntil(t + 2000); foreach (var s in Sessions) s.Update(t + 2000); break; }
                }
            }

            private static void Play(RaceSession s, ref Pcg32 rng)
            {
                var sim = s.Sim;
                var h = sim.GetHorse(s.Slot);
                if (!h.Departed) { if (rng.Chance(1, 3)) s.Input(Cmd.Start); return; }
                if (sim.Track.Distance - h.Distance < Fx.FromInt(400) && rng.Chance(1, 30)) s.Input(Cmd.Whip);
            }
        }

        [Fact]
        public void CleanRaceGoesThroughEveryState()
        {
            var w = new World(2, 11);
            w.Run(150_000);
            foreach (var states in w.States)
                Assert.Equal(new[] { RaceSessionState.Connecting, RaceSessionState.Waiting, RaceSessionState.Racing, RaceSessionState.Finished, RaceSessionState.Confirmed }, states);
            Assert.Equal("confirmed", w.Relay.FinalStatus);
            foreach (var s in w.Sessions)
            {
                Assert.Equal(w.Relay.FinalHash, s.Sim.Result.Hash);
                Assert.Equal(s.Sim.Result.Hash, s.Final.Hash);
                Assert.True(s.Client.LastRttMs >= 0, "pings were answered");
                Assert.Equal(0, s.ReconnectCount);
            }
            Assert.Equal(w.Relay.Replay().Result.Hash, w.Relay.FinalHash);
        }

        [Fact]
        public void MidRaceDropReconnectsWithBackoffAndFastForwards()
        {
            var w = new World(2, 12);
            bool dropped = false;
            w.Factories[0].Accept = () => w.Net.Now < 20_000 || w.Net.Now >= 26_000; // unreachable for 6s (> grace)
            w.Run(160_000, t =>
            {
                if (!dropped && t >= 20_000) { dropped = true; w.Factories[0].Current.Kill(); }
            });
            var s0 = w.Sessions[0];
            Assert.Contains(RaceSessionState.Reconnecting, w.States[0]);
            Assert.True(s0.ReconnectCount >= 3, "several attempts while unreachable: " + s0.ReconnectCount);
            Assert.Equal(RaceSessionState.Confirmed, s0.State);
            Assert.Equal(RaceSessionState.Confirmed, w.Sessions[1].State);
            Assert.Equal(w.Sessions[1].Sim.Result.Hash, s0.Sim.Result.Hash);
            Assert.Equal(w.Relay.Replay().Result.Hash, s0.Sim.Result.Hash);
            Assert.Contains(w.Relay.Log, r => r.Slot == 0 && (r.Cmd & Cmd.CpuTakeover) != 0);
            Assert.Contains(w.Relay.Log, r => r.Slot == 0 && (r.Cmd & Cmd.HumanResume) != 0);
            Assert.Empty(s0.Client.DesyncTicks);
        }

        [Fact]
        public void GivesUpAfterMaxReconnectAttempts()
        {
            var w = new World(2, 13);
            bool dropped = false;
            w.Factories[0].Accept = () => w.Net.Now < 20_000;
            w.Run(160_000, t =>
            {
                if (!dropped && t >= 20_000) { dropped = true; w.Factories[0].Current.Kill(); }
            });
            var s0 = w.Sessions[0];
            Assert.Equal(RaceSessionState.Failed, s0.State);
            Assert.Equal(new RaceSessionOptions().MaxReconnectAttempts, s0.ReconnectCount);
            Assert.NotNull(s0.FailureReason);
            // the other player still gets a decision; with one human left the ranked race goes to the verifier
            Assert.Equal(RaceSessionState.Verifying, w.Sessions[1].State);
            Assert.Contains(w.Relay.Log, r => r.Slot == 0 && (r.Cmd & Cmd.CpuTakeover) != 0);
        }

        [Fact]
        public void InputsAreIgnoredWhileDisconnected()
        {
            var w = new World(1, 14);
            bool dropped = false;
            int sentWhileDown = 0;
            w.Factories[0].Accept = () => w.Net.Now < 15_000 || w.Net.Now >= 16_000;
            w.Run(150_000, t =>
            {
                if (!dropped && t >= 15_000) { dropped = true; w.Factories[0].Current.Kill(); }
                if (dropped && w.Sessions[0].State == RaceSessionState.Reconnecting)
                {
                    int before = w.Relay.Log.Count;
                    w.Sessions[0].Input(Cmd.Whip);
                    sentWhileDown += w.Relay.Log.Count - before;
                }
            });
            Assert.Equal(0, sentWhileDown);
            Assert.True(w.Sessions[0].ReconnectCount >= 1);
            Assert.Equal(RaceSessionState.Verifying, w.Sessions[0].State); // 1-human ranked race
        }
    }
}
