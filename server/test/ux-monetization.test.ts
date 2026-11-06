import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { productsProblems, shopProducts } from '../src/domain/shop.js';
import { collectItemIds } from '../src/domain/visuals.js';
import { studHeldFree } from '../src/domain/stud.js';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { GooglePlayApi, GoogleStoreVerifier, type ProductPurchase } from '../src/stores/google.js';
import { storeSettingsFromEnv } from '../src/http/stores.js';
import type { Env } from '../src/env.js';
import type { Master } from '../src/domain/master.js';

const JST = 9 * 3600_000;
const DAY = 86_400_000;
/** JST wall clock → ms. */
const jst = (y: number, mo: number, d: number, h = 12) => Date.UTC(y, mo - 1, d, h) - JST;
const NOV_END = jst(2026, 12, 1, 0);

function world(start = jst(2026, 11, 5), master: Master = m) {
  let now = start;
  const store = new FakeStoreVerifier();
  const svc = new PlayerService(new MemoryPlayerRepo(), { master, rng: seededRng(7), clock: () => now, verifiers: { fake: store } });
  let n = 0;
  const k = () => `c:t:${n++}`;
  let tx = 0;
  const buy = async (id: string, productId: string, opts: { intent?: boolean } = {}) => {
    const p = master.products.find((x) => x.id === productId)!;
    if (opts.intent !== false) await svc.purchaseIntent(id, productId);
    const t = `T${tx++}`;
    const r = await svc.purchase(id, 'fake', productId, store.issue({ transactionId: t, productId, purchasedAt: now, priceYen: p.priceYen }));
    return { ...r, txId: t };
  };
  let race = 0;
  const ranked = (id: string, place: number, mode: 'ranked' | 'friend' = 'ranked') =>
    svc.applyRace(id, { raceId: `r${race++}`, mode, place, fieldSize: 12, newRating: null, void: false, humans: 2 });
  return { svc, store, k, buy, ranked, at: (t: number) => { now = t; }, now: () => now };
}
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as AppError).code; } return 'NO_ERROR'; };
const adult = async (w: ReturnType<typeof world>, id = 'p') => { await w.svc.bootstrap(id); await w.svc.setAge(id, 1990, 1, false); };

describe('REQ-UXS-022 product display data (/v1/shop/products)', () => {
  const view = shopProducts(m);
  it('price ladder of spec 06 §5.2 (JPY incl. tax)', () => {
    const price = Object.fromEntries(view.products.map((p) => [p.id, p.priceYen]));
    expect(price).toEqual({
      coin_160: 160, coin_480: 480, coin_800: 800, coin_1500: 1500, coin_2400: 2400, coin_3800: 3800, coin_5000: 5000, coin_10000: 10000,
      starter_pack: 480, stable_allowance_30d: 480, season_pass: 1000, season_pass_plus: 2400, promo_pack_B: 1500, promo_pack_A: 1500, promo_pack_S: 1500,
    });
    const paid = Object.fromEntries(view.products.map((p) => [p.id, p.paidCoins]));
    expect(paid).toMatchObject({ coin_160: 100, coin_480: 310, coin_800: 530, coin_1500: 1020, coin_2400: 1660, coin_3800: 2680, coin_5000: 3600, coin_10000: 7400, starter_pack: 300, stable_allowance_30d: 100, season_pass: 0, promo_pack_B: 1020 });
  });
  it('states contents with quantities; the first-purchase bonus is free coins, never "2倍"', () => {
    const json = JSON.stringify(view);
    expect(json).not.toMatch(/倍/);
    for (const p of view.products) {
      expect(p.contents.length).toBeGreaterThan(0);
      expect(p.autoRenew).toBe(false);
      for (const c of p.contents) expect(c.label).not.toMatch(/undefined|NaN/);
      if (p.kind === 'coins') {
        expect(p.firstPurchaseBonus).toEqual({ coins: p.paidCoins, currency: 'free', label: expect.stringContaining(`無償コイン${p.paidCoins.toLocaleString('en-US')}枚`) });
      } else expect(p.firstPurchaseBonus).toBeNull();
      for (const key of p.noticeKeys) expect(view.notices[key], key).toBeTruthy();
      expect(p.noticeKeys).toEqual(expect.arrayContaining(['legal.tokushoho', 'legal.shikin_kessai', 'shop.paid_first']));
    }
    const byId = Object.fromEntries(view.products.map((p) => [p.id, p]));
    expect(byId.starter_pack!.oneTime).toBe(true);
    expect(byId.starter_pack!.contents.map((c) => c.label)).toEqual(['有償コイン300枚', 'SR以上確定スカウト券×1', '限定勝負服の柄「稲妻」×1']);
    expect(byId.stable_allowance_30d!.contents[1]).toMatchObject({ type: 'daily_free_coins', qty: 30, days: 30, total: 900 });
    expect(byId.stable_allowance_30d!.period).toEqual({ kind: 'days', days: 30 });
    expect(byId.season_pass!.period).toEqual({ kind: 'season' });
    expect(byId.season_pass!.noticeKeys).toEqual(expect.arrayContaining(['shop.no_auto_renew', 'shop.pass_season_only', 'shop.pass_auto_grant']));
    expect(byId.season_pass_plus!.contents.map((c) => c.type)).toEqual(['pass_premium', 'pass_levels', 'item', 'item']);
    expect(byId.promo_pack_A!.oneTimeScope).toBe('class');
    expect(view.legalLinks.map((l) => l.key)).toEqual(['legal.tokushoho', 'legal.shikin_kessai', 'shop.paid_first']);
  });
  it('master/products.json is consistent (SKU ids, store types, once-only = non-consumable, classes, items)', () => {
    expect(productsProblems(m, new Set(collectItemIds(m)))).toEqual([]);
    const bad = { ...m, products: [...m.products, { id: 'promo_pack_C', kind: 'promotion' as const, name: 'x', priceYen: 1, paidCoins: 0, classId: 'C', storeType: 'consumable' as const }] };
    expect(productsProblems(bad, new Set(collectItemIds(m)))).toEqual(expect.arrayContaining(['promo_pack_C: the first class is never reached by promotion', 'promo_pack_C: a promotion pack is once-only']));
  });
  it('every product item has a display label; no product is an auto-renewing subscription', () => {
    for (const p of m.products) {
      expect(p.storeType).toMatch(/^(consumable|non_consumable)$/);
      for (const it of p.items ?? []) expect(m.shopDisplay!.itemLabels[it.itemId], it.itemId).toBeTruthy();
      if (p.once) expect(p.storeType).toBe('non_consumable');
    }
  });
});

describe('REQ-UXS-017 offers (/v1/shop/offers)', () => {
  it('T2 starter: hidden until the first ranked 4th-or-worse, shown once, kept in the shop until bought', async () => {
    const w = world();
    await adult(w);
    expect((await w.svc.shopOffers('p')).offers.find((o) => o.productId === 'starter_pack')).toBeUndefined();
    await w.ranked('p', 2);
    expect((await w.svc.shopOffers('p')).offers.find((o) => o.productId === 'starter_pack')).toBeUndefined();
    await w.ranked('p', 4);
    const o = (await w.svc.shopOffers('p')).offers.find((x) => x.productId === 'starter_pack')!;
    expect(o).toMatchObject({ id: 'starter_pack', touchpoint: 'T2', placement: 'popup', reason: 'first_4th_or_worse', showPopup: true, viewedAt: null, endsAt: null });
    const v = await w.svc.markOfferViewed('p', 'starter_pack');
    expect(v.viewedAt).toBe(w.now());
    expect((await w.svc.markOfferViewed('p', 'starter_pack')).viewedAt).toBe(v.viewedAt); // first view kept
    const after = (await w.svc.shopOffers('p')).offers.find((x) => x.productId === 'starter_pack')!;
    expect(after).toMatchObject({ showPopup: false, viewedAt: v.viewedAt });
    await w.buy('p', 'starter_pack');
    expect((await w.svc.shopOffers('p')).offers.find((x) => x.productId === 'starter_pack')).toBeUndefined();
    expect(await code(w.svc.markOfferViewed('p', 'starter_pack'))).toBe('NOT_FOUND');
  });
  it('T2 starter: or after the 5th ranked race, whichever comes first', async () => {
    const w = world();
    await adult(w);
    for (let i = 0; i < 4; i++) await w.ranked('p', 1 + (i % 3));
    expect((await w.svc.shopOffers('p')).offers.some((x) => x.productId === 'starter_pack')).toBe(false);
    await w.ranked('p', 1);
    expect((await w.svc.shopOffers('p')).offers.find((x) => x.productId === 'starter_pack')).toMatchObject({ reason: 'race5', showPopup: true });
  });
  it('T3 season pass: after 3 ranked races, once per season, real season end; not returned once bought', async () => {
    const w = world(jst(2026, 11, 28));
    await adult(w);
    for (let i = 0; i < 2; i++) await w.ranked('p', 1);
    expect((await w.svc.shopOffers('p')).offers.some((o) => o.touchpoint === 'T3')).toBe(false);
    await w.ranked('p', 1);
    const t3 = (await w.svc.shopOffers('p')).offers.filter((o) => o.touchpoint === 'T3');
    expect(t3.map((o) => [o.id, o.productId, o.showPopup])).toEqual([['season_pass_2026_11', 'season_pass', true], ['season_pass_2026_11_plus', 'season_pass_plus', false]]);
    expect(t3[0]).toMatchObject({ endsAt: NOV_END, remainingDays: 3, reason: 'pass_unlock' }); // 2.5 days left, rounded up
    await w.svc.markOfferViewed('p', 'season_pass_2026_11');
    expect((await w.svc.shopOffers('p')).offers.find((o) => o.id === 'season_pass_2026_11')!.showPopup).toBe(false);
    // a new season: a new one-time sheet
    w.at(jst(2026, 12, 2));
    const dec = (await w.svc.shopOffers('p')).offers.find((o) => o.productId === 'season_pass')!;
    expect(dec).toMatchObject({ id: 'season_pass_2026_12', showPopup: true, reason: 'season_start' });
    await w.buy('p', 'season_pass');
    expect((await w.svc.shopOffers('p')).offers.some((o) => o.touchpoint === 'T3')).toBe(false);
  });
  it('T4 promotion pack after reaching the class; first purchase (T1) and the daily pack', async () => {
    const w = world(jst(2026, 11, 20));
    await adult(w);
    let o = await w.svc.shopOffers('p');
    expect(o.offers.some((x) => x.touchpoint === 'T4')).toBe(false);
    expect(o.firstPurchase.available).toBe(true);
    expect(o.firstPurchase.productIds).toHaveLength(8);
    expect(o.offers.find((x) => x.productId === 'stable_allowance_30d')).toMatchObject({ touchpoint: 'shop', placement: 'recommended', showPopup: false });
    expect(await code(w.svc.purchaseIntent('p', 'promo_pack_B'))).toBe('NOT_ELIGIBLE');
    for (let i = 0; i < 10; i++) await w.ranked('p', 1); // 300 pts → promoted to B at the season close
    w.at(jst(2026, 12, 1, 9));
    o = await w.svc.shopOffers('p');
    expect(o.offers.filter((x) => x.touchpoint === 'T4').map((x) => [x.id, x.showPopup])).toEqual([['promo_pack_B', true]]);
    await w.svc.purchaseIntent('p', 'promo_pack_B');
    expect(await code(w.svc.purchaseIntent('p', 'promo_pack_A'))).toBe('NOT_ELIGIBLE');
    const r = await w.buy('p', 'promo_pack_B');
    expect(r.wallet.paid).toBe(1020);
    expect(r.wallet.free).toBeGreaterThan(0); // race coins; no first-purchase bonus on a pack
    expect(r.record.bonusCoinsGranted).toBe(0);
    expect((await w.svc.state('p')).items.costume_promo_b).toBe(1);
    expect(await code(w.svc.purchaseIntent('p', 'promo_pack_B'))).toBe('ALREADY_PURCHASED');
    await w.buy('p', 'coin_160');
    o = await w.svc.shopOffers('p');
    expect(o.firstPurchase.productIds).not.toContain('coin_160');
    expect(o.offers.some((x) => x.touchpoint === 'T4')).toBe(false);
  });
});

describe('REQ-UXS-020 season pass per season, no auto-renew', () => {
  it('ends at the season end; the purchase confirmation gets the remaining days in the last 7 days', async () => {
    const w = world(jst(2026, 11, 10));
    await adult(w);
    let intent = await w.svc.purchaseIntent('p', 'season_pass');
    expect(intent.pass).toMatchObject({ seasonId: '2026-11', endsAt: NOV_END, remainingDays: 21, lastWeek: false, autoRenew: false });
    w.at(jst(2026, 11, 25, 10));
    intent = await w.svc.purchaseIntent('p', 'season_pass');
    expect(intent.pass).toMatchObject({ remainingDays: 6, lastWeek: true });
    await w.buy('p', 'season_pass', { intent: false });
    const pv = await w.svc.passView('p');
    expect(pv).toMatchObject({ seasonId: '2026-11', active: true, expiresAt: NOV_END, seasonEndsAt: NOV_END, remainingDays: 6, lastWeek: true, autoRenew: false, owned: ['season_pass'], purchasable: [] });
    expect(await code(w.svc.purchaseIntent('p', 'season_pass_plus'))).toBe('ALREADY_PURCHASED');
    // next season: not active, no renewal; can be bought again
    w.at(jst(2026, 12, 1, 0) + 60_000);
    const dec = await w.svc.passView('p');
    expect(dec).toMatchObject({ seasonId: '2026-12', active: false, owned: [], purchasable: ['season_pass', 'season_pass_plus'] });
    await w.svc.purchaseIntent('p', 'season_pass');
  });
  it('a purchase delivered after its season ended covers the new season', async () => {
    const w = world(jst(2026, 11, 30, 23));
    await adult(w);
    w.at(jst(2026, 12, 1, 0) + 5 * 60_000);
    const r = await w.buy('p', 'season_pass', { intent: false });
    expect(r.record.passSeasonId).toBe('2026-12');
    expect(r.record.passUntil).toBe(jst(2027, 1, 1, 0));
  });
});

describe('REQ-UXS-021 unclaimed pass rewards are granted at the season close', () => {
  it('free and premium levels reached but not claimed; idempotent via the rollover closeSeason', async () => {
    const w = world(jst(2026, 11, 20));
    await adult(w);
    await w.buy('p', 'season_pass');
    for (let i = 0; i < 25; i++) await w.ranked('p', 12); // 25 × 20 xp = level 5
    await w.svc.claimPass('p', 'free', 1, w.k());
    await w.svc.claimPass('p', 'premium', 1, w.k());
    const before = (await w.svc.state('p')).wallet.free;
    w.at(jst(2026, 12, 1, 0) + 5 * 60_000);
    const close = await w.svc.closeSeason('p', '2026-11', 50);
    expect(close.pass).toMatchObject({ seasonId: '2026-11', level: 5, premium: true, autoGranted: { free: [2, 3, 4, 5], premium: [2, 3, 4, 5] } });
    const free = m.progression.passRewards.free.reward.freeCoins!;
    const prem = m.progression.passRewards.premium.reward.freeCoins!;
    const s = await w.svc.state('p');
    expect(s.wallet.free - before).toBe(4 * free + 4 * prem + (close.reward?.freeCoins ?? 0));
    expect(s.ledger.filter((l) => l.ref.startsWith('passclose:2026-11:'))).toHaveLength(8);
    // the job retries (dead-letter retry, overlapping cron): nothing is paid twice
    const again = await w.svc.closeSeason('p', '2026-11', 50);
    expect(again.status).toBe('already');
    expect((await w.svc.state('p')).wallet.free).toBe(s.wallet.free);
    const pv = await w.svc.passView('p');
    expect(pv).toMatchObject({ seasonId: '2026-12', level: 0, claimed: { free: [], premium: [] }, lastSeason: { seasonId: '2026-11' } });
  });
  it('without a pass only the free track; the player\'s own next request closes it if the job has not', async () => {
    const w = world(jst(2026, 11, 20));
    await adult(w);
    for (let i = 0; i < 10; i++) await w.ranked('p', 12); // 10 × 20 xp = level 2
    w.at(jst(2026, 12, 3));
    const pv = await w.svc.passView('p'); // any transaction rolls the season first
    expect(pv.lastSeason).toMatchObject({ seasonId: '2026-11', level: 2, premium: false, autoGranted: { free: [1, 2], premium: [] } });
    const s = await w.svc.state('p');
    expect(s.ledger.filter((l) => l.ref.startsWith('passclose:2026-11:premium'))).toHaveLength(0);
  });
});

describe('REQ-UXS-010 daily first-3-wins bonus', () => {
  it('30 / 20 / 10 free coins for the first three ranked wins of the JST day; friend races and void races do not count', async () => {
    const w = world(jst(2026, 11, 5, 10));
    await adult(w);
    const fw = m.progression.firstWinBonus!;
    expect(fw).toEqual({ modes: ['ranked'], freeCoinsByWin: [30, 20, 10], _note: expect.any(String) } as unknown as typeof fw);
    const got: number[] = [];
    for (let i = 0; i < 4; i++) got.push(((await w.ranked('p', 1)) as { firstWinBonus: number }).firstWinBonus);
    expect(got).toEqual([30, 20, 10, 0]);
    expect(((await w.ranked('p', 1, 'friend')) as { firstWinBonus: number }).firstWinBonus).toBe(0);
    expect(await w.svc.firstWinBonus('p')).toMatchObject({ winsToday: 3, remaining: 0, next: null });
    w.at(jst(2026, 11, 6, 0) + 60_000); // JST midnight resets
    expect(await w.svc.firstWinBonus('p')).toMatchObject({ winsToday: 0, remaining: 3, next: 30 });
    expect(((await w.ranked('p', 2)) as { firstWinBonus: number }).firstWinBonus).toBe(0);
    const v = await w.svc.applyRace('p', { raceId: 'void1', mode: 'ranked', place: 1, fieldSize: 12, newRating: null, void: true });
    expect((v as { firstWinBonus: number }).firstWinBonus).toBe(0);
    expect(((await w.ranked('p', 1)) as { firstWinBonus: number }).firstWinBonus).toBe(30);
  });
});

describe('REQ-UXS-018 厩舎手当 (30-day daily-coin pack)', () => {
  it('paid 100 at purchase, 30 free a day for 30 JST days, claimed daily, no stacking, rebuy after it ends', async () => {
    const w = world(jst(2026, 11, 5, 20));
    await adult(w);
    const intent = await w.svc.purchaseIntent('p', 'stable_allowance_30d');
    expect(intent.allowance).toEqual({ days: 30, dailyFreeCoins: 30, autoRenew: false });
    const r = await w.buy('p', 'stable_allowance_30d');
    expect(r.wallet).toMatchObject({ paid: 100, free: 0 });
    expect(r.record.bonusCoinsGranted).toBe(0);
    expect(await w.svc.allowance('p')).toMatchObject({ active: true, startDate: '2026-11-05', endDate: '2026-12-04', day: 1, daysLeft: 30, claimedToday: false });
    const c1 = await w.svc.claimAllowance('p', w.k());
    expect(c1).toMatchObject({ freeCoins: 30, claimedToday: true, claimedDays: 1, wallet: { free: 30 } });
    expect(await code(w.svc.claimAllowance('p', w.k()))).toBe('ALREADY_CLAIMED');
    expect(await code(w.svc.purchaseIntent('p', 'stable_allowance_30d'))).toBe('ALREADY_PURCHASED');
    w.at(jst(2026, 11, 6, 0) + 60_000);
    expect((await w.svc.claimAllowance('p', w.k())).day).toBe(2);
    w.at(jst(2026, 12, 4, 23)); // day 30
    expect(await w.svc.allowance('p')).toMatchObject({ day: 30, daysLeft: 1 });
    await w.svc.claimAllowance('p', w.k());
    w.at(jst(2026, 12, 5, 9)); // ended; missed days are not paid later
    expect(await w.svc.allowance('p')).toMatchObject({ active: false });
    expect(await code(w.svc.claimAllowance('p', w.k()))).toBe('NOT_ELIGIBLE');
    expect((await w.svc.state('p')).wallet.free).toBe(90);
    await w.svc.purchaseIntent('p', 'stable_allowance_30d');
  });
  it('refund: the paid coins and every claimed daily coin are taken back (debt if spent); claims stop; stud hold covers them', async () => {
    const w = world(jst(2026, 11, 5));
    await adult(w);
    const r = await w.buy('p', 'stable_allowance_30d');
    for (let d = 0; d < 3; d++) { w.at(jst(2026, 11, 5 + d)); await w.svc.claimAllowance('p', w.k()); }
    let s = await w.svc.state('p');
    expect(studHeldFree(s, w.now())).toBe(90);
    const out = await w.svc.refund('p', r.txId);
    expect(out).toMatchObject({ removed: 100 + 0, linkedClawback: { freeCoins: 90 } });
    s = await w.svc.state('p');
    expect(s.wallet).toMatchObject({ paid: 0, free: 0, debt: 0 });
    expect(await code(w.svc.claimAllowance('p', w.k()))).toBe('NOT_ELIGIBLE');
    // the refund does not block buying it again
    await w.svc.purchaseIntent('p', 'stable_allowance_30d');
  });
  it('a second purchase that arrives while one runs is queued after it (paid days are never lost)', async () => {
    const w = world(jst(2026, 11, 5));
    await adult(w);
    await w.buy('p', 'stable_allowance_30d');
    await w.buy('p', 'stable_allowance_30d', { intent: false });
    expect(await w.svc.allowance('p')).toMatchObject({ endDate: '2026-12-04', queued: { startDate: '2026-12-05', endDate: '2027-01-03' } });
    expect((await w.svc.state('p')).supportFlags).toContain('allowance_overlap:T1');
  });
});

describe('REQ-UXS-019 Pass+ and refunds of passes', () => {
  it('Pass+ adds 10 levels at purchase and its tack; a refund takes the levels and what they unlocked back', async () => {
    const w = world(jst(2026, 11, 10));
    await adult(w);
    await w.buy('p', 'season_pass_plus');
    let pv = await w.svc.passView('p');
    expect(pv).toMatchObject({ level: 10, boostLevels: 10, active: true, owned: ['season_pass_plus'] });
    let s = await w.svc.state('p');
    expect(s.items).toMatchObject({ tack_bridle_pass_plus: 1, costume_season_limited: 1 });
    expect(await code(w.svc.buyCosmetic('p', 'tack_bridle_pass_plus', w.k()))).toBe('NOT_ELIGIBLE');
    for (let lv = 1; lv <= 10; lv++) { await w.svc.claimPass('p', 'free', lv, w.k()); await w.svc.claimPass('p', 'premium', lv, w.k()); }
    for (let i = 0; i < 10; i++) await w.ranked('p', 12); // +200 xp → level 12; the free line of 1..2 is now earned without the boost
    s = await w.svc.state('p');
    const free = m.progression.passRewards.free.reward.freeCoins!;
    const prem = m.progression.passRewards.premium.reward.freeCoins!;
    expect(studHeldFree(s, w.now())).toBe(10 * prem + 10 * free); // premium + free levels above the natural level at claim time (all 10 then)
    const tx = s.purchases[0]!.txId;
    const before = s.wallet.free;
    const out = await w.svc.refund('p', tx);
    // boost removed: level 2; free 3..10 and premium 1..10 taken back
    expect(out.linkedClawback.freeCoins).toBe(8 * free + 10 * prem);
    s = await w.svc.state('p');
    expect(before - s.wallet.free).toBe(8 * free + 10 * prem);
    expect(s.items.tack_bridle_pass_plus ?? 0).toBe(0);
    expect(s.items.breeding_material ?? 0).toBe(0); // the premium materials went back too
    pv = await w.svc.passView('p');
    expect(pv).toMatchObject({ level: 2, boostLevels: 0, active: false, claimed: { free: [1, 2], premium: [] }, purchasable: ['season_pass', 'season_pass_plus'] });
    expect(await code(w.svc.claimPass('p', 'premium', 1, w.k()))).toBe('NOT_ELIGIBLE');
  });
  it('a refund after the season closed reaches the recorded season (auto-granted rewards included)', async () => {
    const w = world(jst(2026, 11, 25));
    await adult(w);
    const r = await w.buy('p', 'season_pass');
    for (let i = 0; i < 15; i++) await w.ranked('p', 12); // level 3, nothing claimed
    w.at(jst(2026, 12, 2));
    await w.svc.passView('p'); // closes November: free 1..3 and premium 1..3 auto-granted
    const s0 = await w.svc.state('p');
    expect(s0.passHistory![0]).toMatchObject({ seasonId: '2026-11', premium: true, autoGranted: { premium: [1, 2, 3] } });
    const out = await w.svc.refund('p', r.txId);
    expect(out.linkedClawback.freeCoins).toBe(3 * m.progression.passRewards.premium.reward.freeCoins!);
    const s = await w.svc.state('p');
    expect(s.passHistory![0]).toMatchObject({ premium: false, granted: { free: [1, 2, 3], premium: [] } });
  });
});

describe('store paths for the new SKUs', () => {
  it('Google: once-only packs are acknowledged (not consumed); passes and the daily pack are consumed', async () => {
    const calls: string[] = [];
    const purchase: ProductPurchase = { purchaseState: 0, consumptionState: 0, acknowledgementState: 0, orderId: 'GPA.1', purchaseTimeMillis: String(jst(2026, 11, 5)), purchaseType: 1 };
    const f: typeof fetch = async (u, init) => {
      calls.push(`${init?.method ?? 'GET'} ${String(u).split('/purchases')[1]}`);
      return (init?.method ?? 'GET') === 'GET' ? Response.json(purchase) : new Response('', { status: 200 });
    };
    const st = storeSettingsFromEnv({ GOOGLE_PACKAGE_NAME: 'pkg', GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"a","private_key":"b"}' } as unknown as Env, m);
    const v = new GoogleStoreVerifier({ ...st.google!, api: new GooglePlayApi('pkg', { accessToken: async () => 't' }, f) });
    expect(st.google!.subscriptionProductIds.size).toBe(0);
    for (const id of ['starter_pack', 'promo_pack_B', 'season_pass', 'stable_allowance_30d']) {
      const r = await v.verify(JSON.stringify({ purchaseToken: `tok_${id}` }), id);
      expect(r.expiresAt).toBeUndefined();
      await v.finalize(r);
    }
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual([
      'POST /products/starter_pack/tokens/tok_starter_pack:acknowledge',
      'POST /products/promo_pack_B/tokens/tok_promo_pack_B:acknowledge',
      'POST /products/season_pass/tokens/tok_season_pass:consume',
      'POST /products/stable_allowance_30d/tokens/tok_stable_allowance_30d:consume',
    ]);
  });
  it('a once-only pack bought again outside the app flow is still credited and flagged for support', async () => {
    const w = world();
    await adult(w);
    await w.buy('p', 'starter_pack');
    const r = await w.buy('p', 'starter_pack', { intent: false });
    expect(r.duplicate).toBe(false);
    expect((await w.svc.state('p')).supportFlags).toContain(`once_duplicate:starter_pack:${r.txId}`);
  });
});

describe('HTTP: shop endpoints (contracts/protocol.md §13)', () => {
  function ctx() {
    const now = jst(2026, 11, 5);
    const store = new FakeStoreVerifier();
    const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(3), clock: () => now, verifiers: { fake: store } });
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
    const c = {
      master: m, authenticate: async (req: Request) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
      player: () => invoker, friends: makeFriendsService(() => invoker, new MemoryDirectory()), clock: () => now,
      paidBalance: async () => ({}), adminToken: 'x', parseStoreNotification: async () => null,
    } as unknown as AppContext;
    return { c, svc, store };
  }
  const req = (method: string, path: string, user?: string, idem?: string) => new Request(`https://x${path}`, { method, headers: { ...(user ? { 'x-test-user': user } : {}), ...(idem ? { 'idempotency-key': idem } : {}) } });
  it('products (no auth), offers / view / allowance / claim (auth), missions with the first-win bonus', async () => {
    const { c, svc, store } = ctx();
    const products = await (await handle(req('GET', '/v1/shop/products'), {}, c)).json() as { products: { id: string; contents: unknown[] }[]; legalLinks: unknown[] };
    expect(products.products.find((p) => p.id === 'season_pass')!.contents.length).toBeGreaterThan(0);
    expect((await handle(req('GET', '/v1/shop/offers'), {}, c)).status).toBe(401);
    const offers = await (await handle(req('GET', '/v1/shop/offers', 'u'), {}, c)).json() as { offers: unknown[]; firstPurchase: { available: boolean }; allowance: { active: boolean } };
    expect(offers).toMatchObject({ firstPurchase: { available: true }, allowance: { active: false } });
    expect((await handle(req('POST', '/v1/shop/offers/starter_pack/view', 'u'), {}, c)).status).toBe(404);
    expect((await handle(req('POST', '/v1/shop/offers/bad!id/view', 'u'), {}, c)).status).toBe(400);
    expect(await (await handle(req('POST', '/v1/shop/allowance/claim', 'u'), {}, c)).json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
    expect(await (await handle(req('POST', '/v1/shop/allowance/claim', 'u', 'k1'), {}, c)).json()).toMatchObject({ error: { code: 'NOT_ELIGIBLE' } });
    await svc.setAge('u', 1990, 1, false);
    await svc.purchase('u', 'fake', 'stable_allowance_30d', store.issue({ transactionId: 'A1', productId: 'stable_allowance_30d', purchasedAt: 0, priceYen: 480 }));
    const claim = await (await handle(req('POST', '/v1/shop/allowance/claim', 'u', 'k2'), {}, c)).json() as { freeCoins: number };
    expect(claim.freeCoins).toBe(30);
    expect(await (await handle(req('GET', '/v1/shop/allowance', 'u'), {}, c)).json()).toMatchObject({ active: true, claimedToday: true });
    const missions = await (await handle(req('GET', '/v1/missions', 'u'), {}, c)).json() as { firstWinBonus: { remaining: number } };
    expect(missions.firstWinBonus).toMatchObject({ remaining: 3, next: 30, byWin: [30, 20, 10] });
    const pass = await (await handle(req('GET', '/v1/season-pass', 'u'), {}, c)).json() as Record<string, unknown>;
    expect(pass).toMatchObject({ seasonId: '2026-11', autoRenew: false, autoGrantAtSeasonEnd: true, purchasable: ['season_pass', 'season_pass_plus'] });
  });
});

it('time helpers', async () => {
  const { jstMonthEndMs, addJstDays } = await import('../src/domain/time.js');
  expect(jstMonthEndMs('2026-12')).toBe(jst(2027, 1, 1, 0));
  expect(addJstDays('2026-11-05', 29)).toBe('2026-12-04');
  expect(NOV_END - jst(2026, 11, 30, 0)).toBe(DAY);
});
