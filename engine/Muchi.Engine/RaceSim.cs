using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Muchi.Engine
{
    /// <summary>
    /// Deterministic fixed-step race simulation (REQ-RACE-001..083).
    /// Call <see cref="Step"/> once per confirmed tick with one command byte per slot.
    /// The renderer reads <see cref="GetHorse"/>, <see cref="GetPreviousHorse"/> and <see cref="Events"/>.
    /// </summary>
    public sealed class RaceSim
    {
        private const ulong SaltKakari = 0x4B414B41UL;
        private const ulong SaltCpu = 0x43505531UL;
        private const ulong SaltForm = 0x464F524DUL;

        public readonly RaceConfig Config;
        public readonly RulesetParams P;
        public readonly TrackLayout Track;

        private readonly int _n;
        private HorseState[] _cur;
        private HorseState[] _prev;
        private readonly Fx[] _topSpeed;
        private readonly int[] _gutsFloorPermille;
        private readonly Pcg32[] _kakariRng;
        private readonly CpuBrain[] _brains;
        private readonly byte[] _resolved;
        private readonly List<RaceEvent> _events = new List<RaceEvent>();
        private readonly int[] _rankOrder;
        private int _finishedCount;
        private int _leader = -1;
        private int _lastLeaderEventTick = -1000;
        private RaceResult _result;
        private string _lastChecksum;
        private int _lastChecksumTick = -1;

        // Derived constants (Fx, per tick where noted)
        private readonly Fx _dtAccelUp;      // accel * dt  (m/s per tick)
        private readonly Fx _dtDecel;        // decel * dt
        private readonly Fx _laneStep;       // lanes per tick while changing lane
        private readonly Fx _laneWidth;      // meters
        private readonly Fx _blockRange, _slipRange, _clearance, _spurtDist, _halfLane, _minGap;
        private readonly int _tickHz;
        private readonly int _goingDrainPermille; // race-wide stamina drain factor from the ground (1000 = neutral)
        // unique skills (ruleset 1.3): per slot, effects clamped to the ruleset caps; null spec = no skill (or no skill keys)
        private readonly SkillSpec[] _skill;
        private readonly int[] _skSpeed, _skAccel, _skDrain, _skRecover, _skTicks;
        private readonly Fx _finalStraight; // length of the final straight counted for FinalStraight (0 = course ends in a corner)
        // tactics (ruleset 1.4): the 仕掛け window and the auto go mark (both 0 without the tactics keys)
        private readonly bool _tactics;
        private readonly Fx _goWindow, _autoGo;

        public RaceSim(RaceConfig config)
        {
            config.Validate();
            Config = config;
            P = config.Ruleset;
            Track = new TrackLayout(config.Track);
            _n = config.Entrants.Count;
            _tickHz = config.Net.TickHz;
            _cur = new HorseState[_n];
            _prev = new HorseState[_n];
            _topSpeed = new Fx[_n];
            _gutsFloorPermille = new int[_n];
            _kakariRng = new Pcg32[_n];
            _brains = new CpuBrain[_n];
            _resolved = new byte[_n];
            _rankOrder = new int[_n];
            _skill = new SkillSpec[_n];
            _skSpeed = new int[_n]; _skAccel = new int[_n]; _skDrain = new int[_n]; _skRecover = new int[_n]; _skTicks = new int[_n];

            _dtAccelUp = Fx.FromMilli(P.AccelMmPerSec2) / _tickHz;
            _dtDecel = Fx.FromMilli(P.DecelMmPerSec2) / _tickHz;
            _laneStep = Fx.One / P.LaneChangeTicks;
            _laneWidth = Fx.FromMilli(P.LaneWidthMm);
            _blockRange = Fx.FromMilli(P.BlockRangeMm);
            _slipRange = Fx.FromMilli(P.SlipstreamRangeMm);
            _clearance = Fx.FromMilli(P.LaneChangeClearanceMm);
            // ruleset 1.2: the spurt zone may scale with the race distance (factor 1000 when the keys are absent)
            bool dirtTrack = config.Track.Surface == Surface.Dirt;
            _spurtDist = Fx.FromInt((int)((long)P.SpurtDistanceM * P.DistanceFactorPermille(config.Track.DistanceM, dirtTrack, P.SpurtDistanceScalePermille) / 1000));
            int staminaDistPermille = P.DistanceFactorPermille(config.Track.DistanceM, dirtTrack, P.StaminaDistanceScalePermille);
            _halfLane = Fx.FromRatio(1, 2);
            _minGap = Fx.FromMilli(P.MinGapMm);
            var lastSeg = config.Track.Segments[config.Track.Segments.Count - 1];
            _finalStraight = lastSeg.Kind == SegmentKind.Straight ? Fx.Min(Fx.FromInt(lastSeg.LengthM), _spurtDist) : Fx.Zero;
            _tactics = P.HasTacticsKeys;
            if (_tactics)
            {
                _goWindow = Fx.FromRaw(_spurtDist.Raw * P.GoWindowPermille / 1000);
                _autoGo = Fx.FromRaw(_spurtDist.Raw * P.AutoGoPermille / 1000);
            }

            // ground condition (REQ-RACE-034): absent going = Good, which is neutral (1000‰) on turf,
            // so configs without the new fields reproduce exactly the same results as before.
            int g = (int)config.Track.EffectiveGoing;
            bool dirt = config.Track.Surface == Surface.Dirt;
            int goingSpeedPermille = dirt
                ? (int)((long)P.DirtSpeedPermille * P.GoingDirtSpeedPermille[g] / 1000)
                : P.GoingTurfSpeedPermille[g];
            _goingDrainPermille = dirt ? P.GoingDirtDrainPermille[g] : P.GoingTurfDrainPermille[g];

            for (int i = 0; i < _n; i++)
            {
                var e = config.Entrants[i];
                var h = e.Horse;
                int penalty = 0;
                if (config.Track.DistanceM < h.DistMinM || config.Track.DistanceM > h.DistMaxM) penalty += P.AptitudeOutPenaltyPermille;
                if (h.Surface != Surface.Both && h.Surface != config.Track.Surface) penalty += P.AptitudeOutPenaltyPermille;
                long topMm = P.BaseCruiseSpeedMmPerSec + (long)h.Speed * P.SpeedStatBonusMmPerSecPer1000 / 1000;
                topMm = topMm * (1000 - penalty) / 1000;
                if (goingSpeedPermille != 1000) topMm = topMm * goingSpeedPermille / 1000;
                int spec = GoingSpecialistPermille(h.GoingAptitude ?? GoingAptitude.Any, config.Track.EffectiveGoing, P.GoingSpecialistPermille);
                if (spec != 0) topMm = topMm * (1000 + spec) / 1000;
                if (P.ConditionVariancePermille > 0)
                {
                    // per-race form (調子): its own seeded stream, so no other random draw shifts (ruleset 1.1)
                    var form = new Pcg32(SeedMix.Derive(config.Seed, SaltForm, (ulong)i), (ulong)i + 200);
                    topMm = topMm * (1000 + form.Range(-P.ConditionVariancePermille, P.ConditionVariancePermille)) / 1000;
                }
                _topSpeed[i] = Fx.FromMilli(topMm);
                long stamina = P.StaminaBase + (long)h.Stamina * P.StaminaPerStatPoint;
                stamina = stamina * (1000 - penalty) / 1000;
                if (staminaDistPermille != 1000) stamina = stamina * staminaDistPermille / 1000;
                _gutsFloorPermille[i] = P.GutsFloorMinPermille + (P.GutsFloorMaxPermille - P.GutsFloorMinPermille) * h.Guts / 1000;
                _kakariRng[i] = new Pcg32(SeedMix.Derive(config.Seed, SaltKakari, (ulong)i), (ulong)i);
                _brains[i] = new CpuBrain(this, i, e.CpuLevel, new Pcg32(SeedMix.Derive(config.Seed, SaltCpu, (ulong)i), (ulong)i + 100));

                var s = new HorseState
                {
                    Distance = Fx.Zero,
                    Lane = Fx.FromInt(i),
                    LaneTarget = i,
                    Speed = Fx.Zero,
                    Stamina = Fx.FromInt(stamina),
                    StaminaMax = Fx.FromInt(stamina),
                    Composure = 100,
                    WhipsLeft = P.MaxWhips,
                    LastWhipTick = -100000,
                    LastManualLaneTick = -100000,
                    DepartTick = -1,
                    FinishTick = -1,
                    Rank = i,
                    CpuControlled = e.Kind == EntrantKind.Cpu,
                    GoTick = -1,
                    RhythmRefTick = -100000,
                };
                _cur[i] = s;
                _prev[i] = s;
                if (P.HasSkillKeys && h.Skill != null)
                {
                    // ruleset 1.3: a skill without the keys is ignored, so 1.2 replays reproduce exactly
                    var sk = h.Skill;
                    _skill[i] = sk;
                    _skSpeed[i] = Math.Min(sk.SpeedPermille, P.SkillMaxSpeedPermille);
                    _skAccel[i] = Math.Min(sk.AccelPermille, P.SkillMaxAccelPermille);
                    _skDrain[i] = Math.Min(sk.DrainSavePermille, P.SkillMaxDrainSavePermille);
                    _skRecover[i] = Math.Min(sk.RecoverPermille, P.SkillMaxRecoverPermille);
                    _skTicks[i] = Math.Min(sk.DurationTicks, P.SkillMaxDurationTicks);
                }
                _rankOrder[i] = i;
            }
        }

        /// <summary>
        /// Top-speed adjustment (‰) for a horse's ground preference (REQ-RACE-035): a fast-ground horse gains on
        /// firm/fast and loses on soft/sloppy (half on yielding/muddy); a heavy-ground horse the opposite.
        /// </summary>
        public static int GoingSpecialistPermille(GoingAptitude apt, Going going, int maxPermille)
        {
            if (apt == GoingAptitude.Any || maxPermille == 0) return 0;
            int wet; // -2 firm, 0 good, +1 yielding, +2 soft (in half steps of maxPermille)
            switch (going)
            {
                case Going.FirmOrFast: wet = -2; break;
                case Going.YieldingOrMuddy: wet = 1; break;
                case Going.SoftOrSloppy: wet = 2; break;
                default: wet = 0; break;
            }
            int sign = apt == GoingAptitude.Heavy ? 1 : -1;
            return sign * wet * maxPermille / 2;
        }

        // ------------------------------------------------------------------ read API

        /// <summary>Next tick to be simulated. Ticks 0..Tick-1 have been processed.</summary>
        public int Tick { get; private set; }
        public int EntrantCount => _n;
        public bool IsFinished { get; private set; }
        public RaceResult Result => _result;
        public IReadOnlyList<RaceEvent> Events => _events;
        /// <summary>State after the last processed tick.</summary>
        public HorseState GetHorse(int slot) => _cur[slot];
        /// <summary>State before the last processed tick (for interpolation, REQ-RACE-081).</summary>
        public HorseState GetPreviousHorse(int slot) => _prev[slot];
        /// <summary>Top speed (m/s) of the horse after aptitude penalties.</summary>
        public Fx TopSpeed(int slot) => _topSpeed[slot];
        /// <summary>Slot currently in position <paramref name="rank"/> (0 = leader).</summary>
        public int SlotAtRank(int rank) => _rankOrder[rank];
        public bool GateOpened => Tick > P.GateOpenTick;
        /// <summary>The skill this horse races with (null = none, or the ruleset has no skill keys).</summary>
        public SkillSpec SkillOf(int slot) => _skill[slot];
        /// <summary>Effect this horse's skill applies in this race after the ruleset caps: (speed‰, accel‰, drain save‰, recover‰, ticks).</summary>
        public (int speed, int accel, int drainSave, int recover, int ticks) SkillEffect(int slot) => (_skSpeed[slot], _skAccel[slot], _skDrain[slot], _skRecover[slot], _skTicks[slot]);
        public string LastChecksum => _lastChecksum;
        public int LastChecksumTick => _lastChecksumTick;
        internal Fx BlockRange => _blockRange;
        internal Fx Clearance => _clearance;
        internal Fx SpurtDistance => _spurtDist;
        /// <summary>Length of the spurt zone in this race (m); scales with distance from ruleset 1.2.</summary>
        public int SpurtZoneM => (int)(_spurtDist.Raw >> 16);
        internal int[] RankOrderInternal => _rankOrder;

        /// <summary>Ruleset 1.4 tactics are on (the spurt is the rider's 仕掛け).</summary>
        public bool TacticsEnabled => _tactics;
        /// <summary>Ruleset 1.4: metres to go at which the 仕掛け window opens (0 without tactics).</summary>
        public int GoWindowM => (int)(_goWindow.Raw >> 16);
        /// <summary>Ruleset 1.4: metres to go at which a horse that has not gone goes by itself (0 without tactics).</summary>
        public int AutoGoM => (int)(_autoGo.Raw >> 16);

        /// <summary>
        /// Metres the horse's current stamina would carry a spurt (integer estimate, deterministic: CPUs use it inside the
        /// simulation). Spurt speed = top + spurt bonus × burst × stamina‰; drain per metre = v × drain coefficient × tick rate ×
        /// the ground's drain factor. The speed actually falls as stamina drains, so the true distance is a little longer;
        /// <see cref="GoLineM"/> applies the ruleset's calibration.
        /// </summary>
        public int SustainableSpurtM(int slot)
        {
            var h = _cur[slot];
            var horse = Config.Entrants[slot].Horse;
            long topMm = _topSpeed[slot].Raw * 1000 >> 16;
            long vMm = topMm + (long)P.SpurtSpeedBonusMaxMmPerSec * horse.Burst / 1000 * h.StaminaPermille / 1000;
            long perMetre = PerMetreMicro(vMm);
            if (perMetre <= 0) return 100000;
            long staminaMilli = h.Stamina.Raw * 1000 >> 16; // stamina points × 1000
            long m = staminaMilli * 1000L / perMetre;
            if (_tactics && P.LongSpurtBonusPermille < 1000)
            {
                // ruleset 1.4: before the spurt mark a long spurt runs on part of the bonus (cheaper per metre)
                long mark = Math.Min(_spurtDist.Raw >> 16, Math.Max(0, (Track.Distance - h.Distance).Raw >> 16));
                long need = mark * perMetre / 1000; // stamina × 1000 for the spurt from the mark
                if (staminaMilli > need)
                {
                    long vLong = topMm + (vMm - topMm) * P.LongSpurtBonusPermille / 1000;
                    long perLong = PerMetreMicro(vLong);
                    m = mark + (perLong <= 0 ? 100000 : (staminaMilli - need) * 1000L / perLong);
                }
            }
            return m > 100000 ? 100000 : (int)m;
        }

        /// <summary>Stamina points per metre × 1e6 at <paramref name="vMm"/> mm/s: v × coefficient(µ) / 1000 × tick rate × ground drain (‰).</summary>
        private long PerMetreMicro(long vMm)
        {
            if (vMm < 1000) vMm = 1000;
            return vMm * P.DrainMicroPerSpeedSqPerTick / 1000 * _tickHz * _goingDrainPermille / 1000;
        }

        /// <summary>
        /// Ruleset 1.4: the go line — going with this many metres to go spends the stamina about right (HUD gold mark, CPU go).
        /// = SustainableSpurtM × goLinePermille, never later than the auto mark (a horse short of stamina still goes there, with
        /// the kick if it held) and at most the 仕掛け window. 0 without tactics.
        /// </summary>
        public int GoLineM(int slot)
        {
            if (!_tactics) return 0;
            long m = (long)SustainableSpurtM(slot) * P.GoLinePermille / 1000;
            return (int)Math.Min(Math.Max(m, AutoGoM), GoWindowM);
        }

        // ------------------------------------------------------------------ stepping

        /// <summary>Advances one tick. <paramref name="cmds"/> holds one byte per slot (null = no input).</summary>
        public void Step(byte[] cmds)
        {
            if (IsFinished) throw new InvalidOperationException("race already finished");
            if (cmds != null && cmds.Length != _n) throw new ArgumentException("cmds length must equal entrant count");
            int t = Tick;

            Array.Copy(_cur, _prev, _n);

            if (t == P.GateOpenTick) _events.Add(new RaceEvent(t, RaceEventType.GateOpen, -1, 0));

            // 1) resolve commands (CPU decisions are based on the pre-step state)
            for (int i = 0; i < _n; i++)
            {
                byte c = cmds == null ? (byte)0 : cmds[i];
                if ((c & Cmd.CpuTakeover) != 0 && !_cur[i].CpuControlled)
                {
                    _cur[i].CpuControlled = true;
                    _brains[i].OnTakeover(t);
                    _events.Add(new RaceEvent(t, RaceEventType.CpuTakeover, i, 0));
                }
                if ((c & Cmd.HumanResume) != 0 && _cur[i].CpuControlled && Config.Entrants[i].Kind == EntrantKind.Human)
                {
                    _cur[i].CpuControlled = false;
                    _events.Add(new RaceEvent(t, RaceEventType.HumanResume, i, 0));
                }
                if (_cur[i].CpuControlled) c = _brains[i].Decide(t);
                else c = (byte)(c & Cmd.ClientMask);
                if ((c & Cmd.LaneIn) != 0 && (c & Cmd.LaneOut) != 0) c = (byte)(c & ~(Cmd.LaneIn | Cmd.LaneOut));
                if ((c & Cmd.ReinPress) != 0 && (c & Cmd.ReinRelease) != 0) c = (byte)(c & ~Cmd.ReinPress);
                _resolved[i] = c;
            }

            // 2) apply discrete commands in slot order
            for (int i = 0; i < _n; i++) ApplyCommands(i, _resolved[i], t);

            // 3) continuous physics, reading other horses from the pre-step snapshot
            for (int i = 0; i < _n; i++) Physics(i, t);

            // 4) ranking, events, end detection
            UpdateRanks(t);
            Tick = t + 1;

            if (t > 0 && t % Config.Net.ChecksumIntervalTicks == 0)
            {
                _lastChecksum = ComputeChecksum();
                _lastChecksumTick = t;
            }

            if (_finishedCount == _n || Tick >= P.MaxTicks)
            {
                IsFinished = true;
                _result = BuildResult(t);
                _events.Add(new RaceEvent(t, RaceEventType.RaceEnd, _result.Order.Length > 0 && _result.FinishTicks[0] >= 0 ? _result.Order[0] : -1, 0));
            }
        }

        /// <summary>True when the tick just processed is a checksum tick (t &gt; 0 and t % checksumIntervalTicks == 0).</summary>
        public bool ChecksumDueForLastTick => _lastChecksumTick >= 0 && _lastChecksumTick == Tick - 1;

        private void ApplyCommands(int i, byte c, int t)
        {
            ref HorseState h = ref _cur[i];
            if (h.Finished) return;

            // Start (REQ-RACE-021)
            if (!h.Departed && t >= P.GateOpenTick)
            {
                int reaction = t - P.GateOpenTick;
                if ((c & Cmd.Start) != 0)
                {
                    h.Departed = true;
                    h.DepartTick = t;
                    if (reaction < P.StartReactionWindowTicks) h.StartBoostTicksLeft = P.StartBoostTicks;
                    _events.Add(new RaceEvent(t, RaceEventType.Start, i, reaction));
                }
                else if (reaction >= P.AutoStartDelayTicks)
                {
                    h.Departed = true;
                    h.DepartTick = t;
                    _events.Add(new RaceEvent(t, RaceEventType.LateStart, i, reaction));
                }
            }

            if ((c & Cmd.ReinPress) != 0) h.Reining = true;
            if ((c & Cmd.ReinRelease) != 0) h.Reining = false;

            if (!h.Departed) return;

            // Lane change (REQ-RACE-045)
            if ((c & (Cmd.LaneIn | Cmd.LaneOut)) != 0)
            {
                h.LastManualLaneTick = t;
                if (!h.IsChangingLane)
                {
                    int target = h.LaneTarget + ((c & Cmd.LaneIn) != 0 ? -1 : 1);
                    if (target >= 0 && target < P.LaneCount && LaneClear(i, target))
                    {
                        h.LaneTarget = target;
                        _events.Add(new RaceEvent(t, RaceEventType.LaneChange, i, target));
                        // ruleset 1.4 slingshot: pulling out of a slipstream held long enough, inside the 仕掛け window
                        if (_tactics && h.SlipTicks >= P.SlingshotMinSlipTicks && Track.Distance - h.Distance <= _goWindow && P.SlingshotTicks > 0)
                        {
                            h.SlingTicksLeft = P.SlingshotTicks;
                            _events.Add(new RaceEvent(t, RaceEventType.Slingshot, i, target));
                        }
                    }
                }
            }
            else if (P.AutoRailIntervalTicks > 0 && !h.IsChangingLane && h.LaneTarget > 0 && !(_tactics && (h.InSpurt || h.Gathering))
                && (t + i) % P.AutoRailIntervalTicks == 0 && t - h.LastManualLaneTick >= P.AutoRailHoldTicks
                && Track.Distance - h.Distance > _spurtDist && LaneClear(i, h.LaneTarget - 1) && !SlowerAheadIn(i, h.LaneTarget - 1))
            {
                // auto-steer toward the rail (ruleset 1.1): the jockey saves ground unless the rider chose a line
                h.LaneTarget--;
                _events.Add(new RaceEvent(t, RaceEventType.LaneChange, i, h.LaneTarget));
            }

            // ruleset 1.4: the whip button inside the 仕掛け window before the go is the hold (溜め); START is its release
            if (_tactics && !h.InSpurt)
            {
                if (h.Gathering)
                {
                    if ((c & Cmd.Start) != 0) Go(i, ref h, t, h.GatherTicks);
                    return;
                }
                if ((c & Cmd.Whip) != 0 && Track.Distance - h.Distance <= _goWindow)
                {
                    h.Gathering = true;
                    h.GatherTicks = 0;
                    _events.Add(new RaceEvent(t, RaceEventType.Gather, i, (int)((Track.Distance - h.Distance).Raw >> 16)));
                    if ((c & Cmd.Start) != 0) Go(i, ref h, t, 0); // pressed and released on one tick: a plain go
                    return;
                }
            }

            // Whip (REQ-RACE-047)
            if ((c & Cmd.Whip) != 0 && h.WhipsLeft > 0)
            {
                bool spurt = _tactics ? h.InSpurt : Track.Distance - h.Distance <= _spurtDist;
                int effect = 1000;
                bool perfect = false;
                if (_tactics && spurt && t - h.RhythmRefTick >= P.RhythmFromTicks && t - h.RhythmRefTick <= P.RhythmToTicks)
                {
                    // 会心: on the beat after the go or the previous whip (overrides the diminish rule)
                    effect = 1000 + P.RhythmBonusPermille;
                    perfect = true;
                }
                else if (t - h.LastWhipTick < P.WhipDiminishWindowTicks && h.WhipTicksLeft > 0)
                    effect = h.WhipEffectPermille * P.WhipDiminishPermille / 1000;
                if (!spurt)
                {
                    effect = effect * P.EarlyWhipEffectPermille / 1000;
                    h.Composure = Math.Max(0, h.Composure - P.EarlyWhipComposurePenalty);
                }
                h.WhipsLeft--;
                h.WhipEffectPermille = effect;
                h.WhipTicksLeft = P.WhipEffectTicks;
                h.LastWhipTick = t;
                h.Stamina = Fx.Max(Fx.Zero, h.Stamina - Fx.FromInt(P.WhipStaminaCost));
                _events.Add(new RaceEvent(t, RaceEventType.Whip, i, h.WhipsLeft));
                if (_tactics)
                {
                    h.RhythmRefTick = t;
                    if (perfect)
                    {
                        h.PerfectWhips++;
                        _events.Add(new RaceEvent(t, RaceEventType.Rhythm, i, h.WhipsLeft));
                    }
                }
            }
        }

        /// <summary>
        /// Ruleset 1.4 仕掛け: the spurt starts now. <paramref name="charge"/> = ticks gathered (the 一閃 kick scales with it),
        /// -1 = the auto go (no kick). The rhythm counts from here.
        /// </summary>
        private void Go(int i, ref HorseState h, int t, int charge)
        {
            h.Gathering = false;
            h.InSpurt = true;
            h.GoTick = t;
            h.GoCharge = charge;
            int c = Math.Max(0, Math.Min(charge, P.GatherMaxTicks));
            h.KickPermille = c * 1000 / P.GatherMaxTicks;
            h.KickTicksLeft = c > 0 ? P.KickTicks : 0;
            h.RhythmRefTick = t;
            _events.Add(new RaceEvent(t, RaceEventType.Go, i, charge));
        }

        /// <summary>Would moving into <paramref name="lane"/> put this horse right behind a slower one? (pre-step state)</summary>
        private bool SlowerAheadIn(int self, int lane)
        {
            Fx laneFx = Fx.FromInt(lane);
            Fx range = _blockRange * 3;
            var me = _prev[self];
            for (int j = 0; j < _n; j++)
            {
                if (j == self) continue;
                var o = _prev[j];
                if (o.Finished) continue;
                if ((o.Lane - laneFx).Abs() > _halfLane) continue;
                Fx gap = o.Distance - me.Distance;
                if (gap.Raw > 0 && gap <= range && o.Speed < me.Speed) return true;
            }
            return false;
        }

        /// <summary>Is the target lane free of horses within the clearance distance? Uses pre-step positions and targets already accepted this tick.</summary>
        internal bool LaneClear(int self, int targetLane)
        {
            Fx myDist = _prev[self].Distance;
            Fx targetFx = Fx.FromInt(targetLane);
            for (int j = 0; j < _n; j++)
            {
                if (j == self) continue;
                var o = _cur[j];
                if (o.Finished) continue;
                bool occupies = (_prev[j].Lane - targetFx).Abs() < Fx.FromRatio(3, 4) || o.LaneTarget == targetLane;
                if (!occupies) continue;
                if ((_prev[j].Distance - myDist).Abs() < _clearance) return false;
            }
            return true;
        }

        private void Physics(int i, int t)
        {
            ref HorseState h = ref _cur[i];
            var horse = Config.Entrants[i].Horse;

            if (h.Finished)
            {
                // keep moving for presentation, slowing to half top speed; never affects others
                Fx coast = _topSpeed[i].MulPermille(500);
                if (h.Speed > coast) h.Speed = Fx.Max(coast, h.Speed - _dtDecel);
                h.LastAdvance = h.Speed / _tickHz;
                h.Distance = h.Distance + h.LastAdvance;
                MoveLane(ref h);
                return;
            }
            if (!h.Departed) return;

            Fx remaining = Track.Distance - h.Distance;
            if (_tactics && !h.InSpurt)
            {
                // a full charge goes by itself (溜めきり); a horse that never went goes at the auto mark
                if (h.Gathering) { if (h.GatherTicks >= P.GatherMaxTicks) Go(i, ref h, t, P.GatherMaxTicks); }
                else if (remaining <= _autoGo) Go(i, ref h, t, -1);
            }
            bool spurtMark = remaining <= _spurtDist;
            bool spurt = _tactics ? h.InSpurt : spurtMark;
            if (_tactics ? spurtMark && !h.SpurtCalled : spurt && !h.InSpurt)
            {
                // ruleset 1.4: the spurt mark is only the final-stretch call (the spurt itself starts on the go)
                if (_tactics) h.SpurtCalled = true; else h.InSpurt = true;
                // Value = the horse's rank (0 = leader) as it reached the spurt mark (ranks of the previous tick);
                // presentation only, not part of the checksum or result hash
                _events.Add(new RaceEvent(t, RaceEventType.SpurtStart, i, h.Rank));
            }

            if (_skill[i] != null && !h.SkillUsed && SkillCondition(i, _skill[i], remaining, spurtMark))
            {
                h.SkillUsed = true;
                h.SkillTicksLeft = _skTicks[i];
                if (_skRecover[i] > 0) h.Stamina = Fx.Min(h.StaminaMax, h.Stamina + Fx.FromRaw(h.StaminaMax.Raw * _skRecover[i] / 1000));
                // Value = rank (0 = leader) as it fired (ranks of the previous tick); presentation only
                _events.Add(new RaceEvent(t, RaceEventType.Skill, i, _prev[i].Rank));
            }
            bool skillOn = h.SkillTicksLeft > 0;

            Fx top = _topSpeed[i];
            int staminaPermille = h.StaminaPermille;

            // target speed (REQ-RACE-040, 048)
            Fx target;
            if (spurt)
            {
                long bonusMm = (long)P.SpurtSpeedBonusMaxMmPerSec * horse.Burst / 1000 * staminaPermille / 1000;
                // ruleset 1.4: a long spurt (went before the spurt mark) runs on part of the bonus until the mark
                if (_tactics && !spurtMark) bonusMm = bonusMm * P.LongSpurtBonusPermille / 1000;
                target = top + Fx.FromMilli(bonusMm);
            }
            else if (h.IsKakari && !h.Reining && !h.Gathering)
            {
                target = top;
            }
            else
            {
                target = top.MulPermille(P.CruiseSpeedPermille);
            }
            if (h.Gathering) target = target.MulPermille(P.GatherSpeedPermille);
            else if (h.Reining) target = target.MulPermille(P.ReinSpeedPermille);
            if (skillOn && _skSpeed[i] > 0) target = target.MulPermille(1000 + _skSpeed[i]);

            // exhaustion (REQ-RACE-041)
            if (h.Stamina.Raw <= 0) target = Fx.Min(target, top.MulPermille(_gutsFloorPermille[i]));

            Fx accel = _dtAccelUp;
            if (h.WhipTicksLeft > 0)
            {
                target = target + Fx.FromMilli((long)P.WhipSpeedBonusMmPerSec * h.WhipEffectPermille / 1000);
                accel = accel + Fx.FromMilli((long)P.WhipAccelBonusMmPerSec2 * h.WhipEffectPermille / 1000) / _tickHz;
            }
            if (h.KickTicksLeft > 0)
            {
                target = target + Fx.FromMilli((long)P.KickSpeedBonusMmPerSec * h.KickPermille / 1000);
                accel = accel + Fx.FromMilli((long)P.KickAccelBonusMmPerSec2 * h.KickPermille / 1000) / _tickHz;
            }
            if (h.SlingTicksLeft > 0)
            {
                target = target + Fx.FromMilli(P.SlingshotSpeedBonusMmPerSec);
                accel = accel + Fx.FromMilli(P.SlingshotAccelBonusMmPerSec2) / _tickHz;
            }
            if (h.StartBoostTicksLeft > 0) accel = accel.MulPermille(1000 + P.StartBoostPermille);
            if (skillOn && _skAccel[i] > 0) accel = accel.MulPermille(1000 + _skAccel[i]);

            // blocking (REQ-RACE-044) and slipstream detection (REQ-RACE-042)
            h.Blocked = false;
            bool slip = false;
            Fx myLane = _prev[i].Lane;
            Fx myDist = _prev[i].Distance;
            int nearest = -1;
            Fx nearestGap = Fx.Zero;
            for (int j = 0; j < _n; j++)
            {
                if (j == i) continue;
                var o = _prev[j];
                if (o.Finished || !o.Departed) continue;
                if ((o.Lane - myLane).Abs() > _halfLane) continue;
                Fx gap = o.Distance - myDist;
                if (gap.Raw <= 0) continue;
                if (gap <= _slipRange) slip = true;
                if (gap <= _blockRange)
                {
                    if (o.Speed < target)
                    {
                        target = o.Speed;
                        h.Blocked = true;
                    }
                    if (nearest < 0 || gap < nearestGap) { nearest = j; nearestGap = gap; }
                }
            }

            // speed integration
            if (h.Speed < target) h.Speed = Fx.Min(target, h.Speed + accel);
            else if (h.Speed > target) h.Speed = Fx.Max(target, h.Speed - _dtDecel);
            if (h.Speed.Raw < 0) h.Speed = Fx.Zero;

            // stamina drain (REQ-RACE-041, 042, 046)
            Fx v2 = h.Speed * h.Speed;
            long drainRaw = v2.Raw * P.DrainMicroPerSpeedSqPerTick / 1000000;
            if (slip) drainRaw = drainRaw * (1000 - P.SlipstreamSavePermille) / 1000;
            if (h.Gathering) drainRaw = drainRaw * P.GatherDrainPermille / 1000;
            else if (h.Reining) drainRaw = drainRaw * P.ReinDrainPermille / 1000;
            if (h.Composure < P.BadComposureThreshold) drainRaw = drainRaw * (1000 + P.BadComposureExtraDrainPermille) / 1000;
            if (_goingDrainPermille != 1000) drainRaw = drainRaw * _goingDrainPermille / 1000;
            if (skillOn && _skDrain[i] > 0) drainRaw = drainRaw * (1000 - _skDrain[i]) / 1000;
            h.Stamina = Fx.FromRaw(Math.Max(0, h.Stamina.Raw - drainRaw));

            // movement with corner geometry (REQ-RACE-043)
            Fx ds = h.Speed / _tickHz;
            int seg = Track.SegmentIndexAt(h.Distance);
            var segment = Track.Segment(seg);
            if (segment.Kind == SegmentKind.Corner)
            {
                Fx r = Fx.FromInt(segment.RadiusM);
                Fx offset = h.Lane * _laneWidth;
                ds = ds * r / (r + offset);
            }
            // hard constraint: never run through the horse directly ahead in the same lane
            if (nearest >= 0)
            {
                var o = _prev[nearest];
                Fx allowed = o.Distance + o.LastAdvance - _minGap - h.Distance;
                if (ds > allowed)
                {
                    ds = Fx.Max(Fx.Zero, allowed);
                    h.Speed = Fx.Min(h.Speed, o.Speed);
                    h.Blocked = true;
                }
            }
            h.LastAdvance = ds;
            if (h.Distance + ds >= Track.Distance && ds.Raw > 0)
            {
                Fx frac = (Track.Distance - h.Distance) / ds;
                long raw = frac.Raw;
                if (raw < 0) raw = 0;
                if (raw >= Fx.OneRaw) raw = Fx.OneRaw - 1;
                h.FinishTick = t;
                h.FinishFracRaw = (int)raw;
                _finishedCount++;
            }
            h.Distance = h.Distance + ds;

            MoveLane(ref h);

            // composure (REQ-RACE-046)
            if (!spurtMark && h.KakariTicksLeft == 0) // 1.4: a long spurt (gone before the mark) can still pull
            {
                int chance = (int)((long)P.KakariChancePer100000PerTickAtTemper0 * (1000 - horse.Temper) / 1000);
                if (chance > 0 && _kakariRng[i].Chance(chance, 100000))
                {
                    h.KakariTicksLeft = P.KakariDurationTicks;
                    // Value = the horse's rank (0 = leader) as it started pulling (ranks of the previous tick, as for
                    // SpurtStart); presentation only, not part of the checksum or result hash
                    _events.Add(new RaceEvent(t, RaceEventType.Kakari, i, h.Rank));
                }
            }
            if (h.KakariTicksLeft > 0)
            {
                h.Composure -= P.KakariComposureLossPerTick;
                h.KakariTicksLeft -= h.Reining ? 2 : 1;
                if (h.KakariTicksLeft < 0) h.KakariTicksLeft = 0;
            }
            if (h.Reining) h.Composure += P.ReinComposureRecoverPerTick;
            h.Composure += P.NaturalComposureRecoverPerTick;
            if (h.Blocked && horse.Style == RunningStyle.Nige && P.BlockedComposureLossIntervalTicks > 0 && t % P.BlockedComposureLossIntervalTicks == 0)
                h.Composure -= 1;
            if (h.Composure < 0) h.Composure = 0;
            if (h.Composure > 100) h.Composure = 100;

            if (h.WhipTicksLeft > 0) h.WhipTicksLeft--;
            if (h.StartBoostTicksLeft > 0) h.StartBoostTicksLeft--;
            if (h.SkillTicksLeft > 0) h.SkillTicksLeft--;
            if (h.KickTicksLeft > 0) h.KickTicksLeft--;
            if (h.SlingTicksLeft > 0) h.SlingTicksLeft--;
            if (h.Gathering && h.GatherTicks < P.GatherMaxTicks) h.GatherTicks++;
            h.SlipTicks = slip ? h.SlipTicks + 1 : 0;
        }

        /// <summary>
        /// Skill condition (ruleset 1.3): read from the start-of-tick state (the previous tick's distance, lane, rank,
        /// stamina), so the slot order never matters. No random draw.
        /// </summary>
        private bool SkillCondition(int i, SkillSpec sk, Fx remaining, bool spurt)
        {
            var p = _prev[i];
            switch (sk.Trigger)
            {
                case SkillTrigger.FinalStraight: return _finalStraight.Raw > 0 && remaining <= _finalStraight && p.Rank <= sk.Value;
                case SkillTrigger.CornerRail: return Track.Segment(Track.SegmentIndexAt(p.Distance)).Kind == SegmentKind.Corner && p.Lane <= Fx.FromInt(sk.Value);
                case SkillTrigger.LowStamina: return p.StaminaPermille <= sk.Value;
                case SkillTrigger.SpurtBehind: return spurt && p.Rank >= sk.Value;
                case SkillTrigger.Remaining: return remaining <= Fx.FromInt(sk.Value);
                case SkillTrigger.Leading: return remaining <= Fx.FromInt(sk.Value) && p.Rank == 0;
                case SkillTrigger.Slipstream: return p.SlipTicks >= sk.Value;
                case SkillTrigger.GoodStart: return p.Departed ? false : _cur[i].DepartTick - P.GateOpenTick <= sk.Value;
                default: return false;
            }
        }

        private void MoveLane(ref HorseState h)
        {
            Fx target = Fx.FromInt(h.LaneTarget);
            if (h.Lane < target) h.Lane = Fx.Min(target, h.Lane + _laneStep);
            else if (h.Lane > target) h.Lane = Fx.Max(target, h.Lane - _laneStep);
        }

        // ------------------------------------------------------------------ ranking / result

        private int CompareRank(int a, int b)
        {
            var x = _cur[a];
            var y = _cur[b];
            if (x.Finished && y.Finished)
            {
                if (x.FinishTick != y.FinishTick) return x.FinishTick.CompareTo(y.FinishTick);
                if (x.FinishFracRaw != y.FinishFracRaw) return x.FinishFracRaw.CompareTo(y.FinishFracRaw);
                return a.CompareTo(b);
            }
            if (x.Finished) return -1;
            if (y.Finished) return 1;
            if (x.Distance != y.Distance) return y.Distance.CompareTo(x.Distance);
            return a.CompareTo(b);
        }

        private void UpdateRanks(int t)
        {
            // insertion sort: stable, deterministic, n <= 12
            for (int i = 0; i < _n; i++) _rankOrder[i] = i;
            for (int i = 1; i < _n; i++)
            {
                int key = _rankOrder[i];
                int j = i - 1;
                while (j >= 0 && CompareRank(_rankOrder[j], key) > 0)
                {
                    _rankOrder[j + 1] = _rankOrder[j];
                    j--;
                }
                _rankOrder[j + 1] = key;
            }
            for (int r = 0; r < _n; r++) _cur[_rankOrder[r]].Rank = r;

            // finish events in place order for horses that finished this tick
            for (int r = 0; r < _n; r++)
            {
                int s = _rankOrder[r];
                if (_cur[s].FinishTick == t)
                    _events.Add(new RaceEvent(t, RaceEventType.Finish, s, r + 1));
            }

            if (t > P.GateOpenTick)
            {
                int leader = _rankOrder[0];
                if (leader != _leader && (t - _lastLeaderEventTick >= _tickHz || _leader < 0))
                {
                    _leader = leader;
                    _lastLeaderEventTick = t;
                    _events.Add(new RaceEvent(t, RaceEventType.LeaderChanged, leader, 0));
                }
            }
        }

        /// <summary>FNV-1a over the current state (contracts/protocol.md §5).</summary>
        public string ComputeChecksum()
        {
            var f = Fnv1a64.Create();
            for (int i = 0; i < _n; i++)
            {
                var h = _cur[i];
                f.AddInt64(h.Distance.Raw);
                f.AddInt64(h.Lane.Raw);
                f.AddInt64(h.Speed.Raw);
                f.AddInt64(h.Stamina.Raw);
                f.AddInt64(h.Composure);
                f.AddInt64(h.WhipsLeft);
                f.AddInt64(h.FinishTick);
                if (_tactics)
                {
                    // ruleset 1.4 only, so older rulesets keep their checksums
                    f.AddInt64((h.InSpurt ? 1 : 0) | (h.Gathering ? 2 : 0));
                    f.AddInt64(h.GatherTicks);
                    f.AddInt64(h.KickTicksLeft);
                    f.AddInt64(h.SlingTicksLeft);
                }
            }
            return f.Hex;
        }

        private RaceResult BuildResult(int endTick)
        {
            var r = new RaceResult
            {
                Order = new int[_n],
                FinishTicks = new int[_n],
                FinishFracOrDistanceRaw = new long[_n],
                Margins = new Fx[_n],
                EndTick = endTick,
            };
            var sb = new StringBuilder();
            sb.Append("v1|").Append(Config.RaceId).Append('|').Append(P.RulesetVersion).Append('|');
            for (int p = 0; p < _n; p++)
            {
                int s = _rankOrder[p];
                var h = _cur[s];
                r.Order[p] = s;
                r.FinishTicks[p] = h.FinishTick;
                r.FinishFracOrDistanceRaw[p] = h.Finished ? h.FinishFracRaw : h.Distance.Raw;
                if (p > 0) sb.Append(';');
                sb.Append(Inv(s)).Append(':');
                if (h.Finished) sb.Append(Inv(h.FinishTick)).Append(':').Append(Inv(h.FinishFracRaw));
                else sb.Append("-1:").Append(Inv(h.Distance.Raw));
            }
            for (int p = 1; p < _n; p++)
            {
                // margin approximation: time gap * winner-ish speed of the follower at its finish
                var prev = _cur[r.Order[p - 1]];
                var me = _cur[r.Order[p]];
                if (prev.Finished && me.Finished)
                {
                    long gapTicksRaw = ((long)(me.FinishTick - prev.FinishTick) << Fx.Shift) + me.FinishFracRaw - prev.FinishFracRaw;
                    r.Margins[p] = Fx.FromRaw(gapTicksRaw) * me.Speed / _tickHz;
                }
                else
                {
                    r.Margins[p] = prev.Distance - me.Distance;
                }
            }
            r.CanonicalString = sb.ToString();
            r.Hash = ResultHasher.Sha256Hex(r.CanonicalString);
            return r;
        }

        private static string Inv(long v) => v.ToString(CultureInfo.InvariantCulture);
    }
}
