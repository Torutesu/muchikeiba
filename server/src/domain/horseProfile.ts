/**
 * Quality pass (raising & breeding, docs/quality/raising-breeding.md): 馬カード — one read-only view of a horse that shows it
 * growing. Everything here is derived from state that already exists (base stats, awakening, training growth, the §34 career
 * record, the parents in the stable); nothing is written, granted or drawn, so no economy target (E1..E19), no race result and
 * no ranked number moves.
 *
 * - stats: each of the 5 stats as layers base → +awakening → +training (= what the horse races with, each ≤ 1000), and the
 *   same stats after the player's current class normalisation (normalizeStats keeps the proportions, so a horse trained toward
 *   burst still races as a burst horse in ranked even when its total is capped — the honest answer to "does training matter").
 * - growth: the training potential used, and a growth stage (新馬 → 成長期 → 充実期 → 本格化 → 完成) from the share of the
 *   potential used. Display only (no reward is attached to a stage; nothing to collect).
 * - leaning: the stat training has pushed most, and how much its share of the horse moved.
 * - lineage: the generation in this stable, the line, the parents, where the unique skill came from, 隔世遺伝.
 * - career / recent training: copied from the §34 record and the §25 log.
 * C#: Muchi.Client HorseProfile (parse) and GrowthStages (the same stage function; contracts/horse-profile.vectors.json).
 */
import { AppError } from './errors.js';
import { STAT_KEYS, type Master, type Stats } from './master.js';
type StatKey = keyof Stats;
import type { HorseInstance, PlayerState } from './player.js';
import { effectiveStats } from './horses.js';
import { classDef, normalizeStats } from './season.js';
import { horseSkillId, skillSummary } from './skills.js';
import { perStatCap, potentialOf, raceStats, trainedTotal, trainingConfig } from './training.js';

/** Stage keys in order. Thresholds are permille of the potential used; `complete` needs the whole potential. */
export const GROWTH_STAGES = ['debut', 'growing', 'prime', 'peak', 'complete'] as const;
export type GrowthStage = (typeof GROWTH_STAGES)[number];
export const GROWTH_THRESHOLDS_PERMILLE = [0, 100, 350, 650, 1000] as const;

/**
 * The growth stage of a horse from its training growth (pure; C# GrowthStages.Of is the same, contracts/horse-profile.vectors.json).
 * Returns the stage index (0..4) and the trained total at which the next stage starts (null at the last stage, or with no potential).
 */
export function growthStage(trained: number, potential: number): { index: number; key: GrowthStage; nextAt: number | null } {
  if (!(potential > 0)) return { index: 0, key: 'debut', nextAt: null };
  const t = Math.max(0, Math.min(potential, Math.trunc(trained)));
  let index = 0;
  for (let i = 1; i < GROWTH_THRESHOLDS_PERMILLE.length; i++) if (t * 1000 >= GROWTH_THRESHOLDS_PERMILLE[i]! * potential) index = i;
  const next = GROWTH_THRESHOLDS_PERMILLE[index + 1];
  return { index, key: GROWTH_STAGES[index]!, nextAt: next === undefined ? null : Math.ceil((next * potential) / 1000) };
}

const sum = (s: Stats) => STAT_KEYS.reduce((a, k) => a + s[k], 0);
/** Share of each stat in permille of the total (integer, floor). */
const shares = (s: Stats): Stats => {
  const t = sum(s);
  const out = {} as Stats;
  for (const k of STAT_KEYS) out[k] = t > 0 ? Math.floor((s[k] * 1000) / t) : 0;
  return out;
};

const GEN_DEPTH = 30;
/** Generation in this stable: a scouted/gift horse is 1, a foal is one more than its oldest-line parent found in the stable. */
export function generationOf(s: PlayerState, h: HorseInstance, depth = 0): number {
  if (depth >= GEN_DEPTH || h.templateId) return 1;
  let best = 1; // a parent outside the stable (a borrowed stallion, a released horse) counts as generation 1
  for (const pid of [h.sireId, h.damId]) {
    const p = pid ? s.horses.find((x) => x.id === pid) : undefined;
    if (p) best = Math.max(best, generationOf(s, p, depth + 1));
  }
  return best + 1;
}

/** Where the horse's unique skill came from: its own template, a parent (when that parent has the same skill), or unknown. */
function skillOrigin(m: Master, s: PlayerState, h: HorseInstance, skillId: string | null): 'own' | 'sire' | 'dam' | null {
  if (!skillId) return null;
  if (h.templateId) return 'own';
  const parentSkill = (id: string | null) => {
    const p = id ? s.horses.find((x) => x.id === id) : undefined;
    return p ? horseSkillId(m, p) : null;
  };
  if (parentSkill(h.sireId) === skillId) return 'sire';
  if (parentSkill(h.damId) === skillId) return 'dam';
  if (h.studSire) return 'sire'; // the borrowed stallion is not in this stable; a foal's skill only comes from its parents
  return null;
}

/** GET /v1/horses/:horseId/profile. Read-only. */
export function horseProfile(m: Master, s: PlayerState, horseId: string) {
  const h = s.horses.find((x) => x.id === horseId);
  if (!h) throw new AppError('HORSE_NOT_FOUND', horseId);
  const eff = effectiveStats(m, h);
  const race = raceStats(m, h);
  const cls = classDef(m, s.season.classId);
  const ranked = normalizeStats(race, cls.statCap);
  const tc = trainingConfig(m);
  const trained = {} as Stats;
  for (const k of STAT_KEYS) trained[k] = race[k] - eff[k]; // what training adds after the 1000 ceiling
  const stats = STAT_KEYS.map((k) => ({ key: k, base: Math.min(eff[k], h.base[k]), awakening: Math.max(0, eff[k] - h.base[k]), trained: trained[k], race: race[k], ranked: ranked[k] }));
  const raceTotal = sum(race);
  const effShare = shares(eff), raceShare = shares(race);
  const tt = trainedTotal(h);
  let leaning: { stat: StatKey; trained: number; sharePermilleBefore: number; sharePermilleNow: number } | null = null;
  if (tt > 0) {
    const top = STAT_KEYS.reduce<StatKey>((best, k) => (trained[k] > trained[best] ? k : best), STAT_KEYS[0]!);
    if (trained[top] > 0) leaning = { stat: top, trained: trained[top], sharePermilleBefore: effShare[top], sharePermilleNow: raceShare[top] };
  }
  const potential = tc ? potentialOf(tc, h) : 0;
  const stage = growthStage(tt, potential);
  const rec = s.training?.horses[h.id];
  const career = s.hall?.careers[h.id];
  const skillId = horseSkillId(m, h);
  const skill = skillId ? skillSummary(m, m.skills.byId.get(skillId)!) : null;
  return {
    horseId: h.id, name: h.name, rarity: h.rarity, sex: h.sex, style: h.style, status: h.status,
    surface: h.surface, distMinM: h.distMinM, distMaxM: h.distMaxM, goingAptitude: h.goingAptitude ?? 'any',
    partner: s.flags.partnerHorseId === h.id,
    stats,
    totals: { base: sum(h.base), effective: sum(eff), race: raceTotal, ranked: sum(ranked), classId: cls.id, cap: cls.statCap, capped: raceTotal > cls.statCap, toCap: Math.max(0, cls.statCap - raceTotal) },
    /** Null when training is switched off. */
    growth: tc ? { trainedTotal: tt, potential, perStatCap: perStatCap(tc, h), stage: stage.index, stageKey: stage.key, nextStageAt: stage.nextAt, sessions: rec?.sessions ?? 0 } : null,
    leaning,
    lineage: {
      generation: generationOf(s, h), line: h.line, sireName: h.sireName, damName: h.damName, studSire: !!h.studSire,
      bred: !h.templateId, skill, skillFrom: skillOrigin(m, s, h, skillId), atavism: h.atavism ?? null,
    },
    career: career
      ? { races: career.races, wins: career.wins, places: career.places, rivalWins: career.rivalWins, tournamentWins: career.tournamentWins, biggestWin: career.biggestWin, firstRaceAt: career.firstRaceAt }
      : { races: 0, wins: 0, places: 0, rivalWins: 0, tournamentWins: 0, biggestWin: null, firstRaceAt: null },
    recentTraining: (rec?.log ?? []).slice(0, 5),
  };
}
