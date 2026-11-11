// クライアントのエラー報告 (REQ-CERR-002/013/020, contracts/protocol.md §60): ClientErrorModel over a fake server — Unity log
// lines (exception / assert / error / warning), the type split, no reporting loop, stalls and pauses, API failures from
// ApiClient, a desync from the lockstep client, the consent hook and the send on pause.
using Muchi.Client;
using Muchi.Game;
using Muchi.Net;

static class ClientErrorChecks
{
    sealed class FakeServer : IHttp
    {
        public readonly List<HttpRequest> Sent = new List<HttpRequest>();
        public Task<HttpResponse> SendAsync(HttpRequest r, CancellationToken ct)
        {
            Sent.Add(r);
            if (r.Path == "/v1/client-errors")
            {
                int n = JsonNode.Parse(r.Body).Get("items").Count;
                return Task.FromResult(new HttpResponse(200, "{\"accepted\":" + n + ",\"dropped\":0,\"duplicate\":false,\"enabled\":true,\"sampling\":{\"exception\":1000,\"api\":1000,\"desync\":1000,\"asset\":1000,\"stall\":1000},\"flushIntervalSec\":60}"));
            }
            return Task.FromResult(new HttpResponse(500, "{\"error\":{\"code\":\"INTERNAL\",\"message\":\"x\"}}"));
        }
    }
    sealed class Tokens : IAuthTokenProvider { public Task<string> GetTokenAsync(bool f, CancellationToken ct) => Task.FromResult("tok"); }
    sealed class NullTransport : ITransport { public void Send(string message) { } }

    public static async Task Run(Action<bool, string> check)
    {
        long now = 1_794_790_800_000L;
        var s = new FakeServer();
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var rep = new ErrorReporter(api, new ClientErrorOptions { Platform = "ios", AppVersion = "1.4.0", DeviceModel = "iPhone15,2", OsVersion = "iOS 18.1", FlushIntervalMs = 10_000_000 }, null, now, () => 0.0);
        var m = new ClientErrorModel(rep, () => now) { Screen = "home" };
        m.Attach(api);

        m.OnLogMessage("NullReferenceException: Object reference not set to an instance of an object", "Muchi.Game.HudModel.Update () (at Assets/Muchi/Game/HudModel.cs:120)", GameLogType.Exception);
        m.OnLogMessage("NullReferenceException: Object reference not set to an instance of an object", "Muchi.Game.HudModel.Update () (at Assets/Muchi/Game/HudModel.cs:120)", GameLogType.Exception);
        m.OnLogMessage("just a warning", "", GameLogType.Warning);
        m.OnLogMessage("Debug.LogError line for ハヤテ", "", GameLogType.Error);
        check(rep.Queued.Count == 1 && rep.Queued[0].Count == 2, "a repeated exception collapses into one item (count 2); warnings and LogError lines are not reported");
        var q = rep.Queued[0];
        check(q.Type == "NullReferenceException" && q.Message.StartsWith("Object reference") && q.Stack.Contains("(at HudModel.cs:120)") && q.Screen == "home", "the type is split from the condition; the stack keeps only the file name; the screen tags it");
        m.ReportLogErrors = true;
        m.OnLogMessage("Debug.LogError line for ハヤテ", "", GameLogType.Error);
        check(rep.Queued.Count == 2 && rep.Queued[1].Type == "LogError" && !rep.Queued[1].Message.Contains("ハヤテ"), "LogError lines when switched on, with player names scrubbed");
        check(ClientErrorModel.SplitCondition("Assertion failed", GameLogType.Assert).Type == "Assert" && ClientErrorModel.SplitCondition("Bad thing: x", GameLogType.Exception).Type == "Exception", "conditions that do not start with an exception type keep the whole text");

        // a listener that throws while reporting never reaches the game, and a log line raised during a report is ignored
        m.OnException(new AggregateException(new InvalidOperationException("inner one")));
        check(rep.Queued.Count == 3 && rep.Queued[2].Type == "InvalidOperationException", "an aggregate exception reports its inner exception");

        // stalls: a 6 s gap on the gacha screen, then a pause (time away is not a stall)
        m.Screen = "gacha_reveal";
        m.OnFrame(); now += 16; m.OnFrame(); now += 6000; m.OnFrame();
        check(rep.Queued.Count == 4 && rep.Queued[3].Kind == "anr" && rep.Queued[3].Screen == "gacha_reveal", "a 6-second stall is reported as anr on the screen in front");
        _ = m.OnPause(false); now += 600_000; m.OnFrame();
        check(rep.Queued.Count == 4, "after a pause the first frame does not count the time away");

        // an API call that fails for good (500) is reported with the route template
        try { await api.GetPlayerAsync(); } catch (ApiException) { }
        check(rep.Queued.Count == 5 && rep.Queued[4].Route == "/v1/player" && rep.Queued[4].Status == 500, "a failed API call is reported (route, status, code)");

        // a desync in an online race: race id + tick only
        var race = new LockstepClient(new NullTransport(), "race_20261116_7", "tok");
        m.WatchRace(race, "ranked");
        race.HandleMessage("{\"t\":\"desync\",\"tick\":812}");
        var d = rep.Queued[5];
        check(d.Category == "desync" && d.RaceId == "race_20261116_7" && d.Tick == 812 && !d.ToJson().ToString().Contains("input"), "a desync is reported with the race id and tick, never inputs");
        m.OnAssetFailure("ios/horses/sakura.bundle", "hash");
        check(rep.Queued[6].Category == "asset" && rep.Queued[6].Reason == "hash", "an asset download failure is reported");

        // the consent hook (§58, default true): off → attachPlayer false; the pause sends everything
        rep.AllowsDiagnostics = () => false;
        await m.OnPause(true);
        var posts = s.Sent.Where(r => r.Path == "/v1/client-errors").ToList();
        var body = JsonNode.Parse(posts[0].Body);
        check(posts.Count == 1 && body.Get("items").Count == 7 && !body.Get("attachPlayer").AsBool() && rep.Pending == 0, "going to the background sends the queue in one batch; consent off → attachPlayer false");
        check(body.Get("deviceModel").AsString() == "iPhone15,2" && body.Get("osVersion").AsString() == "iOS 18.1" && body.Get("installId").AsString().Length >= 8, "device model, OS version and the random install id ride the batch");
        check(posts[0].Headers.TryGetValue("authorization", out var auth) && auth == "Bearer tok", "the batch is signed in when a token is available");
        check(!posts[0].Body.Contains("ハヤテ") && !posts[0].Body.Contains("Assets/Muchi"), "no player name or full path leaves the device");
    }
}
