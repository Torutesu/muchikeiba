/**
 * イベント交換所 REQ-EXCH-001..012 (contracts/protocol.md §30).
 */
import { describe, expect, it } from 'vitest';
import { handle, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { eventProblems } from '../src/domain/events.js';
import {
  buyExchange, earnExchangePoints, ensureExchange, eventPointSourceProblems, exchangeClosesAt, exchangeProblems, exchangeView, leftoverQty, settleExchanges,
} from '../src/domain/exchange.js';
import { resolveBundle } from '../src/ops/config.js';
import { dayRule, gameDayKey } from '../src/domain/time.js';
import type { EventDef, Master } from '../src/domain/master.js';
import type { PlayerState } from '../src/domain/player.js';
import { freshPlayer, m } from './helpers.js';
import type { KpiRecord } from '../src/domain/kpi.js';

const ev = m.events.find((e) => e.id === 'newyear_cup_2027_01')!;
const ex = ev.exchange!;
const DURING = ev.startAtMs + 3 * 3600_000; // 2027-01-01 03:00 JST (game day 12-31 under the 04:00 rollover)
const CLOSES = exchangeClosesAt(ev, ex, dayRule(m));
const code = (f: () => unknown) => { try { f(); return 'ok'; } catch (e) { return (e as AppError).code; } };
const acode = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as AppError).code; } };
const withEx = (patch: Partial<NonNullable<EventDef['exchange']>>): EventDef => ({ ...ev, exchange: { ...structuredClone(ex), ...patch } });
const line = (id: string) => ex.items.find((x) => x.id === id)!;
const pts = (s: PlayerState) => s.events?.[ev.id]?.exchange?.points ?? 0;
/** Puts exactly `n` spendable points on the player (as if earned by racing). */
function give(s: PlayerState, n: number) {
  ensureExchange(m, s, ev).points = n;
}

describe('definitions and validation (REQ-EXCH-001/002/003/007)', () => {
  it('the shipped exchange is valid, with a horse, coins within 景表法, a ticket, material and a cosmetic', () => {
    expect(eventProblems(m, m.events)).toEqual([]);
    expect(exchangeProblems(m, ev, m.events)).toEqual([]);
    expect(new Set(ex.items.map((x) => x.kind))).toEqual(new Set(['horse', 'ticket', 'coins', 'material', 'cosmetic']));
    expect(eventPointSourceProblems(m)).toEqual([]);
  });

  it('closes 3 whole game days after the event’s last game day, at the 04:00 JST rollover', () => {
    // ends 2027-01-12 00:00 JST → last game day 01-11 → open 01-12, 01-13, 01-14 → closes 01-15 04:00 JST
    expect(new Date(CLOSES + 9 * 3600_000).toISOString()).toBe('2027-01-15T04:00:00.000Z');
    expect(gameDayKey(CLOSES, dayRule(m))).toBe('2027-01-15');
  });

  it('rejects random lines, a "take everything" reward, paid-only cosmetics, over-limit coins and bad leftovers', () => {
    const bad = (e: EventDef) => exchangeProblems(m, e, m.events).join('; ');
    expect(bad({ ...ev, exchange: { ...ex, completeReward: { freeCoins: 500 } } as never })).toMatch(/completeReward|Unrecognized/i);
    expect(bad(withEx({ items: [{ ...line('ex_coins_50'), reward: { freeCoins: 50 }, rates: { SSR: 1 } } as never] }))).toMatch(/Unrecognized|rates/i);
    expect(bad(withEx({ items: [{ ...line('ex_coins_50'), reward: { freeCoins: 101 } }] }))).toMatch(/100|freeCoins/);
    expect(bad(withEx({ items: [{ ...line('ex_flower_box'), reward: { items: [{ itemId: 'decor_golden_horseshoe', qty: 1 }] } }] }))).toMatch(/paid-only/);
    expect(bad(withEx({ items: [{ ...line('ex_flower_box'), reward: { items: [{ itemId: 'tack_bridle_pass_plus', qty: 1 }] } }] }))).toMatch(/product-only/);
    expect(bad(withEx({ items: [{ ...line('ex_scout_ticket'), reward: { items: [{ itemId: 'ticket_sr_plus', qty: 1 }] } }] }))).toMatch(/ticket line/);
    expect(bad(withEx({ items: [{ ...line('ex_scout_ticket'), reward: { items: [{ itemId: 'gacha_ticket_10', qty: 1 }] } }] }))).toMatch(/¥200/);
    expect(bad(withEx({ items: [{ ...line('ex_hatsuyuki'), stock: 2 }] }))).toMatch(/stock 1/);
    expect(bad(withEx({ items: [{ ...line('ex_hatsuyuki'), reward: { horse: 'nope' } }] }))).toMatch(/unknown horse/);
    expect(bad(withEx({ items: [{ ...line('ex_coins_50'), reward: { freeCoins: 50, items: [{ itemId: 'breeding_material', qty: 1 }] } }] }))).toMatch(/exactly one/);
    expect(bad(withEx({ leftover: { itemId: 'gacha_ticket', pointsPerUnit: 100 } }))).toMatch(/standard material/);
    expect(bad(withEx({ earn: { byPlace: [30], participation: 10, dailyCap: 20 } }))).toMatch(/dailyCap/);
    expect(bad(withEx({ items: [line('ex_material'), line('ex_material')] }))).toMatch(/duplicate/);
    // a seasonal horse must stay inside its window until the exchange closes
    const late = { ...ev, startAtMs: Date.UTC(2027, 0, 10), endAtMs: Date.UTC(2027, 0, 14) };
    expect(exchangeProblems(m, late, m.events).join('; ')).toMatch(/seasonal horse/);
  });

  it('paid lint: no product, banner, mission or reward may name event points', () => {
    const products = [...m.products.slice(0, 1).map((p) => ({ ...p, eventPoints: 100 })), ...m.products.slice(1)] as never;
    expect(eventPointSourceProblems({ ...m, products }).join('; ')).toMatch(/products\[0\]\.eventPoints/);
    const items = [{ itemId: 'event_points', qty: 100 }];
    expect(eventPointSourceProblems({ ...m, events: [{ ...ev, milestones: [{ points: 100, reward: { items } }] }] }).join('; ')).toMatch(/not an item/);
    // the same check runs on remote config
    expect(() => resolveBundle(m, { events: [...m.events, { ...ev, id: 'x_cup', rankRewards: [{ maxRank: null, reward: { exchangePoints: 5 } }] }] as never })).toThrow(/event points/);
  });

  it('remote config: an exchange is validated with the event (and may be replaced)', () => {
    expect(resolveBundle(m, { events: m.events as never }).master.events.find((e) => e.id === ev.id)!.exchange!.items).toHaveLength(ex.items.length);
    expect(() => resolveBundle(m, { events: m.events.map((e) => (e.id === ev.id ? withEx({ items: [{ ...line('ex_coins_50'), price: 0 }] }) : e)) as never })).toThrow(/price/);
  });
});

describe('earning points (REQ-EXCH-004)', () => {
  it('fixed by place + participation, capped per game day, reset at 04:00 JST', () => {
    const s = freshPlayer();
    expect(earnExchangePoints(m, ev, s, 1, DURING)).toMatchObject({ gained: 40, capped: false, points: 40, remainingToday: 110 });
    expect(earnExchangePoints(m, ev, s, 12, DURING)!.gained).toBe(14);
    expect(earnExchangePoints(m, ev, s, 0, DURING)!.gained).toBe(10); // DNF/unknown place: participation only
    for (let i = 0; i < 2; i++) earnExchangePoints(m, ev, s, 1, DURING);
    const capped = earnExchangePoints(m, ev, s, 1, DURING)!;
    expect(capped).toMatchObject({ gained: 6, capped: true, remainingToday: 0 }); // 144 → 150
    expect(earnExchangePoints(m, ev, s, 1, DURING)!.gained).toBe(0);
    // next game day starts at 04:00 JST: DURING is 03:00 JST, so one hour later the cap is fresh
    expect(earnExchangePoints(m, ev, s, 1, DURING + 3600_000)!.gained).toBe(40);
    expect(pts(s)).toBe(190);
  });

  it('applyRace credits points once per race (KPI event_point_earn); a void race and a ranked race earn none', async () => {
    const repo = new MemoryPlayerRepo();
    const kpi: KpiRecord[] = [];
    const svc = new PlayerService(repo, { master: m, rng: seededRng(3), clock: () => DURING, verifiers: {}, onKpi: (_id, r) => { kpi.push(...r); } });
    await svc.bootstrap('p1');
    const res = { raceId: 'r1', mode: 'event' as const, eventId: ev.id, place: 3, fieldSize: 12, newRating: null, void: false, humans: 2 };
    const a = await svc.applyRace('p1', res);
    await svc.applyRace('p1', res);
    expect(a.event?.exchange).toMatchObject({ gained: 31, points: 31 });
    await svc.applyRace('p1', { ...res, raceId: 'rv', void: true });
    await svc.applyRace('p1', { ...res, raceId: 'rr', mode: 'ranked', eventId: undefined } as never);
    expect(pts((await repo.get('p1'))!)).toBe(31);
    expect(kpi.filter((k) => k.name === 'event_point_earn')).toHaveLength(1);
  });

  it('no points after the exchange closed', () => {
    const s = freshPlayer();
    expect(earnExchangePoints(m, ev, s, 1, CLOSES)!.gained).toBe(0);
  });
});

describe('buying (REQ-EXCH-008)', () => {
  it('fixed price, per-event stock, points checked before anything moves', () => {
    const s = freshPlayer();
    give(s, 300);
    const free0 = s.wallet.free;
    const r = buyExchange(m, ev, s, 'ex_coins_50', 2, DURING, 'c:k1');
    expect(r).toMatchObject({ qty: 2, spent: 300, remaining: 0, granted: { freeCoins: 100 } });
    expect(s.wallet.free).toBe(free0 + 100);
    expect(s.wallet.paid).toBe(0); // never paid coins
    expect(code(() => buyExchange(m, ev, s, 'ex_coins_50', 1, DURING, 'c:k2'))).toBe('OUT_OF_STOCK');
    expect(code(() => buyExchange(m, ev, s, 'ex_material', 1, DURING, 'c:k3'))).toBe('INSUFFICIENT_POINTS');
    expect(code(() => buyExchange(m, ev, s, 'nope', 1, DURING, 'c:k4'))).toBe('NOT_FOUND');
    expect(code(() => buyExchange(m, ev, s, 'ex_material', 0, DURING, 'c:k5'))).toBe('BAD_REQUEST');
    // each coin unit is its own grant (≤ ¥200 per grant)
    expect(s.ledger.filter((l) => l.ref.startsWith('c:k1')).map((l) => [l.currency, l.delta])).toEqual([['free', 50], ['free', 50]]);
  });

  it('the horse is a named template (non-random), stock 1; a cosmetic already owned is refused', () => {
    const s = freshPlayer();
    give(s, 1100);
    const horses = s.horses.length;
    buyExchange(m, ev, s, 'ex_hatsuyuki', 1, DURING, 'c:h');
    expect(s.horses.length).toBe(horses + 1);
    expect(s.horses.at(-1)!.templateId).toBe('t_hatsuyuki');
    expect(code(() => buyExchange(m, ev, s, 'ex_hatsuyuki', 1, DURING, 'c:h2'))).toBe('OUT_OF_STOCK');
    s.items.decor_flower_box = 1;
    expect(code(() => buyExchange(m, ev, s, 'ex_flower_box', 1, DURING, 'c:f'))).toBe('ALREADY_PURCHASED');
    expect(pts(s)).toBeGreaterThanOrEqual(200); // nothing was taken by the refused buy
  });

  it('open before the start? no; during grace yes; after the close no', () => {
    const s = freshPlayer();
    give(s, 200);
    expect(code(() => buyExchange(m, ev, s, 'ex_material', 1, ev.startAtMs - 1, 'c:a'))).toBe('EXCHANGE_NOT_OPEN');
    expect(code(() => buyExchange(m, ev, s, 'ex_material', 1, ev.endAtMs + 3600_000, 'c:b'))).toBe('ok');
    expect(code(() => buyExchange(m, ev, s, 'ex_material', 1, CLOSES, 'c:c'))).toBe('EXCHANGE_CLOSED');
  });

  it('service: idempotency key required, a resent key returns the same result without paying twice, KPI exchange_buy', async () => {
    let now = DURING;
    const repo = new MemoryPlayerRepo();
    const kpi: KpiRecord[] = [];
    const svc = new PlayerService(repo, { master: m, rng: seededRng(3), clock: () => now, verifiers: {}, onKpi: (_id, r) => { kpi.push(...r); } });
    await svc.bootstrap('p1');
    for (let i = 0; i < 3; i++) await svc.applyRace('p1', { raceId: `r${i}`, mode: 'event', eventId: ev.id, place: 1, fieldSize: 12, newRating: null, void: false, humans: 2 });
    expect(await acode(svc.exchangeBuy('p1', ev.id, 'ex_material', 1, null))).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const a = await svc.exchangeBuy('p1', ev.id, 'ex_material', 1, 'c:x1');
    const b = await svc.exchangeBuy('p1', ev.id, 'ex_material', 1, 'c:x1');
    expect(b).toEqual(a);
    expect(a.points).toBe(0);
    expect(a.exchange.items.find((x) => x.id === 'ex_material')).toMatchObject({ bought: 1, remaining: 2 });
    expect(kpi.filter((k) => k.name === 'exchange_buy')).toHaveLength(1);
    // two different keys racing for the last points: the second is refused (one transaction at a time in the PlayerDO)
    now += 24 * 3600_000;
    for (let i = 0; i < 3; i++) await svc.applyRace('p1', { raceId: `q${i}`, mode: 'event', eventId: ev.id, place: 1, fieldSize: 12, newRating: null, void: false, humans: 2 });
    const both = await Promise.allSettled([svc.exchangeBuy('p1', ev.id, 'ex_material', 1, 'c:y1'), svc.exchangeBuy('p1', ev.id, 'ex_material', 1, 'c:y2')]);
    const st = (await repo.get('p1'))!;
    expect(st.events![ev.id]!.exchange!.bought.ex_material).toBe(2);
    expect(both.filter((x) => x.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
  });

  it('refused while the account deletion runs', async () => {
    const repo = new MemoryPlayerRepo();
    const svc = new PlayerService(repo, { master: m, rng: seededRng(3), clock: () => DURING, verifiers: {} });
    await svc.bootstrap('p1');
    const s = (await repo.get('p1'))!;
    give(s, 200);
    s.deletion = { status: 'deleting', steps: [] } as never;
    await repo.put(s);
    expect(await acode(svc.exchangeBuy('p1', ev.id, 'ex_material', 1, 'c:d'))).toBe('DELETION_PENDING');
  });
});

describe('after the event (REQ-EXCH-005/006)', () => {
  it('leftover points become ceil(points / 100) breeding material once, at the close — shown before it', () => {
    const s = freshPlayer();
    give(s, 130);
    const before = exchangeView(m, ev, s, ev.endAtMs + 1);
    expect(before.status).toBe('grace');
    expect(before.leftover).toMatchObject({ itemId: 'breeding_material', pointsPerUnit: 100, rounding: 'up', preview: 2, converted: null });
    expect(settleExchanges(m, s, CLOSES - 1)).toEqual([]);
    const mat = s.items.breeding_material ?? 0;
    expect(settleExchanges(m, s, CLOSES)).toEqual([{ eventId: ev.id, points: 130, itemId: 'breeding_material', qty: 2 }]);
    expect(s.items.breeding_material).toBe(mat + 2);
    expect(settleExchanges(m, s, CLOSES + 1)).toEqual([]); // once
    expect(exchangeView(m, ev, s, CLOSES).status).toBe('closed');
    expect(exchangeView(m, ev, s, CLOSES).leftover.converted).toMatchObject({ points: 130, qty: 2 });
    expect(leftoverQty(1, 100)).toBe(1);
    expect(leftoverQty(0, 100)).toBe(0);
  });

  it('converts even if the event was removed from config afterwards (stored rule)', () => {
    const s = freshPlayer();
    give(s, 40);
    const gone: Pick<Master, 'events' | 'progression'> = { ...m, events: m.events.filter((e) => e.id !== ev.id) };
    expect(settleExchanges(gone, s, CLOSES)[0]).toMatchObject({ qty: 1 });
  });

  it('the service converts on the player’s next call (view or any transaction)', async () => {
    let now = DURING;
    const repo = new MemoryPlayerRepo();
    const svc = new PlayerService(repo, { master: m, rng: seededRng(3), clock: () => now, verifiers: {} });
    await svc.bootstrap('p1');
    await svc.applyRace('p1', { raceId: 'r', mode: 'event', eventId: ev.id, place: 1, fieldSize: 12, newRating: null, void: false, humans: 2 });
    now = CLOSES + 5;
    const v = await svc.exchangeView('p1', ev.id);
    expect(v.status).toBe('closed');
    expect(v.leftover.converted).toMatchObject({ points: 40, qty: 1 });
    expect((await repo.get('p1'))!.items.breeding_material).toBeGreaterThanOrEqual(1);
  });
});

describe('views and HTTP (REQ-EXCH-009/010)', () => {
  it('GET shows stock, points, today’s cap and real instants only', () => {
    const s = freshPlayer();
    earnExchangePoints(m, ev, s, 1, DURING);
    const v = exchangeView(m, ev, s, DURING);
    expect(v).toMatchObject({ status: 'open', points: 40, closesAtMs: CLOSES, graceDays: 3, earn: { dailyCap: 150, earnedToday: 40, remainingToday: 110 } });
    expect(v.earn.resetsAtMs).toBe(ev.startAtMs + 4 * 3600_000); // 2027-01-01 04:00 JST
    expect(v.items.find((x) => x.id === 'ex_coins_50')).toMatchObject({ stock: 2, bought: 0, remaining: 2, affordable: false, maxQty: 0 });
    expect(v.rules).toEqual({ purchasable: false, random: false, completionReward: false, sources: ['event_race'] });
  });

  it('the event list carries the point counter; an event stays listed while its exchange is open', async () => {
    const repo = new MemoryPlayerRepo();
    let now = DURING;
    const svc = new PlayerService(repo, { master: m, rng: seededRng(3), clock: () => now, verifiers: {} });
    await svc.bootstrap('p1');
    const list = (await svc.eventsView('p1')) as { id: string; exchange: { points: number; status: string } | null }[];
    expect(list.find((e) => e.id === ev.id)!.exchange).toMatchObject({ points: 0, status: 'open' });
    expect(list.find((e) => e.id === 'sprint_cup_2026_11')?.exchange ?? null).toBeNull();
    now = CLOSES - 1;
    expect(((await svc.eventsView('p1')) as { id: string }[]).some((e) => e.id === ev.id)).toBe(true);
  });

  it('HTTP: GET and POST /v1/events/:eventId/exchange', async () => {
    const repo = new MemoryPlayerRepo();
    const svc = new PlayerService(repo, { master: m, rng: seededRng(3), clock: () => DURING, verifiers: {} });
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
    const c = { master: m, authenticate: async (req: Request) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; }, player: () => invoker, clock: () => DURING } as unknown as AppContext;
    const call = async (method: string, path: string, o: { body?: unknown; idem?: string } = {}) => {
      const res = await handle(new Request(`https://x${path}`, { method, headers: { 'content-type': 'application/json', 'x-test-user': 'p1', ...(o.idem ? { 'idempotency-key': o.idem } : {}) }, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) }), {}, c);
      return { status: res.status, body: (await res.json()) as any };
    };
    await svc.bootstrap('p1');
    for (let i = 0; i < 3; i++) await svc.applyRace('p1', { raceId: `r${i}`, mode: 'event', eventId: ev.id, place: 1, fieldSize: 12, newRating: null, void: false, humans: 2 });
    const g = await call('GET', `/v1/events/${ev.id}/exchange`);
    expect(g.status).toBe(200);
    expect(g.body.points).toBe(120);
    expect((await call('POST', `/v1/events/${ev.id}/exchange`, { body: { itemId: 'ex_material' } })).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await call('POST', `/v1/events/${ev.id}/exchange`, { body: { itemId: 'ex_material', extra: 1 }, idem: 'k' })).status).toBe(400);
    const ok = await call('POST', `/v1/events/${ev.id}/exchange`, { body: { itemId: 'ex_material', qty: 1 }, idem: 'k1' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ itemId: 'ex_material', qty: 1, spent: 120, points: 0 });
    expect((await call('POST', `/v1/events/${ev.id}/exchange`, { body: { itemId: 'ex_material' }, idem: 'k2' })).body.error.code).toBe('INSUFFICIENT_POINTS');
    expect((await call('GET', '/v1/events/BAD!/exchange')).status).toBe(400);
    expect((await call('GET', '/v1/events/sprint_cup_2026_11/exchange')).status).toBe(404);
  });
});
