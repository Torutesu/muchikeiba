import { AppError } from './errors.js';
import { grantReward } from './items.js';
import type { Master, Reward } from './master.js';
import { isLooksOnlyItem } from './visuals.js';
import type { PlayerState } from './player.js';
import type { RaceMode } from './schemas.js';
import { seasonPointsFor } from './season.js';
import { DAY_MS, dayRule, gameDayKey, sameGameDay } from './time.js';
import { grantFree } from './wallet.js';
import type { Rating } from './rating.js';
import { applyStats, evaluateTitles, type RaceDetails } from './stats.js';
import { levelOf, notePassClaim, passRewardAt } from './pass.js';

/**
 * REQ-UXS-010: the day's first wins (1st place) pay extra free coins, up to `freeCoinsByWin.length` per game day,
 * in the configured modes only (ranked: friend races could be farmed). Gives a natural stopping point.
 */
export function applyFirstWinBonus(m: Master, s: PlayerState, r: { mode: RaceMode; place: number; raceId: string }, now: number): number {
  const fw = m.progression.firstWinBonus;
  if (!fw || r.place !== 1 || !fw.modes.includes(r.mode)) return 0;
  const today = gameDayKey(now, dayRule(m));
  if (!s.dailyWins || !sameGameDay(s.dailyWins.date, today)) s.dailyWins = { date: today, count: 0 };
  const n = s.dailyWins.count;
  if (n >= fw.freeCoinsByWin.length) return 0;
  s.dailyWins.count = n + 1;
  const coins = fw.freeCoinsByWin[n] ?? 0;
  if (coins > 0) grantFree(s, coins, now, `first win bonus #${n + 1}`, r.raceId);
  return coins;
}

export function firstWinBonusView(m: Master, s: PlayerState, now: number) {
  const fw = m.progression.firstWinBonus;
  if (!fw) return { modes: [] as string[], byWin: [] as number[], winsToday: 0, remaining: 0, next: null };
  const winsToday = s.dailyWins && sameGameDay(s.dailyWins.date, gameDayKey(now, dayRule(m))) ? s.dailyWins.count : 0;
  const remaining = Math.max(0, fw.freeCoinsByWin.length - winsToday);
  return { modes: fw.modes, byWin: fw.freeCoinsByWin, winsToday: Math.min(winsToday, fw.freeCoinsByWin.length), remaining, next: remaining > 0 ? fw.freeCoinsByWin[winsToday]! : null };
}
import { onRaceApplied } from './onboarding.js';
import { comebackRaceXp } from './comeback.js';

/**
 * REQ-REW-002: 7-day login bonus, once per game day, cumulative (missing days does not reset).
 * REQ-UXS-013: a new player first gets the beginner table once (day 2 = a broodmare), then the normal 7-day cycle.
 */
/**
 * Stream D (docs/quality/shopcfg.md): a looks-only item on a login bonus day that the player already owns is swapped for
 * progression.loginBonusOwnedSwap[itemId] (the 7-day cycle's day 3 「翼」 → 2 breeding material). A player who does not own
 * it gets the item. `owned` lets a projection (goals.ts) count items the plan itself would have given by then.
 */
export function loginRewardFor(m: Pick<Master, 'progression'>, s: PlayerState, def: Reward, owned?: Set<string>): { reward: Reward; swappedFrom?: string } {
  const { day: _d, ...reward } = def as Reward & { day?: number };
  const swap = m.progression.loginBonusOwnedSwap;
  if (!swap || !reward.items?.length) return { reward };
  const has = (id: string) => owned ? owned.has(id) : (s.items[id] ?? 0) > 0;
  const hit = reward.items.find((it) => { const sub = swap[it.itemId]; return sub && typeof sub === 'object' && has(it.itemId); });
  if (!hit) return { reward };
  const sub = swap[hit.itemId] as Reward;
  const items = new Map<string, number>();
  for (const it of [...reward.items.filter((x) => x !== hit), ...(sub.items ?? [])]) items.set(it.itemId, (items.get(it.itemId) ?? 0) + it.qty);
  const out: Reward = { ...reward };
  if (items.size) out.items = [...items].map(([itemId, qty]) => ({ itemId, qty })); else delete out.items;
  return { reward: out, swappedFrom: hit.itemId };
}

/** Boot and every remote-config version: the swapped item is looks-only; the substitute is 1..5 breeding material, nothing else. */
export function loginBonusSwapProblems(m: Pick<Master, 'progression' | 'items'>): string[] {
  const c = m.progression.loginBonusOwnedSwap;
  if (c === undefined) return [];
  if (!c || typeof c !== 'object' || Array.isArray(c)) return ['progression.loginBonusOwnedSwap must be an object'];
  const out: string[] = [];
  for (const [id, r] of Object.entries(c)) {
    if (id === '_note') continue;
    const path = `progression.loginBonusOwnedSwap.${id}`;
    if (!isLooksOnlyItem(m, id)) out.push(`${path}: only a looks-only item is swapped when owned`);
    if (!r || typeof r !== 'object' || Object.keys(r).some((k) => k !== 'items') || !r.items?.length) { out.push(`${path}: items only (breeding material)`); continue; }
    for (const it of r.items) {
      if (it.itemId !== 'breeding_material') out.push(`${path}: the substitute is breeding material only (${it.itemId})`);
      if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > 5) out.push(`${path}: at most 5 breeding material (qty 1..5)`);
    }
  }
  return out;
}

export function claimLoginBonus(m: Master, s: PlayerState, now: number) {
  const today = gameDayKey(now, dayRule(m));
  if (sameGameDay(s.loginBonus.lastClaimDate, today)) throw new AppError('ALREADY_CLAIMED');
  const beginner = m.progression.beginnerLoginBonus ?? [];
  // states stored before the beginner table existed: a player who already claimed is past the beginner week
  const bDay = s.loginBonus.beginnerDay ?? (s.loginBonus.lastClaimDate === null ? 0 : beginner.length);
  if (bDay < beginner.length) {
    const day = bDay + 1;
    const def = beginner.find((d) => d.day === day)!;
    const { reward, swappedFrom } = loginRewardFor(m, s, def);
    grantReward(s, reward, now, `beginner login bonus day ${day}`, `b:${today}`, m);
    s.loginBonus = { streakDay: s.loginBonus.streakDay, lastClaimDate: today, beginnerDay: day, ...(swappedFrom ? { swappedFrom } : {}) };
    return { day, track: 'beginner' as const, reward: { day, ...reward }, beginnerDaysLeft: beginner.length - day, ...(swappedFrom ? { swappedFrom } : {}) };
  }
  const day = (s.loginBonus.streakDay % m.progression.loginBonus.length) + 1;
  const def = m.progression.loginBonus.find((d) => d.day === day)!;
  const { reward, swappedFrom } = loginRewardFor(m, s, def);
  grantReward(s, reward, now, `login bonus day ${day}`, today, m);
  s.loginBonus = { streakDay: day, lastClaimDate: today, beginnerDay: bDay, ...(swappedFrom ? { swappedFrom } : {}) };
  return { day, track: 'normal' as const, reward: { day, ...reward }, beginnerDaysLeft: 0, ...(swappedFrom ? { swappedFrom } : {}) };
}

function ensureMissionDay(m: Master, s: PlayerState, now: number) {
  const today = gameDayKey(now, dayRule(m));
  if (!sameGameDay(s.missions.date, today)) s.missions = { date: today, progress: {}, claimed: [] };
}

export function missionsView(m: Master, s: PlayerState, now: number) {
  ensureMissionDay(m, s, now);
  return m.progression.dailyMissions.map((d) => ({ ...d, progress: Math.min(d.target, s.missions.progress[d.id] ?? 0), claimed: s.missions.claimed.includes(d.id) }));
}

export function claimMission(m: Master, s: PlayerState, id: string, now: number) {
  ensureMissionDay(m, s, now);
  const d = m.progression.dailyMissions.find((x) => x.id === id);
  if (!d) throw new AppError('NOT_FOUND', `mission ${id}`);
  if (s.missions.claimed.includes(id)) throw new AppError('ALREADY_CLAIMED');
  if ((s.missions.progress[id] ?? 0) < d.target) throw new AppError('NOT_ELIGIBLE');
  s.missions.claimed.push(id);
  grantReward(s, d.reward, now, `mission ${id}`, s.missions.date);
  return d.reward;
}

export function passLevel(m: Master, s: PlayerState) {
  return levelOf(m, s.seasonPass.xp);
}

export const passActive = (s: PlayerState, now: number) => s.seasonPass.expiresAt > now;

/** REQ-REW-003 */
export function claimPass(m: Master, s: PlayerState, track: 'free' | 'premium', level: number, now: number) {
  if (!Number.isInteger(level) || level < 1 || level > passLevel(m, s)) throw new AppError('NOT_ELIGIBLE');
  if (s.seasonPass.forfeitedAt !== undefined) throw new AppError('NOT_ELIGIBLE', 'the season pass was given up (account deletion)');
  if (track === 'premium' && !passActive(s, now)) throw new AppError('NOT_ELIGIBLE', 'season pass not active');
  // quality pass 3: a standout tier pays its own reward (passRewardAt)
  const reward = passRewardAt(m, track, level);
  if (!reward) throw new AppError('NOT_ELIGIBLE');
  if (s.seasonPass.claimed[track].includes(level)) throw new AppError('ALREADY_CLAIMED');
  s.seasonPass.claimed[track].push(level);
  grantReward(s, reward, now, `pass ${track} ${level}`, String(level));
  notePassClaim(m, s, track, level, reward);
  return reward;
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
  /** REQ-COL-002: what the player raced against (CPU templates, skills in the field), from the race config. */
  seen?: { templates: string[]; skills: string[] };
  /** REQ-RIVAL-004: every human rider's place in this confirmed race (head to head with the weekly rival). */
  field?: { playerId: string; place: number }[];
  /** REQ-HOF-002: the rider's horse (the entrant's horse id in the race config). Absent in results from older rooms. */
  horseId?: string;
  /** REQ-MYRP-001: what マイリプレイ needs to offer this race later (absent for void races and results from older rooms). */
  replay?: import('./myReplays.js').ReplayRef;
  /** REQ-PROMO-003: this rider's reported result disagreed with the final one (cheat / desync suspect). */
  suspect?: boolean;
  /** REQ-PROMO-005: when the race started (orders races for the promotion series). Absent in results from older rooms. */
  startAtMs?: number;
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

/** REQ-REW-004: friend races pay only with ≥2 humans and at most friendRewardDailyCap times per game day. */
export function friendRewardAllowed(m: Master, s: PlayerState, r: RaceResultForPlayer, now: number): boolean {
  if (r.mode !== 'friend') return true;
  if ((r.humans ?? 0) < 2) return false;
  const today = gameDayKey(now, dayRule(m));
  if (!sameGameDay(s.friendRewards.date, today)) s.friendRewards = { date: today, count: 0 };
  if (s.friendRewards.count >= m.progression.friendRewardDailyCap) return false;
  s.friendRewards.count++;
  return true;
}

/** REQ-REW-001: apply a confirmed race outcome to one player. Idempotency is handled by the caller (key = race id). */
export function applyRaceResult(m: Master, s: PlayerState, r: RaceResultForPlayer, now: number) {
  if (r.void) return { coins: 0, seasonPoints: 0, titles: [] as string[], rewarded: false, firstWinBonus: 0, comebackXp: 0 };
  const rewarded = friendRewardAllowed(m, s, r, now);
  const firstWinBonus = rewarded ? applyFirstWinBonus(m, s, r, now) : 0;
  // time attack runs never come through here (they are settled by src/race/timeAttack.ts)
  const byPlace = (m.progression.raceFreeCoinsByPlace as Partial<Record<RaceMode, number[]>>)[r.mode];
  const coins = rewarded ? byPlace?.[r.place - 1] ?? 0 : 0;
  if (coins > 0) grantFree(s, coins, now, `race ${r.mode} place ${r.place}`, r.raceId);
  let seasonPoints = 0;
  let comebackXp = 0;
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
      comebackXp = comebackRaceXp(m, s, now); // REQ-CB-006: catch-up while a comeback window runs
      ensureMissionDay(m, s, now);
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
  onRaceApplied(m, s, r.mode, r.place, rewarded); // REQ-UXS-014/015/016 counters
  const titles = evaluateTitles(m, s);
  return { coins, seasonPoints, titles, rewarded, firstWinBonus, comebackXp };
}

export { DAY_MS };
