using System.Linq;
using Muchi.Client;

namespace Muchi.Engine.Tests
{
    /// <summary>
    /// Quality pass 3 (docs/quality/pass.md): the season pass standout tiers on the wire. The bodies below were produced by the
    /// real server code (PlayerService.passView at level 15 without the pass, shop.ts productContents) with the shipped master.
    /// </summary>
    public class ApiClientPassStandoutTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientPassStandoutTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        internal const string PassView = @"{""seasonId"":""2026-11"",""level"":15,""xp"":1520,""xpPerLevel"":100,""maxLevel"":30,""xpToNextLevel"":80,""racesToNextLevel"":4,""active"":false,""expiresAt"":0,""seasonEndsAt"":1796050800000,""remainingDays"":26,""lastWeek"":false,""autoRenew"":false,""boostLevels"":0,""owned"":[],""purchasable"":[""season_pass"",""season_pass_plus""],""claimed"":{""free"":[],""premium"":[]},""rewards"":{""free"":{""every"":1,""reward"":{""freeCoins"":10},""tiers"":{""15"":{""freeCoins"":10,""items"":[{""itemId"":""silkpart_cap_comet"",""qty"":1}]}}},""premium"":{""every"":1,""reward"":{""freeCoins"":50,""items"":[{""itemId"":""breeding_material"",""qty"":1}]},""tiers"":{""10"":{""freeCoins"":50,""items"":[{""itemId"":""breeding_material"",""qty"":1},{""itemId"":""silkpart_color_shokou"",""qty"":1}]},""20"":{""freeCoins"":50,""items"":[{""itemId"":""breeding_material"",""qty"":1},{""itemId"":""silkpart_sleeve_comet"",""qty"":1}]},""30"":{""freeCoins"":50,""items"":[{""itemId"":""breeding_material"",""qty"":1},{""itemId"":""costume_silks_comet"",""qty"":1}]}}}},""autoGrantAtSeasonEnd"":true,""lastSeason"":null,""standouts"":[{""track"":""premium"",""level"":10,""itemId"":""silkpart_color_shokou"",""label"":""勝負服の色「曙光」"",""purpose"":""勝負服の色が選べるようになります（見た目だけ。ランク戦の能力は変わりません）"",""look"":{""part"":""color"",""ref"":""shokou""},""reward"":{""freeCoins"":50,""items"":[{""itemId"":""breeding_material"",""qty"":1},{""itemId"":""silkpart_color_shokou"",""qty"":1}]},""owned"":false,""reached"":true,""claimed"":false,""claimable"":false,""levelsAway"":0,""racesAway"":0},{""track"":""free"",""level"":15,""itemId"":""silkpart_cap_comet"",""label"":""勝負服の帽子「流れ星」"",""purpose"":""勝負服の帽子が選べるようになります（見た目だけ。ランク戦の能力は変わりません）"",""look"":{""part"":""cap"",""ref"":""comet""},""reward"":{""freeCoins"":10,""items"":[{""itemId"":""silkpart_cap_comet"",""qty"":1}]},""owned"":false,""reached"":true,""claimed"":false,""claimable"":true,""levelsAway"":0,""racesAway"":0},{""track"":""premium"",""level"":20,""itemId"":""silkpart_sleeve_comet"",""label"":""勝負服の袖「流星」"",""purpose"":""勝負服の袖が選べるようになります（見た目だけ。ランク戦の能力は変わりません）"",""look"":{""part"":""sleeve"",""ref"":""comet""},""reward"":{""freeCoins"":50,""items"":[{""itemId"":""breeding_material"",""qty"":1},{""itemId"":""silkpart_sleeve_comet"",""qty"":1}]},""owned"":false,""reached"":false,""claimed"":false,""claimable"":false,""levelsAway"":5,""racesAway"":24},{""track"":""premium"",""level"":30,""itemId"":""costume_silks_comet"",""label"":""勝負服の柄「流星群」"",""purpose"":""勝負服の柄が選べるようになります（見た目だけ。ランク戦の能力は変わりません）"",""look"":{""part"":""pattern"",""ref"":""comet""},""reward"":{""freeCoins"":50,""items"":[{""itemId"":""breeding_material"",""qty"":1},{""itemId"":""costume_silks_comet"",""qty"":1}]},""owned"":false,""reached"":false,""claimed"":false,""claimable"":false,""levelsAway"":15,""racesAway"":74}],""nextStandout"":{""track"":""premium"",""level"":20,""itemId"":""silkpart_sleeve_comet"",""label"":""勝負服の袖「流星」"",""levelsAway"":5,""racesAway"":24},""totals"":{""free"":{""freeCoins"":300,""items"":[{""itemId"":""silkpart_cap_comet"",""qty"":1}]},""premium"":{""freeCoins"":1500,""items"":[{""itemId"":""breeding_material"",""qty"":30},{""itemId"":""silkpart_color_shokou"",""qty"":1},{""itemId"":""silkpart_sleeve_comet"",""qty"":1},{""itemId"":""costume_silks_comet"",""qty"":1}]}}}";
        internal const string PassPremium = @"{""type"":""pass_premium"",""levels"":30,""reward"":{""freeCoins"":50,""items"":[{""itemId"":""breeding_material"",""qty"":1}]},""label"":""シーズンパス有料ライン 全30段（各段：無償コイン50枚＋配合素材×1）"",""total"":{""freeCoins"":1500,""items"":[{""itemId"":""breeding_material"",""qty"":30}]},""totalLabel"":""30段の合計：無償コイン1,500枚＋配合素材×30"",""standouts"":[{""level"":10,""itemId"":""silkpart_color_shokou"",""label"":""勝負服の色「曙光」""},{""level"":20,""itemId"":""silkpart_sleeve_comet"",""label"":""勝負服の袖「流星」""},{""level"":30,""itemId"":""costume_silks_comet"",""label"":""勝負服の柄「流星群」""}],""standoutLabel"":""ティア10 勝負服の色「曙光」・ティア20 勝負服の袖「流星」・ティア30 勝負服の柄「流星群」""}";

        [Fact]
        public async Task StandoutsNextAndTotals()
        {
            _http.Reply(200, PassView);
            var p = await _api.GetSeasonPassAsync();
            Assert.Equal(15, p.Level);
            Assert.Equal(new[] { 10, 15, 20, 30 }, p.Standouts.Select(x => x.Level).ToArray());
            var ten = p.Standouts[0];
            Assert.True(ten.Premium);
            Assert.Equal("silkpart_color_shokou", ten.ItemId);
            Assert.Equal("勝負服の色「曙光」", ten.Label);
            Assert.Equal("color", ten.Look.Part);
            Assert.Equal("shokou", ten.Look.Ref);
            Assert.True(ten.Reached);
            Assert.False(ten.Claimable); // the pass is not owned
            Assert.Equal(50, ten.Reward.FreeCoins);
            var cap = p.Standouts[1];
            Assert.Equal("free", cap.Track);
            Assert.True(cap.Claimable);
            Assert.Equal(20, p.NextStandout.Level);
            Assert.Equal(5, p.NextStandout.LevelsAway);
            Assert.Equal(24, p.NextStandout.RacesAway);
            Assert.Equal(1500, p.PremiumTotal.FreeCoins);
            Assert.Equal(300, p.FreeTotal.FreeCoins);
            // the line's own reward stays (older screens), and At() reads a tier's own reward
            Assert.Equal(50, p.PremiumLine.Reward.FreeCoins);
            Assert.Single(p.PremiumLine.Reward.Items);
            Assert.Equal(2, p.PremiumLine.At(10).Items.Count);
            Assert.Single(p.PremiumLine.At(11).Items);
            Assert.Equal("silkpart_cap_comet", p.FreeLine.At(15).Items[0].ItemId);
            Assert.Null(p.FreeLine.At(0));
        }

        [Fact]
        public async Task OlderServerHasNoStandouts()
        {
            _http.Reply(200, ApiClientRound8Tests.SeasonPass);
            var p = await _api.GetSeasonPassAsync();
            Assert.Empty(p.Standouts);
            Assert.Null(p.NextStandout);
            Assert.Empty(p.PremiumLine.Tiers);
            Assert.Equal(50, p.PremiumLine.At(10).FreeCoins);
        }

        [Fact]
        public async Task ProductNamesTheStandoutTiers()
        {
            _http.Reply(200, "{\"products\":[{\"id\":\"season_pass\",\"kind\":\"season_pass\",\"name\":\"シーズンパス\",\"tab\":\"pass\",\"priceYen\":1000,\"paidCoins\":0,\"contents\":[" + PassPremium + "]}]}");
            var c = (await _api.GetProductsAsync()).Products[0].Contents[0];
            Assert.Equal("pass_premium", c.Type);
            Assert.Equal("30段の合計：無償コイン1,500枚＋配合素材×30", c.TotalLabel);
            Assert.Equal(new[] { 10, 20, 30 }, c.Standouts.Select(x => x.Level).ToArray());
            Assert.Equal("ティア10 勝負服の色「曙光」・ティア20 勝負服の袖「流星」・ティア30 勝負服の柄「流星群」", c.StandoutLabel);
        }

        [Fact]
        public void PreviewPutsTheStandoutOnTheOwnSilks()
        {
            var mine = new SilksDesign { Pattern = "hoops", Colors = new[] { "navy", "white" }, Sleeve = "match", Cap = "plain", CapColors = new[] { "navy", "white" } };
            var color = PassPreview.Apply(mine, new PassLook { Part = "color", Ref = "shokou" });
            Assert.Equal(new[] { "navy", "shokou" }, color.Colors);
            Assert.Equal("hoops", color.Pattern);
            Assert.Equal(new[] { "navy", "white" }, mine.Colors); // never changes the player's own design
            var pattern = PassPreview.Apply(mine, new PassLook { Part = "pattern", Ref = "comet" });
            Assert.Equal("comet", pattern.Pattern);
            Assert.Equal(new[] { "navy", "white", "gold" }, pattern.Colors);
            Assert.Equal("comet", PassPreview.Apply(mine, new PassLook { Part = "sleeve", Ref = "comet" }).Sleeve);
            Assert.Equal("comet", PassPreview.Apply(mine, new PassLook { Part = "cap", Ref = "comet" }).Cap);
            Assert.True(PassPreview.Apply(mine, new PassLook { Part = "tack", Slot = "bridle", Asset = "tack/x" }).SameAs(mine));
            var set = PassPreview.ApplyAll(mine, new[]
            {
                new PassStandout { Track = "premium", Level = 30, Look = new PassLook { Part = "pattern", Ref = "comet" } },
                new PassStandout { Track = "free", Level = 15, Look = new PassLook { Part = "cap", Ref = "comet" } },
                new PassStandout { Track = "premium", Level = 10, Look = new PassLook { Part = "color", Ref = "shokou" } },
                new PassStandout { Track = "premium", Level = 20, Look = new PassLook { Part = "sleeve", Ref = "comet" } },
            });
            Assert.Equal("comet", set.Pattern);
            Assert.Equal("comet", set.Sleeve);
            Assert.Equal("plain", set.Cap); // the free line's cap is not part of the premium set
            Assert.Equal(new[] { "navy", "shokou", "gold" }, set.Colors);
        }
    }
}
