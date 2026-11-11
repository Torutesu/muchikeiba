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
