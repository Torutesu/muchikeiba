import { AppError, assert } from './errors.js';
import { collectionRewardProblems } from './collection.js';
import { paidRandomTemplates, type PaidRandomSource } from './paidRandom.js';
import { templateAppearance, type Appearance } from './visuals.js';
import { dayRule, gameDayKey, gameDaysUntil } from './time.js';
import { PPM_TOTAL, RARITY_ORDER, type BannerDef, type CollectionMissionDef, type GachaMaster, type HorseTemplate, type Master, type PoolEntry, type Rarity } from './master.js';
import type { PlayerState } from './player.js';
import { randInt, type Rng } from './rng.js';
import { spend } from './wallet.js';
import { createHorseFromTemplate } from './horses.js';
import { hasItemDebt } from './items.js';
import { skillSummary, templateSkill } from './skills.js';

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
      // REQ-UXS-002: the first partner / gift horses are never drawable (remote config can list explicit pools)
      if (m.templateById.get(e.templateId)?.giftOnly) p.push(`${b.id}: ${name} contains gift-only ${e.templateId}`);
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
  // REQ-BREED-020: a seasonal horse is offered only by a banner that runs inside its window, on a closing pity group
  for (const e of [...b.pool, ...b.guaranteePool]) {
    const se = m.templateById.get(e.templateId)?.seasonal;
    if (!se) continue;
    if (b.startAtMs === undefined || b.endAtMs === undefined || b.startAtMs < se.startAtMs || b.endAtMs > se.endAtMs) p.push(`${b.id}: seasonal ${e.templateId} offered outside its window`);
    if (g && g.endAtMs === undefined) p.push(`${b.id}: seasonal banner needs a closing pity group`);
  }
  // REQ-GACHA-011: a schedule that can actually run, announced no later than it opens
  if (b.startAtMs !== undefined && b.endAtMs !== undefined && b.startAtMs >= b.endAtMs) p.push(`${b.id}: starts at or after its end`);
  if (b.announceAtMs !== undefined && (b.startAtMs === undefined || b.announceAtMs > b.startAtMs)) p.push(`${b.id}: announced after it opens`);
  if (b.pickupTemplateId !== undefined && !b.pool.some((e) => e.templateId === b.pickupTemplateId)) p.push(`${b.id}: pickup ${b.pickupTemplateId} not in pool`);
  // REQ-GACHA-014: every step has a price and, when it has one, a valid SR+ slot-10 table
  if (b.stepUp) {
    if (b.stepUp.steps.length === 0) p.push(`${b.id}: step-up without steps`);
    b.stepUp.steps.forEach((st, i) => {
      if (!Number.isInteger(st.priceTen) || st.priceTen <= 0) p.push(`${b.id}: step ${i + 1} price must be > 0`);
      if (st.finalSlotPool) {
        check(`step ${i + 1} finalSlotPool`, st.finalSlotPool);
        for (const e of st.finalSlotPool) {
          const t = m.templateById.get(e.templateId);
          if (t && rank(t.rarity) < rank('SR')) p.push(`${b.id}: step ${i + 1} finalSlotPool contains below-SR ${e.templateId}`);
        }
      }
    });
  }
  return p;
}

/**
 * REQ-GACHA-012/013: pity points must stay usable. A group whose banners all close must close itself exactly when the
 * last of them does (no window where points exist but cannot be exchanged), and a group that never closes needs a
 * banner that never closes. Closing groups convert, they never expire (pityGroupProblems checks the chain).
 */
export function pityScheduleProblems(gm: Pick<GachaMaster, 'pityGroups' | 'banners'>): string[] {
  const p: string[] = [];
  for (const [id, g] of Object.entries(gm.pityGroups)) {
    const bs = gm.banners.filter((b) => b.pityGroup === id);
    const permanent = bs.some((b) => b.endAtMs === undefined);
    if (g.endAtMs === undefined) {
      if (!permanent) p.push(`pity group ${id}: never closes but has no permanent banner (points could not be exchanged); give it an end`);
    } else if (bs.length > 0 && !permanent) {
      const last = Math.max(...bs.map((b) => b.endAtMs!));
      if (g.endAtMs > last) p.push(`pity group ${id}: closes after its last banner (points unusable in between)`);
    }
  }
  // the tutorial 10-pull and every conversion end on the permanent standard banner
  const std = gm.banners.find((b) => b.id === 'standard');
  if (!std) p.push('gacha: banner standard is required');
  else if (std.startAtMs !== undefined || std.endAtMs !== undefined) p.push('gacha: banner standard must be permanent');
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
  problems.push(...pityScheduleProblems(m.gacha));
  // REQ-GACHA-014: a ticket draw would skip the step price, so step-up banners take no tickets
  for (const [id, t] of Object.entries(m.items?.tickets ?? {})) {
    if (t.kind !== 'single' && t.kind !== 'ten') continue;
    for (const bid of t.banners) if (m.gacha.banners.find((b) => b.id === bid)?.stepUp) problems.push(`${id}: step-up banner ${bid} cannot take tickets`);
  }
  // every paid random source counts (paidRandomTemplates: banners, tickets incl. the starter pack's SR+ ticket …)
  const collects = [...(m.progression.beginnerMissions ?? []), ...(m.progression.seasonMissions ?? [])]
    .filter((d) => d.kind === 'collect').map((d) => ({ id: d.id, kind: 'collect' as const, templateIds: d.templateIds ?? [], reward: d.reward }));
  problems.push(...compGachaProblems([...m.progression.collectionMissions, ...collects], m, new Set()));
  // REQ-ACH-008: 図鑑・実績 — no reward for a set that contains a gacha-obtainable horse or skill (re-checked on every banner change)
  problems.push(...collectionRewardProblems(m));
  if (problems.length) throw new AppError('CONFIG_INVALID', problems.join('; '));
}

/**
 * REQ-GACHA-008 (コンプガチャ防止): a "collect a set" condition that needs 2+ items obtainable only
 * from PAID random draws is the prohibited カード合わせ. Returns problems. The paid random sources are
 * paidRandomTemplates(src) — the same list the 図鑑・実績 check uses (REQ-SHORT-010), never a list of its own.
 */
export function compGachaProblems(missions: CollectionMissionDef[], src: PaidRandomSource, freelyObtainable: Set<string>): string[] {
  const gachaOnly = new Set([...paidRandomTemplates(src)].filter((t) => !freelyObtainable.has(t)));
  const problems: string[] = [];
  for (const mi of missions) {
    const n = mi.templateIds.filter((t) => gachaOnly.has(t)).length;
    if (n >= 2) problems.push(`${mi.id}: requires collecting ${n} gacha-only items (comp gacha is prohibited)`);
  }
  return problems;
}

/**
 * QA r9 (景表法・ガチャ表示): what a banner may be bought for. A step-up banner sells only step 10-pulls at the step
 * prices (stepUp.prices / steps[].priceTen), so its flat priceSingle / priceTen are not shown as usable prices.
 */
const shownPrices = (b: BannerDef) => b.stepUp
  ? { singleAllowed: false as const, priceSingle: null, priceTen: null }
  : { singleAllowed: true as const, priceSingle: b.priceSingle, priceTen: b.priceTen };

const pct = (ppm: number) => `${(ppm / 10_000).toFixed(4)}%`;

/** REQ-GACHA-002: disclosure generated from the very same definition used for drawing. */
export function oddsDisclosure(m: Master, b: BannerDef, yenPerCoin = 1.6) {
  const rows = (pool: PoolEntry[]) =>
    pool.map((e) => {
      const t = m.templateById.get(e.templateId)!;
      const row: { templateId: string; name: string; rarity: Rarity; ppm: number; rate: string; limited?: { seasonId: string; label: string; endAtMs: number }; skill?: ReturnType<typeof skillSummary> } = { templateId: t.id, name: t.name, rarity: t.rarity, ppm: e.ppm, rate: pct(e.ppm) };
      if (t.seasonal) row.limited = { seasonId: t.seasonal.seasonId, label: t.seasonal.label, endAtMs: t.seasonal.endAtMs };
      // REQ-UXS-050: the horse's unique skill, display only (the ppm above come from the drawing table alone)
      const sk = skillSummary(m, templateSkill(m, t));
      if (sk) row.skill = sk;
      return row;
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
  const carry = carryOverRule(m, b.pityGroup);
  const pickRow = (pool: PoolEntry[]) => pool.find((e) => e.templateId === b.pickupTemplateId);
  const pk = b.pickupTemplateId ? pickRow(b.pool) : undefined;
  const pkG = b.pickupTemplateId ? pickRow(b.guaranteePool) : undefined;
  const pkT = b.pickupTemplateId ? m.templateById.get(b.pickupTemplateId) : undefined;
  // REQ-GACHA-014: the price of every 10-pull on the way to the pity, from the step definitions
  const pityCostCoins = b.stepUp ? stepUpCoins(b, 0, Math.ceil(pityCost / 10)) : tenAndSingles(b, pityCost);
  return {
    bannerId: b.id, name: b.name, currency: b.currency, ...shownPrices(b),
    period: { startAtMs: b.startAtMs ?? null, endAtMs: b.endAtMs ?? null, lastDay: b.endAtMs !== undefined ? gameDayKey(b.endAtMs - 1, dayRule(m)) : null },
    // REQ-BREED-021: limited horses are marked per row; owned ones stay owned after the period
    limitedNotice: isLimited(m, b) ? `季節限定の馬は期間終了後この表から外れます。入手済みの馬はそのまま所持・出走・種付けできます。${carry ? `天井の交換ptは期間終了時に「${carry.toLabel}」の交換ptへ1:1で移ります（失効しません）。` : ''}` : null,
    items: rows(b.pool), rarityTotals: totals(b.pool),
    // REQ-GACHA-015: the featured horse's own rate, read from the same rows (never a multiplier or a comparison)
    pickup: pk && pkT ? { templateId: pkT.id, name: pkT.name, rarity: pkT.rarity, ppm: pk.ppm, rate: pct(pk.ppm), guaranteePpm: pkG?.ppm ?? 0, guaranteeRate: pct(pkG?.ppm ?? 0) } : null,
    guarantee: { appliesTo: '10連の10枠目（1〜9枠目にSR以上が出なかった場合のみ、この表で抽選）', items: rows(b.guaranteePool), rarityTotals: totals(b.guaranteePool) },
    stepUp: b.stepUp ? {
      afterLast: b.stepUp.afterLast,
      notice: `10連のみ。1回引くごとに次のステップへ進みます。${b.stepUp.afterLast === 'loop' ? `ステップ${b.stepUp.steps.length}の次はステップ1に戻ります。` : `ステップ${b.stepUp.steps.length}の後はステップ${b.stepUp.steps.length}を繰り返します。`}1〜9枠目は上の表で抽選します。10枠目の抽選の仕方はステップごとに下に書いています。`,
      steps: b.stepUp.steps.map((st, i) => ({
        step: i + 1, priceTen: st.priceTen,
        finalSlot: st.finalSlotPool
          ? { appliesTo: `ステップ${i + 1}の10枠目（必ずこの表で抽選）`, items: rows(st.finalSlotPool), rarityTotals: totals(st.finalSlotPool) }
          : { appliesTo: `ステップ${i + 1}の10枠目（1〜9枠目にSR以上が出なかった場合は上の保証の表、それ以外は上の表で抽選）`, items: null, rarityTotals: null },
      })),
    } : null,
    pity: {
      group: b.pityGroup, label: pityLabel(m, b.pityGroup), pullsRequired: pityCost, targets: b.pityTargets,
      costCoins: pityCostCoins, estimatedMaxCostYen: Math.ceil(pityCostCoins * yenPerCoin),
      closesAtMs: m.gacha.pityGroups[b.pityGroup]!.endAtMs ?? null, carryOver: carry,
    },
    duplicates: m.gacha.duplicateMaterial,
    // REQ-ITEM-001: tickets usable on this banner draw from this very table (one definition, REQ-GACHA-002)
    tickets: Object.entries(m.items?.tickets ?? {}).filter(([, t]) => (t.kind === 'single' || t.kind === 'ten') && t.banners.includes(b.id)).map(([id, t]) => ({
      itemId: id, name: t.name,
      notice: t.kind === 'ten' ? '券1枚で10連1回（10枠目は上の保証の表）。この提供割合と同じ表で抽選し、天井ポイントも10回分加算' : '券1枚で1回。この提供割合と同じ表で抽選し、天井ポイントも1回分加算',
    })),
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

export function grantPull(m: Master, s: PlayerState, tpl: HorseTemplate, now: number, guaranteed: boolean): PullResult {
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
export function rollPulls(m: Master, b: BannerDef, count: 1 | 10, rng: Rng, finalSlotPool?: PoolEntry[]): { templateId: string; guaranteed: boolean }[] {
  const out: { templateId: string; guaranteed: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    const last = count === 10 && i === 9;
    const hasSrPlus = out.some((o) => rank(m.templateById.get(o.templateId)!.rarity) >= rank('SR'));
    // REQ-GACHA-014: a step's own slot-10 table applies unconditionally (SR+ only, so REQ-GACHA-004 still holds)
    if (last && finalSlotPool) out.push({ templateId: drawFromPool(finalSlotPool, rng), guaranteed: true });
    else if (last && !hasSrPlus) out.push({ templateId: drawFromPool(b.guaranteePool, rng), guaranteed: true });
    else out.push({ templateId: drawFromPool(b.pool, rng), guaranteed: false });
  }
  return out;
}

/**
 * What the next pull of `count` on this banner costs this player (REQ-GACHA-014: a step-up banner charges its current
 * step's 10-pull price). The draw and the shortfall preview (REQ-SHORT-005) both use it.
 */
export function gachaPrice(b: BannerDef, s: PlayerState, count: 1 | 10): number {
  if (b.stepUp) return b.stepUp.steps[stepIndex(b, s.stepUp?.[b.id] ?? 0)]!.priceTen;
  return count === 10 ? b.priceTen : b.priceSingle;
}

/**
 * REQ-GACHA-004..010. Must be called on a draft state inside a transaction (all-or-nothing, REQ-GACHA-009).
 */
export function drawGacha(m: Master, s: PlayerState, bannerId: string, count: 1 | 10, rng: Rng, now: number, opts: { tutorialFree?: boolean } = {}) {
  const b = findBanner(m, bannerId);
  assert(count === 1 || count === 10, 'BAD_REQUEST', 'count must be 1 or 10');
  // REQ-GACHA-011: decided by the server clock of this transaction (open until endAtMs − 1 ms, closed from endAtMs)
  assertBannerOpen(b, now);
  if (s.wallet.debt > 0) throw new AppError('UNSETTLED_DEBT');
  // REQ-GACHA-014: step-up banners draw 10 at a time at the price of the current step
  const step = b.stepUp ? stepIndex(b, s.stepUp?.[b.id] ?? 0) : null;
  if (b.stepUp) {
    assert(count === 10, 'BAD_REQUEST', 'step-up banners draw 10 at a time');
    assert(!opts.tutorialFree, 'BAD_REQUEST', 'the tutorial draw is on the standard banner');
  }
  let paid = { paid: 0, free: 0 };
  if (opts.tutorialFree) {
    if (s.flags.tutorialGachaUsed) throw new AppError('TUTORIAL_GACHA_USED');
    assert(count === 10, 'BAD_REQUEST', 'tutorial gacha is a 10-pull');
    s.flags.tutorialGachaUsed = true;
  } else {
    const price = gachaPrice(b, s, count);
    paid = spend(s, price, { paidOnly: b.currency === 'paidOnly' }, now, `gacha ${b.id} x${count}${step !== null ? ` step ${step + 1}` : ''}`, b.id);
  }
  const finalSlot = step !== null ? b.stepUp!.steps[step]!.finalSlotPool : undefined;
  const rolls = rollPulls(m, b, count, rng, finalSlot);
  const results = rolls.map((r) => grantPull(m, s, m.templateById.get(r.templateId)!, now, r.guaranteed));
  s.pity[b.pityGroup] = (s.pity[b.pityGroup] ?? 0) + count;
  const out: DrawOutcome = { bannerId: b.id, results, spent: paid, pityPoints: s.pity[b.pityGroup]! };
  if (step !== null) {
    const done = (s.stepUp?.[b.id] ?? 0) + 1;
    s.stepUp = { ...(s.stepUp ?? {}), [b.id]: done };
    out.stepUp = { drawnStep: step + 1, next: stepUpProgress(m, b, done)! };
  }
  return out;
}

export interface DrawOutcome {
  bannerId: string; results: PullResult[]; spent: { paid: number; free: number }; pityPoints: number;
  /** REQ-GACHA-014: the step just drawn (1-based) and where the next 10-pull stands. */
  stepUp?: { drawnStep: number; next: NonNullable<ReturnType<typeof stepUpProgress>> };
}

// ------------------------------------------------------------------ schedule (REQ-GACHA-011)

export type BannerStatus = 'hidden' | 'upcoming' | 'active' | 'ended';

/** Server time decides: open from startAtMs (inclusive) to endAtMs (exclusive); listed as upcoming from announceAtMs. */
export function bannerStatus(b: BannerDef, now: number): BannerStatus {
  if (b.endAtMs !== undefined && now >= b.endAtMs) return 'ended';
  if (b.startAtMs !== undefined && now < b.startAtMs) return b.announceAtMs !== undefined && now >= b.announceAtMs ? 'upcoming' : 'hidden';
  return 'active';
}

const JST_MS = 9 * 3600 * 1000;
/** The exact instant in JST, e.g. "2026-12-01 00:00 JST". */
export function jstClock(ms: number): string {
  const d = new Date(ms + JST_MS).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)} JST`;
}

/** Refuses pulls, tickets and exchanges outside the open period, with the reason (decided by the server clock of the transaction). */
export function assertBannerOpen(b: BannerDef, now: number): void {
  const st = bannerStatus(b, now);
  if (st === 'ended') throw new AppError('BANNER_CLOSED', `banner ${b.id} ended at ${jstClock(b.endAtMs!)}`);
  if (st === 'upcoming') throw new AppError('BANNER_CLOSED', `banner ${b.id} opens at ${jstClock(b.startAtMs!)}`);
  if (st === 'hidden') throw new AppError('BANNER_CLOSED', `banner ${b.id} is not open`);
}

/** Public lookup: an unannounced banner does not exist yet (its schedule is not leaked). */
export function findVisibleBanner(m: Master, id: string, now: number): BannerDef {
  const b = findBanner(m, id);
  if (bannerStatus(b, now) === 'hidden') throw new AppError('NOT_FOUND', `banner ${id}`);
  return b;
}

const isLimited = (m: Master, b: BannerDef) => b.pool.some((e) => m.templateById.get(e.templateId)?.seasonal);

/**
 * GET /v1/gacha/banners: active and announced banners only, sorted: banners that end (soonest first), then permanent ones
 * (master order, the standard banner last), then upcoming ones (soonest start first). Times are the real schedule; the
 * client counts down to `endAtMs` against `serverNowMs` and shows no timer for a permanent banner (06 §5.5 偽の急かし).
 */
export function bannerList(m: Master, now: number) {
  const order = new Map(m.gacha.banners.map((b, i) => [b.id, i]));
  const visible = m.gacha.banners.map((b) => ({ b, st: bannerStatus(b, now) })).filter((x) => x.st === 'active' || x.st === 'upcoming');
  const key = (x: { b: BannerDef; st: BannerStatus }): [number, number, number] => {
    if (x.st === 'upcoming') return [2, x.b.startAtMs!, order.get(x.b.id)!];
    if (x.b.endAtMs !== undefined) return [0, x.b.endAtMs, order.get(x.b.id)!];
    return [1, x.b.id === 'standard' ? 1 : 0, order.get(x.b.id)!];
  };
  visible.sort((a, c) => { const ka = key(a), kc = key(c); return ka[0] - kc[0] || ka[1] - kc[1] || ka[2] - kc[2]; });
  return {
    serverNowMs: now,
    banners: visible.map(({ b, st }) => {
      const pk = b.pickupTemplateId ? m.templateById.get(b.pickupTemplateId) : undefined;
      return {
        id: b.id, name: b.name, currency: b.currency, ...shownPrices(b),
        status: st as 'active' | 'upcoming',
        startAtMs: b.startAtMs ?? null, endAtMs: b.endAtMs ?? null, announceAtMs: b.announceAtMs ?? null,
        /** The last game day the banner is open ("2026-11-30"), null when permanent. */
        lastDay: b.endAtMs !== undefined ? gameDayKey(b.endAtMs - 1, dayRule(m)) : null,
        /** Game days left counting today (REQ-UXS-011), null when permanent or not open yet. */
        daysLeft: st === 'active' && b.endAtMs !== undefined ? gameDaysUntil(b.endAtMs, now, dayRule(m)) : null,
        pityGroup: b.pityGroup, pityLabel: pityLabel(m, b.pityGroup), pityCost: m.gacha.pityGroups[b.pityGroup]!.cost, pityTargets: b.pityTargets,
        pickup: pk ? { templateId: pk.id, name: pk.name, rarity: pk.rarity } : null,
        limited: isLimited(m, b),
        stepUp: b.stepUp ? { steps: b.stepUp.steps.length, afterLast: b.stepUp.afterLast, prices: b.stepUp.steps.map((x) => x.priceTen), finalSlotSteps: b.stepUp.steps.flatMap((x, i) => (x.finalSlotPool ? [i + 1] : [])) } : null,
      };
    }),
  };
}

// ------------------------------------------------------------------ pity and step-up display (REQ-GACHA-012..014)

export function pityLabel(m: Master, group: string): string { return m.gacha.pityGroups[group]?.label ?? group; }

/** Where a closing group's points end up (follows the convertTo chain to the group that never closes). */
export function finalPityGroup(m: Master, group: string): string {
  let cur = group;
  for (let i = 0; i < 16; i++) {
    const g = m.gacha.pityGroups[cur];
    if (!g || g.endAtMs === undefined) return cur;
    cur = g.convertTo ?? 'standard';
  }
  return cur;
}

/**
 * REQ-GACHA-013 carry-over rule, generated from data: at the close of a limited group the leftover points move 1:1 into
 * the group it converts to (they never expire and are never lost) and can be exchanged there for that group's targets —
 * a non-random exchange, like the 交換pt carry-over common in Japanese games. Null for a group that never closes.
 */
export function carryOverRule(m: Master, group: string) {
  const g = m.gacha.pityGroups[group];
  if (!g || g.endAtMs === undefined) return null;
  const to = finalPityGroup(m, group);
  const targets = [...new Set(m.gacha.banners.filter((b) => b.pityGroup === to && b.endAtMs === undefined).flatMap((b) => b.pityTargets))];
  const name = (id: string) => m.templateById.get(id)?.name ?? id;
  const toLabel = pityLabel(m, to);
  return {
    atMs: g.endAtMs, toGroup: to, toLabel, rate: '1:1' as const, expires: false,
    toTargets: targets.map((id) => ({ templateId: id, name: name(id) })),
    notice: `${jstClock(g.endAtMs)}に、残っている交換ptはすべて「${toLabel}」の交換ptへ1:1で移ります。失効しません。移った後は${targets.map(name).join('・')}のどれかと交換できます（抽選ではありません）。`,
  };
}

/** Cheapest coins for `pulls` pulls on a plain banner (10-pulls first, then singles). */
function tenAndSingles(b: BannerDef, pulls: number): number {
  if (pulls <= 0) return 0;
  return Math.floor(pulls / 10) * b.priceTen + (pulls % 10) * b.priceSingle;
}

/** Index of the step a player who completed `completed` step-up draws is on. */
export function stepIndex(b: BannerDef, completed: number): number {
  const n = b.stepUp!.steps.length;
  if (completed < n) return completed;
  return b.stepUp!.afterLast === 'loop' ? completed % n : n - 1;
}

/** Coins of the next `draws` step-up 10-pulls from progress `completed`. */
export function stepUpCoins(b: BannerDef, completed: number, draws: number): number {
  let sum = 0;
  for (let i = 0; i < draws; i++) sum += b.stepUp!.steps[stepIndex(b, completed + i)]!.priceTen;
  return sum;
}

/** The lowest rarity a slot-10 table can give ("SSR" for an SSR-only table), read from the table itself. */
function minRarity(m: Master, pool: PoolEntry[]): Rarity {
  return pool.map((e) => m.templateById.get(e.templateId)?.rarity ?? 'R').reduce((a, r) => (rank(r) < rank(a) ? r : a), 'SSR' as Rarity);
}

export function stepUpProgress(m: Master, b: BannerDef, completed: number) {
  if (!b.stepUp) return null;
  const n = b.stepUp.steps.length;
  const idx = stepIndex(b, completed);
  const st = b.stepUp.steps[idx]!;
  return {
    completed, steps: n, afterLast: b.stepUp.afterLast,
    /** 1-based step the next 10-pull is on. */
    step: idx + 1,
    /** 1-based round of a looping step-up. */
    round: b.stepUp.afterLast === 'loop' ? Math.floor(completed / n) + 1 : 1,
    priceTen: st.priceTen,
    /** Slot 10 of this step is always from its own table, at least this rarity (null: the usual SR+ guarantee). */
    finalSlotMinRarity: st.finalSlotPool ? minRarity(m, st.finalSlotPool) : null,
  };
}

/**
 * Per-player pity meter (GET /v1/gacha/status): points of every group that has points or an open banner, after the
 * period-end conversion that the next transaction would apply, the pulls and coins still needed on each open banner,
 * where the points go when a group closes, and step-up progress.
 */
export function gachaStatus(m: Master, s0: PlayerState, now: number) {
  const s = { pity: { ...s0.pity } } as PlayerState;
  settlePityGroups(m, s, now);
  const open = m.gacha.banners.filter((b) => bannerStatus(b, now) === 'active');
  const groupIds = Object.keys(m.gacha.pityGroups).filter((g) => (s.pity[g] ?? 0) > 0 || open.some((b) => b.pityGroup === g));
  const name = (id: string) => m.templateById.get(id)?.name ?? id;
  const groups = groupIds.map((g) => {
    const def = m.gacha.pityGroups[g]!;
    const points = s.pity[g] ?? 0;
    const bs = open.filter((b) => b.pityGroup === g);
    const targets = [...new Set(bs.flatMap((b) => b.pityTargets))];
    return {
      group: g, label: pityLabel(m, g), points, cost: def.cost,
      remaining: Math.max(0, def.cost - points),
      /** Exchanges possible right now (needs an open banner on the group). */
      exchangeable: bs.length > 0 ? Math.floor(points / def.cost) : 0,
      banners: bs.map((b) => b.id),
      targets: targets.map((id) => ({ templateId: id, name: name(id), owned: s0.horses.some((h) => h.templateId === id) })),
      closesAtMs: def.endAtMs ?? null,
      carryOver: carryOverRule(m, g),
    };
  });
  const banners = open.map((b) => {
    const cost = m.gacha.pityGroups[b.pityGroup]!.cost;
    const points = s.pity[b.pityGroup] ?? 0;
    const remaining = Math.max(0, cost - points);
    const completed = s0.stepUp?.[b.id] ?? 0;
    return {
      bannerId: b.id, pityGroup: b.pityGroup, points, cost, remaining,
      /** Coins of the cheapest way to reach the exchange on this banner (step prices for a step-up). */
      coinsToExchange: b.stepUp ? stepUpCoins(b, completed, Math.ceil(remaining / 10)) : tenAndSingles(b, remaining),
      stepUp: stepUpProgress(m, b, completed),
    };
  });
  return { serverNowMs: now, groups, banners };
}

/** REQ-GACHA-005: exchange pity points for a target. */
export function exchangePity(m: Master, s: PlayerState, bannerId: string, templateId: string, now: number) {
  const b = findBanner(m, bannerId);
  // exchange only through an open banner (bug review #13); closed groups were converted by settlePityGroups
  assertBannerOpen(b, now);
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
  // follow the chain to the first group still open at `now` (QA r9: one pass in master order could leave points in a
  // closed group that converts later in the iteration order)
  const target = (id: string): string => {
    let cur = id;
    for (let i = 0; i < 16; i++) {
      const g = m.gacha.pityGroups[cur];
      if (!g || g.endAtMs === undefined || now < g.endAtMs) return cur;
      cur = g.convertTo ?? 'standard';
    }
    return cur;
  };
  for (const [id, g] of Object.entries(m.gacha.pityGroups)) {
    if (g.endAtMs !== undefined && now >= g.endAtMs) moved += convertPityGroup(s, id, target(id));
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
