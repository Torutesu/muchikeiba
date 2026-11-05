import { AppError } from './errors.js';
import { STAT_KEYS, type ClassDef, type Master, type Stats } from './master.js';
import type { PlayerState } from './player.js';
import { jstMonthKey } from './time.js';

export const seasonIdFor = (now: number) => jstMonthKey(now);

export function classDef(m: Master, id: string): ClassDef {
  const c = m.progression.classes.find((x) => x.id === id);
  if (!c) throw new AppError('CONFIG_INVALID', `class ${id}`);
  return c;
}

/**
 * REQ-RATE-003: ranked normalization. If the stat total exceeds the class cap, every stat is scaled
 * by the same ratio (integer, floor). Style/aptitude are untouched.
 */
export function normalizeStats(stats: Stats, cap: number): Stats {
  const total = STAT_KEYS.reduce((a, k) => a + stats[k], 0);
  if (total <= cap) return { ...stats };
  const out = {} as Stats;
  for (const k of STAT_KEYS) out[k] = Math.floor((stats[k] * cap) / total);
  return out;
}

export function seasonPointsFor(m: Master, place: number): number {
  return m.progression.seasonPointsByPlace[place - 1] ?? 0;
}

/** Ensures the player's season record is for the current season; closes the old one (promotion/demotion). */
export function rollSeason(m: Master, s: PlayerState, now: number): { closed: boolean; from?: string; to?: string } {
  const id = seasonIdFor(now);
  if (s.season.id === id) return { closed: false };
  const classes = m.progression.classes;
  const idx = classes.findIndex((c) => c.id === s.season.classId);
  const c = classes[idx]!;
  let next = idx;
  if (c.promotePoints !== null && s.season.points >= c.promotePoints && idx < classes.length - 1) next = idx + 1;
  else if (c.demoteBelowPoints !== null && s.season.points < c.demoteBelowPoints && idx > 0) next = idx - 1;
  const from = c.id;
  s.season = { id, classId: classes[next]!.id, points: 0 };
  s.seasonPass = { expiresAt: s.seasonPass.expiresAt, xp: 0, claimed: { free: [], premium: [] }, seasonId: id };
  return { closed: true, from, to: classes[next]!.id };
}
