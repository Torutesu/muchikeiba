import { describe, expect, it } from 'vitest';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { m } from './helpers.js';
import type { PaidBalanceSnapshot } from '../src/domain/accounting.js';

function setup(start = Date.UTC(2026, 10, 5, 3)) {
  let now = start;
  const repo = new MemoryPlayerRepo();
  const store = new FakeStoreVerifier();
  const snaps: PaidBalanceSnapshot[] = [];
  const svc = new PlayerService(repo, { master: m, rng: seededRng(11), clock: () => now, verifiers: { fake: store }, onPaidBalance: (s) => { snaps.push(s); } });
  return { svc, repo, store, snaps, setNow: (t: number) => { now = t; }, now: () => now };
}

describe('PlayerService', () => {
  it('purchase → gacha → retry with same idempotency key returns the same result without charging twice', async () => {
    const { svc, store, snaps, now } = setup();
    await svc.setAge('p1', 1990, 5, false);
    await svc.purchaseIntent('p1', 'coin_1500');
    const tok = store.issue({ transactionId: 'T1', productId: 'coin_1500', purchasedAt: now(), priceYen: 1500 });
    const p1 = await svc.purchase('p1', 'fake', 'coin_1500', tok);
    expect(p1.wallet).toMatchObject({ paid: 1020, free: 1020 });
    const again = await svc.purchase('p1', 'fake', 'coin_1500', tok);
    expect(again.wallet).toEqual(p1.wallet);
    const d1 = await svc.draw('p1', 'standard', 10, 'c:k1');
    const d2 = await svc.draw('p1', 'standard', 10, 'c:k1');
    expect(d2).toEqual(d1);
    const v = await svc.view('p1');
    expect(v.wallet).toMatchObject({ paid: 20, free: 1020 });
    expect(snaps.at(-1)).toMatchObject({ playerId: 'p1', paidCoins: 20 });
  });
  it('a failing operation leaves state untouched (atomic)', async () => {
    const { svc, repo } = setup();
    await svc.bootstrap('p1');
    const before = repo.data.get('p1');
    await expect(svc.draw('p1', 'standard', 10, 'c:k')).rejects.toMatchObject({ code: 'INSUFFICIENT_COINS' });
    expect(repo.data.get('p1')).toBe(before);
  });
  it('requires idempotency keys on mutating endpoints', async () => {
    const { svc } = setup();
    await expect(svc.draw('p1', 'standard', 1, null)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  });
  it('tutorial draw, naming, login bonus, missions, pass, race results', async () => {
    const { svc, setNow, now } = setup();
    const t = await svc.tutorialDraw('p1', 'c:tut');
    expect(t.results).toHaveLength(10);
    const horseId = t.results.find((r) => r.horseId)!.horseId!;
    await svc.nameHorse('p1', horseId, 'あおぞらまーち');
    const lb = await svc.claimLogin('p1', 'c:lb1');
    expect(lb.day).toBe(1);
    await expect(svc.claimLogin('p1', 'c:lb2')).rejects.toMatchObject({ code: 'ALREADY_CLAIMED' });
    setNow(now() + 86400000);
    expect((await svc.claimLogin('p1', 'c:lb3')).day).toBe(2);
    for (let i = 0; i < 5; i++) await svc.applyRace('p1', { raceId: `r${i}`, mode: 'ranked', place: i === 0 ? 1 : 4, fieldSize: 12, newRating: { r: 1510 + i, rd: 300, vol: 0.06 }, void: false });
    await svc.applyRace('p1', { raceId: 'r0', mode: 'ranked', place: 1, fieldSize: 12, newRating: null, void: false }); // duplicate ignored
    const missions = await svc.missions('p1');
    expect(missions.find((x) => x.id === 'race3')).toMatchObject({ progress: 3 });
    expect(missions.find((x) => x.id === 'win1')).toMatchObject({ progress: 1 });
    await svc.claimMission('p1', 'race3', 'c:m1');
    await expect(svc.claimMission('p1', 'top3x2', 'c:m2')).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
    const v = await svc.view('p1');
    expect(v.season.points).toBe(30 + 4 * 12);
    expect(v.rating.rankedRaces).toBe(5);
    const pass = await svc.passView('p1');
    expect(pass.level).toBe(1);
    await svc.claimPass('p1', 'free', 1, 'c:pf1');
    await expect(svc.claimPass('p1', 'premium', 1, 'c:pp1')).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
    const entry = await svc.raceEntry('p1', horseId);
    expect(entry).toMatchObject({ playerId: 'p1', classId: 'C', statCap: 2800, beginner: false });
    expect(entry.horse.name).toBe('アオゾラマーチ');
  });
  it('refund creates debt that blocks gacha', async () => {
    const { svc, store, now } = setup();
    await svc.setAge('p1', 1990, 5, false);
    const tok = store.issue({ transactionId: 'T9', productId: 'coin_1500', purchasedAt: now(), priceYen: 1500 });
    await svc.purchase('p1', 'fake', 'coin_1500', tok);
    await svc.draw('p1', 'standard', 10, 'c:g1');
    await svc.draw('p1', 'standard', 10, 'c:g2'); // uses remaining paid + free
    const r = await svc.refund('p1', 'T9');
    expect(r.debt).toBeGreaterThan(0);
    await expect(svc.draw('p1', 'standard', 1, 'c:g3')).rejects.toMatchObject({ code: 'UNSETTLED_DEBT' });
  });
});

describe('idempotency key namespaces (bug review #2)', () => {
  it('a client key can never collide with server-internal refund/race keys', async () => {
    const { clientIdemKey } = await import('../src/http/app.js');
    const req = new Request('http://x/v1/rewards/login-bonus', { method: 'POST', headers: { 'idempotency-key': 'refund:T_1' } });
    const k = clientIdemKey(req);
    expect(k).toBe('c:/v1/rewards/login-bonus:refund:T_1');
    expect(k.startsWith('refund:')).toBe(false);
  });
  it('the service refuses un-namespaced client keys', async () => {
    const { svc } = setup();
    await expect(svc.claimLogin('p9', 'refund:T_1')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
