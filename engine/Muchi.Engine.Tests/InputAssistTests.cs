using System.Globalization;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Net;
using Muchi.Verifier;

namespace Muchi.Engine.Tests
{
    /// <summary>Rides a slot with <see cref="InputAssistant"/>; with the whip assist an optional rider plays the rest.</summary>
    public sealed class AssistRider : IRider
    {
        private readonly AssistLevel _level;
        private readonly IRider _player;
        private InputAssistant _a;
        public AssistRider(AssistLevel level, IRider player = null) { _level = level; _player = player; }
        public InputAssistant Assistant => _a;
        public void Reset(RaceSim sim, int slot, ulong seed) { _a = new InputAssistant(_level, slot); _player?.Reset(sim, slot, seed); }
        public byte Decide(RaceSim sim, int slot, int tick) => _a.Apply(sim, _player?.Decide(sim, slot, tick) ?? 0);
    }

    /// <summary>Sends nothing (a player who never touches the screen: the engine starts the horse late on its own).</summary>
    public sealed class NoInputRider : IRider
    {
        public void Reset(RaceSim sim, int slot, ulong seed) { }
        public byte Decide(RaceSim sim, int slot, int tick) => 0;
    }

    /// <summary>
    /// The R11 fairness harness (docs/spec/balance-targets.md §2.3, REQ-ASSIST-005): many seeds, the same horse in the
    /// same race ridden by each rider model. Equal stats: the measured horse is a flat 500 in a 500±150 field.
    /// </summary>
    public static class AssistHarness
    {
        public sealed class Rates
        {
            public double Skilled, Full, WhipCasual, Casual, None;
            /// <summary>Average finishing place (1 = win) of the same horse in the same race.</summary>
            public double PlaceSkilled, PlaceFull, PlaceWhipCasual, PlaceCasual, PlaceNone;
            public double FullVsSkilledDuel, FullVsNoneDuel, WhipCasualVsCasualDuel;
            public double FullRatio => Skilled <= 0 ? 0 : Full / Skilled;
            public double FullOverNone => None <= 0 ? double.PositiveInfinity : Full / None;
            public override string ToString() => string.Format(CultureInfo.InvariantCulture,
                "skilled {0:P1}  full {1:P1}  whip+casual {2:P1}  casual {3:P1}  none {4:P1}  | full/skilled {5:F2}  full/none {6:F2}  | duel full>skilled {7:P1}  full>none {8:P1}  whip+casual>casual {9:P1}",
                Skilled, Full, WhipCasual, Casual, None, FullRatio, FullOverNone, FullVsSkilledDuel, FullVsNoneDuel, WhipCasualVsCasualDuel)
                + string.Format(CultureInfo.InvariantCulture, "  | avg place skilled {0:F2} full {1:F2} whip+casual {2:F2} casual {3:F2} none {4:F2}", PlaceSkilled, PlaceFull, PlaceWhipCasual, PlaceCasual, PlaceNone);
        }

        private static List<HorseSpec> Field(ulong seed, Surface surface)
        {
            var rng = new Pcg32(seed, 5);
            var list = new List<HorseSpec>();
            for (int i = 0; i < 12; i++) { var h = SampleRaces.RandomHorse(ref rng, "f" + i, 500, 150); h.Surface = surface; list.Add(h); }
            return list;
        }

        private static HorseSpec Even(string id, RunningStyle style, Surface surface) { var h = SampleRaces.Horse(id, 500, style, 500); h.Surface = surface; return h; }

        public static Rates Measure(RulesetParams rs, int races, ulong seedBase, TrackSpec track = null)
        {
            track ??= SampleRaces.Turf2000();
            var riders = new (string name, Func<IRider> make)[]
            {
                ("skilled", () => new SkilledRider()),
                ("full", () => new AssistRider(AssistLevel.Full)),
                ("whipcasual", () => new AssistRider(AssistLevel.Whip, new CasualRider())),
                ("casual", () => new CasualRider()),
                ("none", () => new NoInputRider()),
            };
            var wins = new int[riders.Length];
            var places = new long[riders.Length];
            for (int r = 0; r < races; r++)
            {
                ulong s = seedBase + (ulong)r * 7919UL;
                var horses = Field(s, track.Surface);
                int slot = r % 12;
                horses[slot] = Even("me", (RunningStyle)(r / 12 % 4), track.Surface);
                for (int k = 0; k < riders.Length; k++)
                {
                    var cfg = BalanceHarness.Config("as_" + r, SeedMix.Mix(seedBase + (ulong)r), track, rs, horses, new HashSet<int> { slot }, _ => 3);
                    var sim = BalanceHarness.Run(cfg, new Dictionary<int, IRider> { [slot] = riders[k].make() }, seedBase + (ulong)r);
                    int pl = BalanceHarness.PlaceOf(sim, slot);
                    if (pl == 0) wins[k]++;
                    places[k] += pl + 1;
                }
            }
            return new Rates
            {
                Skilled = (double)wins[0] / races, Full = (double)wins[1] / races, WhipCasual = (double)wins[2] / races,
                Casual = (double)wins[3] / races, None = (double)wins[4] / races,
                PlaceSkilled = (double)places[0] / races, PlaceFull = (double)places[1] / races, PlaceWhipCasual = (double)places[2] / races,
                PlaceCasual = (double)places[3] / races, PlaceNone = (double)places[4] / races,
                FullVsSkilledDuel = Duel(rs, riders[1].make, riders[0].make, races, seedBase + 1, track),
                FullVsNoneDuel = Duel(rs, riders[1].make, riders[4].make, races, seedBase + 2, track),
                WhipCasualVsCasualDuel = Duel(rs, riders[2].make, riders[3].make, races, seedBase + 3, track),
            };
        }

        /// <summary>Two equal horses (same style) in a CPU field: share of races where A finishes ahead of B.</summary>
        public static double Duel(RulesetParams rs, Func<IRider> a, Func<IRider> b, int races, ulong seedBase, TrackSpec track)
        {
            int ahead = 0;
            for (int r = 0; r < races; r++)
            {
                var horses = Field(seedBase + (ulong)r * 104729UL, track.Surface);
                // swap the gates every other race so neither side keeps the inside
                int sa = r % 12, sb = (r + 6) % 12;
                if (r % 2 == 1) (sa, sb) = (sb, sa);
                var style = (RunningStyle)(r / 12 % 4);
                horses[sa] = Even("A", style, track.Surface);
                horses[sb] = Even("B", style, track.Surface);
                var cfg = BalanceHarness.Config("ad_" + r, SeedMix.Mix(seedBase + 77 + (ulong)r), track, rs, horses, new HashSet<int> { sa, sb }, _ => 3);
                var sim = BalanceHarness.Run(cfg, new Dictionary<int, IRider> { [sa] = a(), [sb] = b() }, seedBase + (ulong)r);
                if (BalanceHarness.PlaceOf(sim, sa) < BalanceHarness.PlaceOf(sim, sb)) ahead++;
            }
            return (double)ahead / races;
        }
    }

    public class InputAssistTests
    {
        private readonly Xunit.Abstractions.ITestOutputHelper _out;
        public InputAssistTests(Xunit.Abstractions.ITestOutputHelper output) { _out = output; }

        [Fact]
        public void R11_AssistIsCappedBelowSkilledPlayAndWellAboveNoInput()
        {
            // docs/spec/balance-targets.md §2.3 (R11), REQ-ASSIST-005: 480 seeded races per rider, every style, every gate
            var m = AssistHarness.Measure(TestUtil.Ruleset(), 480, 9_100_000);
            _out.WriteLine(m.ToString());
            Assert.True(m.FullRatio < 1.0, "R11a assist must never beat good manual play: " + m);
            Assert.InRange(m.FullRatio, 0.3, 0.9);                 // R11a
            Assert.True(m.Full - m.None >= 0.05, "R11b " + m);       // R11b well above no input: +5pt win rate
            Assert.True(m.PlaceNone - m.PlaceFull >= 2.0, "R11b " + m); // … and at least 2 places better on average
            Assert.True(m.PlaceFull > m.PlaceSkilled, "R11a places " + m);
            Assert.InRange(m.FullVsSkilledDuel, 0.0, 0.45);          // R11c head to head at equal stats
            Assert.InRange(m.FullVsNoneDuel, 0.70, 1.0);             // R11d
            Assert.True(m.WhipCasual < m.Skilled, "R11e whip assist below skilled " + m);
            Assert.InRange(m.WhipCasualVsCasualDuel, 0.5, 1.0);      // R11f the whip assist helps a beginner
        }

        [Fact]
        public void R11_HoldsOnEveryServerCourse()
        {
            // the cap must not depend on the course (short sprint, long, dirt): fewer races per course
            var tracks = BalanceHarness.LoadServerTracks(System.IO.Path.Combine(TestUtil.RepoRoot, "server", "master", "tracks.json"));
            foreach (var t in tracks)
            {
                var m = AssistHarness.Measure(TestUtil.Ruleset(), 120, 9_200_000, t);
                _out.WriteLine(t.Id + ": " + m);
                Assert.True(m.Full <= m.Skilled && m.PlaceFull > m.PlaceSkilled, t.Id + " assist beat skilled play: " + m);
                Assert.True(m.PlaceNone - m.PlaceFull >= 1.5, t.Id + " assist not well above no input: " + m);
                Assert.True(m.FullVsSkilledDuel < 0.5, t.Id + " duel: " + m);
            }
        }

        [Fact]
        public void AssistIsDeterministicAndOnlyUsesNormalInputs()
        {
            // REQ-ASSIST-002: same race twice → identical inputs and hash; replaying the recorded inputs reproduces it
            var rs = TestUtil.Ruleset();
            var horses = Enumerable.Range(0, 12).Select(i => SampleRaces.Horse("h" + i, 500, (RunningStyle)(i % 4))).ToList();
            var cfg = BalanceHarness.Config("det", 42, SampleRaces.Turf2000(), rs, horses, new HashSet<int> { 3 }, _ => 3);
            string Run(out List<InputRecord> rec)
            {
                var race = new OfflineRace(cfg, 3) { Assistant = new InputAssistant(AssistLevel.Full, 3) };
                while (!race.IsFinished) race.StepOnce();
                rec = race.AllInputs();
                return race.ResultHash;
            }
            var h1 = Run(out var r1);
            var h2 = Run(out var r2);
            Assert.Equal(h1, h2);
            Assert.Equal(r1.Select(x => (x.Tick, x.Slot, x.Cmd)), r2.Select(x => (x.Tick, x.Slot, x.Cmd)));
            Assert.Equal(h1, RaceReplay.Run(cfg, r1).Result.Hash);
            Assert.All(r1, x => Assert.Equal(0, x.Cmd & ~Cmd.ClientMask));
            Assert.Contains(r1, x => (x.Cmd & Cmd.Whip) != 0);
            Assert.Contains(r1, x => (x.Cmd & Cmd.Start) != 0);
            Assert.True(r1.Count(x => (x.Cmd & Cmd.Whip) != 0) <= rs.MaxWhips);
        }

        [Fact]
        public void OffChangesNothingAndWhipLevelKeepsThePlayersSteering()
        {
            var rs = TestUtil.Ruleset();
            var horses = Enumerable.Range(0, 12).Select(i => SampleRaces.Horse("h" + i, 500, (RunningStyle)(i % 4))).ToList();
            var cfg = BalanceHarness.Config("off", 7, SampleRaces.Turf2000(), rs, horses, new HashSet<int> { 0 }, _ => 3);
            var plain = new OfflineRace(cfg, 0);
            var off = new OfflineRace(cfg, 0) { Assistant = new InputAssistant(AssistLevel.Off, 0) };
            var whip = new OfflineRace(cfg, 0) { Assistant = new InputAssistant(AssistLevel.Whip, 0) };
            foreach (var r in new[] { plain, off, whip })
                while (!r.IsFinished)
                {
                    // the player starts, steers out once and mashes the whip at 1000 m — the whip assist drops the mashing
                    if (r.Sim.Tick == rs.GateOpenTick) r.Input(Cmd.Start);
                    if (r.Sim.Tick == 400) r.Input(Cmd.LaneOut);
                    if (r.Sim.GetHorse(0).Departed && (r.Sim.Track.Distance - r.Sim.GetHorse(0).Distance).Raw >> 16 < 1000) r.Input(Cmd.Whip);
                    r.StepOnce();
                }
            Assert.Equal(plain.ResultHash, off.ResultHash);
            Assert.Equal(plain.RecordedInputs.Count, off.RecordedInputs.Count);
            Assert.Contains(whip.RecordedInputs, x => x.Tick == rs.GateOpenTick && (x.Cmd & Cmd.Start) != 0);
            Assert.Contains(whip.RecordedInputs, x => x.Tick == 400 && (x.Cmd & Cmd.LaneOut) != 0);
            // whips only inside the spurt zone and spaced (no mashing)
            var whips = whip.RecordedInputs.Where(x => (x.Cmd & Cmd.Whip) != 0).Select(x => x.Tick).ToList();
            Assert.NotEmpty(whips);
            for (int i = 1; i < whips.Count; i++) Assert.True(whips[i] - whips[i - 1] >= rs.WhipDiminishWindowTicks, "spaced");
        }

        [Fact]
        public void TutorialNeverUsesTheAssistAndKeepsItsOutcomeRule()
        {
            // REQ-ASSIST-006 / REQ-UXS-004: assist off in the tutorial — a full assist attached to it sends nothing, and the
            // 3rd-attempt guarantee still holds for a player who never whips
            var rs = TestUtil.Ruleset();
            for (int attempt = 1; attempt <= 3; attempt++)
            {
                var race = OfflinePresets.TutorialRace(rs, attempt);
                race.Assistant = new InputAssistant(AssistLevel.Full, OfflinePresets.TutorialPlayerSlot);
                while (!race.IsFinished) race.StepOnce();
                Assert.Equal(0, race.Assistant.CommandsSent);
                Assert.DoesNotContain(race.RecordedInputs, x => (x.Cmd & Cmd.Whip) != 0);
                int place = Array.IndexOf(race.Sim.Result.Order, OfflinePresets.TutorialPlayerSlot);
                if (attempt >= 3) Assert.Equal(0, place);
                else Assert.Equal(1, place); // 0 whips → a close 2nd
            }
            Assert.False(AssistLevels.AllowedIn(RaceMode.Tutorial));
            Assert.True(AssistLevels.AllowedIn(RaceMode.Ranked));
        }

        private sealed class RecordingFactory : ITransportFactory
        {
            private readonly ITransportFactory _inner;
            public readonly List<string> Sent = new List<string>();
            public readonly List<string> Received = new List<string>();
            public RecordingFactory(ITransportFactory inner) { _inner = inner; }
            public IConnection Open(string url, Action onOpen, Action<string> onMessage, Action<int> onClosed)
                => new Rec(this, _inner.Open(url, onOpen, m => { Received.Add(m); onMessage(m); }, onClosed));
            private sealed class Rec : IConnection
            {
                private readonly RecordingFactory _f; private readonly IConnection _c;
                public Rec(RecordingFactory f, IConnection c) { _f = f; _c = c; }
                public void Send(string m) { _f.Sent.Add(m); _c.Send(m); }
                public void Close() => _c.Close();
            }
        }

        [Fact]
        public void OnlineAssistGoesThroughTheLockstepInputPathAndMarksTheResult()
        {
            // REQ-ASSIST-002/007: online the assistant's commands are ordinary "in" messages (the room adds the input
            // delay) and only our own `res` says the race was assisted; nothing the room sends back names it
            var net = new FakeNet();
            var hr = new Pcg32(5, 5);
            var horses = Enumerable.Range(0, 8).Select(i => SampleRaces.RandomHorse(ref hr, "o" + i)).ToList();
            var cfg = SampleRaces.Config("as_online", 5, SampleRaces.Turf1600(), TestUtil.Ruleset(), horses, 1);
            var relay = new InMemoryRelay(net, cfg, 1000);
            var f = new RecordingFactory(new RelayTransportFactory(net, relay, 0));
            var session = new RaceSession(f, "wss://test/v1/race/x/ws", cfg.RaceId, "tok0") { Assistant = new InputAssistant(AssistLevel.Full, 0) };
            session.Start(0);
            for (long t = 0; t <= 150_000 && !session.IsTerminal && session.State != RaceSessionState.Verifying; t += 5)
            {
                net.RunUntil(t);
                relay.Advance();
                session.Update(t);
                if (session.State == RaceSessionState.Racing) session.Input(Cmd.Whip); // ignored: full assist owns the controls
            }
            Assert.True(session.IsTerminal || session.State == RaceSessionState.Verifying, session.State + " " + session.FailureReason + " " + string.Join("|", session.Client.Errors) + " sent=" + f.Sent.Count);
            var ins = f.Sent.Where(m => m.Contains("\"t\":\"in\"")).ToList();
            Assert.NotEmpty(ins);
            Assert.True(session.Assistant.CommandsSent >= ins.Count - 1);
            Assert.True(relay.Log.Count(x => (x.Cmd & Cmd.Whip) != 0) <= TestUtil.Ruleset().MaxWhips, "player mashing was filtered");
            var res = f.Sent.Last(m => m.Contains("\"t\":\"res\""));
            Assert.Contains("\"assist\":\"full\"", res);
            Assert.DoesNotContain(f.Received, m => m.Contains("assist"));
            // the relay's own re-simulation of the confirmed log agrees: nothing but normal inputs
            Assert.Equal(relay.Replay().Result.Hash, session.Sim.Result.Hash);
        }

        [Fact]
        public void ResultWithoutAssistHasNoAssistField()
        {
            var net = new FakeNet();
            var hr = new Pcg32(6, 5);
            var horses = Enumerable.Range(0, 4).Select(i => SampleRaces.RandomHorse(ref hr, "q" + i)).ToList();
            var cfg = SampleRaces.Config("as_off", 6, SampleRaces.Turf1600(), TestUtil.Ruleset(), horses, 1);
            var relay = new InMemoryRelay(net, cfg, 1000);
            var f = new RecordingFactory(new RelayTransportFactory(net, relay, 0));
            var session = new RaceSession(f, "wss://test/v1/race/x/ws", cfg.RaceId, "tok0") { Assistant = new InputAssistant(AssistLevel.Off, 0) };
            session.Start(0);
            for (long t = 0; t <= 150_000 && !session.IsTerminal; t += 5) { net.RunUntil(t); relay.Advance(); session.Update(t); }
            Assert.DoesNotContain(f.Sent, m => m.Contains("assist"));
        }

        [Fact]
        public void ALostReinEdgeIsSentAgain()
        {
            // online a command can be lost with a dropped socket: the assistant re-sends a rein edge the horse never showed
            var rs = TestUtil.Ruleset();
            var horses = Enumerable.Range(0, 12).Select(i => SampleRaces.Horse("h" + i, 500, (RunningStyle)(i % 4))).ToList();
            var cfg = BalanceHarness.Config("lost", 9, SampleRaces.Turf2000(), rs, horses, new HashSet<int> { 0 }, _ => 3);
            var sim = new RaceSim(cfg);
            var a = new InputAssistant(AssistLevel.Full, 0);
            var cmds = new byte[cfg.Entrants.Count];
            int dropped = -1, resent = -1;
            while (!sim.IsFinished && resent < 0)
            {
                byte c = a.Decide(sim);
                if ((c & (Cmd.ReinPress | Cmd.ReinRelease)) != 0)
                {
                    if (dropped < 0) { dropped = sim.Tick; c = (byte)(c & ~(Cmd.ReinPress | Cmd.ReinRelease)); } // lost on the way
                    else resent = sim.Tick;
                }
                Array.Clear(cmds, 0, cmds.Length); cmds[0] = c;
                sim.Step(cmds);
            }
            Assert.True(dropped >= 0, "the assistant used the rein");
            Assert.True(resent - dropped >= InputAssistant.ResyncTicks, "re-sent only after the resync window, not every tick");
        }

        [Fact]
        public void WireValuesRoundTrip()
        {
            foreach (AssistLevel l in Enum.GetValues(typeof(AssistLevel))) Assert.Equal(l, AssistLevels.Parse(AssistLevels.Wire(l)));
            Assert.Equal(AssistLevel.Off, AssistLevels.Parse(null));
            Assert.Equal(AssistLevel.Off, AssistLevels.Parse("turbo"));
            Assert.Null(AssistLevels.HudLabel(AssistLevel.Off));
            Assert.Equal("かんたん操作 ON", AssistLevels.HudLabel(AssistLevel.Whip));
        }
    }
}
