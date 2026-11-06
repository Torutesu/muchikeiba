using System.Collections.Generic;

namespace Muchi.Engine
{
    /// <summary>Commentary / presentation events (REQ-RACE-083).</summary>
    public enum RaceEventType
    {
        GateOpen = 0,
        /// <summary>Horse left the gate on a player/CPU START. Value = reaction ticks after the gate opened.</summary>
        Start = 1,
        /// <summary>Horse was auto-started (出遅れ).</summary>
        LateStart = 2,
        /// <summary>New leader. Slot = leader.</summary>
        LeaderChanged = 3,
        /// <summary>Horse started pulling (かかった).</summary>
        Kakari = 4,
        /// <summary>Whip used. Value = whips left after this one.</summary>
        Whip = 5,
        /// <summary>Horse entered the spurt zone. Value = its rank (0 = leader) at that moment (ranks after the previous tick).</summary>
        SpurtStart = 6,
        /// <summary>Horse crossed the line. Value = 1-based finishing place.</summary>
        Finish = 7,
        CpuTakeover = 8,
        HumanResume = 9,
        /// <summary>Race over (all finished or maxTicks). Slot = winner or -1.</summary>
        RaceEnd = 10,
        /// <summary>Lane change started. Value = target lane.</summary>
        LaneChange = 11,
    }

    public struct RaceEvent
    {
        public int Tick;
        public RaceEventType Type;
        public int Slot;
        public int Value;

        public RaceEvent(int tick, RaceEventType type, int slot, int value)
        {
            Tick = tick; Type = type; Slot = slot; Value = value;
        }

        public override string ToString() => Tick + ":" + Type + ":" + Slot + ":" + Value;
    }

    /// <summary>Final result (REQ-RACE-071).</summary>
    public sealed class RaceResult
    {
        /// <summary>Slots in finishing order.</summary>
        public int[] Order;
        /// <summary>Finish tick per place (same order as Order), -1 = did not finish.</summary>
        public int[] FinishTicks;
        /// <summary>Finish fraction per place (Q16.16 fractional raw), or distance raw for non-finishers.</summary>
        public long[] FinishFracOrDistanceRaw;
        /// <summary>Distance behind the previous place at the moment the previous horse finished, meters (0 for the winner).</summary>
        public Fx[] Margins;
        public string CanonicalString;
        public string Hash;
        public int EndTick;
    }
}
