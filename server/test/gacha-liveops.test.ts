// Round 9: banner schedule (live-ops calendar), pity meter and carry-over, step-up, odds page data
// (docs/planning/06 §7 item 7, REQ-GACHA-011..016; legal guards of docs/planning/03 and 06 §5.5).
import { describe, expect, it } from 'vitest';
import gachaJson from '../master/gacha.json';
import { m, freshPlayer } from './helpers.js';
import {
  assertBannerOpen, bannerList, bannerProblems, bannerStatus, carryOverRule, drawGacha, findBanner, gachaStatus, oddsDisclosure,
  pityScheduleProblems, settlePityGroups, stepIndex, validateGacha,
} from '../src/domain/gacha.js';
import { buildBanner, buildPityGroups, DEFAULT_ANNOUNCE_DAYS, endOfGameDay, PPM_TOTAL, type Master, type RawBanner } from '../src/domain/master.js';
import { DAY_MS, dayRule, gameDayKey, gameDayStartMs, type DayRollover } from '../src/domain/time.js';
import { seededRng } from '../src/domain/rng.js';
import { grantFree, grantPaid } from '../src/domain/wallet.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { resolveBundle, type ConfigBundle } from '../src/ops/config.js';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { AppError } from '../src/domain/errors.js';
import { useTicket } from '../src/domain/itemShop.js';

const NOW = Date.UTC(2026, 10, 6, 3); // 2026-11-06 12:00 JST
const ginga = findBanner(m, 'pickup_ginga');
const winter = findBanner(m, 'winter_2026');
const step = findBanner(m, 'stepup_paid');
const err = (fn: () => unknown) => { try { fn(); } catch (e) { return e as AppError; } throw new Error('did not throw'); };
type RawB = NonNullable<NonNullable<ConfigBundle['gacha']>['banners']>[number];
const rawBanners = () => structuredClone((gachaJson as unknown as { banners: RawB[] }).banners);
const rawGroups = () => structuredClone((gachaJson as unknown as { pityGroups: NonNullable<NonNullable<ConfigBundle['gacha']>['pityGroups']> }).pityGroups);

describe('banner schedule (REQ-GACHA-011)', () => {
  it('game-day schedule: opens at the rollover of startDay, closes at the rollover after endDay', () => {
    const R = dayRule(m);
    expect(gameDayStartMs('2026-11-01', R)).toBe(Date.UTC(2026, 9, 31, 15)); // 2026-11-01 00:00 JST (before the 04:00 switch)
    for (const k of ['2026-11-01', '2026-11-30', '2026-12-01', '2026-12-02', '2027-02-28', '2026-12-31']) {
      expect(gameDayKey(gameDayStartMs(k, R), R)).toBe(k);
      expect(gameDayKey(gameDayStartMs(k, R) - 1, R)).not.toBe(k);
      expect(gameDayKey(gameDayStartMs(k, 4), 4)).toBe(k);
      expect(gameDayKey(gameDayStartMs(k, 0), 0)).toBe(k);
    }
    expect(ginga.startAtMs).toBe(gameDayStartMs('2026-11-01', R));
    expect(ginga.endAtMs).toBe(gameDayStartMs('2026-12-01', R));
    expect(ginga.announceAtMs).toBe(ginga.startAtMs! - DEFAULT_ANNOUNCE_DAYS * DAY_MS);
    expect(winter.announceAtMs).toBe(winter.startAtMs! - 7 * DAY_MS);
    // the closing pity group of the limited banner closes exactly with it
    expect(m.gacha.pityGroups.pickup_ginga!.endAtMs).toBe(ginga.endAtMs);
  });

  it('game days across the 0 -> 4 switch (REQ-DAY-001): endDay closes at the next rollover, not start + 24 h', () => {
    const R = dayRule(m);
    const jst = (mo: number, d: number, h = 0) => Date.UTC(2026, mo - 1, d, h - 9);
    expect(gameDayStartMs('2026-12-01', R)).toBe(jst(12, 1, 0)); // the 28 h switch day starts at midnight
    expect(gameDayStartMs('2026-12-02', R)).toBe(jst(12, 2, 4)); // and ends at 04:00 the next morning
    expect(endOfGameDay('2026-12-01', R)).toBe(jst(12, 2, 4));
    expect(endOfGameDay('2026-11-30', R)).toBe(jst(12, 1, 0));
    const raw = { ...(rawBanners().find((b) => b.id === 'pickup_ginga')! as unknown as RawBanner), startDay: '2026-12-01', endDay: '2026-12-10', announceDays: 2 };
    const b = buildBanner(raw, m.templates, R);
    expect(b.startAtMs).toBe(jst(12, 1, 0));
    expect(b.endAtMs).toBe(jst(12, 11, 4)); // last game day 12-10 runs to 12-11 04:00 JST
    expect(b.announceAtMs).toBe(jst(11, 29, 0)); // two game days before the start, at that day's rollover
    expect(bannerStatus(b, jst(12, 11, 4) - 60_000)).toBe('active'); // 03:59 JST on 12-11 is still game day 12-10
    expect(bannerStatus(b, jst(12, 11, 4))).toBe('ended');
    const list = (now: number) => bannerList({ ...m, gacha: { ...m.gacha, banners: [...m.gacha.banners.filter((x) => x.id !== 'pickup_ginga'), b] } }, now);
    const row = list(jst(12, 10, 12)).banners.find((x) => x.id === 'pickup_ginga')!;
    expect(row.lastDay).toBe('2026-12-10');
    expect(row.daysLeft).toBe(1);
    expect(list(jst(12, 11, 2)).banners.find((x) => x.id === 'pickup_ginga')!.daysLeft).toBe(1); // 02:00: still the last day
    expect(list(jst(12, 9, 12)).banners.find((x) => x.id === 'pickup_ginga')!.daysLeft).toBe(2);
  });

  it('a config version that changes the day rule re-resolves game-day schedules (banners and pity groups)', () => {
    const later: DayRollover = { hourJst: 5, previousHourJst: 5, effectiveAtMs: 0 };
    const { master } = resolveBundle(m, { progression: { dayRollover: later } } as ConfigBundle);
    const g = findBanner(master, 'pickup_ginga');
    expect(g.startAtMs).toBe(gameDayStartMs('2026-11-01', 5));
    expect(g.endAtMs).toBe(gameDayStartMs('2026-12-01', 5));
    expect(master.gacha.pityGroups.pickup_ginga!.endAtMs).toBe(g.endAtMs);
    expect(findBanner(master, 'winter_2026').startAtMs).toBe(winter.startAtMs); // instants stay instants
    expect(findBanner(m, 'pickup_ginga').endAtMs).toBe(ginga.endAtMs); // the base master is not changed
  });

  it('status by server time: hidden → upcoming → active → ended', () => {
    expect(bannerStatus(winter, winter.announceAtMs! - 1)).toBe('hidden');
    expect(bannerStatus(winter, winter.announceAtMs!)).toBe('upcoming');
    expect(bannerStatus(winter, winter.startAtMs! - 1)).toBe('upcoming');
    expect(bannerStatus(winter, winter.startAtMs!)).toBe('active');
    expect(bannerStatus(winter, winter.endAtMs! - 1)).toBe('active');
    expect(bannerStatus(winter, winter.endAtMs!)).toBe('ended');
    expect(bannerStatus(findBanner(m, 'standard'), 0)).toBe('active');
  });

  it('GET /v1/gacha/banners data: active + announced only, sorted, real end times', () => {
    const l = bannerList(m, NOW);
    expect(l.serverNowMs).toBe(NOW);
    // limited (ends soonest first), then permanent with the standard banner last; winter is not announced yet
    expect(l.banners.map((b) => b.id)).toEqual(['pickup_ginga', 'pickup_akatsuki', 'stepup_paid', 'standard']);
    const g = l.banners[0]!;
    expect(g).toMatchObject({ status: 'active', endAtMs: ginga.endAtMs, lastDay: '2026-11-30', daysLeft: 25, pickup: { templateId: 't_ginga', rarity: 'SSR' }, pityGroup: 'pickup_ginga', pityCost: 100 });
    // permanent banners carry no end and no countdown (06 §5.5: no fake urgency)
    for (const b of l.banners.slice(1)) expect(b).toMatchObject({ endAtMs: null, daysLeft: null, lastDay: null });
    expect(l.banners.find((b) => b.id === 'stepup_paid')!.stepUp).toEqual({ steps: 5, afterLast: 'loop', prices: [500, 1000, 1000, 1000, 1000], finalSlotSteps: [5] });

    const announced = bannerList(m, winter.announceAtMs!).banners;
    expect(announced.at(-1)).toMatchObject({ id: 'winter_2026', status: 'upcoming', startAtMs: winter.startAtMs, daysLeft: null, limited: true });
    // the last day: daysLeft 1, then gone from the list
    expect(bannerList(m, ginga.endAtMs! - 1).banners[0]).toMatchObject({ id: 'pickup_ginga', daysLeft: 1 });
    expect(bannerList(m, ginga.endAtMs!).banners.map((b) => b.id)).not.toContain('pickup_ginga');
  });

  it('pulling at the boundary: decided by server time, open 1 ms before the end, refused 1 ms after (and at) it', () => {
    const s = freshPlayer('p', NOW);
    grantFree(s, 5000, NOW, 'test', 't');
    expect(() => drawGacha(m, s, 'pickup_ginga', 1, seededRng(1), ginga.endAtMs! - 1)).not.toThrow();
    for (const t of [ginga.endAtMs!, ginga.endAtMs! + 1]) {
      const e = err(() => drawGacha(m, s, 'pickup_ginga', 1, seededRng(1), t));
      expect(e.code).toBe('BANNER_CLOSED');
      expect(e.message).toBe('banner pickup_ginga ended at 2026-12-01 00:00 JST');
    }
    expect(err(() => drawGacha(m, s, 'winter_2026', 1, seededRng(1), winter.startAtMs! - 1)).message).toBe('banner winter_2026 opens at 2026-12-11 00:00 JST');
    expect(err(() => drawGacha(m, s, 'winter_2026', 1, seededRng(1), NOW)).message).toBe('banner winter_2026 is not open'); // unannounced: no schedule leak
    expect(() => assertBannerOpen(ginga, ginga.startAtMs!)).not.toThrow();
  });

  it('the player transaction uses the server clock read at commit', async () => {
    const clock = { now: ginga.endAtMs! - 1 };
    const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(5), clock: () => clock.now, verifiers: {} });
    await svc.adminGrant('p', { freeCoins: 1000 }, 'test', 'test', 'g1');
    const ok = await svc.draw('p', 'pickup_ginga', 1, 'c:k1');
    expect(ok.results).toHaveLength(1);
    clock.now = ginga.endAtMs! + 1;
    await expect(svc.draw('p', 'pickup_ginga', 1, 'c:k2')).rejects.toMatchObject({ code: 'BANNER_CLOSED' });
    // the refused pull charged nothing and added no pity
    const v = await svc.view('p');
    expect(v.wallet.free).toBe(1000 - 100);
    // and the retry of the first key still returns the stored result (no second charge)
    expect((await svc.draw('p', 'pickup_ginga', 1, 'c:k1')).results).toEqual(ok.results);
  });

  it('validation of schedules (boot and remote config)', () => {
    expect(() => validateGacha(m)).not.toThrow();
    expect(bannerProblems({ ...ginga, startAtMs: ginga.endAtMs }, m, m.gacha).join()).toMatch(/starts at or after its end/);
    expect(bannerProblems({ ...ginga, announceAtMs: ginga.startAtMs! + 1 }, m, m.gacha).join()).toMatch(/announced after it opens/);
    expect(bannerProblems({ ...ginga, pickupTemplateId: 't_nope' }, m, m.gacha).join()).toMatch(/pickup t_nope not in pool/);
    const raw = rawBanners().find((b) => b.id === 'pickup_ginga')! as unknown as RawBanner;
    expect(() => buildBanner({ ...raw, startAtMs: 1 }, m.templates, dayRule(m))).toThrow(/startDay or startAtMs/);
    expect(() => buildBanner({ ...raw, startDay: undefined, announceDays: 2 }, m.templates, dayRule(m))).toThrow(/needs a start/);
    expect(() => buildPityGroups({ x: { cost: 100, endDay: '2026-11-30', endAtMs: 1 } }, dayRule(m))).toThrow(/endDay or endAtMs/);
    // a pity group that outlives its banners (points sitting unusable), a permanent group with only ending banners
    expect(pityScheduleProblems({ ...m.gacha, pityGroups: { ...m.gacha.pityGroups, pickup_ginga: { cost: 100, endAtMs: ginga.endAtMs! + DAY_MS } } }).join()).toMatch(/closes after its last banner/);
    expect(pityScheduleProblems({ ...m.gacha, pityGroups: { ...m.gacha.pityGroups, pickup_ginga: { cost: 100 } } }).join()).toMatch(/never closes but has no permanent banner/);
    expect(pityScheduleProblems({ ...m.gacha, banners: m.gacha.banners.filter((b) => b.id !== 'standard') }).join()).toMatch(/standard is required/);
    expect(pityScheduleProblems({ ...m.gacha, banners: m.gacha.banners.map((b) => (b.id === 'standard' ? { ...b, endAtMs: NOW } : b)) }).join()).toMatch(/standard must be permanent/);
  });

  it('remote config schedules a new banner rotation with game days; the same checks apply', () => {
    const b = rawBanners();
    const g = rawGroups();
    b.push({ id: 'pickup_kohaku', name: 'ピックアップ：コハクノヒカリ', currency: 'any', priceSingle: 100, priceTen: 1000, pityGroup: 'pickup_kohaku', pityTargets: ['t_kohaku'], pickup: { templateId: 't_kohaku', ppm: 15000 }, pool: 'auto', rates: { SSR: 30000, SR: 180000, R: 790000 }, guaranteeRates: { SSR: 30000, SR: 970000 }, startDay: '2026-12-01', endDay: '2026-12-10', announceDays: 2 });
    g.pickup_kohaku = { cost: 100, endDay: '2026-12-10', convertTo: 'standard', label: 'ピックアップ（コハク）' };
    const { master } = resolveBundle(m, { gacha: { banners: b, pityGroups: g } });
    const k = findBanner(master, 'pickup_kohaku');
    expect([k.startAtMs, k.endAtMs, k.announceAtMs]).toEqual([gameDayStartMs('2026-12-01', dayRule(m)), gameDayStartMs('2026-12-11', dayRule(m)), gameDayStartMs('2026-11-29', dayRule(m))]);
    expect(bannerList(master, gameDayStartMs('2026-12-01', dayRule(m))).banners.map((x) => x.id)).toEqual(['pickup_kohaku', 'pickup_akatsuki', 'stepup_paid', 'standard']);
    // closing the group one day after the banner strands points → refused
    g.pickup_kohaku = { cost: 100, endDay: '2026-12-11', convertTo: 'standard' };
    expect(() => resolveBundle(m, { gacha: { banners: b, pityGroups: g } })).toThrow(/closes after its last banner/);
    // bad day keys and both forms at once are rejected by the schema / builder
    expect(() => resolveBundle(m, { gacha: { banners: [...rawBanners(), { ...b.at(-1)!, id: 'x', startDay: '12/01' }] } } as never)).toThrow(/startDay/);
  });
});

describe('pity meter and carry-over (REQ-GACHA-012/013)', () => {
  it('per group: points, remaining, coins to the exchange on each open banner, targets', () => {
    const s = freshPlayer('p', NOW);
    s.pity.pickup_ginga = 37;
    s.pity.standard = 100;
    const st = gachaStatus(m, s, NOW);
    const g = st.groups.find((x) => x.group === 'pickup_ginga')!;
    expect(g).toMatchObject({ label: 'ピックアップ（ギンガノカナタ）', points: 37, cost: 100, remaining: 63, exchangeable: 0, banners: ['pickup_ginga'], closesAtMs: ginga.endAtMs, targets: [{ templateId: 't_ginga', owned: false }] });
    expect(st.groups.find((x) => x.group === 'standard')).toMatchObject({ points: 100, remaining: 0, exchangeable: 1, carryOver: null });
    // 63 pulls = six 10-pulls + three singles
    expect(st.banners.find((x) => x.bannerId === 'pickup_ginga')).toMatchObject({ remaining: 63, coinsToExchange: 6 * 1000 + 3 * 100, stepUp: null });
    // winter is not open and has no points: not listed
    expect(st.groups.map((x) => x.group)).not.toContain('winter_2026');
  });

  it('carry-over rule is generated from data: 1:1 into the permanent group, never expires, exchangeable there (no lottery)', () => {
    const c = carryOverRule(m, 'pickup_ginga')!;
    expect(c).toMatchObject({ atMs: ginga.endAtMs, toGroup: 'standard', toLabel: '恒常', rate: '1:1', expires: false });
    expect(c.toTargets.map((t) => t.templateId)).toEqual(['t_akatsuki', 't_ginga', 't_kohaku', 't_tsukikage']);
    expect(c.notice).toBe('2026-12-01 00:00 JSTに、残っている交換ptはすべて「恒常」の交換ptへ1:1で移ります。失効しません。移った後はシンセイアカツキ・ギンガノカナタ・コハクノヒカリ・ツキカゲロードのどれかと交換できます（抽選ではありません）。');
    expect(carryOverRule(m, 'standard')).toBeNull();
    expect(carryOverRule(m, 'pickup')).toBeNull();
  });

  it('after the end the meter already shows the converted points (same rule the next transaction applies)', () => {
    const s = freshPlayer('p', NOW);
    s.pity.pickup_ginga = 37;
    s.pity.standard = 20;
    const after = gachaStatus(m, s, ginga.endAtMs!);
    expect(after.groups.find((x) => x.group === 'standard')!.points).toBe(57);
    expect(after.groups.map((x) => x.group)).not.toContain('pickup_ginga');
    expect(s.pity.pickup_ginga).toBe(37); // read only
    settlePityGroups(m, s, ginga.endAtMs!);
    expect(s.pity).toMatchObject({ pickup_ginga: 0, standard: 57 });
  });
});

describe('step-up (REQ-GACHA-014)', () => {
  it('steps advance per 10-pull at the step price; step 5 slot 10 is always from its SSR table; then it loops', () => {
    const s = freshPlayer('p', NOW);
    grantPaid(s, 20_000, 30_000, NOW, 'buy', 'tx');
    const prices = [500, 1000, 1000, 1000, 1000, 500];
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = s.wallet.paid;
      const r = drawGacha(m, s, 'stepup_paid', 10, seededRng(100 + i), NOW);
      expect(before - s.wallet.paid).toBe(prices[i]);
      expect(r.stepUp!.drawnStep).toBe((i % 5) + 1);
      seen.push(r.stepUp!.next.step);
      if (i === 4) {
        expect(r.results[9]).toMatchObject({ rarity: 'SSR', guaranteed: true });
        expect(r.stepUp!.next).toMatchObject({ step: 1, round: 2, priceTen: 500, finalSlotMinRarity: null });
      }
    }
    expect(seen).toEqual([2, 3, 4, 5, 1, 2]);
    expect(s.stepUp).toEqual({ stepup_paid: 6 });
    expect(s.pity.pickup).toBe(60);
  });

  it('slot 10 of the SSR step is SSR on every seed; other steps keep the usual SR+ guarantee', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const s = freshPlayer('p', NOW);
      grantPaid(s, 10_000, 15_000, NOW, 'buy', 'tx');
      s.stepUp = { stepup_paid: 4 };
      expect(drawGacha(m, s, 'stepup_paid', 10, seededRng(seed), NOW).results[9]!.rarity).toBe('SSR');
    }
  });

  it('10-pulls only, paid coins only, no tickets; the meter prices the way to the exchange from the steps', () => {
    const s = freshPlayer('p', NOW);
    grantPaid(s, 5000, 7500, NOW, 'buy', 'tx');
    expect(err(() => drawGacha(m, s, 'stepup_paid', 1, seededRng(1), NOW)).code).toBe('BAD_REQUEST');
    s.items.gacha_ticket = 1;
    expect(err(() => useTicket(m, s, 'gacha_ticket', 'stepup_paid', seededRng(1), NOW, 'k')).code).toBe('NOT_ELIGIBLE');
    const st = gachaStatus(m, s, NOW).banners.find((b) => b.bannerId === 'stepup_paid')!;
    // 100 pulls = 10 step draws from step 1: 500 + 4×1000 + 500 + 4×1000
    expect(st).toMatchObject({ remaining: 100, coinsToExchange: 9000, stepUp: { step: 1, steps: 5, completed: 0, priceTen: 500 } });
    s.stepUp = { stepup_paid: 3 };
    s.pity.pickup = 30;
    expect(gachaStatus(m, s, NOW).banners.find((b) => b.bannerId === 'stepup_paid')).toMatchObject({ remaining: 70, coinsToExchange: 1000 + 1000 + 500 + 4000, stepUp: { step: 4, finalSlotMinRarity: null } });
    expect(stepIndex(step, 5)).toBe(0);
    expect(stepIndex({ ...step, stepUp: { ...step.stepUp!, afterLast: 'repeatLast' } }, 12)).toBe(4);
  });

  it('validation: SR+ slot-10 tables, prices, and tickets kept off step-up banners', () => {
    const bad = { ...step, stepUp: { afterLast: 'loop' as const, steps: [{ priceTen: 0 }, { priceTen: 100, finalSlotPool: [{ templateId: m.templates.find((t) => t.rarity === 'R')!.id, ppm: PPM_TOTAL }] }] } };
    const p = bannerProblems(bad, m, m.gacha).join();
    expect(p).toMatch(/step 1 price/);
    expect(p).toMatch(/step 2 finalSlotPool contains below-SR/);
    const withTicket: Master = { ...m, items: { ...m.items, tickets: { ...m.items.tickets, gacha_ticket: { kind: 'single', name: 'x', banners: ['standard'] }, t2: { kind: 'single', name: 'y', banners: ['pickup_ginga'] } } } };
    expect(() => validateGacha(withTicket)).not.toThrow();
    const stepFree: Master = { ...withTicket, gacha: { ...m.gacha, banners: m.gacha.banners.map((b) => (b.id === 'pickup_ginga' ? { ...b, stepUp: step.stepUp! } : b)) } };
    expect(() => validateGacha(stepFree)).toThrow(/step-up banner pickup_ginga cannot take tickets/);
  });
});

describe('odds page data (REQ-GACHA-002/015)', () => {
  it('pickup rates, step tables, pity cost and carry-over all come from the drawing tables', () => {
    const d = oddsDisclosure(m, ginga);
    expect(d.pickup).toEqual({ templateId: 't_ginga', name: 'ギンガノカナタ', rarity: 'SSR', ppm: 15000, rate: '1.5000%', guaranteePpm: ginga.guaranteePool.find((e) => e.templateId === 't_ginga')!.ppm, guaranteeRate: expect.any(String) });
    expect(d.items.find((r) => r.templateId === 't_ginga')!.ppm).toBe(d.pickup!.ppm);
    expect(d.pity).toMatchObject({ group: 'pickup_ginga', label: 'ピックアップ（ギンガノカナタ）', pullsRequired: 100, costCoins: 10_000, closesAtMs: ginga.endAtMs, carryOver: { toGroup: 'standard', expires: false } });
    expect(d.period.lastDay).toBe('2026-11-30');
    const sd = oddsDisclosure(m, step);
    expect(sd.stepUp!.steps.map((x) => x.priceTen)).toEqual([500, 1000, 1000, 1000, 1000]);
    const s5 = sd.stepUp!.steps[4]!.finalSlot;
    expect(s5.items!.map((r) => [r.templateId, r.ppm])).toEqual(step.stepUp!.steps[4]!.finalSlotPool!.map((e) => [e.templateId, e.ppm]));
    expect(Object.keys(s5.rarityTotals!)).toEqual(['SSR']);
    expect(s5.rarityTotals!.SSR!.ppm).toBe(PPM_TOTAL);
    expect(sd.stepUp!.steps[0]!.finalSlot.items).toBeNull();
    expect(sd.pity.costCoins).toBe(9000);
    expect(oddsDisclosure(m, findBanner(m, 'standard')).pickup).toBeNull();
  });

  it('no misleading wording: generated texts never say 「倍」 or compare prices, and only real periods carry dates', () => {
    const texts: string[] = [];
    const walk = (x: unknown) => { if (typeof x === 'string') texts.push(x); else if (x && typeof x === 'object') Object.values(x).forEach(walk); };
    for (const b of m.gacha.banners) walk(oddsDisclosure(m, b));
    walk(bannerList(m, winter.announceAtMs!));
    const s = freshPlayer('p', NOW);
    s.pity.pickup_ginga = 5;
    walk(gachaStatus(m, s, NOW));
    for (const t of texts) {
      expect(t).not.toMatch(/倍|通常価格|今だけ|残りわずか|お得/);
    }
    for (const b of m.gacha.banners) expect(b.name).not.toMatch(/倍|確率.?UP|確率アップ/i);
  });
});

describe('HTTP: banners, status and odds', () => {
  function ctx(now: number) {
    const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(3), clock: () => now, verifiers: {} });
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
    const c = {
      master: m, clock: () => now,
      authenticate: async (req: Request) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
      player: () => invoker, friends: makeFriendsService(() => invoker, new MemoryDirectory()),
      adminToken: 'x', parseStoreNotification: async () => null, paidBalance: async () => ({}),
    } as unknown as AppContext;
    return { c, svc };
  }
  const get = (path: string, user?: string) => new Request(`https://x${path}`, { headers: user ? { 'x-test-user': user } : {} });

  it('GET /v1/gacha/banners lists the calendar by server time; GET /v1/gacha/status needs a player', async () => {
    const { c, svc } = ctx(NOW);
    const l = await (await handle(get('/v1/gacha/banners'), {}, c)).json() as ReturnType<typeof bannerList>;
    expect(l.serverNowMs).toBe(NOW);
    expect(l.banners.map((b) => b.id)).toEqual(['pickup_ginga', 'pickup_akatsuki', 'stepup_paid', 'standard']);
    expect((await handle(get('/v1/gacha/status'), {}, c)).status).toBe(401);
    await svc.adminGrant('u', { freeCoins: 1000 }, 't', 't', 'g');
    await svc.draw('u', 'pickup_ginga', 10, 'c:d');
    const st = await (await handle(get('/v1/gacha/status', 'u'), {}, c)).json() as ReturnType<typeof gachaStatus>;
    expect(st.groups.find((g) => g.group === 'pickup_ginga')).toMatchObject({ points: 10, remaining: 90 });
    expect(st.banners.find((b) => b.bannerId === 'stepup_paid')!.stepUp).toMatchObject({ step: 1 });
  });

  it('odds: an unannounced banner is not found; an announced one is disclosed before it opens', async () => {
    expect((await handle(get('/v1/gacha/winter_2026/odds'), {}, ctx(NOW).c)).status).toBe(404);
    const r = await handle(get('/v1/gacha/winter_2026/odds'), {}, ctx(winter.announceAtMs!).c);
    expect(r.status).toBe(200);
    expect((await r.json() as { bannerId: string }).bannerId).toBe('winter_2026');
  });

  it('a pull after the end answers BANNER_CLOSED (409) with the end time', async () => {
    const { c, svc } = ctx(ginga.endAtMs!);
    await svc.adminGrant('u', { freeCoins: 1000 }, 't', 't', 'g');
    const r = await handle(new Request('https://x/v1/gacha/pickup_ginga/draw', { method: 'POST', headers: { 'x-test-user': 'u', 'content-type': 'application/json', 'idempotency-key': 'k' }, body: JSON.stringify({ count: 1 }) }), {}, c);
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: { code: 'BANNER_CLOSED', message: 'banner pickup_ginga ended at 2026-12-01 00:00 JST' } });
  });
});

describe('QA r9: carry-over along a chain', () => {
  it('a closed group converting into another closed group reaches the open end of the chain in one settlement', () => {
    // the group listed first closes later than the one converting into it: one pass left points in a closed group,
    // where the meter showed them as not exchangeable and a same-transaction exchange on standard came up short
    const mm = { ...m, gacha: { ...m.gacha, pityGroups: {
      standard: { cost: 100 }, second: { cost: 100, endAtMs: NOW - 2000, convertTo: 'standard' }, first: { cost: 100, endAtMs: NOW - 5000, convertTo: 'second' },
    } } } as Master;
    const s = freshPlayer();
    s.pity = { first: 70, second: 40, standard: 10 };
    expect(settlePityGroups(mm, s, NOW)).toBeGreaterThan(0);
    expect(s.pity).toEqual({ first: 0, second: 0, standard: 120 });
    expect(settlePityGroups(mm, s, NOW)).toBe(0);
  });
});
