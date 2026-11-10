using System.Linq;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-CUP-*: プレイヤー主催カップ client methods, models, codes, the cup race mode and the result card (contracts/protocol.md §42).</summary>
    public class HostedCupsTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public HostedCupsTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        // the shape HostedCupsService answers (server test hosted-cups.test.ts)
        internal const string Cup = "{\"cupId\":\"cup_abcdefghijklmnop\",\"cupName\":\"1着\",\"hostId\":\"h\",\"hostName\":\"トオル\",\"role\":\"entrant\",\"code\":\"K7PM-Q2XD\",\"format\":\"best_of_3\",\"capacity\":6,\"racesTotal\":3,\"racesDone\":1,"
            + "\"conditions\":{\"trackId\":\"aoba_turf_1600\",\"going\":\"good\",\"night\":null,\"weather\":\"sunny\",\"temperatureC\":18,\"windKmh\":0},\"opensAt\":1794279600000,\"closesAt\":1794290400000,\"status\":\"open\",\"partial\":false,\"cancelReason\":null,\"finishedAt\":null,"
            + "\"entrants\":[{\"playerId\":\"h\",\"displayName\":\"トオル\",\"horseName\":\"アイボウ\",\"withdrawn\":false},{\"playerId\":\"me\",\"displayName\":\"ゆう\",\"horseName\":\"ハヤテ\",\"withdrawn\":false}],"
            + "\"races\":[{\"index\":0,\"raceId\":\"cup-cup_abcdefghijklmnop-0-0\",\"status\":\"done\",\"startAtMs\":1794280000000,\"places\":{\"h\":2,\"me\":1,\"x\":null}}],"
            + "\"standings\":[{\"playerId\":\"me\",\"rank\":1,\"points\":10,\"places\":[1],\"displayName\":\"ゆう\",\"trophy\":null},{\"playerId\":\"h\",\"rank\":2,\"points\":7,\"places\":[null],\"displayName\":\"トオル\",\"trophy\":null}],"
            + "\"canStart\":false,\"startProblem\":null,\"minEntrants\":2}";

        [Fact]
        public async Task ListAndCupParse()
        {
            _http.Reply(200, "{\"enabled\":true,\"limits\":{\"maxActivePerHost\":2,\"maxEntriesPerPlayer\":4,\"minCapacity\":4,\"maxCapacity\":8,\"minEntrants\":2,\"nameMaxChars\":20,\"pointsByPlace\":[10,7,5]},\"active\":[" + Cup + "],"
                + "\"invites\":[{\"cupId\":\"cup_x\",\"cupName\":\"夜カップ\",\"hostId\":\"f\",\"hostName\":\"フレンド\",\"at\":1,\"until\":2}],"
                + "\"history\":[{\"cupId\":\"cup_y\",\"cupName\":\"昼カップ\",\"format\":\"single\",\"rank\":1,\"points\":0,\"entrants\":4,\"at\":5,\"status\":\"finished\",\"partial\":false,\"cancelReason\":null,\"trophy\":\"gold\"}],"
                + "\"trophies\":{\"gold\":1,\"silver\":0,\"bronze\":0},\"teamId\":null}");
            var v = await _api.GetCupsAsync();
            Assert.Equal("/v1/cups", _http.Requests[0].Path);
            Assert.True(v.Enabled && v.CanHost);
            Assert.Equal(new[] { 10, 7, 5 }, v.Limits.PointsByPlace);
            var c = v.Active.Single();
            Assert.Equal("1着", c.CupName); // player-typed, never translated
            Assert.False(c.IsHost);
            Assert.Equal("aoba_turf_1600", c.Conditions.TrackId);
            Assert.Null(c.Conditions.Night);
            Assert.Equal(1, c.Races[0].Places["me"]);
            Assert.Null(c.Races[0].Places["x"]);
            Assert.Null(c.Standings[1].Places[0]);
            Assert.Equal("gold", v.History[0].Trophy);
            Assert.Equal(1, v.Trophies.Total);
            Assert.Equal("フレンド", v.Invites[0].HostName);
        }

        [Fact]
        public async Task CreateJoinAreKeyedAndCodesNormalized()
        {
            _http.Reply(200, "{\"cup\":" + Cup + ",\"created\":true}");
            var req = new CupCreateRequest { CupName = "1着", Capacity = 6, Format = CupFormats.BestOf3, OpensAt = 1, ClosesAt = 2, HorseId = "h1", Conditions = new CupConditions { TrackId = "aoba_turf_1600", Weather = "sunny", TemperatureC = 18 } };
            var r = await _api.CreateCupAsync(req);
            Assert.True(r.Created);
            Assert.True(_http.Requests[0].Headers.ContainsKey("idempotency-key"));
            Assert.Contains("\"going\":null", _http.Requests[0].Body);
            Assert.Contains("\"format\":\"best_of_3\"", _http.Requests[0].Body);
            _http.Reply(200, "{\"cup\":" + Cup + ",\"joined\":true}");
            var j = await _api.JoinCupAsync("h1", code: "k7pm-q2xd");
            Assert.True(j.Joined);
            Assert.Equal("/v1/cups/join", _http.Requests[1].Path);
            Assert.Contains("\"code\":\"K7PMQ2XD\"", _http.Requests[1].Body);
            Assert.Throws<ArgumentException>(() => { _api.JoinCupAsync("h1").GetAwaiter().GetResult(); });
        }

        [Fact]
        public async Task ErrorsMapToTypedExceptions()
        {
            _http.Reply(409, "{\"error\":{\"code\":\"CUP_FULL\",\"message\":\"the cup is full\"}}");
            var e = await Assert.ThrowsAsync<ConflictException>(() => _api.JoinCupAsync("h1", cupId: "cup_abcdefghijklmnop"));
            Assert.Equal(ApiErrorCode.CupFull, e.Code);
            _http.Reply(404, "{\"error\":{\"code\":\"CUP_CODE_INVALID\",\"message\":\"x\"}}");
            var n = await Assert.ThrowsAsync<NotFoundException>(() => _api.LookupCupCodeAsync("AAAA-AAAA"));
            Assert.Equal(ApiErrorCode.CupCodeInvalid, n.Code);
            foreach (var w in new[] { "CUP_LIMIT", "CUP_FULL", "CUP_CLOSED", "CUP_CODE_INVALID", "CUP_NOT_READY" }) Assert.Contains(w, ApiErrorCodes.WireCodes);
        }

        [Fact]
        public void CupCodes()
        {
            Assert.Equal("K7PMQ2XD", CupCode.Normalize(" k7pm-q2xd "));
            Assert.Equal("KMPMQ2XD", CupCode.Normalize("ＫＭＰＭＱ２ＸＤ"));
            Assert.Null(CupCode.Normalize("K7PM-Q2X0")); // 0 is not in the alphabet
            Assert.Null(CupCode.Normalize("K7PM"));
            Assert.Equal("K7PM-Q2XD", CupCode.Display("k7pmq2xd"));
            Assert.DoesNotContain('O', CupCode.Alphabet);
            Assert.DoesNotContain('1', CupCode.Alphabet);
        }

        [Fact]
        public void CupModeRoundTripsAndResultCardShowsNoNames()
        {
            Assert.Equal(RaceMode.Cup, ProtocolCodec.ParseMode("cup"));
            Assert.Equal("cup", ProtocolCodec.ModeToString(RaceMode.Cup));
            Assert.Equal("cup", Commentator.ModeName(RaceMode.Cup));
            Assert.Equal("主催カップ", ShareCard.ModeText(RaceMode.Cup));
            var cup = HostedCup.FromJson(Cup);
            var card = CupResultCard.Build(cup, "me", "ハヤテ", "青葉 芝1600m");
            Assert.Equal("1位 / 2人", card.PlaceText);
            Assert.Equal(CupResultCard.Kind, card.Kind);
            Assert.Equal("10pt（3レース）", card.SkillLines.Single());
            Assert.DoesNotContain("トオル", card.ShareText);
            Assert.DoesNotContain("ゆう", card.ShareText);
            Assert.DoesNotContain("1着", card.ShareText); // the cup name (typed by the host) stays off the card
            Assert.Contains("#ムチ一閃", card.ShareText);
        }
    }
}
