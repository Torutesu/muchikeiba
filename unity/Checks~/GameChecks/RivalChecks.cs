// ライバル (REQ-RIVAL-001..016, contracts/protocol.md §28): RivalModel over a routed fake server with responses produced by
// the real server. Home card lines (human / CPU), detail (score, races, time attack), the week-result sheet shown once,
// opt-out, block, the friend-room challenge (never scores), the wording rules (no streak bonus, no shop link) and English.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class RivalChecks
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

    const string PlayerJson = "{\"id\":\"a\",\"wallet\":{\"paid\":0,\"free\":500,\"total\":500,\"debt\":0},\"season\":{\"id\":\"2026-12\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[{\"id\":\"h1\",\"name\":\"アイボウ\",\"rarity\":\"SR\",\"status\":\"active\",\"base\":{\"speed\":700}}],\"equipment\":{\"tack\":{},\"decor\":[]}}";
    const string Human = "{\"enabled\":true,\"optOut\":false,\"weekId\":\"2026-12-14\",\"weekEndsAt\":1797793200000,\"rival\":{\"kind\":\"human\",\"playerId\":\"b\",\"card\":{\"displayName\":\"ハヤテ乗り\",\"titleId\":null,\"classId\":\"C\",\"silks\":{\"pattern\":\"chevrons\",\"colors\":[\"brown\",\"yellow\"],\"cap\":\"plain\"},\"partner\":{\"name\":\"ハヤテ\",\"rarity\":\"SR\",\"style\":\"sashi\",\"appearance\":{\"coat\":\"chestnut\",\"face\":\"blaze\",\"legs\":[\"none\",\"none\",\"sock\",\"none\"],\"mane\":\"normal\",\"build\":\"standard\"}}},\"dissolved\":false},\"score\":{\"me\":2,\"them\":1,\"rankedRaces\":3,\"minRaces\":3,\"taMe\":1,\"taThem\":0},\"recent\":[{\"raceId\":\"r6\",\"at\":1797303600000,\"mode\":\"friend\",\"me\":3,\"them\":4,\"point\":null},{\"raceId\":\"r5\",\"at\":1797303600000,\"mode\":\"ranked\",\"me\":1,\"them\":2,\"point\":\"me\"},{\"raceId\":\"r4\",\"at\":1797303600000,\"mode\":\"ranked\",\"me\":6,\"them\":3,\"point\":\"them\"},{\"raceId\":\"r3\",\"at\":1797303600000,\"mode\":\"ranked\",\"me\":2,\"them\":5,\"point\":\"me\"}],\"timeAttack\":[{\"trackId\":\"aoba_turf_1600\",\"trackName\":\"青葉競馬場 芝1600m\",\"me\":70210,\"rival\":71004,\"faster\":\"me\"}],\"result\":{\"weekId\":\"2026-12-07\",\"outcome\":\"win\",\"kind\":\"cpu\",\"rivalName\":\"堅実のアサギ\",\"me\":3,\"them\":0,\"taMe\":0,\"taThem\":0,\"freeCoins\":20,\"settledAt\":1797303600000,\"newTitles\":[\"rival_first\"]},\"history\":[{\"weekId\":\"2026-12-07\",\"outcome\":\"win\",\"kind\":\"cpu\",\"rivalName\":\"堅実のアサギ\",\"me\":3,\"them\":0,\"taMe\":0,\"taThem\":0,\"freeCoins\":20,\"settledAt\":1797303600000,\"newTitles\":[\"rival_first\"]}],\"record\":{\"weeksWon\":1,\"weeksPlayed\":1,\"titles\":[{\"titleId\":\"rival_first\",\"name\":\"好敵手\",\"weeksWon\":1,\"unlocked\":true},{\"titleId\":\"rival_5\",\"name\":\"宿命の対決\",\"weeksWon\":5,\"unlocked\":false},{\"titleId\":\"rival_20\",\"name\":\"ライバルキラー\",\"weeksWon\":20,\"unlocked\":false}],\"nextTitle\":{\"titleId\":\"rival_5\",\"name\":\"宿命の対決\",\"weeksWon\":5,\"unlocked\":false}},\"rewards\":{\"win\":20,\"draw\":10,\"lose\":10,\"noContest\":10,\"minRaces\":3},\"challenge\":{\"left\":3,\"perDay\":3},\"rules\":{\"rankedOnly\":true,\"challengeUnranked\":true,\"fixedRewards\":true,\"noStreakRewards\":true,\"taBreaksTies\":true}}";
    const string Cpu = "{\"enabled\":true,\"optOut\":false,\"weekId\":\"2026-12-14\",\"weekEndsAt\":1797793200000,\"rival\":{\"kind\":\"cpu\",\"cpuId\":\"cpu_asagi\",\"name\":\"堅実のアサギ\",\"personality\":\"steady\",\"line\":\"毎週コツコツ。今週も先に着くのはこっちだ\",\"style\":\"senko\",\"targetPlace\":6,\"taMedal\":\"silver\"},\"score\":{\"me\":2,\"them\":1,\"rankedRaces\":3,\"minRaces\":3,\"taMe\":1,\"taThem\":0},\"recent\":[{\"raceId\":\"r9\",\"at\":1797303600000,\"mode\":\"ranked\",\"me\":4,\"them\":null,\"point\":\"me\"}],\"timeAttack\":[{\"trackId\":\"aoba_turf_1600\",\"trackName\":\"青葉競馬場 芝1600m\",\"me\":70210,\"rival\":71004,\"faster\":\"me\"}],\"result\":null,\"history\":[{\"weekId\":\"2026-12-07\",\"outcome\":\"win\",\"kind\":\"cpu\",\"rivalName\":\"堅実のアサギ\",\"me\":3,\"them\":0,\"taMe\":0,\"taThem\":0,\"freeCoins\":20,\"settledAt\":1797303600000,\"newTitles\":[\"rival_first\"]}],\"record\":{\"weeksWon\":1,\"weeksPlayed\":1,\"titles\":[{\"titleId\":\"rival_first\",\"name\":\"好敵手\",\"weeksWon\":1,\"unlocked\":true},{\"titleId\":\"rival_5\",\"name\":\"宿命の対決\",\"weeksWon\":5,\"unlocked\":false},{\"titleId\":\"rival_20\",\"name\":\"ライバルキラー\",\"weeksWon\":20,\"unlocked\":false}],\"nextTitle\":{\"titleId\":\"rival_5\",\"name\":\"宿命の対決\",\"weeksWon\":5,\"unlocked\":false}},\"rewards\":{\"win\":20,\"draw\":10,\"lose\":10,\"noContest\":10,\"minRaces\":3},\"challenge\":null,\"rules\":{\"rankedOnly\":true,\"challengeUnranked\":true,\"fixedRewards\":true,\"noStreakRewards\":true,\"taBreaksTies\":true}}";
    const string Result = "{\"enabled\":true,\"optOut\":false,\"weekId\":\"2026-12-21\",\"weekEndsAt\":1798398000000,\"rival\":{\"kind\":\"human\",\"playerId\":\"b\",\"card\":{\"displayName\":\"ハヤテ乗り\",\"titleId\":null,\"classId\":\"C\",\"silks\":{\"pattern\":\"chevrons\",\"colors\":[\"brown\",\"yellow\"],\"cap\":\"plain\"},\"partner\":{\"name\":\"ハヤテ\",\"rarity\":\"SR\",\"style\":\"sashi\",\"appearance\":{\"coat\":\"chestnut\",\"face\":\"blaze\",\"legs\":[\"none\",\"none\",\"sock\",\"none\"],\"mane\":\"normal\",\"build\":\"standard\"}}},\"dissolved\":false},\"score\":{\"me\":0,\"them\":0,\"rankedRaces\":0,\"minRaces\":3,\"taMe\":0,\"taThem\":0},\"recent\":[],\"timeAttack\":[],\"result\":{\"weekId\":\"2026-12-14\",\"outcome\":\"win\",\"kind\":\"human\",\"rivalName\":\"ハヤテ乗り\",\"me\":2,\"them\":1,\"taMe\":1,\"taThem\":0,\"freeCoins\":20,\"settledAt\":1797908400000,\"newTitles\":[]},\"history\":[{\"weekId\":\"2026-12-14\",\"outcome\":\"win\",\"kind\":\"human\",\"rivalName\":\"ハヤテ乗り\",\"me\":2,\"them\":1,\"taMe\":1,\"taThem\":0,\"freeCoins\":20,\"settledAt\":1797908400000,\"newTitles\":[]},{\"weekId\":\"2026-12-07\",\"outcome\":\"win\",\"kind\":\"cpu\",\"rivalName\":\"堅実のアサギ\",\"me\":3,\"them\":0,\"taMe\":0,\"taThem\":0,\"freeCoins\":20,\"settledAt\":1797303600000,\"newTitles\":[\"rival_first\"]}],\"record\":{\"weeksWon\":2,\"weeksPlayed\":2,\"titles\":[{\"titleId\":\"rival_first\",\"name\":\"好敵手\",\"weeksWon\":1,\"unlocked\":true},{\"titleId\":\"rival_5\",\"name\":\"宿命の対決\",\"weeksWon\":5,\"unlocked\":false},{\"titleId\":\"rival_20\",\"name\":\"ライバルキラー\",\"weeksWon\":20,\"unlocked\":false}],\"nextTitle\":{\"titleId\":\"rival_5\",\"name\":\"宿命の対決\",\"weeksWon\":5,\"unlocked\":false}},\"rewards\":{\"win\":20,\"draw\":10,\"lose\":10,\"noContest\":10,\"minRaces\":3},\"challenge\":{\"left\":3,\"perDay\":3},\"rules\":{\"rankedOnly\":true,\"challengeUnranked\":true,\"fixedRewards\":true,\"noStreakRewards\":true,\"taBreaksTies\":true}}";

    static HttpResponse Ok(string body) => new HttpResponse(200, body);

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        var s = new FakeServer();
        s.Routes["POST /v1/player/bootstrap"] = _ => Ok(PlayerJson);
        s.Routes["GET /v1/player"] = _ => Ok(PlayerJson);
        string view = Human;
        s.Routes["GET /v1/rival"] = _ => Ok(view);
        s.Routes["POST /v1/rival/results/2026-12-07/seen"] = _ => Ok("{\"unseen\":null}");
        s.Routes["POST /v1/rival/challenge"] = _ => Ok("{\"ok\":true,\"rivalId\":\"b\"}");
        s.Routes["POST /v1/rival/block"] = _ => { view = Human.Replace("\"playerId\":\"b\",\"card\":{", "\"playerId\":null,\"card\":null,\"x\":{").Replace("\"dissolved\":false", "\"dissolved\":true").Replace("\"challenge\":{\"left\":3,\"perDay\":3}", "\"challenge\":null"); return Ok("{\"blocked\":\"b\",\"dissolved\":true}"); };
        s.Routes["PUT /v1/rival/settings"] = r => { view = r.Body.Contains("true") ? "{\"enabled\":true,\"optOut\":true,\"weekId\":\"2026-12-14\",\"rival\":null,\"recent\":[],\"timeAttack\":[]}" : Human; return Ok(r.Body.Contains("true") ? "{\"optOut\":true}" : "{\"optOut\":false}"); };
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, new MemoryKeyValueStore(), ruleset);
        await b.InitializeAsync();
        long now = 1797303600000L; // 2026-12-16 12:00 JST (week of 2026-12-14)
        var m = new RivalModel(b, null, () => now);

        var load = await m.LoadAsync();
        check(load.Ok && m.Enabled && m.ShowHomeCard && m.HasHuman, "rival: loads this week's human rival for the home card");
        check(m.RivalName == "ハヤテ乗り" && m.RivalSubline == "C級・相棒 ハヤテ（差し）", "rival: the public card only — name, class, partner horse (" + m.RivalSubline + ")");
        check(m.ScoreLine == "今週 2 - 1" && m.RacesLine == "ランク戦 3戦" && m.DaysLeftLine == "あと" + GameDay.DaysUntil(m.View.WeekEndsAt, now) + "日", "rival: score, races and days left (" + m.ScoreLine + " / " + m.RacesLine + " / " + m.DaysLeftLine + ")");
        var races = m.Races;
        check(races.Count == 4 && races[0].Challenge && races[0].Point == null && races[0].Text == "挑戦状 3着 vs 4着" && races[1].Text == "1着 vs 2着" && races[1].Point == "me", "rival: recent races, the challenge race shown without a point");
        var ta = m.TimeAttack;
        check(ta.Count == 1 && ta[0].MeText == "1:10.2" && ta[0].RivalText == "1:11.0" && ta[0].Faster == "me", "rival: time attack comparison (" + ta[0].MeText + " vs " + ta[0].RivalText + ")");
        check(m.RewardsLine == "勝ち 20・引き分け 10・負け 10（無償コイン）" && m.RecordLine == "通算 1勝 / 1週" && m.NextTitleLine == "称号「宿命の対決」まで あと4勝", "rival: fixed rewards, total record and the next title");
        check(RivalModel.RulesText.Contains("点になりません") && RivalModel.RulesText.Contains("連勝の上乗せはありません") && !RivalModel.RulesText.Contains("倍") && !RivalModel.RulesText.Contains("ショップ"), "rival: rules wording (challenge never scores, no streak bonus, no shop link)");

        // the week-result sheet: once
        var sheet = m.ResultSheet;
        check(sheet != null && sheet.Headline == "勝ち" && sheet.ScoreText == "直接対決 3 - 0" && sheet.RivalText == "vs 堅実のアサギ" && sheet.RewardText == "無償コイン20枚" && sheet.NewTitles.SequenceEqual(new[] { "好敵手" }), "rival: the week-result sheet (" + sheet?.Headline + " / " + sheet?.ScoreText + " / " + sheet?.RewardText + ")");
        var dismissed = await m.DismissResultAsync();
        check(dismissed.Ok && m.ResultSheet == null && s.Sent.Any(r => r.Path == "/v1/rival/results/2026-12-07/seen"), "rival: closing the sheet marks it seen");
        var tie = RivalModel.Sheet(new RivalResult { WeekId = "w", Outcome = "win", Me = 2, Them = 2, TaMe = 2, TaThem = 1, FreeCoins = 20, RivalName = "x" }, m.View);
        var few = RivalModel.Sheet(new RivalResult { WeekId = "w", Outcome = "not_enough", Me = 1, Them = 0 }, m.View);
        check(tie.ScoreText == "直接対決 2 - 2・タイムアタック 2 - 1" && few.RewardText == null && few.Note == "ランク戦が3戦に届かなかったため、報酬はありません", "rival: a tie broken by time attack, and a week without enough races pays nothing");

        // challenge: the friend room passphrase is required; the counter goes down
        check(m.CanChallenge && m.ChallengeLine == "挑戦状 あと3回", "rival: challenge available with today's count");
        var noRoom = await m.ChallengeAsync(null);
        var sent = await m.ChallengeAsync("sakura-42");
        check(!noRoom.Ok && sent.Ok && sent.Message == "挑戦状を送りました（このレースは点になりません）" && m.ChallengeLine == "挑戦状 あと2回", "rival: challenge needs a room first, then is sent (unranked)");

        // CPU rival
        view = Cpu;
        await m.LoadAsync();
        check(m.Rival.IsCpu && m.RivalName == "堅実のアサギ" && m.RivalSubline == "先行・目標6着以内" && m.RivalLine.StartsWith("毎週コツコツ") && !m.CanChallenge && m.ChallengeLine == null, "rival: a CPU rival with its personality line, no challenge");
        check(m.Races[0].Text == "4着（目標6着以内）", "rival: a race against the CPU shows the target place");

        // block
        view = Human;
        await m.LoadAsync();
        check(m.BlockConfirmText.StartsWith("ハヤテ乗りさんをブロックします"), "rival: block asks first");
        var blocked = await m.BlockAsync();
        check(blocked.Ok && m.Dissolved && m.RivalName == "ライバル解除" && m.RivalSubline == null && !m.CanChallenge, "rival: after a block the pair is dissolved and the card is gone");

        // opt out / back in
        var off = await m.SetOptOutAsync(true);
        check(off.Ok && m.OptedOut && !m.ShowHomeCard, "rival: opting out hides the home card");
        var on = await m.SetOptOutAsync(false);
        check(on.Ok && !m.OptedOut && on.Message == "来週からライバルが決まります", "rival: opting back in");

        // the feature in home and errors
        check(UnlockGate.Titles["rival"] == "ライバル" && HomeModel.TileKeys.Contains("rival") && UxText.Errors.ContainsKey("RIVAL_CHALLENGE_LIMIT"), "rival: unlock title, home tile and the challenge limit sentence");

        // English (REQ-L10N-010)
        Loc.SetLocale("en");
        try
        {
            view = Human;
            await m.LoadAsync();
            var lines = new List<string> { m.RivalSubline, m.ScoreLine, m.RacesLine, m.DaysLeftLine, m.RewardsLine, m.RecordLine, m.NextTitleLine, m.ChallengeLine, m.BlockConfirmText.Replace("ハヤテ乗り", "Hayate"), RivalModel.RulesText,
                "ランク戦 2/3戦（3戦で週の結果に報酬）", "ライバル解除", "先行・目標6着以内", "4着（目標6着以内）", "挑戦状 3着 vs 4着", "1着 vs 2着", "直接対決 2 - 2・タイムアタック 2 - 1", "直接対決 3 - 0", "vs 堅実のアサギ",
                "無償コイン20枚", "ランク戦が3戦に届かなかったため、報酬はありません", "ライバルが解除されたため、今週の勝敗はつきません", "勝ち", "負け", "引き分け", "解除", "記録なし",
                "ライバルをお休みにしました。来週から組まれません", "来週からライバルが決まります", "挑戦状を送りました（このレースは点になりません）", UnlockGate.Titles["rival"], UnlockGate.Guides["rival"], UxText.Errors["RIVAL_CHALLENGE_LIMIT"] };
            var bad = lines.Where(x => Loc.HasJapanese(Loc.T(x))).ToList();
            check(bad.Count == 0, "rival: every line in English" + (bad.Count > 0 ? " (missing: " + string.Join(" | ", bad) + ")" : " (e.g. " + Loc.T(m.RacesLine) + " / " + Loc.T(m.RivalSubline) + ")"));
            check(Loc.T(m.BlockConfirmText).Contains("ハヤテ乗り") && Loc.T(m.BlockConfirmText).StartsWith("Block "), "rival: a player-typed name is never translated (" + Loc.T(m.BlockConfirmText) + ")");
        }
        finally { Loc.SetLocale("ja"); }
    }
}
