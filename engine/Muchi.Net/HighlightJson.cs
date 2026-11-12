using Muchi.Engine;

namespace Muchi.Net
{
    /// <summary>REQ-HL-001 (§72.2 item 4): the JSON form of a highlight set (shared vectors, the verifier, the prototype).</summary>
    public static class HighlightJson
    {
        public static JsonNode Moment(HighlightMoment m) => JsonNode.Obj().Set("rank", m.Rank).Set("kind", m.Kind).Set("startTick", m.StartTick).Set("endTick", m.EndTick)
            .Set("keyTick", m.KeyTick).Set("slot", m.Slot).Set("slot2", m.Slot2).Set("value", m.Value).Set("remainingM", m.RemainingM).Set("place", m.Place).Set("score", m.Score);

        public static JsonNode ToJson(HighlightSet s)
        {
            var arr = JsonNode.Arr();
            foreach (var m in s.Moments) arr.Add(Moment(m));
            return JsonNode.Obj().Set("version", s.Version).Set("focusSlot", s.FocusSlot).Set("endTick", s.EndTick).Set("totalTicks", s.TotalTicks).Set("moments", arr);
        }

        private static int I(JsonNode o, string k, int d = 0) => o.TryGet(k, out var v) && !v.IsNull ? v.AsInt() : d;

        public static HighlightSet Parse(JsonNode o, int tickHz = 20)
        {
            var s = new HighlightSet { Version = I(o, "version"), FocusSlot = I(o, "focusSlot", -1), EndTick = I(o, "endTick"), TickHz = tickHz };
            if (o.TryGet("moments", out var arr) && !arr.IsNull)
                foreach (var m in arr.Items)
                    s.Moments.Add(new HighlightMoment
                    {
                        Rank = I(m, "rank"), Kind = m.Get("kind").AsString(), StartTick = I(m, "startTick"), EndTick = I(m, "endTick"), KeyTick = I(m, "keyTick"),
                        Slot = I(m, "slot"), Slot2 = I(m, "slot2", -1), Value = I(m, "value"), RemainingM = I(m, "remainingM"), Place = I(m, "place"), Score = I(m, "score"),
                    });
            return s;
        }
    }
}
