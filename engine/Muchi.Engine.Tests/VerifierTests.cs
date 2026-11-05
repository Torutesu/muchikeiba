using Muchi.Engine;
using Muchi.Net;
using Muchi.Verifier;

namespace Muchi.Engine.Tests
{
    public class VerifierTests
    {
        private static string GoldenDir => Path.Combine(TestUtil.RepoRoot, "contracts", "golden");

        public static IEnumerable<object[]> GoldenFiles()
        {
            var dir = GoldenDir;
            if (!Directory.Exists(dir)) yield break;
            foreach (var f in Directory.GetFiles(dir, "race-*.json").OrderBy(x => x)) yield return new object[] { Path.GetFileName(f) };
        }

        [Fact]
        public void AtLeastTwoGoldenRacesExist()
        {
            Assert.True(GoldenFiles().Count() >= 2, "run: dotnet run --project Muchi.Verifier -- golden ../contracts/golden ../contracts/ruleset-params.default.json");
        }

        [Theory]
        [MemberData(nameof(GoldenFiles))]
        public void VerifierReproducesGolden(string name)
        {
            var doc = JsonNode.Parse(File.ReadAllText(Path.Combine(GoldenDir, name)));
            var (status, body) = VerifyService.Verify(doc.Get("log").ToString());
            Assert.Equal(200, status);
            Assert.Equal(doc.Get("expected").ToString(), JsonNode.Parse(body).ToString());
            var log = ProtocolCodec.ParseReplayLog(doc.Get("log"));
            Assert.Equal(log.EndTick, RaceReplay.Run(log.Config, log.Inputs).Result.EndTick);
        }

        [Fact]
        public void GoldenGeneratorIsStable()
        {
            // regenerating with the current ruleset must reproduce the committed files byte for byte
            var tmp = Path.Combine(Path.GetTempPath(), "muchi-golden-" + Guid.NewGuid().ToString("N"));
            try
            {
                var written = GoldenGenerator.WriteAll(tmp, File.ReadAllText(TestUtil.DefaultRulesetPath));
                foreach (var p in written)
                {
                    var committed = Path.Combine(GoldenDir, Path.GetFileName(p));
                    Assert.True(File.Exists(committed), "missing golden " + committed);
                    Assert.Equal(File.ReadAllText(committed), File.ReadAllText(p));
                }
            }
            finally { if (Directory.Exists(tmp)) Directory.Delete(tmp, true); }
        }

        [Fact]
        public void TsGeneratedConfigsRunToTheEnd()
        {
            // contracts/golden/ts-config-*.json are produced by the TypeScript race-config builder (protocol §9)
            foreach (var f in Directory.Exists(GoldenDir) ? Directory.GetFiles(GoldenDir, "ts-config-*.json") : Array.Empty<string>())
            {
                var cfg = ProtocolCodec.ParseConfig(File.ReadAllText(f));
                var outp = RaceReplay.Run(cfg, new List<InputRecord>());
                Assert.True(outp.Sim.IsFinished, f);
            }
        }

        [Theory]
        [InlineData("{")]
        [InlineData("{\"v\":2}")]
        [InlineData("{\"v\":1,\"config\":{},\"endTick\":0,\"inputs\":[]}")]
        public void BadLogsReturn400(string body)
        {
            var (status, json) = VerifyService.Verify(body);
            Assert.Equal(400, status);
            Assert.True(JsonNode.Parse(json).Has("error"));
        }

        private static JsonNode ValidLog()
        {
            var doc = JsonNode.Parse(File.ReadAllText(Directory.GetFiles(GoldenDir, "race-*.json").OrderBy(x => x).First()));
            return doc.Get("log");
        }

        [Fact]
        public void RulesetKeyMismatchReturns400()
        {
            var log = ValidLog();
            log.Get("config").Get("ruleset").Set("extraKey", 1);
            Assert.Equal(400, VerifyService.Verify(log.ToString()).status);
        }

        [Theory]
        [InlineData("[[5,99,1]]")]          // bad slot
        [InlineData("[[999999,0,1]]")]      // beyond maxTicks
        [InlineData("[[10,1,1],[5,0,1]]")]  // unsorted
        [InlineData("[[10,1,1],[10,1,2]]")] // duplicate tick/slot
        [InlineData("[[10,1,300]]")]        // cmd out of byte range
        [InlineData("[[10,1]]")]            // wrong arity
        public void InvalidInputsReturn400(string inputs)
        {
            var log = ValidLog();
            log.Set("inputs", JsonNode.Parse(inputs));
            Assert.Equal(400, VerifyService.Verify(log.ToString()).status);
        }

        [Fact]
        public void VerificationIsFast()
        {
            var body = ValidLog().ToString();
            VerifyService.Verify(body);
            var sw = System.Diagnostics.Stopwatch.StartNew();
            for (int i = 0; i < 10; i++) Assert.Equal(200, VerifyService.Verify(body).status);
            Assert.True(sw.ElapsedMilliseconds / 10 < 1000, "REQ-VER-003");
        }
    }
}
