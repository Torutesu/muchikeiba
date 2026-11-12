using System;
using Muchi.Client;
using Muchi.Engine;

namespace Muchi.Game
{
    /// <summary>
    /// Turns the race screen's controls into engine input bytes (contracts/protocol.md §3).
    /// - Lane arrows are in screen terms (left/right as seen from the chase camera). On a left-handed course
    ///   the inside rail is on the left, so "left" = LANE_IN; right-handed courses mirror that.
    /// - SPUR is START until the horse has left the gate, WHIP afterwards (the engine ignores a START before
    ///   the gate opens, so an early tap costs nothing).
    /// - REIN is a hold: only the press/release edges are sent (REIN_PRESS / REIN_RELEASE).
    /// Call <see cref="Collect"/> once per frame and pass the byte to the race driver (0 = nothing to send).
    /// </summary>
    public sealed class RaceInput
    {
        private int _lane;
        private bool _spur;
        private bool _reinHeld, _reinSent;

        /// <summary>Course direction (RaceVisuals.Track.LeftHanded; tutorial and practice courses are left-handed).</summary>
        public bool LeftHanded = true;

        /// <summary>
        /// REQ-A11Y-012: Tap (default) or Hold (AccessibilityModel.ApplyTo sets it). With Hold, the whip button reports
        /// its state through <see cref="SetWhipHeld"/> and <see cref="Collect(RaceSim, int)"/> turns it into taps
        /// (<see cref="WhipHold"/>: the press is a tap, a few spaced whips while held). Taps (<see cref="Spur"/>) still work.
        /// </summary>
        public WhipInput WhipMode = WhipInput.Tap;
        private bool _whipHeld;
        private readonly WhipHold _hold = new WhipHold();
        public void SetWhipHeld(bool held) => _whipHeld = held;
        public bool WhipHeld => _whipHeld;
        /// <summary>Automatic whips the hold may still give this race (for the 「長押し あと{n}」 hint).</summary>
        public int HoldRepeatsLeft(RulesetParams p) => Math.Max(0, WhipHold.MaxRepeats(p) - _hold.Repeats);

        /// <summary>
        /// Per frame with the race state (preferred): the same as <see cref="Collect(HorseState)"/> plus the whip hold.
        /// </summary>
        public byte Collect(RaceSim sim, int slot)
        {
            if (sim == null || slot < 0 || slot >= sim.EntrantCount) return 0;
            var me = sim.GetHorse(slot);
            byte c = Collect(me);
            if (WhipMode == WhipInput.Hold) c |= _hold.Next(sim, slot, _whipHeld);
            else if (_spurReleased && sim.TacticsEnabled && me.Departed && !me.InSpurt)
            {
                // ruleset 1.4 (tap mode): letting go of the whip button before the go is the release of the hold (START =
                // WHIP_RELEASE after departure). Sent whenever the horse has not gone: with the input delay the hold may
                // not be simulated yet, and the engine ignores a release with no hold.
                c |= Cmd.Start;
            }
            _spurReleased = false;
            return c;
        }

        /// <summary>
        /// Ruleset 1.4: the whip button was let go (pointer up / cancel). Before the go this releases the hold (溜め → 仕掛け);
        /// afterwards it does nothing. Call it from the button's release in tap mode (hold mode reports through SetWhipHeld).
        /// </summary>
        public void SpurRelease() => _spurReleased = true;
        private bool _spurReleased;

        /// <summary>-1 = screen left, +1 = screen right. Taps accumulate until the next Collect (one lane per frame).</summary>
        public void Lane(int screenDirection) { if (screenDirection != 0) _lane = Math.Sign(screenDirection); }
        public void Spur() => _spur = true;
        public void SetRein(bool held) => _reinHeld = held;
        public bool ReinHeld => _reinHeld;

        /// <summary>Label for the SPUR button: START before departure, SPUR after.</summary>
        public static bool SpurIsStart(HorseState me) => !me.Departed;

        public byte Collect(HorseState me)
        {
            byte c = 0;
            if (_lane != 0)
            {
                bool towardInside = LeftHanded ? _lane < 0 : _lane > 0;
                c |= towardInside ? Cmd.LaneIn : Cmd.LaneOut;
                _lane = 0;
            }
            if (_spur)
            {
                c |= me.Departed ? Cmd.Whip : Cmd.Start;
                _spur = false;
            }
            if (_reinHeld != _reinSent)
            {
                c |= _reinHeld ? Cmd.ReinPress : Cmd.ReinRelease;
                _reinSent = _reinHeld;
            }
            return c;
        }

        public void Reset()
        {
            _lane = 0; _spur = false; _reinHeld = false; _reinSent = false; _whipHeld = false; _spurReleased = false; _hold.Reset();
        }
    }
}
