using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-CERR-002..013/020: ErrorReporter, scrubber / fingerprint parity with the server, StallDetector, ApiClient hooks (contracts/protocol.md §60).</summary>
    public class ClientErrorsTests
    {
        private static JsonNode Vectors() => JsonNode.Parse(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "contracts", "client-errors.vectors.json")));

        [Fact]
        public void ScrubberAndFingerprintMatchTheServerVectors()
        {
            var v = Vectors();
            foreach (var x in v.Get("fnv").Items) Assert.Equal(x.Get("hash").AsString(), ErrorFingerprint.Fnv64(x.Get("input").AsString()));
            foreach (var x in v.Get("messages").Items) Assert.Equal(x.Get("output").AsString(), ErrorScrubber.Message(x.Get("input").AsString()));
            foreach (var x in v.Get("stacks").Items)
            {
                var s = ErrorScrubber.Stack(x.Get("input").AsString());
                Assert.Equal(x.Get("output").AsString(), s);
                Assert.Equal(x.Get("frames").Items.Select(f => f.AsString()).ToList(), ErrorFingerprint.TopFrames(s));
            }
            foreach (var x in v.Get("routes").Items) Assert.Equal(x.Get("output").AsString(), ErrorScrubber.NormalizeRoute(x.Get("input").AsString()));
            foreach (var x in v.Get("devices").Items) Assert.Equal(x.Get("output").AsString(), ErrorScrubber.DeviceField(x.Get("input").AsString()));
            foreach (var x in v.Get("fingerprints").Items)
            {
                var item = ClientErrorItem.FromJson(x.Get("input"));
                Assert.Equal(x.Get("source").AsString(), ErrorFingerprint.Source(item));
                Assert.Equal(x.Get("fingerprint").AsString(), item.Fingerprint);
            }
        }

        [Fact]
        public void FactoriesShapeItemsToTheWireAndADesyncCarriesNoInputs()
        {
            var e = ClientErrorItem.Exception(1, "List`1[System.String]", "Horse \"ハヤテ\" for bob@x.jp", "A.B () (at /Users/bob/A.cs:3)", false, "gacha reveal!");
            Assert.Equal("List`1_System.String_", e.Type);
            Assert.Equal("Horse \"…\" for <email>", e.Message);
            Assert.Equal("A.B () (at A.cs:3)", e.Stack);
            Assert.Equal("gacha_reveal_", e.Screen);
            var d = ClientErrorItem.Desync(1, "race_9", 812, "ranked", 1).ToJson();
            Assert.Equal(new[] { "category", "at", "count", "sampleRate", "raceId", "tick", "mode", "engineLevel" }, d.Props.Select(p => p.Key).ToArray());
            var a = ClientErrorItem.Api(1, "post", "/v1/horses/h_9f2k/goals?x=1", 503, "INTERNAL", "http");
            Assert.Equal(("POST", "/v1/horses/:id/goals"), (a.Method, a.Route));
            Assert.Equal("long_frame", ClientErrorItem.Stall(1, "weird", 900, "home").Kind);
            Assert.Equal("other", ClientErrorItem.Asset(1, "ios/h/a.bundle", "boom").Reason);
        }

        private sealed class MemStore : IClientErrorStore { public string Json; public string Load() => Json; public void Save(string json) => Json = json; }

        private sealed class FakeSend
        {
            public readonly List<JsonNode> Batches = new List<JsonNode>();
            public readonly Queue<Func<JsonNode, ClientErrorBatchResult>> Replies = new Queue<Func<JsonNode, ClientErrorBatchResult>>();
            public FakeSend Ok(int accepted = -1, bool enabled = true, bool duplicate = false, JsonNode sampling = null)
            { Replies.Enqueue(b => new ClientErrorBatchResult { Accepted = accepted < 0 ? b.Get("items").Count : accepted, Enabled = enabled, Duplicate = duplicate, Sampling = ClientErrorSampling.Parse(sampling) }); return this; }
            public FakeSend Throw(Exception e) { Replies.Enqueue(_ => throw e); return this; }
            public Task<ClientErrorBatchResult> Send(JsonNode b, CancellationToken ct) { Batches.Add(b); return Task.FromResult(Replies.Dequeue()(b)); }
        }

        private static ErrorReporter Reporter(FakeSend s, MemStore store = null, double roll = 0.0, ClientErrorOptions opt = null)
            => new ErrorReporter(s.Send, opt ?? new ClientErrorOptions { Platform = "android", AppVersion = "1.4.0", DeviceModel = "Pixel 8", OsVersion = "Android 14", InstallId = "inst_0000000001" }, store, 0, () => roll);

        [Fact]
        public void RepeatsCollapseSamplingDropsAndDesyncIsAlwaysKept()
        {
            var s = new FakeSend();
            var r = Reporter(s, roll: 0.5); // api 200‰ and stall 100‰ are sampled out at this roll, exception 1000‰ kept
            for (int i = 0; i < 3; i++) Assert.True(r.Report(ClientErrorItem.Exception(1, "NullReferenceException", "x " + i, "A.B () (at A.cs:" + i + ")")));
            Assert.False(r.Report(ClientErrorItem.Api(1, "GET", "/v1/player", 500, null, "http")));
            Assert.False(r.Report(ClientErrorItem.Stall(1, "anr", 6000, "home")));
            Assert.True(r.Report(ClientErrorItem.Desync(1, "race_1", 10, "ranked")));
            Assert.Equal(2, r.Queued.Count);
            Assert.Equal(3, r.Queued[0].Count);
            Assert.Equal(2, r.Dropped);
        }

        [Fact]
        public async Task BatchesKeepTheirIdAcrossFailuresAndRestartsAndAttachPlayerFollowsTheConsentHook()
        {
            var s = new FakeSend().Throw(new NetworkException("down", null)).Throw(new ServerException(ApiErrorCode.Unknown, "INTERNAL", "x", 500));
            var store = new MemStore();
            var r = Reporter(s, store);
            r.AllowsDiagnostics = () => false;
            r.Report(ClientErrorItem.Exception(1, "E", "m", ""));
            Assert.True(r.Update(70_000));
            await Task.Yield();
            Assert.False(r.Update(70_001)); // backing off
            Assert.True(r.Update(70_000 + 10_000));
            var first = s.Batches[0];
            Assert.Equal(first.Get("batchId").AsString(), s.Batches[1].Get("batchId").AsString());
            Assert.False(first.Get("attachPlayer").AsBool());
            Assert.Equal("inst_0000000001", first.Get("installId").AsString());
            Assert.Equal("Pixel 8", first.Get("deviceModel").AsString());
            // the app restarts: the unanswered batch comes back with the same id and is sent first
            var s2 = new FakeSend().Ok(duplicate: true, accepted: 0);
            var r2 = Reporter(s2, store);
            Assert.Equal(1, r2.Pending);
            await r2.FlushAllAsync(200_000);
            Assert.Equal(first.Get("batchId").AsString(), s2.Batches[0].Get("batchId").AsString());
            Assert.Equal(0, r2.Pending);
            Assert.Equal(1, r2.Sent);
        }

        [Fact]
        public async Task RateLimitWaitsBadRequestDropsAndDisabledStops()
        {
            var s = new FakeSend().Throw(new RateLimitedException("RATE_LIMITED", "x", 429)).Throw(new ValidationException(ApiErrorCode.BadRequest, "BAD_REQUEST", "x", 400))
                .Ok(enabled: false);
            var r = Reporter(s);
            r.Report(ClientErrorItem.Exception(1, "E", "a", ""));
            await r.FlushAllAsync(100);
            Assert.False(r.Update(100 + 60_000)); // waits at least RateLimitBackoffMs
            await r.FlushAllAsync(100 + 300_001);
            Assert.Equal(0, r.Pending); // the 400 dropped the batch
            Assert.Equal(1, r.Dropped);
            r.Report(ClientErrorItem.Exception(2, "E", "b", ""));
            await r.FlushAllAsync(500_000);
            Assert.False(r.Enabled);
            Assert.False(r.Report(ClientErrorItem.Exception(3, "E", "c", "")));
        }

        [Fact]
        public async Task TheServerSamplingIsUsedFromTheNextReport()
        {
            var sampling = JsonNode.Parse("{\"exception\":0,\"api\":1000,\"desync\":5,\"asset\":1000,\"stall\":1000}");
            var s = new FakeSend().Ok(sampling: sampling);
            var r = Reporter(s, roll: 0.99);
            r.Report(ClientErrorItem.Desync(1, "race_1", 1, "ranked"));
            await r.FlushAllAsync(100);
            Assert.False(r.Report(ClientErrorItem.Exception(2, "E", "a", "")));
            Assert.True(r.Report(ClientErrorItem.Api(2, "GET", "/v1/player", 500, null, "http")));
            Assert.True(r.Report(ClientErrorItem.Desync(2, "race_2", 1, "ranked"))); // desync stays 1000 whatever the server says
            Assert.Equal(1000, r.Sampling.RateOf("desync"));
        }

        [Fact]
        public async Task ApiClientRaisesFailuresAndTheReporterSkipsBusinessAnswersAndItsOwnEndpoint()
        {
            var http = new FakeHttp().Reply(500, "{\"error\":{\"code\":\"INTERNAL\",\"message\":\"x\"}}").Reply(409, "{\"error\":{\"code\":\"INSUFFICIENT_COINS\",\"message\":\"x\"}}")
                .Reply(429, "{\"error\":{\"code\":\"RATE_LIMITED\",\"message\":\"x\"}}");
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test/" };
            opt.Retry.MaxRetries = 0;
            var api = new ApiClient(http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
            var seen = new List<ApiFailure>();
            api.RequestFailed += seen.Add;
            var s = new FakeSend();
            var r = Reporter(s, roll: 0.0);
            r.AttachTo(api, () => 5);
            await Assert.ThrowsAnyAsync<ApiException>(() => api.GetPlayerAsync());
            await Assert.ThrowsAnyAsync<ApiException>(() => api.GetPlayerAsync());
            await Assert.ThrowsAnyAsync<ApiException>(() => api.SendClientErrorsAsync(JsonNode.Obj()));
            Assert.Equal(new[] { 500, 409, 429 }, seen.Select(f => f.Status).ToArray());
            Assert.Equal("INTERNAL", seen[0].Code);
            var q = Assert.Single(r.Queued);
            Assert.Equal(ClientErrorCategories.Api, q.Category);
            Assert.False(ErrorReporter.IsReportable(new ApiFailure { Path = "/v1/client-errors", Status = 500 }));
            Assert.True(ErrorReporter.IsReportable(new ApiFailure { Path = "/v1/player", Status = 0, Reason = "network" }));
            Assert.False(ErrorReporter.IsReportable(new ApiFailure { Path = "/v1/gacha/x/draw", Status = 404 }));
            // the post is signed in when a provider exists
            Assert.Equal("Bearer token", http.Requests[2].Headers["authorization"]);
            Assert.Equal("/v1/client-errors", http.Requests[2].Path);
        }

        [Fact]
        public void StallDetectorReportsLongFramesAndAnrOncePerCooldownAndIgnoresPauses()
        {
            var d = new StallDetector();
            Assert.Null(d.Frame(0, "home"));
            Assert.Null(d.Frame(16, "home"));
            var lf = d.Frame(816, "home");
            Assert.Equal(("long_frame", 800), (lf.Kind, lf.DurationMs));
            Assert.Null(d.Frame(1700, "home")); // cooldown for this screen and kind
            Assert.Equal("anr", d.Frame(8000, "home").Kind);
            d.Pause();
            Assert.Null(d.Frame(500_000, "home")); // back from the background: not a stall
        }

        [Fact]
        public void LockstepClientRaisesDesyncWithTheRaceId()
        {
            var c = new LockstepClient(new NullTransport(), "race_42", "tok");
            var s = new FakeSend();
            var r = Reporter(s);
            r.WatchRace(c, "ranked", () => 9);
            c.HandleMessage("{\"t\":\"desync\",\"tick\":812}");
            Assert.Equal(new[] { 812 }, c.DesyncTicks);
            var q = Assert.Single(r.Queued);
            Assert.Equal(("race_42", 812, "ranked"), (q.RaceId, q.Tick, q.Mode));
            Assert.DoesNotContain("input", q.ToJson().ToString());
        }

        [Fact]
        public async Task EveryNewBatchGetsItsOwnIdEvenWithAFixedSamplingRoll()
        {
            var s = new FakeSend().Ok().Ok();
            var r = Reporter(s, roll: 0.0);
            r.Report(ClientErrorItem.Exception(1, "E", "a", ""));
            await r.FlushAllAsync(100);
            r.Report(ClientErrorItem.Exception(2, "F", "b", ""));
            await r.FlushAllAsync(200);
            Assert.Equal(2, s.Batches.Count);
            Assert.NotEqual(s.Batches[0].Get("batchId").AsString(), s.Batches[1].Get("batchId").AsString());
            Assert.Matches("^b_[0-9a-f]{16}$", s.Batches[1].Get("batchId").AsString());
        }

        [Fact]
        public void AnAssetRunReportsItsFailedFilesButNotAnOfflineRun()
        {
            var r = Reporter(new FakeSend(), roll: 0.0);
            var rep = new AssetDownloadReport();
            rep.Keys["ios/horses/a.bundle"] = AssetFileState.Corrupt;
            rep.Keys["ios/horses/b.bundle"] = AssetFileState.Downloaded;
            rep.Keys["ios/tracks/c.bundle"] = AssetFileState.NotFound;
            rep.Keys["ios/tracks/d.bundle"] = AssetFileState.DiskFull;
            Assert.Equal(3, r.ReportAssetDownload(1, rep));
            Assert.Equal(new[] { "hash", "http", "disk" }, r.Queued.Select(q => q.Reason).ToArray());
            Assert.Equal(404, r.Queued[1].AssetStatus);
            var offline = new AssetDownloadReport { Offline = true };
            offline.Keys["ios/x/y.bundle"] = AssetFileState.Failed;
            Assert.Equal(0, r.ReportAssetDownload(2, offline));
        }

        private sealed class NullTransport : ITransport { public void Send(string message) { } }
    }
}
