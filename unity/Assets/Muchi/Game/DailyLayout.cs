using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Muchi.Client;

namespace Muchi.Game
{
    // U1-A (docs/quality/unity-daily.md): the daily loop's screens — home, 目標, 調教 (choose / play / result), 機能 and the class
    // ladder — as plain rectangles on the 1600×900 reference canvas. Runtime/MuchiApp.Daily.cs draws exactly these boxes with
    // the screen kit (Card, Kicker, Body, Cta, Ghost), so GameChecks can audit what the player sees without Unity: every box
    // inside the canvas, no two text boxes overlapping, body text ≥ 16 px, text that fits its box, at most one CTA.
    //
    // Coordinates are the web prototype's (tools/figma-prototype/site/app.js: Home / GoalLadderPanel / Goals / Training /
    // TrainingPlay / TrainingResult), moved only where the Unity kit differs: body text 12–15 px there is 16 px here (rows grow
    // to fit), the kit's CTA is 76 px tall and its Ghost 64 px, and the language button (MuchiApp.Clear) sits at 1370,132 —
    // on the list screens it moves into the title row like the prototype's EN toggle.
    //
    // No game rules here: every figure and sentence comes from the models (GoalLadderModel, NextActionModel.HomeLine,
    // TrainingModel, ProfileModel); this file only places them. Texts are Japanese; the view shows Loc.T(text).

    public enum LayoutKind
    {
        /// <summary>A translucent navy panel (kit Card); with an Action the whole panel is tappable.</summary>
        Card,
        /// <summary>An invisible tap area (a menu row).</summary>
        Hit,
        /// <summary>A small letter-spaced cyan label (kit Kicker, 16 px).</summary>
        Kicker,
        Text,
        /// <summary>Tappable text (「やってみる ›」).</summary>
        Link,
        /// <summary>A thin progress bar; Fill 0..1.</summary>
        Gauge,
        /// <summary>A row of Count small squares, the first On filled, the next one outlined (stage of five, steps of ten).</summary>
        Pips,
        /// <summary>A short coloured rule or a hairline.</summary>
        Rule,
        /// <summary>The one skewed cyan call to action with 」»」 (kit Cta, 76 px tall).</summary>
        Cta,
        /// <summary>A secondary outlined action (kit Ghost, 64 px tall).</summary>
        Ghost,
        /// <summary>The app's language button (MuchiApp.Clear) — not drawn by the layout, only kept clear of.</summary>
        Chrome,
    }

    public sealed class LayoutBox
    {
        public string Id;
        public LayoutKind Kind;
        public float X, Y, W, H;
        /// <summary>Font size in px (text kinds).</summary>
        public int Size;
        /// <summary>The Japanese source (the view shows Loc.T).</summary>
        public string Text;
        /// <summary>white | soft | muted | dim | cyan | gold | ok | warn.</summary>
        public string Tone = "white";
        /// <summary>left | right | center.</summary>
        public string Align = "left";
        /// <summary>What a tap does (the view maps the id to a screen); null = not tappable.</summary>
        public string Action;
        public float Fill;
        public int Count, On;
        /// <summary>May take more than one line (H is sized for the lines).</summary>
        public bool Wrap;
        public bool Disabled, Selected;
        public bool IsText => Kind == LayoutKind.Kicker || Kind == LayoutKind.Text || Kind == LayoutKind.Link;
        public bool IsButton => Kind == LayoutKind.Cta || Kind == LayoutKind.Ghost || Kind == LayoutKind.Chrome;
        public override string ToString() => Kind + " " + Id + " (" + X + "," + Y + " " + W + "×" + H + ")" + (Text != null ? " 「" + Text + "」" : "");
    }

    /// <summary>One screen's boxes in drawing order (panels first).</summary>
    public sealed class ScreenLayout
    {
        public string Screen;
        public readonly List<LayoutBox> Boxes = new List<LayoutBox>();
        public ScreenLayout(string screen) { Screen = screen; }

        public LayoutBox Add(LayoutBox b) { Boxes.Add(b); return b; }
        public LayoutBox this[string id] => Boxes.FirstOrDefault(b => b.Id == id);
        public IEnumerable<LayoutBox> Texts => Boxes.Where(b => b.IsText || b.Kind == LayoutKind.Cta || b.Kind == LayoutKind.Ghost);
        public Frame At(float x, float y) => new Frame(this, x, y);

        /// <summary>Adds boxes relative to a panel's top-left corner.</summary>
        public sealed class Frame
        {
            private readonly ScreenLayout _l;
            public readonly float X, Y;
            public Frame(ScreenLayout l, float x, float y) { _l = l; X = x; Y = y; }
            public Frame At(float x, float y) => new Frame(_l, X + x, Y + y);

            public LayoutBox Card(string id, float x, float y, float w, float h, string action = null)
                => _l.Add(new LayoutBox { Id = id, Kind = LayoutKind.Card, X = X + x, Y = Y + y, W = w, H = h, Action = action });
            public LayoutBox Hit(string id, float x, float y, float w, float h, string action)
                => _l.Add(new LayoutBox { Id = id, Kind = LayoutKind.Hit, X = X + x, Y = Y + y, W = w, H = h, Action = action });
            public LayoutBox Kicker(string id, string text, float x, float y, float w)
                => text == null ? null : _l.Add(new LayoutBox { Id = id, Kind = LayoutKind.Kicker, Text = text, X = X + x, Y = Y + y, W = w, H = 24, Size = 16, Tone = "cyan" });
            /// <summary>One line of text (height = 1.4 × size, the UI font's line box).</summary>
            public LayoutBox Text(string id, string text, float x, float y, float w, int size, string tone = "white", string align = "left")
                => string.IsNullOrEmpty(text) ? null : _l.Add(new LayoutBox { Id = id, Kind = LayoutKind.Text, Text = text, X = X + x, Y = Y + y, W = w, H = (float)Math.Ceiling(size * 1.4), Size = size, Tone = tone, Align = align });
            /// <summary>Text that may wrap onto <paramref name="lines"/> lines.</summary>
            public LayoutBox Para(string id, string text, float x, float y, float w, int size, int lines, string tone = "soft")
                => string.IsNullOrEmpty(text) ? null : _l.Add(new LayoutBox { Id = id, Kind = LayoutKind.Text, Text = text, X = X + x, Y = Y + y, W = w, H = (float)Math.Ceiling(lines * size * LayoutAudit.LineHeight), Size = size, Tone = tone, Wrap = true });
            public LayoutBox Link(string id, string text, float x, float y, float w, string action, string tone = "cyan", string align = "left", int size = 16)
                => string.IsNullOrEmpty(text) ? null : _l.Add(new LayoutBox { Id = id, Kind = LayoutKind.Link, Text = text, X = X + x, Y = Y + y, W = w, H = size + 14, Size = size, Tone = tone, Align = align, Action = action });
            public LayoutBox Gauge(string id, float x, float y, float w, float fill, bool gold = false, float h = 4)
                => _l.Add(new LayoutBox { Id = id, Kind = LayoutKind.Gauge, X = X + x, Y = Y + y, W = w, H = h, Fill = Math.Max(0f, Math.Min(1f, fill)), Tone = gold ? "gold" : "cyan" });
            public LayoutBox Pips(string id, float x, float y, int count, int on, float pitch = 18)
                => _l.Add(new LayoutBox { Id = id, Kind = LayoutKind.Pips, X = X + x, Y = Y + y, W = count * pitch, H = 8, Count = count, On = on, Tone = "gold" });
            public LayoutBox Rule(string id, float x, float y, float w, float h, string tone = "cyan")
                => _l.Add(new LayoutBox { Id = id, Kind = LayoutKind.Rule, X = X + x, Y = Y + y, W = w, H = h, Tone = tone });
            public LayoutBox Cta(string id, string text, float x, float y, float w, string action, bool disabled = false)
                => _l.Add(new LayoutBox { Id = id, Kind = LayoutKind.Cta, Text = text, X = X + x, Y = Y + y, W = w, H = 76, Size = 27, Action = action, Disabled = disabled });
            public LayoutBox Ghost(string id, string text, float x, float y, float w, string action)
                => _l.Add(new LayoutBox { Id = id, Kind = LayoutKind.Ghost, Text = text, X = X + x, Y = Y + y, W = w, H = 64, Size = 21, Action = action });
        }
    }

    /// <summary>What home shows, read from the models by the screen (no rules here).</summary>
    public sealed class DailyHomeInput
    {
        public GoalLadderModel Goals;
        /// <summary>NextActionModel.HomeLine — null draws no line.</summary>
        public NextCardRow Next;
        public ProfileModel Profile;
        public bool Online;
        /// <summary>TrainingModel.SlotsLeft when training is open, else null.</summary>
        public int? TrainingSlotsLeft;
        /// <summary>UnlockGate.LockLabel("training") while training is closed.</summary>
        public string TrainingLock;
        public int Horses;
        /// <summary>Unity's other screens reachable from 機能 (wardrobe, course, conditions, care, season pass).</summary>
        public int Features = 5;
        public string ModeLabel;
    }

    public static class DailyLayout
    {
        public const float Width = 1600, Height = 900;
        /// <summary>MuchiApp.Clear's language button.</summary>
        public static readonly float[] LanguageHome = { 1370, 132, 195, 72 };
        /// <summary>The language button moved into the title row on the list screens (the prototype's EN toggle).</summary>
        public static readonly float[] LanguageTopBar = { 1394, 31, 170, 88 };
        /// <summary>The prototype's goal ladder box (GL_BOX), widened for 16 px text.</summary>
        public const float LadderX = 32, LadderY = 32, LadderW = 540, RungH = 50;
        public const string Ready = "受け取れる報酬があります";
        /// <summary>The kicker of the stage-up moment after training.</summary>
        public const string StageMomentKicker = "成長段階";
        /// <summary>A link to a screen Unity does not have yet (it says so instead of doing nothing).</summary>
        public const string NotYet = "この画面はUnity版でまだ準備中です";

        /// <summary>Where a goal step / 次にやること screen id leads in Unity (null = not built yet). The ids are §45.1's and the
        /// ladder's step screens; never the shop.</summary>
        public static string ScreenFor(string screen)
        {
            switch (screen)
            {
                case "race": case "first_race": return "race";
                case "scout": return "scout";
                case "silks": return "wardrobe";
                case "care": return "care";
                case "training": return "training";
                case "missions": case "login_bonus": return "goals";
                case "season_pass": return "pass";
                case "stable": return "stable";
                default: return null;
            }
        }

        static string N(int n) => n.ToString("#,0", CultureInfo.InvariantCulture);

        static void Chrome(ScreenLayout l, float[] at) => l.Add(new LayoutBox { Id = "language", Kind = LayoutKind.Chrome, X = at[0], Y = at[1], W = at[2], H = at[3], Text = "English", Size = 20 });

        static void Wallet(ScreenLayout.Frame f, ProfileModel p, float x, float y, float w, float h)
        {
            var c = f.At(x, y);
            c.Card("wallet", 0, 0, w, h);
            float half = (w - 40) / 2;
            c.Text("wallet.free.k", "無償", 28, h / 2 - 30, 120, 16, "muted");
            c.Text("wallet.free", "◎ " + N(p?.FreeCoins ?? 0), 28, h / 2 - 6, half - 12, 22, "gold");
            c.Text("wallet.paid.k", "有償", 28 + half, h / 2 - 30, 120, 16, "muted");
            c.Text("wallet.paid", "◈ " + N(p?.PaidCoins ?? 0), 28 + half, h / 2 - 6, half - 16, 22, "gold");
        }

        static void TopBar(ScreenLayout l, string title, string sub, ProfileModel p)
        {
            var f = l.At(0, 0);
            f.Card("header", 36, 31, 1000, 88);
            f.Rule("header.rule", 58, 49, 84, 3);
            f.Text("header.title", title, 58, 58, 950, 22);
            f.Text("header.sub", sub, 58, 90, 950, 16, "muted");
            Wallet(f, p, 1050, 31, 330, 88);
            Chrome(l, LanguageTopBar);
        }

        // ============================================================================================= home

        /// <summary>The home rungs as drawn: 「受け取れる報酬があります」 is said once, on the claim line under the ladder, so a ready
        /// rung keeps its own line (the prototype's GoalLadderPanel).</summary>
        public static List<GoalRung> HomeRungs(GoalLadderModel g)
        {
            var v = g?.View;
            if (v == null) return new List<GoalRung>();
            return g.Rungs.Select(r =>
            {
                if (r.Main != Ready) return r;
                string main = r.Key == "today" ? (v.Today.Complete ? "今日の目標は完了" : "今日の目標 " + v.Today.Done + "/" + v.Today.Total)
                    : r.Key == "path" ? g.PathStep?.Title ?? r.Label
                    : r.Key == "week2" ? g.Week2Short ?? "2週目" : r.Main;
                return new GoalRung { Key = r.Key, Label = r.Label, Main = main, Figure = r.Figure, Fill = r.Fill, Sub = r.Sub, Ready = r.Ready };
            }).ToList();
        }

        public static ScreenLayout Home(DailyHomeInput i)
        {
            var l = new ScreenLayout("home");
            var f = l.At(0, 0);
            Chrome(l, LanguageHome);

            // top left: the goal ladder (today / week 2 or the first steps / this week / the season); the panel opens 目標
            var rungs = HomeRungs(i.Goals);
            if (rungs.Count > 0)
            {
                bool anyReady = rungs.Any(r => r.Ready);
                var p = f.At(LadderX, LadderY);
                p.Card("ladder", 0, 0, LadderW, 16 + rungs.Count * RungH + (anyReady ? RungH : 0), "goals");
                for (int k = 0; k < rungs.Count; k++)
                {
                    var r = rungs[k];
                    var row = p.At(0, 8 + k * RungH);
                    if (r.Ready) row.Rule("rung." + r.Key + ".dot", 10, 17, 6, 6, "gold");
                    row.Text("rung." + r.Key + ".label", r.Label, 24, 8, 104, 16, "cyan");
                    row.Text("rung." + r.Key + ".main", r.Main, 132, 6, r.Figure != null ? 296 : 384, 16);
                    if (r.Figure != null) row.Text("rung." + r.Key + ".figure", r.Figure, 436, 5, 90, 17, "gold", "right");
                    row.Gauge("rung." + r.Key + ".gauge", 132, 36, 384, r.Fill, r.Ready, 3);
                }
                if (anyReady)
                {
                    var c = p.At(0, 8 + rungs.Count * RungH);
                    c.Text("ladder.claim", Ready + " ›", 24, 12, LadderW - 60, 17, "gold");
                }
            }

            Wallet(f, i.Profile, 1182, 33, 346, 77);

            // right: the thin-divider menu (厩舎 / 調教 / スカウト / 機能); 目標 is the ladder, not a row
            var m = f.At(1139, 222);
            var rows = new List<(string id, string name, string meta, string action, bool dot, bool locked)>
            {
                ("stable", "厩舎", i.Horses > 0 ? i.Horses + "頭" : null, "stable", false, false),
                i.TrainingSlotsLeft.HasValue
                    ? ("training", "調教", "今日あと" + i.TrainingSlotsLeft.Value + "回", "training", i.TrainingSlotsLeft.Value > 0, false)
                    : i.TrainingLock != null ? ("training", "調教", i.TrainingLock, "training_locked", false, true)
                    : ("training", "調教", null, "training", false, false),
                ("scout", "スカウト", null, "scout", false, false),
                ("features", "機能", i.Features + "件", "features", false, false),
            };
            m.Card("menu", 0, 0, 388, 20 + rows.Count * 70);
            for (int k = 0; k < rows.Count; k++)
            {
                var (id, label, meta, action, dot, locked) = rows[k];
                var r = m.At(0, 10 + k * 70);
                r.Hit("menu." + id, 16, 0, 356, 70, action);
                if (dot) r.Rule("menu." + id + ".dot", 22, 32, 6, 6, "gold");
                r.Text("menu." + id + ".name", label, 38, 20, 150, 20, locked ? "muted" : "white");
                r.Text("menu." + id + ".meta", meta, 190, 22, 164, 16, dot ? "gold" : "muted", "right");
                if (k < rows.Count - 1) r.Rule("menu." + id + ".hair", 38, 69, 316, 1, "line");
            }

            // bottom left: the partner plate — the name large, the growth stage of five, today's growth, the treat line
            var pg = i.Goals?.Partner;
            var pc = f.At(33, 598);
            pc.Card("partner", 0, 0, 470, 192, pg != null ? "partner_card" : "stable");
            string name = pg?.Name ?? i.Profile?.PartnerName;
            if (pg != null) pc.Rule("partner.rule", 29, 18, 56, 3, "gold");
            else pc.Kicker("partner.kicker", "あなたの相棒", 29, 18, 300);
            pc.Text("partner.name", name ?? "—", 29, pg != null ? 40 : 60, 420, 44);
            if (pg != null)
            {
                pc.Pips("partner.stage", 29, 114, pg.Stages, pg.Stage);
                string rarity = i.Profile?.PartnerRarity;
                pc.Text("partner.growth", (rarity != null ? rarity + "　·　" : "") + pg.Line, 134, 106, 220, 16);
                pc.Text("partner.delta", pg.DeltaLine, 354, 106, 86, 16, "gold", "right");
                pc.Gauge("partner.gauge", 29, 136, 411, pg.Fill, pg.DeltaLine != null, 3);
                if (pg.TreatLine != null) pc.Link("partner.treat", pg.TreatLine + " ›", 29, 146, 411, "training", "gold");
                else pc.Text("partner.next", pg.TrainLine ?? pg.NextLine, 29, 150, 411, 16, "muted");
            }
            else if (i.Profile != null && name != null) pc.Text("partner.line", PartnerLine(i.Profile), 29, 130, 420, 16, "muted");
            else pc.Text("partner.empty", "無料スカウトで相棒を迎えよう", 29, 130, 420, 16);

            // 次にやること: one slim line, only for what no other home element says (NextActionModel.HomeLine), one link at most
            var nx = i.Next;
            if (nx != null)
            {
                var n = f.At(540, 714);
                n.Card("next", 0, 0, 540, 72, "next");
                n.Kicker("next.kicker", nx.Kicker, 22, 8, 150);
                bool dismiss = NextActionModel.HomeLinks(nx).Count > 0;
                n.Text("next.deadline", nx.DeadlineText, 176, 6, dismiss ? 186 : 340, 16, "gold");
                n.Text("next.what", nx.Kind == "feature_unlocked" ? nx.Title + "　·　" + nx.Detail : nx.Title, 22, 36, 466, 18);
                n.Text("next.go", "›", 500, 34, 20, 20, "cyan");
                if (dismiss) n.Link("next.dismiss", "今日は閉じる", 372, 2, 150, "next_dismiss", "cyan", "right");
            }

            // bottom right: the race, the largest action
            f.Text("race.caption", i.Online ? "ランク戦　·　12頭　·　約90秒" : "練習レース　·　オフライン", 1134, 600, 392, 16);
            f.Cta("race", "レースへ", 1110, 636, 416, "race");
            f.Text("mode", i.ModeLabel, 1134, 724, 392, 16, "muted");

            // the tab crumbs (ホーム・厩舎・スカウト・ショップ・パス)
            var tabs = new[] { ("ホーム", "home"), ("厩舎", "stable"), ("スカウト", "scout"), ("ショップ", "shop"), ("パス", "pass") };
            float tx = 52;
            for (int k = 0; k < tabs.Length; k++)
            {
                if (k > 0) { f.Text("tab.sep" + k, "・", tx, 830, 20, 18, "muted"); tx += 20; }
                f.Link("tab." + tabs[k].Item2, tabs[k].Item1, tx, 826, 96, tabs[k].Item2, k == 0 ? "cyan" : "white", "center", 18);
                tx += 96;
            }
            return l;
        }

        /// <summary>「SR　·　差し　·　芝 1,600〜2,400m」 (the plate without growth data: an older server or offline).</summary>
        public static string PartnerLine(ProfileModel p)
        {
            string style = p.PartnerStyle == "nige" ? "逃げ" : p.PartnerStyle == "senko" ? "先行" : p.PartnerStyle == "oikomi" ? "追込" : "差し";
            string surface = p.PartnerSurface == "dirt" ? "ダート" : "芝";
            return p.PartnerRarity + "　·　" + style + "　·　" + surface + " " + N(p.PartnerDistMinM) + "〜" + N(p.PartnerDistMaxM) + "m";
        }

        // ============================================================================================= 目標

        public const float ColY = 134, ColW = 490, ColH = 600;
        public static readonly float[] ColX = { 36, 555, 1074 };

        public static ScreenLayout Goals(GoalLadderModel g, ProfileModel p, long nowMs)
        {
            var l = new ScreenLayout("goals");
            var v = g.View;
            TopBar(l, "目標　/　今日 → 今週 → シーズン", v == null ? null : "今日の分は " + GameDay.NextResetLabel(nowMs) + " に更新　·　報酬は1回でまとめて受け取れます", p);
            var f = l.At(0, 0);
            if (v == null)
            {
                f.Card("empty", ColX[0], ColY, ColW, 200);
                f.Para("empty.text", "目標を読み込めませんでした", ColX[0] + 32, ColY + 40, ColW - 64, 18, 2, "white");
                f.Ghost("back", "ホームへ", 36, 760, 220, "home");
                return l;
            }
            const float W = ColW - 64;

            // ① 今日
            var c1 = f.At(ColX[0], ColY);
            c1.Card("today", 0, 0, ColW, ColH);
            c1.Kicker("today.kicker", "今日", 32, 24, 200);
            if (v.Today.Open)
            {
                c1.Text("today.figure", v.Today.Done + "/" + v.Today.Total, 330, 52, 128, 30, "gold", "right");
                // what tomorrow brings (gold, once today is done) else today's / tomorrow's login bonus
                if (g.TomorrowLine != null && v.Today.Complete) c1.Text("today.tomorrow", g.TomorrowLine, 32, 98, W, 16, "gold");
                else c1.Text("today.login", g.LoginLine, 32, 98, W, 16, "muted");
                for (int k = 0; k < g.Today.Count && k < 5; k++) GoalRow(c1, "today." + k, g.Today[k], 32, 124 + k * 94, W);
            }
            else
            {
                c1.Para("today.closed", "デイリーミッションはまだ開いていません。まずは「はじめの10歩」から。", 32, 72, W, 16, 2, "muted");
                TomorrowBlock(c1, g, 32, 140, W);
            }

            // ② 2週目 / はじめの10歩 / 今週
            var c2 = f.At(ColX[1], ColY);
            c2.Card("week", 0, 0, ColW, ColH);
            bool arc = v.Week2 != null && (v.Path == null || v.Path.Step == v.Path.Steps);
            bool compact = arc || v.Path != null;
            float wy;
            if (arc)
            {
                c2.Kicker("week.kicker", v.Week != null ? "2週目　/　今週" : "2週目", 32, 24, 300);
                Week2Strip(c2, g, 92);
                wy = 284;
            }
            else if (v.Path != null && v.Week != null)
            {
                c2.Kicker("week.kicker", "はじめの" + v.Path.Steps + "歩　/　今週", 32, 24, 300);
                PathBlock(c2, g, 92, true);
                wy = 296;
            }
            else if (v.Path != null)
            {
                c2.Kicker("week.kicker", "はじめの" + v.Path.Steps + "歩", 32, 24, 260);
                c2.Text("path.figure", v.Path.Done + "/" + v.Path.Steps, 330, 52, 128, 30, "gold", "right");
                PathBlock(c2, g, 92, false);
                c2.Para("path.note", "1歩ずつ順に受け取ります。週替わりチャレンジ・ライバルが開くと、ここに「今週」の目標も並びます。", 32, 500, W, 16, 3);
                wy = 0;
            }
            else
            {
                c2.Kicker("week.kicker", "今週", 32, 24, 200);
                wy = 118;
            }
            var w = v.Week;
            if (v.Path == null && w == null && !arc) c2.Para("week.none", "週替わりチャレンジ・ライバルが開くと、ここに並びます。", 32, 118, W, 16, 2, "muted");
            if (w != null && wy > 0)
            {
                c2.Text("week.until", GameDay.UntilLabel(w.EndsAt), 196, 56, 262, 16, "muted", "right");
                float step = compact ? 100 : 132;
                int rowsLeft = compact ? 3 : 4;
                if (w.HasChallenge && rowsLeft-- > 0)
                {
                    WeekRow(c2, "week.challenge", wy, "週替わりチャレンジ", w.ChallengeCleared + "/" + w.ChallengeTotal, (float)w.ChallengeCleared / Math.Max(1, w.ChallengeTotal),
                        UxText.Reward(w.ChallengeReward, GoalLadderModel.ItemName) + (w.BadgeName != null ? "　·　3つで「" + w.BadgeName + "」" : ""), "weekly_challenge");
                    wy += step;
                }
                if (w.HasRivalResult && rowsLeft-- > 0)
                {
                    WeekRow(c2, "week.rival_result", wy, "先週のライバル", w.RivalResultMe + " - " + w.RivalResultThem, null,
                        RivalOutcome(w.RivalResultOutcome) + (w.RivalResultCoins > 0 ? "　·　無償コイン" + N(w.RivalResultCoins) + "枚" : ""), "rival");
                    wy += step;
                }
                if (w.HasRival && !(compact && w.HasRivalResult && w.HasChallenge) && rowsLeft-- > 0)
                {
                    string sub = w.RivalRankedRaces < w.RivalMinRaces ? "ランク戦 " + w.RivalRankedRaces + "/" + w.RivalMinRaces + "戦で結果が出ます" : "同じランク戦で先着すれば1点";
                    WeekRow(c2, "week.rival", wy, "ライバル", w.RivalMe + " - " + w.RivalThem, null, "勝ち越すと 無償コイン" + N(w.RivalWinCoins) + "枚　·　" + sub, "rival");
                    wy += step;
                }
                if (w.HasTeamGoal && rowsLeft-- > 0)
                    WeekRow(c2, "week.team", wy, "支部の共同目標", w.TeamReached + "/" + w.TeamTiers + "段", (float)w.TeamReached / Math.Max(1, w.TeamTiers),
                        w.TeamNextTarget.HasValue ? "次の段まで " + N(w.TeamNextTarget.Value - w.TeamProgress) : "すべての段に届きました", "team_goal");
            }

            // ③ シーズン: the class line, the own pace, why climb, the season missions
            var s = v.Season;
            var c3 = f.At(ColX[2], ColY);
            c3.Card("season", 0, 0, ColW, ColH);
            c3.Kicker("season.kicker", "シーズン", 32, 24, 200);
            c3.Text("season.until", GameDay.UntilLabel(s.EndsAt), 196, 56, 262, 16, "muted", "right");
            float linkY;
            if (s.Status == "rookie")
            {
                c3.Text("season.rookie", "ルーキー", 32, 86, 300, 30);
                c3.Text("season.rookie.sub", "ランク戦でクラスが決まります", 32, 132, W, 16, "muted");
                linkY = 176;
            }
            else
            {
                c3.Text("season.class", s.ClassId + "級", 32, 86, 160, 34);
                c3.Text("season.points", s.Line == null ? N(s.Points) + "pt" : N(s.Points) + " / " + N(s.Line.Value) + "pt", 200, 94, 258, 22, "gold", "right");
                c3.Gauge("season.gauge", 32, 134, W, s.Line.HasValue && s.Line.Value > 0 ? (float)s.Points / s.Line.Value : 1f, s.Status != "climbing");
                c3.Para("season.line", SeasonLine(g), 32, 146, W, 16, 2, "white");
                if (g.PowerLine != null)
                {
                    c3.Text("why.kicker", "なぜ上をめざす？", 32, 196, 300, 16, "cyan");
                    c3.Text("why.power", g.PowerLine, 32, 222, W, 16);
                    c3.Gauge("why.bar", 32, 252, W, s.PowerTotal > 0 ? (float)s.PowerUsable / s.PowerTotal : 0f, false, 6);
                    c3.Text("why.line", g.WhyClimbLine, 32, 264, W, 16, s.PowerHeld == 0 ? "ok" : "gold");
                }
                linkY = 296;
            }
            c3.Link("season.ladder", "クラスの階段 ›", 32, linkY, 210, "class_ladder");
            if (g.CapCardLink != null) c3.Link("season.cap", g.CapCardLink + " ›", 248, linkY, 210, "cap_card", "cyan", "right");
            c3.Text("missions.kicker", "シーズンミッション", 32, 344, 220, 16, "cyan");
            if (g.PassLine != null) c3.Link("missions.pass", g.PassLine + " ›", 258, 338, 200, "pass", "gold", "right");
            for (int k = 0; k < g.SeasonMissions.Count && k < 5; k++) MiniRow(c3, "mission." + k, g.SeasonMissions[k], 32, 378 + k * 44, W);

            // the one claim (the screen's only filled CTA); otherwise a quiet line
            if (g.ClaimText != null) f.Cta("claim", g.ClaimText, ColX[2], 748, ColW, "claim");
            else f.Text("claim.none", v.Today.Complete ? "今日の目標は完了　·　" + GameDay.NextResetLabel(nowMs) + " に更新" : "受け取れる報酬はありません", ColX[2], 770, ColW, 16, "muted", "right");
            f.Ghost("back", "ホームへ", 36, 760, 220, "home");
            return l;
        }

        static string SeasonLine(GoalLadderModel g)
        {
            var s = g.View.Season;
            if (s.Status == "top") return "最上位クラス";
            if (s.Status == "line_reached")
                return s.PromotionStatus == "active" && s.PromotionNext.HasValue ? "昇級ラインに到達　·　昇級戦 " + s.PromotionNext.Value + "/" + s.PromotionRaces : "昇級ラインに到達　·　シーズンの締めで " + s.NextClassId + "級へ";
            return "昇級まで あと" + N(s.Left ?? 0) + "pt" + (g.PaceLine != null ? "　·　" + g.PaceLine : "");
        }

        static string RivalOutcome(string o) => o == "win" ? "勝ち越し" : o == "lose" ? "負け越し" : o == "draw" ? "引き分け" : o == "no_contest" ? "勝負なし" : o == "not_enough" ? "レース数が足りませんでした" : "";

        /// <summary>A goal row: title and progress, the gauge, the reward and what it does (86 px).</summary>
        static void GoalRow(ScreenLayout.Frame f, string id, LadderGoalRow r, float x, float y, float w, string prefix = "")
        {
            var c = f.At(x, y);
            bool tick = r.Claimed || (r.Done && r.Auto);
            c.Text(id + ".title", (tick ? "✓ " : "") + prefix + r.Title, 0, 0, w - 110, 18, r.Claimed ? "ok" : "white");
            c.Text(id + ".progress", r.ProgressText, w - 110, 0, 110, 18, r.Claimable ? "gold" : "muted", "right");
            c.Gauge(id + ".gauge", 0, 30, w, r.Fill, r.Claimable, 3);
            c.Text(id + ".reward", r.RewardText + (r.Auto ? "（1着で自動）" : ""), 0, 38, w, 16, "gold");
            c.Text(id + ".purpose", r.PurposeText, 0, 62, w, 16, "soft");
        }

        static void MiniRow(ScreenLayout.Frame f, string id, LadderGoalRow r, float x, float y, float w)
        {
            var c = f.At(x, y);
            c.Text(id + ".title", (r.Claimed ? "✓ " : "") + r.Title, 0, 0, 200, 16, r.Claimed ? "ok" : "white");
            c.Text(id + ".progress", r.ProgressText, 200, 0, 96, 16, r.Claimable ? "gold" : "muted", "right");
            c.Text(id + ".reward", r.RewardText, 300, 0, w - 300, 16, "gold", "right");
            c.Gauge(id + ".gauge", 0, 30, w, r.Fill, r.Claimable, 2);
        }

        static void WeekRow(ScreenLayout.Frame f, string id, float y, string title, string figure, float? fill, string sub, string action)
        {
            var c = f.At(32, y);
            c.Hit(id, 0, -6, 426, 96, action);
            c.Text(id + ".title", title + " ›", 0, 0, 300, 18);
            c.Text(id + ".figure", figure, 300, -2, 126, 20, "gold", "right");
            if (fill.HasValue) c.Gauge(id + ".gauge", 0, 34, 426, fill.Value, false, 3);
            c.Para(id + ".sub", sub, 0, 42, 426, 16, 2, "muted");
        }

        /// <summary>REQ-GOAL-013: 「明日」 and one fact per line.</summary>
        static void TomorrowBlock(ScreenLayout.Frame f, GoalLadderModel g, float x, float y, float w)
        {
            if (g.TomorrowLines.Count == 0) return;
            var c = f.At(x, y);
            c.Text("tomorrow.kicker", "明日", 0, 0, 120, 16, "cyan");
            c.Text("tomorrow.at", g.TomorrowAt, w - 160, 0, 160, 16, "muted", "right");
            for (int k = 0; k < g.TomorrowLines.Count && k < 6; k++) c.Text("tomorrow." + k, g.TomorrowLines[k], 0, 30 + k * 30, w, 16);
        }

        /// <summary>REQ-GOAL-019: seven days, one reason each; the peak marked, today outlined; the headline and graduation's day.</summary>
        static void Week2Strip(ScreenLayout.Frame f, GoalLadderModel g, float y)
        {
            const float W = 448, Cw = 64;
            var strip = f.At(21, y);
            for (int k = 0; k < g.Week2Days.Count && k < 7; k++)
            {
                var d = g.Week2Days[k];
                var c = strip.At(k * Cw, 0);
                var cell = c.Card("w2." + d.PlayerDay, 0, 0, Cw - 2, 96);
                cell.Selected = d.Today;
                c.Text("w2." + d.PlayerDay + ".day", d.DayLabel, 0, 8, Cw, 16, d.Today ? "cyan" : "muted", "center");
                string word = d.Past ? "✓" : d.GraduateText != null ? "卒業" : d.ShortText ?? "—";
                c.Text("w2." + d.PlayerDay + ".word", word, 0, 38, Cw, 16, d.Past ? "ok" : d.GraduateText != null || d.Peak ? "gold" : "white", "center");
                if (d.Peak && !d.Past) c.Text("w2." + d.PlayerDay + ".peak", "★", 0, 64, Cw, 16, "gold", "center");
                else if (d.GraduateText != null && d.ShortText != null && !d.Past) c.Text("w2." + d.PlayerDay + ".sub", d.ShortText, 0, 64, Cw, 16, "muted", "center");
            }
            f.Text("w2.goal", g.Week2Goal, 32, y + 108, W - 22, 16, "gold");
            var cur = g.PathStep;
            if (cur != null && cur.Claimable) f.Para("w2.claimable", "はじめの10歩の卒業を受け取れます（まとめて受け取る）", 32, y + 136, W - 22, 16, 2, "white");
            else if (g.PathWaitText != null && cur != null) f.Para("w2.wait", "はじめの10歩：" + cur.RewardText + "　·　" + g.PathWaitText, 32, y + 136, W - 22, 16, 2, "muted");
            else f.Para("w2.why", "毎日のログインボーナスが、この週の1日ずつの理由です", 32, y + 136, W - 22, 16, 2, "soft");
        }

        /// <summary>The first steps: pips, the current step, where it is done (or why not yet), the solo way, the last reward.</summary>
        static void PathBlock(ScreenLayout.Frame f, GoalLadderModel g, float y, bool compact)
        {
            var path = g.View.Path;
            var it = g.PathStep;
            const float W = 426;
            f.Pips("path.pips", 32, y, path.Steps, path.Done, 22);
            if (compact)
            {
                f.Text("path.title", path.Step + ". " + it.Title, 32, y + 20, 300, 18);
                f.Text("path.progress", it.ProgressText, 332, y + 20, 126, 18, it.Claimable ? "gold" : "muted", "right");
                f.Text("path.reward", it.RewardText + "　·　最後に " + UxText.Reward(path.FinalReward, GoalLadderModel.ItemName), 32, y + 50, W, 16, "gold");
                StepLinks(f, g, y + 78);
                return;
            }
            GoalRow(f, "path.row", it, 32, y + 24, W, path.Step + ". ");
            StepLinks(f, g, y + 116);
            f.Rule("path.hair", 32, y + 214, W, 1, "line");
            f.Text("path.final.kicker", "最後の歩の報酬", 32, y + 226, 300, 16, "cyan");
            f.Text("path.final", UxText.Reward(path.FinalReward, GoalLadderModel.ItemName), 32, y + 254, W, 20, "gold");
            f.Text("path.final.purpose", GoalLadderModel.ItemPurpose(path.FinalReward), 32, y + 286, W, 16, "soft");
        }

        /// <summary>REQ-GOAL-015/017: 「やってみる ›」 where the step is done, or when it can be received / why it is not open; the solo
        /// way 「ひとりでも：…」 on its own line under it.</summary>
        static void StepLinks(ScreenLayout.Frame f, GoalLadderModel g, float y)
        {
            var it = g.PathStep;
            if (it == null || it.Claimable) return;
            if (g.PathWaitText != null) f.Text("path.wait", g.PathWaitText, 32, y, 426, 16, "gold", "right");
            else if (g.PathLockText != null) f.Text("path.lock", g.PathLockText, 32, y, 426, 16, "muted", "right");
            else if (g.PathScreen != null) f.Link("path.go", "やってみる ›", 278, y - 4, 180, "step:" + g.PathScreen, "cyan", "right");
            if (g.PathAltLine != null && g.PathWaitText == null) f.Link("path.alt", g.PathAltLine + " ›", 32, y + 28, 426, "step:" + (g.PathAltScreen ?? "training"));
        }

        // ============================================================================================= 調教

        public static ScreenLayout Training(TrainingModel t, ProfileModel p, string selectedMenu, long nowMs)
        {
            var l = new ScreenLayout("training");
            var v = t.View;
            TopBar(l, "調教　/　" + (t.SlotsText ?? "今日の調教"), "タイミングよく押すと、伸びが少しだけ良くなります", p);
            var f = l.At(0, 0);
            var h = t.Horse;
            var hp = f.At(36, 134);
            hp.Card("horse", 0, 0, 560, 676);
            hp.Kicker("horse.kicker", "相棒　/　" + (v?.Horses.Count ?? 0) + "頭", 36, 30, 400);
            if (h == null)
            {
                hp.Para("horse.none", t.Message ?? "調教できる馬がいません", 36, 100, 488, 20, 3, "white");
                f.Ghost("back", "ホームへ", 36, 822, 220, "home");
                return l;
            }
            hp.Text("horse.name", h.Name, 36, 82, 330, 36);
            if (v.Horses.Count > 1) hp.Ghost("horse.next", "別の馬", 380, 76, 144, "next_horse");
            hp.Text("horse.info", h.Rarity + "　·　調子 " + TrainingModel.ConditionText(h.Condition) + "　·　絆 Lv" + h.BondLevel, 36, 150, 488, 16, "gold");
            hp.Text("fatigue.k", "疲れ", 36, 194, 200, 18);
            hp.Text("fatigue.v", h.Fatigue + " / " + v.FatigueMax, 344, 194, 180, 18, t.FatigueWarning ? "warn" : "gold", "right");
            var fg = hp.Gauge("fatigue.gauge", 36, 226, 488, t.FatigueProgress, false, 6);
            if (t.FatigueWarning) fg.Tone = "warn";
            hp.Para("fatigue.note", "1日休むと " + v.RecoveryPerDay + " 回復。疲れていると伸びが落ちます（レースには影響しません）", 36, 238, 488, 16, 2);
            var stage = GrowthStages.Of(h.TrainedTotal, h.Potential);
            hp.Text("potential.k", "素質　·　" + stage.Name, 36, 300, 300, 18);
            hp.Text("potential.v", h.TrainedTotal + " / " + h.Potential, 344, 300, 180, 18, "gold", "right");
            hp.Gauge("potential.gauge", 36, 332, 488, t.PotentialProgress, true, 6);
            if (stage.NextAt >= 0) hp.Text("potential.next", GrowthStages.Ja[stage.Index + 1] + "まで あと" + Math.Max(0, stage.NextAt - h.TrainedTotal), 224, 342, 300, 16, "soft", "right");
            var keys = new[] { "speed", "stamina", "burst", "guts", "temper" };
            for (int j = 0; j < keys.Length; j++)
            {
                int val = Stat(h.Trained, keys[j]);
                var c = hp.At(36 + (j % 3) * 168, 380 + (j / 3) * 40);
                c.Text("stat." + keys[j], TrainingModel.StatNames[keys[j]], 0, 0, 92, 16, "muted");
                c.Text("stat." + keys[j] + ".v", "+" + val, 92, -2, 64, 18, val > 0 ? "white" : "dim");
            }
            if (t.TreatLine != null)
            {
                // REQ-ITEM-010: the treat when it matters — what it changes (the server's numbers) and one button
                hp.Text("treat.line", t.TreatLine, 36, 470, 300, 16, "gold");
                hp.Text("treat.fatigue", t.TreatFatigueLine, 36, 498, 300, 16, "muted");
                hp.Ghost("treat.give", "おやつをあげる", 344, 466, 180, "treat");
            }
            else if (t.CanUseItem) hp.Ghost("item", t.Apple.Name + "（" + t.Apple.Owned + "）", 36, 466, 300, "item");
            else hp.Para("item.none", "りんごのおやつはデイリーミッション「調教を1回」でもらえます", 36, 474, 488, 16, 2, "dim");
            hp.Para("rules", TrainingModel.RulesText, 36, 550, 488, 16, 5);

            // ② the menus (2 × 2): one is chosen, then the one CTA
            var mp = f.At(620, 134);
            mp.Card("menus", 0, 0, 944, 676);
            mp.Kicker("menus.kicker", "メニュー", 36, 30, 300);
            var cards = t.Cards;
            for (int k = 0; k < cards.Count && k < 4; k++)
            {
                var m = cards[k];
                var c = mp.At(36 + (k % 2) * 444, 78 + (k / 2) * 226);
                var card = c.Card("menu." + m.Id, 0, 0, 428, 210, m.Enabled ? "menu:" + m.Id : "menu_blocked:" + m.Id);
                card.Selected = m.Id == selectedMenu && m.Enabled;
                card.Disabled = !m.Enabled;
                c.Text("menu." + m.Id + ".name", m.Name, 24, 20, 190, 26, m.Enabled ? "white" : "dim");
                c.Text("menu." + m.Id + ".fatigue", m.FatigueText, 220, 28, 184, 16, (v.Menu(m.Id)?.Fatigue ?? 0) < 0 ? "ok" : "muted", "right");
                c.Text("menu." + m.Id + ".focus", m.FocusText, 24, 70, 380, 18, m.Enabled ? "gold" : "dim");
                var menu = v.Menu(m.Id);
                c.Text("menu." + m.Id + ".gain", (m.BondText != null ? m.BondText + "　·　" : "") + "伸び " + (menu?.BaseGain ?? 0), 24, 102, 380, 16, "muted");
                if (!m.Enabled) c.Para("menu." + m.Id + ".blocked", m.BlockedText, 24, 140, 380, 16, 2, "warn");
                else if (m.OutlookText != null)
                {
                    c.Text("menu." + m.Id + ".outlook", "この馬なら " + m.OutlookText, 24, 136, 380, 20);
                    c.Text("menu." + m.Id + ".why", m.OutlookReason, 24, 172, 380, 16, "muted");
                }
            }
            var sel = cards.FirstOrDefault(c => c.Id == selectedMenu && c.Enabled);
            mp.Cta("go", sel != null ? sel.Name + "で調教" : "メニューを選ぶ", 36, 560, 428, "start", sel == null);
            mp.Para("slots", "今日 " + v.UsedToday + " / " + v.SlotsPerDay + " 回　·　1頭 1日 " + v.PerHorsePerDay + " 回まで　·　" + GameDay.NextResetLabel(nowMs) + " に戻ります", 490, 572, 420, 16, 2);
            f.Ghost("back", "ホームへ", 36, 822, 220, "home");
            return l;
        }

        static int Stat(Stats s, string k) => k == "speed" ? s.Speed : k == "stamina" ? s.Stamina : k == "burst" ? s.Burst : k == "guts" ? s.Guts : s.Temper;

        /// <summary>The beat lane: markers slide onto the hit line (the view moves them); the CTA is 「追う」.</summary>
        public const float LaneX = 36, LaneY = 610, LaneW = 1100, LaneH = 120, HitLineX = 120, BeatSize = 48;

        /// <summary>The flash for a tap's judgement (TrainingModel.Tap): ◎ / ○ / ×.</summary>
        public static string JudgeText(string judgement) => judgement == "perfect" ? "◎" : judgement == "good" ? "○" : judgement == null ? "" : "×";
        /// <summary>The live count during the mini-game: 「◎3　○1」.</summary>
        public static string ScoreText(TimingScore s) => "◎" + s.Perfect + "　○" + s.Good;

        public static ScreenLayout TrainingPlay(TrainingModel t)
        {
            var l = new ScreenLayout("training-play");
            var f = l.At(0, 0);
            Chrome(l, LanguageHome);
            var menu = t.View?.Menu(t.Session?.MenuId ?? t.Started?.Session?.MenuId);
            var head = f.At(36, 31);
            head.Card("head", 0, 0, 760, 108);
            head.Kicker("head.kicker", "調教　/　" + (menu?.Name ?? ""), 22, 14, 600);
            head.Text("head.how", "光る印が線に重なった瞬間に「追う」", 22, 42, 720, 24);
            head.Text("head.preview", t.PreviewText, 22, 78, 720, 16, "muted");
            f.Ghost("skip", "スキップ", 1150, 31, 200, "skip");
            f.Text("judge", "READY", LaneX, 500, LaneW, 48, "gold", "center");
            f.Text("score", ScoreText(new TimingScore()), 1180, 540, 380, 22, "white", "right");
            f.Card("lane", LaneX, LaneY, LaneW, LaneH);
            f.Rule("lane.line", LaneX + HitLineX, LaneY + 14, 4, LaneH - 28, "cyan");
            f.Cta("whip", "追う", 1196, 632, 340, "tap");
            return l;
        }

        public static ScreenLayout TrainingResult(TrainingModel t, bool claimable)
        {
            var l = new ScreenLayout("training-result");
            var f = l.At(0, 0);
            Chrome(l, LanguageHome);
            var r = t.Result;
            var d = f.At(36, 110);
            d.Card("result", 0, 0, 800, 720);
            if (r == null) { d.Para("result.none", t.Message ?? "調教が始まっていません", 40, 80, 720, 20, 2, "white"); f.Cta("continue", "つづける", 76, 720, 360, "continue"); return l; }
            d.Kicker("result.kicker", "調教　/　" + (r.Settled == "done" ? "結果" : "ミニゲームなし"), 40, 30, 600);
            d.Text("result.grade", t.GradeText, 40, 76, 700, 28);
            d.Text("result.total", r.Total > 0 ? "+" + r.Total : "±0", 40, 118, 220, 80, "gold");
            d.Text("result.gain", t.GainText, 270, 140, 490, 20);
            d.Text("result.timing", t.TimingText, 270, 178, 490, 16, "muted");
            d.Text("result.stage", t.StageUp ? t.StageUpText : "成長段階　" + t.StageText + (t.StageNextText != null ? "　·　" + t.StageNextText : ""), 40, 242, 720, 18, t.StageUp ? "gold" : "muted");
            d.Text("result.growth.k", "調教の伸び", 40, 292, 200, 16, "muted");
            var keys = new[] { "speed", "stamina", "burst", "guts", "temper" };
            int cap = Math.Max(1, t.Horse?.PerStatCap ?? (int)(r.Potential * 0.4));
            for (int k = 0; k < keys.Length; k++)
            {
                int after = Stat(r.Trained, keys[k]), gain = Stat(r.Gain, keys[k]);
                var c = d.At(40, 324 + k * 38);
                c.Text("growth." + keys[k], TrainingModel.StatNames[keys[k]], 0, 0, 120, 16, gain > 0 ? "white" : "muted");
                c.Gauge("growth." + keys[k] + ".bar", 130, 10, 420, (float)after / cap, gain > 0, 6);
                c.Text("growth." + keys[k] + ".v", after + " / " + cap, 560, 0, 90, 16, "muted", "right");
                if (gain > 0) c.Text("growth." + keys[k] + ".gain", "+" + gain, 660, -1, 60, 18, "gold", "right");
            }
            d.Text("potential.k", "素質", 40, 516, 200, 18);
            d.Text("potential.v", r.TrainedTotal + " / " + r.Potential, 560, 516, 200, 18, "gold", "right");
            d.Gauge("potential.gauge", 40, 548, 720, r.Potential > 0 ? (float)r.TrainedTotal / r.Potential : 0f, true, 6);
            d.Text("result.fatigue", "疲れ " + r.Fatigue + (r.Capped ? "　·　素質いっぱいまで伸びました" : ""), 40, 564, 720, 16, "dim");
            d.Cta("continue", "つづける", 40, 610, 360, "continue");
            if (claimable) d.Ghost("claim", "目標の報酬を受け取る", 430, 616, 330, "claim");
            return l;
        }

        // ============================================================================================= 機能 / クラスの階段

        /// <summary>Unity's other screens (the prototype's 機能 sheet): each opens the existing screen.</summary>
        public static readonly (string Name, string Action)[] FeatureRows =
        {
            ("着せ替え", "wardrobe"), ("コース", "course"), ("コンディション", "conditions"), ("飼い葉", "care"), ("シーズンパス", "pass"),
        };

        public static ScreenLayout Features(ProfileModel p)
        {
            var l = new ScreenLayout("features");
            TopBar(l, "機能・イベント", "開放されている機能", p);
            var f = l.At(36, 134);
            f.Card("features", 0, 0, 560, 100 + FeatureRows.Length * 80);
            f.Kicker("features.kicker", "機能", 36, 30, 300);
            for (int k = 0; k < FeatureRows.Length; k++) f.Ghost("feature." + FeatureRows[k].Action, FeatureRows[k].Name, 36, 80 + k * 80, 488, FeatureRows[k].Action);
            l.At(0, 0).Ghost("back", "ホームへ", 36, 822, 220, "home");
            return l;
        }

        public static ScreenLayout ClassLadder(GoalLadderModel g, ProfileModel p)
        {
            var l = new ScreenLayout("class-ladder");
            TopBar(l, "クラスの階段", "ランク戦", p);
            var f = l.At(36, 134);
            var rows = Enumerable.Reverse(g.Ladder).ToList();
            f.Card("ladder", 0, 0, 1000, 120 + rows.Count * 132);
            f.Para("ladder.note", "クラスごとに、ランク戦で使える能力の合計に上限があります。上のクラスほど、育てた力をそのまま出せます。買える物で上限は変わりません。", 36, 30, 928, 16, 2);
            for (int k = 0; k < rows.Count; k++)
            {
                var c = rows[k];
                var r = f.At(36, 100 + k * 132);
                var card = r.Card("class." + c.ClassId, 0, 0, 928, 120);
                card.Selected = c.Current;
                r.Text("class." + c.ClassId + ".title", c.Title, 24, 16, 120, 30, c.Current ? "cyan" : c.Reached ? "white" : "muted");
                if (c.Current) r.Text("class." + c.ClassId + ".now", "いまのクラス", 24, 70, 140, 16, "cyan");
                r.Text("class." + c.ClassId + ".cap", c.CapText, 190, 20, 340, 18);
                r.Text("class." + c.ClassId + ".line", c.LineText, 190, 66, 340, 16, "muted");
                r.Text("class." + c.ClassId + ".reward", c.RewardText, 540, 20, 364, 16, "gold", "right");
            }
            l.At(0, 0).Ghost("back", "目標へ", 36, 822, 220, "goals");
            return l;
        }
    }

    /// <summary>
    /// The layout audit (U1 common brief): every box inside 1600×900, no two text boxes overlapping (buttons and gauges
    /// included), text ≥ 16 px, each text fits its box (estimated with the UI font's widths: CJK 1 em, Latin ≈ .58 em), at most one
    /// CTA. Width estimates are deliberately generous (bold CJK), so a pass leaves room on device.
    /// </summary>
    public static class LayoutAudit
    {
        public const float LineHeight = 1.3f;

        public static float Em(char c)
        {
            if (c == ' ') return .3f;
            if (c == '·') return .35f;
            if (c >= 0x2E80 || c == '◎' || c == '◈' || c == '★' || c == '✓' || c == '›' || c == '»' || c == '→' || c == '〜') return 1f;
            if (c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '%' || c == '+' || c == '−' || c == '×') return .64f;
            if (c == 'm' || c == 'w' || c == 'M' || c == 'W') return .85f;
            if (c == '.' || c == ',' || c == ':' || c == '/' || c == '(' || c == ')' || c == '-' || c == '\'' || c == 'i' || c == 'l' || c == 'j' || c == 't' || c == 'f' || c == 'r') return .34f;
            return .56f;
        }

        public static float TextWidth(string s, int size) => s == null ? 0 : s.Sum(Em) * size;

        /// <summary>The kit's Kicker spaces the letters ("目標" → "目 標"; Latin upper-cased).</summary>
        public static string Spaced(string s)
        {
            if (string.IsNullOrEmpty(s)) return s;
            var upper = s.ToUpperInvariant();
            var sb = new System.Text.StringBuilder(upper.Length * 2);
            for (int i = 0; i < upper.Length; i++) { if (i > 0 && upper[i] != ' ' && upper[i - 1] != ' ') sb.Append(' '); sb.Append(upper[i]); }
            return sb.ToString();
        }

        /// <summary>The width a box's text needs on one line (the kit adds 「　»」 to a CTA, the Kicker spaces letters).</summary>
        public static float Needed(LayoutBox b, string text)
        {
            if (b.Kind == LayoutKind.Kicker) return TextWidth(Spaced(text), b.Size);
            if (b.Kind == LayoutKind.Cta) return TextWidth(text + "　»", b.Size);
            return TextWidth(text, b.Size);
        }

        /// <summary>The room a box gives its text on one line (the kit's CTA label is inset 28 px a side, Ghost 12).</summary>
        public static float Room(LayoutBox b) => b.Kind == LayoutKind.Cta ? b.W - 56 : b.Kind == LayoutKind.Ghost ? b.W - 24 : b.W;

        static bool Overlap(LayoutBox a, LayoutBox b) => a.X < b.X + b.W && b.X < a.X + a.W && a.Y < b.Y + b.H && b.Y < a.Y + a.H;

        /// <summary>Problems with a screen, empty when it passes. <paramref name="translate"/> audits another language (Loc.T).</summary>
        public static List<string> Problems(ScreenLayout l, Func<string, string> translate = null)
        {
            var p = new List<string>();
            foreach (var b in l.Boxes)
            {
                if (b.X < 0 || b.Y < 0 || b.X + b.W > DailyLayout.Width + .01f || b.Y + b.H > DailyLayout.Height + .01f) p.Add(l.Screen + ": outside 1600×900: " + b);
                bool text = b.IsText || b.Kind == LayoutKind.Cta || b.Kind == LayoutKind.Ghost;
                if (!text) continue;
                if (b.Size < 16) p.Add(l.Screen + ": text below 16 px: " + b);
                string s = translate != null ? translate(b.Text) : b.Text;
                float need = Needed(b, s), room = Room(b);
                if (b.Wrap)
                {
                    int lines = (int)Math.Ceiling(need / Math.Max(1f, room) - .001);
                    int fit = Math.Max(1, (int)Math.Floor(b.H / (b.Size * LineHeight) + .001));
                    if (lines > fit) p.Add(l.Screen + ": needs " + lines + " lines, has " + fit + ": " + b + (translate != null ? " → " + s : ""));
                }
                else if (need > room * 1.02f) p.Add(l.Screen + ": too long (" + (int)need + " > " + (int)room + " px): " + b + (translate != null ? " → " + s : ""));
            }
            // text, buttons, gauges and pips never cover one another
            var solid = l.Boxes.Where(b => b.IsText || b.IsButton || b.Kind == LayoutKind.Gauge || b.Kind == LayoutKind.Pips).ToList();
            for (int i = 0; i < solid.Count; i++)
                for (int j = i + 1; j < solid.Count; j++)
                    if (Overlap(solid[i], solid[j])) p.Add(l.Screen + ": overlap: " + solid[i] + "  ×  " + solid[j]);
            int ctas = l.Boxes.Count(b => b.Kind == LayoutKind.Cta);
            if (ctas > 1) p.Add(l.Screen + ": " + ctas + " CTAs (at most one)");
            return p;
        }

        /// <summary>The kit's Moment (MuchiApp.Kit.cs): kicker 16 px in 800, headline 40 px in 1000, line 20 px in 1000.</summary>
        public static List<string> MomentProblems(string kicker, string headline, string line, Func<string, string> translate = null)
        {
            translate = translate ?? (x => x);
            var p = new List<string>();
            if (TextWidth(Spaced(translate(kicker)), 16) > 800) p.Add("moment kicker too long: " + kicker);
            if (TextWidth(translate(headline), 40) > 1000) p.Add("moment headline too long: " + headline);
            if (line != null && TextWidth(translate(line), 20) > 1000) p.Add("moment line too long: " + line);
            if (string.IsNullOrEmpty(headline)) p.Add("moment without a headline");
            return p;
        }
    }
}
