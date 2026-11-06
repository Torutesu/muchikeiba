/** Injectable clock. */
export type Clock = () => number;
export const systemClock: Clock = () => Date.now();

const JST_OFFSET_MS = 9 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;

/**
 * REQ-UXS-011: the JST hour at which the game day rolls over (login bonus, daily missions, care, breeding,
 * time attack attempts, friend reward cap, stud lending, push daily cap, the day's going). The single place
 * to change it: every game-day computation goes through gameDayKey / gameDayIndex (enforced by a test).
 * 0 = midnight (current behaviour). The UX spec proposes 4 (04:00 JST); switching is a one-line change here
 * plus re-checking the cron times in scheduled.ts, which are clock times and do not move with it.
 * Calendar computations stay on jstDateKey / jstMonthKey: seasons (months), monthly spend limits, the
 * paid-balance base date, KPI cohort days and season reminder dates.
 */
export const DAY_ROLLOVER_HOUR_JST = 0;

/** JST calendar date "YYYY-MM-DD" (calendar uses: accounting base dates, KPI cohorts, season reminders). */
export function jstDateKey(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** REQ-UXS-011: the game day "YYYY-MM-DD" (daily resets happen at DAY_ROLLOVER_HOUR_JST, JST). */
export function gameDayKey(ms: number, rolloverHour: number = DAY_ROLLOVER_HOUR_JST): string {
  return new Date(ms + JST_OFFSET_MS - rolloverHour * HOUR_MS).toISOString().slice(0, 10);
}

/** REQ-UXS-011: whole game days since the epoch (difference = game days between two instants). */
export function gameDayIndex(ms: number, rolloverHour: number = DAY_ROLLOVER_HOUR_JST): number {
  return Math.floor((ms + JST_OFFSET_MS - rolloverHour * HOUR_MS) / DAY_MS);
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
