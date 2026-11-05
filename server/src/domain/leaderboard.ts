import { jstMonthKey } from './time.js';

/**
 * Leaderboards & season rollover (REQ-LB-*, REQ-SEASON-*). Pure logic: the LeaderboardDO (one per
 * season) stores entries in SQLite and calls these functions; tests use arrays.
 */

/** One player's standing in one season, pushed by the player's Durable Object after ranked races. */
export interface SeasonEntry {
  playerId: string; seasonId: string; classId: string; points: number; rating: number; races: number;
  displayName: string; titleId: string | null; updatedAt: number;
}

export interface RankInfo { classId: string; classRank: number; classTotal: number; ratingRank: number; ratingTotal: number }

export interface BoardRow { rank: number; playerId: string; displayName: string; titleId: string | null; classId: string; points: number; rating: number; races: number }
export interface BoardFile { seasonId: string; board: string; generatedAt: number; total: number; entries: BoardRow[] }
export interface SnapshotOutput { files: { key: string; body: BoardFile | SnapshotIndex }[]; ranks: Map<string, RankInfo> }
export interface SnapshotIndex { seasonId: string; generatedAt: number; boards: { board: string; total: number; key: string }[] }

/** Season points desc → rating desc → reached earlier → player id (total order, stable). */
export function comparePoints(a: SeasonEntry, b: SeasonEntry) {
  return b.points - a.points || b.rating - a.rating || a.updatedAt - b.updatedAt || (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0);
}
/** Rating desc → more races → player id. */
export function compareRating(a: SeasonEntry, b: SeasonEntry) {
  return b.rating - a.rating || b.races - a.races || (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0);
}

const row = (e: SeasonEntry, rank: number): BoardRow => ({ rank, playerId: e.playerId, displayName: e.displayName, titleId: e.titleId, classId: e.classId, points: e.points, rating: e.rating, races: e.races });

export const boardKey = (seasonId: string, board: string) => `leaderboards/${seasonId}/${board}.json`;
export const indexKey = (seasonId: string) => `leaderboards/${seasonId}/index.json`;

/**
 * REQ-LB-001: builds the public snapshot files (top N per class by season points, and an all-class
 * rating board) and every participant's rank (for "my rank" lookups). Players with 0 races are skipped.
 */
export function buildSnapshot(seasonId: string, entries: SeasonEntry[], now: number, topN: number): SnapshotOutput {
  const active = entries.filter((e) => e.seasonId === seasonId && e.races > 0);
  const byClass = new Map<string, SeasonEntry[]>();
  for (const e of active) {
    let l = byClass.get(e.classId);
    if (!l) byClass.set(e.classId, (l = []));
    l.push(e);
  }
  const ranks = new Map<string, RankInfo>();
  const files: SnapshotOutput['files'] = [];
  const index: SnapshotIndex = { seasonId, generatedAt: now, boards: [] };
  for (const classId of [...byClass.keys()].sort()) {
    const list = byClass.get(classId)!.sort(comparePoints);
    list.forEach((e, i) => ranks.set(e.playerId, { classId, classRank: i + 1, classTotal: list.length, ratingRank: 0, ratingTotal: 0 }));
    const board = `class-${classId}`;
    files.push({ key: boardKey(seasonId, board), body: { seasonId, board, generatedAt: now, total: list.length, entries: list.slice(0, topN).map((e, i) => row(e, i + 1)) } });
    index.boards.push({ board, total: list.length, key: boardKey(seasonId, board) });
  }
  const byRating = active.slice().sort(compareRating);
  byRating.forEach((e, i) => {
    const r = ranks.get(e.playerId)!;
    r.ratingRank = i + 1;
    r.ratingTotal = byRating.length;
  });
  files.push({ key: boardKey(seasonId, 'rating'), body: { seasonId, board: 'rating', generatedAt: now, total: byRating.length, entries: byRating.slice(0, topN).map((e, i) => row(e, i + 1)) } });
  index.boards.push({ board: 'rating', total: byRating.length, key: boardKey(seasonId, 'rating') });
  files.push({ key: indexKey(seasonId), body: index });
  return { files, ranks };
}

/** Last write wins per player; entries for another season are rejected (late hook after rollover). */
export function acceptEntry(seasonId: string, status: RolloverStatus, e: SeasonEntry): boolean {
  return e.seasonId === seasonId && status === 'open';
}

export type RolloverStatus = 'open' | 'closing' | 'closed';
export interface RolloverState { seasonId: string; status: RolloverStatus; cursor: string; processed: number; lastError: string | null }
export const newRolloverState = (seasonId: string): RolloverState => ({ seasonId, status: 'open', cursor: '', processed: 0, lastError: null });

/** The JST month before `now`'s month ("YYYY-MM"). */
export function previousSeasonId(now: number): string {
  const [y, m] = jstMonthKey(now).split('-').map(Number) as [number, number];
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, '0')}`;
}

export const seasonIsOver = (seasonId: string, now: number) => seasonId < jstMonthKey(now);

export interface Participant { playerId: string; classId: string }

/**
 * REQ-SEASON-001/003: one resumable step of closing a season. The caller must have taken the final
 * snapshot (ranks) before the first step. Players are processed in player-id order after `cursor`;
 * the cursor advances only after each player's close succeeded, so an interrupted run resumes where
 * it stopped and a re-run never skips anyone. `close` must itself be idempotent (it is: the player's
 * season record is marked rewarded).
 */
export async function rolloverStep(
  st: RolloverState,
  participantsAfterCursor: Participant[],
  rankOf: (playerId: string) => RankInfo | undefined,
  close: (playerId: string, rank: number | null, total: number) => Promise<void>,
  batch: number,
): Promise<RolloverState> {
  const next: RolloverState = { ...st, lastError: null };
  if (next.status === 'closed') return next;
  if (next.status === 'open') next.status = 'closing';
  const todo = participantsAfterCursor.filter((p) => p.playerId > next.cursor).sort((a, b) => (a.playerId < b.playerId ? -1 : 1)).slice(0, batch);
  for (const p of todo) {
    const r = rankOf(p.playerId);
    try {
      await close(p.playerId, r?.classRank ?? null, r?.classTotal ?? 0);
    } catch (e) {
      next.lastError = `${p.playerId}: ${(e as Error).message}`;
      return next;
    }
    next.cursor = p.playerId;
    next.processed++;
  }
  if (todo.length < batch) next.status = 'closed';
  return next;
}
