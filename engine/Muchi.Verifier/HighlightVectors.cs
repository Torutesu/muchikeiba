using System.Text;
using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Verifier
{
    /// <summary>
    /// REQ-HL-001 (§72): the verifier's side of the shared highlight vectors. For every top-level golden replay
    /// (contracts/golden/race-*.json) and focus slots -1, 0 and the last slot, re-simulates the log and runs the same
    /// HighlightDetector the devices run. `Render` regenerates contracts/highlights.vectors.json, `Check` compares.
    /// </summary>
    public static class HighlightVectors
    {
        public static List<(string golden, int focus, string hash, JsonNode expected)> Compute(string goldenDir)
        {
            var o = new List<(string, int, string, JsonNode)>();
            foreach (var path in Directory.GetFiles(goldenDir, "race-*.json").OrderBy(p => Path.GetFileName(p), StringComparer.Ordinal))
            {
                var log = ProtocolCodec.ParseReplayLog(JsonNode.Parse(File.ReadAllText(path)).Get("log"));
                int n = log.Config.Entrants.Count;
                var hash = RaceReplay.Run(log.Config, log.Inputs).Result.Hash;
                foreach (int focus in new[] { -1, 0, n - 1 }.Distinct())
                    o.Add((Path.GetFileName(path), focus, hash, HighlightJson.ToJson(HighlightDetector.Detect(log.Config, log.Inputs, focus, hash))));
            }
            return o;
        }

        public static string Render(List<(string golden, int focus, string hash, JsonNode expected)> cases)
        {
            var sb = new StringBuilder();
            sb.Append("{\n \"_note\": \"REQ-HL-001 (contracts/protocol.md §72): highlight detection v").Append(HighlightRules.Version)
              .Append(" on the golden replays. Regenerate: dotnet run --project engine/Muchi.Verifier -- highlights contracts/golden contracts/highlights.vectors.json write\",\n");
            sb.Append(" \"version\": ").Append(HighlightRules.Version).Append(",\n \"cases\": [\n");
            for (int i = 0; i < cases.Count; i++)
            {
                var c = cases[i];
                var row = JsonNode.Obj().Set("golden", c.golden).Set("focusSlot", c.focus).Set("resultHash", c.hash).Set("expected", c.expected);
                sb.Append("  ").Append(row.ToString()).Append(i + 1 < cases.Count ? ",\n" : "\n");
            }
            sb.Append(" ]\n}\n");
            return sb.ToString();
        }

        /// <summary>Mismatches between the vectors file and a fresh computation (empty = identical).</summary>
        public static List<string> Check(string goldenDir, string vectorsPath)
        {
            var problems = new List<string>();
            var doc = JsonNode.Parse(File.ReadAllText(vectorsPath));
            var fresh = Compute(goldenDir).ToDictionary(c => c.golden + "#" + c.focus);
            var seen = new HashSet<string>();
            foreach (var row in doc.Get("cases").Items)
            {
                string key = row.Get("golden").AsString() + "#" + row.Get("focusSlot").AsInt();
                seen.Add(key);
                if (!fresh.TryGetValue(key, out var f)) { problems.Add(key + ": no such golden"); continue; }
                if (f.hash != row.Get("resultHash").AsString()) problems.Add(key + ": result hash differs (the golden changed)");
                string want = HighlightJson.ToJson(HighlightJson.Parse(row.Get("expected"))).ToString(), got = f.expected.ToString();
                if (want != got) problems.Add(key + ": expected " + want + " got " + got);
            }
            foreach (var k in fresh.Keys) if (!seen.Contains(k)) problems.Add(k + ": missing from the vectors");
            return problems;
        }
    }
}
