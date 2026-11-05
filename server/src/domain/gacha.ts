import { AppError, assert } from './errors.js';
import { templateAppearance, type Appearance } from './visuals.js';
import { PPM_TOTAL, RARITY_ORDER, type BannerDef, type CollectionMissionDef, type GachaMaster, type HorseTemplate, type Master, type PoolEntry, type Rarity } from './master.js';
import type { PlayerState } from './player.js';
import { randInt, type Rng } from './rng.js';
import { spend } from './wallet.js';
import { createHorseFromTemplate } from './horses.js';
import { hasItemDebt } from './items.js';

const rank = (r: Rarity) => RARITY_ORDER.indexOf(r);

/** REQ-GACHA-003: banner definitions are validated on load. Returns a list of problems (empty = ok). */
export function bannerProblems(b: BannerDef, m: Pick<Master, 'templateById'>, gm: Pick<GachaMaster, 'pityGroups'>): string[] {
  const p: string[] = [];
  const check = (name: string, pool: PoolEntry[]) => {
    if (pool.length === 0) p.push(`${b.id}: ${name} empty`);
    const sum = pool.reduce((a, e) => a + e.ppm, 0);
    if (sum !== PPM_TOTAL) p.push(`${b.id}: ${name} ppm sum ${sum} != ${PPM_TOTAL}`);
    const seen = new Set<string>();
    for (const e of pool) {
      if (!Number.isInteger(e.ppm) || e.ppm <= 0) p.push(`${b.id}: ${name} ${e.templateId} ppm must be a positive integer`);
      if (!m.templateById.has(e.templateId)) p.push(`${b.id}: ${name} unknown template ${e.templateId}`);
      if (seen.has(e.templateId)) p.push(`${b.id}: ${name} duplicate ${e.templateId}`);
      seen.add(e.templateId);
    }
  };
  check('pool', b.pool);
  check('guaranteePool', b.guaranteePool);
  for (const e of b.guaranteePool) {
    const t = m.templateById.get(e.templateId);
    if (t && rank(t.rarity) < rank('SR')) p.push(`${b.id}: guaranteePool contains below-SR ${e.templateId}`);
  }
  if (!(b.priceSingle > 0) || !(b.priceTen > 0)) p.push(`${b.id}: price must be > 0`);
  if (!gm.pityGroups[b.pityGroup]) p.push(`${b.id}: unknown pity group ${b.pityGroup}`);
  const g = gm.pityGroups[b.pityGroup];
  if (g?.endAtMs !== undefined && !gm.pityGroups[g.convertTo ?? 'standard']) p.push(`${b.pityGroup}: convertTo group ${g.convertTo ?? 'standard'} does not exist`);
  // A closing pity group needs every banner on it to close no later; a permanent banner would keep
  // disclosing a pity that settlePityGroups makes unreachable (review r5 #8).
  if (g?.endAtMs !== undefined && (b.endAtMs === undefined || b.endAtMs > g.endAtMs)) p.push(`${b.id}: banner outlives its pity group`);
  for (const t of b.pityTargets) if (!b.pool.some((e) => e.templateId === t)) p.push(`${b.id}: pity target ${t} not in pool`);
  return p;
}

/** Closing pity groups must convert along an acyclic chain that ends in a group that never closes. */
export function pityGroupProblems(gm: Pick<GachaMaster, 'pityGroups'>): string[] {
  const p: string[] = [];
  for (const start of Object.keys(gm.pityGroups)) {
    const seen = new Set<string>();
    let cur: string | undefined = start;
    while (cur !== undefined && gm.pityGroups[cur]?.endAtMs !== undefined) {
      if (seen.has(cur)) { p.push(`pity group ${start}: convertTo chain has a cycle`); break; }
      seen.add(cur);
      cur = gm.pityGroups[cur]!.convertTo ?? 'standard';
      if (!gm.pityGroups[cur]) break; // reported by bannerProblems
    }
  }
  return p;
}

export function validateGacha(m: Master): void {
  const problems = m.gacha.banners.flatMap((b) => bannerProblems(b, m, m.gacha));
  problems.push(...pityGroupProblems(m.gacha));
  // every banner can be paid with paid coins, so nothing in a pool counts as freely obtainable
  problems.push(...compGachaProblems(m.progression.collectionMissions, m.gacha.banners, new Set()));
  if (problems.length) throw new AppError('CONFIG_INVALID', problems.join('; '));
}

/**
 * REQ-GACHA-008 (コンプガチャ防止): a "collect a set" condition that needs 2+ items obtainable only
 * from PAID gacha is the prohibited カード合わせ. Returns problems.
 */
export function compGachaProblems(missions: CollectionMissionDef[], banners: BannerDef[], freelyObtainable: Set<string>): string[] {
  const gachaOnly = new Set<string>();
  for (const b of banners) for (const e of b.pool) if (!freelyObtainable.has(e.templateId)) gachaOnly.add(e.templateId);
  const problems: string[] = [];
  for (const mi of missions) {
    const n = mi.templateIds.filter((t) => gachaOnly.has(t)).length;
    if (n >= 2) problems.push(`${mi.id}: requires collecting ${n} gacha-only items (comp gacha is prohibited)`);
  }
  return problems;
}

const pct = (ppm: number) => `${(ppm / 10_000).toFixed(4)}%`;

/** REQ-GACHA-002: disclosure generated from the very same definition used for drawing. */
export function oddsDisclosure(m: Master, b: BannerDef, yenPerCoin = 1.6) {
  const rows = (pool: PoolEntry[]) =>
    pool.map((e) => {
      const t = m.templateById.get(e.templateId)!;
      return { templateId: t.id, name: t.name, rarity: t.rarity, ppm: e.ppm, rate: pct(e.ppm) };
    });
  const totals = (pool: PoolEntry[]) => {
    const out: Record<string, { ppm: number; rate: string }> = {};
    for (const r of RARITY_ORDER) {
      const ppm = pool.filter((e) => m.templateById.get(e.templateId)!.rarity === r).reduce((a, e) => a + e.ppm, 0);
      if (ppm > 0) out[r] = { ppm, rate: pct(ppm) };
    }
    return out;
  };
  const pityCost = m.gacha.pityGroups[b.pityGroup]!.cost;
  return {
    bannerId: b.id, name: b.name, currency: b.currency, priceSingle: b.priceSingle, priceTen: b.priceTen,
    items: rows(b.pool), rarityTotals: totals(b.pool),
    guarantee: { appliesTo: '10連の10枠目（1〜9枠目にSR以上が出なかった場合のみ、この表で抽選）', items: rows(b.guaranteePool), rarityTotals: totals(b.guaranteePool) },
    pity: { group: b.pityGroup, pullsRequired: pityCost, targets: b.pityTargets, estimatedMaxCostYen: Math.ceil(pityCost * b.priceSingle * yenPerCoin) },
    duplicates: m.gacha.duplicateMaterial,
  };
}

export function drawFromPool(pool: PoolEntry[], rng: Rng): string {
  let r = randInt(rng, PPM_TOTAL);
  for (const e of pool) {
    if (r < e.ppm) return e.templateId;
    r -= e.ppm;
  }
  throw new Error('pool does not sum to PPM_TOTAL');
}

/** appearance: the new horse's look, or the template's look for a duplicate (REQ-ASSET-006). */
export interface PullResult { templateId: string; rarity: Rarity; horseId: string | null; duplicate: boolean; material: number; guaranteed: boolean; appearance: Appearance | null }

export function findBanner(m: Master, id: string): BannerDef {
  const b = m.gacha.banners.find((x) => x.id === id);
  if (!b) throw new AppError('NOT_FOUND', `banner ${id}`);
  return b;
}

function grantPull(m: Master, s: PlayerState, tpl: HorseTemplate, now: number, guaranteed: boolean): PullResult {
  const owned = s.horses.some((h) => h.templateId === tpl.id);
  if (owned) {
    const material = m.gacha.duplicateMaterial[tpl.rarity];
    s.materials.awakening += material;
    return { templateId: tpl.id, rarity: tpl.rarity, horseId: null, duplicate: true, material, guaranteed, appearance: templateAppearance(tpl.id) };
  }
  const h = createHorseFromTemplate(s, tpl, now);
  return { templateId: tpl.id, rarity: tpl.rarity, horseId: h.id, duplicate: false, material: 0, guaranteed, appearance: h.appearance ?? null };
}

/** The pull itself (no payment). 10-pull: slot 10 uses the guarantee table if slots 1-9 had no SR+. */
export function rollPulls(m: Master, b: BannerDef, count: 1 | 10, rng: Rng): { templateId: string; guaranteed: boolean }[] {
  const out: { templateId: string; guaranteed: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    const last = count === 10 && i === 9;
    const hasSrPlus = out.some((o) => rank(m.templateById.get(o.templateId)!.rarity) >= rank('SR'));
    if (last && !hasSrPlus) out.push({ templateId: drawFromPool(b.guaranteePool, rng), guaranteed: true });
    else out.push({ templateId: drawFromPool(b.pool, rng), guaranteed: false });
  }
  return out;
}

/**
 * REQ-GACHA-004..010. Must be called on a draft state inside a transaction (all-or-nothing, REQ-GACHA-009).
 */
export function drawGacha(m: Master, s: PlayerState, bannerId: string, count: 1 | 10, rng: Rng, now: number, opts: { tutorialFree?: boolean } = {}) {
  const b = findBanner(m, bannerId);
  assert(count === 1 || count === 10, 'BAD_REQUEST', 'count must be 1 or 10');
  if ((b.startAtMs !== undefined && now < b.startAtMs) || (b.endAtMs !== undefined && now >= b.endAtMs)) throw new AppError('BANNER_CLOSED');
  if (s.wallet.debt > 0) throw new AppError('UNSETTLED_DEBT');
  let paid = { paid: 0, free: 0 };
  if (opts.tutorialFree) {
    if (s.flags.tutorialGachaUsed) throw new AppError('TUTORIAL_GACHA_USED');
    assert(count === 10, 'BAD_REQUEST', 'tutorial gacha is a 10-pull');
    s.flags.tutorialGachaUsed = true;
  } else {
    const price = count === 10 ? b.priceTen : b.priceSingle;
    paid = spend(s, price, { paidOnly: b.currency === 'paidOnly' }, now, `gacha ${b.id} x${count}`, b.id);
  }
  const rolls = rollPulls(m, b, count, rng);
  const results = rolls.map((r) => grantPull(m, s, m.templateById.get(r.templateId)!, now, r.guaranteed));
  s.pity[b.pityGroup] = (s.pity[b.pityGroup] ?? 0) + count;
  return { bannerId: b.id, results, spent: paid, pityPoints: s.pity[b.pityGroup]! };
}

/** REQ-GACHA-005: exchange pity points for a target. */
export function exchangePity(m: Master, s: PlayerState, bannerId: string, templateId: string, now: number) {
  const b = findBanner(m, bannerId);
  // exchange only through an open banner (bug review #13); closed groups were converted by settlePityGroups
  if ((b.startAtMs !== undefined && now < b.startAtMs) || (b.endAtMs !== undefined && now >= b.endAtMs)) throw new AppError('BANNER_CLOSED');
  // pity earned by pulls that were later refunded must not be cashed in while that debt is open (review r5)
  if (s.wallet.debt > 0 || hasItemDebt(s)) throw new AppError('UNSETTLED_DEBT');
  if (!b.pityTargets.includes(templateId)) throw new AppError('BAD_REQUEST', 'not an exchange target');
  const cost = m.gacha.pityGroups[b.pityGroup]!.cost;
  const have = s.pity[b.pityGroup] ?? 0;
  if (have < cost) throw new AppError('PITY_INSUFFICIENT', `${have}/${cost}`);
  s.pity[b.pityGroup] = have - cost;
  return grantPull(m, s, m.templateById.get(templateId)!, now, false);
}

/** Apply period-end conversion for every closed pity group (idempotent; run on every player transaction). */
export function settlePityGroups(m: Master, s: PlayerState, now: number): number {
  let moved = 0;
  for (const [id, g] of Object.entries(m.gacha.pityGroups)) {
    if (g.endAtMs !== undefined && now >= g.endAtMs) moved += convertPityGroup(s, id, g.convertTo ?? 'standard');
  }
  return moved;
}

/** End of a limited period: carry pity points of a closed group into another group (default policy). */
export function convertPityGroup(s: PlayerState, fromGroup: string, toGroup: string) {
  const n = s.pity[fromGroup] ?? 0;
  if (n > 0) {
    s.pity[toGroup] = (s.pity[toGroup] ?? 0) + n;
    s.pity[fromGroup] = 0;
  }
  return n;
}
