using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Muchi.Engine;
using Muchi.Net;
using Muchi.Verifier;

namespace Muchi.Engine.Tests
{
    public class FxAndRngTests
    {
        [Fact]
        public void FixedPointArithmetic()
        {
            Assert.Equal(Fx.FromInt(6), Fx.FromInt(2) * Fx.FromInt(3));
            Assert.Equal(Fx.FromInt(2), Fx.FromInt(6) / Fx.FromInt(3));
            Assert.Equal(1500, Fx.FromMilli(1500).ToMilli());
            Assert.Equal(Fx.FromRatio(1, 2), Fx.FromInt(1).MulPermille(500));
            Assert.Equal("-1.500", Fx.FromMilli(-1500).ToString());
            Assert.True(Fx.FromInt(-1) < Fx.Zero);
            Assert.Equal(Fx.FromInt(3), Fx.Clamp(Fx.FromInt(9), Fx.Zero, Fx.FromInt(3)));
        }

        [Fact]
        public void Pcg32IsDeterministicAndStreamsDiffer()
        {
            var a = new Pcg32(123, 1);
            var b = new Pcg32(123, 1);
            var c = new Pcg32(123, 2);
            bool differs = false;
            for (int i = 0; i < 1000; i++)
            {
                uint x = a.NextUInt();
                Assert.Equal(x, b.NextUInt());
                if (x != c.NextUInt()) differs = true;
            }
            Assert.True(differs);
            var r = new Pcg32(5, 5);
            for (int i = 0; i < 10000; i++)
            {
                int v = r.Range(-3, 3);
                Assert.InRange(v, -3, 3);
            }
        }

        [Fact]
        public void Pcg32ReferenceValues()
        {
            // pinned values: any change to the generator changes every race, so it must be deliberate
            var r = new Pcg32(42, 54);
            var got = new uint[] { r.NextUInt(), r.NextUInt(), r.NextUInt() };
            Assert.Equal(new uint[] { 0xa15c02b7, 0x7b47f409, 0xba1d3330 }, got);
        }
    }

    public class NoFloatTests
    {
        private static readonly Regex Forbidden = new Regex(@"\b(float|double|decimal|Single|Double|Decimal|System\.Random|new Random|DateTime|Math\.Sqrt|Math\.Pow|MathF|Environment\.TickCount|Stopwatch)\b");

        [Theory]
        [InlineData("Muchi.Engine")]
        [InlineData("Muchi.Net")]
        public void SourceUsesNoFloatsOrNondeterministicApis(string project)
        {
            var dir = Path.Combine(TestUtil.RepoRoot, "engine", project);
            var files = Directory.GetFiles(dir, "*.cs", SearchOption.AllDirectories)
                .Where(f => !f.Contains(Path.DirectorySeparatorChar + "obj" + Path.DirectorySeparatorChar)
                         && !f.Contains(Path.DirectorySeparatorChar + "bin" + Path.DirectorySeparatorChar));
            var hits = new List<string>();
            foreach (var f in files)
            {
                int line = 0;
                foreach (var l in File.ReadAllLines(f))
                {
                    line++;
                    string code = l;
                    int comment = code.IndexOf("//", StringComparison.Ordinal);
                    if (comment >= 0) code = code.Substring(0, comment);
                    if (Forbidden.IsMatch(code)) hits.Add(Path.GetFileName(f) + ":" + line + ": " + l.Trim());
                }
            }
            Assert.True(hits.Count == 0, string.Join("\n", hits));
        }

        [Fact]
        public void EngineAssemblyHasNoFloatingPointMembers()
        {
            var asm = typeof(RaceSim).Assembly;
            var floatTypes = new[] { typeof(float), typeof(double), typeof(decimal) };
            var bad = new List<string>();
            const BindingFlags all = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
            foreach (var t in asm.GetTypes())
            {
                foreach (var f in t.GetFields(all)) if (floatTypes.Contains(f.FieldType)) bad.Add(t.Name + "." + f.Name);
                foreach (var m in t.GetMethods(all))
                {
                    if (floatTypes.Contains(m.ReturnType)) bad.Add(t.Name + "." + m.Name);
                    foreach (var p in m.GetParameters()) if (floatTypes.Contains(p.ParameterType)) bad.Add(t.Name + "." + m.Name + "(" + p.Name + ")");
                    var body = m.GetMethodBody();
                    if (body != null)
                        foreach (var lv in body.LocalVariables) if (floatTypes.Contains(lv.LocalType)) bad.Add(t.Name + "." + m.Name + " local");
                }
            }
            Assert.True(bad.Count == 0, string.Join("\n", bad));
        }
    }

    public class HashingTests
    {
        [Fact]
        public void ChecksumMatchesIndependentFnvImplementation()
        {
            var rs = TestUtil.Ruleset();
            var cfg = TestUtil.Cfg(SampleRaces.Turf2000(), rs, Enumerable.Range(0, 3).Select(i => TestUtil.H("c" + i)).ToList(), 0);
            var sim = new RaceSim(cfg);
            for (int i = 0; i < 300; i++) sim.Step(null);

            ulong h = 0xcbf29ce484222325UL;
            void Add(long v)
            {
                var bytes = BitConverter.GetBytes(v);
                if (!BitConverter.IsLittleEndian) Array.Reverse(bytes);
                foreach (var b in bytes) { h ^= b; h = unchecked(h * 0x100000001b3UL); }
            }
            for (int s = 0; s < 3; s++)
            {
                var x = sim.GetHorse(s);
                Add(x.Distance.Raw); Add(x.Lane.Raw); Add(x.Speed.Raw); Add(x.Stamina.Raw);
                Add(x.Composure); Add(x.WhipsLeft); Add(x.FinishTick);
            }
            Assert.Equal(h.ToString("x16"), sim.ComputeChecksum());
            Assert.Matches("^[0-9a-f]{16}$", sim.ComputeChecksum());
        }

        [Fact]
        public void ResultHashIsSha256OfCanonicalString()
        {
            var rs = TestUtil.Ruleset();
            var cfg = TestUtil.Cfg(SampleRaces.Turf1600(), rs, Enumerable.Range(0, 5).Select(i => TestUtil.H("r" + i, 400 + i * 50)).ToList(), 0);
            var outp = RaceReplay.Run(cfg, new List<InputRecord>());
            var r = outp.Result;
            Assert.StartsWith("v1|t_99|1.0.0|", r.CanonicalString);
            Assert.Matches(@"^v1\|t_99\|1\.0\.0\|(\d+:\d+:\d+)(;\d+:\d+:\d+){4}$", r.CanonicalString);
            string expected = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(r.CanonicalString))).ToLowerInvariant();
            Assert.Equal(expected, r.Hash);
            // entries are in finishing order and consistent with Order
            var entries = r.CanonicalString.Split('|')[3].Split(';');
            for (int p = 0; p < 5; p++) Assert.StartsWith(r.Order[p] + ":", entries[p]);
        }

        [Fact]
        public void UnfinishedHorsesUseMinusOneAndDistance()
        {
            var rs = TestUtil.Ruleset(("maxTicks", 400));
            var cfg = TestUtil.Cfg(SampleRaces.Turf2000(), rs, Enumerable.Range(0, 4).Select(i => TestUtil.H("u" + i)).ToList(), 0);
            var outp = RaceReplay.Run(cfg, new List<InputRecord>());
            Assert.All(outp.Result.FinishTicks, t => Assert.Equal(-1, t));
            Assert.Equal(399, outp.Result.EndTick);
            var entries = outp.Result.CanonicalString.Split('|')[3].Split(';');
            long prevDist = long.MaxValue;
            foreach (var e in entries)
            {
                var parts = e.Split(':');
                Assert.Equal("-1", parts[1]);
                long d = long.Parse(parts[2]);
                Assert.True(d <= prevDist);
                prevDist = d;
            }
        }
    }

    public class ConfigAndCodecTests
    {
        [Fact]
        public void DefaultRulesetKeySetMatchesEngineExactly()
        {
            var node = JsonNode.Parse(File.ReadAllText(TestUtil.DefaultRulesetPath));
            var keys = node.Props.Select(p => p.Key).Where(k => k != RulesetParams.VersionKey).ToHashSet();
            // the default file always carries every key, including the later-added optional (ground) ones
            Assert.True(keys.SetEquals(RulesetParams.IntKeys.Concat(RulesetParams.OptionalIntKeys)), "file and RulesetParams keys differ");
            Assert.Equal(RulesetParams.IntKeys.Length, RulesetParams.IntKeys.Distinct().Count());
            Assert.Empty(RulesetParams.IntKeys.Intersect(RulesetParams.OptionalIntKeys));
            Assert.Equal(RulesetParams.OptionalIntKeys.Length, RulesetParams.OptionalNeutralValues.Length);
            Assert.True(node.Has("rulesetVersion"));
            Assert.True(node.Has("maxTicks"));
            foreach (var p in node.Props) if (p.Key != "rulesetVersion") p.Value.AsLong();
        }

        [Fact]
        public void RulesetRejectsMissingAndUnknownKeys()
        {
            var node = JsonNode.Parse(File.ReadAllText(TestUtil.DefaultRulesetPath));
            node.Set("bogusKey", 1);
            Assert.Throws<FormatException>(() => ProtocolCodec.ParseRuleset(node));

            var node2 = JsonNode.Obj();
            foreach (var p in JsonNode.Parse(File.ReadAllText(TestUtil.DefaultRulesetPath)).Props)
                if (p.Key != "maxWhips") node2.Set(p.Key, p.Value);
            Assert.Throws<FormatException>(() => ProtocolCodec.ParseRuleset(node2));

            var node3 = JsonNode.Parse(File.ReadAllText(TestUtil.DefaultRulesetPath));
            node3.Set("maxWhips", JsonNode.NumRaw("1.5"));
            Assert.Throws<FormatException>(() => ProtocolCodec.ParseRuleset(node3));
        }

        [Fact]
        public void ConfigRoundTripsThroughJson()
        {
            var rs = TestUtil.Ruleset();
            var rng = new Pcg32(1, 1);
            var horses = Enumerable.Range(0, 12).Select(i => SampleRaces.RandomHorse(ref rng, "x" + i)).ToList();
            var cfg = SampleRaces.Config("rt", ulong.MaxValue, SampleRaces.Turf2000(), rs, horses, 5);
            string json = ProtocolCodec.ConfigToJson(cfg).ToString();
            var back = ProtocolCodec.ParseConfig(json);
            Assert.Equal(ulong.MaxValue, back.Seed);
            Assert.Contains("\"seed\":\"18446744073709551615\"", json);
            Assert.Equal(json, ProtocolCodec.ConfigToJson(back).ToString());
            Assert.Equal(RaceReplay.Run(cfg, new List<InputRecord>()).Result.Hash, RaceReplay.Run(back, new List<InputRecord>()).Result.Hash);
        }

        [Theory]
        [InlineData("segments")]
        [InlineData("slots")]
        [InlineData("stats")]
        [InlineData("cpuLevel")]
        [InlineData("seed")]
        [InlineData("count")]
        public void InvalidConfigsAreRejected(string what)
        {
            var rs = TestUtil.Ruleset();
            var cfg = SampleRaces.Config("bad", 1, SampleRaces.Turf2000(), rs, Enumerable.Range(0, 3).Select(i => TestUtil.H("b" + i)).ToList(), 1);
            var node = ProtocolCodec.ConfigToJson(cfg);
            switch (what)
            {
                case "segments": node.Get("track").Get("segments")[0].Set("lengthM", 299); break;
                case "slots": node.Get("entrants")[1].Set("slot", 5); break;
                case "stats": node.Get("entrants")[0].Get("horse").Set("speed", 1001); break;
                case "cpuLevel": node.Get("entrants")[0].Set("cpuLevel", 0); break;
                case "seed": node.Set("seed", JsonNode.Num(5)); break;
                case "count":
                    var arr = JsonNode.Arr();
                    node.Set("entrants", arr);
                    break;
            }
            Assert.Throws<FormatException>(() => ProtocolCodec.ParseConfig(node.ToString()));
        }
    }

    public class JsonTests
    {
        [Fact]
        public void ParsesAndWritesProtocolShapes()
        {
            var n = JsonNode.Parse("{\"t\":\"b\",\"from\":10,\"to\":11,\"in\":[[10,3,32],[11,0,2]],\"s\":\"a\\\"\\u3042\\n\",\"x\":null,\"y\":true}");
            Assert.Equal("b", n.Get("t").AsString());
            Assert.Equal(32, n.Get("in")[0][2].AsInt());
            Assert.Equal("a\"あ\n", n.Get("s").AsString());
            Assert.True(n.Get("x").IsNull);
            Assert.True(n.Get("y").AsBool());
            var round = JsonNode.Parse(n.ToString());
            Assert.Equal(n.ToString(), round.ToString());
            Assert.Equal(long.MaxValue, JsonNode.Parse("9223372036854775807").AsLong());
        }

        [Theory]
        [InlineData("{")]
        [InlineData("{\"a\":1,}")]
        [InlineData("[1,2")]
        [InlineData("{\"a\":1}x")]
        [InlineData("{\"a\":1,\"a\":2}")]
        [InlineData("\"abc")]
        [InlineData("tru")]
        public void RejectsMalformedJson(string s)
        {
            Assert.Throws<FormatException>(() => JsonNode.Parse(s));
        }

        [Fact]
        public void IntegerAccessorRejectsFractions()
        {
            Assert.Throws<FormatException>(() => JsonNode.Parse("1.5").AsLong());
            Assert.Throws<FormatException>(() => JsonNode.Parse("\"1\"").AsLong());
        }
    }
}
