/**
 * Shop experience on the server (spec 06 §5, §6.8): product display data (REQ-UXS-022), offer triggers and
 * shown-once records (REQ-UXS-017) and the 30-day daily-coin pack 厩舎手当 (REQ-UXS-018).
 *
 * Legal guard rails (docs/planning/03, 06 §5.5):
 * - every text about what a product contains is built here from master data; the client shows it as is and
 *   never builds bonus wording ("2倍" is never used: the first-purchase bonus is stated as free coins);
 * - no reference prices / discounts (二重価格), no fake timers: the only end times are real season ends;
 * - nothing here moves value between players.
 */
import { AppError } from './errors.js';
import type { Master, Product, Reward, ShopOffersConfig } from './master.js';
import type { PlayerState, PurchaseRecord } from './player.js';
import { addJstDays, dayRule, gameDayKey, gameDaysUntil, jstMonthKey } from './time.js';
import { clawbackFree, grantFree } from './wallet.js';
import { levelOf, passPurchasesFor, seasonEndMs } from './pass.js';
import { experimentsView } from './onboarding.js';

export interface OfferRecord { triggeredAt?: number; reason?: string; viewedAt?: number }
/** REQ-UXS-018: one 厩舎手当 purchase. Day 1 = `startDate` (game day, gameDayKey); the last day is startDate + days − 1. */
export interface AllowanceEntitlement { txId: string; productId: string; startDate: string; days: number; dailyFreeCoins: number; claimed: string[]; refunded?: boolean;
  /** REQ-UXS-040: given up by an account deletion (the unclaimed days are never paid). */
  forfeitedAt?: number }
export interface ShopState { offers: Record<string, OfferRecord>; allowances: AllowanceEntitlement[] }
/** REQ-UXS-021: a closed season's pass. `granted` = every level paid out (claimed or automatic). */
export interface PassSeasonRecord {
  seasonId: string; xp: number; level: number; premium: boolean; boostXp: number;
  granted: { free: number[]; premium: number[] }; autoGranted: { free: number[]; premium: number[] }; autoFreeCoins: number; at: number;
}

export const ALLOWANCE_KEEP = 12;
const DEFAULT_OFFERS: ShopOffersConfig = { starterPlaceAtOrWorse: 4, starterAfterRankedRaces: 5, passAfterRankedRaces: 3 };
const offersConfig = (m: Master) => m.shopOffers ?? DEFAULT_OFFERS;

export function ensureShop(s: PlayerState): ShopState {
  s.shop ??= { offers: {}, allowances: [] };
  s.shop.offers ??= {};
  s.shop.allowances ??= [];
  return s.shop;
}

// --------------------------------------------------------------------------------------- product display

const fmt = (n: number) => n.toLocaleString('en-US');
const itemLabel = (m: Master, id: string) =>
  m.shopDisplay?.itemLabels[id] ?? m.items.tickets[id]?.name ?? m.items.cosmetics.find((c) => c.id === id)?.name ?? id;

function rewardText(m: Master, r: Reward): string {
  const parts: string[] = [];
  if (r.freeCoins) parts.push(`無償コイン${fmt(r.freeCoins)}枚`);
  for (const it of r.items ?? []) parts.push(`${itemLabel(m, it.itemId)}×${it.qty}`);
  return parts.join('＋');
}

export type ProductContent =
  | { type: 'paid_coins'; qty: number; label: string }
  | { type: 'daily_free_coins'; qty: number; days: number; total: number; label: string }
  | { type: 'pass_premium'; levels: number; reward: Reward; label: string }
  | { type: 'pass_levels'; qty: number; label: string }
  | { type: 'item'; itemId: string; qty: number; label: string };

/** REQ-UXS-022: what the product contains, in display order, with quantities and server-built labels. */
export function productContents(m: Master, p: Product): ProductContent[] {
  const out: ProductContent[] = [];
  if (p.paidCoins > 0) out.push({ type: 'paid_coins', qty: p.paidCoins, label: `有償コイン${fmt(p.paidCoins)}枚` });
  if (p.allowance) {
    const a = p.allowance;
    out.push({ type: 'daily_free_coins', qty: a.dailyFreeCoins, days: a.days, total: a.dailyFreeCoins * a.days, label: `${a.days}日間、毎日 無償コイン${fmt(a.dailyFreeCoins)}枚（1日1回受け取り）` });
  }
  if (p.kind === 'season_pass') {
    const pr = m.progression.passRewards.premium;
    const levels = Math.floor(m.progression.passMaxLevel / pr.every);
    out.push({ type: 'pass_premium', levels, reward: pr.reward, label: `シーズンパス有料ライン 全${levels}段（各段：${rewardText(m, pr.reward)}）` });
    if (p.pass?.levels) out.push({ type: 'pass_levels', qty: p.pass.levels, label: `パスのレベル＋${p.pass.levels}（購入時）` });
  }
  for (const it of p.items ?? []) out.push({ type: 'item', itemId: it.itemId, qty: it.qty, label: `${itemLabel(m, it.itemId)}×${it.qty}` });
  return out;
}

export function firstPurchaseBonusOf(m: Master, p: Product) {
  if (p.kind !== 'coins' || p.paidCoins <= 0) return null;
  const currency = m.firstPurchaseBonusAsPaid ? 'paid' as const : 'free' as const;
  return { coins: p.paidCoins, currency, label: `はじめての購入時のみ：${currency === 'free' ? '無償' : '有償'}コイン${fmt(p.paidCoins)}枚をプレゼント` };
}

function noticeKeys(p: Product): string[] {
  const k = ['shop.paid_first'];
  if (p.kind === 'coins') k.push('shop.first_purchase_bonus');
  if (p.once) k.push(p.classId ? 'shop.one_time_per_class' : 'shop.one_time');
  if (p.kind === 'season_pass') k.push('shop.no_auto_renew', 'shop.pass_season_only', 'shop.pass_auto_grant');
  if (p.kind === 'allowance') k.push('shop.no_auto_renew', 'shop.allowance_daily_claim', 'shop.allowance_no_stack');
  k.push('legal.tokushoho', 'legal.shikin_kessai');
  return k;
}

const tabOf = (p: Product) => p.tab ?? (p.kind === 'coins' ? 'coins' : p.kind === 'season_pass' ? 'pass' : 'recommended');

/** REQ-UXS-022: GET /v1/shop/products. Legacy fields stay; display fields are additive. */
export function shopProducts(m: Master) {
  const d = m.shopDisplay;
  return {
    products: m.products.filter((p) => p.storeType !== 'auto_renewing').map((p) => ({
      ...p,
      name: p.name ?? p.id,
      tab: tabOf(p),
      storeType: p.storeType ?? 'consumable',
      autoRenew: false,
      contents: productContents(m, p),
      firstPurchaseBonus: firstPurchaseBonusOf(m, p),
      oneTime: p.once === true,
      oneTimeScope: p.once ? (p.classId ? 'class' as const : 'account' as const) : null,
      period: p.kind === 'season_pass' ? { kind: 'season' as const } : p.allowance ? { kind: 'days' as const, days: p.allowance.days } : null,
      noticeKeys: noticeKeys(p),
    })),
    notices: d?.notices ?? {},
    legalLinks: d?.legalLinks ?? [],
    notice: '有償コインから先に使われます',
  };
}

// ------------------------------------------------------------------------------- daily pack (厩舎手当)

/** Only the game-day rule is read (REQ-DAY-001). */
type DayMaster = Pick<Master, 'progression'>;
const allowanceEnd = (a: AllowanceEntitlement) => addJstDays(a.startDate, a.days - 1);
const live = (s: PlayerState) => (s.shop?.allowances ?? []).filter((a) => !a.refunded && a.forfeitedAt === undefined);

/** The entitlement running today, if any. */
export function activeAllowance(m: DayMaster, s: PlayerState, now: number): AllowanceEntitlement | null {
  const today = gameDayKey(now, dayRule(m));
  return live(s).find((a) => a.startDate <= today && today <= allowanceEnd(a)) ?? null;
}
/** Running or starting later (a second purchase that arrived while one was running). */
export function pendingAllowance(m: DayMaster, s: PlayerState, now: number): AllowanceEntitlement | null {
  const today = gameDayKey(now, dayRule(m));
  return live(s).find((a) => today <= allowanceEnd(a)) ?? null;
}

/**
 * REQ-UXS-018: start the 30 days on the purchase's grant day. A purchase that arrives while another is still
 * running (the app skipped the intent check) is queued after it — paid days are never lost — and flagged.
 */
export function grantAllowance(m: DayMaster, s: PlayerState, p: Product, txId: string, now: number) {
  const a = p.allowance!;
  const sh = ensureShop(s);
  let start = gameDayKey(now, dayRule(m));
  const running = live(s).map(allowanceEnd).filter((e) => e >= start).sort();
  if (running.length) {
    start = addJstDays(running[running.length - 1]!, 1);
    (s.supportFlags ??= []).push(`allowance_overlap:${txId}`);
  }
  sh.allowances.push({ txId, productId: p.id, startDate: start, days: a.days, dailyFreeCoins: a.dailyFreeCoins, claimed: [] });
  const today = gameDayKey(now, dayRule(m));
  // keep running/queued ones and the most recent ended ones
  const keep = sh.allowances.filter((x) => allowanceEnd(x) >= today);
  const room = Math.max(0, ALLOWANCE_KEEP - keep.length); // slice(-0) would keep every ended one
  const ended = room > 0 ? sh.allowances.filter((x) => allowanceEnd(x) < today).slice(-room) : [];
  sh.allowances = [...ended, ...keep];
}

/** REQ-UXS-018: claim today's coins (once per game day while the entitlement runs; missed days are not paid later). */
export function claimAllowance(m: DayMaster, s: PlayerState, now: number) {
  const a = activeAllowance(m, s, now);
  if (!a) throw new AppError('NOT_ELIGIBLE', 'no daily pack is running today');
  const today = gameDayKey(now, dayRule(m));
  // REQ-DAY-003: a day claimed under a later key (stale rule) also counts as today's claim
  if (a.claimed.some((d) => d >= today)) throw new AppError('ALREADY_CLAIMED');
  a.claimed.push(today);
  grantFree(s, a.dailyFreeCoins, now, `daily pack ${a.productId} ${today}`, `allowance:${a.txId}:${today}`);
  const rec = s.purchases.find((x) => x.txId === a.txId);
  if (rec) rec.linkedFree = (rec.linkedFree ?? 0) + a.dailyFreeCoins;
  return { freeCoins: a.dailyFreeCoins, ...allowanceView(m, s, now) };
}

export function allowanceView(m: DayMaster, s: PlayerState, now: number) {
  const today = gameDayKey(now, dayRule(m));
  const a = activeAllowance(m, s, now);
  const next = live(s).filter((x) => x.startDate > today).sort((x, y) => (x.startDate < y.startDate ? -1 : 1))[0] ?? null;
  if (!a) return { active: false as const, claimedToday: false, queued: next ? { startDate: next.startDate, endDate: allowanceEnd(next) } : null };
  const day = Math.round((Date.parse(today) - Date.parse(a.startDate)) / 86_400_000) + 1;
  return {
    active: true as const, productId: a.productId, startDate: a.startDate, endDate: allowanceEnd(a), day, days: a.days,
    daysLeft: a.days - day + 1, dailyFreeCoins: a.dailyFreeCoins, claimedToday: a.claimed.some((d) => d >= today) /* REQ-DAY-003: the claim path's rule */, claimedDays: a.claimed.length,
    queued: next ? { startDate: next.startDate, endDate: allowanceEnd(next) } : null,
  };
}

/** Unclaimed days of every running or queued daily pack from today on (what an account deletion gives up). */
export function allowanceRemaining(m: DayMaster, s: PlayerState, now: number): { days: number; freeCoins: number; txIds: string[] } {
  const today = gameDayKey(now, dayRule(m));
  let days = 0, freeCoins = 0;
  const txIds: string[] = [];
  for (const a of live(s)) {
    const end = allowanceEnd(a);
    if (end < today) continue;
    let n = 0;
    for (let d = a.startDate > today ? a.startDate : today; d <= end; d = addJstDays(d, 1)) if (!a.claimed.includes(d)) n++;
    days += n; freeCoins += n * a.dailyFreeCoins; txIds.push(a.txId);
  }
  return { days, freeCoins, txIds };
}

/** REQ-UXS-040: the account deletion gives up the running and queued daily packs (no more claims). */
export function forfeitAllowances(m: DayMaster, s: PlayerState, now: number) {
  const r = allowanceRemaining(m, s, now);
  for (const a of s.shop?.allowances ?? []) if (r.txIds.includes(a.txId)) a.forfeitedAt = now;
  return { days: r.days, freeCoins: r.freeCoins };
}

/** REQ-PUR-006: refund of a daily pack. The paid coins go with the purchase; claimed daily coins are taken back; no more claims. */
export function refundAllowance(s: PlayerState, rec: PurchaseRecord, now: number) {
  const a = (s.shop?.allowances ?? []).find((x) => x.txId === rec.txId);
  if (!a) {
    // the entitlement was pruned (ALLOWANCE_KEEP): the purchase record still knows the daily coins it paid out
    const total = rec.linkedFree ?? 0;
    if (total > 0) clawbackFree(s, total, now, rec.txId);
    return { freeCoins: total };
  }
  if (a.refunded) return { freeCoins: 0 };
  a.refunded = true;
  const total = a.claimed.length * a.dailyFreeCoins;
  if (total > 0) clawbackFree(s, total, now, rec.txId);
  return { freeCoins: total };
}

// ----------------------------------------------------------------------------------------------- offers

/** Highest class index the player has been in (current class or any closed season, incl. promotions). */
export function highestClassIndex(m: Master, s: PlayerState): number {
  const idx = (id: string) => m.progression.classes.findIndex((c) => c.id === id);
  let best = idx(s.season.classId);
  for (const h of s.seasonHistory) best = Math.max(best, idx(h.classId), idx(h.nextClassId));
  return best;
}
export function classReached(m: Master, s: PlayerState, classId: string) {
  const i = m.progression.classes.findIndex((c) => c.id === classId);
  return i >= 0 && highestClassIndex(m, s) >= i;
}

const everBought = (s: PlayerState, productId: string) => s.purchases.some((x) => x.productId === productId);
const passOfferId = (seasonId: string) => `season_pass_${seasonId.replace('-', '_')}`;

function trigger(sh: ShopState, id: string, reason: string, now: number) {
  const r = (sh.offers[id] ??= {});
  if (r.triggeredAt === undefined) { r.triggeredAt = now; r.reason = reason; }
  return r;
}

/** REQ-UXS-017: T2 trigger from a confirmed ranked result (called after the result is applied). */
export function noteRaceForOffers(m: Master, s: PlayerState, place: number, now: number) {
  const starter = m.products.find((p) => p.kind === 'starter');
  if (!starter || everBought(s, starter.id)) return;
  const c = offersConfig(m);
  const sh = ensureShop(s);
  const t = starterTriggers(m, s);
  if (t.bottomHalf && place >= c.starterPlaceAtOrWorse) trigger(sh, starter.id, 'first_4th_or_worse', now);
  else if (t.fifthRace && s.rating.rankedRaces >= c.starterAfterRankedRaces) trigger(sh, starter.id, `race${c.starterAfterRankedRaces}`, now);
}

/**
 * Which T2 triggers apply: both (the earlier wins) unless the A/B key `starterOfferTrigger` (REQ-UXS-032,
 * onboarding.ts) picks one for this player. Only the moment changes, never the price or the contents.
 */
export function starterTriggers(m: Master, s: PlayerState): { bottomHalf: boolean; fifthRace: boolean } {
  const v = experimentsView(m, s.id).values.starterOfferTrigger;
  return { bottomHalf: v !== 'fifth_race', fifthRace: v !== 'first_bottom_half' };
}

export interface OfferView {
  id: string; productId: string; touchpoint: 'T2' | 'T3' | 'T4' | 'shop';
  placement: 'popup' | 'recommended'; reason: string | null; triggeredAt: number | null; viewedAt: number | null;
  /** Show the one-time sheet now (triggered and not marked viewed). Afterwards the offer only sits in the shop. */
  showPopup: boolean;
  /** Real end of the period it is sold for (season end), never a made-up timer. */
  endsAt: number | null; remainingDays: number | null;
}

/**
 * REQ-UXS-017: GET /v1/shop/offers. Products already bought (once-only, or this season's pass, or a running
 * daily pack) are never returned. Lazy triggers (race count, season start, promotion) are recorded here.
 */
export function shopOffers(m: Master, s: PlayerState, now: number) {
  const c = offersConfig(m);
  const sh = ensureShop(s);
  const offers: OfferView[] = [];
  const add = (id: string, p: Product, touchpoint: OfferView['touchpoint'], popup: boolean, r: OfferRecord | null, endsAt: number | null = null) => {
    offers.push({
      id, productId: p.id, touchpoint, placement: popup ? 'popup' : 'recommended', reason: r?.reason ?? null, triggeredAt: r?.triggeredAt ?? null,
      viewedAt: r?.viewedAt ?? null, showPopup: popup && r?.triggeredAt !== undefined && r.viewedAt === undefined,
      endsAt, remainingDays: endsAt === null ? null : gameDaysUntil(endsAt, now, dayRule(m)),
    });
  };
  // T2 starter pack: popup once after the trigger, then in the recommended tab until bought
  for (const p of m.products.filter((x) => x.kind === 'starter' && !everBought(s, x.id))) {
    if (!sh.offers[p.id]?.triggeredAt && starterTriggers(m, s).fifthRace && s.rating.rankedRaces >= c.starterAfterRankedRaces) trigger(sh, p.id, `race${c.starterAfterRankedRaces}`, now);
    const r = sh.offers[p.id];
    if (r?.triggeredAt !== undefined) add(p.id, p, 'T2', true, r);
  }
  // T3 season pass: once per season after the shop/pass unlock
  const seasonId = jstMonthKey(now);
  if (passPurchasesFor(s, seasonId).length === 0 && s.rating.rankedRaces >= c.passAfterRankedRaces) {
    const id = passOfferId(seasonId);
    const reason = levelOf(m, s.seasonPass.seasonId === seasonId ? s.seasonPass.xp : 0) >= 1 ? 'pass_level_up' : s.seasonHistory.length > 0 ? 'season_start' : 'pass_unlock';
    const r = trigger(sh, id, reason, now);
    const end = seasonEndMs(seasonId);
    for (const p of m.products.filter((x) => x.kind === 'season_pass' && x.storeType !== 'auto_renewing')) {
      const plus = (p.pass?.levels ?? 0) > 0;
      add(plus ? `${id}_plus` : id, p, 'T3', !plus, r, end);
    }
  }
  // T4 promotion pack: once per class reached by promotion
  for (const p of m.products.filter((x) => x.kind === 'promotion' && x.classId && !everBought(s, x.id))) {
    if (!classReached(m, s, p.classId!)) continue;
    add(p.id, p, 'T4', true, trigger(sh, p.id, `class_${p.classId}`, now));
  }
  // daily pack: shop placement only, while none is running or queued
  if (!pendingAllowance(m, s, now)) for (const p of m.products.filter((x) => x.kind === 'allowance')) add(p.id, p, 'shop', false, null);
  const coins = m.products.filter((p) => p.kind === 'coins');
  const remaining = coins.filter((p) => !s.firstPurchased.includes(p.id)).map((p) => p.id);
  return {
    offers,
    // T1: shown at the top of the shop while any coin pack still has its first-purchase bonus
    firstPurchase: { available: remaining.length > 0, productIds: remaining, noticeKey: 'shop.first_purchase_bonus' },
    allowance: allowanceView(m, s, now),
  };
}

/** REQ-UXS-017: POST /v1/shop/offers/:offerId/view — the one-time sheet was shown (first time kept). */
export function markOfferViewed(m: Master, s: PlayerState, offerId: string, now: number) {
  const list = shopOffers(m, s, now).offers;
  const o = list.find((x) => x.id === offerId);
  if (!o) throw new AppError('NOT_FOUND', `offer ${offerId}`);
  const key = offerId.endsWith('_plus') ? offerId.slice(0, -'_plus'.length) : offerId;
  const r = (ensureShop(s).offers[key] ??= {});
  r.viewedAt ??= now;
  return { offerId, viewedAt: r.viewedAt };
}

// ------------------------------------------------------------------------------------------- validation

const KINDS = new Set(['coins', 'starter', 'season_pass', 'allowance', 'promotion']);
const STORE_TYPES = new Set(['consumable', 'non_consumable', 'auto_renewing']);

/** Consistency of master/products.json (checked at test time; REQ-UXS-018..022). */
export function productsProblems(m: Master, knownItems: Set<string>): string[] {
  const p: string[] = [];
  const ids = new Set<string>();
  for (const x of m.products) {
    if (ids.has(x.id)) p.push(`${x.id}: duplicate product`);
    ids.add(x.id);
    if (!/^[a-zA-Z0-9_]{1,64}$/.test(x.id)) p.push(`${x.id}: id must be [A-Za-z0-9_] (store SKU)`);
    if (!KINDS.has(x.kind)) p.push(`${x.id}: unknown kind ${x.kind}`);
    if (!STORE_TYPES.has(x.storeType ?? 'consumable')) p.push(`${x.id}: unknown storeType ${x.storeType}`);
    if (!Number.isInteger(x.priceYen) || x.priceYen <= 0) p.push(`${x.id}: priceYen must be a positive integer`);
    if (!Number.isInteger(x.paidCoins) || x.paidCoins < 0) p.push(`${x.id}: paidCoins must be a non-negative integer`);
    if (!x.name) p.push(`${x.id}: needs a display name`);
    // a once-only product must not be consumed on Google, or Play offers it again
    if (x.once && x.storeType !== 'non_consumable') p.push(`${x.id}: once-only products are non_consumable`);
    if (!x.once && x.storeType === 'non_consumable') p.push(`${x.id}: a non_consumable product must be once-only`);
    if (x.kind === 'coins' && (x.paidCoins <= 0 || x.items?.length || x.allowance || x.pass)) p.push(`${x.id}: a coin pack holds paid coins only`);
    if (x.kind === 'allowance' && !(x.allowance && Number.isInteger(x.allowance.days) && x.allowance.days >= 1 && x.allowance.days <= 31 && Number.isInteger(x.allowance.dailyFreeCoins) && x.allowance.dailyFreeCoins > 0)) p.push(`${x.id}: allowance needs days 1..31 and dailyFreeCoins > 0`);
    if (x.kind !== 'allowance' && x.allowance) p.push(`${x.id}: allowance only on kind allowance`);
    if (x.pass && (x.kind !== 'season_pass' || !Number.isInteger(x.pass.levels) || x.pass.levels < 1 || x.pass.levels > m.progression.passMaxLevel)) p.push(`${x.id}: pass.levels 1..passMaxLevel on a season pass only`);
    if (x.kind === 'promotion') {
      if (!x.classId || !m.progression.classes.some((c) => c.id === x.classId)) p.push(`${x.id}: unknown classId ${x.classId}`);
      else if (m.progression.classes[0]!.id === x.classId) p.push(`${x.id}: the first class is never reached by promotion`);
      if (!x.once) p.push(`${x.id}: a promotion pack is once-only`);
    }
    for (const it of x.items ?? []) {
      if (!knownItems.has(it.itemId)) p.push(`${x.id}: unknown item ${it.itemId}`);
      if (!Number.isInteger(it.qty) || it.qty < 1) p.push(`${x.id}: item qty must be a positive integer`);
      if (m.shopDisplay && !m.shopDisplay.itemLabels[it.itemId]) p.push(`${x.id}: no display label for ${it.itemId}`);
    }
  }
  const promo = m.products.filter((x) => x.kind === 'promotion').map((x) => x.classId);
  if (new Set(promo).size !== promo.length) p.push('one promotion pack per class');
  return p;
}
