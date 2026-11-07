// REQ-SHORT-010 (Round 11 gap): the 2+ rule of the "collect" missions (beginner / season / collection) must count every
// paid random source — the starter pack's SR以上確定券 table too, not only banner pools — through the one helper.
import { describe, expect, it } from 'vitest';
import { compGachaProblems, validateGacha } from '../src/domain/gacha.js';
import { gachaObtainable } from '../src/domain/collection.js';
import { paidRandomTemplates } from '../src/domain/paidRandom.js';
import type { BannerDef, Master } from '../src/domain/master.js';
import { m } from './helpers.js';

const SR_ONLY_IN_TICKET = ['t_harukaze', 't_kurogane'];
/** Banners whose tables leave out two SR horses: those two now come only from the SR+ ticket (sold in the starter pack). */
function withoutInBanners(ids: string[]): BannerDef[] {
  const strip = (pool: BannerDef['pool']) => {
    const kept = pool.filter((e) => !ids.includes(e.templateId));
    const lost = pool.filter((e) => ids.includes(e.templateId)).reduce((a, e) => a + e.ppm, 0);
    return kept.map((e, i) => (i === 0 ? { ...e, ppm: e.ppm + lost } : e));
  };
  return m.gacha.banners.map((b) => ({
    ...b, pool: strip(b.pool), guaranteePool: strip(b.guaranteePool), pityTargets: b.pityTargets.filter((t) => !ids.includes(t)),
    ...(b.stepUp ? { stepUp: { ...b.stepUp, steps: b.stepUp.steps.map((st) => ({ ...st, ...(st.finalSlotPool ? { finalSlotPool: strip(st.finalSlotPool) } : {}) })) } } : {}),
  }));
}

describe('comp gacha: every paid random source (REQ-SHORT-010)', () => {
  const banners = withoutInBanners(SR_ONLY_IN_TICKET);
  const src = { ...m, gacha: { ...m.gacha, banners } } as Master;

  it('the starter pack ticket table counts as a paid random source', () => {
    for (const b of banners) for (const e of b.pool) expect(SR_ONLY_IN_TICKET).not.toContain(e.templateId);
    const set = paidRandomTemplates(src);
    for (const t of SR_ONLY_IN_TICKET) expect(set.has(t)).toBe(true);
    expect(compGachaProblems([{ id: 'set', kind: 'collect', templateIds: SR_ONLY_IN_TICKET, reward: { freeCoins: 10 } }], src, new Set())).toHaveLength(1);
  });

  it('a beginner or season collect mission of two ticket-only horses is refused at boot / remote config', () => {
    const bm = { ...src, progression: { ...m.progression, beginnerMissions: [...(m.progression.beginnerMissions ?? []), { id: 'bm_pair', kind: 'collect', target: 2, templateIds: SR_ONLY_IN_TICKET, reward: { freeCoins: 10 } }] } } as unknown as Master;
    expect(() => validateGacha(bm)).toThrow(/bm_pair: requires collecting 2 gacha-only items/);
    const sm = { ...src, progression: { ...m.progression, seasonMissions: [...(m.progression.seasonMissions ?? []), { id: 'sm_pair', kind: 'collect', target: 2, templateIds: SR_ONLY_IN_TICKET, reward: { freeCoins: 10 } }] } } as unknown as Master;
    expect(() => validateGacha(sm)).toThrow(/sm_pair: requires collecting 2 gacha-only items/);
  });

  it('the 図鑑・実績 list and the mission list are the same function', () => {
    expect([...gachaObtainable(m).templates].sort()).toEqual([...paidRandomTemplates(m)].sort());
    expect([...gachaObtainable(src).templates].sort()).toEqual([...paidRandomTemplates(src)].sort());
    // gift-only horses (the first partner) are never a paid random result
    expect(paidRandomTemplates(m).has('t_partner')).toBe(false);
  });

  it('the shipped master passes', () => {
    expect(() => validateGacha(m)).not.toThrow();
  });
});
