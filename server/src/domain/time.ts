/** Injectable clock. */
export type Clock = () => number;
export const systemClock: Clock = () => Date.now();

const JST_OFFSET_MS = 9 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;

/**
 * REQ-UXS-011 / REQ-DAY-001..006: the game day. Daily resets (login bonus, daily missions, first-win bonus,
 * friend reward cap, care, breeding, time attack attempts, stud lending, likes cap, allowance claim, push
 * daily cap, the day's going) happen at a JST hour that is a validated master / remote-config value
 * (`progression.dayRollover`), not a constant. Every game-day computation goes through gameDayKey /
 * gameDayIndex / gameDaysUntil with that rule, which is a required argument (and a test bans jstDateKey in
 * daily rules).
 *
 * A rule carries one switch-over: instants before `effectiveAtMs` use `previousHourJst`, instants from it on
 * use `hourJst`. The switch is driven by the clock, not by config delivery: a version carrying a new rule is
 * active at least DAY_ROLLOVER_MIN_LEAD_MS before the rule changes anything (dayRolloverChangeProblems), so
 * every isolate already knows it when the clock passes the switch (REQ-DAY-002). dayRolloverProblems only
 * accepts a switch instant at which the day index neither moves back (a second reset) nor skips a day:
 *   0 → 4 switched at 04:00 JST (shipped): the switch-day game day runs 00:00 → 04:00 next day (28 h);
 *   0 → 4 switched at 00:00 JST: the previous game day runs 00:00 → 04:00 next day (28 h);
 *   0 → 4 switched between 00:00 and 04:00 JST: refused.
 * Calendar computations stay on jstDateKey / jstMonthKey (REQ-DAY-004): seasons (months), season pass end,
 * monthly spend limits, the paid-balance base date, KPI cohort days and season reminder dates.
 */
export interface DayRollover {
  /** JST hour (0..23) the game day rolls over at, from `effectiveAtMs` on. */
  hourJst: number;
  /** JST hour used before `effectiveAtMs` (the rule being replaced). */
  previousHourJst: number;
  /** First instant (Unix ms) of the `hourJst` rule. 0 = always `hourJst`. */
  effectiveAtMs: number;
}
/** A full rule, or a fixed hour (pure helpers and tests). */
export type DayRule = DayRollover | number;

/** 2026-12-01 04:00 JST: the shipped switch from midnight to 04:00 (a 04:00 instant: no reset is added or lost). */
export const DAY_ROLLOVER_SWITCH_AT_MS = Date.UTC(2026, 10, 30, 19);
/** Built-in rule (master/progression.json carries the same value; hand-built test masters fall back to it). */
export const DEFAULT_DAY_ROLLOVER: DayRollover = { hourJst: 4, previousHourJst: 0, effectiveAtMs: DAY_ROLLOVER_SWITCH_AT_MS };
/** REQ-DAY-002: a config version that changes the rule must be active this long before the rule changes anything. */
export const DAY_ROLLOVER_MIN_LEAD_MS = 3_600_000;
/**
 * REQ-DAY-002: how far back a rule change must keep the current rule. Stored day keys are only ever compared
 * with today's key, so only the current and the previous game day matter; older instants (an account's
 * creation day for playerDay) may be re-read under the new rule, which moves them by at most one day.
 */
export const DAY_ROLLOVER_KEEP_PAST_MS = 2 * 24 * 3600 * 1000;

/** The rule in effect for a master (remote config may replace it). */
export function dayRule(m: { progression: { dayRollover?: DayRollover } }): DayRollover {
  const r = m.progression.dayRollover;
  return r ? { hourJst: r.hourJst, previousHourJst: r.previousHourJst, effectiveAtMs: r.effectiveAtMs } : DEFAULT_DAY_ROLLOVER;
}

/** The rollover hour that applies to the instant `ms`. */
export function rolloverHourAt(rule: DayRule, ms: number): number {
  if (typeof rule === 'number') return rule;
  return ms < rule.effectiveAtMs ? rule.previousHourJst : rule.hourJst;
}

/** JST calendar date "YYYY-MM-DD" (calendar uses: accounting base dates, KPI cohorts, season reminders). */
export function jstDateKey(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** REQ-UXS-011: the game day "YYYY-MM-DD" (daily resets happen at the rule's rollover hour, JST). */
export function gameDayKey(ms: number, rule: DayRule): string {
  return new Date(ms + JST_OFFSET_MS - rolloverHourAt(rule, ms) * HOUR_MS).toISOString().slice(0, 10);
}

/** REQ-UXS-011: whole game days since the epoch (difference = game days between two instants). */
export function gameDayIndex(ms: number, rule: DayRule): number {
  return Math.floor((ms + JST_OFFSET_MS - rolloverHourAt(rule, ms) * HOUR_MS) / DAY_MS);
}

/**
 * REQ-UXS-011: game days left until `endMs` (exclusive), counting today: the game day that contains the last
 * instant before `endMs` is day 1. 0 once `endMs` has passed. With a midnight rollover and a midnight end this
 * equals ceil((endMs − now) / DAY_MS) (season pass and offer remaining days).
 */
export function gameDaysUntil(endMs: number, now: number, rule: DayRule): number {
  if (endMs <= now) return 0;
  return gameDayIndex(endMs - 1, rule) - gameDayIndex(now, rule) + 1;
}

/**
 * REQ-DAY-003: a stored game-day key is still "today" when it is today's key or a later one. Daily counters
 * reset only when the day moves forward, so a key written by an isolate that was briefly on another rule
 * (stale config) can never cause a second reset when the correct, earlier key comes back.
 */
export const sameGameDay = (stored: string | null | undefined, today: string): boolean => typeof stored === 'string' && stored >= today;

const isHour = (h: unknown) => typeof h === 'number' && Number.isInteger(h) && h >= 0 && h <= 23;

/** REQ-DAY-001: validation of `progression.dayRollover` (boot and every remote-config version). */
export function dayRolloverProblems(r: unknown, path = 'progression.dayRollover'): string[] {
  if (r === undefined) return [];
  if (!r || typeof r !== 'object' || Array.isArray(r)) return [`${path}: must be an object`];
  const x = r as Partial<DayRollover>;
  const out: string[] = [];
  for (const k of Object.keys(x)) if (!k.startsWith('_') && !['hourJst', 'previousHourJst', 'effectiveAtMs'].includes(k)) out.push(`${path}: unknown key ${k}`);
  if (!isHour(x.hourJst)) out.push(`${path}.hourJst: must be an integer hour 0..23`);
  if (!isHour(x.previousHourJst)) out.push(`${path}.previousHourJst: must be an integer hour 0..23`);
  if (!(typeof x.effectiveAtMs === 'number' && Number.isInteger(x.effectiveAtMs) && x.effectiveAtMs >= 0)) out.push(`${path}.effectiveAtMs: must be a non-negative integer (Unix ms)`);
  if (out.length) return out;
  const rule = x as DayRollover;
  if (rule.effectiveAtMs > 0 && rule.hourJst !== rule.previousHourJst) {
    const before = gameDayIndex(rule.effectiveAtMs - 1, rule);
    const after = gameDayIndex(rule.effectiveAtMs, rule);
    if (after < before) out.push(`${path}.effectiveAtMs: switching from ${rule.previousHourJst}:00 to ${rule.hourJst}:00 JST at this instant moves the game day back (a second daily reset); switch exactly at ${rule.previousHourJst}:00 or ${rule.hourJst}:00 JST, or outside that window`);
    else if (after > before + 1) out.push(`${path}.effectiveAtMs: the switch would skip a game day`);
  }
  return out;
}

/**
 * REQ-DAY-002: a config change activated at `at` may change the day rule only for instants from
 * `at + DAY_ROLLOVER_MIN_LEAD_MS` on, and must keep the current rule back to `at − DAY_ROLLOVER_KEEP_PAST_MS`.
 * Both rules are piecewise constant, so comparing them at every breakpoint inside that window is exact.
 */
export function dayRolloverChangeProblems(prev: DayRollover, next: DayRollover, at: number): string[] {
  const from = at - DAY_ROLLOVER_KEEP_PAST_MS;
  const until = at + DAY_ROLLOVER_MIN_LEAD_MS;
  const points = [from, prev.effectiveAtMs, next.effectiveAtMs].filter((p) => p >= from && p < until);
  if (points.every((p) => rolloverHourAt(prev, p) === rolloverHourAt(next, p))) return [];
  return [`progression.dayRollover: this activation would change the game day before ${new Date(until).toISOString()} (activation + ${DAY_ROLLOVER_MIN_LEAD_MS / 60_000} min) or rewrite the last ${DAY_ROLLOVER_KEEP_PAST_MS / 3_600_000} h; keep the current rule (previousHourJst = the hour in effect now) and schedule the change with an effectiveAtMs at least that far ahead`];
}

/**
 * REQ-GACHA-011: the first instant (ms) of game day `dayKey` ("YYYY-MM-DD"), the inverse of gameDayKey under the same
 * rule: banner and pity-group schedules written as game days open and close exactly at the rollover. Across the
 * shipped 0 → 4 switch the game day 2026-12-01 starts at 12-01 00:00 JST and 2026-12-02 at 12-02 04:00 JST (28 h).
 */
export function gameDayStartMs(dayKey: string, rule: DayRule): number {
  const [y, mo, d] = dayKey.split('-').map(Number) as [number, number, number];
  const base = Date.UTC(y, mo - 1, d) - JST_OFFSET_MS;
  if (typeof rule === 'number') return base + rule * HOUR_MS;
  const before = base + rule.previousHourJst * HOUR_MS; // the start under the rule being replaced
  if (before < rule.effectiveAtMs) return before;
  const after = base + rule.hourJst * HOUR_MS;
  // a later hour after the switch: the day starts at its rollover; an earlier one: the day starts at the switch itself
  return Math.max(after, rule.effectiveAtMs);
}

/** JST month "YYYY-MM" (monthly spend limits). */
export function jstMonthKey(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 7);
}

export function jstYearMonth(ms: number): { year: number; month: number } {
  const d = new Date(ms + JST_OFFSET_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

/** Age in completed years given birth year/month (day unknown → assume birthday at month start). */
export function ageAt(birthYear: number, birthMonth: number, nowMs: number): number {
  const { year, month } = jstYearMonth(nowMs);
  let age = year - birthYear;
  if (month < birthMonth) age -= 1;
  return age;
}

export const DAY_MS = 24 * 3600 * 1000;

/** First instant (ms) of the JST month after `monthKey` ("YYYY-MM") = the end of that month / season. */
export function jstMonthEndMs(monthKey: string): number {
  const [y, mo] = monthKey.split('-').map(Number) as [number, number];
  return Date.UTC(y, mo, 1) - JST_OFFSET_MS;
}

/** JST date key `n` days after `dateKey` ("YYYY-MM-DD"). */
export function addJstDays(dateKey: string, n: number): string {
  const [y, mo, d] = dateKey.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * REQ-WCH-001: the game week. A week starts on weekday `weekStartsOn` (0 = Sunday … 6 = Saturday; Monday by default) at
 * the game-day rollover (progression.dayRollover), so it rolls over exactly when the daily resets do. Its id is the game
 * day key ("YYYY-MM-DD") of its first day. Meant to be shared by every weekly feature (週替わりチャレンジ §31; the
 * weekly rival uses the same definition: the first game day of the week, Monday by default, at the rollover).
 */
export function gameWeekId(ms: number, rule: DayRule, weekStartsOn = 1): string {
  const day = gameDayKey(ms, rule);
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addJstDays(day, -((weekday - weekStartsOn + 7) % 7));
}

/** First instant (ms) of the game week `weekId` (the rollover of its first game day). */
export const gameWeekStartMs = (weekId: string, rule: DayRule): number => gameDayStartMs(weekId, rule);

/** First instant (ms) after the game week `weekId` = the start of the next one. */
export const gameWeekEndMs = (weekId: string, rule: DayRule): number => gameDayStartMs(addJstDays(weekId, 7), rule);

/** Whole weeks from week `fromId` to week `toId` (negative when `toId` is earlier). Both are week ids of the same weekday. */
export function gameWeeksBetween(fromId: string, toId: string): number {
  const d = (k: string) => { const [y, mo, dd] = k.split('-').map(Number) as [number, number, number]; return Date.UTC(y, mo - 1, dd); };
  return Math.round((d(toId) - d(fromId)) / (7 * DAY_MS));
}
