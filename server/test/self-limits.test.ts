// 使いすぎ・遊びすぎの防止 (REQ-LIMIT-001..022, contracts/protocol.md §67).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import { clientBatchSchema, clientToKpi, type ClientEvent } from '../src/domain/kpi.js';
import { KPI_ESSENTIAL, kpiClassOf } from '../src/domain/kpiConsent.js';
import { endpointGroup, isExempt, LEGAL_WORDS_JA } from '../src/domain/maintenance.js';
import { buildExportDocument, classifyKey } from '../src/domain/dataExport.js';
import { coinShortfall } from '../src/domain/shortfall.js';
import { historySummary } from '../src/domain/history.js';
import { bettingWordsIn } from '../src/domain/bettingWords.js';
import { adminRoutes } from '../src/http/admin.js';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import {
  DEFAULT_SELF_LIMITS, decidePlaytimeReminder, playtimeDay, selfLimitsProblems, selfLimitsTextsEn, selfLimitsTextsJa,
  type PlaytimeSnapshot,
} from '../src/domain/selfLimits.js';
import type { Master } from '../src/domain/master.js';
import type { PlayerState } from '../src/domain/player.js';

const JST = 9 * 3600_000;
const HOUR = 3_600_000;
const jst = (y: number, mo: number, d: number, h = 12, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - JST;
const VECTORS_PATH = join(__dirname, '..', '..', 'contracts', 'self-limits.vectors.json');

function world(master: Master = m) {
  let now = jst(2026, 11, 10);
  const kpi: KpiRecord[] = [];
  const store = new FakeStoreVerifier();
  const repo = new MemoryPlayerRepo();
  const svc = new PlayerService(repo, { master, rng: seededRng(5), clock: () => now, verifiers: { fake: store }, onKpi: (_id, recs) => { kpi.push(...recs); } });
  let tx = 0;
  const price = (productId: string) => master.products.find((x) => x.id === productId)!.priceYen;
  /** A store purchase whose receipt arrives (with or without the intent check first). */
  const receipt = (id: string, productId: string) => svc.purchase(id, 'fake', productId, store.issue({ transactionId: `T${tx++}`, productId, purchasedAt: now, priceYen: price(productId) }));
  const buy = async (id: string, productId: string) => { await svc.purchaseIntent(id, productId); return receipt(id, productId); };
  return { svc, kpi, buy, receipt, repo, advance: (ms: number) => { now += ms; }, set: (ms: number) => { now = ms; }, now: () => now };
}
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as AppError).code; } return 'NO_ERROR'; };
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as AppError; } throw new Error('no error'); };
const adult = async (w: ReturnType<typeof world>, id = 'p') => { await w.svc.bootstrap(id); await w.svc.setAge(id, 1990, 1, false); };
const under16 = async (w: ReturnType<typeof world>, id = 'p') => { await w.svc.bootstrap(id); await w.svc.setAge(id, 2015, 1, true); };

describe('REQ-LIMIT-019 config', () => {
  it('the shipped section is valid; absent = the defaults (no kill switch)', () => {
    expect(selfLimitsProblems(m)).toEqual([]);
    expect((m.progression as { selfLimits?: unknown }).selfLimits).toBeDefined();
    const none = { ...m, progression: { ...m.progression, selfLimits: undefined } } as Master;
    expect(selfLimitsProblems(none)).toEqual([]);
  });
  it('rejects bad sections', () => {
    const bad = (x: Record<string, unknown>) => selfLimitsProblems({ progression: { ...m.progression, selfLimits: { ...DEFAULT_SELF_LIMITS, ...x } } } as Master).join(' | ');
    expect(bad({ coolOffHours: 1 })).toMatch(/coolOffHours/);
    expect(bad({ coolOffHours: 500 })).toMatch(/coolOffHours/);
    expect(bad({ spendingChoicesYen: [3000, 1000] })).toMatch(/ascending/);
    expect(bad({ spendingChoicesYen: [1050] })).toMatch(/multiples/);
    expect(bad({ enabled: false })).toMatch(/enabled|Unrecognized|unrecognized/);
    expect(bad({ playtime: { ...DEFAULT_SELF_LIMITS.playtime, quietAfterChoicesHour: [24] } })).toMatch(/quietAfterChoicesHour/);
    expect(bad({ customMinYen: 5000, customMaxYen: 1000 })).toMatch(/customMinYen/);
  });
});

describe('REQ-LIMIT-001..004 the own monthly limit', () => {
  it('never chosen: read-only view, nothing created; bootstrap carries the digest', async () => {
    const w = world();
    const boot = await w.svc.bootstrap('p');
    expect((boot as unknown as { selfLimits: unknown }).selfLimits).toEqual({
      playtime: { sessionMin: null, dailyMin: null, quietAfterHour: null, enabled: false },
      spending: { limitYen: null, effectiveLimitYen: null, pending: null },
    });
    const v = await w.svc.selfLimits('p');
    expect(v.spending).toMatchObject({ limitYen: null, ageLimitYen: null, effectiveLimitYen: null, binding: 'none', pending: null, choicesYen: [1000, 3000, 5000, 10000, 30000], coolOffHours: 72 });
    expect((await w.svc.state('p')).selfLimits).toBeUndefined();
    // removing a limit that never existed changes nothing and writes nothing
    expect((await w.svc.setSpendingLimit('p', null)).applied).toBe('unchanged');
    expect((await w.svc.state('p')).selfLimits).toBeUndefined();
  });
  it('lowering applies at once; raising waits 72 h; the view shows the pending change and its text', async () => {
    const w = world();
    await adult(w);
    expect((await w.svc.setSpendingLimit('p', 5000)).applied).toBe('now');
    expect((await w.svc.setSpendingLimit('p', 3000)).applied).toBe('now');
    let r = await w.svc.setSpendingLimit('p', 10000);
    expect(r.applied).toBe('pending');
    expect(r.view.spending).toMatchObject({ limitYen: 3000, effectiveLimitYen: 3000, binding: 'self', pending: { limitYen: 10000, effectiveAt: w.now() + 72 * HOUR } });
    expect(r.view.spending.pendingText).toBe('¥10,000への変更は 11/13 12:00 から効きます（取り消せます）');
    expect(r.view.spending.statusText).toBe('自分で決めた上限 ¥3,000（今月の残り ¥3,000）');
    w.advance(72 * HOUR - 1);
    expect((await w.svc.selfLimits('p')).spending.limitYen).toBe(3000);
    w.advance(1);
    const v = await w.svc.selfLimits('p');
    expect(v.spending).toMatchObject({ limitYen: 10000, pending: null });
    expect(v.history[0]).toMatchObject({ kind: 'raise_applied', fromYen: 3000, toYen: 10000 });
    // the next change writes the matured raise into the state first
    r = await w.svc.setSpendingLimit('p', 5000);
    expect(r.applied).toBe('now');
    expect(r.view.history.slice(0, 2).map((h) => h.kind)).toEqual(['set', 'raise_applied']);
    expect((await w.svc.state('p')).selfLimits!.history.filter((h) => h.kind === 'raise_applied')).toHaveLength(1);
  });
  it('removing waits too; a cancel keeps the limit; a lower amount while waiting replaces the raise', async () => {
    const w = world();
    await adult(w);
    await w.svc.setSpendingLimit('p', 3000);
    expect((await w.svc.setSpendingLimit('p', null)).view.spending.pendingText).toBe('上限なしへの変更は 11/13 12:00 から効きます（取り消せます）');
    const c = await w.svc.cancelSpendingRaise('p');
    expect(c.applied).toBe('cancelled');
    expect(c.view.spending).toMatchObject({ limitYen: 3000, pending: null });
    expect((await w.svc.cancelSpendingRaise('p')).applied).toBe('unchanged');
    await w.svc.setSpendingLimit('p', 10000);
    const low = await w.svc.setSpendingLimit('p', 1000);
    expect(low.applied).toBe('now');
    expect(low.view.spending).toMatchObject({ limitYen: 1000, pending: null });
    w.advance(80 * HOUR);
    expect((await w.svc.selfLimits('p')).spending.limitYen).toBe(1000);
  });
  it('the same raise again keeps its clock (idempotent); a different raise starts the clock again; saving the current amount cancels', async () => {
    const w = world();
    await adult(w);
    await w.svc.setSpendingLimit('p', 3000);
    const t0 = w.now();
    await w.svc.setSpendingLimit('p', 10000);
    w.advance(10 * HOUR);
    const again = await w.svc.setSpendingLimit('p', 10000);
    expect(again.view.spending.pending!.effectiveAt).toBe(t0 + 72 * HOUR);
    const other = await w.svc.setSpendingLimit('p', 30000);
    expect(other.view.spending.pending).toMatchObject({ limitYen: 30000, effectiveAt: w.now() + 72 * HOUR });
    const same = await w.svc.setSpendingLimit('p', 3000);
    expect(same.applied).toBe('cancelled');
    expect(same.view.spending.pending).toBeNull();
    expect((await w.svc.setSpendingLimit('p', 3000)).applied).toBe('unchanged');
  });
  it('custom amounts on the step; never above the age cap; choices filtered by the age cap', async () => {
    const w = world();
    await under16(w);
    const v = await w.svc.selfLimits('p');
    expect(v.spending).toMatchObject({ ageLimitYen: 5000, ageBand: 'under16', effectiveLimitYen: 5000, binding: 'age', choicesYen: [1000, 3000, 5000], custom: { minYen: 100, maxYen: 5000, stepYen: 100 } });
    expect(await code(w.svc.setSpendingLimit('p', 10000))).toBe('BAD_REQUEST');
    expect(await code(w.svc.setSpendingLimit('p', 2550))).toBe('BAD_REQUEST');
    expect(await code(w.svc.setSpendingLimit('p', 50))).toBe('BAD_REQUEST');
    expect((await w.svc.setSpendingLimit('p', 2500)).view.spending).toMatchObject({ limitYen: 2500, effectiveLimitYen: 2500, binding: 'self' });
    expect((await w.svc.setSpendingLimit('p', 5000)).applied).toBe('pending'); // equal to the age cap is allowed (a raise)
  });
  it('can be set before the age is registered; the lower cap applies once it is', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    expect((await w.svc.setSpendingLimit('p', 10000)).applied).toBe('now');
    await w.svc.setAge('p', 2015, 1, true);
    expect((await w.svc.selfLimits('p')).spending).toMatchObject({ limitYen: 10000, ageLimitYen: 5000, effectiveLimitYen: 5000, binding: 'age' });
  });
  it('JST calendar month (not the 4:00 game day): the month resets at 00:00 JST on the 1st', async () => {
    const w = world();
    await adult(w);
    await w.svc.setSpendingLimit('p', 1000);
    w.set(jst(2026, 11, 30, 23, 59));
    await w.buy('p', 'coin_800');
    expect(await code(w.svc.purchaseIntent('p', 'coin_480'))).toBe('SELF_LIMIT_EXCEEDED');
    w.set(jst(2026, 12, 1, 0, 1));
    expect(await code(w.svc.purchaseIntent('p', 'coin_480'))).toBe('NO_ERROR');
  });
});

describe('REQ-LIMIT-005..007 every purchase path', () => {
  it('the confirmation refuses with SELF_LIMIT_EXCEEDED and details; lower than the age cap only', async () => {
    const w = world();
    await adult(w);
    await w.svc.setSpendingLimit('p', 3000);
    await w.buy('p', 'coin_2400');
    const e = await err(w.svc.purchaseIntent('p', 'coin_800'));
    expect(e.code).toBe('SELF_LIMIT_EXCEEDED');
    expect(e.status).toBe(409);
    expect(e.details).toEqual({ selfLimitYen: 3000, monthSpentYen: 2400, priceYen: 800, month: '2026-11', settings: 'self_limits' });
    // within the limit: the confirmation carries the own limit next to the age cap
    const ok = await w.svc.purchaseIntent('p', 'coin_480');
    expect(ok).toMatchObject({ monthlyLimitYen: null, selfLimitYen: 3000, effectiveLimitYen: 3000, selfLimitBinding: true, selfLimitPending: null });
    // equal to the age cap → the age code (changing the own limit would not help)
    const u = world();
    await under16(u);
    await u.svc.setSpendingLimit('p', 5000);
    await u.buy('p', 'coin_5000');
    expect(await code(u.svc.purchaseIntent('p', 'coin_160'))).toBe('AGE_LIMIT_EXCEEDED');
  });
  it('a lowered limit applies to the next confirmation at once; a pending raise does not until it matures', async () => {
    const w = world();
    await adult(w);
    await w.buy('p', 'coin_1500');
    await w.svc.setSpendingLimit('p', 1500);
    expect(await code(w.svc.purchaseIntent('p', 'coin_160'))).toBe('SELF_LIMIT_EXCEEDED');
    await w.svc.setSpendingLimit('p', 5000);
    expect(await code(w.svc.purchaseIntent('p', 'coin_160'))).toBe('SELF_LIMIT_EXCEEDED');
    expect((await w.svc.purchaseIntent('p', 'coin_160').catch(() => null))).toBeNull();
    w.advance(72 * HOUR);
    expect(await code(w.svc.purchaseIntent('p', 'coin_160'))).toBe('NO_ERROR');
  });
  it('§29 shortfall never offers a pack over the own limit; none buyable names SELF_LIMIT_EXCEEDED', async () => {
    const w = world();
    await adult(w);
    await w.svc.setSpendingLimit('p', 1000);
    const s = await w.svc.state('p');
    const r = coinShortfall(m, s, { coinKind: 'any', need: s.wallet.paid + s.wallet.free + 2000 }, w.now());
    expect(r.offer === null || r.offer.priceYen <= 1000).toBe(true);
    expect(r.status).toBe('largest_only');
    expect(r.offer!.productId).toBe('coin_800');
    await w.buy('p', 'coin_800');
    await w.buy('p', 'coin_160'); // ¥960 of ¥1,000: nothing fits any more
    const s2 = await w.svc.state('p');
    const r2 = coinShortfall(m, s2, { coinKind: 'any', need: s2.wallet.paid + s2.wallet.free + 500 }, w.now());
    expect(r2).toMatchObject({ status: 'none_buyable', blockedCode: 'SELF_LIMIT_EXCEEDED', offer: null, line: '自分で決めた今月の上限に達しているため、いま購入できるパックはありません' });
    // every candidate refused for a pack over the limit: the offer is never above it whatever the shortfall
    for (const need of [10, 100, 500, 1000, 5000, 50_000]) {
      const x = coinShortfall(m, s, { coinKind: 'paid', need: s.wallet.paid + need }, w.now());
      expect(x.offer === null || x.offer.priceYen <= 1000, `need ${need}`).toBe(true);
    }
  });
  it('§13.3 one-time offers over the own limit are not popped up (still listed)', async () => {
    const w = world();
    await adult(w);
    const st = await w.svc.state('p');
    st.rating.rankedRaces = 10; // past the starter / pass triggers
    await w.repo.put(st);
    let offers = (await w.svc.shopOffers('p')).offers;
    const pass = offers.find((o) => o.productId === 'season_pass')!;
    expect(pass).toMatchObject({ selfLimitBlocked: false });
    await w.svc.setSpendingLimit('p', 300);
    offers = (await w.svc.shopOffers('p')).offers;
    for (const o of offers) {
      const price = m.products.find((p) => p.id === o.productId)!.priceYen;
      if (price > 300) expect(o, o.id).toMatchObject({ selfLimitBlocked: true, showPopup: false });
    }
    expect(offers.find((o) => o.productId === 'season_pass')).toBeDefined();
  });
  it('a store receipt over the limit is granted and counted (selfLimitBreach); later confirmations refuse', async () => {
    const w = world();
    await adult(w);
    await w.svc.purchaseIntent('p', 'coin_1500'); // passes now
    await w.svc.setSpendingLimit('p', 1000); // lowered before the store finished
    const before = (await w.svc.state('p')).wallet.paid;
    const r = await w.receipt('p', 'coin_1500');
    expect(r.record).toMatchObject({ selfLimitBreach: true, limitBreach: false, paidCoinsGranted: 1020 });
    const s = await w.svc.state('p');
    expect(s.wallet.paid).toBe(before + 1020);
    expect(s.monthlySpendYen['2026-11']).toBe(1500);
    expect(s.supportFlags ?? []).not.toContain(expect.stringMatching(/monthly_limit_breach/));
    expect(await code(w.svc.purchaseIntent('p', 'coin_160'))).toBe('SELF_LIMIT_EXCEEDED');
    // within the limit: no flag
    const w2 = world();
    await adult(w2);
    await w2.svc.setSpendingLimit('p', 1000);
    expect((await w2.buy('p', 'coin_480')).record.selfLimitBreach).toBeUndefined();
  });
  it('§33 history shows the own limit next to the age cap', async () => {
    const w = world();
    await under16(w);
    await w.svc.setSpendingLimit('p', 3000);
    await w.buy('p', 'coin_800');
    await w.svc.setSpendingLimit('p', null);
    const h = historySummary(m, await w.svc.state('p'), w.now());
    expect(h).toMatchObject({
      monthlyLimitYen: 5000, limitText: '今月の購入 ¥800 ／ 上限 ¥5,000（年齢に応じた月額上限）',
      selfLimitYen: 3000, effectiveLimitYen: 3000, selfRemainingYen: 2200, selfLimitText: '自分で決めた上限 ¥3,000（今月の残り ¥2,200）',
      selfLimitPending: { limitYen: null },
    });
    const none = historySummary(m, (await (async () => { const x = world(); await adult(x); return x.svc.state('p'); })()), w.now());
    expect(none).toMatchObject({ selfLimitYen: null, selfLimitText: null, effectiveLimitYen: null });
  });
});

describe('REQ-LIMIT-009 play-time settings', () => {
  it('values from the choices or null; missing keys kept; the digest follows', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    expect(await code(w.svc.setPlaytime('p', { sessionMin: 45 }))).toBe('BAD_REQUEST');
    expect(await code(w.svc.setPlaytime('p', { quietAfterHour: 25 }))).toBe('BAD_REQUEST');
    let r = await w.svc.setPlaytime('p', { sessionMin: 60, quietAfterHour: 22 });
    expect(r.changed).toEqual(['sessionMin', 'quietAfterHour']);
    expect(r.view.playtime).toMatchObject({ sessionMin: 60, dailyMin: null, quietAfterHour: 22, enabled: true });
    r = await w.svc.setPlaytime('p', { dailyMin: 120 });
    expect(r.view.playtime).toMatchObject({ sessionMin: 60, dailyMin: 120, quietAfterHour: 22 });
    expect((await w.svc.setPlaytime('p', { dailyMin: 120 })).changed).toEqual([]);
    expect(((await w.svc.view('p')) as unknown as { selfLimits: { playtime: unknown } }).selfLimits.playtime).toEqual({ sessionMin: 60, dailyMin: 120, quietAfterHour: 22, enabled: true });
    r = await w.svc.setPlaytime('p', { sessionMin: null, dailyMin: null, quietAfterHour: null });
    expect(r.view.playtime.enabled).toBe(false);
    expect(w.kpi.filter((k) => k.name === 'playtime_setting_change').map((k) => [k.s1, k.s2])).toEqual([['session,quiet_after', 'on'], ['daily', 'on'], ['session,daily,quiet_after', 'off']]);
  });
});

describe('REQ-LIMIT-011 decidePlaytimeReminder', () => {
  const base = (x: Partial<PlaytimeSnapshot> = {}): PlaytimeSnapshot => ({
    now: jst(2026, 11, 10, 20), localOffsetMin: 540, locale: 'ja', settings: { sessionMin: 60, dailyMin: null, quietAfterHour: null },
    sessionPlayedMin: 0, dayPlayedMin: 0, marks: { sessionMark: null, dayKey: null, dailyShown: false, quietShown: false }, place: 'race_result', ...x,
  });
  it('off by default; session marks every sessionMin; never mid-race (kept for the next safe point)', () => {
    expect(decidePlaytimeReminder(base({ settings: { sessionMin: null, dailyMin: null, quietAfterHour: null }, sessionPlayedMin: 500 }))).toMatchObject({ show: false, blockedBy: 'off' });
    expect(decidePlaytimeReminder(base({ sessionPlayedMin: 59 }))).toMatchObject({ show: false, blockedBy: 'not_due' });
    const race = decidePlaytimeReminder(base({ sessionPlayedMin: 61, place: 'race' }));
    expect(race).toMatchObject({ show: false, blockedBy: 'not_safe', reasons: ['session'] });
    for (const place of ['matchmaking', 'purchase', 'tutorial', 'other'] as const) expect(decidePlaytimeReminder(base({ sessionPlayedMin: 61, place })).show).toBe(false);
    const d = decidePlaytimeReminder(base({ sessionPlayedMin: 61 }));
    expect(d).toMatchObject({ show: true, reasons: ['session'], title: 'ひと息つきませんか', lines: ['遊びはじめて60分たちました'], buttons: { continue: '続ける', stop: '今日はここまで' } });
    expect(d.marks.sessionMark).toBe(60);
    expect(decidePlaytimeReminder(base({ sessionPlayedMin: 100, marks: d.marks })).show).toBe(false);
    expect(decidePlaytimeReminder(base({ sessionPlayedMin: 125, marks: d.marks }))).toMatchObject({ show: true, lines: ['遊びはじめて120分たちました'] });
  });
  it('daily once a device day (4:00 roll-over); quiet-after once a day from the hour until 4:00; one sheet in order', () => {
    const s = { sessionMin: 30, dailyMin: 120, quietAfterHour: 22 };
    const late = jst(2026, 11, 10, 22, 30);
    const d = decidePlaytimeReminder(base({ now: late, settings: s, sessionPlayedMin: 31, dayPlayedMin: 125 }));
    expect(d).toMatchObject({ show: true, reasons: ['quiet_after', 'daily', 'session'], lines: ['22時を過ぎました', '今日は合計125分遊びました', '遊びはじめて30分たちました'] });
    expect(d.marks).toMatchObject({ dayKey: '2026-11-10', dailyShown: true, quietShown: true });
    // 1:00 the next calendar day is still the same device day
    const night = decidePlaytimeReminder(base({ now: jst(2026, 11, 11, 1), settings: s, sessionPlayedMin: 40, dayPlayedMin: 200, marks: d.marks }));
    expect(night).toMatchObject({ show: false, blockedBy: 'not_due' });
    // after 4:00 a new day: daily again once played enough; quiet-after not before 22:00
    const morning = decidePlaytimeReminder(base({ now: jst(2026, 11, 11, 9), settings: s, sessionPlayedMin: 5, dayPlayedMin: 130, marks: d.marks }));
    expect(morning).toMatchObject({ show: true, reasons: ['daily'] });
    expect(playtimeDay(jst(2026, 11, 11, 3, 59), 540).dayKey).toBe('2026-11-10');
    expect(playtimeDay(jst(2026, 11, 11, 4), 540).dayKey).toBe('2026-11-11');
    // midnight choice: 0:00..3:59 only
    expect(decidePlaytimeReminder(base({ now: jst(2026, 11, 10, 23), settings: { sessionMin: null, dailyMin: null, quietAfterHour: 0 } })).show).toBe(false);
    expect(decidePlaytimeReminder(base({ now: jst(2026, 11, 11, 0, 5), settings: { sessionMin: null, dailyMin: null, quietAfterHour: 0 } })).show).toBe(true);
    // a device on another time zone uses its own clock
    expect(decidePlaytimeReminder(base({ now: Date.UTC(2026, 10, 10, 22, 30), localOffsetMin: 0, settings: { sessionMin: null, dailyMin: null, quietAfterHour: 22 } })).show).toBe(true);
  });
  it('English', () => {
    const d = decidePlaytimeReminder(base({ locale: 'en', now: jst(2026, 11, 10, 23), settings: { sessionMin: 30, dailyMin: 60, quietAfterHour: 22 }, sessionPlayedMin: 30, dayPlayedMin: 60 }));
    expect(d).toMatchObject({ title: 'Time for a short break?', lines: ['It is past 10 p.m.', 'You have played 60 minutes in total today', 'You have been playing for 30 minutes'], buttons: { continue: 'Continue', stop: 'Done for today' } });
  });
});

describe('§67 shared vectors (TS ↔ C# PlaytimeReminderPolicy)', () => {
  it('matches contracts/self-limits.vectors.json', () => {
    const v = vectors();
    if (process.env.UPDATE_VECTORS === '1') writeFileSync(VECTORS_PATH, JSON.stringify(v, null, 2) + '\n');
    expect(JSON.parse(readFileSync(VECTORS_PATH, 'utf8'))).toEqual(v);
  });
});

function vectors() {
  const marks0 = { sessionMark: null, dayKey: null, dailyShown: false, quietShown: false };
  const all = { sessionMin: 30, dailyMin: 120, quietAfterHour: 22 };
  const cases: [string, PlaytimeSnapshot][] = [];
  const add = (name: string, x: Partial<PlaytimeSnapshot>) => cases.push([name, {
    now: jst(2026, 11, 10, 20), localOffsetMin: 540, locale: 'ja', settings: { sessionMin: 60, dailyMin: null, quietAfterHour: null },
    sessionPlayedMin: 0, dayPlayedMin: 0, marks: marks0, place: 'race_result', ...x,
  }]);
  add('off', { settings: { sessionMin: null, dailyMin: null, quietAfterHour: null }, sessionPlayedMin: 300 });
  add('session not due', { sessionPlayedMin: 59 });
  add('session due at result', { sessionPlayedMin: 60 });
  add('session due at home, en', { sessionPlayedMin: 75, place: 'home', locale: 'en' });
  add('session due mid race', { sessionPlayedMin: 75, place: 'race' });
  add('session due in matchmaking', { sessionPlayedMin: 75, place: 'matchmaking' });
  add('session due in purchase', { sessionPlayedMin: 75, place: 'purchase' });
  add('session due in tutorial', { sessionPlayedMin: 75, place: 'tutorial' });
  add('session second mark', { sessionPlayedMin: 125, marks: { ...marks0, sessionMark: 60 } });
  add('session between marks', { sessionPlayedMin: 110, marks: { ...marks0, sessionMark: 60 } });
  add('daily due', { settings: { sessionMin: null, dailyMin: 120, quietAfterHour: null }, dayPlayedMin: 130 });
  add('daily shown today', { settings: { sessionMin: null, dailyMin: 120, quietAfterHour: null }, dayPlayedMin: 200, marks: { ...marks0, dayKey: '2026-11-10', dailyShown: true } });
  add('daily shown yesterday', { settings: { sessionMin: null, dailyMin: 120, quietAfterHour: null }, dayPlayedMin: 200, marks: { ...marks0, dayKey: '2026-11-09', dailyShown: true } });
  add('quiet before', { now: jst(2026, 11, 10, 21, 59), settings: { sessionMin: null, dailyMin: null, quietAfterHour: 22 } });
  add('quiet at', { now: jst(2026, 11, 10, 22), settings: { sessionMin: null, dailyMin: null, quietAfterHour: 22 } });
  add('quiet after midnight same day', { now: jst(2026, 11, 11, 2), settings: { sessionMin: null, dailyMin: null, quietAfterHour: 22 } });
  add('quiet shown', { now: jst(2026, 11, 11, 2), settings: { sessionMin: null, dailyMin: null, quietAfterHour: 22 }, marks: { ...marks0, dayKey: '2026-11-10', quietShown: true } });
  add('quiet morning', { now: jst(2026, 11, 11, 4), settings: { sessionMin: null, dailyMin: null, quietAfterHour: 22 } });
  add('quiet midnight choice', { now: jst(2026, 11, 11, 0, 30), settings: { sessionMin: null, dailyMin: null, quietAfterHour: 0 } });
  add('quiet 21 en', { now: jst(2026, 11, 10, 21, 10), locale: 'en', settings: { sessionMin: null, dailyMin: null, quietAfterHour: 21 } });
  add('quiet midnight en', { now: jst(2026, 11, 11, 1), locale: 'en', settings: { sessionMin: null, dailyMin: null, quietAfterHour: 0 } });
  add('all three ja', { now: jst(2026, 11, 10, 22, 30), settings: all, sessionPlayedMin: 31, dayPlayedMin: 125 });
  add('all three en', { now: jst(2026, 11, 10, 22, 30), locale: 'en', settings: all, sessionPlayedMin: 31, dayPlayedMin: 125 });
  add('all three not safe', { now: jst(2026, 11, 10, 22, 30), settings: all, sessionPlayedMin: 31, dayPlayedMin: 125, place: 'race' });
  add('utc device', { now: Date.UTC(2026, 10, 10, 22, 30), localOffsetMin: 0, settings: { sessionMin: null, dailyMin: null, quietAfterHour: 22 } });
  add('negative offset device', { now: Date.UTC(2026, 10, 11, 3, 30), localOffsetMin: -300, settings: all, sessionPlayedMin: 95, dayPlayedMin: 119 });
  return { version: 1, cases: cases.map(([name, snapshot]) => ({ name, snapshot, expect: decidePlaytimeReminder(snapshot) })) };
}

describe('REQ-LIMIT-013/014 HTTP, gate groups', () => {
  function ctx() {
    const w = world();
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (w.svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(w.svc, args)) as PlayerInvoker['invoke'] };
    const c = {
      master: m, authenticate: async (req: Request) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
      player: () => invoker, friends: makeFriendsService(() => invoker, new MemoryDirectory()), clock: () => Date.now(),
      paidBalance: async () => ({}), adminToken: 'x', parseStoreNotification: async () => null,
    } as unknown as AppContext;
    return { c, w };
  }
  const req = (method: string, path: string, user?: string, body?: unknown, lang?: string) => new Request(`https://x${path}`, {
    method, headers: { ...(user ? { 'x-test-user': user } : {}), ...(lang ? { 'accept-language': lang } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  it('the four routes are never gated and sit outside /v1/shop', () => {
    for (const [mth, p] of [['GET', '/v1/self-limits'], ['PUT', '/v1/self-limits/spending'], ['DELETE', '/v1/self-limits/spending/pending'], ['PUT', '/v1/self-limits/playtime']] as const) {
      expect(isExempt(mth, p), p).toBe(true);
      expect(endpointGroup(p)).not.toBe('shop');
    }
  });
  it('GET / PUT / DELETE; 401 without auth; 400 for extra or bad fields; the refusal carries its details', async () => {
    const { c, w } = ctx();
    expect((await handle(req('GET', '/v1/self-limits'), {}, c)).status).toBe(401);
    expect(await (await handle(req('GET', '/v1/self-limits', 'u'), {}, c)).json()).toMatchObject({ rev: 0, spending: { limitYen: null } });
    expect((await handle(req('PUT', '/v1/self-limits/spending', 'u', { limitYen: 1000, extra: 1 }), {}, c)).status).toBe(400);
    expect((await handle(req('PUT', '/v1/self-limits/spending', 'u', { limitYen: '1000' }), {}, c)).status).toBe(400);
    expect((await handle(req('PUT', '/v1/self-limits/playtime', 'u', { sessionMin: 61 }), {}, c)).status).toBe(400);
    expect(await (await handle(req('PUT', '/v1/self-limits/spending', 'u', { limitYen: 1000 }), {}, c)).json()).toMatchObject({ applied: 'now', view: { spending: { limitYen: 1000 } } });
    expect(await (await handle(req('PUT', '/v1/self-limits/spending', 'u', { limitYen: null }), {}, c)).json()).toMatchObject({ applied: 'pending' });
    expect(await (await handle(req('DELETE', '/v1/self-limits/spending/pending', 'u'), {}, c)).json()).toMatchObject({ applied: 'cancelled' });
    expect(await (await handle(req('PUT', '/v1/self-limits/playtime', 'u', { sessionMin: 30 }), {}, c)).json()).toMatchObject({ view: { playtime: { sessionMin: 30, enabled: true } } });
    await w.svc.setAge('u', 1990, 1, false);
    const res = await handle(req('POST', '/v1/shop/purchase-intent', 'u', { productId: 'coin_1500' }), {}, c);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'SELF_LIMIT_EXCEEDED', details: { selfLimitYen: 1000, priceYen: 1500, settings: 'self_limits' } } });
    // English at the response boundary
    const en = await (await handle(req('GET', '/v1/self-limits', 'u', undefined, 'en'), {}, c)).json() as { spending: { statusText: string; rulesText: string[] } };
    expect(en.spending.statusText).toBe('Your own limit: ¥1,000 (¥1,000 left this month)');
    expect(en.spending.rulesText[1]).toBe('Raising or removing it takes effect after 72 hours (you can cancel it until then)');
  });
  it('works while the account deletion is scheduled (lowering protects the player)', async () => {
    const w = world();
    await adult(w);
    const st = await w.svc.state('p');
    st.deletion = { status: 'scheduled', requestedAt: w.now(), deleteAt: w.now() + 30 * 24 * HOUR, steps: [], attempts: 0 } as unknown as PlayerState['deletion'];
    await w.repo.put(st);
    expect((await w.svc.setSpendingLimit('p', 1000)).applied).toBe('now');
  });
});

describe('REQ-LIMIT-015..017 state, export, KPI, ops', () => {
  it('§51: classified under settings, exported whole; no unclassified key', async () => {
    const w = world();
    await adult(w);
    await w.svc.setSpendingLimit('p', 3000);
    await w.svc.setSpendingLimit('p', 10000);
    await w.svc.setPlaytime('p', { sessionMin: 60 });
    expect(classifyKey('selfLimits')).toEqual({ section: 'settings' });
    const s = await w.svc.state('p');
    const doc = buildExportDocument(m, s, { ledger: s.ledger, gacha: [], names: {}, reportsMade: [], kpiEvents: null }, 'dex_1', 'ja', w.now()) as unknown as { settings: { selfLimits: PlayerState['selfLimits'] }; unclassified: string[] };
    expect(doc.unclassified).toEqual([]);
    expect(doc.settings.selfLimits).toMatchObject({ spending: { limitYen: 3000, pending: { limitYen: 10000 } }, playtime: { sessionMin: 60 } });
    expect(doc.settings.selfLimits!.history.map((h) => h.kind)).toEqual(['set', 'raise_requested', 'playtime']);
  });
  it('KPI: self_limit_set is essential (kept with analytics off); the others optional; client event accepted', async () => {
    expect(kpiClassOf('self_limit_set')).toBe('essential');
    expect('self_limit_set' in KPI_ESSENTIAL).toBe(true);
    for (const n of ['self_limit_block', 'playtime_setting_change', 'playtime_reminder_shown']) expect(kpiClassOf(n), n).toBe('optional');
    const w = world();
    await adult(w);
    await w.svc.setPrivacyChoices('p', { privacyVersion: m.progression.consent!.privacyVersion, source: 'settings', analytics: false });
    w.kpi.length = 0;
    await w.svc.setSpendingLimit('p', 1000);
    await w.svc.setSpendingLimit('p', 3000);
    await w.svc.cancelSpendingRaise('p');
    await w.svc.setPlaytime('p', { sessionMin: 30 });
    await code(w.svc.purchaseIntent('p', 'coin_1500'));
    expect(w.kpi.map((k) => [k.name, k.s1, k.amountYen, k.value])).toEqual([
      ['self_limit_set', 'set', 1000, 0], ['self_limit_set', 'raise_requested', 3000, 1000], ['self_limit_set', 'raise_cancelled', 3000, 1000],
    ]);
    await w.svc.setPrivacyChoices('p', { privacyVersion: m.progression.consent!.privacyVersion, source: 'settings', analytics: true });
    w.kpi.length = 0;
    await code(w.svc.purchaseIntent('p', 'coin_1500'));
    expect(w.kpi.map((k) => [k.name, k.s1, k.amountYen])).toEqual([['self_limit_block', 'coin_1500', 1500]]);
    const ev = { name: 'playtime_reminder_shown', at: 1, props: { reasons: 'quiet_after,session', sessionMin: 60, dayMin: 125, choice: 'continue' } };
    const b = clientBatchSchema.parse({ platform: 'ios', appVersion: '1.0.0', events: [ev] });
    expect(clientToKpi(b.events[0] as ClientEvent)).toEqual({ name: 'playtime_reminder_shown', s1: 'quiet_after,session', s2: 'continue', value: 60, count: 125 });
    expect(clientBatchSchema.safeParse({ platform: 'ios', appVersion: '1.0.0', events: [{ ...ev, props: { ...ev.props, sessionMin: 61 } }] }).success).toBe(false);
    expect(clientBatchSchema.safeParse({ platform: 'ios', appVersion: '1.0.0', events: [{ ...ev, props: { ...ev.props, reasons: 'session,quiet_after' } }] }).success).toBe(false);
  });
  it('ops: the player view shows the limits; no admin route writes them', async () => {
    const w = world();
    await adult(w);
    await w.svc.setSpendingLimit('p', 3000);
    await w.svc.setSpendingLimit('p', null);
    const v = await w.svc.adminView('p') as unknown as { selfLimits: { spending: { limitYen: number; pending: { limitYen: null } } } };
    expect(v.selfLimits.spending).toMatchObject({ limitYen: 3000, pending: { limitYen: null } });
    const writes = adminRoutes.filter((r) => r.write && /self[-_]?limit|limit/i.test(r.path + r.action));
    expect(writes.map((r) => r.path)).toEqual([]);
  });
  it('the account deletion wipe leaves nothing (the key lives only in the player state)', async () => {
    const w = world();
    await adult(w);
    await w.svc.setSpendingLimit('p', 3000);
    expect((await w.svc.state('p')).selfLimits).toBeDefined();
    await w.repo.delete?.('p');
    expect((await w.repo.get('p'))).toBeNull();
  });
});

describe('REQ-LIMIT-022 wording', () => {
  const PRESSURE = ['もう少しだけ', 'あと1回', 'あと一回', '急いで', 'お見逃し', '限定'];
  const PRESSURE_EN = [/\bhurry\b/i, /\bjust one more\b/i, /\blast chance\b/i, /\blimited time\b/i, /\bdon'?t miss\b/i, /\bdouble\b/i];
  it('no legal, betting or pressure words in Japanese or English (code texts, help article, tip)', () => {
    const help = JSON.parse(readFileSync(join(__dirname, '..', 'master', 'help.json'), 'utf8')) as { articles: { id: string; title: { ja: string; en: string }; body: { ja: string; en: string } }[] };
    const tips = JSON.parse(readFileSync(join(__dirname, '..', 'master', 'tips.json'), 'utf8')) as { tips: { id: string; title: { ja: string; en: string }; body: { ja: string; en: string } }[] };
    const a = help.articles.find((x) => x.id === 'self_limits')!;
    const t = tips.tips.find((x) => x.id === 'self_limits')!;
    const ja = [...selfLimitsTextsJa(), a.title.ja, a.body.ja, t.title.ja, t.body.ja].join('\n');
    const en = [...selfLimitsTextsEn(), a.title.en, a.body.en, t.title.en, t.body.en].join('\n');
    for (const word of [...LEGAL_WORDS_JA, ...PRESSURE]) expect(ja.includes(word), word).toBe(false);
    for (const re of PRESSURE_EN) expect(re.test(en), re.source).toBe(false);
    expect(bettingWordsIn(ja + '\n' + en)).toEqual([]);
  });
});
