using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>Tickets, breeding material and the cosmetics shop (server/src/http/app.ts, REQ-ITEM-*).</summary>
    public class ApiClientItemsTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly FakeDelay _delay = new FakeDelay();
        private readonly ApiClient _api;

        public ApiClientItemsTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, _delay, new SeqIds());
        }

        private static string Canon(string json) => JsonNode.Parse(json).ToString();

        private HttpRequest Single(string method, string path, string body = null, bool keyed = false)
        {
            var r = Assert.Single(_http.Requests);
            Assert.Equal(method, r.Method);
            Assert.Equal(path, r.Path);
            if (body == null) Assert.True(r.Body == null || r.Body == "{}", "unexpected body " + r.Body);
            else Assert.Equal(Canon(body), Canon(r.Body));
            Assert.Equal(keyed, r.Headers.ContainsKey("idempotency-key"));
            return r;
        }

        [Fact]
        public async Task TicketsListAndOdds()
        {
            _http.Reply(200, "{\"tickets\":[{\"itemId\":\"gacha_ticket\",\"name\":\"スカウト券\",\"kind\":\"single\",\"icon\":\"item/gacha_ticket\",\"banners\":[\"standard\"],\"notice\":\"n\"},"
                + "{\"itemId\":\"ticket_sr_plus\",\"name\":\"SR以上確定\",\"kind\":\"srPlus\",\"icon\":\"item/ticket_sr_plus\",\"items\":[{\"templateId\":\"t_a\",\"name\":\"A\",\"rarity\":\"SSR\",\"ppm\":60000,\"rate\":\"6.0000%\"}],\"rarityTotals\":{\"SSR\":{\"ppm\":60000,\"rate\":\"6.0000%\"}},\"notice\":\"m\"}]}");
            var t = await _api.GetTicketsAsync();
            Assert.Equal(2, t.Count);
            Assert.Equal(new[] { "standard" }, t[0].Banners);
            Assert.Equal("srPlus", t[1].Kind);
            Assert.Equal("6.0000%", t[1].Items[0].Rate);
            Assert.Equal(60000, t[1].RarityTotals["SSR"].Ppm);
            Single("GET", "/v1/items/tickets");

            _http.Requests.Clear();
            _http.Reply(200, "{\"itemId\":\"ticket_sr_plus\",\"kind\":\"srPlus\",\"items\":[]}");
            Assert.Equal("ticket_sr_plus", (await _api.GetTicketOddsAsync("ticket_sr_plus")).ItemId);
            Single("GET", "/v1/items/tickets/ticket_sr_plus/odds");
        }

        [Fact]
        public async Task UseTicketSendsBannerOnlyWhenGivenAndIsKeyed()
        {
            _http.Reply(200, "{\"itemId\":\"gacha_ticket\",\"bannerId\":\"standard\",\"result\":{\"templateId\":\"t_a\",\"rarity\":\"R\",\"horseId\":\"h3\",\"duplicate\":false,\"material\":0,\"guaranteed\":false},\"pityPoints\":4,\"remaining\":1}");
            var r = await _api.UseTicketAsync("gacha_ticket", "standard");
            Assert.Equal(4, r.PityPoints);
            Assert.Equal("h3", r.Result.HorseId);
            Assert.Equal(1, r.Remaining);
            Single("POST", "/v1/items/tickets/gacha_ticket/use", "{\"bannerId\":\"standard\"}", keyed: true);

            _http.Requests.Clear();
            _http.Reply(200, "{\"itemId\":\"ticket_sr_plus\",\"bannerId\":null,\"result\":{\"templateId\":\"t_b\",\"rarity\":\"SSR\",\"horseId\":\"h4\",\"duplicate\":false,\"material\":0,\"guaranteed\":true},\"pityPoints\":null,\"remaining\":0}");
            var s = await _api.UseTicketAsync("ticket_sr_plus");
            Assert.Null(s.PityPoints);
            Assert.True(s.Result.Guaranteed);
            Single("POST", "/v1/items/tickets/ticket_sr_plus/use", "{}", keyed: true);
        }

        [Fact]
        public async Task InsufficientItemsAndAlreadyPurchasedAreTyped()
        {
            _http.Reply(409, "{\"error\":{\"code\":\"INSUFFICIENT_ITEMS\",\"message\":\"need 1 gacha_ticket\"}}");
            var e = await Assert.ThrowsAnyAsync<ApiException>(() => _api.UseTicketAsync("gacha_ticket", "standard"));
            Assert.Equal(ApiErrorCode.InsufficientItems, e.Code);
            _http.Requests.Clear();
            _http.Reply(409, "{\"error\":{\"code\":\"ALREADY_PURCHASED\",\"message\":\"owned\"}}");
            var e2 = await Assert.ThrowsAnyAsync<ApiException>(() => _api.BuyCosmeticAsync("tack_bridle_classic"));
            Assert.Equal(ApiErrorCode.AlreadyPurchased, e2.Code);
        }

        [Fact]
        public async Task CosmeticsCatalogBuyAndEquip()
        {
            _http.Reply(200, "{\"decorSlots\":3,\"notice\":\"見た目のみ\",\"silksPattern\":\"plain\",\"equipment\":{\"tack\":{\"bridle\":\"tack_bridle_classic\"},\"decor\":[null,\"decor_flower_box\"]},"
                + "\"items\":[{\"id\":\"tack_bridle_classic\",\"name\":\"頭絡\",\"kind\":\"tack\",\"slot\":\"bridle\",\"price\":300,\"currency\":\"any\",\"icon\":\"item/tack_bridle_classic\",\"asset\":\"tack/bridle_classic\",\"owned\":true,\"equipped\":true},"
                + "{\"id\":\"decor_golden_horseshoe\",\"name\":\"金の蹄鉄\",\"kind\":\"decor\",\"price\":1000,\"currency\":\"paidOnly\",\"icon\":\"item/decor_golden_horseshoe\",\"asset\":\"decor/golden_horseshoe\",\"owned\":false,\"equipped\":false}]}");
            var c = await _api.GetCosmeticsAsync();
            Assert.Equal(3, c.DecorSlots);
            Assert.Equal("tack_bridle_classic", c.Equipment.Tack["bridle"]);
            Assert.Equal(new string[] { null, "decor_flower_box" }, c.Equipment.Decor);
            Assert.True(c.Items[0].Equipped);
            Assert.Equal("bridle", c.Items[0].Slot);
            Assert.True(c.Items[1].PaidOnly);
            Single("GET", "/v1/shop/cosmetics");

            _http.Requests.Clear();
            _http.Reply(200, "{\"itemId\":\"decor_golden_horseshoe\",\"spent\":{\"paid\":1000,\"free\":0},\"wallet\":{\"paid\":20,\"free\":5,\"total\":25,\"debt\":0}}");
            var b = await _api.BuyCosmeticAsync("decor_golden_horseshoe");
            Assert.Equal(1000, b.SpentPaid);
            Assert.Equal(20, b.Wallet.Paid);
            Single("POST", "/v1/shop/cosmetics/decor_golden_horseshoe/buy", "{}", keyed: true);

            _http.Requests.Clear();
            _http.Reply(200, "{\"equipment\":{\"tack\":{\"saddlecloth\":\"tack_saddlecloth_navy\"},\"decor\":[\"decor_golden_horseshoe\"]}}");
            var patch = new EquipmentPatch
            {
                Tack = new Dictionary<string, string> { ["saddlecloth"] = "tack_saddlecloth_navy" },
                ClearTack = new List<string> { "bridle" },
                Decor = new List<string> { "decor_golden_horseshoe" },
            };
            var eq = await _api.SetEquipmentAsync(patch);
            Assert.Equal("tack_saddlecloth_navy", eq.Tack["saddlecloth"]);
            Assert.False(eq.Tack.ContainsKey("bridle"));
            Single("PUT", "/v1/player/equipment", "{\"tack\":{\"saddlecloth\":\"tack_saddlecloth_navy\",\"bridle\":null},\"decor\":[\"decor_golden_horseshoe\"]}");
        }

        [Fact]
        public async Task BreedWithMaterialAndAllowance()
        {
            _http.Reply(200, "{\"stats\":{},\"nick\":false,\"inbreedingCount\":0,\"styles\":{},\"distance\":{\"minM\":1600,\"maxM\":2400},\"surface\":\"turf\",\"goingAptitude\":{\"any\":1000},"
                + "\"today\":{\"perDay\":1,\"used\":1,\"extraPerDay\":1,\"extraUsed\":0,\"materialItemId\":\"breeding_material\",\"materialCost\":1,\"materialOwned\":3}}");
            var p = await _api.BreedingPreviewAsync("h1", "h2");
            Assert.Equal(0, p.Today.NormalLeft);
            Assert.True(p.Today.CanBreedWithMaterial);
            _http.Requests.Clear();
            _http.Reply(200, "{\"foal\":{\"id\":\"h9\"},\"nick\":false,\"inbreedingCount\":0,\"usedMaterial\":true}");
            var r = await _api.BreedAsync("h1", "h2", useMaterial: true);
            Assert.True(r.UsedMaterial);
            Single("POST", "/v1/breeding", "{\"sireId\":\"h1\",\"damId\":\"h2\",\"useMaterial\":true}", keyed: true);
        }

        [Fact]
        public void PlayerViewParsesEquipmentAndBannerTickets()
        {
            var pv = JsonNode.Parse("{\"id\":\"p\",\"equipment\":{\"tack\":{\"bridle\":\"tack_bridle_gold\"},\"decor\":[]}}");
            var parse = typeof(PlayerView).GetMethod("Parse", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic)!;
            var v = (PlayerView)parse.Invoke(null, new object[] { pv })!;
            Assert.Equal("tack_bridle_gold", v.Equipment.Tack["bridle"]);
            Assert.Equal("tack/bridle_gold", AssetKeys.Tack("bridle_gold"));
            Assert.Equal("decor/stable_plaque", AssetKeys.Decor("stable_plaque"));
            Assert.Equal("tack", AssetKeys.KindOf("tack/bridle_gold"));
        }
    }
}
