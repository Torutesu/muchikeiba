using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-HGOAL-001..016: 馬ごとの目標 — the shared chain rules (contracts/horse-goals.vectors.json) and the client API (protocol §53).</summary>
    [Collection("Loc")] // EveryGoalTextHasEnglish switches the process-wide Loc
    public class HorseGoalsTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public HorseGoalsTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        private static JsonNode Get(JsonNode o, string k) { Assert.True(o.TryGet(k, out var x), k); return x; }

        [Fact]
        public void ChainAndProgressMatchTheServerVectors()
        {
            var v = JsonNode.Parse(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "contracts", "horse-goals.vectors.json")));
            var tracks = Get(v, "tracks").Items.Select(HorseGoalTrack.Parse).ToList();
            int n = 0;
            foreach (var c in Get(v, "cases").Items)
            {
                string name = Get(c, "name").AsString();
                var stamped = new Dictionary<string, long>();
                foreach (var kv in Get(c, "stamped").Props) stamped[kv.Key] = kv.Value.AsLong();
                var got = HorseGoalChain.Evaluate(HorseGoalChain.Build(HorseGoalHorse.Parse(Get(c, "horse")), tracks), HorseGoalRecord.Parse(Get(c, "record")), stamped);
                var expect = Get(c, "expect").Items.Select(HorseGoal.Parse).ToList();
                Assert.True(expect.Count == got.Count, name);
                for (int i = 0; i < expect.Count; i++)
                {
                    var e = expect[i]; var g = got[i];
                    Assert.True(e.Id == g.Id && e.Kind == g.Kind && e.Text == g.Text && e.Need == g.Need && e.Have == g.Have && e.Done == g.Done
                        && e.Current == g.Current && e.CompletedAt == g.CompletedAt, name + " #" + i + " " + e.Id + " vs " + g.Id);
                    Assert.True(e.Params.OrderBy(x => x.Key).SequenceEqual(g.Params.OrderBy(x => x.Key)), name + " params " + e.Id);
                }
                n++;
            }
            Assert.True(n >= 40);
        }

        [Fact]
        public void EveryGoalTextHasEnglish()
        {
            Loc.LoadEnglish(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "engine", "Muchi.Client", "Resources", "Muchi", "server-en.json")));
            var tracks = new List<HorseGoalTrack>
            {
                new HorseGoalTrack { Id = "aoba_turf_1600", Name = "青葉競馬場 芝1600m", Surface = "turf", DistanceM = 1600 },
                new HorseGoalTrack { Id = "aoba_dirt_1400", Name = "青葉競馬場 ダート1400m", Surface = "dirt", DistanceM = 1400 },
                new HorseGoalTrack { Id = "minato_turf_2400", Name = "みなと競馬場 芝2400m", Surface = "turf", DistanceM = 2400 },
            };
            var texts = new HashSet<string>();
            foreach (var s in new[] { "turf", "dirt", "both" })
                foreach (var st in new[] { "nige", "sashi" })
                    foreach (var g in HorseGoalChain.Build(new HorseGoalHorse { Surface = s, DistMinM = 1500, DistMaxM = 1900, Style = st, SkillId = "sk" }, tracks)) texts.Add(g.Text);
            Loc.SetLocale("en");
            try
            {
                foreach (var t in texts) Assert.False(Loc.HasJapanese(Loc.T(t)), t + " → " + Loc.T(t));
                Assert.Equal("Win 3 races on turf", Loc.T("芝で3勝する"));
            }
            finally { Loc.SetLocale("ja"); }
        }

        private const string ViewJson = "{\"v\":1,\"horseId\":\"h7\",\"horseName\":\"ミドリノカゼ\",\"status\":\"active\",\"pinned\":true,\"goals\":[{\"id\":\"first_win\",\"kind\":\"first_win\",\"params\":{},\"text\":\"初勝利をあげる\",\"have\":1,\"need\":1,\"done\":true,\"completedAt\":1794000000000,\"current\":false},{\"id\":\"races:10\",\"kind\":\"races\",\"params\":{\"n\":10},\"text\":\"10戦を走る\",\"have\":7,\"need\":10,\"done\":false,\"completedAt\":null,\"current\":true}],\"doneCount\":1,\"total\":2,\"chainComplete\":false,\"chainCompletedAt\":null,\"notice\":\"目標は確定したレースの成績だけで進みます。達成の印は見た目だけです。\"}";

        [Fact]
        public async Task GoalsPinAndPinned()
        {
            _http.Reply(200, ViewJson);
            var v = await _api.GetHorseGoalsAsync("h7");
            Assert.Equal("/v1/horses/h7/goals", _http.Requests[0].Path);
            Assert.Equal("ミドリノカゼ", v.HorseName);
            Assert.Equal("races:10", v.Current.Id);
            Assert.Equal(3, v.Current.Left);
            Assert.Equal("10", v.Current.Params["n"]);
            Assert.True(v.Pinned);

            _http.Reply(200, "{\"pinned\":{\"horseId\":\"h7\",\"horseName\":\"ミドリノカゼ\",\"goal\":{\"id\":\"races:10\",\"kind\":\"races\",\"params\":{\"n\":10},\"text\":\"10戦を走る\",\"have\":7,\"need\":10,\"done\":false,\"completedAt\":null,\"current\":true},\"doneCount\":1,\"total\":7}}");
            var p = await _api.PinHorseGoalAsync("h7");
            Assert.Equal("PUT", _http.Requests[1].Method);
            Assert.Equal("/v1/horse-goals/pin", _http.Requests[1].Path);
            Assert.Contains("\"horseId\":\"h7\"", _http.Requests[1].Body);
            Assert.Equal(7, p.Total);
            Assert.Equal("races", p.Goal.Kind);

            _http.Reply(200, "{\"pinned\":null}");
            Assert.Null(await _api.PinHorseGoalAsync(null));
            Assert.Contains("\"horseId\":null", _http.Requests[2].Body);
            _http.Reply(200, "{\"pinned\":null}");
            Assert.Null(await _api.GetPinnedHorseGoalAsync());
            Assert.Equal("/v1/horse-goals/pinned", _http.Requests[3].Path);
        }

        [Fact]
        public void ViewEventAndNextKind()
        {
            Assert.Equal("hgoal_view", AnalyticsEvent.HorseGoalView(1, "home", 12).Name);
            Assert.Throws<System.ArgumentException>(() => AnalyticsEvent.HorseGoalView(1, "shop", 0));
            Assert.True(NextKinds.Known("horse_goal_near"));
            Assert.True(NextKinds.Dismissible("horse_goal_near"));
            Assert.False(NextKinds.ChipOnly("horse_goal_near"));
        }
    }
}
