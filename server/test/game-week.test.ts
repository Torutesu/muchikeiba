import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { dayRule, gameWeekEndMs, gameWeekId, gameWeekStartMs } from '../src/domain/time.js';
import { weekEndMs as rivalWeekEndMs, weekIdAt as rivalWeekId } from '../src/domain/rival.js';
import { weekEndMs as goalWeekEndMs, weekKeyOf as goalWeekKey, weekStartMs as goalWeekStartMs } from '../src/domain/teamGoal.js';
import { weekAt as challengeWeekAt, weeklyChallengeConfig } from '../src/domain/weeklyChallenge.js';
import { uxProblems, weekStartProblems } from '../src/domain/onboarding.js';

/**
 * Round 13 integration: the three weekly features (ライバル §28, 週替わりチャレンジ §31, 支部の共同目標 §32) share one game week
 * (time.ts gameWeekId: Monday at the game-day rollover, progression.dayRollover). Around a Monday rollover they must all
 * still be on the old week at 03:59 JST and all on the new one at 04:00 JST.
 */
const jst = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h - 9, mi);

describe('one game week for rival, weekly challenge and team goal', () => {
  const rule = dayRule(m);
  const wch = weeklyChallengeConfig(m)!;
  const cases: [string, number, string][] = [
    ['Monday 03:59 JST (still Sunday\'s game day)', jst(2026, 12, 14, 3, 59), '2026-12-07'],
    ['Monday 04:00 JST (the rollover)', jst(2026, 12, 14, 4, 0), '2026-12-14'],
    ['Sunday 23:59 JST', jst(2026, 12, 13, 23, 59), '2026-12-07'],
    ['Monday 04:01 JST', jst(2026, 12, 14, 4, 1), '2026-12-14'],
  ];
  for (const [name, at, week] of cases) {
    it(name, () => {
      expect(gameWeekId(at, rule)).toBe(week);
      expect(rivalWeekId(m, at)).toBe(week);
      expect(goalWeekKey(at, rule)).toBe(week);
      expect(wch.weekStartsOn).toBe(1);
      expect(challengeWeekAt(m, wch, at).weekId).toBe(week);
    });
  }

  it('the week ends at the same instant everywhere (the next Monday 04:00 JST)', () => {
    const week = '2026-12-07';
    const end = jst(2026, 12, 14, 4, 0);
    expect(gameWeekEndMs(week, rule)).toBe(end);
    expect(rivalWeekEndMs(m, week)).toBe(end);
    expect(goalWeekEndMs(week, rule)).toBe(end);
    expect(challengeWeekAt(m, wch, end - 1).endsAt).toBe(end);
    expect(gameWeekStartMs(week, rule)).toBe(jst(2026, 12, 7, 4, 0));
    expect(goalWeekStartMs(week, rule)).toBe(jst(2026, 12, 7, 4, 0));
    expect(challengeWeekAt(m, wch, end).startsAt).toBe(end);
  });

  it('across the shipped 0:00 → 4:00 switch (2026-12-01 04:00 JST) all three agree on every hour of two weeks', () => {
    for (let t = jst(2026, 11, 23, 0); t < jst(2026, 12, 9, 0); t += 30 * 60_000) {
      const w = gameWeekId(t, rule);
      expect(rivalWeekId(m, t)).toBe(w);
      expect(goalWeekKey(t, rule)).toBe(w);
      expect(challengeWeekAt(m, wch, t).weekId).toBe(w);
    }
  });

  it('boot / remote config refuses a rival or weekly challenge week that starts on another weekday', () => {
    expect(weekStartProblems(m)).toEqual([]);
    const bad = structuredClone(m.progression) as typeof m.progression & { rival: { weekStartsOn: number }; weeklyChallenge: { weekStartsOn: number } };
    bad.rival.weekStartsOn = 0;
    bad.weeklyChallenge.weekStartsOn = 3;
    const p = weekStartProblems({ progression: bad });
    expect(p).toHaveLength(2);
    expect(p.join('\n')).toMatch(/progression\.rival\.weekStartsOn[\s\S]*progression\.weeklyChallenge\.weekStartsOn/);
    expect(uxProblems({ ...m, progression: bad }, new Set(Object.keys(m.items.tickets)))).toEqual(expect.arrayContaining(p));
  });
});

