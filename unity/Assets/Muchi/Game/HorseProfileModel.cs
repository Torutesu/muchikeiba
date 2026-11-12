using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // Quality pass (raising & breeding, docs/quality/raising-breeding.md, contracts/protocol.md Q1): 馬カード, the game layer.
    // Pure C#: the horse detail screen binds to the public members. Read-only (GET /v1/horses/:id/profile): nothing is granted,
    // and the growth stage is display only. Horse names are what players typed (never through Loc.T); the labels are in ui-en.json.

    /// <summary>One stat bar: base → +awakening → +training, on the 0..1000 scale the engine uses.</summary>
    public sealed class ProfileStatBar
    {
        public string Key, Name;
        public int Base, Awakening, Trained, Race, Ranked;
        /// <summary>"726".</summary>
        public string ValueText;
        /// <summary>"+6" (training), or null when untrained.</summary>
        public string TrainedText;
        /// <summary>Segment lengths for the bar (0..1 of 1000).</summary>
        public float BaseRatio, AwakeningRatio, TrainedRatio;
        /// <summary>The stat training pushed most (gold label).</summary>
        public bool Leaning;
    }

    public sealed class HorseProfileModel : ScreenModel
    {
        public const string Title = "馬カード";
        public const string OfflineText = "馬カードはオンラインで見られます";
        public const string RulesText = "調教の伸びはレースで使われます。ランク戦は能力の合計をクラスの上限にそろえますが、能力の配分（得意）はそのまま残ります。伸びは課金で増えず、仔には受け継がれません。成長段階は表示だけです。";
        public static readonly IReadOnlyDictionary<string, string> StatNames = TrainingModel.StatNames;
        public static readonly IReadOnlyDictionary<string, string> FromTexts = new Dictionary<string, string> { ["own"] = "生まれつき", ["sire"] = "父から", ["dam"] = "母から", ["both"] = "父と母から" };

        public HorseProfileModel(GameBackend backend, IKeyValueStore store = null) : base(backend, store ?? backend?.Store) { }

        public HorseProfile Profile { get; private set; }
        public List<ProfileStatBar> Bars { get; private set; } = new List<ProfileStatBar>();

        public async Task<ActionResult> LoadAsync(string horseId, CancellationToken ct = default)
        {
            Message = null;
            if (!ServerAvailable) { Online = false; return Offline(OfflineText); }
            try { Use(await B.Api.GetHorseProfileAsync(horseId, ct)); Online = true; return ActionResult.Success(); }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        public void Use(HorseProfile p)
        {
            Profile = p;
            Bars = p == null ? new List<ProfileStatBar>() : HorseProfile.StatOrder.Select(k => p.Stat(k)).Where(s => s != null).Select(s => new ProfileStatBar
            {
                Key = s.Key, Name = StatNames.TryGetValue(s.Key, out var n) ? n : s.Key, Base = s.Base, Awakening = s.Awakening, Trained = s.Trained, Race = s.Race, Ranked = s.Ranked,
                ValueText = s.Race.ToString(CultureInfo.InvariantCulture), TrainedText = s.Trained > 0 ? "+" + s.Trained.ToString(CultureInfo.InvariantCulture) : null,
                BaseRatio = s.Base / 1000f, AwakeningRatio = s.Awakening / 1000f, TrainedRatio = s.Trained / 1000f, Leaning = p.Leaning != null && p.Leaning.Stat == s.Key,
            }).ToList();
        }

        public GrowthStages.Stage Stage => Profile?.Stage ?? GrowthStages.Of(0, 0);
        /// <summary>"成長期".</summary>
        public string StageText => Profile?.Growth == null ? null : Stage.Name;
        /// <summary>Progress inside the current stage, 0..1 (1 at 完成).</summary>
        public float StageProgress
        {
            get
            {
                var g = Profile?.Growth;
                if (g == null || g.Potential <= 0) return 0f;
                var st = Stage;
                if (st.NextAt < 0) return 1f;
                int from = (int)((GrowthStages.ThresholdsPermille[st.Index] * (long)g.Potential + 999) / 1000);
                return st.NextAt <= from ? 0f : Math.Min(1f, Math.Max(0f, (g.TrainedTotal - from) / (float)(st.NextAt - from)));
            }
        }
        /// <summary>"充実期まで あと54" / "素質いっぱいまで伸びました".</summary>
        public string NextStageText
        {
            get
            {
                var g = Profile?.Growth;
                if (g == null) return null;
                var st = Stage;
                return st.NextAt < 0 ? "素質いっぱいまで伸びました" : GrowthStages.Ja[st.Index + 1] + "まで あと" + Math.Max(0, st.NextAt - g.TrainedTotal).ToString(CultureInfo.InvariantCulture);
            }
        }
        /// <summary>"素質 30 / 240".</summary>
        public string PotentialText => Profile?.Growth == null ? null : "素質 " + Profile.Growth.TrainedTotal.ToString(CultureInfo.InvariantCulture) + " / " + Profile.Growth.Potential.ToString(CultureInfo.InvariantCulture);
        /// <summary>"能力合計 3,332".</summary>
        public string TotalText => Profile == null ? null : "能力合計 " + Profile.Totals.Race.ToString("N0", CultureInfo.InvariantCulture);
        /// <summary>The ranked line, honest either way.</summary>
        public string RankedText
        {
            get
            {
                if (Profile == null) return null;
                var t = Profile.Totals;
                string cls = t.ClassId + "級 上限 " + t.Cap.ToString("N0", CultureInfo.InvariantCulture);
                return t.Capped ? "ランク戦（" + cls + "）：合計は上限にそろえ、配分はそのまま" : "ランク戦（" + cls + "）まで あと " + t.ToCap.ToString("N0", CultureInfo.InvariantCulture);
            }
        }
        /// <summary>"得意：瞬発（21.6% → 21.8%）", or null before any training.</summary>
        public string LeaningText
        {
            get
            {
                var l = Profile?.Leaning;
                if (l == null) return null;
                return "得意：" + (StatNames.TryGetValue(l.Stat, out var n) ? n : l.Stat) + "（" + Pct(l.SharePermilleBefore) + " → " + Pct(l.SharePermilleNow) + "）";
            }
        }
        /// <summary>"第2世代".</summary>
        public string GenerationText => Profile == null ? null : "第" + Profile.Lineage.Generation.ToString(CultureInfo.InvariantCulture) + "世代";
        /// <summary>"固有スキル「末脚一閃」：母から" (null with no skill).</summary>
        public string SkillOriginText
        {
            get
            {
                var l = Profile?.Lineage;
                if (l?.Skill == null) return null;
                return "固有スキル「" + l.Skill.Name + "」" + (l.SkillFrom != null && FromTexts.TryGetValue(l.SkillFrom, out var f) ? "：" + f : "");
            }
        }
        /// <summary>"隔世遺伝：逃げ（ソフ）" (null without one). The grandparent's name is as typed.</summary>
        public string AtavismText => Profile?.Lineage?.Atavism == null ? null : "隔世遺伝：" + BreedingModel.TraitLabel(Profile.Lineage.Atavism) + "（" + Profile.Lineage.Atavism.From + "）";
        /// <summary>"12戦3勝・ライバルに1回先着" / "まだ走っていません".</summary>
        public string CareerText
        {
            get
            {
                var c = Profile?.Career;
                if (c == null) return null;
                if (c.Races == 0) return "まだ走っていません";
                var parts = new List<string> { c.Races.ToString(CultureInfo.InvariantCulture) + "戦" + c.Wins.ToString(CultureInfo.InvariantCulture) + "勝" };
                if (c.RivalWins > 0) parts.Add("ライバルに" + c.RivalWins.ToString(CultureInfo.InvariantCulture) + "回先着");
                if (c.TournamentWins > 0) parts.Add("大会優勝" + c.TournamentWins.ToString(CultureInfo.InvariantCulture) + "回");
                return string.Join("・", parts);
            }
        }

        internal static string Pct(int permille) => (permille / 10).ToString(CultureInfo.InvariantCulture) + "." + (permille % 10).ToString(CultureInfo.InvariantCulture) + "%";
    }
}
