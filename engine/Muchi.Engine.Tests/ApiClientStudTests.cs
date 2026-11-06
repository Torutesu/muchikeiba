using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>Stud lending, atavism and seasonal horses on the wire (server/src/http/app.ts, REQ-BREED-*).</summary>
    public class ApiClientStudTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientStudTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        private static string Canon(string json) => JsonNode.Parse(json).ToString();

        private HttpRequest Last(string method, string path, string body = null, bool keyed = false)
        {
            var r = _http.Requests[_http.Requests.Count - 1];
            Assert.Equal(method, r.Method);
            Assert.Equal(path, r.Path);
            if (body == null) Assert.True(r.Body == null || r.Body == "{}", "unexpected body " + r.Body);
            else Assert.Equal(Canon(body), Canon(r.Body));
            Assert.Equal(keyed, r.Headers.ContainsKey("idempotency-key"));
            return r;
        }

        private const string Listing = "{\"ownerId\":\"o\",\"ownerName\":\"騎手O\",\"horseId\":\"h2\",\"name\":\"ギンガノカナタ\",\"rarity\":\"SSR\",\"line\":\"hoshi\",\"style\":\"senko\","
            + "\"distMinM\":1800,\"distMaxM\":2600,\"surface\":\"turf\",\"goingAptitude\":\"heavy\",\"statTotal\":3600,\"awakening\":1,"
            + "\"appearance\":{\"coat\":\"gray\",\"face\":\"none\",\"legs\":[\"none\",\"none\",\"none\",\"none\"],\"mane\":\"normal\",\"build\":\"powerful\"},"
            + "\"visibility\":\"friends\",\"fee\":50,\"dailyLimit\":2,\"listedAt\":1000";

        [Fact]
        public async Task ListBrowseAndMine()
        {
            _http.Reply(200, Listing + "}");
            var l = await _api.ListStudAsync("h2", "friends", 50, 2);
            Assert.Equal(50, l.Fee);
            Assert.False(l.IsPublic);
            Assert.Equal("gray", l.Appearance.Coat);
            Last("PUT", "/v1/stud/listings/h2", "{\"visibility\":\"friends\",\"fee\":50,\"dailyLimit\":2}");

            _http.Reply(200, "{\"scope\":\"public\",\"listings\":[" + Listing + "}]}");
            var b = await _api.BrowseStudAsync("public");
            Assert.Equal("public", b.Scope);
            Assert.Equal("heavy", b.Listings[0].GoingAptitude);
            Last("GET", "/v1/stud/browse?scope=public");

            _http.Reply(200, "{\"listings\":[" + Listing + ",\"lentToday\":1}],\"today\":{\"earned\":50,\"earnCap\":300,\"borrowed\":0,\"borrowPerDay\":2},"
                + "\"limits\":{\"feeMax\":100,\"dailyLimitMax\":3,\"maxListings\":3},\"pendingPayments\":0,"
                + "\"history\":[{\"opId\":\"stud:b:k\",\"role\":\"lent\",\"at\":5,\"ownerId\":\"o\",\"borrowerId\":\"b\",\"horseId\":\"h2\",\"horseName\":\"ギンガノカナタ\",\"fee\":50,\"paid\":50,\"foalId\":\"h9\"}]}");
            var mine = await _api.GetMyStudAsync();
            Assert.Equal(1, mine.Listings[0].LentToday);
            Assert.Equal(300, mine.EarnCap);
            Assert.Equal(100, mine.FeeMax);
            Assert.True(mine.History[0].Lent);
            Assert.Equal("h9", mine.History[0].FoalId);
            Last("GET", "/v1/stud/mine");

            _http.Reply(200, "{\"horseId\":\"h2\",\"listed\":false}");
            await _api.UnlistStudAsync("h2");
            Last("DELETE", "/v1/stud/listings/h2");
        }

        [Fact]
        public async Task PreviewAndBreedWithAtavism()
        {
            _http.Reply(200, "{\"stats\":{\"speed\":{\"min\":600,\"max\":720}},\"nick\":false,\"inbreedingCount\":0,\"styles\":{\"senko\":47.5,\"nige\":2.5},"
                + "\"distance\":{\"minM\":1400,\"maxM\":2500},\"surface\":\"turf\",\"goingAptitude\":{\"any\":500,\"fast\":0,\"heavy\":500},"
                + "\"atavism\":{\"chancePermille\":40,\"candidates\":[{\"trait\":\"style\",\"value\":\"nige\",\"from\":\"ハツユキソウ\",\"permille\":13.333333333333334},{\"trait\":\"goingAptitude\",\"value\":\"fast\",\"from\":\"X\",\"permille\":26.666666666666668}]},"
                + "\"today\":{\"perDay\":1,\"used\":0,\"extraPerDay\":1,\"extraUsed\":0,\"materialItemId\":\"breeding_material\",\"materialCost\":1,\"materialOwned\":0},"
                + "\"stud\":{\"ownerId\":\"o\",\"horseId\":\"h2\",\"name\":\"ギンガノカナタ\",\"fee\":50,\"feeCurrency\":\"free\",\"remainingToday\":2,\"borrowed\":0,\"borrowPerDay\":2,\"canPay\":true}}");
            var p = await _api.StudPreviewAsync("o", "h2", "h1");
            Assert.Equal(40, p.Breeding.Atavism.ChancePermille);
            Assert.Equal(13333, p.Breeding.Atavism.Candidates[0].PerMillion);
            Assert.Equal("nige", p.Breeding.Atavism.Candidates[0].Trait.Value);
            Assert.Equal("free", p.Stud.FeeCurrency);
            Assert.True(p.Stud.CanPay);
            Assert.Equal(2, p.Stud.RemainingToday);
            Last("POST", "/v1/stud/preview", "{\"ownerId\":\"o\",\"horseId\":\"h2\",\"damId\":\"h1\"}");

            _http.Reply(200, "{\"opId\":\"stud:b:c:/v1/stud/breed:key1\",\"ownerId\":\"o\",\"horseId\":\"h2\",\"fee\":50,\"feeStatus\":\"pending\",\"nick\":false,\"inbreedingCount\":0,\"usedMaterial\":true,"
                + "\"atavism\":{\"trait\":\"style\",\"value\":\"nige\",\"from\":\"ハツユキソウ\"},"
                + "\"foal\":{\"id\":\"h9\",\"templateId\":null,\"name\":\"ミメイ\",\"rarity\":\"SR\",\"sex\":\"female\",\"style\":\"nige\",\"distMinM\":1400,\"distMaxM\":2400,\"surface\":\"turf\",\"line\":\"hoshi\","
                + "\"base\":{\"speed\":700,\"stamina\":650,\"burst\":700,\"guts\":600,\"temper\":550},\"awakening\":0,\"bornAt\":1,\"status\":\"active\",\"sireId\":null,\"damId\":\"h1\",\"sireName\":\"ギンガノカナタ\",\"damName\":\"コハク\",\"named\":false,"
                + "\"studSire\":{\"ownerId\":\"o\",\"horseId\":\"h2\",\"sireName\":\"S\",\"damName\":\"ハツユキソウ\"},\"atavism\":{\"trait\":\"style\",\"value\":\"nige\",\"from\":\"ハツユキソウ\"}}}");
            var r = await _api.StudBreedAsync("o", "h2", "h1", useMaterial: true);
            Assert.Equal("pending", r.FeeStatus);
            Assert.Equal("nige", r.Atavism.Value);
            Assert.Null(r.Foal.SireId);
            Assert.Equal("o", r.Foal.StudSire.OwnerId);
            Assert.Equal("ハツユキソウ", r.Foal.Atavism.From);
            Last("POST", "/v1/stud/breed", "{\"ownerId\":\"o\",\"horseId\":\"h2\",\"damId\":\"h1\",\"useMaterial\":true}", keyed: true);
        }

        [Fact]
        public async Task OddsMarkLimitedHorsesAndPeriod()
        {
            _http.Reply(200, "{\"bannerId\":\"winter_2026\",\"name\":\"季節限定\",\"currency\":\"any\",\"priceSingle\":100,\"priceTen\":1000,\"period\":{\"startAtMs\":10,\"endAtMs\":20},"
                + "\"limitedNotice\":\"季節限定の馬は期間終了後この表から外れます。\","
                + "\"items\":[{\"templateId\":\"t_seiya\",\"name\":\"セイヤノカネ\",\"rarity\":\"SSR\",\"ppm\":15000,\"rate\":\"1.5000%\",\"limited\":{\"seasonId\":\"winter_2026\",\"label\":\"冬季限定\",\"endAtMs\":30}},"
                + "{\"templateId\":\"t_natsu\",\"name\":\"ナツ\",\"rarity\":\"R\",\"ppm\":985000,\"rate\":\"98.5000%\"}],\"rarityTotals\":{},"
                + "\"guarantee\":{\"appliesTo\":\"x\",\"items\":[],\"rarityTotals\":{}},\"pity\":{\"group\":\"winter_2026\",\"pullsRequired\":100,\"targets\":[\"t_seiya\"],\"estimatedMaxCostYen\":16000},\"duplicates\":{},\"tickets\":[]}");
            var d = await _api.GetOddsAsync("winter_2026");
            Assert.Equal(10, d.StartAtMs);
            Assert.Equal(20, d.EndAtMs);
            Assert.NotNull(d.LimitedNotice);
            Assert.Equal("冬季限定", d.Items[0].Limited.Label);
            Assert.Null(d.Items[1].Limited);
        }

        [Fact]
        public void ServerStudShapesMatchTheClient()
        {
            // drift guard: the fields the client reads exist in the server's stud domain
            string stud = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "src", "domain", "stud.ts"));
            string horses = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "src", "domain", "horses.ts"));
            string gacha = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "src", "domain", "gacha.ts"));
            foreach (var f in new[] { "ownerName", "statTotal", "dailyLimit", "listedAt", "lentToday", "earnCap", "borrowPerDay", "dailyLimitMax", "maxListings", "pendingPayments", "feeCurrency", "remainingToday", "canPay", "foalId" })
                Assert.True(stud.Contains(f), "stud.ts lost " + f);
            foreach (var f in new[] { "chancePermille", "candidates", "permille", "studSire", "atavism" }) Assert.True(horses.Contains(f), "horses.ts lost " + f);
            foreach (var f in new[] { "limitedNotice", "period", "limited" }) Assert.True(gacha.Contains(f), "gacha.ts lost " + f);
            string svc = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "src", "domain", "studService.ts"));
            Assert.Contains("feeStatus", svc);
        }
    }
}
