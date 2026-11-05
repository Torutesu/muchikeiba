using Muchi.Engine;
using Muchi.Net;
using Muchi.Verifier;

namespace Muchi.Engine.Tests
{
    public class LockstepTests
    {
        private sealed class World
        {
            public FakeNet Net = new FakeNet();
            public InMemoryRelay Relay;
            public List<TestClient> Clients = new List<TestClient>();
            public Pcg32 Rng;

            public World(int humans, ulong seed, Func<int, Func<long>> latencyFor = null, RaceMode mode = RaceMode.Ranked)
            {
                Rng = new Pcg32(seed, 77);
                var rs = TestUtil.Ruleset();
                var hr = new Pcg32(seed, 5);
                var horses = Enumerable.Range(0, 12).Select(i => SampleRaces.RandomHorse(ref hr, "l" + i)).ToList();
                var cfg = SampleRaces.Config("ls_" + seed, seed, SampleRaces.Turf1600(), rs, horses, humans, 3, mode);
                Relay = new InMemoryRelay(Net, cfg, 1000);
                for (int s = 0; s < humans; s++)
                {
                    var lat = latencyFor?.Invoke(s) ?? DefaultLatency(seed, s);
                    Clients.Add(new TestClient(Net, Relay, s, lat));
                }
            }

            private static Func<long> DefaultLatency(ulong seed, int slot)
            {
                var r = new Pcg32(seed + (ulong)slot, 99);
                return () => 20 + r.NextInt(100);
            }

            /// <summary>Random human play: start at the gate, lane changes, rein, whips in the stretch.</summary>
            public void PlayRandomly(TestClient c)
            {
                var sim = c.Client.Sim;
                if (sim == null || sim.IsFinished) return;
                var h = sim.GetHorse(c.Slot);
                int gate = sim.P.GateOpenTick;
                if (!h.Departed && c.Client.ConfirmedTick + sim.Config.Net.InputDelayTicks >= gate - 1 && Rng.Chance(1, 4)) c.Client.QueueInput(Cmd.Start);
                if (!h.Departed) return;
                int roll = Rng.NextInt(400);
                if (roll == 0) c.Client.QueueInput(Cmd.LaneIn);
                else if (roll == 1) c.Client.QueueInput(Cmd.LaneOut);
                else if (roll == 2) c.Client.QueueInput(h.Reining ? Cmd.ReinRelease : Cmd.ReinPress);
                else if (roll < 12 && sim.Track.Distance - h.Distance < Fx.FromInt(400)) c.Client.QueueInput(Cmd.Whip);
            }

            public void Run(long untilMs, Action<long> each = null)
            {
                for (long t = 0; t <= untilMs; t += 5)
                {
                    Net.RunUntil(t);
                    Relay.Advance();
                    each?.Invoke(t);
                    foreach (var c in Clients) if (c.Up.Open) PlayRandomly(c);
                    if (Relay.FinalStatus != null && Clients.All(c => !c.Up.Open || c.Client.Final != null)) { Net.RunUntil(t + 1000); break; }
                }
            }
        }

        private static void AssertAllAgree(World w, IEnumerable<TestClient> clients)
        {
            var replay = w.Relay.Replay();
            foreach (var c in clients)
            {
                Assert.True(c.Client.Sim.IsFinished, "client " + c.Slot + " not finished");
                Assert.Equal(replay.Result.Hash, c.Client.Sim.Result.Hash);
                foreach (var kv in c.Client.SentChecksums) Assert.Equal(replay.Checksums[kv.Key], kv.Value);
                Assert.Empty(c.Client.Errors);
                Assert.Empty(c.Client.DesyncTicks);
            }
        }

        [Fact]
        public void TwelveClientsWithJitterAndLateInputsAgree()
        {
            // slot 11 has 300 ms latency: its inputs arrive after the 150 ms input delay and get shifted
            var w = new World(12, 2026, s => s == 11 ? (Func<long>)(() => 300) : null);
            w.Run(200_000);
            Assert.Equal("confirmed", w.Relay.FinalStatus);
            Assert.True(w.Relay.ShiftedLateInputs > 0);
            Assert.True(w.Relay.Log.Count > 50);
            AssertAllAgree(w, w.Clients);
            Assert.All(w.Clients, c => Assert.Equal(FinalStatus.Confirmed, c.Client.Final.Status));
            Assert.All(w.Clients, c => Assert.Equal(w.Relay.FinalHash, c.Client.Final.Hash));
            // ticks were confirmed close to real time: race end ≈ start + endTick * 50 ms
            var end = w.Relay.Replay().Result.EndTick;
            Assert.True(w.Relay.Confirmed >= end);
        }

        [Fact]
        public void DisconnectGetsCpuTakeoverAndFreshClientFastForwards()
        {
            var w = new World(4, 31337);
            var victim = w.Clients[2];
            bool dropped = false, rejoined = false;
            w.Run(200_000, now =>
            {
                if (!dropped && now >= 4000) { victim.Drop(); dropped = true; }
                if (!rejoined && now >= 12000)
                {
                    // the app restarted: brand-new client with no simulation → hello lastTick=-1 → full catch-up
                    victim.Connect(new LockstepClient(victim, w.Relay.Config.RaceId, "tok2"));
                    rejoined = true;
                }
            });
            Assert.True(rejoined);
            Assert.Contains(w.Relay.Log, r => r.Slot == 2 && (r.Cmd & Cmd.CpuTakeover) != 0);
            Assert.Contains(w.Relay.Log, r => r.Slot == 2 && (r.Cmd & Cmd.HumanResume) != 0);
            var replay = w.Relay.Replay();
            Assert.Contains(replay.Sim.Events, e => e.Type == RaceEventType.CpuTakeover && e.Slot == 2);
            Assert.Contains(replay.Sim.Events, e => e.Type == RaceEventType.HumanResume && e.Slot == 2);
            AssertAllAgree(w, w.Clients);
            Assert.Equal("confirmed", w.Relay.FinalStatus);
        }

        [Fact]
        public void ShortDisconnectWithinGraceResumesWithoutTakeover()
        {
            var w = new World(3, 4242);
            var c1 = w.Clients[1];
            bool dropped = false, back = false;
            w.Run(200_000, now =>
            {
                if (!dropped && now >= 5000) { c1.Drop(); dropped = true; }
                if (!back && now >= 6500) { c1.Connect(c1.Client); back = true; } // same client object → hello lastTick=N
            });
            Assert.DoesNotContain(w.Relay.Log, r => (r.Cmd & (Cmd.CpuTakeover | Cmd.HumanResume)) != 0);
            AssertAllAgree(w, w.Clients);
        }

        [Fact]
        public void TamperedClientIsDetectedAsDesyncAndOutvoted()
        {
            var w = new World(4, 99);
            // client 3 corrupts every whip it receives from slot 0 into a lane change
            w.Clients[3].TamperIncoming = s =>
            {
                var m = JsonNode.Parse(s);
                if (m.Get("t").AsString() != "b") return s;
                foreach (var r in m.Get("in").Items)
                    if (r[1].AsInt() == 0 && r[2].AsInt() == Cmd.Start) return s.Replace("[" + r[0].AsInt() + ",0,1]", "[" + r[0].AsInt() + ",0,4]");
                return s;
            };
            w.Run(200_000);
            var honest = w.Clients.Take(3).ToList();
            AssertAllAgree(w, honest);
            Assert.NotEmpty(w.Clients[3].Client.DesyncTicks);
            Assert.NotEqual(w.Relay.FinalHash, w.Clients[3].Client.Sim.Result.Hash);
            Assert.Equal("confirmed", w.Relay.FinalStatus); // 3 of 4 agree ≥ 2/3
        }

        [Fact]
        public void SingleHumanRankedRaceGoesToVerification()
        {
            var w = new World(1, 7);
            w.Run(200_000);
            Assert.Equal("verifying", w.Relay.FinalStatus);
            Assert.Equal(FinalStatus.Verifying, w.Clients[0].Client.Final.Status);
            AssertAllAgree(w, w.Clients);
        }

        [Fact]
        public void TooEarlyInputsAreRejected()
        {
            var w = new World(2, 11);
            w.Run(2000);
            var raw = JsonNode.Obj();
            raw.Set("t", "in"); raw.Set("tick", w.Relay.Confirmed + 1000); raw.Set("cmd", Cmd.Whip);
            w.Clients[0].Send(raw.ToString());
            w.Net.RunUntil(w.Net.Now + 1000);
            Assert.Equal(1, w.Relay.RejectedEarly);
            Assert.Contains("TOO_EARLY", w.Clients[0].Client.Errors);
        }

        [Fact]
        public void ClientIgnoresDuplicateBundlesAndRejectsGaps()
        {
            var sent = new List<string>();
            var transport = new ListTransport(sent);
            var rs = TestUtil.Ruleset();
            var cfg = SampleRaces.Config("dup", 5, SampleRaces.Turf1600(), rs, Enumerable.Range(0, 2).Select(i => TestUtil.H("d" + i)).ToList(), 2);
            var c = new LockstepClient(transport, "dup", "t");
            var start = JsonNode.Obj();
            start.Set("t", "start"); start.Set("you", 1); start.Set("startAtMs", 0); start.Set("config", ProtocolCodec.ConfigToJson(cfg));
            c.HandleMessage(start.ToString());
            Assert.Equal(1, c.Slot);
            string b = "{\"t\":\"b\",\"from\":0,\"to\":61,\"in\":[[60,0,1],[60,1,1]]}";
            c.HandleMessage(b);
            c.HandleMessage(b); // duplicate delivery after reconnect
            Assert.Equal(62, c.Sim.Tick);
            Assert.True(c.Sim.GetHorse(0).Departed);
            Assert.Equal(1, c.Sim.Events.Count(e => e.Type == RaceEventType.Start && e.Slot == 0));
            c.HandleMessage("{\"t\":\"b\",\"from\":70,\"to\":71,\"in\":[]}");
            Assert.Contains("GAP_IN_BUNDLES", c.Errors);
            Assert.Equal(62, c.Sim.Tick);
            c.HandleMessage("not json");
            Assert.Contains("BAD_JSON", c.Errors);

            // inputs are sent for confirmedTick + inputDelay, with server-only bits stripped
            c.QueueInput((byte)(Cmd.Whip | Cmd.CpuTakeover));
            var last = JsonNode.Parse(sent.Last());
            Assert.Equal("in", last.Get("t").AsString());
            Assert.Equal(61 + cfg.Net.InputDelayTicks, last.Get("tick").AsInt());
            Assert.Equal(Cmd.Whip, last.Get("cmd").AsInt());
        }

        [Fact]
        public void PingPongEstimatesClockOffset()
        {
            var sent = new List<string>();
            var c = new LockstepClient(new ListTransport(sent), "x", "t");
            c.SendPing(1000);
            Assert.Contains("\"c\":1000", sent[0]);
            c.HandleMessage("{\"t\":\"pong\",\"c\":1000,\"s\":5050}", 1100);
            Assert.Equal(100, c.LastRttMs);
            Assert.Equal(4000, c.ServerClockOffsetMs);
        }

        private sealed class ListTransport : ITransport
        {
            private readonly List<string> _l;
            public ListTransport(List<string> l) { _l = l; }
            public void Send(string message) => _l.Add(message);
        }
    }
}
