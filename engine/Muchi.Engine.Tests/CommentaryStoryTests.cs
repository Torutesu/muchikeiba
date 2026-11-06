using Muchi.Client;
using Muchi.Engine;
using Muchi.Verifier;

namespace Muchi.Engine.Tests
{
    /// <summary>AI実況の多様化 (REQ-COMM-002..004): venue lines, mode tone, mid-race ground call and race-story lines.</summary>
    public class CommentaryStoryTests
    {
        private static readonly CommentaryTemplates T = CommentaryTests.Templates();

        private static List<TrackSpec> ServerTracks()
            => BalanceHarness.LoadServerTracks(Path.Combine(TestUtil.RepoRoot, "server", "master", "tracks.json"));

        private static List<string> ServerVenues()
        {
            var v = Muchi.Net.JsonNode.Parse(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "master", "visuals.json")));
            return v.Get("venues").Props.Select(kv => kv.Key).ToList();
        }

        private static (RaceSim sim, Commentator c, int[] rankAtSpurt) Run(ulong seed, TrackSpec track, RaceMode mode = RaceMode.Ranked, CommentaryTemplates t = null, int field = 12)
        {
            var hr = new Pcg32(seed, 5);
            var horses = Enumerable.Range(0, field).Select(i => SampleRaces.RandomHorse(ref hr, "s" + i)).ToList();
            var cfg = SampleRaces.Config("st_" + seed, seed, track, TestUtil.Ruleset(), horses, 0, 3, mode);
            var sim = new RaceSim(cfg);
            var c = new Commentator(t ?? T, cfg, 0);
            var empty = new byte[field];
            int[] ranks = null;
            int seen = 0;
            while (!sim.IsFinished)
            {
                sim.Step(empty);
                for (; seen < sim.Events.Count; seen++)
                    if (ranks == null && sim.Events[seen].Type == RaceEventType.SpurtStart)
                        ranks = Enumerable.Range(0, field).Select(i => sim.GetHorse(i).Rank).ToArray();
                c.Process(sim);
            }
            return (sim, c, ranks);
        }

        private static void AssertWellFormed(RaceSim sim, Commentator c)
        {
            var lines = c.Lines;
            for (int i = 1; i < lines.Count; i++)
                Assert.True(lines[i].Tick >= lines[i - 1].Tick + lines[i - 1].DurationTicks, lines[i - 1] + " overlaps " + lines[i]);
            Assert.Single(lines, l => l.Kind == "gate_open");
            Assert.Single(lines, l => l.Kind == "spurt");
            var win = Assert.Single(lines, l => Commentator.IsWinKind(l.Kind));
            Assert.Equal(sim.Result.Order[0], win.Slot);
            Assert.Single(lines, l => l.Kind == "result");
            var clips = T.AllFixedClips();
            foreach (var l in lines)
            {
                Assert.DoesNotContain("{", l.Text);
                foreach (var k in l.ClipKeys)
                    if (!k.StartsWith("name:", StringComparison.Ordinal) && !k.StartsWith("num:", StringComparison.Ordinal)) Assert.True(clips.ContainsKey(k), k);
            }
        }

        [Fact]
        public void ShippedTemplatesCoverEveryVenueGoingModeAndStoryKind()
        {
            foreach (var k in CommentaryTemplates.StoryKinds) Assert.True(T.Phrases.ContainsKey(k), k);
            var venues = ServerVenues();
            Assert.Contains("nordhaven", venues);
            Assert.Contains("santalucera", venues);
            Assert.Contains("bellmoor", venues);
            foreach (var v in venues)
            {
                Assert.True(T.Phrases.ContainsKey("spurt@" + v), "spurt@" + v);
                Assert.True(T.Phrases["spurt@" + v].Variants.Count >= 2, v);
            }
            // every track maps to a listed venue by its id prefix (the commentary's venue lookup)
            foreach (var tr in ServerTracks()) Assert.Contains(Commentator.VenueOf(tr), venues);
            foreach (var g in new[] { "turf_firm", "turf_yielding", "turf_soft", "dirt_fast", "dirt_muddy", "dirt_sloppy" })
                Assert.True(T.Phrases.ContainsKey("going_call_" + g), g);
            foreach (var m in new[] { "tutorial", "ranked", "event" }) Assert.True(T.Phrases.ContainsKey("gate_open@" + m), m);
            Assert.True(T.Phrases["photo_finish"].MustSay && T.Phrases["comeback_win"].MustSay && T.Phrases["wire_win"].MustSay);
            Assert.False(T.Phrases["duel"].MustSay);
            // a specialised phrase must keep its base kind's key-moment rule and must have a base kind
            Assert.Throws<FormatException>(() => CommentaryTemplates.Parse(WithExtra("\"spurt@x\": { \"priority\": 90, \"variants\": [ { \"id\": \"sx\", \"text\": \"直線\" } ] }")));
            Assert.Throws<FormatException>(() => CommentaryTemplates.Parse(WithExtra("\"nope@x\": { \"priority\": 90, \"variants\": [ { \"id\": \"nx\", \"text\": \"x\" } ] }")));
        }

        private static string WithExtra(string phrase)
        {
            string json = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "engine", "Muchi.Client", "Resources", "Muchi", "commentary-ja.json"));
            int i = json.IndexOf("\"phrases\": {", StringComparison.Ordinal) + "\"phrases\": {".Length;
            return json.Substring(0, i) + phrase + "," + json.Substring(i);
        }

        [Fact]
        public void EveryServerCourseGetsItsVenueLinesAndAWellFormedCall()
        {
            foreach (var track in ServerTracks())
            {
                var (sim, c, _) = Run(11, track);
                AssertWellFormed(sim, c);
                var spurt = c.Lines.Single(l => l.Kind == "spurt");
                Assert.Equal("spurt@" + Commentator.VenueOf(track), spurt.PhraseKey);
                Assert.StartsWith("spurt_" + Commentator.VenueOf(track) + "_", spurt.VariantId);
            }
        }

        [Fact]
        public void ToneFollowsTheRaceMode()
        {
            var track = ServerTracks().First(t => t.Id == "kirameki_turf_2000");
            Assert.Equal("gate_open@tutorial", Run(3, track, RaceMode.Tutorial).c.Lines.Single(l => l.Kind == "gate_open").PhraseKey);
            Assert.Equal("gate_open@ranked", Run(3, track, RaceMode.Ranked).c.Lines.Single(l => l.Kind == "gate_open").PhraseKey);
            Assert.Equal("gate_open", Run(3, track, RaceMode.Friend).c.Lines.Single(l => l.Kind == "gate_open").PhraseKey);
            // mode tone wins over the venue's own lines; the line kind stays the base kind
            var tut = Run(3, track, RaceMode.Tutorial).c;
            Assert.Contains(tut.Lines, l => l.Kind == "focus_whip" && l.PhraseKey == "focus_whip@tutorial");
            Assert.Equal("spurt@kirameki", tut.Lines.Single(l => l.Kind == "spurt").PhraseKey);
        }

        [Fact]
        public void OffGoodGroundReplacesTheFirstPositionCallOnce()
        {
            var soft = SampleRaces.WithGoing(ServerTracks().First(t => t.Id == "nordhaven_turf_2400"), Going.SoftOrSloppy, false);
            var (sim, c, _) = Run(7, soft);
            AssertWellFormed(sim, c);
            var calls = c.Lines.Where(l => l.Kind.StartsWith("going_call_", StringComparison.Ordinal)).ToList();
            var call = Assert.Single(calls);
            Assert.Equal("going_call_turf_soft", call.Kind);
            Assert.Equal(Commentator.GoingCallKind(soft), call.Kind);
            var firstMid = c.Lines.First(l => l.Kind == "position_call" || l.Kind == call.Kind);
            Assert.Same(call, firstMid);
            var good = SampleRaces.WithGoing(ServerTracks().First(t => t.Id == "nordhaven_turf_2400"), Going.Good, false);
            Assert.Null(Commentator.GoingCallKind(good));
            Assert.DoesNotContain(Run(7, good).c.Lines, l => l.Kind.StartsWith("going_call_", StringComparison.Ordinal));
            Assert.Null(Commentator.GoingCallKind(SampleRaces.Turf2000())); // old configs carry no going: no call
        }

        [Fact]
        public void RaceStoryLinesAppearAndAreTrue()
        {
            var seen = new HashSet<string>();
            var tracks = ServerTracks();
            for (ulong seed = 1; seed <= 40; seed++)
            {
                var track = tracks[(int)(seed % (ulong)tracks.Count)];
                var (sim, c, ranks) = Run(seed, track);
                AssertWellFormed(sim, c);
                var r = sim.Result;
                foreach (var l in c.Lines)
                {
                    seen.Add(l.Kind);
                    switch (l.Kind)
                    {
                        case "comeback_win": Assert.True(ranks[l.Slot] >= T.ComebackFromRank, "comeback from rank " + ranks[l.Slot]); break;
                        case "wire_win": Assert.Equal(0, ranks[l.Slot]); break;
                        case "finish_win": Assert.InRange(ranks[l.Slot], 1, T.ComebackFromRank - 1); break;
                        case "photo_finish":
                            Assert.InRange(r.FinishTicks[1] - r.FinishTicks[0], 0, T.PhotoFinishTicks);
                            Assert.Equal(r.Order[1], l.Slot);
                            break;
                        case "duel": Assert.NotEqual(-1, l.Slot); break;
                    }
                }
                // the photo-finish line comes after the winner's line and before the result
                int win = c.Lines.ToList().FindIndex(l => Commentator.IsWinKind(l.Kind));
                int photo = c.Lines.ToList().FindIndex(l => l.Kind == "photo_finish");
                int res = c.Lines.ToList().FindIndex(l => l.Kind == "result");
                if (photo >= 0) Assert.True(win < photo && photo < res);
                // determinism
                Assert.Equal(c.Lines.Select(l => l.Text), Run(seed, track).c.Lines.Select(l => l.Text));
            }
            foreach (var k in new[] { "comeback_win", "wire_win", "finish_win", "photo_finish", "duel" }) Assert.Contains(k, seen);
        }

        [Fact]
        public void OldTemplatesSpeakExactlyAsBefore()
        {
            // a template without the new kinds: no story/going lines, the plain win line, unchanged variant choice
            string json = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "engine", "Muchi.Client", "Resources", "Muchi", "commentary-ja.json"));
            var node = Muchi.Net.JsonNode.Parse(json);
            var full = CommentaryTemplates.Parse(json);
            var old = CommentaryTemplates.Parse(json);
            foreach (var k in old.Phrases.Keys.ToList())
                if (k.Contains('@') || k.StartsWith("going_call_", StringComparison.Ordinal) || CommentaryTemplates.StoryKinds.Contains(k)) old.Phrases.Remove(k);
            var track = ServerTracks().First(t => t.Id == "minato_dirt_1800");
            var a = Run(9, SampleRaces.WithGoing(track, Going.SoftOrSloppy, true), RaceMode.Ranked, old).c.Lines;
            Assert.DoesNotContain(a, l => l.PhraseKey != l.Kind);
            Assert.DoesNotContain(a, l => CommentaryTemplates.StoryKinds.Contains(l.Kind) || l.Kind.StartsWith("going_call_", StringComparison.Ordinal));
            Assert.Contains(a, l => l.Kind == "finish_win");
            // plain kinds pick the same variants with or without the new phrases present
            var b = Run(9, SampleRaces.WithGoing(track, Going.SoftOrSloppy, true), RaceMode.Friend, full).c.Lines;
            var oldFriend = Run(9, SampleRaces.WithGoing(track, Going.SoftOrSloppy, true), RaceMode.Friend, old).c.Lines;
            Assert.Equal(oldFriend.First(l => l.Kind == "gate_open").VariantId, b.First(l => l.Kind == "gate_open").VariantId);
            Assert.NotNull(node);
        }
    }
}
