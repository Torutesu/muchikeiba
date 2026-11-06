using System.Text.RegularExpressions;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    internal sealed class FakeHttp : IHttp
    {
        public readonly List<HttpRequest> Requests = new List<HttpRequest>();
        public readonly Queue<Func<HttpRequest, HttpResponse>> Responses = new Queue<Func<HttpRequest, HttpResponse>>();

        public FakeHttp Reply(int status, string body) { Responses.Enqueue(_ => new HttpResponse(status, body)); return this; }
        public FakeHttp Fail(Exception e) { Responses.Enqueue(_ => throw e); return this; }

        public Task<HttpResponse> SendAsync(HttpRequest request, CancellationToken ct)
        {
            Requests.Add(request);
            if (Responses.Count == 0) throw new InvalidOperationException("unexpected request " + request);
            return Task.FromResult(Responses.Dequeue()(request));
        }
    }

    internal sealed class FakeAuth : IAuthTokenProvider
    {
        public int Calls, Forced;
        public Task<string> GetTokenAsync(bool forceRefresh, CancellationToken ct)
        {
            Calls++;
            if (forceRefresh) Forced++;
            return Task.FromResult(forceRefresh ? "fresh-token" : "token");
        }
    }

    internal sealed class FakeDelay : IDelay
    {
        public readonly List<int> Waits = new List<int>();
        public Task Delay(int ms, CancellationToken ct) { Waits.Add(ms); return Task.CompletedTask; }
    }

    internal sealed class SeqIds : IIdGenerator
    {
        private int _n;
        public string NewId() => "key" + (++_n);
    }

    public class ApiClientTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly FakeAuth _auth = new FakeAuth();
        private readonly FakeDelay _delay = new FakeDelay();
        private readonly ApiClient _api;

        public ApiClientTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test/" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, _auth, opt, _delay, new SeqIds());
        }

        private const string HorseJson = "{\"id\":\"h1\",\"templateId\":\"t_ssr_01\",\"name\":\"シンセイアカツキ\",\"rarity\":\"SSR\",\"sex\":\"male\",\"style\":\"sashi\",\"distMinM\":1600,\"distMaxM\":2400,\"surface\":\"turf\",\"line\":\"L1\",\"base\":{\"speed\":720,\"stamina\":650,\"burst\":800,\"guts\":600,\"temper\":500},\"awakening\":1,\"bornAt\":1730000000000,\"status\":\"active\",\"sireId\":null,\"damId\":null,\"sireName\":\"アカツキオー\",\"damName\":\"ハルノヒ\",\"named\":true}";
        private const string WalletJson = "{\"paid\":320,\"free\":960,\"total\":1280,\"debt\":0}";

        private static string Canon(string json) => JsonNode.Parse(json).ToString();

        private HttpRequest Single(string method, string path, string body = null)
        {
            var r = Assert.Single(_http.Requests);
            Assert.Equal(method, r.Method);
            Assert.Equal(path, r.Path);
            if (body == null) Assert.True(r.Body == null || r.Body == "{}", "unexpected body " + r.Body);
            else Assert.Equal(Canon(body), Canon(r.Body));
            return r;
        }

        // ------------------------------------------------------------------ endpoints

        [Fact]
        public async Task Health()
        {
            _http.Reply(200, "{\"ok\":true}");
            Assert.True(await _api.HealthAsync());
            var r = Single("GET", "/v1/health");
            Assert.False(r.Headers.ContainsKey("authorization"));
        }

        [Fact]
        public async Task BootstrapAndPlayerView()
        {
            string view = "{\"id\":\"u1\",\"wallet\":" + WalletJson + ",\"items\":{\"ticket_sr\":2},\"materials\":{\"awakening\":30},\"pity\":{\"standard\":62},\"horses\":[" + HorseJson + "],\"ageRegistered\":true,\"flags\":{\"tutorialGachaUsed\":true},\"seasonPass\":{\"expiresAt\":1733000000000,\"xp\":120,\"claimed\":{\"free\":[1],\"premium\":[]},\"seasonId\":\"2026-11\"},\"loginBonus\":{\"streakDay\":3,\"lastClaimDate\":\"2026-11-05\"},\"rating\":{\"r\":1612,\"rd\":80,\"rankedRaces\":12},\"season\":{\"id\":\"2026-11\",\"classId\":\"A\",\"points\":420}}";
            _http.Reply(200, view);
            var p = await _api.BootstrapAsync();
            var r = Single("POST", "/v1/player/bootstrap");
            Assert.Equal("Bearer token", r.Headers["authorization"]);
            Assert.Equal(320, p.Wallet.Paid);
            Assert.Equal(1280, p.Wallet.Total);
            Assert.Equal(2, p.Items["ticket_sr"]);
            Assert.Equal(30, p.AwakeningMaterial);
            Assert.Equal(62, p.Pity["standard"]);
            var h = Assert.Single(p.Horses);
            Assert.Equal("シンセイアカツキ", h.Name);
            Assert.Equal(800, h.Base.Burst);
            Assert.True(h.IsActive);
            Assert.Null(h.SireId);
            Assert.Equal("アカツキオー", h.SireName);
            Assert.True(p.AgeRegistered && p.TutorialGachaUsed);
            Assert.Equal(new[] { 1 }, p.SeasonPass.ClaimedFree);
            Assert.Equal(3, p.LoginStreakDay);
            Assert.Equal(1612, p.Rating);
            Assert.Equal("A", p.ClassId);
            Assert.Equal(420, p.SeasonPoints);

            _http.Requests.Clear();
            _http.Reply(200, view);
            await _api.GetPlayerAsync();
            Single("GET", "/v1/player");
        }

        [Fact]
        public async Task SetAge()
        {
            _http.Reply(200, "{\"age\":17,\"band\":\"u18\",\"monthlyLimitYen\":10000}");
            var a = await _api.SetAgeAsync(2009, 4, true);
            Single("PUT", "/v1/player/age", "{\"birthYear\":2009,\"birthMonth\":4,\"guardianConsent\":true}");
            Assert.Equal(17, a.Age);
            Assert.Equal(10000, a.MonthlyLimitYen);

            _http.Requests.Clear();
            _http.Reply(200, "{\"age\":30,\"band\":\"adult\",\"monthlyLimitYen\":null}");
            Assert.Null((await _api.SetAgeAsync(1996, 1, false)).MonthlyLimitYen);
        }

        [Fact]
        public async Task ShopProductsIntentAndPurchase()
        {
            _http.Reply(200, "{\"products\":[{\"id\":\"coin_160\",\"kind\":\"coins\",\"priceYen\":160,\"paidCoins\":100},{\"id\":\"starter\",\"kind\":\"starter\",\"priceYen\":480,\"paidCoins\":300,\"once\":true,\"items\":[{\"itemId\":\"ticket_sr\",\"qty\":1}]},{\"id\":\"pass\",\"kind\":\"season_pass\",\"priceYen\":1000,\"paidCoins\":0,\"durationDays\":30}],\"notice\":\"有償コインから先に使われます\"}");
            var list = await _api.GetProductsAsync();
            Single("GET", "/v1/shop/products");
            Assert.Equal(3, list.Products.Count);
            Assert.True(list.Products[1].Once);
            Assert.Equal("ticket_sr", list.Products[1].Items[0].ItemId);
            Assert.Equal(30, list.Products[2].DurationDays);
            Assert.Equal("有償コインから先に使われます", list.Notice);

            _http.Requests.Clear();
            _http.Reply(200, "{\"product\":{\"id\":\"coin_160\",\"kind\":\"coins\",\"priceYen\":160,\"paidCoins\":100},\"monthSpentYen\":480,\"monthlyLimitYen\":5000,\"remainingYen\":4520}");
            var intent = await _api.PurchaseIntentAsync("coin_160");
            Single("POST", "/v1/shop/purchase-intent", "{\"productId\":\"coin_160\"}");
            Assert.Equal(4520, intent.RemainingYen);

            _http.Requests.Clear();
            _http.Reply(200, "{\"record\":{\"txId\":\"T1\",\"platform\":\"apple\",\"productId\":\"coin_160\",\"priceYen\":160,\"at\":1,\"paidCoinsGranted\":100,\"bonusCoinsGranted\":100,\"lotId\":\"lot1\",\"refunded\":false,\"limitBreach\":false},\"duplicate\":false,\"wallet\":" + WalletJson + "}");
            var pr = await _api.PurchaseAsync(StorePlatform.Apple, "coin_160", "signed-jws");
            Single("POST", "/v1/shop/purchase", "{\"platform\":\"apple\",\"productId\":\"coin_160\",\"receipt\":\"signed-jws\"}");
            Assert.Equal("T1", pr.Record.TxId);
            Assert.Equal(100, pr.Record.BonusCoinsGranted);
            Assert.False(pr.Duplicate);
            Assert.Equal(320, pr.Wallet.Paid);
        }

        [Fact]
        public async Task GachaBannersOddsDrawTutorialAndPity()
        {
            _http.Reply(200, "{\"banners\":[{\"id\":\"standard\",\"name\":\"通常\",\"currency\":\"any\",\"priceSingle\":100,\"priceTen\":1000,\"startAtMs\":null,\"endAtMs\":null},{\"id\":\"step\",\"name\":\"ステップ\",\"currency\":\"paidOnly\",\"priceSingle\":100,\"priceTen\":900,\"startAtMs\":1,\"endAtMs\":2}]}");
            var banners = await _api.GetBannersAsync();
            Single("GET", "/v1/gacha/banners");
            Assert.False(banners[0].PaidOnly);
            Assert.Null(banners[0].EndAtMs);
            Assert.True(banners[1].PaidOnly);
            Assert.Equal(2, banners[1].EndAtMs);

            _http.Requests.Clear();
            _http.Reply(200, "{\"bannerId\":\"standard\",\"name\":\"通常\",\"currency\":\"any\",\"priceSingle\":100,\"priceTen\":1000,\"items\":[{\"templateId\":\"t1\",\"name\":\"A\",\"rarity\":\"SSR\",\"ppm\":30000,\"rate\":\"3.0000%\"},{\"templateId\":\"t2\",\"name\":\"B\",\"rarity\":\"R\",\"ppm\":970000,\"rate\":\"97.0000%\"}],\"rarityTotals\":{\"SSR\":{\"ppm\":30000,\"rate\":\"3.0000%\"},\"R\":{\"ppm\":970000,\"rate\":\"97.0000%\"}},\"guarantee\":{\"appliesTo\":\"10連の10枠目\",\"items\":[{\"templateId\":\"t1\",\"name\":\"A\",\"rarity\":\"SSR\",\"ppm\":1000000,\"rate\":\"100.0000%\"}],\"rarityTotals\":{\"SSR\":{\"ppm\":1000000,\"rate\":\"100.0000%\"}}},\"pity\":{\"group\":\"standard\",\"pullsRequired\":100,\"targets\":[\"t1\"],\"estimatedMaxCostYen\":16000},\"duplicates\":{\"R\":1,\"SR\":5,\"SSR\":20}}");
            var odds = await _api.GetOddsAsync("standard");
            Single("GET", "/v1/gacha/standard/odds");
            Assert.Equal(1_000_000, odds.Items.Sum(i => i.Ppm));
            Assert.Equal("3.0000%", odds.RarityTotals["SSR"].Rate);
            Assert.Equal("10連の10枠目", odds.GuaranteeAppliesTo);
            Assert.Equal(1_000_000, odds.GuaranteeItems.Sum(i => i.Ppm));
            Assert.Equal(100, odds.PityPullsRequired);
            Assert.Equal(new[] { "t1" }, odds.PityTargets);
            Assert.Equal(20, odds.DuplicateMaterial["SSR"]);

            _http.Requests.Clear();
            string draw = "{\"bannerId\":\"standard\",\"results\":[{\"templateId\":\"t1\",\"rarity\":\"SSR\",\"horseId\":\"h9\",\"duplicate\":false,\"material\":0,\"guaranteed\":true},{\"templateId\":\"t2\",\"rarity\":\"R\",\"horseId\":null,\"duplicate\":true,\"material\":1,\"guaranteed\":false}],\"spent\":{\"paid\":320,\"free\":680},\"pityPoints\":72,\"wallet\":" + WalletJson + "}";
            _http.Reply(200, draw);
            var d = await _api.DrawAsync("standard", 10);
            var r = Single("POST", "/v1/gacha/standard/draw", "{\"count\":10}");
            Assert.Equal("key1", r.Headers["idempotency-key"]);
            Assert.True(d.Results[0].Guaranteed);
            Assert.Null(d.Results[1].HorseId);
            Assert.Equal(320, d.SpentPaid);
            Assert.Equal(680, d.SpentFree);
            Assert.Equal(72, d.PityPoints);
            Assert.NotNull(d.Wallet);
            await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => _api.DrawAsync("standard", 5));

            _http.Requests.Clear();
            _http.Reply(200, "{\"bannerId\":\"standard\",\"results\":[],\"spent\":{\"paid\":0,\"free\":0},\"pityPoints\":10}");
            var t = await _api.TutorialDrawAsync("my-own-key");
            r = Single("POST", "/v1/gacha/tutorial");
            Assert.Equal("my-own-key", r.Headers["idempotency-key"]);
            Assert.Null(t.Wallet);

            _http.Requests.Clear();
            _http.Reply(200, "{\"templateId\":\"t1\",\"rarity\":\"SSR\",\"horseId\":\"h10\",\"duplicate\":false,\"material\":0,\"guaranteed\":false}");
            var pull = await _api.PityExchangeAsync("standard", "t1");
            Single("POST", "/v1/gacha/standard/pity-exchange", "{\"templateId\":\"t1\"}");
            Assert.Equal("h10", pull.HorseId);
        }

        [Fact]
        public async Task HorsesNamingAwakenRetirePedigree()
        {
            _http.Reply(200, "{\"horses\":[" + HorseJson + "]}");
            Assert.Single(await _api.GetHorsesAsync());
            Single("GET", "/v1/horses");

            _http.Requests.Clear();
            _http.Reply(200, HorseJson);
            await _api.NameHorseAsync("h1", "シンセイアカツキ");
            Single("PUT", "/v1/horses/h1/name", "{\"name\":\"シンセイアカツキ\"}");

            _http.Requests.Clear();
            _http.Reply(200, HorseJson);
            var r0 = await _api.AwakenAsync("h1");
            var req = Single("POST", "/v1/horses/h1/awaken");
            Assert.True(req.Headers.ContainsKey("idempotency-key"));
            Assert.Equal(1, r0.Awakening);

            _http.Requests.Clear();
            _http.Reply(200, HorseJson.Replace("\"active\"", "\"retired\""));
            Assert.True((await _api.RetireAsync("h1")).IsRetired);
            req = Single("POST", "/v1/horses/h1/retire");
            Assert.False(req.Headers.ContainsKey("idempotency-key"));

            _http.Requests.Clear();
            _http.Reply(200, "{\"key\":\"h3\",\"name\":\"コ\",\"horseId\":\"h3\",\"sire\":{\"key\":\"h1\",\"name\":\"チチ\",\"horseId\":\"h1\",\"sire\":{\"key\":\"name:ソフ\",\"name\":\"ソフ\",\"horseId\":null,\"sire\":null,\"dam\":null},\"dam\":null},\"dam\":{\"key\":\"h2\",\"name\":\"ハハ\",\"horseId\":\"h2\",\"sire\":null,\"dam\":null}}");
            var ped = await _api.GetPedigreeAsync("h3");
            Single("GET", "/v1/horses/h3/pedigree");
            Assert.Equal("チチ", ped.Sire.Name);
            Assert.Null(ped.Sire.Sire.HorseId);
            Assert.Equal(2, ped.GenerationsAbove);
        }

        [Fact]
        public async Task GroundPreferencesParse()
        {
            // REQ-RACE-035: horses and the breeding preview carry goingAptitude; absent = "any"
            _http.Reply(200, "{\"stats\":{},\"nick\":false,\"inbreedingCount\":0,\"styles\":{\"sashi\":100},\"distance\":{\"minM\":1400,\"maxM\":2600},\"surface\":\"dirt\",\"goingAptitude\":{\"any\":200,\"fast\":0,\"heavy\":800}}");
            var p = await _api.BreedingPreviewAsync("h1", "h2");
            Assert.Equal(800, p.GoingAptitudePermille["heavy"]);
            Assert.Equal(1000, p.GoingAptitudePermille.Values.Sum());

            _http.Requests.Clear();
            _http.Reply(200, "{\"foal\":" + HorseJson.Replace("\"surface\":\"turf\"", "\"surface\":\"dirt\",\"goingAptitude\":\"heavy\"") + ",\"nick\":false,\"inbreedingCount\":0}");
            var b = await _api.BreedAsync("h1", "h2");
            Assert.Equal("heavy", b.Foal.GoingAptitude);

            _http.Requests.Clear();
            _http.Reply(200, "{\"foal\":" + HorseJson + ",\"nick\":false,\"inbreedingCount\":0}");
            Assert.Equal("any", (await _api.BreedAsync("h1", "h2")).Foal.GoingAptitude);
        }

        [Fact]
        public async Task Breeding()
        {
            _http.Reply(200, "{\"stats\":{\"speed\":{\"min\":600,\"max\":720},\"stamina\":{\"min\":500,\"max\":620},\"burst\":{\"min\":640,\"max\":760},\"guts\":{\"min\":540,\"max\":660},\"temper\":{\"min\":440,\"max\":560}},\"nick\":true,\"inbreedingCount\":0,\"styles\":{\"sashi\":47.5,\"nige\":47.5,\"senko\":2.5,\"oikomi\":2.5},\"distance\":{\"minM\":1400,\"maxM\":2600},\"surface\":\"turf\"}");
            var p = await _api.BreedingPreviewAsync("h1", "h2");
            Single("POST", "/v1/breeding/preview", "{\"sireId\":\"h1\",\"damId\":\"h2\"}");
            Assert.Equal(720, p.Stats["speed"].Max);
            Assert.True(p.Nick);
            Assert.Equal(47500, p.StyleMilliPercent["sashi"]);
            Assert.Equal(2500, p.StyleMilliPercent["oikomi"]);
            Assert.Equal(100_000, p.StyleMilliPercent.Values.Sum());
            Assert.Equal(2600, p.DistanceMaxM);

            _http.Requests.Clear();
            _http.Reply(200, "{\"foal\":" + HorseJson.Replace("\"h1\"", "\"h4\"") + ",\"nick\":true,\"inbreedingCount\":1}");
            var b = await _api.BreedAsync("h1", "h2");
            var r = Single("POST", "/v1/breeding", "{\"sireId\":\"h1\",\"damId\":\"h2\"}");
            Assert.True(r.Headers.ContainsKey("idempotency-key"));
            Assert.Equal("h4", b.Foal.Id);
            Assert.Equal(1, b.InbreedingCount);
        }

        [Fact]
        public async Task RewardsMissionsAndSeasonPass()
        {
            _http.Reply(200, "{\"day\":3,\"reward\":{\"day\":3,\"items\":[{\"itemId\":\"suit_a\",\"qty\":1}]}}");
            var lb = await _api.ClaimLoginBonusAsync();
            Single("POST", "/v1/rewards/login-bonus");
            Assert.Equal(3, lb.Day);
            Assert.Equal("suit_a", lb.Reward.Items[0].ItemId);

            _http.Requests.Clear();
            _http.Reply(200, "{\"missions\":[{\"id\":\"d_races3\",\"kind\":\"races\",\"target\":3,\"reward\":{\"freeCoins\":50},\"progress\":3,\"claimed\":false},{\"id\":\"d_win1\",\"kind\":\"wins\",\"target\":1,\"reward\":{\"freeCoins\":100},\"progress\":0,\"claimed\":false}]}");
            var ms = await _api.GetMissionsAsync();
            Single("GET", "/v1/missions");
            Assert.True(ms[0].Claimable);
            Assert.False(ms[1].Claimable);
            Assert.Equal(50, ms[0].Reward.FreeCoins);

            _http.Requests.Clear();
            _http.Reply(200, "{\"freeCoins\":50}");
            Assert.Equal(50, (await _api.ClaimMissionAsync("d_races3")).FreeCoins);
            Single("POST", "/v1/missions/d_races3/claim");

            _http.Requests.Clear();
            _http.Reply(200, "{\"level\":4,\"xp\":420,\"active\":true,\"expiresAt\":1733000000000,\"claimed\":{\"free\":[2],\"premium\":[]}}");
            var pass = await _api.GetSeasonPassAsync();
            Single("GET", "/v1/season-pass");
            Assert.Equal(4, pass.Level);
            Assert.True(pass.Active);
            Assert.Equal(new[] { 2 }, pass.ClaimedFree);

            _http.Requests.Clear();
            _http.Reply(200, "{\"freeCoins\":100}");
            await _api.ClaimSeasonPassAsync(PassTrack.Premium, 4);
            Single("POST", "/v1/season-pass/claim", "{\"track\":\"premium\",\"level\":4}");
        }

        [Fact]
        public async Task MatchmakingFriendRoomsTutorialAndReport()
        {
            _http.Reply(200, "{\"state\":\"queued\"}");
            Assert.Equal(MatchState.Queued, (await _api.EnqueueRankedAsync("h1")).State);
            Single("POST", "/v1/match/enqueue", "{\"horseId\":\"h1\"}");

            _http.Requests.Clear();
            _http.Reply(200, "{\"state\":\"matched\",\"raceId\":\"r_1\",\"slot\":4,\"ticket\":\"tk\",\"startAtMs\":1730000006000,\"wsPath\":\"/v1/race/r_1/ws\",\"at\":1}");
            var st = await _api.GetMatchStatusAsync();
            Single("GET", "/v1/match/status");
            Assert.Equal(MatchState.Matched, st.State);
            Assert.Equal(4, st.Assignment.Slot);
            Assert.Equal("wss://api.example.test/v1/race/r_1/ws", _api.RaceWebSocketUrl(st.Assignment));

            _http.Requests.Clear();
            _http.Reply(200, "{\"state\":\"none\"}");
            var none = await _api.CancelMatchAsync();
            Single("POST", "/v1/match/cancel");
            Assert.Equal(MatchState.None, none.State);
            Assert.Null(none.Assignment);

            _http.Requests.Clear();
            _http.Reply(200, "{\"passphrase\":\"さくら-1234\",\"members\":[\"u1\"]}");
            var room = await _api.CreateFriendRoomAsync("h1");
            Single("POST", "/v1/friend-rooms", "{\"horseId\":\"h1\"}");
            Assert.Equal("さくら-1234", room.Passphrase);

            _http.Requests.Clear();
            _http.Reply(200, "{\"passphrase\":\"さくら-1234\",\"members\":[\"u1\",\"u2\"]}");
            await _api.JoinFriendRoomAsync("さくら-1234", "h2");
            Single("POST", "/v1/friend-rooms/" + Uri.EscapeDataString("さくら-1234") + "/join", "{\"horseId\":\"h2\"}");

            _http.Requests.Clear();
            _http.Reply(200, "{\"raceId\":\"r_2\",\"slot\":0,\"ticket\":\"tk2\",\"startAtMs\":5,\"wsPath\":\"/v1/race/r_2/ws\"}");
            Assert.Equal("r_2", (await _api.StartFriendRoomAsync("さくら-1234")).RaceId);
            Assert.Equal("POST", _http.Requests[0].Method);
            Assert.EndsWith("/start", _http.Requests[0].Path);

            _http.Requests.Clear();
            _http.Reply(200, "{\"raceId\":\"r_3\",\"slot\":0,\"ticket\":\"tk3\",\"startAtMs\":5,\"wsPath\":\"/v1/race/r_3/ws\"}");
            Assert.Equal("tk3", (await _api.StartTutorialRaceAsync("h1")).Ticket);
            Single("POST", "/v1/race/tutorial", "{\"horseId\":\"h1\"}");

            _http.Requests.Clear();
            _http.Reply(200, "{\"ok\":true}");
            Assert.True(await _api.ReportRaceAsync("r_3"));
            Single("POST", "/v1/race/r_3/report");
        }

        [Fact]
        public void EveryPlayerFacingServerRouteHasAClientMethod()
        {
            // keeps the client in step with server/src/http/app.ts
            string app = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "src", "http", "app.ts"));
            // ApiClient is partial: feature files (e.g. Stable.cs) add their methods next to their models
            string client = string.Concat(Directory.GetFiles(Path.Combine(TestUtil.RepoRoot, "engine", "Muchi.Client"), "*.cs")
                .Select(File.ReadAllText).Where(t => t.Contains("partial class ApiClient")));
            var routes = Regex.Matches(app, @"method: '(\w+)', path: '([^']+)'").Select(m => (m.Groups[1].Value, m.Groups[2].Value)).ToList();
            Assert.True(routes.Count >= 30);
            foreach (var (method, path) in routes)
            {
                if (path.StartsWith("/v1/admin/") || path.StartsWith("/v1/store/notifications") || path.StartsWith("/v1/ads/ssv/") || path.EndsWith("/ws")) continue; // server-to-server (store / ad network SSV) / admin / websocket
                // "/v1/gacha/:bannerId/draw" → the literal pieces must appear in the client
                var pieces = path.Split('/').Where(p => p.Length > 0 && !p.StartsWith(":")).ToList();
                string last = pieces.Last();
                Assert.True(client.Contains("\"" + method + "\"") && client.Contains(last), method + " " + path + " has no client method");
            }
        }

        // ------------------------------------------------------------------ behaviour

        [Fact]
        public async Task IdempotencyKeyIsStableAcrossRetriesAndBackoffGrows()
        {
            _http.Fail(new IOException("reset")).Reply(503, "{\"error\":{\"code\":\"INTERNAL\",\"message\":\"x\"}}").Reply(200, "{\"bannerId\":\"standard\",\"results\":[],\"spent\":{\"paid\":0,\"free\":100},\"pityPoints\":1}");
            await _api.DrawAsync("standard", 1);
            Assert.Equal(3, _http.Requests.Count);
            Assert.All(_http.Requests, r => Assert.Equal("key1", r.Headers["idempotency-key"]));
            Assert.Equal(new[] { 300, 600 }, _delay.Waits);

            // a new logical call gets a new key
            _http.Requests.Clear();
            _http.Reply(200, "{\"bannerId\":\"standard\",\"results\":[],\"spent\":{\"paid\":0,\"free\":100},\"pityPoints\":2}");
            await _api.DrawAsync("standard", 1);
            Assert.Equal("key2", _http.Requests[0].Headers["idempotency-key"]);
        }

        [Fact]
        public async Task UnsafeRequestsAreNotRetried()
        {
            _http.Fail(new IOException("timeout"));
            var e = await Assert.ThrowsAsync<NetworkException>(() => _api.EnqueueRankedAsync("h1"));
            Assert.Equal(ApiErrorCode.Network, e.Code);
            Assert.Single(_http.Requests);

            _http.Requests.Clear();
            _http.Reply(500, "{\"error\":{\"code\":\"INTERNAL\",\"message\":\"boom\"}}");
            await Assert.ThrowsAsync<ServerException>(() => _api.RetireAsync("h1"));
            Assert.Single(_http.Requests);
        }

        [Fact]
        public async Task SafeRequestsGiveUpAfterMaxRetries()
        {
            for (int i = 0; i < 4; i++) _http.Fail(new IOException("down"));
            await Assert.ThrowsAsync<NetworkException>(() => _api.GetPlayerAsync());
            Assert.Equal(4, _http.Requests.Count);
            Assert.Equal(new[] { 300, 600, 1200 }, _delay.Waits);
        }

        [Fact]
        public async Task UnauthorizedRefreshesTheTokenOnce()
        {
            _http.Reply(401, "{\"error\":{\"code\":\"UNAUTHORIZED\",\"message\":\"x\"}}").Reply(200, "{\"horses\":[]}");
            await _api.GetHorsesAsync();
            Assert.Equal("Bearer token", _http.Requests[0].Headers["authorization"]);
            Assert.Equal("Bearer fresh-token", _http.Requests[1].Headers["authorization"]);

            _http.Requests.Clear();
            _http.Reply(401, "{\"error\":{\"code\":\"UNAUTHORIZED\"}}").Reply(401, "{\"error\":{\"code\":\"UNAUTHORIZED\"}}");
            await Assert.ThrowsAsync<AuthException>(() => _api.GetHorsesAsync());
            Assert.Equal(2, _http.Requests.Count);
        }

        [Fact]
        public async Task DevUserHeaderReplacesTheToken()
        {
            var api = new ApiClient(_http, null, new ApiClientOptions { BaseUrl = "http://127.0.0.1:8787", DevUserId = "dev1" }, _delay, new SeqIds());
            _http.Reply(200, "{\"horses\":[]}");
            await api.GetHorsesAsync();
            Assert.Equal("dev1", _http.Requests[0].Headers["x-dev-user"]);
            Assert.False(_http.Requests[0].Headers.ContainsKey("authorization"));
            Assert.Equal("ws://127.0.0.1:8787/v1/race/r/ws", api.RaceWebSocketUrl(new RaceAssignment { WsPath = "/v1/race/r/ws" }));
        }

        [Theory]
        [InlineData(409, "INSUFFICIENT_COINS", typeof(InsufficientCoinsException), ApiErrorCode.InsufficientCoins)]
        [InlineData(409, "AGE_LIMIT_EXCEEDED", typeof(PurchaseBlockedException), ApiErrorCode.AgeLimitExceeded)]
        [InlineData(409, "AGE_REQUIRED", typeof(PurchaseBlockedException), ApiErrorCode.AgeRequired)]
        [InlineData(409, "GUARDIAN_CONSENT_REQUIRED", typeof(PurchaseBlockedException), ApiErrorCode.GuardianConsentRequired)]
        [InlineData(409, "UNSETTLED_DEBT", typeof(PurchaseBlockedException), ApiErrorCode.UnsettledDebt)]
        [InlineData(400, "NG_NAME", typeof(ValidationException), ApiErrorCode.NgName)]
        [InlineData(400, "INVALID_NAME", typeof(ValidationException), ApiErrorCode.InvalidName)]
        [InlineData(404, "HORSE_NOT_FOUND", typeof(NotFoundException), ApiErrorCode.HorseNotFound)]
        [InlineData(409, "BREEDING_DAILY_LIMIT", typeof(ConflictException), ApiErrorCode.BreedingDailyLimit)]
        [InlineData(409, "ALREADY_CLAIMED", typeof(ConflictException), ApiErrorCode.AlreadyClaimed)]
        [InlineData(409, "SOMETHING_NEW", typeof(ConflictException), ApiErrorCode.Unknown)]
        public async Task ErrorCodesMapToTypedExceptions(int status, string code, Type type, ApiErrorCode expected)
        {
            _http.Reply(status, "{\"error\":{\"code\":\"" + code + "\",\"message\":\"m\"}}");
            var e = await Assert.ThrowsAnyAsync<ApiException>(() => _api.ClaimLoginBonusAsync());
            Assert.IsType(type, e);
            Assert.Equal(expected, e.Code);
            Assert.Equal(code, e.WireCode);
            Assert.Equal(status, e.Status);
            Assert.Single(_http.Requests); // 4xx is never retried
        }

        [Fact]
        public void EveryServerErrorCodeIsKnown()
        {
            string errors = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "src", "domain", "errors.ts"));
            var union = errors.Substring(errors.IndexOf("export type ErrorCode", StringComparison.Ordinal));
            union = union.Substring(0, union.IndexOf(';'));
            var codes = Regex.Matches(union, "'([A-Z_]+)'").Select(m => m.Groups[1].Value).ToList();
            Assert.True(codes.Count >= 30);
            foreach (var c in codes) Assert.NotEqual(ApiErrorCode.Unknown, ApiErrorCodes.Parse(c));
            Assert.Equal(ApiErrorCode.Internal, ApiErrorCodes.Parse("INTERNAL"));
        }

        [Fact]
        public async Task NonJsonErrorBodyStillMapsByStatus()
        {
            _http.Reply(502, "<html>bad gateway</html>").Reply(502, "x").Reply(502, "x").Reply(502, "x");
            var e = await Assert.ThrowsAsync<ServerException>(() => _api.GetPlayerAsync());
            Assert.Equal(ApiErrorCode.Internal, e.Code);
        }

        [Fact]
        public async Task CancellationIsNotTreatedAsANetworkError()
        {
            using var cts = new CancellationTokenSource();
            cts.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => _api.GetPlayerAsync(cts.Token));
            Assert.Empty(_http.Requests);
        }
    }
}
