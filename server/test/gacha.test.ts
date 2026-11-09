import { describe, expect, it } from 'vitest';
import { bannerProblems, compGachaProblems, drawFromPool, drawGacha, exchangePity, findBanner, oddsDisclosure, rollPulls, validateGacha } from '../src/domain/gacha.js';
import { PPM_TOTAL, RARITY_ORDER } from '../src/domain/master.js';
import { seededRng } from '../src/domain/rng.js';
import { grantFree, grantPaid } from '../src/domain/wallet.js';
import { freshPlayer, m } from './helpers.js';
import type { AppError } from '../src/domain/errors.js';

const NOW = Date.UTC(2026, 10, 5);
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as AppError).code; } return 'NO_ERROR'; };
const rarityOf = (id: string) => m.templateById.get(id)!.rarity;

describe('gacha definitions (REQ-GACHA-001..003)', () => {
  it('master banners are valid', () => {
    expect(() => validateGacha(m)).not.toThrow();
    for (const b of m.gacha.banners) {
      expect(b.pool.reduce((a, e) => a + e.ppm, 0)).toBe(PPM_TOTAL);
      expect(b.guaranteePool.every((e) => rarityOf(e.templateId) !== 'R')).toBe(true);
    }
  });
  it('detects broken definitions', () => {
    const b = findBanner(m, 'standard');
    expect(bannerProblems({ ...b, pool: b.pool.slice(1) }, m, m.gacha).join()).toMatch(/ppm sum/);
    expect(bannerProblems({ ...b, pool: [...b.pool.slice(0, -1), { templateId: 'ghost', ppm: b.pool.at(-1)!.ppm }] }, m, m.gacha).join()).toMatch(/unknown template ghost/);
    const r = m.templates.find((t) => t.rarity === 'R')!.id;
    expect(bannerProblems({ ...b, guaranteePool: [{ templateId: r, ppm: PPM_TOTAL }] }, m, m.gacha).join()).toMatch(/below-SR/);
    expect(bannerProblems({ ...b, priceSingle: 0 }, m, m.gacha).join()).toMatch(/price/);
    expect(bannerProblems({ ...b, pityTargets: ['t_nope'] }, m, m.gacha).join()).toMatch(/pity target/);
  });
  it('disclosure is generated from the same pool and totals 100%', () => {
    for (const b of m.gacha.banners) {
      const d = oddsDisclosure(m, b);
      expect(d.items.map((i) => [i.templateId, i.ppm])).toEqual(b.pool.map((e) => [e.templateId, e.ppm]));
      expect(Object.values(d.rarityTotals).reduce((a, x) => a + x.ppm, 0)).toBe(PPM_TOTAL);
      expect(Object.values(d.guarantee.rarityTotals).reduce((a, x) => a + x.ppm, 0)).toBe(PPM_TOTAL);
      expect(d.pity.pullsRequired).toBe(100);
    }
    const std = oddsDisclosure(m, findBanner(m, 'standard'));
    expect(std.rarityTotals.SSR!.rate).toBe('3.0000%');
    // JOGA guide: estimated cost to the rare item within 100x a single pull
    expect(std.pity.pullsRequired).toBeLessThanOrEqual(100);
  });
  it('pickup banner gives the pickup its configured share', () => {
    const b = findBanner(m, 'pickup_akatsuki');
    expect(b.pool.find((e) => e.templateId === 't_akatsuki')!.ppm).toBe(15000);
  });
});

describe('drawing', () => {
  it('observed rates match the table (statistical, seeded)', () => {
    const b = findBanner(m, 'standard');
    const rng = seededRng(123);
    const N = 200_000;
    const counts: Record<string, number> = { R: 0, SR: 0, SSR: 0 };
    for (let i = 0; i < N; i++) counts[rarityOf(drawFromPool(b.pool, rng))]!++;
    for (const r of RARITY_ORDER) {
      const p = b.pool.filter((e) => rarityOf(e.templateId) === r).reduce((a, e) => a + e.ppm, 0) / PPM_TOTAL;
      const sd = Math.sqrt(N * p * (1 - p));
      expect(Math.abs(counts[r]! - N * p)).toBeLessThan(5 * sd);
    }
  });
  it('every 10-pull contains SR+, and the guarantee table is used only when slots 1-9 had none', () => {
    const b = findBanner(m, 'standard');
    const rng = seededRng(9);
    let guaranteed = 0;
    for (let i = 0; i < 3000; i++) {
      const r = rollPulls(m, b, 10, rng);
      expect(r.some((x) => rarityOf(x.templateId) !== 'R')).toBe(true);
      const firstNineSr = r.slice(0, 9).some((x) => rarityOf(x.templateId) !== 'R');
      expect(r[9]!.guaranteed).toBe(!firstNineSr);
      if (r[9]!.guaranteed) guaranteed++;
    }
    expect(guaranteed).toBeGreaterThan(0);
  });
  it('charges coins (paid first), converts duplicates, accumulates pity and exchanges at 100', () => {
    const s = freshPlayer();
    grantPaid(s, 300, 480, NOW, 'buy', 'tx');
    grantFree(s, 20000, NOW, 'gift', 'g');
    const rng = seededRng(1);
    const first = drawGacha(m, s, 'standard', 10, rng, NOW);
    expect(first.spent).toEqual({ paid: 300, free: 700 });
    for (let i = 0; i < 9; i++) drawGacha(m, s, 'standard', 10, rng, NOW);
    expect(s.pity.standard).toBe(100);
    const owned = new Set(s.horses.map((h) => h.templateId));
    expect(owned.size).toBe(s.horses.length); // no duplicate horses, dupes became material
    expect(s.materials.awakening).toBeGreaterThan(0);
    const r = exchangePity(m, s, 'standard', 't_ginga', NOW);
    expect(s.pity.standard).toBe(0);
    expect(r.templateId).toBe('t_ginga');
    expect(code(() => exchangePity(m, s, 'standard', 't_ginga', NOW))).toBe('PITY_INSUFFICIENT');
    expect(code(() => exchangePity(m, s, 'standard', 't_natsu', NOW))).toBe('BAD_REQUEST');
  });
  it('paid-only banner refuses free coins', () => {
    const s = freshPlayer();
    grantFree(s, 5000, NOW, 'gift', 'g');
    expect(code(() => drawGacha(m, s, 'stepup_paid', 10, seededRng(1), NOW))).toBe('INSUFFICIENT_COINS');
    grantPaid(s, 1020, 1500, NOW, 'buy', 'tx');
    // step 1 of the step-up is 500 coins (REQ-GACHA-014), paid coins only
    expect(drawGacha(m, s, 'stepup_paid', 10, seededRng(1), NOW).spent).toEqual({ paid: 500, free: 0 });
  });
  it('tutorial free 10-pull works exactly once (REQ-GACHA-010)', () => {
    const s = freshPlayer();
    const r = drawGacha(m, s, 'standard', 10, seededRng(2), NOW, { tutorialFree: true });
    expect(r.results).toHaveLength(10);
    expect(s.wallet).toMatchObject({ paid: 0, free: 0 });
    expect(code(() => drawGacha(m, s, 'standard', 10, seededRng(2), NOW, { tutorialFree: true }))).toBe('TUTORIAL_GACHA_USED');
  });
  it('closed banners and insufficient coins are refused', () => {
    const s = freshPlayer();
    expect(code(() => drawGacha(m, s, 'standard', 1, seededRng(1), NOW))).toBe('INSUFFICIENT_COINS');
    const closed = { ...m, gacha: { ...m.gacha, banners: m.gacha.banners.map((b) => ({ ...b, endAtMs: NOW })) } };
    grantFree(s, 1000, NOW, 'g', 'g');
    expect(code(() => drawGacha(closed, s, 'standard', 1, seededRng(1), NOW))).toBe('BANNER_CLOSED');
  });
});

describe('comp gacha guard (REQ-GACHA-008)', () => {
  it('rejects collect-set missions that need 2+ gacha-only items', () => {
    expect(compGachaProblems([{ id: 'set', kind: 'collect', templateIds: ['t_akatsuki', 't_ginga'], reward: { freeCoins: 1 } }], m, new Set())).toHaveLength(1);
    expect(compGachaProblems([{ id: 'ok', kind: 'collect', templateIds: ['t_akatsuki', 't_ginga'], reward: { freeCoins: 1 } }], m, new Set(['t_ginga']))).toHaveLength(0);
    expect(compGachaProblems(m.progression.collectionMissions, m, new Set())).toEqual([]);
  });
});
