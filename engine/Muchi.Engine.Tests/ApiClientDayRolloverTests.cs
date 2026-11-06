using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-DAY-001/006: GET /v1/config carries the game-day rule; the client formulas match server/src/domain/time.ts.</summary>
    public class ApiClientDayRolloverTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;
        private static long Jst(int y, int mo, int d, int h = 0, int mi = 0) => new DateTimeOffset(y, mo, d, h, mi, 0, TimeSpan.FromHours(9)).ToUnixTimeMilliseconds();

        public ApiClientDayRolloverTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        [Fact]
        public async Task ConfigParsesTheRuleAndKeysMatchTheServer()
        {
            _http.Reply(200, "{\"versionId\":\"base\",\"hash\":\"base\",\"rulesetVersion\":\"1.3.0\",\"activatedAt\":null,\"visualsVersion\":3,"
                + "\"dayRollover\":{\"hourJst\":4,\"previousHourJst\":0,\"effectiveAtMs\":1796065200000}}");
            var c = await _api.GetConfigAsync();
            var r = c.DayRollover;
            Assert.NotNull(r);
            Assert.Equal(4, r.HourJst);
            Assert.Equal(Jst(2026, 12, 1, 4), r.EffectiveAtMs);
            // the same cases as server/test/day-rollover.test.ts
            Assert.Equal("2026-12-04", r.Key(Jst(2026, 12, 5, 3, 59)));
            Assert.Equal("2026-12-05", r.Key(Jst(2026, 12, 5, 4)));
            Assert.Equal("2026-11-21", r.Key(Jst(2026, 11, 21, 0)));        // before the switch: midnight
            Assert.Equal("2026-12-01", r.Key(Jst(2026, 12, 1, 0)));
            Assert.Equal("2026-12-01", r.Key(Jst(2026, 12, 2, 0, 30)));     // the 28 h switch day
            Assert.Equal("2026-12-02", r.Key(Jst(2026, 12, 2, 4)));
            Assert.Equal(1, r.Index(Jst(2026, 12, 5, 4)) - r.Index(Jst(2026, 12, 5, 3, 59)));
            Assert.Equal(2, r.DaysUntil(Jst(2027, 1, 1), Jst(2026, 12, 31, 2)));
            Assert.Equal(1, r.DaysUntil(Jst(2027, 1, 1), Jst(2026, 12, 31, 12)));
            Assert.Equal(0, r.DaysUntil(Jst(2027, 1, 1), Jst(2027, 1, 1)));
        }

        [Fact]
        public async Task OlderServerWithoutTheRule()
        {
            _http.Reply(200, "{\"versionId\":\"base\",\"hash\":\"base\",\"rulesetVersion\":\"1.3.0\",\"activatedAt\":null,\"visualsVersion\":3}");
            Assert.Null((await _api.GetConfigAsync()).DayRollover);
        }
    }
}
