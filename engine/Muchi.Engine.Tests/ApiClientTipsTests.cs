using System.Text.Json;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-TUT-001..018: /v1/tips client methods, models and KPI rows (contracts/protocol.md §57).</summary>
    public class ApiClientTipsTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientTipsTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        // produced by the real server (tips.ts tipsIndex / markTipsSeen on a fresh player; cards and replays trimmed to three)
        internal const string Index = "{\"enabled\":true,\"version\":1,\"lang\":\"ja\",\"newCount\":12,\"topics\":[{\"id\":\"race\",\"title\":\"レース\",\"count\":8,\"unlocked\":8,\"newCount\":8},{\"id\":\"horses\",\"title\":\"馬を育てる\",\"count\":5,\"unlocked\":1,\"newCount\":1},{\"id\":\"scout\",\"title\":\"スカウト\",\"count\":3,\"unlocked\":3,\"newCount\":3}],\"tips\":[{\"id\":\"whip_window\",\"topic\":\"race\",\"art\":\"whip\",\"unlock\":null,\"unlocked\":true,\"new\":true,\"title\":\"光ったら、ムチ\",\"body\":\"最後の直線でムチのボタンが光ったら合図。そこから続けて入れると、前の馬に並べる。\",\"help\":{\"articleId\":\"whip\",\"title\":\"ムチのタイミング\"}},{\"id\":\"breeding_pair\",\"topic\":\"horses\",\"art\":\"breeding\",\"unlock\":\"breeding\",\"unlocked\":false,\"new\":false,\"title\":\"配合のきほん\",\"body\":null,\"help\":{\"articleId\":\"breeding\",\"title\":\"配合と種付け\"}},{\"id\":\"scout_pity_tip\",\"topic\":\"scout\",\"art\":\"pity\",\"unlock\":null,\"unlocked\":true,\"new\":true,\"title\":\"交換ptで選べる\",\"body\":\"引くたびに交換ptがたまり、常設では100回分で対象の馬から好きな馬を選べる。\",\"help\":{\"articleId\":\"pity\",\"title\":\"天井（交換pt）のしくみ\"}}],\"tutorials\":[{\"id\":\"race_whip\",\"kind\":\"race\",\"lesson\":\"whip\",\"unlock\":null,\"unlocked\":true,\"title\":\"ムチのタイミング\",\"tips\":[\"whip_window\",\"whip_spacing\"]},{\"id\":\"tour_breeding\",\"kind\":\"tour\",\"lesson\":null,\"unlock\":\"breeding\",\"unlocked\":false,\"title\":\"配合のツアー\",\"tips\":[\"breeding_pair\",\"breeding_stud\"]},{\"id\":\"tour_scout\",\"kind\":\"tour\",\"lesson\":null,\"unlock\":\"scout\",\"unlocked\":true,\"title\":\"スカウトのツアー\",\"tips\":[\"scout_rates_tip\",\"scout_pity_tip\",\"scout_guarantee\"]}],\"contexts\":{\"gacha_odds\":\"scout_pity_tip\",\"breeding\":\"breeding_pair\",\"training\":\"training_timing\",\"roster_bulk_retire\":\"roster_retire\"}}";
        internal const string Seen = "{\"marked\":[\"whip_window\"],\"skipped\":[\"breeding_pair\"],\"newCount\":11}";

        [Fact]
        public async Task IndexParsesOpenAndClosedCardsReplaysAndContexts()
        {
            _http.Reply(200, Index);
            var idx = await _api.GetTipsAsync();
            Assert.Equal("/v1/tips", _http.Requests[0].Path);
            Assert.True(idx.Enabled);
            Assert.Equal(12, idx.NewCount);
            Assert.Equal(TipTopics.Race, idx.Topics[0].Id);
            Assert.Equal(1, idx.Topics[1].Unlocked);
            var whip = idx.Card("whip_window");
            Assert.True(whip.Unlocked && whip.New);
            Assert.Equal("whip", whip.HelpArticleId);
            Assert.Null(whip.Unlock);
            var closed = idx.Card("breeding_pair");
            Assert.False(closed.Unlocked);
            Assert.Null(closed.Body);
            Assert.Equal("breeding", closed.Unlock);
            Assert.Contains("100回分", idx.Card("scout_pity_tip").Body);
            var lesson = idx.Tutorial("race_whip");
            Assert.Equal(TutorialEntry.KindRace, lesson.Kind);
            Assert.Equal(RaceLessons.Whip, lesson.Lesson);
            Assert.Null(idx.Tutorial("tour_scout").Lesson);
            Assert.Equal(new[] { "scout_rates_tip", "scout_pity_tip", "scout_guarantee" }, idx.Tutorial("tour_scout").Tips);
            Assert.False(idx.Tutorial("tour_breeding").Unlocked);
            foreach (var c in TipContexts.All) Assert.True(idx.Contexts.ContainsKey(c), c);
            Assert.Equal("scout_pity_tip", idx.Contexts[TipContexts.GachaOdds]);
        }

        [Fact]
        public async Task MarkSeenSendsIdsOnlyAndChecksThemFirst()
        {
            _http.Reply(200, Seen);
            var r = await _api.MarkTipsSeenAsync(new[] { "whip_window", "breeding_pair" });
            Assert.Equal("/v1/tips/seen", _http.Requests[0].Path);
            Assert.Equal("POST", _http.Requests[0].Method);
            Assert.Equal("{\"ids\":[\"whip_window\",\"breeding_pair\"]}", _http.Requests[0].Body);
            Assert.Equal(new[] { "whip_window" }, r.Marked);
            Assert.Equal(new[] { "breeding_pair" }, r.Skipped);
            Assert.Equal(11, r.NewCount);
            await Assert.ThrowsAsync<ArgumentException>(() => _api.MarkTipsSeenAsync(new string[0]));
            await Assert.ThrowsAsync<ArgumentException>(() => _api.MarkTipsSeenAsync(new[] { "../x" }));
            await Assert.ThrowsAsync<ArgumentException>(() => _api.MarkTipsSeenAsync(Enumerable.Range(0, 21).Select(i => "t_" + i).ToArray()));
            Assert.Single(_http.Requests);
        }

        [Fact]
        public async Task PlayerViewCarriesTheBadge()
        {
            _http.Reply(200, "{\"id\":\"u1\",\"wallet\":{},\"tips\":{\"newCount\":4}}").Reply(200, "{\"id\":\"u1\",\"wallet\":{}}");
            Assert.Equal(4, (await _api.GetPlayerAsync()).Tips.NewCount);
            Assert.Equal(0, (await _api.GetPlayerAsync()).Tips.NewCount); // an older server sends none
        }

        [Fact]
        public async Task TipEventsMatchTheServerSchema()
        {
            _http.Reply(200, "{\"accepted\":3}");
            await _api.SendAnalyticsAsync("ios", "1", new[]
            {
                AnalyticsEvent.TutorialReplay(5, "race_whip", TutorialEntry.KindRace, "start"),
                AnalyticsEvent.TipView(6, "scout_pity_tip", "context"),
                AnalyticsEvent.TipContextOpen(7, TipContexts.RosterBulkRetire, "roster_retire"),
            });
            var body = _http.Requests[0].Body;
            Assert.Contains("\"name\":\"tutorial_replay\"", body);
            Assert.Contains("\"stage\":\"start\"", body);
            Assert.Contains("\"name\":\"tip_view\"", body);
            Assert.Contains("\"context\":\"roster_bulk_retire\"", body);
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.TutorialReplay(0, "race_whip", "practice", "start"));
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.TutorialReplay(0, "race_whip", "race", "win"));
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.TipView(0, "whip_window", "push"));
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.TipContextOpen(0, "home", "whip_window"));
            string ts = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "src", "domain", "kpi.ts"));
            foreach (var n in new[] { "tutorial_replay", "tip_view", "tip_context_open" }) Assert.Contains("z.literal('" + n + "')", ts);
            foreach (var s in AnalyticsEvent.TipViewSources) Assert.Contains("'" + s + "'", ts);
            string tips = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "src", "domain", "tips.ts"));
            foreach (var c in TipContexts.All) Assert.Contains("'" + c + "'", tips);
            foreach (var l in RaceLessons.All) Assert.Contains("'" + l + "'", tips);
            foreach (var t in TipTopics.All) Assert.Contains("'" + t + "'", tips);
        }
    }
}
