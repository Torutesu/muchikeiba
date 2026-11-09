using System.IO;
using System.Linq;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-ORG-001..016: 厩舎の整理 — the shared sort rules (contracts/roster-query.vectors.json) and the client API (protocol §44).</summary>
    public class RosterTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public RosterTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        private static JsonNode Vectors => JsonNode.Parse(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "contracts", "roster-query.vectors.json")));

        [Fact]
        public void SorterMatchesTheServerVectors()
        {
            var v = Vectors;
            JsonNode Get(JsonNode o, string k) { Assert.True(o.TryGet(k, out var x)); return x; }
            var rows = Get(v, "rows").Items.Select(RosterRow.Parse).ToList();
            int n = 0;
            foreach (var c in Get(v, "cases").Items)
            {
                var q = RosterQuery.FromJson(Get(c, "query"));
                var expect = Get(c, "expect").Items.Select(x => x.AsString()).ToArray();
                Assert.True(expect.SequenceEqual(RosterSorter.Apply(rows, q).Select(r => r.HorseId)), Get(c, "name").AsString());
                n++;
            }
            Assert.True(n >= 30);
        }

        [Fact]
        public void AptitudeAndSearchFollowTheServer()
        {
            var c = new RosterCourse { Surface = "turf", DistanceM = 2000, Going = "soft" };
            var a = RosterSorter.Aptitude(new RosterRow { Surface = "turf", DistMinM = 1800, DistMaxM = 2400, GoingAptitude = "heavy" }, c);
            Assert.Equal(450, a.Score); Assert.Equal("◎", a.Mark);
            Assert.Equal("○", RosterSorter.Aptitude(new RosterRow { Surface = "both", DistMinM = 1800, DistMaxM = 2400, GoingAptitude = "fast" }, c).Mark);
            Assert.Equal(300, RosterSorter.Aptitude(new RosterRow { Surface = "turf", DistMinM = 1000, DistMaxM = 1800, GoingAptitude = "any" }, c).Score);
            Assert.Equal("×", RosterSorter.Aptitude(new RosterRow { Surface = "dirt", DistMinM = 1000, DistMaxM = 1400, GoingAptitude = "any" }, c).Mark);
            Assert.Equal(RosterSorter.FoldSearch("ミドリ"), RosterSorter.FoldSearch("みどり"));
            Assert.Equal(RosterSorter.FoldSearch("ミドリ"), RosterSorter.FoldSearch("ﾐﾄﾞﾘ"));
            Assert.Equal("ミドリノカゼ", RosterSorter.FoldSearch("ミドリ ノ カゼ"));
            Assert.Equal("ハヤテー", RosterSorter.FoldSearch("ハヤテ-"));
        }

        [Fact]
        public void QueryEncodesForTheDeviceAndDecodesUnknownValuesToDefaults()
        {
            var q = new RosterQuery { Sort = "aptitude", Dir = "asc", Course = new RosterCourse { Surface = "turf", DistanceM = 2000, Going = "soft", TrackId = "aoba_turf_2000" },
                Surface = "turf", Band = "mile", Style = "sashi", Status = "active", Skill = true, Locked = false, FavoritesFirst = false, Q = "ミドリ;=x" };
            var s = q.Encode();
            Assert.StartsWith("v1;sort=aptitude;dir=asc;", s);
            var d = RosterQuery.Decode(s);
            Assert.Equal(s, d.Encode());
            Assert.Equal("ミドリ;=x", d.Q);
            Assert.Equal(7, d.FilterCount);
            var bad = RosterQuery.Decode("v1;sort=speed;dir=up;surface=snow;band=x;status=gone;skill=yes;q=" + new string('ア', 40));
            Assert.Equal("acquired", bad.Sort); Assert.Equal("desc", bad.Dir); Assert.Null(bad.Surface); Assert.Null(bad.Band); Assert.Equal("all", bad.Status);
            Assert.Null(bad.Skill); Assert.Equal(20, bad.Q.Length);
            Assert.Equal("acquired", RosterQuery.Decode("v1;sort=aptitude").Sort); // aptitude without a course falls back
            Assert.Equal("acquired", RosterQuery.Decode("v2;sort=rating").Sort);
            Assert.Equal("?sort=aptitude&dir=asc&trackId=aoba_turf_2000&going=soft&surface=turf&band=mile&style=sashi&status=active&skill=1&locked=0&favoritesFirst=0&q=%E3%83%9F%E3%83%89%E3%83%AA%3B%3Dx", q.ToQueryString());
        }

        private const string View = "{\"total\":2,\"active\":1,\"retired\":1,\"locked\":1,\"favorites\":0,\"bulkMax\":50,\"actions\":[\"retire\"],\"partnerHorseId\":\"h1\",\"horses\":[{\"horseId\":\"h2\",\"name\":\"ミドリノカゼ\",\"templateId\":\"t1\",\"rarity\":\"SSR\",\"sex\":\"male\",\"style\":\"sashi\",\"surface\":\"turf\",\"distMinM\":1600,\"distMaxM\":2400,\"goingAptitude\":\"heavy\",\"status\":\"active\",\"rating\":2880,\"skillId\":null,\"partner\":false,\"locked\":true,\"favorite\":false,\"acquiredSeq\":2,\"bornAt\":1,\"ageDays\":3,\"races\":4,\"wins\":1,\"blocks\":[\"locked\"]}],\"notice\":\"まとめて引退しても、コインや素材は返ってきません\"}";

        [Fact]
        public async Task ListLockFavouritePreviewAndBulk()
        {
            _http.Reply(200, View);
            var v = await _api.GetRosterAsync(new RosterQuery { Sort = "rating" });
            Assert.Equal("/v1/roster?sort=rating&dir=desc", _http.Requests[0].Path);
            Assert.Equal("ミドリノカゼ", v.Horses[0].Name);
            Assert.False(v.Horses[0].Selectable);
            Assert.Equal(new[] { "retire" }, v.Actions);

            _http.Reply(200, "{\"horseId\":\"h2\",\"locked\":false}");
            Assert.False(await _api.SetHorseLockAsync("h2", false));
            Assert.Equal("PUT", _http.Requests[1].Method);
            Assert.Equal("/v1/horses/h2/lock", _http.Requests[1].Path);
            Assert.Contains("\"locked\":false", _http.Requests[1].Body);
            _http.Reply(200, "{\"horseId\":\"h2\",\"favorite\":true}");
            Assert.True(await _api.SetHorseFavoriteAsync("h2", true));

            _http.Reply(200, "{\"action\":\"retire\",\"count\":1,\"eligible\":1,\"refused\":0,\"horses\":[{\"horseId\":\"h2\",\"name\":\"ミドリノカゼ\",\"ok\":true,\"reasons\":[]}],\"refund\":{\"paidCoins\":0,\"freeCoins\":0,\"materials\":{},\"items\":{}},\"canConfirm\":true,\"confirmToken\":\"r1-0a\"}");
            var p = await _api.PreviewBulkAsync("retire", new[] { "h2" });
            Assert.True(p.CanConfirm); Assert.True(p.Refund.IsNothing); Assert.Equal("r1-0a", p.ConfirmToken);
            Assert.False(_http.Requests[3].Headers.ContainsKey("idempotency-key"));

            _http.Reply(200, "{\"action\":\"retire\",\"count\":1,\"horses\":[{\"horseId\":\"h2\",\"name\":\"ミドリノカゼ\",\"ceremony\":null}],\"refund\":{\"paidCoins\":0,\"freeCoins\":0,\"materials\":{},\"items\":{}}}");
            var r = await _api.RunBulkAsync(p, new[] { "h2" });
            Assert.Equal(1, r.Count);
            Assert.Equal("key1", _http.Requests[4].Headers["idempotency-key"]);
            Assert.Contains("\"confirmToken\":\"r1-0a\"", _http.Requests[4].Body);
            Assert.Contains("\"horseIds\":[\"h2\"]", _http.Requests[4].Body);
        }

        [Fact]
        public async Task RefusalCarriesEachHorseAndReason()
        {
            _http.Reply(409, "{\"error\":{\"code\":\"ROSTER_BULK_REFUSED\",\"message\":\"1 horse(s) cannot be retired\",\"details\":{\"horses\":[{\"horseId\":\"h1\",\"name\":\"アイボウ\",\"ok\":false,\"reasons\":[\"partner\",\"in_training\"]}]}}}");
            var e = await Assert.ThrowsAsync<BulkRefusedException>(() => _api.RunBulkAsync(new BulkPreview { Action = "retire", ConfirmToken = "x" }, new[] { "h1" }));
            Assert.Equal(ApiErrorCode.RosterBulkRefused, e.Code);
            Assert.Equal(new[] { BulkReason.Partner, BulkReason.InTraining }, e.Horses[0].Reasons);
            Assert.Equal(ApiErrorCode.HorseLocked, ApiErrorCodes.Parse("HORSE_LOCKED"));
            Assert.Equal(ApiErrorCode.RosterBulkStale, ApiErrorCodes.Parse("ROSTER_BULK_STALE"));
        }

        [Fact]
        public void RosterSortEventIsChecked()
        {
            var e = AnalyticsEvent.RosterSort(1, "aptitude", 12);
            Assert.Equal("roster_sort", e.Name);
            Assert.Throws<System.ArgumentException>(() => AnalyticsEvent.RosterSort(1, "speed", 0));
        }
    }
}
