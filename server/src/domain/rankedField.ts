// Quality pass 2 (docs/quality/ranked.md, REQ-MM-008..010): how a ranked race's card is made — which course, which CPU
// riders. Pure functions over the master; createRace / rankedMatchRules call them. Ranked fairness: nothing here depends on
// anything purchasable — only the horses' own aptitudes (every horse has one), the class, and the player's ranked-race count.
import type { Master } from './master.js';
import { randInt, type Rng } from './rng.js';

export interface RankedFieldConfig {
  /**
   * REQ-MM-008: the course is drawn among the courses inside the most human horses' distance and surface aptitude (every
   * course when none fits). Off = any course (before quality pass 2, about 45% of a turf horse's ranked races were on a
   * course it is not made for: −5% top speed and stamina per miss, almost never a win).
   */
  courseFitsHorses: boolean;
  /**
   * REQ-MM-009: the CPU riders' level per class, clamped around the level the match rating gives (cpuLevelFor). C, the class
   * every player starts in, keeps average CPU riders; S meets the best. Absent class = the rating level as before.
   */
  cpuLevelByClass?: Record<string, { min: number; max: number }>;
  /**
   * REQ-MM-011: the CPU horses of a class race at this stat total (scaled up or down from their template, the template's
   * balance between stats kept, each stat ≤ 1000) — a class is a field of that class's strength. Before quality pass 2 a CPU
   * horse was only scaled down to the cap, so above C most of the field (the R horses, ~2,800) stayed far under it and a
   * raised horse found the higher classes easier than C. Absent class = the template's stats capped as before.
   */
  cpuStatTotalByClass?: Record<string, number>;
  /**
   * REQ-MM-010: after the beginner matches (progression.beginnerMatch, the first `beginnerRaces` races), the CPU horses' stats
   * come back to full strength over these steps (permille, one per ranked race) instead of in one jump — the first regular
   * races no longer fall off a cliff. Empty / absent = full strength at once (as before).
   */
  rampCpuStatPermille?: number[];
}

/** Track `t` is inside horse `h`'s aptitude (the engine's aptitude rule: distance range and surface, `both` = any). */
export function courseFits(t: { distanceM: number; surface: string }, h: { distMinM: number; distMaxM: number; surface: string }): boolean {
  return t.distanceM >= h.distMinM && t.distanceM <= h.distMaxM && (h.surface === 'both' || h.surface === t.surface);
}

/**
 * REQ-MM-008: the ranked course — uniformly among the courses that fit the most human horses (one draw from `rng`, like the
 * plain draw it replaces). A match of horses with nothing in common still gets a course that fits as many as possible.
 */
export function rankedCourse(m: Pick<Master, 'tracks'>, horses: { distMinM: number; distMaxM: number; surface: string }[], rng: Rng): string {
  const score = m.tracks.map((t) => horses.filter((h) => courseFits(t, h)).length);
  const best = Math.max(...score);
  const pool = m.tracks.filter((_, i) => score[i] === best);
  return pool[randInt(rng, pool.length)]!.id;
}

/** REQ-MM-009: the CPU level of a ranked match in `classId` (the rating level, clamped to the class's band). */
export function rankedCpuLevel(cfg: RankedFieldConfig | undefined, classId: string | null, ratingLevel: number): number {
  const band = classId ? cfg?.cpuLevelByClass?.[classId] : undefined;
  return band ? Math.max(band.min, Math.min(band.max, ratingLevel)) : ratingLevel;
}

/** REQ-MM-011: the CPU stat total of a ranked match in `classId` (null = the template's stats, capped as before). */
export function rankedCpuStatTotal(cfg: RankedFieldConfig | undefined, classId: string | null): number | null {
  return (classId ? cfg?.cpuStatTotalByClass?.[classId] : undefined) ?? null;
}

/** REQ-MM-010: the CPU stat permille of a regular match for a player with `rankedRaces` races (1000 = full strength). */
export function rankedRampPermille(cfg: RankedFieldConfig | undefined, rankedRaces: number, beginnerRaces: number): number {
  const ramp = cfg?.rampCpuStatPermille ?? [];
  const i = rankedRaces - beginnerRaces;
  return i >= 0 && i < ramp.length ? ramp[i]! : 1000;
}

/** Remote-config / boot check of `progression.rankedField`. */
export function rankedFieldProblems(r: unknown, classIds: string[]): string[] {
  if (r === undefined) return [];
  const o = r as Partial<RankedFieldConfig> | null;
  if (!o || typeof o !== 'object') return ['progression.rankedField must be an object'];
  const p: string[] = [];
  const allowed = new Set(['_note', 'courseFitsHorses', 'cpuLevelByClass', 'cpuStatTotalByClass', 'rampCpuStatPermille']);
  for (const k of Object.keys(o)) if (!allowed.has(k)) p.push(`progression.rankedField: unknown key ${k}`);
  if (typeof o.courseFitsHorses !== 'boolean') p.push('progression.rankedField.courseFitsHorses must be a boolean');
  if (o.cpuLevelByClass !== undefined) {
    if (!o.cpuLevelByClass || typeof o.cpuLevelByClass !== 'object') p.push('progression.rankedField.cpuLevelByClass must be an object');
    else for (const [c, b] of Object.entries(o.cpuLevelByClass)) {
      if (!classIds.includes(c)) p.push(`progression.rankedField.cpuLevelByClass: unknown class ${c}`);
      const ok = (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5;
      if (!b || !ok(b.min) || !ok(b.max) || b.min > b.max) p.push(`progression.rankedField.cpuLevelByClass.${c} must be { min ≤ max } in 1..5`);
    }
  }
  if (o.cpuStatTotalByClass !== undefined) {
    if (!o.cpuStatTotalByClass || typeof o.cpuStatTotalByClass !== 'object') p.push('progression.rankedField.cpuStatTotalByClass must be an object');
    else for (const [c, v] of Object.entries(o.cpuStatTotalByClass)) {
      if (!classIds.includes(c)) p.push(`progression.rankedField.cpuStatTotalByClass: unknown class ${c}`);
      if (!Number.isInteger(v) || v < 1000 || v > 5000) p.push(`progression.rankedField.cpuStatTotalByClass.${c} must be an integer in 1000..5000`);
    }
  }
  if (o.rampCpuStatPermille !== undefined) {
    const a = o.rampCpuStatPermille;
    // a ramp only weakens CPUs (never above full strength) and only rises (no step back down), at most 20 races long
    if (!Array.isArray(a) || a.length > 20 || a.some((v, i) => !Number.isInteger(v) || v < 500 || v > 1000 || (i > 0 && v < a[i - 1]!))) {
      p.push('progression.rankedField.rampCpuStatPermille must be ≤ 20 rising integers in 500..1000');
    }
  }
  return p;
}
