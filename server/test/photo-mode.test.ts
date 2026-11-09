// REQ-PHOTO-001..018: フォトモード (contracts/protocol.md §38).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { DEFAULT_RULESET } from '../src/domain/ruleset.js';
import { grantFree } from '../src/domain/wallet.js';
import { ensureCollection } from '../src/domain/collection.js';
import { itemsProblems } from '../src/domain/itemShop.js';
import { clientBatchSchema, clientToKpi, type KpiRecord } from '../src/domain/kpi.js';
import { catalogFor, localize, untranslated } from '../src/i18n/catalog.js';
import {
  PHOTO_BANNED_WORDS, PHOTO_HARD_LIMITS, photoOf, photoProblems, validateCaption, type PhotoInput, type PhotoMaster,
} from '../src/domain/photoMode.js';
import { MANIFEST_PATH } from '../scripts/gen-assets.js';
import { resolveBundle } from '../src/ops/config.js';
import type { Master } from '../src/domain/master.js';
import type { PlayerState } from '../src/domain/player.js';
import { m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 9, 3);

function setup(master: Master = m) {
  let now = NOW;
  const repo = new MemoryPlayerRepo();
  const kpi: KpiRecord[] = [];
  const svc = new PlayerService(repo, { master, rng: seededRng(15), clock: () => now, verifiers: {}, onKpi: (_id, recs) => { kpi.push(...recs); } });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const c: AppContext = {
    master,
    authenticate: async (req) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
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
    configInfo: async () => ({ versionId: 'base', hash: 'base', rulesetVersion: DEFAULT_RULESET.rulesetVersion, activatedAt: null }),
  };
  const call = async (user: string, path: string, init: { method?: string; body?: unknown; key?: string; lang?: string } = {}) => {
    const headers: Record<string, string> = { 'x-test-user': user, 'content-type': 'application/json' };
    if (init.key) headers['idempotency-key'] = init.key;
    if (init.lang) headers['accept-language'] = init.lang;
    const res = await handle(new Request(`https://x${path}`, { method: init.method ?? 'GET', headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }), {}, c);
    return { status: res.status, body: (await res.json()) as any };
  };
  const edit = async (u: string, f: (s: PlayerState) => void) => { const s = (await repo.get(u))!; f(s); await repo.put(s); };
  return { svc, repo, kpi, call, edit, advance: (ms: number) => { now += ms; } };
}

const input = (over: Partial<PhotoInput> = {}): PhotoInput => ({
  source: { kind: 'paused', mode: 'practice', raceId: 'local:abc123', tick: 640 },
  camera: { focusSlot: 0, orbitDeg: 30, distanceDm: 60, heightDm: 15, fovDeg: 40, dof: 1 },
  lookId: 'film', frameId: 'plain', stamps: [{ id: 'hoof', xPermille: 800, yPermille: 200, scalePermille: 1000, rotDeg: -10 }],
  caption: 'ゴール前の一閃', names: 'masked', hideUi: true,
  ...over,
});
const withMaster = (f: (p: PhotoMaster) => void): Master => { const p = structuredClone(photoOf(m)); f(p); return { ...m, photo: p }; };

describe('REQ-PHOTO-013 catalog validation (master/photo.json)', () => {
  it('the shipped catalog is consistent with achievements and cosmetics, and every item has an asset key in the manifest', () => {
    expect(photoProblems(m)).toEqual([]);
    expect(itemsProblems(m)).toEqual([]);
    const man = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { keys: string[]; kinds: Record<string, unknown> };
    const pm = photoOf(m);
    for (const d of pm.looks) expect(man.keys).toContain(`photo/look/${d.id}`);
    for (const d of pm.frames) expect(man.keys).toContain(`photo/frame/${d.id}`);
    for (const d of pm.stamps) expect(man.keys).toContain(`photo/stamp/${d.id}`);
    for (const k of ['photo/look', 'photo/frame', 'photo/stamp']) { expect(man.kinds[k]).toBeDefined(); expect(man.keys).toContain(`${k}/default`); }
  });

  it('REQ-PHOTO-004: every look is free; frames and stamps each have a free item', () => {
    expect(photoOf(m).looks.every((d) => d.unlock.kind === 'default')).toBe(true);
    expect(photoProblems(withMaster((p) => { p.looks[1]!.unlock = { kind: 'achievement', achievementId: 'wins', tier: 1 }; }))).toContain('photo.looks.film: every look is free (unlock default)');
    expect(photoProblems(withMaster((p) => { p.frames = p.frames.filter((d) => d.unlock.kind !== 'default'); }))).toContain('photo.frames: at least one free item (unlock default)');
  });

  it('refuses unknown achievements / tiers, mismatched or not-for-sale cosmetics, duplicates, bad ranges and banned wording', () => {
    const probs = (f: (p: PhotoMaster) => void) => photoProblems(withMaster(f)).join(' | ');
    expect(probs((p) => { p.frames[2]!.unlock = { kind: 'achievement', achievementId: 'nope', tier: 1 }; })).toContain('unknown achievement nope');
    expect(probs((p) => { p.frames[2]!.unlock = { kind: 'achievement', achievementId: 'wins', tier: 9 }; })).toContain('has no tier 9');
    expect(probs((p) => { p.stamps.push({ ...p.stamps[0]! }); })).toContain('duplicate');
    expect(probs((p) => { p.config.camera.heightDm = [0, 100]; })).toContain('camera.heightDm'); // never below the course
    expect(probs((p) => { p.config.maxSaved = 1000; })).toContain('maxSaved');
    expect(probs((p) => { p.frames[0]!.name = '今だけ額縁'; })).toContain('「今だけ」');
    expect(probs((p) => { p.frames[0]!.name = '馬券の額縁'; })).toContain('「馬券」');
    // a cosmetic whose asset points at another item, a not-for-sale one, and a photo cosmetic that unlocks nothing
    const badAsset: Master = { ...m, items: { ...m.items, cosmetics: m.items.cosmetics.map((x) => (x.id === 'photo_frame_sakura' ? { ...x, asset: 'photo/frame/other' } : x)) } };
    expect(photoProblems(badAsset).join(' | ')).toContain('must be kind "photo" with asset photo/frame/sakura');
    const nfs: Master = { ...m, items: { ...m.items, cosmetics: m.items.cosmetics.map((x) => (x.id === 'photo_frame_sakura' ? { ...x, price: 0, notForSale: true } : x)) } };
    expect(photoProblems(nfs).join(' | ')).toContain('must be sold directly');
    const orphan: Master = { ...m, items: { ...m.items, cosmetics: [...m.items.cosmetics, { id: 'photo_frame_orphan', name: '孤児', kind: 'photo', asset: 'photo/frame/orphan', price: 100, currency: 'any' }] } };
    expect(photoProblems(orphan).join(' | ')).toContain('cosmetic photo_frame_orphan: unlocks 0 photo items');
    const badKind: Master = { ...m, items: { ...m.items, cosmetics: m.items.cosmetics.map((x) => (x.id === 'photo_frame_sakura' ? { ...x, asset: 'decor/sakura' } : x)) } };
    expect(itemsProblems(badKind).join(' | ')).toContain('photo_frame_sakura: asset must be a photo/frame/<id> or photo/stamp/<id> key');
  });

  it('a remote config version is checked with the photo catalog too (base master resolves cleanly)', () => {
    expect(() => resolveBundle(m, {})).not.toThrow();
  });
});

describe('REQ-PHOTO-006 GET /v1/photo/catalog', () => {
  it('lists looks / frames / stamps with assets, unlock texts, prices of the shop items and this player\'s unlocks', async () => {
    const w = setup();
    await w.svc.bootstrap('u1');
    const r = await w.call('u1', '/v1/photo/catalog');
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.limits).toEqual({ maxSaved: 30, captionMaxChars: 24, stampsMax: 3, camera: { orbitDeg: [-180, 180], distanceDm: [20, 200], heightDm: [3, 100], fovDeg: [20, 70], dof: [0, 3] } });
    expect(r.body.looks.map((x: any) => x.unlocked)).toEqual([true, true, true, true, true]);
    const victory = r.body.frames.find((x: any) => x.id === 'victory');
    expect(victory).toMatchObject({ asset: 'photo/frame/victory', unlock: { kind: 'achievement', achievementId: 'wins', tier: 1 }, unlockText: '実績「勝利の記録」の1段目で解放', unlocked: false });
    expect(victory.price).toBeUndefined();
    const carrot = r.body.stamps.find((x: any) => x.id === 'carrot_pop');
    expect(carrot).toMatchObject({ asset: 'photo/stamp/carrot_pop', price: 100, currency: 'any', unlockText: '見た目ショップで購入（100コイン）', unlocked: false });
    // an achievement tier reached unlocks the frame
    await w.edit('u1', (s) => { ensureCollection(s).tiers['wins:1'] = { at: NOW, claimedAt: null }; });
    const r2 = await w.call('u1', '/v1/photo/catalog');
    expect(r2.body.frames.find((x: any) => x.id === 'victory').unlocked).toBe(true);
    expect(r2.body.frames.find((x: any) => x.id === 'champion').unlocked).toBe(false);
  });

  it('REQ-PHOTO-005: a shop item is bought once at its fixed price through the cosmetics shop, then unlocked', async () => {
    const w = setup();
    await w.svc.bootstrap('u1');
    await w.edit('u1', (s) => { grantFree(s, 500, NOW, 'test', 't1'); });
    const before = (await w.repo.get('u1'))!.wallet.free;
    const buy = await w.call('u1', '/v1/shop/cosmetics/photo_frame_sakura/buy', { method: 'POST', body: {}, key: 'k1' });
    expect(buy.status).toBe(200);
    expect((await w.repo.get('u1'))!.wallet.free).toBe(before - 150);
    const again = await w.call('u1', '/v1/shop/cosmetics/photo_frame_sakura/buy', { method: 'POST', body: {}, key: 'k2' });
    expect(again.body.error.code).toBe('ALREADY_PURCHASED');
    const cat = await w.call('u1', '/v1/photo/catalog');
    expect(cat.body.frames.find((x: any) => x.id === 'sakura').unlocked).toBe(true);
    // listed in the cosmetics shop like any other cosmetic (no random draw involved)
    const shop = await w.call('u1', '/v1/shop/cosmetics');
    expect(shop.body.items.find((x: any) => x.id === 'photo_frame_sakura')).toMatchObject({ kind: 'photo', price: 150, owned: true, equipped: false, asset: 'photo/frame/sakura' });
  });

  it('English: names and unlock texts are translated; the response has nothing left in Japanese', async () => {
    const w = setup();
    await w.svc.bootstrap('u1');
    const r = await w.call('u1', '/v1/photo/catalog?lang=en');
    expect(r.body.frames.find((x: any) => x.id === 'victory')).toMatchObject({ name: 'Victory Frame', unlockText: 'Unlocked at tier 1 of the achievement "Win Record"' });
    expect(r.body.stamps.find((x: any) => x.id === 'carrot_pop')).toMatchObject({ name: 'Carrot Pop', unlockText: 'Buy in the cosmetics shop (100 coins)' });
    expect(untranslated(r.body)).toEqual([]);
  });

  it('REQ-PHOTO-012: disabled → the catalog says so and the record routes are 404', async () => {
    const w = setup(withMaster((p) => { p.config.enabled = false; }));
    await w.svc.bootstrap('u1');
    expect((await w.call('u1', '/v1/photo/catalog')).body).toEqual({ enabled: false });
    expect((await w.call('u1', '/v1/photos')).status).toBe(404);
    expect((await w.call('u1', '/v1/photos', { method: 'POST', body: input(), key: 'a' })).status).toBe(404);
  });
});

describe('REQ-PHOTO-010/011 photo records', () => {
  it('saves a small record (no image), lists newest first, deletes; a retried key gives the first answer', async () => {
    const w = setup();
    await w.svc.bootstrap('u1');
    const r = await w.call('u1', '/v1/photos', { method: 'POST', body: input(), key: 'p1' });
    expect(r.status).toBe(200);
    expect(r.body.photo).toMatchObject({ id: 'ph_1', createdAt: NOW, source: { kind: 'paused', mode: 'practice', raceId: 'local:abc123', tick: 640 }, lookId: 'film', caption: 'ゴール前の一閃' });
    expect(r.body).toMatchObject({ count: 1, max: 30 });
    const again = await w.call('u1', '/v1/photos', { method: 'POST', body: input(), key: 'p1' });
    expect(again.body.photo.id).toBe('ph_1');
    expect((await w.call('u1', '/v1/photos', { method: 'POST', body: input() })).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    await w.call('u1', '/v1/photos', { method: 'POST', body: input({ source: { kind: 'result', mode: 'ranked', raceId: 'r_9', tick: 1200 }, caption: null, frameId: null, stamps: [] }), key: 'p2' });
    const list = await w.call('u1', '/v1/photos');
    expect(list.body.photos.map((x: any) => x.id)).toEqual(['ph_2', 'ph_1']);
    expect(list.body.count).toBe(2);
    expect(JSON.stringify((await w.repo.get('u1'))!.photos).length).toBeLessThan(2000); // a pointer, never an image
    const del = await w.call('u1', '/v1/photos/ph_1', { method: 'DELETE' });
    expect(del.body).toEqual({ deleted: true, count: 1, max: 30 });
    expect((await w.call('u1', '/v1/photos/ph_1', { method: 'DELETE' })).status).toBe(404);
    // other players never see them (there is no route by player id) and their own list is empty
    await w.svc.bootstrap('u2');
    expect((await w.call('u2', '/v1/photos')).body.photos).toEqual([]);
    expect((await w.call('u2', '/v1/photos/ph_2', { method: 'DELETE' })).status).toBe(404);
  });

  it('REQ-PHOTO-001: a race run with other people cannot be paused live — only its result or replay', async () => {
    const w = setup();
    await w.svc.bootstrap('u1');
    for (const mode of ['ranked', 'friend', 'event', 'tournament'] as const) {
      const r = await w.call('u1', '/v1/photos', { method: 'POST', body: input({ source: { kind: 'paused', mode, raceId: 'r_1', tick: 100 } }), key: `x-${mode}` });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('PHOTO_SOURCE_INVALID');
      expect((await w.call('u1', '/v1/photos', { method: 'POST', body: input({ source: { kind: 'replay', mode, raceId: 'r_1', tick: 100 } }), key: `y-${mode}` })).status).toBe(200);
    }
    for (const mode of ['practice', 'time_attack', 'tutorial', 'challenge'] as const) {
      expect((await w.call('u1', '/v1/photos', { method: 'POST', body: input({ source: { kind: 'paused', mode, raceId: 'local:1', tick: 100 } }), key: `z-${mode}` })).status).toBe(200);
    }
  });

  it('checks camera ranges (never under the course), stamp placement, unknown keys and locked items', async () => {
    const w = setup();
    await w.svc.bootstrap('u1');
    let n = 0;
    const post = (b: unknown) => w.call('u1', '/v1/photos', { method: 'POST', body: b, key: `k${n++}` });
    const codeOf = async (b: unknown) => { const r = await post(b); return r.status === 200 ? 'ok' : r.body.error.code; };
    const cam = input().camera;
    expect(await codeOf(input({ camera: { ...cam, heightDm: 2 } }))).toBe('BAD_REQUEST');
    expect(await codeOf(input({ camera: { ...cam, heightDm: -5 } }))).toBe('BAD_REQUEST');
    expect(await codeOf(input({ camera: { ...cam, distanceDm: 500 } }))).toBe('BAD_REQUEST');
    expect(await codeOf(input({ camera: { ...cam, orbitDeg: 181 } }))).toBe('BAD_REQUEST');
    expect(await codeOf(input({ camera: { ...cam, fovDeg: 90 } }))).toBe('BAD_REQUEST');
    expect(await codeOf(input({ camera: { ...cam, dof: 4 } }))).toBe('BAD_REQUEST');
    expect(await codeOf(input({ camera: { ...cam, focusSlot: 18 } }))).toBe('BAD_REQUEST');
    expect(await codeOf({ ...input(), extra: 1 })).toBe('BAD_REQUEST');
    expect(await codeOf(input({ source: { kind: 'paused', mode: 'practice', raceId: 'bad id with spaces', tick: 1 } }))).toBe('BAD_REQUEST');
    expect(await codeOf(input({ source: { kind: 'paused', mode: 'practice', raceId: 'ok', tick: PHOTO_HARD_LIMITS.maxTick + 1 } }))).toBe('BAD_REQUEST');
    const st = input().stamps[0]!;
    expect(await codeOf(input({ stamps: [st, st, st, st] }))).toBe('BAD_REQUEST');
    expect(await codeOf(input({ stamps: [{ ...st, xPermille: 1001 }] }))).toBe('BAD_REQUEST');
    expect(await codeOf(input({ lookId: 'sepia_unknown' }))).toBe('BAD_REQUEST');
    // locked: an achievement frame, a shop stamp
    expect(await codeOf(input({ frameId: 'victory' }))).toBe('PHOTO_LOCKED');
    expect(await codeOf(input({ stamps: [{ ...st, id: 'carrot_pop' }] }))).toBe('PHOTO_LOCKED');
    await w.edit('u1', (s) => { ensureCollection(s).tiers['wins:1'] = { at: NOW, claimedAt: null }; s.items['photo_stamp_carrot_pop'] = 1; });
    expect(await codeOf(input({ frameId: 'victory', stamps: [{ ...st, id: 'carrot_pop' }] }))).toBe('ok');
    expect(await codeOf(input({ camera: { ...cam, heightDm: 3, distanceDm: 20, orbitDeg: -180, fovDeg: 70, dof: 3 } }))).toBe('ok');
  });

  it('REQ-PHOTO-010: at most maxSaved records (not raised by paying); deleting frees a slot', async () => {
    const w = setup(withMaster((p) => { p.config.maxSaved = 2; }));
    await w.svc.bootstrap('u1');
    await w.edit('u1', (s) => { grantFree(s, 5000, NOW, 'test', 't'); });
    expect((await w.call('u1', '/v1/photos', { method: 'POST', body: input(), key: 'a' })).status).toBe(200);
    expect((await w.call('u1', '/v1/photos', { method: 'POST', body: input(), key: 'b' })).status).toBe(200);
    const full = await w.call('u1', '/v1/photos', { method: 'POST', body: input(), key: 'c' });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('PHOTO_LIMIT');
    await w.call('u1', '/v1/photos/ph_1', { method: 'DELETE' });
    const ok = await w.call('u1', '/v1/photos', { method: 'POST', body: input(), key: 'c' }); // the refused key was not stored
    expect(ok.body.photo.id).toBe('ph_3'); // ids are never reused
  });

  it('the caption is player text: never translated in an English response', async () => {
    const w = setup();
    await w.svc.bootstrap('u1');
    await w.call('u1', '/v1/photos', { method: 'POST', body: input({ caption: '決勝' }), key: 'a' });
    const r = await w.call('u1', '/v1/photos?lang=en');
    expect(r.body.photos[0].caption).toBe('決勝');
    expect(localize({ caption: '決勝', name: '金箔' }, 'en', catalogFor(m))).toEqual({ caption: '決勝', name: 'Gold Leaf' });
  });

  it('REQ-PHOTO-014: photo_save is written by the server; photo_take / photo_share are client events', async () => {
    const w = setup();
    await w.svc.bootstrap('u1');
    await w.call('u1', '/v1/photos', { method: 'POST', body: input({ source: { kind: 'result', mode: 'ranked', raceId: 'r_1', tick: 9 } }), key: 'a' });
    expect(w.kpi.find((r) => r.name === 'photo_save')).toMatchObject({ s1: 'result', s2: 'ranked', count: 1 });
    const batch = clientBatchSchema.parse({ platform: 'ios', appVersion: '1.0.0', events: [
      { name: 'photo_take', at: NOW, props: { source: 'paused', look: 'film' } },
      { name: 'photo_share', at: NOW, props: { source: 'replay', framed: true } },
    ] });
    expect(batch.events.map(clientToKpi)).toEqual([{ name: 'photo_take', s1: 'paused', s2: 'film' }, { name: 'photo_share', s1: 'replay', s2: 'framed' }]);
    expect(clientBatchSchema.safeParse({ platform: 'ios', appVersion: '1', events: [{ name: 'photo_take', at: NOW, props: { source: 'live', look: 'film' } }] }).success).toBe(false);
    expect(clientBatchSchema.safeParse({ platform: 'ios', appVersion: '1', events: [{ name: 'photo_save', at: NOW, props: {} }] }).success).toBe(false); // server-only
  });
});

describe('REQ-PHOTO-007 captions', () => {
  it('display-name rules: NFKC, length, control characters, URLs, NG names', () => {
    expect(validateCaption(m, null)).toBeNull();
    expect(validateCaption(m, '   ')).toBeNull();
    expect(validateCaption(m, '  ﾑﾁ　一閃  ')).toBe('ムチ 一閃');
    expect(validateCaption(m, 'あ'.repeat(24))).toBe('あ'.repeat(24));
    const code = (t: string) => { try { validateCaption(m, t); return 'ok'; } catch (e) { return (e as AppError).code; } };
    expect(code('あ'.repeat(25))).toBe('INVALID_NAME');
    expect(code('見て\u0007')).toBe('INVALID_NAME');
    expect(code('https://example.com')).toBe('INVALID_NAME');
    expect(code('www.muchi')).toBe('INVALID_NAME');
    expect(code(m.ng.contains[0] ?? m.ng.exact[0]!)).toBe('NG_NAME');
  });

  it('shop wording rules and betting words are refused', () => {
    const code = (t: string) => { try { validateCaption(m, t); return 'ok'; } catch (e) { return (e as AppError).code; } };
    for (const w of PHOTO_BANNED_WORDS) expect(code(`今日の${w}`)).toBe('NG_NAME');
    for (const t of ['馬券が当たった', 'オッズ10倍', 'お得な一枚', '今だけの走り']) expect(code(t)).toBe('NG_NAME');
    expect(code('差し切った！')).toBe('ok');
  });
});
