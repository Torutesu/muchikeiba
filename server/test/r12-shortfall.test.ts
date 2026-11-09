// T6 コイン不足の案内 (contracts/protocol.md §29, REQ-SHORT-001..008): which coins are short, by how much, and the one
// smallest pack this player can buy now; on the INSUFFICIENT_COINS error and on GET /v1/shop/shortfall.
import { describe, expect, it } from 'vitest';
import { m, freshPlayer } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { coinShortfall, type CoinShortfall } from '../src/domain/shortfall.js';
import { firstPurchaseBonusOf } from '../src/domain/shop.js';
import { grantFree, grantPaid } from '../src/domain/wallet.js';
import { unwrap, wrap } from '../src/do/rpc.js';
import { handle, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { compileCatalog, EN_BANNED, translateText } from '../src/i18n/catalog.js';
import { CODE_EN } from '../src/i18n/en.js';
import type { Master, Product } from '../src/domain/master.js';

const JST = 9 * 3600_000;
const jst = (y: number, mo: number, d: number, h = 12) => Date.UTC(y, mo - 1, d, h) - JST;
const NOW = jst(2026, 11, 5);
const product = (id: string) => m.products.find((p) => p.id === id)!;

function world(master: Master = m) {
  let now = NOW;
  const store = new FakeStoreVerifier();
  const svc = new PlayerService(new MemoryPlayerRepo(), { master, rng: seededRng(7), clock: () => now, verifiers: { fake: store } });
  let tx = 0;
  const buy = async (id: string, productId: string) => {
    const p = master.products.find((x) => x.id === productId)!;
    await svc.purchaseIntent(id, productId);
    return svc.purchase(id, 'fake', productId, store.issue({ transactionId: `T${tx++}`, productId, purchasedAt: now, priceYen: p.priceYen }));
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
    const res = await handle(new Request(`https://x${path}`, { method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify(o.body ?? {}) }) }), {}, c);
    return { status: res.status, body: (await res.json()) as any };
  };
  return { svc, buy, call, at: (t: number) => { now = t; } };
}

const FORBIDDEN = ['倍', 'お得', '今だけ', '残りわずか', '通常価格', '限定', 'あと数'];
function texts(r: CoinShortfall): string[] {
  return [r.headline, r.line, ...r.notes, r.offer?.name, r.offer?.firstPurchaseBonus?.label, ...(r.offer?.contents.map((c) => c.label) ?? [])].filter((x): x is string => !!x);
}

describe('coinShortfall: the one pack (REQ-SHORT-001/002/003)', () => {
  it('any coins: the smallest pack whose paid coins cover the shortfall', () => {
    const s = freshPlayer();
    s.age = { birthYear: 1990, birthMonth: 1, guardianConsent: false, setAt: NOW };
    grantFree(s, 300, NOW, 'g', 'g');
    const r = coinShortfall(m, s, { coinKind: 'any', need: 1500 }, NOW);
    expect(r).toMatchObject({ short: true, coinKind: 'any', need: 1500, have: 300, shortfall: 1200, status: 'covered', headline: 'コインが1,200枚足りません', blockedCode: null, ageCheck: false });
    expect(r.offer).toMatchObject({ offerId: 'shortfall', touchpoint: 'T6', productId: 'coin_2400', paidCoins: 1660, priceYen: 2400, covers: true, oneTime: false });
    expect(r.line).toBe('コイン1,660（¥2,400）で足ります');
    // the first-purchase bonus exactly as the shop states it, only while this pack still has it
    expect(r.offer!.firstPurchaseBonus).toEqual(firstPurchaseBonusOf(m, product('coin_2400')));
    s.firstPurchased.push('coin_2400');
    expect(coinShortfall(m, s, { coinKind: 'any', need: 1500 }, NOW).offer!.firstPurchaseBonus).toBeNull();
  });

  it('a price tie goes to the plain coin pack, not the once-only bundle; the bonus never counts toward covering', () => {
    const s = freshPlayer();
    // shortfall 250: coin_480 (310) and starter_pack (300) are both ¥480 → the coin pack
    expect(coinShortfall(m, s, { coinKind: 'any', need: 250 }, NOW).offer!.productId).toBe('coin_480');
    // shortfall 101: coin_160 has 100 paid coins (+100 free first-purchase bonus) — the bonus is not counted
    expect(coinShortfall(m, s, { coinKind: 'any', need: 101 }, NOW).offer!.productId).toBe('coin_480');
    expect(coinShortfall(m, s, { coinKind: 'any', need: 100 }, NOW).offer!.productId).toBe('coin_160');
  });

  it('paid-only spends count paid coins only; free coins do not help', () => {
    const s = freshPlayer();
    grantFree(s, 5000, NOW, 'g', 'g');
    grantPaid(s, 200, 320, NOW, 'p', 'tx');
    const r = coinShortfall(m, s, { coinKind: 'paid', need: 1000 }, NOW);
    expect(r).toMatchObject({ have: 200, shortfall: 800, headline: '有償コインが800枚足りません', status: 'covered' });
    expect(r.notes).toContain('有償コインだけで支払います（無償コインは使えません）');
    expect(r.offer!.productId).toBe('coin_1500');
  });

  it('free-only payments never get a purchase suggestion', () => {
    const s = freshPlayer();
    grantPaid(s, 5000, 8000, NOW, 'p', 'tx');
    const r = coinShortfall(m, s, { coinKind: 'free', need: 300 }, NOW);
    expect(r).toMatchObject({ status: 'free_only', offer: null, shortfall: 300, headline: '無償コインが300枚足りません' });
  });

  it('enough coins: not short, nothing offered', () => {
    const s = freshPlayer();
    grantFree(s, 1000, NOW, 'g', 'g');
    expect(coinShortfall(m, s, { coinKind: 'any', need: 1000 }, NOW)).toMatchObject({ short: false, status: 'not_short', shortfall: 0, offer: null, headline: null, line: null });
  });

  it('minors: only packs within this month\'s limit; none covers → the largest buyable one, said plainly', () => {
    const s = freshPlayer();
    s.age = { birthYear: 2013, birthMonth: 1, guardianConsent: true, setAt: NOW }; // 13: ¥5,000 a month
    s.monthlySpendYen['2026-11'] = 4000;
    const r = coinShortfall(m, s, { coinKind: 'any', need: 1200 }, NOW);
    expect(r).toMatchObject({ status: 'largest_only', shortfall: 1200 });
    expect(r.offer).toMatchObject({ productId: 'coin_800', covers: false, paidCoins: 530 });
    expect(r.line).toBe('いちばん大きいコイン530（¥800）でも、あと670枚足りません');
    s.monthlySpendYen['2026-11'] = 5000;
    expect(coinShortfall(m, s, { coinKind: 'any', need: 50 }, NOW)).toMatchObject({ status: 'none_buyable', offer: null, blockedCode: 'AGE_LIMIT_EXCEEDED' });
  });

  it('a purchase over the limit this month blocks every pack; unsettled refunds and a scheduled deletion too', () => {
    const s = freshPlayer();
    s.age = { birthYear: 1990, birthMonth: 1, guardianConsent: false, setAt: NOW };
    s.purchases.push({ txId: 'x', productId: 'coin_160', platform: 'fake', at: NOW, priceYen: 160, paidCoins: 100, limitBreach: true, month: '2026-11' } as never);
    expect(coinShortfall(m, s, { coinKind: 'any', need: 50 }, NOW)).toMatchObject({ status: 'none_buyable', blockedCode: 'AGE_LIMIT_EXCEEDED', line: '今月の購入上限に達しているため、いま購入できるパックはありません' });
    const d = freshPlayer();
    d.wallet.debt = 10;
    expect(coinShortfall(m, d, { coinKind: 'any', need: 50 }, NOW)).toMatchObject({ status: 'none_buyable', blockedCode: 'UNSETTLED_DEBT' });
    const del = freshPlayer();
    del.deletion = { status: 'scheduled', requestedAt: NOW, deleteAt: NOW + 14 * 86_400_000 } as never;
    expect(coinShortfall(m, del, { coinKind: 'any', need: 50 }, NOW)).toMatchObject({ status: 'none_buyable', blockedCode: 'DELETION_PENDING' });
  });

  it('age not registered: limits are left to the purchase confirmation (ageCheck)', () => {
    const r = coinShortfall(m, freshPlayer(), { coinKind: 'any', need: 7000 }, NOW);
    expect(r).toMatchObject({ ageCheck: true, status: 'covered' });
    expect(r.offer!.productId).toBe('coin_10000');
    expect(r.notes).toContain('購入の前に、生年月を確認します');
  });

  it('once-only bundles already bought and promotion packs of a class not reached are left out', () => {
    const bundle: Product = { id: 'bundle_x', kind: 'starter', name: 'テストパック', storeType: 'non_consumable', priceYen: 300, paidCoins: 500, once: true };
    const promo: Product = { id: 'promo_x', kind: 'promotion', name: '昇級記念パック（S級）', storeType: 'non_consumable', priceYen: 200, paidCoins: 2000, once: true, classId: 'S' };
    const mm = { ...m, products: [...m.products, bundle, promo] } as Master;
    const s = freshPlayer();
    expect(coinShortfall(mm, s, { coinKind: 'any', need: 400 }, NOW).offer).toMatchObject({ productId: 'bundle_x', oneTime: true, firstPurchaseBonus: null });
    s.purchases.push({ txId: 'b', productId: 'bundle_x', platform: 'fake', at: NOW, priceYen: 300, paidCoins: 500 } as never);
    expect(coinShortfall(mm, s, { coinKind: 'any', need: 400 }, NOW).offer!.productId).toBe('coin_800');
    // the season pass and the daily pack are not coin products
    for (const need of [1, 99, 100, 310, 7400, 9000]) expect(['season_pass', 'season_pass_plus', 'stable_allowance_30d']).not.toContain(coinShortfall(m, s, { coinKind: 'any', need }, NOW).offer?.productId);
  });

  it('wording: no multipliers, deals or urgency; every text has English and the English passes the legal lint', () => {
    const cat = compileCatalog(m.locale?.en, CODE_EN);
    const minor = freshPlayer();
    minor.age = { birthYear: 2013, birthMonth: 1, guardianConsent: true, setAt: NOW };
    minor.monthlySpendYen['2026-11'] = 4000;
    const cases = [
      coinShortfall(m, freshPlayer(), { coinKind: 'any', need: 1200 }, NOW),
      coinShortfall(m, freshPlayer(), { coinKind: 'paid', need: 900 }, NOW),
      coinShortfall(m, freshPlayer(), { coinKind: 'free', need: 30 }, NOW),
      coinShortfall(m, minor, { coinKind: 'any', need: 1200 }, NOW),
      coinShortfall(m, freshPlayer(), { coinKind: 'any', need: 20000 }, NOW),
    ];
    for (const r of cases) for (const t of texts(r)) {
      for (const w of FORBIDDEN) expect(t).not.toContain(w);
      const en = translateText(t, cat);
      expect(en, t).toBeTruthy();
      for (const re of EN_BANNED) expect(en).not.toMatch(re);
    }
  });
});

describe('INSUFFICIENT_COINS carries details.shortfall (REQ-SHORT-004)', () => {
  it('a gacha pull: 409 with the shortfall; nothing is written; the same key works once coins arrive', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await w.svc.adminGrant('p', { freeCoins: 300 }, 'test', 'op', 'g1');
    const r = await w.call('POST', '/v1/gacha/standard/draw', 'p', { key: 'k1', body: { count: 10 } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('INSUFFICIENT_COINS');
    expect(r.body.error.details.shortfall).toMatchObject({ coinKind: 'any', need: 1000, have: 300, shortfall: 700, status: 'covered', offer: { productId: 'coin_1500', offerId: 'shortfall' } });
    expect((await w.svc.view('p')).wallet.free).toBe(300);
    await w.svc.adminGrant('p', { freeCoins: 700 }, 'test', 'op', 'g2');
    const ok = await w.call('POST', '/v1/gacha/standard/draw', 'p', { key: 'k1', body: { count: 10 } });
    expect(ok.status).toBe(200);
    expect(ok.body.results).toHaveLength(10);
  });

  it('the paid step-up: paid coins only, free coins are not counted', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await w.svc.adminGrant('p', { freeCoins: 5000 }, 'test', 'op', 'g1');
    const r = await w.call('POST', '/v1/gacha/stepup_paid/draw', 'p', { key: 'k', body: { count: 10 } });
    expect(r.status).toBe(409);
    expect(r.body.error.details.shortfall).toMatchObject({ coinKind: 'paid', need: 500, have: 0, shortfall: 500, headline: '有償コインが500枚足りません', offer: { productId: 'coin_800' } });
  });

  it('a paid-only cosmetic; and in English the texts come back translated', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    const r = await w.call('POST', '/v1/shop/cosmetics/tack_bridle_gold/buy', 'p', { key: 'c1', lang: 'en' });
    expect(r.status).toBe(409);
    const sf = r.body.error.details.shortfall;
    expect(sf).toMatchObject({ coinKind: 'paid', need: 800, shortfall: 800, headline: 'You need 800 more paid coins', offer: { productId: 'coin_1500' } });
    expect(sf.line).toBe('1,020 Coins (¥1,500) covers it');
    expect(JSON.stringify(r.body)).not.toMatch(/[぀-ヿ一-鿿]/);
  });

  it('other errors keep their shape (no details)', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    const r = await w.call('POST', '/v1/gacha/nope/draw', 'p', { key: 'z', body: { count: 10 } });
    expect(r.status).toBe(404);
    expect(r.body.error).not.toHaveProperty('details');
  });

  it('the Durable Object envelope keeps details across RPC', async () => {
    const env = await wrap(() => { throw new AppError('INSUFFICIENT_COINS', 'x', undefined, { coinKind: 'any', need: 1, have: 0 }); });
    expect(env).toMatchObject({ ok: false, details: { coinKind: 'any' } });
    try { unwrap(env); } catch (e) { expect((e as AppError).details).toEqual({ coinKind: 'any', need: 1, have: 0 }); }
    expect(await wrap(() => { throw new AppError('NOT_FOUND'); })).not.toHaveProperty('details');
  });
});

describe('GET /v1/shop/shortfall (REQ-SHORT-005)', () => {
  it('gacha (the step-up\'s current step price), cosmetic, amount; same answer as the failed spend', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await w.svc.adminGrant('p', { freeCoins: 300 }, 'test', 'op', 'g1');
    const pre = await w.call('GET', '/v1/shop/shortfall?for=gacha&bannerId=standard&count=10', 'p');
    expect(pre.status).toBe(200);
    const fail = await w.call('POST', '/v1/gacha/standard/draw', 'p', { key: 'k', body: { count: 10 } });
    expect(pre.body).toEqual(fail.body.error.details.shortfall);
    expect((await w.call('GET', '/v1/shop/shortfall?for=gacha&bannerId=standard&count=1', 'p')).body).toMatchObject({ short: false, status: 'not_short' });
    // step 1 of the paid step-up costs 500 paid coins (count is always 10 there)
    expect((await w.call('GET', '/v1/shop/shortfall?for=gacha&bannerId=stepup_paid&count=1', 'p')).body).toMatchObject({ coinKind: 'paid', need: 500 });
    expect((await w.call('GET', '/v1/shop/shortfall?for=cosmetic&itemId=decor_golden_horseshoe', 'p')).body).toMatchObject({ coinKind: 'paid', need: 1000, shortfall: 1000 });
    expect((await w.call('GET', '/v1/shop/shortfall?for=coins&coins=1500&kind=any', 'p')).body).toMatchObject({ coinKind: 'any', shortfall: 1200, offer: { productId: 'coin_2400' } });
  });

  it('bad queries are 400, unknown ids 404, not-for-sale / owned cosmetics refused', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    for (const q of ['', 'for=x', 'for=coins&coins=0', 'for=coins&coins=abc', 'for=coins&coins=5&kind=free', 'for=gacha&bannerId=standard&count=5', 'for=gacha&bannerId=standard&extra=1'])
      expect((await w.call('GET', `/v1/shop/shortfall?${q}`, 'p')).status, q).toBe(400);
    expect((await w.call('GET', '/v1/shop/shortfall?for=gacha&bannerId=nope', 'p')).status).toBe(404);
    // a banner that is not open answers as its pull would (BANNER_CLOSED), not with a price
    w.at(m.gacha.banners.find((b) => b.id === 'winter_2026')!.endAtMs! + 1);
    expect((await w.call('GET', '/v1/shop/shortfall?for=gacha&bannerId=winter_2026', 'p')).body.error.code).toBe('BANNER_CLOSED');
    w.at(NOW);
    expect((await w.call('GET', '/v1/shop/shortfall?for=cosmetic&itemId=tack_bridle_pass_plus', 'p')).body.error.code).toBe('NOT_ELIGIBLE');
    await w.svc.adminGrant('p', { freeCoins: 300 }, 'test', 'op', 'g1');
    await w.svc.buyCosmetic('p', 'tack_bridle_classic', 'c:b1');
    expect((await w.call('GET', '/v1/shop/shortfall?for=cosmetic&itemId=tack_bridle_classic', 'p')).body.error.code).toBe('ALREADY_PURCHASED');
  });

  it('a bought once-only pack is never offered again; a read writes nothing', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await w.svc.setAge('p', 1990, 1, false);
    await w.buy('p', 'coin_160'); // first-purchase bonus used for this pack
    const v0 = await w.svc.view('p');
    const r = await w.call('GET', '/v1/shop/shortfall?for=coins&coins=' + (v0.wallet.paid + v0.wallet.free + 50), 'p');
    expect(r.body.offer).toMatchObject({ productId: 'coin_160', firstPurchaseBonus: null });
    expect(await w.svc.view('p')).toEqual(v0);
  });
});
