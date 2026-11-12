// REQ-DEV-001..020: ログイン中の端末とセキュリティ (contracts/protocol.md §70).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handle, makeFriendsService, routes, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { DEFAULT_RULESET } from '../src/domain/ruleset.js';
import { authenticateAdmin, type AdminAuthConfig } from '../src/ops/admin.js';
import { sha256Hex as opsSha } from '../src/ops/hash.js';
import { memoryOps } from '../src/ops/memoryOps.js';
import { catalogFor, localize, untranslated } from '../src/i18n/catalog.js';
import { SessionGuard, transferConfig } from '../src/domain/transferCode.js';
import { MemoryTransferDirectory, TransferService, type CustomTokenSigner } from '../src/domain/transferService.js';
import { DEFAULT_MAINTENANCE, EXEMPT_ROUTES, endpointGroup, gateRequest, jstToMs, type MaintenanceConfig } from '../src/domain/maintenance.js';
import { DEFAULT_DEVICES, devicesProblems, providersOf, regionOf, sanitizeModel, SECURITY_EVENTS, SECURITY_TEXT, signOutAvailableAt } from '../src/domain/devices.js';
import { sessionRevoked } from '../src/domain/sessionRevocation.js';
import { KPI_EVENT_CLASS, kpiClassOf } from '../src/domain/kpiConsent.js';
import { clientEventSchema, clientToKpi, type KpiRecord } from '../src/domain/kpi.js';
import { ACTIVITY_META, activityText } from '../src/domain/activity.js';
import { buildExportDocument, classifyKey } from '../src/domain/dataExport.js';
import { helpArticle, helpOf } from '../src/domain/help.js';
import type { Master } from '../src/domain/master.js';
import { m } from './helpers.js';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const NOW = Date.UTC(2026, 10, 12, 3); // 12:00 JST
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TOKENS = { viewer: 'viewer-token-0123456789', operator: 'operator-token-0123456789', admin: 'admin-token-0123456789' };
const sec = (ms: number) => Math.floor(ms / 1000);
const fakeSigner: CustomTokenSigner = { sign: async (uid, now) => `ct.${uid}.${Math.floor(now / 1000)}` };

async function setup(opts: { master?: Master } = {}) {
  let now = NOW;
  const master = opts.master ?? m;
  const repo = new MemoryPlayerRepo();
  let puts = 0;
  const put = repo.put.bind(repo);
  repo.put = async (s) => { puts++; return put(s); };
  const kpi: { id: string; rec: KpiRecord }[] = [];
  const svc = new PlayerService(repo, { master, rng: seededRng(23), clock: () => now, verifiers: { fake: new FakeStoreVerifier() }, onKpi: (id, recs) => { for (const rec of recs) kpi.push({ id, rec }); } });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  // two isolates: the one serving the requests (A) and another one (B) that only learns through its 30 s cache
  const guardA = new SessionGuard((uid) => svc.sessionState(uid), () => now);
  const guardB = new SessionGuard((uid) => svc.sessionState(uid), () => now);
  const transfer = new TransferService({
    view: (u) => svc.transferView(u), checkIssue: (u) => svc.transferCheckIssue(u), issued: (u, c, mode) => svc.transferIssued(u, c, mode),
    revoke: (u, by) => svc.transferRevoke(u, by), progress: (u) => svc.transferProgress(u), redeemed: (u, c) => svc.transferRedeemed(u, c),
    noteFail: (u, r) => svc.transferFailed(u, r), admin: (u) => svc.adminTransfer(u),
    redeemReplay: (u, k) => svc.transferRedeemReplay(u, k), redeemRemember: (u, k, p, n) => svc.transferRedeemRemember(u, k, p, n),
  }, new MemoryTransferDirectory(), () => transferConfig(master), fakeSigner, { clock: () => now, iterations: 1000, limitSalt: 'salt', onRedeemed: (u, c) => guardA.note(u, c) });
  const ops = memoryOps(master, () => invoker);
  const auth: AdminAuthConfig = { tokens: await Promise.all((Object.keys(TOKENS) as (keyof typeof TOKENS)[]).map(async (name) => ({ name, role: name, sha256: await opsSha(TOKENS[name]) }))) };
  const session = (req: Request) => {
    const u = req.headers.get('x-test-user');
    if (!u) throw new AppError('UNAUTHORIZED');
    const t = req.headers.get('x-test-auth');
    const ids = req.headers.get('x-test-identities');
    return { uid: u, authTime: t === null ? sec(now) : t === 'none' ? null : Number(t), ...(ids !== null ? { identities: Object.fromEntries(ids.split(',').filter(Boolean).map((x) => [x, []])) } : {}) };
  };
  let isolate: 'A' | 'B' = 'A';
  const c: AppContext = {
    master,
    authenticate: async (req) => session(req).uid,
    authenticateSession: async (req) => session(req),
    sessionGuard: (uid, at) => (isolate === 'A' ? guardA : guardB).check(uid, at),
    sessionForget: (uid) => guardA.forget(uid),
    player: () => invoker,
    match: {} as AppContext['match'],
    friends: makeFriendsService(() => invoker, new MemoryDirectory()),
    leaderboard: { board: async () => ({ entries: [], total: 0 }), myRank: async () => ({}) },
    timeAttack: {} as AppContext['timeAttack'],
    clock: () => now,
    race: { websocket: async () => new Response(null), report: async () => ({}), replay: async (id) => ({ raceId: id }) },
    paidBalance: async () => ({}),
    adminToken: undefined,
    parseStoreNotification: async () => null,
    ops: ops.api,
    authenticateAdmin: (req) => authenticateAdmin(req, auth),
    configInfo: async () => ({ versionId: 'base', hash: 'base', rulesetVersion: DEFAULT_RULESET.rulesetVersion, activatedAt: null }),
    transfer,
  };
  interface Init { method?: string; body?: unknown; auth?: number | 'none'; install?: string | null; lang?: string; country?: string; ids?: string; on?: 'A' | 'B'; ip?: string }
  const call = async (user: string, path: string, init: Init = {}) => {
    const headers: Record<string, string> = { 'x-test-user': user, 'content-type': 'application/json', 'cf-connecting-ip': init.ip ?? '198.51.100.23' };
    if (init.auth !== undefined) headers['x-test-auth'] = String(init.auth);
    if (init.install !== null) headers['x-install-id'] = init.install ?? 'install-aaaa-0001';
    if (init.lang) headers['accept-language'] = init.lang;
    if (init.country) headers['cf-ipcountry'] = init.country;
    if (init.ids !== undefined) headers['x-test-identities'] = init.ids;
    isolate = init.on ?? 'A';
    try {
      const res = await handle(new Request(`https://x${path}`, { method: init.method ?? 'GET', headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }), {}, c);
      return { status: res.status, body: (await res.json()) as any };
    } finally { isolate = 'A'; }
  };
  const admin = async (path: string, who: keyof typeof TOKENS = 'viewer', body?: unknown) => {
    const res = await handle(new Request(`https://x${path}`, {
      method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${TOKENS[who]}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
    }), {}, c);
    return { status: res.status, body: (await res.json()) as any };
  };
  /** A device = an install id and a sign-in time. */
  const checkin = (user: string, d: { auth: number; install?: string | null; platform?: string; model?: string; osMajor?: number; appVersion?: string; country?: string; ids?: string; on?: 'A' | 'B' }) =>
    call(user, '/v1/account/devices/checkin', { method: 'POST', auth: d.auth, install: d.install, country: d.country ?? 'JP', ...(d.ids !== undefined ? { ids: d.ids } : {}), ...(d.on ? { on: d.on } : {}),
      body: { platform: d.platform ?? 'ios', osMajor: d.osMajor ?? 18, model: d.model ?? 'iPhone15,2', appVersion: d.appVersion ?? '1.4.0' } });
  const signout = (user: string, auth: number, sessionId: string, body: unknown = { confirm: true }) => call(user, `/v1/account/devices/${sessionId}/signout`, { method: 'POST', auth, body });
  const others = (user: string, auth: number, body: unknown = { confirm: true }) => call(user, '/v1/account/devices/signout-others', { method: 'POST', auth, body });
  const bootstrap = (user: string) => svc.bootstrap(user);
  return { svc, repo, kpi, c, call, admin, checkin, signout, others, bootstrap, ops, guardA, guardB, puts: () => puts, tick: (ms: number) => { now += ms; }, now: () => now };
}
type W = Awaited<ReturnType<typeof setup>>;

/** Phone A (owner, signed in 2 days ago) and a fresh account. */
async function owner(w: W, user = 'p1') {
  await w.bootstrap(user);
  const a = sec(w.now() - 2 * DAY);
  const r = await w.checkin(user, { auth: a, install: 'install-phone-A' });
  expect(r.status).toBe(200);
  return { a, aId: r.body.current as string };
}

describe('§70.10 configuration (REQ-DEV-*)', () => {
  it('the shipped config is the defaults and validates; bad values are reported', () => {
    expect(devicesProblems(m)).toEqual([]);
    const shipped = { ...(m.progression as { devices?: Record<string, unknown> }).devices };
    delete shipped._note;
    expect(shipped).toEqual(DEFAULT_DEVICES);
    const bad = { progression: { ...m.progression, devices: { ...DEFAULT_DEVICES, maxSessions: 2, logDays: 9999 } } } as unknown as Master;
    expect(devicesProblems(bad).join(' ')).toMatch(/maxSessions.*logDays|logDays.*maxSessions/s);
    const order = { progression: { ...m.progression, devices: { ...DEFAULT_DEVICES, maxSessions: 40, knownDevicesMax: 20 } } } as unknown as Master;
    expect(devicesProblems(order)).toEqual(['progression.devices.knownDevicesMax: must be >= maxSessions']);
  });
});

describe('§70 minimisation helpers (REQ-DEV-001/002)', () => {
  it('model family keeps letters only, region keeps two-letter countries, providers come from firebase.identities', () => {
    expect(sanitizeModel('iPhone15,2')).toBe('iPhone');
    expect(sanitizeModel('Pixel 8 Pro')).toBe('Pixel Pro');
    expect(sanitizeModel('SM-S918B')).toBe('SM S B');
    expect(sanitizeModel('１２３')).toBeNull();
    expect(sanitizeModel('A'.repeat(60))).toHaveLength(24);
    expect(regionOf('jp')).toBe('JP');
    expect(regionOf('XX')).toBeNull();
    expect(regionOf('T1')).toBeNull();
    expect(regionOf(null)).toBeNull();
    expect(providersOf({ 'apple.com': ['x'], 'email': [] })).toEqual(['apple']);
    expect(providersOf({})).toEqual([]);
    expect(providersOf(undefined)).toBeNull();
  });
  it('the revocation check: one by one, everything before a time except the kept session, nothing for a token without auth_time', () => {
    const r = { revoked: [100], othersBefore: { at: 500_000, keep: 300 } };
    expect(sessionRevoked(r, 100)).toBe(true);
    expect(sessionRevoked(r, 300)).toBe(false);
    expect(sessionRevoked(r, 400)).toBe(true);
    expect(sessionRevoked(r, 501)).toBe(false);
    expect(sessionRevoked(r, null)).toBe(false);
    expect(sessionRevoked(null, 100)).toBe(false);
    expect(sessionRevoked({ revoked: [], othersBefore: { at: 500_000, keep: null } }, 300)).toBe(true);
  });
  it('the trust rule: newer sessions at once, older ones after trustAfterHours', () => {
    const c = DEFAULT_DEVICES;
    expect(signOutAvailableAt(c, 1000, 2000, 1_000_000)).toBeNull();
    expect(signOutAvailableAt(c, 1000, 500, 1_000_000 + HOUR)).toBe(1_000_000 + 24 * HOUR);
    expect(signOutAvailableAt(c, 1000, 500, 1_000_000 + 24 * HOUR)).toBeNull();
  });
});

describe('§70.1 check-in and the device list (REQ-DEV-002/003)', () => {
  it('the first device is recorded with a coarse label, the region and hour-rounded times — no IP, no install id, no notice', async () => {
    const w = await setup();
    await w.bootstrap('p1');
    const a = sec(w.now() - DAY);
    const r = await w.checkin('p1', { auth: a, install: 'install-phone-A', model: 'iPhone15,2', country: 'JP' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, recorded: true, newDevice: false });
    expect(r.body.current).toMatch(/^s_[0-9a-f]{16}$/);
    expect(r.body.sessions).toEqual([expect.objectContaining({ current: true, platform: 'ios', osMajor: 18, model: 'iPhone', appVersion: '1.4.0', region: 'JP', canSignOut: false })]);
    expect(r.body.sessions[0].lastSeenAt % HOUR).toBe(0);
    const raw = JSON.stringify(await w.svc.state('p1'));
    expect(raw).not.toContain('198.51.100.23');
    expect(raw).not.toContain('install-phone-A');
    expect(raw).not.toContain('iPhone15');
    expect((await w.svc.state('p1')).activity?.entries.some((e) => e.kind === 'new_device') ?? false).toBe(false);
    expect(w.kpi.some((k) => k.rec.name === 'new_device_notice')).toBe(false);
  });
  it('an unchanged check-in within the hour writes nothing; a new hour or a new app version writes', async () => {
    const w = await setup();
    const { a } = await owner(w);
    const before = w.puts();
    await w.checkin('p1', { auth: a, install: 'install-phone-A' });
    expect(w.puts()).toBe(before);
    await w.checkin('p1', { auth: a, install: 'install-phone-A', appVersion: '1.4.1' });
    expect(w.puts()).toBe(before + 1);
    w.tick(HOUR);
    const r = await w.checkin('p1', { auth: a, install: 'install-phone-A', appVersion: '1.4.1' });
    expect(w.puts()).toBe(before + 2);
    expect(r.body.sessions).toHaveLength(1);
  });
  it('a check-in never creates an account (before the bootstrap / after a wipe) and needs auth_time', async () => {
    const w = await setup();
    const r = await w.checkin('ghost', { auth: sec(w.now()) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ recorded: false, sessions: [] });
    expect(w.repo.get('ghost')).toBeNull();
    await w.bootstrap('p2');
    const n = await w.call('p2', '/v1/account/devices/checkin', { method: 'POST', auth: 'none', body: { platform: 'android' } });
    expect(n.body.recorded).toBe(false);
    const bad = await w.call('p2', '/v1/account/devices/checkin', { method: 'POST', body: { platform: 'symbian' } });
    expect(bad.status).toBe(400);
    const badInstall = await w.call('p2', '/v1/account/devices/checkin', { method: 'POST', install: 'bad id!', body: { platform: 'ios' } });
    expect(badInstall.status).toBe(400);
  });
  it('sessions beyond maxSessions drop the least recently seen; the current one is listed first', async () => {
    const w = await setup();
    const { a } = await owner(w);
    for (let i = 0; i < 22; i++) { w.tick(HOUR); await w.checkin('p1', { auth: sec(w.now()) - 5, install: `install-extra-${String(i).padStart(4, '0')}` }); }
    w.tick(HOUR);
    const r = await w.checkin('p1', { auth: a, install: 'install-phone-A' });
    expect(r.body.sessions).toHaveLength(DEFAULT_DEVICES.maxSessions);
    expect(r.body.sessions[0].current).toBe(true);
    expect(r.body.sessions.slice(1).map((x: { lastSeenAt: number }) => x.lastSeenAt)).toEqual([...r.body.sessions.slice(1).map((x: { lastSeenAt: number }) => x.lastSeenAt)].sort((x, y) => y - x));
  });
});

describe('§70.4 new device notice (REQ-DEV-009)', () => {
  it('a second device signing in after the list began: one activity entry (account, devices), the log, an essential KPI row — never a push', async () => {
    const w = await setup();
    await owner(w);
    w.tick(HOUR);
    const b = sec(w.now());
    const r = await w.checkin('p1', { auth: b, install: 'install-phone-B', platform: 'android', model: 'Pixel 9', osMajor: 15 });
    expect(r.body.newDevice).toBe(true);
    const s = await w.svc.state('p1');
    const e = s.activity!.entries.filter((x) => x.kind === 'new_device');
    expect(e).toHaveLength(1);
    expect(e[0]!.linkId).toBe(r.body.current);
    expect(ACTIVITY_META.new_device).toEqual({ category: 'account', screen: 'devices', collapse: false });
    expect(s.push?.outbox ?? []).toEqual([]);
    expect(w.kpi.filter((k) => k.rec.name === 'new_device_notice').map((k) => k.rec.s1)).toEqual(['android']);
    const log = (await w.call('p1', '/v1/account/security-log', { auth: b })).body;
    expect(log.items[0]).toMatchObject({ kind: 'new_device', text: '新しい端末でログインがありました', device: { platform: 'android', osMajor: 15, model: 'Pixel', region: 'JP' } });
    // the same check-in again, and the same phone signing in again later (a known device), add nothing
    await w.checkin('p1', { auth: b, install: 'install-phone-B', platform: 'android', model: 'Pixel 9', osMajor: 15 });
    w.tick(HOUR);
    const again = await w.checkin('p1', { auth: sec(w.now()), install: 'install-phone-B', platform: 'android', model: 'Pixel 9', osMajor: 15 });
    expect(again.body.newDevice).toBe(false);
    expect((await w.svc.state('p1')).activity!.entries.filter((x) => x.kind === 'new_device')).toHaveLength(1);
  });
  it('a session signed in before the list began (the second phone of a player from before this feature) is not a new device', async () => {
    const w = await setup();
    await owner(w);
    const r = await w.checkin('p1', { auth: sec(w.now() - 10 * DAY), install: 'install-old-tablet', platform: 'ios', model: 'iPad' });
    expect(r.body.newDevice).toBe(false);
    expect(r.body.sessions).toHaveLength(2);
  });
  it('without an install id, a new platform + model counts as new; the same label does not', async () => {
    const w = await setup();
    await owner(w);
    w.tick(HOUR);
    expect((await w.checkin('p1', { auth: sec(w.now()), install: null })).body.newDevice).toBe(false); // iPhone again
    expect((await w.checkin('p1', { auth: sec(w.now()) + 1, install: null, platform: 'android', model: 'Galaxy' })).body.newDevice).toBe(true);
  });
  it('the activity text is neutral (no alarm words) and English at the boundary', () => {
    const t = activityText('new_device', 1, {}, '');
    for (const w of ['不正', '危険', 'すぐに', '今すぐ']) expect(t).not.toContain(w);
    expect(untranslated(localize({ t }, 'en', catalogFor(m)))).toEqual([]);
  });
});

describe('§70.3 sign out one device (REQ-DEV-004/006/007/008)', () => {
  it('the owner signs out a newer device at once; its next request is 401 SESSION_REVOKED (this isolate at once, another within 30 s)', async () => {
    const w = await setup();
    const { a } = await owner(w);
    w.tick(HOUR);
    const b = sec(w.now());
    const bId = (await w.checkin('p1', { auth: b, install: 'install-phone-B', platform: 'android', model: 'Pixel' })).body.current as string;
    // isolate B learns the account's state now (cached for 30 s)
    expect((await w.call('p1', '/v1/account/devices', { auth: b, on: 'B' })).status).toBe(200);
    const r = await w.signout('p1', a, bId);
    expect(r.status).toBe(200);
    expect(r.body.signedOut).toBe(1);
    expect(r.body.devices.sessions.map((x: { sessionId: string }) => x.sessionId)).not.toContain(bId);
    const refused = await w.call('p1', '/v1/account/devices', { auth: b });
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe('SESSION_REVOKED');
    expect((await w.call('p1', '/v1/player', { auth: b })).body.error.code).toBe('SESSION_REVOKED');
    expect((await w.call('p1', '/v1/account/devices', { auth: b, on: 'B' })).status).toBe(200); // B's cache is still fresh
    w.tick(31_000);
    expect((await w.call('p1', '/v1/account/devices', { auth: b, on: 'B' })).body.error.code).toBe('SESSION_REVOKED');
    // the owner's own session keeps working; the log and the essential KPI row
    expect((await w.call('p1', '/v1/account/devices', { auth: a })).status).toBe(200);
    expect((await w.call('p1', '/v1/account/security-log', { auth: a })).body.items[0]).toMatchObject({ kind: 'signout_device', device: { platform: 'android', model: 'Pixel' } });
    expect(w.kpi.filter((k) => k.rec.name === 'device_signout').map((k) => [k.rec.s1, k.rec.count])).toEqual([['one', 1]]);
    // idempotent: again → 200, nothing counted
    const again = await w.signout('p1', a, bId);
    expect(again.status).toBe(200);
    expect(again.body.signedOut).toBe(0);
    expect(again.body.devices.revokesToday).toBe(1);
  });
  it('confirm is required; the current session cannot be signed out from here; unknown ids are 404', async () => {
    const w = await setup();
    const { a, aId } = await owner(w);
    expect((await w.signout('p1', a, aId, {})).status).toBe(400);
    expect((await w.signout('p1', a, aId, { confirm: false })).status).toBe(400);
    const cur = await w.signout('p1', a, aId);
    expect(cur.status).toBe(409);
    expect(cur.body.error.code).toBe('DEVICE_IS_CURRENT');
    expect((await w.signout('p1', a, 's_0000000000000000')).status).toBe(404);
    expect((await w.signout('p1', a, 'not-an-id')).status).toBe(404);
    expect((await w.call('p1', '/v1/account/devices', { auth: a })).status).toBe(200);
  });
  it('a newer session cannot sign out an older one until it has been signed in for trustAfterHours (403 DEVICE_SIGNOUT_TOO_SOON)', async () => {
    const w = await setup();
    const { aId } = await owner(w);
    w.tick(HOUR);
    const b = sec(w.now());
    const list = (await w.checkin('p1', { auth: b, install: 'install-intruder' })).body;
    expect(list.sessions.find((x: { sessionId: string }) => x.sessionId === aId)).toMatchObject({ canSignOut: false, availableAt: b * 1000 + 24 * HOUR });
    const r = await w.signout('p1', b, aId);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('DEVICE_SIGNOUT_TOO_SOON');
    expect(r.body.error.details.availableAt).toBe(b * 1000 + 24 * HOUR);
    expect(untranslated(localize(r.body, 'en', catalogFor(m)))).toEqual([]);
    w.tick(24 * HOUR);
    expect((await w.signout('p1', b, aId)).body.signedOut).toBe(1);
  });
  it('sign-outs per game day are limited (429 RATE_LIMITED); the count starts again after 04:00 JST', async () => {
    const w = await setup();
    const { a } = await owner(w);
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) ids.push((await w.checkin('p1', { auth: a + 10 + i, install: `install-n-${String(i).padStart(4, '0')}` })).body.sessions.find((x: { current: boolean }) => x.current).sessionId);
    for (let i = 0; i < 10; i++) expect((await w.signout('p1', a, ids[i]!)).status).toBe(200);
    const over = await w.signout('p1', a, ids[10]!);
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('RATE_LIMITED');
    w.tick(DAY);
    expect((await w.signout('p1', a, ids[10]!)).status).toBe(200);
  });
});

describe('§70.3 sign out all other devices (REQ-DEV-005/006)', () => {
  it('a trusted session signs out every other session, listed or not (an app that never checked in), never itself', async () => {
    const w = await setup();
    const { a } = await owner(w);
    const old = a - 3600; // signed in before phone A, never checked in (an old app)
    const b = sec(w.now()) - 60;
    await w.checkin('p1', { auth: b, install: 'install-phone-B' });
    const r = await w.others('p1', a);
    expect(r.status).toBe(200);
    expect(r.body.signedOut).toBe(1);
    expect(r.body.devices.sessions).toHaveLength(1);
    expect(r.body.devices.sessions[0].current).toBe(true);
    for (const t of [old, b]) expect((await w.call('p1', '/v1/account/devices', { auth: t })).body.error.code).toBe('SESSION_REVOKED');
    expect((await w.call('p1', '/v1/account/devices', { auth: a })).status).toBe(200);
    // a session signed in later (the owner on a new phone) is not affected
    w.tick(HOUR);
    expect((await w.call('p1', '/v1/account/devices', { auth: sec(w.now()) })).status).toBe(200);
    // again with nobody left: 200, nothing counted
    const again = await w.others('p1', a);
    expect(again.body.signedOut).toBe(0);
    expect(again.body.devices.revokesToday).toBe(1);
    expect(w.kpi.filter((k) => k.rec.name === 'device_signout').map((k) => [k.rec.s1, k.rec.count])).toEqual([['others', 1]]);
  });
  it('a young session may only sign out listed newer sessions; with an older one listed it is refused, and unlisted older sessions stay', async () => {
    const w = await setup();
    const { a } = await owner(w);
    w.tick(HOUR);
    const b = sec(w.now());
    await w.checkin('p1', { auth: b, install: 'install-young' });
    const r = await w.others('p1', b);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('DEVICE_SIGNOUT_TOO_SOON');
    expect((await w.call('p1', '/v1/account/devices', { auth: b })).body.signOutOthers).toMatchObject({ allowed: false, availableAt: b * 1000 + 24 * HOUR, count: 1 });
    // a fresh account: one young device and a newer one; an unlisted older session survives the young device's 「すべて」
    const w2 = await setup();
    await w2.bootstrap('p2');
    const y = sec(w2.now()) - 600;
    await w2.checkin('p2', { auth: y, install: 'install-y' });
    await w2.checkin('p2', { auth: y + 300, install: 'install-z' });
    const ok = await w2.others('p2', y);
    expect(ok.body.signedOut).toBe(1);
    expect((await w2.call('p2', '/v1/account/devices', { auth: y - 1000 })).status).toBe(200);
    expect(a).toBeLessThan(b);
  });
});

describe('§70 × §54 transfer code (REQ-DEV-011/012)', () => {
  it('issue / revoke are in the log; a redeem empties the list, old sessions are SESSION_REPLACED (checked first), the new device gets no notice', async () => {
    const w = await setup();
    const { a } = await owner(w);
    await w.checkin('p1', { auth: a + 100, install: 'install-phone-B' });
    const issued = await w.call('p1', '/v1/transfer/code', { method: 'POST', auth: a, body: { mode: 'custom', password: 'Haneda2026!' } });
    expect(issued.status).toBe(200);
    await w.call('p1', '/v1/transfer/code', { method: 'DELETE', auth: a });
    await w.call('p1', '/v1/transfer/code', { method: 'DELETE', auth: a }); // nothing to revoke: no second line
    const code = (await w.call('p1', '/v1/transfer/code', { method: 'POST', auth: a, body: { mode: 'custom', password: 'Haneda2026!' } })).body.codeId as string;
    const kinds = (await w.call('p1', '/v1/account/security-log', { auth: a })).body.items.map((x: { kind: string; text: string }) => x.text);
    expect(kinds).toEqual(['引き継ぎコードを発行しました（パスワードを設定）', '引き継ぎコードを取り消しました', '引き継ぎコードを発行しました（パスワードを設定）']);
    // a revoked session from just before the redeem stays revoked (the cut-off allows 30 s of clock difference)
    const late = sec(w.now()) - 5;
    const lateId = (await w.checkin('p1', { auth: late, install: 'install-late' })).body.current as string;
    expect((await w.signout('p1', a, lateId)).status).toBe(200);
    await w.bootstrap('newphone');
    w.tick(1000);
    const red = await w.call('newphone', '/v1/transfer/redeem', { method: 'POST', body: { codeId: code, password: 'Haneda2026!' } });
    expect(red.status).toBe(200);
    expect((await w.call('p1', '/v1/account/devices', { auth: a })).body.error.code).toBe('SESSION_REPLACED');
    expect((await w.call('p1', '/v1/account/devices', { auth: late })).body.error.code).toBe('SESSION_REVOKED');
    w.tick(2000);
    const n = sec(w.now());
    const first = await w.checkin('p1', { auth: n, install: 'install-new-phone' });
    expect(first.body).toMatchObject({ recorded: true, newDevice: false });
    expect(first.body.sessions).toHaveLength(1);
    expect(first.body.lastTransferredAt).not.toBeNull();
    expect((await w.call('p1', '/v1/account/security-log', { auth: n })).body.items[0].kind).toBe('transfer_redeemed');
  });
});

describe('§70.1 link changes from the token (REQ-DEV-010)', () => {
  it('apple linked on one device is logged once; a stale token on another device does not flap; unlinking is logged', async () => {
    const w = await setup();
    await w.bootstrap('p1');
    const a = sec(w.now() - DAY), b = a + 60;
    await w.checkin('p1', { auth: a, install: 'install-phone-A', ids: '' });
    await w.checkin('p1', { auth: b, install: 'install-phone-B', ids: '' });
    expect((await w.call('p1', '/v1/account/devices', { auth: a })).body.anonymousOnly).toBe(true);
    w.tick(HOUR);
    await w.checkin('p1', { auth: a, install: 'install-phone-A', ids: 'apple.com' });
    await w.checkin('p1', { auth: b, install: 'install-phone-B', ids: '' }); // B's token from before the link
    w.tick(HOUR);
    await w.checkin('p1', { auth: b, install: 'install-phone-B', ids: 'apple.com' }); // B refreshed
    let log = (await w.call('p1', '/v1/account/security-log', { auth: a })).body.items.map((x: { kind: string }) => x.kind);
    expect(log).toEqual(['link_added']);
    expect((await w.call('p1', '/v1/account/devices', { auth: a })).body.anonymousOnly).toBe(false);
    w.tick(HOUR);
    await w.checkin('p1', { auth: a, install: 'install-phone-A', ids: '' });
    await w.checkin('p1', { auth: b, install: 'install-phone-B', ids: 'apple.com' }); // stale again
    log = (await w.call('p1', '/v1/account/security-log', { auth: a })).body.items;
    expect(log.map((x: { kind: string }) => x.kind)).toEqual(['link_removed', 'link_added']);
    expect(log[0].text).toBe('Appleの連携を解除しました');
    const en = (await w.call('p1', '/v1/account/security-log', { auth: a, lang: 'en' })).body;
    expect(en.items.map((x: { text: string }) => x.text)).toEqual(['Unlinked Apple', 'Linked Apple']);
  });
});

describe('§70 account deletion (REQ-DEV-014/015)', () => {
  it('while the deletion runs nothing is written and sign-outs are refused; a scheduled deletion still allows them', async () => {
    const w = await setup();
    const { a } = await owner(w);
    const bId = (await w.checkin('p1', { auth: a + 100, install: 'install-phone-B' })).body.sessions.find((x: { current: boolean }) => x.current).sessionId as string;
    const tok = (await w.svc.requestDeletion('p1', null)) as { confirmToken: string };
    await w.svc.requestDeletion('p1', tok.confirmToken);
    expect((await w.signout('p1', a, bId)).status).toBe(200); // scheduled: still possible
    await w.svc.deletionStart('p1');
    const r = await w.checkin('p1', { auth: a + 200, install: 'install-phone-C' });
    expect(r.body).toMatchObject({ recorded: false, sessions: [] });
    expect((await w.others('p1', a)).body.error.code).toBe('DELETION_PENDING');
  });
});

describe('§70 HTTP: gates, English, export, ops (REQ-DEV-013/015/016/017)', () => {
  const ROUTES = ['GET /v1/account/devices', 'POST /v1/account/devices/checkin', 'POST /v1/account/devices/:sessionId/signout', 'POST /v1/account/devices/signout-others', 'GET /v1/account/security-log'];
  it('every §70 route exists and is exempt from maintenance and the version gate (and §46.2 says so)', () => {
    const have = new Set(routes.map((r) => `${r.method} ${r.path}`));
    const fam = [...have].filter((r) => r.includes('/v1/account/'));
    expect(fam.sort()).toEqual([...ROUTES].sort());
    const START = jstToMs('2026-11-12T02:00')!;
    const cfg: MaintenanceConfig = { ...structuredClone(DEFAULT_MAINTENANCE), windows: [{ id: 'm1', startAtMs: START, endAtMs: START + 4 * HOUR, scope: 'all', message: { ja: '点検中', en: 'Checks' } }],
      clientVersions: { ios: { min: '9.0.0', recommended: '9.0.0', storeUrl: 'https://apps.apple.com/jp/app/id1234567890' }, android: DEFAULT_MAINTENANCE.clientVersions.android } };
    for (const r of ROUTES) {
      expect(EXEMPT_ROUTES, r).toContain(r);
      const [method, path] = r.split(' ');
      const p = path!.replace(':sessionId', 's_0123456789abcdef');
      expect(gateRequest(cfg, method!, p, { platform: 'ios', version: '1.0.0', engine: null }, START), r).toBeNull();
      expect(endpointGroup(p)).toBe('core');
    }
    const p = read('contracts/protocol.md');
    const s462 = p.slice(p.indexOf('### 46.2'), p.indexOf('### 46.3'));
    for (const r of ROUTES) expect(s462, r).toContain(r.split(' ')[1]!);
  });
  it('disabled by remote config: the list says enabled: false, sign-outs are 404 — and revocations keep working', async () => {
    const w = await setup();
    const { a } = await owner(w);
    const bId = (await w.checkin('p1', { auth: a + 100, install: 'install-phone-B' })).body.sessions.find((x: { current: boolean }) => x.current).sessionId as string;
    await w.signout('p1', a, bId);
    w.svc.setMaster({ ...m, progression: { ...m.progression, devices: { ...DEFAULT_DEVICES, enabled: false } } } as Master);
    w.c.master = w.svc['d'].master;
    const v = await w.call('p1', '/v1/account/devices', { auth: a });
    expect(v.body).toMatchObject({ enabled: false, sessions: [] });
    expect((await w.others('p1', a)).status).toBe(404);
    w.guardA.forget('p1');
    expect((await w.call('p1', '/v1/account/devices', { auth: a + 100 })).body.error.code).toBe('SESSION_REVOKED');
  });
  it('English: errors, the list and the log carry no Japanese', async () => {
    const w = await setup();
    const { a, aId } = await owner(w);
    await w.checkin('p1', { auth: a + 100, install: 'install-phone-B', platform: 'android', model: 'Pixel' });
    const cur = await w.call('p1', `/v1/account/devices/${aId}/signout`, { method: 'POST', auth: a, lang: 'en', body: { confirm: true } });
    expect(cur.body.error.message).toBe('This device cannot be signed out from here');
    const log = await w.call('p1', '/v1/account/security-log', { auth: a, lang: 'en' });
    expect(untranslated(log.body)).toEqual([]);
    for (const t of Object.values(SECURITY_TEXT)) expect(untranslated(localize({ t: t.replace('{provider}', 'Google') }, 'en', catalogFor(m))), t).toEqual([]);
    const bId = (await w.call('p1', '/v1/account/devices', { auth: a })).body.sessions[1].sessionId;
    await w.signout('p1', a, bId);
    const gone = await w.call('p1', '/v1/account/devices', { auth: a + 100, lang: 'en' });
    expect(gone.body.error).toMatchObject({ code: 'SESSION_REVOKED', message: 'This device was signed out' });
    expect(SECURITY_EVENTS).toHaveLength(9);
  });
  it('§51: devices is classified account; the export has labels, regions, times and the log — never auth_time, hashes or revocations', async () => {
    const w = await setup();
    const { a } = await owner(w);
    const bId = (await w.checkin('p1', { auth: a + 100, install: 'install-phone-B' })).body.sessions.find((x: { current: boolean }) => x.current).sessionId as string;
    await w.signout('p1', a, bId);
    expect(classifyKey('devices')).toEqual({ section: 'account' });
    const s = await w.svc.state('p1');
    const doc = buildExportDocument(m, s, { ledger: s.ledger, gacha: [], names: {}, reportsMade: [], kpiEvents: null }, 'dx_1', 'ja', w.now()) as unknown as { account: { signedInDevices: unknown[]; securityLog: { kind: string }[] }; unclassified: string[] };
    expect(doc.unclassified).toEqual([]);
    expect(doc.account.signedInDevices).toEqual([expect.objectContaining({ platform: 'ios', model: 'iPhone', region: 'JP' })]);
    expect(doc.account.securityLog.map((x) => x.kind)).toEqual(['signout_device']);
    const text = JSON.stringify(doc.account);
    expect(text).not.toContain(String(a));
    for (const h of s.devices!.known) expect(text).not.toContain(h);
    expect(text).not.toContain(bId);
    expect(text).not.toContain('"revoked"');
  });
  it('KPI: device_signout and new_device_notice are essential, device_list_view optional; rows carry no ids, hashes, regions or models', async () => {
    expect(kpiClassOf('device_signout')).toBe('essential');
    expect(kpiClassOf('new_device_notice')).toBe('essential');
    expect(KPI_EVENT_CLASS.device_list_view).toBe('optional');
    const e = clientEventSchema.parse({ name: 'device_list_view', at: NOW, props: { screen: 'log', count: 3 } });
    expect(clientToKpi(e)).toEqual({ name: 'device_list_view', s1: 'log', value: 3 });
    const w = await setup();
    const { a } = await owner(w);
    w.tick(HOUR);
    const b = sec(w.now());
    const bId = (await w.checkin('p1', { auth: b, install: 'install-phone-B', country: 'KR' })).body.current as string;
    await w.signout('p1', a, bId);
    const rows = JSON.stringify(w.kpi.filter((k) => ['device_signout', 'new_device_notice'].includes(k.rec.name)).map((k) => k.rec));
    expect(rows).not.toContain(bId);
    expect(rows).not.toContain('KR');
    expect(rows).not.toContain('iPhone');
    const p = read('contracts/protocol.md');
    const s587 = p.slice(p.indexOf('### 58.7'), p.indexOf('### 58.8'));
    for (const n of ['device_signout', 'new_device_notice', 'device_list_view']) expect(s587, n).toContain(n);
    const q = read('docs/ops/kpi-queries.md');
    for (const n of ['device_signout', 'new_device_notice', 'device_list_view']) expect(q, n).toContain(n);
  });
  it('ops: a viewer sees the list and the log (no auth_time, no hashes); only an admin signs out, with a reason, in the audit', async () => {
    const w = await setup();
    const { a } = await owner(w);
    const bId = (await w.checkin('p1', { auth: a + 100, install: 'install-phone-B' })).body.sessions.find((x: { current: boolean }) => x.current).sessionId as string;
    const v = await w.admin('/v1/admin/players/p1/devices');
    expect(v.status).toBe(200);
    expect(v.body.sessions.map((x: { sessionId: string }) => x.sessionId)).toContain(bId);
    expect(JSON.stringify(v.body)).not.toContain(String(a));
    expect(JSON.stringify(v.body)).not.toMatch(/authTime|"device":"[0-9a-f]{16}"/);
    expect((await w.admin('/v1/admin/players/p1/devices/revoke', 'operator', { sessionId: bId, reason: 'lost phone (ticket Q-1)' })).status).toBe(403);
    const one = await w.admin('/v1/admin/players/p1/devices/revoke', 'admin', { sessionId: bId, reason: 'lost phone (ticket Q-1)' });
    expect(one.status).toBe(200);
    expect(one.body.signedOut).toBe(1);
    w.guardA.forget('p1');
    expect((await w.call('p1', '/v1/account/devices', { auth: a + 100 })).body.error.code).toBe('SESSION_REVOKED');
    const all = await w.admin('/v1/admin/players/p1/devices/revoke', 'admin', { all: true, reason: 'account takeover (ticket Q-2)' });
    expect(all.body.signedOut).toBe(1);
    w.guardA.forget('p1');
    expect((await w.call('p1', '/v1/account/devices', { auth: a })).body.error.code).toBe('SESSION_REVOKED');
    w.tick(HOUR);
    expect((await w.call('p1', '/v1/account/devices', { auth: sec(w.now()) })).status).toBe(200); // signing in again works
    const audit = await w.ops.api.auditQuery({ limit: 50 } as never) as unknown as { rows?: { action: string; reason: string | null }[] } | { action: string; reason: string | null }[];
    const rows = Array.isArray(audit) ? audit : audit.rows ?? [];
    expect(rows.filter((x) => x.action === 'player.devices.revoke').map((x) => x.reason)).toEqual(expect.arrayContaining(['lost phone (ticket Q-1)', 'account takeover (ticket Q-2)']));
    const log = (await w.svc.securityLog('p1')).items.map((x) => x.kind);
    expect(log.slice(0, 2)).toEqual(['signout_support', 'signout_support']);
    expect(w.kpi.filter((k) => k.rec.name === 'device_signout').map((k) => k.rec.s1)).toEqual(['support', 'support']);
  });
  it('help article, context and tip exist (REQ-DEV-018)', () => {
    const h = helpOf(m);
    expect(h.contexts.devices).toBe('signed_in_devices');
    const art = helpArticle(m, 'signed_in_devices', 'ja', 6);
    expect(art).not.toBeNull();
    const tips = JSON.parse(read('server/master/tips.json')) as { tips: { id: string; help?: string }[] };
    expect(tips.tips.find((t) => t.id === 'devices_tip')?.help).toBe('signed_in_devices');
  });
});
