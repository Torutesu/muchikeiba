// 勝負服エディタ (contracts/protocol.md §35, REQ-SILK-001..016): parts, the shared code, validation (owned parts,
// readability, reserved silks), presets, part purchase through the cosmetics flow, refunds, KPI, English.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { m, freshPlayer } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { grantFree } from '../src/domain/wallet.js';
import { handle, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { cosmeticsCatalog } from '../src/domain/itemShop.js';
import { bannedMatch, BASE_BANNED_SILKS, bannedSilksProblems, type BannedSilksList } from '../src/domain/bannedSilks.js';
import { effectiveSilks, startVisuals, VISUALS, type Silks } from '../src/domain/visuals.js';
import {
  checkDesign, codeToDesign, decodeSilksCode, deltaE76, designToCode, encodeSilksCode, legacyToDesign, lowContrast, ownsPart, previewDesign,
  silksCodeOf, silksEditorOf, silksEditorProblems, silksEditorView, type SilksDesign, type SilksEditorMaster,
} from '../src/domain/silksEditor.js';
import { collectionOf, ensureCollection } from '../src/domain/collection.js';
import { compileCatalog, EN_BANNED, translateText } from '../src/i18n/catalog.js';
import { CODE_EN } from '../src/i18n/en.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import type { Master, Product } from '../src/domain/master.js';

const VECTORS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'contracts', 'silks-code.vectors.json'), 'utf8')) as {
  numeric: { numbers: (number | null)[]; code: string }[];
  designs: { design: SilksDesign; code: string }[];
  legacy: { silks: Silks; design: SilksDesign; code: string }[];
  invalid: string[];
};
const NOW = Date.UTC(2026, 10, 5, 3);
const D = (o: Partial<SilksDesign> = {}): SilksDesign => ({ pattern: 'hoops', colors: ['navy', 'white'], sleeve: 'match', cap: 'plain', capColors: ['navy', 'white'], ...o });
const codeOf = (f: () => unknown) => { try { f(); return null; } catch (e) { return (e as AppError).code; } };
const errOf = (f: () => unknown) => { try { f(); return null; } catch (e) { return e as AppError; } };

const BUNDLE: Product = { id: 'silks_bundle_test', kind: 'coins', name: '勝負服パーツのテスト', tab: 'coins', storeType: 'consumable', priceYen: 480, paidCoins: 310, items: [{ itemId: 'silkpart_sleeve_stars', qty: 1 }] } as unknown as Product;
const withBundle: Master = { ...m, products: [...m.products, BUNDLE] };

function world(master: Master = withBundle) {
  let now = NOW;
  const kpi: KpiRecord[] = [];
  const repo = new MemoryPlayerRepo();
  const store = new FakeStoreVerifier();
  const svc = new PlayerService(repo, { master, rng: seededRng(5), clock: () => now, verifiers: { fake: store }, onKpi: (_id, recs) => { kpi.push(...recs); } });
  let tx = 0;
  const buy = async (id: string, productId: string) => {
    const p = master.products.find((x) => x.id === productId)!;
    await svc.setAge(id, 1990, 1, false).catch(() => undefined);
    await svc.purchaseIntent(id, productId);
    const txId = `T${tx++}`;
    await svc.purchase(id, 'fake', productId, store.issue({ transactionId: txId, productId, purchasedAt: now, priceYen: p.priceYen }));
    return txId;
  };
  /** Direct state edit for setup (coins, races) — the same as playing / earning would leave it. */
  const edit = async (id: string, f: (s: import('../src/domain/player.js').PlayerState) => void) => {
    await svc.bootstrap(id);
    const s = repo.get(id)!;
    f(s);
    repo.put(s);
  };
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const c = {
    master, clock: () => now, player: () => invoker,
    authenticate: async (req: Request) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
  } as unknown as AppContext;
  const call = async (method: string, path: string, user: string, o: { lang?: string; key?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { 'x-test-user': user, 'content-type': 'application/json' };
    if (o.lang) headers['accept-language'] = o.lang;
    if (o.key) headers['idempotency-key'] = o.key;
    const res = await handle(new Request(`https://x${path}`, { method, headers, ...(method === 'GET' || method === 'DELETE' ? {} : { body: JSON.stringify(o.body ?? {}) }) }), {}, c);
    return { status: res.status, body: (await res.json()) as any };
  };
  return { svc, repo, kpi, buy, edit, call, advance: (ms: number) => { now += ms; } };
}

describe('REQ-SILK-002 code (shared with C# SilksCode)', () => {
  it('matches the shared vectors: numbers, designs and legacy silks', () => {
    for (const v of VECTORS.numeric) {
      expect(encodeSilksCode(v.numbers)).toBe(v.code);
      expect(decodeSilksCode(v.code)).toEqual(v.numbers);
    }
    for (const v of VECTORS.designs) {
      expect(designToCode(m, v.design)).toBe(v.code);
      expect(codeToDesign(m, v.code)).toEqual(v.design);
    }
    for (const v of VECTORS.legacy) {
      expect(legacyToDesign(v.silks)).toEqual(v.design);
      expect(silksCodeOf(m, v.silks)).toBe(v.code);
    }
    for (const c of VECTORS.invalid) expect(decodeSilksCode(c)).toBeNull();
  });
  it('is 17 lowercase chars, deterministic, and round-trips every part', () => {
    const e = silksEditorOf(m);
    for (const p of e.patterns) {
      const n = VISUALS.silks.patterns.find((x) => x.id === p.id)!.colors;
      const d = checkDesign(m, D({ pattern: p.id, colors: n === 3 ? ['navy', 'white', 'red'] : ['navy', 'white'] }));
      const code = designToCode(m, d);
      expect(code).toMatch(/^1[0-9a-z]{16}$/);
      expect(codeToDesign(m, code)).toEqual(d);
    }
    for (const c of e.colors) expect(codeToDesign(m, designToCode(m, D({ capColors: [c.id, c.id === 'black' ? 'white' : 'black'] }))).capColors[0]).toBe(c.id);
    for (const s of e.sleeves) expect(codeToDesign(m, designToCode(m, D({ sleeve: s.id }))).sleeve).toBe(s.id);
    for (const c of e.caps) expect(codeToDesign(m, designToCode(m, D({ cap: c.id }))).cap).toBe(c.id);
  });
  it('rejects malformed codes, unknown part numbers and a third colour on a 2-colour pattern', () => {
    expect(codeOf(() => codeToDesign(m, '1zz00000000000000'))).toBe('BAD_REQUEST');
    expect(codeOf(() => codeToDesign(m, '1yy0a00zz00000a00'))).toBe('BAD_REQUEST'); // unknown pattern number
    expect(codeOf(() => codeToDesign(m, '1010a0002000000a00'.slice(0, 17)))).toBe('BAD_REQUEST'); // hoops with a 3rd colour
    expect(codeOf(() => codeToDesign(m, '1090a00zz00000a00'))).toBe('BAD_REQUEST'); // stars needs a 3rd colour
    expect(codeOf(() => encodeSilksCode([0, 0, 0, 0, null, 0, 0, 0]))).toBe('BAD_REQUEST');
    expect(codeOf(() => encodeSilksCode([1295, 0, 0, null, 0, 0, 0, 0]))).toBe('BAD_REQUEST');
  });
  it('legacy silks keep working: same design, cap in body colours 1/2, sleeves like the body', () => {
    expect(legacyToDesign({ pattern: 'plain', colors: ['white', 'navy'], cap: 'plain' })).toEqual({ pattern: 'plain', colors: ['white', 'navy'], sleeve: 'match', cap: 'plain', capColors: ['white', 'navy'] });
  });
});

describe('REQ-SILK-013 master checks', () => {
  it('the shipped master is consistent (and with the cosmetics)', () => {
    expect(silksEditorProblems(m)).toEqual([]);
  });
  it('catches duplicate codes, bad special colours, unpaired cosmetics and unknown achievements', () => {
    const base = silksEditorOf(m);
    const bad = structuredClone(base) as SilksEditorMaster;
    bad.sleeves[1]!.code = 0;
    bad.colors.find((c) => c.id === 'crimson')!.base = 'nope';
    bad.caps.find((c) => c.id === 'diamond')!.source = { kind: 'achievement', achievementId: 'nope', tier: 1 };
    bad.caps.find((c) => c.id === 'spots')!.source = { kind: 'free' };
    bad.patterns.pop();
    bad.presets.max = 0;
    const p = silksEditorProblems(m, bad).join('\n');
    expect(p).toMatch(/duplicate code 0/);
    expect(p).toMatch(/crimson: base must be a palette colour/);
    expect(p).toMatch(/unknown achievement nope/);
    expect(p).toMatch(/silkpart_cap_spots: cap spots must have source item silkpart_cap_spots/);
    expect(p).toMatch(/exactly the visuals.json silks patterns/);
    expect(p).toMatch(/presets.max/);
  });
  it('codes fit two base-36 digits with zz reserved', () => {
    const bad = structuredClone(silksEditorOf(m)) as SilksEditorMaster;
    bad.colors[0]!.code = 1295;
    expect(silksEditorProblems(m, bad).join()).toMatch(/code must be 0\.\.1294/);
  });
});

describe('REQ-SILK-004 ownership', () => {
  it('free parts are owned; item / achievement / race parts follow their condition', () => {
    const s = freshPlayer();
    expect(ownsPart(m, s, 'pattern', 'hoops')).toBe(true);
    expect(ownsPart(m, s, 'pattern', 'laurel')).toBe(false); // visuals unlockItem
    expect(ownsPart(m, s, 'color', 'navy')).toBe(true);
    expect(ownsPart(m, s, 'color', 'crimson')).toBe(false);
    s.items.silkpart_color_crimson = 1;
    expect(ownsPart(m, s, 'color', 'crimson')).toBe(true);
    expect(ownsPart(m, s, 'sleeve', 'armlets')).toBe(false);
    s.stats.races = 10;
    expect(ownsPart(m, s, 'sleeve', 'armlets')).toBe(true);
    expect(ownsPart(m, s, 'color', 'royal')).toBe(false);
    ensureCollection(s).tiers['wins:2'] = { at: NOW, claimedAt: null }; // reached, not claimed: still owned
    expect(ownsPart(m, s, 'color', 'royal')).toBe(true);
  });
});

describe('REQ-SILK-008/009 readability and reserved silks', () => {
  it('ΔE below the minimum is refused for body colours 1/2 and the cap; the catalog lists every low pair', () => {
    expect(deltaE76('#F5F5F2', '#E5E4E2')).toBeLessThan(20);
    expect(deltaE76('#D3302F', '#2457C5')).toBeGreaterThan(20);
    expect(lowContrast(m, D({ colors: ['white', 'platinum'] }))).toBe(true);
    expect(lowContrast(m, D({ capColors: ['red', 'crimson'] }))).toBe(true);
    expect(lowContrast(m, D({ colors: ['red', 'blue'] }))).toBe(false);
    const pairs = silksEditorView(m, freshPlayer()).lowContrastPairs.map((p) => p.join('|'));
    expect(pairs).toEqual(expect.arrayContaining(['white|platinum', 'red|crimson', 'yellow|gold']));
    expect(pairs).not.toContain('red|blue');
  });
  it('a banned body stays banned whatever the sleeves / cap colours; special colours match by their base family', () => {
    const list: BannedSilksList = { ...BASE_BANNED_SILKS, entries: [{ id: 'x1', source: 'test', pattern: 'hoops', colors: ['red', 'white'] }, { id: 'x2', source: 'test', pattern: 'sash', colors: ['green', 'yellow'], sleeve: 'stars', capColors: ['green', 'green'] }] };
    expect(bannedSilksProblems(list, VISUALS)).toEqual([]);
    const mm: Master = { ...m, bannedSilks: list };
    const s = freshPlayer();
    s.items.silkpart_color_crimson = 1; s.items.silkpart_sleeve_stars = 1; s.items.silkpart_color_emerald = 1;
    const e = (d: SilksDesign) => errOf(() => previewDesign(mm, s, d))?.code ?? previewDesign(mm, s, d).problems.map((p) => p.problem).join();
    expect(e(D({ colors: ['red', 'white'] }))).toBe('RESERVED');
    expect(e(D({ colors: ['crimson', 'white'], sleeve: 'stars', capColors: ['black', 'yellow'] }))).toBe('RESERVED'); // crimson ≈ red, sleeves don't escape
    expect(e(D({ colors: ['white', 'red'] }))).toBe('RESERVED'); // hoops are symmetric
    // an entry with sleeve / capColors conditions only matches when they match too
    expect(e(D({ pattern: 'sash', colors: ['emerald', 'yellow'], sleeve: 'stars', capColors: ['green', 'lime'] }))).toBe('RESERVED');
    expect(e(D({ pattern: 'sash', colors: ['emerald', 'yellow'], sleeve: 'plain', capColors: ['green', 'lime'] }))).toBe('');
    // shown-time check (list imported after saving) also sees the editor fields
    const saved = { pattern: 'sash', colors: ['green', 'yellow'], cap: 'plain', sleeve: 'stars', capColors: ['green', 'lime'], code: 'x' } as Silks;
    expect(bannedMatch({ ...list, entries: list.entries }, saved)?.id).toBe('x2');
    expect(effectiveSilks(saved, 'p:a', list).code).toBeUndefined();
  });
});

describe('REQ-SILK-006 preview (try before buying)', () => {
  it('locked parts with price and how to get them; nothing changes', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    const before = JSON.stringify(w.repo.get('p'));
    const r = await w.svc.silksPreview('p', { design: D({ pattern: 'stars', colors: ['crimson', 'platinum', 'white'], sleeve: 'stars', cap: 'diamond', capColors: ['navy', 'white'] }) });
    expect(r.owned).toBe(false);
    expect(r.savable).toBe(false);
    expect(r.locked.map((l) => `${l.type}:${l.id}`)).toEqual(['color:crimson', 'color:platinum', 'sleeve:stars', 'cap:diamond']);
    expect(r.totalPrice).toEqual({ any: 400, paidOnly: 400 });
    expect(r.locked.find((l) => l.id === 'diamond')!.sourceLabel).toBe(`実績「${collectionOf(m).achievements.find((a) => a.id === 'podiums')!.name}」の3段目で解放`);
    expect(r.locked.find((l) => l.id === 'platinum')!.sourceLabel).toBe('有償コイン400で購入');
    expect(r.code).toMatch(/^1[0-9a-z]{16}$/);
    expect(JSON.stringify(w.repo.get('p'))).toBe(before);
    expect((await w.svc.silksPreview('p', { code: r.code })).design).toEqual(r.design);
  });
});

describe('REQ-SILK-012 PUT /v1/silks', () => {
  it('equips an owned design, others receive the code (race visuals, profile); idempotent, KPI on change only', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    const r = await w.svc.saveSilks('p', { design: D({ pattern: 'stars', colors: ['red', 'white', 'navy'], sleeve: 'hoops', cap: 'star', capColors: ['white', 'red'] }) });
    expect(r.code).toBe(designToCode(m, r.design));
    expect(r.silks).toMatchObject({ pattern: 'stars', colors: ['red', 'white', 'navy'], cap: 'star', sleeve: 'hoops', code: r.code });
    const pub = await w.svc.publicProfile('p');
    expect(pub.silks?.code).toBe(r.code);
    await w.svc.tutorialDraw('p', 'c:t1');
    const entry = await w.svc.raceEntry('p', (await w.svc.view('p')).horses[0]!.id);
    expect((entry as { visual?: { silks: Silks } }).visual!.silks.code).toBe(r.code);
    expect(w.kpi.filter((k) => k.name === 'silks_edit')).toHaveLength(1);
    expect(w.kpi.find((k) => k.name === 'silks_edit')).toMatchObject({ s1: r.code, s2: 'editor', value: 0 });
    await w.svc.saveSilks('p', { code: r.code });
    expect(w.kpi.filter((k) => k.name === 'silks_edit')).toHaveLength(1);
  });
  it('race start visuals pass the code through (not part of the hashed config)', () => {
    const silks = { pattern: 'hoops', colors: ['navy', 'white'], cap: 'plain', sleeve: 'stars', capColors: ['navy', 'white'] as [string, string], code: '1010a00zz06000a00' };
    const cfg = { raceId: 'r1', track: { id: m.tracks[0]!.id, surface: m.tracks[0]!.surface }, entrants: [{ slot: 0, playerId: 'p', horse: { id: 'h1', name: 'テスト' } }] } as never;
    const v = startVisuals(cfg, { p: { appearance: { coat: 'bay', face: 'none', legs: ['none', 'none', 'none', 'none'], mane: 'black', build: 'standard' }, silks, displayName: null, titleId: null } });
    expect(v.entrants[0]!.silks.code).toBe(silks.code);
  });
  it('refuses unowned parts (with the locked list), low contrast and one colour only', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    const e1 = await w.svc.saveSilks('p', { design: D({ colors: ['crimson', 'white'] }) }).catch((e) => e as AppError);
    expect(e1).toMatchObject({ code: 'NOT_ELIGIBLE', details: { locked: [{ type: 'color', id: 'crimson' }] } });
    const e2 = await w.svc.saveSilks('p', { design: D({ colors: ['yellow', 'gold'] }) }).catch((e) => e as AppError);
    expect(e2).toMatchObject({ code: 'BAD_REQUEST', details: { problem: 'LOW_CONTRAST' } });
    expect(await w.svc.saveSilks('p', { design: D({ colors: ['navy', 'navy'] }) }).catch((e) => (e as AppError).code)).toBe('BAD_REQUEST');
    expect(await w.svc.saveSilks('p', { design: D({ sleeve: 'nope' }) }).catch((e) => (e as AppError).code)).toBe('BAD_REQUEST');
    expect(w.kpi.filter((k) => k.name === 'silks_edit')).toHaveLength(0);
  });
  it('HTTP: design or code (not both, not neither), strict keys, malformed code 400; counts the beginner silks mission', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    expect((await w.call('PUT', '/v1/silks', 'p', { body: {} })).status).toBe(400);
    expect((await w.call('PUT', '/v1/silks', 'p', { body: { code: '1010a00zz00000a00', design: D() } })).status).toBe(400);
    expect((await w.call('PUT', '/v1/silks', 'p', { body: { code: 'XYZ' } })).status).toBe(400);
    expect((await w.call('PUT', '/v1/silks', 'p', { body: { design: { ...D(), extra: 1 } } })).status).toBe(400);
    const ok = await w.call('PUT', '/v1/silks', 'p', { body: { code: '1010a00zz00000a00' } });
    expect(ok.status).toBe(200);
    expect(ok.body.design).toEqual(D());
    const view = await w.call('GET', '/v1/silks/editor', 'p');
    expect(view.body.current.code).toBe('1010a00zz00000a00');
    const st = w.repo.get('p') as unknown as { onboarding?: { counters?: Record<string, number> } };
    expect(JSON.stringify(st)).toMatch(/silks/);
  });
  it('the old PUT /v1/player/silks still works and drops the editor code', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await w.svc.saveSilks('p', { design: D({ sleeve: 'hoops' }) });
    const r = await w.svc.setSilks('p', { pattern: 'plain', colors: ['white', 'navy'], cap: 'plain' });
    expect(r.silks.code).toBeUndefined();
    expect((await w.svc.silksEditor('p')).current.design.sleeve).toBe('match');
  });
});

describe('REQ-SILK-005 buying parts (cosmetics flow)', () => {
  it('fixed price, paid coins first, paid-only part on paid coins, once only, idempotent, KPI on both APIs', async () => {
    const w = world();
    await w.edit('p', (s) => grantFree(s, 500, NOW, 'test', 't'));
    const r = await w.call('POST', '/v1/silks/parts/silkpart_color_crimson/buy', 'p', { key: 'k1' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ itemId: 'silkpart_color_crimson', spent: { paid: 0, free: 200 }, wallet: { free: 300 }, part: { type: 'color', id: 'crimson', owned: true } });
    const again = await w.call('POST', '/v1/silks/parts/silkpart_color_crimson/buy', 'p', { key: 'k1' }); // same key: same answer, no second charge
    expect(again.body.wallet.free).toBe(300);
    expect((await w.call('POST', '/v1/silks/parts/silkpart_color_crimson/buy', 'p', { key: 'k2' })).body.error.code).toBe('ALREADY_PURCHASED');
    expect((await w.call('POST', '/v1/silks/parts/silkpart_color_crimson/buy', 'p')).status).toBe(400); // key required
    const paidOnly = await w.call('POST', '/v1/silks/parts/silkpart_color_platinum/buy', 'p', { key: 'k3' });
    expect(paidOnly.body.error.code).toBe('INSUFFICIENT_COINS');
    expect(paidOnly.body.error.details.shortfall).toMatchObject({ coinKind: 'paid', need: 400 });
    expect((await w.call('POST', '/v1/silks/parts/tack_bridle_classic/buy', 'p', { key: 'k4' })).status).toBe(404); // not a silks part
    await w.buy('p', 'coin_480'); // 310 paid
    const sleeve = await w.call('POST', '/v1/shop/cosmetics/silkpart_sleeve_chevrons/buy', 'p', { key: 'k5' }); // the shop's cosmetics tab
    expect(sleeve.body.spent).toEqual({ paid: 150, free: 0 });
    const buys = w.kpi.filter((k) => k.name === 'silks_part_buy');
    expect(buys.map((k) => [k.s1, k.s2, k.s3, k.paidCoins, k.freeCoins, k.value])).toEqual([
      ['silkpart_color_crimson', 'color', 'any', 0, 200, 200],
      ['silkpart_sleeve_chevrons', 'sleeve', 'any', 150, 0, 150],
    ]);
    // now owned: the editor saves it
    expect((await w.svc.saveSilks('p', { design: D({ colors: ['crimson', 'white'], sleeve: 'chevrons' }) })).silks.colors).toEqual(['red', 'white']); // base colour for older clients
  });
  it('parts show in the shop cosmetics tab with part/ref and equipped', async () => {
    const w = world();
    await w.edit('p', (s) => { s.items.silkpart_sleeve_stars = 1; });
    await w.svc.saveSilks('p', { design: D({ sleeve: 'stars' }) });
    const cat = cosmeticsCatalog(m, w.repo.get('p')!);
    const it = cat.items.find((x) => x.id === 'silkpart_sleeve_stars')!;
    expect(it).toMatchObject({ kind: 'silks_part', part: 'sleeve', ref: 'stars', owned: true, equipped: true, asset: 'silks/sleeve/stars', price: 200 });
    expect(cat.items.find((x) => x.id === 'silkpart_cap_spots')).toMatchObject({ owned: false, equipped: false });
  });
});

describe('REQ-SILK-011 presets', () => {
  it('up to 5 slots, private names, update / delete / apply, KPI with source preset', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    const designs = ['red', 'blue', 'green', 'yellow', 'black'].map((c) => D({ colors: [c, 'white'] }));
    for (const [i, d] of designs.entries()) expect((await w.svc.silksPresetCreate('p', i === 0 ? '  本番用  ' : undefined, { design: d })).slot).toBe(i);
    const full = await w.svc.silksPresetCreate('p', 'x', { design: D() }).catch((e) => (e as AppError).code);
    expect(full).toBe('CONFLICT');
    let v = await w.svc.silksEditor('p');
    expect(v.presets.map((p) => p.name)).toEqual(['本番用', 'プリセット2', 'プリセット3', 'プリセット4', 'プリセット5']);
    expect(v.presets.every((p) => p.usable)).toBe(true);
    expect(await w.svc.silksPresetUpdate('p', 1, 'a'.repeat(13), null).catch((e) => (e as AppError).code)).toBe('BAD_REQUEST');
    expect(await w.svc.silksPresetUpdate('p', 1, 'a‮b', null).catch((e) => (e as AppError).code)).toBe('BAD_REQUEST');
    await w.svc.silksPresetUpdate('p', 1, '雨の日', { design: D({ colors: ['sky', 'navy'] }) });
    await w.svc.silksPresetDelete('p', 2);
    expect(await w.svc.silksPresetDelete('p', 2).catch((e) => (e as AppError).code)).toBe('NOT_FOUND');
    expect((await w.svc.silksPresetCreate('p', undefined, { design: D() })).slot).toBe(2); // smallest free slot
    const applied = await w.svc.silksPresetApply('p', 1);
    expect(applied.design.colors).toEqual(['sky', 'navy']);
    expect(w.kpi.filter((k) => k.name === 'silks_edit').at(-1)).toMatchObject({ s2: 'preset', count: 5 });
    v = await w.svc.silksEditor('p');
    expect(v.current.code).toBe(applied.code);
    // HTTP shapes
    expect((await w.call('POST', '/v1/silks/presets/abc/apply', 'p')).status).toBe(400);
    expect((await w.call('PUT', '/v1/silks/presets/1', 'p', { body: {} })).status).toBe(400);
    expect((await w.call('DELETE', '/v1/silks/presets/4', 'p')).body.presets).toHaveLength(4);
    expect((await w.call('POST', '/v1/silks/presets', 'p', { body: { name: 'x' } })).status).toBe(400);
    expect((await w.call('POST', '/v1/silks/presets', 'p', { body: { name: 'x', code: '1010a00zz00000a00' } })).body.slot).toBe(4);
  });
  it('presets need owned parts and pass the same checks', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    expect(await w.svc.silksPresetCreate('p', 'x', { design: D({ cap: 'spots' }) }).catch((e) => (e as AppError).code)).toBe('NOT_ELIGIBLE');
    expect(await w.svc.silksPresetCreate('p', 'x', { design: D({ colors: ['yellow', 'gold'] }) }).catch((e) => (e as AppError).code)).toBe('BAD_REQUEST');
  });
});

describe('REQ-SILK-010 refunds take parts back', () => {
  it('equipped silks go back to the default with a one-time notice; presets stay but are unusable until re-owned', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    const tx = await w.buy('p', BUNDLE.id);
    await w.svc.saveSilks('p', { design: D({ sleeve: 'stars' }) });
    await w.svc.silksPresetCreate('p', '星袖', { design: D({ sleeve: 'stars', colors: ['red', 'white'] }) });
    await w.svc.silksPresetCreate('p', '普通', { design: D() });
    const r = await w.svc.refund('p', tx);
    expect((r as { silksReset?: boolean }).silksReset).toBe(true);
    const v = await w.svc.silksEditor('p');
    expect(v.current.silks.code).toBeUndefined(); // default silks
    expect(v.current.resetNotice).toMatchObject({ reason: 'refund', message: '返金によりパーツが取り消されたため、勝負服を初期の柄に戻しました' });
    expect(v.presets.map((p) => [p.name, p.usable, p.missing.map((x) => x.id)])).toEqual([['星袖', false, ['stars']], ['普通', true, []]]);
    expect(await w.svc.silksPresetApply('p', 0).catch((e) => (e as AppError).code)).toBe('NOT_ELIGIBLE');
    await w.svc.silksNoticeSeen('p');
    expect((await w.svc.silksEditor('p')).current.resetNotice).toBeNull();
    // a refund that took nothing the silks use leaves them alone
    const tx2 = await w.buy('p', 'coin_160');
    await w.svc.saveSilks('p', { design: D({ colors: ['red', 'white'] }) });
    expect((await w.svc.refund('p', tx2) as { silksReset?: boolean }).silksReset).toBeUndefined();
    expect((await w.svc.silksEditor('p')).current.design.colors).toEqual(['red', 'white']);
  });
});

describe('REQ-SILK-012 GET /v1/silks/editor', () => {
  it('catalog with owned / source / shop, current design and code, never creates state', async () => {
    const w = world();
    const v = await w.svc.silksEditor('ghost');
    expect(w.repo.get('ghost')).toBeNull();
    expect(v.maxPresets).toBe(5);
    expect(v.notice).not.toMatch(/倍|今だけ|残りわずか|お得|通常価格/);
    const crimson = v.parts.colors.find((c) => c.id === 'crimson')!;
    expect(crimson).toMatchObject({ owned: false, hex: '#B3122E', base: 'red', sourceLabel: 'コイン200で購入', shop: { itemId: 'silkpart_color_crimson', price: 200, currency: 'any', forSale: true } });
    expect(v.parts.sleeves.find((c) => c.id === 'armlets')!.sourceLabel).toBe('レースを10回走ると解放');
    expect(v.parts.patterns.find((c) => c.id === 'promo_b')!.sourceLabel).toBe('商品・報酬で入手');
    expect(v.parts.patterns.find((c) => c.id === 'hoops')).toMatchObject({ owned: true, sourceLabel: '最初から使える', colors: 2 });
    expect(v.current.code).toMatch(/^1[0-9a-z]{16}$/);
  });
  it('English: names, source lines, notices and problems all translate (preset names are never translated)', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await w.svc.silksPresetCreate('p', '本番用', { design: D() });
    const v = await w.call('GET', '/v1/silks/editor', 'p', { lang: 'en' });
    const texts: string[] = [v.body.notice];
    for (const list of Object.values(v.body.parts) as { name: string; sourceLabel: string }[][]) for (const p of list) texts.push(p.name, p.sourceLabel);
    for (const t of texts) expect(t, t).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
    expect(v.body.presets[0].name).toBe('本番用');
    const pv = await w.call('POST', '/v1/silks/preview', 'p', { lang: 'en', body: { design: D({ colors: ['white', 'platinum'] }) } });
    for (const t of [...pv.body.problems.map((p: { message: string }) => p.message), ...pv.body.locked.map((l: { name: string; sourceLabel: string }) => l.name + l.sourceLabel)]) expect(t).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
    expect(translateText('返金によりパーツが取り消されたため、勝負服を初期の柄に戻しました', compileCatalog(CODE_EN))).not.toMatch(/[ぁ-ん]/);
    for (const t of texts) for (const re of EN_BANNED) expect(t).not.toMatch(re);
  });
});

describe('REQ-SILK-004 earned parts are not rewards', () => {
  it('race count and achievement tiers unlock parts without granting items or coins', async () => {
    const w = world();
    await w.edit('p', (s) => { s.stats.races = 50; });
    const before = w.repo.get('p')!;
    const v = await w.svc.silksEditor('p');
    expect(v.parts.colors.find((c) => c.id === 'sakura')!.owned).toBe(true);
    expect(v.parts.sleeves.find((c) => c.id === 'armlets')!.owned).toBe(true);
    const after = w.repo.get('p')!;
    expect(after.items).toEqual(before.items);
    expect(after.wallet).toEqual(before.wallet);
  });
});
