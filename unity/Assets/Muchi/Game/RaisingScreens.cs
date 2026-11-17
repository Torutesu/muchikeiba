using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Muchi.Client;

namespace Muchi.Game
{
    // U1 raising screens (docs/quality/unity-raising.md): the pure part of the Unity screens for the horse card, breeding, the
    // foal reveal, the pedigree tree and the race result. The runtime (Runtime/MuchiApp.Raising.cs) draws every rectangle from the
    // layouts here, so the layout audit in the checks (RaisingScreenChecks) audits what the player sees: no two text rects
    // overlap, all inside the 1600×900 reference canvas, body text ≥ 16 px, at most one CTA per screen, sample texts fit.
    // Coordinates follow the web prototype (tools/figma-prototype/site/app.js HorseCard / Breeding / FoalReveal / Pedigree /
    // ResultScreen), moved where the Unity language button (1370,132 195×72) sits.

    public static class RaisingLayout
    {
        public const float Width = 1600, Height = 900;
        public const int BodyMin = 16, CtaHeight = 76, GhostHeight = 64, CtaLabelSize = 27, GhostLabelSize = 21;

        /// <summary>Card / Bar draw no text; Text / Kicker / Cta / Ghost / Reserved carry text and must not overlap each other.</summary>
        public enum Kind { Card, Bar, Text, Kicker, Cta, Ghost, Reserved }

        public sealed class Box
        {
            public string Id;
            public Kind Kind;
            public float X, Y, W, H;
            public int Size;
            /// <summary>A real text this box must hold (the audit estimates whether it fits).</summary>
            public string Sample;
            public bool IsText => Kind == Kind.Text || Kind == Kind.Kicker || Kind == Kind.Cta || Kind == Kind.Ghost || Kind == Kind.Reserved;
            public float Right => X + W;
            public float Bottom => Y + H;
            public override string ToString() => Id + " (" + X + "," + Y + " " + W + "×" + H + ")";
        }

        public sealed class Screen
        {
            public readonly string Name;
            public readonly List<Box> Boxes = new List<Box>();
            public Screen(string name) { Name = name; }
            public Box this[string id] => Boxes.FirstOrDefault(b => b.Id == id) ?? throw new KeyNotFoundException(Name + ": " + id);
            public bool Has(string id) => Boxes.Any(b => b.Id == id);
            public Box Add(string id, Kind kind, float x, float y, float w, float h, int size = 0)
            {
                if (kind == Kind.Cta) { h = CtaHeight; size = CtaLabelSize; }
                if (kind == Kind.Ghost) { h = GhostHeight; size = GhostLabelSize; }
                if (kind == Kind.Kicker) { h = 24; size = BodyMin; }
                var b = new Box { Id = id, Kind = kind, X = x, Y = y, W = w, H = h, Size = size };
                Boxes.Add(b);
                return b;
            }
            public Box Text(string id, float x, float y, float w, float h, int size) => Add(id, Kind.Text, x, y, w, h, size);
            public Box Kicker(string id, float x, float y, float w, string label = null) { var b = Add(id, Kind.Kicker, x, y, w, 24); b.Sample = label; return b; }
            public Box Cta(string id, float x, float y, float w, string label = null) { var b = Add(id, Kind.Cta, x, y, w, CtaHeight); b.Sample = label; return b; }
            public Box Ghost(string id, float x, float y, float w, string label = null) { var b = Add(id, Kind.Ghost, x, y, w, GhostHeight); b.Sample = label; return b; }
            public void Sample(string id, string text) => this[id].Sample = text;
        }

        /// <summary>The language button every screen gets from MuchiApp.Clear() (reserved: nothing may sit under it).</summary>
        static void Reserve(Screen s) => s.Add("language", Kind.Reserved, 1370, 132, 195, 72, 21);

        // ------------------------------------------------------------------------------------------- the audit

        /// <summary>Problems with a screen's layout (empty = fine).</summary>
        public static List<string> Audit(Screen s)
        {
            var problems = new List<string>();
            foreach (var b in s.Boxes)
            {
                if (b.X < 0 || b.Y < 0 || b.Right > Width || b.Bottom > Height) problems.Add(b + " is outside 1600×900");
                if ((b.Kind == Kind.Text || b.Kind == Kind.Kicker) && b.Size < BodyMin) problems.Add(b + " text " + b.Size + " < 16");
                if (b.IsText && b.H < b.Size) problems.Add(b + " is shorter than its text size");
                if (!string.IsNullOrEmpty(b.Sample) && !Fits(b.Sample, b)) problems.Add(b + " does not fit 「" + b.Sample + "」");
            }
            var texts = s.Boxes.Where(b => b.IsText).ToList();
            for (int i = 0; i < texts.Count; i++)
                for (int j = i + 1; j < texts.Count; j++)
                    if (Overlap(texts[i], texts[j])) problems.Add(texts[i] + " and " + texts[j] + " overlap");
            int ctas = s.Boxes.Count(b => b.Kind == Kind.Cta);
            if (ctas > 1) problems.Add(ctas + " CTAs (one per screen)");
            return problems;
        }

        public static bool Overlap(Box a, Box b) => a.X < b.Right && b.X < a.Right && a.Y < b.Bottom && b.Y < a.Bottom;

        /// <summary>
        /// Whether <paramref name="text"/> fits <paramref name="b"/> when wrapped at the box width, estimated for the bold CJK UI font:
        /// a CJK / full-width character is 1 em, Latin and digits 0.6 em, the middle dot 0.6 em; a line is 1.45 em (the first 1.2 em).
        /// Kickers count their letter spacing; a CTA / ghost label its padding and 「　»」.
        /// </summary>
        public static bool Fits(string text, Box b) => NeededHeight(text, b) <= b.H + 1f;

        public static float NeededHeight(string text, Box b)
        {
            if (string.IsNullOrEmpty(text)) return 0;
            float w = b.W;
            if (b.Kind == Kind.Cta) { w = b.W - 56; text += "　»"; }
            if (b.Kind == Kind.Ghost) w = b.W - 24;
            int lines = 0;
            foreach (var raw in text.Split('\n'))
            {
                float width = 0;
                char prev = ' ';
                foreach (char c in raw)
                {
                    width += Em(c) * b.Size;
                    if (b.Kind == Kind.Kicker && c != ' ' && prev != ' ') width += 0.3f * b.Size;
                    prev = c;
                }
                lines += Math.Max(1, (int)Math.Ceiling(width / Math.Max(1f, w) - 0.0001f));
            }
            return b.Size * 1.2f + (lines - 1) * b.Size * 1.45f;
        }

        static float Em(char c)
        {
            if (c < 0x80) return 0.6f;
            if (c == '·' || c == '—' || c == '–' || c == '×' || c == '→' || c == '›' || c == '»') return 0.6f;
            return 1f;
        }

        // ------------------------------------------------------------------------------------------- 馬カード

        /// <summary>The horse card: growth on the left (stage, five layered stats, totals, the ranked line, the rules), the story on the right.</summary>
        public static Screen HorseCard()
        {
            var s = new Screen("horse card");
            Reserve(s);
            s.Add("growthCard", Kind.Card, 36, 110, 800, 700);
            s.Kicker("kicker", 72, 136, 480);
            s.Text("name", 72, 180, 420, 46, 34);
            s.Text("rarity", 72, 240, 420, 26, 18);
            s.Text("stageLabel", 596, 136, 204, 24, 16);
            s.Text("stage", 596, 162, 204, 40, 30);
            s.Add("stageBar", Kind.Bar, 596, 210, 204, 6);
            s.Text("next", 496, 228, 304, 24, 16);
            s.Add("rule", Kind.Bar, 72, 282, 728, 1);
            s.Text("statsLabel", 72, 296, 200, 24, 16).Sample = RaisingText.Stats;
            s.Text("trainedLabel", 596, 296, 204, 24, 16).Sample = RaisingText.Trained;
            for (int i = 0; i < 5; i++)
            {
                float y = 328 + i * 50;
                s.Text("stat" + i + ".name", 72, y, 220, 24, 18).Sample = "スタミナ　·　得意";
                s.Text("stat" + i + ".value", 300, y - 2, 90, 26, 22).Sample = "1,000";
                s.Add("stat" + i + ".bar", Kind.Bar, 72, y + 28, 318, 8);
                s.Add("stat" + i + ".meter", Kind.Bar, 430, y + 30, 230, 6);
                s.Text("stat" + i + ".trained", 670, y + 18, 130, 24, 18).Sample = "+96";
            }
            s.Text("total", 72, 580, 300, 26, 18).Sample = "能力合計 3,360";
            s.Text("potential", 466, 580, 334, 26, 18).Sample = "素質 240 / 240";
            s.Text("ranked", 72, 612, 728, 24, 16);
            s.Text("leaning", 72, 640, 728, 24, 16);
            s.Text("rules", 72, 672, 728, 72, 16);
            s.Add("storyCard", Kind.Card, 860, 110, 704, 700);
            s.Kicker("careerKicker", 896, 136, 440, RaisingText.Career);
            s.Text("career", 896, 214, 440, 40, 30);
            s.Text("extra", 896, 262, 632, 24, 16);
            s.Kicker("lineageKicker", 896, 306, 300, RaisingText.Lineage);
            s.Ghost("pedigree", 1344, 296, 184, RaisingText.PedigreeLink);
            s.Text("generation", 896, 340, 432, 26, 18).Sample = "第2世代（スカウト・配布の馬）";
            s.Text("parents", 896, 372, 632, 24, 16);
            s.Text("skill", 896, 402, 632, 24, 16);
            s.Text("atavism", 896, 430, 632, 24, 16).Sample = "隔世遺伝：重馬場巧者（ハツユキソウ）";
            s.Kicker("trainingKicker", 896, 474, 300, RaisingText.RecentTraining);
            for (int i = 0; i < 3; i++)
            {
                float y = 506 + i * 32;
                s.Text("log" + i + ".grade", 896, y, 480, 24, 16).Sample = "◎ 会心の追い切り";
                s.Text("log" + i + ".gain", 1416, y, 112, 24, 16).Sample = "+12";
            }
            s.Text("noTraining", 896, 506, 480, 24, 16).Sample = RaisingText.NoTraining;
            s.Boxes.Remove(s["noTraining"]); // drawn in log0's place when there is no training (same rect; kept out of the overlap audit)
            s.Cta("cta", 896, 666, 400, RaisingText.Train);
            s.Ghost("back", 36, 826, 180, RaisingText.Back);
            s.Text("note", 240, 842, 1100, 28, 16);
            return s;
        }

        // ------------------------------------------------------------------------------------------- 配合

        public static Screen Breeding()
        {
            var s = new Screen("breeding");
            Reserve(s);
            s.Text("title", 36, 36, 900, 48, 32).Sample = "配合　/　今日あと1回";
            s.Text("steps", 36, 92, 1000, 26, 16).Sample = RaisingText.BreedingSteps;
            // ① parents
            s.Add("parentsCard", Kind.Card, 36, 134, 440, 676);
            foreach (var (who, top, label) in new[] { ("sire", 160f, RaisingText.SireTitle), ("dam", 444f, RaisingText.DamTitle) })
            {
                s.Kicker(who + "Kicker", 72, top, 368, label);
                for (int i = 0; i < 3; i++)
                {
                    float y = top + 36 + i * 80;
                    s.Add(who + i + ".card", Kind.Card, 72, y, 368, 70);
                    s.Text(who + i + ".name", 90, y + 10, 200, 26, 18).Sample = "アカツキノヒカリ";
                    s.Text(who + i + ".rarity", 290, y + 12, 132, 24, 16).Sample = "SSR　追込";
                    s.Text(who + i + ".aim", 90, y + 42, 332, 24, 16);
                }
            }
            s.Text("noPair", 72, 720, 368, 72, 16).Sample = RaisingText.NoPair;
            // ② the outlook
            s.Add("outlookCard", Kind.Card, 496, 134, 560, 676);
            s.Kicker("outlookKicker", 532, 160, 488, RaisingText.Outlook);
            s.Text("empty", 532, 226, 488, 52, 16).Sample = RaisingText.ChooseParents;
            s.Boxes.Remove(s["empty"]); // drawn in compat's place before a preview
            s.Text("compat", 532, 226, 488, 26, 18);
            for (int i = 0; i < 5; i++)
            {
                float y = 266 + i * 40;
                s.Text("range" + i + ".name", 532, y, 110, 24, 16).Sample = "スタミナ";
                s.Add("range" + i + ".track", Kind.Bar, 646, y + 8, 300, 8);
                s.Text("range" + i + ".value", 956, y, 100, 24, 16).Sample = "600〜720";
            }
            s.Text("rangeNote", 532, 466, 488, 24, 16).Sample = RaisingText.RangeNote;
            s.Kicker("oddsKicker", 532, 504, 488, RaisingText.OddsTitle);
            s.Add("oddsBar", Kind.Bar, 532, 540, 488, 20);
            s.Text("odds", 532, 570, 488, 26, 18);
            s.Text("oddsNote", 532, 604, 488, 48, 16).Sample = RaisingText.OddsNote;
            s.Text("distance", 532, 664, 488, 24, 16);
            // ③ what each parent passes on; the one CTA
            s.Add("giftsCard", Kind.Card, 1076, 134, 488, 676);
            s.Kicker("giftsKicker", 1112, 220, 400, RaisingText.Gifts);
            s.Text("gifts", 1112, 256, 416, 236, 16);
            s.Ghost("sirePedigree", 1112, 512, 200, RaisingText.SirePedigree);
            s.Ghost("damPedigree", 1328, 512, 200, RaisingText.DamPedigree);
            s.Cta("cta", 1112, 596, 416, RaisingText.Breed);
            s.Text("today", 1112, 686, 416, 24, 16);
            s.Text("legal", 1112, 718, 416, 48, 16).Sample = RaisingText.BreedingLegal;
            s.Ghost("back", 36, 826, 180, RaisingText.Back);
            s.Text("note", 240, 842, 1100, 28, 16);
            return s;
        }

        // ------------------------------------------------------------------------------------------- 仔馬のお披露目

        /// <summary>The foal reveal. <paramref name="done"/>: all four steps shown (CTA 馬カードを見る); <paramref name="again"/>: material allows one more.</summary>
        public static Screen FoalReveal(bool done, bool again)
        {
            var s = new Screen("foal reveal" + (done ? (again ? " (done, one more)" : " (done)") : " (revealing)"));
            Reserve(s);
            s.Add("card", Kind.Card, 36, 80, 1060, 740);
            s.Kicker("kicker", 76, 110, 600, RaisingText.NewLife);
            s.Text("title", 76, 160, 700, 44, 34).Sample = RaisingText.FoalBorn;
            s.Text("sexstyle", 76, 226, 900, 28, 20);
            for (int i = 0; i < 5; i++)
            {
                float y = 280 + i * 44;
                s.Text("stat" + i + ".name", 76, y, 110, 24, 16).Sample = "スタミナ";
                s.Add("stat" + i + ".track", Kind.Bar, 186, y + 8, 420, 8);
                s.Text("stat" + i + ".value", 622, y - 2, 70, 28, 20).Sample = "1000";
                s.Text("stat" + i + ".mark", 704, y, 120, 24, 16).Sample = RaisingText.AboveRange;
            }
            s.Text("rarity", 76, 500, 200, 70, 56).Sample = "SSR";
            s.Text("summary", 290, 522, 780, 28, 18);
            s.Text("skill", 76, 588, 980, 26, 18);
            s.Text("atavism", 76, 618, 980, 26, 18).Sample = "隔世遺伝：重馬場巧者（ハツユキソウ）";
            s.Text("parents", 76, 650, 980, 24, 16).Sample = "父 アカツキノヒカリ　·　母 サクラノミチシルベ";
            s.Cta("cta", 76, 708, 360, done ? RaisingText.SeeHorseCard : RaisingText.Turn);
            if (!done) s.Ghost("all", 466, 714, 240, RaisingText.ShowAll);
            else if (again)
            {
                s.Ghost("again", 466, 714, 300, RaisingText.BreedAgain);
                s.Ghost("back", 796, 714, 240, RaisingText.BackToBreeding);
                s.Text("again.line", 466, 786, 600, 24, 16);
            }
            else s.Ghost("back", 466, 714, 240, RaisingText.BackToBreeding);
            return s;
        }

        // ------------------------------------------------------------------------------------------- 血統 (minimal)

        /// <summary>Column x / width per generation and the box height (gen 0..3) of the minimal tree.</summary>
        public static readonly float[] PedX = { 60, 396, 762, 1148 }, PedW = { 300, 330, 350, 392 }, PedH = { 200, 160, 120, 60 };
        public const float PedTop = 240, PedHeight = 550;

        /// <summary>Slot <paramref name="slot"/>'s box: centred on its share of the column height.</summary>
        public static Box PedigreeSlot(int slot)
        {
            int g = PedigreeTree.GenOf(slot), count = 1 << g, idx = slot - (count - 1);
            float cell = PedHeight / count, cy = PedTop + cell * idx + cell / 2;
            return new Box { Id = "slot" + slot, Kind = Kind.Card, X = PedX[g], Y = cy - PedH[g] / 2, W = PedW[g], H = PedH[g] };
        }

        public static Screen Pedigree()
        {
            var s = new Screen("pedigree");
            Reserve(s);
            s.Text("title", 36, 36, 900, 48, 32).Sample = RaisingText.PedigreeTitle;
            s.Text("sub", 36, 92, 1200, 26, 16).Sample = "ミナモ系　·　3代の血統　·　共通の祖先はシアンの枠";
            s.Add("treeCard", Kind.Card, 36, 220, 1528, 590);
            for (int i = 0; i < PedigreeTree.SlotCount; i++)
            {
                var b = PedigreeSlot(i);
                int g = PedigreeTree.GenOf(i);
                s.Boxes.Add(b);
                float x = b.X + 10, w = b.W - 20;
                if (g == 3)
                {
                    s.Text(b.Id + ".rel", x, b.Y + 4, w - 60, 24, 16).Sample = "母の母の父";
                    s.Text(b.Id + ".badge", b.Right - 66, b.Y + 4, 56, 24, 16).Sample = PedigreeModel.SharedBadge;
                    s.Text(b.Id + ".name", x, b.Y + 32, w, 24, 16).Sample = "サクラノミチシルベ";
                    continue;
                }
                s.Text(b.Id + ".rel", x, b.Y + 8, w - 60, 24, 16).Sample = g == 0 ? "本人" : "母の父";
                s.Text(b.Id + ".badge", b.Right - 66, b.Y + 8, 56, 24, 16).Sample = PedigreeModel.SharedBadge;
                int nameSize = g == 0 ? 24 : g == 1 ? 20 : 18;
                s.Text(b.Id + ".name", x, b.Y + 36, w, nameSize + 8, nameSize).Sample = "サクラノミチシ";
                s.Text(b.Id + ".traits", x, b.Y + 44 + nameSize, w, 24, 16).Sample = g == 2 ? "差し・末脚一閃" : "差し・重馬場が得意・末脚一閃";
                if (g < 2) s.Text(b.Id + ".under", x, b.Y + 72 + nameSize, w, 24, 16).Sample = "系統の祖";
                if (g == 0) s.Text(b.Id + ".line", x, b.Y + 100 + nameSize, w, 24, 16).Sample = "SSR　/　ミナモ系";
            }
            s.Ghost("back", 36, 826, 150, RaisingText.Back);
            s.Text("inbreeding", 210, 840, 900, 28, 16).Sample = "近親：共通の祖先2頭（能力の基準 −100）";
            s.Cta("cta", 1164, 816, 400, RaisingText.SeeHorseCard);
            return s;
        }

        // ------------------------------------------------------------------------------------------- レース結果

        /// <summary>The ranked / practice result. <paramref name="promoCard"/>: the promotion card is on the right.</summary>
        public static Screen Result(bool promoCard)
        {
            var s = new Screen("result" + (promoCard ? " (promotion card)" : ""));
            Reserve(s);
            s.Add("panel", Kind.Card, 33, 48, 603, 804);
            s.Kicker("kicker", 75, 90, 540, "レース結果　/　ランク戦");
            s.Text("place", 75, 124, 540, 110, 89).Sample = "12着";
            s.Text("won", 77, 238, 300, 36, 26).Sample = "12頭中";
            s.Text("partner", 77, 282, 520, 28, 19).Sample = "アカツキノヒカリ　/　ランク戦";
            s.Add("rule", Kind.Bar, 77, 322, 478, 2);
            s.Kicker("timeKicker", 77, 338, 170, RaisingText.Time);
            s.Kicker("coinsKicker", 255, 338, 170, RaisingText.FreeCoins);
            s.Kicker("pointsKicker", 431, 338, 170, RaisingText.SeasonPoints);
            s.Text("time", 77, 366, 170, 40, 30).Sample = "1:35.82";
            s.Text("coins", 255, 366, 170, 40, 30).Sample = "+1,000";
            s.Text("points", 431, 366, 170, 40, 30).Sample = "+100";
            s.Text("rewards", 77, 414, 520, 24, 16);
            s.Kicker("reasonKicker", 77, 452, 200, RaisingText.LossReason);
            s.Text("debrief", 77, 478, 520, 30, 22);
            s.Text("tip", 77, 514, 520, 44, 16);
            s.Text("lesson", 77, 562, 520, 66, 16);
            s.Text("status", 77, 636, 520, 24, 16).Sample = RaceResultModel.VoidText;
            s.Cta("cta", 77, 688, 478, "相棒に名前をつける");
            s.Ghost("home", 77, 780, 200, RaisingText.Home);
            s.Ghost("horseCard", 297, 780, 200, HorseProfileModel.Title);
            if (promoCard)
            {
                s.Add("promoCard", Kind.Card, 900, 230, 520, 300);
                s.Kicker("promoKicker", 928, 252, 460, "昇級戦　/　C級 → B級");
                s.Text("promoTitle", 928, 296, 464, 44, 34);
                s.Text("promoLead", 928, 348, 464, 24, 16).Sample = PromotionModel.StartLead;
                s.Text("promoMarks", 928, 380, 464, 44, 34).Sample = "○●·";
                s.Text("promoRule", 928, 432, 464, 24, 16).Sample = "3戦で3着以内が2回で突破";
                s.Text("promoFoot", 928, 462, 464, 24, 16);
                s.Text("promoReward", 928, 494, 464, 24, 16);
            }
            return s;
        }
    }

    /// <summary>The fixed Japanese labels of the raising screens (English in ui-en.json; RaisingScreenChecks checks every one).</summary>
    public static class RaisingText
    {
        public const string Stats = "能力", Trained = "調教の伸び", StageLabel = "成長段階", Career = "戦績", Lineage = "血統", PedigreeLink = "血統 ›", RecentTraining = "最近の調教",
            NoTraining = "まだ調教していません", Train = "調教する", ToBreeding = "配合へ", Back = "戻る", Home = "ホーム",
            KickerHorseCard = "馬カード", Scouted = "（スカウト・配布の馬）", StudSire = "（借りた種牡馬）",
            BreedingTitle = "配合", BreedingSteps = "父と母を選ぶ　→　見込みを確かめる　→　仔を迎える", SireTitle = "父（引退した牡馬）", DamTitle = "母（引退した牝馬）",
            NoRetired = "引退した馬がいません", NoPair = "牡馬と牝馬を1頭ずつ引退させると配合できます。引退は所属馬の一覧から。",
            Outlook = "仔の見込み", ChooseParents = "父と母を選ぶと、生まれる仔の見込みが出ます", RangeNote = "能力は幅の中で決まります",
            OddsTitle = "仔のレア度の見込み", OddsNote = "実際の配合と同じ計算で出しています", Gifts = "受け継げるもの", SirePedigree = "父の血統 ›", DamPedigree = "母の血統 ›",
            Breed = "配合する", BreedingLegal = "見込みの確率はすべて実際の配合と同じ計算です。調教の伸びは受け継がれません。",
            NewLife = "新しい命", FoalBorn = "仔馬が生まれました", AboveRange = "期待以上", Turn = "めくる", ShowAll = "すべて見る", SeeHorseCard = "馬カードを見る",
            BreedAgain = "もう1回配合する", BackToBreeding = "配合へ戻る", DailyLimit = "今日の配合はおしまい。4:00に戻ります",
            PedigreeTitle = "血統　/　PEDIGREE", PedigreeSub = "3代の血統　·　共通の祖先はシアンの枠", NoRecord = "記録なし",
            Time = "タイム", FreeCoins = "無償コイン", SeasonPoints = "シーズンpt", WinReason = "勝因", LossReason = "敗因", Hint = "ヒント：", Lookback = "振り返り：",
            Win = "勝利", Ranked = "ランク戦", Practice = "練習", FirstRide = "はじめてのレース", Again = "もう一度", Continue = "つづける", ResultKicker = "レース結果";

        public static readonly string[] All =
        {
            Stats, Trained, StageLabel, Career, Lineage, PedigreeLink, RecentTraining, NoTraining, Train, ToBreeding, Back, Home, KickerHorseCard, Scouted, StudSire,
            BreedingTitle, BreedingSteps, SireTitle, DamTitle, NoRetired, NoPair, Outlook, ChooseParents, RangeNote, OddsTitle, OddsNote, Gifts, SirePedigree, DamPedigree,
            Breed, BreedingLegal, NewLife, FoalBorn, AboveRange, Turn, ShowAll, SeeHorseCard, BreedAgain, BackToBreeding, DailyLimit,
            PedigreeTitle, PedigreeSub, NoRecord, Time, FreeCoins, SeasonPoints, WinReason, LossReason, Win, Ranked, Practice, FirstRide, Again, Continue, ResultKicker,
            "馬カード　/　第2世代", "第2世代", "第1世代（スカウト・配布の馬）", "父 アカツキ（借りた種牡馬）　·　母 サクラ", "父 —　·　母 —", "配合　/　今日あと1回",
            "SR　·　差し　·　芝 1,600〜2,400m", "SSR　·　追込　·　ダート 1,000〜1,400m", "SR　·　先行　·　芝・ダート 1,200〜2,000m", "スタミナ　·　得意", "3着以内6回", "12頭中", "1着", "ミナモ系　·　3代の血統　·　共通の祖先はシアンの枠", "SSR　/　ミナモ系",
            "アカツキ　/　ランク戦", "アカツキ　/　練習", "アカツキ　/　はじめてのレース", "ヒント：次は残り300mからムチを2回", "SR　逃げ", "600〜720",
        };
    }

    // ------------------------------------------------------------------------------------------- result screen parts

    /// <summary>
    /// The place-coin line: what the race actually granted, from the server's wallet and season points before the race and after the
    /// confirmed result (the server applies 着順コイン + 初勝利ボーナス; the client never computes them). Practice / verifying / void:
    /// no number at all.
    /// </summary>
    public sealed class ResultRewards
    {
        public int FreeBefore = -1, PointsBefore = -1;
        public bool Known;
        public int Coins, Points;
        public string Line;
        public string CoinsText => Known ? "+" + Coins.ToString("N0", CultureInfo.InvariantCulture) : "—";
        public string PointsText => Known ? "+" + Points.ToString("N0", CultureInfo.InvariantCulture) : "—";

        public const string PracticeLine = "練習：コインとポイントはつきません";
        public const string VerifyingLine = "報酬は結果の照合のあとに入ります";
        public const string VoidLine = "無効のレース：報酬はありません";
        public const string UnknownLine = "報酬はホームの残高に入ります";

        /// <summary>The wallet and points at the race's start (null player = offline / no snapshot).</summary>
        public static ResultRewards Snapshot(PlayerView p) => p?.Wallet == null ? new ResultRewards() : new ResultRewards { FreeBefore = p.Wallet.Free, PointsBefore = p.SeasonPoints };

        /// <summary>The line once the result is known. <paramref name="after"/> = the player after RefreshAsync.</summary>
        public ResultRewards Settle(PlayerView after, bool online, bool confirmed, bool voided)
        {
            var r = new ResultRewards { FreeBefore = FreeBefore, PointsBefore = PointsBefore };
            if (!online) { r.Line = PracticeLine; return r; }
            if (voided) { r.Line = VoidLine; return r; }
            if (!confirmed) { r.Line = VerifyingLine; return r; }
            if (FreeBefore < 0 || after?.Wallet == null) { r.Line = UnknownLine; return r; }
            r.Known = true;
            r.Coins = Math.Max(0, after.Wallet.Free - FreeBefore);
            r.Points = Math.Max(0, after.SeasonPoints - PointsBefore);
            r.Line = "着順の無償コイン +" + r.Coins.ToString("N0", CultureInfo.InvariantCulture) + "・シーズンpt +" + r.Points.ToString("N0", CultureInfo.InvariantCulture) + "（サーバーの確定値）";
            return r;
        }
    }

    /// <summary>
    /// The reason block of the result (ruleset 1.4): 勝因/敗因, the debrief line, the tip and the 振り返り row (the 能力の差 line,
    /// the 仕掛け lesson, the 会心 count), shortened to fit its box like the prototype: 会心 goes first, then — when the field says
    /// the horse is weaker — the lesson, else the general line before the specific lesson.
    /// </summary>
    public sealed class ResultLines
    {
        public string ReasonKicker, Debrief, Tip, Lesson;
        /// <summary>Which side the row says to work on: "horse" / "riding" / null.</summary>
        public string Field;

        public static ResultLines Build(RaceResultModel r, bool beginner, RaisingLayout.Box tipBox, RaisingLayout.Box lessonBox)
        {
            var o = new ResultLines { ReasonKicker = r.Won ? RaisingText.WinReason : RaisingText.LossReason, Debrief = string.IsNullOrEmpty(r.DebriefLine) ? "—" : r.DebriefLine };
            if (!string.IsNullOrEmpty(r.DebriefTip)) o.Tip = RaisingText.Hint + r.DebriefTip;
            string field = !beginner && !string.IsNullOrEmpty(r.FieldLine) ? r.FieldLine : null;
            var parts = new List<string> { field, r.GoLesson, r.PerfectLine }.Where(x => !string.IsNullOrEmpty(x)).ToList();
            if (parts.Count == 0) return o;
            string Row() => RaisingText.Lookback + string.Join("　·　", parts);
            bool weaker = r.FieldCheck?.HorseWeaker == true;
            while (parts.Count > 1 && lessonBox != null && !RaisingLayout.Fits(Row(), lessonBox))
            {
                if (parts.Count > 2 || field == null || weaker || parts[0] != field) parts.RemoveAt(parts.Count - 1);
                else parts.RemoveAt(0);
            }
            o.Lesson = Row();
            if (field != null && parts.Contains(field)) o.Field = weaker ? "horse" : "riding";
            if (o.Tip != null && tipBox != null && !RaisingLayout.Fits(o.Tip, tipBox)) o.Tip = null;
            return o;
        }
    }

    /// <summary>The class pattern that becomes a free reward on promotion (quality/shopcfg, option A). Name as the server sends it.</summary>
    public sealed class PromotionRewardInfo
    {
        public string Name;
        /// <summary>Already in the player's box (true) or arrives when the class goes up at the season close (false).</summary>
        public bool Granted;
    }

    /// <summary>
    /// What the result screen shows of the promotion series: the outcome popup (the outcome sheet, through the session's one-prompt
    /// gate) or the card on the right — never both — or nothing when this race did not touch the series.
    /// </summary>
    public sealed class ResultPromotionPlan
    {
        public enum Show { None, Card, Popup }
        public Show What;
        public string Kicker, Title, Lead, Marks, Rule, Foot, RewardLine;
        /// <summary>Gold title: the start of a series and a pass (rank).</summary>
        public bool Gold;
        public string MomentKicker, MomentLine, MomentButton;
        public const string RulesLink = PromotionModel.RulesLabel;

        public static ResultPromotionPlan Build(PromotionModel m, PromotionRewardInfo reward)
        {
            var p = new ResultPromotionPlan { What = Show.None };
            var v = m?.View;
            var x = v?.Series;
            if (v == null || !v.Enabled || x == null) return p;
            p.Kicker = "昇級戦　/　" + v.ClassId + "級 → " + v.ToClassId + "級";
            p.Marks = m.Marks;
            p.Rule = m.RuleLine;
            if (x.Passed && reward != null && !string.IsNullOrEmpty(reward.Name))
                p.RewardLine = reward.Granted ? "昇級の記念「" + reward.Name + "」を受け取りました（無料）" : v.ToClassId + "級に上がると「" + reward.Name + "」が届きます（無料）";
            if (m.OutcomeSheetVisible)
            {
                p.What = Show.Popup;
                p.Title = m.OutcomeTitle;
                p.Gold = x.Passed;
                p.MomentKicker = x.Passed ? "昇級戦　/　突破" : "昇級戦　/　届かず";
                p.MomentLine = m.OutcomeBody + (p.RewardLine != null ? "　·　" + p.RewardLine : "");
                p.MomentButton = RaisingText.Continue;
                return p;
            }
            if (!m.TouchedByLastResult) return p;
            p.What = Show.Card;
            bool started = m.ResultBanner != null;
            p.Title = started ? PromotionModel.StartBanner : x.Passed || x.Failed ? m.OutcomeTitle : m.HomeLabel;
            p.Gold = started || x.Passed;
            p.Lead = started ? PromotionModel.StartLead : null;
            p.Foot = x.Failed && x.SetbackTo.HasValue ? "ポイントは" + x.SetbackTo.Value.ToString("N0", CultureInfo.InvariantCulture) + "ptに戻りました"
                : x.Passed ? "クラスが上がるのはシーズンの締め"
                : "ライン " + (v.Line ?? 0).ToString("N0", CultureInfo.InvariantCulture) + "pt　·　いま " + v.Points.ToString("N0", CultureInfo.InvariantCulture) + "pt";
            return p;
        }
    }
}
