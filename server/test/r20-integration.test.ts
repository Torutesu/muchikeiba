// Round 20 integration: §58 広告・分析の同意, §59 レビュー依頼, §60 クライアントのエラー報告, §61 端末のローカル通知 against
// each other and against Rounds 17–19 (§46 maintenance, §48 help, §51 data export, §54 transfer, §57 tips, account deletion, KPI).
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { m } from './helpers.js';
import { clientEventSchema } from '../src/domain/kpi.js';
import { KPI_ESSENTIAL, kpiClassOf } from '../src/domain/kpiConsent.js';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { memoryOps } from '../src/ops/memoryOps.js';
import { clientErrorBatchSchema } from '../src/domain/clientErrors.js';
import type { Master } from '../src/domain/master.js';
import { DEFAULT_MAINTENANCE, EXEMPT_ROUTES, endpointGroup, gateRequest, jstToMs, type MaintenanceConfig } from '../src/domain/maintenance.js';
import { routes } from '../src/http/app.js';
import { buildExportDocument } from '../src/domain/dataExport.js';
import { ClientErrorsCore, MemoryClientErrorRepo } from '../src/ops/clientErrors.js';
import { CLIENT_ERRORS_DEFAULTS } from '../src/domain/clientErrors.js';
import { runAccountDeletion, type DeletionPorts } from '../src/domain/accountDeletion.js';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const NOW = Date.UTC(2026, 10, 11, 3);
const V = m.progression.consent!.privacyVersion;
const csFiles = (dir: string) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.cs')).map((f) => read(join(dir, f))).join('\n');

describe('§58 KPI classification of the Round 19 / 20 events (REQ-CNS-012, §58.7)', () => {
  it('transfer events are essential (account access audit), engagement events optional', () => {
    for (const n of ['transfer_issue', 'transfer_redeem', 'consent_change']) expect(kpiClassOf(n), n).toBe('essential');
    for (const n of ['cheer_send', 'cheer_seen', 'perf_setting_change', 'asset_predownload', 'tutorial_replay', 'tip_view', 'tip_context_open',
      'review_prompt_eligible', 'review_prompt_shown', 'review_soft_answer', 'lnotif_scheduled', 'lnotif_opened', 'lnotif_permission']) {
      expect(kpiClassOf(n), n).toBe('optional');
      expect(n in KPI_ESSENTIAL, n).toBe(false);
    }
  });
  it('§58.7 in the protocol lists every Round 19 / 20 event with its class', () => {
    const p = read('contracts/protocol.md');
    const s = p.slice(p.indexOf('### 58.7'), p.indexOf('### 58.8'));
    for (const n of ['transfer_issue', 'transfer_redeem', 'cheer_send', 'cheer_seen', 'perf_setting_change', 'asset_predownload', 'tutorial_replay', 'tip_view',
      'tip_context_open', 'review_prompt_eligible', 'review_prompt_shown', 'review_soft_answer', 'lnotif_scheduled', 'lnotif_opened', 'lnotif_permission']) expect(s, n).toContain(n);
  });
});

describe('KPI: every client event has a C# constructor, a query and a §58 class (cross-check incl. Round 20)', () => {
  const names = clientEventSchema.options.map((o) => (o.shape.name as unknown as { value: string }).value);
  it('Round 20 client events are in the schema', () => {
    for (const n of ['lnotif_scheduled', 'lnotif_opened', 'lnotif_permission']) expect(names).toContain(n);
  });
  it('each client event is built by Muchi.Client, documented in docs/ops/kpi-queries.md and optional (§58.7: clients send no essential event)', () => {
    const cs = csFiles('engine/Muchi.Client');
    const q = read('docs/ops/kpi-queries.md');
    expect(names.filter((n) => !cs.includes(`"${n}"`))).toEqual([]);
    expect(names.filter((n) => !q.includes(n))).toEqual([]);
    expect(names.map((n) => (n === 'race_start' ? 'client_race_start' : n)).filter((n) => kpiClassOf(n) !== 'optional')).toEqual([]);
  });
  it('the server events of Round 20 are documented too', () => {
    const q = read('docs/ops/kpi-queries.md');
    for (const n of ['consent_change', 'review_prompt_eligible', 'review_prompt_shown', 'review_soft_answer']) expect(q, n).toContain(n);
  });
});

/** A Worker context on the real PlayerService (signed-in tokens `Bearer <playerId>`) with the memory ops store. */
function appWorld(master: Master = m) {
  let now = NOW;
  const svc = new PlayerService(new MemoryPlayerRepo(), { master, rng: seededRng(20), clock: () => now, verifiers: {} });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const ops = memoryOps(master, () => invoker);
  const c: AppContext = {
    master,
    authenticate: async (req) => { const a = req.headers.get('authorization'); if (a?.startsWith('Bearer p_')) return a.slice(7); throw new AppError('UNAUTHORIZED'); },
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
  };
  const req = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await handle(new Request(`https://x${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), {}, c);
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> };
  };
  return { svc, ops, c, req, setNow: (t: number) => { now = t; } };
}
let seq = 0;
const ceBatch = (attachPlayer = true) => clientErrorBatchSchema.parse({
  batchId: `b_r20_${String(++seq).padStart(6, '0')}`, platform: 'ios', appVersion: '1.4.0', osVersion: 'iOS 18.1', deviceModel: 'iPhone15,2',
  installId: 'inst_r20_000001', attachPlayer,
  items: [{ category: 'exception', at: NOW, count: 1, sampleRate: 1000, type: 'NullReferenceException', message: 'Object reference not set', stack: 'Muchi.Game.HudModel.Update ()', handled: false }],
});

describe('§58 × §60: the analytics choice governs the player id on client error samples (server-side too)', () => {
  it('analytics on → the sample keeps the player id; analytics off → no player id even when the device sent attachPlayer: true', async () => {
    const w = appWorld();
    await w.svc.bootstrap('p_on');
    await w.svc.bootstrap('p_off');
    await w.svc.setPrivacyChoices('p_off', { privacyVersion: V, source: 'settings', analytics: false });
    expect((await w.req('POST', '/v1/client-errors', ceBatch(), { authorization: 'Bearer p_on' })).body).toMatchObject({ accepted: 1 });
    expect((await w.req('POST', '/v1/client-errors', ceBatch(), { authorization: 'Bearer p_off' })).body).toMatchObject({ accepted: 1 });
    expect(w.ops.clientErrors.madeBy('p_on')).toHaveLength(1);
    expect(w.ops.clientErrors.madeBy('p_off')).toEqual([]); // the report counts, the id is not kept
    // turning analytics back on attaches again
    await w.svc.setPrivacyChoices('p_off', { privacyVersion: V, source: 'settings', analytics: true });
    await w.req('POST', '/v1/client-errors', ceBatch(), { authorization: 'Bearer p_off' });
    expect(w.ops.clientErrors.madeBy('p_off')).toHaveLength(1);
    // the player's object cannot answer → anonymous (fail closed), the report is still accepted
    const invoke = w.c.player('p_on').invoke;
    w.c.player = () => ({ invoke: (async (method: string, ...a: unknown[]) => { if (method === 'privacyChoices') throw new Error('down'); return (invoke as (...x: unknown[]) => unknown)(method, ...a); }) as PlayerInvoker['invoke'] });
    expect((await w.req('POST', '/v1/client-errors', ceBatch(), { authorization: 'Bearer p_on' })).body).toMatchObject({ accepted: 1 });
    expect(w.ops.clientErrors.madeBy('p_on')).toHaveLength(1);
  });
  it('a minor without a guardian consent (analytics locked off) is never attached', async () => {
    const w = appWorld();
    await w.svc.bootstrap('p_kid');
    await w.svc.setAge('p_kid', 2016, 1, false);
    await w.req('POST', '/v1/client-errors', ceBatch(), { authorization: 'Bearer p_kid' });
    expect(w.ops.clientErrors.madeBy('p_kid')).toEqual([]);
  });
  it('both spec sections say which choice governs it', () => {
    const p = read('contracts/protocol.md');
    expect(p.slice(p.indexOf('### 58.10'), p.indexOf('## 59.'))).toMatch(/AllowsDiagnostics/);
    expect(p.slice(p.indexOf('## 60.'), p.indexOf('## 61.'))).toMatch(/analytics\.effective/);
  });
});

describe('§46 gates × Round 20 routes (and the terms consent, R20 integration)', () => {
  const START = jstToMs('2026-11-12T02:00')!;
  const closed: MaintenanceConfig = {
    ...structuredClone(DEFAULT_MAINTENANCE),
    windows: [{ id: 'm1', startAtMs: START, endAtMs: START + 4 * 3600_000, scope: 'all', message: { ja: '点検中', en: 'Checks' } }],
    clientVersions: { ios: { min: '9.0.0', recommended: '9.0.0', storeUrl: 'https://apps.apple.com/jp/app/id1234567890' }, android: DEFAULT_MAINTENANCE.clientVersions.android },
  };
  const old = { platform: 'ios', version: '1.0.0', engine: null };
  const none = { platform: null, version: null, engine: null };
  const NEVER = ['POST /v1/player/consent', 'GET /v1/privacy/choices', 'PUT /v1/privacy/choices', 'PUT /v1/privacy/platform', 'POST /v1/privacy/prompt-shown', 'POST /v1/client-errors'];
  const CORE = ['GET /v1/review-prompt', 'POST /v1/review-prompt/check', 'POST /v1/review-prompt/rp_1/answer', 'GET /v1/push/preferences', 'PUT /v1/push/preferences'];
  it('terms consent, the ad / analytics choices and client error reports are never gated (any window, an outdated app)', () => {
    for (const r of NEVER) {
      const [method, path] = r.split(' ');
      expect(EXEMPT_ROUTES, r).toContain(r);
      expect(gateRequest(closed, method!, path!, none, START), r).toBeNull();
      expect(gateRequest(closed, method!, path!, old, START), r).toBeNull();
    }
  });
  it('the review prompt and the push preferences (reminders, §61) are core: closed by an `all` window', () => {
    for (const r of CORE) {
      const [method, path] = r.split(' ');
      expect(endpointGroup(path!), r).toBe('core');
      expect(EXEMPT_ROUTES.some((e) => e === r || e === `${method} ${path!.replace('rp_1', ':promptId')}`), r).toBe(false);
      expect(gateRequest(closed, method!, path!, none, START)?.code, r).toBe('MAINTENANCE');
    }
  });
  it('every Round 20 route exists, and §46.2 lists the never-gated ones', () => {
    const have = new Set(routes.map((r) => `${r.method} ${r.path}`));
    for (const r of [...NEVER, ...CORE.map((x) => x.replace('rp_1', ':promptId'))]) expect(have.has(r), r).toBe(true);
    const p = read('contracts/protocol.md');
    const s46 = p.slice(p.indexOf('### 46.2'), p.indexOf('### 46.3'));
    for (const r of ['/v1/player/consent', '/v1/privacy/choices', '/v1/privacy/platform', '/v1/privacy/prompt-shown', '/v1/client-errors', '/v1/transfer/redeem', '/v1/review-prompt']) expect(s46, r).toContain(r);
  });
});

describe('§51 data export and account deletion × Round 20 state', () => {
  async function seeded() {
    let now = NOW;
    const repo = new MemoryPlayerRepo();
    const svc = new PlayerService(repo, { master: m, rng: seededRng(51), clock: () => now, verifiers: {} });
    await svc.bootstrap('dx');
    await svc.setDisplayName('dx', 'ハヤテ');
    await svc.setPrivacyChoices('dx', { privacyVersion: V, source: 'settings', analytics: true, personalizedAds: false });
    await svc.tx('dx', null, (st) => {
      st.reviewPrompt = { v: 1, seq: 1, lastSessionId: 's_1', history: [{ id: 'rp_1', at: now - 86_400_000, moment: 'first_win', platform: 'ios', style: 'native', sessionId: 's_1', answer: null, nativeAt: now - 86_400_000 }] };
      return true;
    });
    const store = new MemoryClientErrorRepo();
    const core = new ClientErrorsCore(store);
    core.ingest(ceBatch(), { playerId: 'dx', installId: 'inst_r20_000001' }, now, CLIENT_ERRORS_DEFAULTS);
    return { svc, repo, core, store, now: () => now, advance: (ms: number) => { now += ms; } };
  }
  it('privacyChoices (account), reviewPrompt (analytics) and analytics.clientErrors are exported; nothing is unclassified', async () => {
    const w = await seeded();
    const s = await w.svc.state('dx');
    const doc = buildExportDocument(m, s, { ledger: [], gacha: [], names: {}, reportsMade: [], kpiEvents: null, clientErrors: w.core.madeBy('dx') }, 'dex_r20', 'ja', w.now());
    expect(doc.unclassified).toEqual([]);
    expect(doc.account.privacyChoices).toMatchObject({ personalizedAds: false, analytics: true, decidedVersion: V });
    expect(doc.analytics.reviewPrompts).toEqual([expect.objectContaining({ moment: 'first_win', style: 'native' })]);
    expect(doc.analytics.clientErrors).toMatchObject({ available: true, rows: [expect.objectContaining({ category: 'exception' })] });
    // §61 schedules live on the device only; §51.5 says so
    const p = read('contracts/protocol.md');
    const s515 = p.slice(p.indexOf('### 51.5'), p.indexOf('### 51.6'));
    for (const k of ['§58', '§59', '§60', '§61']) expect(s515, k).toContain(k);
  });
  it('deletion clears privacyChoices and reviewPrompt with the wipe and anonymises the client error samples', async () => {
    const w = await seeded();
    const tok = (await w.svc.requestDeletion('dx', null)) as { confirmToken: string };
    await w.svc.requestDeletion('dx', tok.confirmToken);
    w.advance(15 * 86_400_000);
    const ports = {
      start: async (u: string) => { await w.svc.deletionStart(u); }, snapshot: (u: string) => w.svc.deletionSnapshot(u),
      markStep: async (u: string, st: never) => { await w.svc.deletionMarkStep(u, st); },
      friends: { removeFriend: async () => undefined, dropOutgoing: async () => undefined, dropIncoming: async () => undefined },
      directory: { forget: async () => undefined }, leaderboards: { forget: async () => undefined, deleteGhosts: async () => undefined },
      clientErrors: { forget: async (u: string) => w.core.forgetPlayer(u) },
      finalize: (u: string) => w.svc.deletionFinalize(u), retain: async () => undefined, wipe: (u: string) => w.svc.wipe(u),
    } as unknown as DeletionPorts;
    const before = await w.svc.state('dx');
    expect(before.privacyChoices).toBeTruthy();
    expect(before.reviewPrompt?.history).toHaveLength(1);
    const r = await runAccountDeletion(ports, 'dx', w.now());
    expect(r.done).toEqual(expect.arrayContaining(['client_errors', 'wipe']));
    expect(w.repo.get('dx')).toBeNull(); // privacyChoices and reviewPrompt go with the state
    expect(w.core.madeBy('dx')).toEqual([]);
    expect(w.store.sampleRows.map((x) => x.playerId)).toEqual([null]);
  });
});
