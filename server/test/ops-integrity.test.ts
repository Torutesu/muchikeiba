import { describe, expect, it } from 'vitest';
import { IntegrityCore, MemoryIntegrityRepo, scoreOf, statusOf } from '../src/ops/integrity.js';
import { assertMayRace, MatchmakerCore } from '../src/domain/matchmaker.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { integrityReport } from '../src/race/settlement.js';
import { memoryOps } from '../src/ops/memoryOps.js';
import { createHorseFromTemplate } from '../src/domain/horses.js';
import type { PlayerInvoker } from '../src/http/app.js';
import { m, makeConfig } from './helpers.js';

const T = Date.UTC(2026, 10, 10);
const DAY = 86_400_000;
const race = (id: string, at: number, suspects: string[], desync: string[] = [], mode: 'ranked' | 'friend' | 'tutorial' = 'ranked') => ({ raceId: id, mode, at, suspects, desync });

describe('automatic quarantine (REQ-OPS-030/031)', () => {
  it('weights suspects and desync in a rolling window; idempotent per race; tutorial ignored', () => {
    const repo = new MemoryIntegrityRepo();
    const c = new IntegrityCore(repo);
    expect(c.recordRace(race('r1', T, ['bad']))).toEqual([]);
    expect(c.recordRace(race('r1', T, ['bad']))).toEqual([]); // same race again
    expect(c.recordRace(race('t1', T, ['bad'], [], 'tutorial'))).toEqual([]);
    c.recordRace(race('r2', T + 1, [], ['bad'])); // desync = 0.5
    expect(scoreOf(repo.player('bad')!, T + 2)).toBe(1.5);
    c.recordRace(race('r3', T + 2, ['bad']));
    expect(statusOf(repo.player('bad'), T + 3)).toBe('ok'); // 2.5
    const ch = c.recordRace(race('r4', T + 3, ['bad']));
    expect(ch).toEqual([{ playerId: 'bad', status: 'quarantined', until: T + 3 + 14 * DAY, reason: 'automatic quarantine' }]);
    expect(statusOf(repo.player('bad'), T + 14 * DAY + 2)).toBe('quarantined');
    expect(statusOf(repo.player('bad'), T + 14 * DAY + 3)).toBe('ok'); // expires
  });

  it('old flags fall out of the window', () => {
    const repo = new MemoryIntegrityRepo();
    const c = new IntegrityCore(repo);
    c.recordRace(race('a', T, ['x']));
    c.recordRace(race('b', T + 1, ['x']));
    expect(c.recordRace(race('c', T + 8 * DAY, ['x']))).toEqual([]);
    expect(scoreOf(repo.player('x')!, T + 8 * DAY)).toBe(1);
  });

  it('admin release, ban and unban; bans outrank quarantine', () => {
    const repo = new MemoryIntegrityRepo();
    const c = new IntegrityCore(repo);
    for (let i = 0; i < 3; i++) c.recordRace(race(`q${i}`, T + i, ['p']));
    expect(c.view('p', T + 5).status).toBe('quarantined');
    expect(c.ban('p', null, 'aimbot confirmed by replay', 'admin', T + 6).status).toBe('banned');
    expect(c.view('p', T + 7).status).toBe('banned');
    expect(c.unban('p', 'appeal accepted', 'admin', T + 8).status).toBe('quarantined');
    expect(c.release('p', 'router issue', 'operator', T + 9).status).toBe('ok');
    expect(c.view('p', T + 10).score).toBe(0);
    expect(() => c.release('p', 'again', 'op', T + 11)).toThrow(/not quarantined/);
    expect(() => c.ban('p', T, 'past', 'admin', T + 12)).toThrow(/future/);
    expect(c.view('p', T + 13).notes.map((n) => n.action)).toEqual(['quarantine', 'ban', 'unban', 'release']);
    expect(c.list('flagged', T + 13)).toHaveLength(0);
  });

  it('player reports go to a review queue (deduplicated) and never quarantine by themselves', () => {
    const repo = new MemoryIntegrityRepo();
    const c = new IntegrityCore(repo);
    const r1 = c.addReport('race9', 'u1', T);
    expect(c.addReport('race9', 'u1', T + 5).id).toBe(r1.id);
    c.addReport('race9', 'u2', T + 6);
    expect(c.reports('open')).toHaveLength(2);
    expect(c.resolveReport(r1.id, 'no foul play', 'operator', T + 7).status).toBe('resolved');
    expect(c.reports('open')).toHaveLength(1);
    expect(c.list('quarantined', T + 8)).toHaveLength(0);
  });
});

describe('settlement → integrity report', () => {
  it('maps suspect and desync slots to player ids; nothing to report for a clean race', () => {
    const cfg = makeConfig(3, 'ranked', 9, 4);
    const clean = { config: cfg, desyncSlots: [] as number[], final: { status: 'confirmed' as const, order: [], hash: '', via: 'consensus' as const, suspects: [] as number[] } };
    expect(integrityReport(clean, T)).toBeNull();
    const humans = cfg.entrants.filter((e) => e.kind === 'human');
    const r = integrityReport({ ...clean, desyncSlots: [humans[1]!.slot], final: { ...clean.final, suspects: [humans[0]!.slot] } }, T)!;
    expect(r).toMatchObject({ raceId: cfg.raceId, mode: 'ranked', suspects: [humans[0]!.playerId], desync: [humans[1]!.playerId] });
  });
});

describe('quarantine and bans in matchmaking and purchases (REQ-OPS-032/033)', () => {
  it('quarantined players are matched only with each other (or CPU)', () => {
    const mm = new MatchmakerCore<null>({ maxPlayers: 4, cpuFillAfterMs: 15_000, baseWindow: 1000, widenPerSec: 0, maxWindow: 1000 });
    mm.enqueue({ playerId: 'a', rating: 1500, beginner: false, enqueuedAt: 0, payload: null });
    mm.enqueue({ playerId: 'q1', rating: 1500, beginner: false, enqueuedAt: 0, payload: null, quarantined: true });
    mm.enqueue({ playerId: 'b', rating: 1500, beginner: false, enqueuedAt: 0, payload: null });
    mm.enqueue({ playerId: 'q2', rating: 1500, beginner: false, enqueuedAt: 0, payload: null, quarantined: true });
    const matches = mm.tick(15_000);
    const groups = matches.map((x) => ({ ids: x.players.map((p) => p.playerId).sort(), q: x.quarantined, cpu: x.cpuCount }));
    expect(groups).toEqual(expect.arrayContaining([{ ids: ['a', 'b'], q: false, cpu: 2 }, { ids: ['q1', 'q2'], q: true, cpu: 2 }]));
    expect(() => assertMayRace({ moderation: 'banned' })).toThrow(/racing is disabled/);
    expect(() => assertMayRace({ moderation: 'quarantined' })).not.toThrow();
  });

  it('a ban reaches the player: no purchase intent, ranked entry carries the status, paid receipts still credit with a flag', async () => {
    const now = T;
    const store = new FakeStoreVerifier();
    const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(2), clock: () => now, verifiers: { fake: store } });
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
    const ops = memoryOps(m, () => invoker);
    await svc.setAge('p', 1990, 1, false);
    await svc.tx('p', null, (s) => { s.horses.push(createHorseFromTemplate(s, m.templates[0]!, now)); });
    const horseId = (await svc.view('p')).horses[0]!.id;
    expect((await svc.raceEntry('p', horseId)).moderation).toBe('ok');

    for (let i = 0; i < 3; i++) await ops.api.integrity.recordRace(race(`r${i}`, now, ['p']));
    expect((await svc.raceEntry('p', horseId)).moderation).toBe('quarantined');
    await expect(svc.purchaseIntent('p', 'coin_1500')).resolves.toBeTruthy(); // quarantine does not block purchases

    await ops.api.integrity.ban('p', null, 'cheat tool', 'admin', now);
    expect((await svc.raceEntry('p', horseId)).moderation).toBe('banned');
    await expect(svc.purchaseIntent('p', 'coin_1500')).rejects.toMatchObject({ code: 'BANNED', status: 403 });
    await svc.purchase('p', 'fake', 'coin_1500', store.issue({ transactionId: 'TB', productId: 'coin_1500', purchasedAt: now, priceYen: 1500 }));
    const s = await svc.state('p');
    expect(s.wallet.paid).toBeGreaterThan(0);
    expect(s.supportFlags).toContain('purchase_while_banned:TB');

    await ops.api.integrity.unban('p', 'appeal', 'admin', now);
    expect((await svc.raceEntry('p', horseId)).moderation).toBe('quarantined');
  });
});
