using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // Quality pass (raising & breeding, docs/quality/raising-breeding.md, contracts/protocol.md Q1): 馬カード (GET /v1/horses/:id/profile),
    // the growth stages (the same function as server horseProfile.ts growthStage, contracts/horse-profile.vectors.json), the per-menu
    // training outlook and the foal reveal. Everything here is display: nothing is granted, drawn or stored.

    /// <summary>Growth stages from the share of the training potential used. Display only (no reward is attached).</summary>
    public static class GrowthStages
    {
        public static readonly string[] Keys = { "debut", "growing", "prime", "peak", "complete" };
        public static readonly int[] ThresholdsPermille = { 0, 100, 350, 650, 1000 };
        public static readonly string[] Ja = { "新馬", "成長期", "充実期", "本格化", "完成" };

        public struct Stage
        {
            public int Index;
            public string Key;
            /// <summary>Trained total at which the next stage starts; -1 at the last stage or with no potential.</summary>
            public int NextAt;
            public string Name => Ja[Index];
        }

        public static Stage Of(int trained, int potential)
        {
            if (potential <= 0) return new Stage { Index = 0, Key = Keys[0], NextAt = -1 };
            long t = Math.Max(0, Math.Min(potential, trained));
            int index = 0;
            for (int i = 1; i < ThresholdsPermille.Length; i++) if (t * 1000 >= (long)ThresholdsPermille[i] * potential) index = i;
            int next = index + 1 < ThresholdsPermille.Length ? (int)((ThresholdsPermille[index + 1] * (long)potential + 999) / 1000) : -1;
            return new Stage { Index = index, Key = Keys[index], NextAt = next };
        }

        /// <summary>True when a session moved the horse into a later stage (the result screen's moment).</summary>
        public static bool StageUp(int before, int after, int potential) => Of(after, potential).Index > Of(before, potential).Index;
    }

    public sealed class ProfileStat
    {
        public string Key;
        public int Base, Awakening, Trained, Race, Ranked;
        internal static ProfileStat Parse(JsonNode o) => new ProfileStat
        {
            Key = J.Str(o, "key"), Base = J.Int(o, "base"), Awakening = J.Int(o, "awakening"), Trained = J.Int(o, "trained"), Race = J.Int(o, "race"), Ranked = J.Int(o, "ranked"),
        };
    }

    public sealed class ProfileTotals
    {
        public int Base, Effective, Race, Ranked, Cap, ToCap;
        public string ClassId;
        public bool Capped;
        internal static ProfileTotals Parse(JsonNode o) => new ProfileTotals
        {
            Base = J.Int(o, "base"), Effective = J.Int(o, "effective"), Race = J.Int(o, "race"), Ranked = J.Int(o, "ranked"), Cap = J.Int(o, "cap"),
            ToCap = J.Int(o, "toCap"), ClassId = J.Str(o, "classId"), Capped = J.Bool(o, "capped"),
        };
    }

    public sealed class ProfileGrowth
    {
        public int TrainedTotal, Potential, PerStatCap, Stage, Sessions;
        public string StageKey;
        /// <summary>-1 at the last stage.</summary>
        public int NextStageAt = -1;
        internal static ProfileGrowth Parse(JsonNode o) => o == null ? null : new ProfileGrowth
        {
            TrainedTotal = J.Int(o, "trainedTotal"), Potential = J.Int(o, "potential"), PerStatCap = J.Int(o, "perStatCap"), Stage = J.Int(o, "stage"),
            Sessions = J.Int(o, "sessions"), StageKey = J.Str(o, "stageKey"), NextStageAt = J.Int(o, "nextStageAt", -1),
        };
    }

    public sealed class ProfileLeaning
    {
        public string Stat;
        public int Trained, SharePermilleBefore, SharePermilleNow;
        internal static ProfileLeaning Parse(JsonNode o) => o == null ? null : new ProfileLeaning
        {
            Stat = J.Str(o, "stat"), Trained = J.Int(o, "trained"), SharePermilleBefore = J.Int(o, "sharePermilleBefore"), SharePermilleNow = J.Int(o, "sharePermilleNow"),
        };
    }

    public sealed class ProfileLineage
    {
        public int Generation = 1;
        public string Line, SireName, DamName, SkillFrom;
        public bool StudSire, Bred;
        public SkillSummary Skill;
        public AtavismTrait Atavism;
        internal static ProfileLineage Parse(JsonNode o) => o == null ? new ProfileLineage() : new ProfileLineage
        {
            Generation = J.Int(o, "generation", 1), Line = J.Str(o, "line"), SireName = J.Str(o, "sireName"), DamName = J.Str(o, "damName"),
            SkillFrom = J.Str(o, "skillFrom"), StudSire = J.Bool(o, "studSire"), Bred = J.Bool(o, "bred"),
            Skill = SkillSummary.Parse(J.Opt(o, "skill")), Atavism = AtavismTrait.Parse(J.Opt(o, "atavism")),
        };
    }

    public sealed class ProfileCareer
    {
        public int Races, Wins, Places, RivalWins, TournamentWins;
        public bool HasBiggestWin;
        internal static ProfileCareer Parse(JsonNode o) => o == null ? new ProfileCareer() : new ProfileCareer
        {
            Races = J.Int(o, "races"), Wins = J.Int(o, "wins"), Places = J.Int(o, "places"), RivalWins = J.Int(o, "rivalWins"),
            TournamentWins = J.Int(o, "tournamentWins"), HasBiggestWin = J.Opt(o, "biggestWin") != null,
        };
    }

    /// <summary>馬カード: GET /v1/horses/:horseId/profile (contracts/protocol.md Q1.1).</summary>
    public sealed class HorseProfile
    {
        public static readonly string[] StatOrder = { "speed", "stamina", "burst", "guts", "temper" };
        public string HorseId, Name, Rarity, Sex, Style, Status, Surface, GoingAptitude;
        public int DistMinM, DistMaxM;
        public bool Partner;
        public List<ProfileStat> Stats = new List<ProfileStat>();
        public ProfileTotals Totals = new ProfileTotals();
        /// <summary>Null when training is switched off.</summary>
        public ProfileGrowth Growth;
        public ProfileLeaning Leaning;
        public ProfileLineage Lineage = new ProfileLineage();
        public ProfileCareer Career = new ProfileCareer();
        public List<TrainingLogEntry> RecentTraining = new List<TrainingLogEntry>();

        public ProfileStat Stat(string key) => Stats.FirstOrDefault(s => s.Key == key);
        public GrowthStages.Stage Stage => Growth == null ? GrowthStages.Of(0, 0) : GrowthStages.Of(Growth.TrainedTotal, Growth.Potential);

        public static HorseProfile Parse(JsonNode o) => new HorseProfile
        {
            HorseId = J.Str(o, "horseId"), Name = J.Str(o, "name"), Rarity = J.Str(o, "rarity"), Sex = J.Str(o, "sex"), Style = J.Str(o, "style"),
            Status = J.Str(o, "status"), Surface = J.Str(o, "surface"), GoingAptitude = J.Str(o, "goingAptitude") ?? "any",
            DistMinM = J.Int(o, "distMinM"), DistMaxM = J.Int(o, "distMaxM"), Partner = J.Bool(o, "partner"),
            Stats = J.List(o, "stats", ProfileStat.Parse), Totals = ProfileTotals.Parse(J.Opt(o, "totals")) ?? new ProfileTotals(),
            Growth = ProfileGrowth.Parse(J.Opt(o, "growth")), Leaning = ProfileLeaning.Parse(J.Opt(o, "leaning")),
            Lineage = ProfileLineage.Parse(J.Opt(o, "lineage")), Career = ProfileCareer.Parse(J.Opt(o, "career")),
            RecentTraining = J.List(o, "recentTraining", TrainingLogEntry.Parse),
        };
    }

    /// <summary>What a menu would give a horse now (GET /v1/training horses[].menus[].outlook): exact, from the server's computeGain.</summary>
    public sealed class TrainingMenuOutlook
    {
        public int Min, Max, EfficiencyPermille = 1000, BondPermille, SoftPermille = 1000;
        internal static TrainingMenuOutlook Parse(JsonNode o) => o == null ? null : new TrainingMenuOutlook
        {
            Min = J.Int(o, "min"), Max = J.Int(o, "max"), EfficiencyPermille = J.Int(o, "efficiencyPermille", 1000), BondPermille = J.Int(o, "bondPermille"), SoftPermille = J.Int(o, "softPermille", 1000),
        };
        /// <summary>"+5〜+6" (or "+6" when the mini-game cannot change the whole points).</summary>
        public string RangeText => Min == Max ? "+" + Min : "+" + Min + "〜+" + Max;
        /// <summary>Why the outlook is lower or higher than the menu's base: "疲れ −15%" / "絆 +8%" / "伸びしろ 80%" (empty when none).</summary>
        public string ReasonText
        {
            get
            {
                var parts = new List<string>();
                if (EfficiencyPermille < 1000) parts.Add("疲れ −" + Pct(1000 - EfficiencyPermille));
                if (BondPermille > 0) parts.Add("絆 +" + Pct(BondPermille));
                if (SoftPermille < 1000) parts.Add("伸びしろ " + Pct(SoftPermille));
                return string.Join("・", parts);
            }
        }
        private static string Pct(int permille) => (permille / 10).ToString(System.Globalization.CultureInfo.InvariantCulture) + (permille % 10 == 0 ? "" : "." + (permille % 10)) + "%";
    }

    /// <summary>The foal's rarity odds in parts per million (POST /v1/breeding/preview rarity; exact, contracts/protocol.md Q1.2).</summary>
    public sealed class FoalRarityOdds
    {
        public long R = 1_000_000, SR, SSR;
        public bool Known;
        internal static FoalRarityOdds Parse(JsonNode o) => o == null ? new FoalRarityOdds() : new FoalRarityOdds { R = J.Long(o, "R"), SR = J.Long(o, "SR"), SSR = J.Long(o, "SSR"), Known = true };
        public long Of(string rarity) => rarity == "SSR" ? SSR : rarity == "SR" ? SR : R;
        /// <summary>"12.3%" (one decimal, rounded half up; ""0.1%未満" for a chance under 0.05% that is not zerolt;0.1%" for a chance under 0.05% that is not zero).</summary>
        public static string Percent(long ppm)
        {
            if (ppm <= 0) return "0%";
            long tenths = (ppm + 500) / 1000;
            if (tenths == 0) return "<0.1%";
            return (tenths / 10).ToString(System.Globalization.CultureInfo.InvariantCulture) + "." + (tenths % 10) + "%";
        }
    }

    public sealed class FoalRevealStat
    {
        public string Key;
        public int Value, Min, Max;
        /// <summary>Where the value landed in the preview's range, 0..1000.</summary>
        public int PositionPermille;
        /// <summary>"high" (top quarter of the range) / "mid" / "low" (bottom quarter).</summary>
        public string Mark;
    }

    /// <summary>
    /// The foal reveal: the order a breeding result is uncovered (sex and style → the five stats against the preview's range →
    /// rarity → skill and 隔世遺伝). Built from the preview the player saw and the foal the server returned; it adds no judgement
    /// of its own beyond where each stat landed in the range.
    /// </summary>
    public sealed class FoalReveal
    {
        public static readonly string[] Steps = { "sex_style", "stats", "rarity", "gifts" };
        public Horse Foal;
        public List<FoalRevealStat> Stats = new List<FoalRevealStat>();
        public int Total;
        /// <summary>The chance the preview gave this rarity (ppm), when the server sent rarity odds; else -1.</summary>
        public long RarityChancePpm = -1;
        /// <summary>"sire" / "dam" / "both" (same style) / "atavism" / "other".</summary>
        public string StyleFrom;
        /// <summary>"sire" / "dam" / "both" / null (no skill).</summary>
        public string SkillFrom;
        public AtavismTrait Atavism;
        /// <summary>Count of stats in the top quarter of their range ("期待以上").</summary>
        public int HighCount => Stats.Count(s => s.Mark == "high");

        public static FoalReveal Build(BreedingPreview p, Horse foal, string sireStyle, string damStyle)
        {
            var r = new FoalReveal { Foal = foal, Atavism = foal.Atavism };
            var b = foal.Base ?? new Stats();
            var values = new Dictionary<string, int> { ["speed"] = b.Speed, ["stamina"] = b.Stamina, ["burst"] = b.Burst, ["guts"] = b.Guts, ["temper"] = b.Temper };
            foreach (var k in HorseProfile.StatOrder)
            {
                int v = values[k];
                var range = p?.Stats != null && p.Stats.TryGetValue(k, out var x) ? x : new StatRange { Min = v, Max = v };
                int span = range.Max - range.Min;
                int pos = span <= 0 ? 500 : (int)Math.Max(0, Math.Min(1000, (v - range.Min) * 1000L / span));
                r.Stats.Add(new FoalRevealStat { Key = k, Value = v, Min = range.Min, Max = range.Max, PositionPermille = pos, Mark = pos >= 750 ? "high" : pos <= 250 ? "low" : "mid" });
                r.Total += v;
            }
            if (p?.Rarity != null && p.Rarity.Known) r.RarityChancePpm = p.Rarity.Of(foal.Rarity);
            if (foal.Atavism != null && foal.Atavism.Trait == "style") r.StyleFrom = "atavism";
            else if (foal.Style == sireStyle && foal.Style == damStyle) r.StyleFrom = "both";
            else if (foal.Style == sireStyle) r.StyleFrom = "sire";
            else if (foal.Style == damStyle) r.StyleFrom = "dam";
            else r.StyleFrom = "other";
            if (foal.SkillId != null && p?.Skill != null)
            {
                var c = p.Skill.Candidates.FirstOrDefault(x => x.Skill?.Id == foal.SkillId);
                if (c != null) r.SkillFrom = c.From.Length >= 2 ? "both" : c.From.FirstOrDefault();
            }
            return r;
        }
    }

    public sealed partial class ApiClient
    {
        /// <summary>馬カード (contracts/protocol.md Q1.1). Read-only. NotFoundException HORSE_NOT_FOUND.</summary>
        public Task<HorseProfile> GetHorseProfileAsync(string horseId, CancellationToken ct = default)
            => Call("GET", "/v1/horses/" + Seg(horseId) + "/profile", null, true, null, true, HorseProfile.Parse, ct);
    }
}
