// 図鑑 / 実績 / 称号 (REQ-COL-*, REQ-ACH-*, REQ-TITLE-*): CollectionModel (tabs, silhouettes for unknown entries, counts,
// completion is display-only), AchievementModel (progress meter, keyed claims kept across a 5xx, claim-all, deletion
// block, no gacha / purchase wording) and TitleShowcaseModel (one title list, equip). Routed fake server.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class CollectionChecks
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

    const string PlayerJson = "{\"id\":\"c\",\"wallet\":{\"paid\":0,\"free\":500,\"total\":500,\"debt\":0},\"season\":{\"id\":\"2026-11\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[],\"equipment\":{\"tack\":{},\"decor\":[]}}";
    const string PlayerDeleting = "{\"id\":\"c\",\"wallet\":{\"paid\":0,\"free\":500,\"total\":500,\"debt\":0},\"season\":{\"id\":\"2026-11\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[],\"equipment\":{\"tack\":{},\"decor\":[]},\"deletion\":{\"status\":\"scheduled\",\"requestedAt\":1,\"deleteAt\":1796482800000}}";

    const string Book = "{\"sections\":{"
        + "\"horses\":{\"total\":3,\"obtained\":1,\"seen\":1,\"unknown\":1,\"completionPermille\":333,\"entries\":["
        + "{\"id\":\"t_partner\",\"state\":\"obtained\",\"rarity\":\"SR\",\"name\":\"アイボウ\",\"style\":\"sashi\",\"surface\":\"turf\",\"distance\":{\"minM\":1600,\"maxM\":2400},\"skillId\":\"sk_sueashi\",\"lore\":\"はじめての相棒。\",\"stats\":{\"speed\":600,\"stamina\":550,\"burst\":650,\"guts\":500,\"temper\":500},\"seasonal\":null,\"art\":\"collection/portrait/t_partner\"},"
        + "{\"id\":\"t_aozora\",\"state\":\"seen\",\"rarity\":\"R\",\"name\":\"アオゾラマーチ\",\"style\":\"nige\",\"surface\":\"turf\",\"distance\":{\"minM\":1200,\"maxM\":1800},\"skillId\":\"sk_ichibanyari\",\"lore\":\"元気な逃げ馬。\",\"stats\":null,\"seasonal\":null,\"art\":\"collection/portrait/t_aozora\"},"
        + "{\"id\":\"t_seiya\",\"state\":\"unknown\",\"rarity\":\"SSR\",\"name\":null,\"style\":null,\"surface\":null,\"distance\":null,\"skillId\":null,\"lore\":null,\"stats\":null,\"seasonal\":{\"label\":\"冬季限定\"},\"art\":\"collection/silhouette/t_seiya\"}]},"
        + "\"skills\":{\"total\":2,\"obtained\":1,\"seen\":0,\"unknown\":1,\"completionPermille\":500,\"entries\":[{\"id\":\"sk_sueashi\",\"state\":\"obtained\",\"rarity\":\"SR\",\"name\":\"末脚一閃\",\"styles\":[\"sashi\"],\"condition\":\"後方から\",\"effect\":\"速度+\",\"lore\":\"一閃\"},{\"id\":\"sk_goukyaku\",\"state\":\"unknown\",\"rarity\":\"SSR\",\"name\":null,\"styles\":null,\"condition\":null,\"effect\":null,\"lore\":null}]},"
        + "\"courses\":{\"total\":1,\"obtained\":1,\"seen\":0,\"unknown\":0,\"completionPermille\":1000,\"entries\":[{\"id\":\"aoba_turf_1600\",\"state\":\"obtained\",\"name\":\"青葉競馬場 芝1600m\",\"surface\":\"turf\",\"distanceM\":1600,\"lore\":\"マイル\",\"races\":4,\"wins\":1,\"bestFinishTick\":1700,\"timeAttackBestMs\":86100}]},"
        + "\"cosmetics\":{\"total\":1,\"obtained\":0,\"seen\":0,\"unknown\":1,\"completionPermille\":0,\"entries\":[{\"id\":\"decor_flower_box\",\"state\":\"unknown\",\"kind\":\"decor\",\"name\":\"花のプランター\",\"lore\":null,\"icon\":\"item/decor_flower_box\"}]}},"
        + "\"totals\":{\"total\":7,\"obtained\":3,\"seen\":1,\"unknown\":3,\"completionPermille\":428},\"completionRewards\":false,\"notice\":\"図鑑の達成率は記録の表示だけです。そろえても報酬はありません。\"}";

    static string Achievements(bool racesClaimed, bool blocked = false) =>
        "{\"achievements\":[{\"id\":\"races\",\"category\":\"race\",\"name\":\"出走の記録\",\"description\":\"出走する\",\"metric\":\"races\",\"progress\":40,\"nextTarget\":100,\"tier\":1,\"maxTier\":2,\"badge\":\"badge/races_1\","
        + "\"tiers\":[{\"tier\":1,\"target\":10,\"reward\":{\"freeCoins\":5},\"unlocked\":true,\"unlockedAt\":1,\"claimed\":" + (racesClaimed ? "true" : "false") + ",\"claimable\":" + (!racesClaimed && !blocked ? "true" : "false") + ",\"badge\":\"badge/races_1\"},"
        + "{\"tier\":2,\"target\":100,\"reward\":{\"freeCoins\":10},\"unlocked\":false,\"unlockedAt\":null,\"claimed\":false,\"claimable\":false,\"badge\":\"badge/races_2\"}],\"titles\":[]},"
        + "{\"id\":\"tournament_win\",\"category\":\"tournament\",\"name\":\"大会の覇者\",\"description\":\"優勝\",\"metric\":\"tournamentWins\",\"progress\":1,\"nextTarget\":null,\"tier\":1,\"maxTier\":1,\"badge\":\"badge/tournament_win_1\","
        + "\"tiers\":[{\"tier\":1,\"target\":1,\"reward\":{\"freeCoins\":20},\"unlocked\":true,\"unlockedAt\":2,\"claimed\":true,\"claimable\":false,\"badge\":\"badge/tournament_win_1\"}],"
        + "\"titles\":[{\"id\":\"ach_champion\",\"name\":\"大会の覇者\",\"tier\":1,\"unlocked\":true,\"icon\":\"title/ach_champion\"}]}],"
        + "\"blocked\":" + (blocked ? "true" : "false") + ",\"totals\":{\"tiers\":3,\"unlocked\":2,\"claimed\":" + (racesClaimed ? 2 : 1) + ",\"claimable\":" + (!racesClaimed && !blocked ? 1 : 0) + ",\"claimableCoins\":" + (!racesClaimed && !blocked ? 5 : 0) + ",\"earnedCoins\":20,\"totalCoins\":35},\"notice\":\"実績はレースや育成などのプレイで達成します。課金やガチャの回数では達成しません。報酬は無償コインです。\"}";

    const string Titles = "{\"equipped\":null,\"titles\":[{\"id\":\"debut\",\"name\":\"デビュー\",\"icon\":\"title/debut\",\"unlocked\":true,\"source\":\"record\"},"
        + "{\"id\":\"ach_champion\",\"name\":\"大会の覇者\",\"icon\":\"title/ach_champion\",\"unlocked\":true,\"source\":\"achievement\",\"achievementId\":\"tournament_win\",\"tier\":1},"
        + "{\"id\":\"ach_clockwork\",\"name\":\"時計の支配者\",\"icon\":\"title/ach_clockwork\",\"unlocked\":false,\"source\":\"achievement\",\"achievementId\":\"tournament_win\",\"tier\":1}]}";

    static HttpResponse Ok(string body) => new HttpResponse(200, body);

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        var s = new FakeServer();
        string player = PlayerJson;
        s.Routes["POST /v1/player/bootstrap"] = _ => Ok(player);
        s.Routes["GET /v1/player"] = _ => Ok(player);
        s.Routes["GET /v1/collection"] = _ => Ok(Book);
        bool claimed = false, blocked = false;
        s.Routes["GET /v1/achievements"] = _ => Ok(Achievements(claimed, blocked));
        int claimCalls = 0;
        s.Routes["POST /v1/achievements/races/tiers/1/claim"] = _ =>
        {
            if (++claimCalls == 1) return new HttpResponse(503, "{\"error\":{\"code\":\"INTERNAL\",\"message\":\"x\"}}");
            claimed = true;
            return Ok("{\"achievementId\":\"races\",\"tier\":1,\"reward\":{\"freeCoins\":5},\"wallet\":{\"free\":505,\"paid\":0}}");
        };
        s.Routes["POST /v1/achievements/claim-all"] = _ => { claimed = true; return Ok("{\"claimed\":[{\"achievementId\":\"races\",\"tier\":1,\"reward\":{\"freeCoins\":5}}],\"freeCoins\":5,\"wallet\":{\"free\":505,\"paid\":0}}"); };
        string equipped = null;
        s.Routes["GET /v1/titles"] = _ => Ok(Titles.Replace("\"equipped\":null", "\"equipped\":" + (equipped == null ? "null" : "\"" + equipped + "\"")));
        s.Routes["PUT /v1/player/title"] = r => { equipped = r.Body.Contains("ach_champion") ? "ach_champion" : null; return Ok("{\"titleId\":" + (equipped == null ? "null" : "\"" + equipped + "\"") + "}"); };
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var kv = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, ruleset);
        await b.InitializeAsync();

        // ---------------------------------------------------------------- 図鑑
        var c = new CollectionModel(b);
        await c.LoadAsync();
        check(c.TotalText == "図鑑 達成率 42%（3/7）", "collection: header shows completion and counts (" + c.TotalText + ")");
        check(c.TabCountsText == "入手 1 ・ 出会った 1 ・ 未発見 1" && Math.Abs(c.TabProgress - 1f / 3) < 1e-4, "collection: horse tab counts and meter");
        check(c.Cells.Count == 3 && c.Cells[0].Obtained && c.Cells[0].StatLines.Count == 5 && c.Cells[0].Title == "アイボウ", "collection: an obtained horse shows its stats");
        check(c.Cells[1].Seen && c.Cells[1].StateLabel == "出会った" && c.Cells[1].StatLines.Count == 0 && c.Cells[1].Lore != null, "collection: a seen horse shows name and lore, no stats");
        var unk = c.Cells[2];
        check(unk.Unknown && unk.Title == CollectionModel.Unknown && unk.Art == "collection/silhouette/t_seiya" && unk.Lore == null && unk.Badge == "冬季限定", "collection: an unknown horse is a silhouette with ？？？");
        check(c.Notice.Contains("報酬はありません") && !c.Book.CompletionRewards, "collection: completion pays nothing (notice from the server)");
        string allText = string.Join("|", c.Cells.Select(x => x.Title + x.Subtitle + x.Lore + x.StateLabel)) + c.TotalText + c.TabCountsText + c.Notice;
        check(!allText.Contains("スカウト") && !allText.Contains("ガチャ") && !allText.Contains("あと"), "collection: no scout / gacha / 'あと◯体' wording in the book");
        c.SetHideUnknown(true);
        check(c.Cells.Count == 2, "collection: hide unknown entries");
        c.SelectTab("skills");
        check(c.Cells.Count == 1 && c.Cells[0].StatLines[0] == "速度+", "collection: skills tab (unknown hidden), effect for an owned skill");
        c.SetHideUnknown(false);
        check(c.Cells[1].Title == CollectionModel.Unknown && c.Cells[1].Subtitle == "SSR", "collection: an unknown skill keeps only its rarity");
        c.SelectTab("courses");
        check(c.Cells[0].StateLabel == "走った" && c.Cells[0].StatLines.Contains("出走 4 ・ 1着 1") && c.Cells[0].StatLines.Contains("タイムアタック 1:26.1"), "collection: course with races, wins and the time-attack best");
        check(c.TabCountsText == "走った 1 / 1", "collection: course tab counts");
        c.SelectTab("cosmetics");
        check(c.Cells[0].StateLabel == "未所持" && c.Cells[0].Art == "item/decor_flower_box", "collection: cosmetics tab");
        c.SelectTab("horses");
        c.Open("t_partner");
        check(c.Selected != null && c.Selected.Id == "t_partner", "collection: open the detail panel");

        // ---------------------------------------------------------------- 実績
        var a = new AchievementModel(b);
        await a.LoadAsync();
        check(a.TotalText == "実績 2/3段" && a.CanClaimAll && a.ClaimAllText == "まとめて受け取る（1件・無償コイン5枚）", "achievements: totals and the claim-all button");
        var races = a.Rows[0];
        check(races.Id == "races" && races.ClaimTier == 1 && races.ClaimText == "無償コイン5枚" && races.ProgressText == "40/100" && Math.Abs(races.Meter - 30f / 90) < 1e-4, "achievements: claimable first, progress toward the next tier");
        check(races.Badges.Count == 2 && races.Badges[0].unlocked && !races.Badges[1].unlocked, "achievements: tier badges");
        var tw = a.Rows.Find(r => r.Id == "tournament_win");
        check(tw.ProgressText == "達成" && tw.Meter == 1f && tw.TitleTexts[0] == "称号「大会の覇者」（1段） 獲得済み", "achievements: a completed achievement and its title");
        string achText = string.Join("|", a.Rows.Select(r => r.Name + r.Description + r.ClaimText + string.Join("", r.TitleTexts))) + a.Notice + a.ClaimAllText;
        check(!achText.Contains("スカウト") && !achText.Contains("購入") && !achText.Contains("倍"), "achievements: no scout / purchase / '◯倍' wording (the notice says gacha and spending never count)");
        var first = await a.ClaimAsync("races");
        string kept = kv.Get(AchievementModel.KeyPending);
        check(!first.Ok && !string.IsNullOrEmpty(kept), "achievements: a 5xx keeps the claim's idempotency key");
        var second = await a.ClaimAsync("races");
        var keys = s.Sent.Where(r => r.Path == "/v1/achievements/races/tiers/1/claim").Select(r => r.Headers["idempotency-key"]).ToList();
        check(second.Ok && keys.Count == 2 && keys[0] == keys[1], "achievements: the retry reuses the key (never pays twice)");
        check(a.Toast == "実績「出走の記録」1段：無償コイン5枚" && !a.CanClaimAll && a.Rows.All(r => r.ClaimTier == null), "achievements: toast, and the list reloads after the claim");
        check(!(await a.ClaimAsync("races")).Ok, "achievements: nothing left to claim is refused locally");
        a.SelectCategory("tournament");
        check(a.Rows.Count == 1 && a.Rows[0].Id == "tournament_win", "achievements: category filter");

        claimed = false;
        var all = new AchievementModel(b);
        await all.LoadAsync();
        var ra = await all.ClaimAllAsync();
        check(ra.Ok && all.Toast == "1件の実績：無償コイン5枚", "achievements: claim-all");

        player = PlayerDeleting;
        await b.RefreshAsync();
        claimed = false; blocked = true;
        var del = new AchievementModel(b);
        await del.LoadAsync();
        int before = s.Sent.Count;
        check(del.Blocked && !del.CanClaimAll && del.Rows.All(r => r.ClaimTier == null) && del.BlockedText.StartsWith("アカウント削除の予定があります"), "achievements: deletion pending → nothing claimable, guard banner");
        check(!(await del.ClaimAllAsync()).Ok && s.Sent.Count == before, "achievements: a blocked claim is not sent");
        player = PlayerJson; blocked = false;
        await b.RefreshAsync();

        // ---------------------------------------------------------------- 称号
        var t = new TitleShowcaseModel(b);
        await t.LoadAsync();
        check(t.CountText == "2/3" && t.EquippedName == null, "titles: one list (records + achievement tiers)");
        var locked = t.Locked[0];
        check(t.HintFor(locked, a.Data) == "実績「大会の覇者」1段で獲得" && t.HintFor(t.Unlocked[0]) == null, "titles: a locked achievement title names its tier");
        check(!(await t.EquipAsync("ach_clockwork")).Ok, "titles: a locked title cannot be equipped");
        var eq = await t.EquipAsync("ach_champion");
        check(eq.Ok && t.EquippedId == "ach_champion" && t.EquippedName == "大会の覇者", "titles: equip an achievement title (profile and stable plate)");

        // ---------------------------------------------------------------- English (REQ-L10N-010): every text the models build
        // (server texts arrive in English; here the fake server's Japanese names are table entries or skipped)
        Loc.SetLocale("en");
        try
        {
            var built = new List<string> { c.TotalText, c.Notice, a.TotalText, a.Notice, t.HintFor(locked, a.Data), t.HintFor(t.Unlocked[0]) ?? "記録で獲得" };
            built.AddRange(CollectionModel.TabLabels.Values);
            built.AddRange(AchievementModel.CategoryLabels.Values);
            foreach (var tab in CollectionModel.Tabs)
            {
                c.SelectTab(tab);
                built.Add(c.TabCountsText);
                foreach (var cell in c.Cells)
                {
                    built.Add(cell.StateLabel); if (tab != "skills") built.Add(cell.Subtitle);
                    if (tab != "skills") built.AddRange(cell.StatLines);
                }
            }
            c.SelectTab("horses");
            foreach (var r in a.Rows) { built.Add(r.ProgressText); built.Add(r.ClaimText); built.AddRange(r.TitleTexts); }
            built.AddRange(new[] { "まとめて受け取る（1件・無償コイン5枚）", "実績「出走の記録」1段：無償コイン5枚", "1件の実績：無償コイン5枚", "称号「大会の覇者」（1段）",
                "図鑑はオンラインで表示されます", "実績はオンラインで表示されます", "称号はオンラインで表示されます", "称号はオンラインで変更できます", "SR ・ 先行 ・ 芝・ダート 1200〜2000m" });
            var bad = built.Where(x => x != null && Loc.HasJapanese(Loc.T(x))).ToList();
            check(Loc.English.Count > 0 && bad.Count == 0, "collection / achievements / titles: every text the models build reads in English (" + built.Count + ")" + (bad.Count > 0 ? ": " + string.Join(" | ", bad) : ""));
            check(Loc.T(c.TotalText) == "Collection 42% complete (3/7)" && Loc.T("出走 4 ・ 1着 1") == "Races 4 · Wins 1", "collection in English: " + Loc.T(c.TotalText));
        }
        finally { Loc.SetLocale("ja"); }

        var off = new GameBackend(new GameSettings { OfflineOnly = true }, null, null, new MemoryKeyValueStore(), ruleset);
        await off.InitializeAsync();
        var co = new CollectionModel(off);
        var ao = new AchievementModel(off);
        check(!(await co.LoadAsync()).Ok && co.Cells.Count == 0 && !(await ao.LoadAsync()).Ok && ao.Rows.Count == 0, "collection / achievements: offline → empty with a notice");
    }
}
