using System;
using System.Collections.Generic;
using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Client
{
    /// <summary>An open WebSocket. Send must be safe to call from the Unity main thread.</summary>
    public interface IConnection : ITransport
    {
        void Close();
    }

    /// <summary>
    /// Opens WebSockets (Codex implements with the Unity WebSocket library of choice).
    /// Callbacks may arrive on any thread: RaceSession queues them and handles them in <see cref="RaceSession.Update"/>.
    /// Call onOpen once the socket is open, onMessage for every text frame, onClosed exactly once when the
    /// socket closes or fails to open.
    /// </summary>
    public interface ITransportFactory
    {
        IConnection Open(string url, Action onOpen, Action<string> onMessage, Action onClosed);
    }

    public enum RaceSessionState
    {
        Connecting,
        /// <summary>Lost the connection; trying again with backoff.</summary>
        Reconnecting,
        /// <summary>Config received; waiting for tick 0.</summary>
        Waiting,
        Racing,
        /// <summary>Our simulation finished and the result hash was sent; waiting for the room's decision.</summary>
        Finished,
        /// <summary>The room sent the race to the verifier; a second final will follow.</summary>
        Verifying,
        Confirmed,
        Void,
        /// <summary>Gave up (could not reconnect, or a fatal protocol error).</summary>
        Failed,
    }

    public sealed class RaceSessionOptions
    {
        public int PingIntervalMs = 2000;
        public int ReconnectBaseMs = 500;
        public int ReconnectMaxMs = 8000;
        public int MaxReconnectAttempts = 8;
        /// <summary>Close the socket this long after the final decision (lets the last frames flush).</summary>
        public int CloseAfterFinalMs = 500;
    }

    /// <summary>
    /// One online race for the UI: connection lifecycle around <see cref="LockstepClient"/>.
    /// Drive it from the Unity main thread: call <see cref="Update"/> every frame with a monotonic clock in ms.
    /// </summary>
    public sealed class RaceSession : ITransport
    {
        private readonly ITransportFactory _factory;
        private readonly string _url;
        private readonly RaceSessionOptions _opt;
        private readonly object _gate = new object();
        private readonly Queue<Action> _inbox = new Queue<Action>();

        private IConnection _conn;
        private int _connGeneration;
        private bool _open;
        private int _attempts;
        private long _reconnectAt = -1;
        private long _nextPingAt;
        private long _closeAt = -1;
        private long _now;
        private bool _started;

        public LockstepClient Client { get; }
        public RaceSessionState State { get; private set; } = RaceSessionState.Connecting;
        public RaceSim Sim => Client.Sim;
        public int Slot => Client.Slot;
        public FinalMessage Final => Client.Final;
        public int ReconnectCount { get; private set; }
        public string FailureReason { get; private set; }

        /// <summary>(old, new)</summary>
        public event Action<RaceSessionState, RaceSessionState> StateChanged;
        public event Action<RaceSession> RaceStarted;
        /// <summary>Raised for every final message (Verifying first, then Confirmed/Void).</summary>
        public event Action<RaceSession, FinalMessage> FinalReceived;
        /// <summary>Raised after the simulation advanced (argument = last simulated tick).</summary>
        public event Action<RaceSession, int> TicksAdvanced;

        public RaceSession(ITransportFactory factory, string webSocketUrl, string raceId, string ticket, RaceSessionOptions options = null)
        {
            _factory = factory ?? throw new ArgumentNullException(nameof(factory));
            _url = webSocketUrl;
            _opt = options ?? new RaceSessionOptions();
            Client = new LockstepClient(this, raceId, ticket);
            Client.RaceStarted += c => { _started = true; SetState(RaceSessionState.Waiting); RaceStarted?.Invoke(this); };
            Client.TicksAdvanced += (c, t) =>
            {
                if (State == RaceSessionState.Waiting) SetState(RaceSessionState.Racing);
                if (c.Sim.IsFinished && State == RaceSessionState.Racing) SetState(RaceSessionState.Finished);
                TicksAdvanced?.Invoke(this, t);
            };
            Client.RaceFinal += (c, f) =>
            {
                SetState(f.Status == FinalStatus.Confirmed ? RaceSessionState.Confirmed : f.Status == FinalStatus.Verifying ? RaceSessionState.Verifying : RaceSessionState.Void);
                if (f.Status != FinalStatus.Verifying) _closeAt = _now + _opt.CloseAfterFinalMs;
                FinalReceived?.Invoke(this, f);
            };
        }

        public bool IsTerminal => State == RaceSessionState.Confirmed || State == RaceSessionState.Void || State == RaceSessionState.Failed;

        /// <summary>Opens the socket. Call once.</summary>
        public void Start(long nowMs)
        {
            _now = nowMs;
            OpenConnection();
        }

        /// <summary>Queue a player input (Cmd.*). Ignored unless racing.</summary>
        public void Input(byte cmd)
        {
            if (State != RaceSessionState.Racing && State != RaceSessionState.Waiting) return;
            if (!_open) return; // inputs while disconnected would be lost anyway
            Client.QueueInput(cmd);
        }

        /// <summary>Process queued network events, pings and reconnects. Call every frame.</summary>
        public void Update(long nowMs)
        {
            _now = nowMs;
            while (true)
            {
                Action a;
                lock (_gate)
                {
                    if (_inbox.Count == 0) break;
                    a = _inbox.Dequeue();
                }
                a();
            }

            if (IsTerminal)
            {
                if (_closeAt >= 0 && nowMs >= _closeAt) { _closeAt = -1; CloseConnection(); }
                return;
            }

            if (_reconnectAt >= 0 && nowMs >= _reconnectAt)
            {
                _reconnectAt = -1;
                OpenConnection();
            }

            if (_open && nowMs >= _nextPingAt)
            {
                _nextPingAt = nowMs + _opt.PingIntervalMs;
                Client.SendPing(nowMs);
            }
        }

        /// <summary>Leave the race (the room hands the horse to the CPU after its grace period).</summary>
        public void Dispose()
        {
            _reconnectAt = -1;
            CloseConnection();
            if (!IsTerminal) Fail("disposed");
        }

        /// <summary>Interpolation factor for rendering between GetPreviousHorse and GetHorse (legacy; prefer <see cref="TryGetRenderState"/>).</summary>
        public int InterpolationAlphaPermille(long nowMs) => Client.InterpolationAlphaPermille(nowMs);

        /// <summary>Smooth rendering across buffered ticks: draw from + (to − from) × alpha / 1000 (see LockstepClient.TryGetRenderState).</summary>
        public bool TryGetRenderState(int slot, long nowMs, out HorseState from, out HorseState to, out int alphaPermille)
            => Client.TryGetRenderState(slot, nowMs, out from, out to, out alphaPermille);

        void ITransport.Send(string message)
        {
            if (_open) _conn?.Send(message);
        }

        private void Post(int generation, Action a)
        {
            lock (_gate) _inbox.Enqueue(() => { if (generation == _connGeneration) a(); });
        }

        private void OpenConnection()
        {
            int gen = ++_connGeneration;
            if (State != RaceSessionState.Connecting && !IsTerminal && (_started || ReconnectCount > 0)) SetState(RaceSessionState.Reconnecting);
            try
            {
                _conn = _factory.Open(_url,
                    () => Post(gen, OnOpen),
                    msg => Post(gen, () => OnMessage(msg)),
                    () => Post(gen, OnClosed));
            }
            catch (Exception e)
            {
                _conn = null;
                ScheduleReconnect("open failed: " + e.Message);
            }
        }

        private void OnOpen()
        {
            _open = true;
            _nextPingAt = _now;
            Client.Connect(); // hello with lastTick → the room re-sends everything we missed
        }

        /// <summary>Room error codes after which reconnecting cannot help (expired/invalid ticket, not a member).</summary>
        public static readonly string[] FatalRoomErrors = { "UNAUTHORIZED", "NOT_IN_RACE" };

        private void OnMessage(string msg)
        {
            var before = Client.Errors.Count;
            bool startedBefore = _started;
            int confirmedBefore = Client.ConfirmedTick;
            var finalBefore = Client.Final;
            Client.HandleMessage(msg, _now);

            for (int i = before; i < Client.Errors.Count; i++)
            {
                string code = Client.Errors[i];
                if (Array.IndexOf(FatalRoomErrors, code) >= 0)
                {
                    // e.g. the ticket expired while the app was in the background: retrying would loop forever
                    CloseConnection();
                    Fail(code);
                    return;
                }
                if (code == "GAP_IN_BUNDLES") { CloseConnection(); ScheduleReconnect("gap in bundles"); return; }
            }

            // Only real progress proves the connection works again (an "err" or "pong" does not).
            if ((!startedBefore && _started) || Client.ConfirmedTick > confirmedBefore || !ReferenceEquals(Client.Final, finalBefore))
                _attempts = 0;

            if (!_started) return;
            if (State == RaceSessionState.Reconnecting)
                SetState(RestoredState());
        }

        /// <summary>State to return to after a reconnect (keeps "verifying" if the room already said so).</summary>
        private RaceSessionState RestoredState()
        {
            if (Client.Final != null && Client.Final.Status == FinalStatus.Verifying) return RaceSessionState.Verifying;
            if (Sim.IsFinished) return RaceSessionState.Finished;
            return Client.ConfirmedTick >= 0 ? RaceSessionState.Racing : RaceSessionState.Waiting;
        }

        private void OnClosed()
        {
            _open = false;
            _conn = null;
            if (IsTerminal) return;
            ScheduleReconnect("connection closed");
        }

        private void ScheduleReconnect(string reason)
        {
            _open = false;
            if (_attempts >= _opt.MaxReconnectAttempts) { Fail(reason); return; }
            long delay = (long)_opt.ReconnectBaseMs << Math.Min(_attempts, 16);
            if (delay > _opt.ReconnectMaxMs) delay = _opt.ReconnectMaxMs;
            _attempts++;
            ReconnectCount++;
            _reconnectAt = _now + delay;
            if (State != RaceSessionState.Connecting || _started) SetState(RaceSessionState.Reconnecting);
        }

        private void CloseConnection()
        {
            _open = false;
            var c = _conn;
            _conn = null;
            _connGeneration++;
            try { c?.Close(); } catch (Exception) { }
        }

        private void Fail(string reason)
        {
            FailureReason = reason;
            _reconnectAt = -1;
            SetState(RaceSessionState.Failed);
        }

        private void SetState(RaceSessionState s)
        {
            if (State == s) return;
            if (IsTerminal) return; // terminal states are final
            var old = State;
            State = s;
            StateChanged?.Invoke(old, s);
        }
    }
}
