using System;
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;
using Muchi.Net;

namespace Muchi.Client
{
    /// <summary>
    /// Localization on the client (REQ-L10N-009..011, contracts/protocol.md §23). Japanese is the source language: the
    /// game layer builds Japanese and the view shows <c>Loc.T(text)</c>. In English, T looks the text up in the string
    /// tables — Resources/Muchi/ui-en.json (texts the client builds) and master-en.json (a copy of
    /// server/master/locale-en.json for names inside race configs) — with the server's template rules: keys with
    /// <c>{placeholders}</c> match numbers / names, composite texts fall back to their sentences and list parts. A name in
    /// katakana with no entry (a player-named horse) is romanized (<see cref="Romaji"/>). Server texts arrive already in
    /// the request locale (ApiClient sends Accept-Language), so T leaves English as it is.
    /// </summary>
    public static class Loc
    {
        public const string Ja = "ja", En = "en";
        private static readonly object Gate = new object();
        private static volatile string _current = Ja;
        private static LocaleCatalog _en = new LocaleCatalog();

        /// <summary>"ja" (default) or "en".</summary>
        public static string Current => _current;
        public static bool IsEnglish => _current == En;

        /// <summary>Normalizes "en-US", "EN" … to "en"; anything unsupported to "ja".</summary>
        public static string Normalize(string tag)
        {
            if (string.IsNullOrEmpty(tag)) return Ja;
            string b = tag.Trim().ToLowerInvariant();
            int i = b.IndexOfAny(new[] { '-', '_' });
            if (i >= 0) b = b.Substring(0, i);
            return b == En ? En : Ja;
        }

        public static void SetLocale(string tag) => _current = Normalize(tag);

        /// <summary>Adds an English string table (`{"strings": {ja: en}}`); later tables win.</summary>
        public static void LoadEnglish(string json)
        {
            lock (Gate) { var c = _en.Clone(); c.Add(json); _en = c; }
        }

        public static LocaleCatalog English => _en;

        /// <summary>The text in the current locale (the Japanese when there is no English for it).</summary>
        public static string T(string ja) => _current == Ja || ja == null ? ja : _en.Translate(ja) ?? ja;

        /// <summary>`T` for a format: the Japanese template is translated first, then filled (`Loc.F("残り{0}m", 200)`).</summary>
        public static string F(string jaFormat, params object[] args) => T(string.Format(System.Globalization.CultureInfo.InvariantCulture, jaFormat, args));

        private static readonly Regex JapaneseRe = new Regex("[　-ヿ㐀-䶿一-鿿＀-￯]");
        public static bool HasJapanese(string s) => s != null && JapaneseRe.IsMatch(s);

        /// <summary>1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st (English place lines).</summary>
        public static string Ordinal(int n)
        {
            int t = n % 100;
            string suf = t >= 11 && t <= 13 ? "th" : (n % 10) == 1 ? "st" : (n % 10) == 2 ? "nd" : (n % 10) == 3 ? "rd" : "th";
            return n.ToString(System.Globalization.CultureInfo.InvariantCulture) + suf;
        }
    }

    /// <summary>One language's string table with the template / sentence / list rules (same as server/src/i18n/catalog.ts).</summary>
    public sealed class LocaleCatalog
    {
        private sealed class Template { public string Ja, En; public Regex Re; public List<string> Names; public int Literal; }

        private static readonly Regex Ph = new Regex(@"\{(\w+)\}");
        /// <summary>In the English, <c>{n:ord}</c> renders a number as an ordinal ("3着" → "3rd").</summary>
        private static readonly Regex PhEn = new Regex(@"\{(\w+)(:ord)?\}");
        private static readonly HashSet<string> Numeric = new HashSet<string> { "n", "m", "v", "p", "a", "b", "i", "y", "days", "levels", "qty", "minutes", "points" };
        private static readonly HashSet<string> Verbatim = new HashSet<string> { "name", "team", "url", "code", "id" };
        private static readonly string[][] Separators =
        {
            new[] { "　/　", "  /  " }, new[] { "　·　", "  ·  " }, new[] { "  /  ", "  /  " }, new[] { " / ", " / " }, new[] { "\n", "\n" }, new[] { " または ", " or " }, new[] { " ・ ", " · " }, new[] { "＋", " + " }, new[] { "・", ", " }, new[] { "、", ", " }, new[] { "　", "  " },
        };

        private readonly Dictionary<string, string> _exact = new Dictionary<string, string>();
        private List<Template> _templates = new List<Template>();
        private readonly Dictionary<string, string> _memo = new Dictionary<string, string>();

        public int Count => _exact.Count;

        /// <summary>The placeholder names of a text, sorted (`{n:ord}` counts as `n`).</summary>
        public static string Placeholders(string s)
        {
            var l = new List<string>();
            foreach (Match m in PhEn.Matches(s ?? "")) l.Add(m.Groups[1].Value);
            l.Sort(StringComparer.Ordinal);
            return string.Join(",", l);
        }
        public IReadOnlyDictionary<string, string> Entries => _exact;

        public LocaleCatalog Clone()
        {
            var c = new LocaleCatalog();
            foreach (var kv in _exact) c._exact[kv.Key] = kv.Value;
            c._templates = new List<Template>(_templates);
            return c;
        }

        public void Add(string json)
        {
            var o = JsonNode.Parse(json);
            var strings = o.Get("strings");
            foreach (var kv in strings.Props)
            {
                if (kv.Key.StartsWith("_", StringComparison.Ordinal) || kv.Value.Kind != JsonKind.String) continue;
                Set(kv.Key, kv.Value.AsString());
            }
        }

        public void Set(string ja, string en)
        {
            _exact[ja] = en;
            _memo.Clear();
            _templates.RemoveAll(t => t.Ja == ja);
            if (!Ph.IsMatch(ja)) return;
            var names = new List<string>();
            var src = new StringBuilder("^");
            int last = 0;
            foreach (Match m in Ph.Matches(ja))
            {
                src.Append(Regex.Escape(ja.Substring(last, m.Index - last)));
                string n = m.Groups[1].Value;
                src.Append(Numeric.Contains(n) ? @"([+\-−]?[0-9][0-9.,]*%?)" : n == "hm" ? "([0-9]{1,2}:[0-9]{2})" : n == "id" ? "([A-Za-z0-9]+)" : n == "url" ? @"(\S+)" : "(.+?)");
                names.Add(n);
                last = m.Index + m.Length;
            }
            src.Append(Regex.Escape(ja.Substring(last))).Append('$');
            _templates.Add(new Template { Ja = ja, En = en, Re = new Regex(src.ToString(), RegexOptions.Singleline), Names = names, Literal = Ph.Replace(ja, "").Length });
            _templates.Sort((a, b) => b.Literal.CompareTo(a.Literal));
        }

        /// <summary>English for a Japanese text, or null. Texts without Japanese are returned as they are.</summary>
        public string Translate(string s) => Translate(s, 0);

        private string Translate(string s, int depth)
        {
            if (s == null || !Loc.HasJapanese(s)) return s;
            if (_exact.TryGetValue(s, out var hit)) return hit;
            if (depth > 6) return null;
            lock (_memo) if (_memo.TryGetValue(s, out var m)) return m;
            var r = Uncached(s, depth);
            lock (_memo) { if (_memo.Count > 20000) _memo.Clear(); _memo[s] = r; }
            return r;
        }

        private string Uncached(string s, int depth)
        {
            foreach (var t in _templates)
            {
                var m = t.Re.Match(s);
                if (!m.Success) continue;
                var vals = new Dictionary<string, string>();
                bool ok = true;
                for (int i = 0; i < t.Names.Count; i++)
                {
                    string raw = m.Groups[i + 1].Value;
                    string v = Translate(raw, depth + 1) ?? (Verbatim.Contains(t.Names[i]) ? Romaji.Name(raw) : null);
                    if (v == null) { ok = false; break; }
                    vals[t.Names[i]] = v;
                }
                if (ok) return PhEn.Replace(t.En, x =>
                {
                    if (!vals.TryGetValue(x.Groups[1].Value, out var v)) return "";
                    return x.Groups[2].Success && int.TryParse(v, out int k) ? Loc.Ordinal(k) : v;
                });
            }
            var sentences = SplitSentences(s);
            if (sentences.Count > 1)
            {
                var parts = new List<string>();
                foreach (var x in sentences) { var y = Translate(x, depth + 1); if (y == null) { parts = null; break; } parts.Add(y); }
                if (parts != null) return string.Join(" ", parts);
            }
            foreach (var sep in Separators)
            {
                if (!s.Contains(sep[0])) continue;
                var pieces = s.Split(new[] { sep[0] }, StringSplitOptions.None);
                var parts = new List<string>();
                foreach (var x in pieces)
                {
                    var y = x.Length == 0 ? "" : Translate(x, depth + 1);
                    if (y == null) { parts = null; break; }
                    parts.Add(y);
                }
                if (parts != null) return string.Join(sep[1], parts);
            }
            // a katakana name with no entry (a player-named horse, a CPU horse): romanized
            return Romaji.IsKatakanaName(s) ? Romaji.Name(s) : null;
        }

        private static List<string> SplitSentences(string s)
        {
            var o = new List<string>();
            int start = 0;
            for (int i = 0; i < s.Length; i++)
                if (s[i] == '。') { o.Add(s.Substring(start, i + 1 - start)); start = i + 1; }
            if (start < s.Length) o.Add(s.Substring(start));
            return o;
        }
    }

    /// <summary>
    /// Katakana → Hepburn romaji for names (REQ-L10N-010): player-named horses are katakana by rule (REQ-HORSE-004), so in
    /// English they are shown romanized ("ミドリカワ" → "Midorikawa"). Display only; the stored name never changes.
    /// </summary>
    public static class Romaji
    {
        private static readonly Dictionary<string, string> Two = new Dictionary<string, string>
        {
            ["キャ"] = "kya", ["キュ"] = "kyu", ["キョ"] = "kyo", ["シャ"] = "sha", ["シュ"] = "shu", ["ショ"] = "sho", ["シェ"] = "she",
            ["チャ"] = "cha", ["チュ"] = "chu", ["チョ"] = "cho", ["チェ"] = "che", ["ニャ"] = "nya", ["ニュ"] = "nyu", ["ニョ"] = "nyo",
            ["ヒャ"] = "hya", ["ヒュ"] = "hyu", ["ヒョ"] = "hyo", ["ミャ"] = "mya", ["ミュ"] = "myu", ["ミョ"] = "myo", ["リャ"] = "rya",
            ["リュ"] = "ryu", ["リョ"] = "ryo", ["ギャ"] = "gya", ["ギュ"] = "gyu", ["ギョ"] = "gyo", ["ジャ"] = "ja", ["ジュ"] = "ju",
            ["ジョ"] = "jo", ["ジェ"] = "je", ["ビャ"] = "bya", ["ビュ"] = "byu", ["ビョ"] = "byo", ["ピャ"] = "pya", ["ピュ"] = "pyu",
            ["ピョ"] = "pyo", ["ファ"] = "fa", ["フィ"] = "fi", ["フェ"] = "fe", ["フォ"] = "fo", ["ティ"] = "ti", ["ディ"] = "di",
            ["トゥ"] = "tu", ["ドゥ"] = "du", ["ウィ"] = "wi", ["ウェ"] = "we", ["ウォ"] = "wo", ["ヴァ"] = "va", ["ヴィ"] = "vi",
            ["ヴェ"] = "ve", ["ヴォ"] = "vo", ["ツァ"] = "tsa", ["デュ"] = "dyu", ["テュ"] = "tyu",
        };
        private static readonly Dictionary<char, string> One = new Dictionary<char, string>();

        static Romaji()
        {
            string[] rows =
            {
                "ア a", "イ i", "ウ u", "エ e", "オ o", "カ ka", "キ ki", "ク ku", "ケ ke", "コ ko", "サ sa", "シ shi", "ス su", "セ se", "ソ so",
                "タ ta", "チ chi", "ツ tsu", "テ te", "ト to", "ナ na", "ニ ni", "ヌ nu", "ネ ne", "ノ no", "ハ ha", "ヒ hi", "フ fu", "ヘ he", "ホ ho",
                "マ ma", "ミ mi", "ム mu", "メ me", "モ mo", "ヤ ya", "ユ yu", "ヨ yo", "ラ ra", "リ ri", "ル ru", "レ re", "ロ ro", "ワ wa", "ヲ o", "ン n",
                "ガ ga", "ギ gi", "グ gu", "ゲ ge", "ゴ go", "ザ za", "ジ ji", "ズ zu", "ゼ ze", "ゾ zo", "ダ da", "ヂ ji", "ヅ zu", "デ de", "ド do",
                "バ ba", "ビ bi", "ブ bu", "ベ be", "ボ bo", "パ pa", "ピ pi", "プ pu", "ペ pe", "ポ po", "ヴ vu",
                "ァ a", "ィ i", "ゥ u", "ェ e", "ォ o", "ャ ya", "ュ yu", "ョ yo", "ヮ wa", "ヵ ka", "ヶ ke",
            };
            foreach (var r in rows) One[r[0]] = r.Substring(2);
        }

        /// <summary>Katakana, the long mark and the middle dot only (2+ characters).</summary>
        public static bool IsKatakanaName(string s)
        {
            if (string.IsNullOrEmpty(s) || s.Length < 2) return false;
            foreach (char c in s) if (!((c >= 'ァ' && c <= 'ヶ') || c == 'ー' || c == '・')) return false;
            return true;
        }

        /// <summary>A katakana name romanized and capitalized ("ハヤテノツバサ" → "Hayatenotsubasa"); other text unchanged.</summary>
        public static string Name(string s)
        {
            if (!IsKatakanaName(s)) return s;
            var sb = new StringBuilder();
            bool sokuon = false;
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                if (c == 'ッ') { sokuon = true; continue; }
                if (c == '・') { sb.Append(' '); continue; }
                if (c == 'ー') continue; // long vowels are not marked (Hepburn without macrons, as on race cards)
                string syl = null;
                if (i + 1 < s.Length && Two.TryGetValue(s.Substring(i, 2), out var two)) { syl = two; i++; }
                else if (!One.TryGetValue(c, out syl)) syl = "";
                if (sokuon && syl.Length > 0) { sb.Append(syl.StartsWith("ch", StringComparison.Ordinal) ? 't' : syl[0]); sokuon = false; }
                sb.Append(syl);
            }
            string r = sb.ToString();
            var words = r.Split(' ');
            for (int w = 0; w < words.Length; w++) if (words[w].Length > 0) words[w] = char.ToUpperInvariant(words[w][0]) + words[w].Substring(1);
            return string.Join(" ", words);
        }
    }
}
