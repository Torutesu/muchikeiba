import { AppError } from './errors.js';
import { expandPool, PPM_TOTAL, RARITY_ORDER, TACK_SLOTS, type CosmeticDef, type Master, type PoolEntry, type Rarity, type TackSlot } from './master.js';
import type { Equipment, PlayerState } from './player.js';
import { assertBannerOpen, drawFromPool, findBanner, grantPull, rollPulls, type PullResult } from './gacha.js';
import { addItems, consumeItem, logItem } from './items.js';
import { spend } from './wallet.js';
import { ASSET_KEY_RE, assetKeys, VISUALS, type VisualsMaster } from './visuals.js';
import type { Rng } from './rng.js';

/**
 * REQ-ITEM-*: what the tickets and materials handed out by rewards are good for, and the cosmetics
 * shop. Nothing here changes race stats, so ranked fairness (REQ-RATE-003) is untouched.
 */

const pct = (ppm: number) => `${(ppm / 10_000).toFixed(4)}%`;
const rank = (r: Rarity) => RARITY_ORDER.indexOf(r);
const srPlusCache = new WeakMap<Master, Map<string, PoolEntry[]>>();

/** The draw table of a guaranteed-SR+ ticket, expanded like a banner's guarantee table (one definition, REQ-GACHA-002). */
export function srPlusPool(m: Master, itemId: string): PoolEntry[] {
  const t = m.items.tickets[itemId];
  if (!t || t.kind !== 'srPlus') throw new AppError('NOT_FOUND', `ticket ${itemId}`);
  let byId = srPlusCache.get(m);
  if (!byId) { byId = new Map(); srPlusCache.set(m, byId); }
  let pool = byId.get(itemId);
  if (!pool) { pool = expandPool(m.templates, t.rates); byId.set(itemId, pool); }
  return pool;
}

/** Validation of master/items.json against the rest of the master data (load time and tests). */
export function itemsProblems(m: Master, v: VisualsMaster = VISUALS): string[] {
  const p: string[] = [];
  const it = m.items;
  for (const [id, t] of Object.entries(it.tickets)) {
    if (t.kind === 'single' || t.kind === 'ten') {
      if (t.banners.length === 0) p.push(`${id}: no banners`);
      for (const bid of t.banners) {
        const b = m.gacha.banners.find((x) => x.id === bid);
        if (!b) p.push(`${id}: unknown banner ${bid}`);
        // tickets come from free rewards; letting them draw a paid-only banner would make it reachable without paying
        else if (b.currency === 'paidOnly') p.push(`${id}: paid-only banner ${bid} cannot take tickets`);
      }
    } else if (t.kind === 'srPlus') {
      const sum = Object.values(t.rates).reduce((a, n) => a + (n ?? 0), 0);
      if (sum !== PPM_TOTAL) p.push(`${id}: rates sum ${sum} != ${PPM_TOTAL}`);
      if ((t.rates.R ?? 0) > 0) p.push(`${id}: an SR+ ticket cannot draw R`);
      try { expandPool(m.templates, t.rates); } catch (e) { p.push(`${id}: ${(e as Error).message}`); }
    } else p.push(`${id}: unknown ticket kind`);
  }
  const bm = it.breedingMaterial;
  if (!Number.isInteger(bm.cost) || bm.cost < 1) p.push('breedingMaterial.cost must be an integer >= 1');
  if (!Number.isInteger(bm.extraPerDay) || bm.extraPerDay < 0 || bm.extraPerDay > 3) p.push('breedingMaterial.extraPerDay must be 0..3');
  if (!Number.isInteger(it.decorSlots) || it.decorSlots < 0 || it.decorSlots > 10) p.push('decorSlots must be 0..10');
  const ids = new Set<string>();
  for (const c of it.cosmetics) {
    if (ids.has(c.id)) p.push(`${c.id}: duplicate cosmetic`);
    ids.add(c.id);
    if (it.tickets[c.id] || c.id === bm.itemId) p.push(`${c.id}: cosmetic id collides with a ticket/material`);
    // REQ-UXS-019: a not-for-sale cosmetic (e.g. the Pass+ tack) only comes with a product or reward
    if (c.notForSale) { if (c.price !== 0) p.push(`${c.id}: a not-for-sale cosmetic has price 0`); }
    else if (!Number.isInteger(c.price) || c.price <= 0) p.push(`${c.id}: price must be a positive integer`);
    if (c.currency !== 'any' && c.currency !== 'paidOnly') p.push(`${c.id}: bad currency`);
    if (c.kind === 'silks') {
      const pat = v.silks.patterns.find((x) => x.id === c.pattern);
      if (!pat) p.push(`${c.id}: unknown silks pattern ${c.pattern}`);
      else if (pat.unlockItem !== c.id) p.push(`${c.id}: pattern ${c.pattern} must have unlockItem ${c.id}`);
    } else if (c.kind === 'tack') {
      if (!TACK_SLOTS.includes(c.slot)) p.push(`${c.id}: unknown tack slot ${c.slot}`);
      if (!ASSET_KEY_RE.test(c.asset) || !c.asset.startsWith('tack/')) p.push(`${c.id}: asset must be a tack/<name> key`);
    } else if (c.kind === 'decor') {
      if (!ASSET_KEY_RE.test(c.asset) || !c.asset.startsWith('decor/')) p.push(`${c.id}: asset must be a decor/<name> key`);
    } else if (c.kind === 'stamp') {
      if (!ASSET_KEY_RE.test(c.asset) || !c.asset.startsWith('stamp/')) p.push(`${c.id}: asset must be a stamp/<id> key`);
    } else if (c.kind === 'photo') {
      if (!ASSET_KEY_RE.test(c.asset) || !/^photo\/(frame|stamp)\//.test(c.asset)) p.push(`${c.id}: asset must be a photo/frame/<id> or photo/stamp/<id> key`);
    } else p.push(`${(c as CosmeticDef).id}: unknown cosmetic kind`);
  }
  return p;
}

export function validateItems(m: Master): void {
  const problems = itemsProblems(m);
  if (problems.length) throw new AppError('CONFIG_INVALID', problems.join('; '));
}

/** REQ-ITEM-002: disclosure of every ticket, generated from the same definitions used for drawing. */
export function ticketDisclosure(m: Master, itemId: string) {
  const t = m.items.tickets[itemId];
  if (!t) throw new AppError('NOT_FOUND', `ticket ${itemId}`);
  if (t.kind === 'single') {
    return {
      itemId, name: t.name, kind: t.kind, icon: assetKeys.item(itemId),
      banners: t.banners,
      notice: '1枚で対象ガチャを1回引けます。抽選は各ガチャの提供割合（GET /v1/gacha/:bannerId/odds）と同じ表で行い、天井ポイントも1回分加算されます。',
    };
  }
  if (t.kind === 'ten') {
    return {
      itemId, name: t.name, kind: t.kind, icon: assetKeys.item(itemId),
      banners: t.banners,
      notice: '1枚で対象ガチャの10連を1回引けます（10枠目はSR以上確定の保証つき）。抽選は各ガチャの提供割合（GET /v1/gacha/:bannerId/odds）と同じ表で行い、天井ポイントも10回分加算されます。',
    };
  }
  const pool = srPlusPool(m, itemId);
  const rarityTotals: Record<string, { ppm: number; rate: string }> = {};
  for (const r of RARITY_ORDER) {
    const ppm = pool.filter((e) => m.templateById.get(e.templateId)!.rarity === r).reduce((a, e) => a + e.ppm, 0);
    if (ppm > 0) rarityTotals[r] = { ppm, rate: pct(ppm) };
  }
  return {
    itemId, name: t.name, kind: t.kind, icon: assetKeys.item(itemId),
    items: pool.map((e) => { const tpl = m.templateById.get(e.templateId)!; return { templateId: tpl.id, name: tpl.name, rarity: tpl.rarity, ppm: e.ppm, rate: pct(e.ppm) }; }),
    rarityTotals,
    notice: '1枚でSR以上が1頭確定。天井ポイントは加算されません。',
  };
}

/** `results`: every pull of a 10-pull ticket (`result` is then the first one). */
export interface TicketResult { itemId: string; bannerId: string | null; result: PullResult; results?: PullResult[]; pityPoints: number | null; remaining: number }

/** REQ-ITEM-001: one draw on an eligible banner, paid with a ticket instead of coins. Counts toward that banner's pity. */
export function useGachaTicket(m: Master, s: PlayerState, itemId: string, bannerId: string, rng: Rng, now: number, ref: string): TicketResult {
  const t = m.items.tickets[itemId];
  if (!t || t.kind !== 'single') throw new AppError('NOT_FOUND', `ticket ${itemId}`);
  if (!t.banners.includes(bannerId)) throw new AppError('NOT_ELIGIBLE', `${itemId} cannot be used on ${bannerId}`);
  const b = findBanner(m, bannerId);
  assertBannerOpen(b, now);
  // QA r6 #1: runtime backstop — free tickets never draw a paid-only banner, whatever the active config says
  if (b.currency === 'paidOnly') throw new AppError('NOT_ELIGIBLE', `${bannerId} is paid-only and cannot take tickets`);
  if (b.stepUp) throw new AppError('NOT_ELIGIBLE', `${bannerId} is a step-up banner and cannot take tickets`);
  consumeItem(s, itemId, 1, now, `ticket draw ${bannerId}`, ref);
  const tplId = drawFromPool(b.pool, rng);
  const result = grantPull(m, s, m.templateById.get(tplId)!, now, false);
  s.pity[b.pityGroup] = (s.pity[b.pityGroup] ?? 0) + 1;
  return { itemId, bannerId, result, pityPoints: s.pity[b.pityGroup]!, remaining: s.items[itemId] ?? 0 };
}

/** REQ-ITEM-002: one guaranteed SR+ horse from the ticket's own disclosed table. */
export function useSrPlusTicket(m: Master, s: PlayerState, itemId: string, rng: Rng, now: number, ref: string): TicketResult {
  const pool = srPlusPool(m, itemId);
  consumeItem(s, itemId, 1, now, 'SR+ ticket draw', ref);
  const tpl = m.templateById.get(drawFromPool(pool, rng))!;
  if (rank(tpl.rarity) < rank('SR')) throw new AppError('CONFIG_INVALID', `${itemId} drew below SR`);
  return { itemId, bannerId: null, result: grantPull(m, s, tpl, now, true), pityPoints: null, remaining: s.items[itemId] ?? 0 };
}

/** REQ-UXS-015: a 10-pull ticket (beginner missions' last reward): the banner's own pool and slot-10 guarantee. */
export function useTenTicket(m: Master, s: PlayerState, itemId: string, bannerId: string, rng: Rng, now: number, ref: string): TicketResult {
  const t = m.items.tickets[itemId];
  if (!t || t.kind !== 'ten') throw new AppError('NOT_FOUND', `ticket ${itemId}`);
  if (!t.banners.includes(bannerId)) throw new AppError('NOT_ELIGIBLE', `${itemId} cannot be used on ${bannerId}`);
  const b = findBanner(m, bannerId);
  assertBannerOpen(b, now);
  if (b.currency === 'paidOnly') throw new AppError('NOT_ELIGIBLE', `${bannerId} is paid-only and cannot take tickets`);
  if (b.stepUp) throw new AppError('NOT_ELIGIBLE', `${bannerId} is a step-up banner and cannot take tickets`);
  consumeItem(s, itemId, 1, now, `ten-pull ticket ${bannerId}`, ref);
  const results = rollPulls(m, b, 10, rng).map((r) => grantPull(m, s, m.templateById.get(r.templateId)!, now, r.guaranteed));
  s.pity[b.pityGroup] = (s.pity[b.pityGroup] ?? 0) + 10;
  return { itemId, bannerId, result: results[0]!, results, pityPoints: s.pity[b.pityGroup]!, remaining: s.items[itemId] ?? 0 };
}

export function useTicket(m: Master, s: PlayerState, itemId: string, bannerId: string | null, rng: Rng, now: number, ref: string): TicketResult {
  const t = m.items.tickets[itemId];
  if (!t) throw new AppError('NOT_FOUND', `ticket ${itemId}`);
  if (t.kind === 'single' || t.kind === 'ten') {
    if (!bannerId) throw new AppError('BAD_REQUEST', 'bannerId is required for this ticket');
    return t.kind === 'ten' ? useTenTicket(m, s, itemId, bannerId, rng, now, ref) : useGachaTicket(m, s, itemId, bannerId, rng, now, ref);
  }
  return useSrPlusTicket(m, s, itemId, rng, now, ref);
}

// ---------------------------------------------------------------------------------------------- cosmetics

export const emptyEquipment = (): Equipment => ({ tack: {}, decor: [] });

export function findCosmetic(m: Master, itemId: string): CosmeticDef {
  const c = m.items.cosmetics.find((x) => x.id === itemId);
  if (!c) throw new AppError('NOT_FOUND', `cosmetic ${itemId}`);
  return c;
}

const ownsItem = (s: PlayerState, id: string) => (s.items[id] ?? 0) > 0;

/** REQ-ITEM-004: the shop list with ownership and what is equipped (asset keys per contracts/assets.md). */
export function cosmeticsCatalog(m: Master, s: PlayerState) {
  const eq = s.equipment ?? emptyEquipment();
  return {
    decorSlots: m.items.decorSlots,
    notice: '見た目のみ。ランク戦の能力には影響しません。有償コインから先に使われます（「有償限定」の品は有償コインのみ）。',
    equipment: eq,
    silksPattern: s.profile.silks?.pattern ?? null,
    items: m.items.cosmetics.map((c) => ({
      id: c.id, name: c.name, kind: c.kind, price: c.price, currency: c.currency, forSale: !c.notForSale, icon: assetKeys.item(c.id),
      asset: c.kind === 'silks' ? assetKeys.silksPattern(c.pattern) : c.asset,
      ...(c.kind === 'tack' ? { slot: c.slot } : {}),
      ...(c.kind === 'silks' ? { pattern: c.pattern } : {}),
      owned: ownsItem(s, c.id),
      equipped: c.kind === 'tack' ? eq.tack[c.slot] === c.id : c.kind === 'decor' ? eq.decor.includes(c.id) : c.kind === 'silks' ? s.profile.silks?.pattern === c.pattern : false, // stamps are used in the team feed, never equipped
    })),
  };
}

/** REQ-ITEM-005: buy a cosmetic for coins (each is owned once; paid-only items use paid coins only). */
export function buyCosmetic(m: Master, s: PlayerState, itemId: string, now: number, ref: string) {
  const c = findCosmetic(m, itemId);
  if (c.notForSale) throw new AppError('NOT_ELIGIBLE', `${c.id} is not sold for coins`);
  if (ownsItem(s, c.id)) throw new AppError('ALREADY_PURCHASED', `${c.id} is already owned`);
  const spent = spend(s, c.price, { paidOnly: c.currency === 'paidOnly' }, now, `cosmetic ${c.id}`, ref);
  addItems(s, [{ itemId: c.id, qty: 1 }]);
  logItem(s, now, c.id, 1, 'cosmetic purchase', ref);
  return { itemId: c.id, spent };
}

export interface EquipmentPatch { tack?: Partial<Record<TackSlot, string | null>>; decor?: (string | null)[] }

/** REQ-ITEM-006: equip/unequip tack per slot and fill decor slots with owned decor (no duplicates). */
export function setEquipment(m: Master, s: PlayerState, patch: EquipmentPatch): Equipment {
  const eq: Equipment = structuredClone(s.equipment ?? emptyEquipment());
  if (patch.tack) {
    for (const [slot, id] of Object.entries(patch.tack) as [TackSlot, string | null | undefined][]) {
      if (!TACK_SLOTS.includes(slot)) throw new AppError('BAD_REQUEST', `unknown tack slot ${slot}`);
      if (id === undefined) continue;
      if (id === null) { delete eq.tack[slot]; continue; }
      const c = findCosmetic(m, id);
      if (c.kind !== 'tack' || c.slot !== slot) throw new AppError('BAD_REQUEST', `${id} is not ${slot} tack`);
      if (!ownsItem(s, id)) throw new AppError('NOT_ELIGIBLE', `${id} is not owned`);
      eq.tack[slot] = id;
    }
  }
  if (patch.decor) {
    if (patch.decor.length > m.items.decorSlots) throw new AppError('BAD_REQUEST', `at most ${m.items.decorSlots} decor slots`);
    const seen = new Set<string>();
    for (const id of patch.decor) {
      if (id === null) continue;
      const c = findCosmetic(m, id);
      if (c.kind !== 'decor') throw new AppError('BAD_REQUEST', `${id} is not decor`);
      if (!ownsItem(s, id)) throw new AppError('NOT_ELIGIBLE', `${id} is not owned`);
      if (seen.has(id)) throw new AppError('BAD_REQUEST', `${id} is placed twice`);
      seen.add(id);
    }
    eq.decor = [...patch.decor];
  }
  s.equipment = eq;
  return eq;
}
