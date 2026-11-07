using System.Text.RegularExpressions;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Net;
using Muchi.Verifier;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-L10N-009..012: English on the client — commentary, string tables, names, the request locale.</summary>
    [Collection("Loc")] // Loc is process-wide: these tests switch it
    public class LocalizationTests
    {
        private static string Res(string f) => File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "engine", "Muchi.Client", "Resources", "Muchi", f));
        private static readonly Regex Ph = new Regex(@"\{(\w+)(:ord)?\}");
        private static string Places(string s) => string.Join(",", Ph.Matches(s).Select(m => m.Groups[1].Value).OrderBy(x => x, StringComparer.Ordinal));

        static LocalizationTests()
        {
            Loc.LoadEnglish(Res("server-en.json"));
            Loc.LoadEnglish(Res("ui-en.json"));
        }

        [Fact]
        public void CommentaryEnglishCoversEveryJapanesePhraseAndVariant()
        {
            var ja = CommentaryTemplates.Parse(Res("commentary-ja.json"));
            var en = CommentaryTemplates.Parse(Res("commentary-en.json"));
            Assert.Equal("ja", ja.Language);
            Assert.Equal("en", en.Language);
            Assert.Equal(ja.Phrases.Keys.OrderBy(k => k, StringComparer.Ordinal), en.Phrases.Keys.OrderBy(k => k, StringComparer.Ordinal));
            foreach (var kv in ja.Phrases)
            {
                var e = en.Phrases[kv.Key];
                Assert.Equal(kv.Value.MustSay, e.MustSay);
                Assert.Equal(kv.Value.Priority, e.Priority);
                Assert.Equal(kv.Value.Variants.Select(v => v.Id), e.Variants.Select(v => v.Id));
                for (int i = 0; i < e.Variants.Count; i++)
                {
                    Assert.Equal(Places(kv.Value.Variants[i].Text), Places(e.Variants[i].Text));
                    Assert.False(Loc.HasJapanese(e.Variants[i].Text), e.Variants[i].Id);
                }
            }
            // the English has its own fixed clips to pre-generate with TTS (clip ids follow each language's word order)
            Assert.All(en.AllFixedClips().Values, v => Assert.False(Loc.HasJapanese(v)));
            Assert.True(en.TicksPerChar < ja.TicksPerChar); // English has more characters per second of speech
        }

        [Theory]
        [InlineData(1UL)]
        [InlineData(17UL)]
        [InlineData(2026UL)]
        public void EnglishRaceCommentaryHasNoJapaneseAndSpeaksOrdinals(ulong seed)
        {
            var en = CommentaryTemplates.Parse(Res("commentary-en.json"));
            var hr = new Pcg32(seed, 5);
            var names = new[] { "シンセイアカツキ", "ミドリカワ", "ハヤテノツバサ", "ギンガノカナタ", "ユウヤケボシ", "コハクノヒカリ", "ツキミダンゴ", "サクラフブキ", "アイボウ", "ホーリーベル", "ナミノリタロウ", "シャトルラン" };
            var horses = Enumerable.Range(0, 12).Select(i => { var h = SampleRaces.RandomHorse(ref hr, "h" + i); h.Name = names[i]; return h; }).ToList();
            var cfg = SampleRaces.Config("en_" + seed, seed, SampleRaces.Turf2000(), TestUtil.Ruleset(), horses, 0);
            var sim = new RaceSim(cfg);
            var c = new Commentator(en, cfg, 3);
            var empty = new byte[12];
            while (!sim.IsFinished) { sim.Step(empty); c.Process(sim); }
            Assert.True(c.Lines.Count >= 6);
            foreach (var l in c.Lines) Assert.False(Loc.HasJapanese(l.Text), l.ToString());
            for (int i = 1; i < c.Lines.Count; i++) Assert.True(c.Lines[i].Tick >= c.Lines[i - 1].Tick + c.Lines[i - 1].DurationTicks);
            foreach (var finish in c.Lines.Where(l => l.Kind == "focus_finish")) Assert.Matches(@" (1st|2nd|3rd|\d+th)\.$", finish.Text);
            // master names in English, other katakana names romanized
            Assert.Contains(c.Lines, l => l.Text.Contains("Shinsei Akatsuki") || l.Text.Contains("Midorikawa") || l.Text.Contains("Hayatenotsubasa") || l.Text.Contains("Ginga no Kanata"));
        }

        [Fact]
        public void RomajiForKatakanaNames()
        {
            Assert.Equal("Midorikawa", Romaji.Name("ミドリカワ"));
            Assert.Equal("Hayatenotsubasa", Romaji.Name("ハヤテノツバサ"));
            Assert.Equal("Shattoran", Romaji.Name("シャットラン"));
            Assert.Equal("Chocho", Romaji.Name("チョーチョ"));
            Assert.Equal("Matchi", Romaji.Name("マッチ"));
            Assert.Equal("Fairu Dorobu", Romaji.Name("ファイル・ドロブ"));
            Assert.Equal("Midori", Romaji.Name("Midori"));
            Assert.Equal("ミドリ川", Romaji.Name("ミドリ川"));
            Assert.Equal("1st", Loc.Ordinal(1)); Assert.Equal("2nd", Loc.Ordinal(2)); Assert.Equal("3rd", Loc.Ordinal(3));
            Assert.Equal("11th", Loc.Ordinal(11)); Assert.Equal("12th", Loc.Ordinal(12)); Assert.Equal("22nd", Loc.Ordinal(22));
        }

        [Fact]
        public void TablesTranslateClientTextsWithTemplates()
        {
            var en = Loc.English;
            Assert.Equal("3rd", en.Translate("3着"));
            Assert.Equal("Pity pts 37 / 100 (63 more scouts, 6,300 coins)", en.Translate("交換pt 37 / 100（あと63回・6,300コイン）"));
            Assert.Equal("Used 1,000 paid, 500 free coins", en.Translate("有償 1,000・無償 500 コインを使いました"));
            Assert.Equal("Resets tomorrow 4:00", en.Translate("明日 4:00 に更新"));
            Assert.Equal("Stable Allowance day 3/30, 27 days left (until 12/4), claimed today", en.Translate("厩舎手当 3/30日目・残り27日（12月4日まで）・今日は受取済み"));
            Assert.Equal("Midori won a ranked race!", en.Translate("Midoriさんがランク戦で1着！"));
            Assert.Equal("Midorikawa finished 4th in a ranked race", en.Translate("ミドリカワさんがランク戦で4着"));
            Assert.Equal("Finished half a length behind the winner", en.Translate("勝ち馬まで1/2馬身届かなかった"));
            Assert.Equal("Shinsei Akatsuki", en.Translate("シンセイアカツキ")); // server master table
            Assert.Equal("Received: 50 free coins, Scout Ticket ×1", en.Translate("受け取りました：無償コイン50枚・スカウト券×1"));
            Assert.Equal("Unlocks after 2 more races or 1 more breedings", en.Translate("あと2戦 または 配合あと1回で開放"));
            Assert.Equal("Already English", en.Translate("Already English"));
            Assert.Null(en.Translate("まったく知らない文"));
            // every English text of the client table is English, with the Japanese key's placeholders
            var raw = JsonNode.Parse(Res("ui-en.json")).Get("strings");
            foreach (var kv in raw.Props)
            {
                if (kv.Key.StartsWith("_")) continue;
                string v = kv.Value.AsString();
                Assert.False(Loc.HasJapanese(v), kv.Key);
                Assert.Equal(Places(kv.Key), Places(v));
                Assert.DoesNotMatch(@"(?i)\b(double|2x|x2|limited[- ]time|hurry|% off|today only)\b", v);
            }
        }

        [Fact]
        public async Task ApiClientSendsTheLocaleOnEveryRequest()
        {
            var http = new FakeHttp().Reply(200, "{\"ok\":true}").Reply(200, "{\"ok\":true}").Reply(200, "{\"devices\":1}");
            var api = new ApiClient(http, null, new ApiClientOptions { BaseUrl = "https://x", DevUserId = "u", Locale = "en-US" });
            Assert.Equal("en", api.Locale);
            await api.HealthAsync();
            Assert.Equal("en", http.Requests[0].Headers["accept-language"]);
            api.Locale = "ja";
            await api.HealthAsync();
            Assert.Equal("ja", http.Requests[1].Headers["accept-language"]);
            api.Locale = "fr";
            Assert.Equal("ja", api.Locale);
            api.Locale = "en";
            await api.RegisterPushDeviceAsync("fcm-token-1", PushPlatform.Ios);
            Assert.Contains("\"locale\":\"en\"", http.Requests[2].Body);
        }

        [Fact]
        public void TFollowsTheCurrentLocale()
        {
            try
            {
                Loc.SetLocale("ja");
                Assert.Equal("再試行", Loc.T("再試行"));
                Loc.SetLocale("EN");
                Assert.True(Loc.IsEnglish);
                Assert.Equal("Retry", Loc.T("再試行"));
                Assert.Equal("200 m to go", Loc.F("残り{0}m", 200));
                Assert.Equal("Hayatenotsubasa", Loc.T("ハヤテノツバサ"));
                Assert.Null(Loc.T(null));
            }
            finally { Loc.SetLocale("ja"); }
        }
    }
}
