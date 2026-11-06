/**
 * REQ-UXS-012: personal push nudges inside the existing categories (season / events / friends), on top of the
 * generic push rules (preferences, quiet hours, daily cap — push.ts):
 *   promotion_near      season  "1 win from promotion": within `promotionNearPoints` of the class's promotion line and
 *                               no ranked race for `promotionIdleMs`; at most once per season (player object alarm).
 *   tournament_closing  events  registration closes in `tournamentClosingLeadMs`; only players who meet the entry
 *                               conditions and have not registered (cron, see index.ts tournamentClosingStep).
 *   ta_beaten           friends a friend beat your time attack record on a course; at most once per game day.
 */
import { enqueuePush, type EnqueueResult } from './push.js';
import type { Master } from './master.js';
import type { PlayerState } from './player.js';
import { classDef } from './season.js';
import { gameDayKey } from './time.js';

export interface NudgeConfig {
  promotionNearPoints: number;
  promotionIdleMs: number;
  tournamentClosingLeadMs: number;
  /** Players notified per tournament (the cron fans out to at most this many objects). */
  tournamentClosingMaxTargets: number;
}
export interface NudgeState {
  promotion?: { seasonId: string; checkAt: number | null; sent: boolean };
  taBeatenDay?: string;
  /** Tournament ids already nudged (newest last, capped). */
  tournaments?: string[];
}

const TOURNAMENTS_KEEP = 20;
const ensure = (s: PlayerState): NudgeState => (s.nudges ??= {});

/** Points left to the class's promotion line (null in the top class). */
export function pointsToPromotion(m: Master, s: PlayerState): number | null {
  const p = classDef(m, s.season.classId).promotePoints;
  return p === null ? null : Math.max(0, p - s.season.points);
}

/** After each ranked race: (re)arm the idle check while the player is close to promotion. */
export function armPromotionNudge(m: Master, s: PlayerState, now: number) {
  const cfg = m.progression.nudges;
  if (!cfg) return;
  const n = ensure(s);
  if (!n.promotion || n.promotion.seasonId !== s.season.id) n.promotion = { seasonId: s.season.id, checkAt: null, sent: false };
  if (n.promotion.sent) return;
  const left = pointsToPromotion(m, s);
  n.promotion.checkAt = left !== null && left > 0 && left <= cfg.promotionNearPoints ? now + cfg.promotionIdleMs : null;
}

export function nextNudgeWake(s: PlayerState): number | null {
  return s.nudges?.promotion?.checkAt ?? null;
}

/** Alarm: send the promotion nudge if it is due and still true. */
export function runDueNudges(m: Master, s: PlayerState, now: number): EnqueueResult | null {
  const p = s.nudges?.promotion;
  if (!p || p.checkAt === null || now < p.checkAt) return null;
  p.checkAt = null;
  const left = pointsToPromotion(m, s);
  const cfg = m.progression.nudges;
  if (p.sent || p.seasonId !== s.season.id || !cfg || left === null || left <= 0 || left > cfg.promotionNearPoints) return null;
  const r = enqueuePush(m, s, 'promotion_near', { points: String(left) }, now);
  if (r.status === 'queued') p.sent = true;
  return r;
}

/** A friend beat this player's time attack record (`byName`, course name). At most once per game day. */
export function nudgeTaBeaten(m: Master, s: PlayerState, byName: string, course: string, now: number): EnqueueResult | { status: 'skipped'; reason: 'already_today' } {
  const n = ensure(s);
  const day = gameDayKey(now);
  if (n.taBeatenDay === day) return { status: 'skipped', reason: 'already_today' };
  const r = enqueuePush(m, s, 'ta_beaten', { name: byName, course }, now);
  if (r.status === 'queued') n.taBeatenDay = day;
  return r;
}

export interface TournamentClosingInfo { tournamentId: string; name: string; classIds: string[] | null; minRankedRaces: number; minutes: number }

/** Registration closes soon: nudge a player who meets the entry conditions (the caller excludes registrants). */
export function nudgeTournamentClosing(m: Master, s: PlayerState, t: TournamentClosingInfo, now: number): EnqueueResult | { status: 'skipped'; reason: 'not_eligible' | 'already' } {
  if ((t.classIds && !t.classIds.includes(s.season.classId)) || s.rating.rankedRaces < t.minRankedRaces) return { status: 'skipped', reason: 'not_eligible' };
  const n = ensure(s);
  if (n.tournaments?.includes(t.tournamentId)) return { status: 'skipped', reason: 'already' };
  const r = enqueuePush(m, s, 'tournament_closing', { tournament: t.name, minutes: String(t.minutes) }, now);
  n.tournaments = [...(n.tournaments ?? []), t.tournamentId].slice(-TOURNAMENTS_KEEP);
  return r;
}

/** Validation of progression.nudges (boot and remote config). */
export function nudgeProblems(c: NudgeConfig | undefined): string[] {
  if (!c) return [];
  const out: string[] = [];
  const intIn = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  if (!intIn(c.promotionNearPoints, 1, 1000)) out.push('progression.nudges.promotionNearPoints must be 1..1000');
  if (!intIn(c.promotionIdleMs, 3_600_000, 7 * 86_400_000)) out.push('progression.nudges.promotionIdleMs must be 1h..7d');
  if (!intIn(c.tournamentClosingLeadMs, 300_000, 86_400_000)) out.push('progression.nudges.tournamentClosingLeadMs must be 5min..24h');
  if (!intIn(c.tournamentClosingMaxTargets, 0, 5000)) out.push('progression.nudges.tournamentClosingMaxTargets must be 0..5000');
  return out;
}
