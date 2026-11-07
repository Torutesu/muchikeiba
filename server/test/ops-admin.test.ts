import { describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { DEFAULT_RULESET } from '../src/domain/ruleset.js';
import { authenticateAdmin, type AdminAuthConfig, type RateLimitPolicy } from '../src/ops/admin.js';
import { sha256Hex } from '../src/ops/hash.js';
import { memoryOps } from '../src/ops/memoryOps.js';
import { m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 10, 3);
const TOKENS = { viewer: 'viewer-token-0123456789', operator: 'operator-token-0123456789', admin: 'admin-token-0123456789' };

async function setup(opts: { rate?: Record<'read' | 'write', RateLimitPolicy>; board?: { entries: { playerId: string }[]; total: number } } = {}) {
  let now = NOW;
  const store = new FakeStoreVerifier();
  const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(3), clock: () => now, verifiers: { fake: store } });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const ops = memoryOps(m, () => invoker, opts.rate ? { rate: opts.rate } : {});
  const auth: AdminAuthConfig = {
    tokens: await Promise.all((Object.keys(TOKENS) as (keyof typeof TOKENS)[]).map(async (role) => ({ name: role, role, sha256: await sha256Hex(TOKENS[role]) }))),
  };
  const c: AppContext = {
    master: m,
    authenticate: async (req) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
    player: () => invoker,
    match: { enqueue: async () => ({}), cancel: async () => ({}), status: async () => ({}), friendCreate: async () => ({}), friendJoin: async () => ({}), friendStart: async () => ({}), tutorial: async () => ({}), friendMember: async () => false },
    friends: makeFriendsService(() => invoker, new MemoryDirectory()),
    leaderboard: { board: async (season, board) => opts.board ?? { season, board, entries: [], total: 0 }, myRank: async () => ({}) },
    timeAttack: {} as AppContext['timeAttack'],
    clock: () => now,
    race: { websocket: async () => new Response(null), report: async () => ({ ok: true }), replay: async (id) => ({ raceId: id }) },
    paidBalance: async () => ({ totalPaidYen: 0 }),
    adminToken: undefined,
    parseStoreNotification: async () => null,
    ops: ops.api,
    authenticateAdmin: (req) => authenticateAdmin(req, auth),
    configInfo: async () => ({ versionId: 'base', hash: 'base', rulesetVersion: DEFAULT_RULESET.rulesetVersion, activatedAt: null }),
  };
  const call = async (role: keyof typeof TOKENS | null, method: string, path: string, body?: unknown) => {
    const res = await handle(new Request(`https://x${path}`, {
      method, headers: { 'content-type': 'application/json', ...(role ? { authorization: `Bearer ${TOKENS[role]}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }), {}, c);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { svc, store, ops, c, call, setNow: (t: number) => { now = t; }, auth };
}

describe('admin authentication and roles (REQ-OPS-010/011)', () => {
  it('hashed tokens map to roles; unknown tokens are rejected', async () => {
    const { call } = await setup();
    expect((await call('viewer', 'GET', '/v1/admin/whoami')).body).toMatchObject({ id: 'viewer', role: 'viewer', via: 'token' });
    expect((await call(null, 'GET', '/v1/admin/whoami')).status).toBe(401);
    const res = await handle(new Request('https://x/v1/admin/whoami', { headers: { authorization: 'Bearer nope-nope-nope-nope' } }), {}, (await setup()).c);
    expect(res.status).toBe(401);
  });

  it('roles are ordered: viewer cannot grant, operator cannot activate config', async () => {
    const { call, ops } = await setup();
    const r = await call('viewer', 'POST', '/v1/admin/players/p1/grants', { grant: { freeCoins: 10 }, opKey: 'comp-0001', reason: 'outage' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FORBIDDEN');
    const st = await call('operator', 'POST', '/v1/admin/config/versions', { bundle: { ruleset: { ...DEFAULT_RULESET, rulesetVersion: '2.1.0', maxWhips: 5 } }, note: 'n', reason: 'balance patch' });
    expect(st.status).toBe(200);
    const act = await call('operator', 'POST', '/v1/admin/config/activations', { versionId: st.body.version.id, reason: 'ship it' });
    expect(act.status).toBe(403);
    const ok = await call('admin', 'POST', '/v1/admin/config/activations', { versionId: st.body.version.id, reason: 'ship it' });
    expect(ok.status).toBe(200);
    // failed attempts are audited too
    expect(ops.audits.rows.filter((x) => x.result === 'error').map((x) => x.action)).toEqual(['player.grant', 'config.activate']);
  });

  it('Cloudflare Access JWTs map e-mails to roles', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k', alg: 'ES256' }] });
    const cfg: AdminAuthConfig = { tokens: [], access: { teamDomain: 'team.cloudflareaccess.com', audience: 'aud1', roles: { 'ops@example.com': 'operator' }, jwks } };
    const sign = (email: string, aud = 'aud1') => new SignJWT({ email }).setProtectedHeader({ alg: 'ES256', kid: 'k' }).setIssuer('https://team.cloudflareaccess.com').setAudience(aud).setExpirationTime('5m').sign(privateKey);
    const req = async (jwt: string) => new Request('https://x/v1/admin/whoami', { headers: { 'cf-access-jwt-assertion': jwt } });
    await expect(authenticateAdmin(await req(await sign('OPS@example.com')), cfg)).resolves.toEqual({ id: 'ops@example.com', role: 'operator', via: 'access' });
    await expect(authenticateAdmin(await req(await sign('who@example.com')), cfg)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(authenticateAdmin(await req(await sign('ops@example.com', 'other')), cfg)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('writes need a reason; admin calls are rate limited', async () => {
    const { call } = await setup({ rate: { read: { capacity: 3, refillPerSec: 0 }, write: { capacity: 1, refillPerSec: 0 } } });
    expect((await call('operator', 'POST', '/v1/admin/players/p1/grants', { grant: { freeCoins: 10 }, opKey: 'comp-0001' })).status).toBe(400);
    for (let i = 0; i < 3; i++) expect((await call('viewer', 'GET', '/v1/admin/whoami')).status).toBe(200);
    const limited = await call('viewer', 'GET', '/v1/admin/whoami');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect((await call('admin', 'GET', '/v1/admin/whoami')).status).toBe(200); // per principal
  });
});

describe('support tools (REQ-OPS-020..025)', () => {
  it('compensation grant: idempotent per opKey, capped by role, audited with before/after', async () => {
    const { call, svc, ops } = await setup();
    const body = { grant: { freeCoins: 500, items: [{ itemId: 'ticket_sr_plus', qty: 1 }] }, opKey: 'outage-2026-11-10', reason: 'server outage 11/10' };
    const a = await call('operator', 'POST', '/v1/admin/players/p1/grants', body);
    expect(a.status).toBe(200);
    expect((await call('operator', 'POST', '/v1/admin/players/p1/grants', body)).status).toBe(200);
    const v = await svc.view('p1');
    expect(v.wallet.free).toBe(500);
    expect(v.items.ticket_sr_plus).toBe(1);
    expect((await call('operator', 'POST', '/v1/admin/players/p1/grants', { ...body, opKey: 'big-one-0001', grant: { freeCoins: 50_000 } })).status).toBe(403);
    // REQ-OPS-026: over the operator limit needs two-person approval, even for an admin (POST /v1/admin/compensations)
    expect((await call('admin', 'POST', '/v1/admin/players/p1/grants', { ...body, opKey: 'big-one-0001', grant: { freeCoins: 50_000 } })).status).toBe(403);
    expect((await call('admin', 'POST', '/v1/admin/players/p1/grants', { ...body, opKey: 'big-one-0002', grant: { freeCoins: 10_000 } })).status).toBe(200);
    const audit = await call('viewer', 'GET', '/v1/admin/audit?target=player:p1&action=player.grant');
    const okRows = audit.body.entries.filter((e: { result: string }) => e.result === 'ok');
    expect(okRows).toHaveLength(3);
    expect(okRows[2]).toMatchObject({ actor: 'operator', reason: 'server outage 11/10', before: { free: 0 }, after: { free: 500 } });
    const ledger = (await svc.state('p1')).ledger.filter((l) => l.kind === 'grant');
    expect(ledger).toHaveLength(2);
    expect(ledger[0]!.reason).toMatch(/support grant by operator: server outage/);
    expect(ops.audits.rows.every((r) => r.at === NOW)).toBe(true);
  });

  it('bulk grant to a list or a leaderboard segment is idempotent per recipient and capped', async () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ playerId: `s${i}` }));
    const { call, svc } = await setup({ board: { entries, total: 5 } });
    const body = { grant: { freeCoins: 100 }, opKey: 'season-fix-01', reason: 'season reward fix' };
    const r1 = await call('operator', 'POST', '/v1/admin/grants/bulk', { ...body, segment: { kind: 'leaderboard', seasonId: '2026-10', board: 'class-A', offset: 0, limit: 3 } });
    expect(r1.body).toMatchObject({ granted: 3, failed: [], nextOffset: 3 });
    const r2 = await call('operator', 'POST', '/v1/admin/grants/bulk', { ...body, segment: { kind: 'leaderboard', seasonId: '2026-10', board: 'class-A', offset: 0, limit: 5 } });
    expect(r2.body).toMatchObject({ granted: 5, nextOffset: null });
    for (const e of entries) expect((await svc.view(e.playerId)).wallet.free).toBe(100); // s0..s2 not granted twice
    const tooMuch = await call('admin', 'POST', '/v1/admin/grants/bulk', { grant: { freeCoins: 100_000 }, opKey: 'oops-0001', reason: 'typo', playerIds: Array.from({ length: 11 }, (_, i) => `x${i}`) });
    expect(tooMuch.status).toBe(403);
    expect((await call('operator', 'POST', '/v1/admin/grants/bulk', { ...body, playerIds: ['a'], segment: { kind: 'leaderboard', seasonId: '2026-10', board: 'rating' } })).status).toBe(400);
  });

  it('debt write-off, age correction and name reset', async () => {
    const { call, svc, store } = await setup();
    await svc.setAge('p2', 1990, 1, false);
    const rec = store.issue({ transactionId: 'T1', productId: 'coin_1500', purchasedAt: NOW, priceYen: 1500 });
    await svc.purchase('p2', 'fake', 'coin_1500', rec);
    await svc.draw('p2', 'standard', 10, 'c:k1');
    const tx = (await svc.state('p2')).purchases[0]!.txId;
    await svc.refund('p2', tx);
    const debt = (await svc.view('p2')).wallet.debt;
    expect(debt).toBeGreaterThan(0);
    const settle = await call('operator', 'POST', '/v1/admin/players/p2/debt/settle', { coins: debt, opKey: 'debt-p2-01', reason: 'goodwill after duplicate charge' });
    expect(settle.status).toBe(200);
    expect(settle.body.after.debt).toBe(0);
    expect((await call('operator', 'POST', '/v1/admin/players/p2/debt/settle', { coins: 5, opKey: 'debt-p2-02', reason: 'again' })).body.error.code).toBe('CONFLICT');

    await svc.setAge('p3', 2012, 4, true);
    await expect(svc.setAge('p3', 1990, 4, false)).rejects.toMatchObject({ code: 'CONFLICT' }); // app path
    const age = await call('operator', 'PUT', '/v1/admin/players/p3/age', { birthYear: 1990, birthMonth: 4, guardianConsent: false, reason: 'ID checked by support' });
    expect(age.body).toMatchObject({ before: { birthYear: 2012 }, after: { birthYear: 1990 } });
    expect((await call('viewer', 'GET', '/v1/admin/players/p3')).body.state.supportFlags[0]).toMatch(/^age_corrected:/);

    await svc.setDisplayName('p3', 'ワルイナマエ');
    const nr = await call('operator', 'POST', '/v1/admin/players/p3/name-reset', { target: 'display', reason: 'offensive name report' });
    expect(nr.body.before).toBe('ワルイナマエ');
    expect((await svc.view('p3')).profile.displayName).toMatch(/^騎手/);
  });

  it('player lookup shows ledger, purchases, flags and integrity', async () => {
    const { call, svc } = await setup();
    await svc.claimLogin('p4', 'c:lb');
    const r = await call('viewer', 'GET', '/v1/admin/players/p4');
    expect(r.status).toBe(200);
    expect(r.body.state.ledger.length).toBeGreaterThan(0);
    expect(r.body.state).toHaveProperty('purchases');
    expect(r.body.state).not.toHaveProperty('idem');
    expect(r.body.integrity).toMatchObject({ status: 'ok', score: 0 });
  });
});

describe('config over the admin API and to clients (REQ-OPS-007)', () => {
  it('stage → schedule → list; invalid bundles are refused with the problems', async () => {
    const { call } = await setup();
    const bad = await call('operator', 'POST', '/v1/admin/config/versions', { bundle: { ruleset: { maxWhips: 9 } }, reason: 'x y z' });
    expect(bad.status).toBe(500 /* CONFIG_INVALID */);
    expect(bad.body.error.message).toMatch(/rulesetVersion was not changed/);
    const dry = await call('viewer', 'POST', '/v1/admin/config/validate', { bundle: { ruleset: { maxWhips: 9 } } });
    expect(dry.body.problems.length).toBe(1);
    const st = await call('operator', 'POST', '/v1/admin/config/versions', { bundle: { ruleset: { ...DEFAULT_RULESET, rulesetVersion: '2.1.0', maxWhips: 5 } }, reason: 'whip patch' });
    await call('admin', 'POST', '/v1/admin/config/activations', { versionId: st.body.version.id, at: NOW + 60_000, reason: 'maintenance window' });
    const list = await call('viewer', 'GET', '/v1/admin/config');
    expect(list.body.active.versionId).toBe('base');
    expect(list.body.pending).toHaveLength(1);
    expect((await handle(new Request('https://x/v1/config'), {}, (await setup()).c)).status).toBe(200);
  });
});
