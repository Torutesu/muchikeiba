// プロフィールのショーケース (REQ-SHOW-001..018, contracts/protocol.md §62): ShowcaseCardModel / ShowcaseEditorModel over a routed
// fake server. The card (pins, records, horse, neutral card), share image without a player id, report targets (source profile),
// KPI showcase_view / showcase_share, the editor's draft rules (earned only, pins / courses limits, locked backgrounds, no text
// field), save, offline, English for every label, and no shop / urgency / betting words.
using System.Linq;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class ShowcaseChecks
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

    const long Now = 1796698800000L;
    const string Player = "{\"id\":\"v\",\"wallet\":{\"paid\":0,\"free\":0,\"total\":0,\"debt\":0},\"season\":{\"id\":\"2026-11\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[],\"equipment\":{\"tack\":{},\"decor\":[]},\"deletion\":{\"status\":\"none\"}}";
    // produced by the real server (showcase.ts; lists trimmed)
    const string Mine = "{\"saved\":true,\"selection\":{\"horseId\":\"h1\",\"pins\":[{\"kind\":\"title\",\"id\":\"debut\"},{\"kind\":\"cup_trophy\",\"id\":\"cup_aaaaaaaaaaaaaaaa\"},{\"kind\":\"achievement\",\"id\":\"wins\"}],\"taTrackIds\":[\"aoba_turf_1600\"],\"phraseId\":\"race_anytime\",\"backgroundId\":\"turf_stretch\"},\"limits\":{\"pinsMax\":3,\"taMax\":2},\"horses\":[{\"horseId\":\"h1\",\"horseName\":\"ミドリノカゼ\",\"rarity\":\"SR\",\"sex\":\"male\",\"appearance\":{\"coat\":\"chestnut\",\"face\":\"blaze\",\"legs\":[\"none\",\"none\",\"sock\",\"none\"],\"mane\":\"normal\",\"build\":\"standard\"}}],\"pins\":[{\"kind\":\"title\",\"id\":\"debut\",\"label\":\"デビュー\",\"sub\":\"称号\",\"icon\":\"title/debut\"},{\"kind\":\"title\",\"id\":\"first_win\",\"label\":\"初勝利\",\"sub\":\"称号\",\"icon\":\"title/first_win\"},{\"kind\":\"achievement\",\"id\":\"races\",\"label\":\"出走の記録\",\"sub\":\"実績 1段目\",\"icon\":\"badge/races_1\"},{\"kind\":\"achievement\",\"id\":\"wins\",\"label\":\"勝利の記録\",\"sub\":\"実績 1段目\",\"icon\":\"badge/wins_1\"}],\"courses\":[{\"trackId\":\"aoba_turf_1600\",\"course\":\"青葉競馬場 芝1600m\",\"time\":\"1:35.4\",\"timeMs\":95400,\"horseName\":\"ミドリノカゼ\"}],\"phrases\":[{\"id\":\"hello\",\"phraseText\":\"よろしくお願いします！\"},{\"id\":\"race_anytime\",\"phraseText\":\"いつでもレースしよう！\"},{\"id\":\"thanks\",\"phraseText\":\"いつもありがとう！\"}],\"backgrounds\":[{\"id\":\"dawn\",\"key\":\"showcase/bg/dawn\",\"backgroundName\":\"夜明けの馬場\",\"unlocked\":true,\"unlockText\":\"最初から使える\"},{\"id\":\"turf_stretch\",\"key\":\"showcase/bg/turf_stretch\",\"backgroundName\":\"芝の直線\",\"unlocked\":true,\"unlockText\":\"実績「勝利の記録」の1段目で解放\"},{\"id\":\"night_lights\",\"key\":\"showcase/bg/night_lights\",\"backgroundName\":\"ナイターの灯\",\"unlocked\":false,\"unlockText\":\"実績「出走の記録」の2段目で解放\"}],\"young\":false,\"preview\":{\"playerId\":\"a\",\"state\":\"ok\",\"displayName\":\"はやて\",\"titleId\":null,\"titleName\":null,\"classId\":\"C\",\"rating\":1500,\"stats\":{\"races\":12,\"wins\":3,\"top3\":0},\"lastSeenAt\":1794366000000,\"silks\":{\"pattern\":\"cross_sashes\",\"colors\":[\"green\",\"blue\"],\"cap\":\"star\"},\"background\":{\"id\":\"turf_stretch\",\"key\":\"showcase/bg/turf_stretch\",\"backgroundName\":\"芝の直線\"},\"phrase\":{\"id\":\"race_anytime\",\"phraseText\":\"いつでもレースしよう！\"},\"horse\":{\"horseId\":\"h1\",\"rarity\":\"SR\",\"sex\":\"male\",\"appearance\":{\"coat\":\"chestnut\",\"face\":\"blaze\",\"legs\":[\"none\",\"none\",\"sock\",\"none\"],\"mane\":\"normal\",\"build\":\"standard\"},\"horseName\":\"ミドリノカゼ\"},\"pins\":[{\"kind\":\"title\",\"id\":\"debut\",\"label\":\"デビュー\",\"sub\":\"称号\",\"icon\":\"title/debut\"},{\"kind\":\"cup_trophy\",\"id\":\"cup_aaaaaaaaaaaaaaaa\",\"label\":\"プレイヤー主催カップ\",\"sub\":\"金トロフィー\",\"icon\":null,\"cupName\":\"春の小さな杯\"},{\"kind\":\"achievement\",\"id\":\"wins\",\"label\":\"勝利の記録\",\"sub\":\"実績 1段目\",\"icon\":\"badge/wins_1\"}],\"timeAttack\":[{\"trackId\":\"aoba_turf_1600\",\"course\":\"青葉競馬場 芝1600m\",\"time\":\"1:35.4\",\"timeMs\":95400,\"horseName\":\"ミドリノカゼ\"}],\"seasonClass\":{\"seasonId\":\"2026-11\",\"classId\":\"C\",\"label\":\"今シーズン Cクラス\"},\"cupTrophies\":{\"gold\":1,\"silver\":0,\"bronze\":0},\"relation\":\"self\",\"reportable\":false,\"reportableHorseId\":null,\"young\":false},\"notice\":\"カードに出せるのは自分で手に入れたものだけです。引退した馬や手元にないものは自動で外れます。一言は決まった文から選びます。\"}";
    const string Card = "{\"playerId\":\"a\",\"state\":\"ok\",\"displayName\":\"はやて\",\"titleId\":null,\"titleName\":null,\"classId\":\"C\",\"rating\":1500,\"stats\":{\"races\":12,\"wins\":3,\"top3\":0},\"lastSeenAt\":1794366000000,\"silks\":{\"pattern\":\"cross_sashes\",\"colors\":[\"green\",\"blue\"],\"cap\":\"star\"},\"background\":{\"id\":\"turf_stretch\",\"key\":\"showcase/bg/turf_stretch\",\"backgroundName\":\"芝の直線\"},\"phrase\":{\"id\":\"race_anytime\",\"phraseText\":\"いつでもレースしよう！\"},\"horse\":{\"horseId\":\"h1\",\"rarity\":\"SR\",\"sex\":\"male\",\"appearance\":{\"coat\":\"chestnut\",\"face\":\"blaze\",\"legs\":[\"none\",\"none\",\"sock\",\"none\"],\"mane\":\"normal\",\"build\":\"standard\"},\"horseName\":\"ミドリノカゼ\"},\"pins\":[{\"kind\":\"title\",\"id\":\"debut\",\"label\":\"デビュー\",\"sub\":\"称号\",\"icon\":\"title/debut\"},{\"kind\":\"cup_trophy\",\"id\":\"cup_aaaaaaaaaaaaaaaa\",\"label\":\"プレイヤー主催カップ\",\"sub\":\"金トロフィー\",\"icon\":null,\"cupName\":\"春の小さな杯\"},{\"kind\":\"achievement\",\"id\":\"wins\",\"label\":\"勝利の記録\",\"sub\":\"実績 1段目\",\"icon\":\"badge/wins_1\"}],\"timeAttack\":[{\"trackId\":\"aoba_turf_1600\",\"course\":\"青葉競馬場 芝1600m\",\"time\":\"1:35.4\",\"timeMs\":95400,\"horseName\":\"ミドリノカゼ\"}],\"seasonClass\":{\"seasonId\":\"2026-11\",\"classId\":\"C\",\"label\":\"今シーズン Cクラス\"},\"cupTrophies\":{\"gold\":1,\"silver\":0,\"bronze\":0},\"relation\":\"other\",\"reportable\":true,\"reportableHorseId\":\"h1\",\"young\":false}";
    const string Neutral = "{\"playerId\":\"a\",\"state\":\"neutral\",\"displayName\":\"プレイヤー\",\"titleId\":null,\"titleName\":null,\"classId\":null,\"rating\":null,\"stats\":null,\"lastSeenAt\":null,\"silks\":null,\"background\":{\"id\":\"dawn\",\"key\":\"showcase/bg/dawn\",\"backgroundName\":\"夜明けの馬場\"},\"phrase\":null,\"horse\":null,\"pins\":[],\"timeAttack\":[],\"seasonClass\":null,\"cupTrophies\":null,\"relation\":\"other\",\"reportable\":false,\"reportableHorseId\":null,\"young\":false}";

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        var s = new FakeServer();
        bool blocked = false;
        s.Routes["POST /v1/player/bootstrap"] = _ => new HttpResponse(200, Player);
        s.Routes["GET /v1/player"] = _ => new HttpResponse(200, Player);
        s.Routes["GET /v1/showcase/a"] = _ => new HttpResponse(200, blocked ? Neutral : Card);
        s.Routes["GET /v1/showcase"] = _ => new HttpResponse(200, Mine);
        s.Routes["PUT /v1/showcase"] = r => r.Body.Contains("night_lights")
            ? new HttpResponse(409, "{\"error\":{\"code\":\"NOT_ELIGIBLE\",\"message\":\"background night_lights is locked\"}}")
            : new HttpResponse(200, Mine);
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var kv = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, ruleset);
        await b.InitializeAsync();
        var events = new List<AnalyticsEvent>();
        long now = Now;

        // ---- the card
        var card = new ShowcaseCardModel(b, events.Add, () => now);
        var open = await card.OpenAsync("a", ShowcaseSources.Friends);
        check(open.Ok && !card.IsNeutral && card.Card.DisplayName == "はやて" && card.HorseTitle == "ミドリノカゼ", "showcase: the card opens with the name and the horse as typed");
        check(card.Pins.Count == 3 && card.Pins[1].Headline == "春の小さな杯" && card.Pins[1].PlayerText && card.Pins[1].Sub == "金トロフィー" && !card.Pins[0].PlayerText, "showcase: pin lines (a cup name is player text, a title is not)");
        check(card.Records.Count == 2 && card.Records[0].Headline == "青葉競馬場 芝1600m" && card.Records[0].Sub == "1:35.4" && card.Records[1].Headline == "今シーズン Cクラス", "showcase: best records (time attack, this season's class)");
        check(events.Count(e => e.Name == "showcase_view") == 1, "showcase: showcase_view on open");
        var targets = card.ReportTargets();
        check(card.CanReport && targets.Count == 3 && targets.Any(t => t.Kind == ReportContentKinds.HorseName && t.Ref == "h1") && ShowcaseCardModel.ReportSource == ReportSources.Profile, "showcase: report from the card (display name, horse name, player; source profile)");
        var share = card.BuildShare();
        card.ReportShared();
        var shareAll = share.ShareText + string.Join("", share.Lines) + share.PlaceText + share.ModeLabel;
        check(share.Kind == ShowcaseShare.Kind && share.PlaceText == "はやて" && !shareAll.Contains("\"a\"") && share.Lines.Contains("いつでもレースしよう！") && events.Any(e => e.Name == "showcase_share"), "showcase: share image (name and card texts, no player id) + showcase_share");
        check(!card.CanEdit, "showcase: another player's card has no edit button");

        blocked = true;
        await card.OpenAsync("a", ShowcaseSources.CupLobby);
        check(card.IsNeutral && card.Pins.Count == 0 && card.Records.Count == 0 && !card.CanShare && !card.CanReport && card.BuildShare() == null && card.ReportTargets().Count == 0 && card.Card.DisplayName == "プレイヤー", "showcase: a neutral card shows only the neutral name (no share, no report)");
        bool threw = false;
        try { await card.OpenAsync("a", "home"); } catch (ArgumentException) { threw = true; }
        check(threw, "showcase: an unknown source is refused before any request");

        // ---- the editor
        var ed = new ShowcaseEditorModel(b, events.Add, () => now);
        var load = await ed.LoadAsync();
        check(load.Ok && ed.Editor.Saved && ed.Draft.Pins.Count == 3 && !ed.Dirty, "showcase editor: loads the saved selection");
        check(!ed.TogglePin("title", "first_win").Ok && ed.Draft.Pins.Count == 3, "showcase editor: a 4th pin is refused (limit 3)");
        check(ed.TogglePin("title", "debut").Ok && ed.Draft.Pins.Count == 2 && ed.Dirty, "showcase editor: unpin");
        check(!ed.TogglePin("hall", "h_none").Ok, "showcase editor: only listed (earned) things can be pinned");
        check(ed.TogglePin("title", "first_win").Ok && ed.IsPinned("title", "first_win"), "showcase editor: pin an earned title");
        check(!ed.SetBackground("night_lights").Ok && ed.Draft.BackgroundId == "turf_stretch", "showcase editor: a locked background cannot be picked");
        check(ed.SetBackground("dawn").Ok && ed.Draft.BackgroundId == "dawn", "showcase editor: an unlocked background");
        ed.SetPhrase("free text"); check(ed.Draft.PhraseId == "race_anytime", "showcase editor: only listed phrases (no text field)");
        ed.SetPhrase(null); check(ed.Draft.PhraseId == null, "showcase editor: no phrase");
        check(!ed.ToggleCourse("kirameki_turf_2000").Ok && ed.ToggleCourse("aoba_turf_1600").Ok && ed.Draft.TaTrackIds.Count == 0, "showcase editor: courses only with a record; toggle off");
        ed.SetHorse("h_other"); check(ed.Draft.HorseId == "h1", "showcase editor: only an active horse of the list");
        var save = await ed.SaveAsync();
        check(save.Ok && s.Sent.Last().Method == "PUT" && s.Sent.Last().Body.Contains("\"backgroundId\":\"dawn\"") && !ed.Dirty, "showcase editor: save sends ids and takes the server's answer");
        ed.Draft.BackgroundId = "night_lights";
        var refused = await ed.SaveAsync();
        check(!refused.Ok && refused.Message == UxText.Errors["NOT_ELIGIBLE"], "showcase editor: a refusal reads as a sentence");

        // ---- offline
        var off = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, null, null, new MemoryKeyValueStore(), ruleset);
        var offCard = new ShowcaseCardModel(off, events.Add, () => now);
        check(!(await offCard.OpenAsync("a", ShowcaseSources.Friends)).Ok && offCard.Card == null, "showcase: offline shows the offline notice, no stale card");

        // ---- English and words
        var labels = new List<string> { ShowcaseCardModel.Title, ShowcaseCardModel.HorseLabel, ShowcaseCardModel.NoHorseText, ShowcaseCardModel.PinsLabel, ShowcaseCardModel.RecordsLabel,
            ShowcaseCardModel.ShareLabel, ShowcaseCardModel.ReportLabel, ShowcaseCardModel.EditLabel, ShowcaseCardModel.NeutralText, ShowcaseCardModel.OfflineText,
            ShowcaseEditorModel.Title, ShowcaseEditorModel.HorseLabel, ShowcaseEditorModel.NoHorseLabel, ShowcaseEditorModel.PinsLabel, ShowcaseEditorModel.CoursesLabel,
            ShowcaseEditorModel.PhraseLabel, ShowcaseEditorModel.NoPhraseLabel, ShowcaseEditorModel.BackgroundLabel, ShowcaseEditorModel.SaveLabel, ShowcaseEditorModel.SavedText,
            ShowcaseEditorModel.LockedText, ShowcaseEditorModel.PinsFullText, ShowcaseEditorModel.CoursesFullText, ShowcaseEditorModel.YoungText, ShowcaseEditorModel.OfflineText,
            ShowcaseShare.HeaderJa, "金トロフィー", "今シーズン Cクラス", "実績 1段目", "称号", "プレイヤー主催カップ" };
        Loc.SetLocale("en");
        try
        {
            var missing = labels.Where(t => Loc.HasJapanese(Loc.T(t))).ToList();
            check(missing.Count == 0, "showcase: every label has English (" + string.Join(" | ", missing) + ")");
        }
        finally { Loc.SetLocale("ja"); }
        var all = string.Join("", labels);
        check(!all.Contains("今だけ") && !all.Contains("残りわずか") && !all.Contains("倍") && !all.Contains("ショップ") && !all.Contains("購入") && BettingFree(all), "showcase: no urgency, shop or betting words");
    }

    static bool BettingFree(string s) => !new[] { "馬券", "オッズ", "配当", "的中", "賭", "儲", "本命" }.Any(s.Contains);
}
