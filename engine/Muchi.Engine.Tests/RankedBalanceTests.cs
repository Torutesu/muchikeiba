using System.Globalization;
using Muchi.Verifier;

namespace Muchi.Engine.Tests
{
    /// <summary>
    /// Quality pass 2 (docs/quality/ranked.md, docs/spec/balance-targets.md §2.5): ranked is winnable through skill in every
    /// class, on the fields the server really issues (contracts/ranked-fields.sample.json: matchmaker CPU fill, class cap,
    /// course draw, the day's going — server/src/domain/rankedSample.ts; a server test fails while it is stale). Every rider
    /// rides the same fields, fixed seeds: the numbers are exact and reproducible (≈20 s for both rulesets).
    /// </summary>
    public class RankedBalanceTests
    {
        private readonly Xunit.Abstractions.ITestOutputHelper _out;
        public RankedBalanceTests(Xunit.Abstractions.ITestOutputHelper output) { _out = output; }

        private static string Sample => Path.Combine(TestUtil.RepoRoot, "contracts", "ranked-fields.sample.json");
        private static string Vectors => Path.Combine(TestUtil.RepoRoot, "contracts", "ranked-places.vectors.json");
        private static RulesetParams Tactics => Muchi.Net.ProtocolCodec.ParseRuleset(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "contracts", "ruleset-params.1.4.0.json")));

        private static string Pct(double v) => (v * 100).ToString("F1", CultureInfo.InvariantCulture) + "%";

        [Fact]
        public void AfterARankedLossTheResultSaysHorseOrRiding()
        {
            // the partner as given in S (3,320 against the S field 3,600): the horse; at its cap in C: the riding
            var sets = RankedHarness.Load(Sample);
            var s = sets.Single(x => x.Key == "S/starter/regular").Races[0];
            var weak = Muchi.Client.RankedFieldCheck.For(s.Config, s.Slot, 5);
            Assert.NotNull(weak);
            Assert.True(weak.HorseWeaker);
            Assert.Equal(3320, weak.HorseTotal);
            Assert.StartsWith("能力の差：相棒 3320 ／ この場のCPU ", weak.Line);
            var c = sets.Single(x => x.Key == "C/day30/regular").Races[0];
            var even = Muchi.Client.RankedFieldCheck.For(c.Config, c.Slot, 4);
            Assert.False(even.HorseWeaker);
            Assert.EndsWith("：差は乗り方", even.Line);
            // a win, another mode or no CPU: nothing to say
            Assert.Null(Muchi.Client.RankedFieldCheck.For(c.Config, c.Slot, 1));
            // English for both lines (ui-en.json templates)
            var loc = new Muchi.Client.LocaleCatalog();
            loc.Add(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "engine", "Muchi.Client", "Resources", "Muchi", "ui-en.json")));
            Assert.Equal("Stats gap: your horse 3320 / the CPU field " + weak.FieldTotal + ". Training closes it", loc.Translate(weak.Line));
            Assert.StartsWith("Stats even or better (yours ", loc.Translate(even.Line));
        }

        [Fact]
        public void RankedFieldsMeetTheWinnabilityTargets()
        {
            var sets13 = RankedHarness.Load(Sample);
            var cells = RankedHarness.RunAll(sets13);
            var cells14 = RankedHarness.RunAll(RankedHarness.Load(Sample, Tactics));
            _out.WriteLine("ruleset 1.3.0 (ranked today)\n" + RankedHarness.Markdown(cells));
            _out.WriteLine("ruleset 1.4.0 (ranked after the rollout)\n" + RankedHarness.Markdown(cells14));

            // W9 (REQ-MM-008): the course always fits the player's horse
            foreach (var s in sets13) Assert.All(s.Races, r => Assert.False(r.PlayerOffAptitude, s.Key + " " + r.Config.RaceId + " on " + r.Config.Track.Id));

            var fails = new List<string>();
            foreach (var (rs, list) in new[] { ("1.3.0", cells), ("1.4.0", cells14) })
            {
                RankedCell C(string set, string rider) => list.Single(c => c.SetKey == set && c.Rider == rider);
                void Check(bool ok, string id, string what) { if (!ok) fails.Add(rs + " " + id + ": " + what); }
                string[] classes = { "C", "B", "A", "S" };

                foreach (var cls in classes)
                {
                    // W1: a skilled rider on a fairly raised horse wins clearly more than the fair share (1 in 12) — at least 1 in 6 —
                    // in every class, but never every race
                    var sk = C(cls + "/day30/regular", "skilled");
                    Check(sk.Win >= 1.0 / 6 && sk.Win <= 0.70, "W1", cls + " skilled day30 win " + Pct(sk.Win) + " (16.7%..70%)");
                    // W3: an average rider on a raised horse finishes in the top 3 reasonably often (about the fair share or better)
                    var av = C(cls + "/day30/regular", "average");
                    Check(av.Top3Rate >= 0.20, "W3", cls + " average day30 top-3 " + Pct(av.Top3Rate) + " (≥20%)");
                }
                foreach (var cls in new[] { "C", "B" })
                {
                    // W2: in C and B (the classes the partner is made for: it is at the cap) the partner as given is enough to win
                    var sk = C(cls + "/starter/regular", "skilled");
                    Check(sk.Win >= 1.0 / 6, "W2", cls + " skilled starter win " + Pct(sk.Win) + " (≥16.7%)");
                    var av = C(cls + "/starter/regular", "average");
                    Check(av.Top3Rate >= 0.20, "W3", cls + " average starter top-3 " + Pct(av.Top3Rate) + " (≥20%)");
                }
                foreach (var key in list.Select(c => c.SetKey).Distinct().Where(k => !k.EndsWith("/beginner")))
                {
                    var sk = C(key, "skilled"); var av = C(key, "average"); var ma = C(key, "masher");
                    // W4: skill decides — skilled clearly ahead of average (1.5× the wins and +5 pt at least), average ahead of
                    // mashing. Not asserted for the partner as given in A and S: it is far under those classes' fields (3,320
                    // against 3,500 / 3,600), so nobody wins much there and the gap is noise — that is the horse's lesson (§4)
                    bool outgrown = key == "A/starter/regular" || key == "S/starter/regular";
                    if (!outgrown)
                        Check(sk.Win >= Math.Max(av.Win * 1.5, av.Win + 0.05) && sk.Top3Rate > av.Top3Rate, "W4", key + " skilled " + Pct(sk.Win) + "/" + Pct(sk.Top3Rate) + " vs average " + Pct(av.Win) + "/" + Pct(av.Top3Rate));
                    Check(av.Top3Rate > ma.Top3Rate && av.AvgPlace < ma.AvgPlace, "W4", key + " average top-3 " + Pct(av.Top3Rate) + " vs masher " + Pct(ma.Top3Rate));
                    // W5: mashing the button does not win
                    Check(ma.Win <= 0.10, "W5", key + " masher win " + Pct(ma.Win) + " (≤10%)");
                }
                // W6: no cliff after the beginner matches — the ramp sits between the beginner matches and the regular field
                var beg = C("C/starter/beginner", "average"); var ramp = C("C/starter/ramp", "average"); var reg = C("C/starter/regular", "average");
                Check(ramp.Top3Rate >= 0.35 && ramp.Top3Rate <= beg.Top3Rate && ramp.Top3Rate >= reg.Top3Rate, "W6", "average top-3 beginner " + Pct(beg.Top3Rate) + " → ramp " + Pct(ramp.Top3Rate) + " → regular " + Pct(reg.Top3Rate));
                // W7 (= R10/R10b, REQ-UXS-003): a beginner in the beginner matches is usually top 3, in a close race
                Check(beg.Top3Rate >= 0.70 && beg.Win <= 0.60, "W7", "beginner match average top-3 " + Pct(beg.Top3Rate) + " (≥70%), win " + Pct(beg.Win) + " (≤60%)");
                // W8: in C (where a free player spends the first month) an average rider's ranked coins stay near the economy sim's
                // uniform places — the E1 check with these very places is server/test/economy.test.ts
                foreach (var h in new[] { "starter", "day30" })
                {
                    var c = C("C/" + h + "/regular", "average");
                    Check(c.CoinsVsUniform <= 1.40, "W8", "C " + h + " average coins ÷ uniform " + c.CoinsVsUniform.ToString("F2", CultureInfo.InvariantCulture) + " (≤1.40)");
                }
            }
            Assert.True(fails.Count == 0, "ranked targets missed:\n" + string.Join("\n", fails));

            // the place counts the economy test replays are these very cells (npm run is not needed: the harness writes them)
            var all = new List<RankedCell>(cells);
            all.AddRange(cells14);
            Assert.Equal(RankedHarness.Vectors(all), File.ReadAllText(Vectors).Replace("\r\n", "\n"));
        }
    }
}
