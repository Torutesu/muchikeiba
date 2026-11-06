using System.Globalization;
using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Verifier
{
    /// <summary>One skill of server/master/skills.json with the master-only fields the harness needs.</summary>
    public sealed class MasterSkill
    {
        public SkillSpec Spec;
        public string Rarity;
        public RunningStyle[] Styles;
    }

    /// <summary>server/master/skills.json: the skills and the caps applied in stat-normalised (ranked) races.</summary>
    public sealed class SkillMaster
    {
        public List<MasterSkill> Skills = new List<MasterSkill>();
        public int CapSpeed, CapAccel, CapDrain, CapRecover, CapTicks;

        public static SkillMaster Load(string path)
        {
            var root = JsonNode.Parse(File.ReadAllText(path));
            var caps = root.Get("rankedCaps");
            var m = new SkillMaster
            {
                CapSpeed = caps.Get("speedPermille").AsInt(), CapAccel = caps.Get("accelPermille").AsInt(),
                CapDrain = caps.Get("drainSavePermille").AsInt(), CapRecover = caps.Get("recoverPermille").AsInt(),
                CapTicks = caps.Get("durationTicks").AsInt(),
            };
            foreach (var k in root.Get("skills").Items)
            {
                m.Skills.Add(new MasterSkill
                {
                    Spec = ProtocolCodec.ParseSkill(k),
                    Rarity = k.Get("rarity").AsString(),
                    Styles = k.Get("styles").Items.Select(x => ProtocolCodec.ParseStyle(x.AsString())).ToArray(),
                });
            }
            return m;
        }

        /// <summary>The skill as a stat-normalised (ranked) race carries it: every effect capped (same rule as server raceConfig.ts).</summary>
        public SkillSpec Ranked(SkillSpec s) => new SkillSpec
        {
            Id = s.Id, Name = s.Name, Trigger = s.Trigger, Value = s.Value,
            SpeedPermille = Math.Min(s.SpeedPermille, CapSpeed), AccelPermille = Math.Min(s.AccelPermille, CapAccel),
            DrainSavePermille = Math.Min(s.DrainSavePermille, CapDrain), RecoverPermille = Math.Min(s.RecoverPermille, CapRecover),
            DurationTicks = Math.Min(s.DurationTicks, CapTicks),
        };

        /// <summary>Deterministic skill for a field horse of this style (like CPU templates: every horse has a style-fitting skill).</summary>
        public SkillSpec ForStyle(RunningStyle style, int k)
        {
            var c = Skills.Where(x => x.Styles.Contains(style)).ToList();
            return c.Count == 0 ? null : c[(int)((uint)k % (uint)c.Count)].Spec;
        }
    }

    /// <summary>
    /// R9 (docs/spec/balance-targets.md §2, docs/planning/06 §7.1): a horse with a skill must not win much more often than the same
    /// horse without it (≤ 1.15×), for every skill; and running-style parity (±25% of uniform) must still hold on every course
    /// and going when every runner carries a skill (as CPU horses from the templates do).
    /// </summary>
    public static class SkillBalance
    {
        /// <summary>
        /// Field of the R9 races: random horses (500±150 per stat) normalised to this stat total, as ranked races normalise every
        /// entrant to the class cap. The test horse is 500 in every stat (total 2500), slightly above the field, so it wins about
        /// one race in five and the with/without ratio is measurable.
        /// </summary>
        public const int FieldTotal = 2400;
        public const int TestStat = 550;

        private static readonly Func<TrackSpec>[] Tracks = { SampleRaces.Turf2000, SampleRaces.Turf1600, () => SampleRaces.Dirt1800() };

        public struct PairedResult { public int Without, WithRanked, WithOpen, FiredRanked, Races; }

        /// <summary>
        /// Paired runs: the same race (seed, field, gate) with the test horse without the skill, with the ranked-capped skill and
        /// with the uncapped skill. Field: CPU level 3, normalised random horses without skills.
        /// </summary>
        public static PairedResult Paired(RulesetParams rs, SkillMaster master, MasterSkill skill, int races, ulong seedBase, bool open = true)
        {
            var res = new PairedResult { Races = races };
            var ranked = master.Ranked(skill.Spec);
            for (int r = 0; r < races; r++)
            {
                var track = Tracks[r % Tracks.Length]();
                var rng = new Pcg32(seedBase + (ulong)r * 7919UL, 5);
                var horses = new List<HorseSpec>();
                for (int i = 0; i < 12; i++)
                {
                    var h = SampleRaces.RandomHorse(ref rng, "f" + i, 500, 150);
                    int total = h.Speed + h.Stamina + h.Burst + h.Guts + h.Temper;
                    h.Speed = h.Speed * FieldTotal / total; h.Stamina = h.Stamina * FieldTotal / total; h.Burst = h.Burst * FieldTotal / total;
                    h.Guts = h.Guts * FieldTotal / total; h.Temper = h.Temper * FieldTotal / total;
                    h.Surface = track.Surface;
                    horses.Add(h);
                }
                int slot = r % 12;
                var me = SampleRaces.Horse("me", TestStat, skill.Styles[(r / 12) % skill.Styles.Length], TestStat);
                me.Surface = track.Surface;
                horses[slot] = me;
                ulong seed = SeedMix.Mix(seedBase + (ulong)r);
                RaceSim Race(SkillSpec sk)
                {
                    me.Skill = sk;
                    return RaceReplay.Run(SampleRaces.Config("r9_" + r, seed, track, rs, horses, 0, 3), new List<InputRecord>()).Sim;
                }
                if (Race(null).Result.Order[0] == slot) res.Without++;
                var simR = Race(ranked);
                if (simR.Result.Order[0] == slot) res.WithRanked++;
                if (simR.Events.Any(e => e.Type == RaceEventType.Skill && e.Slot == slot)) res.FiredRanked++;
                if (open && Race(skill.Spec).Result.Order[0] == slot) res.WithOpen++;
            }
            return res;
        }

        /// <param name="open">Also measure the uncapped (friend race) effect, R9f. CI checks the ranked values only.</param>
        public static HarnessReport Run(RulesetParams rs, SkillMaster master, IEnumerable<TrackSpec> courses, int scale = 1, bool open = true)
        {
            var rep = new HarnessReport();
            int n = 1440 * scale;
            ulong s = 90909;
            var skills = master.Skills;
            var paired = new PairedResult[skills.Count];
            Parallel.For(0, skills.Count, i => paired[i] = Paired(rs, master, skills[i], n, s, open));
            double worst = 0;
            int ssrWith = 0, ssrWithout = 0;
            for (int i = 0; i < skills.Count; i++)
            {
                var sk = skills[i];
                var p = paired[i];
                double ratio = p.Without == 0 ? 0 : (double)p.WithRanked / p.Without;
                worst = Math.Max(worst, ratio);
                if (sk.Rarity == "SSR") { ssrWith += p.WithRanked; ssrWithout += p.Without; }
                rep.Add("R9." + sk.Spec.Id, sk.Rarity + " " + sk.Spec.Name + " 勝率比(ランク戦の上限) " + p.WithRanked + "/" + p.Without, ratio, 0.95, 1.15);
                rep.Add("R9." + sk.Spec.Id + ".fired", sk.Spec.Name + " 発動率(%)", (double)p.FiredRanked / p.Races * 100, 0, 100, "%");
                if (open) rep.Add("R9f." + sk.Spec.Id, sk.Spec.Name + " 勝率比(上限なし・フレンド戦) " + p.WithOpen + "/" + p.Without, p.Without == 0 ? 0 : (double)p.WithOpen / p.Without, 0.95, 1.25);
            }
            rep.Add("R9", "スキル持ちSSRの勝率 ÷ 同能力のスキルなし(SSR全体、ランク戦)", ssrWithout == 0 ? 0 : (double)ssrWith / ssrWithout, 0.95, 1.15);
            rep.Add("R9max", "最も強いスキルの勝率比(ランク戦)", worst, 0, 1.15);

            // S2: running-style parity on every course × going when every runner carries a style-fitting skill (ranked caps)
            var list = courses.ToList();
            var goings = new[] { Going.FirmOrFast, Going.Good, Going.YieldingOrMuddy, Going.SoftOrSloppy };
            var probes = new BalanceReport[list.Count, goings.Length];
            int pn = 240 * scale;
            Parallel.For(0, list.Count * goings.Length, k =>
            {
                int ti = k / goings.Length, gi = k % goings.Length;
                var t = list[ti];
                var tg = goings[gi] == Going.Good ? t : new TrackSpec { Id = t.Id, Surface = t.Surface, DistanceM = t.DistanceM, Segments = t.Segments, Going = goings[gi] };
                probes[ti, gi] = BalanceProbe.Run(rs, pn, 70707 + 100, 150, tg, decorate: (r, i, h) => h.Skill = master.Ranked(master.ForStyle(h.Style, r * 5 + i)));
            });
            for (int ti = 0; ti < list.Count; ti++)
                for (int gi = 0; gi < goings.Length; gi++)
                {
                    var b = probes[ti, gi];
                    double lo = 1, hi = 0;
                    foreach (RunningStyle st in Enum.GetValues(typeof(RunningStyle)))
                    {
                        lo = Math.Min(lo, b.StyleWinRate(st));
                        hi = Math.Max(hi, b.StyleWinRate(st));
                    }
                    string id = "S2." + list[ti].Id + "." + goings[gi];
                    rep.Add(id, list[ti].Id + " " + goings[gi] + " スキルあり 脚質別勝率の最小(%)", lo * 100, 6.25 - BalanceHarness.Tolerance(pn), 100, "%");
                    rep.Add(id + "+", list[ti].Id + " " + goings[gi] + " スキルあり 脚質別勝率の最大(%)", hi * 100, 0, 10.42 + BalanceHarness.Tolerance(pn), "%");
                    if (b.Dnf != 0) rep.Add(id + ".dnf", list[ti].Id + " 完走しない馬", b.Dnf, 0, 0);
                }
            return rep;
        }
    }
}
