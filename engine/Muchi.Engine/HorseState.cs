namespace Muchi.Engine
{
    /// <summary>
    /// Per-horse simulation state (REQ-RACE-033). A value type: copies handed to the
    /// renderer are snapshots and cannot change the simulation.
    /// </summary>
    public struct HorseState
    {
        /// <summary>Distance along the inside rail from the start, meters.</summary>
        public Fx Distance;
        /// <summary>Lateral position in lanes (0 = inside rail). Fractional while changing lanes.</summary>
        public Fx Lane;
        /// <summary>Lane the horse is moving to (integer).</summary>
        public int LaneTarget;
        /// <summary>Speed, m/s.</summary>
        public Fx Speed;
        /// <summary>Remaining stamina (脚).</summary>
        public Fx Stamina;
        public Fx StaminaMax;
        /// <summary>折り合い 0..100.</summary>
        public int Composure;
        public int WhipsLeft;
        public int WhipTicksLeft;
        public int WhipEffectPermille;
        public int LastWhipTick;
        /// <summary>Tick of the last lane change the rider asked for (auto-steer holds off after it).</summary>
        public int LastManualLaneTick;
        public bool Reining;
        public bool Departed;
        public int DepartTick;
        public int StartBoostTicksLeft;
        public int KakariTicksLeft;
        public bool InSpurt;
        public bool Blocked;
        public bool CpuControlled;
        /// <summary>Tick on which the horse crossed the line, -1 if not finished.</summary>
        public int FinishTick;
        /// <summary>Fraction of the finishing tick at which the line was crossed (Q16.16 fractional part, 0..65535).</summary>
        public int FinishFracRaw;
        /// <summary>Distance advanced in the last tick (used to keep followers from running through).</summary>
        public Fx LastAdvance;
        /// <summary>0-based current position in the race.</summary>
        public int Rank;
        /// <summary>The unique skill has fired (at most once per race).</summary>
        public bool SkillUsed;
        /// <summary>Ticks the fired skill's effect still lasts.</summary>
        public int SkillTicksLeft;
        /// <summary>Consecutive ticks spent in another horse's slipstream (skill condition).</summary>
        public int SlipTicks;

        public bool Finished => FinishTick >= 0;
        public bool IsKakari => KakariTicksLeft > 0;
        public bool IsWhipActive => WhipTicksLeft > 0;
        public bool IsSkillActive => SkillTicksLeft > 0;
        public bool IsChangingLane => Lane != Fx.FromInt(LaneTarget);

        /// <summary>Remaining stamina as permille of the maximum (for HUD gauges).</summary>
        public int StaminaPermille => StaminaMax.Raw <= 0 ? 0 : (int)(Stamina.Raw * 1000 / StaminaMax.Raw);
    }
}
