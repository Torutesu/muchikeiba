// 昇級戦と降級の猶予 (REQ-PROMO-001..020, contracts/protocol.md §68): PromotionModel over a routed fake server. The start banner
// only on the race that started the series, the pips and 「昇級戦 2/3」, the outcome sheet through the session's one-prompt gate
// (inline only when another prompt showed), the ack (seen, never again), the offline copy for the home, the grace label,
// the kill switch (nothing shown), English for every line.
using System.Linq;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class PromotionChecks
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

    const string Player = "{\"id\":\"g\",\"wallet\":{\"paid\":0,\"free\":0,\"total\":0,\"debt\":0},\"season\":{\"id\":\"2026-11\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[],\"equipment\":{\"tack\":{},\"decor\":[]},\"deletion\":{\"status\":\"none\"}}";
    const string Rules = "\"rules\":{\"races\":3,\"needTop\":2,\"topPlace\":3,\"setbackPoints\":40,\"graceRaces\":10}";
    static string View(string series, bool enabled = true, string grace = "null") =>
        "{\"enabled\":" + (enabled ? "true" : "false") + ",\"seasonId\":\"2026-11\",\"classId\":\"C\",\"toClassId\":\"B\",\"line\":300,\"points\":320,\"earned\":320," + Rules +
        ",\"series\":" + series + ",\"passedThisSeason\":false,\"grace\":" + grace + ",\"shieldUsedThisSeason\":false}";
    static string Series(string status, string pips, int results, string next, bool seen = false, string setbackTo = "null") =>
        "{\"id\":\"2026-11:C:1\",\"status\":\"" + status + "\",\"races\":3,\"needTop\":2,\"topPlace\":3,\"results\":[" +
        string.Join(",", Enumerable.Range(0, results).Select(i => "{\"raceId\":\"r" + i + "\",\"place\":2,\"top\":true,\"cpu\":false}")) +
        "],\"pips\":[" + pips + "],\"next\":" + next + ",\"tops\":" + results + ",\"misses\":0,\"startedAt\":1,\"endedAt\":null,\"setbackTo\":" + setbackTo + ",\"seen\":" + (seen ? "true" : "false") + "}";

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset, string root)
    {
        var s = new FakeServer();
        string view = View("null");
        int acks = 0;
        s.Routes["POST /v1/player/bootstrap"] = _ => new HttpResponse(200, Player);
        s.Routes["GET /v1/player"] = _ => new HttpResponse(200, Player);
        s.Routes["GET /v1/promotion"] = _ => new HttpResponse(200, view);
        s.Routes["POST /v1/promotion/ack"] = r => { acks++; view = view.Replace("\"seen\":false", "\"seen\":true"); return new HttpResponse(200, "{\"seriesId\":\"2026-11:C:1\",\"seen\":true}"); };
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var kv = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, ruleset);
        await b.InitializeAsync();
        var gate = new SessionPrompts(); // R22 integration: the one §58.11 mechanism
        var m = new PromotionModel(b) { Prompts = gate };

        // no series yet: nothing on the home
        await m.RefreshAsync();
        check(m.HomeLabel == null && m.GraceLabel == null && m.ResultBanner == null, "promo: nothing before the line");

        // the race that reached the line: the start banner, three open pips
        view = View(Series("active", "\"open\",\"open\",\"open\"", 0, "1"));
        await m.AfterRankedResultAsync();
        check(m.ResultBanner == PromotionModel.StartBanner && m.Marks == "···" && m.HomeLabel == "昇級戦 1/3", "promo: start banner, pips, 「昇級戦 1/3」 (" + m.Marks + " / " + m.HomeLabel + ")");
        check(m.RuleLine == "3戦で3着以内が2回で突破", "promo: the rule line");

        // one top-3: no banner again, 「昇級戦 2/3」
        view = View(Series("active", "\"top\",\"open\",\"open\"", 1, "2"));
        await m.AfterRankedResultAsync();
        check(m.ResultBanner == null && m.Marks == "○··" && m.HomeLabel == "昇級戦 2/3" && !m.OutcomeSheetVisible, "promo: the second race is up, no banner");

        // offline: the home still says 「昇級戦 2/3」 from the copy
        var off = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, null, null, kv, ruleset);
        var mo = new PromotionModel(off);
        await mo.RefreshAsync();
        check(mo.HomeLabel == "昇級戦 2/3" && mo.Marks == "○··", "promo: offline copy for the home (" + mo.HomeLabel + ")");

        // passed while another prompt already showed this session: inline only, the sheet waits
        gate.TryClaim(SessionPrompts.ConsentPrePrompt);
        view = View(Series("passed", "\"top\",\"top\",\"skip\"", 2, "null"));
        await m.AfterRankedResultAsync();
        check(!m.OutcomeSheetVisible && m.OutcomeInline == "B級へ昇級確定" && m.Passed, "promo: the gate was taken → inline only");
        // next session's home: the sheet shows
        gate.NewSession();
        check(m.TryShowSheet() && m.OutcomeSheetVisible && gate.Claimed == SessionPrompts.PromotionOutcome, "promo: the sheet on the next home, through the gate");
        check(m.OutcomeTitle == "B級へ昇級確定" && m.OutcomeBody == "シーズンの締めでB級に上がります", "promo: pass sheet words");
        // R22 integration (§58.11): the sheet took this session's one prompt; the table puts it after the release notes and
        // before the reminders card / account link / review
        check(!gate.CanShow(SessionPrompts.RemindersPrePermission)
            && !new SessionPrompts().TryClaim(SessionPrompts.PromotionOutcome, new[] { SessionPrompts.ReleaseNotes })
            && new SessionPrompts().Pick(new[] { SessionPrompts.ReviewPrompt, SessionPrompts.RemindersPrePermission, SessionPrompts.PromotionOutcome }) == SessionPrompts.PromotionOutcome,
            "promo: promotion_outcome in the one table (after release notes, before reminders)");
        await m.CloseOutcomeAsync();
        check(acks == 1 && !m.OutcomeSheetVisible && m.View.Series.Seen && !m.TryShowSheet(), "promo: closed = seen, never again");
        check(s.Sent.Any(r => r.Path == "/v1/promotion/ack" && r.Body.Contains("2026-11:C:1")), "promo: ack carries the series id");

        // failed: the setback line
        view = View(Series("failed", "\"miss\",\"miss\",\"skip\"", 0, "null", false, "260"));
        gate.NewSession();
        await m.AfterRankedResultAsync();
        check(m.OutcomeSheetVisible && m.OutcomeTitle == "昇級ならず" && m.OutcomeBody == "ポイントは260ptに戻りました。あと40ptでもう一度挑めます", "promo: fail sheet with the setback (" + m.OutcomeBody + ")");
        await m.CloseOutcomeAsync();

        // grace window and the kill switch
        view = View("null", true, "{\"classId\":\"C\",\"racesLeft\":7}");
        await m.RefreshAsync();
        check(m.GraceLabel == "降級の猶予 残り7戦", "promo: the grace label");
        view = View(Series("active", "\"open\",\"open\",\"open\"", 0, "1"), false);
        await m.RefreshAsync();
        check(m.HomeLabel == null && m.GraceLabel == null, "promo: kill switch → nothing shown");

        // stream D (docs/quality/shopcfg.md): the retired 昇級記念パック's pattern is the free reward on reaching the class.
        // The passed sheet names it; after the close the claim moment shows it once (ack = seen); never while the outcome sheet is up.
        string names(string id) => id == "costume_promo_b" ? "B級昇級記念の勝負服の柄" : id == "costume_promo_a" ? "A級昇級記念の勝負服の柄" : id;
        m.ItemName = names;
        int rewardAcks = 0;
        s.Routes["POST /v1/promotion/ack"] = r =>
        {
            if (r.Body.Contains("rewardClassId")) { rewardAcks++; view = view.Replace(",\"reward\":{\"classId\":\"B\",\"seasonId\":\"2026-11\",\"items\":[{\"itemId\":\"costume_promo_b\",\"qty\":1}]}", ",\"reward\":null"); return new HttpResponse(200, "{\"classId\":\"B\",\"seen\":true}"); }
            acks++; view = view.Replace("\"seen\":false", "\"seen\":true"); return new HttpResponse(200, "{\"seriesId\":\"2026-11:C:1\",\"seen\":true}");
        };
        const string NextB = ",\"nextReward\":{\"classId\":\"B\",\"items\":[{\"itemId\":\"costume_promo_b\",\"qty\":1}]}";
        view = View(Series("passed", "\"top\",\"top\",\"skip\"", 2, "null")).Replace(",\"series\":", NextB + ",\"series\":");
        gate.NewSession();
        await m.AfterRankedResultAsync();
        check(m.OutcomeSheetVisible && m.OutcomeRewardLine == "B級に上がると：B級昇級記念の勝負服の柄", "promo reward: the passed sheet names the B pattern (" + m.OutcomeRewardLine + ")");
        check(!m.TryShowRewardMoment(), "promo reward: no moment while nothing was granted");
        await m.CloseOutcomeAsync();
        // the close granted it: the next home shows the moment once
        view = "{\"enabled\":true,\"seasonId\":\"2026-12\",\"classId\":\"B\",\"toClassId\":\"A\",\"line\":400,\"points\":0,\"earned\":0," + Rules +
            ",\"reward\":{\"classId\":\"B\",\"seasonId\":\"2026-11\",\"items\":[{\"itemId\":\"costume_promo_b\",\"qty\":1}]},\"nextReward\":{\"classId\":\"A\",\"items\":[{\"itemId\":\"costume_promo_a\",\"qty\":1}]},\"series\":null,\"passedThisSeason\":false,\"grace\":null,\"shieldUsedThisSeason\":false}";
        await m.RefreshAsync();
        check(m.TryShowRewardMoment() && m.RewardMomentVisible, "promo reward: the claim moment shows");
        check(m.RewardMomentTitle == "昇級の記念" && m.RewardMomentKicker == "B級に昇級" && m.RewardMomentItems == "B級昇級記念の勝負服の柄" && m.RewardMomentSub == "B級に昇級した記念です。勝負服の画面で着られます",
            "promo reward: moment words (" + m.RewardMomentKicker + " / " + m.RewardMomentItems + ")");
        check(m.OutcomeRewardLine == null, "promo reward: no reward line without a passed series");
        await m.CloseRewardMomentAsync();
        check(rewardAcks == 1 && !m.RewardMomentVisible && m.View.Reward == null, "promo reward: closed = acked with the class");
        check(s.Sent.Any(r => r.Path == "/v1/promotion/ack" && r.Body.Contains("\"rewardClassId\":\"B\"")), "promo reward: ack carries rewardClassId");
        await m.RefreshAsync();
        check(!m.TryShowRewardMoment(), "promo reward: never again");

        // stream D: the login bonus swap note (an owned 「翼」 → 2 breeding material)
        var swapped = new LoginBonusResult { Day = 3, Track = "normal", SwappedFrom = "costume_login", Reward = new Reward { Items = new List<ItemQty> { new ItemQty { ItemId = "breeding_material", Qty = 2 } } } };
        string lbNames(string id) => id == "costume_login" ? "記念の勝負服の柄「翼」" : id == "breeding_material" ? "配合素材" : id;
        check(LoginBonusModel.ToastFor(swapped, lbNames) == "ログインボーナス 3日目：配合素材×2", "login swap: the toast says what was given (" + LoginBonusModel.ToastFor(swapped, lbNames) + ")");
        check(LoginBonusModel.SwapNoteFor(swapped, lbNames) == "記念の勝負服の柄「翼」は持っているので、かわりに配合素材を受け取りました", "login swap: the note says why");
        check(LoginBonusModel.SwapNoteFor(new LoginBonusResult { Day = 3, Reward = new Reward() }, lbNames) == null, "login swap: no note without a swap");

        // English
        Loc.LoadEnglish(File.ReadAllText(Path.Combine(root, "engine", "Muchi.Client", "Resources", "Muchi", "server-en.json"))); // item names
        Loc.LoadEnglish(File.ReadAllText(Path.Combine(root, "engine", "Muchi.Client", "Resources", "Muchi", "ui-en.json")));
        try
        {
            Loc.SetLocale("en");
            foreach (var (ja, en) in new[] { ("昇級戦 2/3", "Promotion series 2/3"), ("B級へ昇級確定", "Promotion to Class B confirmed"), ("昇級ならず", "Not promoted this time"),
                         ("降級の猶予 残り7戦", "Demotion protection: 7 races left"), (PromotionModel.StartBanner, "Promotion series begins"), ("3戦で3着以内が2回で突破", "Win with 2 top-3 finishes in 3 races"),
                         ("昇級の記念", "Promotion keepsake"), ("B級に上がると：B級昇級記念の勝負服の柄", "Reach Class B for: Class B promotion silks pattern"),
                         ("B級に昇級した記念です。勝負服の画面で着られます", "A keepsake for reaching Class B. Wear it from the silks screen"),
                         ("記念の勝負服の柄「翼」は持っているので、かわりに配合素材を受け取りました", "You already have Commemorative silks pattern \"Wings\", so you got breeding material instead") })
                check(Loc.T(ja) == en, "promo: English for " + ja + " → " + Loc.T(ja));
        }
        finally { Loc.SetLocale("ja"); }
    }
}
