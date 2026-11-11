using System.Reflection;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-PROMO-013/014/019: 昇級戦と降級の猶予 — the client view, the home / result words and the API (protocol §68).</summary>
    public class PromotionTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public PromotionTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        private const string Rules = "\"rules\":{\"races\":3,\"needTop\":2,\"topPlace\":3,\"setbackPoints\":40,\"graceRaces\":10}";

        [Fact]
        public async Task ActiveSeriesViewAndHomeLabel()
        {
            _http.Reply(200, "{\"enabled\":true,\"seasonId\":\"2026-11\",\"classId\":\"C\",\"toClassId\":\"B\",\"line\":300,\"points\":332,\"earned\":332," + Rules +
                ",\"series\":{\"id\":\"2026-11:C:1\",\"status\":\"active\",\"races\":3,\"needTop\":2,\"topPlace\":3,\"results\":[{\"raceId\":\"r1\",\"place\":2,\"top\":true,\"cpu\":false}],\"pips\":[\"top\",\"open\",\"open\"],\"next\":2,\"tops\":1,\"misses\":0,\"startedAt\":1794416400000,\"endedAt\":null,\"setbackTo\":null,\"seen\":false}," +
                "\"passedThisSeason\":false,\"grace\":null,\"shieldUsedThisSeason\":false}");
            var v = await _api.GetPromotionAsync();
            Assert.Equal("GET", _http.Requests[0].Method);
            Assert.Equal("/v1/promotion", _http.Requests[0].Path);
            Assert.True(v.InSeries);
            Assert.Equal(300, v.Line);
            Assert.Equal(3, v.Rules.TopPlace);
            Assert.Equal("昇級戦 2/3", PromotionPips.HomeLabel(v));
            Assert.Equal("○◌◌", PromotionPips.Marks(v.Series));
            Assert.Equal("3戦で3着以内が2回で突破", PromotionPips.RuleLine(v.Series));
            Assert.Null(PromotionPips.OutcomeTitle(v));
            Assert.Null(PromotionPips.GraceLabel(v));
            Assert.True(v.Series.Results[0].Top);
        }

        [Fact]
        public async Task OutcomesGraceAndAck()
        {
            _http.Reply(200, "{\"enabled\":true,\"seasonId\":\"2026-11\",\"classId\":\"C\",\"toClassId\":\"B\",\"line\":300,\"points\":260,\"earned\":328," + Rules +
                ",\"series\":{\"id\":\"2026-11:C:1\",\"status\":\"failed\",\"races\":3,\"needTop\":2,\"topPlace\":3,\"results\":[],\"pips\":[\"miss\",\"miss\",\"skip\"],\"next\":null,\"tops\":0,\"misses\":2,\"startedAt\":1,\"endedAt\":2,\"setbackTo\":260,\"seen\":false}," +
                "\"passedThisSeason\":false,\"grace\":{\"classId\":\"C\",\"racesLeft\":7},\"shieldUsedThisSeason\":false}");
            var v = await _api.GetPromotionAsync();
            Assert.False(v.InSeries);
            Assert.True(v.Series.OutcomePending);
            Assert.Null(PromotionPips.HomeLabel(v));
            Assert.Equal("●●–", PromotionPips.Marks(v.Series));
            Assert.Equal("昇級ならず", PromotionPips.OutcomeTitle(v));
            Assert.Equal("ポイントは260ptに戻りました。あと40ptでもう一度挑めます", PromotionPips.OutcomeBody(v));
            Assert.Equal("降級の猶予 残り7戦", PromotionPips.GraceLabel(v));

            _http.Reply(200, "{\"seriesId\":\"2026-11:C:1\",\"seen\":true}");
            Assert.True(await _api.AckPromotionAsync("2026-11:C:1"));
            Assert.Equal("POST", _http.Requests[1].Method);
            Assert.Equal("/v1/promotion/ack", _http.Requests[1].Path);
            Assert.Contains("\"seriesId\":\"2026-11:C:1\"", _http.Requests[1].Body);

            var passed = PromotionView.FromJson("{\"enabled\":true,\"toClassId\":\"B\",\"line\":300," + Rules + ",\"series\":{\"id\":\"x\",\"status\":\"passed\",\"pips\":[\"top\",\"top\",\"skip\"],\"races\":3,\"seen\":false}}");
            Assert.Equal("B級へ昇級確定", PromotionPips.OutcomeTitle(passed));
            Assert.Equal("シーズンの締めでB級に上がります", PromotionPips.OutcomeBody(passed));
        }

        [Fact]
        public void KillSwitchShowsNothingAndNothingIsForSale()
        {
            var off = PromotionView.FromJson("{\"enabled\":false,\"classId\":\"C\"," + Rules + ",\"series\":null,\"grace\":null}");
            Assert.False(off.InSeries);
            Assert.Null(PromotionPips.HomeLabel(off));
            Assert.Null(PromotionPips.GraceLabel(off));
            Assert.Contains(ActivityKinds.ClassPromoted, ActivityKinds.All);
            foreach (var t in new[] { typeof(PromotionView), typeof(PromotionSeries), typeof(PromotionRules), typeof(PromotionGrace) })
                foreach (var mbr in t.GetMembers(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static))
                    Assert.DoesNotMatch("(?i)reward|coin|price|purchase|grant|gift", mbr.Name);
        }
    }
}
