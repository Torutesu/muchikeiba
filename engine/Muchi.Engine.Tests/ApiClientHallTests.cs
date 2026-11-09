using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-HOF-001..016: 殿堂 client methods and models (contracts/protocol.md §34).</summary>
    public class ApiClientHallTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientHallTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        // produced by the real server code (HallService over PlayerService; tools/figma-prototype logic bundle): the partner with
        // 5 races, a retired horse inducted for 10 wins + a tournament title (the frame), a second plaque, a friend's hall
        internal const string Career = "{\"horseId\":\"h1\",\"horseName\":\"アカツキ\",\"status\":\"active\",\"partner\":true,\"career\":{\"races\":5,\"wins\":3,\"places\":3,\"tournamentWins\":0,\"firstRaceAt\":1794193200006,\"lastRaceAt\":1794193200010,\"byMode\":{\"ranked\":{\"races\":5,\"wins\":3}},\"bestTa\":{},\"tournaments\":[],\"biggestWin\":{\"raceId\":\"proto_hof_mw8w5z7d_0\",\"mode\":\"ranked\",\"fieldSize\":12,\"humans\":4,\"trackId\":\"aoba_turf_1600\",\"at\":1794193200006},\"rivalWins\":0},\"progress\":{\"wins\":{\"have\":3,\"need\":10},\"tournamentWin\":false,\"partnerRaces\":{\"have\":5,\"need\":30}},\"qualifies\":false,\"reasons\":[],\"preview\":[{\"kind\":\"partner\",\"text\":\"最初の相棒として5戦をともに走った\",\"params\":{\"n\":5}},{\"kind\":\"wins\",\"text\":\"通算5戦3勝\",\"params\":{\"races\":5,\"wins\":3}},{\"kind\":\"biggest_win\",\"text\":\"最大の勝利：青葉競馬場 芝1600mのランク戦（12頭立て）\",\"params\":{\"course\":\"青葉競馬場 芝1600m\",\"mode\":\"ランク戦\",\"n\":12}},{\"kind\":\"career_span\",\"text\":\"現役1日・5戦\",\"params\":{\"days\":1,\"n\":5}}],\"ceremony\":null,\"entry\":null}";
        internal const string Mine = "{\"entries\":[{\"horseId\":\"h2\",\"horseName\":\"ソラノカナタ\",\"rarity\":\"SR\",\"sex\":\"female\",\"appearance\":{\"coat\":\"gray\",\"face\":\"star_stripe\",\"legs\":[\"none\",\"none\",\"stocking\",\"none\"],\"mane\":\"normal\",\"build\":\"powerful\"},\"partner\":false,\"reasons\":[\"wins\",\"tournament\"],\"inductedAt\":1794193200020,\"career\":{\"races\":14,\"wins\":10,\"places\":12,\"tournamentWins\":1,\"firstRaceAt\":1794193200011,\"lastRaceAt\":1794193200019},\"highlights\":[{\"kind\":\"tournament_win\",\"text\":\"大会「オータムカップ」優勝\",\"params\":{\"tournament\":\"オータムカップ\",\"n\":1}},{\"kind\":\"wins\",\"text\":\"通算14戦10勝\",\"params\":{\"races\":14,\"wins\":10}},{\"kind\":\"biggest_win\",\"text\":\"最大の勝利：青葉競馬場 芝1600mのランク戦（12頭立て）\",\"params\":{\"course\":\"青葉競馬場 芝1600m\",\"mode\":\"ランク戦\",\"n\":12}},{\"kind\":\"career_span\",\"text\":\"現役1日・14戦\",\"params\":{\"days\":1,\"n\":14}}],\"frame\":true}],\"nextCursor\":null,\"total\":1,\"relation\":\"self\",\"visibility\":\"friends_team\",\"frame\":{\"itemId\":\"decor_hall_plaque_frame\",\"owned\":true},\"criteria\":{\"winsMin\":10,\"tournamentWin\":true,\"partnerRacesMin\":30},\"pendingCeremonies\":[{\"horseId\":\"h2\",\"horseName\":\"ソラノカナタ\",\"retiredAt\":1794193200020,\"partner\":false,\"career\":{\"races\":14,\"wins\":10,\"places\":12,\"tournamentWins\":1,\"firstRaceAt\":1794193200011,\"lastRaceAt\":1794193200019},\"highlights\":[{\"kind\":\"tournament_win\",\"text\":\"大会「オータムカップ」優勝\",\"params\":{\"tournament\":\"オータムカップ\",\"n\":1}},{\"kind\":\"wins\",\"text\":\"通算14戦10勝\",\"params\":{\"races\":14,\"wins\":10}},{\"kind\":\"biggest_win\",\"text\":\"最大の勝利：青葉競馬場 芝1600mのランク戦（12頭立て）\",\"params\":{\"course\":\"青葉競馬場 芝1600m\",\"mode\":\"ランク戦\",\"n\":12}},{\"kind\":\"career_span\",\"text\":\"現役1日・14戦\",\"params\":{\"days\":1,\"n\":14}}],\"inducted\":true,\"reasons\":[\"wins\",\"tournament\"],\"rewardItemId\":\"decor_hall_plaque_frame\",\"ackedAt\":null}],\"notice\":\"殿堂入りは確定したレースの成績だけで決まります（購入やアイテムでは決まりません）。\"}";
        internal const string Mine2 = "{\"entries\":[{\"horseId\":\"h3\",\"horseName\":\"ミナモノヒカリ\",\"rarity\":\"SSR\",\"sex\":\"female\",\"appearance\":{\"coat\":\"black\",\"face\":\"star_stripe\",\"legs\":[\"none\",\"none\",\"stocking\",\"none\"],\"mane\":\"dark\",\"build\":\"rangy\"},\"partner\":false,\"reasons\":[\"wins\"],\"inductedAt\":1794193200031,\"career\":{\"races\":11,\"wins\":11,\"places\":11,\"tournamentWins\":0,\"firstRaceAt\":1794193200023,\"lastRaceAt\":1794193200031},\"highlights\":[{\"kind\":\"wins\",\"text\":\"通算11戦11勝\",\"params\":{\"races\":11,\"wins\":11}},{\"kind\":\"biggest_win\",\"text\":\"最大の勝利：青葉競馬場 芝1600mのランク戦（12頭立て）\",\"params\":{\"course\":\"青葉競馬場 芝1600m\",\"mode\":\"ランク戦\",\"n\":12}},{\"kind\":\"career_span\",\"text\":\"現役1日・11戦\",\"params\":{\"days\":1,\"n\":11}}],\"frame\":true}],\"nextCursor\":\"1794193200031_h3\",\"total\":2,\"relation\":\"self\",\"visibility\":\"friends_team\",\"frame\":{\"itemId\":\"decor_hall_plaque_frame\",\"owned\":true},\"criteria\":{\"winsMin\":10,\"tournamentWin\":true,\"partnerRacesMin\":30},\"pendingCeremonies\":[{\"horseId\":\"h3\",\"horseName\":\"ミナモノヒカリ\",\"retiredAt\":1794193200031,\"partner\":false,\"career\":{\"races\":11,\"wins\":11,\"places\":11,\"tournamentWins\":0,\"firstRaceAt\":1794193200023,\"lastRaceAt\":1794193200031},\"highlights\":[{\"kind\":\"wins\",\"text\":\"通算11戦11勝\",\"params\":{\"races\":11,\"wins\":11}},{\"kind\":\"biggest_win\",\"text\":\"最大の勝利：青葉競馬場 芝1600mのランク戦（12頭立て）\",\"params\":{\"course\":\"青葉競馬場 芝1600m\",\"mode\":\"ランク戦\",\"n\":12}},{\"kind\":\"career_span\",\"text\":\"現役1日・11戦\",\"params\":{\"days\":1,\"n\":11}}],\"inducted\":true,\"reasons\":[\"wins\"],\"rewardItemId\":null,\"ackedAt\":null},{\"horseId\":\"h2\",\"horseName\":\"ソラノカナタ\",\"retiredAt\":1794193200020,\"partner\":false,\"career\":{\"races\":14,\"wins\":10,\"places\":12,\"tournamentWins\":1,\"firstRaceAt\":1794193200011,\"lastRaceAt\":1794193200019},\"highlights\":[{\"kind\":\"tournament_win\",\"text\":\"大会「オータムカップ」優勝\",\"params\":{\"tournament\":\"オータムカップ\",\"n\":1}},{\"kind\":\"wins\",\"text\":\"通算14戦10勝\",\"params\":{\"races\":14,\"wins\":10}},{\"kind\":\"biggest_win\",\"text\":\"最大の勝利：青葉競馬場 芝1600mのランク戦（12頭立て）\",\"params\":{\"course\":\"青葉競馬場 芝1600m\",\"mode\":\"ランク戦\",\"n\":12}},{\"kind\":\"career_span\",\"text\":\"現役1日・14戦\",\"params\":{\"days\":1,\"n\":14}}],\"inducted\":true,\"reasons\":[\"wins\",\"tournament\"],\"rewardItemId\":\"decor_hall_plaque_frame\",\"ackedAt\":null}],\"notice\":\"殿堂入りは確定したレースの成績だけで決まります（購入やアイテムでは決まりません）。\"}";
        internal const string Visit = "{\"owner\":{\"playerId\":\"demo_hof_1\",\"displayName\":\"アオバ\",\"titleId\":null,\"silks\":{\"pattern\":\"plain\",\"colors\":[\"sky\",\"yellow\"],\"cap\":\"hooped\"}},\"relation\":\"friend\",\"entries\":[{\"horseId\":\"h3\",\"horseName\":\"ハルカゼダンサー\",\"rarity\":\"SR\",\"sex\":\"female\",\"appearance\":{\"coat\":\"gray\",\"face\":\"star_stripe\",\"legs\":[\"none\",\"none\",\"stocking\",\"none\"],\"mane\":\"normal\",\"build\":\"powerful\"},\"partner\":false,\"reasons\":[\"wins\",\"tournament\"],\"inductedAt\":1794193200076,\"career\":{\"races\":30,\"wins\":10,\"places\":18,\"tournamentWins\":1,\"firstRaceAt\":1794193200050,\"lastRaceAt\":1794193200075},\"highlights\":[{\"kind\":\"tournament_win\",\"text\":\"大会「春の陣」優勝\",\"params\":{\"tournament\":\"春の陣\",\"n\":1}},{\"kind\":\"wins\",\"text\":\"通算30戦10勝\",\"params\":{\"races\":30,\"wins\":10}},{\"kind\":\"biggest_win\",\"text\":\"最大の勝利：青葉競馬場 芝1600mのランク戦（12頭立て）\",\"params\":{\"course\":\"青葉競馬場 芝1600m\",\"mode\":\"ランク戦\",\"n\":12}},{\"kind\":\"career_span\",\"text\":\"現役1日・30戦\",\"params\":{\"days\":1,\"n\":30}}],\"frame\":true},{\"horseId\":\"h2\",\"horseName\":\"ギンノカケハシ\",\"rarity\":\"SR\",\"sex\":\"male\",\"appearance\":{\"coat\":\"bay\",\"face\":\"star_stripe\",\"legs\":[\"none\",\"stocking\",\"none\",\"none\"],\"mane\":\"normal\",\"build\":\"compact\"},\"partner\":false,\"reasons\":[\"tournament\"],\"inductedAt\":1794193200049,\"career\":{\"races\":10,\"wins\":4,\"places\":6,\"tournamentWins\":1,\"firstRaceAt\":1794193200041,\"lastRaceAt\":1794193200047},\"highlights\":[{\"kind\":\"tournament_win\",\"text\":\"大会「秋の陣」優勝\",\"params\":{\"tournament\":\"秋の陣\",\"n\":1}},{\"kind\":\"wins\",\"text\":\"通算10戦4勝\",\"params\":{\"races\":10,\"wins\":4}},{\"kind\":\"biggest_win\",\"text\":\"最大の勝利：青葉競馬場 芝1600mのランク戦（12頭立て）\",\"params\":{\"course\":\"青葉競馬場 芝1600m\",\"mode\":\"ランク戦\",\"n\":12}},{\"kind\":\"career_span\",\"text\":\"現役1日・10戦\",\"params\":{\"days\":1,\"n\":10}}],\"frame\":true},{\"horseId\":\"h1\",\"horseName\":\"アオバノツバサ\",\"rarity\":\"SSR\",\"sex\":\"female\",\"appearance\":{\"coat\":\"black\",\"face\":\"star_stripe\",\"legs\":[\"none\",\"none\",\"stocking\",\"none\"],\"mane\":\"dark\",\"build\":\"rangy\"},\"partner\":false,\"reasons\":[\"wins\"],\"inductedAt\":1794193200040,\"career\":{\"races\":21,\"wins\":12,\"places\":16,\"tournamentWins\":0,\"firstRaceAt\":1794193200033,\"lastRaceAt\":1794193200040},\"highlights\":[{\"kind\":\"wins\",\"text\":\"通算21戦12勝\",\"params\":{\"races\":21,\"wins\":12}},{\"kind\":\"biggest_win\",\"text\":\"最大の勝利：青葉競馬場 芝1600mのランク戦（12頭立て）\",\"params\":{\"course\":\"青葉競馬場 芝1600m\",\"mode\":\"ランク戦\",\"n\":12}},{\"kind\":\"career_span\",\"text\":\"現役1日・21戦\",\"params\":{\"days\":1,\"n\":21}}],\"frame\":true}],\"nextCursor\":null,\"total\":3,\"frame\":{\"itemId\":\"decor_hall_plaque_frame\",\"owned\":true}}";
        internal const string RetiredCareer = "{\"horseId\":\"h2\",\"horseName\":\"ソラノカナタ\",\"status\":\"retired\",\"partner\":false,\"career\":{\"races\":14,\"wins\":10,\"places\":12,\"tournamentWins\":1,\"firstRaceAt\":1794193200011,\"lastRaceAt\":1794193200019,\"byMode\":{\"ranked\":{\"races\":14,\"wins\":10}},\"bestTa\":{},\"tournaments\":[{\"tournamentId\":\"proto_cup_h2\",\"name\":\"オータムカップ\",\"rank\":1,\"at\":1794193200020}],\"biggestWin\":{\"raceId\":\"proto_hof_mw8w5z7j_5\",\"mode\":\"ranked\",\"fieldSize\":12,\"humans\":4,\"trackId\":\"aoba_turf_1600\",\"at\":1794193200011},\"rivalWins\":0},\"progress\":{\"wins\":{\"have\":10,\"need\":10},\"tournamentWin\":true,\"partnerRaces\":null},\"qualifies\":true,\"reasons\":[\"wins\",\"tournament\"],\"preview\":null,\"ceremony\":{\"horseId\":\"h2\",\"horseName\":\"ソラノカナタ\",\"retiredAt\":1794193200020,\"partner\":false,\"career\":{\"races\":14,\"wins\":10,\"places\":12,\"tournamentWins\":1,\"firstRaceAt\":1794193200011,\"lastRaceAt\":1794193200019},\"highlights\":[{\"kind\":\"tournament_win\",\"text\":\"大会「オータムカップ」優勝\",\"params\":{\"tournament\":\"オータムカップ\",\"n\":1}},{\"kind\":\"wins\",\"text\":\"通算14戦10勝\",\"params\":{\"races\":14,\"wins\":10}},{\"kind\":\"biggest_win\",\"text\":\"最大の勝利：青葉競馬場 芝1600mのランク戦（12頭立て）\",\"params\":{\"course\":\"青葉競馬場 芝1600m\",\"mode\":\"ランク戦\",\"n\":12}},{\"kind\":\"career_span\",\"text\":\"現役1日・14戦\",\"params\":{\"days\":1,\"n\":14}}],\"inducted\":true,\"reasons\":[\"wins\",\"tournament\"],\"rewardItemId\":\"decor_hall_plaque_frame\",\"ackedAt\":null},\"entry\":{\"horseId\":\"h2\",\"horseName\":\"ソラノカナタ\",\"rarity\":\"SR\",\"sex\":\"female\",\"appearance\":{\"coat\":\"gray\",\"face\":\"star_stripe\",\"legs\":[\"none\",\"none\",\"stocking\",\"none\"],\"mane\":\"normal\",\"build\":\"powerful\"},\"partner\":false,\"reasons\":[\"wins\",\"tournament\"],\"inductedAt\":1794193200020,\"career\":{\"races\":14,\"wins\":10,\"places\":12,\"tournamentWins\":1,\"firstRaceAt\":1794193200011,\"lastRaceAt\":1794193200019},\"highlights\":[{\"kind\":\"tournament_win\",\"text\":\"大会「オータムカップ」優勝\",\"params\":{\"tournament\":\"オータムカップ\",\"n\":1}},{\"kind\":\"wins\",\"text\":\"通算14戦10勝\",\"params\":{\"races\":14,\"wins\":10}},{\"kind\":\"biggest_win\",\"text\":\"最大の勝利：青葉競馬場 芝1600mのランク戦（12頭立て）\",\"params\":{\"course\":\"青葉競馬場 芝1600m\",\"mode\":\"ランク戦\",\"n\":12}},{\"kind\":\"career_span\",\"text\":\"現役1日・14戦\",\"params\":{\"days\":1,\"n\":14}}],\"frame\":true}}";
        internal const string Retire = "{\"id\":\"h2\",\"name\":\"ソラノカナタ\",\"rarity\":\"SR\",\"status\":\"retired\",\"ceremony\":{\"horseId\":\"h2\",\"horseName\":\"ソラノカナタ\",\"retiredAt\":1794193200020,\"partner\":false,\"career\":{\"races\":14,\"wins\":10,\"places\":12,\"tournamentWins\":1,\"firstRaceAt\":1794193200011,\"lastRaceAt\":1794193200019},\"highlights\":[{\"kind\":\"tournament_win\",\"text\":\"大会「オータムカップ」優勝\",\"params\":{\"tournament\":\"オータムカップ\",\"n\":1}},{\"kind\":\"wins\",\"text\":\"通算14戦10勝\",\"params\":{\"races\":14,\"wins\":10}},{\"kind\":\"biggest_win\",\"text\":\"最大の勝利：青葉競馬場 芝1600mのランク戦（12頭立て）\",\"params\":{\"course\":\"青葉競馬場 芝1600m\",\"mode\":\"ランク戦\",\"n\":12}},{\"kind\":\"career_span\",\"text\":\"現役1日・14戦\",\"params\":{\"days\":1,\"n\":14}}],\"inducted\":true,\"reasons\":[\"wins\",\"tournament\"],\"rewardItemId\":\"decor_hall_plaque_frame\",\"ackedAt\":null}}";

        [Fact]
        public async Task RetireReturnsTheCeremony()
        {
            _http.Reply(200, Retire);
            var r = await _api.RetireHorseAsync("h2");
            Assert.Equal("POST", _http.Requests[0].Method);
            Assert.Equal("/v1/horses/h2/retire", _http.Requests[0].Path);
            Assert.True(r.Horse.IsRetired);
            var c = r.Ceremony;
            Assert.True(c.Inducted);
            Assert.False(c.Seen);
            Assert.Equal(new[] { "wins", "tournament" }, c.Reasons);
            Assert.Equal("decor_hall_plaque_frame", c.RewardItemId);
            Assert.Equal("tournament_win", c.Highlights[0].Kind);
            Assert.Equal("オータムカップ", c.Highlights[0].Params["tournament"]);
            Assert.Equal("通算14戦10勝", c.Highlights[1].Text);
            Assert.Equal(14, c.Career.Races);
            Assert.Equal(10, c.Career.Wins);
            Assert.Equal(1, c.Career.TournamentWins);
        }

        [Fact]
        public async Task MyHallPagesWithTheCursorAndListsPendingCeremonies()
        {
            _http.Reply(200, Mine2);
            var p = await _api.GetMyHallAsync(null, 1);
            Assert.Equal("/v1/hall?limit=1", _http.Requests[0].Path);
            Assert.True(p.IsMine);
            Assert.Equal(2, p.Total);
            Assert.Single(p.Entries);
            Assert.Equal("ミナモノヒカリ", p.Entries[0].HorseName);
            Assert.True(p.Entries[0].Frame);
            Assert.NotNull(p.Entries[0].Appearance.Coat);
            Assert.NotNull(p.NextCursor);
            Assert.Equal("friends_team", p.Visibility);
            Assert.True(p.FrameOwned);
            Assert.Equal(10, p.Criteria.WinsMin);
            Assert.True(p.Criteria.TournamentWin);
            Assert.Equal(30, p.Criteria.PartnerRacesMin);
            Assert.Equal(2, p.PendingCeremonies.Count);
            _http.Reply(200, Mine);
            await _api.GetMyHallAsync(p.NextCursor, 1);
            Assert.Equal("/v1/hall?cursor=" + System.Uri.EscapeDataString(p.NextCursor) + "&limit=1", _http.Requests[1].Path);
        }

        [Fact]
        public async Task FriendHallShowsTheOwnerCardOnly()
        {
            _http.Reply(200, Visit);
            var p = await _api.GetHallAsync("demo_hof_1");
            Assert.Equal("/v1/hall/demo_hof_1", _http.Requests[0].Path);
            Assert.Equal("friend", p.Relation);
            Assert.False(p.IsMine);
            Assert.Equal("アオバ", p.Owner.DisplayName);
            Assert.NotNull(p.Owner.Silks);
            Assert.Equal(3, p.Total);
            Assert.Null(p.Criteria);
            Assert.Empty(p.PendingCeremonies);
        }

        [Fact]
        public async Task HorseCareerParsesProgressAndRecord()
        {
            _http.Reply(200, Career);
            var c = await _api.GetHorseCareerAsync("h1");
            Assert.Equal("/v1/horses/h1/career", _http.Requests[0].Path);
            Assert.True(c.Partner);
            Assert.Equal(5, c.Career.Races);
            Assert.Equal(3, c.Career.Wins);
            Assert.Equal(30, c.PartnerRacesProgress.Need);
            Assert.Equal(5, c.PartnerRacesProgress.Have);
            Assert.False(c.PartnerRacesProgress.Met);
            Assert.Equal(3, c.WinsProgress.Have);
            Assert.False(c.TournamentWin);
            Assert.False(c.Qualifies);
            Assert.NotNull(c.Preview);
            Assert.Null(c.Ceremony);
            Assert.Null(c.Entry);
            _http.Reply(200, RetiredCareer);
            var r = await _api.GetHorseCareerAsync("h2");
            Assert.Equal("retired", r.Status);
            Assert.Null(r.Preview);
            Assert.True(r.Ceremony.Inducted);
            Assert.Equal("ソラノカナタ", r.Entry.HorseName);
            Assert.True(r.TournamentWin);
        }

        [Fact]
        public async Task AcknowledgeAndVisibility()
        {
            _http.Reply(200, "{\"horseId\":\"h2\",\"ackedAt\":1794193200100,\"already\":false}");
            Assert.Equal(1794193200100L, await _api.AcknowledgeCeremonyAsync("h2"));
            Assert.Equal("/v1/hall/ceremonies/h2/ack", _http.Requests[0].Path);
            _http.Reply(200, "{\"visibility\":\"friends\"}");
            Assert.Equal("friends", await _api.SetHallVisibilityAsync("friends"));
            Assert.Equal("PUT", _http.Requests[1].Method);
            Assert.Contains("friends", _http.Requests[1].Body);
        }

        [Fact]
        public async Task ANotFoundVisitIsTheSameForEveryRefusal()
        {
            _http.Reply(404, "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"no hall to show\"}}");
            var e = await Assert.ThrowsAnyAsync<ApiException>(() => _api.GetHallAsync("x"));
            Assert.Equal("NOT_FOUND", e.WireCode);
        }
    }
}
