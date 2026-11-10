import { describe, expect, it } from 'vitest';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { DEFAULT_RULESET } from '../src/domain/ruleset.js';
import { authenticateAdmin, type AdminAuthConfig } from '../src/ops/admin.js';
import { sha256Hex } from '../src/ops/hash.js';
import { memoryOps } from '../src/ops/memoryOps.js';
import { resolveBundle } from '../src/ops/config.js';
import { clientMessageSchema } from '../src/domain/schemas.js';
import { clientBatchSchema, clientToKpi } from '../src/domain/kpi.js';
import { PACK_LEGAL_WORDS_JA } from '../src/domain/commentaryPacks.js';
import { whatsNew } from '../src/domain/comeback.js';
import { freshPlayer, m } from './helpers.js';
import {
  DEFAULT_MAINTENANCE, ENGINE_LEVEL, EXEMPT_ROUTES, LEGAL_WORDS_JA, activeWindowFor, clientStatus, compareVersions, endpointGroup, engineMismatch,
  gateRequest, isExempt, jstToMs, maintenanceProblems, maintenanceStatus, msToJst, visibleWindows, type MaintenanceConfig, type MaintenanceWindow,
} from '../src/domain/maintenance.js';

/** メンテナンス・強制アップデート (REQ-MNT-001..016, contracts/protocol.md §46). */
const NOW = Date.UTC(2026, 10, 11, 12); // 2026-11-11 21:00 JST
const H = 3600_000;
const START = jstToMs('2026-11-12T02:00')!;
const END = jstToMs('2026-11-12T06:00')!;
const MSG = { ja: '11/12 2:00〜6:00 にメンテナンスを行います。', en: 'Maintenance on 11/12 from 2:00 to 6:00 (JST).' };
const win = (o: Partial<MaintenanceWindow> = {}): MaintenanceWindow => ({ id: 'm1', startAtMs: START, endAtMs: END, scope: 'all', message: MSG, ...o });
const cfg = (o: Partial<MaintenanceConfig> = {}): MaintenanceConfig => ({ ...structuredClone(DEFAULT_MAINTENANCE), ...o });
const VERSIONS: MaintenanceConfig['clientVersions'] = {
  ios: { min: '1.2.0', recommended: '1.3.0', storeUrl: 'https://apps.apple.com/jp/app/id1234567890' },
  android: { min: '1.2.0', recommended: '1.3.0', storeUrl: 'https://play.google.com/store/apps/details?id=jp.example.muchi' },
};
const noHeaders = { platform: null, version: null, engine: null };

describe('maintenance config validation (REQ-MNT-001/002)', () => {
  it('the default and a sensible window are valid', () => {
    expect(maintenanceProblems(DEFAULT_MAINTENANCE)).toEqual([]);
    expect(maintenanceProblems(cfg({ windows: [win(), win({ id: 'm2', startAtMs: END + H, endAtMs: END + 2 * H, scope: ['gacha', 'shop'] })], clientVersions: VERSIONS }))).toEqual([]);
  });
  it('rejects bad windows: order, length, overlap, ids, wording, announce', () => {
    const p = (w: MaintenanceWindow[]) => maintenanceProblems(cfg({ windows: w })).join(' | ');
    expect(p([win({ endAtMs: START })])).toMatch(/after startAtMs/);
    expect(p([win({ endAtMs: START + 60_000 })])).toMatch(/shorter than 5 minutes/);
    expect(p([win({ endAtMs: START + 25 * H })])).toMatch(/longer than 24 hours/);
    expect(p([win(), win({ id: 'm2', startAtMs: START + H, endAtMs: END + H })])).toMatch(/overlaps m1/);
    expect(p([win(), win()])).toMatch(/duplicate id/);
    expect(p([win({ message: { ja: '今だけメンテナンス', en: 'Maintenance' } })])).toMatch(/今だけ/);
    expect(p([win({ message: { ja: 'メンテナンス', en: 'Maintenance; no bets accepted' } })])).toMatch(/betting word/);
    expect(p([win({ announceAtMs: START + 1 })])).toMatch(/announceAtMs/);
    expect(p([win({ announceAtMs: START - 15 * 24 * H })])).toMatch(/14 days/);
    expect(p([win({ scope: ['gacha', 'gacha'] })])).toMatch(/duplicate scope/);
    expect(maintenanceProblems(cfg({ windows: [win({ scope: ['core'] as never })] })).join()).toMatch(/scope/); // core is only closed by `all`
    // a cancelled window no longer blocks the slot
    expect(p([win({ cancelledAtMs: NOW }), win({ id: 'm2' })])).toBe('');
  });
  it('client versions: recommended ≥ min, store URL on the right store over https', () => {
    const v = (o: object) => maintenanceProblems(cfg({ clientVersions: { ...VERSIONS, ...o } })).join(' | ');
    expect(v({ ios: { min: '1.3.0', recommended: '1.2.0', storeUrl: VERSIONS.ios.storeUrl } })).toMatch(/below min/);
    expect(v({ ios: { min: '1.0.0', recommended: '1.0.0', storeUrl: null } })).toMatch(/storeUrl is required/);
    expect(v({ ios: { min: '1.0.0', recommended: '1.0.0', storeUrl: 'https://evil.example/app' } })).toMatch(/https link/);
    expect(v({ ios: { min: '1.0.0', recommended: '1.0.0', storeUrl: 'http://apps.apple.com/app/id1' } })).toMatch(/https link/);
    expect(v({ android: { min: '1.0.0', recommended: '1.0.0', storeUrl: VERSIONS.ios.storeUrl } })).toMatch(/App Store/);
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
  });
  it('the shop wording list is the shared one', () => {
    expect([...LEGAL_WORDS_JA]).toEqual([...PACK_LEGAL_WORDS_JA]);
  });
  it('remote config: the section resolves, its English joins the locale table, and invalid sections are refused', () => {
    const { master } = resolveBundle(m, { maintenance: cfg({ windows: [win()], clientVersions: VERSIONS }) });
    expect(master.maintenance?.windows[0]?.id).toBe('m1');
    expect(master.locale?.en[MSG.ja]).toBe(MSG.en);
    expect(() => resolveBundle(m, { maintenance: cfg({ windows: [win({ endAtMs: START })] }) })).toThrow(/after startAtMs/);
    // the English message passes the same wording lint as every other text
    expect(() => resolveBundle(m, { maintenance: cfg({ windows: [win({ message: { ja: 'メンテナンス', en: 'Limited-time maintenance' } })] }) })).toThrow(/wording/);
    expect(() => resolveBundle(m, { maintenance: { windows: [] } as never })).toThrow(/CONFIG_INVALID|clientVersions/);
  });
  it('JST helpers round-trip and reject impossible times', () => {
    expect(msToJst(START)).toBe('2026-11-12T02:00');
    expect(jstToMs('2026-02-30T02:00')).toBeNull();
    expect(jstToMs('2026-11-12 02:00')).toBeNull();
  });
});

describe('endpoint groups and exempt routes (REQ-MNT-003)', () => {
  it('maps paths to groups', () => {
    expect(endpointGroup('/v1/gacha/b1/draw')).toBe('gacha');
    expect(endpointGroup('/v1/items/tickets/t1/use')).toBe('gacha');
    expect(endpointGroup('/v1/shop/purchase-intent')).toBe('shop');
    expect(endpointGroup('/v1/silks/parts/x/buy')).toBe('shop');
    expect(endpointGroup('/v1/match/enqueue')).toBe('ranked');
    expect(endpointGroup('/v1/races/advice')).toBe('ranked');
    expect(endpointGroup('/v1/teams/me')).toBe('teams');
    expect(endpointGroup('/v1/time-attack/start')).toBe('time_attack');
    expect(endpointGroup('/v1/player')).toBe('core');
    expect(endpointGroup('/v1/silks')).toBe('core');
  });
  it('purchases, store notifications, deletion and in-flight submissions are never gated', () => {
    for (const r of ['POST /v1/shop/purchase', 'POST /v1/store/notifications/apple', 'DELETE /v1/player', 'GET /v1/race/r1/ws', 'POST /v1/time-attack/submit', 'POST /v1/training/s1/finish', 'POST /v1/match/cancel', 'GET /v1/maintenance', 'POST /v1/analytics/events']) {
      const [method, path] = r.split(' ');
      expect(isExempt(method!, path!), r).toBe(true);
    }
    expect(isExempt('POST', '/v1/shop/purchase-intent')).toBe(false);
    expect(isExempt('GET', '/v1/player')).toBe(false);
    expect(EXEMPT_ROUTES.every((r) => /^(GET|POST|PUT|DELETE) \/v1\//.test(r))).toBe(true);
  });
});

describe('the gate (REQ-MNT-003/006/007)', () => {
  const c = cfg({ windows: [win({ scope: ['gacha'] }), win({ id: 'm2', startAtMs: END + H, endAtMs: END + 2 * H })], clientVersions: VERSIONS });
  it('a scoped window closes only its groups, exactly within [start, end)', () => {
    expect(gateRequest(c, 'GET', '/v1/gacha/banners', noHeaders, START - 1)).toBeNull();
    const e = gateRequest(c, 'GET', '/v1/gacha/banners', noHeaders, START)!;
    expect(e.code).toBe('MAINTENANCE');
    expect(e.status).toBe(503);
    expect(e.details).toMatchObject({ windowId: 'm1', group: 'gacha', endAt: END, endsAtJst: '11/12 06:00', retryAfterSec: 4 * 3600, message: MSG.ja });
    expect(gateRequest(c, 'GET', '/v1/player', noHeaders, START)).toBeNull();
    expect(gateRequest(c, 'GET', '/v1/gacha/banners', noHeaders, END)).toBeNull();
  });
  it('`all` closes core too, but never the exempt routes or the admin API', () => {
    const t = END + H + 1;
    expect(gateRequest(c, 'GET', '/v1/player', noHeaders, t)?.code).toBe('MAINTENANCE');
    expect(gateRequest(c, 'POST', '/v1/shop/purchase', noHeaders, t)).toBeNull();
    expect(gateRequest(c, 'GET', '/v1/admin/config', noHeaders, t)).toBeNull();
  });
  it('a cancelled window stops blocking at its cancellation', () => {
    const cc = cfg({ windows: [win({ cancelledAtMs: START + H })] });
    expect(gateRequest(cc, 'GET', '/v1/player', noHeaders, START + H - 1)?.code).toBe('MAINTENANCE');
    expect(gateRequest(cc, 'GET', '/v1/player', noHeaders, START + H)).toBeNull();
    expect(activeWindowFor(cfg({ windows: [win({ cancelledAtMs: NOW })] }), 'core', START + 1)).toBeNull();
  });
  it('version gate: below min → 426 with the store URL; below recommended passes; unknown headers pass', () => {
    const e = gateRequest(c, 'GET', '/v1/player', { platform: 'ios', version: '1.1.9', engine: null }, NOW)!;
    expect(e.code).toBe('UPGRADE_REQUIRED');
    expect(e.status).toBe(426);
    expect(e.details).toMatchObject({ reason: 'version', platform: 'ios', minVersion: '1.2.0', storeUrl: VERSIONS.ios.storeUrl });
    expect(gateRequest(c, 'GET', '/v1/player', { platform: 'android', version: '1.2.5', engine: null }, NOW)).toBeNull();
    expect(gateRequest(c, 'GET', '/v1/player', { platform: 'web', version: '0.0.1', engine: null }, NOW)).toBeNull();
    expect(gateRequest(c, 'GET', '/v1/player', { platform: 'ios', version: 'garbage', engine: null }, NOW)).toBeNull();
    // an outdated app can still finish a purchase it already paid for, and delete its account
    expect(gateRequest(c, 'POST', '/v1/shop/purchase', { platform: 'ios', version: '0.1.0', engine: null }, NOW)).toBeNull();
    expect(gateRequest(c, 'DELETE', '/v1/player', { platform: 'ios', version: '0.1.0', engine: null }, NOW)).toBeNull();
    expect(clientStatus(c, 'android', '1.2.5')).toBe('recommended');
    expect(clientStatus(c, 'android', '1.3.0')).toBe('ok');
    // the version gate comes first: waiting out a window would not fix an outdated app
    expect(gateRequest(c, 'GET', '/v1/gacha/banners', { platform: 'ios', version: '1.0.0', engine: null }, START)?.code).toBe('UPGRADE_REQUIRED');
  });
  it('engine level: race groups refuse a lower x-engine-level; other groups and absent headers pass', () => {
    const ce = cfg({ minEngineLevel: 2 });
    const e = gateRequest(ce, 'POST', '/v1/match/enqueue', { platform: null, version: null, engine: 1 }, NOW)!;
    expect(e.code).toBe('UPGRADE_REQUIRED');
    expect(e.details).toMatchObject({ reason: 'engine', engineLevel: 1, minEngineLevel: 2 });
    expect(gateRequest(ce, 'POST', '/v1/events/e1/enqueue', { platform: null, version: null, engine: 2 }, NOW)).toBeNull();
    expect(gateRequest(ce, 'GET', '/v1/gacha/banners', { platform: null, version: null, engine: 1 }, NOW)).toBeNull();
    expect(gateRequest(ce, 'POST', '/v1/match/enqueue', noHeaders, NOW)).toBeNull();
  });
});

describe('race handshake (REQ-MNT-008, protocol §4 hello.engine)', () => {
  it('hello may carry an engine level; a lower level is a mismatch, absent is accepted as before', () => {
    expect(clientMessageSchema.safeParse({ t: 'hello', raceId: 'r', token: 't', lastTick: -1, engine: 1 }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ t: 'hello', raceId: 'r', token: 't', lastTick: -1 }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ t: 'hello', raceId: 'r', token: 't', lastTick: -1, engine: 0 }).success).toBe(false);
    expect(engineMismatch(undefined)).toBe(false);
    expect(engineMismatch(ENGINE_LEVEL)).toBe(false);
    expect(engineMismatch(1, 2)).toBe(true);
  });
});

describe('announcements (REQ-MNT-004/005)', () => {
  const c = cfg({ windows: [win()], clientVersions: VERSIONS });
  it('a window is visible from its announcement (default 24 h before) until it ends', () => {
    expect(visibleWindows(c, START - 25 * H)).toEqual([]);
    expect(visibleWindows(c, START - 24 * H)[0]).toMatchObject({ id: 'm1', status: 'announced', startJst: '11/12 02:00', endJst: '11/12 06:00' });
    expect(visibleWindows(c, START)[0]?.status).toBe('active');
    expect(visibleWindows(c, END)).toEqual([]);
    expect(visibleWindows(cfg({ windows: [win({ cancelledAtMs: NOW })] }), NOW + 1)).toEqual([]);
  });
  it('GET /v1/maintenance shape: active, upcoming and where this app stands', () => {
    const s = maintenanceStatus(c, { platform: 'android', version: '1.2.1', engine: null }, NOW);
    expect(s.active).toEqual([]);
    expect(s.upcoming.map((w) => w.id)).toEqual(['m1']);
    expect(s.client).toMatchObject({ platform: 'android', status: 'recommended', minVersion: '1.2.0', recommendedVersion: '1.3.0', storeUrl: VERSIONS.android.storeUrl, minEngineLevel: 1 });
    expect(maintenanceStatus(c, noHeaders, NOW).client.status).toBe('unknown');
  });
  it('what\'s new lists an announced window once (until it ends), linking to the notice', () => {
    const master = resolveBundle(m, { maintenance: c }).master;
    const s = freshPlayer('p1', NOW - 48 * H);
    const before = whatsNew(master, s, START - 25 * H);
    expect(before.items.some((i) => i.kind === 'maintenance')).toBe(false);
    const after = whatsNew(master, s, NOW);
    const item = after.items.find((i) => i.kind === 'maintenance')!;
    expect(item).toMatchObject({ id: 'maintenance_m1', title: 'メンテナンスのお知らせ', body: MSG.ja, feature: 'maintenance', endsAt: END });
    expect(whatsNew(master, s, END + 1).items.some((i) => i.kind === 'maintenance')).toBe(false);
  });
});

describe('KPI (REQ-MNT-013)', () => {
  it('maintenance_block and upgrade_prompt are accepted client events', () => {
    const b = clientBatchSchema.parse({ platform: 'ios', appVersion: '1.2.0', events: [
      { name: 'maintenance_block', at: NOW, props: { group: 'gacha', windowId: 'm1' } },
      { name: 'upgrade_prompt', at: NOW, props: { kind: 'required', action: 'store', platform: 'ios' } },
    ] });
    expect(b.events.map(clientToKpi)).toEqual([
      { name: 'maintenance_block', s1: 'gacha', s2: 'm1' },
      { name: 'upgrade_prompt', s1: 'required', s2: 'store', s3: 'ios' },
    ]);
    expect(clientBatchSchema.safeParse({ platform: 'ios', appVersion: '1.2.0', events: [{ name: 'maintenance_block', at: NOW, props: { group: 'nope', windowId: 'm1' } }] }).success).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ over HTTP

const TOKENS = { viewer: 'viewer-token-0123456789', admin: 'admin-token-0123456789' };
async function setup() {
  let now = NOW;
  const store = new FakeStoreVerifier();
  const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(3), clock: () => now, verifiers: { fake: store } });
  const receipt = (tx: string) => ({ platform: 'fake', productId: 'coin_1500', receipt: store.issue({ transactionId: tx, productId: 'coin_1500', purchasedAt: NOW, priceYen: 1500 }) });
  let during: (() => void) | null = null;
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => {
    during?.(); // lets a test move the clock while a request is being served
    return (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args);
  }) as PlayerInvoker['invoke'] };
  const ops = memoryOps(m, () => invoker);
  const auth: AdminAuthConfig = { tokens: await Promise.all((Object.keys(TOKENS) as (keyof typeof TOKENS)[]).map(async (name) => ({ name, role: name, sha256: await sha256Hex(TOKENS[name]) }))) };
  const c: AppContext = {
    master: m,
    authenticate: async (req) => { const u = req.headers.get('x-dev-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
    player: () => invoker,
    match: { enqueue: async () => ({ queued: true }), cancel: async () => ({ ok: true }) } as unknown as AppContext['match'],
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
  };
  let n = 0;
  /** Each request sees the active config at its time (like the Worker's activeConfig). */
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const a = await ops.api.config.active(now, null);
    c.master = a.bundle ? resolveBundle(m, a.bundle).master : m;
    const res = await handle(new Request(`https://x${path}`, { method, headers: { 'content-type': 'application/json', 'idempotency-key': `k${n++}`, ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), {}, c);
    return { status: res.status, body: (await res.json()) as Record<string, any>, headers: res.headers };
  };
  const player = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => call(method, path, body, { 'x-dev-user': 'p1', ...headers });
  const admin = (who: keyof typeof TOKENS, method: string, path: string, body?: unknown) => call(method, path, body, { authorization: `Bearer ${TOKENS[who]}` });
  return { svc, ops, c, call, receipt, player, admin, setNow: (t: number) => { now = t; }, setDuring: (f: (() => void) | null) => { during = f; } };
}

describe('maintenance over HTTP, scheduled from the ops console (REQ-MNT-003/006/011)', () => {
  it('schedule → 503 for the covered group with the end time (ja/en), receipts still granted, cancel reopens; every change audited', async () => {
    const t = await setup();
    await t.player('POST', '/v1/player/bootstrap');
    await t.player('PUT', '/v1/player/age', { birthYear: 1990, birthMonth: 1, guardianConsent: false });
    await t.player('POST', '/v1/shop/purchase-intent', { productId: 'coin_1500' }); // started before the window

    const draft = { id: 'm-1112', startJst: '2026-11-12T02:00', endJst: '2026-11-12T06:00', scope: ['shop', 'gacha'], message: MSG };
    const pv = await t.admin('viewer', 'POST', '/v1/admin/maintenance/preview', { window: draft });
    expect(pv.status).toBe(200);
    expect(pv.body).toMatchObject({ ok: true, banner: { ja: { label: 'メンテナンスのお知らせ', times: '11/12 02:00〜11/12 06:00（日本時間）', message: MSG.ja }, en: { label: 'Scheduled maintenance', message: MSG.en } } });
    expect((await t.admin('viewer', 'POST', '/v1/admin/maintenance/windows', { window: draft, reason: 'nightly db work' })).status).toBe(403);
    const sch = await t.admin('admin', 'POST', '/v1/admin/maintenance/windows', { window: draft, reason: 'nightly db work' });
    expect(sch.status).toBe(200);
    expect((await t.admin('admin', 'POST', '/v1/admin/maintenance/windows', { window: draft, reason: 'again' })).status).toBe(409);
    const overlap = await t.admin('admin', 'POST', '/v1/admin/maintenance/windows', { window: { ...draft, id: 'm-x', startJst: '2026-11-12T05:00', endJst: '2026-11-12T07:00' }, reason: 'overlap' });
    expect(overlap.status).toBe(400);
    expect(overlap.body.error.message).toMatch(/overlaps/);

    // announced in-game ahead of time
    const st = await t.call('GET', '/v1/maintenance', undefined, { 'x-client-platform': 'ios', 'x-client-version': '1.0.0' });
    expect(st.body.upcoming.map((w: { id: string }) => w.id)).toEqual(['m-1112']);
    expect((await t.player('GET', '/v1/gacha/banners')).status).toBe(200);

    t.setNow(START + 30 * 60_000);
    const blocked = await t.player('GET', '/v1/gacha/banners');
    expect(blocked.status).toBe(503);
    expect(blocked.body.error).toMatchObject({ code: 'MAINTENANCE', message: 'メンテナンス中です', details: { group: 'gacha', endsAtJst: '11/12 06:00', message: MSG.ja } });
    expect(blocked.headers.get('retry-after')).toBe(String(3.5 * 3600));
    const en = await t.player('GET', '/v1/gacha/banners?lang=en');
    expect(en.body.error).toMatchObject({ message: 'Under maintenance', details: { message: MSG.en } });
    expect((await t.player('POST', '/v1/shop/purchase-intent', { productId: 'coin_1500' })).status).toBe(503); // no new purchase starts
    expect((await t.player('GET', '/v1/player')).status).toBe(200); // core is open (scoped window)
    // 資金決済法: the receipt of the purchase started before the window is accepted and granted during it
    const paid = await t.player('POST', '/v1/shop/purchase', t.receipt('T_m1'));
    expect(paid.status).toBe(200);
    expect((await t.svc.state('p1')).wallet.paid).toBeGreaterThan(0);

    // ended early from the console
    const cancel = await t.admin('admin', 'POST', '/v1/admin/maintenance/windows/m-1112/cancel', { reason: 'done early' });
    expect(cancel.status).toBe(200);
    expect((await t.player('GET', '/v1/gacha/banners')).status).toBe(200);
    expect((await t.admin('admin', 'POST', '/v1/admin/maintenance/windows/m-1112/cancel', { reason: 'twice' })).status).toBe(409);
    const view = await t.admin('viewer', 'GET', '/v1/admin/maintenance');
    expect(view.body.windows[0]).toMatchObject({ id: 'm-1112', status: 'ended_early' });

    const audit = await t.ops.api.auditQuery({ limit: 50 });
    const actions = audit.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['maintenance.schedule', 'maintenance.cancel']));
    const sEntry = audit.find((e) => e.action === 'maintenance.schedule' && e.result === 'ok')!;
    expect(sEntry).toMatchObject({ actor: 'admin', reason: 'nightly db work', target: 'maintenance:m-1112' });
  });

  it('a request that passed the gate completes even if the window starts while it is served (never mid-transaction)', async () => {
    const t = await setup();
    await t.player('POST', '/v1/player/bootstrap');
    await t.admin('admin', 'POST', '/v1/admin/maintenance/windows', { window: { id: 'm-all', startJst: '2026-11-12T02:00', endJst: '2026-11-12T06:00', scope: 'all', message: MSG }, reason: 'all down' });
    t.setNow(START - 1);
    t.setDuring(() => t.setNow(START + 1)); // the window opens while the DO is working
    expect((await t.player('POST', '/v1/rewards/login-bonus')).status).not.toBe(503);
    t.setDuring(null);
    expect((await t.player('GET', '/v1/player')).status).toBe(503);
    expect((await t.player('DELETE', '/v1/player')).status).not.toBe(503); // deletion is never closed
    expect((await t.call('GET', '/v1/health')).status).toBe(200);
  });

  it('refuses a maintenance change while another config activation is pending', async () => {
    const t = await setup();
    const v = await t.admin('admin', 'POST', '/v1/admin/config/versions', { bundle: { progression: {} }, reason: 'staged' });
    expect(v.status).toBe(200);
    await t.admin('admin', 'POST', '/v1/admin/config/activations', { versionId: v.body.version.id, at: NOW + 10 * H, reason: 'later' });
    const r = await t.admin('admin', 'POST', '/v1/admin/maintenance/windows', { window: { id: 'm2', startJst: '2026-11-12T02:00', endJst: '2026-11-12T06:00', scope: 'all', message: MSG }, reason: 'try' });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/pending/);
  });

  it('client versions: set from the console; below min → 426 everywhere but receipts; status endpoint tells the app', async () => {
    const t = await setup();
    await t.player('POST', '/v1/player/bootstrap');
    await t.player('PUT', '/v1/player/age', { birthYear: 1990, birthMonth: 1, guardianConsent: false });
    await t.player('POST', '/v1/shop/purchase-intent', { productId: 'coin_1500' });
    const bad = await t.admin('admin', 'PUT', '/v1/admin/maintenance/client-versions', { clientVersions: { ...VERSIONS, ios: { ...VERSIONS.ios, storeUrl: 'https://evil.example/x' } }, reason: 'bump' });
    expect(bad.status).toBe(400);
    expect((await t.admin('admin', 'PUT', '/v1/admin/maintenance/client-versions', { clientVersions: VERSIONS, minEngineLevel: 1, reason: 'bump to 1.2' })).status).toBe(200);
    const old = { 'x-client-platform': 'ios', 'x-client-version': '1.1.0' };
    const r = await t.player('GET', '/v1/player', undefined, old);
    expect(r.status).toBe(426);
    expect(r.body.error).toMatchObject({ code: 'UPGRADE_REQUIRED', message: 'アプリを最新版に更新してください', details: { storeUrl: VERSIONS.ios.storeUrl, minVersion: '1.2.0' } });
    expect((await t.player('GET', '/v1/player?lang=en', undefined, old)).body.error.message).toBe('Please update the app to the latest version');
    expect((await t.player('POST', '/v1/shop/purchase', t.receipt('T_old'), old)).status).toBe(200);
    const st = await t.call('GET', '/v1/maintenance', undefined, old);
    expect(st.body.client).toMatchObject({ status: 'required', storeUrl: VERSIONS.ios.storeUrl });
    expect((await t.player('GET', '/v1/player', undefined, { 'x-client-platform': 'ios', 'x-client-version': '1.2.0' })).status).toBe(200);
    // the engine floor from the console applies to race groups
    await t.admin('admin', 'PUT', '/v1/admin/maintenance/client-versions', { clientVersions: VERSIONS, minEngineLevel: 2, reason: 'engine 2' });
    const race = await t.player('POST', '/v1/match/enqueue', { horseId: 'h1' }, { 'x-engine-level': '1' });
    expect(race.status).toBe(426);
    expect(race.body.error.details).toMatchObject({ reason: 'engine', minEngineLevel: 2 });
  });
});
