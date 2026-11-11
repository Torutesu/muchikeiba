// Round 20 integration (contracts/protocol.md §58.10/§58.11, §59, §60.6, §61): one system-ish prompt per session across
// ConsentModel / LocalNotificationModel / ReviewPromptModel (SessionPromptGate), the error reporter's consent = the §58
// analytics choice (ClientErrorModel.FollowConsent), and what a change of account resets on this device (AccountChangeReset:
// SESSION_REPLACED and a redeemed transfer code → reminders forgotten, the error queue anonymous, a new review session).
using System.Linq;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;
using Muchi.Net;

static class Round20IntegrationChecks
{
    sealed class FakeServer : IHttp
    {
        public readonly List<HttpRequest> Sent = new List<HttpRequest>();
        public readonly Dictionary<string, Func<HttpRequest, HttpResponse>> Routes = new Dictionary<string, Func<HttpRequest, HttpResponse>>();
        public Task<HttpResponse> SendAsync(HttpRequest r, CancellationToken ct)
        {
            Sent.Add(r);
            if (Routes.TryGetValue(r.Method + " " + r.Path, out var h)) return Task.FromResult(h(r));
            return Task.FromResult(new HttpResponse(404, "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"no route\"}}"));
        }
    }
    sealed class Tokens : IAuthTokenProvider { public Task<string> GetTokenAsync(bool f, CancellationToken ct) => Task.FromResult("tok"); }

    const long Now = 1796698800000L; // 2026-12-08 12:00 JST

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        // a device with all three prompts due: consent never decided, a training started, a happy moment
        var s = new FakeServer();
        var rules = new ConsentChecks.Rules();
        string Player() => LocalNotificationChecks.Player("g20", LocalNotificationChecks.Digest(false, "ts1"));
        s.Routes["POST /v1/player/bootstrap"] = _ => new HttpResponse(200, Player());
        s.Routes["GET /v1/player"] = _ => new HttpResponse(200, Player());
        s.Routes["GET /v1/privacy/choices"] = _ => new HttpResponse(200, rules.View());
        s.Routes["GET /v1/review-prompt"] = _ => new HttpResponse(200, ReviewPromptChecks.Status(false));
        s.Routes["POST /v1/review-prompt/check"] = _ => new HttpResponse(200, "{\"v\":1,\"show\":true,\"style\":\"native\",\"reason\":null,\"promptId\":\"rp_1\"}");
        s.Routes["POST /v1/review-prompt/rp_1/answer"] = _ => new HttpResponse(200, "{\"promptId\":\"rp_1\",\"next\":\"none\",\"helpCategory\":null}");
        s.Routes["POST /v1/client-errors"] = r => new HttpResponse(200, "{\"accepted\":" + JsonNode.Parse(r.Body).Get("items").Count + ",\"dropped\":0,\"duplicate\":false,\"enabled\":true}");
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, new MemoryKeyValueStore(), ruleset);
        await b.InitializeAsync();
        long now = Now;

        SessionPromptGate gate = new SessionPromptGate();
        var consent = new ConsentModel(b, new ConsentChecks.Platform()) { Prompts = gate };
        await consent.LoadAsync();
        var os = new LocalNotificationChecks.FakeOs();
        var reminders = new LocalNotificationModel(b, os, null, () => now) { Prompts = gate };
        var store = new ReviewPromptChecks.FakeStore();
        var review = new ReviewPromptModel(b, store, null, () => now, "sess_r20_0001") { Prompts = gate };

        // the order when several are due at one moment: consent → reminders → review
        check(gate.Pick(true, true, true) == SessionPromptKind.Consent && gate.Pick(false, true, true) == SessionPromptKind.Notifications && gate.Pick(false, false, true) == SessionPromptKind.Review,
            "prompts: consent first, then the reminders sheet, then the review");

        // the consent sheet shows before the first ad → the reminders sheet and the review wait for another session
        check(consent.ShouldShowPrePrompt(ConsentMoment.BeforeAdOffer), "prompts: the consent sheet is due before the first ad offer");
        consent.BuildPrePrompt();
        check(gate.Shown == SessionPromptKind.Consent && consent.ShouldShowPrePrompt(ConsentMoment.BeforeAdOffer), "prompts: the consent sheet claims the session (still showing)");
        check(!reminders.OnTrainingStarted() && !reminders.PrePromptDue, "prompts: no reminders sheet right after the consent sheet (same session)");
        int checksBefore = s.Sent.Count(r => r.Path == "/v1/review-prompt/check");
        check(await review.OnMomentAsync(ReviewMoments.FirstWin) == ReviewOutcome.Skipped && review.LastReason == "session_prompt" && store.Calls == 0
            && s.Sent.Count(r => r.Path == "/v1/review-prompt/check") == checksBefore, "prompts: no review in the session of the consent sheet (no check call)");

        // a new session (next launch): the reminders sheet may show, then nothing else this session
        gate.Reset();
        check(reminders.OnTrainingStarted() && gate.Shown == SessionPromptKind.Notifications, "prompts: next session → the reminders sheet after a training");
        check(!consent.ShouldShowPrePrompt(ConsentMoment.BeforeAdOffer), "prompts: no consent sheet right after the reminders sheet");
        check(await review.OnMomentAsync(ReviewMoments.FirstWin) == ReviewOutcome.Skipped && review.LastReason == "session_prompt", "prompts: no review after the reminders sheet");

        // a third session: the review asks; afterwards neither sheet shows in that session
        gate.Reset();
        reminders.DeclinePrePrompt(); // answered last session (今はしない): not due again for retryDays anyway
        check(await review.OnMomentAsync(ReviewMoments.FirstWin) == ReviewOutcome.NativeRequested && store.Calls == 1 && gate.Shown == SessionPromptKind.Review, "prompts: a quiet session → the review asks");
        check(!consent.ShouldShowPrePrompt(ConsentMoment.BeforeAdOffer), "prompts: no consent sheet after the review in the same session");

        // §58.10: the error reporter's consent follows the analytics choice
        var reporter = new ErrorReporter(api, new ClientErrorOptions { Platform = "ios", AppVersion = "1.4.0", InstallId = "inst_r20_game01", FlushIntervalMs = 10_000_000 }, null, now, () => 0.0);
        var errors = new ClientErrorModel(reporter, () => now) { Screen = "home" };
        errors.FollowConsent(consent);
        errors.OnException(new InvalidOperationException("boom"));
        await reporter.FlushAllAsync(now + 1);
        var sent = s.Sent.Where(r => r.Path == "/v1/client-errors").Select(r => JsonNode.Parse(r.Body)).ToList();
        check(sent.Count == 1 && sent[0].Get("attachPlayer").AsBool() && consent.AllowsDiagnostics, "errors: analytics on → reports carry the player id");
        rules.Analytics = false;
        await consent.LoadAsync();
        errors.OnException(new ArgumentException("bad"));
        await reporter.FlushAllAsync(now + 2);
        sent = s.Sent.Where(r => r.Path == "/v1/client-errors").Select(r => JsonNode.Parse(r.Body)).ToList();
        check(sent.Count == 2 && !sent[1].Get("attachPlayer").AsBool() && !consent.AllowsDiagnostics, "errors: analytics off (分析への協力) → reports go without the player id");
        rules.Analytics = true;
        await consent.LoadAsync();

        // §54: SESSION_REPLACED and a redeemed transfer code reset the device state of the old account
        var reset = new AccountChangeReset { Reminders = reminders, Errors = errors, Review = review, Prompts = gate };
        var maint = new MaintenanceModel(null, "ios");
        reset.Watch(maint);
        reminders.Refresh();
        errors.OnException(new NullReferenceException("left over"));
        var oldSession = review.SessionId;
        int cancels = os.CancelAlls;
        maint.OnSessionReplaced();
        maint.OnSessionReplaced(); // a second 401 does not reset twice
        check(reset.Resets == 1 && os.CancelAlls == cancels + 1 && os.Pending.Count == 0, "account: SESSION_REPLACED → the local reminders are cancelled and forgotten");
        check(review.SessionId != oldSession && !review.SessionPrompted && gate.Shown == null, "account: SESSION_REPLACED → a new review session and the one-prompt gate reset");
        await reporter.FlushAllAsync(now + 3);
        sent = s.Sent.Where(r => r.Path == "/v1/client-errors").Select(r => JsonNode.Parse(r.Body)).ToList();
        check(sent.Count == 3 && !sent[2].Get("attachPlayer").AsBool(), "account: the old account's queued error goes without a player id");
        errors.OnException(new TimeoutException("new account"));
        await reporter.FlushAllAsync(now + 4);
        sent = s.Sent.Where(r => r.Path == "/v1/client-errors").Select(r => JsonNode.Parse(r.Body)).ToList();
        check(sent.Count == 4 && sent[3].Get("attachPlayer").AsBool(), "account: the new account's errors attach again");

        var transferApi = new TransferCodeChecks.FakeApi();
        var transfer = new TransferCodeModel(transferApi);
        reset.Watch(transfer);
        await review.OnMomentAsync(ReviewMoments.FirstWin);
        check(review.SessionPrompted, "account: (a review asked in this session)");
        check(await transfer.RedeemAsync("K7M-Q3X-PHR", "Haneda2026!") && transfer.State == RedeemState.Done, "account: a transfer code redeemed");
        check(reset.Resets == 2 && !review.SessionPrompted && gate.Shown == null && os.Pending.Count == 0, "account: a redeemed code resets the reminders, the review session and the gate");
    }
}
