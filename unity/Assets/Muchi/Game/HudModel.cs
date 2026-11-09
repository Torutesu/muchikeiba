using System;
using Muchi.Client;
using Muchi.Engine;

namespace Muchi.Game
{
    /// <summary>Everything the race HUD shows, read from the engine state (no presentation-side race logic).</summary>
    public sealed class HudSnapshot
    {
        public RacePhase Phase;
        public bool HasRace;
        public int PlayerSlot;
        public int Runners;
        public int Rank;
        public int DistanceM, RemainingM;
        public int StaminaPermille;
        public int WhipsLeft, MaxWhips;
        public int Composure;
        public bool Kakari, Reining, Spurt, WhipActive, Blocked, Departed, Finished, GateOpen;
        /// <summary>Ticks until the gate opens (0 once open).</summary>
        public int GateCountdownTicks;
        public long ElapsedMs;
        /// <summary>0..1 progress per slot for the minimap (index = slot).</summary>
        public double[] Progress = Array.Empty<double>();
        /// <summary>The player's finishing place (1-based) once the race result exists, else 0.</summary>
        public int FinishPlace;
        /// <summary>The rank means something (the gate has opened): before that show 「—」 (06 §6.3, F7).</summary>
        public bool RankKnown;

        // ---- race feel (06 §6.3, REQ-UXU-007): data only, Codex draws it
        /// <summary>Gauge colour: Low (≤30 %) yellow, Critical (≤10 %) red + blink + haptic, Empty 「脚が上がった」.</summary>
        public StaminaWarning Stamina;
        public bool StaminaBlink;
        /// <summary>Light the whip button 「今だ、ムチ！」: inside the whip window only, once per race with a tracker.</summary>
        public bool WhipChance;
        /// <summary>In a slipstream: wind lines around the partner + 「脚をためている」.</summary>
        public bool Slipstream;
        /// <summary>Pulling while not reined: 「掛かっている：手綱を長押し」.</summary>
        public bool KakariWarning;
        /// <summary>Burning stamina too fast for the distance left (before the final stretch).</summary>
        public bool RunawayWarning;
        /// <summary>The last whip was mashed: 「間をあけて」.</summary>
        public bool WhipMashed;
        /// <summary>Nearest horse ahead / behind, mm (-1 = none): 「前と1馬身」 via RaceFeel.MarginText.</summary>
        public long GapAheadMm = -1, GapBehindMm = -1;
        /// <summary>The one line to show now (null = none).</summary>
        public string Hint;
        /// <summary>Cues raised since the last Build with a tracker (haptics, sounds, one-shot subtitles).</summary>
        public RaceFeelCue[] Cues = Array.Empty<RaceFeelCue>();
        /// <summary>
        /// Show SPUR / REIN / lane controls: only when riding a horse (PlayerSlot &gt;= 0). Spectators (and a session that
        /// has not been given its slot yet) get no rider controls.
        /// </summary>
        public bool RiderControls => PlayerSlot >= 0;

        // ---- かんたん操作 (REQ-ASSIST-009)
        /// <summary>The assist level riding this race (Off in the tutorial and for spectators).</summary>
        public AssistLevel Assist;
        /// <summary>「かんたん操作 ON」 while the assist rides (null when off): a small chip, never shown to other riders.</summary>
        public string AssistLabel;
        /// <summary>The whip button is driven by the assist (draw it dimmed with the auto mark; taps are ignored).</summary>
        public bool WhipAuto => Assist != AssistLevel.Off;
        /// <summary>Lanes and rein are driven too (full assist): dim those controls.</summary>
        public bool SteeringAuto => Assist == AssistLevel.Full;
    }

    public static class HudModel
    {
        /// <summary>
        /// HUD state now. Pass the race's <see cref="RaceFeelTracker"/> (one per race, e.g. from
        /// <see cref="RaceObserver"/>) for the one-time cues; without it the race-feel flags are computed statelessly.
        /// </summary>
        public static HudSnapshot Build(IRaceDriver d, long nowMs, RaceFeelTracker feel = null)
        {
            var s = new HudSnapshot { Phase = d.Phase, PlayerSlot = d.PlayerSlot };
            var sim = d.Sim;
            var cfg = d.Config;
            if (sim == null || cfg == null || d.PlayerSlot < 0) return s;
            s.HasRace = true;
            s.Runners = sim.EntrantCount;
            var me = sim.GetHorse(d.PlayerSlot);
            int total = cfg.Track.DistanceM;
            s.DistanceM = (int)Math.Min(total, me.Distance.Raw >> 16);
            s.RemainingM = Math.Max(0, total - s.DistanceM);
            s.Rank = me.Rank + 1; // HorseState.Rank is 0-based
            s.StaminaPermille = me.StaminaPermille;
            s.WhipsLeft = me.WhipsLeft;
            s.MaxWhips = cfg.Ruleset.MaxWhips;
            s.Composure = me.Composure;
            s.Kakari = me.IsKakari;
            s.Reining = me.Reining;
            s.Spurt = me.InSpurt;
            s.WhipActive = me.IsWhipActive;
            s.Blocked = me.Blocked;
            s.Departed = me.Departed;
            s.Finished = me.Finished;
            s.GateOpen = sim.GateOpened;
            s.GateCountdownTicks = Math.Max(0, cfg.Ruleset.GateOpenTick - sim.Tick + 1);
            s.ElapsedMs = d.ElapsedMs(nowMs);
            s.Progress = new double[s.Runners];
            for (int i = 0; i < s.Runners; i++)
            {
                var h = sim.GetHorse(i);
                s.Progress[i] = Math.Max(0, Math.Min(1, (h.Distance.Raw / 65536.0) / total));
            }
            if (sim.IsFinished && sim.Result != null)
            {
                int place = Array.IndexOf(sim.Result.Order, d.PlayerSlot);
                s.FinishPlace = place < 0 ? 0 : place + 1;
            }
            s.RankKnown = sim.GateOpened && me.Departed;
            s.Assist = AssistModel.RidingLevel(d);
            s.AssistLabel = AssistLevels.HudLabel(s.Assist);
            FillFeel(s, sim, d.PlayerSlot, feel);
            return s;
        }

        private static void FillFeel(HudSnapshot s, RaceSim sim, int slot, RaceFeelTracker feel)
        {
            if (feel != null && feel.Slot == slot)
            {
                var f = feel.Update(sim);
                s.Stamina = f.Stamina; s.StaminaBlink = f.StaminaBlink; s.WhipChance = f.WhipChance; s.Slipstream = f.Slipstream;
                s.KakariWarning = f.KakariWarning; s.RunawayWarning = f.RunawayWarning; s.WhipMashed = f.WhipMashed;
                s.GapAheadMm = f.GapAheadMm; s.GapBehindMm = f.GapBehindMm; s.Hint = f.Hint;
                s.Cues = feel.NewCues.Count == 0 ? Array.Empty<RaceFeelCue>() : new System.Collections.Generic.List<RaceFeelCue>(feel.NewCues).ToArray();
                return;
            }
            var me = sim.GetHorse(slot);
            if (!me.Departed) return;
            s.Stamina = RaceFeel.StaminaLevel(me);
            s.StaminaBlink = s.Stamina == StaminaWarning.Critical;
            s.WhipChance = RaceFeel.InWhipWindow(sim, slot);
            s.Slipstream = RaceFeel.InSlipstream(sim, slot);
            s.KakariWarning = me.IsKakari && !me.Reining && !me.Finished;
            s.RunawayWarning = !s.KakariWarning && RaceFeel.IsRunaway(sim, slot);
            var g = RaceFeel.Gaps(sim, slot);
            s.GapAheadMm = g.aheadMm; s.GapBehindMm = g.behindMm;
            s.Hint = me.Finished ? null : s.KakariWarning ? RaceFeel.TextKakari : s.Stamina == StaminaWarning.Empty ? RaceFeel.TextStaminaEmpty
                : s.WhipChance ? RaceFeel.TextWhipChance : s.Stamina == StaminaWarning.Critical ? RaceFeel.TextStaminaCritical
                : s.RunawayWarning ? RaceFeel.TextRunaway : s.Slipstream ? RaceFeel.TextSlipstream : null;
        }

        /// <summary>m:ss.f</summary>
        public static string FormatTime(long ms)
        {
            if (ms < 0) ms = 0;
            long tenths = ms / 100;
            return (tenths / 600) + ":" + (tenths / 10 % 60).ToString("00") + "." + (tenths % 10);
        }
    }
}
