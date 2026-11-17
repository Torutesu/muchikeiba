// Quality pass 3 (docs/quality/pass.md): the season pass premium track gets standout tiers (10 / 20 / 30 on the premium line,
// 15 on the free line) — a looks-only, not-for-sale silks part on top of the tier's usual coins and material, so the track's
// coin/material totals and every running total are exactly what they were. The pass screen names the next standout and how
// far it is; the silks editor says where each part comes from. The owner's shop proposals (daily pack under the pass, retired
// coin / promotion packs) sit behind progression.shopLayout and are off by default.
import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { passLineLevels, passLineTotal, passRewardAt, passRewardsProblems, passStandouts } from '../src/domain/pass.js';
import { productContents, shopLayoutProblems, shopOffers, shopProducts } from '../src/domain/shop.js';
import { collectItemIds } from '../src/domain/visuals.js';
import { resolveBundle } from '../src/ops/config.js';
import { catalogFor, translateText } from '../src/i18n/catalog.js';
import { coinShortfall } from '../src/domain/shortfall.js';
import type { Master } from '../src/domain/master.js';

const JST = 9 * 3600_000;
const NOW = Date.UTC(2026, 10, 5, 12) - JST; // 2026-11-05 12:00 JST
const BANNED = /倍|今だけ|残りわずか|お得|通常価格/;
const known = new Set(collectItemIds(m));

function world(master: Master = m) {
  let now = NOW;
  const store = new FakeStoreVerifier();
  const repo = new MemoryPlayerRepo();
  const svc = new PlayerService(repo, { master, rng: seededRng(7), clock: () => now, verifiers: { fake: store } });
  let tx = 0, k = 0;
  const purchase = (id: string, productId: string) => {
    const p = master.products.find((x) => x.id === productId)!;
    return svc.purchase(id, 'fake', productId, store.issue({ transactionId: `T${tx++}`, productId, purchasedAt: now, priceYen: p.priceYen }));
  };
  const buy = async (id: string, productId: string) => { await svc.purchaseIntent(id, productId); return purchase(id, productId); };
  const player = async (id: string) => { await svc.bootstrap(id); await svc.setAge(id, 1990, 1, false); };
  const setXp = (id: string, xp: number) => {
    const st = JSON.parse((repo as unknown as { data: Map<string, string> }).data.get(id)!);
    st.seasonPass.xp = xp;
    (repo as unknown as { data: Map<string, string> }).data.set(id, JSON.stringify(st));
  };
  return { svc, buy, purchase, player, setXp, key: () => `c:q3k${k++}`, at: (t: number) => { now = t; }, lastTx: () => `fake:T${tx - 1}` };
}

const withProgression = (progression: Record<string, unknown>) => resolveBundle(m, { progression }).master;

describe('the premium track: standout tiers, same totals', () => {
  it('the totals are what they were: 1,500 free coins + 30 materials (premium), 300 free coins (free)', () => {
    const premium = passLineTotal(m, 'premium');
    expect(premium.freeCoins).toBe(1500);
    expect(premium.items?.find((x) => x.itemId === 'breeding_material')?.qty).toBe(30);
    expect(passLineTotal(m, 'free').freeCoins).toBe(300);
    expect(passLineLevels(m, 'premium')).toHaveLength(30);
    // E7 still holds on the same coins (the cosmetics carry no coin price: not for sale)
    const pass = m.products.find((p) => p.id === 'season_pass')!;
    const best = Math.min(...m.products.filter((p) => p.kind === 'coins').map((p) => p.priceYen / p.paidCoins));
    expect(premium.freeCoins! * best).toBeGreaterThanOrEqual(pass.priceYen * 1.5);
  });

  it('every running total is unchanged: nobody who stops before 30 gets less than the flat line gave', () => {
    for (const track of ['free', 'premium'] as const) {
      const flat = m.progression.passRewards[track].reward;
      let coins = 0, mats = 0;
      for (let lv = 1; lv <= m.progression.passMaxLevel; lv++) {
        const r = passRewardAt(m, track, lv)!;
        coins += r.freeCoins ?? 0;
        mats += r.items?.find((x) => x.itemId === 'breeding_material')?.qty ?? 0;
        expect(coins).toBe((flat.freeCoins ?? 0) * lv);
        expect(mats).toBe((flat.items?.find((x) => x.itemId === 'breeding_material')?.qty ?? 0) * lv);
      }
    }
  });

  it('standouts: premium 10 / 20 / 30 (colour, sleeves, body pattern of one set), free 15 (the cap); looks only, not for sale', () => {
    const st = passStandouts(m);
    expect(st.map((x) => `${x.track}:${x.level}:${x.look.part}`)).toEqual(['premium:10:color', 'free:15:cap', 'premium:20:sleeve', 'premium:30:pattern']);
    for (const x of st) {
      const c = m.items.cosmetics.find((y) => y.id === x.itemId)!;
      expect(c.notForSale).toBe(true);
      expect(c.currency).toBe('any');
      expect(['silks', 'silks_part']).toContain(c.kind);
      expect(m.shopDisplay!.itemPurposes![x.itemId]).toContain('ランク戦の能力は変わりません');
    }
    expect(passRewardsProblems(m, known)).toEqual([]);
    // the legacy fields stay: an older client still reads the line's every-tier reward
    expect(m.progression.passRewards.premium.reward).toEqual({ freeCoins: 50, items: [{ itemId: 'breeding_material', qty: 1 }] });
  });

  it('the shape rules refuse a sold or paid-only cosmetic, a non-reward level, a horse, and one cosmetic on both lines', () => {
    const bad = (tiersP: Record<string, unknown>, tiersF: Record<string, unknown> = {}) => {
      const pr = structuredClone(m.progression.passRewards) as unknown as Record<string, { tiers?: unknown }>;
      pr.premium!.tiers = tiersP; pr.free!.tiers = tiersF;
      return passRewardsProblems({ ...m, progression: { ...m.progression, passRewards: pr as never } }, known).join('\n');
    };
    expect(bad({ '10': { freeCoins: 50, items: [{ itemId: 'costume_silks_laurel', qty: 1 }] } })).toMatch(/sold in the shop/);
    expect(bad({ '10': { freeCoins: 50, items: [{ itemId: 'tack_bridle_gold', qty: 1 }] } })).toMatch(/paid-only/);
    expect(bad({ '31': { freeCoins: 50 } })).toMatch(/level 1\.\.30/);
    expect(bad({ '10': { freeCoins: 50, horse: 'x' } })).toMatch(/horse is not allowed/);
    expect(bad({ '10': { freeCoins: 50, items: [{ itemId: 'silkpart_cap_comet', qty: 1 }] } }, { '15': { freeCoins: 10, items: [{ itemId: 'silkpart_cap_comet', qty: 1 }] } })).toMatch(/both the free and the premium line/);
    // the same check runs on a remote-config version, and a season's rotation (other tiers) is accepted
    expect(() => withProgression({ passRewards: { ...m.progression.passRewards, premium: { ...m.progression.passRewards.premium, tiers: { '10': { freeCoins: 50, items: [{ itemId: 'costume_silks_laurel', qty: 1 }] } } } } })).toThrow(/sold in the shop/);
    const rotated = withProgression({ passRewards: { ...m.progression.passRewards, premium: { ...m.progression.passRewards.premium, tiers: { '25': { freeCoins: 50, items: [{ itemId: 'breeding_material', qty: 1 }, { itemId: 'costume_silks_comet', qty: 1 }] } } } } });
    expect(passStandouts(rotated).filter((x) => x.track === 'premium').map((x) => x.level)).toEqual([25]);
  });

  it('the product says what the track holds: the total and the standout tiers by name, no banned words', () => {
    const c = productContents(m, m.products.find((p) => p.id === 'season_pass')!).find((x) => x.type === 'pass_premium')!;
    if (c.type !== 'pass_premium') throw new Error('no pass_premium');
    expect(c.levels).toBe(30);
    expect(c.total).toEqual({ freeCoins: 1500, items: [{ itemId: 'breeding_material', qty: 30 }] });
    expect(c.totalLabel).toBe('30段の合計：無償コイン1,500枚＋配合素材×30');
    expect(c.standouts.map((x) => x.level)).toEqual([10, 20, 30]);
    expect(c.standoutLabel).toBe('ティア10 勝負服の色「曙光」・ティア20 勝負服の袖「流星」・ティア30 勝負服の柄「流星群」');
    for (const t of [c.label, c.totalLabel, c.standoutLabel!]) expect(t).not.toMatch(BANNED);
    const cat = catalogFor(m);
    expect(translateText(c.standoutLabel!, cat)).toBe('Tier 10: Silks colour "Dawnlight", Tier 20: Silks sleeves "Meteor", Tier 30: Silks pattern "Meteor Shower"');
    expect(translateText(c.totalLabel, cat)).not.toMatch(/[぀-ヿ一-龯]/);
  });
});

describe('the pass screen: the next standout, the claim, the silks editor', () => {
  it('names the next standout and how far it is (levels and races, counted like racesToNextLevel)', async () => {
    const w = world();
    await w.player('p');
    w.setXp('p', 740); // level 7, 40 XP into it
    const v = await w.svc.passView('p') as any;
    expect(v.nextStandout).toEqual({ track: 'premium', level: 10, itemId: 'silkpart_color_shokou', label: '勝負服の色「曙光」', levelsAway: 3, racesAway: Math.ceil((1000 - 740) / m.progression.passXpPerRace) });
    expect(v.standouts).toHaveLength(4);
    const ten = v.standouts.find((x: any) => x.level === 10);
    expect(ten).toMatchObject({ track: 'premium', look: { part: 'color', ref: 'shokou' }, reached: false, claimable: false, owned: false });
    expect(ten.reward.freeCoins).toBe(50);
    expect(v.totals.premium.freeCoins).toBe(1500);
    w.setXp('p', 1500); // level 15: premium 10 passed → next is premium 20; the free 15 is reached and claimable
    const v2 = await w.svc.passView('p') as any;
    expect(v2.nextStandout).toMatchObject({ track: 'premium', level: 20, levelsAway: 5 });
    expect(v2.standouts.find((x: any) => x.track === 'free').claimable).toBe(true);
    expect(v2.standouts.find((x: any) => x.level === 10).claimable).toBe(false); // premium not owned
    w.setXp('p', 3000);
    expect((await w.svc.passView('p') as any).nextStandout).toBeNull();
  });

  it('claiming a standout tier gives the usual coins and material plus the part, and the editor unlocks it (source: the tier)', async () => {
    const w = world();
    await w.player('p');
    const before = await w.svc.silksEditor('p') as any;
    const color = before.parts.colors.find((x: any) => x.id === 'shokou');
    expect(color).toMatchObject({ owned: false, sourceLabel: 'シーズンパス 有料ライン ティア10で入手' });
    expect(before.parts.patterns.find((x: any) => x.id === 'comet').sourceLabel).toBe('シーズンパス 有料ライン ティア30で入手');
    expect(before.parts.caps.find((x: any) => x.id === 'comet').sourceLabel).toBe('シーズンパス 無料ライン ティア15で入手');
    expect(color.shop?.forSale ?? false).toBe(false);
    await w.buy('p', 'season_pass');
    w.setXp('p', 1000);
    const s0 = await w.svc.state('p');
    const r = await w.svc.claimPass('p', 'premium', 10, w.key()) as any;
    expect(r).toEqual({ freeCoins: 50, items: [{ itemId: 'breeding_material', qty: 1 }, { itemId: 'silkpart_color_shokou', qty: 1 }] });
    const s1 = await w.svc.state('p');
    expect(s1.wallet.free - s0.wallet.free).toBe(50);
    expect(s1.items.silkpart_color_shokou).toBe(1);
    const after = await w.svc.silksEditor('p') as any;
    expect(after.parts.colors.find((x: any) => x.id === 'shokou').owned).toBe(true);
    const v = await w.svc.passView('p') as any;
    expect(v.standouts.find((x: any) => x.level === 10)).toMatchObject({ claimed: true, owned: true, claimable: false });
    await expect(w.svc.claimPass('p', 'premium', 10, w.key())).rejects.toMatchObject({ code: 'ALREADY_CLAIMED' });
  });

  it('the season close grants unclaimed standout tiers like any other tier, and a refund takes the parts back', async () => {
    const w = world();
    await w.player('p');
    await w.buy('p', 'season_pass');
    const tx = w.lastTx();
    w.setXp('p', 2000);
    w.at(Date.UTC(2026, 11, 1, 12) - JST); // into December: the November pass closes on the next request
    await w.svc.passView('p');
    const s = await w.svc.state('p');
    expect(s.items.silkpart_color_shokou).toBe(1);
    expect(s.items.silkpart_sleeve_comet).toBe(1);
    expect(s.items.silkpart_cap_comet).toBe(1);
    expect(s.items.costume_silks_comet ?? 0).toBe(0);
    const h = s.passHistory!.find((x) => x.seasonId === '2026-11')!;
    expect(h.autoGranted.premium).toContain(20);
    await w.svc.refund('p', tx.replace(/^fake:/, ''));
    const s2 = await w.svc.state('p');
    expect(s2.items.silkpart_color_shokou ?? 0).toBe(0);
    expect(s2.items.silkpart_sleeve_comet ?? 0).toBe(0);
    expect(s2.items.silkpart_cap_comet).toBe(1); // the free line's part stays (it was earned, not bought)
  });
});

describe('shop layout proposals (progression.shopLayout; shipped ON since stream D, docs/quality/shopcfg.md)', () => {
  const RETIRE = ['coin_800', 'coin_2400', 'promo_pack_B', 'promo_pack_A', 'promo_pack_S'];
  // the layout switched off by remote config (the promotion reward goes with it: its patterns cannot be free and on sale)
  const OFF = withProgression({ shopLayout: { allowanceUnderPass: false, retiredProducts: [] }, promotionRewards: {} });

  it('switched off: every product is listed and the daily pack stays on the recommended tab', () => {
    const list = shopProducts(OFF).products;
    expect(list.filter((p) => p.kind === 'coins')).toHaveLength(8);
    expect(list.find((p) => p.kind === 'allowance')!.tab).toBe('recommended');
    expect(shopLayoutProblems(OFF)).toEqual([]);
  });

  it('retired packs: not listed, no offer, a new intent refused; a purchase already in flight is still credited', async () => {
    const mm = withProgression({ shopLayout: { allowanceUnderPass: true, retiredProducts: RETIRE } });
    const list = shopProducts(mm).products;
    expect(list.filter((p) => p.kind === 'coins').map((p) => p.priceYen)).toEqual([160, 480, 1500, 3800, 5000, 10000]);
    expect(list.some((p) => p.kind === 'promotion')).toBe(false);
    expect(list.find((p) => p.kind === 'allowance')!.tab).toBe('pass');
    const w = world(mm);
    await w.player('p');
    await expect(w.svc.purchaseIntent('p', 'coin_800')).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
    const s0 = await w.svc.state('p');
    await w.purchase('p', 'coin_800'); // the store delivered it after the switch: credited as bought
    expect((await w.svc.state('p')).wallet.paid - s0.wallet.paid).toBe(530);
    // a class reached by promotion offers no retired pack; the first-purchase list skips retired packs
    const s = await w.svc.state('p');
    s.season.classId = 'A';
    const o = shopOffers(mm, s, NOW);
    expect(o.offers.some((x) => x.touchpoint === 'T4')).toBe(false);
    expect(o.firstPurchase.productIds).not.toContain('coin_2400');
    expect(o.offers.some((x) => x.productId === 'stable_allowance_30d')).toBe(false); // listed under the pass instead
    expect(shopOffers(OFF, s, NOW).offers.some((x) => x.productId === 'stable_allowance_30d')).toBe(true);
    // the shortfall sheet never names a retired pack
    const sh = coinShortfall(mm, s, { coinKind: 'any', need: (s.wallet.paid + s.wallet.free) + 1500 }, NOW) as any;
    expect(sh.offer?.productId).not.toBe('coin_2400');
    expect(RETIRE).not.toContain(sh.offer?.productId);
  });

  it('the rules: coin and promotion packs only, at least 4 coin packs, never the smallest or the largest', () => {
    const p = (ids: string[]) => shopLayoutProblems({ ...m, progression: { ...m.progression, shopLayout: { retiredProducts: ids } } }).join('\n');
    expect(p(RETIRE)).toBe('');
    expect(p(['season_pass'])).toMatch(/cannot be retired/);
    expect(p(['stable_allowance_30d'])).toMatch(/cannot be retired/);
    expect(p(['coin_160'])).toMatch(/smallest or largest/);
    expect(p(['coin_10000'])).toMatch(/smallest or largest/);
    expect(p(['coin_480', 'coin_800', 'coin_1500', 'coin_2400', 'coin_3800'])).toMatch(/at least 4 coin packs/);
    expect(p(['nope'])).toMatch(/unknown product/);
    expect(() => withProgression({ shopLayout: { retiredProducts: ['season_pass'] } })).toThrow(AppError);
  });
});
