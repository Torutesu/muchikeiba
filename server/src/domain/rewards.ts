import { AppError } from './errors.js';
import { grantReward } from './items.js';
import type { Master } from './master.js';
import type { PlayerState } from './player.js';
import type { RaceMode } from './schemas.js';
import { seasonPointsFor } from './season.js';
import { DAY_MS, jstDateKey } from './time.js';
import { grantFree } from './wallet.js';
import type { Rating } from './rating.js';
import { applyStats, evaluateTitles, type RaceDetails } from './stats.js';

/** REQ-REW-002: 7-day login bonus, once per JST day, cumulative (missing days does not reset). */
export function claimLoginBonus(m: Master, s: PlayerState, now: number) {
  const today = jstDateKey(now);
  if (s.loginBonus.lastClaimDate === today) throw new AppError('ALREADY_CLAIMED');
  const day = (s.loginBonus.streakDay % m.progression.loginBonus.length) + 1;
  const def = m.progression.loginBonus.find((d) => d.day === day)!;
  grantReward(s, def, now, `login bonus day ${day}`, today);
  s.loginBonus = { streakDay: day, lastClaimDate: today };
  return { day, reward: def };
}

function ensureMissionDay(s: PlayerState, now: number) {
  const today = jstDateKey(now);
  if (s.missions.date !== today) s.missions = { date: today, progress: {}, claimed: [] };
}

export function missionsView(m: Master, s: PlayerState, now: number) {
  ensureMissionDay(s, now);
  return m.progression.dailyMissions.map((d) => ({ ...d, progress: Math.min(d.target, s.missions.progress[d.id] ?? 0), claimed: s.missions.claimed.includes(d.id) }));
}

export function claimMission(m: Master, s: PlayerState, id: string, now: number) {
  ensureMissionDay(s, now);
  const d = m.progression.dailyMissions.find((x) => x.id === id);
  if (!d) throw new AppError('NOT_FOUND', `mission ${id}`);
  if (s.missions.claimed.includes(id)) throw new AppError('ALREADY_CLAIMED');
  if ((s.missions.progress[id] ?? 0) < d.target) throw new AppError('NOT_ELIGIBLE');
  s.missions.claimed.push(id);
  grantReward(s, d.reward, now, `mission ${id}`, s.missions.date);
  return d.reward;
}

export function passLevel(m: Master, s: PlayerState) {
  return Math.min(m.progression.passMaxLevel, Math.floor(s.seasonPass.xp / m.progression.passXpPerLevel));
}

export const passActive = (s: PlayerState, now: number) => s.seasonPass.expiresAt > now;

/** REQ-REW-003 */
export function claimPass(m: Master, s: PlayerState, track: 'free' | 'premium', level: number, now: number) {
  if (!Number.isInteger(level) || level < 1 || level > passLevel(m, s)) throw new AppError('NOT_ELIGIBLE');
  if (track === 'premium' && !passActive(s, now)) throw new AppError('NOT_ELIGIBLE', 'season pass not active');
  const def = m.progression.passRewards[track];
  if (level % def.every !== 0) throw new AppError('NOT_ELIGIBLE');
  if (s.seasonPass.claimed[track].includes(level)) throw new AppError('ALREADY_CLAIMED');
  s.seasonPass.claimed[track].push(level);
  grantReward(s, def.reward, now, `pass ${track} ${level}`, String(level));
  return def.reward;
}

export interface RaceResultForPlayer {
  raceId: string; mode: RaceMode; place: number; fieldSize: number; newRating: Rating | null; void: boolean;
  /** Ride details derived from the confirmed input log (REQ-STAT-002). Absent for results from older rooms. */
  details?: RaceDetails | null;
  /** Human riders in the race (REQ-REW-004: friend races need at least 2). */
  humans?: number;
  /** Rating snapshot the race was matched with; the update is applied as a delta against it (REQ-RATE-004). */
  oldRating?: Rating | null;
  /** REQ-EVENT-005: set for event races. */
  eventId?: string;
}

/** REQ-RATE-004: apply the race's rating change as a delta, so a newer rating is never overwritten by a stale snapshot. */
export function applyRatingChange(s: PlayerState, oldR: Rating | null | undefined, newR: Rating) {
  const cur = s.rating;
  if (!oldR || (cur.r === oldR.r && cur.rd === oldR.rd && cur.vol === oldR.vol)) {
    s.rating = { ...newR, rankedRaces: cur.rankedRaces };
    return;
  }
  s.rating = { r: cur.r + (newR.r - oldR.r), rd: Math.max(30, Math.min(cur.rd, newR.rd)), vol: newR.vol, rankedRaces: cur.rankedRaces };
}

/** REQ-REW-004: friend races pay only with ≥2 humans and at most friendRewardDailyCap times per JST day. */
export function friendRewardAllowed(m: Master, s: PlayerState, r: RaceResultForPlayer, now: number): boolean {
  if (r.mode !== 'friend') return true;
  if ((r.humans ?? 0) < 2) return false;
  const today = jstDateKey(now);
  if (s.friendRewards.date !== today) s.friendRewards = { date: today, count: 0 };
  if (s.friendRewards.count >= m.progression.friendRewardDailyCap) return false;
  s.friendRewards.count++;
  return true;
}

/** REQ-REW-001: apply a confirmed race outcome to one player. Idempotency is handled by the caller (key = race id). */
export function applyRaceResult(m: Master, s: PlayerState, r: RaceResultForPlayer, now: number) {
  if (r.void) return { coins: 0, seasonPoints: 0, titles: [] as string[], rewarded: false };
  const rewarded = friendRewardAllowed(m, s, r, now);
  // time attack runs never come through here (they are settled by src/race/timeAttack.ts)
  const byPlace = (m.progression.raceFreeCoinsByPlace as Partial<Record<RaceMode, number[]>>)[r.mode];
  const coins = rewarded ? byPlace?.[r.place - 1] ?? 0 : 0;
  if (coins > 0) grantFree(s, coins, now, `race ${r.mode} place ${r.place}`, r.raceId);
  let seasonPoints = 0;
  if (r.mode === 'ranked') {
    seasonPoints = seasonPointsFor(m, r.place);
    s.season.points += seasonPoints;
    s.season.races += 1;
    s.rating.rankedRaces += 1;
    if (r.newRating) applyRatingChange(s, r.oldRating, r.newRating);
  }
  if (r.mode !== 'tutorial') {
    if (rewarded) {
      s.seasonPass.xp += m.progression.passXpPerRace;
      ensureMissionDay(s, now);
      const inc = (k: string) => (s.missions.progress[k] = (s.missions.progress[k] ?? 0) + 1);
      for (const d of m.progression.dailyMissions) {
        if (d.kind === 'races') inc(d.id);
        if (d.kind === 'wins' && r.place === 1) inc(d.id);
        if (d.kind === 'top3' && r.place <= 3) inc(d.id);
      }
    }
    // statistics are records, not rewards: friend races with ≥2 humans count even over the daily cap
    if (r.details && (r.mode === 'ranked' || (r.humans ?? 0) >= 2)) applyStats(s, r.place, r.details);
  }
  const titles = evaluateTitles(m, s);
  return { coins, seasonPoints, titles, rewarded };
}

export { DAY_MS };
