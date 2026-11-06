using System.Linq;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>
    /// Round 9 gacha live-ops on the wire (contracts/protocol.md §17): banner calendar, pity meter with the carry-over rule,
    /// step-up progress and the extended odds page. The bodies below were produced by the real server code (gacha.ts with the
    /// shipped master data at 2026-11-06 12:00 JST; odds rows trimmed), so their shapes match server/src/domain/gacha.ts.
    /// </summary>
    public class ApiClientGachaLiveOpsTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientGachaLiveOpsTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        internal const string Banners = @"{""serverNowMs"":1793934000000,""banners"":[{""id"":""pickup_ginga"",""name"":""ピックアップ：ギンガノカナタ"",""currency"":""any"",""priceSingle"":100,""priceTen"":1000,""status"":""active"",""startAtMs"":1793458800000,""endAtMs"":1796050800000,""announceAtMs"":1793199600000,""lastDay"":""2026-11-30"",""daysLeft"":25,""pityGroup"":""pickup_ginga"",""pityLabel"":""ピックアップ（ギンガノカナタ）"",""pityCost"":100,""pityTargets"":[""t_ginga""],""pickup"":{""templateId"":""t_ginga"",""name"":""ギンガノカナタ"",""rarity"":""SSR""},""limited"":false,""stepUp"":null},{""id"":""pickup_akatsuki"",""name"":""ピックアップ：シンセイアカツキ"",""currency"":""any"",""priceSingle"":100,""priceTen"":1000,""status"":""active"",""startAtMs"":null,""endAtMs"":null,""announceAtMs"":null,""lastDay"":null,""daysLeft"":null,""pityGroup"":""pickup"",""pityLabel"":""ピックアップ"",""pityCost"":100,""pityTargets"":[""t_akatsuki""],""pickup"":{""templateId"":""t_akatsuki"",""name"":""シンセイアカツキ"",""rarity"":""SSR""},""limited"":false,""stepUp"":null},{""id"":""stepup_paid"",""name"":""有償限定ステップアップ"",""currency"":""paidOnly"",""singleAllowed"":false,""priceSingle"":null,""priceTen"":null,""status"":""active"",""startAtMs"":null,""endAtMs"":null,""announceAtMs"":null,""lastDay"":null,""daysLeft"":null,""pityGroup"":""pickup"",""pityLabel"":""ピックアップ"",""pityCost"":100,""pityTargets"":[""t_akatsuki""],""pickup"":null,""limited"":false,""stepUp"":{""steps"":5,""afterLast"":""loop"",""prices"":[500,1000,1000,1000,1000],""finalSlotSteps"":[5]}},{""id"":""standard"",""name"":""恒常ガチャ"",""currency"":""any"",""priceSingle"":100,""priceTen"":1000,""status"":""active"",""startAtMs"":null,""endAtMs"":null,""announceAtMs"":null,""lastDay"":null,""daysLeft"":null,""pityGroup"":""standard"",""pityLabel"":""恒常"",""pityCost"":100,""pityTargets"":[""t_akatsuki"",""t_ginga"",""t_kohaku"",""t_tsukikage""],""pickup"":null,""limited"":false,""stepUp"":null}]}";
        internal const string Status = @"{""serverNowMs"":1793934000000,""groups"":[{""group"":""standard"",""label"":""恒常"",""points"":12,""cost"":100,""remaining"":88,""exchangeable"":0,""banners"":[""standard""],""targets"":[{""templateId"":""t_akatsuki"",""name"":""シンセイアカツキ"",""owned"":false},{""templateId"":""t_ginga"",""name"":""ギンガノカナタ"",""owned"":false},{""templateId"":""t_kohaku"",""name"":""コハクノヒカリ"",""owned"":false},{""templateId"":""t_tsukikage"",""name"":""ツキカゲロード"",""owned"":true}],""closesAtMs"":null,""carryOver"":null},{""group"":""pickup"",""label"":""ピックアップ"",""points"":10,""cost"":100,""remaining"":90,""exchangeable"":0,""banners"":[""pickup_akatsuki"",""stepup_paid""],""targets"":[{""templateId"":""t_akatsuki"",""name"":""シンセイアカツキ"",""owned"":false}],""closesAtMs"":null,""carryOver"":null},{""group"":""pickup_ginga"",""label"":""ピックアップ（ギンガノカナタ）"",""points"":37,""cost"":100,""remaining"":63,""exchangeable"":0,""banners"":[""pickup_ginga""],""targets"":[{""templateId"":""t_ginga"",""name"":""ギンガノカナタ"",""owned"":false}],""closesAtMs"":1796050800000,""carryOver"":{""atMs"":1796050800000,""toGroup"":""standard"",""toLabel"":""恒常"",""rate"":""1:1"",""expires"":false,""toTargets"":[{""templateId"":""t_akatsuki"",""name"":""シンセイアカツキ""},{""templateId"":""t_ginga"",""name"":""ギンガノカナタ""},{""templateId"":""t_kohaku"",""name"":""コハクノヒカリ""},{""templateId"":""t_tsukikage"",""name"":""ツキカゲロード""}],""notice"":""2026-12-01 00:00 JSTに、残っている交換ptはすべて「恒常」の交換ptへ1:1で移ります。失効しません。移った後はシンセイアカツキ・ギンガノカナタ・コハクノヒカリ・ツキカゲロードのどれかと交換できます（抽選ではありません）。""}}],""banners"":[{""bannerId"":""standard"",""pityGroup"":""standard"",""points"":12,""cost"":100,""remaining"":88,""coinsToExchange"":8800,""stepUp"":null},{""bannerId"":""pickup_akatsuki"",""pityGroup"":""pickup"",""points"":10,""cost"":100,""remaining"":90,""coinsToExchange"":9000,""stepUp"":null},{""bannerId"":""pickup_ginga"",""pityGroup"":""pickup_ginga"",""points"":37,""cost"":100,""remaining"":63,""coinsToExchange"":6300,""stepUp"":null},{""bannerId"":""stepup_paid"",""pityGroup"":""pickup"",""points"":10,""cost"":100,""remaining"":90,""coinsToExchange"":8000,""stepUp"":{""completed"":5,""steps"":5,""afterLast"":""loop"",""step"":1,""round"":2,""priceTen"":500,""finalSlotMinRarity"":null}}]}";
        internal const string Draw = @"{""bannerId"":""stepup_paid"",""results"":[{""templateId"":""t_kawarabi"",""rarity"":""R"",""horseId"":""h1"",""duplicate"":false,""material"":0,""guaranteed"":false,""appearance"":{""coat"":""dark_bay"",""face"":""none"",""legs"":[""none"",""none"",""sock"",""none""],""mane"":""normal"",""build"":""rangy""}},{""templateId"":""t_kazamidori"",""rarity"":""R"",""horseId"":""h2"",""duplicate"":false,""material"":0,""guaranteed"":false,""appearance"":{""coat"":""dark_bay"",""face"":""none"",""legs"":[""none"",""none"",""none"",""none""],""mane"":""dark"",""build"":""standard""}},{""templateId"":""t_tsukikage"",""rarity"":""SSR"",""horseId"":""h8"",""duplicate"":false,""material"":0,""guaranteed"":true,""appearance"":{""coat"":""black"",""face"":""star_stripe"",""legs"":[""none"",""none"",""stocking"",""none""],""mane"":""dark"",""build"":""rangy""}}],""spent"":{""paid"":1000,""free"":0},""pityPoints"":10,""stepUp"":{""drawnStep"":5,""next"":{""completed"":5,""steps"":5,""afterLast"":""loop"",""step"":1,""round"":2,""priceTen"":500,""finalSlotMinRarity"":null}}}";
        internal const string OddsGinga = @"{""bannerId"":""pickup_ginga"",""name"":""ピックアップ：ギンガノカナタ"",""currency"":""any"",""priceSingle"":100,""priceTen"":1000,""period"":{""startAtMs"":1793458800000,""endAtMs"":1796050800000,""lastDay"":""2026-11-30""},""limitedNotice"":null,""items"":[{""templateId"":""t_yukimi"",""name"":""ユキミザクラ"",""rarity"":""R"",""ppm"":65834,""rate"":""6.5834%"",""skill"":{""id"":""sk_kouinonebari"",""name"":""好位の粘り"",""rarity"":""R"",""condition"":""最後の直線で前に1頭以内"",""effect"":""4秒間 目標速度+1.5%""}},{""templateId"":""t_natsu"",""name"":""ナツノアラシ"",""rarity"":""R"",""ppm"":65834,""rate"":""6.5834%"",""skill"":{""id"":""sk_hitonobi"",""name"":""ラストひと伸び"",""rarity"":""R"",""condition"":""残り150m"",""effect"":""3秒間 目標速度+1.5%""}}],""rarityTotals"":{""R"":{""ppm"":790000,""rate"":""79.0000%""},""SR"":{""ppm"":180000,""rate"":""18.0000%""},""SSR"":{""ppm"":30000,""rate"":""3.0000%""}},""pickup"":{""templateId"":""t_ginga"",""name"":""ギンガノカナタ"",""rarity"":""SSR"",""ppm"":15000,""rate"":""1.5000%"",""guaranteePpm"":15000,""guaranteeRate"":""1.5000%""},""guarantee"":{""appliesTo"":""10連の10枠目（1〜9枠目にSR以上が出なかった場合のみ、この表で抽選）"",""items"":[{""templateId"":""t_harukaze"",""name"":""ハルカゼノミチ"",""rarity"":""SR"",""ppm"":138572,""rate"":""13.8572%"",""skill"":{""id"":""sk_kagefumase"",""name"":""影踏ませず"",""rarity"":""SR"",""condition"":""残り400mで先頭"",""effect"":""4秒間 目標速度+1.8%""}}],""rarityTotals"":{""SR"":{""ppm"":970000,""rate"":""97.0000%""},""SSR"":{""ppm"":30000,""rate"":""3.0000%""}}},""stepUp"":null,""pity"":{""group"":""pickup_ginga"",""label"":""ピックアップ（ギンガノカナタ）"",""pullsRequired"":100,""targets"":[""t_ginga""],""costCoins"":10000,""estimatedMaxCostYen"":16000,""closesAtMs"":1796050800000,""carryOver"":{""atMs"":1796050800000,""toGroup"":""standard"",""toLabel"":""恒常"",""rate"":""1:1"",""expires"":false,""toTargets"":[{""templateId"":""t_akatsuki"",""name"":""シンセイアカツキ""},{""templateId"":""t_ginga"",""name"":""ギンガノカナタ""},{""templateId"":""t_kohaku"",""name"":""コハクノヒカリ""},{""templateId"":""t_tsukikage"",""name"":""ツキカゲロード""}],""notice"":""2026-12-01 00:00 JSTに、残っている交換ptはすべて「恒常」の交換ptへ1:1で移ります。失効しません。移った後はシンセイアカツキ・ギンガノカナタ・コハクノヒカリ・ツキカゲロードのどれかと交換できます（抽選ではありません）。""}},""duplicates"":{""R"":1,""SR"":5,""SSR"":20}}";
        internal const string OddsStep = @"{""bannerId"":""stepup_paid"",""name"":""有償限定ステップアップ"",""currency"":""paidOnly"",""singleAllowed"":false,""priceSingle"":null,""priceTen"":null,""period"":{""startAtMs"":null,""endAtMs"":null,""lastDay"":null},""limitedNotice"":null,""items"":[{""templateId"":""t_yukimi"",""name"":""ユキミザクラ"",""rarity"":""R"",""ppm"":61667,""rate"":""6.1667%"",""skill"":{""id"":""sk_kouinonebari"",""name"":""好位の粘り"",""rarity"":""R"",""condition"":""最後の直線で前に1頭以内"",""effect"":""4秒間 目標速度+1.5%""}},{""templateId"":""t_natsu"",""name"":""ナツノアラシ"",""rarity"":""R"",""ppm"":61667,""rate"":""6.1667%"",""skill"":{""id"":""sk_hitonobi"",""name"":""ラストひと伸び"",""rarity"":""R"",""condition"":""残り150m"",""effect"":""3秒間 目標速度+1.5%""}}],""rarityTotals"":{""R"":{""ppm"":740000,""rate"":""74.0000%""},""SR"":{""ppm"":200000,""rate"":""20.0000%""},""SSR"":{""ppm"":60000,""rate"":""6.0000%""}},""pickup"":null,""guarantee"":{""appliesTo"":""10連の10枠目（1〜9枠目にSR以上が出なかった場合のみ、この表で抽選）"",""items"":[{""templateId"":""t_harukaze"",""name"":""ハルカゼノミチ"",""rarity"":""SR"",""ppm"":134286,""rate"":""13.4286%"",""skill"":{""id"":""sk_kagefumase"",""name"":""影踏ませず"",""rarity"":""SR"",""condition"":""残り400mで先頭"",""effect"":""4秒間 目標速度+1.8%""}}],""rarityTotals"":{""SR"":{""ppm"":940000,""rate"":""94.0000%""},""SSR"":{""ppm"":60000,""rate"":""6.0000%""}}},""stepUp"":{""afterLast"":""loop"",""notice"":""10連のみ。1回引くごとに次のステップへ進みます。ステップ5の次はステップ1に戻ります。1〜9枠目は上の表、10枠目は各ステップの表で抽選します。"",""steps"":[{""step"":1,""priceTen"":500,""finalSlot"":{""appliesTo"":""ステップ1の10枠目（上の保証の表。1〜9枠目にSR以上が出なかった場合のみ）"",""items"":null,""rarityTotals"":null}},{""step"":2,""priceTen"":1000,""finalSlot"":{""appliesTo"":""ステップ2の10枠目（上の保証の表。1〜9枠目にSR以上が出なかった場合のみ）"",""items"":null,""rarityTotals"":null}},{""step"":3,""priceTen"":1000,""finalSlot"":{""appliesTo"":""ステップ3の10枠目（上の保証の表。1〜9枠目にSR以上が出なかった場合のみ）"",""items"":null,""rarityTotals"":null}},{""step"":4,""priceTen"":1000,""finalSlot"":{""appliesTo"":""ステップ4の10枠目（上の保証の表。1〜9枠目にSR以上が出なかった場合のみ）"",""items"":null,""rarityTotals"":null}},{""step"":5,""priceTen"":1000,""finalSlot"":{""appliesTo"":""ステップ5の10枠目（必ずこの表で抽選）"",""items"":[{""templateId"":""t_akatsuki"",""name"":""シンセイアカツキ"",""rarity"":""SSR"",""ppm"":250000,""rate"":""25.0000%"",""skill"":{""id"":""sk_kireaji"",""name"":""切れ味鋭く"",""rarity"":""SSR"",""condition"":""スパート区間で前に3頭以上"",""effect"":""5秒間 目標速度+2%""}},{""templateId"":""t_ginga"",""name"":""ギンガノカナタ"",""rarity"":""SSR"",""ppm"":250000,""rate"":""25.0000%"",""skill"":{""id"":""sk_oudou"",""name"":""王道の構え"",""rarity"":""SSR"",""condition"":""最後の直線で前に4頭以内"",""effect"":""4秒間 目標速度+2%""}}],""rarityTotals"":{""SSR"":{""ppm"":1000000,""rate"":""100.0000%""}}}}]},""pity"":{""group"":""pickup"",""label"":""ピックアップ"",""pullsRequired"":100,""targets"":[""t_akatsuki""],""costCoins"":9000,""estimatedMaxCostYen"":14400,""closesAtMs"":null,""carryOver"":null},""duplicates"":{""R"":1,""SR"":5,""SSR"":20}}";

        private HttpRequest Last(string method, string path, bool auth)
        {
            var r = _http.Requests[_http.Requests.Count - 1];
            Assert.Equal(method, r.Method);
            Assert.Equal(path, r.Path);
            Assert.Equal(auth, r.Headers.ContainsKey("authorization"));
            return r;
        }

        [Fact]
        public async Task BannerScheduleCarriesTheServerClockAndRealEndTimes()
        {
            _http.Reply(200, Banners);
            var s = await _api.GetBannerScheduleAsync();
            Last("GET", "/v1/gacha/banners", false);
            Assert.Equal(1793934000000L, s.ServerNowMs);
            Assert.Equal(new[] { "pickup_ginga", "pickup_akatsuki", "stepup_paid", "standard" }, s.Banners.Select(b => b.Id).ToArray());
            var g = s.Banners[0];
            Assert.Equal("active", g.Status);
            Assert.False(g.Upcoming);
            Assert.Equal(1796050800000L, g.EndAtMs);
            Assert.Equal("2026-11-30", g.LastDay);
            Assert.Equal(25, g.DaysLeft);
            Assert.Equal("t_ginga", g.Pickup.TemplateId);
            Assert.Equal("ピックアップ（ギンガノカナタ）", g.PityLabel);
            Assert.Equal(100, g.PityCost);
            // permanent banners: no end, no countdown data
            Assert.All(s.Banners.Skip(1), b => { Assert.Null(b.EndAtMs); Assert.Null(b.DaysLeft); });
            var st = s.Banners[2].StepUp;
            Assert.Equal(new[] { 500, 1000, 1000, 1000, 1000 }, st.Prices);
            Assert.Equal(new[] { 5 }, st.FinalSlotSteps);
            Assert.Equal("loop", st.AfterLast);
            Assert.True(s.Banners[2].PaidOnly);
            // QA r9: a step-up banner has no single pull and no flat 10-pull price (step prices only)
            Assert.False(s.Banners[2].SingleAllowed);
            Assert.Equal(0, s.Banners[2].PriceSingle);
            Assert.True(g.SingleAllowed);

            // the list variant parses the same body
            _http.Reply(200, Banners);
            Assert.Equal(4, (await _api.GetBannersAsync()).Count);
        }

        [Fact]
        public void OlderServersWithoutStatusParseAsActive()
        {
            var s = BannerSchedule.FromJson("{\"banners\":[{\"id\":\"standard\",\"name\":\"恒常ガチャ\",\"currency\":\"any\",\"priceSingle\":100,\"priceTen\":1000,\"startAtMs\":null,\"endAtMs\":null}]}");
            Assert.Equal("active", s.Banners[0].Status);
            Assert.Null(s.Banners[0].StepUp);
            Assert.Null(s.Banners[0].Pickup);
            Assert.True(s.Banners[0].SingleAllowed); // older servers: singles allowed as before
            Assert.True(OddsDisclosure.FromJson(OddsGinga).SingleAllowed);
            Assert.False(OddsDisclosure.FromJson(OddsStep).SingleAllowed);
        }

        [Fact]
        public async Task GachaStatusHasThePityMeterTheCarryOverRuleAndStepUpProgress()
        {
            _http.Reply(200, Status);
            var s = await _api.GetGachaStatusAsync();
            Last("GET", "/v1/gacha/status", true);
            var g = s.ForGroup("pickup_ginga");
            Assert.Equal(37, g.Points);
            Assert.Equal(63, g.Remaining);
            Assert.Equal(0, g.Exchangeable);
            Assert.Equal(1796050800000L, g.ClosesAtMs);
            var c = g.CarryOver;
            Assert.Equal("standard", c.ToGroup);
            Assert.Equal("恒常", c.ToLabel);
            Assert.Equal("1:1", c.Rate);
            Assert.False(c.Expires);
            Assert.Equal(4, c.ToTargets.Count);
            Assert.StartsWith("2026-12-01 00:00 JSTに", c.Notice);
            Assert.Null(s.ForGroup("standard").CarryOver);
            Assert.True(s.ForGroup("standard").Targets.Single(t => t.TemplateId == "t_tsukikage").Owned);
            Assert.Equal(6300, s.ForBanner("pickup_ginga").CoinsToExchange);
            var su = s.ForBanner("stepup_paid").StepUp;
            Assert.Equal(1, su.Step);
            Assert.Equal(2, su.Round);
            Assert.Equal(500, su.PriceTen);
            Assert.Null(su.FinalSlotMinRarity);
            Assert.Equal(8000, s.ForBanner("stepup_paid").CoinsToExchange);
        }

        [Fact]
        public async Task StatusNeedsSignInAndIsRetriedOnServerErrors()
        {
            _http.Reply(503, "{}").Reply(200, Status);
            var s = await _api.GetGachaStatusAsync();
            Assert.Equal(2, _http.Requests.Count);
            Assert.Equal(3, s.Groups.Count);
        }

        [Fact]
        public void StepUpDrawResultNamesTheStepJustDrawnAndTheNextOne()
        {
            var d = DrawResult.FromJson(Draw);
            Assert.Equal(5, d.StepUp.DrawnStep);
            Assert.Equal(1, d.StepUp.Next.Step);
            Assert.Equal(1000, d.SpentPaid);
            Assert.Equal(0, d.SpentFree);
            var last = d.Results[d.Results.Count - 1];
            Assert.Equal("SSR", last.Rarity);
            Assert.True(last.Guaranteed);
        }

        [Fact]
        public async Task OddsPageCarriesPickupRateStepTablesPityCostAndCarryOver()
        {
            _http.Reply(200, OddsGinga);
            var o = await _api.GetOddsAsync("pickup_ginga");
            Last("GET", "/v1/gacha/pickup_ginga/odds", false);
            Assert.Equal("1.5000%", o.Pickup.Rate);
            Assert.Equal(15000, o.Pickup.Ppm);
            Assert.Equal("2026-11-30", o.LastDay);
            Assert.Equal(10000, o.PityCostCoins);
            Assert.Equal("恒常", o.PityCarryOver.ToLabel);
            Assert.Null(o.StepUp);

            _http.Reply(200, OddsStep);
            var s = await _api.GetOddsAsync("stepup_paid");
            Assert.Null(s.Pickup);
            Assert.Null(s.PityCarryOver);
            Assert.Equal(9000, s.PityCostCoins);
            Assert.Equal(5, s.StepUp.Steps.Count);
            Assert.Null(s.StepUp.Steps[0].FinalSlotItems);
            var s5 = s.StepUp.Steps[4];
            Assert.Equal(1000, s5.PriceTen);
            Assert.Equal(1000000, s5.FinalSlotRarityTotals["SSR"].Ppm);
            Assert.Equal("25.0000%", s5.FinalSlotItems[0].Rate);
            Assert.Contains("ステップ5の次はステップ1", s.StepUp.Notice);
        }
    }
}
