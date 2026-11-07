using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-TRAIN-001..014: /v1/training client methods, models and the shared timing scorer (contracts/protocol.md §22).</summary>
    public class ApiClientTrainingTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientTrainingTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        // produced by the real server (PlayerService.training) after one 坂路 session with a perfect mini-game
        internal const string View = "{\"enabled\":true,\"slotsPerDay\":3,\"usedToday\":1,\"slotsLeft\":2,\"perHorsePerDay\":2,\"menus\":[{\"id\":\"hill\",\"name\":\"坂路\",\"baseGain\":6,\"fatigue\":30,\"weights\":{\"burst\":2,\"guts\":1,\"stamina\":1},\"bondMultiplier\":1},{\"id\":\"wood\",\"name\":\"ウッド\",\"baseGain\":6,\"fatigue\":25,\"weights\":{\"speed\":2,\"stamina\":1,\"temper\":1},\"bondMultiplier\":1},{\"id\":\"pool\",\"name\":\"プール\",\"baseGain\":3,\"fatigue\":-20,\"weights\":{\"stamina\":2,\"temper\":1},\"bondMultiplier\":1},{\"id\":\"awase\",\"name\":\"併せ馬\",\"baseGain\":7,\"fatigue\":35,\"weights\":{\"guts\":2,\"speed\":1,\"burst\":1},\"bondMultiplier\":2}],"
            + "\"timing\":{\"beats\":5,\"durationMs\":6000,\"leadMs\":800,\"tailMs\":200,\"perfectMs\":60,\"goodMs\":150,\"perfectPoints\":2,\"goodPoints\":1,\"strayPenalty\":1,\"permillePerPoint\":10,\"maxTaps\":10,\"minTapGapMs\":80,\"maxScore\":10},\"fatigue\":{\"max\":100,\"restAt\":80,\"recoveryPerDay\":40},"
            + "\"items\":[{\"itemId\":\"training_apple\",\"name\":\"りんごのおやつ\",\"fatigueRelief\":30,\"owned\":0}],"
            + "\"horses\":[{\"horseId\":\"h1\",\"name\":\"アイボウ\",\"rarity\":\"SR\",\"trained\":{\"speed\":0,\"stamina\":2,\"burst\":3,\"guts\":1,\"temper\":0},\"trainedTotal\":6,\"potential\":240,\"perStatCap\":96,\"fatigue\":30,\"condition\":\"fresh\",\"bondLevel\":1,\"todayCount\":1,\"sessions\":1,\"log\":[{\"at\":1796871607000,\"menuId\":\"hill\",\"grade\":\"great\",\"gain\":6,\"score\":10}],\"blocked\":null,\"menus\":[{\"id\":\"hill\",\"blocked\":null},{\"id\":\"wood\",\"blocked\":null},{\"id\":\"pool\",\"blocked\":null},{\"id\":\"awase\",\"blocked\":\"tired\"}]}],"
            + "\"open\":null,\"rules\":{\"rankedNormalized\":true,\"fatigueAffectsRaces\":false,\"inherited\":false,\"paidBoosts\":false}}";
        internal const string Start = "{\"session\":{\"sessionId\":\"tr_mxgyyg00_oggiip\",\"horseId\":\"h1\",\"menuId\":\"hill\",\"startedAt\":1796871600000,\"expiresAt\":1796872200000,\"beats\":[814,1916,3236,4273,4887],\"durationMs\":6000},\"preview\":{\"min\":6,\"max\":6,\"minMilli\":6000,\"maxMilli\":6600},\"slotsLeft\":2}";
        internal const string Finish = "{\"sessionId\":\"tr_mxgyyg00_oggiip\",\"horseId\":\"h1\",\"menuId\":\"hill\",\"grade\":\"great\",\"timing\":{\"perfect\":5,\"good\":0,\"miss\":0,\"stray\":0,\"score\":10,\"bonusPermille\":100},\"gain\":{\"speed\":0,\"stamina\":2,\"burst\":3,\"guts\":1,\"temper\":0},\"total\":6,\"capped\":false,\"breakdown\":{\"efficiencyPermille\":1000,\"bondPermille\":0,\"timingPermille\":100,\"softPermille\":1000},\"trained\":{\"speed\":0,\"stamina\":2,\"burst\":3,\"guts\":1,\"temper\":0},\"trainedTotal\":6,\"potential\":240,\"fatigue\":30,\"settled\":\"done\",\"void\":false}";

        [Fact]
        public async Task ViewParsesSlotsMenusHorsesAndTheRules()
        {
            _http.Reply(200, View);
            var v = await _api.GetTrainingAsync();
            Assert.Equal("/v1/training", _http.Requests[0].Path);
            Assert.True(v.Enabled);
            Assert.Equal(2, v.SlotsLeft);
            Assert.Equal(4, v.Menus.Count);
            Assert.Equal("併せ馬", v.Menu("awase").Name);
            Assert.Equal(2, v.Menu("awase").BondMultiplier);
            Assert.Equal(-20, v.Menu("pool").Fatigue);
            Assert.Equal(2, v.Menu("hill").Weights["burst"]);
            Assert.Equal(10, v.Timing.MaxScore);
            Assert.Equal(80, v.RestAt);
            var h = v.Horse("h1");
            Assert.Equal(240, h.Potential);
            Assert.Equal(3, h.Trained.Burst);
            Assert.Equal("fresh", h.Condition);
            Assert.True(h.CanTrain("hill"));
            Assert.False(h.CanTrain("awase"));
            Assert.Equal("great", h.Log[0].Grade);
            Assert.Null(v.Open);
            Assert.True(v.Rules.RankedNormalized);
            Assert.False(v.Rules.FatigueAffectsRaces);
            Assert.False(v.Rules.PaidBoosts);
        }

        [Fact]
        public async Task StartAndFinishAreKeyedAndSendTheTaps()
        {
            _http.Reply(503, "{\"error\":{\"code\":\"INTERNAL\"}}").Reply(200, Start);
            var s = await _api.StartTrainingAsync("h1", "hill");
            Assert.Equal(2, _http.Requests.Count);
            Assert.Equal("POST", _http.Requests[1].Method);
            Assert.Equal("/v1/training/start", _http.Requests[1].Path);
            Assert.Equal(_http.Requests[0].Headers["idempotency-key"], _http.Requests[1].Headers["idempotency-key"]);
            Assert.Contains("\"menuId\":\"hill\"", _http.Requests[1].Body);
            Assert.Equal(new[] { 814, 1916, 3236, 4273, 4887 }, s.Session.Beats);
            Assert.Equal(6600, s.PreviewMaxMilli);

            _http.Reply(200, Finish);
            var r = await _api.FinishTrainingAsync(s.Session.SessionId, new[] { 834, 1936, 3256, 4293, 4907 });
            var req = _http.Requests[2];
            Assert.Equal("/v1/training/tr_mxgyyg00_oggiip/finish", req.Path);
            Assert.Contains("\"taps\":[834,1936,3256,4293,4907]", req.Body);
            Assert.DoesNotContain("skipped", req.Body);
            Assert.True(req.Headers.ContainsKey("idempotency-key"));
            Assert.Equal("great", r.Grade);
            Assert.Equal(6, r.Total);
            Assert.Equal(5, r.Timing.Perfect);
            Assert.Equal(100, r.TimingPermille);
            Assert.Equal("done", r.Settled);

            _http.Reply(200, Finish);
            await _api.FinishTrainingAsync("tr_x", null, skipped: true);
            Assert.Contains("\"skipped\":true", _http.Requests[3].Body);
            Assert.Contains("\"taps\":[]", _http.Requests[3].Body);
        }

        [Fact]
        public async Task TrainingErrorsAreTyped()
        {
            _http.Reply(422, "{\"error\":{\"code\":\"TRAINING_INPUT_INVALID\",\"message\":\"finished faster than the taps say\"}}");
            var e = await Assert.ThrowsAsync<ValidationException>(() => _api.FinishTrainingAsync("tr_x", new[] { 1 }));
            Assert.Equal(ApiErrorCode.TrainingInputInvalid, e.Code);
            _http.Reply(409, "{\"error\":{\"code\":\"TRAINING_TIRED\"}}");
            var c = await Assert.ThrowsAsync<ConflictException>(() => _api.StartTrainingAsync("h1", "hill"));
            Assert.Equal(ApiErrorCode.TrainingTired, c.Code);
            foreach (var w in new[] { "TRAINING_LIMIT", "TRAINING_POTENTIAL_FULL", "TRAINING_SESSION_EXPIRED", "TRAINING_SESSION_USED" })
                Assert.Contains(w, ApiErrorCodes.WireCodes);
        }

        [Fact]
        public async Task ItemUseSendsTheHorse()
        {
            _http.Reply(200, "{\"itemId\":\"training_apple\",\"horseId\":\"h1\",\"fatigueBefore\":60,\"fatigue\":30,\"remaining\":2}");
            var r = await _api.UseTrainingItemAsync("training_apple", "h1");
            Assert.Equal("/v1/training/items/training_apple/use", _http.Requests[0].Path);
            Assert.Contains("\"horseId\":\"h1\"", _http.Requests[0].Body);
            Assert.Equal(30, r.Fatigue);
            Assert.Equal(2, r.Remaining);
        }

        [Fact]
        public void ScorerMatchesTheServerVector()
        {
            var t = new TrainingTiming { Beats = 5, DurationMs = 6000, PerfectMs = 60, GoodMs = 150, PerfectPoints = 2, GoodPoints = 1, StrayPenalty = 1, PermillePerPoint = 10, MaxTaps = 10, MinTapGapMs = 80 };
            var beats = new[] { 1000, 2000, 3000, 4000, 5000 };
            // the same vector as server/test/training.test.ts
            var s = TrainingScorer.Score(t, beats, new[] { 1010, 2100, 3200, 4950, 5000 });
            Assert.Equal((2, 1, 2, 2, 3, 30), (s.Perfect, s.Good, s.Miss, s.Stray, s.Score, s.BonusPermille));
            Assert.Equal(10, TrainingScorer.Score(t, beats, beats).Score);
            Assert.Equal(0, TrainingScorer.Score(t, beats, new int[0]).Score);
            Assert.Equal("great", TrainingScorer.Grade(t, 9, false));
            Assert.Equal("good", TrainingScorer.Grade(t, 5, false));
            Assert.Equal("normal", TrainingScorer.Grade(t, 10, true));
            Assert.Equal("perfect", TrainingScorer.Judge(t, beats, 2040));
            Assert.Equal("good", TrainingScorer.Judge(t, beats, 2140));
            Assert.Equal("miss", TrainingScorer.Judge(t, beats, 2500));
            Assert.True(TrainingScorer.Accepts(t, new[] { 1000 }, 1080));
            Assert.False(TrainingScorer.Accepts(t, new[] { 1000 }, 1079));
            Assert.False(TrainingScorer.Accepts(t, new int[0], 6001));
        }

        [Fact]
        public async Task HorseParsesTrainedGrowth()
        {
            _http.Reply(200, "{\"horses\":[{\"id\":\"h1\",\"base\":{\"speed\":700},\"trained\":{\"speed\":12,\"guts\":3}},{\"id\":\"h2\"}]}");
            var hs = await _api.GetHorsesAsync();
            Assert.Equal(12, hs[0].Trained.Speed);
            Assert.Equal(3, hs[0].Trained.Guts);
            Assert.Equal(0, hs[1].Trained.Speed);
        }
    }
}
