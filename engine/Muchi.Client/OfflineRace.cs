using System;
using System.Collections.Generic;
using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Client
{
    /// <summary>
    /// A race run entirely on the device (tutorial, time attack, practice): no server, same engine.
    /// Fixed-step driver: call <see cref="Update"/> every frame with a monotonic clock in ms; the simulation
    /// advances in 1/tickHz steps, catching up at most <see cref="MaxCatchUpTicks"/> per frame.
    /// </summary>
    public sealed class OfflineRace
    {
        private readonly List<byte> _queued = new List<byte>();
        private readonly byte[] _cmds;
        private readonly int _msPerTick;
        private long _anchorMs = -1;   // clock time of tick 0
        private long _pausedAt = -1;

        public RaceSim Sim { get; }
        public RaceConfig Config { get; }
        /// <summary>Slot controlled by the player (-1 = spectate).</summary>
        public int PlayerSlot { get; }
        /// <summary>Press START automatically when the gate opens (tutorial "only the whip matters").</summary>
        public bool AutoStart { get; set; }
        public int MaxCatchUpTicks { get; set; } = 10;
        /// <summary>
        /// Upper bound on <see cref="RecordedInputs"/> (time attack: the server accepts at most
        /// <see cref="TimeAttackLimits.MaxInputs"/>). Once reached, further player inputs are ignored so the run
        /// stays submittable and reproducible; <see cref="InputCapReached"/> tells the UI.
        /// </summary>
        public int MaxRecordedInputs { get; set; } = int.MaxValue;
        public bool InputCapReached { get; private set; }
        public bool IsPaused => _pausedAt >= 0;
        public bool IsFinished => Sim.IsFinished;

        public event Action<OfflineRace, int> TicksAdvanced;
        public event Action<OfflineRace, RaceResult> Finished;
        /// <summary>Raised after every single simulated tick (exact per-tick observers: RaceFeelTracker, RaceDebriefRecorder).</summary>
        public event Action<OfflineRace> Stepped;

        /// <summary>
        /// Optional offline-only script that rides the non-CPU slots other than the player and may restrict the
        /// player's command bits (the tutorial's rival, REQ-UXS-004). Must be deterministic: it only reads the
        /// race state and the player's command of the tick. Its commands are kept in <see cref="DirectorInputs"/>.
        /// </summary>
        public IOfflineRaceDirector Director { get; set; }

        public OfflineRace(RaceConfig config, int playerSlot)
        {
            config.Validate();
            Config = config;
            PlayerSlot = playerSlot;
            Sim = new RaceSim(config);
            _cmds = new byte[config.Entrants.Count];
            _msPerTick = 1000 / config.Net.TickHz;
            // the tutorial preset's rival needs its director (attempt 1); OfflinePresets.TutorialRace sets the attempt
            if (TutorialDirector.Fits(config, playerSlot)) Director = new TutorialDirector(1, playerSlot, OfflinePresets.TutorialRivalSlot);
        }

        public void Start(long nowMs)
        {
            _anchorMs = nowMs;

        }

        /// <summary>Queue an input (Cmd.*) for the next simulated tick.</summary>
        public void Input(byte cmd)
        {
            if (PlayerSlot < 0 || IsPaused || Sim.IsFinished) return;
            _queued.Add((byte)(cmd & Cmd.ClientMask));
        }

        public void Pause(long nowMs)
        {
            if (IsPaused || _anchorMs < 0) return;
            _pausedAt = nowMs;
        }

        public void Resume(long nowMs)
        {
            if (!IsPaused) return;
            _anchorMs += nowMs - _pausedAt; // shift the timeline so paused time does not count
            _pausedAt = -1;

        }

        public void Update(long nowMs)
        {
            if (_anchorMs < 0) throw new InvalidOperationException("call Start first");

            if (IsPaused || Sim.IsFinished) return;
            long elapsedTicks = (nowMs - _anchorMs) / _msPerTick;
            int steps = 0;
            int before = Sim.Tick;
            while (!Sim.IsFinished && Sim.Tick < elapsedTicks && steps < MaxCatchUpTicks)
            {
                StepOnce();
                steps++;
            }
            // if we hit the catch-up cap, slide the timeline instead of running a burst next frame
            if (!Sim.IsFinished && Sim.Tick < elapsedTicks) _anchorMs = nowMs - (long)Sim.Tick * _msPerTick;
            if (Sim.Tick != before) TicksAdvanced?.Invoke(this, Sim.Tick - 1);
            if (Sim.IsFinished) Finished?.Invoke(this, Sim.Result);
        }

        /// <summary>Advance exactly one tick regardless of the clock (tests, replays, "skip").</summary>
        public void StepOnce()
        {
            if (Sim.IsFinished) return;
            Array.Clear(_cmds, 0, _cmds.Length);
            if (PlayerSlot >= 0)
            {
                byte c = 0;
                foreach (var q in _queued) c |= q;
                _queued.Clear();
                if (AutoStart && (Sim.Tick == Sim.P.GateOpenTick || Sim.Tick == Sim.P.GateOpenTick + 1)) c |= Cmd.Start;
                c = EffectiveCommand(Sim, PlayerSlot, c);
                if (Director != null) c = (byte)(c & Director.AllowedPlayerBits);
                if (c != 0 && _recorded.Count >= MaxRecordedInputs) { c = 0; InputCapReached = true; }
                _cmds[PlayerSlot] = c;
                if (c != 0) _recorded.Add(new InputRecord(Sim.Tick, PlayerSlot, c));
            }
            if (Director != null)
            {
                Director.Drive(Sim, PlayerSlot, PlayerSlot >= 0 ? _cmds[PlayerSlot] : (byte)0, _cmds);
                for (int i = 0; i < _cmds.Length; i++)
                {
                    if (i == PlayerSlot) continue;
                    byte d = EffectiveCommand(Sim, i, _cmds[i]);
                    _cmds[i] = d;
                    if (d != 0) _directorRecorded.Add(new InputRecord(Sim.Tick, i, d));
                }
            }
            Sim.Step(_cmds);
            Stepped?.Invoke(this);
        }

        private readonly List<InputRecord> _recorded = new List<InputRecord>();
        private readonly List<InputRecord> _directorRecorded = new List<InputRecord>();

        /// <summary>Commands the <see cref="Director"/> gave to its slots (tick order).</summary>
        public IReadOnlyList<InputRecord> DirectorInputs => _directorRecorded;

        /// <summary>
        /// Every input of the race (player + director), tick then slot order: <c>RaceReplay.Run(Config, AllInputs)</c>
        /// reproduces the run exactly. Without a director this equals <see cref="RecordedInputs"/>.
        /// </summary>
        public List<InputRecord> AllInputs()
        {
            var all = new List<InputRecord>(_recorded.Count + _directorRecorded.Count);
            all.AddRange(_recorded);
            all.AddRange(_directorRecorded);
            all.Sort((a, b) => a.Tick != b.Tick ? a.Tick.CompareTo(b.Tick) : a.Slot.CompareTo(b.Slot));
            return all;
        }

        /// <summary>
        /// The command with every bit removed that provably does nothing in <see cref="RaceSim"/> this tick (it
        /// mirrors RaceSim's command resolution and ApplyCommands), so mashing does not bloat the recording.
        /// Applying the result gives exactly the same simulation as applying <paramref name="c"/>.
        /// </summary>
        public static byte EffectiveCommand(RaceSim sim, int slot, byte c)
        {
            var h = sim.GetHorse(slot);
            if (h.Finished || h.CpuControlled) return 0;
            var p = sim.P;
            int t = sim.Tick;
            c = (byte)(c & Cmd.ClientMask);
            // same conflict resolution as RaceSim.Step
            if ((c & Cmd.LaneIn) != 0 && (c & Cmd.LaneOut) != 0) c = (byte)(c & ~(Cmd.LaneIn | Cmd.LaneOut));
            if ((c & Cmd.ReinPress) != 0 && (c & Cmd.ReinRelease) != 0) c = (byte)(c & ~Cmd.ReinPress);

            // START only matters on the tick it releases the horse from the gate
            if ((c & Cmd.Start) != 0 && (h.Departed || t < p.GateOpenTick)) c = (byte)(c & ~Cmd.Start);
            bool departs = h.Departed || (t >= p.GateOpenTick && ((c & Cmd.Start) != 0 || t - p.GateOpenTick >= p.AutoStartDelayTicks));

            // rein is a level: pressing while held / releasing while free changes nothing
            if ((c & Cmd.ReinPress) != 0 && h.Reining) c = (byte)(c & ~Cmd.ReinPress);
            if ((c & Cmd.ReinRelease) != 0 && !h.Reining) c = (byte)(c & ~Cmd.ReinRelease);

            if (!departs) return (byte)(c & ~(Cmd.LaneIn | Cmd.LaneOut | Cmd.Whip));
            if ((c & (Cmd.LaneIn | Cmd.LaneOut)) != 0)
            {
                int target = h.LaneTarget + ((c & Cmd.LaneIn) != 0 ? -1 : 1);
                if (h.IsChangingLane || target < 0 || target >= p.LaneCount) c = (byte)(c & ~(Cmd.LaneIn | Cmd.LaneOut));
            }
            if ((c & Cmd.Whip) != 0 && h.WhipsLeft <= 0) c = (byte)(c & ~Cmd.Whip);
            return c;
        }

        /// <summary>
        /// Every non-zero effective command applied to the player's horse (no-op taps are not recorded), in tick
        /// order (one per tick). Together with
        /// <see cref="Config"/> this reproduces the run exactly: it is what a time attack submits (REQ-TA-003).
        /// </summary>
        public IReadOnlyList<InputRecord> RecordedInputs => _recorded;

        /// <summary>Result hash of the finished run (null until finished).</summary>
        public string ResultHash => Sim.IsFinished ? Sim.Result.Hash : null;

        /// <summary>Interpolation factor (‰) between GetPreviousHorse and GetHorse for rendering.</summary>
        public int InterpolationAlphaPermille(long nowMs)
        {
            if (_anchorMs < 0 || Sim.Tick == 0) return 1000;
            long t = (IsPaused ? _pausedAt : nowMs) - _anchorMs - (long)(Sim.Tick - 1) * _msPerTick;
            if (t <= 0) return 0;
            if (t >= _msPerTick) return 1000;
            return (int)(t * 1000 / _msPerTick);
        }

        /// <summary>Race time of a finished horse in ms from the gate opening (time attack), or -1.</summary>
        public long FinishTimeMs(int slot)
        {
            var h = Sim.GetHorse(slot);
            if (!h.Finished) return -1;
            long ticks = h.FinishTick - Sim.P.GateOpenTick;
            return ticks * _msPerTick + (long)h.FinishFracRaw * _msPerTick / 65536;
        }
    }

    /// <summary>Ready-made offline race configs.</summary>
    public static class OfflinePresets
    {
        public const int TutorialPlayerSlot = 0;

        /// <summary>
        /// Tutorial "いきなり本番" (docs/planning/04, 06 §2.3): a 400 m straight where the whole race is the final
        /// stretch. Slot 0 is the player (auto start: only the whip matters), slot 1 is the rival ridden by
        /// <see cref="TutorialDirector"/> (a Human-kind slot so the director can ride it), slots 2..7 are weaker
        /// CPUs. Use <see cref="TutorialRace"/> to get the race with its director: the outcome rule
        /// (REQ-UXS-004) only holds with the director attached. Offline only — never sent to the server.
        /// </summary>
        public static RaceConfig Tutorial(RulesetParams baseRuleset, ulong seed = 20261105)
            => Tutorial(baseRuleset, seed, TutorialPlayerStat, TutorialCpuStat, TutorialCpuWhipStartM);

        /// <summary>Tuning overload (balance tests). CPUs only whip inside the last <paramref name="cpuWhipStartM"/> meters.</summary>
        public static RaceConfig Tutorial(RulesetParams baseRuleset, ulong seed, int playerStat, int cpuStat, int cpuWhipStartM)
        {
            var rs = Override(baseRuleset, ("gateOpenTick", 20), ("maxTicks", 1200), ("kakariChancePer100000PerTickAtTemper0", 0), ("cpuWhipStartDistanceM", cpuWhipStartM));
            // the tutorial teaches one thing (the whip): no day-to-day form and no casual-style CPUs, when the ruleset has them
            if (rs.HasBalanceKeys) rs = Override(rs, ("conditionVariancePermille", 0), ("cpuSloppyMaxLevel", 0));
            // a 400m sprint that is all final stretch: keep the full stamina pool and spurt zone (no distance scaling, ruleset 1.2)
            if (rs.HasDistanceKeys) rs = Override(rs, ("staminaDistanceScalePermille", 0), ("spurtDistanceScalePermille", 0));
            // only the director's rival reins here (the player has the whip only; CPUs never rein in the spurt zone,
            // which is the whole race): a firmer rein lets the rival give way quickly once the player has earned it
            rs = Override(rs, ("reinSpeedPermille", TutorialReinSpeedPermille));
            var cfg = new RaceConfig
            {
                RaceId = "offline_tutorial",
                Mode = RaceMode.Tutorial,
                Seed = seed,
                Ruleset = rs,
                Track = new TrackSpec
                {
                    Id = "tutorial_straight_400",
                    Surface = Surface.Turf,
                    DistanceM = TutorialDistanceM,
                    Segments = { new TrackSegment(SegmentKind.Straight, TutorialDistanceM) },
                },
            };
            cfg.Entrants.Add(new Entrant { Slot = 0, Kind = EntrantKind.Human, PlayerId = "local", CpuLevel = 1, Horse = TutorialHorse("tut_player", "アイボウ", playerStat, RunningStyle.Sashi) });
            string[] names = { "ハヤテノツバサ", "ユウヤケボシ", "アオゾラマーチ", "シラカバノオカ", "ナミノリタロウ", "ツキミダンゴ", "ホシクズノミチ" };
            cfg.Entrants.Add(new Entrant { Slot = TutorialRivalSlot, Kind = EntrantKind.Human, PlayerId = TutorialRivalId, CpuLevel = 1, Horse = TutorialHorse("tut_cpu1", names[0], TutorialRivalStat, RunningStyle.Senko) });
            for (int i = 1; i < names.Length; i++)
            {
                var style = i % 2 == 0 ? RunningStyle.Senko : RunningStyle.Nige;
                cfg.Entrants.Add(new Entrant { Slot = i + 1, Kind = EntrantKind.Cpu, CpuLevel = 1, Horse = TutorialHorse("tut_cpu" + (i + 1), names[i], cpuStat, style) });
            }
            cfg.Validate();
            return cfg;
        }

        /// <summary>
        /// The tutorial race ready to drive: auto start, and the <see cref="TutorialDirector"/> that guarantees
        /// REQ-UXS-004 — 2+ whips in the last 300 m win, 0–1 whips finish a close 2nd, and from
        /// <paramref name="attempt"/> 3 on (1-based count of tutorial races this player has run) the player wins.
        /// </summary>
        public static OfflineRace TutorialRace(RulesetParams baseRuleset, int attempt = 1, ulong seed = 20261105)
        {
            var race = new OfflineRace(Tutorial(baseRuleset, seed), TutorialPlayerSlot) { AutoStart = true };
            race.Director = new TutorialDirector(attempt, TutorialPlayerSlot, TutorialRivalSlot);
            return race;
        }

        public const int TutorialDistanceM = 400;
        public const int TutorialPlayerStat = 560;
        /// <summary>The rival is slightly stronger than the player so it can always hold a close lead when asked to.</summary>
        public const int TutorialRivalStat = 600;
        /// <summary>The rest of the field is clearly weaker: they make up the pack but never beat the player.</summary>
        public const int TutorialCpuStat = 380;
        public const int TutorialCpuWhipStartM = 150;
        public const int TutorialRivalSlot = 1;
        public const int TutorialReinSpeedPermille = 900;
        public const string TutorialRivalId = "tutorial_rival";

        /// <summary>Solo time attack on any track (no CPUs).</summary>
        public static RaceConfig TimeAttack(TrackSpec track, HorseSpec horse, RulesetParams ruleset, ulong seed = 1)
        {
            // like the server's time attack (timeAttackRuleset): no day-to-day form, so a time reflects only the ride
            if (ruleset.HasBalanceKeys && ruleset.ConditionVariancePermille != 0)
            {
                var node = ProtocolCodec.RulesetToJson(ruleset);
                node.Set("conditionVariancePermille", 0);
                node.Set("rulesetVersion", ruleset.RulesetVersion + "+ta");
                ruleset = ProtocolCodec.ParseRuleset(node);
            }
            var cfg = new RaceConfig { RaceId = "offline_ta_" + track.Id, Mode = RaceMode.Friend, Seed = seed, Ruleset = ruleset, Track = track };
            cfg.Entrants.Add(new Entrant { Slot = 0, Kind = EntrantKind.Human, PlayerId = "local", CpuLevel = 3, Horse = horse });
            cfg.Validate();
            return cfg;
        }

        private static HorseSpec TutorialHorse(string id, string name, int stat, RunningStyle style) => new HorseSpec
        {
            Id = id, Name = name, Speed = stat, Stamina = stat, Burst = stat, Guts = stat, Temper = 1000,
            Style = style, DistMinM = 400, DistMaxM = 2400, Surface = Surface.Turf,
        };

        /// <summary>Copy of a ruleset with some keys replaced (offline only; online rulesets come from the server).</summary>
        public static RulesetParams Override(RulesetParams rs, params (string key, long value)[] values)
        {
            var node = ProtocolCodec.RulesetToJson(rs);
            foreach (var (k, v) in values) node.Set(k, v);
            return ProtocolCodec.ParseRuleset(node);
        }
    }
}
