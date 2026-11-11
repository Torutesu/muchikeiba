using System;
using System.Collections.Generic;
using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Client
{
    // 観戦中の応援 (REQ-CHEER-001..016, contracts/protocol.md §55): the client half. Spectators send preset cheers through
    // LockstepClient.SendCheer (CheerThrottle keeps the 2 s pace the room enforces); every socket gets at most one `cheers`
    // window a second (LockstepClient.CheersReceived). Racers may show a quiet 「応援 ×n」 for their own horse (CheerIndicator),
    // spectators a short burst (CheerBurst). None of it reaches the simulation, the inputs or the result. Nothing is sold.

    /// <summary>The preset cheers (§55.1). Japanese labels here; English through Loc (ui-en.json), the same table as the server's CHEER_TEXT.</summary>
    public static class CheerKinds
    {
        public const string Go = "go";
        public const string Close = "close";
        public const string Hold = "hold";
        public static readonly string[] All = { Go, Close, Hold };

        public const string LabelGo = "いけ！";
        public const string LabelClose = "差せ！";
        public const string LabelHold = "粘れ！";

        public static bool Known(string kind) => Array.IndexOf(All, kind) >= 0;

        /// <summary>The Japanese label of a kind (null for an unknown kind: draw nothing).</summary>
        public static string Label(string kind)
        {
            switch (kind)
            {
                case Go: return LabelGo;
                case Close: return LabelClose;
                case Hold: return LabelHold;
                default: return null;
            }
        }

        /// <summary>The KPI / wire mode name of a race (null = a mode nobody watches, so no cheers).</summary>
        public static string ModeName(RaceMode mode)
        {
            switch (mode)
            {
                case RaceMode.Friend: return "friend";
                case RaceMode.Cup: return "cup";
                case RaceMode.Ranked: return "ranked";
                case RaceMode.Event: return "event";
                case RaceMode.Tournament: return "tournament";
                default: return null;
            }
        }
    }

    /// <summary>
    /// REQ-CHEER-004: one cheer every <see cref="MinIntervalMs"/> (the room's own limit, from start.spectator.cheer). The buttons
    /// grey out until <see cref="RemainingMs"/> is 0, so a tap never turns into a refusal from the room.
    /// </summary>
    public sealed class CheerThrottle
    {
        public int MinIntervalMs { get; }
        private long _lastAt = long.MinValue;
        public CheerThrottle(int minIntervalMs = 2000) { MinIntervalMs = Math.Max(0, minIntervalMs); }
        public bool CanSend(long nowMs) => RemainingMs(nowMs) == 0;
        /// <summary>A clock that went back never locks the buttons (same rule as the room).</summary>
        public long RemainingMs(long nowMs) => _lastAt == long.MinValue || nowMs < _lastAt ? 0 : Math.Max(0, _lastAt + MinIntervalMs - nowMs);
        public void Mark(long nowMs) => _lastAt = nowMs;
    }

    /// <summary>
    /// REQ-CHEER-007/010: the racer's quiet indicator for their own horse — 「応援 ×n」 (n = cheers this race), shown for
    /// <see cref="VisibleMs"/> after the last window, never over the controls, and only when the player left it on. A soft
    /// pulse may play per window unless motion is reduced (§41) or the flash limiter refuses (≤ 3 a second, WCAG 2.3.1).
    /// </summary>
    public sealed class CheerIndicator
    {
        public const string TextFormat = "応援 ×{n}";
        public const int VisibleMs = 4000;

        private readonly FlashLimiter _flash = new FlashLimiter();
        private long _lastAt = long.MinValue;

        public bool On { get; set; } = true;
        public bool ReduceMotion { get; set; }
        /// <summary>Cheers for our horse this race (counted even while hidden, so turning it on shows the right number).</summary>
        public int Total { get; private set; }
        /// <summary>Cheers for our horse that were on screen (the cheer_seen count).</summary>
        public int Seen { get; private set; }
        /// <summary>True when the last window should play the soft pulse (false with reduced motion or past the flash limit).</summary>
        public bool Pulse { get; private set; }

        /// <summary>A window arrived. Returns how many were for <paramref name="mySlot"/>.</summary>
        public int OnCheers(IReadOnlyList<CheerCount> counts, int mySlot, long nowMs)
        {
            int n = 0;
            if (counts != null) foreach (var c in counts) if (c.Slot == mySlot && c.Count > 0) n += c.Count;
            Pulse = false;
            if (n == 0) return 0;
            Total += n;
            _lastAt = nowMs;
            if (On)
            {
                Seen += n;
                Pulse = !ReduceMotion && _flash.TryFlash(nowMs);
            }
            return n;
        }

        public bool Visible(long nowMs) => On && Total > 0 && _lastAt != long.MinValue && nowMs >= _lastAt && nowMs - _lastAt < VisibleMs;
        public string Text => TextFormat.Replace("{n}", Total.ToString());

        public void Reset() { Total = 0; Seen = 0; Pulse = false; _lastAt = long.MinValue; _flash.Reset(); }
    }

    /// <summary>One line of the spectator burst: a horse, a cheer, how many in the last window.</summary>
    public sealed class CheerBurstLine
    {
        public int Slot;
        public string Kind, Label;
        public int Count;
    }

    /// <summary>
    /// REQ-CHEER-007: what spectators see — the last window as a few lines (largest first, at most <see cref="MaxLines"/>), and
    /// race totals per horse. Same motion and flash rules as <see cref="CheerIndicator"/>.
    /// </summary>
    public sealed class CheerBurst
    {
        public const int MaxLines = 3;
        public const int VisibleMs = 2500;
        private readonly FlashLimiter _flash = new FlashLimiter();
        private readonly Dictionary<int, int> _perSlot = new Dictionary<int, int>();
        private long _lastAt = long.MinValue;

        public bool ReduceMotion { get; set; }
        public List<CheerBurstLine> Lines { get; } = new List<CheerBurstLine>();
        public int Total { get; private set; }
        public bool Pulse { get; private set; }

        public void OnCheers(IReadOnlyList<CheerCount> counts, long nowMs)
        {
            Lines.Clear();
            Pulse = false;
            if (counts == null) return;
            var rows = new List<CheerCount>();
            foreach (var c in counts)
            {
                if (c.Count <= 0 || !CheerKinds.Known(c.Kind)) continue;
                rows.Add(c);
                Total += c.Count;
                _perSlot[c.Slot] = TotalFor(c.Slot) + c.Count;
            }
            if (rows.Count == 0) return;
            rows.Sort((a, b) => b.Count != a.Count ? b.Count.CompareTo(a.Count) : a.Slot != b.Slot ? a.Slot.CompareTo(b.Slot) : Array.IndexOf(CheerKinds.All, a.Kind).CompareTo(Array.IndexOf(CheerKinds.All, b.Kind)));
            for (int i = 0; i < rows.Count && i < MaxLines; i++) Lines.Add(new CheerBurstLine { Slot = rows[i].Slot, Kind = rows[i].Kind, Label = CheerKinds.Label(rows[i].Kind), Count = rows[i].Count });
            _lastAt = nowMs;
            Pulse = !ReduceMotion && _flash.TryFlash(nowMs);
        }

        public int TotalFor(int slot) => _perSlot.TryGetValue(slot, out var n) ? n : 0;
        public bool Visible(long nowMs) => Lines.Count > 0 && _lastAt != long.MinValue && nowMs >= _lastAt && nowMs - _lastAt < VisibleMs;
    }

    /// <summary>
    /// REQ-CHEER-013: the KPI rows of one race — <c>cheer_send</c> (cheers this spectator sent) and <c>cheer_seen</c> (cheers on
    /// screen), ONE of each per race at most, never one per tap. <see cref="Finish"/> returns them once; later calls return none.
    /// </summary>
    public sealed class CheerRaceTally
    {
        private bool _done;
        public int Sent { get; private set; }
        public int Seen { get; private set; }
        public void AddSent(int n = 1) { if (!_done && n > 0) Sent += n; }
        public void AddSeen(int n) { if (!_done && n > 0) Seen += n; }

        /// <param name="mode">CheerKinds.ModeName of the race (null = not a watchable mode: nothing).</param>
        /// <param name="role">"racer" or "spectator".</param>
        public List<AnalyticsEvent> Finish(long atMs, string mode, string role)
        {
            var out_ = new List<AnalyticsEvent>();
            if (_done) return out_;
            _done = true;
            if (mode == null) return out_;
            if (Sent > 0) out_.Add(AnalyticsEvent.CheerSend(atMs, mode, Sent));
            if (Seen > 0) out_.Add(AnalyticsEvent.CheerSeen(atMs, mode, role, Seen));
            return out_;
        }
    }

    /// <summary>REQ-CHEER-012: a 「応援の多かった瞬間」 marker of a replay (the bucket's first tick and its count). Optional data.</summary>
    public sealed class CheerMoment
    {
        public int Tick, Count;
        internal static CheerMoment Parse(JsonNode o) => new CheerMoment { Tick = J.Int(o, "tick"), Count = J.Int(o, "count") };

        /// <summary>Where to put the marker on a seek bar of <paramref name="endTick"/> ticks (0..1; clamped).</summary>
        public double Fraction(int endTick) => endTick <= 0 ? 0 : Math.Max(0, Math.Min(1, (double)Tick / endTick));
    }

    public sealed partial class AnalyticsEvent
    {
        private static readonly string[] CheerModes = { "friend", "cup", "ranked", "event", "tournament" };

        /// <summary>REQ-CHEER-013: cheers this spectator sent in one race (1..1000). One row per race.</summary>
        public static AnalyticsEvent CheerSend(long atMs, string mode, int count)
        {
            if (Array.IndexOf(CheerModes, mode) < 0) throw new ArgumentException("unknown cheer mode " + mode);
            return new AnalyticsEvent("cheer_send", atMs, JsonNode.Obj().Set("mode", mode).Set("count", Math.Max(1, Math.Min(count, 1000))));
        }

        /// <summary>REQ-CHEER-013: cheers shown to this player in one race (racer with the indicator on, or spectator). One row per race.</summary>
        public static AnalyticsEvent CheerSeen(long atMs, string mode, string role, int count)
        {
            if (Array.IndexOf(CheerModes, mode) < 0) throw new ArgumentException("unknown cheer mode " + mode);
            if (role != "racer" && role != "spectator") throw new ArgumentException("unknown cheer role " + role);
            return new AnalyticsEvent("cheer_seen", atMs, JsonNode.Obj().Set("mode", mode).Set("role", role).Set("count", Math.Max(1, Math.Min(count, 100_000))));
        }
    }
}
