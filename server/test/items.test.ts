import { describe, expect, it } from 'vitest';
import { breed, breedingAllowance, createHorseFromTemplate, retire } from '../src/domain/horses.js';
import { buyCosmetic, cosmeticsCatalog, itemsProblems, setEquipment, srPlusPool, ticketDisclosure, useTicket } from '../src/domain/itemShop.js';
import { oddsDisclosure, findBanner } from '../src/domain/gacha.js';
import { PPM_TOTAL, STAT_KEYS, type Master } from '../src/domain/master.js';
import { seededRng } from '../src/domain/rng.js';
import { grantFree, grantPaid } from '../src/domain/wallet.js';
import { addItems, clawbackItems } from '../src/domain/items.js';
import { validateSilks } from '../src/domain/visuals.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { buildAssetManifest } from '../src/domain/assetManifest.js';
import { handle } from '../src/http/app.js';
import { freshPlayer, m } from './helpers.js';
import type { AppError } from '../src/domain/errors.js';
import commentary from '../../engine/Muchi.Client/Resources/Muchi/commentary-ja.json';

const NOW = Date.UTC(2026, 10, 5, 3);
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as AppError).code; } return 'NO_ERROR'; };
const tpl = (id: string) => m.templateById.get(id)!;

describe('items master (REQ-ITEM-001..007)', () => {
  it('the shipped master is valid', () => {
    expect(itemsProblems(m)).toEqual([]);
  });
  it('rejects tickets that would reach a paid-only banner, SR+ tables with R, and broken cosmetics', () => {
    const bad: Master = structuredClone({ ...m, templateById: undefined }) as unknown as Master;
    bad.templateById = m.templateById;
    bad.items.tickets.gacha_ticket = { kind: 'single', name: 'x', banners: ['stepup_paid', 'nope'] };
    bad.items.tickets.ticket_sr_plus = { kind: 'srPlus', name: 'y', rates: { SSR: 60000, SR: 900000, R: 40000 } };
    bad.items.cosmetics.push({ id: 'tack_bridle_classic', name: 'dup', kind: 'tack', slot: 'bridle', asset: 'tack/x', price: 1, currency: 'any' });
    bad.items.cosmetics.push({ id: 'costume_bad', name: 'bad', kind: 'silks', pattern: 'laurel', price: 0, currency: 'any' });
    bad.items.cosmetics.push({ id: 'decor_bad', name: 'bad', kind: 'decor', asset: 'tack/oops', price: 5, currency: 'any' });
    const p = itemsProblems(bad).join('\n');
    expect(p).toMatch(/paid-only banner stepup_paid/);
    expect(p).toMatch(/unknown banner nope/);
    expect(p).toMatch(/cannot draw R/);
    expect(p).toMatch(/duplicate cosmetic/);
    expect(p).toMatch(/costume_bad: price/);
    expect(p).toMatch(/pattern laurel must have unlockItem costume_bad/);
    expect(p).toMatch(/decor_bad: asset must be a decor/);
  });
  it('every cosmetic, ticket and tack/decor asset key is in the asset manifest', () => {
    const keys = new Set(buildAssetManifest(m, commentary as never).keys);
    for (const c of m.items.cosmetics) {
      expect(keys.has(`item/${c.id}`)).toBe(true);
      if (c.kind !== 'silks') expect(keys.has(c.asset)).toBe(true);
    }
    for (const id of [...Object.keys(m.items.tickets), m.items.breedingMaterial.itemId]) expect(keys.has(`item/${id}`)).toBe(true);
    expect(keys.has('tack/default')).toBe(true);
    expect(keys.has('decor/default')).toBe(true);
  });
});

describe('gacha ticket (REQ-ITEM-001)', () => {
  it('draws once from the banner table, counts toward pity and consumes one ticket', () => {
    const s = freshPlayer();
    addItems(s, [{ itemId: 'gacha_ticket', qty: 2 }]);
    const b = findBanner(m, 'standard');
    const r = useTicket(m, s, 'gacha_ticket', 'standard', seededRng(1), NOW, 'k1');
    expect(b.pool.some((e) => e.templateId === r.result.templateId)).toBe(true);
    expect(r.pityPoints).toBe(1);
    expect(s.pity.standard).toBe(1);
    expect(s.items.gacha_ticket).toBe(1);
    expect(s.wallet.free + s.wallet.paid).toBe(0); // no coins used
    expect(s.itemLog?.at(-1)).toMatchObject({ itemId: 'gacha_ticket', delta: -1, ref: 'k1' });
  });
  it('is refused on paid-only or unlisted banners, without tickets, with debt, and on closed banners', () => {
    const s = freshPlayer();
    addItems(s, [{ itemId: 'gacha_ticket', qty: 1 }]);
    expect(code(() => useTicket(m, s, 'gacha_ticket', 'stepup_paid', seededRng(1), NOW, 'k'))).toBe('NOT_ELIGIBLE');
    expect(code(() => useTicket(m, s, 'gacha_ticket', null, seededRng(1), NOW, 'k'))).toBe('BAD_REQUEST');
    s.itemDebt = { ticket_sr_plus: 1 };
    expect(code(() => useTicket(m, s, 'gacha_ticket', 'standard', seededRng(1), NOW, 'k'))).toBe('UNSETTLED_DEBT');
    delete s.itemDebt;
    useTicket(m, s, 'gacha_ticket', 'standard', seededRng(1), NOW, 'k');
    expect(code(() => useTicket(m, s, 'gacha_ticket', 'standard', seededRng(1), NOW, 'k'))).toBe('INSUFFICIENT_ITEMS');
    const closed: Master = { ...m, gacha: { ...m.gacha, banners: m.gacha.banners.map((x) => (x.id === 'pickup_akatsuki' ? { ...x, endAtMs: NOW } : x)) } };
    addItems(s, [{ itemId: 'gacha_ticket', qty: 1 }]);
    expect(code(() => useTicket(closed, s, 'gacha_ticket', 'pickup_akatsuki', seededRng(1), NOW, 'k'))).toBe('BANNER_CLOSED');
    expect(s.items.gacha_ticket).toBe(1); // nothing consumed by a refused draw
  });
  it('the banner odds disclosure names the tickets that draw from it (same table)', () => {
    const d = oddsDisclosure(m, findBanner(m, 'standard'));
    expect(d.tickets.map((t) => t.itemId)).toEqual(['gacha_ticket', 'gacha_ticket_10']);
    expect(oddsDisclosure(m, findBanner(m, 'stepup_paid')).tickets).toEqual([]);
  });
});

describe('SR+ ticket (REQ-ITEM-002)', () => {
  it('discloses a table that sums to 100% and only contains SR or better — the very table it draws from', () => {
    const d = ticketDisclosure(m, 'ticket_sr_plus') as { items: { templateId: string; ppm: number; rarity: string }[] };
    expect(d.items.reduce((a, e) => a + e.ppm, 0)).toBe(PPM_TOTAL);
    expect(d.items.every((e) => e.rarity !== 'R')).toBe(true);
    expect(d.items.map((e) => [e.templateId, e.ppm])).toEqual(srPlusPool(m, 'ticket_sr_plus').map((e) => [e.templateId, e.ppm]));
  });
  it('always yields SR+ and the SSR share matches the disclosed rate', () => {
    const rng = seededRng(42);
    let ssr = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const s = freshPlayer();
      addItems(s, [{ itemId: 'ticket_sr_plus', qty: 1 }]);
      const r = useTicket(m, s, 'ticket_sr_plus', null, rng, NOW, `k${i}`);
      expect(r.result.rarity === 'SR' || r.result.rarity === 'SSR').toBe(true);
      expect(r.result.guaranteed).toBe(true);
      expect(s.pity).toEqual({}); // SR+ tickets never add pity
      if (r.result.rarity === 'SSR') ssr++;
    }
    const expected = (m.items.tickets.ticket_sr_plus as { rates: { SSR: number } }).rates.SSR / PPM_TOTAL;
    expect(Math.abs(ssr / n - expected)).toBeLessThan(0.02);
  });
  it('a refunded starter pack whose ticket was used leaves item debt that blocks further ticket use', () => {
    const s = freshPlayer();
    addItems(s, [{ itemId: 'ticket_sr_plus', qty: 1 }, { itemId: 'gacha_ticket', qty: 1 }]);
    useTicket(m, s, 'ticket_sr_plus', null, seededRng(1), NOW, 'k');
    clawbackItems(s, [{ itemId: 'ticket_sr_plus', qty: 1 }]);
    expect(s.itemDebt).toEqual({ ticket_sr_plus: 1 });
    expect(code(() => useTicket(m, s, 'gacha_ticket', 'standard', seededRng(1), NOW, 'k2'))).toBe('UNSETTLED_DEBT');
  });
});

describe('breeding material (REQ-ITEM-003)', () => {
  const setup = () => {
    const s = freshPlayer();
    const sire = createHorseFromTemplate(s, tpl('t_akatsuki'), NOW);
    const dam = createHorseFromTemplate(s, tpl('t_tsukikage'), NOW);
    retire(s, sire.id);
    retire(s, dam.id);
    return { s, sire, dam };
  };
  it('buys at most extraPerDay extra breedings once the normal ones are used; never consumes otherwise', () => {
    const { s, sire, dam } = setup();
    addItems(s, [{ itemId: 'breeding_material', qty: 5 }]);
    const r1 = breed(m, s, sire.id, dam.id, seededRng(3), NOW, { useMaterial: true });
    expect(r1.usedMaterial).toBe(false); // a normal slot was still free
    expect(s.items.breeding_material).toBe(5);
    expect(code(() => breed(m, s, sire.id, dam.id, seededRng(3), NOW))).toBe('BREEDING_DAILY_LIMIT');
    const r2 = breed(m, s, sire.id, dam.id, seededRng(3), NOW, { useMaterial: true });
    expect(r2.usedMaterial).toBe(true);
    expect(s.items.breeding_material).toBe(5 - m.items.breedingMaterial.cost);
    expect(code(() => breed(m, s, sire.id, dam.id, seededRng(3), NOW, { useMaterial: true }))).toBe('BREEDING_DAILY_LIMIT'); // extraPerDay = 1
    expect(breedingAllowance(m, s, NOW)).toMatchObject({ used: 1, perDay: 1, extraUsed: 1, extraPerDay: 1, materialOwned: 4 });
    // next JST day: allowance resets
    expect(breedingAllowance(m, s, NOW + 86_400_000)).toMatchObject({ used: 0, extraUsed: 0 });
  });
  it('without material the extra breeding is refused and nothing changes', () => {
    const { s, sire, dam } = setup();
    breed(m, s, sire.id, dam.id, seededRng(3), NOW);
    const horses = s.horses.length;
    expect(code(() => breed(m, s, sire.id, dam.id, seededRng(3), NOW, { useMaterial: true }))).toBe('INSUFFICIENT_ITEMS');
    expect(s.horses.length).toBe(horses);
  });
  it('a material-backed foal is drawn exactly like a normal one (no effect on stats → ranked fairness)', () => {
    const a = setup();
    const normal = breed(m, a.s, a.sire.id, a.dam.id, seededRng(77), NOW).foal;
    const b = setup();
    addItems(b.s, [{ itemId: 'breeding_material', qty: 1 }]);
    breed(m, b.s, b.sire.id, b.dam.id, seededRng(1), NOW); // use today's normal breeding
    const extra = breed(m, b.s, b.sire.id, b.dam.id, seededRng(77), NOW, { useMaterial: true });
    expect(extra.usedMaterial).toBe(true);
    for (const k of STAT_KEYS) expect(extra.foal.base[k]).toBe(normal.base[k]);
    expect(extra.foal.style).toBe(normal.style);
  });
});

describe('cosmetics shop and equipment (REQ-ITEM-004..007)', () => {
  it('sells each cosmetic once for coins, paid coins first; paid-only items refuse free coins', () => {
    const s = freshPlayer();
    grantFree(s, 2000, NOW, 'test', 't');
    const r = buyCosmetic(m, s, 'tack_bridle_classic', NOW, 'k1');
    expect(r.spent).toEqual({ paid: 0, free: 300 });
    expect(s.items.tack_bridle_classic).toBe(1);
    expect(code(() => buyCosmetic(m, s, 'tack_bridle_classic', NOW, 'k2'))).toBe('ALREADY_PURCHASED');
    expect(code(() => buyCosmetic(m, s, 'decor_golden_horseshoe', NOW, 'k3'))).toBe('INSUFFICIENT_COINS'); // paid only
    grantPaid(s, 1020, 1500, NOW, 'pack', 'tx1');
    const g = buyCosmetic(m, s, 'decor_golden_horseshoe', NOW, 'k4');
    expect(g.spent).toEqual({ paid: 1000, free: 0 });
    expect(code(() => buyCosmetic(m, s, 'nope', NOW, 'k5'))).toBe('NOT_FOUND');
    expect(s.itemLog?.filter((e) => e.reason === 'cosmetic purchase').map((e) => e.itemId)).toEqual(['tack_bridle_classic', 'decor_golden_horseshoe']);
  });
  it('equips owned tack per slot and decor into limited slots; validates ownership, slot and duplicates', () => {
    const s = freshPlayer();
    grantFree(s, 5000, NOW, 'test', 't');
    for (const id of ['tack_bridle_classic', 'tack_saddlecloth_navy', 'decor_stable_plaque', 'decor_flower_box', 'decor_trophy_shelf']) buyCosmetic(m, s, id, NOW, id);
    expect(setEquipment(m, s, { tack: { bridle: 'tack_bridle_classic', saddlecloth: 'tack_saddlecloth_navy' } }).tack).toEqual({ bridle: 'tack_bridle_classic', saddlecloth: 'tack_saddlecloth_navy' });
    expect(code(() => setEquipment(m, s, { tack: { bridle: 'tack_saddlecloth_navy' } }))).toBe('BAD_REQUEST'); // wrong slot
    expect(code(() => setEquipment(m, s, { tack: { bridle: 'tack_bridle_gold' } }))).toBe('NOT_ELIGIBLE'); // not owned
    expect(setEquipment(m, s, { decor: ['decor_stable_plaque', null, 'decor_flower_box'] }).decor).toEqual(['decor_stable_plaque', null, 'decor_flower_box']);
    expect(code(() => setEquipment(m, s, { decor: ['decor_stable_plaque', 'decor_stable_plaque'] }))).toBe('BAD_REQUEST');
    expect(code(() => setEquipment(m, s, { decor: ['decor_stable_plaque', 'decor_flower_box', 'decor_trophy_shelf', null] }))).toBe('BAD_REQUEST'); // 4 > 3 slots
    expect(code(() => setEquipment(m, s, { decor: ['tack_bridle_classic'] }))).toBe('BAD_REQUEST');
    expect(setEquipment(m, s, { tack: { bridle: null } }).tack).toEqual({ saddlecloth: 'tack_saddlecloth_navy' }); // unequip
    const cat = cosmeticsCatalog(m, s);
    expect(cat.items.find((i) => i.id === 'tack_saddlecloth_navy')).toMatchObject({ owned: true, equipped: true, slot: 'saddlecloth', asset: 'tack/saddlecloth_navy', icon: 'item/tack_saddlecloth_navy' });
    expect(cat.items.find((i) => i.id === 'tack_bridle_gold')).toMatchObject({ owned: false, equipped: false, currency: 'paidOnly' });
  });
  it('a bought silks pattern unlocks the pattern for setSilks', () => {
    const s = freshPlayer();
    const laurel = { pattern: 'laurel', colors: ['red', 'white', 'navy'], cap: 'plain' };
    expect(code(() => validateSilks(laurel, s.items))).toBe('NOT_ELIGIBLE');
    grantFree(s, 1000, NOW, 'test', 't');
    buyCosmetic(m, s, 'costume_silks_laurel', NOW, 'k');
    expect(validateSilks(laurel, s.items).pattern).toBe('laurel');
  });
});

describe('PlayerService items (idempotent, all-or-nothing)', () => {
  const svc = () => new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(5), clock: () => NOW, verifiers: { fake: new FakeStoreVerifier() } });
  it('a retried ticket use or cosmetic purchase with the same key does not charge twice', async () => {
    const p = svc();
    await p.adminGrant('u', { freeCoins: 1000, items: [{ itemId: 'gacha_ticket', qty: 2 }] }, 'test', 'ops', 'op1');
    const a = await p.useTicket('u', 'gacha_ticket', 'standard', 'c:/v1/items/tickets/gacha_ticket/use:k1');
    const b = await p.useTicket('u', 'gacha_ticket', 'standard', 'c:/v1/items/tickets/gacha_ticket/use:k1');
    expect(b).toEqual(a);
    expect((await p.view('u')).items.gacha_ticket).toBe(1);
    await p.buyCosmetic('u', 'decor_flower_box', 'c:/v1/shop/cosmetics/decor_flower_box/buy:k2');
    await p.buyCosmetic('u', 'decor_flower_box', 'c:/v1/shop/cosmetics/decor_flower_box/buy:k2');
    expect((await p.view('u')).wallet.free).toBe(800);
    const eq = await p.setEquipment('u', { decor: ['decor_flower_box'] });
    expect(eq.equipment.decor).toEqual(['decor_flower_box']);
    expect((await p.view('u')).equipment.decor).toEqual(['decor_flower_box']);
    expect((await p.publicProfile('u')).tack).toBeUndefined();
  });
  it('a failing use leaves state untouched', async () => {
    const p = svc();
    await expect(p.useTicket('u', 'gacha_ticket', 'standard', 'c:x:1')).rejects.toMatchObject({ code: 'INSUFFICIENT_ITEMS' });
    expect((await p.view('u')).pity).toEqual({});
  });
});

describe('HTTP routes (REQ-ITEM-*)', () => {
  const p = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(9), clock: () => NOW, verifiers: { fake: new FakeStoreVerifier() } });
  const invoker = { invoke: (async (method: string, ...args: unknown[]) => (p as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(p, args)) };
  const c = { master: m, authenticate: async (r: Request) => r.headers.get('x-test-user') ?? 'anon', player: () => invoker } as never;
  const call = async (method: string, path: string, body?: unknown, idem?: string) => {
    const res = await handle(new Request(`https://x${path}`, { method, headers: { 'content-type': 'application/json', 'x-test-user': 'u1', ...(idem ? { 'idempotency-key': idem } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), {}, c);
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  it('lists ticket disclosures, uses tickets, sells and equips cosmetics', async () => {
    const t = await call('GET', '/v1/items/tickets');
    expect((t.json.tickets as { itemId: string }[]).map((x) => x.itemId).sort()).toEqual(['gacha_ticket', 'gacha_ticket_10', 'ticket_sr_plus']);
    expect((await call('GET', '/v1/items/tickets/ticket_sr_plus/odds')).status).toBe(200);
    expect((await call('GET', '/v1/items/tickets/nope/odds')).status).toBe(404);
    await p.adminGrant('u1', { freeCoins: 1000, items: [{ itemId: 'ticket_sr_plus', qty: 1 }] }, 'test', 'ops', 'op1');
    expect((await call('POST', '/v1/items/tickets/ticket_sr_plus/use', {})).status).toBe(400); // idempotency key required
    const used = await call('POST', '/v1/items/tickets/ticket_sr_plus/use', {}, 'u-1');
    expect(used.status).toBe(200);
    expect((used.json.result as { rarity: string }).rarity).toMatch(/^SS?R$/);
    const cat = await call('GET', '/v1/shop/cosmetics');
    expect((cat.json.items as unknown[]).length).toBe(m.items.cosmetics.length);
    expect((await call('POST', '/v1/shop/cosmetics/tack_saddlecloth_crimson/buy', undefined, 'b-1')).status).toBe(200);
    const eq = await call('PUT', '/v1/player/equipment', { tack: { saddlecloth: 'tack_saddlecloth_crimson' } });
    expect(eq.json).toEqual({ equipment: { tack: { saddlecloth: 'tack_saddlecloth_crimson' }, decor: [] } });
    expect((await call('PUT', '/v1/player/equipment', { tack: { horn: 'x' } })).status).toBe(400); // strict body
    expect((await call('PUT', '/v1/player/equipment', { decor: ['tack_bridle_gold'] })).status).toBe(400);
  });
});
