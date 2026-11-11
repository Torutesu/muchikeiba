/**
 * クライアントのエラー報告 (REQ-CERR-001..020, contracts/protocol.md §60): config, scrubber / fingerprint vectors, the
 * store (idempotency, rate limits, bounds, retention, the spike alert, deletion), the HTTP route (optional auth, never
 * gated, size caps) and the console API.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { authenticateAdmin, type AdminAuthConfig } from '../src/ops/admin.js';
import { sha256Hex } from '../src/ops/hash.js';
import { memoryOps } from '../src/ops/memoryOps.js';
import { m } from './helpers.js';
import {
  CLIENT_ERRORS_DEFAULTS, clientErrorBatchSchema, clientErrorVectorsJson, clientErrorsConfig, clientErrorsProblems, fingerprintOf, scrubItem, scrubMessage, scrubStack,
  type ClientErrorBatch, type ClientErrorsConfig,
} from '../src/domain/clientErrors.js';
import { ClientErrorsCore, MemoryClientErrorRepo } from '../src/ops/clientErrors.js';
import { DEFAULT_MAINTENANCE, EXEMPT_ROUTES } from '../src/domain/maintenance.js';
import { DELETION_STEPS, runAccountDeletion, type DeletionPorts } from '../src/domain/accountDeletion.js';
import { buildExportDocument } from '../src/domain/dataExport.js';
import type { Master } from '../src/domain/master.js';

const ROOT = join(import.meta.dirname, '..', '..');
const NOW = Date.UTC(2026, 10, 11, 3);
const HOUR = 3600_000;
const DAY = 86_400_000;
const cfg = (over: Partial<ClientErrorsConfig> = {}): ClientErrorsConfig => ({ ...CLIENT_ERRORS_DEFAULTS, ...over, sampling: { ...CLIENT_ERRORS_DEFAULTS.sampling, ...(over.sampling ?? {}) } });
const withCE = (ce: unknown) => ({ progression: { ...m.progression, clientErrors: ce } }) as unknown as Pick<Master, 'progression'>;

let seq = 0;
const exc = (message = 'Object reference not set to an instance of an object', stack = 'Muchi.Game.HudModel.Update () (at Assets/Muchi/Game/HudModel.cs:120)') =>
  ({ category: 'exception' as const, at: NOW, count: 1, sampleRate: 1000, type: 'NullReferenceException', message, stack, handled: false });
const batch = (items: unknown[], over: Partial<ClientErrorBatch> = {}): ClientErrorBatch => clientErrorBatchSchema.parse({
  batchId: `b_${String(++seq).padStart(8, '0')}`, platform: 'ios', appVersion: '1.4.0', osVersion: 'iOS 18.1', deviceModel: 'iPhone15,2',
  installId: 'inst_0000000001', attachPlayer: true, items, ...over,
});

describe('config (REQ-CERR-001)', () => {
  it('the shipped master is valid; desync must stay 1000, every category is needed, ranges and unknown keys are problems', () => {
    expect(clientErrorsProblems(m)).toEqual([]);
    expect(clientErrorsConfig(m)).toEqual(CLIENT_ERRORS_DEFAULTS);
    expect(clientErrorsProblems(withCE({ sampling: { exception: 1000, api: 200, desync: 500, asset: 500, stall: 100 } }))).toEqual([expect.stringMatching(/desync must be 1000/)]);
    expect(clientErrorsProblems(withCE({ sampling: { exception: 1000 } })).some((p) => /sampling\.api is required/.test(p))).toBe(true);
    expect(clientErrorsProblems(withCE({ sampling: { exception: 1001, api: -1, desync: 1000, asset: 1.5, stall: 0 } }))).toHaveLength(3);
    expect(clientErrorsProblems(withCE({ maxItems: 0, retentionDays: 365, whatever: 1, _note: 'ok' }))).toEqual([
      'progression.clientErrors.whatever is unknown', expect.stringMatching(/maxItems/), expect.stringMatching(/retentionDays/),
    ]);
    expect(clientErrorsProblems(withCE([]))).toEqual(['progression.clientErrors must be an object']);
  });
});

describe('scrubber and fingerprint (REQ-CERR-008/009)', () => {
  it('the committed shared vectors equal what the server computes (C# reads the same file)', () => {
    expect(readFileSync(join(ROOT, 'contracts/client-errors.vectors.json'), 'utf8')).toBe(clientErrorVectorsJson());
  });
  it('no email, token, player name, free text or path survives; device model and OS version stay', () => {
    const s = scrubMessage('user bob@corp.jp "ハヤテ" Bearer abc.def.ghi at /Users/bob/x/y/Foo.cs:3 id=p_12ab45 9876543 https://x.test/a?t=1');
    expect(s).toBe('user <email> "…" <token> at Foo.cs:3 id=<id> <n> <url>');
    expect(scrubStack('a\n\n' + 'line\n'.repeat(60)).split('\n')).toHaveLength(40);
    expect([...scrubMessage('x'.repeat(1000))]).toHaveLength(300);
    const b = batch([exc()], { deviceModel: 'Pixel 8', osVersion: 'Android 14' });
    expect(b.deviceModel).toBe('Pixel 8');
  });
  it('the fingerprint ignores line numbers and paths, but not the frames or the message shape', () => {
    const a = fingerprintOf(scrubItem(exc(undefined, 'A.B () (at /Users/x/A.cs:10)')));
    expect(fingerprintOf(scrubItem(exc(undefined, 'A.B () (at C:\\work\\A.cs:99)')))).toBe(a);
    expect(fingerprintOf(scrubItem(exc(undefined, 'A.C () (at A.cs:10)')))).not.toBe(a);
    expect(fingerprintOf(scrubItem(exc('Sequence contains 3 elements')))).toBe(fingerprintOf(scrubItem(exc('Sequence contains 7 elements'))));
  });
  it('a desync item carries race id and tick only: inputs / checksums make the batch invalid (strict)', () => {
    const d = { category: 'desync', at: NOW, raceId: 'race_1', tick: 812, mode: 'ranked' };
    expect(clientErrorBatchSchema.safeParse({ ...batch([exc()]), items: [d] }).success).toBe(true);
    expect(clientErrorBatchSchema.safeParse({ ...batch([exc()]), items: [{ ...d, inputs: [1, 2, 3] }] }).success).toBe(false);
    expect(clientErrorBatchSchema.safeParse({ ...batch([exc()]), items: [{ ...d, checksum: 'abc' }] }).success).toBe(false);
    expect(clientErrorBatchSchema.safeParse({ ...batch([exc()]), items: [{ ...exc(), playerName: 'ハヤテ' }] }).success).toBe(false);
  });
});

describe('the store (REQ-CERR-005/007/010..013/017/018)', () => {
  const core = (onAlert?: (g: unknown) => void) => { const repo = new MemoryClientErrorRepo(); return { repo, core: new ClientErrorsCore(repo, onAlert) }; };

  it('aggregates by fingerprint; versions, platforms, estimated counts from the sample rate; a retried batch adds nothing', () => {
    const { repo, core: c } = core();
    const b1 = batch([exc(), { ...exc(), count: 3 }, { category: 'api', at: NOW, method: 'GET', route: '/v1/horses/h_9f2k/goals', status: 503, reason: 'http', sampleRate: 200 }]);
    expect(c.ingest(b1, { playerId: 'p1', installId: b1.installId }, NOW, cfg())).toMatchObject({ accepted: 3, duplicate: false });
    expect(c.ingest(b1, { playerId: 'p1', installId: b1.installId }, NOW + 1000, cfg())).toMatchObject({ accepted: 0, duplicate: true });
    const b2 = batch([exc()], { platform: 'android', appVersion: '1.4.1' });
    c.ingest(b2, { playerId: null, installId: b2.installId }, NOW + HOUR, cfg());
    const list = c.list({ limit: 10 }, NOW + HOUR, cfg());
    expect(list.groups.map((g) => [g.category, g.count, g.estimated])).toEqual([['exception', 5, 5], ['api', 1, 5]]);
    const e = list.groups[0]!;
    expect(e.versions).toEqual([{ appVersion: '1.4.0', count: 4 }, { appVersion: '1.4.1', count: 1 }]);
    expect(e.platforms).toEqual({ ios: 4, android: 1 });
    expect([e.firstVersion, e.lastVersion]).toEqual(['1.4.0', '1.4.1']);
    expect(list.groups[1]!.title).toBe('GET /v1/horses/:id/goals → 503 (http)');
    expect(list.totals).toEqual({ groups: 2, byCategory: { exception: 1, api: 1, desync: 0, asset: 0, stall: 0 } });
    expect(c.list({ limit: 10, platform: 'android' }, NOW, cfg()).groups).toHaveLength(1);
    expect(c.list({ limit: 10, appVersion: '1.4.1' }, NOW, cfg()).groups).toHaveLength(1);
    expect(c.list({ limit: 10, category: 'api' }, NOW, cfg()).groups).toHaveLength(1);
    const d = c.get(e.fingerprint, NOW + HOUR);
    expect(d.days.map((x) => [x.appVersion, x.platform, x.count])).toEqual([['1.4.0', 'ios', 4], ['1.4.1', 'android', 1]]);
    // REQ-CERR-013: the anonymous / attachPlayer:false samples have no player id; aggregates never do
    expect(d.samples.map((s) => s.playerId)).toEqual([null, 'p1', 'p1']);
    expect(JSON.stringify([...repo.groups.values()])).not.toContain('p1');
    expect(() => c.get('0000000000000000', NOW)).toThrow(AppError);
  });

  it('attachPlayer: false keeps no player id even when signed in', () => {
    const { core: c } = core();
    const b = batch([exc()], { attachPlayer: false });
    c.ingest(b, { playerId: 'p1', installId: b.installId }, NOW, cfg());
    expect(c.madeBy('p1')).toEqual([]);
  });

  it('rate limits per player, per device and for anonymous batches; a refused batch is not remembered (sent again later)', () => {
    const { core: c } = core();
    const lim = cfg({ perPlayerPerHour: 2, perDevicePerHour: 3, anonymousPerMinute: 1 });
    c.ingest(batch([exc()], { installId: 'dev_aaaaaaaa' }), { playerId: 'p1', installId: 'dev_aaaaaaaa' }, NOW, lim);
    c.ingest(batch([exc()], { installId: 'dev_bbbbbbbb' }), { playerId: 'p1', installId: 'dev_bbbbbbbb' }, NOW, lim);
    const refused = batch([exc()], { installId: 'dev_cccccccc' });
    expect(() => c.ingest(refused, { playerId: 'p1', installId: 'dev_cccccccc' }, NOW, lim)).toThrow(expect.objectContaining({ code: 'RATE_LIMITED', status: 429 }));
    expect(c.ingest(refused, { playerId: 'p1', installId: 'dev_cccccccc' }, NOW + HOUR, lim)).toMatchObject({ accepted: 1, duplicate: false });
    // device limit (another player on the same device)
    c.ingest(batch([exc()], { installId: 'dev_dddddddd' }), { playerId: 'p2', installId: 'dev_dddddddd' }, NOW, lim);
    c.ingest(batch([exc()], { installId: 'dev_dddddddd' }), { playerId: 'p3', installId: 'dev_dddddddd' }, NOW, lim);
    c.ingest(batch([exc()], { installId: 'dev_dddddddd' }), { playerId: 'p4', installId: 'dev_dddddddd' }, NOW, lim);
    expect(() => c.ingest(batch([exc()], { installId: 'dev_dddddddd' }), { playerId: 'p5', installId: 'dev_dddddddd' }, NOW, lim)).toThrow(/too many/);
    // anonymous: one per minute across all devices
    c.ingest(batch([exc()], { installId: 'dev_eeeeeeee' }), { playerId: null, installId: 'dev_eeeeeeee' }, NOW, lim);
    expect(() => c.ingest(batch([exc()], { installId: 'dev_ffffffff' }), { playerId: null, installId: 'dev_ffffffff' }, NOW + 1000, lim)).toThrow(/too many/);
    expect(c.ingest(batch([exc()], { installId: 'dev_ffffffff' }), { playerId: null, installId: 'dev_ffffffff' }, NOW + 61_000, lim).accepted).toBe(1);
    expect(() => c.ingest(batch(Array.from({ length: 21 }, () => exc())), { playerId: null, installId: 'dev_gggggggg' }, NOW + 200_000, cfg())).toThrow(/at most 20/);
  });

  it('bounded: maxGroups (overflow row per category), samplesPerGroup, retention purge of old rows and batch keys', () => {
    const { repo, core: c } = core();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const small = cfg({ maxGroups: 100, samplesPerGroup: 2, perDevicePerHour: 600, perPlayerPerHour: 600 });
    for (let i = 0; i < 6; i++) c.ingest(batch(Array.from({ length: 20 }, (_, j) => exc(`err ${i}`, `F${String.fromCharCode(97 + i)}${String.fromCharCode(97 + j)}.G () (at a.cs:1)`))), { playerId: 'p1', installId: 'inst_0000000001' }, NOW, small);
    expect(repo.groups.size).toBe(101);
    const of = c.get('overflow:exception', NOW);
    expect(of.count).toBe(20);
    expect(of.title).toMatch(/store full/);
    expect(of.samples).toHaveLength(2);
    expect(repo.batches.size).toBe(6);
    // 31 days later: everything is past retention; a new batch purges a few rows at a time (50)
    c.ingest(batch([exc('fresh')]), { playerId: 'p1', installId: 'inst_0000000001' }, NOW + 31 * DAY, small);
    expect(repo.groups.size).toBeLessThan(101);
    expect(repo.batches.size).toBe(1);
    for (let k = 0; k < 3; k++) c.ingest(batch([exc('fresh')]), { playerId: 'p1', installId: 'inst_0000000001' }, NOW + 31 * DAY + k, small);
    expect(repo.groups.size).toBe(1);
    expect([...repo.dayRows.values()].every((d) => d.day >= '2026-11-12')).toBe(true);
    warn.mockRestore();
  });

  it('a new fingerprint reaching spikeMinCount inside the window alerts once (structured log + hook); an old one does not', () => {
    const hook = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { core: c } = core(hook);
    const lim = cfg({ spikeMinCount: 10, perDevicePerHour: 600, perPlayerPerHour: 600 });
    c.ingest(batch([{ ...exc(), count: 4 }]), { playerId: 'p1', installId: 'inst_0000000001' }, NOW, lim);
    c.ingest(batch([{ ...exc(), count: 1, sampleRate: 100 }]), { playerId: 'p1', installId: 'inst_0000000001' }, NOW + HOUR, lim); // estimated 4 + 10
    c.ingest(batch([{ ...exc(), count: 50 }]), { playerId: 'p1', installId: 'inst_0000000001' }, NOW + 2 * HOUR, lim);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warn.mock.calls[0]![0] as string)).toMatchObject({ alert: 'client_error_spike', category: 'exception', appVersion: '1.4.0', estimated: 14 });
    // an old fingerprint (first seen 2 days ago) growing now does not alert
    c.ingest(batch([exc('old one')]), { playerId: 'p1', installId: 'inst_0000000001' }, NOW, lim);
    c.ingest(batch([{ ...exc('old one'), count: 100 }]), { playerId: 'p1', installId: 'inst_0000000001' }, NOW + 2 * DAY, lim);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(c.list({ limit: 10 }, NOW + 2 * DAY, lim).alerts).toHaveLength(1);
    warn.mockRestore();
  });

  it('deletion anonymises the samples and drops the rate row; madeBy lists the player\'s samples for the export', () => {
    const { repo, core: c } = core();
    c.ingest(batch([exc(), { category: 'desync', at: NOW, raceId: 'race_9', tick: 400, mode: 'ranked' }]), { playerId: 'gone', installId: 'inst_0000000001' }, NOW, cfg());
    expect(c.madeBy('gone').map((r) => r.category)).toEqual(expect.arrayContaining(['exception', 'desync']));
    expect(c.forgetPlayer('gone')).toEqual({ anonymised: 2, rates: 1 });
    expect(repo.sampleRows.every((s) => s.playerId === null)).toBe(true);
    expect(c.madeBy('gone')).toEqual([]);
    expect(c.forgetPlayer('gone')).toEqual({ anonymised: 0, rates: 0 });
  });
});

const TOKENS = { viewer: 'viewer-token-0123456789' };
async function setup(master: Master = m, opts: { noStore?: boolean } = {}) {
  let now = NOW;
  const svc = new PlayerService(new MemoryPlayerRepo(), { master, rng: seededRng(3), clock: () => now, verifiers: {} });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const ops = memoryOps(master, () => invoker);
  if (opts.noStore) delete ops.api.clientErrors;
  const auth: AdminAuthConfig = { tokens: [{ name: 'viewer', role: 'viewer', sha256: await sha256Hex(TOKENS.viewer) }] };
  const c: AppContext = {
    master,
    authenticate: async (req) => { const a = req.headers.get('authorization'); if (a === 'Bearer good') return 'p_good1'; throw new AppError('UNAUTHORIZED'); },
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
  };
  const post = async (b: unknown, headers: Record<string, string> = {}) => {
    const res = await handle(new Request('https://x/v1/client-errors', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof b === 'string' ? b : JSON.stringify(b) }), {}, c);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const admin = async (path: string) => {
    const res = await handle(new Request(`https://x${path}`, { headers: { authorization: `Bearer ${TOKENS.viewer}` } }), {}, c);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { ops, c, post, admin, setNow: (t: number) => { now = t; } };
}

describe('POST /v1/client-errors (REQ-CERR-003..007)', () => {
  it('anonymous and signed-in batches are accepted; an invalid token is anonymous (not 401); the answer carries the sampling', async () => {
    const { post, ops } = await setup();
    const anon = await post(batch([exc()]));
    expect(anon.status).toBe(200);
    expect(anon.body).toMatchObject({ accepted: 1, duplicate: false, enabled: true, sampling: CLIENT_ERRORS_DEFAULTS.sampling, flushIntervalSec: 60 });
    expect((await post(batch([exc()]), { authorization: 'Bearer expired' })).status).toBe(200);
    await post(batch([exc()]), { authorization: 'Bearer good' });
    expect(ops.clientErrors.madeBy('p_good1')).toHaveLength(1);
    const same = batch([exc()]);
    await post(same, { authorization: 'Bearer good' });
    expect((await post(same, { authorization: 'Bearer good' })).body).toMatchObject({ accepted: 0, duplicate: true });
  });
  it('size caps (413), invalid batches (400), too many items, and never closed by maintenance or the version gate', async () => {
    const { post } = await setup();
    expect((await post(batch([exc('x'.repeat(1900), 'y'.repeat(15000)), exc('x'.repeat(1900), 'y'.repeat(15000)), exc('x'.repeat(1900), 'y'.repeat(15000))]))).status).toBe(413);
    expect((await post('{not json')).status).toBe(400);
    expect((await post({ ...batch([exc()]), extra: 1 })).status).toBe(400);
    expect((await post({ ...batch([exc()]), items: Array.from({ length: 21 }, () => exc('a', '')) })).status).toBe(400);
    expect(EXEMPT_ROUTES).toContain('POST /v1/client-errors');
    const closed: Master = { ...m, maintenance: { ...DEFAULT_MAINTENANCE, windows: [{ id: 'w1', startAtMs: NOW - HOUR, endAtMs: NOW + HOUR, scope: 'all', message: { ja: '点検中', en: 'Checks' } }], clientVersions: { ios: { min: '9.0.0', recommended: '9.0.0', storeUrl: 'https://apps.example/x' }, android: DEFAULT_MAINTENANCE.clientVersions.android } } };
    const s2 = await setup(closed);
    const r = await s2.post(batch([exc()]), { 'x-client-platform': 'ios', 'x-client-version': '1.0.0' });
    expect(r.status).toBe(200);
    expect(r.body.accepted).toBe(1);
  });
  it('enabled: false or no store: nothing is stored, the answer says enabled: false', async () => {
    const off: Master = { ...m, progression: { ...m.progression, clientErrors: { ...CLIENT_ERRORS_DEFAULTS, enabled: false } } } as Master;
    const s = await setup(off);
    expect((await s.post(batch([exc()]))).body).toMatchObject({ accepted: 0, enabled: false });
    expect(s.ops.clientErrorRepo.groups.size).toBe(0);
    const n = await setup(m, { noStore: true });
    expect((await n.post(batch([exc()]))).body).toMatchObject({ accepted: 0, enabled: false });
  });
  it('GET /v1/config tells the device the sampling', async () => {
    const { c } = await setup();
    const res = await handle(new Request('https://x/v1/config'), {}, c);
    expect(((await res.json()) as Record<string, unknown>).clientErrors).toEqual({ enabled: true, sampling: CLIENT_ERRORS_DEFAULTS.sampling, flushIntervalSec: 60 });
  });
});

describe('console API (REQ-CERR-014..016)', () => {
  it('lists with filters, shows one fingerprint; a desync sample links to the replay and the integrity events of that race', async () => {
    const { post, admin } = await setup();
    await post(batch([exc(), { category: 'desync', at: NOW, raceId: 'race_77', tick: 812, mode: 'ranked' }]), { authorization: 'Bearer good' });
    const list = await admin('/v1/admin/client-errors?sort=count&limit=10');
    expect(list.status).toBe(200);
    expect(list.body.groups).toHaveLength(2);
    expect((await admin('/v1/admin/client-errors?category=nope')).status).toBe(400);
    expect((await admin('/v1/admin/client-errors?platform=android')).body.groups).toHaveLength(0);
    const ds = list.body.groups.find((g: { category: string }) => g.category === 'desync');
    const d = await admin(`/v1/admin/client-errors/${ds.fingerprint}`);
    expect(d.body.samples[0].race).toMatchObject({ raceId: 'race_77', tick: 812, replay: '/v1/admin/replays/race_77', integrity: { status: expect.any(String), events: [] } });
    expect(d.body.samples[0].context).not.toHaveProperty('inputs');
    expect((await admin('/v1/admin/client-errors/not-a-fp')).status).toBe(400);
    expect((await admin('/v1/admin/client-errors/0000000000000000')).status).toBe(404);
  });
});

describe('account deletion and the data export (REQ-CERR-018/019)', () => {
  it('the client_errors step runs after inquiries and anonymises; the export lists the samples under analytics', async () => {
    expect(DELETION_STEPS.indexOf('client_errors')).toBe(DELETION_STEPS.indexOf('inquiries') + 1);
    let now = NOW;
    const repo = new MemoryPlayerRepo();
    const svc = new PlayerService(repo, { master: m, rng: seededRng(5), clock: () => now, verifiers: {} });
    const store = new MemoryClientErrorRepo();
    const core = new ClientErrorsCore(store);
    core.ingest(batch([exc()]), { playerId: 'gone', installId: 'inst_0000000001' }, now, cfg());
    await svc.setDisplayName('gone', 'キエル');
    const s = await svc.state('gone');
    const doc = buildExportDocument(m, s, { ledger: [], gacha: [], names: {}, reportsMade: [], kpiEvents: null, clientErrors: core.madeBy('gone') }, 'dex_x', 'ja', now);
    expect(doc.analytics.clientErrors).toMatchObject({ available: true, rows: [{ category: 'exception', appVersion: '1.4.0', platform: 'ios', deviceModel: 'iPhone15,2' }] });
    expect(buildExportDocument(m, s, { ledger: [], gacha: [], names: {}, reportsMade: [], kpiEvents: null, clientErrors: null }, 'dex_x', 'ja', now).analytics.clientErrors.available).toBe(false);
    expect(Object.keys(s)).not.toContain('clientErrors'); // no new PlayerState key (§51 classification unchanged)
    const tok = (await svc.requestDeletion('gone', null)) as { confirmToken: string };
    await svc.requestDeletion('gone', tok.confirmToken);
    now += 15 * DAY;
    const ports: DeletionPorts = {
      start: async (u) => { await svc.deletionStart(u); }, snapshot: (u) => svc.deletionSnapshot(u), markStep: async (u, st) => { await svc.deletionMarkStep(u, st); },
      friends: { removeFriend: async () => undefined, dropOutgoing: async () => undefined, dropIncoming: async () => undefined },
      directory: { forget: async () => undefined }, leaderboards: { forget: async () => undefined, deleteGhosts: async () => undefined },
      clientErrors: { forget: async (u) => core.forgetPlayer(u) },
      finalize: (u) => svc.deletionFinalize(u), retain: async () => undefined, wipe: (u) => svc.wipe(u),
    };
    const r = await runAccountDeletion(ports, 'gone', now);
    expect(r.done).toContain('client_errors');
    expect(store.sampleRows.map((x) => x.playerId)).toEqual([null]);
    expect(store.groups.size).toBe(1); // the error itself stays (ops data)
  });
});
