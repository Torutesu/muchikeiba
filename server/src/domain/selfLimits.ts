/**
 * 使いすぎ・遊びすぎの防止 (self-set spending limit & play-time reminder, REQ-LIMIT-001..022, contracts/protocol.md §67).
 *
 * Two player-controlled safety settings, stored in PlayerState `selfLimits`:
 *  - a monthly spending limit the player sets at or below the age band's cap (REQ-PUR-002). Lowering applies at once;
 *    raising or removing waits `coolOffHours` (default 72 h) and can be cancelled meanwhile. The limit in effect is
 *    min(age cap, own limit), judged by purchase.ts productBlock — the one check every purchase path uses (the purchase
 *    confirmation, §29 shortfall packs, §13.3 one-time offers). Store receipts that arrive anyway are granted and counted
 *    (purchase.ts applyVerifiedPurchase records `selfLimitBreach`).
 *  - a play-time reminder (off by default): session length, daily total and an "after this hour" mark, synced through the
 *    server; the DEVICE measures the time and shows a calm sheet at a safe point (after a race result / on the home).
 *    `decidePlaytimeReminder` is the pure rule shared with C# PlaytimeReminderPolicy (contracts/self-limits.vectors.json).
 *
 * Nothing here moves coins or items (no E number); no reward or penalty depends on these settings. This module imports
 * nothing from purchase.ts (purchase.ts reads `selfLimitYenAt`), so the age cap comes in as an argument.
 */
import { z } from 'zod';
import { AppError } from './errors.js';
import type { Master } from './master.js';
import type { PlayerState } from './player.js';
import { jstMonthKey } from './time.js';

const HOUR = 3_600_000;
const MIN = 60_000;

// ------------------------------------------------------------------------------------------------ config (§67.9)

export const selfLimitsConfigSchema = z.object({
  _note: z.string().optional(),
  spendingChoicesYen: z.array(z.number().int().min(1)).min(1).max(8),
  customMinYen: z.number().int().min(1),
  customMaxYen: z.number().int().min(1).max(10_000_000),
  customStepYen: z.number().int().min(1).max(10_000),
  coolOffHours: z.number().int().min(24).max(168),
  historyKeep: z.number().int().min(5).max(100),
  playtime: z.object({
    sessionChoicesMin: z.array(z.number().int().min(15).max(600)).min(1).max(8),
    dailyChoicesMin: z.array(z.number().int().min(30).max(1440)).min(1).max(8),
    quietAfterChoicesHour: z.array(z.number().int().min(0).max(23)).min(1).max(8),
  }).strict(),
}).strict();
export type SelfLimitsConfig = z.infer<typeof selfLimitsConfigSchema>;

export const DEFAULT_SELF_LIMITS: SelfLimitsConfig = {
  spendingChoicesYen: [1000, 3000, 5000, 10000, 30000],
  customMinYen: 100, customMaxYen: 1_000_000, customStepYen: 100,
  coolOffHours: 72, historyKeep: 30,
  playtime: { sessionChoicesMin: [30, 60, 90, 120], dailyChoicesMin: [60, 120, 180, 240], quietAfterChoicesHour: [21, 22, 23, 0] },
};

/** No kill switch (REQ-LIMIT-019): an absent section means the defaults. */
export function selfLimitsConfig(m: Pick<Master, 'progression'>): SelfLimitsConfig {
  return (m.progression as { selfLimits?: SelfLimitsConfig }).selfLimits ?? DEFAULT_SELF_LIMITS;
}

/** REQ-LIMIT-019: boot and every remote-config version. */
export function selfLimitsProblems(m: Pick<Master, 'progression'>): string[] {
  const raw = (m.progression as { selfLimits?: unknown }).selfLimits;
  if (raw === undefined) return [];
  const r = selfLimitsConfigSchema.safeParse(raw);
  if (!r.success) return r.error.issues.map((i) => `selfLimits.${i.path.join('.')}: ${i.message}`);
  const c = r.data;
  const p: string[] = [];
  const ascending = (xs: number[]) => xs.every((x, i) => i === 0 || x > xs[i - 1]!);
  if (!ascending(c.spendingChoicesYen)) p.push('selfLimits.spendingChoicesYen must be ascending without duplicates');
  if (c.spendingChoicesYen.some((x) => x % c.customStepYen !== 0)) p.push('selfLimits.spendingChoicesYen must be multiples of customStepYen');
  if (c.customMinYen > c.customMaxYen) p.push('selfLimits.customMinYen must not be above customMaxYen');
  if (c.customMinYen % c.customStepYen !== 0 || c.customMaxYen % c.customStepYen !== 0) p.push('selfLimits.customMinYen / customMaxYen must be multiples of customStepYen');
  if (c.spendingChoicesYen.some((x) => x < c.customMinYen || x > c.customMaxYen)) p.push('selfLimits.spendingChoicesYen must lie within customMinYen..customMaxYen');
  if (!ascending(c.playtime.sessionChoicesMin)) p.push('selfLimits.playtime.sessionChoicesMin must be ascending without duplicates');
  if (!ascending(c.playtime.dailyChoicesMin)) p.push('selfLimits.playtime.dailyChoicesMin must be ascending without duplicates');
  if (new Set(c.playtime.quietAfterChoicesHour).size !== c.playtime.quietAfterChoicesHour.length) p.push('selfLimits.playtime.quietAfterChoicesHour has duplicates');
  return p;
}

// ------------------------------------------------------------------------------------------------ state (§67.7)

export const SELF_LIMIT_CHANGES = ['set', 'raise_requested', 'remove_requested', 'raise_applied', 'raise_cancelled', 'playtime'] as const;
export type SelfLimitChange = typeof SELF_LIMIT_CHANGES[number];
export interface SelfLimitPending { limitYen: number | null; requestedAt: number; effectiveAt: number }
export interface SelfLimitHistoryRow { at: number; kind: SelfLimitChange; fromYen: number | null; toYen: number | null }
export interface PlaytimeSettings { sessionMin: number | null; dailyMin: number | null; quietAfterHour: number | null }
export interface SelfLimitsState {
  spending: { limitYen: number | null; setAt: number | null; pending: SelfLimitPending | null };
  playtime: PlaytimeSettings & { updatedAt: number | null };
  rev: number;
  /** Oldest first, at most `historyKeep`. */
  history: SelfLimitHistoryRow[];
}

/** The age band's cap as the caller computed it (purchase.ts ageCapOf); `limitYen` null = no cap (adult or not registered). */
export interface AgeCap { limitYen: number | null; band: string | null }

function ensure(s: PlayerState): SelfLimitsState {
  s.selfLimits ??= {
    spending: { limitYen: null, setAt: null, pending: null },
    playtime: { sessionMin: null, dailyMin: null, quietAfterHour: null, updatedAt: null },
    rev: 0, history: [],
  };
  return s.selfLimits;
}

/** REQ-LIMIT-003: the player's own limit in effect at `now` (a raise whose cool-off has passed counts). Read-only. */
export function selfLimitYenAt(s: PlayerState, now: number): number | null {
  const sp = s.selfLimits?.spending;
  if (!sp) return null;
  if (sp.pending && sp.pending.effectiveAt <= now) return sp.pending.limitYen;
  return sp.limitYen;
}
/** The pending raise / removal still waiting at `now` (null once it has taken effect). */
export function pendingAt(s: PlayerState, now: number): SelfLimitPending | null {
  const p = s.selfLimits?.spending.pending ?? null;
  return p && p.effectiveAt > now ? p : null;
}
const minCap = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));
export const effectiveLimitYen = (age: AgeCap, self: number | null) => minCap(age.limitYen, self);
/** Which cap binds: `self` only when strictly below the age cap (equal → `age`: changing the own limit would not help). */
export function bindingCap(age: AgeCap, self: number | null): 'self' | 'age' | 'none' {
  if (self !== null && (age.limitYen === null || self < age.limitYen)) return 'self';
  return age.limitYen !== null ? 'age' : 'none';
}

function push(m: Pick<Master, 'progression'>, st: SelfLimitsState, row: SelfLimitHistoryRow) {
  st.history.push(row);
  const keep = selfLimitsConfig(m).historyKeep;
  if (st.history.length > keep) st.history.splice(0, st.history.length - keep);
}

/** Writes a matured raise into the state (history `raise_applied` at its effectiveAt). Called before every change. */
export function settleSelfLimits(m: Pick<Master, 'progression'>, s: PlayerState, now: number): boolean {
  const st = s.selfLimits;
  const p = st?.spending.pending;
  if (!st || !p || p.effectiveAt > now) return false;
  push(m, st, { at: p.effectiveAt, kind: 'raise_applied', fromYen: st.spending.limitYen, toYen: p.limitYen });
  st.spending.limitYen = p.limitYen;
  st.spending.setAt = p.effectiveAt;
  st.spending.pending = null;
  return true;
}

// ------------------------------------------------------------------------------------------------ changes (§67.1 / §67.5)

export const spendingBodySchema = z.object({ limitYen: z.number().int().nullable() }).strict();
export const playtimeBodySchema = z.object({
  sessionMin: z.number().int().nullable().optional(),
  dailyMin: z.number().int().nullable().optional(),
  quietAfterHour: z.number().int().nullable().optional(),
}).strict();
export type PlaytimeBody = z.infer<typeof playtimeBodySchema>;

export type SpendingApplied = 'now' | 'pending' | 'unchanged' | 'cancelled';
export interface SpendingChange { applied: SpendingApplied; kind: SelfLimitChange | null; fromYen: number | null; toYen: number | null }

/** REQ-LIMIT-001: a valid amount (a listed choice or a custom amount on the step, within range, never above the age cap). */
function checkAmount(c: SelfLimitsConfig, age: AgeCap, yen: number | null) {
  if (yen === null) return;
  const listed = c.spendingChoicesYen.includes(yen);
  if (!listed && (yen < c.customMinYen || yen > c.customMaxYen || yen % c.customStepYen !== 0)) {
    throw new AppError('BAD_REQUEST', `limitYen must be one of the choices or a multiple of ${c.customStepYen} between ${c.customMinYen} and ${c.customMaxYen}`);
  }
  if (age.limitYen !== null && yen > age.limitYen) throw new AppError('BAD_REQUEST', `limitYen ${yen} is above the age band's monthly limit ${age.limitYen}`);
}

/** REQ-LIMIT-001/002: PUT /v1/self-limits/spending. Lowering applies now; raising / removing waits coolOffHours. */
export function setSpendingLimit(m: Pick<Master, 'progression'>, s: PlayerState, limitYen: number | null, age: AgeCap, now: number): SpendingChange {
  const c = selfLimitsConfig(m);
  checkAmount(c, age, limitYen);
  if (!s.selfLimits && limitYen === null) return { applied: 'unchanged', kind: null, fromYen: null, toYen: null };
  const st = ensure(s);
  settleSelfLimits(m, s, now);
  const cur = st.spending.limitYen;
  const pending = st.spending.pending;
  if (limitYen === cur) {
    if (!pending) return { applied: 'unchanged', kind: null, fromYen: cur, toYen: cur };
    // saving the current amount again keeps it: the waiting raise is dropped
    st.spending.pending = null;
    st.rev++;
    push(m, st, { at: now, kind: 'raise_cancelled', fromYen: cur, toYen: pending.limitYen });
    return { applied: 'cancelled', kind: 'raise_cancelled', fromYen: cur, toYen: pending.limitYen };
  }
  const lower = limitYen !== null && (cur === null || limitYen < cur);
  if (lower) {
    st.spending.limitYen = limitYen;
    st.spending.setAt = now;
    st.spending.pending = null; // a lower limit replaces any waiting raise
    st.rev++;
    push(m, st, { at: now, kind: 'set', fromYen: cur, toYen: limitYen });
    return { applied: 'now', kind: 'set', fromYen: cur, toYen: limitYen };
  }
  // raise or remove: the same request again keeps its clock (idempotent); a different one starts the clock again
  if (pending && pending.limitYen === limitYen) return { applied: 'pending', kind: null, fromYen: cur, toYen: limitYen };
  const kind: SelfLimitChange = limitYen === null ? 'remove_requested' : 'raise_requested';
  st.spending.pending = { limitYen, requestedAt: now, effectiveAt: now + c.coolOffHours * HOUR };
  st.rev++;
  push(m, st, { at: now, kind, fromYen: cur, toYen: limitYen });
  return { applied: 'pending', kind, fromYen: cur, toYen: limitYen };
}

/** REQ-LIMIT-002: DELETE /v1/self-limits/spending/pending (nothing waiting = nothing changes). */
export function cancelSpendingRaise(m: Pick<Master, 'progression'>, s: PlayerState, now: number): SpendingChange {
  if (!s.selfLimits) return { applied: 'unchanged', kind: null, fromYen: null, toYen: null };
  const st = s.selfLimits;
  settleSelfLimits(m, s, now);
  const p = st.spending.pending;
  if (!p) return { applied: 'unchanged', kind: null, fromYen: st.spending.limitYen, toYen: st.spending.limitYen };
  st.spending.pending = null;
  st.rev++;
  push(m, st, { at: now, kind: 'raise_cancelled', fromYen: st.spending.limitYen, toYen: p.limitYen });
  return { applied: 'cancelled', kind: 'raise_cancelled', fromYen: st.spending.limitYen, toYen: p.limitYen };
}

/** REQ-LIMIT-009: PUT /v1/self-limits/playtime (missing keys keep their value; values from the choices or null). */
export function setPlaytime(m: Pick<Master, 'progression'>, s: PlayerState, b: PlaytimeBody, now: number): { changed: (keyof PlaytimeSettings)[]; enabled: boolean } {
  const c = selfLimitsConfig(m).playtime;
  const allowed: Record<keyof PlaytimeSettings, number[]> = { sessionMin: c.sessionChoicesMin, dailyMin: c.dailyChoicesMin, quietAfterHour: c.quietAfterChoicesHour };
  for (const k of Object.keys(allowed) as (keyof PlaytimeSettings)[]) {
    const v = b[k];
    if (v !== undefined && v !== null && !allowed[k].includes(v)) throw new AppError('BAD_REQUEST', `${k} must be one of ${allowed[k].join(', ')} or null`);
  }
  const cur = s.selfLimits?.playtime;
  const changed = (Object.keys(allowed) as (keyof PlaytimeSettings)[]).filter((k) => b[k] !== undefined && b[k] !== (cur?.[k] ?? null));
  if (changed.length === 0) return { changed, enabled: playtimeEnabled(cur ?? null) };
  const st = ensure(s);
  for (const k of changed) st.playtime[k] = b[k] ?? null;
  st.playtime.updatedAt = now;
  st.rev++;
  push(m, st, { at: now, kind: 'playtime', fromYen: null, toYen: null });
  return { changed, enabled: playtimeEnabled(st.playtime) };
}
const playtimeEnabled = (p: PlaytimeSettings | null) => !!p && (p.sessionMin !== null || p.dailyMin !== null || p.quietAfterHour !== null);

// ------------------------------------------------------------------------------------------------ views (§67.6)

const fmt = (n: number) => n.toLocaleString('en-US');
const yen = (n: number) => `¥${fmt(n)}`;
/** JST `MM/DD HH:mm` (what the screens print; same as maintenance.ts shortJst). */
const shortJst = (ms: number) => { const s = new Date(ms + 9 * HOUR).toISOString(); return `${s.slice(5, 7)}/${s.slice(8, 10)} ${s.slice(11, 16)}`; };

export const SELF_LIMIT_TEXT = {
  status: (limit: number, left: number) => `自分で決めた上限 ${yen(limit)}（今月の残り ${yen(left)}）`,
  noneSet: '自分で決めた上限はありません',
  pendingRaise: (to: number, at: number) => `${yen(to)}への変更は ${shortJst(at)} から効きます（取り消せます）`,
  pendingRemove: (at: number) => `上限なしへの変更は ${shortJst(at)} から効きます（取り消せます）`,
  ruleLower: '下げた上限はすぐに効きます',
  ruleRaise: (h: number) => `上げる・外す変更は${h}時間たってから効きます（その間は取り消せます）`,
  ruleAge: '年齢に応じた上限より高くはできません',
  ruleStore: 'ストアで支払いが済んだ購入は、上限を超えていても受け取れます（今月の支払いに数えます）',
  rulePlaySafe: 'レースの途中には出しません。結果の後かホームで知らせます',
  rulePlayDevice: '時間は端末で数えます（サーバーには送りません）',
  blocked: '自分で決めた今月の上限に達しているため、いま購入できるパックはありません',
} as const;

export function spendingView(m: Pick<Master, 'progression'>, s: PlayerState, age: AgeCap, now: number) {
  const c = selfLimitsConfig(m);
  const own = selfLimitYenAt(s, now);
  const month = jstMonthKey(now);
  const spent = s.monthlySpendYen[month] ?? 0;
  const eff = effectiveLimitYen(age, own);
  const p = pendingAt(s, now);
  return {
    limitYen: own, ageLimitYen: age.limitYen, ageBand: age.band, effectiveLimitYen: eff, binding: bindingCap(age, own),
    month, monthSpentYen: spent, remainingYen: eff === null ? null : Math.max(0, eff - spent),
    pending: p ? { limitYen: p.limitYen, requestedAt: p.requestedAt, effectiveAt: p.effectiveAt } : null,
    choicesYen: c.spendingChoicesYen.filter((x) => age.limitYen === null || x <= age.limitYen),
    custom: { minYen: c.customMinYen, maxYen: age.limitYen === null ? c.customMaxYen : Math.min(c.customMaxYen, age.limitYen), stepYen: c.customStepYen },
    coolOffHours: c.coolOffHours,
    statusText: own === null ? SELF_LIMIT_TEXT.noneSet : SELF_LIMIT_TEXT.status(own, Math.max(0, own - spent)),
    pendingText: p ? (p.limitYen === null ? SELF_LIMIT_TEXT.pendingRemove(p.effectiveAt) : SELF_LIMIT_TEXT.pendingRaise(p.limitYen, p.effectiveAt)) : null,
    rulesText: [SELF_LIMIT_TEXT.ruleLower, SELF_LIMIT_TEXT.ruleRaise(c.coolOffHours), SELF_LIMIT_TEXT.ruleAge, SELF_LIMIT_TEXT.ruleStore],
  };
}

function playtimeOf(s: PlayerState): PlaytimeSettings & { enabled: boolean } {
  const p = s.selfLimits?.playtime;
  const v = { sessionMin: p?.sessionMin ?? null, dailyMin: p?.dailyMin ?? null, quietAfterHour: p?.quietAfterHour ?? null };
  return { ...v, enabled: playtimeEnabled(v) };
}

/** REQ-LIMIT-013: GET /v1/self-limits (read-only; never creates state). */
export function selfLimitsView(m: Pick<Master, 'progression'>, s: PlayerState, age: AgeCap, now: number) {
  const c = selfLimitsConfig(m);
  // a matured raise shows as applied (its history row is written by the next change)
  const st = s.selfLimits;
  const history = [...(st?.history ?? [])];
  const p = st?.spending.pending;
  if (p && p.effectiveAt <= now) history.push({ at: p.effectiveAt, kind: 'raise_applied', fromYen: st!.spending.limitYen, toYen: p.limitYen });
  return {
    rev: st?.rev ?? 0,
    spending: spendingView(m, s, age, now),
    playtime: {
      ...playtimeOf(s),
      choices: { sessionMin: c.playtime.sessionChoicesMin, dailyMin: c.playtime.dailyChoicesMin, quietAfterHour: c.playtime.quietAfterChoicesHour },
      rulesText: [SELF_LIMIT_TEXT.rulePlaySafe, SELF_LIMIT_TEXT.rulePlayDevice],
    },
    history: history.reverse(),
  };
}
export type SelfLimitsView = ReturnType<typeof selfLimitsView>;

/** REQ-LIMIT-013: the copy in bootstrap / GET /v1/player (`selfLimits`) — what the device needs to time the reminder. */
export function selfLimitsDigest(s: PlayerState, age: AgeCap, now: number) {
  const own = selfLimitYenAt(s, now);
  const p = pendingAt(s, now);
  return {
    playtime: playtimeOf(s),
    spending: { limitYen: own, effectiveLimitYen: effectiveLimitYen(age, own), pending: p ? { limitYen: p.limitYen, effectiveAt: p.effectiveAt } : null },
  };
}

// ------------------------------------------------------------------------------------------------ the reminder (§67.4)

export const PLAYTIME_REASONS = ['quiet_after', 'daily', 'session'] as const;
export type PlaytimeReason = typeof PLAYTIME_REASONS[number];
/** Where the device may show the sheet; every other place keeps the reminder for the next safe point. */
export const PLAYTIME_SAFE_POINTS = ['race_result', 'home'] as const;
export const PLAYTIME_PLACES = ['race_result', 'home', 'race', 'matchmaking', 'purchase', 'tutorial', 'other'] as const;
export type PlaytimePlace = typeof PLAYTIME_PLACES[number];
/** The device starts a new session after this long in the background. */
export const PLAYTIME_SESSION_GAP_MIN = 30;
/** The device's day for the daily total and "after this hour" rolls over at this local hour (the game day's hour). */
export const PLAYTIME_DAY_START_HOUR = 4;
export const PLAYTIME_CHOICES = ['continue', 'stop', 'settings'] as const;

export interface PlaytimeMarks {
  /** The session minute mark last reminded (null = none this session). */
  sessionMark: number | null;
  /** The device day (`YYYY-MM-DD`, local, 4:00 roll-over) of the two once-a-day flags below. */
  dayKey: string | null;
  dailyShown: boolean;
  quietShown: boolean;
}
export interface PlaytimeSnapshot {
  now: number;
  /** The device's UTC offset in minutes (JST = 540). */
  localOffsetMin: number;
  locale: 'ja' | 'en';
  settings: PlaytimeSettings;
  /** Foreground minutes of this session / of this device day (PlaytimeClock). */
  sessionPlayedMin: number;
  dayPlayedMin: number;
  marks: PlaytimeMarks;
  place: PlaytimePlace;
}
export interface PlaytimeDecision {
  show: boolean;
  /** Due reasons in sheet order (also when not shown: kept for the next safe point). */
  reasons: PlaytimeReason[];
  /** `off` = nothing set; `not_due`; `not_safe` = due but not at a safe point. Null when shown. */
  blockedBy: 'off' | 'not_due' | 'not_safe' | null;
  title: string | null;
  lines: string[];
  note: string | null;
  buttons: { continue: string; stop: string; settings: string } | null;
  /** The marks to save when the sheet was shown (equal to the input otherwise, with the day rolled over). */
  marks: PlaytimeMarks;
}

/** The device day of `now` (local time, rolling over at 4:00) and the minutes since that roll-over. */
export function playtimeDay(now: number, offsetMin: number): { dayKey: string; minuteOfDay: number } {
  const local = now + offsetMin * MIN - PLAYTIME_DAY_START_HOUR * HOUR;
  const d = new Date(local);
  return { dayKey: d.toISOString().slice(0, 10), minuteOfDay: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

const SHEET = {
  ja: {
    title: 'ひと息つきませんか',
    session: (n: number) => `遊びはじめて${n}分たちました`,
    daily: (n: number) => `今日は合計${n}分遊びました`,
    quiet_after: (h: number) => `${h}時を過ぎました`,
    note: 'ご自身で決めた目安のお知らせです。続けるか、ここで終えるかはご自由に',
    buttons: { continue: '続ける', stop: '今日はここまで', settings: 'お知らせの設定' },
  },
  en: {
    title: 'Time for a short break?',
    session: (n: number) => `You have been playing for ${n} minutes`,
    daily: (n: number) => `You have played ${n} minutes in total today`,
    quiet_after: (h: number) => `It is past ${h === 0 ? 'midnight' : h < 12 ? `${h} a.m.` : h === 12 ? 'noon' : `${h - 12} p.m.`}`,
    note: 'This is the reminder you set for yourself. Carry on or stop here, as you like.',
    buttons: { continue: 'Continue', stop: 'Done for today', settings: 'Reminder settings' },
  },
} as const;

/**
 * REQ-LIMIT-011: pure (same snapshot → same decision). C# PlaytimeReminderPolicy.Decide agrees through
 * contracts/self-limits.vectors.json. Minutes are floored to whole minutes by the caller.
 */
export function decidePlaytimeReminder(x: PlaytimeSnapshot): PlaytimeDecision {
  const { dayKey, minuteOfDay } = playtimeDay(x.now, x.localOffsetMin);
  const sameDay = x.marks.dayKey === dayKey;
  const marks: PlaytimeMarks = { sessionMark: x.marks.sessionMark, dayKey, dailyShown: sameDay && x.marks.dailyShown, quietShown: sameDay && x.marks.quietShown };
  const st = x.settings;
  const none = (blockedBy: PlaytimeDecision['blockedBy'], reasons: PlaytimeReason[] = []): PlaytimeDecision =>
    ({ show: false, reasons, blockedBy, title: null, lines: [], note: null, buttons: null, marks });
  if (st.sessionMin === null && st.dailyMin === null && st.quietAfterHour === null) return none('off');
  const reasons: PlaytimeReason[] = [];
  if (st.quietAfterHour !== null && !marks.quietShown) {
    const from = ((st.quietAfterHour - PLAYTIME_DAY_START_HOUR + 24) % 24) * 60;
    if (minuteOfDay >= from) reasons.push('quiet_after');
  }
  if (st.dailyMin !== null && !marks.dailyShown && x.dayPlayedMin >= st.dailyMin) reasons.push('daily');
  let sessionMark = marks.sessionMark;
  if (st.sessionMin !== null && x.sessionPlayedMin >= (marks.sessionMark ?? 0) + st.sessionMin) {
    reasons.push('session');
    sessionMark = Math.floor(x.sessionPlayedMin / st.sessionMin) * st.sessionMin;
  }
  if (reasons.length === 0) return none('not_due');
  if (!(PLAYTIME_SAFE_POINTS as readonly string[]).includes(x.place)) return none('not_safe', reasons);
  const t = SHEET[x.locale];
  const lines = reasons.map((r) => (r === 'quiet_after' ? t.quiet_after(st.quietAfterHour!) : r === 'daily' ? t.daily(x.dayPlayedMin) : t.session(sessionMark!)));
  return {
    show: true, reasons, blockedBy: null, title: t.title, lines, note: t.note, buttons: { ...t.buttons },
    marks: { sessionMark, dayKey, dailyShown: marks.dailyShown || reasons.includes('daily'), quietShown: marks.quietShown || reasons.includes('quiet_after') },
  };
}

/** Every Japanese text this module can produce (the wording lint in the tests reads it). */
export function selfLimitsTextsJa(): string[] {
  const t = SHEET.ja;
  return [
    SELF_LIMIT_TEXT.status(3000, 600), SELF_LIMIT_TEXT.noneSet, SELF_LIMIT_TEXT.pendingRaise(5000, 0), SELF_LIMIT_TEXT.pendingRemove(0),
    SELF_LIMIT_TEXT.ruleLower, SELF_LIMIT_TEXT.ruleRaise(72), SELF_LIMIT_TEXT.ruleAge, SELF_LIMIT_TEXT.ruleStore, SELF_LIMIT_TEXT.rulePlaySafe,
    SELF_LIMIT_TEXT.rulePlayDevice, SELF_LIMIT_TEXT.blocked, t.title, t.session(60), t.daily(120), t.quiet_after(22), t.note, ...Object.values(t.buttons),
  ];
}
export function selfLimitsTextsEn(): string[] {
  const t = SHEET.en;
  return [t.title, t.session(60), t.daily(120), t.quiet_after(22), t.quiet_after(0), t.quiet_after(9), t.note, ...Object.values(t.buttons)];
}
