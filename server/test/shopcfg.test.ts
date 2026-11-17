// Stream D (docs/quality/shopcfg.md): the owner's four shop / reward decisions.
//  1. allowanceUnderPass on: the daily pack (厩舎手当) is listed under the season pass.
//  2. coin packs ¥800 and ¥2,400 retired (8 → 6).
//  3. the promotion packs (昇級記念パック) retired; their B/A/S patterns become a free reward on reaching that class
//     (progression.promotionRewards): granted once per class, idempotent, never for sale, shown once (view + ack).
//  4. login bonus: a looks-only item the player already owns is swapped for breeding material
//     (progression.loginBonusOwnedSwap): the normal cycle's day 3 「翼」 gives a player who has it 2 materials.
import { describe, expect, it } from 'vitest';
import { m, freshPlayer } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { shopLayoutProblems, shopProducts } from '../src/domain/shop.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { ALLOWANCE_UNDER_PASS_NOTE } from '../src/domain/receipt.js';
import { catalogFor, translateText } from '../src/i18n/catalog.js';
import { rollSeason } from '../src/domain/season.js';
import {
  ackPromotionReward, promotionRewardFor, promotionRewardsProblems, promotionView,
} from '../src/domain/promotion.js';
import { claimLoginBonus, loginBonusSwapProblems, loginRewardFor } from '../src/domain/rewards.js';
import { loginBonusPlan, nextLoginBonus } from '../src/domain/goals.js';
import { resolveBundle } from '../src/ops/config.js';
import { uxProblems } from '../src/domain/onboarding.js';
import { collectItemIds } from '../src/domain/visuals.js';
import type { Master } from '../src/domain/master.js';
import type { PlayerState } from '../src/domain/player.js';

const NOV = Date.UTC(2026, 10, 10, 3);
const DEC = Date.UTC(2026, 11, 2, 3);
const JAN = Date.UTC(2027, 0, 2, 3);
const FEB = Date.UTC(2027, 1, 2, 3);
const DAY = 24 * 3600_000;
const withProgression = (progression: Record<string, unknown>) => resolveBundle(m, { progression }).master;
const known = new Set(collectItemIds(m));

describe('1・2. shop layout: shipped on (allowance under the pass, 6 coin packs, no promotion packs)', () => {
  it('the shipped config lists 6 coin packs, no promotion pack, and the daily pack on the pass tab', () => {
    expect(m.progression.shopLayout).toMatchObject({ allowanceUnderPass: true });
    expect([...(m.progression.shopLayout!.retiredProducts ?? [])].sort()).toEqual(['coin_2400', 'coin_800', 'promo_pack_A', 'promo_pack_B', 'promo_pack_S']);
    const list = shopProducts(m).products;
    expect(list.filter((p) => p.kind === 'coins').map((p) => p.priceYen)).toEqual([160, 480, 1500, 3800, 5000, 10000]);
    expect(list.some((p) => p.kind === 'promotion')).toBe(false);
    expect(list.find((p) => p.kind === 'allowance')!.tab).toBe('pass');
    expect(shopLayoutProblems(m)).toEqual([]);
  });

  it('remote config can undo it all (every pack back on sale, the promotion reward off)', () => {
    const back = withProgression({ shopLayout: { allowanceUnderPass: false, retiredProducts: [] }, promotionRewards: {} });
    expect(shopProducts(back).products.filter((p) => p.kind === 'coins')).toHaveLength(8);
    expect(shopProducts(back).products.filter((p) => p.kind === 'promotion')).toHaveLength(3);
    // the patterns cannot be free and on sale at once
    expect(() => withProgression({ shopLayout: { allowanceUnderPass: false, retiredProducts: [] } })).toThrow(/on sale in promo_pack_B/);
  });

  it('the daily pack\'s receipt says where each day\'s coins are claimed now (the pass screen), in both languages', async () => {
    const store = new FakeStoreVerifier();
    const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(7), clock: () => NOV, verifiers: { fake: store } });
    await svc.bootstrap('p'); await svc.setAge('p', 1990, 1, false);
    await svc.purchaseIntent('p', 'stable_allowance_30d');
    const p = m.products.find((x) => x.id === 'stable_allowance_30d')!;
    const out = await svc.purchase('p', 'fake', p.id, store.issue({ transactionId: 'T1', productId: p.id, purchasedAt: NOV, priceYen: p.priceYen })) as { receipt: { lines: { kind: string; purpose: string | null }[]; next: { action: string } } };
    const line = out.receipt.lines.find((l) => l.kind === 'allowance')!;
    expect(line.purpose).toBe(ALLOWANCE_UNDER_PASS_NOTE);
    expect(out.receipt.next.action).toBe('claim_allowance');
    expect(translateText(ALLOWANCE_UNDER_PASS_NOTE, catalogFor(m))).toBe("Claim each day's coins on the season pass screen");
  });
});

describe('3. promotion reward (progression.promotionRewards)', () => {
  const PATTERN = { B: 'costume_promo_b', A: 'costume_promo_a', S: 'costume_promo_s' } as const;

  it('the shipped rewards are the three retired packs\' patterns; the boot checks pass', () => {
    for (const [cls, item] of Object.entries(PATTERN)) expect(promotionRewardFor(m, cls)).toEqual({ items: [{ itemId: item, qty: 1 }] });
    expect(promotionRewardFor(m, 'C')).toBeNull();
    expect(promotionRewardsProblems(m)).toEqual([]);
    expect(uxProblems(m, known).filter((p) => p.includes('promotionRewards'))).toEqual([]);
  });

  it('never for sale: a reward item in a product still on sale, a coin / random reward, an unknown class are refused', () => {
    const p = (o: Record<string, unknown>) => promotionRewardsProblems({ ...m, progression: { ...m.progression, ...o } } as Master).join('\n');
    // the promotion packs are back on sale → their pattern cannot also be the free reward
    expect(p({ shopLayout: { allowanceUnderPass: true, retiredProducts: ['coin_800', 'coin_2400'] } })).toMatch(/costume_promo_b.*on sale.*promo_pack_B/);
    expect(p({ promotionRewards: { B: { freeCoins: 100 } } })).toMatch(/looks-only items only/);
    expect(p({ promotionRewards: { B: { items: [{ itemId: 'breeding_material', qty: 1 }] } } })).toMatch(/looks-only/);
    expect(p({ promotionRewards: { Z: { items: [{ itemId: 'costume_promo_b', qty: 1 }] } } })).toMatch(/unknown class Z/);
    expect(p({ promotionRewards: { C: { items: [{ itemId: 'costume_promo_b', qty: 1 }] } } })).toMatch(/lowest class/);
    expect(() => withProgression({ promotionRewards: { B: { freeCoins: 100 } } })).toThrow(AppError);
  });

  it('reaching B at the close grants the B pattern once; the view shows it until acked; coins are untouched', () => {
    const s = freshPlayer('a', NOV);
    s.season.points = 320;
    expect(promotionView(m, s).nextReward).toEqual({ classId: 'B', items: [{ itemId: 'costume_promo_b', qty: 1 }] });
    const wallet = { ...s.wallet };
    rollSeason(m, s, DEC);
    expect(s.season.classId).toBe('B');
    expect(s.items.costume_promo_b).toBe(1);
    expect(s.wallet).toEqual(wallet);
    const v = promotionView(m, s);
    expect(v.reward).toEqual({ classId: 'B', seasonId: '2026-11', items: [{ itemId: 'costume_promo_b', qty: 1 }] });
    expect(v.nextReward).toEqual({ classId: 'A', items: [{ itemId: 'costume_promo_a', qty: 1 }] });
    expect(ackPromotionReward(s, 'B')).toEqual({ classId: 'B', seen: true });
    expect(ackPromotionReward(s, 'B')).toEqual({ classId: 'B', seen: true }); // idempotent
    expect(promotionView(m, s).reward).toBeNull();
    expect(() => ackPromotionReward(s, 'A')).toThrow(AppError);
  });

  it('once per class: demoted and promoted again to B gives nothing the second time', () => {
    const s = freshPlayer('a', NOV);
    s.season.points = 320;
    rollSeason(m, s, DEC); // C → B
    s.promotion!.grace = null; // no shield
    s.season.points = 0;
    rollSeason(m, s, JAN); // B → C
    expect(s.season.classId).toBe('C');
    s.season.points = 320;
    rollSeason(m, s, FEB); // C → B again
    expect(s.season.classId).toBe('B');
    expect(s.items.costume_promo_b).toBe(1);
    expect(s.promotion!.rewards!.filter((r) => r.classId === 'B')).toHaveLength(1);
  });

  it('a player who bought the old pack keeps one pattern and sees no moment', () => {
    const s = freshPlayer('a', NOV);
    s.items.costume_promo_b = 1;
    s.season.points = 320;
    rollSeason(m, s, DEC);
    expect(s.items.costume_promo_b).toBe(1);
    expect(promotionView(m, s).reward).toBeNull();
    expect(promotionView(m, s).nextReward?.classId).toBe('A');
  });

  it('also granted with the promotion series switched off (the class is what counts)', () => {
    const off = { ...m, progression: { ...m.progression, promotion: { ...(m.progression as { promotion: object }).promotion, enabled: false } } } as Master;
    const s = freshPlayer('a', NOV);
    s.season.points = 320;
    rollSeason(off, s, DEC);
    expect(s.items.costume_promo_b).toBe(1);
    expect(promotionView(off, s).reward?.classId).toBe('B');
  });

  it('through the service: the close grants it in the first transaction of the month; POST ack marks it seen', async () => {
    const clock = { now: NOV };
    const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(7), clock: () => clock.now, verifiers: {} });
    await svc.tx('a', null, (s) => { s.season.points = 320; });
    clock.now = DEC;
    expect((await svc.promotion('a')).reward?.classId).toBe('B'); // a read on a copy already shows it
    await svc.tx('a', null, () => {}); // the month's first transaction closes the season
    const v = await svc.promotion('a');
    expect(v.reward?.classId).toBe('B');
    expect((await svc.state('a')).items.costume_promo_b).toBe(1);
    expect(await svc.promotionRewardAck('a', 'B')).toEqual({ classId: 'B', seen: true });
    expect((await svc.promotion('a')).reward).toBeNull();
  });
});

describe('4. login bonus: an owned looks-only item becomes breeding material (progression.loginBonusOwnedSwap)', () => {
  const claimDays = (s: PlayerState, from: number, n: number) => Array.from({ length: n }, (_, i) => claimLoginBonus(m, s, from + i * DAY));

  it('the shipped swap: 「翼」 → 2 breeding material; the checks pass', () => {
    expect(m.progression.loginBonusOwnedSwap?.costume_login).toEqual({ items: [{ itemId: 'breeding_material', qty: 2 }] });
    expect(Object.keys(m.progression.loginBonusOwnedSwap!).filter((k) => k !== '_note')).toEqual(['costume_login']);
    expect(loginBonusSwapProblems(m)).toEqual([]);
  });

  it('a new player gets 「翼」 on beginner day 3, then 2 materials on day 10 (the normal cycle\'s day 3)', () => {
    const s = freshPlayer('a', NOV);
    const r = claimDays(s, NOV, 10);
    expect(r[2]!.reward.items).toEqual([{ itemId: 'costume_login', qty: 1 }]);
    expect(r[2]!.swappedFrom).toBeUndefined();
    expect(r[9]).toMatchObject({ track: 'normal', day: 3, swappedFrom: 'costume_login' });
    expect(r[9]!.reward.items).toEqual([{ itemId: 'breeding_material', qty: 2 }]);
    expect(s.items.costume_login).toBe(1);
  });

  it('a player on the normal cycle who does not own it still gets the pattern', () => {
    const s = freshPlayer('a', NOV);
    s.loginBonus = { streakDay: 2, lastClaimDate: '2026-11-01', beginnerDay: 7 };
    const before = s.items.breeding_material ?? 0;
    const r = claimLoginBonus(m, s, NOV);
    expect(r).toMatchObject({ track: 'normal', day: 3 });
    expect(r.swappedFrom).toBeUndefined();
    expect(s.items.costume_login).toBe(1);
    expect(s.items.breeding_material ?? 0).toBe(before);
  });

  it('the preview (next / week plan) says the same as the claim', () => {
    const s = freshPlayer('a', NOV);
    claimDays(s, NOV, 9);
    expect(nextLoginBonus(m, s)).toMatchObject({ track: 'normal', day: 3, reward: { items: [{ itemId: 'breeding_material', qty: 2 }] }, swappedFrom: 'costume_login' });
    const fresh = freshPlayer('b', NOV);
    const plan = loginBonusPlan(m, fresh, NOV, 10);
    expect(plan[2]!.reward.items).toEqual([{ itemId: 'costume_login', qty: 1 }]);
    expect(plan[9]).toMatchObject({ day: 3, track: 'normal', swappedFrom: 'costume_login', reward: { items: [{ itemId: 'breeding_material', qty: 2 }] } });
    expect(loginRewardFor(m, fresh, { items: [{ itemId: 'costume_login', qty: 1 }] }).reward.items).toEqual([{ itemId: 'costume_login', qty: 1 }]);
  });

  it('rules: the swapped item must be looks-only, the substitute has no coins, no random draw and at most 5 items', () => {
    const p = (swap: unknown) => loginBonusSwapProblems({ ...m, progression: { ...m.progression, loginBonusOwnedSwap: swap } } as Master).join('\n');
    expect(p({ breeding_material: { items: [{ itemId: 'breeding_material', qty: 2 }] } })).toMatch(/looks-only/);
    expect(p({ costume_login: { freeCoins: 100 } })).toMatch(/items only/);
    expect(p({ costume_login: { items: [{ itemId: 'gacha_ticket', qty: 1 }] } })).toMatch(/breeding material/);
    expect(p({ costume_login: { items: [{ itemId: 'breeding_material', qty: 6 }] } })).toMatch(/at most 5/);
  });
});
