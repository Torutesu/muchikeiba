using System;
using Muchi.Engine;

namespace Muchi.Client
{
    /// <summary>
    /// Offline-only script for an <see cref="OfflineRace"/>: rides the slots that are neither the player nor
    /// CPU-controlled, and may restrict which command bits the player can use. Called once per tick, before
    /// <c>RaceSim.Step</c>, with the state after the previous tick. Must be deterministic (integer maths on the
    /// race state only) so the run replays from <see cref="OfflineRace.AllInputs"/>.
    /// </summary>
    public interface IOfflineRaceDirector
    {
        /// <summary>Command bits the player may use (others are dropped before recording).</summary>
        byte AllowedPlayerBits { get; }

        /// <summary>
        /// Fill <paramref name="cmds"/> for the director's slots. <paramref name="playerCmd"/> is the player's
        /// effective command for this tick (already in <paramref name="cmds"/>; do not change the player's entry).
        /// </summary>
        void Drive(RaceSim sim, int playerSlot, byte playerCmd, byte[] cmds);
    }

    public enum TutorialOutcome
    {
        /// <summary>The player wins (2+ whips in the window, or the assisted 3rd attempt).</summary>
        Win = 1,
        /// <summary>The player finishes a close 2nd, about half a length behind the rival.</summary>
        CloseSecond = 2,
    }

    /// <summary>
    /// REQ-UXS-004 (docs/planning/06 §2.3): the tutorial's win condition, enforced by riding the rival.
    /// <list type="bullet">
    /// <item>2 or more whips while the player has <see cref="WhipWindowM"/> m or less to go (and at least
    /// <see cref="LastCountedM"/> m: with under 2 seconds to run a whip can no longer turn the race) → 1st.</item>
    /// <item>0–1 whips in that window → a close 2nd (the rival holds about half a length).</item>
    /// <item>Attempt <see cref="AssistFromAttempt"/> or later → 1st whatever the input (assisted).</item>
    /// </list>
    /// How: the rival runs on the player's outside lane, mirrors every player whip on the same tick (so whips
    /// outside the rule change nothing), and holds a target gap with the rein — ahead by
    /// <see cref="HoldLeadMm"/> until the rule is met, then behind by <see cref="YieldGapMm"/>. Its free speed
    /// is a little above the player's and its reined speed (tutorial rein 90 %) below it, so the gap is always
    /// reachable. One director per race: it keeps the whip count.
    /// The other runners are much weaker CPUs. The player can only START and WHIP (the tutorial's one button).
    /// Everything is integer maths on the race state: the same inputs always give the same race.
    /// </summary>
    public sealed class TutorialDirector : IOfflineRaceDirector
    {
        public const int WhipWindowM = 300;
        /// <summary>Whips with less than this left to go are too late to count (the rival mirrors them instead).</summary>
        public const int LastCountedM = 50;
        public const int WhipsToWin = 2;
        public const int AssistFromAttempt = 3;
        /// <summary>Rival's lead while the player has not met the rule (≈ half a length).</summary>
        public const int HoldLeadMm = 1200;
        /// <summary>Rival's lead after one counted whip (so a 2nd whip late in the race can still turn it).</summary>
        public const int HoldLeadAfterOneMm = 800;
        /// <summary>How far behind the player the rival settles once the player has met the rule.</summary>
        public const int YieldGapMm = 1200;
        public const int BandMm = 150;
        public const int LookAheadMs = 600;

        /// <summary>1-based attempt number (input: how many times this player has started the tutorial race).</summary>
        public int Attempt { get; }
        public int PlayerSlot { get; }
        public int RivalSlot { get; }
        public bool Assisted => Attempt >= AssistFromAttempt;
        /// <summary>Whips that counted towards the rule so far.</summary>
        public int CountedWhips { get; private set; }
        /// <summary>Tick at which the rule was met (-1 = not yet).</summary>
        public int QualifiedTick { get; private set; } = -1;
        public bool Qualified => CountedWhips >= WhipsToWin;
        /// <summary>The outcome the director is steering to with the inputs so far (final once the race is over).</summary>
        public TutorialOutcome Outcome => Assisted || Qualified ? TutorialOutcome.Win : TutorialOutcome.CloseSecond;

        public byte AllowedPlayerBits => Cmd.Start | Cmd.Whip;

        public TutorialDirector(int attempt, int playerSlot = OfflinePresets.TutorialPlayerSlot, int rivalSlot = OfflinePresets.TutorialRivalSlot)
        {
            if (playerSlot == rivalSlot) throw new ArgumentException("rival must not be the player");
            Attempt = Math.Max(1, attempt);
            PlayerSlot = playerSlot;
            RivalSlot = rivalSlot;
        }

        /// <summary>Is this the tutorial preset (its rival slot is the director's) with the player on <paramref name="playerSlot"/>?</summary>
        public static bool Fits(RaceConfig config, int playerSlot)
        {
            int r = OfflinePresets.TutorialRivalSlot;
            return config != null && config.Mode == RaceMode.Tutorial && playerSlot == OfflinePresets.TutorialPlayerSlot
                && config.Entrants.Count > r && config.Entrants[r].Kind == EntrantKind.Human && config.Entrants[r].PlayerId == OfflinePresets.TutorialRivalId;
        }

        /// <summary>The rule on its own: the outcome for a number of counted whips and an attempt number.</summary>
        public static TutorialOutcome Expected(int countedWhips, int attempt)
            => attempt >= AssistFromAttempt || countedWhips >= WhipsToWin ? TutorialOutcome.Win : TutorialOutcome.CloseSecond;

        /// <summary>Does a whip with <paramref name="remainingMm"/> mm to go count towards the rule?</summary>
        public static bool CountsAt(long remainingMm) => remainingMm <= WhipWindowM * 1000L && remainingMm >= LastCountedM * 1000L;

        public void Drive(RaceSim sim, int playerSlot, byte playerCmd, byte[] cmds)
        {
            if (playerSlot != PlayerSlot || RivalSlot < 0 || RivalSlot >= sim.EntrantCount) return;
            var me = sim.GetHorse(PlayerSlot);
            var rival = sim.GetHorse(RivalSlot);
            if (rival.Finished || rival.CpuControlled) return;
            int t = sim.Tick;
            var p = sim.P;
            long remainingMm = (sim.Track.Distance - me.Distance).ToMilli();

            bool playerWhips = (playerCmd & Cmd.Whip) != 0;
            if (playerWhips && !me.Finished && CountsAt(remainingMm))
            {
                CountedWhips++;
                if (CountedWhips == WhipsToWin) QualifiedTick = t;
            }
            // the 2nd counted whip flips the race on this very tick
            bool yield = Qualified || (Assisted && remainingMm <= WhipWindowM * 1000L) || me.Finished;

            byte c = 0;
            // leave the gate with the player (same tick, same start boost)
            if (!rival.Departed)
            {
                bool playerGoes = me.Departed || (playerCmd & Cmd.Start) != 0 || (t >= p.GateOpenTick && t - p.GateOpenTick >= p.AutoStartDelayTicks);
                if (playerGoes && t >= p.GateOpenTick) c |= Cmd.Start;
                cmds[RivalSlot] = c;
                return;
            }

            // Until the rule is met the rival answers every whip on the same tick, so whip states stay identical
            // and those whips change nothing. Afterwards it only answers diminished whips (mashed inside the
            // previous whip's effect) while its own whip is still running: that weakens its whip the same way,
            // instead of leaving it on a stronger whip than the player's.
            if (playerWhips && rival.WhipsLeft > 0)
            {
                bool diminished = me.WhipTicksLeft > 0 && t - me.LastWhipTick < p.WhipDiminishWindowTicks;
                if (!yield || (diminished && rival.WhipTicksLeft > 0)) c |= Cmd.Whip;
            }

            long gapMm = (rival.Distance - me.Distance).ToMilli(); // > 0: rival ahead
            long target = yield ? -YieldGapMm : CountedWhips == 0 ? HoldLeadMm : HoldLeadAfterOneMm;
            // steer on the gap a moment ahead (gap + closing speed × look-ahead), so the rein does not overshoot
            long predicted = gapMm + (rival.Speed - me.Speed).ToMilli() * LookAheadMs / 1000;
            bool wantRein;
            if (predicted > target + BandMm) wantRein = true;
            else if (predicted < target - BandMm) wantRein = false;
            else wantRein = rival.Reining;
            if (wantRein && !rival.Reining) c |= Cmd.ReinPress;
            if (!wantRein && rival.Reining) c |= Cmd.ReinRelease;
            cmds[RivalSlot] = c;
        }
    }
}
