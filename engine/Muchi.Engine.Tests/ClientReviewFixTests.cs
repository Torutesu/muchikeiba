using System.Collections.Concurrent;
using Muchi.Client;
using Muchi.Net;
using Muchi.Verifier;

namespace Muchi.Engine.Tests
{
    /// <summary>Single-threaded SynchronizationContext, like Unity's main thread.</summary>
    internal sealed class MainThreadContext : SynchronizationContext
    {
        private readonly BlockingCollection<(SendOrPostCallback cb, object state)> _q = new BlockingCollection<(SendOrPostCallback, object)>();
        public int ThreadId { get; private set; }

        public override void Post(SendOrPostCallback d, object state) => _q.Add((d, state));
        public override void Send(SendOrPostCallback d, object state) => throw new NotSupportedException();

        /// <summary>Runs <paramref name="body"/> on a dedicated "main" thread, pumping continuations until it completes.</summary>
        public static int Run(Func<Task> body)
        {
            var ctx = new MainThreadContext();
            Exception error = null;
            var t = new Thread(() =>
            {
                ctx.ThreadId = Environment.CurrentManagedThreadId;
                SetSynchronizationContext(ctx);
                Task task;
                try { task = body(); }
                catch (Exception e) { error = e; return; }
                task.ContinueWith(_ => ctx._q.CompleteAdding(), TaskScheduler.Default);
                foreach (var (cb, st) in ctx._q.GetConsumingEnumerable()) cb(st);
                try { task.GetAwaiter().GetResult(); } catch (Exception e) { error = e; }
            });
            t.Start();
            if (!t.Join(TimeSpan.FromSeconds(30))) throw new TimeoutException("main thread did not finish");
            if (error != null) throw new Exception("body failed", error);
            return ctx.ThreadId;
        }
    }

    /// <summary>Regression tests for the round-5 C# review (engine/client).</summary>
    public class ClientReviewFixTests
    {
        private static RaceConfig Cfg(int horses, int humans, ulong seed = 7, TrackSpec track = null)
        {
            var hr = new Pcg32(seed, 5);
            var list = Enumerable.Range(0, horses).Select(i => SampleRaces.RandomHorse(ref hr, "h" + i)).ToList();
            return SampleRaces.Config("rv_" + seed, seed, track ?? SampleRaces.Turf2000(), TestUtil.Ruleset(), list, humans);
        }

        private static string StartMsg(RaceConfig cfg, int you = 0, long startAtMs = 0)
        {
            var o = JsonNode.Obj();
            o.Set("t", "start");
            o.Set("you", you);
            o.Set("startAtMs", startAtMs);
            o.Set("config", ProtocolCodec.ConfigToJson(cfg));
            return o.ToString();
        }

        private static string Bundle(int from, int to) => "{\"t\":\"b\",\"from\":" + from + ",\"to\":" + to + ",\"in\":[]}";

        // ------------------------------------------------------------------ HIGH 1: fatal room errors

        /// <summary>Server that accepts the first connection and then refuses every reconnect with an err + close.</summary>
        private sealed class ScriptedFactory : ITransportFactory
        {
            public int Opens;
            public readonly List<string> Sent = new List<string>();
            public Func<int, string, string[]> OnHello; // (open#, hello) → frames to send back
            public Func<int, bool> CloseAfterHello = _ => false;
            private Action<string> _onMessage;
            private Action<int> _onClosed;
            public bool IsOpen;

            public IConnection Open(string url, Action onOpen, Action<string> onMessage, Action<int> onClosed)
            {
                Opens++;
                _onMessage = onMessage;
                _onClosed = onClosed;
                IsOpen = true;
                int n = Opens;
                var conn = new Conn(this, n);
                onOpen();
                return conn;
            }

            public void Push(string frame) => _onMessage(frame);
            /// <summary>The socket closes: a network drop (1006) or the room's close frame with that code.</summary>
            public void Drop(int code = CloseCodes.Abnormal) { if (!IsOpen) return; IsOpen = false; _onClosed(code); }

            private sealed class Conn : IConnection
            {
                private readonly ScriptedFactory _f;
                private readonly int _n;
                public Conn(ScriptedFactory f, int n) { _f = f; _n = n; }
                public void Send(string message)
                {
                    _f.Sent.Add(message);
                    if (!message.Contains("\"t\":\"hello\"")) return;
                    foreach (var frame in _f.OnHello?.Invoke(_n, message) ?? Array.Empty<string>()) _f._onMessage(frame);
                    if (_f.CloseAfterHello(_n)) _f.Drop();
                }
                public void Close() { }
            }
        }

        private static void Pump(RaceSession s, long fromMs, long toMs, int stepMs = 50)
        {
            for (long t = fromMs; t <= toMs; t += stepMs) { s.Update(t); if (s.IsTerminal) return; }
        }

        [Fact]
        public void ExpiredTicketOnReconnectFailsInsteadOfLoopingForever()
        {
            var cfg = Cfg(4, 1);
            var f = new ScriptedFactory
            {
                OnHello = (n, _) => n == 1 ? new[] { StartMsg(cfg), Bundle(0, 10) } : new[] { "{\"t\":\"err\",\"code\":\"UNAUTHORIZED\"}" },
                CloseAfterHello = n => n > 1,
            };
            var s = new RaceSession(f, "wss://x", cfg.RaceId, "tok");
            s.Start(0);
            Pump(s, 0, 200);
            Assert.Equal(RaceSessionState.Racing, s.State);
            f.Drop(); // app backgrounded; the ticket expires meanwhile
            Pump(s, 200, 600_000);
            Assert.Equal(RaceSessionState.Failed, s.State);
            Assert.Equal("UNAUTHORIZED", s.FailureReason);
            Assert.True(f.Opens <= 3, "opens: " + f.Opens);
        }

        /// <summary>QA r7: a full spectator room (or a read-only refusal) fails at once with the code instead of ~45 s of retries.</summary>
        [Theory]
        [InlineData("SPECTATORS_FULL")]
        [InlineData("SPECTATOR_READ_ONLY")]
        public void SpectatorRefusalsAreFatal(string code)
        {
            var f = new ScriptedFactory
            {
                OnHello = (n, _) => new[] { "{\"t\":\"err\",\"code\":\"" + code + "\"}" },
                CloseAfterHello = _ => true,
            };
            var s = new RaceSession(f, "wss://x", "rv_spec", "tok");
            s.Start(0);
            Pump(s, 0, 600_000);
            Assert.Equal(RaceSessionState.Failed, s.State);
            Assert.Equal(code, s.FailureReason);
            Assert.Equal(1, f.Opens);
            Assert.Contains(code, RaceSession.FatalRoomErrors);
        }

        /// <summary>
        /// QA r7 leftover: the room closes an older socket of the same player with 4000 ("replaced") when a newer one
        /// says hello (the same spectator on a second device, or the rider's seat). Reconnecting would replace the
        /// newer socket in turn and the two devices would keep taking the seat from each other: stop instead.
        /// </summary>
        [Theory]
        [InlineData(true)]
        [InlineData(false)]
        public void ReplacedSocketStopsInsteadOfTakingTheSeatBack(bool spectator)
        {
            var cfg = Cfg(4, 1);
            string start = StartMsg(cfg, spectator ? -1 : 0);
            var f = new ScriptedFactory { OnHello = (n, _) => new[] { start, Bundle(0, 10) } };
            var s = spectator
                ? new SpectatorSession(f, "wss://x", new SpectatorTicket { RaceId = cfg.RaceId, Ticket = "spec" }).Session
                : new RaceSession(f, "wss://x", cfg.RaceId, "tok");
            var states = new List<RaceSessionState>();
            s.StateChanged += (_, now) => states.Add(now);
            s.Start(0);
            Pump(s, 0, 200);
            Assert.Equal(RaceSessionState.Racing, s.State);
            Assert.Equal(spectator, s.Client.IsSpectator);

            f.Drop(CloseCodes.Replaced); // the same player said hello from another device
            Pump(s, 200, 600_000);
            Assert.Equal(RaceSessionState.Failed, s.State);
            Assert.Equal("REPLACED", s.FailureReason);
            Assert.Equal(1, f.Opens);
            Assert.Equal(0, s.ReconnectCount);
            Assert.DoesNotContain(RaceSessionState.Reconnecting, states);
        }

        /// <summary>Every close code the room sends (server/src/do/raceRoom.ts) is mapped on purpose.</summary>
        [Theory]
        [InlineData(4000, "REPLACED")]
        [InlineData(4001, "UNAUTHORIZED")]
        [InlineData(4003, "SPECTATORS_FULL")]
        [InlineData(1011, null)] // "no race" / the runtime's internal error: reconnect (bounded)
        [InlineData(1006, null)] // no close frame: network drop
        [InlineData(1000, null)]
        [InlineData(1001, null)]
        [InlineData(1005, null)]
        [InlineData(1012, null)] // service restart
        public void CloseCodesAreMappedDeliberately(int code, string fatal)
        {
            Assert.Equal(fatal, CloseCodes.FatalReason(code));
            var cfg = Cfg(4, 1);
            var f = new ScriptedFactory { OnHello = (n, _) => n == 1 ? new[] { StartMsg(cfg), Bundle(0, 10) } : new[] { Bundle(0, 20) } };
            var s = new RaceSession(f, "wss://x", cfg.RaceId, "tok");
            s.Start(0);
            Pump(s, 0, 200);
            f.Drop(code);
            Pump(s, 200, 30_000);
            if (fatal != null)
            {
                Assert.Equal(RaceSessionState.Failed, s.State);
                Assert.Equal(fatal, s.FailureReason);
                Assert.Equal(1, f.Opens);
            }
            else
            {
                Assert.Equal(RaceSessionState.Racing, s.State); // reconnected and caught up
                Assert.Equal(2, f.Opens);
                Assert.Equal(20, s.Client.ConfirmedTick);
            }
        }

        /// <summary>An err frame and its close (4003 after SPECTATORS_FULL) give one failure with the room's code.</summary>
        [Fact]
        public void SpectatorsFullCloseWithoutTheErrFrameIsStillFatal()
        {
            var f = new ScriptedFactory { OnHello = (n, _) => Array.Empty<string>() };
            var s = new RaceSession(f, "wss://x", "rv_spec", "tok");
            s.Start(0);
            Pump(s, 0, 100);
            f.Drop(CloseCodes.SpectatorsFull);
            Pump(s, 100, 600_000);
            Assert.Equal(RaceSessionState.Failed, s.State);
            Assert.Equal("SPECTATORS_FULL", s.FailureReason);
            Assert.Equal(1, f.Opens);
        }

        [Fact]
        public void ErrorFramesDoNotResetTheReconnectBudget()
        {
            var cfg = Cfg(4, 1);
            var f = new ScriptedFactory
            {
                OnHello = (n, _) => n == 1 ? new[] { StartMsg(cfg), Bundle(0, 10) } : new[] { "{\"t\":\"err\",\"code\":\"BAD_MESSAGE\"}" },
                CloseAfterHello = n => n > 1,
            };
            var s = new RaceSession(f, "wss://x", cfg.RaceId, "tok", new RaceSessionOptions { MaxReconnectAttempts = 3 });
            s.Start(0);
            Pump(s, 0, 200);
            f.Drop();
            Pump(s, 200, 600_000);
            Assert.Equal(RaceSessionState.Failed, s.State);
            Assert.Equal(1 + 3, f.Opens); // first connection + exactly MaxReconnectAttempts
        }

        [Fact]
        public void ReconnectKeepsVerifyingAndResendsAnUnansweredResult()
        {
            var cfg = Cfg(3, 1);
            int ticks = cfg.Ruleset.MaxTicks;
            var f = new ScriptedFactory
            {
                OnHello = (n, _) => n == 1 ? new[] { StartMsg(cfg), Bundle(0, ticks - 1) } : new[] { Bundle(0, ticks - 1) },
            };
            var s = new RaceSession(f, "wss://x", cfg.RaceId, "tok");
            s.Start(0);
            Pump(s, 0, 100);
            Assert.True(s.Sim.IsFinished);
            Assert.Equal(1, f.Sent.Count(m => m.Contains("\"t\":\"res\"")));

            // socket drops right after the result went out: the reconnect must send it again
            f.Drop();
            Pump(s, 100, 20_000);
            Assert.Equal(2, f.Sent.Count(m => m.Contains("\"t\":\"res\"")));

            // the room sends the race to the verifier; a later drop must not lose that status
            f.Push("{\"t\":\"final\",\"status\":\"verifying\",\"order\":[0,1,2],\"h\":null}");
            s.Update(20_100);
            Assert.Equal(RaceSessionState.Verifying, s.State);
            f.Drop();
            Pump(s, 20_200, 40_000);
            Assert.Equal(RaceSessionState.Verifying, s.State);
            Assert.Equal(2, f.Sent.Count(m => m.Contains("\"t\":\"res\""))); // Final known: no more resends
        }

        // ------------------------------------------------------------------ HIGH 2 / MED 3: main-thread affinity

        private sealed class ThreadRecordingHttp : IHttp
        {
            public readonly ConcurrentQueue<int> Threads = new ConcurrentQueue<int>();
            public readonly Queue<int> Statuses = new Queue<int>();
            public Task<HttpResponse> SendAsync(HttpRequest request, CancellationToken ct)
            {
                Threads.Enqueue(Environment.CurrentManagedThreadId);
                int status = Statuses.Dequeue();
                return Task.Run(() => new HttpResponse(status, status == 200 ? "{\"ok\":true}" : "{\"error\":{\"code\":\"INTERNAL\"}}")); // completes on the pool
            }
        }

        private sealed class PoolAuth : IAuthTokenProvider
        {
            public readonly ConcurrentQueue<int> Threads = new ConcurrentQueue<int>();
            public Task<string> GetTokenAsync(bool forceRefresh, CancellationToken ct)
            {
                Threads.Enqueue(Environment.CurrentManagedThreadId);
                return Task.Run(async () => { await Task.Delay(1); return "tok"; });
            }
        }

        private sealed class TimerDelay : IDelay
        {
            public Task Delay(int ms, CancellationToken ct) => Task.Delay(1, ct); // completes on a timer thread
        }

        [Fact]
        public void ApiClientCallsIHttpAndAuthOnTheCallersThreadAcrossRetries()
        {
            var http = new ThreadRecordingHttp();
            foreach (var st in new[] { 503, 503, 200 }) http.Statuses.Enqueue(st);
            var auth = new PoolAuth();
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test/" };
            opt.Retry.Jitter = _ => 0;
            var api = new ApiClient(http, auth, opt, new TimerDelay(), new SeqIds());

            int main = MainThreadContext.Run(async () => { await api.GetPlayerAsync(); });

            Assert.Equal(3, http.Threads.Count);
            Assert.All(http.Threads, id => Assert.Equal(main, id));
            Assert.All(auth.Threads, id => Assert.Equal(main, id));
        }

        private sealed class ThreadRecordingStore : IAnalyticsStore
        {
            public readonly ConcurrentQueue<int> SaveThreads = new ConcurrentQueue<int>();
            public string Load() => null;
            public void Save(string json) => SaveThreads.Enqueue(Environment.CurrentManagedThreadId);
        }

        [Fact]
        public void AnalyticsPersistsOnTheCallersThread()
        {
            var store = new ThreadRecordingStore();
            AnalyticsSend send = (p, v, events, ct) => Task.Run(() => new AnalyticsIngestResult { Accepted = events.Count });
            var client = new AnalyticsClient(send, new AnalyticsOptions(), store, 0);
            int main = MainThreadContext.Run(async () =>
            {
                for (int i = 0; i < 3; i++) client.Track(AnalyticsEvent.SessionStart(1000 + i));
                await client.FlushAllAsync(5000);
            });
            Assert.Equal(3, client.Sent);
            Assert.True(store.SaveThreads.Count >= 4);
            Assert.All(store.SaveThreads, id => Assert.Equal(main, id));
        }

        private sealed class ThrowingStore : IAnalyticsStore
        {
            public string Load() => null;
            public void Save(string json) => throw new InvalidOperationException("PlayerPrefs off main thread");
        }

        [Fact]
        public void AnalyticsStorageFailuresAreReported()
        {
            var client = new AnalyticsClient((p, v, e, ct) => Task.FromResult(new AnalyticsIngestResult()), new AnalyticsOptions(), new ThrowingStore(), 0);
            Exception seen = null;
            client.StorageError += e => seen = e;
            client.Track(AnalyticsEvent.SessionStart(1000));
            Assert.IsType<InvalidOperationException>(seen);
            Assert.Same(seen, client.LastStorageError);
        }

        // ------------------------------------------------------------------ MED 4: one flush at a time

        [Fact]
        public void FlushAllAndUpdateNeverSendTheSameBatchTwice()
        {
            var pending = new List<(int count, TaskCompletionSource<AnalyticsIngestResult> tcs)>();
            AnalyticsSend send = (p, v, events, ct) =>
            {
                var tcs = new TaskCompletionSource<AnalyticsIngestResult>();
                pending.Add((events.Count, tcs));
                return tcs.Task;
            };
            var client = new AnalyticsClient(send, new AnalyticsOptions { MaxBatch = 50, FlushIntervalMs = 0 }, null, 0);
            for (int i = 0; i < 60; i++) client.Track(AnalyticsEvent.SessionStart(1000 + i));

            var all = client.FlushAllAsync(2000);
            Assert.Single(pending);
            Assert.False(client.Update(100_000)); // a flush is already in flight
            Assert.Single(pending);

            pending[0].tcs.SetResult(new AnalyticsIngestResult { Accepted = pending[0].count });
            Assert.Equal(2, pending.Count);
            pending[1].tcs.SetResult(new AnalyticsIngestResult { Accepted = pending[1].count });
            Assert.True(all.IsCompleted);
            Assert.Equal(60, pending.Sum(x => x.count));
            Assert.Equal(60, client.Sent);
            Assert.Equal(0, client.Pending);
        }

        // ------------------------------------------------------------------ LockstepClient robustness

        private sealed class ListTransport : ITransport
        {
            public readonly List<string> Sent = new List<string>();
            public void Send(string message) => Sent.Add(message);
        }

        [Fact]
        public void UnknownFinalStatusIsAnErrorNotVoid()
        {
            var t = new ListTransport();
            var c = new LockstepClient(t, "r", "tok");
            c.HandleMessage(StartMsg(Cfg(3, 1)));
            c.HandleMessage("{\"t\":\"final\",\"status\":\"overtime\",\"order\":[0,1,2]}");
            Assert.Null(c.Final);
            Assert.Contains("BAD_FINAL_STATUS", c.Errors);
        }

        [Theory]
        [InlineData("{\"t\":\"b\"}")]
        [InlineData("{\"t\":\"b\",\"from\":0,\"to\":3,\"in\":[[1]]}")]
        [InlineData("{\"t\":\"pong\"}")]
        [InlineData("{\"t\":\"desync\"}")]
        [InlineData("{\"t\":\"final\"}")]
        [InlineData("{\"t\":\"err\"}")]
        [InlineData("{\"t\":\"start\",\"you\":0}")]
        public void MalformedKnownMessagesNeverThrow(string frame)
        {
            var t = new ListTransport();
            var c = new LockstepClient(t, "r", "tok");
            if (!frame.Contains("start")) c.HandleMessage(StartMsg(Cfg(3, 1)));
            c.HandleMessage(frame); // must not throw into the app's frame loop
            Assert.Contains(c.Errors, e => e.StartsWith("BAD_MESSAGE", StringComparison.Ordinal));
        }

        [Fact]
        public void ConnectResendsTheResultUntilTheRoomDecides()
        {
            var cfg = Cfg(3, 1);
            var t = new ListTransport();
            var c = new LockstepClient(t, cfg.RaceId, "tok");
            c.HandleMessage(StartMsg(cfg));
            c.HandleMessage(Bundle(0, cfg.Ruleset.MaxTicks - 1));
            Assert.True(c.Sim.IsFinished);
            c.Connect();
            Assert.Equal(2, t.Sent.Count(m => m.Contains("\"t\":\"res\"")));
            c.HandleMessage("{\"t\":\"final\",\"status\":\"confirmed\",\"order\":[0,1,2],\"h\":\"x\"}");
            c.Connect();
            Assert.Equal(2, t.Sent.Count(m => m.Contains("\"t\":\"res\"")));
        }

        // ------------------------------------------------------------------ MED 7: smooth rendering

        [Fact]
        public void RenderingAdvancesEveryFrameWhenBundlesCarryTwoTicks()
        {
            var cfg = Cfg(4, 1);
            var t = new ListTransport();
            var c = new LockstepClient(t, cfg.RaceId, "tok");
            c.HandleMessage(StartMsg(cfg, 0, startAtMs: 0));
            int ms = 1000 / cfg.Net.TickHz;
            int confirmed = -1;
            var moves = new List<double>();
            double last = double.NaN;
            for (long now = 0; now < 30_000; now += 16)
            {
                // the room confirms tick n at (n+1)*ms and sends a bundle every 2 ticks; 30 ms network latency
                int canConfirm = (int)((now - 30) / ms) - 1;
                while (confirmed + 2 <= canConfirm) { c.HandleMessage(Bundle(confirmed + 1, confirmed + 2)); confirmed += 2; }
                Assert.True(c.TryGetRenderState(0, now, out var a, out var b, out int alpha));
                double d = (a.Distance.Raw + (b.Distance.Raw - a.Distance.Raw) * alpha / 1000.0) / 65536.0;
                if (now >= 10_000 && now <= 25_000 && !double.IsNaN(last)) moves.Add(d - last);
                last = d;
            }
            double mean = moves.Average();
            Assert.True(mean > 0.1);
            Assert.True(moves.Min() > mean * 0.5, "min " + moves.Min() + " mean " + mean);
            Assert.True(moves.Max() < mean * 1.6, "max " + moves.Max() + " mean " + mean);
        }

        // ------------------------------------------------------------------ MED 6: commentary timing

        private static List<CommentaryLine> Commentary(RaceConfig cfg, int processFromTick = 0, int focus = 0)
        {
            var sim = new RaceSim(cfg);
            var com = new Commentator(CommentaryTests.Templates(), cfg, focus);
            var lines = new List<CommentaryLine>();
            var empty = new byte[cfg.Entrants.Count];
            while (!sim.IsFinished)
            {
                sim.Step(empty);
                if (sim.Tick - 1 >= processFromTick) lines.AddRange(com.Process(sim));
            }
            return lines;
        }

        [Fact]
        public void GateCallIsOnTimeEvenAfterTheGroundIntro()
        {
            var cfg = Cfg(8, 0, 11, SampleRaces.WithGoing(SampleRaces.Turf2000(), Going.SoftOrSloppy, night: true));
            var lines = Commentary(cfg);
            var intro = lines.First();
            Assert.StartsWith("ground_", intro.Kind);
            var gate = lines.Single(l => l.Kind == "gate_open");
            Assert.Equal(cfg.Ruleset.GateOpenTick, gate.Tick);
            Assert.True(intro.Tick + intro.DurationTicks <= gate.Tick);
            Assert.True(intro.Interrupted);
        }

        [Fact]
        public void BatchedProcessingSkipsStaleKeyMomentsButKeepsTheFinish()
        {
            var cfg = Cfg(8, 0, 12, SampleRaces.WithGoing(SampleRaces.Turf2000(), Going.Good, night: false));
            var lines = Commentary(cfg, processFromTick: 700);
            Assert.DoesNotContain(lines, l => l.Kind == "gate_open" || l.Kind.StartsWith("ground_", StringComparison.Ordinal));
            Assert.Contains(lines, l => Commentator.IsWinKind(l.Kind));
            Assert.Contains(lines, l => l.Kind == "result");
        }

        [Theory]
        [InlineData(1, "result_solo")]
        [InlineData(2, "result_two")]
        public void SmallFieldsStillGetAResultLine(int horses, string kind)
        {
            var lines = Commentary(Cfg(horses, 0, 13));
            Assert.Contains(lines, l => l.Kind == kind);
        }

        // ------------------------------------------------------------------ MED 8: compact time attack recordings

        private static byte RandomCmd(ref Pcg32 rng) => (byte)(rng.Range(0, 64) & Cmd.ClientMask);

        [Theory]
        [InlineData(1UL, 1)]
        [InlineData(2UL, 6)]
        [InlineData(3UL, 12)]
        public void StrippingNoOpTapsNeverChangesTheRace(ulong seed, int horses)
        {
            var cfg = Cfg(horses, 1, seed);
            var raw = new RaceSim(cfg);
            var off = new OfflineRace(cfg, 0);
            var rng = new Pcg32(seed, 9);
            var cmds = new byte[horses];
            while (!raw.IsFinished)
            {
                byte c = rng.Chance(1, 2) ? RandomCmd(ref rng) : (byte)0;
                Array.Clear(cmds, 0, cmds.Length);
                cmds[0] = c;
                raw.Step(cmds);
                off.Input(c);
                off.StepOnce();
                Assert.Equal(raw.Tick, off.Sim.Tick);
                if (raw.ChecksumDueForLastTick) Assert.Equal(raw.LastChecksum, off.Sim.LastChecksum);
            }
            Assert.True(off.IsFinished);
            Assert.Equal(raw.Result.Hash, off.ResultHash);
            Assert.Equal(off.ResultHash, RaceReplay.Run(cfg, off.RecordedInputs.ToList()).Sim.Result.Hash);
        }

        [Fact]
        public void MashingStaysUnderTheServerInputLimit()
        {
            var hr = new Pcg32(5, 5);
            var cfg = SampleRaces.Config("ta_mash", 5, SampleRaces.Turf2000(), TestUtil.Ruleset(), new List<HorseSpec> { SampleRaces.RandomHorse(ref hr, "me") }, 1, mode: RaceMode.TimeAttack);
            var run = new OfflineRace(cfg, 0) { MaxRecordedInputs = TimeAttackLimits.MaxInputs };
            int taps = 0;
            while (!run.IsFinished)
            {
                var h = run.Sim.GetHorse(0);
                // start mashing, rein toggling, lane taps and whip mashing (10/s over the last 900 m)
                if (run.Sim.Tick < cfg.Ruleset.GateOpenTick + 10) { run.Input(Cmd.Start); taps++; }
                bool stretch = run.Sim.Track.Distance - h.Distance < Fx.FromInt(700);
                if (run.Sim.Tick % 5 == 0) { run.Input(stretch ? Cmd.ReinRelease : Cmd.ReinPress); taps++; } // holds/frees the rein repeatedly
                if (run.Sim.Tick % 3 == 0) { run.Input(Cmd.LaneOut); taps++; }
                if (run.Sim.Track.Distance - h.Distance < Fx.FromInt(900) && run.Sim.Tick % 2 == 0) { run.Input(Cmd.Whip); taps++; }
                run.StepOnce();
            }
            Assert.True(taps > 1000, "taps " + taps);
            Assert.True(run.RecordedInputs.Count <= TimeAttackLimits.MaxInputs, "recorded " + run.RecordedInputs.Count);
            Assert.False(run.InputCapReached);
            Assert.Equal(run.ResultHash, RaceReplay.Run(cfg, run.RecordedInputs.ToList()).Sim.Result.Hash);
        }

        [Fact]
        public void InputCapKeepsTheRunReproducible()
        {
            var cfg = Cfg(1, 1, 21);
            var run = new OfflineRace(cfg, 0) { MaxRecordedInputs = 5 };
            while (!run.IsFinished)
            {
                if (run.Sim.GetHorse(0).Departed && run.Sim.Tick % 7 == 0) run.Input(run.Sim.Tick % 14 == 0 ? Cmd.LaneOut : Cmd.LaneIn);
                run.StepOnce();
            }
            Assert.Equal(5, run.RecordedInputs.Count);
            Assert.True(run.InputCapReached);
            Assert.Equal(run.ResultHash, RaceReplay.Run(cfg, run.RecordedInputs.ToList()).Sim.Result.Hash);
        }

        [Fact]
        public void SubmittingTooManyInputsFailsBeforeTheRequest()
        {
            var http = new FakeHttp();
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test/" };
            var api = new ApiClient(http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
            var session = new TimeAttackSession { SessionId = "s", Token = "t" };
            var inputs = Enumerable.Range(0, TimeAttackLimits.MaxInputs + 1).Select(i => new InputRecord(100 + i, 0, Cmd.Whip)).ToList();
            Assert.Throws<ArgumentException>(() => { api.SubmitTimeAttackAsync(session, inputs, new string('a', 64)).GetAwaiter().GetResult(); });
            Assert.Empty(http.Requests);
        }

        // ------------------------------------------------------------------ LOW: strict JSON, config bounds

        [Theory]
        [InlineData("\"\\u 41 \"")]
        [InlineData("--5")]
        [InlineData("1.2.3")]
        [InlineData("01")]
        [InlineData("-")]
        [InlineData("1.")]
        [InlineData("1e")]
        [InlineData("\"\\ud800\"")]
        [InlineData("\"\\udc00\"")]
        [InlineData("\"\\ud800\\u0041\"")]
        public void StrictJsonRejectsMalformedInput(string json)
        {
            Assert.Throws<FormatException>(() => JsonNode.Parse(json));
        }

        [Fact]
        public void StrictJsonStillAcceptsValidInput()
        {
            Assert.Equal("1e3", JsonNode.Parse("1e3").NumberText);
            Assert.Equal("-0.5", JsonNode.Parse("-0.5").NumberText);
            Assert.Equal(0, JsonNode.Parse("0").AsInt());
            Assert.Equal("😀", JsonNode.Parse("\"\\ud83d\\ude00\"").AsString());
            Assert.Equal("😀A", JsonNode.Parse("\"😀\\u0041\"").AsString());
        }

        [Fact]
        public void DuplicateKeysAreFoundInLargeObjects()
        {
            var sb = new System.Text.StringBuilder("{");
            for (int i = 0; i < 20_000; i++) sb.Append("\"k").Append(i).Append("\":").Append(i).Append(',');
            string ok = sb.ToString().TrimEnd(',') + "}";
            Assert.Equal(20_000, JsonNode.Parse(ok).Count);
            Assert.Throws<FormatException>(() => JsonNode.Parse(sb.Append("\"k123\":0}").ToString()));
        }

        [Theory]
        [InlineData(1000, 1000)]
        [InlineData(61, 120)]
        [InlineData(0, 120)]
        [InlineData(20, 2_000_000)]
        public void ConfigBoundsPreventDivisionByZeroAndOverflow(int tickHz, int radiusM)
        {
            var cfg = Cfg(2, 0);
            cfg.Net.TickHz = tickHz;
            foreach (var s in cfg.Track.Segments) if (s.Kind == SegmentKind.Corner) s.RadiusM = radiusM;
            Assert.Throws<ArgumentException>(() => cfg.Validate());
        }
    }
}
