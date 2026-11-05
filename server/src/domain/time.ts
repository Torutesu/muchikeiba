/** Injectable clock. */
export type Clock = () => number;
export const systemClock: Clock = () => Date.now();

const JST_OFFSET_MS = 9 * 3600 * 1000;

/** JST calendar date "YYYY-MM-DD" (daily resets happen at JST midnight). */
export function jstDateKey(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
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
