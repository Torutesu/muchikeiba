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
    public enum RaceMode { Ranked = 0, Friend = 1, Tutorial = 2, TimeAttack = 3, Event = 4 }

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
    }

    public sealed class HorseSpec
    {
        public string Id;
        public string Name;
        public int Speed, Stamina, Burst, Guts, Temper; // 0..1000
        public RunningStyle Style;
        public int DistMinM, DistMaxM;
        public Surface Surface;
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
            if (Net == null || Net.TickHz <= 0) throw new ArgumentException("net.tickHz must be > 0");
            if (Net.ChecksumIntervalTicks <= 0) throw new ArgumentException("net.checksumIntervalTicks must be > 0");
            if (Track.DistanceM <= 0 || Track.DistanceM > 4000) throw new ArgumentException("track.distanceM out of range");
            if (Track.Segments == null || Track.Segments.Count == 0) throw new ArgumentException("track.segments required");
            long sum = 0;
            foreach (var s in Track.Segments)
            {
                if (s.LengthM < 1) throw new ArgumentException("segment lengthM must be >= 1");
                if (s.Kind == SegmentKind.Corner && s.RadiusM < 1) throw new ArgumentException("corner radiusM must be >= 1");
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
            }
        }

        private static bool InStat(int v) => v >= 0 && v <= 1000;
    }
}
