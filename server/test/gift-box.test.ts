import { describe, expect, it } from 'vitest';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import type { Master } from '../src/domain/master.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import { deliverGift, GIFT_BOX_LIMITS, giftBoxProblems, type GiftBoxConfig } from '../src/domain/giftBox.js';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { DEFAULT_RULESET } from '../src/domain/ruleset.js';
import { authenticateAdmin, type AdminAuthConfig } from '../src/ops/admin.js';
import { sha256Hex } from '../src/ops/hash.js';
import { memoryOps } from '../src/ops/memoryOps.js';
import { resolveBundle } from '../src/ops/config.js';
import { untranslated } from '../src/i18n/catalog.js';
import { freshPlayer, m } from './helpers.js';

/** プレゼントボックス (REQ-BOX-001..014, contracts/protocol.md §26). */
const T0 = Date.UTC(2026, 10, 10, 3);
const DAY = 86_400_000;
const TOKENS = { viewer: 'viewer-token-0123456789', operator: 'operator-token-0123456789', admin: 'admin-token-0123456789', admin2: 'second-admin-token-0123456789' };
type Who = keyof typeof TOKENS;
const cfg = m.progression.giftBox!;
const withBox = (over: Partial<GiftBoxConfig> | null): Master => ({ ...m, progression: { ...m.progression, giftBox: over === null ? undefined : { ...cfg, ...over } } });

async function setup(master: Master = m) {
  let now = T0;
  const repo = new MemoryPlayerRepo();
  const kpi: KpiRecord[] = [];
  const svc = new PlayerService(repo, { master, rng: seededRng(3), clock: () => now, verifiers: { fake: new FakeStoreVerifier() }, onKpi: (_id, r) => { kpi.push(...r); } });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const ops = memoryOps(master, () => invoker);
  const auth: AdminAuthConfig = {
    tokens: await Promise.all((Object.keys(TOKENS) as Who[]).map(async (name) => ({ name, role: name === 'admin2' ? 'admin' as const : name, sha256: await sha256Hex(TOKENS[name]) }))),
  };
  const c: AppContext = {
    master,
    authenticate: async (r: Request) => { const u = r.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
    player: () => invoker,
    match: {} as AppContext['match'],
    friends: makeFriendsService(() => invoker, new MemoryDirectory()),
    leaderboard: { board: async () => ({ entries: [{ playerId: 'p1' }, { playerId: 'p2' }], total: 2 }), myRank: async () => ({}) },
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
  const admin = async (who: Who, method: string, path: string, body?: unknown) => {
    const res = await handle(new Request(`https://x${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKENS[who]}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), {}, c);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const player = async (user: string, method: string, path: string, key: string | null = `k${++n}`, lang?: string) => {
    const res = await handle(new Request(`https://x${path}`, { method, headers: { 'x-test-user': user, ...(key ? { 'idempotency-key': key } : {}), ...(lang ? { 'accept-language': lang } : {}) } }), {}, c);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const grant = (id: string, grant: unknown, extra: Record<string, unknown> = {}, who: Who = 'operator') => admin(who, 'POST', `/v1/admin/players/${id}/grants`, { grant, opKey: `op-${++n}`, reason: 'test grant', ...extra });
  return { svc, repo, kpi, c, admin, player, grant, ops, advance: (ms: number) => { now += ms; }, now: () => now };
}
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as AppError).code; } };

describe('REQ-BOX-012 progression.giftBox', () => {
  it('the shipped config is valid; compensation lasts 90 days, the rest 30', () => {
    expect(giftBoxProblems(m)).toEqual([]);
    expect(cfg.expiryDays).toEqual({ default: 30, bySource: { ops_compensation: 90 } });
    expect(cfg.maxUnclaimed).toBe(500);
    expect(m.push.templates.gift_arrived?.category).toBe('gifts');
  });
  it('refuses values out of range, unknown sources, a compensation shorter than the default, a missing push template', () => {
    const bad = (o: Partial<GiftBoxConfig>) => giftBoxProblems(withBox(o));
    expect(bad({ expiryDays: { default: 3 } }).join()).toMatch(/expiryDays.default/);
    expect(bad({ expiryDays: { default: 30, bySource: { ops_compensation: 10 } } }).join()).toMatch(/sooner than the default/);
    expect(bad({ expiryDays: { default: 30, bySource: { nope: 30 } as never } }).join()).toMatch(/unknown source nope/);
    expect(bad({ expiryDays: { default: 30, bySource: { event: 1000 } } }).join()).toMatch(/bySource.event/);
    expect(bad({ expiryDays: { default: 30, bySource: { event: null } } })).toEqual([]); // null = no expiry
    expect(bad({ maxUnclaimed: 5 }).join()).toMatch(/maxUnclaimed/);
    expect(bad({ maxUnclaimed: GIFT_BOX_LIMITS.maxUnclaimed[1] + 1 }).join()).toMatch(/maxUnclaimed/);
    expect(bad({ historyDays: 400 }).join()).toMatch(/historyDays/);
    expect(bad({ holdCaps: { freeCoins: 10, itemQty: 9999 } }).join()).toMatch(/holdCaps/);
    expect(bad({ pushSources: ['bogus' as never] }).join()).toMatch(/unknown source bogus/);
    expect(giftBoxProblems({ ...withBox({}), push: { ...m.push, templates: {} } }).join()).toMatch(/gift_arrived/);
    expect(bad({ paidCoins: 1 } as never).join()).toMatch(/unknown key paidCoins/);
  });
  it('remote config validates a change to giftBox', () => {
    expect(() => resolveBundle(m, { progression: { giftBox: { ...cfg, expiryDays: { default: 2 } } } } as never)).toThrow(/giftBox.expiryDays.default/);
    expect(resolveBundle(m, { progression: { giftBox: { ...cfg, expiryDays: { default: 14, bySource: { ops_compensation: 120 } } } } } as never).master.progression.giftBox!.expiryDays.default).toBe(14);
  });
});

describe('REQ-BOX-001/003/005/010 ops grants land in the box and are claimed into the wallet', () => {
  it('a direct grant does not touch the wallet; claiming moves it, once (idempotency key, ALREADY_CLAIMED)', async () => {
    const w = await setup();
    await w.svc.bootstrap('p1');
    const g = await w.grant('p1', { freeCoins: 300, items: [{ itemId: 'gacha_ticket', qty: 2 }] }, { titleKey: 'ops_compensation_maintenance' });
    expect(g.status).toBe(200);
    expect(g.body.gift).toMatchObject({ giftId: 'gift_1', expiresAt: T0 + 30 * DAY });
    expect(g.body.after.free).toBe(0);
    expect((await w.svc.view('p1')).giftBox).toEqual({ unclaimed: 1, expiringSoon: 0 });
    const list = await w.player('p1', 'GET', '/v1/gift-box', null);
    expect(list.body).toMatchObject({ enabled: true, tab: 'box', total: 1, badge: { unclaimed: 1 }, rules: { paidCoins: false } });
    const e = list.body.entries[0];
    expect(e).toMatchObject({ giftId: 'gift_1', source: 'ops_grant', titleKey: 'ops_compensation_maintenance', title: 'メンテナンスのお詫び', status: 'unclaimed', expiresAt: T0 + 30 * DAY });
    expect(e.lines).toEqual(['無償コイン300枚', 'スカウト券×2']);
    expect(e.note).toBeUndefined(); // the ops reason never reaches the player
    expect(e.ref).toBeUndefined();
    const claim = await w.player('p1', 'POST', '/v1/gift-box/gift_1/claim', 'same');
    expect(claim.body).toMatchObject({ claimed: [{ giftId: 'gift_1', freeCoins: 300 }], held: [], totals: { freeCoins: 300, items: { gacha_ticket: 2 } }, badge: { unclaimed: 0 }, items: { gacha_ticket: 2 } });
    expect(claim.body.wallet).toMatchObject({ free: 300, paid: 0 });
    const again = await w.player('p1', 'POST', '/v1/gift-box/gift_1/claim', 'same');
    expect(again.body).toEqual(claim.body); // retry with the same key = same answer, nothing paid twice
    const other = await w.player('p1', 'POST', '/v1/gift-box/gift_1/claim', 'other');
    expect(other.body.error.code).toBe('ALREADY_CLAIMED');
    const s = await w.svc.state('p1');
    expect(s.wallet.free).toBe(300);
    expect(s.items.gacha_ticket).toBe(2);
    expect(s.ledger.at(-1)).toMatchObject({ kind: 'grant', currency: 'free', delta: 300, ref: 'gift:gift_1' });
    expect(s.ledger.at(-1)!.reason).toMatch(/support grant by operator: test grant/);
    const hist = await w.player('p1', 'GET', '/v1/gift-box?tab=history', null);
    expect(hist.body.entries[0]).toMatchObject({ giftId: 'gift_1', status: 'claimed', how: 'one', doneAt: T0 });
    expect(w.kpi.filter((k) => k.name.startsWith('gift_')).map((k) => [k.name, k.s1, k.s2])).toEqual([['gift_receive', 'ops_grant', 'ops_compensation_maintenance'], ['gift_claim', 'ops_grant', 'one']]);
    // keys, ids and query checks
    expect((await w.player('p1', 'POST', '/v1/gift-box/gift_1/claim', null)).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await w.player('p1', 'POST', '/v1/gift-box/x1/claim')).status).toBe(400);
    expect((await w.player('p1', 'POST', '/v1/gift-box/gift_99/claim')).body.error.code).toBe('NOT_FOUND');
    expect((await w.player('p1', 'GET', '/v1/gift-box?tab=all', null)).status).toBe(400);
    expect((await w.player('p1', 'GET', '/v1/gift-box?limit=500', null)).status).toBe(400);
  });

  it('a re-sent grant (same opKey) puts one entry in the box; paid coins cannot be granted at all', async () => {
    const w = await setup();
    const body = { grant: { freeCoins: 50 }, opKey: 'same-op-key', reason: 'retry test' };
    await w.admin('operator', 'POST', '/v1/admin/players/p1/grants', body);
    await w.admin('operator', 'POST', '/v1/admin/players/p1/grants', body);
    expect((await w.svc.state('p1')).giftBox!.box).toHaveLength(1);
    const paid = await w.admin('admin', 'POST', '/v1/admin/players/p1/grants', { grant: { paidCoins: 50 }, opKey: 'paid-op-key', reason: 'paid try' });
    expect(paid.status).toBe(400);
    expect((await w.svc.state('p1')).wallet.paid).toBe(0);
    // expiry options: a number of days or none
    const forever = await w.grant('p1', { freeCoins: 10 }, { expiryDays: null });
    expect(forever.body.gift.expiresAt).toBeNull();
    expect((await w.grant('p1', { freeCoins: 10 }, { expiryDays: 0 })).status).toBe(400);
    expect((await w.grant('p1', { freeCoins: 10 }, { titleKey: 'season' })).status).toBe(400); // ops titles only
  });

  it('bulk grants put one entry in each box; the 24 h single-person budget is charged when it is put in', async () => {
    const w = await setup();
    const r = await w.admin('operator', 'POST', '/v1/admin/grants/bulk', { grant: { freeCoins: 10_000 }, opKey: 'bulk-1', reason: 'bulk test', playerIds: ['p1', 'p2'] });
    expect(r.body).toMatchObject({ granted: 2, failed: [] });
    for (const p of ['p1', 'p2']) expect((await w.svc.state(p)).giftBox!.box[0]).toMatchObject({ source: 'ops_grant', contents: { freeCoins: 10_000 } });
    // the budget is spent although nothing was claimed yet: a second single-person grant needs two people
    const more = await w.grant('p1', { freeCoins: 1 });
    expect(more.status).toBe(403);
    expect(more.body.error.message).toMatch(/two-person approval required/);
  });

  it('compensations: 90 days, the two-person rule decides when it is put in, the push respects the daily cap', async () => {
    const w = await setup();
    await w.svc.bootstrap('p1');
    await w.svc.registerDevice('p1', 'tok-aaaaaaaa', 'ios');
    const small = await w.admin('operator', 'POST', '/v1/admin/compensations', { playerId: 'p1', grant: { freeCoins: 500 }, opKey: 'comp-1', reason: 'incident 1', titleKey: 'ops_compensation_bug' });
    expect(small.body.request.status).toBe('executed');
    const big = await w.admin('operator', 'POST', '/v1/admin/compensations', { playerId: 'p1', grant: { freeCoins: 20_000 }, opKey: 'comp-2', reason: 'incident 2' });
    expect(big.body.request.status).toBe('pending');
    let s = await w.svc.state('p1');
    expect(s.giftBox!.box.map((e) => [e.source, e.titleKey, e.expiresAt])).toEqual([['ops_compensation', 'ops_compensation_bug', T0 + 90 * DAY]]);
    expect(s.push!.outbox.map((x) => x.templateId)).toEqual(['gift_arrived']);
    const ok = await w.admin('admin', 'POST', `/v1/admin/compensations/${big.body.request.id}/approve`, { reason: 'checked INC-2' });
    expect(ok.body.request.status).toBe('executed');
    s = await w.svc.state('p1');
    expect(s.giftBox!.box).toHaveLength(2);
    expect(s.giftBox!.box[1]).toMatchObject({ titleKey: 'ops_compensation', contents: { freeCoins: 20_000 } });
    expect(s.wallet.free).toBe(0);
    // daily cap 2: the third compensation of the day does not push again
    await w.admin('operator', 'POST', '/v1/admin/compensations', { playerId: 'p1', grant: { freeCoins: 5 }, opKey: 'comp-3', reason: 'incident 3', expiryDays: 7 });
    s = await w.svc.state('p1');
    expect(s.giftBox!.box).toHaveLength(3);
    expect(s.giftBox!.box[2]!.expiresAt).toBe(T0 + 7 * DAY);
    expect(s.push!.outbox.filter((x) => x.templateId === 'gift_arrived')).toHaveLength(2);
    // the same opKey with other gift options is a conflict
    expect((await w.admin('operator', 'POST', '/v1/admin/compensations', { playerId: 'p1', grant: { freeCoins: 5 }, opKey: 'comp-3', reason: 'incident 3', expiryDays: 8 })).status).toBe(409);
    // the console sees the box with the internal note
    const v = await w.admin('viewer', 'GET', '/v1/admin/players/p1');
    expect(v.body.state.giftBox.box).toHaveLength(3);
    expect(v.body.state.giftBox.box[0].note).toMatch(/incident/);
  });

  it('with the box switched off, grants go straight into the wallet as before', async () => {
    const w = await setup(withBox({ enabled: false }));
    const g = await w.grant('p1', { freeCoins: 40 });
    expect(g.body.after.free).toBe(40);
    expect(g.body.gift).toBeNull();
    const none = await setup(withBox(null));
    expect((await none.grant('p1', { freeCoins: 40 })).body.after.free).toBe(40);
    expect((await none.player('p1', 'GET', '/v1/gift-box', null)).body).toMatchObject({ enabled: false, total: 0 });
  });
});

describe('REQ-BOX-005 claim all and hold caps', () => {
  it('claims soonest-expiring first; an entry over a hold cap stays in the box with its reason', async () => {
    const w = await setup(withBox({ holdCaps: { freeCoins: 100_000, itemQty: 99 } }));
    await w.grant('p1', { items: [{ itemId: 'gacha_ticket', qty: 50 }] }, { expiryDays: 20 });
    await w.grant('p1', { items: [{ itemId: 'gacha_ticket', qty: 50 }] }, { expiryDays: 10 });
    await w.grant('p1', { freeCoins: 70 }, { expiryDays: null });
    const box = await w.player('p1', 'GET', '/v1/gift-box', null);
    expect(box.body.entries.map((e: any) => e.giftId)).toEqual(['gift_2', 'gift_1', 'gift_3']); // soonest first, no expiry last
    expect((await w.player('p1', 'POST', '/v1/gift-box/gift_2/claim')).status).toBe(200);
    expect((await w.player('p1', 'POST', '/v1/gift-box/gift_1/claim')).body.error.code).toBe('GIFT_HOLD_CAP');
    const all = await w.player('p1', 'POST', '/v1/gift-box/claim-all');
    expect(all.body).toMatchObject({ claimed: [{ giftId: 'gift_3', freeCoins: 70 }], held: [{ giftId: 'gift_1', reason: 'item_cap', itemId: 'gacha_ticket' }], badge: { unclaimed: 1 } });
    const left = await w.player('p1', 'GET', '/v1/gift-box', null);
    expect(left.body.entries[0]).toMatchObject({ giftId: 'gift_1', held: { reason: 'item_cap', itemId: 'gacha_ticket' } });
    const s = await w.svc.state('p1');
    expect(s.items.gacha_ticket).toBe(50);
    expect(s.wallet.free).toBe(70);
    // after using tickets, the held entry fits again
    s.items.gacha_ticket = 10;
    w.repo.put(s);
    const later = await w.player('p1', 'POST', '/v1/gift-box/claim-all');
    expect(later.body.claimed.map((x: any) => x.giftId)).toEqual(['gift_1']);
    expect((await w.player('p1', 'GET', '/v1/gift-box?tab=history', null)).body.entries[0]).toMatchObject({ giftId: 'gift_1', how: 'all', held: null });
  });
  it('the free coin hold cap', async () => {
    const w = await setup(withBox({ holdCaps: { freeCoins: 100_000, itemQty: 9999 } }));
    const s = await w.svc.state('p1');
    s.wallet.free = 99_990;
    w.repo.put(s);
    await w.grant('p1', { freeCoins: 20 });
    expect((await w.player('p1', 'POST', '/v1/gift-box/claim-all')).body.held).toEqual([{ giftId: 'gift_1', reason: 'coin_cap', itemId: null }]);
  });
  it('an empty claim-all is fine and nothing is paid twice under concurrent claims', async () => {
    const w = await setup();
    expect((await w.player('p1', 'POST', '/v1/gift-box/claim-all')).body).toMatchObject({ claimed: [], held: [], totals: { freeCoins: 0 } });
    await w.grant('p1', { freeCoins: 25 });
    const [a, b] = await Promise.all([w.svc.giftClaimAll('p1', 'c:a'), w.svc.giftClaim('p1', 'gift_1', 'c:b').catch((e: AppError) => e.code)]);
    expect((await w.svc.state('p1')).wallet.free).toBe(25);
    expect([a.claimed.length, b]).toContain(1);
  });
});

describe('REQ-BOX-006 expiry', () => {
  it('expired entries cannot be claimed, move to the history as expired, are not counted in the badge, and wake the alarm', async () => {
    const w = await setup();
    await w.grant('p1', { freeCoins: 10 });                                  // 30 days
    await w.admin('operator', 'POST', '/v1/admin/compensations', { playerId: 'p1', grant: { freeCoins: 20 }, opKey: 'comp-x', reason: 'incident' }); // 90 days
    await w.grant('p1', { freeCoins: 30 }, { expiryDays: null });           // never
    expect(await w.svc.nextWakeOf('p1')).toBe(T0 + 30 * DAY);
    w.advance(27 * DAY);
    expect((await w.svc.view('p1')).giftBox).toEqual({ unclaimed: 3, expiringSoon: 1 });
    w.advance(3 * DAY);
    // the badge (a read) never counts it, even before the expiry is written
    expect((await w.svc.view('p1')).giftBox).toEqual({ unclaimed: 2, expiringSoon: 0 });
    expect(await code(w.svc.giftClaim('p1', 'gift_1', 'c:1'))).toBe('GIFT_EXPIRED');
    const list = await w.player('p1', 'GET', '/v1/gift-box', null);
    expect(list.body.entries.map((e: any) => e.giftId)).toEqual(['gift_2', 'gift_3']);
    const hist = await w.player('p1', 'GET', '/v1/gift-box?tab=history', null);
    expect(hist.body.entries[0]).toMatchObject({ giftId: 'gift_1', status: 'expired', doneAt: T0 + 30 * DAY });
    expect(w.kpi.filter((k) => k.name === 'gift_expire').map((k) => [k.s1, k.freeCoins])).toEqual([['ops_grant', 10]]);
    expect(await w.svc.nextWakeOf('p1')).toBe(T0 + 90 * DAY);
    // the history keeps 90 days
    w.advance(91 * DAY);
    await w.svc.giftClaimAll('p1', 'c:2');
    const h2 = await w.player('p1', 'GET', '/v1/gift-box?tab=history', null);
    expect(h2.body.entries.map((e: any) => [e.giftId, e.status])).toEqual([['gift_3', 'claimed'], ['gift_2', 'expired']]);
    expect((await w.svc.state('p1')).wallet.free).toBe(30);
  });
  it('a plain GET writes nothing when nothing expired; paging', async () => {
    const w = await setup();
    for (let i = 0; i < 5; i++) await w.grant('p1', { freeCoins: 1 + i });
    const before = JSON.stringify(await w.svc.state('p1'));
    const p1 = await w.player('p1', 'GET', '/v1/gift-box?limit=2', null);
    expect(p1.body).toMatchObject({ total: 5, offset: 0, limit: 2, nextOffset: 2 });
    const p3 = await w.player('p1', 'GET', '/v1/gift-box?limit=2&offset=4', null);
    expect(p3.body).toMatchObject({ nextOffset: null });
    expect(p3.body.entries).toHaveLength(1);
    const s = JSON.parse(before);
    s.profile.lastSeenAt = (await w.svc.state('p1')).profile.lastSeenAt;
    expect(JSON.stringify(await w.svc.state('p1'))).toBe(JSON.stringify(s));
  });
});

describe('REQ-BOX-007 a full box', () => {
  it('auto-claims the earliest-expiring non-compensation entry; compensation is never dropped', async () => {
    const master = withBox({ maxUnclaimed: 50 });
    const s = freshPlayer('p1', T0);
    const emitted: string[] = [];
    const emit = (e: { name: string; s2?: string }) => { emitted.push(`${e.name}:${e.s2 ?? ''}`); };
    for (let i = 0; i < 49; i++) deliverGift(master, s, { source: 'ops_compensation', ref: `c${i}`, reward: { freeCoins: 1 }, note: 'comp' }, T0, emit);
    deliverGift(master, s, { source: 'event', ref: 'ev', reward: { freeCoins: 7 }, note: 'event' }, T0, emit);
    expect(s.giftBox!.box).toHaveLength(50);
    const r = deliverGift(master, s, { source: 'ops_compensation', ref: 'c-new', reward: { freeCoins: 2 }, note: 'comp' }, T0 + 1, emit);
    expect(r.status).toBe('boxed');
    expect(s.giftBox!.box).toHaveLength(50);
    expect(s.giftBox!.box.some((e) => e.ref === 'ev')).toBe(false);
    expect(s.giftBox!.history.find((e) => e.ref === 'ev')).toMatchObject({ status: 'claimed', how: 'overflow' });
    expect(s.wallet.free).toBe(7);
    expect(emitted).toContain('gift_claim:overflow');
    // only compensation left: it goes over the cap with a support flag, nothing is lost
    deliverGift(master, s, { source: 'ops_compensation', ref: 'c-over', reward: { freeCoins: 3 }, note: 'comp' }, T0 + 2, emit);
    expect(s.giftBox!.box).toHaveLength(51);
    expect(s.supportFlags!.some((f) => f.startsWith('gift_box_over_cap'))).toBe(true);
    expect(s.giftBox!.box.filter((e) => e.source === 'ops_compensation')).toHaveLength(51);
  });
  it('the same ref is never put in twice (REQ-BOX-008)', () => {
    const s = freshPlayer('p1', T0);
    const a = deliverGift(m, s, { source: 'tournament', ref: 'tournament:t1:rank', reward: { freeCoins: 5 }, note: 'x' }, T0);
    const b = deliverGift(m, s, { source: 'tournament', ref: 'tournament:t1:rank', reward: { freeCoins: 5 }, note: 'x' }, T0);
    expect(a).toMatchObject({ status: 'boxed', duplicate: false });
    expect(b).toMatchObject({ status: 'boxed', duplicate: true, giftId: (a as { giftId: string }).giftId });
    expect(s.giftBox!.box).toHaveLength(1);
  });
  it('horse / pass XP parts are granted at once, coins and items go to the box (REQ-BOX-002)', () => {
    const s = freshPlayer('p1', T0);
    const tpl = m.templates[0]!.id;
    deliverGift(m, s, { source: 'event', ref: 'e1', reward: { freeCoins: 5, horse: tpl, passXp: 3 }, note: 'event' }, T0);
    expect(s.horses.map((h) => h.templateId)).toEqual([tpl]);
    expect(s.seasonPass.xp).toBe(3);
    expect(s.giftBox!.box[0]!.contents).toEqual({ freeCoins: 5 });
    expect(Object.keys(s.giftBox!.box[0]!.contents)).not.toContain('paidCoins');
    const only = deliverGift(m, s, { source: 'event', ref: 'e2', reward: { passXp: 1 }, note: 'event' }, T0);
    expect(only.status).toBe('granted');
  });
});

describe('REQ-BOX-001 rewards with no claim screen go to the box', () => {
  it('tournament prize, event rank reward, branch / league and season rewards, invite milestones', async () => {
    const w = await setup();
    await w.svc.bootstrap('p1');
    await w.svc.tournamentClose('p1', 't1', 2, { freeCoins: 100, items: [{ itemId: 'gacha_ticket', qty: 1 }] }, '秋の大会');
    expect((await w.svc.tournamentClose('p1', 't1', 2, { freeCoins: 100 }, '秋の大会')).status).toBe('already');
    const ev = m.events[0]!;
    const st = await w.svc.state('p1');
    st.events = { [ev.id]: { points: 10, races: 1, wins: 0, milestones: [], pending: null, closed: false, rank: null } as never };
    w.repo.put(st);
    await w.svc.eventClose('p1', ev.id, 1);
    await w.svc.teamSeasonReward('p1', '2026-10', 'team1', 1, 500);
    const s = await w.svc.state('p1');
    const srcs = s.giftBox!.box.map((e) => [e.source, e.rank ?? null]);
    expect(srcs[0]).toEqual(['tournament', 2]);
    expect(srcs.some(([x]) => x === 'event')).toBe(true);
    expect(srcs.some(([x]) => x === 'team')).toBe(true);
    expect(s.wallet.free).toBe(0);
    const all = await w.svc.giftClaimAll('p1', 'c:all');
    expect(all.totals.freeCoins).toBeGreaterThan(100);
    expect((await w.svc.state('p1')).wallet.free).toBe(all.totals.freeCoins);
  });
  it('the inviter bonus goes to the box (the invitee did it, not the inviter)', async () => {
    const w = await setup();
    const inv = m.progression.invite!;
    await w.svc.bootstrap('inviter');
    await w.svc.inviteAccept('inviter', 'invitee', 'install-1', 'name');
    const ms = inv.milestones[0]!;
    const r = await w.svc.inviteMilestone('inviter', 'invitee', ms.id, 'ミナモ');
    expect(r.status).toBe('rewarded');
    const s = await w.svc.state('inviter');
    expect(s.giftBox!.box[0]).toMatchObject({ source: 'invite', titleKey: 'invite' });
    expect(s.wallet.free).toBe(0);
  });
});

describe('REQ-BOX-009 account deletion', () => {
  it('no claims while scheduled; nothing delivered while deleting; the wipe clears the box and refuses later grants', async () => {
    const w = await setup();
    await w.svc.bootstrap('p1');
    await w.grant('p1', { freeCoins: 10 });
    const t = (await w.svc.requestDeletion('p1', null)) as { confirmToken: string };
    await w.svc.requestDeletion('p1', t.confirmToken);
    expect(await code(w.svc.giftClaimAll('p1', 'c:1'))).toBe('DELETION_PENDING');
    expect(await code(w.svc.giftClaim('p1', 'gift_1', 'c:2'))).toBe('DELETION_PENDING');
    // a grant while only scheduled still arrives (the player may cancel)
    expect((await w.grant('p1', { freeCoins: 5 })).status).toBe(200);
    await w.svc.deletionStart('p1');
    const refused = await w.grant('p1', { freeCoins: 5 });
    expect(refused.body.error.code).toBe('DELETION_IN_PROGRESS');
    expect((await w.svc.tournamentClose('p1', 't9', 1, { freeCoins: 9 }, 'x')).status).toBe('rewarded');
    expect((await w.svc.state('p1')).giftBox!.box).toHaveLength(2); // the prize was forfeited, not boxed
    const rec = await w.svc.deletionFinalize('p1');
    expect(rec.forfeited.gifts).toEqual({ entries: 2, freeCoins: 15 });
    expect((await w.svc.state('p1')).giftBox!.box).toEqual([]);
    await w.svc.wipe('p1');
    const after = await w.grant('p1', { freeCoins: 5 });
    expect(after.status).toBe(404);
    expect(await w.repo.get('p1')).toBeNull(); // no fresh player under the deleted id
  });
});

describe('REQ-L10N for the box', () => {
  it('every title and line is in English with ?lang=en / Accept-Language', async () => {
    const w = await setup();
    for (const titleKey of ['ops_compensation', 'ops_compensation_maintenance', 'ops_compensation_bug', 'ops_grant']) {
      await w.grant('p1', { freeCoins: 5, items: [{ itemId: 'gacha_ticket', qty: 1 }, { itemId: 'breeding_material', qty: 1 }] }, { titleKey });
    }
    for (const src of ['invite', 'event', 'tournament', 'team', 'league', 'season'] as const) {
      const s = await w.svc.state('p1');
      deliverGift(m, s, { source: src, ref: `l10n:${src}`, reward: { freeCoins: 1, items: [{ itemId: 'ticket_sr_plus', qty: 1 }] }, note: 'x' }, w.now());
      w.repo.put(s);
    }
    const en = await w.player('p1', 'GET', '/v1/gift-box?limit=100', null, 'en');
    expect(untranslated(en.body)).toEqual([]);
    expect(en.body.entries.map((e: any) => e.title)).toContain('Apology for the maintenance');
    expect(en.body.entries[0].lines[0]).toMatch(/free coins/);
  });
});
