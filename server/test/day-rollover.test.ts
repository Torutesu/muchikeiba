// REQ-DAY-001..006 (REQ-UXS-011): the game day rolls over at 04:00 JST, a validated master / remote-config value,
// switched from midnight with no double reset and no lost day.
import { describe, expect, it } from 'vitest';
import {
  addJstDays, DAY_MS, DAY_ROLLOVER_MIN_LEAD_MS, DAY_ROLLOVER_SWITCH_AT_MS, DEFAULT_DAY_ROLLOVER, dayRolloverProblems, dayRule,
  gameDayIndex, gameDayKey, gameDaysUntil, jstDateKey, sameGameDay, type DayRollover,
} from '../src/domain/time.js';
import type { Master } from '../src/domain/master.js';
import { applyFirstWinBonus, claimLoginBonus, claimMission, missionsView, friendRewardAllowed } from '../src/domain/rewards.js';
import { allowanceView, claimAllowance, grantAllowance } from '../src/domain/shop.js';
import { stableConfig, stableLikeGive } from '../src/domain/stable.js';
import { enqueuePush, registerDevice, setPushPrefs } from '../src/domain/push.js';
import { dailyGoing } from '../src/domain/ground.js';
import { ConfigStore, MemoryConfigRepo, resolveBundle } from '../src/ops/config.js';
import { handle, type AppContext } from '../src/http/app.js';
import { AppError } from '../src/domain/errors.js';
import { freshPlayer, m } from './helpers.js';

const H = 3_600_000;
/** Unix ms of a JST wall-clock time (JST has no DST: always UTC+9). */
const jst = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0) => Date.UTC(y, mo - 1, d, h - 9, mi, s, ms);
const withRule = (rule: DayRollover): Master => ({ ...m, progression: { ...m.progression, dayRollover: rule } });
const code = (f: () => unknown) => { try { f(); return 'ok'; } catch (e) { return (e as AppError).code; } };

describe('REQ-DAY-001 the shipped rule', () => {
  it('master and the built-in default agree: 04:00 JST from 2026-12-01 04:00 JST, midnight before', () => {
    expect(dayRule(m)).toEqual(DEFAULT_DAY_ROLLOVER);
    expect(dayRule(m)).toEqual({ hourJst: 4, previousHourJst: 0, effectiveAtMs: jst(2026, 12, 1, 4) });
    expect(DAY_ROLLOVER_SWITCH_AT_MS).toBe(jst(2026, 12, 1, 4));
    expect(dayRolloverProblems(m.progression.dayRollover)).toEqual([]);
  });

  it('3:59:59.999 JST is still yesterday, 4:00 JST is today (after the switch)', () => {
    const r = dayRule(m);
    expect(gameDayKey(jst(2026, 12, 5, 3, 59, 59, 999), r)).toBe('2026-12-04');
    expect(gameDayKey(jst(2026, 12, 5, 4), r)).toBe('2026-12-05');
    expect(gameDayKey(jst(2026, 12, 5, 0, 30), r)).toBe('2026-12-04');
    expect(gameDayKey(jst(2026, 12, 5, 23, 59), r)).toBe('2026-12-05');
    expect(gameDayIndex(jst(2026, 12, 5, 4), r) - gameDayIndex(jst(2026, 12, 5, 3, 59, 59, 999), r)).toBe(1);
    expect(jstDateKey(jst(2026, 12, 5, 0, 30))).toBe('2026-12-05'); // the calendar date is not the game day
    // before the switch the old midnight rule still applies
    expect(gameDayKey(jst(2026, 11, 20, 23, 59, 59, 999), r)).toBe('2026-11-20');
    expect(gameDayKey(jst(2026, 11, 21, 0), r)).toBe('2026-11-21');
  });

  it('DST-free: every game day of 2027 is exactly 24 h and starts at 04:00 JST (incl. US/EU DST change dates)', () => {
    const r = dayRule(m);
    for (let d = 0; d < 365; d++) {
      const start = jst(2027, 1, 1, 4) + d * DAY_MS;
      expect(gameDayKey(start, r)).toBe(addJstDays('2027-01-01', d));
      expect(gameDayKey(start - 1, r)).toBe(addJstDays('2027-01-01', d - 1));
      expect(gameDayIndex(start + DAY_MS - 1, r)).toBe(gameDayIndex(start, r));
    }
    for (const [mo, d] of [[3, 14], [11, 7], [3, 28], [10, 31]] as const) {
      const key = `2027-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      expect(gameDayKey(jst(2027, mo, d, 3, 59), r)).toBe(addJstDays(key, -1));
      expect(gameDayKey(jst(2027, mo, d, 4), r)).toBe(key);
    }
  });

  it('gameDaysUntil: the season (calendar month, ends 00:00 JST) is "1 day left" on its last game day', () => {
    const r = dayRule(m);
    const end = jst(2027, 1, 1); // the December 2026 season ends at 00:00 JST on Jan 1
    expect(gameDaysUntil(end, jst(2026, 12, 31, 12), r)).toBe(1);
    expect(gameDaysUntil(end, jst(2026, 12, 31, 2), r)).toBe(2); // 02:00 on the 31st is still game day 12-30
    expect(gameDaysUntil(end, jst(2026, 12, 24, 4), r)).toBe(8);
    expect(gameDaysUntil(end, end, r)).toBe(0);
  });
});

describe('REQ-DAY-002 switch day: keys are monotonic and contiguous', () => {
  it('switch at 04:00 JST (shipped): the switch-day game day runs 00:00 → 04:00 next day (28 h)', () => {
    const r = dayRule(m);
    expect(gameDayKey(jst(2026, 11, 30, 23, 30), r)).toBe('2026-11-30');
    expect(gameDayKey(jst(2026, 12, 1, 0, 0), r)).toBe('2026-12-01'); // midnight reset, old rule
    expect(gameDayKey(jst(2026, 12, 1, 3, 59), r)).toBe('2026-12-01');
    expect(gameDayKey(jst(2026, 12, 1, 4, 0), r)).toBe('2026-12-01'); // no second reset at 04:00 on the switch day
    expect(gameDayKey(jst(2026, 12, 2, 0, 30), r)).toBe('2026-12-01'); // no reset at midnight any more
    expect(gameDayKey(jst(2026, 12, 2, 4, 0), r)).toBe('2026-12-02');
  });

  it('switch at 00:00 JST: claimed at 23:30 old day → no second claim at 00:30, next at 04:00', () => {
    const r: DayRollover = { hourJst: 4, previousHourJst: 0, effectiveAtMs: jst(2026, 12, 1, 0) };
    expect(dayRolloverProblems(r)).toEqual([]);
    const mm = withRule(r);
    const s = freshPlayer('p', jst(2026, 11, 20));
    claimLoginBonus(mm, s, jst(2026, 11, 30, 23, 30));
    expect(code(() => claimLoginBonus(mm, s, jst(2026, 12, 1, 0, 30)))).toBe('ALREADY_CLAIMED');
    expect(code(() => claimLoginBonus(mm, s, jst(2026, 12, 1, 3, 59)))).toBe('ALREADY_CLAIMED');
    expect(code(() => claimLoginBonus(mm, s, jst(2026, 12, 1, 4, 0)))).toBe('ok');
  });

  it('refuses a switch instant inside the moved window (the key would go back a day = a double reset)', () => {
    expect(dayRolloverProblems({ hourJst: 4, previousHourJst: 0, effectiveAtMs: jst(2026, 12, 1, 2) }).join()).toMatch(/moves the game day back/);
    expect(dayRolloverProblems({ hourJst: 4, previousHourJst: 0, effectiveAtMs: jst(2026, 12, 1, 0, 1) }).join()).toMatch(/moves the game day back/);
    expect(dayRolloverProblems({ hourJst: 4, previousHourJst: 0, effectiveAtMs: jst(2026, 12, 1, 12) })).toEqual([]);
    // moving back to an earlier hour is safe at any instant (the day only gets shorter, it is never repeated)
    expect(dayRolloverProblems({ hourJst: 0, previousHourJst: 4, effectiveAtMs: jst(2026, 12, 1, 2) })).toEqual([]);
  });

  it('validates hours and the instant', () => {
    expect(dayRolloverProblems({ hourJst: 24, previousHourJst: 0, effectiveAtMs: 0 }).join()).toMatch(/hourJst/);
    expect(dayRolloverProblems({ hourJst: -1, previousHourJst: 0, effectiveAtMs: 0 }).join()).toMatch(/hourJst/);
    expect(dayRolloverProblems({ hourJst: 4.5, previousHourJst: 0, effectiveAtMs: 0 }).join()).toMatch(/hourJst/);
    expect(dayRolloverProblems({ hourJst: 4, previousHourJst: 0, effectiveAtMs: -5 }).join()).toMatch(/effectiveAtMs/);
    expect(dayRolloverProblems({ hourJst: 4, previousHourJst: 0, effectiveAtMs: 0, extra: 1 }).join()).toMatch(/unknown key extra/);
    expect(() => resolveBundle(m, { progression: { dayRollover: { hourJst: 25, previousHourJst: 0, effectiveAtMs: 0 } } })).toThrow(/dayRollover/);
    expect(() => resolveBundle(m, { progression: { dayRollover: { hourJst: 4, previousHourJst: 0, effectiveAtMs: jst(2026, 12, 1, 3) } } })).toThrow(/moves the game day back/);
    expect(() => resolveBundle(m, { progression: { dayRollover: { hourJst: 5, previousHourJst: 4, effectiveAtMs: jst(2027, 2, 1, 5) } } })).not.toThrow();
  });
});

/**
 * Every 15 minutes across the switch, try every daily action. Per game day each one succeeds exactly its cap
 * (no double reset), and the claimed day keys are consecutive (no lost day).
 */
describe('REQ-DAY-002 sweep across the switch: no double reset, no lost day', () => {
  const rules: [string, DayRollover][] = [
    ['shipped 0→4 at 04:00', DEFAULT_DAY_ROLLOVER],
    ['0→4 at 00:00', { hourJst: 4, previousHourJst: 0, effectiveAtMs: jst(2026, 12, 1, 0) }],
    ['0→4 at 12:00', { hourJst: 4, previousHourJst: 0, effectiveAtMs: jst(2026, 12, 1, 12) }],
    ['4→0 at 02:00 (rollback)', { hourJst: 0, previousHourJst: 4, effectiveAtMs: jst(2026, 12, 1, 2) }],
  ];
  for (const [name, rule] of rules) {
    it(name, () => {
      const mm = withRule(rule);
      const from = jst(2026, 11, 27, 6);
      const to = jst(2026, 12, 6, 6);
      const s = freshPlayer('p', from - DAY_MS);
      const allowance = mm.products.find((p) => p.kind === 'allowance')!;
      grantAllowance(mm, s, allowance, 'tx1', from);
      const perDay = new Map<string, Record<string, number>>();
      const bump = (day: string, k: string) => { const r = perDay.get(day) ?? {}; r[k] = (r[k] ?? 0) + 1; perDay.set(day, r); };
      const loginDays: string[] = [];
      const fw = mm.progression.firstWinBonus!;
      const likeCap = stableConfig(mm).likesPerDay;
      const missionId = mm.progression.dailyMissions[0]!.id;
      let n = 0;
      for (let t = from; t < to; t += 15 * 60_000) {
        const day = gameDayKey(t, rule);
        if (code(() => claimLoginBonus(mm, s, t)) === 'ok') { bump(day, 'login'); loginDays.push(day); }
        if (applyFirstWinBonus(mm, s, { mode: 'ranked', place: 1, raceId: `r${n++}` }, t) > 0) bump(day, 'firstWin');
        if (friendRewardAllowed(mm, s, { raceId: `f${n}`, mode: 'friend', place: 1, fieldSize: 2, newRating: null, void: false, humans: 2 }, t)) bump(day, 'friend');
        if (code(() => stableLikeGive(mm, s, `target${n}`, t)) === 'ok') bump(day, 'like');
        if (code(() => claimAllowance(mm, s, t)) === 'ok') bump(day, 'allowance');
        missionsView(mm, s, t);
        s.missions.progress[missionId] = 99;
        if (code(() => claimMission(mm, s, missionId, t)) === 'ok') bump(day, 'mission');
      }
      const days = [...perDay.keys()].sort();
      for (const d of days) {
        expect(perDay.get(d), d).toEqual({ login: 1, firstWin: fw.freeCoinsByWin.length, friend: mm.progression.friendRewardDailyCap, like: likeCap, allowance: 1, mission: 1 });
      }
      for (let i = 1; i < loginDays.length; i++) expect(loginDays[i], `after ${loginDays[i - 1]}`).toBe(addJstDays(loginDays[i - 1]!, 1));
      expect(loginDays[0]).toBe(gameDayKey(from, rule));
      expect(loginDays[loginDays.length - 1]).toBe(gameDayKey(to - 1, rule));
    });
  }
});

describe('REQ-DAY-003 a stored key is never rolled back', () => {
  it('a key written ahead (stale isolate still on midnight) does not cause a second reset', () => {
    const r = dayRule(m);
    const s = freshPlayer('p', jst(2026, 11, 20));
    // a stale isolate (old config, midnight rule) let the player claim at 01:00 on Dec 3 as "12-03"
    s.loginBonus.lastClaimDate = '2026-12-03';
    s.dailyWins = { date: '2026-12-03', count: 3 };
    expect(gameDayKey(jst(2026, 12, 3, 1), r)).toBe('2026-12-02');
    expect(code(() => claimLoginBonus(m, s, jst(2026, 12, 3, 1, 30)))).toBe('ALREADY_CLAIMED');
    expect(applyFirstWinBonus(m, s, { mode: 'ranked', place: 1, raceId: 'x' }, jst(2026, 12, 3, 1, 30))).toBe(0);
    expect(code(() => claimLoginBonus(m, s, jst(2026, 12, 3, 4)))).toBe('ALREADY_CLAIMED'); // 12-03 itself was already claimed
    expect(code(() => claimLoginBonus(m, s, jst(2026, 12, 4, 4)))).toBe('ok');
    expect(sameGameDay('2026-12-03', '2026-12-02')).toBe(true);
    expect(sameGameDay('2026-12-01', '2026-12-02')).toBe(false);
    expect(sameGameDay(null, '2026-12-02')).toBe(false);
  });
});

describe('REQ-DAY-002 remote config: a rule change must be known before it changes anything', () => {
  const later: DayRollover = { hourJst: 5, previousHourJst: 4, effectiveAtMs: jst(2027, 2, 1, 5) };
  it('accepts a change scheduled ≥ 1 h ahead of its effective instant, refuses a late or retroactive one', async () => {
    const store = new ConfigStore(new MemoryConfigRepo(), m);
    const { version } = await store.stage({ progression: { dayRollover: later } }, 'ops', 'move to 05:00', jst(2027, 1, 20));
    const late = new ConfigStore(new MemoryConfigRepo(), m);
    const { version: lateV } = await late.stage({ progression: { dayRollover: later } }, 'ops', 'move to 05:00', jst(2027, 1, 20));
    expect(() => late.schedule(lateV.id, later.effectiveAtMs - DAY_ROLLOVER_MIN_LEAD_MS + 1, 'ops', 'r', jst(2027, 1, 20))).toThrow(/dayRollover/);
    expect(late.schedule(lateV.id, later.effectiveAtMs - DAY_ROLLOVER_MIN_LEAD_MS, 'ops', 'r', jst(2027, 1, 20)).versionId).toBe(lateV.id);
    expect(store.schedule(version.id, jst(2027, 1, 20), 'ops', 'r', jst(2027, 1, 20)).versionId).toBe(version.id);
    // the shipped switch is still ahead: a rule that is 04:00 "always" would change today's day key
    const { version: always } = await store.stage({ progression: { dayRollover: { hourJst: 4, previousHourJst: 4, effectiveAtMs: 0 } } }, 'ops', 'always 4', jst(2026, 11, 10));
    expect(() => store.schedule(always.id, jst(2026, 11, 10), 'ops', 'r', jst(2026, 11, 10))).toThrow(/dayRollover/);
    // …but after the switch it is the same rule for the last two days, so it may be activated
    expect(store.schedule(always.id, jst(2026, 12, 10), 'ops', 'r', jst(2026, 12, 10)).at).toBe(jst(2026, 12, 10));
  });

  it('a rollback that would undo a rule change within the lead time is refused (stage a copy with the current rule)', async () => {
    const store = new ConfigStore(new MemoryConfigRepo(), m);
    const { version } = await store.stage({ progression: { dayRollover: later } }, 'ops', 'move to 05:00', jst(2027, 1, 20));
    store.schedule(version.id, jst(2027, 1, 20), 'ops', 'r', jst(2027, 1, 20));
    expect(() => store.rollback(null, 'ops', 'oops', later.effectiveAtMs - 30 * 60_000)).toThrow(/dayRollover/);
    expect(store.rollback(null, 'ops', 'early', jst(2027, 1, 25)).versionId).toBe('base');
  });
});

describe('QA r9: the daily-pack view uses the claim rule', () => {
  it('a day claimed under a later key (stale isolate) shows as claimed today, as the claim refuses it', () => {
    const s = freshPlayer('p', jst(2026, 12, 1));
    const allowance = m.products.find((p) => p.kind === 'allowance')!;
    grantAllowance(m, s, allowance, 'tx1', jst(2026, 12, 1, 6));
    s.shop!.allowances[0]!.claimed.push('2026-12-03'); // written at 01:00 on 12-03 by an isolate still on midnight
    const at = jst(2026, 12, 3, 1, 30); // game day 12-02 under the 04:00 rule
    expect(code(() => claimAllowance(m, s, at))).toBe('ALREADY_CLAIMED');
    expect(allowanceView(m, s, at)).toMatchObject({ active: true, claimedToday: true });
  });
});

describe('QA r9: a day-rule change keeps every pending activation valid against its new neighbour', () => {
  const six: DayRollover = { hourJst: 6, previousHourJst: 4, effectiveAtMs: jst(2027, 1, 30, 6) };
  const five: DayRollover = { hourJst: 5, previousHourJst: 4, effectiveAtMs: jst(2027, 2, 1, 5) };
  it('inserting a version before a pending one is refused when the pending one would rewrite the inserted rule', async () => {
    const store = new ConfigStore(new MemoryConfigRepo(), m);
    const { version: v5 } = await store.stage({ progression: { dayRollover: five } }, 'ops', '05:00', jst(2027, 1, 20));
    const { version: v6 } = await store.stage({ progression: { dayRollover: six } }, 'ops', '06:00', jst(2027, 1, 20));
    store.schedule(v5.id, jst(2027, 1, 31, 5), 'ops', 'r', jst(2027, 1, 20)); // valid next to base
    // valid against what is active at Jan 25 (base), but then v5 (Jan 31) would undo the 06:00 switch of Jan 30
    expect(() => store.schedule(v6.id, jst(2027, 1, 25), 'ops', 'r', jst(2027, 1, 20))).toThrow(/dayRollover/);
    expect(store.pending(jst(2027, 1, 20)).map((a) => a.versionId)).toEqual([v5.id]);
  });

  it('a rollback or a cancel that leaves a pending activation next to another rule is refused', async () => {
    const store = new ConfigStore(new MemoryConfigRepo(), m);
    const { version: v6 } = await store.stage({ progression: { dayRollover: six } }, 'ops', '06:00', jst(2027, 1, 20));
    const { version: v6b } = await store.stage({ progression: { dayRollover: six }, ng: { exact: ['x'], contains: [] } }, 'ops', '06:00 + ng', jst(2027, 1, 20));
    store.schedule(v6.id, jst(2027, 1, 25), 'ops', 'r', jst(2027, 1, 20));
    const pend = store.schedule(v6b.id, jst(2027, 1, 31, 5), 'ops', 'r', jst(2027, 1, 20));
    // rolling back to base now: base would sit between v6 and v6b, so v6b would bring the 06:00 rule back with a past switch
    expect(() => store.rollback('base', 'ops', 'r', jst(2027, 1, 26))).toThrow(/dayRollover/);
    // cancelling v6 (still pending at Jan 21) leaves v6b next to base: same problem
    expect(() => store.cancel(store.pending(jst(2027, 1, 21))[0]!.id, jst(2027, 1, 21))).toThrow(/dayRollover/);
    // cancelling the later one is fine
    expect(store.cancel(pend.id, jst(2027, 1, 21)).cancelled).toBe(true);
  });
});

describe('REQ-DAY-005 push and the day\'s going follow the game day', () => {
  it('the push daily cap resets at 04:00 JST', () => {
    const s = freshPlayer('p', jst(2026, 12, 1));
    registerDevice(m, s, 'token-0001', 'android', jst(2026, 12, 1));
    setPushPrefs(m, s, { quietHours: null });
    const cap = m.push.defaults.dailyCap;
    for (let i = 0; i < cap; i++) expect(enqueuePush(m, s, 'friend_request', { name: 'a' }, jst(2026, 12, 5, 1, i)).status).toBe('queued');
    expect(enqueuePush(m, s, 'friend_request', { name: 'a' }, jst(2026, 12, 5, 3, 59))).toEqual({ status: 'skipped', reason: 'daily_cap' });
    expect(enqueuePush(m, s, 'friend_request', { name: 'a' }, jst(2026, 12, 5, 4)).status).toBe('queued');
  });

  it('the day\'s going is the same from 04:00 to 03:59 and may change at 04:00', () => {
    const r = dayRule(m);
    const w = m.progression.weather;
    for (const t of m.tracks) {
      expect(dailyGoing(w, t, jst(2026, 12, 6, 3, 59), r)).toBe(dailyGoing(w, t, jst(2026, 12, 5, 4), r));
      expect(dailyGoing(w, t, jst(2026, 12, 6, 0, 30), r)).toBe(dailyGoing(w, t, jst(2026, 12, 5, 23), r));
    }
  });
});

describe('REQ-DAY-006 the client gets the rule from GET /v1/config', () => {
  it('returns dayRollover', async () => {
    const res = await handle(new Request('https://x/v1/config'), {}, { master: m } as AppContext);
    expect(((await res.json()) as { dayRollover: unknown }).dayRollover).toEqual(DEFAULT_DAY_ROLLOVER);
  });
});
