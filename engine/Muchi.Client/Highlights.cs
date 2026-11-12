using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Client
{
    // =====================================================================================================
    // レースの見どころ (REQ-HL-001..020, contracts/protocol.md §72).
    //
    // Detection is Muchi.Engine.HighlightDetector (pure, shared with the verifier). Nothing is stored: the list is computed
    // again whenever it is shown. HighlightReel plays the windows back to back on a ReplayPlayer (same re-simulation, hash
    // check and camera); HighlightCaptions / HighlightShare build the texts and the share card / link.
    // =====================================================================================================

    /// <summary>Detection for a playable saved replay (its own slot as the focus, the hash checked).</summary>
    public static class ReplayHighlights
    {
        public static HighlightSet Detect(ReplayPlayer player)
        {
            if (player == null) throw new ArgumentNullException(nameof(player));
            if (!player.Playable) throw new InvalidOperationException("replay is not playable: " + player.Reason);
            return HighlightDetector.Detect(player.Config, player.Data.Log.Inputs, player.OwnSlot, player.Data.ResultHash);
        }
    }

    /// <summary>REQ-HL-010: one caption per moment (Japanese source, English through <see cref="Loc"/>). Horse names only.</summary>
    public static class HighlightCaptions
    {
        /// <summary>The headline of a moment (no names; numbers from the moment).</summary>
        public static string Headline(HighlightMoment m, RaceConfig config)
        {
            switch (m.Kind)
            {
                case HighlightKinds.PhotoFinish: return "ゴール前、写真判定の大接戦";
                case HighlightKinds.NearMiss: return "ゴール前、わずかな差の競り合い";
                case HighlightKinds.LeadChange: return "残り" + m.Value + "mで先頭が替わる";
                case HighlightKinds.WhipBurst:
                    return (InFinalStraight(m, config) ? "最後の直線で" : "ムチ一閃、") + m.Value + "頭抜き";
                case HighlightKinds.Comeback: return m.Value + "番手から追い込んで" + m.Place + "着";
                case HighlightKinds.UniqueSkill: return "固有スキル発動";
                default: return "ゴールの瞬間";
            }
        }

        /// <summary>The subject line: the horse's name, 「（あなた）」 for the viewer's own horse. Never a player name.</summary>
        public static string Subject(HighlightMoment m, RaceConfig config, int focusSlot)
        {
            if (config == null || m.Slot < 0 || m.Slot >= config.Entrants.Count) return "";
            string name = config.Entrants[m.Slot].Horse?.Name ?? "";
            return m.Slot == focusSlot ? name + "（あなた）" : name;
        }

        /// <summary>The headline in the current locale.</summary>
        public static string Text(HighlightMoment m, RaceConfig config) => Loc.T(Headline(m, config));

        /// <summary>The subject was inside the final straight (the course's last straight segment) at the key tick.</summary>
        public static bool InFinalStraight(HighlightMoment m, RaceConfig config)
        {
            var segs = config?.Track?.Segments;
            if (segs == null || segs.Count == 0) return false;
            var last = segs[segs.Count - 1];
            return last.Kind == SegmentKind.Straight && m.RemainingM <= last.LengthM;
        }
    }

    /// <summary>
    /// REQ-HL-008/009: plays the moments back to back on a <see cref="ReplayPlayer"/> (1×, camera on each moment's subject).
    /// Advance it with wall time; <see cref="Next"/> jumps to the next moment, <see cref="Skip"/> ends the reel.
    /// </summary>
    public sealed class HighlightReel
    {
        private readonly int _msPerTick;
        public ReplayPlayer Player { get; }
        public HighlightSet Set { get; }
        public int Index { get; private set; }
        public bool Done { get; private set; }
        /// <summary>Reel time already played, ms (sum over finished windows plus the current one).</summary>
        public int ElapsedMs { get; private set; }
        public int TotalMs { get; }
        public HighlightMoment Current => Done || Index >= Set.Moments.Count ? null : Set.Moments[Index];
        /// <summary>Raised when a new moment starts (the view cuts the camera and shows the caption).</summary>
        public event Action<HighlightMoment> MomentStarted;

        public HighlightReel(ReplayPlayer player, HighlightSet set)
        {
            Player = player ?? throw new ArgumentNullException(nameof(player));
            Set = set ?? throw new ArgumentNullException(nameof(set));
            if (!player.Playable) throw new InvalidOperationException("replay is not playable: " + player.Reason);
            _msPerTick = 1000 / player.Config.Net.TickHz;
            TotalMs = set.TotalTicks * _msPerTick;
            player.SetSpeed(1.0);
            player.Paused = false;
            if (set.Moments.Count == 0) Done = true; else Enter(0);
        }

        /// <summary>Open the reel for a playable replay: detects (its own slot as the focus) and positions on the first moment.</summary>
        public static HighlightReel Open(ReplayPlayer player) => new HighlightReel(player, ReplayHighlights.Detect(player));

        private void Enter(int i)
        {
            Index = i;
            var m = Set.Moments[i];
            Player.SetCamera(Math.Max(0, Math.Min(Player.Config.Entrants.Count - 1, m.Slot)));
            Player.Seek(m.StartTick * _msPerTick);
            MomentStarted?.Invoke(m);
        }

        private int Played(HighlightMoment m) => Math.Max(0, Player.TimeMs - m.StartTick * _msPerTick);

        /// <summary>Advance by real milliseconds, crossing into the next windows as each one ends.</summary>
        public void Advance(double realMs)
        {
            if (Done || realMs <= 0) return;
            double left = realMs;
            while (!Done && left > 0)
            {
                var m = Current;
                int endMs = m.EndTick * _msPerTick;
                double room = endMs - Player.TimeMs;
                if (left < room) { Player.Advance(left); break; }
                Player.Seek(endMs);
                left -= Math.Max(0, room);
                Next();
            }
            Recount();
        }

        /// <summary>「次へ」: the next moment (the end after the last).</summary>
        public void Next()
        {
            if (Done) return;
            if (Index + 1 >= Set.Moments.Count) { Done = true; Recount(); return; }
            Enter(Index + 1);
            Recount();
        }

        /// <summary>「スキップ」: end the reel now.</summary>
        public void Skip() { Done = true; Recount(); }

        private void Recount()
        {
            int t = 0;
            for (int i = 0; i < Set.Moments.Count; i++)
            {
                var m = Set.Moments[i];
                if (Done || i < Index) t += m.DurationTicks * _msPerTick;
                else if (i == Index) t += Math.Min(m.DurationTicks * _msPerTick, Played(m));
            }
            ElapsedMs = Done ? TotalMs : t;
        }

        public ReplayPlayerFrame Frame() => Player.Frame();

        /// <summary>
        /// REQ-HL-010: the whole race's commentary with the given templates (the equipped §36 pack; the tutorial speaks the
        /// standard), re-simulated from the log. Pass the result to <see cref="LinesIn"/>.
        /// </summary>
        public static List<CommentaryLine> Commentary(CommentaryTemplates templates, RaceConfig config, IList<InputRecord> inputs, int focusSlot)
        {
            var com = new Commentator(templates, config, focusSlot);
            var sim = new RaceSim(config);
            int n = config.Entrants.Count;
            var byTick = new Dictionary<int, List<InputRecord>>();
            foreach (var r in inputs)
            {
                if (!byTick.TryGetValue(r.Tick, out var list)) byTick[r.Tick] = list = new List<InputRecord>();
                list.Add(r);
            }
            var cmds = new byte[n];
            var lines = new List<CommentaryLine>();
            while (!sim.IsFinished)
            {
                Array.Clear(cmds, 0, n);
                if (byTick.TryGetValue(sim.Tick, out var l)) foreach (var r in l) if (r.Slot >= 0 && r.Slot < n) cmds[r.Slot] |= r.Cmd;
                sim.Step(cmds);
                lines.AddRange(com.Process(sim));
            }
            return lines;
        }

        /// <summary>The commentary lines that start inside a moment's window (lines outside are not spoken).</summary>
        public static List<CommentaryLine> LinesIn(IList<CommentaryLine> lines, HighlightMoment m)
        {
            var o = new List<CommentaryLine>();
            if (lines == null || m == null) return o;
            foreach (var l in lines) if (l.Tick >= m.StartTick && l.Tick <= m.EndTick) o.Add(l);
            return o;
        }
    }

    /// <summary>REQ-HL-012/013: the share card and the §63 replay link target for the top moment.</summary>
    public static class HighlightShare
    {
        public const string CardKind = "highlight_image";
        public const int MaxStartTick = 72000;

        /// <summary>The replay share card (REQ-UXS-071, no names / ids) with the top moment's caption.</summary>
        public static ShareCard Card(ReplayPlayer player, HighlightSet set, string courseName = null)
        {
            if (player == null) throw new ArgumentNullException(nameof(player));
            var c = player.BuildShareCard(courseName);
            c.Kind = CardKind;
            var top = set?.Top;
            if (top != null)
            {
                string cap = HighlightCaptions.Headline(top, player.Config);
                c.Lines.Add(cap);
                c.ShareText = cap + "　" + c.ShareText;
            }
            return c;
        }

        /// <summary>The §63 `replay` link target: the race and the top moment's start tick (null when there is no moment).</summary>
        public static int? StartTick(HighlightSet set)
        {
            var top = set?.Top;
            return top == null ? (int?)null : Math.Max(0, Math.Min(MaxStartTick, top.StartTick));
        }

        /// <summary>Where a resolved link's replay should start, ms (its startTick clamped to the race; 0 without one).</summary>
        public static int StartTimeMs(ResolvedLink link, ReplayPlayer player)
        {
            if (player == null || !player.Playable) return 0;
            int? t = link?.StartTick;
            if (t == null) return 0;
            int tick = Math.Max(0, Math.Min(player.EndTick, t.Value));
            return tick * (1000 / player.Config.Net.TickHz);
        }
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-HL-013: a §63 replay link for an own public saved replay, opening at <paramref name="startTick"/> (the top moment).</summary>
        public Task<CreatedLink> CreateReplayLinkAsync(string raceId, int? startTick = null, CancellationToken ct = default)
        {
            var t = JsonNode.Obj().Set("raceId", raceId);
            if (startTick.HasValue) t.Set("startTick", Math.Max(0, Math.Min(HighlightShare.MaxStartTick, startTick.Value)));
            var b = JsonNode.Obj().Set("type", LinkTypes.Replay).Set("target", t);
            return Call("POST", "/v1/links", b, true, null, true, CreatedLink.Parse, ct);
        }
    }

    public sealed partial class AnalyticsEvent
    {
        public static readonly string[] HighlightSurfaces = { "result", "my_replays", "friend_replay", "link" };

        /// <summary>REQ-HL-015: the reel started (surface, the top moment's kind, how many moments). No race, player or tick.</summary>
        public static AnalyticsEvent HighlightView(long atMs, string surface, string topKind, int moments)
        {
            if (Array.IndexOf(HighlightSurfaces, surface) < 0) throw new ArgumentException("unknown surface");
            if (HighlightKinds.IndexOf(topKind) < 0) throw new ArgumentException("unknown kind");
            return new AnalyticsEvent("highlight_view", atMs, JsonNode.Obj().Set("surface", surface).Set("top", topKind).Set("moments", Math.Max(1, Math.Min(3, moments))));
        }

        /// <summary>REQ-HL-015: handed to the OS share sheet (card image or replay link).</summary>
        public static AnalyticsEvent HighlightShare(long atMs, string surface, bool link)
        {
            if (Array.IndexOf(HighlightSurfaces, surface) < 0) throw new ArgumentException("unknown surface");
            return new AnalyticsEvent("highlight_share", atMs, JsonNode.Obj().Set("surface", surface).Set("via", link ? "link" : "card"));
        }
    }
}
