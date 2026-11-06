using Muchi.Client;
using Muchi.Engine;
using Muchi.Net;
using Muchi.Verifier;

namespace Muchi.Engine.Tests
{
    /// <summary>Stable care (bond) and presets endpoints, scene/bond visuals and the bond commentary call-out (round 6).</summary>
    public class BondPresetsClientTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public BondPresetsClientTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        private static string Canon(string json) => JsonNode.Parse(json).ToString();

        private const string Bond = "{\"horseId\":\"h1\",\"level\":3,\"points\":95,\"maxLevel\":10,\"nextLevelAt\":150,\"todayActions\":1,\"dailyActions\":4,\"focus\":\"endurance\",\"commentaryCallout\":false,\"affectsRankedStats\":false,"
            + "\"actions\":[{\"id\":\"grain_apple\",\"focus\":\"balanced\",\"points\":10,\"cooldownMs\":21600000,\"readyAt\":1,\"ready\":true},{\"id\":\"hay_carrot\",\"focus\":\"endurance\",\"points\":10,\"cooldownMs\":21600000,\"readyAt\":99,\"ready\":false}]}";

        [Fact]
        public async Task BondViewLevelsAndCare()
        {
            _http.Reply(200, Bond);
            var b = await _api.GetBondAsync("h1");
            Assert.Equal(3, b.Level);
            Assert.Equal(150, b.NextLevelAt);
            Assert.False(b.AffectsRankedStats);
            Assert.True(b.Actions[0].Ready);
            Assert.False(b.Actions[1].Ready);
            var r = Assert.Single(_http.Requests);
            Assert.Equal("GET", r.Method);
            Assert.Equal("/v1/horses/h1/bond", r.Path);

            _http.Requests.Clear();
            _http.Reply(200, "{\"levels\":{\"h1\":3,\"h2\":1}}");
            var lv = await _api.GetBondLevelsAsync();
            Assert.Equal(3, lv["h1"]);
            Assert.Equal("/v1/bond", Assert.Single(_http.Requests).Path);

            _http.Requests.Clear();
            _http.Reply(200, "{\"gained\":10,\"levelUp\":true,\"rewards\":[{\"level\":4,\"reward\":{\"freeCoins\":50}}],\"titles\":[\"bond_first\"],\"bond\":" + Bond + "}");
            var c = await _api.CareAsync("h1", "grain_apple", "care-key-1");
            Assert.True(c.LevelUp);
            Assert.Equal(50, Assert.Single(c.Rewards).FreeCoins);
            Assert.Equal("bond_first", Assert.Single(c.Titles));
            var cr = Assert.Single(_http.Requests);
            Assert.Equal("POST", cr.Method);
            Assert.Equal("/v1/horses/h1/care", cr.Path);
            Assert.Equal(Canon("{\"action\":\"grain_apple\"}"), Canon(cr.Body));
            Assert.Equal("care-key-1", cr.Headers["idempotency-key"]);
        }

        [Fact]
        public async Task CareCooldownIsAConflict()
        {
            _http.Reply(409, "{\"error\":{\"code\":\"COOLDOWN\",\"message\":\"next grain_apple at 5\"}}");
            var e = await Assert.ThrowsAsync<ConflictException>(() => _api.CareAsync("h1", "grain_apple"));
            Assert.Equal(ApiErrorCode.Cooldown, e.Code);
        }

        [Fact]
        public async Task PresetsRoundTrip()
        {
            const string P = "{\"courseLook\":\"greenfield\",\"courseLookKey\":\"scene/look/greenfield\",\"ownedCourseLooks\":[\"greenfield\"],\"room\":{\"trackId\":null,\"going\":\"soft\",\"night\":null,\"weather\":\"rain\",\"temperatureC\":14,\"windKmh\":10}}";
            _http.Reply(200, P);
            var p = await _api.GetPresetsAsync();
            Assert.Equal("scene/look/greenfield", p.CourseLookKey);
            Assert.Null(p.Room.TrackId);
            Assert.Null(p.Room.Night);
            Assert.Equal("soft", p.Room.Going);
            Assert.Equal("rain", p.Room.Weather);

            _http.Requests.Clear();
            _http.Reply(200, P);
            await _api.SetRoomConditionsAsync(new RoomConditions { Going = "soft", Weather = "rain", TemperatureC = 14, WindKmh = 10 });
            var put = Assert.Single(_http.Requests);
            Assert.Equal("PUT", put.Method);
            Assert.Equal("/v1/presets/room", put.Path);
            Assert.Equal(Canon("{\"trackId\":null,\"going\":\"soft\",\"night\":null,\"weather\":\"rain\",\"temperatureC\":14,\"windKmh\":10}"), Canon(put.Body));

            _http.Requests.Clear();
            _http.Reply(200, P);
            await _api.SetCourseLookAsync(null);
            var look = Assert.Single(_http.Requests);
            Assert.Equal("/v1/presets/course-look", look.Path);
            Assert.Equal(Canon("{\"lookId\":null}"), Canon(look.Body));

            _http.Requests.Clear();
            _http.Reply(200, "{\"courseLook\":null,\"courseLookKey\":\"scene/look/greenfield\",\"ownedCourseLooks\":[\"greenfield\"],\"room\":null}");
            var cleared = await _api.ClearRoomConditionsAsync();
            Assert.Null(cleared.Room);
            Assert.Equal("DELETE", Assert.Single(_http.Requests).Method);
        }

        [Fact]
        public void VisualsCarrySceneAndBondLevels()
        {
            var v = RaceVisuals.Parse(JsonNode.Parse("{\"v\":1,\"track\":{\"trackId\":\"aoba_turf_1600\",\"venue\":\"aoba\",\"direction\":\"left\",\"surface\":\"turf\",\"going\":null,\"night\":false,\"keys\":{\"venue\":\"scene/venue/aoba\",\"surface\":\"scene/surface/aoba_turf\",\"night\":null,\"going\":null}},"
                + "\"scene\":{\"weather\":\"fog\",\"temperatureC\":14,\"windKmh\":15,\"keys\":{\"weather\":\"fx/weather/fog\"}},"
                + "\"entrants\":[{\"slot\":0,\"gate\":1,\"bracket\":1,\"voiceName\":\"voice/ja/name/n0\",\"bondLevel\":6},{\"slot\":1,\"gate\":2,\"bracket\":2,\"voiceName\":\"voice/ja/name/n1\"}]}"));
            Assert.Equal("fog", v.Scene.Weather);
            Assert.Equal(AssetKeys.Weather("fog"), v.Scene.WeatherKey);
            Assert.Equal(6, v.ForSlot(0).BondLevel);
            Assert.Equal(0, v.ForSlot(1).BondLevel);
            Assert.Equal(new List<int> { 0 }, v.BondCalloutSlots(5));
            Assert.Equal("scene/look/greenfield", AssetKeys.CourseLook("greenfield"));
        }

        private static List<CommentaryLine> RunRace(ulong seed, bool bonded)
        {
            var hr = new Pcg32(seed, 5);
            var horses = Enumerable.Range(0, 12).Select(i => SampleRaces.RandomHorse(ref hr, "b" + i)).ToList();
            var cfg = SampleRaces.Config("bond_" + seed, seed, SampleRaces.Turf2000(), TestUtil.Ruleset(), horses, 0);
            var sim = new RaceSim(cfg);
            var c = new Commentator(CommentaryTests.Templates(), cfg, 0);
            if (bonded) c.SetBondCallouts(new[] { 0 });
            var empty = new byte[12];
            while (!sim.IsFinished) { sim.Step(empty); c.Process(sim); }
            return c.Lines.ToList();
        }

        [Fact]
        public void BondCalloutIsFlavourForTheFocusHorseOnly()
        {
            int said = 0;
            foreach (var seed in new ulong[] { 1, 2, 3, 17, 99 })
            {
                var plain = RunRace(seed, false);
                Assert.DoesNotContain(plain, l => l.Kind == "bond_call");
                var bonded = RunRace(seed, true);
                var calls = bonded.Where(l => l.Kind == "bond_call").ToList();
                Assert.True(calls.Count <= 1);
                if (calls.Count == 1) { said++; Assert.Equal(0, calls[0].Slot); }
            }
            Assert.True(said > 0, "the bonded focus horse should be called out in at least one race");
        }
    }
}
