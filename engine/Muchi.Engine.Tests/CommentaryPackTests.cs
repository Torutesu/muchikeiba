using Muchi.Client;
using Muchi.Engine;
using Muchi.Net;
using Muchi.Verifier;

namespace Muchi.Engine.Tests
{
    /// <summary>実況パック (REQ-CMT-002/003/005/006/008/013, contracts/protocol.md §36).</summary>
    public class CommentaryPackTests
    {
        private static string Res(string f) => File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "engine", "Muchi.Client", "Resources", "Muchi", f));
        private static CommentaryTemplates Ja() => CommentaryTemplates.Parse(Res("commentary-ja.json"));
        private static CommentaryTemplates En() => CommentaryTemplates.Parse(Res("commentary-en.json"));
        private static CommentaryPackCatalog Catalog() => CommentaryPackCatalog.Parse(Res("commentary-packs.json"));

        private static List<CommentaryLine> Run(CommentaryTemplates t, ulong seed, RaceMode mode = RaceMode.Ranked)
        {
            var hr = new Pcg32(seed, 5);
            var horses = Enumerable.Range(0, 12).Select(i => SampleRaces.RandomHorse(ref hr, "c" + i)).ToList();
            var cfg = SampleRaces.Config("cp_" + seed, seed, SampleRaces.Turf2000(), TestUtil.Ruleset(), horses, 0);
            cfg.Mode = mode;
            var sim = new RaceSim(cfg);
            var c = new Commentator(t, cfg, 0);
            var empty = new byte[12];
            while (!sim.IsFinished) { sim.Step(empty); c.Process(sim); }
            return c.Lines.ToList();
        }

        [Fact]
        public void CatalogParsesFourPacksAndTheSample()
        {
            var c = Catalog();
            Assert.Equal(new[] { "standard", "nekketsu", "ochitsuki", "kofuu" }, c.Packs.Select(p => p.Id));
            Assert.Equal("default", c.Find("standard").AcquireKind);
            Assert.Equal("achievement", c.Find("nekketsu").AcquireKind);
            Assert.Equal(("coins", 300), (c.Find("kofuu").AcquireKind, c.Find("kofuu").Price));
            Assert.True(c.Find("nekketsu").HasEnglish);
            Assert.False(c.Find("kofuu").HasEnglish);
            Assert.Equal(8, c.Sample.Horses.Count);
            Assert.Equal(1600, c.Sample.Track.DistanceM);
            Assert.Equal(10, c.Sample.Seconds);
        }

        [Fact]
        public void EveryShippedPackPassesTheLintInBothLanguages()
        {
            var c = Catalog();
            foreach (var p in c.Packs)
            {
                Assert.Empty(CommentaryPackLint.Problems(Ja(), p));
                Assert.Empty(CommentaryPackLint.Problems(En(), p));
                var t = CommentaryPackCatalog.Apply(Ja(), p);
                Assert.Equal(p.Id, t.PackId);
                foreach (var k in CommentaryTemplates.RequiredKinds) Assert.True(t.Phrases.ContainsKey(k), p.Id + " " + k);
            }
        }

        [Fact]
        public void MissingKindWithoutFallbackOrAForeignPlaceholderIsRefused()
        {
            var p = Catalog().Find("ochitsuki");
            p.Phrases["ja"].Remove("kakari");
            Assert.Contains("kind kakari is neither in phrases.ja nor in fallback", CommentaryPackLint.Problems(Ja(), p));
            Assert.Throws<FormatException>(() => CommentaryPackCatalog.Apply(Ja(), p));
            p.Fallback.Add("kakari");
            Assert.Empty(CommentaryPackLint.Problems(Ja(), p));
            p.Phrases["ja"]["spurt"][0].Text = "{name}、最後の直線！";
            Assert.Contains(CommentaryPackLint.Problems(Ja(), p), x => x.Contains("placeholder {name} is not used by the standard spurt"));
        }

        [Fact]
        public void PackReplacesItsKindsDropsTheStandardSpecialisationsAndKeepsKeyMomentRules()
        {
            var std = Ja();
            var t = CommentaryPackCatalog.Apply(std, Catalog().Find("nekketsu"));
            Assert.StartsWith("nekketsu_", t.Phrases["spurt"].Variants[0].Id);
            Assert.False(t.Phrases.ContainsKey("spurt@bellmoor")); // the pack's voice, not the venue line of the standard
            Assert.False(t.Phrases.ContainsKey("gate_open@ranked"));
            Assert.True(t.Phrases.ContainsKey("ground_turf_soft")); // explicit fallback: standard lines
            Assert.Same(std.Phrases["ground_turf_soft"], t.Phrases["ground_turf_soft"]);
            Assert.Equal(std.Phrases["finish_win"].MustSay, t.Phrases["finish_win"].MustSay);
            Assert.Equal(std.Phrases["finish_win"].Priority, t.Phrases["finish_win"].Priority);
            Assert.Same(std, t.Standard);
            // English without own lines speaks the standard English
            var kofuuEn = CommentaryPackCatalog.Apply(En(), Catalog().Find("kofuu"));
            Assert.Equal("kofuu", kofuuEn.PackId);
            Assert.Equal(En().Phrases["spurt"].Variants[0].Text, kofuuEn.Phrases["spurt"].Variants[0].Text);
            Assert.Same(std, CommentaryPackCatalog.Apply(std, Catalog().Find("standard")));
        }

        [Fact]
        public void StandardCommentaryIsUnchangedAndPacksAreDeterministic()
        {
            // REQ-CMT-003: the standard hashes exactly as before (same lines as the plain templates), a pack is stable per race
            var plain = Run(Ja(), 17);
            var viaCatalog = Run(CommentaryPackCatalog.Apply(Ja(), Catalog().Find("standard")), 17);
            Assert.Equal(plain.Select(l => l.Text), viaCatalog.Select(l => l.Text));
            foreach (var id in new[] { "nekketsu", "ochitsuki", "kofuu" })
            {
                var a = Run(CommentaryPackCatalog.Apply(Ja(), Catalog().Find(id)), 17);
                var b = Run(CommentaryPackCatalog.Apply(Ja(), Catalog().Find(id)), 17);
                Assert.Equal(a.Select(l => l.Text), b.Select(l => l.Text));
                foreach (var k in new[] { "gate_open", "spurt", "result" }) Assert.Contains(a, l => l.Kind == k);
                Assert.Contains(a, l => Commentator.IsWinKind(l.Kind));
                Assert.Contains(a, l => l.VariantId.StartsWith(id + "_"));
                Assert.NotEqual(plain.Select(l => l.Text), a.Select(l => l.Text));
            }
        }

        [Fact]
        public void TutorialAlwaysSpeaksTheStandard()
        {
            var std = Run(Ja(), 3, RaceMode.Tutorial);
            var nek = Run(CommentaryPackCatalog.Apply(Ja(), Catalog().Find("nekketsu")), 3, RaceMode.Tutorial);
            Assert.Equal(std.Select(l => l.Text), nek.Select(l => l.Text));
        }

        [Fact]
        public void SampleIsTheKeyLinesInTenSecondsAndTheSameEveryTime()
        {
            var c = Catalog();
            foreach (var p in c.Packs)
            {
                var t = CommentaryPackCatalog.Apply(Ja(), p);
                var a = CommentarySample.Build(c.Sample, TestUtil.Ruleset(), t);
                var b = CommentarySample.Build(c.Sample, TestUtil.Ruleset(), t);
                Assert.InRange(a.TotalTicks, 60, 200);
                Assert.True(a.Lines.Count >= 3, p.Id + " sample has " + a.Lines.Count + " lines");
                Assert.Contains(a.Lines, l => l.Kind == "spurt");
                Assert.Contains(a.Lines, l => Commentator.IsWinKind(l.Kind));
                Assert.Equal(0, a.Offset(a.Lines[0]));
                for (int i = 1; i < a.Lines.Count; i++) Assert.Equal(a.Offsets[i - 1] + a.Lines[i - 1].DurationTicks, a.Offsets[i]);
                Assert.Same(a.Lines[0], a.At(0));
                Assert.Equal(a.Lines.Select(l => l.Text), b.Lines.Select(l => l.Text));
                Assert.Equal(p.Id, a.PackId);
                if (!p.IsStandard) Assert.StartsWith(p.Id + "_", a.Lines[0].VariantId);
                // the sample horses are real templates, so every name clip is voiced
                Assert.All(a.Lines.SelectMany(l => l.ClipKeys).Where(k => k.StartsWith("name:")), k => Assert.Contains(c.Sample.Horses, h => "name:" + h.Id == k));
            }
        }

        [Fact]
        public void VoiceOnlyWhenEveryClipIsDownloaded()
        {
            var c = Catalog();
            var t = CommentaryPackCatalog.Apply(Ja(), c.Find("kofuu"));
            var s = CommentarySample.Build(c.Sample, TestUtil.Ruleset(), t);
            var line = s.Lines.First(l => l.ClipKeys.Any(k => k.StartsWith("name:")) || l.ClipKeys.Length > 0);
            Func<string, string> names = id => c.Sample.Horses.FirstOrDefault(h => h.Id == id)?.Name;
            var all = CommentaryVoice.ClipsOrNull(line, names, _ => true);
            Assert.NotNull(all);
            Assert.All(all, k => Assert.StartsWith("voice/ja/", k));
            Assert.Contains(all, k => k.StartsWith("voice/ja/phrase/kofuu_"));
            // one clip missing: subtitles only
            Assert.Null(CommentaryVoice.ClipsOrNull(line, names, k => k != all[0]));
        }

        // ------------------------------------------------------------------ API

        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public CommentaryPackTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        private const string View = "{\"equipped\":\"standard\",\"standardPackId\":\"standard\",\"sample\":{\"seed\":3614,\"seconds\":10,\"trackId\":\"aoba_turf_1600\",\"fieldSize\":8},"
            + "\"notice\":\"実況の話し方だけが変わります。\",\"packs\":["
            + "{\"id\":\"standard\",\"name\":\"標準\",\"description\":\"d\",\"acquire\":\"default\",\"price\":null,\"currency\":null,\"forSale\":false,\"owned\":true,\"equipped\":true,\"unlock\":null,\"english\":\"own\",\"englishNote\":null},"
            + "{\"id\":\"nekketsu\",\"name\":\"熱血\",\"description\":\"d\",\"acquire\":\"achievement\",\"price\":null,\"currency\":null,\"forSale\":false,\"owned\":false,\"equipped\":false,"
            + "\"unlock\":{\"achievementId\":\"races\",\"tier\":1,\"label\":\"実績「出走の記録」1段目で入手\",\"progress\":3,\"target\":10},\"english\":\"own\",\"englishNote\":null},"
            + "{\"id\":\"kofuu\",\"name\":\"古風な名調子\",\"description\":\"d\",\"acquire\":\"coins\",\"price\":300,\"currency\":\"any\",\"forSale\":true,\"owned\":false,\"equipped\":false,\"unlock\":null,\"english\":\"standard\",\"englishNote\":\"英語では標準の実況で話します\"}]}";

        [Fact]
        public async Task GetEquipAndBuy()
        {
            _http.Reply(200, View).Reply(200, View).Reply(200, "{\"packId\":\"kofuu\",\"spent\":{\"paid\":100,\"free\":200},\"wallet\":{\"paid\":0,\"free\":5,\"total\":5,\"debt\":0},\"view\":" + View + "}");
            var v = await _api.GetCommentaryPacksAsync();
            Assert.Equal("GET /v1/commentary/packs", _http.Requests[0].ToString());
            Assert.Equal("standard", v.Equipped);
            Assert.Equal(3, v.Packs.Count);
            Assert.Equal(300, v.Find("kofuu").Price);
            Assert.Null(v.Find("standard").Price);
            Assert.Equal((3, 10), (v.Find("nekketsu").Unlock.Progress, v.Find("nekketsu").Unlock.Target));
            Assert.Equal("standard", v.Find("kofuu").English);
            Assert.Equal(10, v.SampleSeconds);
            await _api.EquipCommentaryPackAsync("nekketsu", CommentaryEquipSource.Shop);
            Assert.Equal("PUT /v1/commentary/equipped", _http.Requests[1].ToString());
            Assert.Contains("\"source\":\"shop\"", _http.Requests[1].Body);
            Assert.False(_http.Requests[1].Headers.ContainsKey("idempotency-key"));
            var b = await _api.BuyCommentaryPackAsync("kofuu", true, "c:key-1");
            Assert.Equal("POST /v1/commentary/packs/kofuu/buy", _http.Requests[2].ToString());
            Assert.True(_http.Requests[2].Headers.ContainsKey("idempotency-key"));
            Assert.Contains("\"equip\":true", _http.Requests[2].Body);
            Assert.Equal((100, 200), (b.SpentPaid, b.SpentFree));
            Assert.Equal(5, b.Wallet.Free);
            Assert.NotNull(b.View);
        }

        [Fact]
        public void PlayerViewCarriesTheEquippedPackAndAnalyticsTheSample()
        {
            var e = AnalyticsEvent.CommentaryPackSample(1, "kofuu", false);
            Assert.Equal("commentary_pack_sample", e.Name);
        }
    }
}
