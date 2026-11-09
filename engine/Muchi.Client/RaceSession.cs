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
    /// socket closes or fails to open, with the close code of the room's close frame, or <see cref="CloseCodes.Abnormal"/>
    /// (1006) when the socket dropped or failed without one. The code decides whether the session reconnects (<see cref="CloseCodes"/>).
    /// </summary>
    public interface ITransportFactory
    {
        IConnection Open(string url, Action onOpen, Action<string> onMessage, Action<int> onClosed);
    }

    /// <summary>
    /// WebSocket close codes of the race room (server/src/do/raceRoom.ts, contracts/protocol.md §4.1) and how
    /// <see cref="RaceSession"/> treats them. Any other code (1000, 1001, 1005, 1006, 1011, 1012, …) is a lost
    /// connection: the session reconnects with backoff, bounded by <see cref="RaceSessionOptions.MaxReconnectAttempts"/>.
    /// </summary>
    public static class CloseCodes
    {
        /// <summary>The socket closed without a close frame (network drop, failed connect, abort). Reconnect.</summary>
        public const int Abnormal = 1006;
        /// <summary>The room has no race ("no race"; also the runtime's generic internal error). Reconnect: a missing room then fails the upgrade until the attempts run out.</summary>
        public const int InternalError = 1011;
        /// <summary>A newer socket of the same player took over the seat (or spectator seat). Fatal "REPLACED": reconnecting would replace the newer one in turn.</summary>
        public const int Replaced = 4000;
        /// <summary>The ticket was rejected (after err UNAUTHORIZED). Fatal "UNAUTHORIZED".</summary>
        public const int Unauthorized = 4001;
        /// <summary>The spectator seats are taken (after err SPECTATORS_FULL). Fatal "SPECTATORS_FULL".</summary>
        public const int SpectatorsFull = 4003;

        /// <summary>The <see cref="RaceSession.FailureReason"/> for a close code after which reconnecting cannot help; null = reconnect.</summary>
        public static string FatalReason(int code)
        {
            switch (code)
            {
                case Replaced: return "REPLACED";
                case Unauthorized: return "UNAUTHORIZED";
                case SpectatorsFull: return "SPECTATORS_FULL";
                default: return null;
            }
        }
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
        /// <summary>Gave up (could not reconnect, a fatal protocol error, or the room closed us for good, e.g. "REPLACED").</summary>
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
        /// <summary>
        /// Runner looks and the track scene (from `start`; derived defaults when the server sent none). Null before start.
        /// </summary>
        public RaceVisuals Visuals => _visuals ?? (Client.Config == null ? null : _visuals = RaceVisuals.Parse(Client.StartVisuals) ?? RaceVisuals.Fallback(Client.Config));
        private RaceVisuals _visuals;
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
                Assist();
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

        /// <summary>
        /// かんたん操作 (REQ-ASSIST-002/007). Set before the race starts. After every advance of the confirmed simulation the
        /// assistant's command goes out as an ordinary "in" message (the room adds the input delay like for a tap), the
        /// player's own bits are filtered (<see cref="InputAssistant.FilterPlayer"/>), and our `res` says the level (KPI
        /// only: the room never shows it to anyone). Ignored for spectators and in the tutorial.
        /// </summary>
        public InputAssistant Assistant
        {
            get => _assistant;
            set { _assistant = value; Client.AssistLevel = value != null && value.Active ? AssistLevels.Wire(value.Level) : null; }
        }
        private InputAssistant _assistant;

        /// <summary>The assist level that actually rides (Off for spectators, in the tutorial, or without an assistant).</summary>
        public AssistLevel EffectiveAssist => _assistant != null && _assistant.Active && Sim != null && !Client.IsSpectator && _assistant.Slot == Slot
            && AssistLevels.AllowedIn(Sim.Config.Mode) ? _assistant.Level : AssistLevel.Off;

        private void Assist()
        {
            if (EffectiveAssist == AssistLevel.Off || Sim.IsFinished || !_open) return;
            if (State != RaceSessionState.Racing && State != RaceSessionState.Waiting) return;
            byte a = _assistant.Decide(Sim);
            if (a != 0) Client.QueueInput(a);
        }

        /// <summary>Queue a player input (Cmd.*). Ignored unless racing.</summary>
        public void Input(byte cmd)
        {
            if (State != RaceSessionState.Racing && State != RaceSessionState.Waiting) return;
            if (!_open) return; // inputs while disconnected would be lost anyway
            if (EffectiveAssist != AssistLevel.Off) cmd = _assistant.FilterPlayer(Sim, cmd);
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
                    code => Post(gen, () => OnClosed(code)));
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

        /// <summary>
        /// Room error codes after which reconnecting cannot help (expired/invalid ticket, not a member, the spectator
        /// seats are taken, a spectator socket sent a player message). The code becomes <see cref="FailureReason"/>.
        /// </summary>
        public static readonly string[] FatalRoomErrors = { "UNAUTHORIZED", "NOT_IN_RACE", "SPECTATORS_FULL", "SPECTATOR_READ_ONLY" };

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

        private void OnClosed(int code)
        {
            _open = false;
            _conn = null;
            if (IsTerminal) return;
            // 4000: the same player opened this race (or this spectator seat) on another device. Reconnecting would
            // replace that socket in turn, and the two devices would keep taking the seat from each other.
            string fatal = CloseCodes.FatalReason(code);
            if (fatal != null) { Fail(fatal); return; }
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
