using System;
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
    }

    public static class HudModel
    {
        public static HudSnapshot Build(IRaceDriver d, long nowMs)
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
            return s;
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
