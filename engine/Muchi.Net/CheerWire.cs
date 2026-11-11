using System;
using System.Collections.Generic;

namespace Muchi.Net
{
    /// <summary>
    /// 観戦中の応援 (REQ-CHEER-003, contracts/protocol.md §55.2): what a spectator's <c>start.spectator.cheer</c> offers. Null on
    /// <see cref="LockstepClient.CheerOffer"/> = the room takes no cheers (an older server, cheers turned off, or not a spectator).
    /// </summary>
    public sealed class CheerOffer
    {
        public readonly List<string> Kinds = new List<string>();
        public int MinIntervalMs = 2000;
        public int WindowMs = 1000;

        internal static CheerOffer Parse(JsonNode o)
        {
            if (o == null || o.Kind != JsonKind.Object) return null;
            var c = new CheerOffer();
            if (o.TryGet("kinds", out var ks) && ks.Kind == JsonKind.Array)
                for (int i = 0; i < ks.Count; i++) if (ks[i].Kind == JsonKind.String) c.Kinds.Add(ks[i].AsString());
            if (o.TryGet("minIntervalMs", out var mi) && mi.Kind == JsonKind.Number) c.MinIntervalMs = Math.Max(0, mi.AsInt());
            if (o.TryGet("windowMs", out var w) && w.Kind == JsonKind.Number) c.WindowMs = Math.Max(0, w.AsInt());
            return c.Kinds.Count == 0 ? null : c;
        }
    }

    /// <summary>One row of a <c>cheers</c> window (REQ-CHEER-005): how many of one cheer a horse got. No sender ids exist on the wire.</summary>
    public struct CheerCount
    {
        public int Slot;
        public string Kind;
        public int Count;
        public CheerCount(int slot, string kind, int count) { Slot = slot; Kind = kind; Count = count; }
    }
}
