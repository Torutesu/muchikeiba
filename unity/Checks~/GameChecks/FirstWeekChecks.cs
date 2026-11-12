// Quality pass 2 — the first week on the goal ladder (REQ-GOAL-013..015, docs/quality/first-week.md): GoalLadderModel over the
// real server's day-1 JSON (login bonus received, 3 races, the partner trained twice). Tomorrow as facts (home line + sheet
// lines), the partner's growth (stage, gauge, today's growth, sessions left), the next first step's screen and its lock text,
// an older server's ladder without the new fields, English for every new line, and no urgency or shop words.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class FirstWeekChecks
{
    sealed class FakeServer : IHttp
    {
        public Task<HttpResponse> SendAsync(HttpRequest r, CancellationToken ct) => Task.FromResult(r.Path.StartsWith("/v1/player")
            ? new HttpResponse(200, "{\"id\":\"g\",\"wallet\":{\"paid\":0,\"free\":0,\"total\":0,\"debt\":0},\"season\":{\"id\":\"2026-12\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[],\"equipment\":{\"tack\":{},\"decor\":[]},\"deletion\":{\"status\":\"none\"}}")
            : new HttpResponse(404, "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"no route\"}}"));
    }
    sealed class Tokens : IAuthTokenProvider { public Task<string> GetTokenAsync(bool f, CancellationToken ct) => Task.FromResult("tok"); }

    const long Now = 1794500702748L;
    // GET /v1/home/goals from the real server rules (tools/figma-prototype logic.js = server/src/domain), a day-1 player
    const string Day1 = "{\"day\":\"2026-11-13\",\"now\":1794500702748,\"today\":{\"open\":true,\"items\":[{\"id\":\"race3\",\"table\":\"daily\",\"kind\":\"races\",\"progress\":3,\"target\":3,\"reward\":{\"freeCoins\":15},\"claimed\":false,\"claimable\":true},{\"id\":\"win1\",\"table\":\"daily\",\"kind\":\"wins\",\"progress\":1,\"target\":1,\"reward\":{\"freeCoins\":30},\"claimed\":false,\"claimable\":true},{\"id\":\"top3x2\",\"table\":\"daily\",\"kind\":\"top3\",\"progress\":2,\"target\":2,\"reward\":{\"items\":[{\"itemId\":\"breeding_material\",\"qty\":1}]},\"claimed\":false,\"claimable\":true},{\"id\":\"train1\",\"table\":\"daily\",\"kind\":\"training\",\"progress\":1,\"target\":1,\"reward\":{\"items\":[{\"itemId\":\"training_apple\",\"qty\":1}]},\"claimed\":false,\"claimable\":true},{\"id\":\"first_win\",\"table\":\"first_win\",\"kind\":\"first_win\",\"progress\":1,\"target\":1,\"reward\":{\"freeCoins\":30},\"claimed\":true,\"claimable\":false}],\"done\":5,\"total\":5,\"claimable\":4,\"complete\":false,\"resetAt\":1794582000000,\"loginBonus\":{\"open\":true,\"claimedToday\":true,\"next\":{\"track\":\"beginner\",\"day\":2,\"days\":7,\"reward\":{\"broodmare\":\"t_broodmare\"}}},\"playerDay\":1,\"tomorrow\":{\"playerDay\":2,\"at\":1794582000000,\"loginBonus\":{\"track\":\"beginner\",\"day\":2,\"days\":7,\"reward\":{\"broodmare\":\"t_broodmare\"}},\"opens\":[\"breeding\",\"friends\",\"friend_rooms\"],\"trainingSlots\":3}},\"path\":{\"step\":1,\"steps\":10,\"done\":0,\"current\":{\"id\":\"bm_scout\",\"table\":\"beginner\",\"kind\":\"gacha\",\"progress\":1,\"target\":1,\"reward\":{\"freeCoins\":50},\"claimed\":false,\"claimable\":true,\"screen\":\"scout\",\"open\":true},\"finalReward\":{\"items\":[{\"itemId\":\"gacha_ticket_10\",\"qty\":1}]}},\"week\":null,\"season\":{\"open\":false,\"seasonId\":\"2026-11\",\"endsAt\":1796050800000,\"classId\":\"C\",\"nextClassId\":\"B\",\"points\":62,\"races\":3,\"line\":300,\"left\":238,\"demoteBelow\":null,\"status\":\"rookie\",\"pace\":{\"races\":3,\"pace10\":206,\"racesToLine\":12,\"minRaces\":3},\"power\":{\"horseId\":\"h1\",\"partner\":true,\"total\":3330,\"cap\":2800,\"usable\":2800,\"nextCap\":3200,\"nextUsable\":3200,\"held\":530},\"ladder\":[{\"classId\":\"C\",\"statCap\":2800,\"promotePoints\":300,\"demoteBelowPoints\":null,\"current\":true,\"reached\":true,\"rewards\":{\"top\":{\"maxRank\":10,\"reward\":{\"freeCoins\":300}},\"floor\":{\"freeCoins\":50}}},{\"classId\":\"B\",\"statCap\":3200,\"promotePoints\":400,\"demoteBelowPoints\":50,\"current\":false,\"reached\":false,\"rewards\":{\"top\":{\"maxRank\":10,\"reward\":{\"freeCoins\":500}},\"floor\":{\"freeCoins\":80}}},{\"classId\":\"A\",\"statCap\":3600,\"promotePoints\":500,\"demoteBelowPoints\":80,\"current\":false,\"reached\":false,\"rewards\":{\"top\":{\"maxRank\":10,\"reward\":{\"freeCoins\":800,\"items\":[{\"itemId\":\"gacha_ticket\",\"qty\":1}]}},\"floor\":{\"freeCoins\":120}}},{\"classId\":\"S\",\"statCap\":4000,\"promotePoints\":null,\"demoteBelowPoints\":100,\"current\":false,\"reached\":false,\"rewards\":{\"top\":{\"maxRank\":1,\"reward\":{\"freeCoins\":3000,\"items\":[{\"itemId\":\"ticket_sr_plus\",\"qty\":1}]}},\"floor\":{\"freeCoins\":200}}}],\"missions\":[{\"id\":\"sm_races10\",\"table\":\"season\",\"kind\":\"ranked_races\",\"progress\":3,\"target\":10,\"reward\":{\"passXp\":100},\"claimed\":false,\"claimable\":false},{\"id\":\"sm_races30\",\"table\":\"season\",\"kind\":\"ranked_races\",\"progress\":3,\"target\":30,\"reward\":{\"passXp\":200},\"claimed\":false,\"claimable\":false},{\"id\":\"sm_wins5\",\"table\":\"season\",\"kind\":\"wins\",\"progress\":1,\"target\":5,\"reward\":{\"passXp\":150},\"claimed\":false,\"claimable\":false},{\"id\":\"sm_top3_15\",\"table\":\"season\",\"kind\":\"top3\",\"progress\":2,\"target\":15,\"reward\":{\"passXp\":150},\"claimed\":false,\"claimable\":false},{\"id\":\"sm_promotion\",\"table\":\"season\",\"kind\":\"promotion_line\",\"progress\":62,\"target\":300,\"reward\":{\"passXp\":300},\"claimed\":false,\"claimable\":false}],\"pass\":{\"level\":0,\"maxLevel\":30,\"freeClaimable\":0},\"promotion\":null},\"partner\":{\"horseId\":\"h1\",\"name\":\"アカツキ\",\"stage\":0,\"stageKey\":\"debut\",\"stages\":5,\"stageFrom\":0,\"nextStageAt\":24,\"trainedTotal\":10,\"potential\":240,\"gainedToday\":10,\"gainedYesterday\":0,\"trainingOpen\":true,\"sessionsLeft\":0,\"full\":false},\"claimable\":5}";

    public static async Task Run(Action<bool, string> check, string root, RulesetParams ruleset)
    {
        var api = new ApiClient(new FakeServer(), new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, new MemoryKeyValueStore(), ruleset);
        await b.InitializeAsync();
        var prevRule = GameDay.Rule;
        GameDay.Use(new DayRolloverInfo { HourJst = 4, PreviousHourJst = 0, EffectiveAtMs = 1796065200000 });
        try
        {
            var m = new GoalLadderModel(b, () => Now);
            m.Use(GoalLadderView.FromJson(Day1));
            check(m.TomorrowLines.Count == 3 && m.TomorrowLines[0] == "ログインボーナス 2日目：繁殖牝馬1頭" && m.TomorrowLines[1] == "配合・フレンド・フレンド部屋が開きます" && m.TomorrowLines[2] == "調教がまた3回できます",
                "first week: tomorrow's facts on the sheet (" + string.Join(" | ", m.TomorrowLines) + ")");
            check(m.TomorrowLine == "明日：繁殖牝馬1頭　·　配合が開く", "first week: one short home line, one feature at most (" + m.TomorrowLine + ")");
            check(m.TomorrowAt != null && System.Text.RegularExpressions.Regex.IsMatch(m.TomorrowAt, "^(今日|明日) [0-9]{1,2}:00$"), "first week: tomorrow starts at the game day's start, a time not a countdown (" + m.TomorrowAt + ")");
            check(m.Rungs[0].Key == "today" && m.Rungs[0].Main != m.TomorrowLine, "first week: while today's set is open the rung keeps today's line");
            var done = new GoalLadderModel(b, () => Now);
            done.Use(GoalLadderView.FromJson(Day1.Replace("\"complete\":false", "\"complete\":true")));
            check(done.Rungs[0].Main == done.TomorrowLine && done.Rungs[0].Figure == null, "first week: once today is done the today rung says what tomorrow brings, on its whole width (" + done.Rungs[0].Main + ")");

            var p = m.Partner;
            check(p != null && p.StageName == "新馬" && p.Stage == 0 && p.Stages == 5, "first week: the partner's stage of five");
            check(p.Line == "新馬　調教 +10" && p.DeltaLine == "今日 +10" && p.NextLine == "成長期まで あと14", "first week: the partner's growth line (" + p.Line + " / " + p.DeltaLine + " / " + p.NextLine + ")");
            check(Math.Abs(p.Fill - 10f / 24f) < 0.001f, "first week: the gauge runs from this stage's start to the next (" + p.Fill + ")");
            check(p.TrainLine == "今日の調教は終わりました" && !p.CanTrain, "first week: both sessions used → today's training is done (" + p.TrainLine + ")");
            var fresh = new GoalLadderModel(b, () => Now);
            fresh.Use(GoalLadderView.FromJson(Day1.Replace("\"gainedToday\":10", "\"gainedToday\":0").Replace("\"gainedYesterday\":0", "\"gainedYesterday\":10").Replace("\"sessionsLeft\":0", "\"sessionsLeft\":2")));
            check(fresh.Partner.DeltaLine == "昨日 +10" && fresh.Partner.TrainLine == "今日あと2回 調教できます" && fresh.Partner.CanTrain, "first week: the next morning — yesterday's growth and today's sessions (" + fresh.Partner.DeltaLine + " / " + fresh.Partner.TrainLine + ")");

            check(m.PathScreen == "scout" && m.PathLockText == null, "first week: the current step opens its screen (" + m.PathScreen + ")");
            var locked = new GoalLadderModel(b, () => Now);
            locked.Use(GoalLadderView.FromJson(Day1.Replace("\"kind\":\"gacha\"", "\"kind\":\"breed\"").Replace("\"screen\":\"scout\",\"open\":true", "\"screen\":\"breeding\",\"open\":false")));
            check(locked.PathScreen == "breeding" && locked.PathLockText == "明日開きます", "first week: a step whose screen opens tomorrow says so (" + locked.PathLockText + ")");

            // an older server: no tomorrow / partner / screen → nothing invented
            var old = new GoalLadderModel(b, () => Now);
            var j = Day1;
            int a = j.IndexOf(",\"playerDay\""), b2 = j.IndexOf(",\"path\"");
            j = j.Substring(0, a) + "}" + j.Substring(b2);
            int c = j.IndexOf(",\"partner\":{"), d = j.IndexOf(",\"claimable\"", c);
            j = j.Substring(0, c) + j.Substring(d);
            old.Use(GoalLadderView.FromJson(j.Replace(",\"screen\":\"scout\",\"open\":true", "")));
            check(old.View != null && old.View.Today.Tomorrow == null && old.TomorrowLine == null && old.TomorrowLines.Count == 0 && old.Partner == null && old.PathScreen == null && old.PathLockText == null, "first week: an older server's ladder shows none of it (" + (old.View == null ? "no view" : old.TomorrowLine + "|" + old.TomorrowLines.Count + "|" + (old.Partner != null) + "|" + old.PathScreen + "|" + old.PathLockText) + ")");

            var all = new List<string>(m.TomorrowLines) { m.TomorrowLine, done.Rungs[0].Main, p.Line, p.DeltaLine, p.NextLine, p.TrainLine, fresh.Partner.DeltaLine, fresh.Partner.TrainLine, locked.PathLockText, "レースを重ねると開きます", m.TomorrowAt };
            all = all.Where(x => !string.IsNullOrEmpty(x)).ToList();
            var text = string.Join("", all);
            check(!text.Contains("今だけ") && !text.Contains("残りわずか") && !text.Contains("お得") && !text.Contains("倍") && !text.Contains("ショップ") && !text.Contains("購入") && !text.Contains("あと残り"), "first week: no urgency words, no shop or purchase");
            Loc.LoadEnglish(File.ReadAllText(Path.Combine(root, "engine", "Muchi.Client", "Resources", "Muchi", "server-en.json")));
            Loc.LoadEnglish(File.ReadAllText(Path.Combine(root, "engine", "Muchi.Client", "Resources", "Muchi", "ui-en.json")));
            Loc.SetLocale("en");
            try
            {
                var miss = all.Where(x => Loc.HasJapanese(Loc.T(x))).Distinct().ToList();
                check(miss.Count == 0, "first week: every line has English (" + all.Count + " lines" + (miss.Count > 0 ? "; missing: " + string.Join(" | ", miss) : "; e.g. " + Loc.T(m.TomorrowLine) + " / " + Loc.T(p.NextLine)) + ")");
            }
            finally { Loc.SetLocale("ja"); }
        }
        finally { GameDay.Use(prevRule); }
    }
}
