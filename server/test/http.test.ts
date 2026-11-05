import { describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from 'jose';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { verifyFirebaseIdToken } from '../src/http/auth.js';
import { signTicket, verifyTicket } from '../src/http/ticket.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { createRace, settleRace } from '../src/race/orchestrate.js';
import { m } from './helpers.js';

function ctx(): { c: AppContext; svc: PlayerService; store: FakeStoreVerifier; enq: unknown[] } {
  const store = new FakeStoreVerifier();
  const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(3), clock: () => Date.UTC(2026, 10, 5, 3), verifiers: { fake: store } });
  const enq: unknown[] = [];
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const c: AppContext = {
    master: m,
    authenticate: async (req) => {
      const u = req.headers.get('x-test-user');
      if (!u) throw new AppError('UNAUTHORIZED');
      return u;
    },
    player: () => invoker,
    match: {
      enqueue: async (p, e) => { enq.push([p, e]); return { state: 'queued' }; },
      cancel: async () => ({}), status: async () => ({ state: 'none' }), friendCreate: async () => ({}), friendJoin: async () => ({}),
      friendStart: async () => ({}), tutorial: async () => ({}), friendMember: async (pass) => pass === '123456',
    },
    friends: makeFriendsService(() => invoker, new MemoryDirectory()),
    leaderboard: { board: async (season, board) => ({ season, board }), myRank: async (p, season) => ({ p, season }) },
    clock: () => Date.UTC(2026, 10, 5, 3),
    race: { websocket: async () => new Response(null, { status: 200 }), report: async () => ({ ok: true }), replay: async () => ({}) },
    paidBalance: async () => ({ totalPaidYen: 0 }),
    adminToken: 'admintoken',
    parseStoreNotification: async () => null,
  };
  return { c, svc, store, enq };
}

const req = (method: string, path: string, opts: { user?: string; body?: unknown; idem?: string; headers?: Record<string, string> } = {}) =>
  new Request(`https://x${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.user ? { 'x-test-user': opts.user } : {}), ...(opts.idem ? { 'idempotency-key': opts.idem } : {}), ...opts.headers },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });

describe('HTTP API', () => {
  it('health, auth, 404, 405', async () => {
    const { c } = ctx();
    expect(await (await handle(req('GET', '/v1/health'), {}, c)).json()).toEqual({ ok: true });
    const unauth = await handle(req('GET', '/v1/player'), {}, c);
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    expect((await handle(req('GET', '/v1/nope'), {}, c)).status).toBe(404);
    expect((await handle(req('DELETE', '/v1/player'), {}, c)).status).toBe(405);
  });
  it('validates bodies and requires idempotency keys', async () => {
    const { c } = ctx();
    const bad = await handle(req('PUT', '/v1/player/age', { user: 'u', body: { birthYear: 'x' } }), {}, c);
    expect(bad.status).toBe(400);
    const noKey = await handle(req('POST', '/v1/gacha/standard/draw', { user: 'u', body: { count: 10 } }), {}, c);
    expect(await noKey.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
    const badCount = await handle(req('POST', '/v1/gacha/standard/draw', { user: 'u', body: { count: 5 }, idem: 'k' }), {}, c);
    expect(badCount.status).toBe(400);
  });
  it('end-to-end: age → intent → purchase → odds → draw → enqueue', async () => {
    const { c, store, enq } = ctx();
    await handle(req('PUT', '/v1/player/age', { user: 'u', body: { birthYear: 1990, birthMonth: 1, guardianConsent: false } }), {}, c);
    const intent = await handle(req('POST', '/v1/shop/purchase-intent', { user: 'u', body: { productId: 'coin_10000' } }), {}, c);
    expect(intent.status).toBe(200);
    const receipt = store.issue({ transactionId: 'T', productId: 'coin_10000', purchasedAt: 0, priceYen: 10000 });
    const p = await (await handle(req('POST', '/v1/shop/purchase', { user: 'u', body: { platform: 'fake', productId: 'coin_10000', receipt } }), {}, c)).json() as { wallet: { paid: number } };
    expect(p.wallet.paid).toBe(7400);
    const odds = await (await handle(req('GET', '/v1/gacha/standard/odds'), {}, c)).json() as { items: unknown[] };
    expect(odds.items.length).toBeGreaterThan(0);
    const d = await (await handle(req('POST', '/v1/gacha/standard/draw', { user: 'u', body: { count: 10 }, idem: 'd1' }), {}, c)).json() as { results: { horseId: string | null }[] };
    const horseId = d.results.find((r) => r.horseId)!.horseId!;
    const q = await handle(req('POST', '/v1/match/enqueue', { user: 'u', body: { horseId } }), {}, c);
    expect(await q.json()).toEqual({ state: 'queued' });
    expect(enq).toHaveLength(1);
    const err = await handle(req('POST', '/v1/gacha/nope/draw', { user: 'u', body: { count: 1 }, idem: 'x' }), {}, c);
    expect(err.status).toBe(404);
  });
  it('admin endpoints need the admin token; ws route needs upgrade', async () => {
    const { c } = ctx();
    expect((await handle(req('GET', '/v1/admin/paid-balance'), {}, c)).status).toBe(401);
    expect((await handle(req('GET', '/v1/admin/paid-balance', { headers: { authorization: 'Bearer admintoken' } }), {}, c)).status).toBe(200);
    expect((await handle(req('GET', '/v1/race/r1/ws'), {}, c)).status).toBe(400);
    expect((await handle(req('GET', '/v1/race/r1/ws', { headers: { upgrade: 'websocket' } }), {}, c)).status).toBe(200);
  });
});

describe('Firebase ID token verification (REQ-API-001)', () => {
  it('accepts a valid token and rejects wrong audience / expired / bad signature', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
    const keys = createLocalJWKSet({ keys: [jwk] });
    const sign = (claims: Record<string, unknown>, aud = 'proj', exp = '1h') =>
      new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(`https://securetoken.google.com/${aud}`).setAudience(aud).setSubject('uid123').setIssuedAt().setExpirationTime(exp).sign(privateKey);
    expect(await verifyFirebaseIdToken(await sign({}), 'proj', keys)).toBe('uid123');
    await expect(verifyFirebaseIdToken(await sign({}, 'other'), 'proj', keys)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(verifyFirebaseIdToken(await sign({}, 'proj', '-1m'), 'proj', keys)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const { privateKey: other } = await generateKeyPair('RS256');
    const forged = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer('https://securetoken.google.com/proj').setAudience('proj').setSubject('x').setExpirationTime('1h').sign(other);
    await expect(verifyFirebaseIdToken(forged, 'proj', keys)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('race tickets and orchestration', () => {
  it('tickets bind race, slot and expiry', async () => {
    const t = await signTicket({ raceId: 'r1', slot: 3, playerId: 'p', exp: 1000 }, 'secret');
    expect(await verifyTicket(t, 'secret', 'r1', 999)).toMatchObject({ slot: 3, playerId: 'p' });
    await expect(verifyTicket(t, 'secret', 'r2', 999)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(verifyTicket(t, 'secret', 'r1', 1001)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(verifyTicket(t, 'wrong', 'r1', 999)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(verifyTicket(t.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A')), 'secret', 'r1', 999)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it('creates a ranked race with the lowest class cap and settles ratings/places', async () => {
    const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(1), clock: () => 0, verifiers: {} });
    const entries = [];
    for (const p of ['a', 'b']) {
      const d = await svc.tutorialDraw(p, 'c:t');
      entries.push(await svc.raceEntry(p, d.results.find((r) => r.horseId)!.horseId!));
    }
    entries[1] = { ...entries[1]!, statCap: 2000 };
    const created = await createRace(m, { mode: 'ranked', humans: entries, cpuCount: 10, cpuLevel: 3, rng: seededRng(5), now: 0, ticketSecret: 's' });
    for (const e of created.config.entrants) expect(e.horse.speed + e.horse.stamina + e.horse.burst + e.horse.guts + e.horse.temper).toBeLessThanOrEqual(2000);
    const sa = created.assignments.a!;
    const sb = created.assignments.b!;
    expect(await verifyTicket(sa.ticket, 's', created.config.raceId, 1)).toMatchObject({ slot: sa.slot, playerId: 'a' });
    const cpuSlots = created.config.entrants.filter((e) => e.kind === 'cpu').map((e) => e.slot);
    const res = settleRace(created.config, { status: 'confirmed', order: [sb.slot, ...cpuSlots, sa.slot], hash: 'h', via: 'consensus', suspects: [] }, created.ratings);
    expect(res.b).toMatchObject({ place: 1, void: false });
    expect(res.a).toMatchObject({ place: 12 });
    expect(res.b!.newRating!.r).toBeGreaterThan(res.a!.newRating!.r);
    const v = settleRace(created.config, { status: 'void', order: [], hash: '', via: 'none', suspects: [] }, created.ratings);
    expect(v.a).toMatchObject({ void: true });
  });
});
