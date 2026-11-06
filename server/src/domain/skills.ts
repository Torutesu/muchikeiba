import skillsJson from '../../master/skills.json';
import { AppError } from './errors.js';
import type { HorseTemplate, Master, Rarity, Style } from './master.js';
import type { HorseInstance } from './player.js';
import { randInt, type Rng } from './rng.js';
import { SKILL_RULESET_KEYS } from './ruleset.js';
import { raceSkillSchema, type RaceSkill } from './schemas.js';

/**
 * 固有スキル (unique skills), docs/planning/06-ux-experience-spec.md §7.1, REQ-UXS-050/051.
 * One skill per horse. It fires from conditions only (no random draw, so there are no odds to disclose) and at most once
 * per race. Effects are integer permille; races that normalise stats (ranked, tournaments, capped events) cap them at
 * `rankedCaps` (like stat normalisation), and every race caps them at the ruleset's `skillMax*` keys.
 */

export interface SkillCaps { speedPermille: number; accelPermille: number; drainSavePermille: number; recoverPermille: number; durationTicks: number }
export interface SkillDef extends RaceSkill { rarity: Rarity; styles: Style[] }
export interface SkillInheritance { singleParentPermille: number; eachOfTwoParentsPermille: number }
export interface SkillsMaster { rankedCaps: SkillCaps; inheritance: SkillInheritance; skills: SkillDef[]; byId: Map<string, SkillDef> }

const EFFECT_KEYS = ['speedPermille', 'accelPermille', 'drainSavePermille', 'recoverPermille', 'durationTicks'] as const;
const RULESET_CAP_KEY: Record<(typeof EFFECT_KEYS)[number], string> = {
  speedPermille: 'skillMaxSpeedPermille', accelPermille: 'skillMaxAccelPermille', drainSavePermille: 'skillMaxDrainSavePermille',
  recoverPermille: 'skillMaxRecoverPermille', durationTicks: 'skillMaxDurationTicks',
};

export function buildSkillsMaster(raw: { rankedCaps: SkillCaps; inheritance: SkillInheritance; skills: SkillDef[] }): SkillsMaster {
  return { rankedCaps: raw.rankedCaps, inheritance: raw.inheritance, skills: raw.skills, byId: new Map(raw.skills.map((s) => [s.id, s])) };
}

export function loadSkills(): SkillsMaster {
  return buildSkillsMaster(skillsJson as unknown as { rankedCaps: SkillCaps; inheritance: SkillInheritance; skills: SkillDef[] });
}

/** The ruleset's skill ceilings, or null when the ruleset has no skill keys (pre-1.3: the engine ignores skills). */
export function rulesetSkillCaps(r: Record<string, unknown>): SkillCaps | null {
  if (!SKILL_RULESET_KEYS.every((k) => typeof r[k] === 'number')) return null;
  const out = {} as SkillCaps;
  for (const k of EFFECT_KEYS) out[k] = r[RULESET_CAP_KEY[k]] as number;
  return out;
}

/** What a race config carries: the engine fields only. */
export function toRaceSkill(d: SkillDef): RaceSkill {
  return { id: d.id, name: d.name, trigger: d.trigger, value: d.value, speedPermille: d.speedPermille, accelPermille: d.accelPermille, drainSavePermille: d.drainSavePermille, recoverPermille: d.recoverPermille, durationTicks: d.durationTicks };
}

export function capSkill(s: RaceSkill, caps: SkillCaps): RaceSkill {
  const out = { ...s };
  for (const k of EFFECT_KEYS) out[k] = Math.min(out[k], caps[k]);
  return out;
}

/** Skill of a template horse (master), or null. */
export function templateSkill(m: Master, t: HorseTemplate): SkillDef | null {
  return t.skillId ? m.skills.byId.get(t.skillId) ?? null : null;
}

/**
 * A horse's skill id: the one stored on it (gacha horses since skills exist, inherited by foals), else its template's
 * (horses stored before skills existed). Foals without an inherited skill have none.
 */
export function horseSkillId(m: Master, h: Pick<HorseInstance, 'skillId' | 'templateId'>): string | null {
  if (h.skillId) return m.skills.byId.has(h.skillId) ? h.skillId : null;
  if (!h.templateId) return null;
  return m.templateById.get(h.templateId)?.skillId ?? null;
}

export function horseSkill(m: Master, h: Pick<HorseInstance, 'skillId' | 'templateId'>): SkillDef | null {
  const id = horseSkillId(m, h);
  return id ? m.skills.byId.get(id) ?? null : null;
}

/** Fills `skillId` on template horses stored before skills existed (shown to the client with the horse; idempotent). */
export function migrateSkills(m: Master, horses: HorseInstance[]): void {
  for (const h of horses) {
    if (h.skillId !== undefined || !h.templateId) continue;
    const id = m.templateById.get(h.templateId)?.skillId;
    if (id) h.skillId = id;
  }
}

// ---------- inheritance (REQ-UXS-050: same function for the preview and the real breeding, like REQ-HORSE-008) ----------

export interface SkillInheritOdds { none: number; skills: { skillId: string; permille: number; from: ('sire' | 'dam')[] }[] }

/**
 * The foal's skill odds in permille. One parent with a skill: that skill at `singleParentPermille`. Both: each parent's at
 * `eachOfTwoParentsPermille` (the same skill twice adds up). The rest = no skill.
 */
export function skillInheritOdds(m: Master, sireSkillId: string | null, damSkillId: string | null): SkillInheritOdds {
  const inh = m.skills.inheritance;
  const out: SkillInheritOdds = { none: 1000, skills: [] };
  const parents = ([['sire', sireSkillId], ['dam', damSkillId]] as const).filter(([, id]) => id && m.skills.byId.has(id));
  const each = parents.length === 2 ? inh.eachOfTwoParentsPermille : inh.singleParentPermille;
  for (const [who, id] of parents) {
    const row = out.skills.find((x) => x.skillId === id);
    if (row) { row.permille += each; row.from.push(who); } else out.skills.push({ skillId: id!, permille: each, from: [who] });
    out.none -= each;
  }
  return out;
}

/** Draws from the odds. Only called when a parent has a skill, so breedings without one use the RNG exactly as before. */
export function rollInheritedSkill(odds: SkillInheritOdds, rng: Rng): string | null {
  let r = randInt(rng, 1000);
  for (const s of odds.skills) {
    if (r < s.permille) return s.skillId;
    r -= s.permille;
  }
  return null;
}

// ---------- display (generated from the very values the engine uses, so the text never disagrees with the race) ----------

const pct = (permille: number) => `${(permille / 10).toFixed(1).replace(/\.0$/, '')}%`;
const secs = (ticks: number) => `${(ticks / 20).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}秒`;

export function conditionText(s: Pick<RaceSkill, 'trigger' | 'value'>): string {
  const v = s.value;
  switch (s.trigger) {
    case 'finalStraight': return v === 0 ? '最後の直線で先頭' : `最後の直線で前に${v}頭以内`;
    case 'cornerRail': return v === 0 ? 'コーナーで内ラチ沿い' : `コーナーで内から${v + 1}頭分以内`;
    case 'lowStamina': return `残りの脚が${pct(v)}以下`;
    case 'spurtBehind': return `スパート区間で前に${v}頭以上`;
    case 'remaining': return `残り${v}m`;
    case 'leading': return `残り${v}mで先頭`;
    case 'slipstream': return `他の馬の後ろで${secs(v)}風よけを続ける`;
    case 'goodStart': return `ゲートが開いて${secs(v)}以内にスタート`;
  }
}

export function effectText(s: Pick<RaceSkill, (typeof EFFECT_KEYS)[number]>): string {
  const parts: string[] = [];
  if (s.speedPermille > 0) parts.push(`目標速度+${pct(s.speedPermille)}`);
  if (s.accelPermille > 0) parts.push(`加速+${pct(s.accelPermille)}`);
  if (s.drainSavePermille > 0) parts.push(`脚の消費−${pct(s.drainSavePermille)}`);
  const timed = parts.length > 0 && s.durationTicks > 0 ? `${secs(s.durationTicks)}間 ${parts.join('・')}` : '';
  const recover = s.recoverPermille > 0 ? `脚を${pct(s.recoverPermille)}回復` : '';
  return [recover, timed].filter((x) => x).join('、') || '効果なし';
}

export interface SkillView {
  id: string; name: string; rarity: Rarity; styles: Style[]; trigger: RaceSkill['trigger']; value: number;
  speedPermille: number; accelPermille: number; drainSavePermille: number; recoverPermille: number; durationTicks: number;
  /** Generated text: when it fires, what it does, and what it does in races that cap skills (ranked etc.). */
  condition: string; effect: string; rankedEffect: string;
}

export function skillView(m: Master, d: SkillDef): SkillView {
  return { ...toRaceSkill(d), rarity: d.rarity, styles: [...d.styles], condition: conditionText(d), effect: effectText(d), rankedEffect: effectText(capSkill(d, m.skills.rankedCaps)) };
}

/** GET /v1/skills: the catalog (no odds: skills fire from conditions only). */
export function skillCatalog(m: Master) {
  return { skills: m.skills.skills.map((d) => skillView(m, d)), notice: '固有スキルは条件を満たすと1レースに1回発動します（確率では決まりません）。ランク戦などでは効果に上限がかかります。' };
}

/** Short skill summary attached to gacha odds rows (display only; never changes the odds). */
export function skillSummary(m: Master, d: SkillDef | null) {
  return d ? { id: d.id, name: d.name, rarity: d.rarity, condition: conditionText(d), effect: effectText(d) } : null;
}

// ---------- validation ----------

/** Problems with the skill master against the templates and a ruleset (empty = ok). */
export function skillProblems(m: Pick<Master, 'skills' | 'templates'>, ruleset: Record<string, unknown>): string[] {
  const p: string[] = [];
  const sm = m.skills;
  const caps = rulesetSkillCaps(ruleset);
  if (!caps) p.push('ruleset has no skill keys (1.3): skills would be ignored by the engine');
  const seen = new Set<string>();
  for (const s of sm.skills) {
    if (seen.has(s.id)) p.push(`skill ${s.id}: duplicate id`);
    seen.add(s.id);
    const parsed = raceSkillSchema.safeParse(toRaceSkill(s));
    if (!parsed.success) p.push(`skill ${s.id}: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
    if (!['R', 'SR', 'SSR'].includes(s.rarity)) p.push(`skill ${s.id}: unknown rarity ${s.rarity}`);
    if (!Array.isArray(s.styles) || s.styles.length === 0 || s.styles.some((x) => !['nige', 'senko', 'sashi', 'oikomi'].includes(x))) p.push(`skill ${s.id}: styles must list running styles`);
    if (caps) for (const k of EFFECT_KEYS) if (s[k] > caps[k]) p.push(`skill ${s.id}: ${k} ${s[k]} exceeds ruleset ${RULESET_CAP_KEY[k]} ${caps[k]}`);
    if (s.durationTicks === 0 && (s.speedPermille > 0 || s.accelPermille > 0 || s.drainSavePermille > 0)) p.push(`skill ${s.id}: timed effect with durationTicks 0`);
    if (EFFECT_KEYS.every((k) => k === 'durationTicks' || s[k] === 0)) p.push(`skill ${s.id}: no effect`);
  }
  for (const k of EFFECT_KEYS) {
    const v = sm.rankedCaps?.[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) p.push(`rankedCaps.${k} must be a non-negative integer`);
    else if (caps && v > caps[k]) p.push(`rankedCaps.${k} ${v} exceeds ruleset ${RULESET_CAP_KEY[k]} ${caps[k]}`);
  }
  const inh = sm.inheritance;
  const okP = (x: unknown) => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 1000;
  if (!okP(inh?.singleParentPermille) || !okP(inh?.eachOfTwoParentsPermille) || inh.eachOfTwoParentsPermille * 2 > 1000) p.push('inheritance permille must be 0..1000 (two parents together at most 1000)');
  for (const t of m.templates) {
    if (!t.skillId) continue;
    const s = sm.byId.get(t.skillId);
    if (!s) { p.push(`template ${t.id}: unknown skill ${t.skillId}`); continue; }
    if (s.rarity !== t.rarity) p.push(`template ${t.id}: ${t.rarity} horse with ${s.rarity} skill ${s.id}`);
    if (!s.styles.includes(t.style)) p.push(`template ${t.id}: skill ${s.id} does not fit style ${t.style}`);
  }
  return p;
}

export function validateSkills(m: Pick<Master, 'skills' | 'templates'>, ruleset: Record<string, unknown>): void {
  const problems = skillProblems(m, ruleset);
  if (problems.length) throw new AppError('CONFIG_INVALID', problems.join('; '));
}

