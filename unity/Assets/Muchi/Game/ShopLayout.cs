using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace Muchi.Game
{
    // U1 money screens (docs/quality/unity-shop.md): the rectangles of the Unity shop, scout confirmation, coin-shortfall sheet,
    // purchase confirmation, receipt, odds and season pass screens, on the 1600×900 reference canvas. The screens in
    // unity/Assets/Muchi/Runtime/MuchiApp.Shop.cs draw at these boxes and nowhere else, so the layout audit below
    // (GameChecks ShopScreenChecks) checks what is drawn: text never overlaps text or a button, everything is inside the
    // canvas and clear of the language button, body text is 16 px or more, one call to action per screen.
    // The coordinates follow tools/figma-prototype/site/app.js (ScoutConfirm, Shortfall, Store, PurchaseConfirm, Receipt,
    // SeasonPass): the prototype's dialog sizes and inner offsets, moved to absolute canvas positions.

    public enum BoxKind { Text, Cta, Ghost, Card, Shape }

    /// <summary>One rectangle of a screen (top-left origin, canvas pixels). Size is the font size of a text box.</summary>
    public sealed class LayoutBox
    {
        public readonly string Name;
        public readonly BoxKind Kind;
        public readonly float X, Y, W, H;
        public readonly int Size;
        public LayoutBox(string name, BoxKind kind, float x, float y, float w, float h, int size = 0) { Name = name; Kind = kind; X = x; Y = y; W = w; H = h; Size = size; }
        public bool Overlaps(LayoutBox o) => X < o.X + o.W && o.X < X + W && Y < o.Y + o.H && o.Y < Y + H;
        public bool Inside(float w, float h) => X >= 0 && Y >= 0 && X + W <= w && Y + H <= h;
        public override string ToString() => Name + " (" + X.ToString(CultureInfo.InvariantCulture) + "," + Y.ToString(CultureInfo.InvariantCulture) + " " + W.ToString(CultureInfo.InvariantCulture) + "×" + H.ToString(CultureInfo.InvariantCulture) + ")";
    }

    /// <summary>The boxes of one screen (one state of it). Boxes are looked up by name; a missing name throws (a typo is a bug).</summary>
    public sealed class ScreenLayout
    {
        public const float CanvasW = 1600, CanvasH = 900;
        /// <summary>The kit's fixed heights (MuchiApp.Kit.cs: Cta 76, Ghost 64, Kicker 24 at 16 px).</summary>
        public const float CtaH = 76, GhostH = 64, KickerH = 24;
        public const int BodyMin = 16;
        /// <summary>MuchiApp.Clear() puts the language button here on every screen.</summary>
        public static readonly LayoutBox LanguageButton = new LayoutBox("language button", BoxKind.Ghost, 1370, 132, 195, 72);

        public readonly string Screen;
        private readonly List<LayoutBox> _boxes = new List<LayoutBox>();
        public ScreenLayout(string screen) { Screen = screen; }
        public IReadOnlyList<LayoutBox> Boxes => _boxes;

        public LayoutBox this[string name] => _boxes.FirstOrDefault(b => b.Name == name) ?? throw new KeyNotFoundException(Screen + ": no box " + name);
        public bool Has(string name) => _boxes.Any(b => b.Name == name);

        public ScreenLayout Text(string name, float x, float y, float w, float h, int size) { _boxes.Add(new LayoutBox(name, BoxKind.Text, x, y, w, h, size)); return this; }
        public ScreenLayout Kicker(string name, float x, float y, float w) => Text(name, x, y, w, KickerH, BodyMin);
        public ScreenLayout Cta(string name, float x, float y, float w) { _boxes.Add(new LayoutBox(name, BoxKind.Cta, x, y, w, CtaH)); return this; }
        public ScreenLayout Ghost(string name, float x, float y, float w) { _boxes.Add(new LayoutBox(name, BoxKind.Ghost, x, y, w, GhostH)); return this; }
        public ScreenLayout Card(string name, float x, float y, float w, float h) { _boxes.Add(new LayoutBox(name, BoxKind.Card, x, y, w, h)); return this; }
        public ScreenLayout Shape(string name, float x, float y, float w, float h) { _boxes.Add(new LayoutBox(name, BoxKind.Shape, x, y, w, h)); return this; }

        private static bool Readable(LayoutBox b) => b.Kind == BoxKind.Text || b.Kind == BoxKind.Cta || b.Kind == BoxKind.Ghost;

        /// <summary>The audit: every rule the brief sets for a screen; empty when the layout is clean.</summary>
        public List<string> Problems()
        {
            var p = new List<string>();
            foreach (var b in _boxes)
            {
                if (!b.Inside(CanvasW, CanvasH)) p.Add(Screen + ": outside 1600×900: " + b);
                if (b.Kind == BoxKind.Text && b.Size < BodyMin) p.Add(Screen + ": text under 16 px: " + b);
                if (Readable(b) && b.Overlaps(LanguageButton)) p.Add(Screen + ": under the language button: " + b);
            }
            int ctas = _boxes.Count(b => b.Kind == BoxKind.Cta);
            if (ctas > 1) p.Add(Screen + ": " + ctas + " calls to action (one per screen)");
            var readable = _boxes.Where(Readable).ToList();
            for (int i = 0; i < readable.Count; i++)
                for (int j = i + 1; j < readable.Count; j++)
                    if (readable[i].Overlaps(readable[j])) p.Add(Screen + ": overlap " + readable[i] + " / " + readable[j]);
            return p;
        }
    }

    /// <summary>The money screens' layouts. Each builder is one screen state; <see cref="All"/> lists every state the audit covers.</summary>
    public static class ShopLayout
    {
        // ---- shared frame: header (kicker, title, sub line) and the back button above the language button
        private static ScreenLayout Framed(string screen)
            => new ScreenLayout(screen).Kicker("head kicker", 40, 30, 900).Text("head title", 40, 58, 1000, 44, 30).Text("head sub", 40, 106, 1300, 24, 16).Ghost("back", 1380, 40, 180);

        /// <summary>Scout confirmation (prototype ScoutConfirm: dialog 1000×640). Coins: bar + split + after + notice; ticket: after only.</summary>
        public static ScreenLayout ScoutConfirm(bool coins)
        {
            var l = new ScreenLayout("scout confirm " + (coins ? "coins" : "ticket"))
                .Card("dialog", 300, 130, 1000, 640)
                .Kicker("kicker", 352, 170, 896)
                .Text("title", 352, 206, 896, 48, 34)
                .Text("spend", 352, 266, 896, 60, 22);
            if (coins) l.Shape("bar paid", 352, 340, 896, 12).Text("split", 352, 364, 896, 28, 18).Text("after", 352, 400, 896, 28, 18).Text("notice", 352, 436, 896, 28, 16);
            else l.Text("after", 352, 344, 896, 28, 18);
            return l.Text("pity", 352, 474, 896, 28, 17)
                .Ghost("odds", 352, 524, 330)
                .Ghost("close", 352, 682, 260)
                .Cta("pull", 798, 676, 450);
        }

        /// <summary>The ways to pull on a banner (tickets are offered here, where they are used). Up to 5 ways.</summary>
        public static ScreenLayout ScoutWays(int ways)
        {
            var l = new ScreenLayout("scout ways " + ways)
                .Card("panel", 40, 60, 620, 780)
                .Kicker("kicker", 78, 96, 540)
                .Text("title", 78, 128, 540, 48, 34)
                .Text("wallet", 78, 186, 540, 28, 18);
            for (int i = 0; i < Math.Min(ways, MaxWays); i++) l.Ghost("way " + i, 78, 236 + i * 76, 540);
            return l.Text("message", 78, 622, 540, 56, 16).Ghost("odds", 78, 700, 260).Ghost("back", 358, 700, 260);
        }
        public const int MaxWays = 5;

        /// <summary>Odds: the rarity totals of a banner or of the SR+ ticket's own table.</summary>
        public static ScreenLayout Odds(int rows)
        {
            var l = new ScreenLayout("odds " + rows).Card("dialog", 300, 130, 1000, 640).Kicker("kicker", 352, 170, 896).Text("title", 352, 204, 896, 44, 30);
            for (int i = 0; i < Math.Min(rows, MaxOddsRows); i++) l.Text("rarity " + i, 352, 270 + i * 44, 200, 32, 20).Text("rate " + i, 572, 270 + i * 44, 300, 32, 20);
            return l.Text("notice", 352, 560, 896, 72, 16).Cta("close", 352, 676, 360);
        }
        public const int MaxOddsRows = 6;

        /// <summary>
        /// The shop: tabs, the wallet, the first-purchase note, the tab's cards, the legal line. coins: up to 8 packs in 2×4;
        /// recommended: up to 4 cards in 2×2; looks: one card with the two ways to the try-on screens.
        /// </summary>
        public static ScreenLayout Shop(string tab, int cards)
        {
            var l = Framed("shop " + tab + " " + cards).Card("panel", 40, 150, 1520, 700);
            for (int i = 0; i < 4; i++) l.Ghost("tab " + i, 64 + i * 156, 170, 144);
            l.Text("wallet", 700, 188, 640, 28, 18).Text("note", 64, 248, 1270, 24, 16);
            if (tab == "coins")
                for (int i = 0; i < Math.Min(cards, MaxCoinPacks); i++)
                {
                    float x = 64 + (i % 2) * 748, y = 284 + (i / 2) * 106;
                    l.Card("pack " + i, x, y, 724, 96).Text("pack " + i + " price", x + 20, y + 30, 150, 32, 24)
                     .Text("pack " + i + " coins", x + 180, y + 12, 320, 30, 20).Text("pack " + i + " bonus", x + 180, y + 52, 320, 24, 16)
                     .Ghost("pack " + i + " buy", x + 520, y + 16, 184);
                }
            else if (tab == "recommended")
                for (int i = 0; i < Math.Min(cards, MaxRecommended); i++)
                {
                    float x = 64 + (i % 2) * 748, y = 284 + (i / 2) * 216;
                    l.Card("card " + i, x, y, 724, 204).Text("card " + i + " name", x + 20, y + 16, 480, 30, 22).Text("card " + i + " price", x + 520, y + 16, 184, 30, 22)
                     .Text("card " + i + " lines", x + 20, y + 54, 684, 52, 16).Text("card " + i + " tags", x + 20, y + 112, 460, 48, 16)
                     .Ghost("card " + i + " buy", x + 480, y + 124, 224);
                }
            else
                l.Card("looks", 64, 284, 1472, 300).Text("looks line", 88, 308, 1100, 56, 20).Ghost("looks silks", 88, 400, 360).Ghost("looks course", 468, 400, 360)
                 .Text("looks note", 88, 488, 1100, 48, 16);
            return l.Text("message", 64, 712, 1270, 24, 16).Text("legal", 64, 744, 1000, 48, 16).Text("checkout", 64, 800, 1270, 24, 16);
        }
        public const int MaxCoinPacks = 8, MaxRecommended = 4;

        /// <summary>T6 coin shortfall (prototype Shortfall: dialog 1080×660, closing is the call to action).</summary>
        public static ScreenLayout Shortfall(bool offer)
        {
            var l = new ScreenLayout("shortfall " + (offer ? "pack" : "none"))
                .Card("dialog", 260, 110, 1080, 690)
                .Kicker("kicker", 312, 150, 976)
                .Text("headline", 312, 184, 976, 48, 34)
                .Text("notes", 312, 240, 976, 48, 16);
            if (offer)
                l.Card("pack", 312, 300, 976, 240).Shape("pack art", 322, 314, 150, 212)
                 .Text("pack name", 494, 318, 520, 30, 22).Text("pack price", 1040, 318, 228, 30, 22)
                 .Text("pack contents", 494, 358, 774, 48, 16).Text("pack bonus", 494, 410, 774, 24, 16)
                 .Text("pack line", 494, 444, 540, 72, 16).Ghost("pack choose", 1050, 456, 218);
            else l.Card("none", 312, 300, 976, 160).Text("none line", 342, 330, 916, 72, 19);
            return l.Text("footer", 312, 560, 976, 48, 16).Cta("close", 312, 700, 380);
        }

        /// <summary>The purchase confirmation (prototype PurchaseConfirm: dialog 1100×820). The state area differs per stage.</summary>
        public static ScreenLayout PurchaseConfirm(PurchaseStage stage)
        {
            var l = new ScreenLayout("purchase " + stage)
                .Card("dialog", 250, 40, 1100, 820)
                .Kicker("kicker", 298, 72, 600)
                .Text("sub", 298, 102, 600, 24, 16)
                .Text("name", 298, 142, 680, 40, 30)
                .Text("price", 1000, 146, 302, 34, 26)
                .Text("lines", 298, 198, 1004, 150, 18)
                .Shape("rule", 298, 362, 1004, 2)
                .Kicker("state", 298, 380, 1004)
                .Text("message", 298, 412, 1004, 56, 18);
            if (stage == PurchaseStage.NeedsBirthMonth || stage == PurchaseStage.NeedsGuardian)
            {
                l.Text("year", 298, 488, 220, 40, 26).Ghost("year down", 530, 476, 80).Ghost("year up", 620, 476, 80)
                 .Text("month", 730, 488, 140, 40, 26).Ghost("month down", 880, 476, 80).Ghost("month up", 970, 476, 80)
                 .Text("age", 1080, 488, 220, 40, 26);
                if (stage == PurchaseStage.NeedsGuardian) l.Ghost("guardian", 298, 566, 520).Text("guardian note", 298, 642, 800, 24, 16);
            }
            else l.Text("lock", 298, 488, 1004, 72, 16);
            return l.Ghost("close", 298, 758, 220).Cta("go", 790, 752, 512);
        }

        /// <summary>The receipt (prototype Receipt: dialog 1100×780): a row per thing received, the wallet, the notes, ONE next step.</summary>
        public static ScreenLayout Receipt(int lines, bool next)
        {
            int n = Math.Min(lines, MaxReceiptLines);
            var l = new ScreenLayout("receipt " + n + (next ? " next" : ""))
                .Card("dialog", 250, 60, 1100, 780)
                .Kicker("kicker", 298, 96, 700)
                .Text("name", 298, 130, 680, 40, 30)
                .Text("price", 1000, 134, 302, 34, 26);
            for (int i = 0; i < n; i++)
                l.Text("row " + i + " mark", 298, 196 + i * 70, 30, 28, 20).Text("row " + i, 338, 196 + i * 70, 964, 28, 20).Text("row " + i + " sub", 338, 228 + i * 70, 964, 24, 16);
            float y = 196 + n * 70 + 12;
            l.Text("wallet", 298, y, 1004, 28, 18).Text("notes", 298, y + 40, 1004, 48, 16).Ghost("close", 298, 738, 220);
            return next ? l.Cta("next", 790, 732, 512) : l;
        }
        public const int MaxReceiptLines = 5;

        /// <summary>A purchase that cannot start here (a cosmetic shown with a proposed price, no product on the server yet).</summary>
        public static ScreenLayout LockedReview()
            => new ScreenLayout("locked review").Card("dialog", 250, 120, 1100, 600).Kicker("kicker", 298, 156, 700).Text("name", 298, 192, 1004, 40, 30)
                .Text("price", 298, 244, 1004, 30, 22).Text("lock", 298, 300, 1004, 96, 18).Ghost("close", 298, 620, 220);

        // ---- the season pass (prototype SeasonPass: preview on the left, level and the road, the tiers, the price line)

        public const int PassPageSize = 6;
        public const int PassChips = 6;

        /// <summary>The season pass screen: the try-on preview, the road of 30 with its standout marks, one page of tiers.</summary>
        public static ScreenLayout SeasonPass(int standouts, int maxLevel = 30)
        {
            var l = Framed("season pass " + standouts)
                .Card("preview", 40, 150, 388, 662)
                .Kicker("preview kicker", 64, 170, 340)
                .Shape("silks", 64, 200, 340, 210)
                .Text("silks parts", 64, 414, 340, 28, 16)
                .Text("try-on note", 64, 448, 340, 24, 16);
            int chips = Math.Min(standouts + 1, PassChips);
            for (int i = 0; i < chips; i++) l.Ghost("chip " + i, 64 + (i % 3) * 117, 480 + (i / 3) * 72, 106);
            l.Text("pick where", 64, 628, 340, 24, 16).Text("pick label", 64, 656, 340, 30, 21).Text("pick state", 64, 690, 340, 24, 16).Ghost("try-on", 64, 732, 340);
            l.Kicker("level kicker", 460, 150, 160).Text("level", 460, 178, 160, 60, 48).Text("xp", 640, 150, 700, 24, 16)
             .Shape("road", 640, 184, 700, 20);
            foreach (var lv in StandoutMarks(standouts, maxLevel)) l.Text("mark " + lv, RoadX(lv, maxLevel) - 20, 210, 40, 24, 16);
            l.Text("next", 640, 244, 900, 24, 16)
             .Ghost("page prev", 460, 280, 120).Ghost("page next", 590, 280, 120).Text("page", 724, 300, 440, 24, 16).Ghost("claim all", 1180, 280, 360);
            for (int c = 0; c < PassPageSize; c++) for (int r = 0; r < 2; r++) Cell(l, c, r);
            return l.Text("total", 460, 672, 1100, 24, 16).Text("price line", 460, 700, 1100, 24, 16)
                .Cta("buy", 460, 736, 440).Ghost("plus", 920, 742, 240).Ghost("allowance", 1180, 742, 360);
        }

        /// <summary>Tier cell (column c of the page, row 0 free / 1 premium).</summary>
        private static void Cell(ScreenLayout l, int c, int r)
        {
            float x = 460 + c * 180, y = 356 + r * 158;
            string k = "cell " + c + " " + r;
            l.Card(k, x, y, 170, 150).Text(k + " tier", x + 10, y + 6, 150, 24, 16).Text(k + " reward", x + 10, y + 32, 150, 46, 16).Ghost(k + " act", x + 10, y + 82, 150);
        }

        /// <summary>The levels marked on the road in the audit (the real screen marks the server's standouts at the same x).</summary>
        private static IEnumerable<int> StandoutMarks(int n, int max)
        {
            var marks = new[] { 10, 15, 20, 30, 25, 5 };
            return marks.Take(Math.Min(n, marks.Length)).Where(x => x <= max);
        }
        /// <summary>x of a level on the road (the road spans 640..1340).</summary>
        public static float RoadX(int level, int maxLevel) => 640 + 700f * Math.Max(0, Math.Min(level, maxLevel)) / Math.Max(1, maxLevel);
        /// <summary>The first level on the page that holds <paramref name="level"/> (pages of six).</summary>
        public static int PageStart(int level) => (Math.Max(1, level) - 1) / PassPageSize * PassPageSize + 1;

        /// <summary>Every screen state of the money area, for the audit.</summary>
        public static IEnumerable<ScreenLayout> All()
        {
            yield return ScoutConfirm(true);
            yield return ScoutConfirm(false);
            for (int w = 1; w <= MaxWays; w++) yield return ScoutWays(w);
            yield return Odds(MaxOddsRows);
            for (int n = 0; n <= MaxCoinPacks; n++) yield return Shop("coins", n);
            for (int n = 0; n <= MaxRecommended; n++) yield return Shop("recommended", n);
            yield return Shop("looks", 0);
            yield return Shortfall(true);
            yield return Shortfall(false);
            foreach (PurchaseStage s in Enum.GetValues(typeof(PurchaseStage))) yield return PurchaseConfirm(s);
            for (int n = 0; n <= MaxReceiptLines; n++) { yield return Receipt(n, true); yield return Receipt(n, false); }
            yield return LockedReview();
            for (int n = 0; n <= 5; n++) yield return SeasonPass(n);
        }
    }
}
