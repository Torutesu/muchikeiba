using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-SHOW-001..018: /v1/showcase client methods, models, the share card and KPI rows (contracts/protocol.md §62).</summary>
    [Collection("Loc")]
    public class ApiClientShowcaseTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientShowcaseTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        // produced by the real server (showcase.ts showcaseMine / ShowcaseService.card; lists trimmed)
        internal const string Mine = "{\"saved\":true,\"selection\":{\"horseId\":\"h1\",\"pins\":[{\"kind\":\"title\",\"id\":\"debut\"},{\"kind\":\"cup_trophy\",\"id\":\"cup_aaaaaaaaaaaaaaaa\"},{\"kind\":\"achievement\",\"id\":\"wins\"}],\"taTrackIds\":[\"aoba_turf_1600\"],\"phraseId\":\"race_anytime\",\"backgroundId\":\"turf_stretch\"},\"limits\":{\"pinsMax\":3,\"taMax\":2},\"horses\":[{\"horseId\":\"h1\",\"horseName\":\"ミドリノカゼ\",\"rarity\":\"SR\",\"sex\":\"male\",\"appearance\":{\"coat\":\"chestnut\",\"face\":\"blaze\",\"legs\":[\"none\",\"none\",\"sock\",\"none\"],\"mane\":\"normal\",\"build\":\"standard\"}}],\"pins\":[{\"kind\":\"title\",\"id\":\"debut\",\"label\":\"デビュー\",\"sub\":\"称号\",\"icon\":\"title/debut\"},{\"kind\":\"title\",\"id\":\"first_win\",\"label\":\"初勝利\",\"sub\":\"称号\",\"icon\":\"title/first_win\"},{\"kind\":\"achievement\",\"id\":\"races\",\"label\":\"出走の記録\",\"sub\":\"実績 1段目\",\"icon\":\"badge/races_1\"},{\"kind\":\"achievement\",\"id\":\"wins\",\"label\":\"勝利の記録\",\"sub\":\"実績 1段目\",\"icon\":\"badge/wins_1\"}],\"courses\":[{\"trackId\":\"aoba_turf_1600\",\"course\":\"青葉競馬場 芝1600m\",\"time\":\"1:35.4\",\"timeMs\":95400,\"horseName\":\"ミドリノカゼ\"}],\"phrases\":[{\"id\":\"hello\",\"phraseText\":\"よろしくお願いします！\"},{\"id\":\"race_anytime\",\"phraseText\":\"いつでもレースしよう！\"},{\"id\":\"thanks\",\"phraseText\":\"いつもありがとう！\"}],\"backgrounds\":[{\"id\":\"dawn\",\"key\":\"showcase/bg/dawn\",\"backgroundName\":\"夜明けの馬場\",\"unlocked\":true,\"unlockText\":\"最初から使える\"},{\"id\":\"turf_stretch\",\"key\":\"showcase/bg/turf_stretch\",\"backgroundName\":\"芝の直線\",\"unlocked\":true,\"unlockText\":\"実績「勝利の記録」の1段目で解放\"},{\"id\":\"night_lights\",\"key\":\"showcase/bg/night_lights\",\"backgroundName\":\"ナイターの灯\",\"unlocked\":false,\"unlockText\":\"実績「出走の記録」の2段目で解放\"}],\"young\":false,\"preview\":{\"playerId\":\"a\",\"state\":\"ok\",\"displayName\":\"はやて\",\"titleId\":null,\"titleName\":null,\"classId\":\"C\",\"rating\":1500,\"stats\":{\"races\":12,\"wins\":3,\"top3\":0},\"lastSeenAt\":1794366000000,\"silks\":{\"pattern\":\"cross_sashes\",\"colors\":[\"green\",\"blue\"],\"cap\":\"star\"},\"background\":{\"id\":\"turf_stretch\",\"key\":\"showcase/bg/turf_stretch\",\"backgroundName\":\"芝の直線\"},\"phrase\":{\"id\":\"race_anytime\",\"phraseText\":\"いつでもレースしよう！\"},\"horse\":{\"horseId\":\"h1\",\"rarity\":\"SR\",\"sex\":\"male\",\"appearance\":{\"coat\":\"chestnut\",\"face\":\"blaze\",\"legs\":[\"none\",\"none\",\"sock\",\"none\"],\"mane\":\"normal\",\"build\":\"standard\"},\"horseName\":\"ミドリノカゼ\"},\"pins\":[{\"kind\":\"title\",\"id\":\"debut\",\"label\":\"デビュー\",\"sub\":\"称号\",\"icon\":\"title/debut\"},{\"kind\":\"cup_trophy\",\"id\":\"cup_aaaaaaaaaaaaaaaa\",\"label\":\"プレイヤー主催カップ\",\"sub\":\"金トロフィー\",\"icon\":null,\"cupName\":\"春の小さな杯\"},{\"kind\":\"achievement\",\"id\":\"wins\",\"label\":\"勝利の記録\",\"sub\":\"実績 1段目\",\"icon\":\"badge/wins_1\"}],\"timeAttack\":[{\"trackId\":\"aoba_turf_1600\",\"course\":\"青葉競馬場 芝1600m\",\"time\":\"1:35.4\",\"timeMs\":95400,\"horseName\":\"ミドリノカゼ\"}],\"seasonClass\":{\"seasonId\":\"2026-11\",\"classId\":\"C\",\"label\":\"今シーズン Cクラス\"},\"cupTrophies\":{\"gold\":1,\"silver\":0,\"bronze\":0},\"relation\":\"self\",\"reportable\":false,\"reportableHorseId\":null,\"young\":false},\"notice\":\"カードに出せるのは自分で手に入れたものだけです。引退した馬や手元にないものは自動で外れます。一言は決まった文から選びます。\"}";
        internal const string Card = "{\"playerId\":\"a\",\"state\":\"ok\",\"displayName\":\"はやて\",\"titleId\":null,\"titleName\":null,\"classId\":\"C\",\"rating\":1500,\"stats\":{\"races\":12,\"wins\":3,\"top3\":0},\"lastSeenAt\":1794366000000,\"silks\":{\"pattern\":\"cross_sashes\",\"colors\":[\"green\",\"blue\"],\"cap\":\"star\"},\"background\":{\"id\":\"turf_stretch\",\"key\":\"showcase/bg/turf_stretch\",\"backgroundName\":\"芝の直線\"},\"phrase\":{\"id\":\"race_anytime\",\"phraseText\":\"いつでもレースしよう！\"},\"horse\":{\"horseId\":\"h1\",\"rarity\":\"SR\",\"sex\":\"male\",\"appearance\":{\"coat\":\"chestnut\",\"face\":\"blaze\",\"legs\":[\"none\",\"none\",\"sock\",\"none\"],\"mane\":\"normal\",\"build\":\"standard\"},\"horseName\":\"ミドリノカゼ\"},\"pins\":[{\"kind\":\"title\",\"id\":\"debut\",\"label\":\"デビュー\",\"sub\":\"称号\",\"icon\":\"title/debut\"},{\"kind\":\"cup_trophy\",\"id\":\"cup_aaaaaaaaaaaaaaaa\",\"label\":\"プレイヤー主催カップ\",\"sub\":\"金トロフィー\",\"icon\":null,\"cupName\":\"春の小さな杯\"},{\"kind\":\"achievement\",\"id\":\"wins\",\"label\":\"勝利の記録\",\"sub\":\"実績 1段目\",\"icon\":\"badge/wins_1\"}],\"timeAttack\":[{\"trackId\":\"aoba_turf_1600\",\"course\":\"青葉競馬場 芝1600m\",\"time\":\"1:35.4\",\"timeMs\":95400,\"horseName\":\"ミドリノカゼ\"}],\"seasonClass\":{\"seasonId\":\"2026-11\",\"classId\":\"C\",\"label\":\"今シーズン Cクラス\"},\"cupTrophies\":{\"gold\":1,\"silver\":0,\"bronze\":0},\"relation\":\"other\",\"reportable\":true,\"reportableHorseId\":\"h1\",\"young\":false}";
        internal const string Neutral = "{\"playerId\":\"a\",\"state\":\"neutral\",\"displayName\":\"プレイヤー\",\"titleId\":null,\"titleName\":null,\"classId\":null,\"rating\":null,\"stats\":null,\"lastSeenAt\":null,\"silks\":null,\"background\":{\"id\":\"dawn\",\"key\":\"showcase/bg/dawn\",\"backgroundName\":\"夜明けの馬場\"},\"phrase\":null,\"horse\":null,\"pins\":[],\"timeAttack\":[],\"seasonClass\":null,\"cupTrophies\":null,\"relation\":\"other\",\"reportable\":false,\"reportableHorseId\":null,\"young\":false}";

        [Fact]
        public async Task EditorParsesSelectionChoicesAndPreview()
        {
            _http.Reply(200, Mine);
            var e = await _api.GetShowcaseAsync();
            Assert.Equal("/v1/showcase", _http.Requests[0].Path);
            Assert.True(e.Saved);
            Assert.Equal(3, e.PinsMax);
            Assert.Equal(2, e.TaMax);
            Assert.Equal("h1", e.Selection.HorseId);
            Assert.Equal(3, e.Selection.Pins.Count);
            Assert.Equal(ShowcasePinKinds.CupTrophy, e.Selection.Pins[1].Kind);
            Assert.Equal("ミドリノカゼ", e.Horses[0].HorseName);
            Assert.Equal("chestnut", e.Horses[0].Appearance.Coat);
            Assert.Equal("1:35.4", e.Courses[0].Time);
            Assert.True(e.Backgrounds[1].Unlocked);
            Assert.False(e.Backgrounds[2].Unlocked);
            Assert.Equal("showcase/bg/dawn", e.Backgrounds[0].Key);
            Assert.Equal(AssetKeys.ShowcaseBg("dawn"), e.Backgrounds[0].Key);
            Assert.Equal("いつでもレースしよう！", e.Phrases[1].Text);
            Assert.True(e.Preview.IsSelf);
            Assert.False(e.Preview.Reportable);
        }

        [Fact]
        public async Task CardParsesAndShareCarriesNoPlayerId()
        {
            _http.Reply(200, Card);
            var c = await _api.GetShowcaseCardAsync("a");
            Assert.Equal("/v1/showcase/a", _http.Requests[0].Path);
            Assert.False(c.IsNeutral);
            Assert.Equal("はやて", c.DisplayName);
            Assert.Equal("turf_stretch", c.BackgroundId);
            Assert.Equal("芝の直線", c.BackgroundName);
            Assert.Equal("ミドリノカゼ", c.Horse.HorseName);
            Assert.Equal("春の小さな杯", c.Pins[1].Headline);
            Assert.Equal("金トロフィー", c.Pins[1].Sub);
            Assert.Equal("badge/wins_1", c.Pins[2].Icon);
            Assert.Equal("今シーズン Cクラス", c.SeasonClassLabel);
            Assert.True(c.Reportable);
            Assert.Equal("h1", c.ReportableHorseId);
            Assert.Equal(1, c.TrophyGold);
            Loc.SetLocale("ja");
            var share = ShowcaseShare.Build(c);
            Assert.Equal(ShowcaseShare.Kind, share.Kind);
            Assert.Equal("トレーナーカード", share.ModeLabel);
            Assert.Equal("はやて", share.PlaceText);
            Assert.Contains("いつでもレースしよう！", share.Lines);
            Assert.Contains("青葉競馬場 芝1600m　1:35.4", share.Lines);
            Assert.EndsWith(ShareCard.Hashtag, share.ShareText);
            var all = share.ShareText + "|" + string.Join("|", share.Lines) + "|" + share.PlaceText + "|" + share.HorseName + "|" + share.ModeLabel;
            Assert.DoesNotContain("\"a\"", all);
            Assert.DoesNotContain(c.PlayerId + "|", all);
        }

        [Fact]
        public void NeutralCardShowsNothingAndCannotBeShared()
        {
            var n = ShowcaseCard.FromJson(Neutral);
            Assert.True(n.IsNeutral);
            Assert.Equal("プレイヤー", n.DisplayName);
            Assert.Empty(n.Pins);
            Assert.Null(n.Horse);
            Assert.False(n.HasStats);
            Assert.False(n.Reportable);
            Assert.Throws<InvalidOperationException>(() => ShowcaseShare.Build(n));
        }

        [Fact]
        public async Task SaveSendsIdsOnlyAndChecksTheShapeFirst()
        {
            _http.Reply(200, Mine);
            var sel = new ShowcaseSelection { HorseId = "h1", PhraseId = "hello", BackgroundId = "dawn" };
            sel.Pins.Add(new ShowcasePinRef(ShowcasePinKinds.Title, "debut"));
            sel.TaTrackIds.Add("aoba_turf_1600");
            await _api.SaveShowcaseAsync(sel);
            Assert.Equal("PUT", _http.Requests[0].Method);
            Assert.Equal("{\"horseId\":\"h1\",\"pins\":[{\"kind\":\"title\",\"id\":\"debut\"}],\"taTrackIds\":[\"aoba_turf_1600\"],\"phraseId\":\"hello\",\"backgroundId\":\"dawn\"}", _http.Requests[0].Body);
            var tooMany = sel.Clone();
            for (int i = 0; i < 3; i++) tooMany.Pins.Add(new ShowcasePinRef(ShowcasePinKinds.Achievement, "a" + i));
            await Assert.ThrowsAsync<ArgumentException>(() => _api.SaveShowcaseAsync(tooMany));
            var dup = sel.Clone();
            dup.Pins.Add(new ShowcasePinRef(ShowcasePinKinds.Title, "debut"));
            await Assert.ThrowsAsync<ArgumentException>(() => _api.SaveShowcaseAsync(dup));
            var bad = sel.Clone();
            bad.Pins[0].Kind = "free_text";
            await Assert.ThrowsAsync<ArgumentException>(() => _api.SaveShowcaseAsync(bad));
            Assert.Single(_http.Requests);
            var none = new ShowcaseSelection();
            Assert.Contains("\"horseId\":null", none.ToJson().ToString());
        }

        [Fact]
        public async Task ShowcaseEventsMatchTheServerSchema()
        {
            _http.Reply(200, "{\"accepted\":2}");
            var c = ShowcaseCard.FromJson(Card);
            await _api.SendAnalyticsAsync("ios", "1", new[] { AnalyticsEvent.ShowcaseView(5, ShowcaseSources.CupLobby, "other", false), AnalyticsEvent.ShowcaseShared(6, c) });
            var body = _http.Requests[0].Body;
            Assert.Contains("\"name\":\"showcase_view\"", body);
            Assert.Contains("\"source\":\"cup_lobby\"", body);
            Assert.Contains("\"neutral\":false", body);
            Assert.Contains("\"name\":\"showcase_share\"", body);
            Assert.Contains("\"pins\":3", body);
            Assert.Contains("\"records\":2", body);
            Assert.DoesNotContain("\"a\"", body);
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.ShowcaseView(0, "home", "other", false));
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.ShowcaseView(0, ShowcaseSources.Friends, "rival", false));
            string ts = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "src", "domain", "kpi.ts"));
            foreach (var n in new[] { "showcase_view", "showcase_share" }) Assert.Contains("z.literal('" + n + "')", ts);
            foreach (var s in ShowcaseSources.All) Assert.Contains("'" + s + "'", ts);
            string sc = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "src", "domain", "showcase.ts"));
            foreach (var k in ShowcasePinKinds.All) Assert.Contains("'" + k + "'", sc);
        }
    }
}
