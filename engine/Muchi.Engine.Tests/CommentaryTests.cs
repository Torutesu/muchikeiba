using Muchi.Client;
using Muchi.Engine;
using Muchi.Verifier;

namespace Muchi.Engine.Tests
{
    public class CommentaryTests
    {
        internal static CommentaryTemplates Templates()
            => CommentaryTemplates.Parse(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "engine", "Muchi.Client", "Data", "commentary-ja.json")));

        private static (RaceSim sim, Commentator c) Run(ulong seed, int focus = 0)
        {
            var hr = new Pcg32(seed, 5);
            var horses = Enumerable.Range(0, 12).Select(i => SampleRaces.RandomHorse(ref hr, "c" + i)).ToList();
            var cfg = SampleRaces.Config("cm_" + seed, seed, SampleRaces.Turf2000(), TestUtil.Ruleset(), horses, 0);
            var sim = new RaceSim(cfg);
            var c = new Commentator(Templates(), cfg, focus);
            var empty = new byte[12];
            while (!sim.IsFinished)
            {
                sim.Step(empty);
                c.Process(sim);
            }
            return (sim, c);
        }

        public static IEnumerable<object[]> Seeds() => new[] { 1UL, 2UL, 3UL, 17UL, 99UL, 2026UL }.Select(s => new object[] { s });

        [Fact]
        public void TemplatesParseAndExposeEveryFixedClip()
        {
            var t = Templates();
            foreach (var k in CommentaryTemplates.RequiredKinds) Assert.True(t.Phrases.ContainsKey(k), k);
            var clips = t.AllFixedClips();
            Assert.Contains("gate_open_1#0", clips.Keys);
            Assert.Equal("、出遅れた！", clips["late_start_1#0"]);
            Assert.DoesNotContain(clips.Values, v => v.Contains('{') || v.Contains('}'));
            Assert.Throws<FormatException>(() => CommentaryTemplates.Parse("{\"phrases\":{\"gate_open\":{\"variants\":[{\"id\":\"x\",\"text\":\"{horse}\"}]}}}"));
        }

        [Theory]
        [MemberData(nameof(Seeds))]
        public void LinesNeverOverlap(ulong seed)
        {
            var (_, c) = Run(seed);
            var lines = c.Lines;
            Assert.True(lines.Count >= 6);
            for (int i = 1; i < lines.Count; i++)
                Assert.True(lines[i].Tick >= lines[i - 1].Tick + lines[i - 1].DurationTicks, lines[i - 1] + " overlaps " + lines[i]);
        }

        [Theory]
        [MemberData(nameof(Seeds))]
        public void KeyMomentsAlwaysGetALine(ulong seed)
        {
            var (sim, c) = Run(seed);
            var lines = c.Lines;
            var t = Templates();
            Assert.Single(lines, l => l.Kind == "gate_open");
            Assert.Single(lines, l => l.Kind == "spurt");
            var win = Assert.Single(lines, l => l.Kind == "finish_win");
            Assert.Equal(sim.Result.Order[0], win.Slot);
            var result = Assert.Single(lines, l => l.Kind == "result");
            var names = sim.Result.Order.Take(3).Select(s => sim.Config.Entrants[s].Horse.Name).ToList();
            // whole-name match ("ランダムc1" must not match inside "ランダムc11")
            int Pos(string n) { var m = System.Text.RegularExpressions.Regex.Match(result.Text, System.Text.RegularExpressions.Regex.Escape(n) + "(?![0-9A-Za-z])"); return m.Success ? m.Index : -1; }
            int p0 = Pos(names[0]), p1 = Pos(names[1]), p2 = Pos(names[2]);
            Assert.True(p0 >= 0 && p1 > p0 && p2 > p1, "result line lists the top 3 in order: " + result.Text);
            Assert.True(lines.Last().Kind == "result" || lines.Last().Kind == "finish_win" || lines.Last().Kind == "focus_finish");

            // every leader who held the lead long enough (and differs from the last one announced) is announced, in order
            int firstFinish = sim.Events.First(e => e.Type == RaceEventType.Finish).Tick;
            var changes = sim.Events.Where(e => e.Type == RaceEventType.LeaderChanged && e.Tick < firstFinish).ToList();
            var expected = new List<int>();
            int announced = -1;
            for (int i = 0; i < changes.Count; i++)
            {
                int end = i + 1 < changes.Count ? changes[i + 1].Tick : firstFinish;
                if (end - changes[i].Tick > t.LeaderStableTicks + 1 && changes[i].Slot != announced)
                {
                    expected.Add(changes[i].Slot);
                    announced = changes[i].Slot;
                }
            }
            var said = lines.Where(l => l.Kind == "leader").Select(l => l.Slot).ToList();
            Assert.NotEmpty(expected);
            Assert.Equal(expected, said);
        }

        [Theory]
        [MemberData(nameof(Seeds))]
        public void NamesAreSubstitutedAndClipsResolve(ulong seed)
        {
            var (sim, c) = Run(seed);
            var fixedClips = Templates().AllFixedClips();
            var horseIds = sim.Config.Entrants.Select(e => e.Horse.Id).ToHashSet();
            foreach (var l in c.Lines)
            {
                Assert.DoesNotContain("{", l.Text);
                Assert.NotEmpty(l.ClipKeys);
                foreach (var k in l.ClipKeys)
                {
                    if (k.StartsWith("name:", StringComparison.Ordinal)) Assert.Contains(k.Substring(5), horseIds);
                    else if (k.StartsWith("num:", StringComparison.Ordinal)) Assert.True(int.Parse(k.Substring(4)) >= 1);
                    else Assert.True(fixedClips.ContainsKey(k), k);
                }
                // the clips spell the text: fixed parts + names in order
                string spelled = string.Concat(l.ClipKeys.Select(k =>
                    k.StartsWith("name:", StringComparison.Ordinal) ? sim.Config.Entrants.First(e => e.Horse.Id == k.Substring(5)).Horse.Name
                    : k.StartsWith("num:", StringComparison.Ordinal) ? k.Substring(4) : fixedClips[k]));
                Assert.Equal(l.Text, spelled);
            }
            var leader = c.Lines.First(l => l.Kind == "leader");
            Assert.Contains(sim.Config.Entrants[leader.Slot].Horse.Name, leader.Text);
        }

        [Fact]
        public void VariationIsDeterministicPerSeed()
        {
            var a = Run(5).c.Lines.Select(l => l.Text).ToList();
            var b = Run(5).c.Lines.Select(l => l.Text).ToList();
            Assert.Equal(a, b);
            var variants = Enumerable.Range(1, 6).Select(s => Run((ulong)s).c.Lines.First(l => l.Kind == "gate_open").VariantId).Distinct().Count();
            Assert.True(variants >= 2, "different races pick different variants");
        }

        [Fact]
        public void FocusHorseGetsWhipAndPlaceLines()
        {
            // pick a focus horse that does not win, so its place line is distinct from the winner line
            var (sim0, _) = Run(3, focus: 0);
            int focus = sim0.Result.Order[4];
            var (sim, c) = Run(3, focus);
            Assert.Contains(c.Lines, l => l.Kind == "focus_whip" && l.Slot == focus);
            var place = Assert.Single(c.Lines, l => l.Kind == "focus_finish");
            Assert.Contains("5着", place.Text);
            Assert.Contains("num:5", place.ClipKeys);
        }
    }
}
