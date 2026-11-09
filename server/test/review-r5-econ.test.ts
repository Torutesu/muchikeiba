// Regression tests for the round-5 money/progression review findings.
import { describe, expect, it } from 'vitest';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { applyEventResult } from '../src/domain/events.js';
import { EventsService, type EventPlayers } from '../src/domain/eventService.js';
import { grantFree } from '../src/domain/wallet.js';
import { createHorseFromTemplate } from '../src/domain/horses.js';
import type { PlayerState } from '../src/domain/player.js';
import { m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 5, 3); // inside sprint_cup_2026_11
const sprint = m.events.find((e) => e.id === 'sprint_cup_2026_11')!;
const acode = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as AppError).code; } };

describe('event fee regressions (review r5 #1, #2)', () => {
  function setup() {
    const repo = new MemoryPlayerRepo();
    const svc = new PlayerService(repo, { master: m, rng: seededRng(9), clock: () => NOW, verifiers: {} });
    let fail: string | null = null;
    const players: EventPlayers = {
      raceEntry: (u, h) => svc.raceEntry(u, h), enter: (u, e, h, k) => svc.eventEnter(u, e, h, k),
      cancel: (u, e, id) => svc.eventCancel(u, e, id), view: (u) => svc.eventsView(u),
    };
    const es = new EventsService(() => m, players, {
      enqueue: async () => { if (fail) throw new AppError(fail as never); return { state: 'queued' }; },
      cancel: async () => ({ state: 'none' }),
    }, { board: async () => ({}), rankOf: async () => null }, () => NOW);
    return { repo, svc, es, setFail: (f: string | null) => { fail = f; } };
  }
  async function seed(repo: MemoryPlayerRepo, svc: PlayerService) {
    await svc.bootstrap('p1');
    const s = (await repo.get('p1')) as PlayerState;
    const h = createHorseFromTemplate(s, m.templates[0]!, NOW);
    grantFree(s, 100, NOW, 'g', 'g');
    await repo.put(s);
    return h.id;
  }
  // REQ-BOX-001: ops grants arrive in the gift box; what was granted = wallet + unclaimed box coins
  const free = async (repo: MemoryPlayerRepo) => { const s = (await repo.get('p1')) as PlayerState; return s.wallet.free + (s.giftBox?.box ?? []).reduce((a, e) => a + (e.contents.freeCoins ?? 0), 0); };

  it('#1 resending the same Idempotency-Key after the race settled charges the fee again', async () => {
    const { repo, svc, es } = setup();
    const hid = await seed(repo, svc);
    await es.enqueue('p1', sprint.id, hid, 'c:same');
    expect(await free(repo)).toBe(70);
    const s = (await repo.get('p1')) as PlayerState;
    applyEventResult(sprint, s, { raceId: 'r1', place: 1, void: false }, NOW);
    await repo.put(s);
    await es.enqueue('p1', sprint.id, hid, 'c:same');
    expect(await free(repo)).toBe(40);
  });

  it('#2 a refused re-enqueue while the held entry backs a live race does not refund that fee', async () => {
    const { repo, svc, es, setFail } = setup();
    const hid = await seed(repo, svc);
    await es.enqueue('p1', sprint.id, hid, 'c:a');
    expect(await free(repo)).toBe(70);
    setFail('ALREADY_IN_RACE');
    expect(await acode(es.enqueue('p1', sprint.id, hid, 'c:b'))).toBe('ALREADY_IN_RACE');
    expect(await free(repo)).toBe(70);
    expect(((await repo.get('p1')) as PlayerState).events![sprint.id]!.pending).not.toBeNull();
  });
});

describe('season pass entitlement per subscription (review r5 #6)', () => {
  const DAY = 86_400_000;
  it('an iOS subscription expiring does not cut a pass paid through Android', async () => {
    const { applyVerifiedPurchase, applySubscriptionStatus } = await import('../src/domain/purchase.js');
    const { freshPlayer } = await import('./helpers.js');
    const s = freshPlayer();
    applyVerifiedPurchase(m, s, 'apple', { transactionId: 'apple:1', productId: 'season_pass', purchasedAt: NOW, priceYen: 1000, originalTransactionId: 'apple:A', expiresAt: NOW + 30 * DAY }, NOW);
    applyVerifiedPurchase(m, s, 'google', { transactionId: 'google:2', productId: 'season_pass', purchasedAt: NOW, priceYen: 1000, originalTransactionId: 'google:sub:T', expiresAt: NOW + 54 * DAY }, NOW);
    expect(s.seasonPass.expiresAt).toBe(NOW + 54 * DAY);
    applySubscriptionStatus(m, s, 'apple', 'apple:A', 'expired', NOW + 30 * DAY, NOW + 30 * DAY);
    expect(s.seasonPass.expiresAt).toBe(NOW + 54 * DAY);
    applySubscriptionStatus(m, s, 'google', 'google:sub:T', 'revoked', null, NOW + 31 * DAY);
    expect(s.seasonPass.expiresAt).toBe(NOW + 31 * DAY);
  });
});

describe('sandbox purchases (review r5 #7)', () => {
  it('credit free coins only: no paid lot, no paidOnly spending, no debt settlement, no bonus; refund claws back', async () => {
    const { applyVerifiedPurchase, applyRefund } = await import('../src/domain/purchase.js');
    const { spend } = await import('../src/domain/wallet.js');
    const { freshPlayer } = await import('./helpers.js');
    const s = freshPlayer();
    s.wallet.debt = 500; // real refund debt outstanding
    applyVerifiedPurchase(m, s, 'apple', { transactionId: 'apple:sb1', productId: 'coin_1500', purchasedAt: NOW, priceYen: 0, sandbox: true }, NOW);
    expect(s.wallet.paid).toBe(0);
    expect(s.wallet.lots).toHaveLength(0);
    expect(s.wallet.debt).toBe(500);
    expect(s.wallet.free).toBe(1020);
    expect(s.firstPurchased).not.toContain('coin_1500');
    expect(() => spend(s, 100, { paidOnly: true }, NOW, 'x', 'x')).toThrow();
    s.wallet.debt = 0;
    applyRefund(m, s, 'apple:sb1', NOW);
    expect(s.wallet.free).toBe(0);
  });
});

describe('config guards (review r5 #8, #9)', () => {
  it('#8 a pity group that closes cannot back a permanent banner; convertTo cycles are rejected', async () => {
    const { resolveBundle } = await import('../src/ops/config.js');
    const { pityGroupProblems } = await import('../src/domain/gacha.js');
    const end = Date.UTC(2026, 11, 1);
    const pityGroups = { ...m.gacha.pityGroups, pickup: { cost: 100, endAtMs: end, convertTo: 'standard' } };
    expect(() => resolveBundle(m, { gacha: { pityGroups } } as never)).toThrow(/banner outlives its pity group/);
    expect(pityGroupProblems({ pityGroups: { a: { cost: 1, endAtMs: 1, convertTo: 'b' }, b: { cost: 1, endAtMs: 1, convertTo: 'a' } } })).toHaveLength(2);
    expect(pityGroupProblems(m.gacha)).toEqual([]);
  });

  it('#9 progression and event reward overrides are shape-checked', async () => {
    const { resolveBundle } = await import('../src/ops/config.js');
    const bad = (progression: Record<string, unknown>) => () => resolveBundle(m, { progression } as never);
    expect(bad({ loginBonus: [] })).toThrow(/loginBonus: must not be empty/);
    expect(bad({ passRewards: { ...m.progression.passRewards, free: { ...m.progression.passRewards.free, every: 0 } } })).toThrow(/every: must be ≥ 1/);
    expect(bad({ loginBonus: m.progression.loginBonus.map((d) => JSON.parse(JSON.stringify(d).replace(/:(\d+)/g, ':-$1'))) })).toThrow(/negative/);
    expect(() => resolveBundle(m, { progression: { loginBonus: m.progression.loginBonus } } as never)).not.toThrow();
    const ev = structuredClone(m.events[0]!);
    ev.milestones[0]!.points = -5;
    expect(() => resolveBundle(m, { events: [ev] } as never)).toThrow(/negative/);
  });
});

describe('minor (review r5)', () => {
  it('pity cannot be exchanged while refund debt is open', async () => {
    const { exchangePity } = await import('../src/domain/gacha.js');
    const { freshPlayer } = await import('./helpers.js');
    const s = freshPlayer();
    const b = m.gacha.banners.find((x) => x.id === 'standard')!;
    s.pity[b.pityGroup] = 1000;
    s.wallet.debt = 10;
    expect(() => exchangePity(m, s, b.id, b.pityTargets[0]!, NOW)).toThrow(/UNSETTLED_DEBT/);
  });

  it('a limit breach blocks the month it was purchased in, not the month it was granted', async () => {
    const { applyVerifiedPurchase, checkPurchaseIntent, registerAge } = await import('../src/domain/purchase.js');
    const { freshPlayer } = await import('./helpers.js');
    const s = freshPlayer();
    const oct31 = Date.UTC(2026, 9, 31, 14, 59); // 2026-10-31 23:59 JST
    const nov1 = Date.UTC(2026, 9, 31, 15, 30); // 2026-11-01 00:30 JST
    registerAge(m, s, 2012, 1, true, oct31);
    applyVerifiedPurchase(m, s, 'fake', { transactionId: 'big', productId: 'coin_10000', purchasedAt: oct31, priceYen: 10000 }, nov1);
    expect(s.purchases[0]!.limitBreach).toBe(true);
    // November starts clean: the breach was October's
    expect(() => checkPurchaseIntent(m, s, 'coin_160', nov1)).not.toThrow();
  });
});

describe('admin grant op keys (review r5 #4, #5)', () => {
  function setup() {
    const repo = new MemoryPlayerRepo();
    const svc = new PlayerService(repo, { master: m, rng: seededRng(3), clock: () => NOW, verifiers: {} });
    return { repo, svc };
  }
  // REQ-BOX-001: ops grants arrive in the gift box; what was granted = wallet + unclaimed box coins
  const free = async (repo: MemoryPlayerRepo) => { const s = (await repo.get('p1')) as PlayerState; return s.wallet.free + (s.giftBox?.box ?? []).reduce((a, e) => a + (e.contents.freeCoins ?? 0), 0); };

  it('#4 an opKey never grants twice, even after the idempotency cache evicted it', async () => {
    const { repo, svc } = setup();
    await svc.bootstrap('p1');
    await svc.adminGrant('p1', { freeCoins: 1000 }, 'outage', 'ops', 'op-1');
    expect(await free(repo)).toBe(1000);
    const s = (await repo.get('p1')) as PlayerState;
    s.idem = []; // what ~200 later keyed operations do to the cache
    await repo.put(s);
    await svc.adminGrant('p1', { freeCoins: 1000 }, 'outage', 'ops', 'op-1');
    expect(await free(repo)).toBe(1000);
  });

  it('#5 bulk per-recipient keys never collide with single-grant keys', async () => {
    const { bulkOpKey } = await import('../src/http/admin.js');
    const { repo, svc } = setup();
    await svc.bootstrap('p1');
    await svc.adminGrant('p1', { freeCoins: 100 }, 'single', 'ops', 'B:p1');
    await svc.adminGrant('p1', { freeCoins: 100 }, 'bulk', 'ops', bulkOpKey('B', 'p1'));
    expect(await free(repo)).toBe(200);
    expect(bulkOpKey('B', 'p1')).not.toMatch(/^[A-Za-z0-9_.:-]{4,100}$/);
  });
});
