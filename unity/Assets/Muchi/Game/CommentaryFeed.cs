using System.Collections.Generic;
using Muchi.Client;
using Muchi.Engine;

namespace Muchi.Game
{
    /// <summary>
    /// Runs the SDK commentator against the race sim and keeps the subtitle that should be on screen.
    /// Voice: each line carries clip keys (AssetKeys.VoiceClip) for pre-generated audio — exposed via
    /// <see cref="NewLines"/> so an audio player can be added later without touching the race screen.
    /// </summary>
    public sealed class CommentaryFeed
    {
        private readonly Commentator _commentator;
        private CommentaryLine _current;
        public readonly List<CommentaryLine> NewLines = new List<CommentaryLine>();

        public CommentaryFeed(CommentaryTemplates templates, RaceConfig config, int focusSlot)
        {
            _commentator = templates == null || config == null ? null : new Commentator(templates, config, focusSlot);
        }

        /// <summary>Call once per frame after the driver updated. Returns the subtitle text (empty = none).</summary>
        public string Update(RaceSim sim)
        {
            NewLines.Clear();
            if (_commentator == null || sim == null) return "";
            var lines = _commentator.Process(sim);
            if (lines != null && lines.Count > 0)
            {
                NewLines.AddRange(lines);
                _current = lines[lines.Count - 1];
            }
            if (_current != null && !_current.Interrupted && sim.Tick <= _current.Tick + _current.DurationTicks + 20) return _current.Text;
            return "";
        }
    }
}
