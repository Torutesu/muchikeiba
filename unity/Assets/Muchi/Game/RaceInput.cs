using System;
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
            _lane = 0; _spur = false; _reinHeld = false; _reinSent = false;
        }
    }
}
