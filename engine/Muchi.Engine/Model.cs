using System;
using System.Collections.Generic;

namespace Muchi.Engine
{
    /// <summary>Input bit flags, one byte per slot per tick (REQ-RACE-010).</summary>
    public static class Cmd
    {
        public const byte Start = 1 << 0;
        public const byte LaneIn = 1 << 1;
        public const byte LaneOut = 1 << 2;
        public const byte ReinPress = 1 << 3;
        public const byte ReinRelease = 1 << 4;
        public const byte Whip = 1 << 5;
        public const byte CpuTakeover = 1 << 6;
        public const byte HumanResume = 1 << 7;

        /// <summary>Bits a client is allowed to send. The room strips the rest.</summary>
        public const byte ClientMask = Start | LaneIn | LaneOut | ReinPress | ReinRelease | Whip;
    }

    public enum RunningStyle { Nige = 0, Senko = 1, Sashi = 2, Oikomi = 3 }
    public enum Surface { Turf = 0, Dirt = 1, Both = 2 }
    public enum SegmentKind { Straight = 0, Corner = 1 }
    public enum EntrantKind { Human = 0, Cpu = 1 }
    public enum RaceMode { Ranked = 0, Friend = 1, Tutorial = 2, TimeAttack = 3, Event = 4, Tournament = 5 }

    /// <summary>
    /// Ground condition (REQ-RACE-034). Turf: firm/good/yielding/soft. Dirt: fast/good/muddy/sloppy.
    /// The numeric value is the "wetness" index 0..3 (good = 1) used to pick ruleset coefficients.
    /// </summary>
    public enum Going { FirmOrFast = 0, Good = 1, YieldingOrMuddy = 2, SoftOrSloppy = 3 }

    /// <summary>Horse preference for the ground (REQ-RACE-035). Any = no preference.</summary>
    public enum GoingAptitude { Any = 0, Fast = 1, Heavy = 2 }

    public sealed class TrackSegment
    {
        public SegmentKind Kind;
        public int LengthM;
        public int RadiusM;

        public TrackSegment() { }
        public TrackSegment(SegmentKind kind, int lengthM, int radiusM = 0)
        {
            Kind = kind; LengthM = lengthM; RadiusM = radiusM;
        }
    }

    public sealed class TrackSpec
    {
        public string Id;
        public Surface Surface;
        public int DistanceM;
        public List<TrackSegment> Segments = new List<TrackSegment>();
        /// <summary>Ground condition; null = not sent (treated as Good; old configs, byte-identical results).</summary>
        public Going? Going;
        /// <summary>Night race; null = not sent. Visual/commentary only — no effect on the simulation.</summary>
        public bool? Night;

        public Going EffectiveGoing => Going ?? Muchi.Engine.Going.Good;
    }

    /// <summary>
    /// When a unique skill (固有スキル, ruleset 1.3) fires. Conditions only — no random draw (docs/planning/06 §7.1).
    /// Every condition is read from the horse's state at the start of the tick (the previous tick's result).
    /// </summary>
    public enum SkillTrigger
    {
        /// <summary>In the final straight (last segment, within the spurt zone) with at most Value horses ahead.</summary>
        FinalStraight = 0,
        /// <summary>In a corner at lane ≤ Value (0 = on the rail).</summary>
        CornerRail = 1,
        /// <summary>Remaining stamina ≤ Value ‰ of the maximum.</summary>
        LowStamina = 2,
        /// <summary>In the spurt zone with at least Value horses ahead.</summary>
        SpurtBehind = 3,
        /// <summary>At most Value metres to go.</summary>
        Remaining = 4,
        /// <summary>Leading with at most Value metres to go.</summary>
        Leading = 5,
        /// <summary>Drafting (in the slipstream) for at least Value consecutive ticks.</summary>
        Slipstream = 6,
        /// <summary>Left the gate at most Value ticks after it opened (fires on the departure tick).</summary>
        GoodStart = 7,
    }

    /// <summary>
    /// A horse's unique skill (固有スキル, REQ-UXS-050/051). Fires at most once per race when its condition holds; the
    /// effect lasts DurationTicks. All effects are integer permille and are clamped to the ruleset's skill caps.
    /// </summary>
    public sealed class SkillSpec
    {
        public string Id;
        /// <summary>Display name (HUD cut-in, commentary). Not used by the simulation.</summary>
        public string Name;
        public SkillTrigger Trigger;
        public int Value;
        /// <summary>Target speed +‰ while active.</summary>
        public int SpeedPermille;
        /// <summary>Acceleration +‰ while active.</summary>
        public int AccelPermille;
        /// <summary>Stamina drain −‰ while active.</summary>
        public int DrainSavePermille;
        /// <summary>One-time stamina recovery, ‰ of the maximum, when it fires.</summary>
        public int RecoverPermille;
        public int DurationTicks;

        /// <summary>Largest Value accepted for each trigger (index = SkillTrigger).</summary>
        public static readonly int[] MaxValue = { 11, 11, 1000, 11, 4000, 4000, 1200, 60 };

        public void Validate()
        {
            if (string.IsNullOrEmpty(Id)) throw new ArgumentException("skill.id required");
            int t = (int)Trigger;
            if (t < 0 || t >= MaxValue.Length) throw new ArgumentException("skill.trigger invalid");
            if (Value < 0 || Value > MaxValue[t]) throw new ArgumentException("skill.value out of range for " + Trigger);
            if (Trigger == SkillTrigger.Slipstream && Value < 1) throw new ArgumentException("skill.value must be >= 1 for slipstream");
            if (!P1000(SpeedPermille) || !P1000(AccelPermille) || !P1000(DrainSavePermille) || !P1000(RecoverPermille))
                throw new ArgumentException("skill effects must be 0..1000");
            if (DurationTicks < 0 || DurationTicks > 1200) throw new ArgumentException("skill.durationTicks must be 0..1200");
        }

        private static bool P1000(int v) => v >= 0 && v <= 1000;
    }

    public sealed class HorseSpec
    {
        public string Id;
        public string Name;
        public int Speed, Stamina, Burst, Guts, Temper; // 0..1000
        public RunningStyle Style;
        public int DistMinM, DistMaxM;
        public Surface Surface;
        /// <summary>Ground preference; null = not sent (Any).</summary>
        public GoingAptitude? GoingAptitude;
        /// <summary>Unique skill (ruleset 1.3); null = none. Ignored when the ruleset has no skill keys.</summary>
        public SkillSpec Skill;
    }

    public sealed class Entrant
    {
        public int Slot;
        public EntrantKind Kind;
        public string PlayerId;
        public int CpuLevel = 3;
        public HorseSpec Horse;
    }

    public sealed class NetParams
    {
        public int TickHz = 20;
        public int InputDelayTicks = 3;
        public int BundleIntervalTicks = 2;
        public int ChecksumIntervalTicks = 20;
        public int DisconnectGraceMs = 3000;
    }

    public sealed class RaceConfig
    {
        public int V = 1;
        public string RaceId;
        public RaceMode Mode;
        /// <summary>uint64 seed (sent as a decimal string over JSON).</summary>
        public ulong Seed;
        public TrackSpec Track;
        public NetParams Net = new NetParams();
        public RulesetParams Ruleset;
        public List<Entrant> Entrants = new List<Entrant>();

        /// <summary>Throws ArgumentException when the config breaks contracts/protocol.md §2.</summary>
        public void Validate()
        {
            if (V != 1) throw new ArgumentException("unsupported config version");
            if (string.IsNullOrEmpty(RaceId)) throw new ArgumentException("raceId required");
            if (Track == null) throw new ArgumentException("track required");
            if (Ruleset == null) throw new ArgumentException("ruleset required");
            // bounds keep 1000 / tickHz > 0 and the fixed-point math far from overflow
            if (Net == null || Net.TickHz < 1 || Net.TickHz > 60) throw new ArgumentException("net.tickHz must be 1..60");
            if (Net.ChecksumIntervalTicks <= 0) throw new ArgumentException("net.checksumIntervalTicks must be > 0");
            if (Net.InputDelayTicks < 0 || Net.InputDelayTicks > 60) throw new ArgumentException("net.inputDelayTicks must be 0..60");
            if (Net.BundleIntervalTicks < 1 || Net.BundleIntervalTicks > 60) throw new ArgumentException("net.bundleIntervalTicks must be 1..60");
            if (Track.DistanceM <= 0 || Track.DistanceM > 4000) throw new ArgumentException("track.distanceM out of range");
            if (Track.Segments == null || Track.Segments.Count == 0) throw new ArgumentException("track.segments required");
            long sum = 0;
            foreach (var s in Track.Segments)
            {
                if (s.LengthM < 1) throw new ArgumentException("segment lengthM must be >= 1");
                if (s.Kind == SegmentKind.Corner && (s.RadiusM < 1 || s.RadiusM > MaxCornerRadiusM)) throw new ArgumentException("corner radiusM must be 1.." + MaxCornerRadiusM);
                sum += s.LengthM;
            }
            if (sum != Track.DistanceM) throw new ArgumentException("segment lengths must sum to distanceM");
            if (Entrants == null || Entrants.Count < 1 || Entrants.Count > 12) throw new ArgumentException("1..12 entrants required");
            if (Entrants.Count > Ruleset.LaneCount) throw new ArgumentException("more entrants than lanes");
            for (int i = 0; i < Entrants.Count; i++)
            {
                var e = Entrants[i];
                if (e.Slot != i) throw new ArgumentException("entrant slots must be 0..n-1 in order");
                if (e.Horse == null) throw new ArgumentException("entrant horse required");
                if (e.CpuLevel < 1 || e.CpuLevel > 5) throw new ArgumentException("cpuLevel must be 1..5");
                var h = e.Horse;
                if (!InStat(h.Speed) || !InStat(h.Stamina) || !InStat(h.Burst) || !InStat(h.Guts) || !InStat(h.Temper))
                    throw new ArgumentException("horse stats must be 0..1000");
                if (h.DistMinM <= 0 || h.DistMaxM < h.DistMinM) throw new ArgumentException("horse distance aptitude invalid");
                h.Skill?.Validate();
            }
        }

        private static bool InStat(int v) => v >= 0 && v <= 1000;

        /// <summary>Largest corner radius accepted (real ovals are ~100-300 m; huge radii would overflow Fx math).</summary>
        public const int MaxCornerRadiusM = 10000;
    }
}
