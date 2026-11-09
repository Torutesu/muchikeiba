using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-ADV-001..016 (contracts/protocol.md §39): 出走前アドバイス. RaceAdvice.Compute is the C# mirror of the server's pure
    // computeRaceAdvice (server/src/domain/raceAdvice.ts), step for step, Japanese text included; both are checked against
    // contracts/race-advice.vectors.json (RaceAdviceTests). Data in, advice out: no clock, no random, never a win probability
    // or odds, never a purchase.

    public sealed class AdviceCourse
    {
        public string TrackId, Surface, Going;
        public int DistanceM, Corners, FinalStraightM;
        public bool Night;
        public static AdviceCourse Parse(JsonNode o) => new AdviceCourse
        {
            TrackId = J.Str(o, "trackId"), Surface = J.Str(o, "surface"), Going = J.Str(o, "going") ?? "good", DistanceM = J.Int(o, "distanceM"),
            Night = J.Bool(o, "night"), Corners = J.Int(o, "corners"), FinalStraightM = J.Int(o, "finalStraightM"),
        };
        internal JsonNode ToJson() => JsonNode.Obj().Set("trackId", TrackId).Set("surface", Surface).Set("distanceM", DistanceM).Set("going", Going)
            .Set("night", Night).Set("corners", Corners).Set("finalStraightM", FinalStraightM);
    }

    public sealed class AdviceSkill
    {
        public string Id, Name, Trigger;
        public static AdviceSkill Parse(JsonNode o) => o == null ? null : new AdviceSkill { Id = J.Str(o, "id"), Name = J.Str(o, "name"), Trigger = J.Str(o, "trigger") };
    }

    public sealed class AdviceHorse
    {
        public string Id, Name, Style, Surface, GoingAptitude = "any";
        public int DistMinM, DistMaxM, Speed, Stamina, Burst, Guts, Temper;
        public AdviceSkill Skill;
        public int StatTotal => Speed + Stamina + Burst + Guts + Temper;
        public static AdviceHorse Parse(JsonNode o) => new AdviceHorse
        {
            Id = J.Str(o, "id"), Name = J.Str(o, "name"), Style = J.Str(o, "style"), DistMinM = J.Int(o, "distMinM"), DistMaxM = J.Int(o, "distMaxM"),
            Surface = J.Str(o, "surface"), GoingAptitude = J.Str(o, "goingAptitude") ?? "any",
            Speed = J.Int(o, "speed"), Stamina = J.Int(o, "stamina"), Burst = J.Int(o, "burst"), Guts = J.Int(o, "guts"), Temper = J.Int(o, "temper"),
            Skill = AdviceSkill.Parse(J.Opt(o, "skill")),
        };

        /// <summary>
        /// A horse as the client knows it. <paramref name="stats"/> must be the race stats (base + awakening + training: the
        /// server's raceStats); the skill comes from the skill catalog (GET /v1/skills).
        /// </summary>
        public static AdviceHorse From(Horse h, Stats stats, SkillInfo skill) => new AdviceHorse
        {
            Id = h.Id, Name = h.Name, Style = h.Style, DistMinM = h.DistMinM, DistMaxM = h.DistMaxM, Surface = h.Surface, GoingAptitude = h.GoingAptitude ?? "any",
            Speed = stats.Speed, Stamina = stats.Stamina, Burst = stats.Burst, Guts = stats.Guts, Temper = stats.Temper,
            Skill = skill == null ? null : new AdviceSkill { Id = skill.Id, Name = skill.Name, Trigger = skill.Trigger },
        };
    }

    public sealed class AdviceField
    {
        public int Nige, Senko, Sashi, Oikomi, Unknown;
        public int Known => Nige + Senko + Sashi + Oikomi;
        /// <summary>Runners including me.</summary>
        public int Size => 1 + Known + Unknown;
        public static AdviceField Parse(JsonNode o) => o == null ? null : new AdviceField
        {
            Nige = J.Int(o, "nige"), Senko = J.Int(o, "senko"), Sashi = J.Int(o, "sashi"), Oikomi = J.Int(o, "oikomi"), Unknown = J.Int(o, "unknown"),
        };
        /// <summary>Counts from the styles the screen shows (friend room members) plus runners still unknown.</summary>
        public static AdviceField From(IEnumerable<string> styles, int unknown)
        {
            var f = new AdviceField { Unknown = Math.Max(0, unknown) };
            if (styles != null) foreach (var s in styles) { if (s == "nige") f.Nige++; else if (s == "senko") f.Senko++; else if (s == "sashi") f.Sashi++; else if (s == "oikomi") f.Oikomi++; }
            return f;
        }
    }

    public sealed class AdviceRules
    {
        public int AptitudeOutPenaltyPermille, GoingSpecialistPermille, MaxWhips, WhipDiminishWindowTicks, TickHz = 20, SpurtDistanceM;
        public int DistanceRefM, DistanceRefDirtM, SpurtDistanceScalePermille;
        public int[] DrainTurf = { 1000, 1000, 1000, 1000 }, DrainDirt = { 1000, 1000, 1000, 1000 };
        public int TargetNige, TargetSenko, TargetSashi, TargetOikomi;
        public bool Skills;

        public int TargetRank(string style) => style == "nige" ? TargetNige : style == "senko" ? TargetSenko : style == "sashi" ? TargetSashi : style == "oikomi" ? TargetOikomi : 0;

        public static AdviceRules Parse(JsonNode o)
        {
            var t = J.Opt(o, "targetRank");
            return new AdviceRules
            {
                AptitudeOutPenaltyPermille = J.Int(o, "aptitudeOutPenaltyPermille"), GoingSpecialistPermille = J.Int(o, "goingSpecialistPermille"),
                MaxWhips = J.Int(o, "maxWhips"), WhipDiminishWindowTicks = J.Int(o, "whipDiminishWindowTicks"), TickHz = J.Int(o, "tickHz", 20),
                SpurtDistanceM = J.Int(o, "spurtDistanceM"), DistanceRefM = J.Int(o, "distanceRefM"), DistanceRefDirtM = J.Int(o, "distanceRefDirtM"),
                SpurtDistanceScalePermille = J.Int(o, "spurtDistanceScalePermille"), DrainTurf = J.Ints(o, "drainTurf"), DrainDirt = J.Ints(o, "drainDirt"),
                TargetNige = J.Int(t, "nige"), TargetSenko = J.Int(t, "senko"), TargetSashi = J.Int(t, "sashi"), TargetOikomi = J.Int(t, "oikomi"),
                Skills = J.Bool(o, "skills"),
            };
        }
    }

    public sealed class AdviceInput
    {
        public int V = 1;
        /// <summary>ranked | friend | event | tournament | challenge | timeattack | tutorial</summary>
        public string Mode;
        public List<AdviceCourse> Courses = new List<AdviceCourse>();
        public List<AdviceHorse> Horses = new List<AdviceHorse>();
        public AdviceField Field;
        public AdviceRules Rules;
        public int? StatCap;
        public bool FixedStats;
        public string FocusHorseId;

        public static AdviceInput FromJson(string json) => Parse(JsonNode.Parse(json));
        public static AdviceInput Parse(JsonNode o) => o == null ? null : new AdviceInput
        {
            V = J.Int(o, "v", 1), Mode = J.Str(o, "mode"), Courses = J.List(o, "courses", AdviceCourse.Parse), Horses = J.List(o, "horses", AdviceHorse.Parse),
            Field = AdviceField.Parse(J.Opt(o, "field")), Rules = AdviceRules.Parse(J.Opt(o, "rules")), StatCap = J.IntN(o, "statCap"),
            FixedStats = J.Bool(o, "fixedStats"), FocusHorseId = J.Str(o, "focusHorseId"),
        };
        /// <summary>The same input with the tips about another horse (the screen's selection changed).</summary>
        public AdviceInput WithFocus(string horseId) => new AdviceInput { V = V, Mode = Mode, Courses = Courses, Horses = Horses, Field = Field, Rules = Rules, StatCap = StatCap, FixedStats = FixedStats, FocusHorseId = horseId };
    }

    public sealed class AdviceCheck
    {
        /// <summary>distance | surface | going | skill | stamina | pool</summary>
        public string Kind;
        /// <summary>plus | ok | minus | off</summary>
        public string Mark;
        public string Text;
        public static AdviceCheck Parse(JsonNode o) => new AdviceCheck { Kind = J.Str(o, "kind"), Mark = J.Str(o, "mark"), Text = J.Str(o, "text") };
        internal JsonNode ToJson() => JsonNode.Obj().Set("kind", Kind).Set("mark", Mark).Set("text", Text);
    }

    public sealed class AdviceHorseResult
    {
        public string HorseId, Name;
        public int Rank, FitPermille, Fits;
        /// <summary>good | ok | poor (words, never betting marks).</summary>
        public string Grade;
        public List<AdviceCheck> Checks = new List<AdviceCheck>();
        public static AdviceHorseResult Parse(JsonNode o) => new AdviceHorseResult
        {
            HorseId = J.Str(o, "horseId"), Name = J.Str(o, "name"), Rank = J.Int(o, "rank"), FitPermille = J.Int(o, "fitPermille"), Grade = J.Str(o, "grade"),
            Fits = J.Int(o, "fits"), Checks = J.List(o, "checks", AdviceCheck.Parse),
        };
        internal JsonNode ToJson()
        {
            var a = JsonNode.Arr();
            foreach (var c in Checks) a.Add(c.ToJson());
            return JsonNode.Obj().Set("horseId", HorseId).Set("name", Name).Set("rank", Rank).Set("fitPermille", FitPermille).Set("grade", Grade).Set("fits", Fits).Set("checks", a);
        }
    }

    public sealed class AdviceLine
    {
        /// <summary>pick | going | night | style | whip | rein | skill | field | rules</summary>
        public string Kind;
        public string Text;
        public static AdviceLine Parse(JsonNode o) => new AdviceLine { Kind = J.Str(o, "kind"), Text = J.Str(o, "text") };
    }

    public sealed class AdviceWhipTip
    {
        public int StartRemainingM, SpurtM, IntervalTicks, Count;
        public static AdviceWhipTip Parse(JsonNode o) => o == null ? null : new AdviceWhipTip
        {
            StartRemainingM = J.Int(o, "startRemainingM"), SpurtM = J.Int(o, "spurtM"), IntervalTicks = J.Int(o, "intervalTicks"), Count = J.Int(o, "count"),
        };
    }

    /// <summary>The advice (GET /v1/races/advice, or RaceAdvice.Compute on the device).</summary>
    public sealed class RaceAdviceResult
    {
        public int V = 1;
        public string Mode, Context;
        public bool Tutorial;
        public int CourseCount;
        public List<AdviceHorseResult> Horses = new List<AdviceHorseResult>();
        public string SuggestedHorseId;
        /// <summary>aptitude | stats | only | even | null</summary>
        public string SuggestReason;
        public string FocusHorseId;
        public List<AdviceLine> Lines = new List<AdviceLine>();
        public AdviceWhipTip Whip;
        public AdviceField Field;
        /// <summary>The input the server computed it from (null for the tutorial); recompute with another focus on the device.</summary>
        public AdviceInput Input;

        public static RaceAdviceResult FromJson(string json) => Parse(JsonNode.Parse(json));
        public static RaceAdviceResult Parse(JsonNode o) => new RaceAdviceResult
        {
            V = J.Int(o, "v", 1), Mode = J.Str(o, "mode"), Context = J.Str(o, "context") ?? J.Str(o, "mode"), Tutorial = J.Bool(o, "tutorial"),
            CourseCount = J.Int(o, "courseCount"), Horses = J.List(o, "horses", AdviceHorseResult.Parse), SuggestedHorseId = J.Str(o, "suggestedHorseId"),
            SuggestReason = J.Str(o, "suggestReason"), FocusHorseId = J.Str(o, "focusHorseId"), Lines = J.List(o, "lines", AdviceLine.Parse),
            Whip = AdviceWhipTip.Parse(J.Opt(o, "whip")), Field = AdviceField.Parse(J.Opt(o, "field")), Input = AdviceInput.Parse(J.Opt(o, "input")),
        };

        /// <summary>The output fields as the server writes them (for the shared vectors).</summary>
        public JsonNode ToJson()
        {
            var hs = JsonNode.Arr();
            foreach (var h in Horses) hs.Add(h.ToJson());
            var ls = JsonNode.Arr();
            foreach (var l in Lines) ls.Add(JsonNode.Obj().Set("kind", l.Kind).Set("text", l.Text));
            var o = JsonNode.Obj().Set("v", V).Set("mode", Mode).Set("tutorial", Tutorial).Set("courseCount", CourseCount).Set("horses", hs)
                .Set("suggestedHorseId", SuggestedHorseId).Set("suggestReason", SuggestReason).Set("focusHorseId", FocusHorseId).Set("lines", ls);
            o.Set("whip", Whip == null ? JsonNode.Null() : JsonNode.Obj().Set("startRemainingM", Whip.StartRemainingM).Set("spurtM", Whip.SpurtM).Set("intervalTicks", Whip.IntervalTicks).Set("count", Whip.Count));
            o.Set("field", Field == null ? JsonNode.Null() : JsonNode.Obj().Set("nige", Field.Nige).Set("senko", Field.Senko).Set("sashi", Field.Sashi).Set("oikomi", Field.Oikomi).Set("unknown", Field.Unknown).Set("size", Field.Size));
            return o;
        }
    }

    /// <summary>Whether the race followed the whip tip (REQ-ADV-014, the result screen's line).</summary>
    public enum WhipTipVerdict { Followed, Early, Late, NoWhip }

    public static class RaceAdvice
    {
        public const int Version = 1;
        public const int SkillBonus = 3, StaminaBonus = 2, StaminaHigh = 220, StaminaLow = 180, TemperLow = 400, WhipStartMaxM = 400;
        public const int HeavyDrain = 1015, LightDrain = 985;
        /// <summary>Tolerance of the whip check: the first whip from start+50 m to start−150 m counts as following the tip.</summary>
        public const int WhipEarlyToleranceM = 50, WhipLateToleranceM = 150;

        public static readonly IReadOnlyDictionary<string, string> GoingJa = new Dictionary<string, string>
        {
            ["firm"] = "良（硬め）", ["good"] = "良", ["yielding"] = "稍重", ["soft"] = "重", ["fast"] = "良", ["muddy"] = "稍重", ["sloppy"] = "不良",
        };
        public static readonly IReadOnlyDictionary<string, string> StyleJa = new Dictionary<string, string>
        {
            ["nige"] = "逃げ", ["senko"] = "先行", ["sashi"] = "差し", ["oikomi"] = "追込",
        };

        public static int GoingIndex(string g)
        {
            switch (g)
            {
                case "firm": case "fast": return 0;
                case "yielding": case "muddy": return 2;
                case "soft": case "sloppy": return 3;
                default: return 1;
            }
        }

        /// <summary>RaceSim.GoingSpecialistPermille on the wire names.</summary>
        public static int GoingSpecialistPermille(string apt, string going, int maxPermille)
        {
            if (apt == null || apt == "any" || maxPermille == 0) return 0;
            int gi = GoingIndex(going);
            int wet = gi == 0 ? -2 : gi == 2 ? 1 : gi == 3 ? 2 : 0;
            int sign = apt == "heavy" ? 1 : -1;
            return sign * wet * maxPermille / 2;
        }

        public static int DistanceFactorPermille(AdviceRules r, int distanceM, bool dirt, int scalePermille)
        {
            int refM = dirt ? r.DistanceRefDirtM : r.DistanceRefM;
            if (refM <= 0 || scalePermille == 0) return 1000;
            long f = 1000 + (long)scalePermille * (distanceM - refM) / refM;
            return (int)Math.Max(200, Math.Min(5000, f));
        }

        public static bool SkillFiresOn(string trigger, AdviceCourse c)
        {
            if (trigger == "cornerRail") return c.Corners > 0;
            if (trigger == "finalStraight") return c.FinalStraightM > 0;
            return true;
        }

        public static bool SkillsApply(AdviceInput i) => i.Rules.Skills && !i.FixedStats && i.Mode != "timeattack" && i.Mode != "challenge" && i.Mode != "tutorial";

        /// <summary>The ruleset values the advice reads (the engine's parsed ruleset; absent optional groups are neutral there too).</summary>
        public static AdviceRules Rules(RulesetParams p) => new AdviceRules
        {
            AptitudeOutPenaltyPermille = p.AptitudeOutPenaltyPermille, GoingSpecialistPermille = p.HasGoingKeys ? p.GoingSpecialistPermille : 0,
            MaxWhips = p.MaxWhips, WhipDiminishWindowTicks = p.WhipDiminishWindowTicks, TickHz = 20, SpurtDistanceM = p.SpurtDistanceM,
            DistanceRefM = p.HasDistanceKeys ? p.DistanceRefM : 0, DistanceRefDirtM = p.HasDistanceKeys ? p.DistanceRefDirtM : 0,
            SpurtDistanceScalePermille = p.HasDistanceKeys ? p.SpurtDistanceScalePermille : 0,
            DrainTurf = p.HasGoingKeys ? (int[])p.GoingTurfDrainPermille.Clone() : new[] { 1000, 1000, 1000, 1000 },
            DrainDirt = p.HasGoingKeys ? (int[])p.GoingDirtDrainPermille.Clone() : new[] { 1000, 1000, 1000, 1000 },
            TargetNige = p.CpuTargetRankNigePermille, TargetSenko = p.CpuTargetRankSenkoPermille, TargetSashi = p.CpuTargetRankSashiPermille, TargetOikomi = p.CpuTargetRankOikomiPermille,
            Skills = p.HasSkillKeys,
        };

        /// <summary>A course from the engine's track (segments decide corners and the final straight).</summary>
        public static AdviceCourse Course(TrackSpec t, string going, bool night)
        {
            int corners = 0;
            foreach (var s in t.Segments) if (s.Kind == SegmentKind.Corner) corners++;
            var last = t.Segments[t.Segments.Count - 1];
            return new AdviceCourse
            {
                TrackId = t.Id, Surface = t.Surface == Surface.Dirt ? "dirt" : "turf", DistanceM = t.DistanceM, Going = going ?? (t.Surface == Surface.Dirt ? "fast" : "good"),
                Night = night, Corners = corners, FinalStraightM = last.Kind == SegmentKind.Straight ? last.LengthM : 0,
            };
        }

        private static string Fmt(int n) => n.ToString("#,0", CultureInfo.InvariantCulture);
        private static string GoingText(string g) => GoingJa.TryGetValue(g ?? "good", out var s) ? s : "良";
        private static string StyleText(string s) => StyleJa.TryGetValue(s ?? "", out var t) ? t : s;

        private static int DrainRel(AdviceRules r, AdviceCourse c)
        {
            var t = c.Surface == "dirt" ? r.DrainDirt : r.DrainTurf;
            int good = t != null && t.Length > 1 ? t[1] : 1000;
            int gi = GoingIndex(c.Going);
            int v = t != null && t.Length > gi ? t[gi] : good;
            return good > 0 ? (int)((long)v * 1000 / good) : 1000;
        }

        private static bool StaminaDemand(AdviceRules r, AdviceCourse c)
        {
            if (DrainRel(r, c) >= HeavyDrain) return true;
            if (r.DistanceRefM <= 0) return c.DistanceM >= (c.Surface == "dirt" ? 2000 : 2400);
            return false;
        }

        private sealed class Score
        {
            public int Apt, Spec, Skill, Stam, Fit;
            public bool DistOut, SurfOut;
            public string SkillMark = "off", StamMark = "ok";
        }

        private static Score ScoreOn(AdviceInput input, AdviceHorse h, AdviceCourse c, bool skillsOn)
        {
            var r = input.Rules;
            var s = new Score
            {
                DistOut = c.DistanceM < h.DistMinM || c.DistanceM > h.DistMaxM,
                SurfOut = h.Surface != "both" && h.Surface != c.Surface,
            };
            s.Apt = -(s.DistOut ? r.AptitudeOutPenaltyPermille : 0) - (s.SurfOut ? r.AptitudeOutPenaltyPermille : 0);
            s.Spec = GoingSpecialistPermille(h.GoingAptitude, c.Going, r.GoingSpecialistPermille);
            if (h.Skill != null && skillsOn)
            {
                if (SkillFiresOn(h.Skill.Trigger, c)) { s.Skill = SkillBonus; s.SkillMark = "plus"; } else s.SkillMark = "minus";
            }
            if (!input.FixedStats && StaminaDemand(r, c))
            {
                int total = h.StatTotal;
                int share = total > 0 ? (int)((long)h.Stamina * 1000 / total) : 200;
                if (share >= StaminaHigh) { s.Stam = StaminaBonus; s.StamMark = "plus"; }
                else if (share < StaminaLow) { s.Stam = -StaminaBonus; s.StamMark = "minus"; }
            }
            s.Fit = s.Apt + s.Spec + s.Skill + s.Stam;
            return s;
        }

        private static List<AdviceCheck> CourseChecks(AdviceHorse h, AdviceCourse c, Score s, bool skillsOn)
        {
            var o = new List<AdviceCheck>();
            o.Add(s.DistOut
                ? new AdviceCheck { Kind = "distance", Mark = "minus", Text = "距離" + Fmt(c.DistanceM) + "mは適性外（" + Fmt(h.DistMinM) + "〜" + Fmt(h.DistMaxM) + "m）：速さとスタミナが少し落ちる" }
                : new AdviceCheck { Kind = "distance", Mark = "ok", Text = "距離" + Fmt(c.DistanceM) + "mは適性内（" + Fmt(h.DistMinM) + "〜" + Fmt(h.DistMaxM) + "m）" });
            o.Add(s.SurfOut
                ? new AdviceCheck { Kind = "surface", Mark = "minus", Text = c.Surface == "dirt" ? "ダートは苦手：速さとスタミナが少し落ちる" : "芝は苦手：速さとスタミナが少し落ちる" }
                : new AdviceCheck { Kind = "surface", Mark = "ok", Text = c.Surface == "dirt" ? "ダートを走れる" : "芝を走れる" });
            if (s.Spec > 0) o.Add(new AdviceCheck { Kind = "going", Mark = "plus", Text = GoingText(c.Going) + "の馬場が得意" });
            else if (s.Spec < 0) o.Add(new AdviceCheck { Kind = "going", Mark = "minus", Text = GoingText(c.Going) + "の馬場は苦手" });
            if (h.Skill != null)
            {
                if (!skillsOn) o.Add(new AdviceCheck { Kind = "skill", Mark = "off", Text = "このレースでは固有スキルは使われない" });
                else if (s.SkillMark == "plus") o.Add(new AdviceCheck { Kind = "skill", Mark = "plus", Text = "固有スキル「" + h.Skill.Name + "」はこのコースで出せる" });
                else o.Add(new AdviceCheck { Kind = "skill", Mark = "minus", Text = h.Skill.Trigger == "cornerRail" ? "「" + h.Skill.Name + "」はこのコースでは出ない（コーナーがない）" : "「" + h.Skill.Name + "」はこのコースでは出ない（最後の直線がない）" });
            }
            if (s.StamMark == "plus") o.Add(new AdviceCheck { Kind = "stamina", Mark = "plus", Text = "スタミナが多く、脚の減る馬場に向く" });
            else if (s.StamMark == "minus") o.Add(new AdviceCheck { Kind = "stamina", Mark = "minus", Text = "スタミナが少なめ：手綱で脚をためたい" });
            return o;
        }

        private sealed class Scored { public AdviceHorse H; public List<Score> Per; public int Fit, Fits, Eff; }

        /// <summary>REQ-ADV-001: the advice; the same steps as the server's computeRaceAdvice.</summary>
        public static RaceAdviceResult Compute(AdviceInput input)
        {
            if (input == null) throw new ArgumentNullException(nameof(input));
            if (input.Mode == "tutorial") return Tutorial();
            bool skillsOn = SkillsApply(input);
            bool multi = input.Courses.Count > 1;
            int n = input.Courses.Count;
            var scored = new List<Scored>();
            foreach (var h in input.Horses)
            {
                var per = new List<Score>();
                int fit = 0, fits = 0;
                foreach (var c in input.Courses) { var s = ScoreOn(input, h, c, skillsOn); per.Add(s); fit += s.Fit; if (s.Apt == 0) fits++; }
                int eff = input.FixedStats ? 0 : input.StatCap.HasValue ? Math.Min(h.StatTotal, input.StatCap.Value) : h.StatTotal;
                scored.Add(new Scored { H = h, Per = per, Fit = fit, Fits = fits, Eff = eff });
            }
            scored.Sort((a, b) => a.Fit != b.Fit ? b.Fit.CompareTo(a.Fit) : a.Eff != b.Eff ? b.Eff.CompareTo(a.Eff) : string.CompareOrdinal(a.H.Id, b.H.Id));

            var res = new RaceAdviceResult { V = Version, Mode = input.Mode, Context = input.Mode, Tutorial = false, CourseCount = n, Input = input };
            for (int i = 0; i < scored.Count; i++)
            {
                var x = scored[i];
                string grade;
                if (multi) grade = x.Fits == n ? "good" : x.Fits * 2 < n ? "poor" : "ok";
                else grade = x.Per[0].Apt < 0 || x.Fit < 0 ? "poor" : x.Fit > 0 ? "good" : "ok";
                var checks = multi
                    ? new List<AdviceCheck> { new AdviceCheck { Kind = "pool", Mark = x.Fits * 2 < n ? "minus" : "ok", Text = "今日の" + n.ToString(CultureInfo.InvariantCulture) + "コースのうち" + x.Fits.ToString(CultureInfo.InvariantCulture) + "コースで距離と芝・ダートが合う" } }
                    : CourseChecks(x.H, input.Courses[0], x.Per[0], skillsOn);
                res.Horses.Add(new AdviceHorseResult { HorseId = x.H.Id, Name = x.H.Name, Rank = i + 1, FitPermille = x.Fit, Grade = grade, Fits = x.Fits, Checks = checks });
            }

            string suggested = null, reason = null;
            if (scored.Count == 1) { suggested = scored[0].H.Id; reason = "only"; }
            else if (scored.Count > 1)
            {
                var a = scored[0]; var b = scored[1];
                if (a.Fit > b.Fit) { suggested = a.H.Id; reason = "aptitude"; }
                else if (a.Eff > b.Eff) { suggested = a.H.Id; reason = "stats"; }
                else reason = "even";
            }
            res.SuggestedHorseId = suggested; res.SuggestReason = reason;
            Scored focus = scored.Find(x => x.H.Id == input.FocusHorseId) ?? scored.Find(x => x.H.Id == suggested) ?? (scored.Count > 0 ? scored[0] : null);
            res.FocusHorseId = focus?.H.Id;

            var lines = res.Lines;
            var top = scored.Count > 0 ? scored[0] : null;
            if (reason == "only") lines.Add(new AdviceLine { Kind = "pick", Text = "出走できる馬は" + top.H.Name + "だけ" });
            else if (reason == "aptitude") lines.Add(new AdviceLine { Kind = "pick", Text = multi ? "おすすめは" + top.H.Name + "。今日の" + n.ToString(CultureInfo.InvariantCulture) + "コースのうち" + top.Fits.ToString(CultureInfo.InvariantCulture) + "コースで距離と芝・ダートが合う" : "おすすめは" + top.H.Name + "。距離・芝ダート・馬場の条件がいちばん合う" });
            else if (reason == "stats") lines.Add(new AdviceLine { Kind = "pick", Text = "おすすめは" + top.H.Name + "。条件は互角で、能力の合計が上" });
            else if (reason == "even") lines.Add(new AdviceLine { Kind = "pick", Text = "どの馬も条件は互角。乗り方で差がつく" });

            var r = input.Rules;
            var course = multi || n == 0 ? null : input.Courses[0];
            if (course != null)
            {
                int rel = DrainRel(r, course);
                if (rel >= HeavyDrain) lines.Add(new AdviceLine { Kind = "going", Text = GoingText(course.Going) + "の馬場：脚が減りやすい。手綱で脚をためる" });
                else if (rel <= LightDrain) lines.Add(new AdviceLine { Kind = "going", Text = GoingText(course.Going) + "の馬場：脚が残りやすい" });
                if (course.Night) lines.Add(new AdviceLine { Kind = "night", Text = "ナイター：走りは昼と同じ（見た目だけ）" });
            }

            AdviceField field = null;
            if (input.Field != null)
            {
                var f = input.Field;
                field = new AdviceField { Nige = f.Nige, Senko = f.Senko, Sashi = f.Sashi, Oikomi = f.Oikomi, Unknown = f.Unknown };
                string size = field.Size.ToString(CultureInfo.InvariantCulture);
                if (f.Known > 0) lines.Add(new AdviceLine { Kind = "field", Text = size + "頭立て。相手は逃げ" + f.Nige.ToString(CultureInfo.InvariantCulture) + "・先行" + f.Senko.ToString(CultureInfo.InvariantCulture) + "・差し" + f.Sashi.ToString(CultureInfo.InvariantCulture) + "・追込" + f.Oikomi.ToString(CultureInfo.InvariantCulture) });
                else lines.Add(new AdviceLine { Kind = "field", Text = size + "頭立て" });
                if (f.Unknown > 0) lines.Add(new AdviceLine { Kind = "field", Text = f.Known > 0 ? "ほかの" + f.Unknown.ToString(CultureInfo.InvariantCulture) + "頭の脚質は出走時に決まる" : "相手の脚質は出走時に決まる" });
            }
            else lines.Add(new AdviceLine { Kind = "field", Text = "最大12頭。相手は出走時に決まる" });
            res.Field = field;

            if (focus != null)
            {
                var h = focus.H;
                if (r.DistanceRefM > 0) lines.Add(new AdviceLine { Kind = "style", Text = course != null ? "この距離で脚質の有利不利はない" : "どの距離でも脚質の有利不利はない" });
                else if (course != null)
                {
                    int refM = course.Surface == "dirt" ? 1800 : 2000;
                    if (course.DistanceM <= refM - 400) lines.Add(new AdviceLine { Kind = "style", Text = "短い距離：前の馬が残りやすい" });
                    else if (course.DistanceM >= refM + 400) lines.Add(new AdviceLine { Kind = "style", Text = "長い距離：後ろの馬が伸びやすい" });
                }
                int fieldSize = field != null ? field.Size : 12;
                if (h.Style == "nige") lines.Add(new AdviceLine { Kind = "style", Text = StyleText(h.Style) + "：スタートを決めて先頭で運ぶ" });
                else if (fieldSize > 1)
                {
                    int pos = Math.Max(2, 1 + (int)((long)(fieldSize - 1) * r.TargetRank(h.Style) / 1000));
                    lines.Add(new AdviceLine { Kind = "style", Text = StyleText(h.Style) + "：" + pos.ToString(CultureInfo.InvariantCulture) + "番手あたりで運ぶ" });
                }
                if (field != null && h.Style == "nige")
                {
                    if (field.Nige >= 2) lines.Add(new AdviceLine { Kind = "style", Text = "逃げが多い：無理に競らず2番手からでもいい" });
                    else if (field.Nige == 0 && field.Unknown == 0) lines.Add(new AdviceLine { Kind = "style", Text = "ほかに逃げはいない：楽に先頭に立てる形" });
                }
                if (h.Temper < TemperLow) lines.Add(new AdviceLine { Kind = "rein", Text = "気性が荒い：かかったら手綱を長押し" });
                if (h.Skill != null && skillsOn && course != null && SkillFiresOn(h.Skill.Trigger, course) && h.Skill.Trigger == "goodStart")
                    lines.Add(new AdviceLine { Kind = "skill", Text = "「" + h.Skill.Name + "」：ゲートが開いた瞬間にスタート" });
            }

            if (course != null)
            {
                int f = DistanceFactorPermille(r, course.DistanceM, course.Surface == "dirt", r.SpurtDistanceScalePermille);
                int spurtM = (int)((long)r.SpurtDistanceM * f / 1000);
                int start = Math.Min(WhipStartMaxM, spurtM) / 50 * 50;
                res.Whip = new AdviceWhipTip { StartRemainingM = start, SpurtM = spurtM, IntervalTicks = r.WhipDiminishWindowTicks, Count = r.MaxWhips };
                int hz = Math.Max(1, r.TickHz);
                int sec = Math.Max(1, (r.WhipDiminishWindowTicks + hz - 1) / hz);
                lines.Add(new AdviceLine { Kind = "whip", Text = "ムチは残り" + Fmt(start) + "mから、" + sec.ToString(CultureInfo.InvariantCulture) + "秒以上あけて" + r.MaxWhips.ToString(CultureInfo.InvariantCulture) + "発まで" });
                lines.Add(new AdviceLine { Kind = "whip", Text = "スパートは残り" + Fmt(spurtM) + "mから。それより前のムチはほとんど効かない" });
            }
            else lines.Add(new AdviceLine { Kind = "whip", Text = "ムチは最後の直線で、間隔をあけて" });
            if (input.StatCap.HasValue && !input.FixedStats) lines.Add(new AdviceLine { Kind = "rules", Text = "能力は合計" + Fmt(input.StatCap.Value) + "までにそろえて走る" });
            if (input.FixedStats) lines.Add(new AdviceLine { Kind = "rules", Text = "全員が同じ能力で走る" });
            bool anySkill = false;
            foreach (var h in input.Horses) if (h.Skill != null) { anySkill = true; break; }
            if (!skillsOn && anySkill) lines.Add(new AdviceLine { Kind = "rules", Text = "このレースでは固有スキルは使われない" });
            return res;
        }

        /// <summary>REQ-ADV-010: the tutorial's fixed, simple version.</summary>
        public static RaceAdviceResult Tutorial() => new RaceAdviceResult
        {
            V = Version, Mode = "tutorial", Context = "tutorial", Tutorial = true, CourseCount = 1,
            Lines = new List<AdviceLine> { new AdviceLine { Kind = "whip", Text = "合図が出たら、ムチ" }, new AdviceLine { Kind = "whip", Text = "ムチは間隔をあけて打つと伸びる" } },
        };

        /// <summary>
        /// REQ-ADV-014: did the race follow the whip tip? Compares the first whip's remaining distance (the debrief recorder's)
        /// with the tip's start: from start+50 m to start−150 m counts as followed.
        /// </summary>
        public static WhipTipVerdict CheckWhipTip(AdviceWhipTip tip, RaceDebriefRecorder rec)
        {
            if (tip == null) throw new ArgumentNullException(nameof(tip));
            if (rec == null || rec.WhipRemainingMm.Count == 0) return WhipTipVerdict.NoWhip;
            long firstM = rec.WhipRemainingMm[0] / 1000;
            if (firstM > tip.StartRemainingM + WhipEarlyToleranceM) return WhipTipVerdict.Early;
            if (firstM < tip.StartRemainingM - WhipLateToleranceM) return WhipTipVerdict.Late;
            return WhipTipVerdict.Followed;
        }

        /// <summary>The result screen's line for a verdict (Japanese; Loc.T gives English, ui-en.json).</summary>
        public static string WhipTipText(WhipTipVerdict v, AdviceWhipTip tip)
        {
            string m = tip.StartRemainingM.ToString(CultureInfo.InvariantCulture);
            switch (v)
            {
                case WhipTipVerdict.Followed: return "ムチはアドバイスどおり残り" + m + "mから";
                case WhipTipVerdict.Early: return "ムチがアドバイス（残り" + m + "m）より早かった";
                case WhipTipVerdict.Late: return "ムチがアドバイス（残り" + m + "m）より遅かった";
                default: return "ムチを使わなかった（アドバイスは残り" + m + "mから）";
            }
        }

        /// <summary>Words that must never appear in advice (REQ-ADV-004; the same list as the server's lint, Japanese part).</summary>
        public static readonly string[] BannedJa =
        {
            "勝率", "確率", "オッズ", "本命", "対抗", "大穴", "穴馬", "単勝", "複勝", "馬券", "予想", "必勝", "勝てる", "絶対", "確実", "%", "％", "倍",
            "買", "購入", "課金", "ガチャ", "スカウト", "ショップ", "有償", "今だけ", "残りわずか", "お得", "通常価格", "◎", "○", "▲", "△", "☆",
        };
    }

    /// <summary>GET /v1/races/advice query (contracts/protocol.md §39.4).</summary>
    public sealed class RaceAdviceQuery
    {
        /// <summary>ranked | friend | event | challenge | timeattack | tutorial</summary>
        public string Context = "ranked";
        public string TrackId, Going, ChallengeId, EventId, HorseId;
        public bool? Night;
        /// <summary>Friend rooms: the other members' running styles as the room shows them (max 11).</summary>
        public List<string> Field;

        internal string ToPath()
        {
            var q = new List<string> { "context=" + Uri.EscapeDataString(Context ?? "ranked") };
            if (!string.IsNullOrEmpty(TrackId)) q.Add("trackId=" + Uri.EscapeDataString(TrackId));
            if (!string.IsNullOrEmpty(Going)) q.Add("going=" + Uri.EscapeDataString(Going));
            if (Night.HasValue) q.Add("night=" + (Night.Value ? "1" : "0"));
            if (!string.IsNullOrEmpty(ChallengeId)) q.Add("challengeId=" + Uri.EscapeDataString(ChallengeId));
            if (!string.IsNullOrEmpty(EventId)) q.Add("eventId=" + Uri.EscapeDataString(EventId));
            if (!string.IsNullOrEmpty(HorseId)) q.Add("horseId=" + Uri.EscapeDataString(HorseId));
            if (Field != null && Field.Count > 0) q.Add("field=" + string.Join(",", Field));
            return "/v1/races/advice?" + string.Join("&", q);
        }
    }

    public sealed partial class ApiClient
    {
        // ------------------------------------------------------------------ 出走前アドバイス (REQ-ADV-*)

        /// <summary>The pre-race advice for this context (read-only, free; safe to retry).</summary>
        public Task<RaceAdviceResult> GetRaceAdviceAsync(RaceAdviceQuery query, CancellationToken ct = default)
            => Call("GET", (query ?? new RaceAdviceQuery()).ToPath(), null, true, null, true, RaceAdviceResult.Parse, ct);
    }
}
