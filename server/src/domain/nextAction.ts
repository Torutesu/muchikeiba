/**
 * 次にやること — the home's next-action guide (REQ-NEXT-001..014, contracts/protocol.md §45, docs/planning/06 §6.1).
 *
 * One primary card and up to two chips, chosen deterministically from a summary of the player's state:
 *   nextActionSummary(m, s, now, teamGoal?)   reads the state (no writes) into a plain NextSummary
 *   computeNextActions(cfg, summary, dismissed) the pure choice (same input → same output), priorities from data
 * Rules that keep it honest:
 *   - the screen a kind opens is fixed here (KIND_SCREEN), never in the config: no card can lead to the shop, a pass
 *     purchase or a paid scout. `scout_ticket` (using tickets the player already owns) is a chip only (CHIP_ONLY).
 *   - deadlines are only real times from data (gift expiry, exchange close, week ends, an open training session); the
 *     clients show them as a date and time, never as a countdown.
 *   - onboarding (06 §2.3): until the partner exists and `onboardingRaces` races are done only `first_race` shows.
 *   - a kind can be closed for the current game day (04:00 JST rollover, REQ-DAY-001).
 * Nothing here moves coins or items.
 */
import { z } from 'zod';
import { AppError } from './errors.js';
import type { Master } from './master.js';
import type { PlayerState } from './player.js';
import { addJstDays, dayRule, gameDayKey, gameDayStartMs, sameGameDay } from './time.js';
import { UNLOCK_KEYS, unlocksView, type UnlockKey } from './onboarding.js';
import { deletionScheduled } from './accountDeletion.js';
import { levelOf } from './pass.js';
import { trainingConfig } from './training.js';
import { weekAt, weeklyChallengeConfig } from './weeklyChallenge.js';
import { weekEndMs, weekIdAt, rivalConfig } from './rival.js';
import { exchangeSummary } from './exchange.js';
import { firstWinBonusView } from './rewards.js';

// ------------------------------------------------------------------------------------------------ kinds

import { NEXT_KINDS, type NextKind } from './nextKinds.js';
export { NEXT_KINDS, NEXT_SLOTS, type NextKind } from './nextKinds.js';

/** The screen each kind opens — code, not config (REQ-NEXT-001). There is deliberately no 'shop'. */
export const KIND_SCREEN: Record<NextKind, string> = {
  first_race: 'race', login_bonus: 'login_bonus', missions_claim: 'missions', pass_claim: 'season_pass', gift_expiring: 'gift_box',
  training_open: 'training', missions_close: 'missions', exchange_closing: 'event_exchange', feature_unlocked: 'feature', rival_week: 'rival',
  weekly_challenge: 'weekly_challenge', team_goal_near: 'team_goal', training_slots: 'training', first_win: 'race', scout_ticket: 'scout', race: 'race',
};
/** REQ-NEXT-003: never the primary card (a scout, even with an owned ticket, is not pushed as "the" thing to do). */
export const CHIP_ONLY: ReadonlySet<NextKind> = new Set(['scout_ticket']);
/** REQ-NEXT-005: always available, so they cannot be closed. */
export const NOT_DISMISSIBLE: ReadonlySet<NextKind> = new Set(['first_race', 'race']);
/** The unlock key (§4.3) a kind needs; absent = always. */
const KIND_UNLOCK: Partial<Record<NextKind, UnlockKey>> = {
  login_bonus: 'login_bonus', missions_claim: 'missions', missions_close: 'missions', pass_claim: 'season_pass', training_open: 'training',
  training_slots: 'training', exchange_closing: 'events', rival_week: 'rival', weekly_challenge: 'weekly_challenge', team_goal_near: 'teams', scout_ticket: 'scout',
};
/** Kinds that take a `threshold`, with its range (REQ-NEXT-011). */
export const THRESHOLDS: Partial<Record<NextKind, { min: number; max: number; unit: 'days' | 'units' }>> = {
  gift_expiring: { min: 1, max: 14, unit: 'days' }, exchange_closing: { min: 1, max: 7, unit: 'days' },
  missions_close: { min: 1, max: 10, unit: 'units' }, team_goal_near: { min: 1, max: 100, unit: 'units' },
};
/** REQ-NEXT-008: purchase / gacha screens can never be announced as a newly opened feature. */
export const FORBIDDEN_FEATURES: readonly string[] = ['shop', 'season_pass', 'scout'];

// ------------------------------------------------------------------------------------------------ config

export interface NextRule { kind: NextKind; priority: number; threshold?: number; features?: UnlockKey[] }
export interface NextActionConfig { enabled: boolean; maxChips: number; onboardingRaces: number; rules: NextRule[] }

let schema: z.ZodType | null = null;
// built lazily: onboarding.ts (UNLOCK_KEYS) imports this module for its config checks
const configSchema = () => (schema ??= z.object({
  _note: z.string().optional(),
  enabled: z.boolean(),
  maxChips: z.number().int().min(0).max(2),
  onboardingRaces: z.number().int().min(0).max(20),
  rules: z.array(z.object({
    kind: z.enum(NEXT_KINDS), priority: z.number().int().min(0).max(1000),
    threshold: z.number().int().optional(), features: z.array(z.enum(UNLOCK_KEYS)).max(UNLOCK_KEYS.length).optional(),
  }).strict()).min(1).max(NEXT_KINDS.length),
}).strict());

/** REQ-NEXT-011: boot and every remote-config version. */
export function nextActionProblems(m: Pick<Master, 'progression'>, path = 'progression.nextActions'): string[] {
  const raw = (m.progression as { nextActions?: unknown }).nextActions;
  if (raw === undefined) return [];
  const r = configSchema().safeParse(raw);
  if (!r.success) return r.error.issues.map((i) => `${path}.${i.path.join('.')}: ${i.message}`);
  const c = r.data as NextActionConfig;
  const out: string[] = [];
  const kinds = new Set<string>();
  const prios = new Set<number>();
  c.rules.forEach((x, i) => {
    const at = `${path}.rules[${i}]`;
    if (kinds.has(x.kind)) out.push(`${at}: duplicate kind ${x.kind}`);
    kinds.add(x.kind);
    if (prios.has(x.priority)) out.push(`${at}: priority ${x.priority} is already used (priorities must be unique)`);
    prios.add(x.priority);
    if (x.kind === 'first_race') out.push(`${at}: first_race is decided by the onboarding rules, not configured`);
    const t = THRESHOLDS[x.kind];
    if (x.threshold !== undefined && !t) out.push(`${at}: ${x.kind} takes no threshold`);
    if (t && x.threshold === undefined) out.push(`${at}: ${x.kind} needs a threshold (${t.min}..${t.max} ${t.unit})`);
    if (t && x.threshold !== undefined && (x.threshold < t.min || x.threshold > t.max)) out.push(`${at}: threshold must be ${t.min}..${t.max} ${t.unit}`);
    if (x.features !== undefined && x.kind !== 'feature_unlocked') out.push(`${at}: only feature_unlocked lists features`);
    if (x.kind === 'feature_unlocked' && !(x.features && x.features.length)) out.push(`${at}: feature_unlocked needs features`);
    for (const f of x.features ?? []) if (FORBIDDEN_FEATURES.includes(f)) out.push(`${at}: ${f} cannot be announced (purchase / scout screen)`);
  });
  if (!kinds.has('race')) out.push(`${path}.rules: race is required (the card shown when nothing else applies)`);
  return out;
}

export const nextActionConfig = (m: Pick<Master, 'progression'>): NextActionConfig | null => {
  const c = m.progression.nextActions;
  return c && c.enabled ? c : null;
};

// ------------------------------------------------------------------------------------------------ state

export interface NextActionState {
  /** Game day of `dismissed`. */
  day: string;
  dismissed: NextKind[];
  /** Unlock key → game day it was first seen unlocked ('' = already open when this was first recorded). */
  features: Record<string, string>;
}

/**
 * REQ-NEXT-008: remember the game day each listed feature is first seen unlocked. The first time ever, everything already
 * open is marked '' (open before the guide existed), so old players are not told every feature is new.
 */
export function noteFeatures(m: Master, s: PlayerState, now: number) {
  const c = nextActionConfig(m);
  if (!c) return;
  const day = gameDayKey(now, dayRule(m));
  const first = !s.nextAction;
  const st = (s.nextAction ??= { day, dismissed: [], features: {} });
  for (const f of unlocksView(m, s, now).features) {
    if (!f.unlocked || f.key in st.features) continue;
    st.features[f.key] = first ? '' : day;
  }
}

// ------------------------------------------------------------------------------------------------ summary

/** The team's goal as GET /v1/teams/me/goal shows it (only GET /v1/home/next reads it: it lives in the TeamDO). */
export interface TeamGoalBrief { endsAt: number; progress: number; milestones: { target: number; reached: boolean }[] }

/** What the choice reads (REQ-NEXT-002). Plain data: the pure function never sees the state. */
export interface NextSummary {
  now: number;
  deleting: boolean;
  onboarding: boolean;
  unlocked: string[];
  /** Listed features first seen unlocked today. */
  newFeatures: string[];
  loginBonusClaimable: boolean;
  /** Each daily mission: units left (0 = done) and whether its reward is still to claim. */
  missions: { left: number; claimable: boolean }[];
  passClaimable: number;
  /** expiresAt of every unclaimed gift that has one. */
  giftExpiries: number[];
  trainingOpenExpiresAt: number | null;
  trainingSlotsLeft: number | null;
  exchanges: { eventId: string; points: number; closesAtMs: number }[];
  rival: { weekEndsAt: number; rankedRaces: number } | null;
  weeklyChallenge: { endsAt: number; uncleared: number; startsLeftToday: number } | null;
  teamGoal: { endsAt: number; unitsLeft: number } | null;
  firstWin: { remaining: number; winsToday: number } | null;
  scoutTickets: number;
}

const safe = <T>(f: () => T, d: T): T => { try { return f(); } catch { return d; } };

/** Reads the player's state into a summary (no writes: safe in GET /v1/player, which is not saved). */
export function nextActionSummary(m: Master, s: PlayerState, now: number, teamGoal?: TeamGoalBrief | null): NextSummary {
  const c = nextActionConfig(m);
  const rule = dayRule(m);
  const today = gameDayKey(now, rule);
  const ul = unlocksView(m, s, now);
  const unlocked = ul.features.filter((f) => f.unlocked).map((f) => f.key as string);
  const listed = c?.rules.find((r) => r.kind === 'feature_unlocked')?.features ?? [];
  const seen = s.nextAction?.features;
  // before anything was recorded every open feature counts as old (noteFeatures marks them '')
  const newFeatures = seen ? listed.filter((k) => unlocked.includes(k) && (seen[k] === undefined || seen[k] === today)) : [];
  const missionsToday = sameGameDay(s.missions.date, today);
  const missions = m.progression.dailyMissions.map((d) => {
    const p = missionsToday ? Math.min(d.target, s.missions.progress[d.id] ?? 0) : 0;
    const claimed = missionsToday && s.missions.claimed.includes(d.id);
    return { left: d.target - p, claimable: p >= d.target && !claimed };
  });
  const passClaimable = safe(() => {
    const sp = s.seasonPass;
    if (sp.forfeitedAt !== undefined) return 0;
    const level = levelOf(m, sp.xp);
    let n = 0;
    for (const track of ['free', 'premium'] as const) {
      if (track === 'premium' && !(sp.expiresAt > now)) continue;
      const every = m.progression.passRewards[track].every;
      if (!(every >= 1)) continue; // a bad config never loops
      for (let l = every; l <= level; l += every) if (!sp.claimed[track].includes(l)) n++;
    }
    return n;
  }, 0);
  const giftExpiries = (s.giftBox?.box ?? []).filter((e) => e.expiresAt !== null && now < e.expiresAt).map((e) => e.expiresAt as number);
  const tc = trainingConfig(m);
  const t = s.training;
  const trainingOpenExpiresAt = tc && t?.open && now <= t.open.expiresAt ? t.open.expiresAt : null;
  const trainingSlotsLeft = tc ? Math.max(0, tc.slotsPerDay - (t && sameGameDay(t.day, today) ? t.used : 0)) : null;
  const exchanges = safe(() => m.events.filter((ev) => ev.exchange).map((ev) => ({ ev, x: exchangeSummary(m, ev, s, now)! }))
    .filter(({ x }) => x.points > 0 && (x.status === 'open' || x.status === 'grace') && !x.converted)
    .map(({ ev, x }) => ({ eventId: ev.id, points: x.points, closesAtMs: x.closesAtMs })), []);
  const rival = safe(() => {
    const r = s.rival;
    if (!rivalConfig(m) || !r || r.optOut) return null;
    const weekId = weekIdAt(m, now);
    const w = r.weeks.find((x) => x.weekId === weekId);
    const a = w?.assignment;
    if (!w || !a || (a.kind === 'human' && a.dissolvedAt !== null && now >= a.dissolvedAt)) return null;
    return { weekEndsAt: weekEndMs(m, weekId), rankedRaces: w.rankedRaces };
  }, null);
  const weeklyChallenge = safe(() => {
    // the same reads as weeklyChallengeView, without building the cards (GET /v1/player stays cheap)
    const wc = weeklyChallengeConfig(m);
    if (!wc || !wc.enabled) return null;
    const cur = weekAt(m, wc, now);
    const st = s.weeklyChallenge;
    const wk = st?.weeks[cur.weekId];
    const used = st && sameGameDay(st.daily.date, today) ? st.daily.count : 0;
    return { endsAt: cur.endsAt, uncleared: cur.def.challenges.filter((ch) => !wk?.cleared[ch.id]).length, startsLeftToday: Math.max(0, wc.startsPerDay - used) };
  }, null);
  const tg = teamGoal ? (() => {
    const next = teamGoal.milestones.find((x) => !x.reached);
    return next ? { endsAt: teamGoal.endsAt, unitsLeft: Math.max(0, next.target - teamGoal.progress) } : null;
  })() : null;
  const fw = m.progression.firstWinBonus ? firstWinBonusView(m, s, now) : null;
  const tickets = Object.keys(m.items?.tickets ?? {}).reduce((a, id) => a + Math.max(0, s.items[id] ?? 0), 0);
  const races = s.onboarding?.races ?? s.stats?.races ?? 0;
  return {
    now,
    deleting: deletionScheduled(s),
    onboarding: !s.flags.partnerHorseId || races < (c?.onboardingRaces ?? 0),
    unlocked, newFeatures,
    loginBonusClaimable: !sameGameDay(s.loginBonus.lastClaimDate, today),
    missions, passClaimable, giftExpiries, trainingOpenExpiresAt, trainingSlotsLeft, exchanges, rival, weeklyChallenge,
    teamGoal: tg, firstWin: fw ? { remaining: fw.remaining, winsToday: fw.winsToday } : null, scoutTickets: tickets,
  };
}

// ------------------------------------------------------------------------------------------------ the choice (pure)

export interface NextItem {
  kind: NextKind;
  screen: string;
  count: number | null;
  /** A real time from data (REQ-NEXT-006), or null. */
  deadlineAt: number | null;
  featureKey: string | null;
  refId: string | null;
  dismissible: boolean;
}
type Candidate = Omit<NextItem, 'screen' | 'dismissible'>;
const DAY = 86_400_000;
const item = (kind: NextKind, o: Partial<Candidate> = {}): Candidate => ({ kind, count: null, deadlineAt: null, featureKey: null, refId: null, ...o });

/** One candidate per kind whose condition holds (§45.1); null when it does not. */
function candidate(r: NextRule, x: NextSummary): Candidate | null {
  const th = r.threshold ?? 0;
  switch (r.kind) {
    case 'first_race': return null;
    case 'login_bonus': return x.loginBonusClaimable ? item(r.kind) : null;
    case 'missions_claim': { const n = x.missions.filter((q) => q.claimable).length; return n > 0 ? item(r.kind, { count: n }) : null; }
    case 'missions_close': {
      const open = x.missions.filter((q) => q.left > 0 && q.left <= th).map((q) => q.left);
      return open.length ? item(r.kind, { count: Math.min(...open) }) : null;
    }
    case 'pass_claim': return x.passClaimable > 0 ? item(r.kind, { count: x.passClaimable }) : null;
    case 'gift_expiring': {
      const soon = x.giftExpiries.filter((e) => e > x.now && e - x.now <= th * DAY);
      return soon.length ? item(r.kind, { count: soon.length, deadlineAt: Math.min(...soon) }) : null;
    }
    case 'training_open': return x.trainingOpenExpiresAt !== null ? item(r.kind, { deadlineAt: x.trainingOpenExpiresAt }) : null;
    case 'training_slots': return x.trainingSlotsLeft ? item(r.kind, { count: x.trainingSlotsLeft }) : null;
    case 'exchange_closing': {
      const e = x.exchanges.filter((q) => q.closesAtMs > x.now && q.closesAtMs - x.now <= th * DAY)
        .sort((a, b) => a.closesAtMs - b.closesAtMs || (a.eventId < b.eventId ? -1 : 1))[0];
      return e ? item(r.kind, { count: e.points, deadlineAt: e.closesAtMs, refId: e.eventId }) : null;
    }
    case 'feature_unlocked': {
      const order = r.features ?? [];
      const f = order.find((k) => x.newFeatures.includes(k));
      return f ? item(r.kind, { featureKey: f }) : null;
    }
    case 'rival_week': return x.rival && x.rival.rankedRaces === 0 ? item(r.kind, { deadlineAt: x.rival.weekEndsAt }) : null;
    case 'weekly_challenge': {
      const w = x.weeklyChallenge;
      return w && w.uncleared > 0 && w.startsLeftToday > 0 ? item(r.kind, { count: w.uncleared, deadlineAt: w.endsAt }) : null;
    }
    case 'team_goal_near': {
      const g = x.teamGoal;
      return g && g.unitsLeft > 0 && g.unitsLeft <= th ? item(r.kind, { count: g.unitsLeft, deadlineAt: g.endsAt }) : null;
    }
    case 'first_win': return x.firstWin && x.firstWin.remaining > 0 && x.firstWin.winsToday === 0 ? item(r.kind) : null;
    case 'scout_ticket': return x.scoutTickets > 0 ? item(r.kind, { count: x.scoutTickets }) : null;
    case 'race': return item(r.kind);
  }
}

const finish = (c: Candidate): NextItem => ({ ...c, screen: KIND_SCREEN[c.kind], dismissible: !NOT_DISMISSIBLE.has(c.kind) });

/**
 * REQ-NEXT-002..005/009: the primary card and the chips. Pure: the result depends only on the arguments.
 * `dismissed` = kinds closed for the summary's game day.
 */
export function computeNextActions(cfg: NextActionConfig, x: NextSummary, dismissed: readonly string[] = []): { primary: NextItem | null; chips: NextItem[] } {
  if (x.deleting) return { primary: finish(item('race')), chips: [] };
  if (x.onboarding) return { primary: finish(item('first_race')), chips: [] };
  const order = (k: NextKind) => NEXT_KINDS.indexOf(k);
  const rules = [...cfg.rules].sort((a, b) => b.priority - a.priority || order(a.kind) - order(b.kind));
  const list: Candidate[] = [];
  for (const r of rules) {
    if (dismissed.includes(r.kind)) continue;
    const need = KIND_UNLOCK[r.kind];
    if (need && !x.unlocked.includes(need)) continue;
    const c = candidate(r, x);
    if (c) list.push(c);
  }
  const primary = list.find((c) => !CHIP_ONLY.has(c.kind)) ?? null;
  const chips = list.filter((c) => c !== primary && c.kind !== 'race').slice(0, cfg.maxChips);
  return { primary: primary ? finish(primary) : null, chips: chips.map(finish) };
}

// ------------------------------------------------------------------------------------------------ view / dismiss

/** Kinds closed today (an older day's list is empty). */
export function dismissedToday(m: Master, s: PlayerState, now: number): NextKind[] {
  const st = s.nextAction;
  return st && st.day === gameDayKey(now, dayRule(m)) ? [...st.dismissed] : [];
}

/** REQ-NEXT-010: GET /v1/home/next, bootstrap and GET /v1/player (`nextActions`). */
export function nextActionsView(m: Master, s: PlayerState, now: number, teamGoal?: TeamGoalBrief | null) {
  const rule = dayRule(m);
  const day = gameDayKey(now, rule);
  const nextDayAt = gameDayStartMs(addJstDays(day, 1), rule);
  const c = nextActionConfig(m);
  if (!c) return { enabled: false as const, day, onboarding: false, primary: null, chips: [] as NextItem[], dismissed: [] as NextKind[], nextDayAt };
  const x = nextActionSummary(m, s, now, teamGoal);
  const dismissed = dismissedToday(m, s, now);
  const r = computeNextActions(c, x, dismissed);
  return { enabled: true as const, day, onboarding: x.onboarding && !x.deleting, primary: r.primary, chips: r.chips, dismissed, nextDayAt };
}
export type NextActionsView = ReturnType<typeof nextActionsView>;

/** REQ-NEXT-005: close a kind for today's game day. Returns whether it was newly closed (the KPI is sent once). */
export function dismissNextAction(m: Master, s: PlayerState, kind: string, now: number): boolean {
  if (!(NEXT_KINDS as readonly string[]).includes(kind)) throw new AppError('BAD_REQUEST', `unknown next action ${kind}`);
  if (NOT_DISMISSIBLE.has(kind as NextKind)) throw new AppError('NOT_ELIGIBLE', `${kind} cannot be closed`);
  if (!nextActionConfig(m)) throw new AppError('NOT_FOUND', 'the next-action guide is not available');
  noteFeatures(m, s, now);
  const day = gameDayKey(now, dayRule(m));
  const st = s.nextAction!;
  if (st.day !== day) { st.day = day; st.dismissed = []; }
  if (st.dismissed.includes(kind as NextKind)) return false;
  st.dismissed.push(kind as NextKind);
  return true;
}
