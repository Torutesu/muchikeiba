using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>Quality pass (raising & breeding, protocol Q1): growth stages (shared vectors), 馬カード, the training outlook, the foal reveal.</summary>
    public class HorseProfileTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public HorseProfileTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        private static JsonNode Get(JsonNode o, string k) { Assert.True(o.TryGet(k, out var x), k); return x; }

        [Fact]
        public void GrowthStagesMatchTheServerVectors()
        {
            var v = JsonNode.Parse(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "contracts", "horse-profile.vectors.json")));
            Assert.Equal(GrowthStages.Keys, Get(v, "stages").Items.Select(x => x.AsString()).ToArray());
            int n = 0;
            foreach (var c in Get(v, "cases").Items)
            {
                var g = GrowthStages.Of(Get(c, "trained").AsInt(), Get(c, "potential").AsInt());
                var next = Get(c, "nextAt");
                Assert.Equal(Get(c, "index").AsInt(), g.Index);
                Assert.Equal(Get(c, "key").AsString(), g.Key);
                Assert.Equal(next.IsNull ? -1 : next.AsInt(), g.NextAt);
                n++;
            }
            Assert.True(n >= 20);
            Assert.True(GrowthStages.StageUp(20, 26, 240));
            Assert.False(GrowthStages.StageUp(26, 32, 240));
            Assert.Equal("完成", GrowthStages.Of(240, 240).Name);
        }

        private const string ProfileJson = "{\"horseId\":\"h1\",\"name\":\"アカツキ\",\"rarity\":\"SR\",\"sex\":\"male\",\"style\":\"sashi\",\"status\":\"active\",\"surface\":\"turf\",\"distMinM\":1600,\"distMaxM\":2400,\"goingAptitude\":\"any\",\"partner\":true,"
            + "\"stats\":[{\"key\":\"speed\",\"base\":700,\"awakening\":0,\"trained\":0,\"race\":700,\"ranked\":589},{\"key\":\"burst\",\"base\":720,\"awakening\":0,\"trained\":6,\"race\":726,\"ranked\":611}],"
            + "\"totals\":{\"base\":3320,\"effective\":3320,\"race\":3332,\"ranked\":2799,\"classId\":\"C\",\"cap\":2800,\"capped\":true,\"toCap\":0},"
            + "\"growth\":{\"trainedTotal\":30,\"potential\":240,\"perStatCap\":96,\"stage\":1,\"stageKey\":\"growing\",\"nextStageAt\":84,\"sessions\":5},"
            + "\"leaning\":{\"stat\":\"burst\",\"trained\":12,\"sharePermilleBefore\":216,\"sharePermilleNow\":218},"
            + "\"lineage\":{\"generation\":2,\"line\":\"x\",\"sireName\":\"チチ\",\"damName\":\"ハハ\",\"studSire\":false,\"bred\":true,\"skill\":{\"id\":\"sk1\",\"name\":\"末脚一閃\"},\"skillFrom\":\"dam\",\"atavism\":{\"trait\":\"style\",\"value\":\"nige\",\"from\":\"ソフ\"}},"
            + "\"career\":{\"races\":12,\"wins\":3,\"places\":6,\"rivalWins\":1,\"tournamentWins\":0,\"biggestWin\":null,\"firstRaceAt\":1},"
            + "\"recentTraining\":[{\"at\":1,\"menuId\":\"hill\",\"grade\":\"great\",\"gain\":6,\"score\":10}]}";

        [Fact]
        public async Task ProfileParses()
        {
            _http.Reply(200, ProfileJson);
            var p = await _api.GetHorseProfileAsync("h1");
            Assert.Equal("/v1/horses/h1/profile", _http.Requests[0].Path);
            Assert.Equal("GET", _http.Requests[0].Method);
            Assert.Equal(726, p.Stat("burst").Race);
            Assert.Equal(6, p.Stat("burst").Trained);
            Assert.True(p.Totals.Capped);
            Assert.Equal(2800, p.Totals.Cap);
            Assert.Equal("growing", p.Growth.StageKey);
            Assert.Equal("成長期", p.Stage.Name);
            Assert.Equal(84, p.Growth.NextStageAt);
            Assert.Equal("burst", p.Leaning.Stat);
            Assert.Equal(2, p.Lineage.Generation);
            Assert.Equal("dam", p.Lineage.SkillFrom);
            Assert.Equal("末脚一閃", p.Lineage.Skill.Name);
            Assert.Equal("nige", p.Lineage.Atavism.Value);
            Assert.Equal(1, p.Career.RivalWins);
            Assert.Single(p.RecentTraining);
        }

        [Fact]
        public async Task OutlookParsesAndExplainsItself()
        {
            _http.Reply(200, "{\"enabled\":true,\"horses\":[{\"horseId\":\"h1\",\"menus\":[{\"id\":\"hill\",\"blocked\":null,\"outlook\":{\"min\":5,\"max\":6,\"efficiencyPermille\":850,\"bondPermille\":20,\"softPermille\":1000}},{\"id\":\"pool\",\"blocked\":null}]}]}");
            var h = (await _api.GetTrainingAsync()).Horses[0];
            Assert.Equal("+5〜+6", h.MenuOutlook["hill"].RangeText);
            Assert.Equal("疲れ −15%・絆 +2%", h.MenuOutlook["hill"].ReasonText);
            Assert.False(h.MenuOutlook.ContainsKey("pool")); // older servers: no outlook
        }

        [Fact]
        public void RarityPercent()
        {
            Assert.Equal("0%", FoalRarityOdds.Percent(0));
            Assert.Equal("<0.1%", FoalRarityOdds.Percent(400));
            Assert.Equal("0.1%", FoalRarityOdds.Percent(500));
            Assert.Equal("12.3%", FoalRarityOdds.Percent(123_400));
            Assert.Equal("100.0%", FoalRarityOdds.Percent(1_000_000));
        }

        [Fact]
        public void FoalRevealPlacesEachStatInThePreviewRange()
        {
            var p = new BreedingPreview
            {
                Stats = new Dictionary<string, StatRange>
                {
                    ["speed"] = new StatRange { Min = 600, Max = 720 }, ["stamina"] = new StatRange { Min = 600, Max = 720 }, ["burst"] = new StatRange { Min = 600, Max = 720 },
                    ["guts"] = new StatRange { Min = 600, Max = 720 }, ["temper"] = new StatRange { Min = 600, Max = 720 },
                },
                Rarity = new FoalRarityOdds { R = 900_000, SR = 99_000, SSR = 1_000, Known = true },
            };
            p.Skill.Candidates.Add(new SkillInheritCandidate { Skill = new SkillSummary { Id = "sk1" }, Permille = 150, From = new[] { "dam" } });
            var foal = new Horse { Rarity = "SR", Style = "nige", SkillId = "sk1", Base = new Stats { Speed = 720, Stamina = 600, Burst = 660, Guts = 700, Temper = 610 } };
            var r = FoalReveal.Build(p, foal, "nige", "sashi");
            Assert.Equal(new[] { 1000, 0, 500, 833, 83 }, r.Stats.Select(s => s.PositionPermille).ToArray());
            Assert.Equal(new[] { "high", "low", "mid", "high", "low" }, r.Stats.Select(s => s.Mark).ToArray());
            Assert.Equal(2, r.HighCount);
            Assert.Equal(3290, r.Total);
            Assert.Equal(99_000, r.RarityChancePpm);
            Assert.Equal("sire", r.StyleFrom);
            Assert.Equal("dam", r.SkillFrom);
            foal.Atavism = new AtavismTrait { Trait = "style", Value = "nige", From = "ソフ" };
            Assert.Equal("atavism", FoalReveal.Build(p, foal, "sashi", "sashi").StyleFrom);
            Assert.Equal(-1, FoalReveal.Build(new BreedingPreview(), foal, "a", "b").RarityChancePpm); // older server: no odds
        }
    }
}
