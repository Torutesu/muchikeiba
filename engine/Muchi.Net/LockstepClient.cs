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
        private readonly List<InputRecord> _confirmedLog = new List<InputRecord>();

        /// <summary>
        /// Every non-zero confirmed input this client simulated, in tick then slot order (REQ-RACE-073):
        /// <c>RaceReplay.Run(Config, ConfirmedInputs)</c> reproduces the race (replay share, REQ-UXS-070).
        /// </summary>
        public IReadOnlyList<InputRecord> ConfirmedInputs => _confirmedLog;

        public LockstepClient(ITransport transport, string raceId, string token)
        {
            _transport = transport ?? throw new ArgumentNullException(nameof(transport));
            _raceId = raceId;
            _token = token;
        }

        public RaceSim Sim { get; private set; }
        public RaceConfig Config { get; private set; }
        /// <summary>Raw `start.visuals` (runner looks + track scene; not hashed). Null on servers without the visual contract.</summary>
        public JsonNode StartVisuals { get; private set; }
        /// <summary>Our slot, -1 until the room sends "start".</summary>
        public int Slot { get; private set; } = -1;
        /// <summary>
        /// True once the room accepted us as a read-only spectator (start.you = -1, REQ-SPEC-002): we never send
        /// inputs, checksums or results, and render <see cref="SpectatorDelayMs"/> behind the room's clock.
        /// </summary>
        public bool IsSpectator { get; private set; }
        /// <summary>How far behind real time the room streams to spectators (start.spectator.delayMs; 0 = live).</summary>
        public int SpectatorDelayMs { get; private set; }
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

        /// <summary>
        /// かんたん操作 (REQ-ASSIST-007): "whip" | "full" when the player's input assistant rode this race, else null.
        /// Sent only in our own `res` (KPI only, outside the result hash); never part of what the room relays.
        /// </summary>
        public string AssistLevel { get; set; }

        public event Action<LockstepClient> RaceStarted;
        public event Action<LockstepClient, int> TicksAdvanced;
        public event Action<LockstepClient, FinalMessage> RaceFinal;
        /// <summary>
        /// REQ-CERR-002 (§60): the room said our checksum disagreed at this tick (also added to <see cref="DesyncTicks"/>).
        /// Diagnostics only: the race itself is unchanged. Muchi.Client ErrorReporter.WatchRace reports race id + tick.
        /// </summary>
        public event Action<LockstepClient, int> Desync;
        /// <summary>The race this client joined.</summary>
        public string RaceId => _raceId;

        /// <summary>Send hello (first join or reconnect). Reports the last tick we simulated.</summary>
        public void Connect()
        {
            var o = JsonNode.Obj();
            o.Set("t", "hello");
            o.Set("raceId", _raceId);
            o.Set("token", _token);
            o.Set("lastTick", Sim == null ? -1 : Sim.Tick - 1);
            o.Set("engine", EngineInfo.Level); // REQ-MNT-008 (§46.4): the room refuses a level it cannot race with (close 4026)
            _transport.Send(o.ToString());
            // The socket may have dropped right after our result went out: send it again so the room does not
            // wait until maxTicks. The room ignores a second "res" from the same slot.
            if (_resultSent && !IsSpectator && Sim != null && Sim.IsFinished && Final == null) SendResult();
        }

        /// <summary>Queue a player input for tick ConfirmedTick + inputDelayTicks (REQ-NET-002).</summary>
        public void QueueInput(byte cmd)
        {
            if (Sim == null || Sim.IsFinished || IsSpectator) return;
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
            try
            {
                switch (t)
                {
                    case "start": OnStart(m); break;
                    case "b": OnBundle(m); break;
                    case "desync":
                        int dt = m.Get("tick").AsInt();
                        DesyncTicks.Add(dt);
                        try { Desync?.Invoke(this, dt); } catch (Exception) { /* a diagnostics listener never breaks the race */ }
                        break;
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
            catch (Exception e) when (e is FormatException || e is ArgumentException || e is InvalidOperationException || e is OverflowException)
            {
                // a malformed known message must never escape into the app's frame loop (RaceSession.Update)
                Errors.Add("BAD_MESSAGE:" + (t ?? "?"));
            }
        }

        private void OnStart(JsonNode m)
        {
            if (Sim != null) return; // reconnect: keep our simulation
            Config = ProtocolCodec.ParseConfig(m.Get("config"));
            StartVisuals = m.TryGet("visuals", out var vis) && vis.Kind == JsonKind.Object ? vis : null;
            Slot = m.Get("you").AsInt();
            IsSpectator = Slot < 0;
            SpectatorDelayMs = IsSpectator && m.TryGet("spectator", out var sp) && sp.Kind == JsonKind.Object && sp.TryGet("delayMs", out var d) ? Math.Max(0, d.AsInt()) : 0;
            StartAtMs = m.Get("startAtMs").AsLong();
            Sim = new RaceSim(Config);
            _scratch = new byte[Config.Entrants.Count];
            _history = new HorseState[Math.Max(4, RenderHistoryCapacity)][];
            for (int i = 0; i < _history.Length; i++) _history[i] = new HorseState[Config.Entrants.Count];
            _historyCount = 0;
            Record(); // state at tick-count 0 (before the first step)
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
                for (int slot = 0; slot < cmds.Length; slot++) if (cmds[slot] != 0) _confirmedLog.Add(new InputRecord(tick, slot, cmds[slot]));
                Sim.Step(cmds);
                Record();
                if (Sim.ChecksumDueForLastTick && !IsSpectator)
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
            if (Sim.IsFinished && !_resultSent && !IsSpectator)
            {
                _resultSent = true;
                SendResult();
            }
        }

        private void SendResult()
        {
            {
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
                // optional (protocol §4, REQ-ACH-002): slots whose unique skill fired — presentation data outside the result
                // hash; the server credits it only when every agreeing client sent the same list
                var sk = JsonNode.Arr();
                for (int slot = 0; slot < Sim.EntrantCount; slot++) if (Sim.GetHorse(slot).SkillUsed) sk.Add(JsonNode.Num(slot));
                o.Set("skills", sk);
                // optional (protocol §27, REQ-ASSIST-007): our own assist level, KPI only
                if (AssistLevel == "whip" || AssistLevel == "full") o.Set("assist", AssistLevel);
                _transport.Send(o.ToString());
            }
        }

        private void OnFinal(JsonNode m)
        {
            string st = m.Get("status").AsString();
            if (st != "confirmed" && st != "verifying" && st != "void")
            {
                // an unknown status (newer server?) must not end the race as Void
                Errors.Add("BAD_FINAL_STATUS");
                return;
            }
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
        /// Legacy single-tick interpolation; prefer <see cref="TryGetRenderState"/>, which renders across the
        /// buffered tick history and stays smooth when bundles carry several ticks.
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

        // ------------------------------------------------------------------ rendering (REQ-NET-004)

        private HorseState[][] _history;   // ring buffer: snapshot after k steps lives at k % length
        private int _historyCount;         // number of snapshots recorded (= Sim.Tick + 1 while running)

        /// <summary>How many past tick states are kept for smooth rendering (set before "start").</summary>
        public int RenderHistoryCapacity { get; set; } = 64;

        /// <summary>
        /// Extra render delay on top of one bundle interval (ms). Rendering this far behind the room's clock means
        /// the confirmed ticks are almost always already here, so horses move every frame instead of in bursts.
        /// </summary>
        public int RenderExtraDelayMs { get; set; } = 50;

        private void Record()
        {
            var slot = _history[_historyCount % _history.Length];
            for (int i = 0; i < slot.Length; i++) slot[i] = Sim.GetHorse(i);
            _historyCount++;
        }

        /// <summary>
        /// Render position in thousandths of a tick (tick-count units: 1000 = state after the first step), from the
        /// local clock: server time − (bundle interval + <see cref="RenderExtraDelayMs"/>), clamped to the states we
        /// actually hold (never extrapolates). Returns -1 before "start".
        /// </summary>
        public long RenderTickPermille(long localNowMs)
        {
            if (Sim == null || Config == null || _historyCount == 0) return -1;
            long msPerTick = Math.Max(1, 1000 / Config.Net.TickHz);
            long serverNow = localNowMs + ServerClockOffsetMs;
            long delayMs = (long)Config.Net.BundleIntervalTicks * msPerTick + RenderExtraDelayMs + SpectatorDelayMs;
            long f = (serverNow - StartAtMs - delayMs) * 1000 / msPerTick;
            long newest = (long)(_historyCount - 1) * 1000;
            long oldest = (long)Math.Max(0, _historyCount - _history.Length) * 1000;
            if (f > newest) f = newest;
            if (f < oldest) f = oldest;
            return f;
        }

        /// <summary>
        /// The two tick states to draw between and the blend factor (‰) for <paramref name="slot"/> at the local
        /// time. Draw <c>from + (to − from) × alpha / 1000</c>. False before "start".
        /// </summary>
        public bool TryGetRenderState(int slot, long localNowMs, out HorseState from, out HorseState to, out int alphaPermille)
        {
            from = default; to = default; alphaPermille = 0;
            long f = RenderTickPermille(localNowMs);
            if (f < 0 || slot < 0 || slot >= Config.Entrants.Count) return false;
            int a = (int)(f / 1000);
            int b = Math.Min(a + 1, _historyCount - 1);
            alphaPermille = b == a ? 0 : (int)(f % 1000);
            from = _history[a % _history.Length][slot];
            to = _history[b % _history.Length][slot];
            return true;
        }

        public override string ToString() => "LockstepClient(slot=" + Slot.ToString(CultureInfo.InvariantCulture) + ", confirmed=" + ConfirmedTick.ToString(CultureInfo.InvariantCulture) + ")";
    }
}
