using System;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Game
{
    /// <summary>Race lifecycle as the race screen sees it (online and offline look the same to the UI).</summary>
    public enum RacePhase { Connecting, Reconnecting, Waiting, Racing, Finished, Verifying, Confirmed, Void, Failed }

    /// <summary>
    /// One race the screen drives every frame. The authoritative state is always the engine's
    /// <see cref="RaceSim"/>: offline races step it locally (<see cref="OfflineRace"/>), online races step it
    /// from confirmed lockstep bundles (<see cref="RaceSession"/>). The renderer only reads from it.
    /// </summary>
    public interface IRaceDriver : IDisposable
    {
        bool Online { get; }
        /// <summary>null until the online room sent "start".</summary>
        RaceConfig Config { get; }
        RaceSim Sim { get; }
        int PlayerSlot { get; }
        RacePhase Phase { get; }
        /// <summary>The race needs no more frames: offline finished, or online reached a terminal state.</summary>
        bool Done { get; }
        string FailureReason { get; }
        /// <summary>Visual descriptors (start.visuals online; derived from the config offline).</summary>
        RaceVisuals Visuals { get; }
        /// <summary>Online room's final decision (hash/order), null offline or before it arrives.</summary>
        FinalMessage Final { get; }
        void Update(long nowMs);
        void Input(byte cmd);
        /// <summary>Two engine states and the interpolation factor to draw a slot at `nowMs`.</summary>
        bool TryGetRender(int slot, long nowMs, out HorseState from, out HorseState to, out int alphaPermille);
        /// <summary>Race clock since the gate opened (finish time once the player has finished).</summary>
        long ElapsedMs(long nowMs);
    }

    public sealed class OfflineRaceDriver : IRaceDriver
    {
        private readonly OfflineRace _race;
        private bool _started;
        private RaceVisuals _visuals;

        public OfflineRaceDriver(RaceConfig config, int playerSlot, bool autoStart)
        {
            _race = new OfflineRace(config, playerSlot) { AutoStart = autoStart };
        }

        /// <summary>Drives an existing local race (e.g. <c>TimeAttackRun.Race</c>, whose inputs are submitted afterwards).</summary>
        public OfflineRaceDriver(OfflineRace race)
        {
            _race = race ?? throw new ArgumentNullException(nameof(race));
        }

        public OfflineRace Race => _race;
        public bool Online => false;
        public RaceConfig Config => _race.Config;
        public RaceSim Sim => _race.Sim;
        public int PlayerSlot => _race.PlayerSlot;
        public RacePhase Phase => !_started ? RacePhase.Waiting : _race.IsFinished ? RacePhase.Finished : RacePhase.Racing;
        public bool Done => _race.IsFinished;
        public string FailureReason => null;
        public FinalMessage Final => null;
        public RaceVisuals Visuals => _visuals ?? (_visuals = RaceVisuals.Fallback(_race.Config));

        public void Update(long nowMs)
        {
            if (!_started) { _race.Start(nowMs); _started = true; }
            _race.Update(nowMs);
        }

        public void Input(byte cmd) { if (cmd != 0 && _started) _race.Input(cmd); }

        public bool TryGetRender(int slot, long nowMs, out HorseState from, out HorseState to, out int alphaPermille)
        {
            from = default; to = default; alphaPermille = 0;
            if (slot < 0 || slot >= Sim.EntrantCount) return false;
            from = Sim.GetPreviousHorse(slot);
            to = Sim.GetHorse(slot);
            alphaPermille = _race.InterpolationAlphaPermille(nowMs);
            return true;
        }

        public long ElapsedMs(long nowMs) => RaceClock.ElapsedMs(Sim, Config, PlayerSlot);

        public void Dispose() { }
    }

    public sealed class OnlineRaceDriver : IRaceDriver
    {
        private readonly RaceSession _session;
        private bool _started;

        public OnlineRaceDriver(RaceSession session) { _session = session ?? throw new ArgumentNullException(nameof(session)); }

        public RaceSession Session => _session;
        public bool Online => true;
        public RaceConfig Config => _session.Client.Config;
        public RaceSim Sim => _session.Sim;
        public int PlayerSlot => _session.Slot;
        public bool Done => _session.IsTerminal;
        public string FailureReason => _session.FailureReason;
        public RaceVisuals Visuals => _session.Visuals;
        public FinalMessage Final => _session.Final;

        public RacePhase Phase
        {
            get
            {
                switch (_session.State)
                {
                    case RaceSessionState.Connecting: return RacePhase.Connecting;
                    case RaceSessionState.Reconnecting: return RacePhase.Reconnecting;
                    case RaceSessionState.Waiting: return RacePhase.Waiting;
                    case RaceSessionState.Racing: return RacePhase.Racing;
                    case RaceSessionState.Finished: return RacePhase.Finished;
                    case RaceSessionState.Verifying: return RacePhase.Verifying;
                    case RaceSessionState.Confirmed: return RacePhase.Confirmed;
                    case RaceSessionState.Void: return RacePhase.Void;
                    default: return RacePhase.Failed;
                }
            }
        }

        public void Update(long nowMs)
        {
            if (!_started) { _session.Start(nowMs); _started = true; }
            _session.Update(nowMs);
        }

        public void Input(byte cmd)
        {
            if (cmd == 0 || Sim == null || Sim.IsFinished) return;
            _session.Input(cmd);
        }

        public bool TryGetRender(int slot, long nowMs, out HorseState from, out HorseState to, out int alphaPermille)
        {
            from = default; to = default; alphaPermille = 0;
            if (Sim == null) return false;
            return _session.TryGetRenderState(slot, nowMs, out from, out to, out alphaPermille);
        }

        public long ElapsedMs(long nowMs) => Sim == null ? 0 : RaceClock.ElapsedMs(Sim, Config, PlayerSlot);

        public void Dispose() => _session.Dispose();
    }

    public static class RaceClock
    {
        public static int MsPerTick(RaceConfig c) => 1000 / Math.Max(1, c.Net.TickHz);

        /// <summary>Time since the gate opened from the engine tick (the player's exact finish time once finished).</summary>
        public static long ElapsedMs(RaceSim sim, RaceConfig config, int playerSlot)
        {
            int ms = MsPerTick(config);
            int gate = config.Ruleset.GateOpenTick;
            if (playerSlot >= 0 && playerSlot < sim.EntrantCount)
            {
                var h = sim.GetHorse(playerSlot);
                if (h.Finished) return (long)(h.FinishTick - gate) * ms + (long)h.FinishFracRaw * ms / 65536;
            }
            return Math.Max(0, (long)(sim.Tick - gate) * ms);
        }
    }
}
