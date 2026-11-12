using System;
using Muchi.Engine;

namespace Muchi.Client
{
    /// <summary>
    /// かんたん操作 (easy controls, REQ-ASSIST-001..012, contracts/protocol.md §27). Off by default.
    /// Whip = the whip is timed automatically (the player still starts, steers and reins).
    /// Full = the assistant rides the whole race (start, pace with the rein, simple lane choice, whip).
    /// </summary>
    public enum AssistLevel { Off = 0, Whip = 1, Full = 2 }

    public static class AssistLevels
    {
        /// <summary>The wire value of the server setting and of the room's `res.assist` ("off" | "whip" | "full").</summary>
        public static string Wire(AssistLevel l) => l == AssistLevel.Whip ? "whip" : l == AssistLevel.Full ? "full" : "off";

        /// <summary>Unknown or missing values are Off (an older or newer server never turns the assist on by itself).</summary>
        public static AssistLevel Parse(string s) => s == "whip" ? AssistLevel.Whip : s == "full" ? AssistLevel.Full : AssistLevel.Off;

        /// <summary>
        /// REQ-ASSIST-006: the assist never rides the tutorial (its outcome rule REQ-UXS-004 is defined for a player
        /// with assist off). Every other mode accepts it (ranked included: it is capped below skilled play, REQ-ASSIST-005).
        /// </summary>
        public static bool AllowedIn(RaceMode mode) => mode != RaceMode.Tutorial;

        /// <summary>HUD indicator (REQ-ASSIST-009): shown while the assist rides; null when off.</summary>
        public static string HudLabel(AssistLevel l) => l == AssistLevel.Off ? null : Loc.T(TextOn);

        /// <summary>The level's short name for the setting row.</summary>
        public static string Name(AssistLevel l) => Loc.T(l == AssistLevel.Whip ? TextWhip : l == AssistLevel.Full ? TextFull : TextOff);

        public const string TextOn = "かんたん操作 ON";
        public const string TextOff = "オフ";
        public const string TextWhip = "ムチだけおまかせ";
        public const string TextFull = "ぜんぶおまかせ";
    }

    /// <summary>
    /// A deterministic input assistant (REQ-ASSIST-002). Each tick it reads the race state the client already has (the
    /// local <see cref="RaceSim"/>) and produces the same command bytes a player would send. Its commands go through
    /// the normal input path (offline: <see cref="OfflineRace"/>; online: <see cref="RaceSession"/> → lockstep "in"), so
    /// the engine, rulesets, verifier and result hash are unchanged, and a replay of the race needs nothing but the
    /// recorded inputs. No randomness, no wall clock: the same state always gives the same command.
    ///
    /// The plan is deliberately simpler than good manual play (REQ-ASSIST-005, balance target R11): a start a little after the gate,
    /// the whips start a little early with a wider gap, the rein keeps a looser stamina reserve and no slipstream is
    /// hunted. It is still clearly better than not touching the screen.
    ///
    /// Commands land later online (the room adds the input delay), so the assistant never re-reads its own pending
    /// commands from the state: it remembers what it already sent (rein intent, last whip tick, last lane tick).
    /// </summary>
    public sealed class InputAssistant
    {
        // The plan's tuning (balance-targets §2.3, R11). Changing any of these means re-running InputAssistTests.

        /// <summary>
        /// START this many ticks after the gate opens, like an attentive player (offline that is inside the good-start
        /// window; online the room's input delay comes on top, as for a tap). Skilled play starts on the gate tick.
        /// </summary>
        public const int StartReactionTicks = 2;
        /// <summary>Extra ticks between whips on top of the shortest spacing without diminishing.</summary>
        public const int WhipSpacingExtraTicks = 6;
        /// <summary>Starts the whips this many metres before the point where the remaining whips would end on the line.</summary>
        public const int WhipEarlyM = 60;
        /// <summary>Rein when stamina‰ + margin is below the remaining distance‰ (skilled riders keep a tighter reserve).</summary>
        public const int ReinMarginPermille = -180;
        /// <summary>Composure below the "bad" threshold + this → rein (calms a pulling horse).</summary>
        public const int ComposureMargin = 10;
        /// <summary>One lane decision every this many ticks.</summary>
        public const int LaneDecisionTicks = 8;

        private int _decidedTick = -1;
        private int _lastWhipTick = -100000;
        private int _lastLaneTick = -100000;
        private bool _reinSent;
        private int _reinSentTick = -100000;
        private bool _startSent;

        /// <summary>
        /// Online only in practice: a rein edge whose effect has not shown after this many ticks (far beyond the room's
        /// input delay) was lost with a dropped socket and is sent again. Offline the effect is immediate, so it never fires.
        /// </summary>
        public const int ResyncTicks = 40;

        public InputAssistant(AssistLevel level, int slot)
        {
            Level = level;
            Slot = slot;
        }

        public AssistLevel Level { get; }
        public int Slot { get; }
        public bool Active => Level != AssistLevel.Off && Slot >= 0;
        /// <summary>Commands the assistant generated (non-zero ticks), for tests and diagnostics.</summary>
        public int CommandsSent { get; private set; }

        /// <summary>
        /// The player's own bits the assistant leaves in place: all of them when off; everything but the whip with the
        /// whip assist (SPUR still starts the race); none with the full assist (taps would only fight the plan).
        /// </summary>
        public byte FilterPlayer(RaceSim sim, byte cmd)
        {
            if (!Active) return cmd;
            if (Level == AssistLevel.Full) return 0;
            // whip assist: START before departure stays the player's; once departed the whip is the assistant's
            var me = sim.GetHorse(Slot);
            return me.Departed ? (byte)(cmd & ~Cmd.Whip) : cmd;
        }

        /// <summary>Filtered player bits plus the assistant's command for this tick (one decision per simulation tick).</summary>
        public byte Apply(RaceSim sim, byte playerCmd) => (byte)(FilterPlayer(sim, playerCmd) | Decide(sim));

        /// <summary>
        /// The assistant's command for the state at <c>sim.Tick</c>. Safe to call every frame: only the first call per
        /// simulation tick decides; later calls in the same tick return 0.
        /// </summary>
        public byte Decide(RaceSim sim)
        {
            if (!Active || sim == null || sim.IsFinished || Slot >= sim.EntrantCount) return 0;
            int t = sim.Tick;
            if (t == _decidedTick) return 0;
            _decidedTick = t;
            if (!AssistLevels.AllowedIn(sim.Config.Mode)) return 0;
            var me = sim.GetHorse(Slot);
            if (me.Finished || me.CpuControlled) return 0;
            byte c = Level == AssistLevel.Full ? FullRide(sim, me, t) : WhipOnly(sim, me, t);
            if (c != 0) CommandsSent++;
            return c;
        }

        private byte WhipOnly(RaceSim sim, HorseState me, int t)
        {
            if (!me.Departed) return 0;
            return WantWhip(sim, me, t) ? MarkWhip(t) : (byte)0;
        }

        private byte FullRide(RaceSim sim, HorseState me, int t)
        {
            var p = sim.P;
            if (!me.Departed)
            {
                if (_startSent || t < p.GateOpenTick + StartReactionTicks) return 0;
                _startSent = true;
                return Cmd.Start;
            }
            byte c = 0;
            if (WantWhip(sim, me, t)) c |= MarkWhip(t);

            long rem = RemainingM(sim, me);
            bool spurt = rem <= sim.SpurtZoneM;
            bool wantRein = false;
            if (!spurt)
            {
                long remPermille = (sim.Track.Distance - me.Distance).Raw * 1000 / Math.Max(1, sim.Track.Distance.Raw);
                bool composure = me.Composure < p.BadComposureThreshold + ComposureMargin || me.IsKakari;
                wantRein = composure || me.StaminaPermille + ReinMarginPermille < remPermille;
            }
            // send the edge once; if the horse still disagrees long after (an "in" lost in a reconnect), send it again
            bool resync = wantRein == _reinSent && me.Reining != wantRein && t - _reinSentTick >= ResyncTicks;
            if (wantRein != _reinSent || resync)
            {
                c |= wantRein ? Cmd.ReinPress : Cmd.ReinRelease;
                _reinSent = wantRein;
                _reinSentTick = t;
            }

            // lanes: only steer round a slower horse in front (the jockey's auto-steer keeps to the rail otherwise)
            if (!me.IsChangingLane && t - _lastLaneTick >= LaneDecisionTicks)
            {
                long rangeMm = p.BlockRangeMm * 2;
                int ahead = AheadInLane(sim, Slot, me, rangeMm);
                if (ahead >= 0 && (spurt || sim.GetHorse(ahead).Speed < me.Speed))
                {
                    if (LaneLooksClear(sim, Slot, me, me.LaneTarget + 1)) { c |= Cmd.LaneOut; _lastLaneTick = t; }
                    else if (LaneLooksClear(sim, Slot, me, me.LaneTarget - 1)) { c |= Cmd.LaneIn; _lastLaneTick = t; }
                }
            }
            return c;
        }

        private bool WantWhip(RaceSim sim, HorseState me, int t)
        {
            var p = sim.P;
            if (me.WhipsLeft <= 0) return false;
            // ruleset 1.4: the assist never holds or goes (the horse goes at the auto mark); its whips come after the go
            if (sim.TacticsEnabled && !me.InSpurt) return false;
            int spacing = Math.Max(p.WhipEffectTicks, p.WhipDiminishWindowTicks) + WhipSpacingExtraTicks;
            if (t - _lastWhipTick < spacing) return false;
            long rem = RemainingM(sim, me);
            if (rem > sim.SpurtZoneM) return false;
            long speedMm = Math.Max(1, me.Speed.Raw * 1000 >> 16);
            long needM = (long)me.WhipsLeft * spacing * speedMm / 1000 / Math.Max(1, sim.Config.Net.TickHz);
            return rem <= needM + WhipEarlyM;
        }

        private byte MarkWhip(int t) { _lastWhipTick = t; return Cmd.Whip; }

        private static long RemainingM(RaceSim sim, HorseState h) => (sim.Track.Distance - h.Distance).Raw >> 16;

        /// <summary>Closest running horse ahead within <paramref name="rangeMm"/> in my lane (±0.5), or -1.</summary>
        private static int AheadInLane(RaceSim sim, int slot, HorseState me, long rangeMm)
        {
            int best = -1;
            long bestGap = long.MaxValue;
            Fx half = Fx.FromRatio(1, 2);
            for (int j = 0; j < sim.EntrantCount; j++)
            {
                if (j == slot) continue;
                var o = sim.GetHorse(j);
                if (o.Finished || !o.Departed) continue;
                if ((o.Lane - me.Lane).Abs() > half) continue;
                long gap = (o.Distance - me.Distance).Raw * 1000 >> 16;
                if (gap <= 0 || gap > rangeMm) continue;
                if (gap < bestGap) { bestGap = gap; best = j; }
            }
            return best;
        }

        /// <summary>A conservative copy of the engine's lane-clear rule (the engine ignores a move into an occupied lane anyway).</summary>
        private static bool LaneLooksClear(RaceSim sim, int slot, HorseState me, int lane)
        {
            if (lane < 0 || lane >= sim.P.LaneCount) return false;
            long clearMm = sim.P.LaneChangeClearanceMm + 500;
            Fx laneFx = Fx.FromInt(lane);
            Fx near = Fx.FromRatio(3, 4);
            for (int j = 0; j < sim.EntrantCount; j++)
            {
                if (j == slot) continue;
                var o = sim.GetHorse(j);
                if (o.Finished) continue;
                bool occ = (o.Lane - laneFx).Abs() < near || o.LaneTarget == lane;
                if (!occ) continue;
                long d = Math.Abs((o.Distance - me.Distance).Raw * 1000 >> 16);
                if (d < clearMm) return false;
            }
            return true;
        }
    }
}
