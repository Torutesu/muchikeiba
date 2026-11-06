using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>Unique skills on the wire (GET /v1/skills, horse.skillId, gacha odds rows, breeding preview; REQ-UXS-050).</summary>
    public class ApiClientSkillTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientSkillTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        [Fact]
        public async Task SkillCatalogParsesAndLooksUpById()
        {
            _http.Reply(200, "{\"skills\":[{\"id\":\"sk_nukedashi\",\"name\":\"先行抜け出し\",\"rarity\":\"SR\",\"styles\":[\"senko\"],\"trigger\":\"finalStraight\",\"value\":2,"
                + "\"speedPermille\":18,\"accelPermille\":0,\"drainSavePermille\":0,\"recoverPermille\":0,\"durationTicks\":80,"
                + "\"condition\":\"最後の直線で前に2頭以内\",\"effect\":\"4秒間 目標速度+1.8%\",\"rankedEffect\":\"4秒間 目標速度+1.8%\"}],\"notice\":\"n\"}");
            var cat = await _api.GetSkillsAsync();
            var r = _http.Requests.Last();
            Assert.Equal("GET", r.Method);
            Assert.Equal("/v1/skills", r.Path);
            var s = cat.Find("sk_nukedashi");
            Assert.NotNull(s);
            Assert.Equal("finalStraight", s.Trigger);
            Assert.Equal(2, s.Value);
            Assert.Equal(18, s.SpeedPermille);
            Assert.Equal(new[] { "senko" }, s.Styles);
            Assert.Equal("最後の直線で前に2頭以内", s.Condition);
            Assert.Null(cat.Find("nope"));
            Assert.Null(cat.Find(null));
        }

        [Fact]
        public async Task HorsesOddsAndBreedingCarryTheSkill()
        {
            _http.Reply(200, "{\"horses\":[{\"id\":\"h1\",\"templateId\":\"t_ginga\",\"name\":\"ギンガノカナタ\",\"status\":\"active\",\"skillId\":\"sk_oudou\"},{\"id\":\"h2\",\"name\":\"ミメイ\",\"status\":\"active\"}]}");
            var horses = await _api.GetHorsesAsync();
            Assert.Equal("sk_oudou", horses[0].SkillId);
            Assert.Null(horses[1].SkillId);

            _http.Reply(200, "{\"bannerId\":\"b\",\"items\":[{\"templateId\":\"t_ginga\",\"name\":\"ギンガノカナタ\",\"rarity\":\"SSR\",\"ppm\":10000,\"rate\":\"1.0000%\","
                + "\"skill\":{\"id\":\"sk_oudou\",\"name\":\"王道の構え\",\"rarity\":\"SSR\",\"condition\":\"c\",\"effect\":\"e\"}},{\"templateId\":\"t_x\",\"name\":\"x\",\"rarity\":\"R\",\"ppm\":990000,\"rate\":\"99%\"}]}");
            var odds = await _api.GetOddsAsync("b");
            Assert.Equal("王道の構え", odds.Items[0].Skill.Name);
            Assert.Equal(10000, odds.Items[0].Ppm);
            Assert.Null(odds.Items[1].Skill);

            _http.Reply(200, "{\"stats\":{},\"styles\":{},\"distance\":{\"minM\":1400,\"maxM\":2400},\"surface\":\"turf\","
                + "\"skill\":{\"nonePermille\":700,\"candidates\":[{\"id\":\"sk_oudou\",\"name\":\"王道の構え\",\"rarity\":\"SSR\",\"condition\":\"c\",\"effect\":\"e\",\"permille\":300,\"from\":[\"sire\"]}]}}");
            var pv = await _api.BreedingPreviewAsync("h1", "h2");
            Assert.Equal(700, pv.Skill.NonePermille);
            Assert.Equal("sk_oudou", Assert.Single(pv.Skill.Candidates).Skill.Id);
            Assert.Equal(new[] { "sire" }, pv.Skill.Candidates[0].From);

            // older servers: no skill fields at all
            _http.Reply(200, "{\"stats\":{},\"styles\":{},\"distance\":{\"minM\":1400,\"maxM\":2400},\"surface\":\"turf\"}");
            var old = await _api.BreedingPreviewAsync("h1", "h2");
            Assert.Equal(1000, old.Skill.NonePermille);
            Assert.Empty(old.Skill.Candidates);
        }
    }
}
