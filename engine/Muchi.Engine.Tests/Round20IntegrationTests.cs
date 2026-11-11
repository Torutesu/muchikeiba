using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>
    /// Round 20 integration: §58 consent × §60 error reports (the analytics choice is the diagnostics consent), and §54
    /// account changes (SESSION_REPLACED / transfer redeem) × the error reporter's queue (contracts/protocol.md §58.10, §60.6).
    /// </summary>
    public class Round20IntegrationTests
    {
        private sealed class MemStore : IClientErrorStore { public string Json; public string Load() => Json; public void Save(string json) => Json = json; }

        private sealed class FakeSend
        {
            public readonly List<JsonNode> Batches = new List<JsonNode>();
            public bool Fail;
            public Task<ClientErrorBatchResult> Send(JsonNode b, CancellationToken ct)
            {
                Batches.Add(b);
                if (Fail) throw new NetworkException("down", null);
                return Task.FromResult(new ClientErrorBatchResult { Accepted = b.Get("items").Count, Enabled = true });
            }
        }

        private static ErrorReporter Reporter(FakeSend s, MemStore store = null)
            => new ErrorReporter(s.Send, new ClientErrorOptions { Platform = "ios", AppVersion = "1.4.0", DeviceModel = "iPhone15,2", OsVersion = "iOS 18.1", InstallId = "inst_0000000020", MaxBatch = 20 }, store, 0, () => 0.0);

        private static ConsentState View(bool analyticsEffective, bool value = true)
            => ConsentState.Parse(JsonNode.Parse("{\"policyVersion\":\"2026-11-01\",\"analytics\":{\"value\":" + (value ? "true" : "false") + ",\"effective\":" + (analyticsEffective ? "true" : "false") + ",\"locked\":null},\"kpi\":{\"optional\":" + (analyticsEffective ? "true" : "false") + "}}"));

        private static ClientErrorItem Exc(long at, string m) => ClientErrorItem.Exception(at, "NullReferenceException", m, "A.B () (at A.cs:1)");

        [Fact]
        public void TheAnalyticsChoiceIsTheDiagnosticsConsent()
        {
            Assert.True(View(true).AllowsDiagnostics);
            Assert.False(View(false, value: false).AllowsDiagnostics);
            Assert.False(View(false, value: true).AllowsDiagnostics); // chosen on but locked (a minor): not effective → no player id
            Assert.True(new ConsentState().AllowsDiagnostics); // before the first view: the server decides (it enforces the choice too)
        }

        [Fact]
        public async Task FollowConsentSendsAttachPlayerFromTheCurrentChoice()
        {
            var s = new FakeSend();
            var r = Reporter(s);
            var state = View(true);
            r.FollowConsent(() => state);
            r.Report(Exc(1, "alpha"));
            await r.FlushAllAsync(100);
            Assert.True(s.Batches[0].Get("attachPlayer").AsBool());
            state = View(false, value: false); // withdrawn in settings
            r.Report(Exc(2, "beta"));
            await r.FlushAllAsync(200);
            Assert.False(s.Batches[1].Get("attachPlayer").AsBool());
            r.FollowConsent(() => null); // no view (signed out): no player id is claimed by the device either way
            Assert.True(r.AllowsDiagnostics());
        }

        [Fact]
        public async Task AnAccountChangeSendsTheOldAccountsQueueWithoutAPlayerIdEvenAfterARestart()
        {
            var s = new FakeSend { Fail = true };
            var store = new MemStore();
            var r = Reporter(s, store);
            r.Report(Exc(1, "old alpha"));
            r.Report(Exc(1, "old beta"));
            await r.FlushAllAsync(100);          // the in-flight batch (old account) failed and waits
            r.Report(Exc(2, "old gamma"));           // queued behind it, still the old account
            r.AccountChanged();                  // SESSION_REPLACED or a redeemed transfer code
            r.Report(Exc(3, "new delta"));           // the new account's own report
            Assert.Equal(4, r.Pending);
            // the app restarts before anything was sent
            var s2 = new FakeSend();
            var r2 = Reporter(s2, store);
            await r2.FlushAllAsync(1_000);
            Assert.Equal(3, s2.Batches.Count);
            Assert.False(s2.Batches[0].Get("attachPlayer").AsBool()); // the in-flight batch: same id, now anonymous
            Assert.Equal(s.Batches[0].Get("batchId").AsString(), s2.Batches[0].Get("batchId").AsString());
            Assert.Equal(2, s2.Batches[0].Get("items").Count);
            Assert.False(s2.Batches[1].Get("attachPlayer").AsBool()); // the old account's queued item: alone, anonymous
            Assert.Equal(1, s2.Batches[1].Get("items").Count);
            Assert.True(s2.Batches[2].Get("attachPlayer").AsBool());  // the new account's item attaches normally
            Assert.Equal(0, r2.Pending);
        }

        [Fact]
        public async Task OverflowAndStaleItemsKeepTheAnonymousCountInRange()
        {
            var s = new FakeSend();
            var r = new ErrorReporter(s.Send, new ClientErrorOptions { Platform = "ios", AppVersion = "1.4.0", InstallId = "inst_0000000021", MaxQueue = 3, MaxBatch = 20 }, null, 0, () => 0.0);
            r.Report(Exc(1, "old alpha"));
            r.Report(Exc(1, "old beta"));
            r.AccountChanged();
            r.Report(Exc(2, "new gamma"));
            r.Report(Exc(2, "new delta")); // the queue is full: the oldest (an old-account item) leaves
            Assert.Equal(3, r.Pending);
            await r.FlushAllAsync(100);
            Assert.Equal(2, s.Batches.Count);
            Assert.False(s.Batches[0].Get("attachPlayer").AsBool());
            Assert.Equal(1, s.Batches[0].Get("items").Count);
            Assert.True(s.Batches[1].Get("attachPlayer").AsBool());
            Assert.Equal(2, s.Batches[1].Get("items").Count);
        }
    }
}
