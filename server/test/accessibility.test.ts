// アクセシビリティ設定 (REQ-A11Y-001..004/014, contracts/protocol.md §41): the server-side settings blob.
import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { A11Y_DEFAULTS, accessibilityBodySchema } from '../src/domain/accessibility.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';

function world() {
  let now = Date.UTC(2026, 11, 10, 3);
  const kpi: KpiRecord[] = [];
  const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(3), clock: () => now, verifiers: {}, onKpi: (_id, recs) => { kpi.push(...recs); } });
  return { svc, kpi, advance: (ms: number) => { now += ms; }, now: () => now };
}
const a11yKpi = (k: KpiRecord[]) => k.filter((x) => x.name === 'a11y_setting_change');
const FULL = { textSize: 'largest', colorMode: 'cvd', reduceMotion: true, haptics: false, subtitles: true, oneHanded: 'right', whipInput: 'hold' } as const;

describe('REQ-A11Y-001/003 defaults, GET and the player bootstrap', () => {
  it('defaults: standard text, standard colours, motion on, haptics on, subtitles on, two-handed, tap', async () => {
    const w = world();
    const boot = await w.svc.bootstrap('p');
    expect(boot.accessibility).toMatchObject({ ...A11Y_DEFAULTS, rev: 0, updatedAt: null });
    expect(A11Y_DEFAULTS).toEqual({ textSize: 'standard', colorMode: 'standard', reduceMotion: false, haptics: true, subtitles: true, oneHanded: 'off', whipInput: 'tap' });
    expect(await w.svc.accessibility('p')).toMatchObject({
      textScale: { standard: 1, large: 1.15, largest: 1.3 },
      rules: { affectsRace: false, whipHold: 'same_as_tap', maxFlashesPerSecond: 3 },
    });
    expect((await w.svc.view('p')).accessibility.textSize).toBe('standard');
  });
  it('reading never creates player state, and the state holds nothing until something changes', async () => {
    const w = world();
    await expect(w.svc.accessibility('ghost')).resolves.toMatchObject({ textSize: 'standard', rev: 0 });
    await w.svc.bootstrap('p');
    await w.svc.accessibility('p');
    expect((await w.svc.state('p')).accessibility).toBeUndefined();
  });
});

describe('REQ-A11Y-002 PUT: idempotent full replace', () => {
  it('stores every key, bumps rev, and appears in GET /v1/player and the next bootstrap', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    const r = await w.svc.setAccessibility('p', { ...FULL });
    expect(r).toMatchObject({ ...FULL, rev: 1, updatedAt: w.now() });
    expect((await w.svc.view('p')).accessibility).toMatchObject(FULL);
    expect((await w.svc.bootstrap('p')).accessibility).toMatchObject({ ...FULL, rev: 1 });
  });
  it('the same body again changes nothing: same rev, same updatedAt, no KPI', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await w.svc.setAccessibility('p', { ...FULL });
    const n = a11yKpi(w.kpi).length;
    w.advance(60_000);
    const again = await w.svc.setAccessibility('p', { ...FULL });
    expect(again.rev).toBe(1);
    expect(again.updatedAt).toBe(w.now() - 60_000);
    expect(a11yKpi(w.kpi).length).toBe(n);
  });
  it('keys left out go back to their defaults (replace, not merge)', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await w.svc.setAccessibility('p', { ...FULL });
    const r = await w.svc.setAccessibility('p', { textSize: 'large' });
    expect(r).toMatchObject({ ...A11Y_DEFAULTS, textSize: 'large', rev: 2 });
    expect(await w.svc.setAccessibility('p', {})).toMatchObject({ ...A11Y_DEFAULTS, rev: 3 });
  });
  it('unknown keys, unknown values and wrong types are refused (schema and domain)', async () => {
    for (const bad of [{ textSize: 'huge' }, { colorMode: 'mono' }, { reduceMotion: 'yes' }, { haptics: 1 }, { oneHanded: 'both' }, { whipInput: 'auto' }, { volume: 3 }, { whipInput: 'hold', rev: 4 }]) {
      expect(accessibilityBodySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(accessibilityBodySchema.safeParse(FULL).success).toBe(true);
    const w = world();
    await w.svc.bootstrap('p');
    await expect(w.svc.setAccessibility('p', { textSize: 'huge' } as never)).rejects.toBeInstanceOf(AppError);
    expect((await w.svc.accessibility('p')).rev).toBe(0);
  });
  it('can be changed while an account deletion is scheduled (looks only), and is gone with the account state', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    const t = ((await w.svc.requestDeletion('p', null)) as { confirmToken: string }).confirmToken;
    await w.svc.requestDeletion('p', t);
    expect((await w.svc.view('p')).deletion).toMatchObject({ status: 'scheduled' });
    expect((await w.svc.setAccessibility('p', { textSize: 'large' })).textSize).toBe('large');
  });
});

describe('REQ-A11Y-014 KPI a11y_setting_change', () => {
  it('one row per changed key: s1 = key, s2 = new value (booleans on/off), s3 = settings; nothing personal', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await w.svc.setAccessibility('p', { textSize: 'large', haptics: false });
    const rows = a11yKpi(w.kpi);
    expect(rows.map((r) => [r.s1, r.s2, r.s3])).toEqual([['textSize', 'large', 'settings'], ['haptics', 'off', 'settings']]);
    for (const r of rows) {
      expect(Object.keys(r).filter((k) => !['name', 's1', 's2', 's3', 'source', 'at', 'cohortDay', 'eventDay', 'daysSinceInstall', 'payer', 'platform', 'appVersion'].includes(k))).toEqual([]);
    }
    // back to the default: a change too (haptics on), textSize dropped from the body → back to standard
    await w.svc.setAccessibility('p', {});
    expect(a11yKpi(w.kpi).slice(2).map((r) => [r.s1, r.s2])).toEqual([['textSize', 'standard'], ['haptics', 'on']]);
  });
});

describe('HTTP /v1/settings/accessibility (contracts/protocol.md §41.2)', () => {
  function ctx() {
    const w = world();
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (w.svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(w.svc, args)) as PlayerInvoker['invoke'] };
    const c = {
      master: m, authenticate: async (req: Request) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
      player: () => invoker, friends: makeFriendsService(() => invoker, new MemoryDirectory()), clock: () => Date.now(),
      paidBalance: async () => ({}), adminToken: 'x', parseStoreNotification: async () => null,
    } as unknown as AppContext;
    return { c, w };
  }
  const req = (method: string, path: string, user?: string, body?: unknown, raw?: string) => new Request(`https://x${path}`, {
    method, headers: { ...(user ? { 'x-test-user': user } : {}), ...(body !== undefined || raw ? { 'content-type': 'application/json' } : {}) },
    ...(raw ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  it('GET / PUT; bad bodies are 400; auth required; bootstrap carries it', async () => {
    const { c, w } = ctx();
    await w.svc.bootstrap('u');
    expect((await handle(req('GET', '/v1/settings/accessibility'), {}, c)).status).toBe(401);
    expect((await handle(req('PUT', '/v1/settings/accessibility', undefined, FULL), {}, c)).status).toBe(401);
    expect(await (await handle(req('GET', '/v1/settings/accessibility', 'u'), {}, c)).json()).toMatchObject({ ...A11Y_DEFAULTS, rev: 0 });
    const put = await handle(req('PUT', '/v1/settings/accessibility', 'u', FULL), {}, c);
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ ...FULL, rev: 1 });
    expect(await (await handle(req('PUT', '/v1/settings/accessibility', 'u', FULL), {}, c)).json()).toMatchObject({ rev: 1 });
    expect((await handle(req('PUT', '/v1/settings/accessibility', 'u', { textSize: 'huge' }), {}, c)).status).toBe(400);
    expect((await handle(req('PUT', '/v1/settings/accessibility', 'u', { ...FULL, extra: 1 }), {}, c)).status).toBe(400);
    expect((await handle(req('PUT', '/v1/settings/accessibility', 'u', [1, 2]), {}, c)).status).toBe(400);
    expect((await handle(req('PUT', '/v1/settings/accessibility', 'u', undefined, '{not json'), {}, c)).status).toBe(400);
    expect(await (await handle(req('GET', '/v1/player', 'u'), {}, c)).json()).toMatchObject({ accessibility: { ...FULL, rev: 1 } });
    expect(await (await handle(req('POST', '/v1/player/bootstrap', 'u'), {}, c)).json()).toMatchObject({ accessibility: { textSize: 'largest' } });
  });
});
