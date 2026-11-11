// Round 21 integration (contracts/protocol.md §58.11 = §64.6, §54 × §63 / §64): ONE prompt gate (Muchi.Client.SessionPrompts)
// for every prompt that can interrupt the player — recommended update > consent pre-prompt > comeback welcome > release notes >
// reminders pre-permission card > account-link prompt > review prompt — at most one per session, none in the FTUE; and what a
// change of account drops on this device (the waiting deep link, the release notes' session state, the gate).
using System.Linq;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;
using Muchi.Net;

static class Round21IntegrationChecks
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

    sealed class FakeNotes : IReleaseNotesApi
    {
        public readonly List<string> Seen = new List<string>();
        public Task<ReleaseNotesCheck> CheckReleaseNotesAsync(CancellationToken ct = default)
        {
            var n = new ReleaseNote { AppVersion = "1.2.0", ReleasedOn = "2026-11-05" };
            n.Pages.Add(new ReleaseNotePage { Art = "cups", Title = "観戦中に応援できる", Body = "応援は2秒ごとに送れます。" });
            return Task.FromResult(new ReleaseNotesCheck { Enabled = true, Show = n });
        }
        public Task<ReleaseNotesSeen> MarkReleaseNotesSeenAsync(string appVersion, CancellationToken ct = default) { Seen.Add(appVersion); return Task.FromResult(new ReleaseNotesSeen { Marked = true }); }
        public Task<ReleaseNotesHistory> GetReleaseNotesAsync(CancellationToken ct = default) => Task.FromResult(new ReleaseNotesHistory { Enabled = true });
    }

    sealed class FakeLinks : IDeepLinkApi
    {
        public int Resolves;
        public Task<ResolvedLink> ResolveAsync(string token, CancellationToken ct) { Resolves++; return Task.FromResult(ResolvedLink.Parse(JsonNode.Parse(@"{""state"":""unavailable""}"))); }
        public Task<CreatedLink> CreateAsync(string type, IDictionary<string, string> target, CancellationToken ct) => throw new NotSupportedException();
    }

    const long Now = 1796698800000L; // 2026-12-08 12:00 JST

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        var s = new FakeServer();
        var rules = new ConsentChecks.Rules();
        string Player() => LocalNotificationChecks.Player("g21", LocalNotificationChecks.Digest(false, "ts1"));
        s.Routes["POST /v1/player/bootstrap"] = _ => new HttpResponse(200, Player());
        s.Routes["GET /v1/player"] = _ => new HttpResponse(200, Player());
        s.Routes["GET /v1/privacy/choices"] = _ => new HttpResponse(200, rules.View());
        s.Routes["GET /v1/review-prompt"] = _ => new HttpResponse(200, ReviewPromptChecks.Status(false));
        s.Routes["POST /v1/review-prompt/check"] = _ => new HttpResponse(200, "{\"v\":1,\"show\":true,\"style\":\"native\",\"reason\":null,\"promptId\":\"rp_1\"}");
        s.Routes["POST /v1/review-prompt/rp_1/answer"] = _ => new HttpResponse(200, "{\"promptId\":\"rp_1\",\"next\":\"none\",\"helpCategory\":null}");
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, new MemoryKeyValueStore(), ruleset);
        await b.InitializeAsync();
        long now = Now;
        bool ftue = true;

        // ONE gate for every prompt, with the FTUE rule in it
        var prompts = new SessionPrompts(() => api.Outage, () => ftue);
        var consent = new ConsentModel(b, new ConsentChecks.Platform()) { Prompts = prompts };
        await consent.LoadAsync();
        var os = new LocalNotificationChecks.FakeOs();
        var reminders = new LocalNotificationModel(b, os, null, () => now) { Prompts = prompts };
        var review = new ReviewPromptModel(b, new ReviewPromptChecks.FakeStore(), null, () => now, "sess_r21_0001") { Prompts = prompts };
        var notesApi = new FakeNotes();
        var notes = new ReleaseNotesModel(notesApi, prompts, () => true, null, () => now);
        var link = new AccountLinkPrompt(new MemoryKeyValueStore()) { Prompts = prompts };

        check(SessionPrompts.Priority.SequenceEqual(new[] { "recommended_update", "consent_pre_prompt", "comeback_welcome", "release_notes", "reminders_pre_permission", "account_link", "review_prompt" }),
            "prompts: one table (§58.11 = §64.6) — update > consent > comeback > release notes > reminders > account link > review");

        // during the FTUE nothing shows: not the consent sheet, not the release notes, not the reminders card, not the account link
        check(!consent.ShouldShowPrePrompt(ConsentMoment.Home) && !await notes.OnHomeArrivedAsync() && !reminders.OnTrainingStarted() && !link.ShouldShow(LinkPromptContext.Home, true, 3, true, true)
            && prompts.Claimed == null && notesApi.Seen.Count == 0, "FTUE: no prompt of any kind, nothing claimed or marked seen");
        ftue = false;

        // the release notes and the reminders card due at one home arrival: the release notes take the session
        string[] due = { SessionPrompts.RemindersPrePermission, SessionPrompts.ReleaseNotes, SessionPrompts.AccountLink };
        check(prompts.Pick(due) == SessionPrompts.ReleaseNotes, "prompts: release notes before the reminders card and the account link");
        check(await notes.OnHomeArrivedAsync(due) && prompts.Claimed == SessionPrompts.ReleaseNotes && notesApi.Seen.SequenceEqual(new[] { "1.2.0" }), "prompts: the release notes sheet opens and takes the session");
        check(!reminders.OnTrainingStarted() && !reminders.PrePromptDue, "prompts: no reminders card in the session of the release notes");
        check(!link.ShouldShow(LinkPromptContext.Home, true, 3, true, true), "prompts: no account-link prompt in the session of the release notes");
        check(!consent.ShouldShowPrePrompt(ConsentMoment.Home), "prompts: no consent sheet after the release notes (it waits for the next session)");
        check(await review.OnMomentAsync(ReviewMoments.FirstWin) == ReviewOutcome.Skipped && review.LastReason == "session_prompt", "prompts: no review after the release notes");

        // next session: the reminders card outranks the account link and the review
        notes.NewSession();
        check(prompts.Claimed == null, "prompts: a new session frees the gate");
        reminders.Refresh();
        check(reminders.OnTrainingStarted() && prompts.Claimed == SessionPrompts.RemindersPrePermission, "prompts: next session → the reminders card after a training");
        check(!link.ShouldShow(LinkPromptContext.Home, true, 3, true, true) && await review.OnMomentAsync(ReviewMoments.FirstWin) == ReviewOutcome.Skipped, "prompts: then no account link and no review");

        // a third session: the account-link prompt; afterwards no review
        prompts.NewSession();
        reminders.DeclinePrePrompt();
        check(link.ShouldShow(LinkPromptContext.Home, true, 3, true, true), "prompts: a quiet session → the account-link prompt (day 3)");
        link.Show(LinkPromptTrigger.Day3);
        check(prompts.Claimed == SessionPrompts.AccountLink && await review.OnMomentAsync(ReviewMoments.FirstWin) == ReviewOutcome.Skipped, "prompts: the account link took the session; the review waits");

        // a maintenance / forced update screen is never covered (the outage blocks every kind)
        prompts.NewSession();
        check(prompts.Free && prompts.Pick(SessionPrompts.Priority) == SessionPrompts.RecommendedUpdate, "prompts: a free session would give the update sheet first");

        // §54 × §63 / §64: a change of account drops the waiting deep link, the release notes' session state and the gate
        var kv = new MemoryKeyValueStore();
        var linksApi = new FakeLinks();
        var deep = new DeepLinkModel(linksApi, kv, () => true, null, () => now);
        check(deep.Receive("https://link.muchi-issen.example/l/k7mq3xphr2abcdefghjkmn") && deep.Pending != null, "account: a deep link waits on the device");
        await notes.OnHomeArrivedAsync();
        check(notes.ShownThisSession && prompts.Claimed == SessionPrompts.ReleaseNotes, "account: (the release notes showed for the old account)");
        var reset = new AccountChangeReset { Reminders = reminders, Review = review, Prompts = prompts, Links = deep, ReleaseNotes = notes };
        var maint = new MaintenanceModel(null, "ios");
        reset.Watch(maint);
        maint.OnSessionReplaced();
        check(reset.Resets == 1 && deep.Pending == null && kv.Get(DeepLinkModel.KeyPending) == "", "account: SESSION_REPLACED drops the waiting deep link (it came for the old account)");
        check(!notes.ShownThisSession && !notes.Showing && prompts.Claimed == null, "account: the release notes' session state and the gate start over for the new account");
        check(await deep.TryOpenAsync(true) == null && linksApi.Resolves == 0, "account: nothing is resolved for the new account");
        var transfer = new TransferCodeModel(new TransferCodeChecks.FakeApi());
        reset.Watch(transfer);
        check(deep.Receive("muchi://l/k7mq3xphr2abcdefghjkmn") && deep.Pending != null, "account: (another link waits)");
        check(await transfer.RedeemAsync("K7M-Q3X-PHR", "Haneda2026!") && reset.Resets == 2 && deep.Pending == null, "account: a redeemed transfer code drops it too");
    }
}
