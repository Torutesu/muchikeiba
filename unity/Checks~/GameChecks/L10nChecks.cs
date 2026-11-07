// Round 11: English (REQ-L10N-009..012). The game layer builds Japanese and the screens show Loc.T(text); these checks
// load the shipped English tables and assert that what the game layer can say comes out in English: every whole
// Japanese literal of Assets/Muchi/Game and the client texts (RaceDebrief, RaceFeel, ReplayClip), the composite lines
// (rewards, margins, dates, debriefs), English commentary of a full race, and the language reaching the API client.
using System.Text.RegularExpressions;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class L10nChecks
{
    static string Res(string root, string f) => File.ReadAllText(Path.Combine(root, "engine", "Muchi.Client", "Resources", "Muchi", f));

    /// <summary>A whole literal: the full value of an assignment / return / argument / dictionary entry (not a piece of a `+` concatenation).</summary>
    static readonly Regex WholeLiteral = new Regex(@"(?<=(=|return|\(|\?|:|,|=>)\s*)""((?:[^""\\]|\\.)*)""(?=\s*(;|,|\)|\}|:|\?\?))");
    static readonly Regex Japanese = new Regex("[぀-ヿ一-鿿]");

    public static async Task Run(Action<bool, string> check, string root, RulesetParams rs)
    {
        Loc.LoadEnglish(Res(root, "server-en.json"));
        Loc.LoadEnglish(Res(root, "ui-en.json"));
        try
        {
            Loc.SetLocale("en");
            Literals(check, root);
            Composites(check);
            Commentary(check, root, rs);
            await ApiLocale(check);
        }
        finally { Loc.SetLocale("ja"); }
        check(Loc.T("再試行") == "再試行", "back in Japanese: Loc.T is the identity (the Japanese UI is unchanged)");
    }

    static void Literals(Action<bool, string> check, string root)
    {
        var files = Directory.GetFiles(Path.Combine(root, "unity", "Assets", "Muchi", "Game"), "*.cs")
            .Concat(new[] { "RaceDebrief.cs", "RaceFeel.cs", "ReplayClip.cs" }.Select(f => Path.Combine(root, "engine", "Muchi.Client", f)));
        // not shown as text: the forbidden-word list of the shop lint, kana test characters
        var skip = new HashSet<string> { "倍", "×2", "お得", "通常価格" };
        // pieces of a concatenation chosen by a ternary (the whole line is checked in Composites)
        skip.UnionWith(new[] { "に開放", "で開放", "（不参加）", "今日 ", "明日 ", "（交換できます）", "1着！", "差し切った", "馬身半", "馬身", "半", "芝", "ダート", "走った ", "所持 ", " 獲得済み" });
        int total = 0;
        var missing = new List<string>();
        foreach (var f in files)
        {
            foreach (var raw in File.ReadAllLines(f))
            {
                var line = raw.TrimStart();
                if (line.StartsWith("//") || line.StartsWith("*") || line.StartsWith("///")) continue;
                int c = line.IndexOf(" // ", StringComparison.Ordinal);
                if (c >= 0) line = line.Substring(0, c);
                foreach (Match m in WholeLiteral.Matches(line))
                {
                    string s = Regex.Unescape(m.Groups[2].Value);
                    if (!Japanese.IsMatch(s) || skip.Contains(s)) continue;
                    total++;
                    var t = Loc.T(s);
                    if (Loc.HasJapanese(t)) missing.Add(Path.GetFileName(f) + ": " + s);
                }
            }
        }
        check(total > 150 && missing.Count == 0, "every whole Japanese literal of the game layer has English (" + total + " literals" + (missing.Count > 0 ? "; missing: " + string.Join(" | ", missing.Take(12)) : "") + ")");
    }

    static void Composites(Action<bool, string> check)
    {
        bool En(string s) => s != null && !Loc.HasJapanese(s);
        // UxText: every error code, unknown codes, rewards
        check(UxText.Errors.Keys.All(k => En(UxText.For(new ConflictException(ApiErrorCode.Unknown, k, k, 409)))), "UxText.For: every error code reads in English");
        check(UxText.For(new ConflictException(ApiErrorCode.Unknown, "SOMETHING_NEW", "x", 409)) == "Connection failed (SOMETHING_NEW)", "UxText.For: unknown codes fall back to an English line");
        var reward = new Reward { FreeCoins = 50, PassXp = 100 };
        reward.Items.Add(new ItemQty { ItemId = "gacha_ticket", Qty = 1 });
        string r = UxText.Reward(reward, InviteModel.DefaultItemName);
        check(r == "50 free coins, Scout Ticket ×1, Pass XP 100", "UxText.Reward in English: " + r);
        // margins, every bucket
        var margins = Enumerable.Range(0, 120).Select(i => RaceFeel.MarginText(i * 500L)).Distinct().ToList();
        check(margins.All(m => En(Loc.T(m))), "every margin (nose … a distance) has English: " + string.Join(", ", margins.Select(m => Loc.T(m)).Take(9)));
        // dates and clocks
        long now = 1795575600000L; // 2026-11-25 12:00 JST
        var dates = new[] { GameDay.NextResetLabel(now), GameDay.UntilLabel(now + 86_400_000L * 3), GameDay.RemainingLabel(1), GameDay.RemainingLabel(5), DeletionGuard.Banner(now + 86_400_000L * 14), DeletionGuard.Banner((long?)null), AllowanceModel.KeyLabel("2026-12-04") };
        check(dates.All(d => En(Loc.T(d))), "dates and deadlines in English: " + string.Join(" | ", dates.Select(d => Loc.T(d))));
        // labels by id
        var labels = new[] { "nige", "senko", "sashi", "oikomi" }.Select(RaceFactory.StyleLabel)
            .Concat(new[] { "scheduled", "registration", "running", "paying", "finished", "cancelled" }.Select(TournamentsBackend.StatusLabel))
            .Concat(new[] { "tournament", "event", "friend", "ranked" }.Select(TournamentsBackend.ModeLabel)).ToList();
        check(labels.All(l => En(Loc.T(l))), "running styles, tournament states and race modes in English");
        // lines built from parts (the forms the models produce)
        var lines = new[]
        {
            "交換pt 37 / 100（あと63回・6,300コイン）", "ステップ2を引きました。次はステップ3（10連 1,000コイン・10枠目はSSRの表から）", "有償 1,000・無償 500 コインを使いました",
            "有償コインのみ ・ 1回 100 ・ 10回 1,000（SR以上1頭確定）", "残り 3日 4時間", "残り 05:12:33", "新規 7頭・ダブり 3頭（覚醒素材 +30）",
            "あと2戦 または 配合あと1回で開放", "7日目に開放", "ログインボーナス 3日目", "今日の分は完了。明日 4:00 に更新", "初勝利ボーナス 残り2回（次は30コイン）",
            "B級  120pt", "厩舎手当 3/30日目・残り27日（12月4日まで）・今日は受取済み", "シーズン終了まで（11月30日 23:59まで）・自動更新なし",
            "Lv.12  次まで80XP（あと2戦）", "残り200mのムチで3頭抜いた", "残り300mからのムチが1回だけ。あとクビ届かなかった", "勝ち馬まで2馬身半届かなかった",
            "コーナーで外を回り、6m損した", "ミドリカワさんがランク戦で4着", "アオバさんが大会で1着！", "12分前", "あと8秒で送れます",
            "一部  2位 / 8", "二部 1位 → 一部に昇格  /  120 コイン", "1:58.3（あと0.4秒）", "いいね 12（今日あと3回）", "ミドリカワの厩舎",
            "発動: Leading in the final straight\n効果: for 4 s: target speed +1.8%\nランク戦: for 4 s: target speed +1.5%", "スキル継承 30.0%  末脚一閃 ← 父・母",
            "隔世遺伝 1.500%  重馬場巧者 ← ハヤテマル", "◎ ニックス  /  近親 2（能力 −100）", "種付け料 ◎300（無償コインのみ）  /  無償コインが足りません",
            "▶ 1着 ミドリカワ", "3位 アオバ", "フレンド出走 2人 / 12人 / 3秒遅れ", "決勝", "2回戦 第3組", "芝2000m", "3着 / 12頭",
            "固有スキル「末脚一閃」 残り300m", "ハヤテノツバサ　芝2000m　1着　1:58.3", "コインが足りません。（購入は確認中です。次回の起動時にもう一度送ります）",
            "招待コードを入力すると 無償コイン50枚・スカウト券×1 がもらえます（あと5日）", "Midoriさんの招待で参加しました", "復帰ログインボーナス 2日目：無償コイン50枚",
            "14日ぶりのご来場です。12月2日まで、復帰キャンペーンを用意しました", "パスXP上乗せ中：1レースごとに +40（残り 800）",
        };
        var bad = lines.Where(l => !En(Loc.T(l))).ToList();
        check(bad.Count == 0, "composite lines translate (" + lines.Length + ")" + (bad.Count > 0 ? ": " + string.Join(" | ", bad) : ""));
        check(Loc.T("1着") == "1st" && Loc.T("12着") == "12th" && Loc.T("一部  2位 / 8") == "Division 1  2nd / 8", "places are English ordinals (1st, 12th, Division 1  2nd / 8)");
        check(Loc.T("ハヤテノツバサ") == "Hayatenotsubasa" && Loc.T("シンセイアカツキ") == "Shinsei Akatsuki", "horse names: master names from the table, other katakana romanized");
        check(ActionResult.Error("父馬と母馬を選んでください").Message == "Choose a sire and a dam", "ActionResult messages come out in the app's language");
    }

    static void Commentary(Action<bool, string> check, string root, RulesetParams rs)
    {
        var en = CommentaryTemplates.Parse(Res(root, "commentary-en.json"));
        var cfg = RaceFactory.Practice(rs, RaceFactory.DefaultPartner("ミドリカワ"), 42);
        var feed = new CommentaryFeed(en, cfg, 0);
        var d = new OfflineRaceDriver(cfg, 0, autoStart: true);
        long now = 0;
        var lines = new List<CommentaryLine>();
        while (!d.Done && now < 400_000) { d.Update(now); feed.Update(d.Sim); lines.AddRange(feed.NewLines); now += 33; }
        check(lines.Count >= 6 && lines.All(l => !Loc.HasJapanese(l.Text)), "English commentary of a full practice race has no Japanese (" + lines.Count + " lines; e.g. " + string.Join(" / ", lines.Take(3).Select(l => l.Text)) + ")");
        check(lines.Any(l => l.Text.Contains("Midorikawa")), "the player's katakana name is romanized in the commentary");
    }

    sealed class Echo : IHttp
    {
        public readonly List<HttpRequest> Sent = new List<HttpRequest>();
        public Task<HttpResponse> SendAsync(HttpRequest r, CancellationToken ct) { Sent.Add(r); return Task.FromResult(new HttpResponse(200, "{\"ok\":true}")); }
    }

    static async Task ApiLocale(Action<bool, string> check)
    {
        var http = new Echo();
        var api = new ApiClient(http, null, new ApiClientOptions { BaseUrl = "http://fake", DevUserId = "u", Locale = Loc.Current });
        await api.HealthAsync();
        check(http.Sent[0].Headers.TryGetValue("accept-language", out var l) && l == "en", "the API client sends the app's language (Accept-Language: en)");
    }
}
