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
        /// <summary>Horse started pulling (かかった). Value = its rank (0 = leader) at that moment (ranks after the previous tick).</summary>
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
        /// <summary>
        /// Unique skill fired (ruleset 1.3, HUD cut-in and commentary). Value = the horse's rank (0 = leader) at that moment
        /// (ranks after the previous tick). Presentation only, not part of the checksum or result hash.
        /// </summary>
        Skill = 12,
        /// <summary>
        /// Ruleset 1.4: the rider pressed the whip inside the 仕掛け window and is holding it (溜め). Value = metres to go.
        /// Presentation only, like every event.
        /// </summary>
        Gather = 13,
        /// <summary>
        /// Ruleset 1.4: the horse went (仕掛け; SpurtStart follows on the same tick). Value = charge in ticks (0 = a plain tap,
        /// gatherMaxTicks = a full 一閃), or -1 when the rider never went and the horse went by itself at the auto mark.
        /// </summary>
        Go = 14,
        /// <summary>Ruleset 1.4: a 会心 whip — on the rhythm after the go or the previous whip. Value = whips left (after the Whip event).</summary>
        Rhythm = 15,
        /// <summary>Ruleset 1.4: pulled out of a slipstream inside the window (slingshot burst). Value = the new lane.</summary>
        Slingshot = 16,
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
