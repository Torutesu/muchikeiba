using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-ADV-001..016: the pre-race advice in C# = the server's (contracts/protocol.md §39, contracts/race-advice.vectors.json).</summary>
    public class RaceAdviceTests
    {
        private static JsonNode Vectors() => JsonNode.Parse(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "contracts", "race-advice.vectors.json")));

        /// <summary>Deep equality of JSON values; object key order does not matter, a missing key equals null.</summary>
        private static void AssertSameJson(JsonNode expected, JsonNode actual, string path)
        {
            bool eNull = expected == null || expected.IsNull, aNull = actual == null || actual.IsNull;
            if (eNull || aNull) { Assert.True(eNull && aNull, path + ": expected " + (expected?.ToString() ?? "null") + " got " + (actual?.ToString() ?? "null")); return; }
            Assert.True(expected.Kind == actual.Kind, path + ": kind " + expected.Kind + " vs " + actual.Kind + " (" + expected + " / " + actual + ")");
            switch (expected.Kind)
            {
                case JsonKind.Object:
                    var keys = new HashSet<string>();
                    foreach (var kv in expected.Props) keys.Add(kv.Key);
                    foreach (var kv in actual.Props) keys.Add(kv.Key);
                    foreach (var k in keys)
                    {
                        expected.TryGet(k, out var ev);
                        actual.TryGet(k, out var av);
                        AssertSameJson(ev, av, path + "." + k);
                    }
                    break;
                case JsonKind.Array:
                    Assert.True(expected.Count == actual.Count, path + ": length " + expected.Count + " vs " + actual.Count + "\n" + expected + "\n" + actual);
                    for (int i = 0; i < expected.Count; i++) AssertSameJson(expected[i], actual[i], path + "[" + i + "]");
                    break;
                case JsonKind.String: Assert.Equal(expected.AsString(), actual.AsString()); break;
                case JsonKind.Bool: Assert.True(expected.AsBool() == actual.AsBool(), path); break;
                default: Assert.True(expected.AsLong() == actual.AsLong(), path + ": " + expected + " vs " + actual); break;
            }
        }

        [Fact]
        public void EveryVectorMatchesTheServer()
        {
            var cases = Vectors().Get("cases");
            Assert.True(cases.Count >= 12);
            foreach (var c in cases.Items)
            {
                var name = c.Get("name").AsString();
                var input = AdviceInput.Parse(c.Get("input"));
                var output = RaceAdvice.Compute(input);
                AssertSameJson(c.Get("output"), output.ToJson(), name);
            }
        }

        [Fact]
        public void TheRulesFromTheEngineRulesetAreTheServersRules()
        {
            // the first vector uses adviceRules(contracts/ruleset-params.default.json) on the server
            var server = AdviceRules.Parse(Vectors().Get("cases")[0].Get("input").Get("rules"));
            var mine = RaceAdvice.Rules(TestUtil.Ruleset());
            Assert.Equal(server.AptitudeOutPenaltyPermille, mine.AptitudeOutPenaltyPermille);
            Assert.Equal(server.GoingSpecialistPermille, mine.GoingSpecialistPermille);
            Assert.Equal(server.MaxWhips, mine.MaxWhips);
            Assert.Equal(server.WhipDiminishWindowTicks, mine.WhipDiminishWindowTicks);
            Assert.Equal(server.SpurtDistanceM, mine.SpurtDistanceM);
            Assert.Equal(server.DistanceRefM, mine.DistanceRefM);
            Assert.Equal(server.DistanceRefDirtM, mine.DistanceRefDirtM);
            Assert.Equal(server.SpurtDistanceScalePermille, mine.SpurtDistanceScalePermille);
            Assert.Equal(server.DrainTurf, mine.DrainTurf);
            Assert.Equal(server.DrainDirt, mine.DrainDirt);
            Assert.Equal(server.TargetSenko, mine.TargetSenko);
            Assert.Equal(server.TargetOikomi, mine.TargetOikomi);
            Assert.Equal(server.Skills, mine.Skills);
            Assert.True(mine.Skills);
            Assert.Equal(1000, RaceAdvice.Rules(TestUtil.Ruleset()).DrainTurf[1]);
        }

        [Fact]
        public void TheGoingSpecialistNumberIsTheEngines()
        {
            string[] wire = { "firm", "good", "yielding", "soft" };
            Going[] engine = { Going.FirmOrFast, Going.Good, Going.YieldingOrMuddy, Going.SoftOrSloppy };
            string[] apts = { "any", "fast", "heavy" };
            GoingAptitude[] eApts = { GoingAptitude.Any, GoingAptitude.Fast, GoingAptitude.Heavy };
            for (int g = 0; g < 4; g++)
                for (int a = 0; a < 3; a++)
                    foreach (int max in new[] { 0, 7, 8 })
                        Assert.Equal(RaceSim.GoingSpecialistPermille(eApts[a], engine[g], max), RaceAdvice.GoingSpecialistPermille(apts[a], wire[g], max));
        }

        [Fact]
        public void SameInputSameOutputAndTheFocusOnlyChangesTheTips()
        {
            var c = Vectors().Get("cases")[3]; // minato soft 2400, focus on the nige horse
            var input = AdviceInput.Parse(c.Get("input"));
            var a = RaceAdvice.Compute(input).ToJson().ToString();
            Assert.Equal(a, RaceAdvice.Compute(input).ToJson().ToString());
            var other = RaceAdvice.Compute(input.WithFocus("h2"));
            var first = RaceAdvice.Compute(input);
            Assert.Equal(first.SuggestedHorseId, other.SuggestedHorseId);
            Assert.Equal("h2", other.FocusHorseId);
            Assert.Contains(first.Lines, l => l.Kind == "rein");
            Assert.DoesNotContain(other.Lines, l => l.Kind == "rein"); // the senko horse has temper 600
        }

        [Fact]
        public void NoAdviceTextUsesABannedWord()
        {
            var names = new HashSet<string>();
            foreach (var c in Vectors().Get("cases").Items) foreach (var h in c.Get("input").Get("horses").Items) names.Add(h.Get("name").AsString());
            foreach (var c in Vectors().Get("cases").Items)
            {
                var r = RaceAdvice.Compute(AdviceInput.Parse(c.Get("input")));
                var texts = new List<string>();
                foreach (var l in r.Lines) texts.Add(l.Text);
                foreach (var h in r.Horses) foreach (var k in h.Checks) texts.Add(k.Text);
                foreach (var t in texts)
                {
                    var s = t;
                    foreach (var n in names) s = s.Replace(n, "");
                    foreach (var w in RaceAdvice.BannedJa) Assert.False(s.Contains(w), "\"" + w + "\" in " + t);
                }
            }
        }

        [Fact]
        public void TheTutorialIsFixed()
        {
            var t = RaceAdvice.Compute(new AdviceInput { Mode = "tutorial", Rules = new AdviceRules() });
            Assert.True(t.Tutorial);
            Assert.Empty(t.Horses);
            Assert.Null(t.SuggestedHorseId);
            Assert.Equal(new[] { "合図が出たら、ムチ", "ムチは間隔をあけて打つと伸びる" }, t.Lines.ConvertAll(l => l.Text).ToArray());
        }

        [Fact]
        public void TheWhipCheckComparesTheFirstWhipWithTheTip()
        {
            var tip = new AdviceWhipTip { StartRemainingM = 400, SpurtM = 700, IntervalTicks = 20, Count = 6 };
            RaceDebriefRecorder Rec(params long[] remainingM)
            {
                var r = new RaceDebriefRecorder(0);
                foreach (var m in remainingM) r.WhipRemainingMm.Add(m * 1000);
                return r;
            }
            Assert.Equal(WhipTipVerdict.NoWhip, RaceAdvice.CheckWhipTip(tip, Rec()));
            Assert.Equal(WhipTipVerdict.Followed, RaceAdvice.CheckWhipTip(tip, Rec(420, 380, 300)));
            Assert.Equal(WhipTipVerdict.Followed, RaceAdvice.CheckWhipTip(tip, Rec(260)));
            Assert.Equal(WhipTipVerdict.Early, RaceAdvice.CheckWhipTip(tip, Rec(600, 400)));
            Assert.Equal(WhipTipVerdict.Late, RaceAdvice.CheckWhipTip(tip, Rec(120)));
            Assert.Equal("ムチはアドバイスどおり残り400mから", RaceAdvice.WhipTipText(WhipTipVerdict.Followed, tip));
            Assert.Equal("ムチがアドバイス（残り400m）より早かった", RaceAdvice.WhipTipText(WhipTipVerdict.Early, tip));
        }

        [Fact]
        public void TheWhipTipLinesTranslate()
        {
            var cat = new LocaleCatalog();
            cat.Add(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "engine", "Muchi.Client", "Resources", "Muchi", "ui-en.json")));
            var tip = new AdviceWhipTip { StartRemainingM = 400 };
            foreach (WhipTipVerdict v in Enum.GetValues(typeof(WhipTipVerdict)))
            {
                var ja = RaceAdvice.WhipTipText(v, tip);
                var en = cat.Translate(ja);
                Assert.True(en != null, "no English for " + ja);
                Assert.False(Loc.HasJapanese(en), en);
            }
        }

        [Fact]
        public void ServerAdviceTextsTranslateWithTheGeneratedServerTable()
        {
            var cat = new LocaleCatalog();
            cat.Add(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "engine", "Muchi.Client", "Resources", "Muchi", "server-en.json")));
            foreach (var c in Vectors().Get("cases").Items)
            {
                var r = RaceAdvice.Compute(AdviceInput.Parse(c.Get("input")));
                foreach (var l in r.Lines)
                {
                    var en = cat.Translate(l.Text);
                    Assert.True(en != null, "no English for " + l.Text);
                }
            }
        }

        [Fact]
        public void TheCourseComesFromTheEngineTrack()
        {
            var straight = RaceAdvice.Course(TestUtil.StraightTrack(1200), "firm", false);
            Assert.Equal(0, straight.Corners);
            Assert.Equal(1200, straight.FinalStraightM);
            Assert.False(RaceAdvice.SkillFiresOn("cornerRail", straight));
            Assert.True(RaceAdvice.SkillFiresOn("finalStraight", straight));
            var corner = RaceAdvice.Course(TestUtil.CornerTrack(1200), null, false);
            Assert.True(corner.Corners > 0);
            Assert.Equal("good", corner.Going);
        }
    }

    /// <summary>REQ-ADV-005/011: GET /v1/races/advice and the KPI events on the wire.</summary>
    public class ApiClientRaceAdviceTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientRaceAdviceTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        [Fact]
        public async Task TheQueryAndTheResponseIncludingTheInputForRecomputing()
        {
            var c = JsonNode.Parse(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "contracts", "race-advice.vectors.json"))).Get("cases")[0];
            var body = c.Get("output");
            body.Set("context", "friend");
            body.Set("input", c.Get("input"));
            _http.Reply(200, body.ToString());
            var r = await _api.GetRaceAdviceAsync(new RaceAdviceQuery { Context = "friend", TrackId = "kirameki_turf_2000", Going = "good", Night = false, HorseId = "h1", Field = new List<string> { "nige", "sashi" } });
            Assert.Equal("/v1/races/advice?context=friend&trackId=kirameki_turf_2000&going=good&night=0&horseId=h1&field=nige,sashi", _http.Requests[0].Path);
            Assert.Equal("friend", r.Context);
            Assert.Equal("h1", r.SuggestedHorseId);
            Assert.Equal("stats", r.SuggestReason);
            Assert.Equal(3, r.Horses.Count);
            Assert.Equal(400, r.Whip.StartRemainingM);
            Assert.NotNull(r.Input);
            // the device recomputes for another horse and agrees with what the server would say
            var again = RaceAdvice.Compute(r.Input);
            Assert.Equal(r.Lines.Count, again.Lines.Count);
            for (int i = 0; i < r.Lines.Count; i++) Assert.Equal(r.Lines[i].Text, again.Lines[i].Text);
        }

        [Fact]
        public void AdviceKpiEvents()
        {
            var v = AnalyticsEvent.AdviceView(1, "challenge", 3, true);
            Assert.Equal("advice_view", v.Name);
            Assert.Equal("advice_follow", AnalyticsEvent.AdviceFollow(1, "ranked", false).Name);
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.AdviceView(1, "shop", 1, true));
            Assert.Throws<ArgumentOutOfRangeException>(() => AnalyticsEvent.AdviceView(1, "ranked", 31, true));
        }
    }
}
