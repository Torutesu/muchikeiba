namespace Muchi.Engine
{
    /// <summary>
    /// Deterministic CPU rider (REQ-RACE-060..063). Produces the same command bytes a
    /// human would send, from the pre-step race state and a per-slot PCG32 stream.
    /// cpuLevel only changes timing accuracy, never horse stats.
    /// </summary>
    internal sealed class CpuBrain
    {
        private readonly RaceSim _sim;
        private readonly int _slot;
        private readonly int _level;
        private Pcg32 _rng;
        private readonly int _startTick;
        private int _nextWhipTick = -1;
        private readonly int _decisionOffset;
        /// <summary>Rides like a casual player (ruleset 1.1 cpuSloppyMaxLevel); extra random draws happen only then.</summary>
        private readonly bool _sloppy;
        private readonly int _sloppyWhipFromM;

        public CpuBrain(RaceSim sim, int slot, int level, Pcg32 rng)
        {
            _sim = sim;
            _slot = slot;
            _level = level;
            _rng = rng;
            var p = sim.P;
            // reaction delay after the gate opens: better riders react faster
            int maxDelay;
            switch (level)
            {
                case 5: maxDelay = 1; break;
                case 4: maxDelay = 2; break;
                case 3: maxDelay = 3; break;
                case 2: maxDelay = 5; break;
                default: maxDelay = 8; break;
            }
            _sloppy = level <= p.CpuSloppyMaxLevel;
            if (_sloppy) maxDelay += 3; // casual reactions: often misses the start window
            _startTick = p.GateOpenTick + _rng.Range(0, maxDelay);
            if (_sloppy) _sloppyWhipFromM = 250 + _rng.Range(0, 350);
            _decisionOffset = slot % p.CpuDecisionIntervalTicks;
        }

        /// <summary>Called when a human slot is taken over (disconnect).</summary>
        public void OnTakeover(int tick)
        {
            _nextWhipTick = -1;
        }

        private int Jitter(int maxAtLevel1)
        {
            int max = maxAtLevel1 * (6 - _level) / 5;
            return max <= 0 ? 0 : _rng.Range(0, max);
        }

        public byte Decide(int t)
        {
            var p = _sim.P;
            var me = _sim.GetHorse(_slot);
            byte c = 0;
            if (me.Finished) return 0;

            if (!me.Departed)
            {
                if (t >= _startTick) c |= Cmd.Start;
                return c;
            }

            Fx remaining = _sim.Track.Distance - me.Distance;
            bool spurt = remaining <= _sim.SpurtDistance;

            if (_sloppy)
            {
                // casual habits: whips from a random point with uneven spacing
                if (remaining <= Fx.FromInt(_sloppyWhipFromM) && me.WhipsLeft > 0)
                {
                    if (_nextWhipTick < 0) _nextWhipTick = t;
                    if (t >= _nextWhipTick) { c |= Cmd.Whip; _nextWhipTick = t + 6 + _rng.Range(0, 30); }
                }
            }
            // whips in the spurt zone, spaced out (never mash)
            else if (remaining <= Fx.FromInt(p.CpuWhipStartDistanceM + Jitter(100)) && me.WhipsLeft > 0)
            {
                if (_nextWhipTick < 0) _nextWhipTick = t + Jitter(8);
                if (t >= _nextWhipTick)
                {
                    c |= Cmd.Whip;
                    _nextWhipTick = t + p.CpuWhipIntervalTicks + Jitter(16);
                }
            }

            if ((t - _decisionOffset) % p.CpuDecisionIntervalTicks != 0) return c;

            var style = _sim.Config.Entrants[_slot].Horse.Style;
            int n = _sim.EntrantCount;

            // rein decisions
            bool wantRein;
            if (spurt)
            {
                wantRein = false;
            }
            else
            {
                int rankPermille = n <= 1 ? 0 : me.Rank * 1000 / (n - 1);
                int targetRank;
                switch (style)
                {
                    case RunningStyle.Nige: targetRank = p.CpuTargetRankNigePermille; break;
                    case RunningStyle.Senko: targetRank = p.CpuTargetRankSenkoPermille; break;
                    case RunningStyle.Sashi: targetRank = p.CpuTargetRankSashiPermille; break;
                    default: targetRank = p.CpuTargetRankOikomiPermille; break;
                }
                long remainingPermille = remaining.Raw * 1000 / _sim.Track.Distance.Raw;
                bool tooFarForward = style != RunningStyle.Nige && rankPermille + 100 < targetRank;
                bool composureBad = me.Composure < p.BadComposureThreshold + 10 || me.IsKakari;
                bool staminaShort = !_sloppy && _level >= p.CpuStaminaReinMinLevel && me.StaminaPermille + 50 < remainingPermille;
                wantRein = tooFarForward || composureBad || staminaShort;
            }
            if (wantRein && !me.Reining) c |= Cmd.ReinPress;
            if (!wantRein && me.Reining) c |= Cmd.ReinRelease;

            // lane decisions
            if (!me.IsChangingLane)
            {
                bool blockedAhead = IsSlowHorseAhead(me);
                if (blockedAhead)
                {
                    if (me.LaneTarget + 1 < p.LaneCount && _sim.LaneClear(_slot, me.LaneTarget + 1)) c |= Cmd.LaneOut;
                    else if (me.LaneTarget > 0 && _sim.LaneClear(_slot, me.LaneTarget - 1)) c |= Cmd.LaneIn;
                }
                else if (!spurt && me.LaneTarget > 0)
                {
                    // save ground: drift toward the rail when there is room (weaker riders do it less)
                    bool tryIn = _level >= p.CpuRailMinLevel || _rng.Chance(1, 2);
                    if (tryIn && _sim.LaneClear(_slot, me.LaneTarget - 1) && !WouldBeBlockedIn(me, me.LaneTarget - 1)) c |= Cmd.LaneIn;
                }
            }
            return c;
        }

        private bool IsSlowHorseAhead(HorseState me)
        {
            Fx range = _sim.BlockRange * 2;
            Fx half = Fx.FromRatio(1, 2);
            Fx myTarget = _sim.TopSpeed(_slot).MulPermille(_sim.P.CruiseSpeedPermille);
            for (int j = 0; j < _sim.EntrantCount; j++)
            {
                if (j == _slot) continue;
                var o = _sim.GetHorse(j);
                if (o.Finished || !o.Departed) continue;
                if ((o.Lane - me.Lane).Abs() > half) continue;
                Fx gap = o.Distance - me.Distance;
                if (gap.Raw <= 0 || gap > range) continue;
                if (me.InSpurt || o.Speed < myTarget) return true;
            }
            return false;
        }

        private bool WouldBeBlockedIn(HorseState me, int lane)
        {
            Fx range = _sim.BlockRange * 3;
            Fx laneFx = Fx.FromInt(lane);
            Fx half = Fx.FromRatio(1, 2);
            for (int j = 0; j < _sim.EntrantCount; j++)
            {
                if (j == _slot) continue;
                var o = _sim.GetHorse(j);
                if (o.Finished) continue;
                if ((o.Lane - laneFx).Abs() > half) continue;
                Fx gap = o.Distance - me.Distance;
                if (gap.Raw > 0 && gap <= range && o.Speed < me.Speed) return true;
            }
            return false;
        }
    }
}
