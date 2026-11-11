using Muchi.Engine;
using Muchi.Net;
using Muchi.Verifier;

namespace Muchi.Engine.Tests
{
    /// <summary>Wall-clock budgets (NFR-001 step cost, REQ-VER-003 verification time). Other test classes block pool threads
    /// (.Result, Thread.Sleep); on a 2-core CI runner running them in parallel starved these timings (CI r19). Like
    /// AssetDeliveryTests, this collection runs alone, after the parallel ones. The budgets are unchanged.</summary>
    [CollectionDefinition(nameof(WallClockSerial), DisableParallelization = true)]
    public sealed class WallClockSerial { }

    /// <summary>NFR-001: the deterministic engine's step cost (moved from DeterminismTests).</summary>
    [Collection(nameof(WallClockSerial))]
    public class StepPerformanceTests
    {
        [Fact]
        public void StepPerformanceIsWellUnderBudget()
        {
            // NFR-001: a 12-horse step costs < 0.1 ms. Wall clock on shared CI runners is noisy (a neighbour can stall one
            // batch for tens of ms), so: warm up (JIT, tiered compilation), then time several short batches and judge
            // the fastest batch against the budget and the median against a generous ceiling. A real regression slows
            // every batch (fastest and median both move); a noisy neighbour only slows some of them.
            var (cfg, inputs) = DeterminismTests.Scenario(9);
            for (int i = 0; i < 3; i++) RaceReplay.Run(cfg, inputs);
            const int Batches = 9, RunsPerBatch = 3;
            var samples = new List<double>();
            for (int b = 0; b < Batches; b++)
            {
                var sw = System.Diagnostics.Stopwatch.StartNew();
                int ticks = 0;
                for (int i = 0; i < RunsPerBatch; i++) ticks += RaceReplay.Run(cfg, inputs).Result.EndTick + 1;
                sw.Stop();
                samples.Add(sw.Elapsed.TotalMilliseconds / ticks);
            }
            samples.Sort();
            double best = samples[0], median = samples[Batches / 2];
            string msg = $"ms per tick: best {best:F4}, median {median:F4} ({string.Join(", ", samples.Select(x => x.ToString("F4")))})";
            Assert.True(best < 0.1, msg);   // the budget itself, on the least-disturbed batch
            Assert.True(median < 0.3, msg); // most batches stay near it (3x headroom for shared runners)
        }
    }

    /// <summary>REQ-VER-003: the verifier's per-race time (moved from VerifierTests).</summary>
    [Collection(nameof(WallClockSerial))]
    public class VerifierPerformanceTests
    {
        [Fact]
        public void VerificationIsFast()
        {
            var body = VerifierTests.ValidLog().ToString();
            VerifyService.Verify(body);
            var sw = System.Diagnostics.Stopwatch.StartNew();
            for (int i = 0; i < 10; i++) Assert.Equal(200, VerifyService.Verify(body).status);
            Assert.True(sw.ElapsedMilliseconds / 10 < 1000, "REQ-VER-003");
        }
    }
}
