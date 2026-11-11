// レビュー依頼のタイミング (REQ-REV-001..016, contracts/protocol.md §59): ReviewPromptModel over a routed fake server and a fake
// IStoreReview. Not asked offline / without the OS API / during the FTUE / twice in a session / right after a loss or an error
// (the device pre-check skips the server call); native style calls the OS API once and reports native_requested; soft style
// shows the sheet, はい → the OS API, いまいち → the help inquiry form and never the store; English for the sheet; no reward words.
using System.Linq;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class ReviewPromptChecks
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
    sealed class FakeStore : IStoreReview
    {
        public bool Available { get; set; } = true;
        public string Platform => "ios";
        public int Calls;
        public Task RequestReviewAsync(CancellationToken ct = default) { Calls++; return Task.CompletedTask; }
    }

    const long Now = 1796698800000L;
    const string Player = "{\"id\":\"g\",\"wallet\":{\"paid\":0,\"free\":0,\"total\":0,\"debt\":0},\"season\":{\"id\":\"2026-12\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[],\"equipment\":{\"tack\":{},\"decor\":[]},\"deletion\":{\"status\":\"none\"}}";
    static string Status(bool soft) => "{\"v\":1,\"rules\":{\"enabled\":true,\"moments\":[\"first_win\",\"first_tournament_win\",\"hall_induction\",\"horse_goal_chain\"],\"minDaysSinceInstall\":3,\"minRacesPlayed\":10,\"maxPerYear\":3,\"coolDownDays\":120," +
        "\"quietMinutes\":{\"loss\":30,\"purchase\":1440,\"refund\":43200,\"error\":30,\"maintenanceNotice\":60},\"softAsk\":{\"ios\":" + (soft ? "true" : "false") + ",\"android\":false}},\"history\":{\"count365\":0,\"lastAt\":null}," +
        "\"serverSummary\":{\"installedAt\":1790000000000,\"racesPlayed\":20,\"inFtue\":false,\"accountClosing\":false,\"maintenanceVisible\":false,\"coinDebt\":false,\"minutesSincePurchase\":null,\"minutesSinceRefund\":null,\"lastSessionId\":null,\"history\":[]}}";

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset, string root)
    {
        bool soft = false;
        var s = new FakeServer();
        s.Routes["POST /v1/player/bootstrap"] = _ => new HttpResponse(200, Player);
        s.Routes["GET /v1/player"] = _ => new HttpResponse(200, Player);
        s.Routes["GET /v1/review-prompt"] = _ => new HttpResponse(200, Status(soft));
        s.Routes["POST /v1/review-prompt/check"] = _ => new HttpResponse(200, "{\"v\":1,\"show\":true,\"style\":\"" + (soft ? "soft" : "native") + "\",\"reason\":null,\"promptId\":\"rp_1\"}");
        string lastStep = null;
        s.Routes["POST /v1/review-prompt/rp_1/answer"] = r =>
        {
            lastStep = r.Body.Contains("soft_no") ? "soft_no" : r.Body.Contains("soft_yes") ? "soft_yes" : r.Body.Contains("soft_dismiss") ? "soft_dismiss" : "native_requested";
            string next = lastStep == "soft_yes" ? "store_review" : lastStep == "soft_no" ? "help_inquiry" : "none";
            return new HttpResponse(200, "{\"promptId\":\"rp_1\",\"next\":\"" + next + "\",\"helpCategory\":" + (lastStep == "soft_no" ? "\"other\"" : "null") + "}");
        };
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, new MemoryKeyValueStore(), ruleset);
        await b.InitializeAsync();
        long now = Now;
        int Checks() => s.Sent.Count(r => r.Path == "/v1/review-prompt/check");

        // the OS API missing (editor) or the FTUE: nothing is sent
        var store = new FakeStore { Available = false };
        var m0 = new ReviewPromptModel(b, store, null, () => now, "sess_check_000");
        check(await m0.OnMomentAsync(ReviewMoments.FirstWin) == ReviewOutcome.Skipped && m0.LastReason == "unavailable" && s.Sent.All(r => !r.Path.StartsWith("/v1/review-prompt")), "review: no OS API → never asked, no request");
        store.Available = true;
        bool ftue = true;
        var m1 = new ReviewPromptModel(b, store, () => ftue, () => now, "sess_check_001");
        check(await m1.OnMomentAsync(ReviewMoments.FirstWin) == ReviewOutcome.Skipped && m1.LastReason == "ftue" && Checks() == 0, "review: during the FTUE → not asked");
        ftue = false;

        // right after a loss / an error: the device pre-check says no without the check call
        m1.NoteLoss();
        check(await m1.OnMomentAsync(ReviewMoments.FirstWin) == ReviewOutcome.Skipped && m1.LastReason == "loss" && Checks() == 0, "review: a loss 0 min ago → loss (no check call)");
        now += 31 * 60_000;
        m1.NoteError();
        check(await m1.OnMomentAsync(ReviewMoments.FirstWin) == ReviewOutcome.Skipped && m1.LastReason == "error" && Checks() == 0, "review: an error dialog just now → error");
        now += 31 * 60_000;
        check(await m1.OnMomentAsync("shop_visit") == ReviewOutcome.Skipped && m1.LastReason == "moment", "review: an unknown moment → not asked");

        // native: the OS API once, native_requested reported, then never again this session
        var o = await m1.OnMomentAsync(ReviewMoments.FirstWin);
        check(o == ReviewOutcome.NativeRequested && store.Calls == 1 && lastStep == "native_requested" && m1.SessionPrompted && Checks() == 1, "review: native → the OS API once and native_requested");
        check(await m1.OnMomentAsync(ReviewMoments.HallInduction) == ReviewOutcome.Skipped && m1.LastReason == "session" && store.Calls == 1 && Checks() == 1, "review: never twice in one session");

        // soft (ops on, iOS): the sheet; いまいち → the inquiry form, never the store
        soft = true;
        var m2 = new ReviewPromptModel(b, store, null, () => now, "sess_check_002");
        check(await m2.OnMomentAsync(ReviewMoments.HorseGoalChain) == ReviewOutcome.SoftShown && m2.SoftSheetVisible && store.Calls == 1, "review: soft → the pre-question sheet, no OS call yet");
        check(await m2.OnMomentAsync(ReviewMoments.FirstWin) == ReviewOutcome.Skipped, "review: no second moment while the sheet is up");
        var a = await m2.AnswerSoftAsync("soft_no");
        check(a.Ok && !m2.SoftSheetVisible && m2.OpenInquiryCategory == "other" && store.Calls == 1 && lastStep == "soft_no", "review: いまいち → help inquiry (other), the store is not asked");
        m2.InquiryOpened();
        check(m2.OpenInquiryCategory == null, "review: the inquiry flag clears once opened");
        var m3 = new ReviewPromptModel(b, store, null, () => now, "sess_check_003");
        await m3.OnMomentAsync(ReviewMoments.FirstTournamentWin);
        await m3.AnswerSoftAsync("soft_yes");
        check(store.Calls == 2 && lastStep == "native_requested" && m3.OpenInquiryCategory == null, "review: はい → the OS API and native_requested");
        var m4 = new ReviewPromptModel(b, store, null, () => now, "sess_check_004");
        await m4.OnMomentAsync(ReviewMoments.FirstWin);
        await m4.AnswerSoftAsync("soft_dismiss");
        check(store.Calls == 2 && lastStep == "soft_dismiss" && !m4.SoftSheetVisible, "review: 閉じる → nothing more");

        // offline: never asked
        var off = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, null, null, new MemoryKeyValueStore(), ruleset);
        var m5 = new ReviewPromptModel(off, store, null, () => now, "sess_check_005");
        check(await m5.OnMomentAsync(ReviewMoments.FirstWin) == ReviewOutcome.Skipped && m5.LastReason == "offline", "review: offline → not asked");

        // English for the sheet; no reward / urgency / star words
        Loc.LoadEnglish(File.ReadAllText(Path.Combine(root, "engine", "Muchi.Client", "Resources", "Muchi", "ui-en.json")));
        Loc.SetLocale("en");
        try
        {
            foreach (var t in new[] { ReviewPromptModel.SoftQuestion, ReviewPromptModel.YesLabel, ReviewPromptModel.NoLabel, ReviewPromptModel.CloseLabel, ReviewPromptModel.SoftKicker, ReviewPromptModel.FeedbackLead })
                check(!Loc.HasJapanese(Loc.T(t)), "review: English for " + t + " → " + Loc.T(t));
        }
        finally { Loc.SetLocale("ja"); }
        var all = string.Join(" ", ReviewPromptModel.SoftQuestion, ReviewPromptModel.YesLabel, ReviewPromptModel.NoLabel, ReviewPromptModel.CloseLabel, ReviewPromptModel.SoftKicker, ReviewPromptModel.FeedbackLead);
        check(new[] { "報酬", "もらえる", "プレゼント", "コイン", "★", "倍", "今だけ", "お得", "残りわずか" }.All(w => !all.Contains(w)), "review: no reward, star or urgency words on the sheet");
    }
}
