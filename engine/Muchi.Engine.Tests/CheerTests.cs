using System.Linq;
using Muchi.Client;
using Muchi.Net;
using Muchi.Verifier;

namespace Muchi.Engine.Tests
{
    /// <summary>
    /// 観戦中の応援 (REQ-CHEER-*, contracts/protocol.md §55) on the client: the offer in the spectator start, sending (only when
    /// offered, only spectators), the `cheers` window never touching the race (same hash with and without cheers), old
    /// servers / old clients (§4 compatibility), the throttle, the racer indicator (off, reduced motion, flash limit), the
    /// spectator burst, one KPI row per race, and the replay moments.
    /// </summary>
    public class CheerTests
    {
        private sealed class Recorder : ITransport
        {
            public readonly List<string> Sent = new List<string>();
            public void Send(string message) => Sent.Add(message);
        }

        private static RaceConfig Cfg(string id = "cheer_1") =>
            SampleRaces.Config(id, 5, SampleRaces.Turf1600(), TestUtil.Ruleset(), Enumerable.Range(0, 3).Select(i => TestUtil.H("c" + i)).ToList(), 2, 3, RaceMode.Friend);

        private static string Start(RaceConfig cfg, int you, bool offer)
        {
            var o = JsonNode.Obj();
            o.Set("t", "start");
            o.Set("you", you);
            o.Set("startAtMs", 1000L);
            o.Set("config", ProtocolCodec.ConfigToJson(cfg));
            if (you < 0)
            {
                var sp = JsonNode.Obj();
                sp.Set("delayMs", 0);
                if (offer)
                {
                    var kinds = JsonNode.Arr();
                    foreach (var k in CheerKinds.All) kinds.Add(JsonNode.Str(k));
                    sp.Set("cheer", JsonNode.Obj().Set("kinds", kinds).Set("minIntervalMs", 2000).Set("windowMs", 1000));
                }
                o.Set("spectator", sp);
            }
            return o.ToString();
        }

        private static string Bundle(int from, int to) => "{\"t\":\"b\",\"from\":" + from + ",\"to\":" + to + ",\"in\":[]}";
        private static string Cheers(params (int slot, string kind, int n)[] rows) =>
            "{\"t\":\"cheers\",\"n\":[" + string.Join(",", rows.Select(r => "[" + r.slot + ",\"" + r.kind + "\"," + r.n + "]")) + "]}";

        [Fact]
        public void SpectatorSendsOfferedCheersOnlyAndRacersNever()
        {
            var cfg = Cfg();
            var t = new Recorder();
            var c = new LockstepClient(t, "cheer_1", "tk");
            c.HandleMessage(Start(cfg, -1, true));
            Assert.NotNull(c.CheerOffer);
            Assert.Equal(CheerKinds.All, c.CheerOffer.Kinds.ToArray());
            Assert.Equal(2000, c.CheerOffer.MinIntervalMs);
            Assert.False(c.CanCheer); // nothing seen yet
            Assert.False(c.SendCheer(1, CheerKinds.Go));
            c.HandleMessage(Bundle(0, 19));
            Assert.True(c.CanCheer);
            Assert.True(c.SendCheer(1, CheerKinds.Go));
            Assert.False(c.SendCheer(1, "boo"));
            Assert.False(c.SendCheer(cfg.Entrants.Count, CheerKinds.Go));
            Assert.False(c.SendCheer(-1, CheerKinds.Go));
            var sent = t.Sent.Select(JsonNode.Parse).ToList();
            Assert.Single(sent);
            Assert.Equal("{\"t\":\"cheer\",\"slot\":1,\"kind\":\"go\"}", t.Sent[0]);

            // an older server (no offer) and a racer never send one
            var old = new LockstepClient(new Recorder(), "cheer_1", "tk");
            old.HandleMessage(Start(cfg, -1, false));
            old.HandleMessage(Bundle(0, 19));
            Assert.Null(old.CheerOffer);
            Assert.False(old.SendCheer(0, CheerKinds.Go));
            var rt = new Recorder();
            var racer = new LockstepClient(rt, "cheer_1", "tk");
            racer.HandleMessage(Start(cfg, 0, true));
            racer.HandleMessage(Bundle(0, 19));
            Assert.Null(racer.CheerOffer);
            Assert.False(racer.SendCheer(1, CheerKinds.Go));
            Assert.DoesNotContain(rt.Sent, s => s.Contains("cheer"));
        }

        [Fact]
        public void CheersNeverChangeTheRaceAndAreNotErrors()
        {
            var cfg = Cfg("cheer_2");
            var plain = new LockstepClient(new Recorder(), "cheer_2", "tk");
            var cheered = new LockstepClient(new Recorder(), "cheer_2", "tk");
            plain.HandleMessage(Start(cfg, 0, false));
            cheered.HandleMessage(Start(cfg, 0, false));
            int windows = 0;
            cheered.CheersReceived += (_, rows) => windows++;
            cheered.HandleMessage(Cheers((0, "go", 3))); // before any tick: harmless
            for (int from = 0; !plain.Sim.IsFinished && from < cfg.Ruleset.MaxTicks; from += 20)
            {
                plain.HandleMessage(Bundle(from, from + 19));
                cheered.HandleMessage(Bundle(from, from + 19));
                cheered.HandleMessage(Cheers((0, "go", 3), (1, "hold", 1)));
            }
            Assert.True(plain.Sim.IsFinished && cheered.Sim.IsFinished);
            Assert.Equal(plain.Sim.Result.Hash, cheered.Sim.Result.Hash);
            Assert.Equal(plain.ConfirmedInputs.Count, cheered.ConfirmedInputs.Count);
            Assert.Equal(plain.SentChecksums, cheered.SentChecksums);
            Assert.True(windows > 10);
            Assert.Empty(cheered.Errors);
            // a malformed window is a non-fatal error, never an exception in the frame loop
            cheered.HandleMessage("{\"t\":\"cheers\",\"n\":[[\"x\"]]}");
            Assert.Contains(cheered.Errors, e => e.StartsWith("BAD_MESSAGE"));
            Assert.DoesNotContain(RaceSession.FatalRoomErrors, f => f.StartsWith("CHEER") || f == "NOT_SPECTATOR");
        }

        [Fact]
        public void WindowRowsOutsideTheFieldAreDropped()
        {
            var cfg = Cfg("cheer_3");
            var c = new LockstepClient(new Recorder(), "cheer_3", "tk");
            c.HandleMessage(Start(cfg, -1, true));
            IReadOnlyList<CheerCount> got = null;
            c.CheersReceived += (_, rows) => got = rows;
            c.HandleMessage(Cheers((99, "go", 3), (2, "close", 0), (1, "go", 2)));
            Assert.Single(got);
            Assert.Equal(new CheerCount(1, "go", 2), got[0]);
        }

        [Fact]
        public void ThrottleKeepsTheRoomsPace()
        {
            var th = new CheerThrottle(2000);
            Assert.True(th.CanSend(10_000));
            th.Mark(10_000);
            Assert.False(th.CanSend(11_999));
            Assert.Equal(1, th.RemainingMs(11_999));
            Assert.True(th.CanSend(12_000));
            Assert.True(th.CanSend(5_000)); // clock went back: never locked
        }

        [Fact]
        public void RacerIndicatorIsQuietOptionalAndRespectsMotionAndFlashLimits()
        {
            var ind = new CheerIndicator();
            var w = new List<CheerCount> { new CheerCount(2, "go", 5), new CheerCount(4, "hold", 7), new CheerCount(2, "close", 1) };
            Assert.Equal(6, ind.OnCheers(w, 2, 1000));
            Assert.True(ind.Visible(1000) && ind.Pulse);
            Assert.Equal("応援 ×6", ind.Text);
            Assert.False(ind.Visible(1000 + CheerIndicator.VisibleMs));
            // flash limiter: at most 3 pulses in any second
            ind.OnCheers(w, 2, 1100); ind.OnCheers(w, 2, 1200);
            Assert.True(ind.Pulse);
            ind.OnCheers(w, 2, 1300);
            Assert.False(ind.Pulse);
            Assert.True(ind.Visible(1300)); // the text still shows
            // reduced motion: never a pulse
            var calm = new CheerIndicator { ReduceMotion = true };
            calm.OnCheers(w, 2, 1000);
            Assert.False(calm.Pulse);
            Assert.True(calm.Visible(1000));
            // off: counted but not shown, not "seen"
            var off = new CheerIndicator { On = false };
            off.OnCheers(w, 2, 1000);
            Assert.False(off.Visible(1000));
            Assert.Equal(6, off.Total);
            Assert.Equal(0, off.Seen);
            off.On = true;
            Assert.True(off.Visible(1500));
            Assert.Equal("応援 ×6", off.Text);
            // nothing for our horse
            Assert.Equal(0, ind.OnCheers(new List<CheerCount> { new CheerCount(4, "go", 3) }, 2, 9000));
            Assert.False(ind.Pulse);
        }

        [Fact]
        public void SpectatorBurstShowsTheBiggestLines()
        {
            var b = new CheerBurst();
            b.OnCheers(new List<CheerCount> { new CheerCount(1, "go", 2), new CheerCount(3, "hold", 9), new CheerCount(0, "close", 2), new CheerCount(5, "go", 1), new CheerCount(6, "boo", 50) }, 1000);
            Assert.Equal(new[] { 3, 0, 1 }, b.Lines.Select(l => l.Slot).ToArray());
            Assert.Equal("粘れ！", b.Lines[0].Label);
            Assert.Equal(14, b.Total);
            Assert.Equal(9, b.TotalFor(3));
            Assert.True(b.Visible(1000) && b.Pulse);
            Assert.False(b.Visible(1000 + CheerBurst.VisibleMs));
            var calm = new CheerBurst { ReduceMotion = true };
            calm.OnCheers(new List<CheerCount> { new CheerCount(1, "go", 2) }, 1000);
            Assert.False(calm.Pulse);
        }

        [Fact]
        public void KpiIsOneRowPerRaceNotPerTap()
        {
            var t = new CheerRaceTally();
            for (int i = 0; i < 12; i++) t.AddSent();
            t.AddSeen(40);
            var rows = t.Finish(5000, "friend", "spectator");
            Assert.Equal(new[] { "cheer_send", "cheer_seen" }, rows.Select(r => r.Name).ToArray());
            Assert.Contains("\"count\":12", rows[0].PropsJson);
            Assert.Contains("\"role\":\"spectator\"", rows[1].PropsJson);
            Assert.Empty(t.Finish(6000, "friend", "spectator")); // once
            Assert.Empty(new CheerRaceTally().Finish(1, "friend", "racer")); // nothing sent or seen: no rows
            var tut = new CheerRaceTally(); tut.AddSeen(3);
            Assert.Empty(tut.Finish(1, CheerKinds.ModeName(RaceMode.Tutorial), "racer"));
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.CheerSeen(1, "friend", "host", 1));
            Assert.Equal("cup", CheerKinds.ModeName(RaceMode.Cup));
        }

        [Fact]
        public void ReplayDataCarriesCheerMomentsAndOlderServersHaveNone()
        {
            var cfg = Cfg("cheer_4");
            string log = "{\"v\":1,\"config\":" + ProtocolCodec.ConfigToJson(cfg).ToString() + ",\"endTick\":1600,\"inputs\":[]}";
            var withMoments = ReplayData.FromJson("{\"raceId\":\"cheer_4\",\"owner\":\"me\",\"focusSlot\":0,\"playable\":true,\"entrants\":[],\"replayLog\":" + log + ",\"cheerMoments\":[{\"tick\":400,\"count\":5},{\"tick\":1200,\"count\":3}]}");
            Assert.Equal(new[] { 400, 1200 }, withMoments.CheerMoments.Select(x => x.Tick).ToArray());
            Assert.Equal(0.25, withMoments.CheerMoments[0].Fraction(1600), 6);
            Assert.NotNull(withMoments.Log);
            var old = ReplayData.FromJson("{\"raceId\":\"cheer_4\",\"owner\":\"me\",\"focusSlot\":0,\"playable\":true,\"entrants\":[],\"replayLog\":" + log + "}");
            Assert.Empty(old.CheerMoments);
        }

        [Fact]
        public void LabelsMatchTheServerTable()
        {
            Assert.Equal("いけ！", CheerKinds.Label(CheerKinds.Go));
            Assert.Equal("差せ！", CheerKinds.Label(CheerKinds.Close));
            Assert.Equal("粘れ！", CheerKinds.Label(CheerKinds.Hold));
            Assert.Null(CheerKinds.Label("boo"));
        }
    }
}
