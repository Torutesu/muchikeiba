/**
 * Returning players (復帰キャンペーン, REQ-CB-001..012; contracts/protocol.md "復帰キャンペーン・お知らせ"; docs/planning/06 §4.5).
 *
 *   lapse        a player whose last ACTIVE game day (app start, login claim, race entry, comeback screen) is at least
 *                `tiers[0].minLapseDays` game days back. Server deliveries (pushes, friend requests, stud fees…) are not
 *                activity: they never touch `lastActiveDay` (profile.lastSeenAt is written by every transaction).
 *   window       on the first active day after a lapse, one comeback window starts for `windowDays` game days: a 7-day
 *                comeback login track, comeback missions that re-teach changed features and a pass-XP catch-up.
 *                One window at a time; a new one only `cooldownDays` game days after the previous START (idling between
 *                two windows cannot farm them), only for players who had played (`minRacesBefore`) and never while the
 *                account is scheduled for deletion (REQ-UXS-040) or banned.
 *   catch-up     while the window runs, each rewarded race adds `bonusPermille` ‰ of the race's pass XP on top, until the
 *                player reaches the season's median-player XP (`medianXpPerSeasonDay` × day of the season) and at most
 *                `min(maxBonusXp, lapseDays × perLapseDayXp)` — less than a daily player earned in the days missed.
 *   reminders    lapse pushes at `pushes[].afterDays` (3 / 7) after the last active day, in their own opt-in category
 *                `comeback` (06 §3.5: a re-engagement push needs its own category and consent), through enqueuePush
 *                (preferences, quiet hours, the daily cap of push.json).
 *   what's new   features / banners / events added since the player last looked (master/changelog.json + live data),
 *                for a one-time home card.
 *
 * Legal guard rails (docs/planning/03, 06 §5.5): every reward is free coins or a non-paid item (validated: no paid
 * currency, no paid-only cosmetic, no horse); no mission rewards collecting a set (no コンプガチャ: there is no
 * `collect` kind); the shop only RECOMMENDS an existing product at its normal price with its real sale end (shop.ts).
 */
import { MAINTENANCE_NEWS_TITLE, maintenanceOf, visibleWindows } from './maintenance.js';
import { z } from 'zod';
import { AppError } from './errors.js';
import { grantReward } from './items.js';
import { endOfGameDay, type Master, type Reward } from './master.js';
import { moderationOf, type PlayerState } from './player.js';
import { enqueuePush, ensurePush, jstHour, type EnqueueResult } from './push.js';
import { deletionScheduled } from './accountDeletion.js';
import { addJstDays, DAY_MS, dayRule, gameDayKey, gameDayStartMs, gameDaysUntil, jstDateKey, sameGameDay } from './time.js';
import type { Emit } from './service.js';

// ------------------------------------------------------------------------------------------------ config

export type ComebackMissionKind = 'races' | 'ranked_races' | 'wins' | 'gacha' | 'care' | 'stable' | 'breed' | 'silks';
export const COMEBACK_MISSION_KINDS: ComebackMissionKind[] = ['races', 'ranked_races', 'wins', 'gacha', 'care', 'stable', 'breed', 'silks'];
export interface ComebackMissionDef {
  id: string; kind: ComebackMissionKind; target: number; reward: Reward;
  /** What the mission re-teaches (client screen / tutorial card): skills, my_stable, scout, bond, breeding, race, … */
  feature: string;
  title: string;
  /** One-line guide shown with the mission ("what changed"). */
  guide: string;
}
export interface ComebackTier { id: string; minLapseDays: number; loginTrack: Reward[] }
export interface ComebackPushDef { afterDays: number; templateId: string; requireEligible?: boolean }
export interface ComebackConfig {
  tiers: ComebackTier[];
  windowDays: number;
  cooldownDays: number;
  minRacesBefore: number;
  /** Coin value a tier's login track + missions may give per lapse day of its threshold (≤ a daily free player's ~179). */
  valueCapPerLapseDay: number;
  missions: ComebackMissionDef[];
  catchUp: { medianXpPerSeasonDay: number; bonusPermille: number; maxBonusXp: number; perLapseDayXp: number };
  pushes: ComebackPushDef[];
  /** JST hour the lapse reminders are queued for (outside the default quiet hours 22–8). */
  pushHourJst: number;
  /** Recommend an existing product during the window (no new price, no discount; shop.ts). */
  offer?: { enabled: boolean };
}

/** Coin value of the items a comeback reward may contain (others are refused: free, non-paid items only). */
export const COMEBACK_ITEM_VALUE: Record<string, number> = { gacha_ticket: 100, gacha_ticket_10: 1000, ticket_sr_plus: 300, breeding_material: 20 };
/** The daily free persona of the economy sim (balance-targets.md §4) runs 6 ranked races a day. */
export const DAILY_PLAYER_RACES = 6;

export function rewardValue(r: Reward): number {
  return (r.freeCoins ?? 0) + (r.items ?? []).reduce((a, it) => a + (COMEBACK_ITEM_VALUE[it.itemId] ?? 0) * it.qty, 0);
}

const int = z.number().int();
const rewardSchema = z.object({
  freeCoins: int.min(0).max(10_000).optional(),
  items: z.array(z.object({ itemId: z.string().min(1).max(64), qty: int.min(1).max(100) }).strict()).max(5).optional(),
}).strict();
const id = z.string().regex(/^[a-z0-9_]{1,40}$/);
export const comebackSchema = z.object({
  _note: z.string().optional(),
  tiers: z.array(z.object({ id, minLapseDays: int.min(3).max(365), loginTrack: z.array(rewardSchema).min(1).max(14) }).strict()).min(1).max(5),
  windowDays: int.min(7).max(30),
  cooldownDays: int.min(14).max(365),
  minRacesBefore: int.min(0).max(1000),
  valueCapPerLapseDay: int.min(1).max(1000),
  missions: z.array(z.object({
    id, kind: z.enum(COMEBACK_MISSION_KINDS as [ComebackMissionKind, ...ComebackMissionKind[]]), target: int.min(1).max(100), reward: rewardSchema,
    feature: z.string().regex(/^[a-z0-9_]{1,40}$/), title: z.string().min(1).max(60), guide: z.string().min(1).max(120),
  }).strict()).max(10),
  catchUp: z.object({ medianXpPerSeasonDay: int.min(0).max(1000), bonusPermille: int.min(0).max(2000), maxBonusXp: int.min(0).max(10_000), perLapseDayXp: int.min(0).max(1000) }).strict(),
  pushes: z.array(z.object({ afterDays: int.min(1).max(60), templateId: z.string().min(1).max(64), requireEligible: z.boolean().optional() }).strict()).max(4),
  pushHourJst: int.min(0).max(23),
  offer: z.object({ enabled: z.boolean() }).strict().optional(),
}).strict();

/** Validation of progression.comeback (boot and every remote-config version). */
export function comebackProblems(m: Pick<Master, 'progression' | 'push' | 'items'>, cfg: unknown = m.progression.comeback): string[] {
  if (cfg === undefined) return [];
  const r = comebackSchema.safeParse(cfg);
  if (!r.success) return r.error.issues.map((i) => `progression.comeback.${i.path.join('.')}: ${i.message}`);
  const c = r.data as ComebackConfig;
  const out: string[] = [];
  const path = 'progression.comeback';
  const tickets = m.items?.tickets ?? {};
  const rewardRefs = (p: string, rw: Reward) => {
    for (const it of rw.items ?? []) {
      // REQ-CB-009: free, non-paid items only (tickets and material; never a cosmetic, paid-only or not)
      if (COMEBACK_ITEM_VALUE[it.itemId] === undefined) out.push(`${p}: item ${it.itemId} is not allowed in comeback rewards (allowed: ${Object.keys(COMEBACK_ITEM_VALUE).join(', ')})`);
      else if (it.itemId !== 'breeding_material' && !tickets[it.itemId]) out.push(`${p}: unknown ticket ${it.itemId}`);
    }
  };
  const tierIds = new Set<string>();
  let prev = 0;
  const missionValue = c.missions.reduce((a, d) => a + rewardValue(d.reward), 0);
  c.tiers.forEach((t, i) => {
    if (tierIds.has(t.id)) out.push(`${path}.tiers[${i}]: duplicate id ${t.id}`);
    tierIds.add(t.id);
    if (t.minLapseDays <= prev) out.push(`${path}.tiers[${i}]: minLapseDays must increase`);
    prev = t.minLapseDays;
    if (t.loginTrack.length > c.windowDays) out.push(`${path}.tiers[${i}]: the login track is longer than the window`);
    t.loginTrack.forEach((rw, d) => rewardRefs(`${path}.tiers[${i}].loginTrack[${d}]`, rw));
    // REQ-CB-010: a returner never gets more than a daily player earned in the days missed
    const value = t.loginTrack.reduce((a, rw) => a + rewardValue(rw), 0) + missionValue;
    if (value > t.minLapseDays * c.valueCapPerLapseDay) out.push(`${path}.tiers[${i}]: login track + missions are worth ${value} coins, over ${t.minLapseDays} days × valueCapPerLapseDay ${c.valueCapPerLapseDay}`);
  });
  const ids = new Set<string>();
  c.missions.forEach((d, i) => {
    if (ids.has(d.id)) out.push(`${path}.missions[${i}]: duplicate id ${d.id}`);
    ids.add(d.id);
    rewardRefs(`${path}.missions[${i}]`, d.reward);
  });
  const dailyXp = DAILY_PLAYER_RACES * m.progression.passXpPerRace;
  if (c.catchUp.perLapseDayXp > dailyXp) out.push(`${path}.catchUp.perLapseDayXp: must be ≤ ${dailyXp} (a daily player's race XP per day)`);
  const maxXp = m.progression.passMaxLevel * m.progression.passXpPerLevel;
  if (c.catchUp.medianXpPerSeasonDay * 31 > maxXp * 2) out.push(`${path}.catchUp.medianXpPerSeasonDay: implausibly high`);
  let lastDays = 0;
  c.pushes.forEach((p, i) => {
    if (p.afterDays <= lastDays) out.push(`${path}.pushes[${i}]: afterDays must increase`);
    lastDays = p.afterDays;
    const t = m.push?.templates[p.templateId];
    if (!t) out.push(`${path}.pushes[${i}]: unknown push template ${p.templateId}`);
    else if (t.category !== 'comeback') out.push(`${path}.pushes[${i}]: template ${p.templateId} must be in the comeback category (06 §3.5)`);
  });
  return out;
}

// ------------------------------------------------------------------------------------------------ state

export interface ComebackWindow {
  id: string; tier: string; lapseDays: number;
  /** First and last game day ("YYYY-MM-DD") and the exclusive end instant. */
  startDay: string; endDay: string; startedAt: number; endsAt: number;
  login: { claimed: number; lastDay: string | null };
  /** Mission counters when the window started (progress = counter − baseline). */
  baseline: Record<string, number>;
  missionsClaimed: string[];
  catchUp: { seasonId: string; targetXp: number; capXp: number; grantedXp: number };
  welcomedAt?: number;
  completedAt?: number;
}
export interface ComebackState {
  lastActiveAt: number;
  /** Last ACTIVE game day (see the module comment). */
  lastActiveDay: string;
  /** What's new: entries after this instant are unseen. */
  seenUpTo: number;
  window: ComebackWindow | null;
  /** Game day the last window started (cooldown). */
  lastStartDay: string | null;
  count: number;
  /** Next lapse reminder (index into config.pushes). */
  remind: { at: number | null; step: number };
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);

/** Created on the first activity; older states start from the last transaction (an under-estimate of the lapse). */
export function ensureComeback(m: Master, s: PlayerState): ComebackState {
  const last = s.profile.lastSeenAt || s.createdAt;
  s.comeback ??= { lastActiveAt: last, lastActiveDay: gameDayKey(last, dayRule(m)), seenUpTo: last, window: null, lastStartDay: null, count: 0, remind: { at: null, step: 0 } };
  return s.comeback;
}

export const windowActive = (m: Master, w: ComebackWindow | null | undefined, now: number): w is ComebackWindow =>
  !!w && gameDayKey(now, dayRule(m)) <= w.endDay;

function counter(s: PlayerState, kind: ComebackMissionKind): number {
  const o = s.onboarding;
  switch (kind) {
    case 'races': return o?.races ?? s.stats.races;
    case 'ranked_races': return s.rating.rankedRaces;
    case 'wins': return s.stats.wins;
    default: return o?.counts[kind] ?? 0;
  }
}

export type IneligibleReason = 'disabled' | 'not_lapsed' | 'deletion_pending' | 'banned' | 'active_window' | 'cooldown' | 'not_engaged';

/** REQ-CB-002/003: may a window start for a lapse of `gap` game days today? */
export function comebackEligibility(m: Master, s: PlayerState, gap: number, now: number): { ok: true; tier: ComebackTier } | { ok: false; reason: IneligibleReason } {
  const c = m.progression.comeback;
  if (!c || c.tiers.length === 0) return { ok: false, reason: 'disabled' };
  const tier = [...c.tiers].reverse().find((t) => gap >= t.minLapseDays);
  if (!tier) return { ok: false, reason: 'not_lapsed' };
  if (deletionScheduled(s)) return { ok: false, reason: 'deletion_pending' };
  if (moderationOf(s, now) === 'banned') return { ok: false, reason: 'banned' };
  const st = s.comeback;
  if (windowActive(m, st?.window, now)) return { ok: false, reason: 'active_window' };
  const today = gameDayKey(now, dayRule(m));
  if (st?.lastStartDay && daysBetween(st.lastStartDay, today) < c.cooldownDays) return { ok: false, reason: 'cooldown' };
  if (counter(s, 'races') < c.minRacesBefore) return { ok: false, reason: 'not_engaged' };
  return { ok: true, tier };
}

function startWindow(m: Master, s: PlayerState, st: ComebackState, tier: ComebackTier, gap: number, now: number, emit: Emit): ComebackWindow {
  const c = m.progression.comeback!;
  const rule = dayRule(m);
  const today = gameDayKey(now, rule);
  const endDay = addJstDays(today, c.windowDays - 1);
  const baseline: Record<string, number> = {};
  for (const k of COMEBACK_MISSION_KINDS) baseline[k] = counter(s, k);
  // the median player's XP by this day of the season (seasons are calendar months, REQ-DAY-004), capped at the pass max
  const seasonDay = Number(jstDateKey(now).slice(8, 10));
  const maxXp = m.progression.passMaxLevel * m.progression.passXpPerLevel;
  const targetXp = Math.min(maxXp, c.catchUp.medianXpPerSeasonDay * seasonDay);
  const capXp = Math.max(0, Math.min(c.catchUp.maxBonusXp, gap * c.catchUp.perLapseDayXp, targetXp - s.seasonPass.xp));
  st.count += 1;
  const w: ComebackWindow = {
    id: `cb${st.count}_${today.replace(/-/g, '')}`, tier: tier.id, lapseDays: gap, startDay: today, endDay, startedAt: now, endsAt: endOfGameDay(endDay, rule),
    login: { claimed: 0, lastDay: null }, baseline, missionsClaimed: [],
    catchUp: { seasonId: s.seasonPass.seasonId, targetXp, capXp, grantedXp: 0 },
  };
  st.window = w;
  st.lastStartDay = today;
  emit({ name: 'comeback_start', s1: tier.id, value: gap, count: st.count });
  return w;
}

/** First instant of game day `dayKey` + n at `pushHourJst` (JST). */
function reminderAt(m: Master, dayKey: string, afterDays: number): number {
  const c = m.progression.comeback!;
  const start = gameDayStartMs(addJstDays(dayKey, afterDays), dayRule(m));
  return start + ((c.pushHourJst - jstHour(start) + 24) % 24) * 3_600_000;
}

function armReminder(m: Master, st: ComebackState) {
  const p = m.progression.comeback?.pushes ?? [];
  st.remind = p.length ? { at: reminderAt(m, st.lastActiveDay, p[0]!.afterDays), step: 0 } : { at: null, step: 0 };
}

/**
 * REQ-CB-001: a player-initiated call (bootstrap, login claim, race entry, comeback screen). On the first active day
 * after a lapse this may start the window; every new active day re-arms the lapse reminders. Returns the window
 * started now (or null).
 */
export function noteActivity(m: Master, s: PlayerState, now: number, emit: Emit): ComebackWindow | null {
  const st = ensureComeback(m, s);
  const today = gameDayKey(now, dayRule(m));
  st.lastActiveAt = now;
  if (sameGameDay(st.lastActiveDay, today)) {
    if (st.remind.at === null && st.remind.step === 0) armReminder(m, st); // first activity ever (install day)
    return null;
  }
  const gap = daysBetween(st.lastActiveDay, today);
  const e = comebackEligibility(m, s, gap, now);
  const started = e.ok ? startWindow(m, s, st, e.tier, gap, now, emit) : null;
  st.lastActiveDay = today;
  armReminder(m, st);
  return started;
}

// ------------------------------------------------------------------------------------------------ claims

function activeWindowOrThrow(m: Master, s: PlayerState, now: number): ComebackWindow {
  const w = s.comeback?.window;
  if (!windowActive(m, w, now)) throw new AppError('NOT_ELIGIBLE', 'no comeback window is running');
  // REQ-CB-003 / REQ-UXS-040: nothing is paid while the account is scheduled for deletion
  if (deletionScheduled(s)) throw new AppError('DELETION_PENDING', 'the account is scheduled for deletion');
  return w;
}

const tierOf = (m: Master, w: ComebackWindow) => m.progression.comeback?.tiers.find((t) => t.id === w.tier) ?? m.progression.comeback?.tiers[0] ?? null;

function missionProgress(s: PlayerState, w: ComebackWindow, d: ComebackMissionDef) {
  return Math.min(d.target, Math.max(0, counter(s, d.kind) - (w.baseline[d.kind] ?? 0)));
}

function checkComplete(m: Master, s: PlayerState, w: ComebackWindow, now: number, emit: Emit) {
  if (w.completedAt !== undefined) return;
  const t = tierOf(m, w);
  const missions = m.progression.comeback?.missions ?? [];
  if (!t || w.login.claimed < t.loginTrack.length || missions.some((d) => !w.missionsClaimed.includes(d.id))) return;
  w.completedAt = now;
  emit({ name: 'comeback_complete', s1: w.tier, value: daysBetween(w.startDay, gameDayKey(now, dayRule(m))) + 1 });
}

/** REQ-CB-004: one comeback login day per game day, cumulative (a missed day is not lost), inside the window. */
export function claimComebackLogin(m: Master, s: PlayerState, now: number, emit: Emit) {
  const w = activeWindowOrThrow(m, s, now);
  const t = tierOf(m, w);
  if (!t) throw new AppError('NOT_ELIGIBLE', 'comeback is not configured');
  const today = gameDayKey(now, dayRule(m));
  if (sameGameDay(w.login.lastDay, today)) throw new AppError('ALREADY_CLAIMED');
  if (w.login.claimed >= t.loginTrack.length) throw new AppError('ALREADY_CLAIMED', 'the comeback login track is complete');
  const day = w.login.claimed + 1;
  const reward = t.loginTrack[day - 1]!;
  grantReward(s, reward, now, `comeback login ${w.id} day ${day}`, `cb:${w.id}:${day}`);
  w.login = { claimed: day, lastDay: today };
  emit({ name: 'comeback_day', s1: w.tier, value: day });
  checkComplete(m, s, w, now, emit);
  return { day, reward, window: comebackView(m, s, now).window };
}

/** REQ-CB-005: claim a comeback mission (progress counted from the window's start). */
export function claimComebackMission(m: Master, s: PlayerState, missionId: string, now: number, emit: Emit) {
  const w = activeWindowOrThrow(m, s, now);
  const d = (m.progression.comeback?.missions ?? []).find((x) => x.id === missionId);
  if (!d) throw new AppError('NOT_FOUND', `comeback mission ${missionId}`);
  if (w.missionsClaimed.includes(d.id)) throw new AppError('ALREADY_CLAIMED');
  if (missionProgress(s, w, d) < d.target) throw new AppError('NOT_ELIGIBLE');
  w.missionsClaimed.push(d.id);
  grantReward(s, d.reward, now, `comeback mission ${d.id}`, `cbm:${w.id}:${d.id}`);
  checkComplete(m, s, w, now, emit);
  return { missionId: d.id, reward: d.reward, window: comebackView(m, s, now).window };
}

/** The welcome screen was shown (first time kept). */
export function markComebackWelcomed(m: Master, s: PlayerState, now: number) {
  const w = s.comeback?.window;
  if (!windowActive(m, w, now)) throw new AppError('NOT_FOUND', 'no comeback window is running');
  w.welcomedAt ??= now;
  return { windowId: w.id, welcomedAt: w.welcomedAt };
}

/** REQ-CB-006: pass XP added to a rewarded race while the window runs (called after the race's own XP). */
export function comebackRaceXp(m: Master, s: PlayerState, now: number): number {
  const c = m.progression.comeback;
  const w = s.comeback?.window;
  if (!c || !windowActive(m, w, now) || deletionScheduled(s)) return 0;
  const cu = w.catchUp;
  if (cu.seasonId !== s.seasonPass.seasonId) return 0; // a new season started: everyone is back at 0
  const per = Math.floor((m.progression.passXpPerRace * c.catchUp.bonusPermille) / 1000);
  const bonus = Math.max(0, Math.min(per, cu.capXp - cu.grantedXp, cu.targetXp - s.seasonPass.xp));
  if (bonus <= 0) return 0;
  cu.grantedXp += bonus;
  s.seasonPass.xp += bonus;
  return bonus;
}

// ------------------------------------------------------------------------------------------------ views

export function comebackView(m: Master, s: PlayerState, now: number) {
  const c = m.progression.comeback;
  const st = s.comeback;
  const w = st?.window ?? null;
  const prefs = ensurePush(m, s).prefs.categories;
  const push = { category: 'comeback' as const, enabled: prefs.comeback === true };
  if (!c || !windowActive(m, w, now)) return { active: false as const, window: null, push };
  const rule = dayRule(m);
  const today = gameDayKey(now, rule);
  const t = tierOf(m, w);
  const track = t?.loginTrack ?? [];
  const cu = w.catchUp;
  const sameSeason = cu.seasonId === s.seasonPass.seasonId;
  const remainingXp = sameSeason ? Math.max(0, Math.min(cu.capXp - cu.grantedXp, cu.targetXp - s.seasonPass.xp)) : 0;
  const blocked = deletionScheduled(s);
  return {
    active: true as const,
    push,
    window: {
      id: w.id, tier: w.tier, lapseDays: w.lapseDays, startDay: w.startDay, endDay: w.endDay, endsAt: w.endsAt,
      remainingDays: gameDaysUntil(w.endsAt, now, rule), day: daysBetween(w.startDay, today) + 1, days: c.windowDays,
      showWelcome: w.welcomedAt === undefined, completed: w.completedAt !== undefined, blocked,
      login: {
        claimed: w.login.claimed, total: track.length,
        claimableToday: !blocked && w.login.claimed < track.length && !sameGameDay(w.login.lastDay, today),
        days: track.map((reward, i) => ({ day: i + 1, reward, claimed: i < w.login.claimed })),
      },
      missions: c.missions.map((d) => {
        const progress = missionProgress(s, w, d);
        const claimed = w.missionsClaimed.includes(d.id);
        return { id: d.id, kind: d.kind, feature: d.feature, title: d.title, guide: d.guide, target: d.target, progress, reward: d.reward, claimed, claimable: !blocked && !claimed && progress >= d.target };
      }),
      catchUp: {
        seasonId: cu.seasonId, targetXp: cu.targetXp, capXp: cu.capXp, grantedXp: cu.grantedXp, remainingXp,
        bonusPerRace: Math.floor((m.progression.passXpPerRace * c.catchUp.bonusPermille) / 1000), active: remainingXp > 0 && !blocked,
      },
    },
  };
}

// ------------------------------------------------------------------------------------------------ lapse reminders

/**
 * The alarm is only armed when a reminder could be delivered: opted in to `comeback`, a device, no deletion scheduled
 * (opting in later re-arms it in that transaction: the wake changes).
 */
export const nextComebackWake = (s: PlayerState): number | null => {
  const at = s.comeback?.remind.at ?? null;
  if (at === null || deletionScheduled(s) || !s.push?.prefs.categories.comeback || s.push.devices.length === 0) return null;
  return at;
};

/** REQ-CB-007: alarm. Queue the due lapse reminder (still lapsed; not while deleting / banned; eligible when required). */
export function runDueComebackPush(m: Master, s: PlayerState, now: number): EnqueueResult | { status: 'skipped'; reason: string } | null {
  const c = m.progression.comeback;
  const st = s.comeback;
  if (!c || !st || st.remind.at === null || now < st.remind.at) return null;
  const p = c.pushes[st.remind.step];
  const next = c.pushes[st.remind.step + 1];
  st.remind = next ? { at: reminderAt(m, st.lastActiveDay, next.afterDays), step: st.remind.step + 1 } : { at: null, step: st.remind.step + 1 };
  if (!p) return null;
  const gap = daysBetween(st.lastActiveDay, gameDayKey(now, dayRule(m)));
  if (gap < p.afterDays) return { status: 'skipped', reason: 'active' };
  if (deletionScheduled(s)) return { status: 'skipped', reason: 'deletion_pending' };
  if (moderationOf(s, now) === 'banned') return { status: 'skipped', reason: 'banned' };
  // the day-7 text promises a comeback bonus: only send it when returning now would start one
  if (p.requireEligible && !comebackEligibility(m, s, p.afterDays, now).ok) return { status: 'skipped', reason: 'not_eligible' };
  return enqueuePush(m, s, p.templateId, { days: String(p.afterDays) }, now);
}

// ------------------------------------------------------------------------------------------------ what's new

export type ChangelogKind = 'feature' | 'banner' | 'event' | 'balance';
export interface ChangelogEntry {
  id: string; kind: ChangelogKind; title: string; body: string;
  /** Game day it went live ("YYYY-MM-DD", resolved at the rollover) or an instant. */
  day?: string; atMs?: number;
  /** Screen / feature key the card links to (client mapping), e.g. skills, my_stable, scout. */
  feature?: string;
}
export const changelogSchema = z.array(z.object({
  id: z.string().regex(/^[a-z0-9_]{1,48}$/), kind: z.enum(['feature', 'banner', 'event', 'balance']),
  title: z.string().min(1).max(40), body: z.string().min(1).max(160),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), atMs: int.min(0).optional(), feature: z.string().regex(/^[a-z0-9_]{1,40}$/).optional(),
}).strict()).max(200);

export function changelogProblems(list: unknown): string[] {
  if (list === undefined) return [];
  const r = changelogSchema.safeParse(list);
  if (!r.success) return r.error.issues.map((i) => `changelog.${i.path.join('.')}: ${i.message}`);
  const out: string[] = [];
  const ids = new Set<string>();
  r.data.forEach((e, i) => {
    if (ids.has(e.id)) out.push(`changelog[${i}]: duplicate id ${e.id}`);
    ids.add(e.id);
    if ((e.day === undefined) === (e.atMs === undefined)) out.push(`changelog[${i}]: give exactly one of day / atMs`);
  });
  return out;
}

export const WHATS_NEW_MAX = 10;

export interface WhatsNewItem { id: string; kind: ChangelogKind | 'maintenance'; title: string; body: string; at: number; feature: string | null; bannerId: string | null; eventId: string | null; endsAt: number | null }

/**
 * REQ-CB-008: what went live after the player last looked (seenUpTo) and up to now, newest first: changelog entries,
 * banners that opened (still open) and events that started (still running). For a one-time home card.
 */
export function whatsNew(m: Master, s: PlayerState, now: number) {
  const st = ensureComeback(m, s);
  const since = st.seenUpTo;
  const rule = dayRule(m);
  const items: WhatsNewItem[] = [];
  const inRange = (at: number) => at > since && at <= now;
  for (const e of m.changelog ?? []) {
    const at = e.atMs ?? gameDayStartMs(e.day!, rule);
    if (inRange(at)) items.push({ id: e.id, kind: e.kind, title: e.title, body: e.body, at, feature: e.feature ?? null, bannerId: null, eventId: null, endsAt: null });
  }
  for (const b of m.gacha.banners) {
    if (b.startAtMs === undefined || !inRange(b.startAtMs) || (b.endAtMs !== undefined && b.endAtMs <= now)) continue;
    items.push({ id: `banner_${b.id}`, kind: 'banner', title: b.name, body: '新しいスカウトが始まりました', at: b.startAtMs, feature: 'scout', bannerId: b.id, eventId: null, endsAt: b.endAtMs ?? null });
  }
  for (const e of m.events) {
    if (!inRange(e.startAtMs) || e.endAtMs <= now) continue;
    items.push({ id: `event_${e.id}`, kind: 'event', title: e.name, body: 'イベントレースが開催中です', at: e.startAtMs, feature: 'events', bannerId: null, eventId: e.id, endsAt: e.endAtMs });
  }
  // REQ-MNT-005 (§46): an announced maintenance window is news until it ends (the row links to the maintenance notice)
  for (const w of visibleWindows(maintenanceOf(m), now)) {
    if (!inRange(w.announceAt)) continue;
    items.push({ id: `maintenance_${w.id}`, kind: 'maintenance', title: MAINTENANCE_NEWS_TITLE, body: w.message, at: w.announceAt, feature: 'maintenance', bannerId: null, eventId: null, endsAt: w.endAt });
  }
  items.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
  return { since, upTo: now, showCard: items.length > 0, items: items.slice(0, WHATS_NEW_MAX), more: Math.max(0, items.length - WHATS_NEW_MAX) };
}

/** The card was shown: entries up to `upTo` (the `upTo` of the GET; capped at now) are seen. */
export function markWhatsNewSeen(m: Master, s: PlayerState, upTo: number, now: number) {
  const st = ensureComeback(m, s);
  if (!Number.isFinite(upTo) || upTo < 0) throw new AppError('BAD_REQUEST', 'upTo must be a timestamp');
  st.seenUpTo = Math.max(st.seenUpTo, Math.min(upTo, now));
  return { seenUpTo: st.seenUpTo };
}
