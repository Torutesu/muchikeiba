import { describe, expect, it } from 'vitest';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { stablePlayersFrom } from '../src/http/stablePorts.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { createHorseFromTemplate } from '../src/domain/horses.js';
import {
  MemoryStableDirectory, STABLE_HARD_LIMITS, StableService, stableConfig, stableConfigProblems, stableSnapshot,
  type StableInput, type StablePlayers, type StableSnapshot,
} from '../src/domain/stable.js';
import { resolveBundle } from '../src/ops/config.js';
import { buildAssetManifest } from '../src/domain/assetManifest.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import type { Master } from '../src/domain/master.js';
import { m } from './helpers.js';
import { BASE_BANNED_SILKS, type BannedSilksList } from '../src/domain/bannedSilks.js';
import { isBannedSilks } from '../src/domain/visuals.js';

const NOW = Date.UTC(2026, 10, 5, 3); // 12:00 JST
const DAY = 86_400_000;
const cfg = stableConfig(m);

interface World {
  svc: PlayerService; dir: MemoryStableDirectory; stable: StableService; clock: { now: number };
  kpi: { id: string; r: KpiRecord }[]; pushed: { id: string; snap: StableSnapshot | null }[]; invoker: PlayerInvoker; ports: StablePlayers;
}

function world(opts: { master?: Master; failReceive?: () => boolean; hook?: boolean } = {}): World {
  const clock = { now: NOW };
  const kpi: World['kpi'] = [];
  const pushed: World['pushed'] = [];
  const dir = new MemoryStableDirectory();
  const master = opts.master ?? m;
  const svc = new PlayerService(new MemoryPlayerRepo(), {
    master, rng: seededRng(4), clock: () => clock.now, verifiers: {},
    onKpi: (id, recs) => { for (const r of recs) kpi.push({ id, r }); },
    ...(opts.hook ? { onStable: async (id: string, snap: StableSnapshot | null) => { pushed.push({ id, snap }); if (snap) await dir.put(snap); else await dir.remove(id); } } : {}),
  });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const base = stablePlayersFrom(() => invoker);
  const ports: StablePlayers = { ...base, receive: async (...a) => { if (opts.failReceive?.()) throw new Error('target object unavailable'); return base.receive(...a); } };
  return { svc, dir, stable: new StableService(ports, dir, () => stableConfig(master)), clock, kpi, pushed, invoker, ports };
}

/** A player owning two decor items (one paid-only) and two active horses, plus a retired one. */
async function seed(w: World, id: string, opts: { friends?: string[]; decor?: string[]; equipped?: (string | null)[] } = {}) {
  return w.svc.tx(id, null, (s, now) => {
    for (const d of opts.decor ?? ['decor_flower_box', 'decor_golden_horseshoe']) s.items[d] = 1;
    const a = createHorseFromTemplate(s, m.templates[0]!, now);
    const b = createHorseFromTemplate(s, m.templates[1]!, now);
    const r = createHorseFromTemplate(s, m.templates[2]!, now);
    r.status = 'retired';
    s.friends.ids.push(...(opts.friends ?? []));
    if (opts.equipped) s.equipment = { tack: {}, decor: opts.equipped };
    return { a: a.id, b: b.id, retired: r.id };
  });
}

const layout = (o: Partial<StableInput> = {}): StableInput => ({ theme: 'standard', name: 'ほしぞら厩舎', slots: ['decor_flower_box', null, 'decor_golden_horseshoe'], featuredHorseIds: [], ...o });
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as AppError).code ?? (e as Error).message; } };
const wallet = async (w: World, id: string) => (await w.svc.view(id)).wallet;

describe('stable config (REQ-STABLE-008)', () => {
  it('ships a valid config, a theme asset key per theme and no coin field anywhere', () => {
    expect(stableConfigProblems(cfg, m)).toEqual([]);
    expect(cfg.likesPerDay).toBe(5);
    expect(cfg.themes.filter((t) => t.default)).toHaveLength(1);
    const man = buildAssetManifest(m, { phrases: {} });
    for (const t of cfg.themes) expect(man.keys).toContain(`stable/theme/${t.id}`);
    expect(man.keys).toContain('stable/theme/default');
    expect(JSON.stringify(cfg)).not.toMatch(/coin/i);
  });

  it('remote config cannot raise like caps past the hard limits or lock the default theme', () => {
    const bad = (patch: object) => stableConfigProblems({ ...cfg, ...patch }, m).join('; ');
    expect(bad({ likesPerDay: STABLE_HARD_LIMITS.likesPerDay + 1 })).toMatch(/likesPerDay/);
    expect(bad({ likesPerTargetPerDay: 2 })).toMatch(/likesPerTargetPerDay/);
    expect(bad({ themes: [{ id: 'standard', name: 'x', slots: 3, default: true, unlockLikes: 5 }] })).toMatch(/cannot be locked/);
    expect(bad({ themes: [{ id: 'a', name: 'x', slots: 3, default: true }, { id: 'b', name: 'y', slots: 3 }] })).toMatch(/needs unlockLikes/);
    expect(bad({ themes: [{ id: 'a', name: 'x', slots: 3, default: true }, { id: 'b', name: 'y', slots: 3, unlockItem: 'nope' }] })).toMatch(/unknown unlockItem/);
    expect(bad({ themes: [{ id: 'default', name: 'x', slots: 3, default: true }] })).toMatch(/not "default"/);
    expect(bad({ themes: [{ id: 'a', name: 'x', slots: 11, default: true }] })).toMatch(/slots/);
    expect(() => resolveBundle(m, { stable: { ...cfg, likesPerDay: 50 } } as never)).toThrow(/likesPerDay/);
    // strict: an unknown key (e.g. a coin reward) is refused by the bundle schema
    expect(() => resolveBundle(m, { stable: { ...cfg, likeRewardCoins: 10 } } as never)).toThrow(/CONFIG_INVALID|likeRewardCoins|Unrecognized/);
    const ok = resolveBundle(m, { stable: { ...cfg, likesPerDay: 3 } } as never);
    expect(stableConfig(ok.master).likesPerDay).toBe(3);
    expect(stableConfig(resolveBundle(m, {} as never).master).likesPerDay).toBe(5);
  });
});

describe('stable layout (REQ-STABLE-001/002)', () => {
  it('starts from the equipped decor, validates ownership like REQ-ITEM-006 and saves a public copy', async () => {
    const w = world();
    const h = await seed(w, 'a', { equipped: ['decor_flower_box', 'decor_trophy_shelf'] }); // trophy shelf equipped but not owned
    const before = await w.stable.mine('a');
    expect(before.saved).toBe(false);
    expect(before.layout).toMatchObject({ theme: 'standard', name: null, slots: ['decor_flower_box'] });
    expect(before.preview).toBeNull();
    expect(before.themes.find((t) => t.id === 'cedar')).toMatchObject({ unlocked: false, unlockLikes: 10, key: 'stable/theme/cedar' });
    expect(before.decor.find((d) => d.itemId === 'decor_golden_horseshoe')).toMatchObject({ owned: true, currency: 'paidOnly' });
    expect(before.decor.find((d) => d.itemId === 'decor_trophy_shelf')).toMatchObject({ owned: false });
    expect(await code(w.stable.visit('b', 'a'))).toBe('NOT_FOUND');

    expect(await code(w.stable.save('a', layout({ slots: ['decor_trophy_shelf'] })))).toBe('NOT_ELIGIBLE');
    expect(await code(w.stable.save('a', layout({ slots: ['tack_bridle_classic'] })))).toBe('BAD_REQUEST');
    expect(await code(w.stable.save('a', layout({ slots: ['nope'] })))).toBe('NOT_FOUND');
    expect(await code(w.stable.save('a', layout({ slots: ['decor_flower_box', 'decor_flower_box'] })))).toBe('BAD_REQUEST');
    expect(await code(w.stable.save('a', layout({ slots: ['decor_flower_box', null, null, null] })))).toBe('BAD_REQUEST'); // standard has 3
    expect(await code(w.stable.save('a', layout({ theme: 'cedar' })))).toBe('NOT_ELIGIBLE');
    expect(await code(w.stable.save('a', layout({ theme: 'nope' })))).toBe('BAD_REQUEST');
    expect(await code(w.stable.save('a', layout({ featuredHorseIds: [h.retired] })))).toBe('HORSE_NOT_ACTIVE');
    expect(await code(w.stable.save('a', layout({ featuredHorseIds: ['h999'] })))).toBe('HORSE_NOT_FOUND');
    expect(await code(w.stable.save('a', layout({ featuredHorseIds: [h.a, h.a] })))).toBe('BAD_REQUEST');
    expect(await code(w.stable.save('a', layout({ featuredHorseIds: [h.a, h.b, h.a, h.b] })))).toBe('BAD_REQUEST');
    expect(await code(w.stable.save('a', layout({ name: 'ダービー王' })))).toBe('NG_NAME');
    expect(await code(w.stable.save('a', layout({ name: 'https://x.com' })))).toBe('INVALID_NAME');
    expect(await code(w.stable.save('a', layout({ name: 'あ'.repeat(13) })))).toBe('INVALID_NAME');
    expect(w.dir.rows.size).toBe(0);

    const r = await w.stable.save('a', layout({ featuredHorseIds: [h.b] }));
    expect(r.layout).toMatchObject({ theme: 'standard', name: 'ほしぞら厩舎', featuredHorseIds: [h.b] });
    const snap = (await w.stable.visit('b', 'a')).stable;
    expect(snap).toMatchObject({ playerId: 'a', name: 'ほしぞら厩舎', theme: { id: 'standard', key: 'stable/theme/standard' }, likes: 0, autoHorses: false });
    expect(snap.slots).toEqual([{ itemId: 'decor_flower_box', name: '花のプランター', key: 'decor/flower_box' }, null, { itemId: 'decor_golden_horseshoe', name: '金の蹄鉄', key: 'decor/golden_horseshoe' }]);
    expect(snap.horses.map((x) => x.horseId)).toEqual([h.b]);
    expect(snap.horses[0]!.appearance.coat).toBeTruthy();
    // the public copy never carries wallet, items or purchases
    expect(JSON.stringify(snap)).not.toMatch(/wallet|purchases|"items"|ledger/);
    expect(w.kpi.filter((k) => k.r.name === 'stable_save')).toHaveLength(1);
    expect(w.kpi.find((k) => k.r.name === 'stable_save')!.r).toMatchObject({ s1: 'standard', count: 2, value: 1 });
  });

  it('with no featured horses the 馬房 shows the top active horses; retired featured horses drop out', async () => {
    const w = world({ hook: true });
    const h = await seed(w, 'a');
    await w.stable.save('a', layout({ featuredHorseIds: [h.a] }));
    await w.svc.tx('a', null, (s) => { s.horses.find((x) => x.id === h.a)!.status = 'retired'; });
    const snap = (await w.dir.get('a'))!;
    expect(snap.autoHorses).toBe(true);
    expect(snap.horses.map((x) => x.horseId)).toEqual([h.b]);
  });
});

describe('visits (REQ-STABLE-004)', () => {
  it('lists friends’ stables and recommended ones (most liked, not mine, not friends, not empty) and records stable_visit', async () => {
    const w = world();
    await seed(w, 'me', { friends: ['f'] });
    for (const id of ['f', 'x', 'y', 'empty']) await seed(w, id, { friends: id === 'f' ? ['me'] : [] });
    await w.stable.save('me', layout());
    await w.stable.save('f', layout({ name: null }));
    await w.stable.save('x', layout({ name: 'エックス厩舎' }));
    await w.stable.save('y', layout({ name: 'ワイ厩舎' }));
    await w.stable.save('empty', layout({ name: null, slots: [] }));
    await w.stable.like('me', 'y', 'c:k1');
    const v = await w.stable.visits('me');
    expect(v.friends.map((s) => s.playerId)).toEqual(['f']);
    expect(v.friends[0]).toMatchObject({ name: null, decorCount: 2, themeKey: 'stable/theme/standard' });
    expect(v.recommended.map((s) => s.playerId)).toEqual(['y', 'x']);
    const visit = await w.stable.visit('me', 'f');
    expect(visit.viewer).toEqual({ relation: 'friend', likedToday: 0, likesLeftToday: 4, canLike: true });
    expect((await w.stable.visit('me', 'me')).viewer).toMatchObject({ relation: 'self', canLike: false });
    expect(w.kpi.filter((k) => k.r.name === 'stable_visit').map((k) => k.r.s1)).toEqual(['friend']); // own stable not counted
    expect(await code(w.stable.visit('me', 'nobody'))).toBe('NOT_FOUND');
  });
});

describe('likes (REQ-STABLE-005/006)', () => {
  it('caps per day and per target, refuses self-likes and never moves coins', async () => {
    const w = world();
    for (const id of ['me', 't1', 't2', 't3', 't4', 't5', 't6']) { await seed(w, id); await w.stable.save(id, layout()); }
    const walletsBefore = await Promise.all(['me', 't1'].map((id) => wallet(w, id)));
    expect(await code(w.stable.like('me', 'me', 'c:self'))).toBe('NOT_ELIGIBLE');
    const r = await w.stable.like('me', 't1', 'c:1');
    expect(r).toEqual({ playerId: 't1', likes: 1, remainingToday: 4 });
    expect(await code(w.stable.like('me', 't1', 'c:1b'))).toBe('ALREADY_LIKED');
    for (const [i, t] of ['t2', 't3', 't4', 't5'].entries()) await w.stable.like('me', t, `c:${i + 2}`);
    expect(await code(w.stable.like('me', 't6', 'c:6'))).toBe('LIKE_LIMIT');
    expect((await w.stable.visit('me', 't6')).viewer).toMatchObject({ likesLeftToday: 0, canLike: false });
    // no coins for either side (docs/planning/06 §5)
    expect(await wallet(w, 'me')).toEqual(walletsBefore[0]);
    expect(await wallet(w, 't1')).toEqual(walletsBefore[1]);
    expect(w.kpi.filter((k) => k.r.name === 'stable_like')).toHaveLength(5);
    expect(w.kpi.every((k) => !k.r.freeCoins && !k.r.paidCoins)).toBe(true);
    // the next JST day: a fresh allowance, the same target can be liked again
    w.clock.now += DAY;
    expect((await w.stable.like('me', 't1', 'c:7')).likes).toBe(2);
    expect((await w.stable.like('me', 't6', 'c:8')).remainingToday).toBe(3);
  });

  it('a retry with the same idempotency key counts once, and completes a like whose second step failed', async () => {
    let fail = true;
    const w = world({ failReceive: () => fail });
    for (const id of ['me', 't']) { await seed(w, id); await w.stable.save(id, layout()); }
    expect(await code(w.stable.like('me', 't', 'c:k'))).toMatch(/unavailable/);
    expect((await w.dir.get('t'))!.likes).toBe(0);
    fail = false;
    expect(await w.stable.like('me', 't', 'c:k')).toEqual({ playerId: 't', likes: 1, remainingToday: 4 });
    expect(await w.stable.like('me', 't', 'c:k')).toEqual({ playerId: 't', likes: 1, remainingToday: 4 });
    expect((await w.dir.get('t'))!.likes).toBe(1);
    // the target side also refuses a second like from the same liker on the same day, whatever the liker side says
    expect((await w.ports.receive('t', 'me', 'me:2026-11-05:9')).counted).toBe(false);
    expect((await w.ports.receive('t', 't', 't:2026-11-05:0')).counted).toBe(false);
    expect(await code(Promise.resolve().then(() => w.svc.stableLikeGive('me', 't', null)))).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('cumulative likes unlock themes (looks only); the snapshot falls back when a theme is no longer unlocked', async () => {
    const w = world();
    await seed(w, 'star');
    await w.stable.save('star', layout());
    for (let i = 0; i < 10; i++) { await seed(w, `fan${i}`); await w.stable.like(`fan${i}`, 'star', `c:${i}`); }
    const mine = await w.stable.mine('star');
    expect(mine.likes.received).toBe(10);
    expect(mine.themes.find((t) => t.id === 'cedar')!.unlocked).toBe(true);
    const r = await w.stable.save('star', layout({ theme: 'cedar', slots: ['decor_flower_box', null, null, 'decor_golden_horseshoe'] }));
    expect(r.snapshot!.slots).toHaveLength(4);
    // ops raise the requirement: the stored layout stays, the public copy shows the default theme (3 slots)
    const raised: Master = { ...m, stable: { ...cfg, themes: cfg.themes.map((t) => (t.id === 'cedar' ? { ...t, unlockLikes: 99 } : t)) } };
    const s = await w.svc.state('star');
    const snap = stableSnapshot(raised, s, NOW)!;
    expect(snap.theme.id).toBe('standard');
    expect(snap.slots).toHaveLength(3);
  });
});

describe('moderation (REQ-STABLE-007)', () => {
  it('a ban hides the stable and blocks edits and likes; NG growth and support resets clear the plate name', async () => {
    const w = world({ hook: true });
    for (const id of ['a', 'b']) { await seed(w, id); await w.stable.save(id, layout()); }
    expect(w.dir.rows.has('a')).toBe(true);
    await w.svc.setModeration('a', 'banned', null, 'abuse');
    expect(w.dir.rows.has('a')).toBe(false);
    expect(w.pushed.at(-1)).toEqual({ id: 'a', snap: null });
    expect(await code(w.stable.visit('b', 'a'))).toBe('NOT_FOUND');
    expect(await code(w.stable.like('b', 'a', 'c:x'))).toBe('NOT_FOUND');
    expect(await code(w.stable.save('a', layout()))).toBe('BANNED');
    expect(await code(w.stable.like('a', 'b', 'c:y'))).toBe('BANNED');
    expect((await w.stable.visit('a', 'b')).viewer.canLike).toBe(false);
    await w.svc.setModeration('a', 'ok', null, 'appeal');
    expect(w.dir.rows.has('a')).toBe(true); // unbanned: the copy comes back

    // the NG list grew after the name was saved: the public copy drops it
    const strict: Master = { ...m, ng: { exact: m.ng.exact, contains: [...m.ng.contains, 'ほしぞら'] } };
    expect(stableSnapshot(strict, await w.svc.state('b'), NOW)!.name).toBeNull();
    // support reset (admin reset-name target "stable") reaches the directory through the hook
    expect(await w.svc.adminResetName('b', 'stable', null)).toEqual({ before: 'ほしぞら厩舎', after: null });
    expect((await w.dir.get('b'))!.name).toBeNull();
    // a display-name change reaches the copy too
    await w.svc.setDisplayName('b', 'あたらしい名前');
    expect((await w.dir.get('b'))!.displayName).toBe('あたらしい名前');
  });

  it('banned real silks never reach the public copy', async () => {
    const w = world();
    await seed(w, 'a');
    await w.stable.save('a', layout());
    const s = await w.svc.state('a');
    const list: BannedSilksList = { ...BASE_BANNED_SILKS, entries: [{ id: 'real1', source: 'test', pattern: s.profile.silks!.pattern, colors: s.profile.silks!.colors }] };
    const snap = stableSnapshot({ ...m, bannedSilks: list }, s, NOW)!;
    expect(snap.silks).not.toEqual(s.profile.silks);
    expect(isBannedSilks(snap.silks, undefined, list)).toBe(false);
  });
});

describe('account deletion hook (REQ-STABLE-009)', () => {
  it('removeStable drops the public copy without touching the player object; stableClear removes the layout', async () => {
    const w = world({ hook: true });
    for (const id of ['a', 'b']) { await seed(w, id); await w.stable.save(id, layout()); }
    expect(await w.stable.removeStable('a')).toEqual({ removed: true });
    expect(await w.dir.get('a')).toBeNull();
    expect(await code(w.stable.like('b', 'a', 'c:z'))).toBe('NOT_FOUND');
    expect(await w.svc.stableClear('b')).toEqual({ removed: true });
    expect(await w.dir.get('b')).toBeNull();
    expect((await w.stable.mine('b')).saved).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------- HTTP

function ctx(w: World, withStable = true): AppContext {
  return {
    master: m,
    authenticate: async (req: Request) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
    player: () => w.invoker,
    friends: makeFriendsService(() => w.invoker, new MemoryDirectory()),
    ...(withStable ? { stable: w.stable } : {}),
    clock: () => w.clock.now,
  } as unknown as AppContext;
}
async function call(c: AppContext, method: string, path: string, o: { user?: string; body?: unknown; key?: string } = {}) {
  const res = await handle(new Request(`https://x${path}`, {
    method, headers: { 'content-type': 'application/json', ...(o.user ? { 'x-test-user': o.user } : {}), ...(o.key ? { 'idempotency-key': o.key } : {}) },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  }), {}, c);
  return { status: res.status, body: (await res.json()) as any };
}

describe('HTTP API: /v1/stable (REQ-STABLE-*)', () => {
  it('GET/PUT mine, visits, visit and like', async () => {
    const w = world();
    await seed(w, 'a', { friends: ['b'] });
    await seed(w, 'b', { friends: ['a'] });
    const c = ctx(w);
    expect((await call(c, 'GET', '/v1/stable')).status).toBe(401);
    expect((await call(c, 'GET', '/v1/stable', { user: 'a' })).body).toMatchObject({ saved: false, featuredMax: 3, likes: { perDay: 5, perTargetPerDay: 1 } });
    expect((await call(c, 'PUT', '/v1/stable', { user: 'a', body: { ...layout(), coins: 5 } })).status).toBe(400);
    expect((await call(c, 'PUT', '/v1/stable', { user: 'a', body: layout({ slots: ['decor_trophy_shelf'] }) })).body.error.code).toBe('NOT_ELIGIBLE');
    const put = await call(c, 'PUT', '/v1/stable', { user: 'a', body: layout() });
    expect(put.status).toBe(200);
    expect(put.body.snapshot).toMatchObject({ playerId: 'a', name: 'ほしぞら厩舎' });
    expect((await call(c, 'GET', '/v1/stable/visits', { user: 'b' })).body.friends.map((x: { playerId: string }) => x.playerId)).toEqual(['a']);
    expect((await call(c, 'GET', '/v1/stable/a', { user: 'b' })).body).toMatchObject({ stable: { playerId: 'a' }, viewer: { relation: 'friend', canLike: true } });
    expect((await call(c, 'GET', '/v1/stable/zz', { user: 'b' })).status).toBe(404);
    expect((await call(c, 'POST', '/v1/stable/a/like', { user: 'b' })).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await call(c, 'POST', '/v1/stable/a/like', { user: 'b', key: 'k1' })).body).toEqual({ playerId: 'a', likes: 1, remainingToday: 4 });
    expect((await call(c, 'POST', '/v1/stable/a/like', { user: 'b', key: 'k1' })).body).toEqual({ playerId: 'a', likes: 1, remainingToday: 4 });
    expect((await call(c, 'POST', '/v1/stable/a/like', { user: 'b', key: 'k2' })).body.error.code).toBe('ALREADY_LIKED');
    expect((await call(c, 'POST', '/v1/stable/a/like', { user: 'a', key: 'k3' })).body.error.code).toBe('NOT_ELIGIBLE');
    expect((await call(ctx(w, false), 'GET', '/v1/stable', { user: 'a' })).status).toBe(404);
  });
});
