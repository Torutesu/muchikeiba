using System;
using System.Collections.Generic;
using Muchi.Engine;

namespace Muchi.Client
{
    /// <summary>Stamina gauge state (docs/planning/06 §6.3: 30 % yellow, 10 % red + blink + haptics, 0 % "脚が上がった").</summary>
    public enum StaminaWarning
    {
        None = 0,
        /// <summary>≤ 30 %: gauge turns yellow.</summary>
        Low = 1,
        /// <summary>≤ 10 %: red, blinking, haptic.</summary>
        Critical = 2,
        /// <summary>0: 脚が上がった (the horse slows to its guts floor).</summary>
        Empty = 3,
    }

    public enum RaceFeelCueKind
    {
        StaminaLow = 0,
        StaminaCritical = 1,
        StaminaEmpty = 2,
        /// <summary>"今だ、ムチ！" — once per race, when the whip window opens.</summary>
        WhipChance = 3,
        /// <summary>"掛かっている：手綱を長押し" — once per race, the first time the horse pulls while not reined.</summary>
        Kakari = 4,
        /// <summary>Burning stamina faster than the distance allows (before the final stretch) — once per race.</summary>
        Runaway = 5,
        /// <summary>A whip inside the previous whip's effect (diminished, R4a): "間をあけて" — once per race.</summary>
        WhipMash = 6,
        SlipstreamOn = 7,
        SlipstreamOff = 8,
        /// <summary>Haptic "light ×1": the player passed a horse.</summary>
        Overtake = 9,
    }

    /// <summary>One presentation cue (subtitle / haptic / sound trigger) for the player's horse.</summary>
    public struct RaceFeelCue
    {
        public int Tick;
        public RaceFeelCueKind Kind;
        /// <summary>One short Japanese line for the HUD, or null when the cue is not meant to be shown as text.</summary>
        public string Text;
        public RaceFeelCue(int tick, RaceFeelCueKind kind, string text) { Tick = tick; Kind = kind; Text = text; }
        public override string ToString() => Tick + ":" + Kind + (Text == null ? "" : ":" + Text);
    }

    /// <summary>Per-tick race-feel state of the player's horse (read-only data for the HUD; no game logic).</summary>
    public sealed class RaceFeelSnapshot
    {
        public int Tick;
        public int StaminaPermille;
        public StaminaWarning Stamina;
        /// <summary>Blink the gauge (Critical).</summary>
        public bool StaminaBlink;
        /// <summary>Light up the whip button: the right moment, inside the whip window only (never from the gate).</summary>
        public bool WhipChance;
        /// <summary>The horse is in another horse's slipstream (REQ-RACE-042): wind lines + "脚をためている".</summary>
        public bool Slipstream;
        /// <summary>Pulling and not reined: show "掛かっている：手綱を長押し".</summary>
        public bool KakariWarning;
        /// <summary>Running too fast for the distance left (before the final stretch).</summary>
        public bool RunawayWarning;
        /// <summary>The last whip was mashed (diminished): show "間をあけて" briefly.</summary>
        public bool WhipMashed;
        /// <summary>Distance to the nearest horse ahead / behind (any lane), mm; -1 when there is none.</summary>
        public long GapAheadMm = -1, GapBehindMm = -1;
        /// <summary>The single most important line to show now (null = none). Same order as the cue priorities.</summary>
        public string Hint;
    }

    /// <summary>Stateless race-feel helpers (shared by the HUD tracker, the debrief and tests).</summary>
    public static class RaceFeel
    {
        public const int StaminaLowPermille = 300;
        public const int StaminaCriticalPermille = 100;
        /// <summary>The whip cue stays on for this many metres after the window opens.</summary>
        public const int WhipChanceWindowM = 100;
        /// <summary>Normal races: the cue opens at min(spurt zone, this) — the same mark CPUs start whipping by default.</summary>
        public const int WhipChanceFromM = 400;
        /// <summary>Runaway: stamina‰ below the share of the race left (‰) by more than this.</summary>
        public const int RunawayMarginPermille = 100;
        /// <summary>1 馬身 ≈ 2.4 m.</summary>
        public const int LengthMm = 2400;

        public const string TextStaminaLow = "脚が残り少ない";
        public const string TextStaminaCritical = "脚がもうない！";
        public const string TextStaminaEmpty = "脚が上がった";
        public const string TextWhipChance = "今だ、ムチ！";
        public const string TextKakari = "掛かっている：手綱を長押し";
        public const string TextRunaway = "飛ばしすぎ：手綱で脚をためよう";
        public const string TextWhipMash = "連打は効きが落ちる：間をあけて";
        public const string TextSlipstream = "脚をためている";

        public static StaminaWarning StaminaLevel(int staminaPermille, long staminaRaw)
        {
            if (staminaRaw <= 0) return StaminaWarning.Empty;
            if (staminaPermille <= StaminaCriticalPermille) return StaminaWarning.Critical;
            if (staminaPermille <= StaminaLowPermille) return StaminaWarning.Low;
            return StaminaWarning.None;
        }

        public static StaminaWarning StaminaLevel(HorseState h) => StaminaLevel(h.StaminaPermille, h.Stamina.Raw);

        /// <summary>
        /// Was <paramref name="slot"/> in a slipstream on the tick just simulated? Mirrors RaceSim's check exactly
        /// (pre-step positions: another departed, unfinished horse within half a lane, 0 &lt; gap ≤ slipstreamRange).
        /// </summary>
        public static bool InSlipstream(RaceSim sim, int slot)
        {
            if (sim == null || slot < 0 || slot >= sim.EntrantCount || sim.Tick == 0) return false;
            var cur = sim.GetHorse(slot);
            if (!cur.Departed || cur.Finished) return false;
            var me = sim.GetPreviousHorse(slot);
            if (!me.Departed) return false;
            Fx half = Fx.FromRatio(1, 2), range = Fx.FromMilli(sim.P.SlipstreamRangeMm);
            for (int j = 0; j < sim.EntrantCount; j++)
            {
                if (j == slot) continue;
                var o = sim.GetPreviousHorse(j);
                if (o.Finished || !o.Departed) continue;
                if ((o.Lane - me.Lane).Abs() > half) continue;
                Fx gap = o.Distance - me.Distance;
                if (gap.Raw > 0 && gap <= range) return true;
            }
            return false;
        }

        /// <summary>Remaining metres at which the whip cue opens: 300 m in the tutorial (REQ-UXS-004), else min(spurt zone, 400 m).</summary>
        public static int WhipChanceStartM(RaceSim sim)
        {
            if (sim.Config.Mode == RaceMode.Tutorial) return TutorialDirector.WhipWindowM;
            return Math.Min(sim.SpurtZoneM, Math.Min(WhipChanceFromM, sim.Config.Track.DistanceM));
        }

        public static long RemainingMm(RaceSim sim, HorseState h) => Math.Max(0, (sim.Track.Distance - h.Distance).ToMilli());

        /// <summary>Is the horse inside the whip window (stateless: ignores whether it already whipped)?</summary>
        public static bool InWhipWindow(RaceSim sim, int slot)
        {
            var h = sim.GetHorse(slot);
            if (!h.Departed || h.Finished || h.WhipsLeft <= 0) return false;
            long rem = RemainingMm(sim, h);
            long from = WhipChanceStartM(sim) * 1000L;
            return rem <= from && rem > from - WhipChanceWindowM * 1000L;
        }

        /// <summary>Burning stamina faster than the distance left allows, before the spurt zone and not reined.</summary>
        public static bool IsRunaway(RaceSim sim, int slot)
        {
            var h = sim.GetHorse(slot);
            if (!h.Departed || h.Finished || h.Reining || h.InSpurt) return false;
            long remPermille = sim.Track.Distance.Raw <= 0 ? 0 : (sim.Track.Distance - h.Distance).Raw * 1000 / sim.Track.Distance.Raw;
            return h.StaminaPermille + RunawayMarginPermille < remPermille;
        }

        /// <summary>Nearest horse ahead and behind by distance along the course (any lane), mm (-1 = none).</summary>
        public static (long aheadMm, long behindMm) Gaps(RaceSim sim, int slot)
        {
            var me = sim.GetHorse(slot);
            long ahead = -1, behind = -1;
            for (int j = 0; j < sim.EntrantCount; j++)
            {
                if (j == slot) continue;
                long d = (sim.GetHorse(j).Distance - me.Distance).ToMilli();
                if (d > 0) { if (ahead < 0 || d < ahead) ahead = d; }
                else if (d < 0) { if (behind < 0 || -d < behind) behind = -d; }
                else { ahead = 0; }
            }
            return (ahead, behind);
        }

        /// <summary>A margin in Japanese racing terms (ハナ / アタマ / クビ / 1/2馬身 … 大差).</summary>
        public static string MarginText(long mm)
        {
            if (mm < 0) mm = -mm;
            if (mm < 200) return "ハナ";
            if (mm < 450) return "アタマ";
            if (mm < 800) return "クビ";
            if (mm < 1500) return "1/2馬身";
            if (mm < 2100) return "3/4馬身";
            long quarters = (mm * 4 + LengthMm / 2) / LengthMm; // nearest 1/4 length
            if (quarters > 40) return "大差";
            long whole = quarters / 4, rest = quarters % 4;
            if (whole >= 3) return whole + (rest >= 2 ? "馬身半" : "馬身");
            return whole + "馬身" + (rest == 0 ? "" : rest == 1 ? "1/4" : rest == 2 ? "半" : "3/4");
        }
    }

    /// <summary>
    /// Follows the player's horse tick by tick and turns the engine state into HUD race-feel data (06 §6.3):
    /// stamina thresholds, the one-time whip cue, slipstream, kakari / runaway warnings, mashing, overtakes.
    /// Call <see cref="Update"/> once per frame (or per tick: <c>OfflineRace.Stepped</c>) after the sim advanced;
    /// several ticks per call are fine. Presentation only — it never feeds back into the simulation.
    /// </summary>
    public sealed class RaceFeelTracker
    {
        private readonly int _slot;
        private readonly List<RaceFeelCue> _cues = new List<RaceFeelCue>();
        private readonly List<RaceFeelCue> _new = new List<RaceFeelCue>();
        private int _lastTick = -1, _eventIndex, _lastRank = -1, _lastWhipTick = -100000, _mashTick = -100000;
        private StaminaWarning _stamina;
        private bool _slip, _chanceShown, _chanceOver, _kakariShown, _runawayShown, _mashShown;
        private int _chanceOpenTick = -1;

        public int Slot => _slot;
        public RaceFeelSnapshot Current { get; private set; } = new RaceFeelSnapshot();
        /// <summary>Every cue so far, in order.</summary>
        public IReadOnlyList<RaceFeelCue> Cues => _cues;
        /// <summary>Cues raised by the last <see cref="Update"/> call.</summary>
        public IReadOnlyList<RaceFeelCue> NewCues => _new;
        /// <summary>Show the "間をあけて" hint for this many ticks after a mashed whip.</summary>
        public int MashHintTicks { get; set; } = 30;

        public RaceFeelTracker(int playerSlot) { _slot = playerSlot; }

        public RaceFeelSnapshot Update(RaceSim sim)
        {
            if (sim == null || _slot < 0 || _slot >= sim.EntrantCount) return Current;
            if (sim.Tick == _lastTick) { _new.Clear(); return Current; }
            _new.Clear();
            int t = sim.Tick - 1; // the tick just simulated
            var h = sim.GetHorse(_slot);
            var p = sim.P;

            // whips (exact, from events): mashing = a whip inside the previous whip's diminish window
            var events = sim.Events;
            for (; _eventIndex < events.Count; _eventIndex++)
            {
                var e = events[_eventIndex];
                if (e.Slot != _slot || e.Type != RaceEventType.Whip) continue;
                if (e.Tick - _lastWhipTick < p.WhipDiminishWindowTicks)
                {
                    _mashTick = e.Tick;
                    if (!_mashShown) { _mashShown = true; Raise(e.Tick, RaceFeelCueKind.WhipMash, RaceFeel.TextWhipMash); }
                }
                _lastWhipTick = e.Tick;
                if (_chanceOpenTick >= 0) _chanceOver = true; // the cue has done its job
            }

            // stamina thresholds, each raised once on the way down
            var level = RaceFeel.StaminaLevel(h);
            if (h.Departed && level > _stamina)
            {
                for (var l = _stamina + 1; l <= level; l++)
                {
                    if (l == StaminaWarning.Low) Raise(t, RaceFeelCueKind.StaminaLow, RaceFeel.TextStaminaLow);
                    else if (l == StaminaWarning.Critical) Raise(t, RaceFeelCueKind.StaminaCritical, RaceFeel.TextStaminaCritical);
                    else if (l == StaminaWarning.Empty) Raise(t, RaceFeelCueKind.StaminaEmpty, RaceFeel.TextStaminaEmpty);
                }
                _stamina = level;
            }

            // whip cue: once, when the window opens; off after a whip or once the window has passed
            bool inWindow = RaceFeel.InWhipWindow(sim, _slot);
            if (inWindow && !_chanceShown)
            {
                _chanceShown = true;
                _chanceOpenTick = t;
                Raise(t, RaceFeelCueKind.WhipChance, RaceFeel.TextWhipChance);
            }
            if (_chanceShown && !inWindow) _chanceOver = true;
            bool chance = _chanceShown && !_chanceOver && inWindow;

            bool slip = RaceFeel.InSlipstream(sim, _slot);
            if (slip != _slip) { Raise(t, slip ? RaceFeelCueKind.SlipstreamOn : RaceFeelCueKind.SlipstreamOff, null); _slip = slip; }

            bool kakari = h.IsKakari && !h.Reining && !h.Finished;
            if (kakari && !_kakariShown) { _kakariShown = true; Raise(t, RaceFeelCueKind.Kakari, RaceFeel.TextKakari); }
            bool runaway = RaceFeel.IsRunaway(sim, _slot) && !kakari;
            if (runaway && !_runawayShown) { _runawayShown = true; Raise(t, RaceFeelCueKind.Runaway, RaceFeel.TextRunaway); }

            if (h.Departed && !h.Finished && _lastRank >= 0 && h.Rank < _lastRank) Raise(t, RaceFeelCueKind.Overtake, null);
            _lastRank = h.Rank;

            var gaps = RaceFeel.Gaps(sim, _slot);
            bool mashed = t - _mashTick < MashHintTicks;
            var s = new RaceFeelSnapshot
            {
                Tick = sim.Tick,
                StaminaPermille = h.StaminaPermille,
                Stamina = h.Departed ? level : StaminaWarning.None,
                StaminaBlink = h.Departed && level == StaminaWarning.Critical,
                WhipChance = chance,
                Slipstream = slip,
                KakariWarning = kakari,
                RunawayWarning = runaway,
                WhipMashed = mashed,
                GapAheadMm = gaps.aheadMm,
                GapBehindMm = gaps.behindMm,
            };
            s.Hint = h.Finished ? null
                : kakari ? RaceFeel.TextKakari
                : s.Stamina == StaminaWarning.Empty ? RaceFeel.TextStaminaEmpty
                : chance ? RaceFeel.TextWhipChance
                : mashed ? RaceFeel.TextWhipMash
                : s.Stamina == StaminaWarning.Critical ? RaceFeel.TextStaminaCritical
                : runaway ? RaceFeel.TextRunaway
                : slip ? RaceFeel.TextSlipstream
                : null;
            Current = s;
            _lastTick = sim.Tick;
            return s;
        }

        private void Raise(int tick, RaceFeelCueKind kind, string text)
        {
            var c = new RaceFeelCue(tick, kind, text);
            _cues.Add(c);
            _new.Add(c);
        }
    }
}
