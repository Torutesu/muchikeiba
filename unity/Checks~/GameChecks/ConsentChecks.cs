// 広告・分析の同意管理 (REQ-CNS-007..017, contracts/protocol.md §58): ConsentModel over a routed fake server and a fake
// IConsentPlatform. When the pre-prompt shows (never in the tutorial / a race, the server's moment), 「続ける」 on iOS asks
// ATT once and saves its answer, 「あとで」 never asks ATT, the settings rows and their reasons, the denied-ATT path to the
// OS settings, the UMP review, the IAdConsent answer, the analytics gate, and English for every text.
using System.Text.RegularExpressions;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class ConsentChecks
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

    internal sealed class Platform : IConsentPlatform
    {
        public string Os { get; set; } = "ios";
        public AttStatus AttStatus { get; set; } = AttStatus.NotDetermined;
        public AttStatus Answer = AttStatus.Authorized;
        public int AttAsked, CmpGathered, OptionsShown, SettingsOpened;
        public bool Gdpr;
        public Task<AttStatus> RequestAttAsync(CancellationToken ct) { AttAsked++; if (AttStatus == AttStatus.NotDetermined) AttStatus = Answer; return Task.FromResult(AttStatus); }
        public Task<CmpResult> GatherCmpAsync(bool u, CancellationToken ct) { CmpGathered++; return Task.FromResult(new CmpResult { GdprApplies = Gdpr, Status = Gdpr ? CmpStatus.Obtained : CmpStatus.NotRequired }); }
        public bool PrivacyOptionsRequired => Gdpr;
        public Task<CmpResult> ShowPrivacyOptionsAsync(CancellationToken ct) { OptionsShown++; return Task.FromResult(new CmpResult { GdprApplies = true, Status = CmpStatus.Obtained }); }
        public void OpenAppSettings() => SettingsOpened++;
    }

    const string Player = "{\"id\":\"u1\",\"wallet\":{\"paid\":0,\"free\":0,\"total\":0,\"debt\":0},\"season\":{\"id\":\"2026-11\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[],\"equipment\":{\"tack\":{},\"decor\":[]},\"deletion\":{\"status\":\"none\"}}";

    /// <summary>A tiny copy of the server rules (privacyChoices.ts) good enough to drive the model.</summary>
    internal sealed class Rules
    {
        public string Version = "2026-11-01", Decided, Prompt = "ad_offer", ShownVersion, Os, Att, Cmp;
        public bool? Ads, Analytics;
        public bool Adult = true, Gdpr;
        public string View()
        {
            bool required = Decided != Version;
            string prompt = required && ShownVersion != Version ? Prompt : null;
            bool adsValue = Ads ?? false;
            string lockAds = !Adult ? "age_unknown" : Os == "ios" && Att != "authorized" ? "att" : Gdpr && Cmp != "obtained" ? "cmp" : null;
            bool an = Analytics ?? !Gdpr;
            bool eff = adsValue && lockAds == null;
            return "{\"policyVersion\":\"" + Version + "\",\"decidedVersion\":" + (Decided == null ? "null" : "\"" + Decided + "\"") + ",\"rev\":1,\"required\":" + (required ? "true" : "false")
                + ",\"prompt\":" + (prompt == null ? "null" : "\"" + prompt + "\"") + ",\"minor\":false,"
                + "\"personalizedAds\":{\"value\":" + B(adsValue) + ",\"effective\":" + B(eff) + ",\"locked\":" + (lockAds == null ? "null" : "\"" + lockAds + "\"") + "},"
                + "\"analytics\":{\"value\":" + B(an) + ",\"effective\":" + B(an) + ",\"locked\":null},"
                + "\"platform\":" + (Os == null ? "null" : "{\"os\":\"" + Os + "\",\"att\":" + (Att == null ? "null" : "\"" + Att + "\"") + ",\"gdprApplies\":" + B(Gdpr) + ",\"cmp\":" + (Cmp == null ? "null" : "\"" + Cmp + "\"") + "}") + ","
                + "\"adRequest\":{\"npa\":" + (eff ? "0" : "1") + ",\"nonPersonalized\":" + B(!eff) + ",\"extras\":" + (eff ? "{}" : "{\"npa\":\"1\"}") + "},\"kpi\":{\"optional\":" + B(an) + "}}";
        }
        static string B(bool b) => b ? "true" : "false";
    }

    static string Field(string body, string key)
    {
        var m = Regex.Match(body ?? "", "\"" + key + "\":(\"[^\"]*\"|true|false|null)");
        return m.Success ? m.Groups[1].Value.Trim('"') : null;
    }

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        var s = new FakeServer();
        var rules = new Rules();
        s.Routes["POST /v1/player/bootstrap"] = _ => new HttpResponse(200, Player);
        s.Routes["GET /v1/player"] = _ => new HttpResponse(200, Player);
        s.Routes["GET /v1/privacy/choices"] = _ => new HttpResponse(200, rules.View());
        s.Routes["POST /v1/privacy/prompt-shown"] = r =>
        {
            if (Field(r.Body, "privacyVersion") != rules.Version) return new HttpResponse(409, "{\"error\":{\"code\":\"CONSENT_VERSION_MISMATCH\",\"message\":\"stale\"}}");
            rules.ShownVersion = rules.Version; return new HttpResponse(200, rules.View());
        };
        s.Routes["PUT /v1/privacy/platform"] = r =>
        {
            rules.Os = Field(r.Body, "os"); var a = Field(r.Body, "att"); if (a != null) rules.Att = a;
            var c = Field(r.Body, "cmp"); if (c != null) rules.Cmp = c; var g = Field(r.Body, "gdprApplies"); if (g != null) rules.Gdpr = g == "true";
            return new HttpResponse(200, rules.View());
        };
        s.Routes["PUT /v1/privacy/choices"] = r =>
        {
            if (Field(r.Body, "privacyVersion") != rules.Version) return new HttpResponse(409, "{\"error\":{\"code\":\"CONSENT_VERSION_MISMATCH\",\"message\":\"stale\"}}");
            var ads = Field(r.Body, "personalizedAds"); var an = Field(r.Body, "analytics");
            if (ads != null) rules.Ads = ads == "true"; if (an != null) rules.Analytics = an == "true";
            rules.Decided = rules.Version; return new HttpResponse(200, rules.View());
        };
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, new MemoryKeyValueStore(), ruleset);
        await b.InitializeAsync();
        var ios = new Platform();
        var m = new ConsentModel(b, ios);

        check((await m.LoadAsync()).Ok && m.State.Required, "cns: loaded, a decision is required");
        check(s.Sent.Any(r => r.Path == "/v1/privacy/platform" && r.Body.Contains("not_determined")), "cns: the device's ATT status is reported on load");
        check(m.ShouldShowPrePrompt(ConsentMoment.BeforeAdOffer) && !m.ShouldShowPrePrompt(ConsentMoment.Home), "cns: first time → right before the ad offer, not on the home");
        check(!m.ShouldShowPrePrompt(ConsentMoment.Tutorial) && !m.ShouldShowPrePrompt(ConsentMoment.Race) && !m.ShouldShowPrePrompt(ConsentMoment.BeforeAdOffer, online: false), "cns: never in the tutorial, a race, or offline");
        var sheet = m.BuildPrePrompt();
        check(sheet.AttNext && sheet.Lines.Contains(ConsentModel.TextPromptAtt) && sheet.Lines.Contains(ConsentModel.TextPromptPersonal), "cns: iOS sheet says why and that the device asks next");
        var copy = string.Join("", sheet.Lines) + sheet.Title + sheet.Continue;
        check(!copy.Contains("お得") && !copy.Contains("今だけ") && !copy.Contains("倍") && !copy.Contains("残りわずか"), "cns: no pressure words on the sheet");

        // 「あとで」: no ATT, seen once
        var later = await m.LaterAsync();
        check(later.Ok && ios.AttAsked == 0 && !m.ShouldShowPrePrompt(ConsentMoment.BeforeAdOffer) && m.State.Required, "cns: later → ATT not shown, the sheet not again this version, still undecided");

        // a new policy version: the sheet again (home), then 「続ける」 → ATT once → saved
        rules.Version = "2027-01-01"; rules.Prompt = "next_home";
        await m.LoadAsync();
        check(m.ShouldShowPrePrompt(ConsentMoment.Home), "cns: a policy update asks again on the home");
        var ok = await m.AcceptAsync(personalizedAds: false, analytics: true);
        check(ok.Ok && ios.AttAsked == 1 && rules.Att == "authorized" && rules.Ads == true && rules.Decided == "2027-01-01", "cns: continue → ATT asked once, its answer is the personalised-ads choice, decided under the new version");
        check(!m.ShouldShowPrePrompt(ConsentMoment.Home) && !m.State.Required, "cns: decided → no sheet");
        check(m.PolicyVersionText == "プライバシーポリシー 2027-01-01版", "cns: the policy version line (" + m.PolicyVersionText + ")");

        // settings rows: age unknown → the reason; IAdConsent says no
        rules.Adult = false; await m.LoadAsync();
        var rows = m.Rows();
        check(rows[0].Key == "personalized_ads" && rows[0].Note == ConsentModel.TextLockAgeUnknown && rows[1].Key == "analytics" && rows[1].Note == ConsentModel.TextAnalyticsNote, "cns: rows with their notes");
        check(!await m.PersonalizedAllowedAsync(default) && m.AdRequest.NonPersonalized, "cns: IAdConsent: not personalised while the age is unknown");
        rules.Adult = true; await m.LoadAsync();
        check(await m.PersonalizedAllowedAsync(default) && !m.AdRequest.NonPersonalized, "cns: IAdConsent: personalised once everything allows it");

        // ATT denied in the OS settings: resume reports it, the row opens the OS settings, turning on does not ask ATT again
        ios.AttStatus = AttStatus.Denied;
        await m.SyncPlatformAsync();
        check(rules.Att == "denied" && !await m.PersonalizedAllowedAsync(default), "cns: an ATT change in the OS settings is reported on resume");
        rows = m.Rows();
        check(rows[0].Action == ConsentRowAction.OpenOsSettings && !rows[0].Value, "cns: denied ATT → the row opens the device settings");
        var on = await m.SetPersonalizedAdsAsync(true);
        check(!on.Ok && ios.SettingsOpened == 1 && ios.AttAsked == 1, "cns: turning on with ATT denied opens the OS settings (no second ATT)");

        // analytics switch + the gate
        var analytics = new AnalyticsClient((pl, v, evs, ct) => Task.FromResult(new AnalyticsIngestResult { Accepted = evs.Count }), new AnalyticsOptions());
        m.Attach(analytics);
        check((await m.SetAnalyticsAsync(false)).Ok && rules.Analytics == false, "cns: analytics off is saved");
        analytics.Track(AnalyticsEvent.SessionStart(1));
        check(analytics.Pending == 0 && analytics.Withheld == 1, "cns: with analytics off the device drops optional events");
        await m.SetAnalyticsAsync(true);
        analytics.Track(AnalyticsEvent.SessionStart(2));
        check(analytics.Pending == 1, "cns: analytics on → events queue again");

        // Android in the EEA: UMP on continue, the review row, the cmp reason
        rules.Decided = null; rules.ShownVersion = null; rules.Prompt = "ad_offer"; rules.Ads = null; rules.Analytics = null; rules.Att = null; rules.Cmp = null; rules.Gdpr = true;
        var droid = new Platform { Os = "android", AttStatus = AttStatus.Unavailable, Gdpr = true };
        var m2 = new ConsentModel(b, droid);
        await m2.LoadAsync();
        check(m2.BuildPrePrompt().AttNext == false && !m2.BuildPrePrompt().Lines.Contains(ConsentModel.TextPromptAtt), "cns: no ATT line off iOS");
        check(!m2.State.Analytics.Value, "cns: EEA → analytics off until chosen");
        var acc = await m2.AcceptAsync(personalizedAds: true, analytics: false);
        check(acc.Ok && droid.CmpGathered == 1 && droid.AttAsked == 0 && rules.Cmp == "obtained" && rules.Ads == true && rules.Analytics == false, "cns: EEA continue → UMP gathered, choices saved, no ATT");
        check(m2.Rows().Any(r => r.Key == "review" && r.Action == ConsentRowAction.ReviewAdConsent), "cns: EEA → 「広告の同意を見直す」 row");
        check((await m2.ReviewAdConsentAsync()).Ok && droid.OptionsShown == 1, "cns: the review opens UMP's privacy options");

        // stale version on save → reload and say so
        rules.Version = "2027-02-01";
        var stale = await m2.SetAnalyticsAsync(true);
        check(!stale.Ok && stale.Message == ConsentModel.TextStale && m2.State.PolicyVersion == "2027-02-01", "cns: a stale version reloads and asks to check again");

        Loc.LoadEnglish(File.ReadAllText(Path.Combine(FindRoot(), "engine", "Muchi.Client", "Resources", "Muchi", "ui-en.json")));
        Loc.SetLocale("en");
        try
        {
            var texts = new[] { ConsentModel.TextSection, ConsentModel.TextPromptTitle, ConsentModel.TextPromptAds, ConsentModel.TextPromptPersonal, ConsentModel.TextPromptAnalytics,
                ConsentModel.TextPromptAtt, ConsentModel.TextPromptChange, ConsentModel.TextContinue, ConsentModel.TextLater, ConsentModel.TextPersonalizedAds, ConsentModel.TextAnalytics,
                ConsentModel.TextReview, ConsentModel.TextOpenSettings, ConsentModel.TextLockMinor, ConsentModel.TextLockMinorAnalytics, ConsentModel.TextLockUnder18,
                ConsentModel.TextLockAgeUnknown, ConsentModel.TextLockAtt, ConsentModel.TextLockCmp, ConsentModel.TextAnalyticsNote, ConsentModel.TextSaved, ConsentModel.TextOffline, ConsentModel.TextStale };
            var left = texts.Where(t => Loc.HasJapanese(Loc.T(t))).ToList();
            check(left.Count == 0, "cns: every model text has English (" + string.Join(" | ", left) + ")");
            check(m2.PolicyVersionText == "Privacy policy 2027-02-01 version", "cns: the version line in English (" + m2.PolicyVersionText + ")");
            check(m2.Rows().All(r => !Loc.HasJapanese(r.Label ?? "") && !Loc.HasJapanese(r.Note ?? "")), "cns: rows in English");
        }
        finally { Loc.SetLocale("ja"); }
    }

    static string FindRoot()
    {
        var d = new DirectoryInfo(AppContext.BaseDirectory);
        while (d != null && !File.Exists(Path.Combine(d.FullName, "contracts", "protocol.md"))) d = d.Parent;
        return d!.FullName;
    }
}
