import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { BASE_BANNED_SILKS, bannedMatch, bannedSilksProblems, silksSignature, type BannedSilksList } from '../src/domain/bannedSilks.js';
import { defaultSilks, isBannedSilks, VISUALS } from '../src/domain/visuals.js';
import { resolveBundle } from '../src/ops/config.js';
import { handle, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { memoryOps } from '../src/ops/memoryOps.js';
import { authenticateAdmin } from '../src/ops/admin.js';
import { sha256Hex } from '../src/ops/hash.js';
import { DEFAULT_RULESET } from '../src/domain/ruleset.js';
import { AppError } from '../src/domain/errors.js';
import type { Master } from '../src/domain/master.js';

const NOW = Date.UTC(2026, 10, 12, 3);

/** "青、白襷" style entry written with the Japanese aliases, as it would be transcribed from a registry. */
const LIST: BannedSilksList = {
  ...BASE_BANNED_SILKS,
  entries: [{ id: 'reg-0001', source: '登録服色（公開情報）2026-11 確認', description: '青、白襷', pattern: '襷', colors: ['青', '白'] }],
};

function svcWith(master: Master) {
  return new PlayerService(new MemoryPlayerRepo(), { master, rng: seededRng(5), clock: () => NOW, verifiers: {} });
}

describe('banned real silks (REQ-ASSET-010 / REQ-OPS-040)', () => {
  it('the shipped list is structured, valid and empty (to be filled from the public registry before release)', () => {
    expect(BASE_BANNED_SILKS.format).toBe(1);
    expect(BASE_BANNED_SILKS.entries).toEqual([]);
    expect(bannedSilksProblems(BASE_BANNED_SILKS, VISUALS)).toEqual([]);
  });

  it('matches on the normalised signature: aliases and colour families (紺 ≈ 青)', () => {
    expect(silksSignature(LIST, '襷', ['青', '白'])).toBe(silksSignature(LIST, 'sash', ['navy', 'white']));
    expect(bannedMatch(LIST, { pattern: 'sash', colors: ['blue', 'white'], cap: 'plain' })?.id).toBe('reg-0001');
    expect(bannedMatch(LIST, { pattern: 'sash', colors: ['navy', 'white'], cap: 'star' })?.id).toBe('reg-0001'); // near-identical shade
    expect(bannedMatch(LIST, { pattern: 'sash', colors: ['white', 'blue'], cap: 'plain' })).toBeNull(); // order matters (body first)
    expect(bannedMatch(LIST, { pattern: 'hoops', colors: ['blue', 'white'], cap: 'plain' })).toBeNull();
    const capped: BannedSilksList = { ...LIST, entries: [{ ...LIST.entries[0]!, cap: 'star' }] };
    expect(bannedMatch(capped, { pattern: 'sash', colors: ['blue', 'white'], cap: 'plain' })).toBeNull();
    expect(bannedMatch(capped, { pattern: 'sash', colors: ['blue', 'white'], cap: 'star' })).not.toBeNull();
  });

  it('player silks on a banned signature are rejected; other combinations still work', async () => {
    const master = resolveBundle(m, { bannedSilks: LIST }).master;
    const svc = svcWith(master);
    await expect(svc.setSilks('p1', { pattern: 'sash', colors: ['navy', 'white'], cap: 'plain' })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringMatching(/reserved/) });
    await expect(svc.setSilks('p1', { pattern: 'sash', colors: ['red', 'white'], cap: 'plain' })).resolves.toMatchObject({ silks: { pattern: 'sash' } });
    // the base master (empty list) allows the same combination
    await expect(svcWith(m).setSilks('p2', { pattern: 'sash', colors: ['navy', 'white'], cap: 'plain' })).resolves.toBeTruthy();
  });

  it('default silks never land on a banned combination', () => {
    for (let i = 0; i < 300; i++) expect(isBannedSilks(defaultSilks(`seed-${i}`, VISUALS), VISUALS, LIST)).toBe(false);
  });

  it('remote config rejects an invalid list (unknown pattern/colour, duplicates, reserving the fallback)', () => {
    const bad: BannedSilksList = {
      ...BASE_BANNED_SILKS,
      entries: [
        { id: 'a', source: 'registry', pattern: 'zigzag', colors: ['blue', 'white'] },
        { id: 'a', source: 'registry', pattern: 'plain', colors: ['ultraviolet', 'white'] },
        { id: 'c', source: 'registry', pattern: 'plain', colors: ['white', 'navy'], cap: 'plain' },
      ],
    };
    const p = bannedSilksProblems(bad, VISUALS);
    expect(p.join('\n')).toMatch(/unknown pattern zigzag/);
    expect(p.join('\n')).toMatch(/unknown colour ultraviolet/);
    expect(p.join('\n')).toMatch(/duplicate id a/);
    expect(p.join('\n')).toMatch(/default fallback/);
    expect(() => resolveBundle(m, { bannedSilks: bad })).toThrow(/bannedSilks/);
  });
});

describe('admin import of the banned list (REQ-OPS-040)', () => {
  async function setup() {
    const svc = svcWith(m);
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
    const ops = memoryOps(m, () => invoker);
    const tokens = { viewer: 'viewer-token-0123456789', admin: 'admin-token-0123456789' };
    const auth = { tokens: [{ name: 'viewer', role: 'viewer' as const, sha256: await sha256Hex(tokens.viewer) }, { name: 'admin', role: 'admin' as const, sha256: await sha256Hex(tokens.admin) }] };
    const c = {
      master: m, authenticate: async () => { throw new AppError('UNAUTHORIZED'); }, player: () => invoker, clock: () => NOW,
      ops: ops.api, authenticateAdmin: (req: Request) => authenticateAdmin(req, auth),
      configInfo: async () => ({ versionId: 'base', hash: 'base', rulesetVersion: DEFAULT_RULESET.rulesetVersion, activatedAt: null }),
      leaderboard: { board: async () => ({}), myRank: async () => ({}) }, paidBalance: async () => ({}), race: { replay: async () => ({}) },
    } as unknown as AppContext;
    const call = async (role: keyof typeof tokens, method: string, path: string, body?: unknown) => {
      const res = await handle(new Request(`https://x${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[role]}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), {}, c);
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    return { call, ops };
  }

  it('validates, stages a config version on top of the active bundle, audits; activation makes it live', async () => {
    const { call, ops } = await setup();
    expect((await call('viewer', 'POST', '/v1/admin/silks/banned/import', { list: LIST, reason: 'registry sync' })).status).toBe(403);
    const bad = await call('admin', 'POST', '/v1/admin/silks/banned/import', { list: { ...LIST, entries: [{ id: 'x', source: 'registry', pattern: 'zigzag', colors: ['blue', 'white'] }] }, reason: 'registry sync' });
    expect(bad.status).toBe(400);
    const ok = await call('admin', 'POST', '/v1/admin/silks/banned/import', { list: LIST, reason: 'registry sync' });
    expect(ok.status).toBe(200);
    expect(ok.body.entries).toBe(1);
    const versionId = ok.body.version.id as string;
    expect(ops.audits.rows.some((r) => r.action === 'silks.banned.import' && r.result === 'ok' && r.target === `config:${versionId}`)).toBe(true);
    // not live until activated
    expect((await call('viewer', 'POST', '/v1/admin/silks/banned/check', { silks: { pattern: 'sash', colors: ['navy', 'white'], cap: 'plain' } })).body.banned).toBeNull();
    expect((await call('admin', 'POST', '/v1/admin/config/activations', { versionId, reason: 'ship registry sync' })).status).toBe(200);
    const view = await call('viewer', 'GET', '/v1/admin/silks/banned');
    expect(view.body.source).toBe('remote-config');
    expect(view.body.list.entries).toHaveLength(1);
    expect((await call('viewer', 'POST', '/v1/admin/silks/banned/check', { silks: { pattern: 'sash', colors: ['navy', 'white'], cap: 'plain' } })).body.banned.id).toBe('reg-0001');
  });
});
