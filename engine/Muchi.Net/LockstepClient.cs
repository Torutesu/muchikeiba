using System;
using System.Collections.Generic;
using System.Globalization;
using Muchi.Engine;

namespace Muchi.Net
{
    /// <summary>Sends text frames to the race room. Implemented by the app (Unity WebSocket) or by tests.</summary>
    public interface ITransport
    {
        void Send(string message);
    }

    public enum FinalStatus { Confirmed, Verifying, Void }

    public sealed class FinalMessage
    {
        public FinalStatus Status;
        public int[] Order;
        public string Hash;
    }

    /// <summary>
    /// Client side of the lockstep protocol (REQ-NET-001..008, contracts/protocol.md §4).
    /// The app forwards every received frame to <see cref="HandleMessage"/> and calls
    /// <see cref="QueueInput"/> when the player taps. The simulation only advances on
    /// ticks the room has confirmed; the renderer interpolates between them.
    /// </summary>
    public sealed class LockstepClient
    {
        private readonly ITransport _transport;
        private readonly string _raceId;
        private readonly string _token;
        private readonly Dictionary<int, byte[]> _inputs = new Dictionary<int, byte[]>();
        private byte[] _scratch;
        private bool _resultSent;

        public LockstepClient(ITransport transport, string raceId, string token)
        {
            _transport = transport ?? throw new ArgumentNullException(nameof(transport));
            _raceId = raceId;
            _token = token;
        }

        public RaceSim Sim { get; private set; }
        public RaceConfig Config { get; private set; }
        /// <summary>Our slot, -1 until the room sends "start".</summary>
        public int Slot { get; private set; } = -1;
        /// <summary>Server epoch ms of tick 0.</summary>
        public long StartAtMs { get; private set; }
        /// <summary>Last tick confirmed by the room (-1 = none).</summary>
        public int ConfirmedTick { get; private set; } = -1;
        public FinalMessage Final { get; private set; }
        /// <summary>Estimated (serverMs - localMs), updated by ping/pong.</summary>
        public long ServerClockOffsetMs { get; private set; }
        public long LastRttMs { get; private set; } = -1;
        /// <summary>Ticks at which the room told us our checksum disagreed with the majority.</summary>
        public readonly List<int> DesyncTicks = new List<int>();
        public readonly List<string> Errors = new List<string>();
        /// <summary>Checksums we computed (tick → hex), for diagnostics/tests.</summary>
        public readonly SortedDictionary<int, string> SentChecksums = new SortedDictionary<int, string>();

        public event Action<LockstepClient> RaceStarted;
        public event Action<LockstepClient, int> TicksAdvanced;
        public event Action<LockstepClient, FinalMessage> RaceFinal;

        /// <summary>Send hello (first join or reconnect). Reports the last tick we simulated.</summary>
        public void Connect()
        {
            var o = JsonNode.Obj();
            o.Set("t", "hello");
            o.Set("raceId", _raceId);
            o.Set("token", _token);
            o.Set("lastTick", Sim == null ? -1 : Sim.Tick - 1);
            _transport.Send(o.ToString());
        }

        /// <summary>Queue a player input for tick ConfirmedTick + inputDelayTicks (REQ-NET-002).</summary>
        public void QueueInput(byte cmd)
        {
            if (Sim == null || Sim.IsFinished) return;
            cmd = (byte)(cmd & Cmd.ClientMask);
            if (cmd == 0) return;
            int target = ConfirmedTick + Config.Net.InputDelayTicks;
            if (target < 0) target = 0;
            var o = JsonNode.Obj();
            o.Set("t", "in");
            o.Set("tick", target);
            o.Set("cmd", cmd);
            _transport.Send(o.ToString());
        }

        public void SendPing(long localNowMs)
        {
            var o = JsonNode.Obj();
            o.Set("t", "ping");
            o.Set("c", localNowMs);
            _transport.Send(o.ToString());
        }

        /// <summary>Feed every frame received from the room. Pass the local clock for ping/pong handling.</summary>
        public void HandleMessage(string json, long localNowMs = 0)
        {
            JsonNode m;
            try { m = JsonNode.Parse(json); }
            catch (FormatException) { Errors.Add("BAD_JSON"); return; }
            string t = m.TryGet("t", out var tn) && tn.Kind == JsonKind.String ? tn.AsString() : null;
            switch (t)
            {
                case "start": OnStart(m); break;
                case "b": OnBundle(m); break;
                case "desync": DesyncTicks.Add(m.Get("tick").AsInt()); break;
                case "final": OnFinal(m); break;
                case "pong":
                    long c = m.Get("c").AsLong(), s = m.Get("s").AsLong();
                    LastRttMs = localNowMs - c;
                    ServerClockOffsetMs = s - (c + LastRttMs / 2);
                    break;
                case "err": Errors.Add(m.Get("code").AsString()); break;
                default: Errors.Add("UNKNOWN_MESSAGE"); break;
            }
        }

        private void OnStart(JsonNode m)
        {
            if (Sim != null) return; // reconnect: keep our simulation
            Config = ProtocolCodec.ParseConfig(m.Get("config"));
            Slot = m.Get("you").AsInt();
            StartAtMs = m.Get("startAtMs").AsLong();
            Sim = new RaceSim(Config);
            _scratch = new byte[Config.Entrants.Count];
            RaceStarted?.Invoke(this);
        }

        private void OnBundle(JsonNode m)
        {
            if (Sim == null) { Errors.Add("BUNDLE_BEFORE_START"); return; }
            int from = m.Get("from").AsInt();
            int to = m.Get("to").AsInt();
            if (to < from) { Errors.Add("BAD_BUNDLE"); return; }
            if (from > ConfirmedTick + 1) { Errors.Add("GAP_IN_BUNDLES"); return; }
            int alreadyConfirmed = ConfirmedTick;
            foreach (var r in m.Get("in").Items)
            {
                int tick = r[0].AsInt(), slot = r[1].AsInt(), cmd = r[2].AsInt();
                if (tick <= alreadyConfirmed) continue; // duplicate delivery
                if (tick < from || tick > to || slot < 0 || slot >= Config.Entrants.Count) { Errors.Add("BAD_BUNDLE_INPUT"); continue; }
                if (!_inputs.TryGetValue(tick, out var arr)) _inputs[tick] = arr = new byte[Config.Entrants.Count];
                arr[slot] |= (byte)cmd;
            }
            if (to > ConfirmedTick) ConfirmedTick = to;
            Pump();
        }

        private void Pump()
        {
            int before = Sim.Tick;
            while (!Sim.IsFinished && Sim.Tick <= ConfirmedTick)
            {
                int tick = Sim.Tick;
                byte[] cmds;
                if (_inputs.TryGetValue(tick, out var arr)) { cmds = arr; _inputs.Remove(tick); }
                else { Array.Clear(_scratch, 0, _scratch.Length); cmds = _scratch; }
                Sim.Step(cmds);
                if (Sim.ChecksumDueForLastTick)
                {
                    SentChecksums[Sim.LastChecksumTick] = Sim.LastChecksum;
                    var o = JsonNode.Obj();
                    o.Set("t", "chk");
                    o.Set("tick", Sim.LastChecksumTick);
                    o.Set("h", Sim.LastChecksum);
                    _transport.Send(o.ToString());
                }
            }
            if (Sim.Tick != before) TicksAdvanced?.Invoke(this, Sim.Tick - 1);
            if (Sim.IsFinished && !_resultSent)
            {
                _resultSent = true;
                var o = JsonNode.Obj();
                o.Set("t", "res");
                o.Set("h", Sim.Result.Hash);
                var order = JsonNode.Arr();
                foreach (var s in Sim.Result.Order) order.Add(JsonNode.Num(s));
                o.Set("order", order);
                // optional (protocol §4): finish ticks in `order` order, -1 = did not finish → best times on consensus races
                var ft = JsonNode.Arr();
                foreach (var f in Sim.Result.FinishTicks) ft.Add(JsonNode.Num(f));
                o.Set("finishTicks", ft);
                _transport.Send(o.ToString());
            }
        }

        private void OnFinal(JsonNode m)
        {
            string st = m.Get("status").AsString();
            var f = new FinalMessage
            {
                Status = st == "confirmed" ? FinalStatus.Confirmed : st == "verifying" ? FinalStatus.Verifying : FinalStatus.Void,
                Hash = m.TryGet("h", out var h) && !h.IsNull ? h.AsString() : null,
            };
            if (m.TryGet("order", out var ord) && ord.Kind == JsonKind.Array)
            {
                f.Order = new int[ord.Count];
                for (int i = 0; i < ord.Count; i++) f.Order[i] = ord[i].AsInt();
            }
            Final = f;
            RaceFinal?.Invoke(this, f);
        }

        /// <summary>
        /// For rendering: fractional tick position to interpolate at, given the local clock.
        /// Returns a value in [Sim.Tick-1, Sim.Tick] (clamped so we never extrapolate past confirmed state).
        /// alphaPermille is the interpolation factor between GetPreviousHorse and GetHorse.
        /// </summary>
        public int InterpolationAlphaPermille(long localNowMs)
        {
            if (Sim == null || Config == null) return 0;
            long serverNow = localNowMs + ServerClockOffsetMs;
            long msPerTick = 1000 / Config.Net.TickHz;
            long lastTickEnd = StartAtMs + (long)Sim.Tick * msPerTick;
            long behind = serverNow - (lastTickEnd - msPerTick) - (long)Config.Net.InputDelayTicks * msPerTick;
            if (behind <= 0) return 0;
            if (behind >= msPerTick) return 1000;
            return (int)(behind * 1000 / msPerTick);
        }

        public override string ToString() => "LockstepClient(slot=" + Slot.ToString(CultureInfo.InvariantCulture) + ", confirmed=" + ConfirmedTick.ToString(CultureInfo.InvariantCulture) + ")";
    }
}
