using System;
using System.Collections.Generic;
using System.Globalization;
using Muchi.Client;
using Muchi.Engine;

namespace Muchi.Game
{
    /// <summary>
    /// 固有スキル on the horse detail and gacha screens (REQ-UXS-050, docs/planning/06 §7.1). Texts come from the server, which
    /// generates them from the very values the engine uses; this only arranges them. No UnityEngine.
    /// </summary>
    public sealed class HorseSkillView
    {
        public string Id, Name, Rarity;
        /// <summary>When it fires ("最後の直線で前に2頭以内").</summary>
        public string Condition;
        /// <summary>What it does ("4秒間 目標速度+1.8%").</summary>
        public string Effect;
        /// <summary>Effect in races that cap skills (ranked, tournaments, capped events); equal to Effect when nothing is capped.</summary>
        public string RankedEffect;
        public bool CappedInRanked => RankedEffect != null && RankedEffect != Effect;
        /// <summary>"発動: … / 効果: …" plus the ranked line when capped.</summary>
        public string DetailText => "発動: " + Condition + "\n効果: " + Effect + (CappedInRanked ? "\nランク戦: " + RankedEffect : "");
        /// <summary>Always shown under the skill: skills fire from conditions, not chance.</summary>
        public const string Notice = "条件を満たすと1レースに1回発動（確率では決まりません）";

        public static HorseSkillView From(SkillInfo s) => s == null ? null : new HorseSkillView
        {
            Id = s.Id, Name = s.Name, Rarity = s.Rarity, Condition = s.Condition, Effect = s.Effect, RankedEffect = s.RankedEffect ?? s.Effect,
        };

        public static HorseSkillView From(SkillSummary s) => s == null ? null : new HorseSkillView
        {
            Id = s.Id, Name = s.Name, Rarity = s.Rarity, Condition = s.Condition, Effect = s.Effect, RankedEffect = s.Effect,
        };

        /// <summary>A horse's skill from the catalog (null when it has none or the catalog is not loaded).</summary>
        public static HorseSkillView ForHorse(Horse h, SkillCatalog catalog) => h == null || catalog == null ? null : From(catalog.Find(h.SkillId));
    }

    /// <summary>Lines for the breeding preview: the foal's skill odds as the server computed them (same function as the breeding).</summary>
    public static class SkillInheritLines
    {
        public static List<string> Of(BreedingPreview p)
        {
            var lines = new List<string>();
            var sk = p?.Skill;
            if (sk == null || sk.Candidates.Count == 0) return lines;
            foreach (var c in sk.Candidates)
                lines.Add("スキル継承 " + Permille(c.Permille) + "  " + (c.Skill?.Name ?? "?") + " ← " + string.Join("・", Array.ConvertAll(c.From ?? new string[0], f => f == "sire" ? "父" : "母")));
            lines.Add("スキルなし " + Permille(sk.NonePermille));
            return lines;
        }

        public static string Permille(int p) => (p / 10).ToString(CultureInfo.InvariantCulture) + "." + (p % 10).ToString(CultureInfo.InvariantCulture) + "%";
    }

    /// <summary>One skill cut-in on the race HUD (1 second, the partner's face + the skill name).</summary>
    public sealed class SkillCutIn
    {
        public int Slot, Tick, Rank;
        public string HorseName, SkillId, SkillName;
        public bool IsPlayer;
    }

    /// <summary>The skill part of the race HUD, read from the engine's tick-stamped Skill events (deterministic, replay-safe).</summary>
    public sealed class SkillHudState
    {
        /// <summary>The player's horse races with a skill.</summary>
        public bool HasSkill;
        public string SkillName;
        public bool Fired;
        /// <summary>The effect is running right now (HorseState.SkillTicksLeft &gt; 0).</summary>
        public bool Active;
        public int TicksLeft;
        /// <summary>Cut-in to show now (the player's own first, else the latest within the window), or null.</summary>
        public SkillCutIn CutIn;
    }

    public static class SkillHud
    {
        /// <summary>A cut-in stays on screen this many ticks (1 second at 20 Hz).</summary>
        public const int CutInTicks = 20;

        public static SkillHudState Build(IRaceDriver d) => Build(d?.Sim, d?.Config, d?.PlayerSlot ?? -1);

        public static SkillHudState Build(RaceSim sim, RaceConfig cfg, int playerSlot)
        {
            var s = new SkillHudState();
            if (sim == null || cfg == null) return s;
            if (playerSlot >= 0 && playerSlot < sim.EntrantCount)
            {
                var sk = sim.SkillOf(playerSlot);
                var me = sim.GetHorse(playerSlot);
                s.HasSkill = sk != null;
                s.SkillName = sk?.Name;
                s.Fired = me.SkillUsed;
                s.Active = me.IsSkillActive;
                s.TicksLeft = me.SkillTicksLeft;
            }
            int now = sim.Tick - 1;
            SkillCutIn best = null;
            var events = sim.Events;
            for (int i = events.Count - 1; i >= 0; i--)
            {
                var e = events[i];
                if (e.Tick < now - CutInTicks + 1) break;
                if (e.Type != RaceEventType.Skill) continue;
                var c = CutIn(cfg, e, playerSlot);
                if (c.IsPlayer) { best = c; break; }
                if (best == null) best = c;
            }
            s.CutIn = best;
            return s;
        }

        /// <summary>All cut-ins of a race in order (results screen / replay timeline).</summary>
        public static List<SkillCutIn> All(RaceSim sim, RaceConfig cfg, int playerSlot)
        {
            var list = new List<SkillCutIn>();
            if (sim == null || cfg == null) return list;
            foreach (var e in sim.Events) if (e.Type == RaceEventType.Skill) list.Add(CutIn(cfg, e, playerSlot));
            return list;
        }

        private static SkillCutIn CutIn(RaceConfig cfg, RaceEvent e, int playerSlot)
        {
            var h = e.Slot >= 0 && e.Slot < cfg.Entrants.Count ? cfg.Entrants[e.Slot].Horse : null;
            return new SkillCutIn { Slot = e.Slot, Tick = e.Tick, Rank = e.Value, HorseName = h?.Name, SkillId = h?.Skill?.Id, SkillName = h?.Skill?.Name, IsPlayer = e.Slot == playerSlot };
        }
    }
}
