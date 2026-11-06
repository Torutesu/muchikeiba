import { describe, expect, it } from 'vitest';
import { m, makeConfig } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { shopProducts } from '../src/domain/shop.js';
import { handle, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { RaceRoomCore, CMD } from '../src/domain/raceRoom.js';
import { driveSettlement, newSettleMeta, type SettleDeps } from '../src/race/settlement.js';
import type { PlayerState } from '../src/domain/player.js';

const JST = 9 * 3600_000;
const jst = (y: number, mo: number, d: number, h = 12) => Date.UTC(y, mo - 1, d, h) - JST;

function world(start = jst(2026, 11, 5)) {
  let now = start;
  const store = new FakeStoreVerifier();
  const repo = new MemoryPlayerRepo();
  const svc = new PlayerService(repo, { master: m, rng: seededRng(7), clock: () => now, verifiers: { fake: store } });
  let tx = 0;
  const buy = async (id: string, productId: string) => {
    const p = m.products.find((x) => x.id === productId)!;
    await svc.purchaseIntent(id, productId);
    return svc.purchase(id, 'fake', productId, store.issue({ transactionId: `T${tx++}`, productId, purchasedAt: now, priceYen: p.priceYen }));
  };
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const c = {
    master: m, clock: () => now, player: () => invoker,
    authenticate: async (req: Request) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
  } as unknown as AppContext;
  const get = async (path: string, user?: string) => {
    const res = await handle(new Request(`https://x${path}`, { headers: user ? { 'x-test-user': user } : {} }), {}, c);
    return { status: res.status, body: (await res.json()) as any };
  };
  return { svc, repo, buy, get, at: (t: number) => { now = t; } };
}

describe('r10 fix: /v1/shop/products says whether this season\'s pass (or a once-only pack) is already bought', () => {
  it('anonymous catalog is unchanged (no per-player fields)', async () => {
    const w = world();
    const r = await w.get('/v1/shop/products');
    expect(r.status).toBe(200);
    expect(r.body.personalized).toBe(false);
    expect(r.body.products[0]).not.toHaveProperty('owned');
    expect(r.body).toEqual(JSON.parse(JSON.stringify(shopProducts(m))));
  });

  it('?mine=1 needs auth and adds owned / purchasedThisSeason per product', async () => {
    const w = world();
    expect((await w.get('/v1/shop/products?mine=1')).status).toBe(401);
    await w.svc.bootstrap('p');
    await w.svc.setAge('p', 1990, 1, false);
    let r = await w.get('/v1/shop/products?mine=1', 'p');
    expect(r.body).toMatchObject({ personalized: true, seasonId: '2026-11' });
    const by = (b: any) => Object.fromEntries(b.products.map((p: any) => [p.id, p]));
    expect(by(r.body).season_pass).toMatchObject({ owned: false, purchasedThisSeason: false, ownedReason: null });
    expect(by(r.body).coin_160).toMatchObject({ owned: false, purchasedThisSeason: null });

    await w.buy('p', 'season_pass');
    r = await w.get('/v1/shop/products?mine=1', 'p');
    // one pass per season: buying Pass also closes Pass+ (purchase-intent refuses both with ALREADY_PURCHASED)
    expect(by(r.body).season_pass).toMatchObject({ owned: true, purchasedThisSeason: true, ownedReason: 'season_pass' });
    expect(by(r.body).season_pass_plus).toMatchObject({ owned: true, purchasedThisSeason: false, ownedReason: 'season_pass' });
    await expect(w.svc.purchaseIntent('p', 'season_pass_plus')).rejects.toMatchObject({ code: 'ALREADY_PURCHASED' });
    expect(by(r.body).coin_160.owned).toBe(false); // consumables are never "owned"

    // the next season the pass is buyable again
    w.at(jst(2026, 12, 2));
    r = await w.get('/v1/shop/products?mine=1', 'p');
    expect(r.body.seasonId).toBe('2026-12');
    expect(by(r.body).season_pass).toMatchObject({ owned: false, purchasedThisSeason: false });
  });

  it('once-only packs and a running daily pack are owned too (same rules as purchase-intent)', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await w.svc.setAge('p', 1990, 1, false);
    await w.buy('p', 'starter_pack');
    await w.buy('p', 'stable_allowance_30d');
    const r = await w.get('/v1/shop/products?mine=1', 'p');
    const by = Object.fromEntries(r.body.products.map((p: any) => [p.id, p]));
    expect(by.starter_pack).toMatchObject({ owned: true, ownedReason: 'once' });
    expect(by.stable_allowance_30d).toMatchObject({ owned: true, ownedReason: 'allowance' });
    // every product the view calls owned is refused by purchase-intent, and vice versa for ALREADY_PURCHASED
    for (const p of r.body.products) {
      const code = await w.svc.purchaseIntent('p', p.id).then(() => 'OK', (e: AppError) => e.code);
      if (p.owned) expect(code).toBe('ALREADY_PURCHASED');
      else expect(code).not.toBe('ALREADY_PURCHASED');
    }
  });
});

describe('r10 fix: race results for a player whose account deletion is running are an ACKed no-op', () => {
  async function deleting(w: ReturnType<typeof world>, id: string) {
    await w.svc.bootstrap(id);
    const t = (await w.svc.requestDeletion(id, null)) as { confirmToken: string };
    await w.svc.requestDeletion(id, t.confirmToken);
    await w.svc.deletionStart(id);
  }

  it('applyRace resolves (ACK) without touching the deleting player; a scheduled (not yet running) deletion still applies', async () => {
    const w = world();
    await deleting(w, 'gone');
    const before = w.repo.get('gone') as PlayerState;
    const out = await w.svc.applyRace('gone', { raceId: 'r1', mode: 'ranked', place: 1, fieldSize: 12, newRating: null, void: false, humans: 2 });
    expect(out).toMatchObject({ skipped: 'deletion_pending' });
    const after = w.repo.get('gone') as PlayerState;
    expect(after.stats).toEqual(before.stats);
    expect(after.season).toEqual(before.season);
    expect(after.wallet).toEqual(before.wallet);
    expect(after.appliedRaces?.r1).toBeUndefined();
    // retried by the room: still a no-op ACK
    expect(await w.svc.applyRace('gone', { raceId: 'r1', mode: 'ranked', place: 1, fieldSize: 12, newRating: null, void: false, humans: 2 })).toMatchObject({ skipped: 'deletion_pending' });

    await w.svc.bootstrap('sched');
    const t = (await w.svc.requestDeletion('sched', null)) as { confirmToken: string };
    await w.svc.requestDeletion('sched', t.confirmToken); // scheduled: the account keeps working
    const r = await w.svc.applyRace('sched', { raceId: 'r2', mode: 'ranked', place: 1, fieldSize: 12, newRating: null, void: false, humans: 2 });
    expect(r).not.toHaveProperty('skipped');
    expect((w.repo.get('sched') as PlayerState).appliedRaces?.r2).toBeDefined();
  });

  it('after the wipe a late race result is an ACKed no-op: it never recreates the deleted player (tombstone)', async () => {
    const w = world();
    await deleting(w, 'wiped');
    await w.svc.wipe('wiped'); // the deletion run's last step
    expect(w.repo.get('wiped')).toBeNull();
    expect(w.repo.tombstoned('wiped')).toBe(true);
    const race = { raceId: 'late1', mode: 'ranked' as const, place: 1, fieldSize: 12, newRating: null, void: false, humans: 2 };
    expect(await w.svc.applyRace('wiped', race)).toMatchObject({ skipped: 'deleted', raceId: 'late1' });
    expect(w.repo.get('wiped')).toBeNull();
    // the room retries: still a no-op ACK, still no state
    expect(await w.svc.applyRace('wiped', race)).toMatchObject({ skipped: 'deleted' });
    expect(w.repo.get('wiped')).toBeNull();
    // a player that simply has no state yet (no tombstone) still gets the race applied, as before
    const r = await w.svc.applyRace('fresh', { ...race, raceId: 'f1' });
    expect(r).not.toHaveProperty('skipped');
    expect((w.repo.get('fresh') as PlayerState).appliedRaces?.f1).toBeDefined();
  });

  it('the Durable Object storage wipe leaves only a tombstone row behind (SqlPlayerRepo)', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { SqlPlayerRepo, wipePlayerStorage } = await import('../src/do/sqlRepo.js');
    const db = new DatabaseSync(':memory:');
    const sql = {
      exec: (q: string, ...args: unknown[]) => {
        const st = db.prepare(q);
        const rows = /^\s*select/i.test(q) ? (st.all(...(args as never[])) as unknown[]) : (st.run(...(args as never[])), []);
        return { toArray: () => rows };
      },
    } as unknown as SqlStorage;
    const storage = { sql, deleteAll: async () => { for (const t of ['state', 'ledger', 'deleted']) db.exec(`DROP TABLE IF EXISTS ${t}`); } } as unknown as DurableObjectStorage;
    const repo = new SqlPlayerRepo(sql);
    const w = world();
    await w.svc.bootstrap('dob');
    repo.put(w.repo.get('dob') as PlayerState);
    expect(repo.tombstoned('dob')).toBe(false);
    await wipePlayerStorage(storage, 'dob');
    expect(repo.get('dob')).toBeNull();
    expect(repo.tombstoned('dob')).toBe(true);
    expect(repo.tombstoned('other')).toBe(false);
  });

  it('the room settles everyone else normally and neither retries nor dead-letters the deleting player', async () => {
    const w = world();
    const H = (ch: string) => ch.repeat(64);
    const cfg = makeConfig(2, 'ranked');
    const r = new RaceRoomCore(cfg, 0, { verifySampleRate: 0, resultWaitMs: 1, rng: seededRng(1) });
    const at = (t: number) => (t + 1) * 50;
    for (const s of r.humanSlots) r.hello(s, -1, 0);
    for (let t = 0; t <= r.minResultTick + 20; t += 20) {
      for (const s of r.humanSlots) r.message(s, { t: 'ping', c: 0 }, at(t));
      r.advance(at(t));
      if (t === 60) r.message(r.humanSlots[0]!, { t: 'in', tick: 62, cmd: CMD.START }, at(t));
    }
    for (const s of r.humanSlots) r.message(s, { t: 'res', h: H('a'), order: [0, 1] }, at(r.minResultTick + 20));
    const [p0, p1] = r.humanSlots.map((s) => r.config.entrants[s]!.playerId!) as [string, string];
    await deleting(w, p0);
    await w.svc.bootstrap(p1);
    const meta = newSettleMeta({});
    const d: SettleDeps = {
      verify: async () => { throw new Error('unused'); }, putReplay: async () => {}, raceFinished: async () => {}, persist: async () => {},
      applyRace: async (pid, res) => { await w.svc.applyRace(pid, res); },
    };
    const res = await driveSettlement(r, meta, d, 0);
    expect(res.retryAt).toBeNull();
    expect(meta).toMatchObject({ settled: true, pending: [], settleAttempts: 0 });
    expect(meta.deadLetter ?? []).toEqual([]);
    expect((w.repo.get(p1) as PlayerState).stats.races).toBe(1);
    expect((w.repo.get(p0) as PlayerState).stats.races).toBe(0);
  });
});
