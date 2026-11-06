/**
 * 絆（bond）— daily stable care per horse (REQ-BOND-*).
 *
 * Care actions give bond points to one horse; bond levels unlock account-wide cosmetic rewards (once per
 * player per level, so owning many horses does not multiply them), titles (`bondLevel` condition) and a
 * commentary flavour line for the player's own horse. Bond NEVER changes race stats in ranked, event or
 * time attack races (REQ-BOND-005): `toRaceHorse` ignores it. The only optional effect is a tiny stat bump
 * in friend rooms, off by default (`friendRoomEffect.enabled = false`).
 */
import { AppError } from './errors.js';
import type { Master, Reward } from './master.js';
import type { PlayerState } from './player.js';
import { getHorse } from './horses.js';
import { grantReward } from './items.js';
import { evaluateTitles } from './stats.js';
import { gameDayKey } from './time.js';

export interface BondAction { focus: string; points: number; cooldownMs: number }
export interface BondConfig {
  /** Care actions by id (the Unity care screen's feed cards). */
  actions: Record<string, BondAction>;
  /** Care actions per horse per JST day (any action). */
  dailyActionsPerHorse: number;
  /** Points needed for each level (index i = points to reach level i+1; index 0 must be 0). */
  levels: number[];
  /** Account-wide rewards, paid once per player when any horse first reaches the level. */
  levelRewards: { level: number; reward: Reward }[];
  /** Bond level from which the commentary may call out the player's own horse (flavour only). */
  commentaryLevel: number;
  /** Optional friend-room-only stat effect. Off by default; never used in ranked/event/time attack. */
  friendRoomEffect: { enabled: boolean; permillePerLevel: number; maxPermille: number };
}

export interface HorseBond { points: number; lastCare: Record<string, number>; day: string; dayCount: number; focus: string | null }
export interface BondState { horses: Record<string, HorseBond>; rewardedLevels: number[] }

export function ensureBond(s: PlayerState): BondState {
  s.bond ??= { horses: {}, rewardedLevels: [] };
  return s.bond;
}

/** Level for a point total (1-based; level 1 at 0 points). */
export function bondLevelOf(cfg: BondConfig, points: number): number {
  let lv = 1;
  for (let i = 1; i < cfg.levels.length; i++) if (points >= cfg.levels[i]!) lv = i + 1;
  return lv;
}

export function horseBondLevel(m: Master, s: PlayerState, horseId: string): number {
  return bondLevelOf(m.progression.bond, s.bond?.horses[horseId]?.points ?? 0);
}

/** Highest bond level over the player's horses (title condition `bondLevel`). */
export function maxBondLevel(m: Master, s: PlayerState): number {
  let best = 1;
  for (const b of Object.values(s.bond?.horses ?? {})) best = Math.max(best, bondLevelOf(m.progression.bond, b.points));
  return best;
}

export function bondView(m: Master, s: PlayerState, horseId: string, now: number) {
  getHorse(s, horseId);
  const cfg = m.progression.bond;
  const b = s.bond?.horses[horseId];
  const points = b?.points ?? 0;
  const level = bondLevelOf(cfg, points);
  const today = gameDayKey(now);
  const used = b && b.day === today ? b.dayCount : 0;
  return {
    horseId, level, points,
    maxLevel: cfg.levels.length,
    nextLevelAt: level < cfg.levels.length ? cfg.levels[level]! : null,
    todayActions: used, dailyActions: cfg.dailyActionsPerHorse,
    focus: b?.focus ?? null,
    commentaryCallout: level >= cfg.commentaryLevel,
    actions: Object.entries(cfg.actions).map(([id, a]) => {
      const last = b?.lastCare[id];
      const readyAt = last === undefined ? now : Math.max(now, last + a.cooldownMs);
      return { id, focus: a.focus, points: a.points, cooldownMs: a.cooldownMs, readyAt, ready: readyAt <= now && used < cfg.dailyActionsPerHorse };
    }),
    // REQ-BOND-005: shown so the UI can state it plainly
    affectsRankedStats: false,
  };
}

/** REQ-BOND-002: one care action on one horse (cooldown per action, daily cap per horse). */
export function careHorse(m: Master, s: PlayerState, horseId: string, actionId: string, now: number) {
  getHorse(s, horseId); // any owned horse (retired breeding horses too)
  const cfg = m.progression.bond;
  const a = cfg.actions[actionId];
  if (!a) throw new AppError('NOT_FOUND', `care action ${actionId}`);
  const st = ensureBond(s);
  const b = (st.horses[horseId] ??= { points: 0, lastCare: {}, day: '', dayCount: 0, focus: null });
  const today = gameDayKey(now);
  if (b.day !== today) { b.day = today; b.dayCount = 0; }
  if (b.dayCount >= cfg.dailyActionsPerHorse) throw new AppError('COOLDOWN', 'daily care limit for this horse');
  const last = b.lastCare[actionId];
  if (last !== undefined && now < last + a.cooldownMs) throw new AppError('COOLDOWN', `next ${actionId} at ${last + a.cooldownMs}`);
  const before = bondLevelOf(cfg, b.points);
  b.points += a.points;
  b.lastCare[actionId] = now;
  b.dayCount++;
  b.focus = a.focus;
  const after = bondLevelOf(cfg, b.points);
  // REQ-BOND-003: account-wide level rewards, once per level
  const rewards: { level: number; reward: Reward }[] = [];
  for (const lr of cfg.levelRewards) {
    if (lr.level > after || st.rewardedLevels.includes(lr.level)) continue;
    st.rewardedLevels.push(lr.level);
    grantReward(s, lr.reward, now, `bond level ${lr.level}`, `bond:${lr.level}`);
    rewards.push(lr);
  }
  const titles = evaluateTitles(m, s);
  return { gained: a.points, levelUp: after > before, rewards, titles, bond: bondView(m, s, horseId, now) };
}

/** Bond levels of all horses (stable list). */
export function bondLevels(m: Master, s: PlayerState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of s.horses) out[h.id] = horseBondLevel(m, s, h.id);
  return out;
}

/** REQ-BOND-006: friend-room-only stat multiplier in permille (0 unless explicitly enabled). */
export function friendRoomBondPermille(cfg: BondConfig, level: number): number {
  const e = cfg.friendRoomEffect;
  if (!e.enabled) return 0;
  return Math.max(0, Math.min(e.maxPermille, (level - 1) * e.permillePerLevel));
}

/** Config problems (remote config validation, REQ-OPS-003). */
/**
 * `knownItems`: item ids the game can grant (from the shipped master); `paidOnlyItems`: cosmetics sold for
 * paid coins only, which must never be handed out for free (QA r6 #8). Both optional for callers that only
 * check the structure.
 */
export function bondProblems(cfg: unknown, knownItems?: ReadonlySet<string>, paidOnlyItems?: ReadonlySet<string>): string[] {
  const p: string[] = [];
  const c = cfg as Partial<BondConfig> | undefined;
  if (!c || typeof c !== 'object') return ['bond: missing'];
  const isInt = (n: unknown, min = 0) => typeof n === 'number' && Number.isInteger(n) && n >= min;
  if (!c.actions || Object.keys(c.actions).length === 0) p.push('bond.actions must not be empty');
  for (const [id, a] of Object.entries(c.actions ?? {})) {
    if (!isInt(a.points, 1)) p.push(`bond.actions.${id}.points must be a positive integer`);
    if (!isInt(a.cooldownMs, 0)) p.push(`bond.actions.${id}.cooldownMs must be a non-negative integer`);
  }
  if (!isInt(c.dailyActionsPerHorse, 1)) p.push('bond.dailyActionsPerHorse must be >= 1');
  const lv = c.levels ?? [];
  if (lv.length < 2 || lv[0] !== 0) p.push('bond.levels must start at 0 and have at least 2 entries');
  for (let i = 1; i < lv.length; i++) if (!isInt(lv[i], 1) || lv[i]! <= lv[i - 1]!) p.push('bond.levels must be strictly increasing integers');
  for (const r of c.levelRewards ?? []) {
    if (!isInt(r.level, 2) || r.level > lv.length) p.push(`bond.levelRewards: level ${r.level} out of range`);
    const rw = r.reward as Reward | undefined;
    if (!rw || typeof rw !== 'object') { p.push(`bond.levelRewards[${r.level}]: reward missing`); continue; }
    if (rw.freeCoins !== undefined && !isInt(rw.freeCoins, 0)) p.push(`bond.levelRewards[${r.level}]: freeCoins must be a non-negative integer`);
    for (const it of rw.items ?? []) {
      if (!isInt(it.qty, 1)) p.push(`bond.levelRewards[${r.level}]: ${it.itemId} qty must be ≥ 1`);
      if (knownItems && !knownItems.has(it.itemId)) p.push(`bond.levelRewards[${r.level}]: unknown item ${it.itemId}`);
      if (paidOnlyItems?.has(it.itemId)) p.push(`bond.levelRewards[${r.level}]: ${it.itemId} is paid-only and cannot be a free reward`);
    }
  }
  if (!isInt(c.commentaryLevel, 1)) p.push('bond.commentaryLevel must be >= 1');
  const e = c.friendRoomEffect;
  if (!e || typeof e.enabled !== 'boolean' || !isInt(e.permillePerLevel, 0) || !isInt(e.maxPermille, 0) || e.maxPermille > 50) p.push('bond.friendRoomEffect invalid (maxPermille ≤ 50)');
  return p;
}
