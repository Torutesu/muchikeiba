import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { newPlayer } from '../src/domain/player.js';
import { admitClientBatch, BLOB, clientBatchSchema, DOUBLE, hashPlayerId, kpiRecord, toDataPoint, type KpiRecord } from '../src/domain/kpi.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { makeKpiWriter } from '../src/push/analytics.js';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { AppError } from '../src/domain/errors.js';

/** 2026-11-05 12:00 JST */
const NOON = Date.UTC(2026, 10, 5, 3);
const DAY = 86_400_000;

function setup() {
  let now = NOON;
  const recs: { id: string; r: KpiRecord }[] = [];
  const store = new FakeStoreVerifier();
  const svc = new PlayerService(new MemoryPlayerRepo(), {
    master: m, rng: seededRng(5), clock: () => now, verifiers: { fake: store },
    onKpi: (id, rs) => { for (const r of rs) recs.push({ id, r }); },
  });
  return { svc, store, recs, names: () => recs.map((x) => x.r.name), setNow: (t: number) => { now = t; }, now: () => now };
}

describe('server events (REQ-KPI-002)', () => {
  it('first_open is emitted once, with cohort and day 0', async () => {
    const { svc, recs } = setup();
    await svc.bootstrap('p1');
    await svc.bootstrap('p1');
    const fo = recs.filter((x) => x.r.name === 'first_open');
    expect(fo).toHaveLength(1);
    expect(fo[0]!.r).toMatchObject({ source: 'server', cohortDay: '2026-11-05', eventDay: '2026-11-05', daysSinceInstall: 0, payer: false });
  });

  it('purchase marks the first real purchase and turns later events into payer rows; refund is negative revenue', async () => {
    const { svc, store, recs, now } = setup();
    await svc.bootstrap('p1');
    await svc.setAge('p1', 1990, 1, false);
    await svc.purchase('p1', 'fake', 'coin_1500', store.issue({ transactionId: 'T1', productId: 'coin_1500', purchasedAt: now(), priceYen: 1500 }));
    await svc.purchase('p1', 'fake', 'coin_1500', store.issue({ transactionId: 'T1', productId: 'coin_1500', purchasedAt: now(), priceYen: 1500 })); // duplicate
    await svc.purchase('p1', 'fake', 'coin_160', store.issue({ transactionId: 'T2', productId: 'coin_160', purchasedAt: now(), priceYen: 160 }));
    const purchases = recs.filter((x) => x.r.name === 'purchase').map((x) => x.r);
    expect(purchases).toHaveLength(2);
    expect(purchases[0]).toMatchObject({ s1: 'coin_1500', s2: 'fake', amountYen: 1500, isFirst: true, payer: true });
    expect(purchases[1]).toMatchObject({ isFirst: false });
    await svc.draw('p1', 'standard', 10, 'c:d1');
    const g = recs.find((x) => x.r.name === 'gacha_draw')!.r;
    expect(g).toMatchObject({ s1: 'standard', count: 10, payer: true });
    expect((g.paidCoins ?? 0) + (g.freeCoins ?? 0)).toBe(1000);
    await svc.refund('p1', 'T2');
    expect(recs.find((x) => x.r.name === 'refund')!.r).toMatchObject({ amountYen: -160 });
  });

  it('race_finish carries mode, place and humans; void races are not counted', async () => {
    const { svc, names, recs } = setup();
    await svc.applyRace('p1', { raceId: 'r1', mode: 'ranked', place: 2, fieldSize: 12, newRating: null, void: false, humans: 3, details: { trackId: 'kirameki_turf_2000', style: 'sashi', finishTick: 1800, startReactionTicks: 1, whips: 4, whipSpam: false } as never });
    await svc.applyRace('p1', { raceId: 'r2', mode: 'ranked', place: 1, fieldSize: 12, newRating: null, void: true });
    expect(names().filter((n) => n === 'race_finish')).toHaveLength(1);
    expect(recs.find((x) => x.r.name === 'race_finish')!.r).toMatchObject({ s1: 'ranked', s2: 'sashi', s3: 'kirameki_turf_2000', place: 2, count: 12, value: 3, durationMs: 90_000 });
  });

  it('events from a failed transaction are not emitted', async () => {
    const { svc, names } = setup();
    await expect(svc.draw('p1', 'standard', 10, 'c:x')).rejects.toMatchObject({ code: 'INSUFFICIENT_COINS' });
    expect(names()).not.toContain('gacha_draw');
  });
});

describe('record shape and privacy (REQ-KPI-001/005)', () => {
  it('counts install days in JST', () => {
    const s = newPlayer('p', Date.UTC(2026, 10, 5, 14, 59), '2026-11'); // 23:59 JST on 11-05
    const r = kpiRecord(s, Date.UTC(2026, 10, 5, 15, 1), { name: 'x' }); // 00:01 JST on 11-06
    expect(r).toMatchObject({ cohortDay: '2026-11-05', eventDay: '2026-11-06', daysSinceInstall: 1 });
    expect(kpiRecord(s, Date.UTC(2026, 10, 5, 15, 1) + 6 * DAY, { name: 'x' }).daysSinceInstall).toBe(7);
  });

  it('maps fields to fixed Analytics Engine columns with the hashed player as index', async () => {
    const s = newPlayer('player-1', NOON, '2026-11');
    const r = kpiRecord(s, NOON, { name: 'purchase', s1: 'coin_1500', amountYen: 1500, isFirst: true });
    const h = await hashPlayerId('salt', 'player-1');
    const p = toDataPoint(r, h);
    expect(p.indexes).toEqual([h]);
    expect(p.blobs[BLOB.event - 1]).toBe('purchase');
    expect(p.blobs[BLOB.player - 1]).toBe(h);
    expect(p.blobs[BLOB.s1 - 1]).toBe('coin_1500');
    expect(p.blobs[BLOB.payer - 1]).toBe('nonpayer');
    expect(p.doubles[DOUBLE.amountYen - 1]).toBe(1500);
    expect(p.doubles[DOUBLE.isFirst - 1]).toBe(1);
    expect(p.blobs.join('|')).not.toContain('player-1');
  });

  it('hash is stable per salt and differs across salts', async () => {
    expect(await hashPlayerId('a', 'p')).toBe(await hashPlayerId('a', 'p'));
    expect(await hashPlayerId('a', 'p')).not.toBe(await hashPlayerId('b', 'p'));
    expect(await hashPlayerId('a', 'p')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('writer is disabled without binding or salt, and writes hashed rows otherwise', async () => {
    expect(makeKpiWriter(undefined, 'salt')).toBeNull();
    const rows: unknown[] = [];
    expect(makeKpiWriter({ writeDataPoint: (x) => { rows.push(x); } }, undefined)).toBeNull();
    const w = makeKpiWriter({ writeDataPoint: (x) => { rows.push(x); } }, 'salt')!;
    await w('p1', [kpiRecord(newPlayer('p1', NOON, '2026-11'), NOON, { name: 'first_open' })]);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('p1"');
  });
});

describe('client ingestion (REQ-KPI-003/004)', () => {
  const batch = (n: number, at = NOON) => ({ platform: 'ios' as const, appVersion: '1.0.0', events: Array.from({ length: n }, (_, i) => ({ name: 'tutorial_step' as const, at, props: { step: `s${i}`, index: i } })) });

  it('accepts only client-observable events with valid props', () => {
    expect(clientBatchSchema.safeParse(batch(3)).success).toBe(true);
    expect(clientBatchSchema.safeParse({ ...batch(1), events: [{ name: 'purchase', at: NOON, props: {} }] }).success).toBe(false);
    expect(clientBatchSchema.safeParse({ ...batch(1), events: [{ name: 'screen_view', at: NOON, props: { screen: 'a b' } }] }).success).toBe(false);
    expect(clientBatchSchema.safeParse(batch(51)).success).toBe(false);
  });

  it('rate-limits per minute and per day, and drops events outside the time window', () => {
    const s = newPlayer('p', NOON, '2026-11');
    expect(admitClientBatch(s, { ...batch(2), events: [...batch(1).events, { name: 'session_start', at: NOON - 8 * DAY }] }, NOON)).toHaveLength(1);
    for (let i = 1; i < 30; i++) admitClientBatch(s, batch(1), NOON);
    expect(() => admitClientBatch(s, batch(1), NOON)).toThrow(/too many/);
    expect(admitClientBatch(s, batch(1), NOON + 60_000)).toHaveLength(1); // next minute
    const day = newPlayer('q', NOON, '2026-11');
    for (let i = 0; i < 40; i++) admitClientBatch(day, batch(50), NOON + i * 60_000);
    expect(() => admitClientBatch(day, batch(50), NOON + 41 * 60_000)).toThrow(/daily/);
  });

  it('POST /v1/analytics/events enriches client events and emits them', async () => {
    const recs: KpiRecord[] = [];
    const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(3), clock: () => NOON, verifiers: {}, onKpi: (_id, rs) => { recs.push(...rs); } });
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
    const ctx = {
      master: m, authenticate: async (req: Request) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
      player: () => invoker, friends: makeFriendsService(() => invoker, new MemoryDirectory()), adminToken: undefined,
    } as unknown as AppContext;
    const post = (body: unknown, user = 'u1') => handle(new Request('https://x/v1/analytics/events', { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': user }, body: JSON.stringify(body) }), {}, ctx);
    const ok = await post({ platform: 'android', appVersion: '1.2.3', events: [{ name: 'session_end', at: NOON - 1000, props: { durationMs: 420_000 } }, { name: 'race_start', at: NOON, props: { mode: 'offline' } }] });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ accepted: 2, dropped: 0 });
    expect(recs.map((r) => [r.name, r.source, r.platform, r.appVersion])).toEqual([['session_end', 'client', 'android', '1.2.3'], ['client_race_start', 'client', 'android', '1.2.3']]);
    expect(recs[0]).toMatchObject({ durationMs: 420_000, at: NOON - 1000 });
    expect((await post({ platform: 'ios', appVersion: '1', events: [{ name: 'gacha_draw', at: NOON }] })).status).toBe(400);
  });
});
