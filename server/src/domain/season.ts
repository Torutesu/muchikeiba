import { deliverGift } from './giftBox.js';
import type { KpiEvent } from './kpi.js';
import { AppError } from './errors.js';
import { STAT_KEYS, type ClassDef, type Master, type Reward, type Stats } from './master.js';
import { grantReward } from './items.js';
import type { PlayerState } from './player.js';
import { jstMonthKey } from './time.js';
import { closePassSeason } from './pass.js';
import { closePromotionSeason, shieldApplies, type PromoCloseOutcome } from './promotion.js';

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
export function rollSeason(m: Master, s: PlayerState, now: number): { closed: boolean; from?: string; to?: string; seasonId?: string; promo?: PromoCloseOutcome } {
  const id = seasonIdFor(now);
  if (s.season.id === id) return { closed: false };
  const classes = m.progression.classes;
  const idx = classes.findIndex((c) => c.id === s.season.classId);
  const c = classes[idx]!;
  let next = idx;
  let shielded = false;
  if (c.promotePoints !== null && s.season.points >= c.promotePoints && idx < classes.length - 1) next = idx + 1;
  else if (c.demoteBelowPoints !== null && s.season.points < c.demoteBelowPoints && idx > 0) {
    // REQ-PROMO-011: the demotion shield of a grace window keeps the class once
    if (shieldApplies(m, s, s.season.id, c.id)) shielded = true;
    else next = idx - 1;
  }
  const from = c.id;
  const closedId = s.season.id;
  // REQ-PROMO-008..011: a running series resolves by these points (no carry-over); a promotion opens a grace window
  const promo = closePromotionSeason(m, s, closedId, from, classes[next]!.id, shielded, now);
  // REQ-SEASON-002: keep the closed season so the rollover job can grant its reward later (rank is final only then)
  if (!s.seasonHistory.some((h) => h.seasonId === s.season.id)) {
    s.seasonHistory.push({
      seasonId: s.season.id, classId: from, points: s.season.points, races: s.season.races, nextClassId: classes[next]!.id, rank: null, rewarded: false,
      ...(promo.promo ? { promo: promo.promo } : {}), ...(promo.shielded ? { shielded: true } : {}),
    });
    if (s.seasonHistory.length > SEASON_HISTORY_KEEP) s.seasonHistory.splice(0, s.seasonHistory.length - SEASON_HISTORY_KEEP);
  }
  s.season = { id, classId: classes[next]!.id, points: 0, races: 0 };
  // REQ-UXS-021: unclaimed pass rewards of the closing season are granted in this same transaction as the reset
  closePassSeason(m, s, now);
  const forfeitedAt = s.seasonPass.forfeitedAt; // REQ-UXS-040: stays given up until the wipe
  s.seasonPass = { expiresAt: s.seasonPass.expiresAt, xp: 0, claimed: { free: [], premium: [] }, seasonId: id, ...(forfeitedAt !== undefined ? { forfeitedAt } : {}) };
  return { closed: true, from, to: classes[next]!.id, seasonId: closedId, promo };
}

export const SEASON_HISTORY_KEEP = 24;

/** Reward band for a final rank in a closed class (REQ-SEASON-002). */
export function seasonRewardFor(m: Master, classId: string, rank: number | null): Reward | null {
  const bands = m.progression.seasonRewards[classId];
  if (!bands) return null;
  for (const b of bands) if (b.maxRank === null || (rank !== null && rank <= b.maxRank)) return b.reward;
  return null;
}

/**
 * REQ-SEASON-002: grant the reward of a closed season once. Called by the rollover job with the final
 * class rank. Idempotent: a rewarded record is never paid twice; a player who never raced gets nothing.
 */
export function closeSeason(m: Master, s: PlayerState, seasonId: string, rank: number | null, now: number, emit?: (e: KpiEvent) => void) {
  const h = s.seasonHistory.find((x) => x.seasonId === seasonId);
  // REQ-UXS-021: the pass close already ran in rollSeason (this transaction's first step); report it
  const pass = (s.passHistory ?? []).find((x) => x.seasonId === seasonId) ?? null;
  if (!h) return { status: 'no-record' as const, reward: null, pass };
  if (h.rewarded) return { status: 'already' as const, reward: null, classId: h.classId, nextClassId: h.nextClassId, pass };
  h.rank = rank;
  h.rewarded = true;
  const reward = h.races > 0 ? seasonRewardFor(m, h.classId, rank) : null;
  // REQ-BOX-001: delivered to the gift box (straight into the wallet when the box is off)
  if (reward) deliverGift(m, s, { source: 'season', ref: 'season:' + seasonId, reward, note: 'season ' + seasonId + ' ' + h.classId + ' rank ' + (rank ?? '-'), rank }, now, emit);
  return { status: 'rewarded' as const, reward, classId: h.classId, nextClassId: h.nextClassId, pass };
}
