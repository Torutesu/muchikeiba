/**
 * T6 コイン不足の案内 (docs/planning/06 §5.1, contracts/protocol.md §29, REQ-SHORT-001..008).
 *
 * When a coin spend fails (or would fail) this says which coins are short, by how much, and the ONE smallest pack this
 * player can buy right now that covers it. Every text is built here; the client shows it as is.
 *
 * Legal guard rails (docs/planning/03, 06 §5.5): no 「倍」/「お得」/「今だけ」/「残りわずか」/「通常価格」, no timers; the
 * first-purchase bonus is the shop's own label (shop.ts firstPurchaseBonusOf); paid and free coins are counted apart; a
 * free-coin-only payment (event entry fee, stud fee) never gets a purchase suggestion.
 */
import { AppError, type CoinNeed, type ErrorCode } from './errors.js';
import type { Master, Product } from './master.js';
import { ageBand, productBlock } from './purchase.js';
import { firstPurchaseBonusOf, productContents, type ProductContent } from './shop.js';
import { hasItemDebt } from './items.js';
import { deletionScheduled } from './accountDeletion.js';
import { moderationOf, type PlayerState } from './player.js';

export const SHORTFALL_OFFER_ID = 'shortfall';
/** Products that put paid coins in the wallet at once (the pass and the daily pack are not coin products). */
const COIN_KINDS = new Set(['coins', 'starter', 'promotion']);

export type ShortfallStatus = 'covered' | 'largest_only' | 'none_buyable' | 'free_only' | 'not_short';

export interface ShortfallOffer {
  offerId: typeof SHORTFALL_OFFER_ID; touchpoint: 'T6';
  productId: string; name: string; priceYen: number; paidCoins: number;
  /** The pack's paid coins alone cover the shortfall (the first-purchase bonus is never counted). */
  covers: boolean;
  contents: ProductContent[];
  /** The shop's own bonus line, only while this pack still has it for this player. */
  firstPurchaseBonus: ReturnType<typeof firstPurchaseBonusOf>;
  oneTime: boolean;
}

export interface CoinShortfall {
  short: boolean; coinKind: CoinNeed['coinKind']; need: number; have: number; shortfall: number;
  headline: string | null; status: ShortfallStatus;
  /** none_buyable: why nothing can be bought now. */
  blockedCode: ErrorCode | null;
  /** Age not registered: monthly limits are judged in the purchase confirmation, which asks for the birth month first. */
  ageCheck: boolean;
  line: string | null; notes: string[]; offer: ShortfallOffer | null;
}

const fmt = (n: number) => n.toLocaleString('en-US');
const HEADLINE: Record<CoinNeed['coinKind'], (n: number) => string> = {
  any: (n) => `コインが${fmt(n)}枚足りません`,
  paid: (n) => `有償コインが${fmt(n)}枚足りません`,
  free: (n) => `無償コインが${fmt(n)}枚足りません`,
};
const BLOCKED_LINE: Partial<Record<ErrorCode, string>> = {
  AGE_LIMIT_EXCEEDED: '今月の購入上限に達しているため、いま購入できるパックはありません',
  UNSETTLED_DEBT: '未精算の返金があるため、いまは購入できません',
  DELETION_PENDING: 'アカウント削除の手続き中のため、購入できません',
  BANNED: 'このアカウントでは購入できません',
};
const NONE_LINE = 'いま購入できるパックはありません';
const PAID_NOTE = '有償コインだけで支払います（無償コインは使えません）';
const FREE_ONLY_LINE = '無償コインだけで支払う項目です（購入したコインでは支払えません）';
const AGE_NOTE = '購入の前に、生年月を確認します';

/** Player-level reasons nothing can be bought (the product-level ones are productBlock's). */
function playerBlock(s: PlayerState, now: number): ErrorCode | null {
  if (moderationOf(s, now) === 'banned') return 'BANNED';
  if (deletionScheduled(s)) return 'DELETION_PENDING';
  if (s.wallet.debt > 0 || hasItemDebt(s)) return 'UNSETTLED_DEBT';
  return null;
}

function offerOf(m: Master, s: PlayerState, p: Product, covers: boolean): ShortfallOffer {
  return {
    offerId: SHORTFALL_OFFER_ID, touchpoint: 'T6', productId: p.id, name: p.name ?? p.id, priceYen: p.priceYen, paidCoins: p.paidCoins, covers,
    contents: productContents(m, p),
    firstPurchaseBonus: p.kind === 'coins' && !s.firstPurchased.includes(p.id) ? firstPurchaseBonusOf(m, p) : null,
    oneTime: p.once === true,
  };
}

/** Smallest first: price, then a plain coin pack before a bundle, then fewer coins, then id (stable). */
const smallestFirst = (a: Product, b: Product) =>
  a.priceYen - b.priceYen || Number(b.kind === 'coins') - Number(a.kind === 'coins') || a.paidCoins - b.paidCoins || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * REQ-SHORT-001/002/003: the shortfall of a payment of `need` coins of `coinKind` and the one pack to offer.
 * `have` defaults to what the wallet would let pay for it (paid only for `paid`, free only for `free`).
 */
export function coinShortfall(m: Master, s: PlayerState, n: { coinKind: CoinNeed['coinKind']; need: number; have?: number }, now: number): CoinShortfall {
  const have = n.have ?? (n.coinKind === 'paid' ? s.wallet.paid : n.coinKind === 'free' ? s.wallet.free : s.wallet.paid + s.wallet.free);
  const shortfall = Math.max(0, n.need - have);
  const base = { coinKind: n.coinKind, need: n.need, have, shortfall, blockedCode: null, ageCheck: false, notes: [] as string[], offer: null };
  if (shortfall === 0) return { ...base, short: false, headline: null, status: 'not_short', line: null };
  const headline = HEADLINE[n.coinKind](shortfall);
  if (n.coinKind === 'free') return { ...base, short: true, headline, status: 'free_only', line: FREE_ONLY_LINE };
  const notes = n.coinKind === 'paid' ? [PAID_NOTE] : [];
  const pb = playerBlock(s, now);
  if (pb) return { ...base, short: true, headline, status: 'none_buyable', blockedCode: pb, line: BLOCKED_LINE[pb] ?? NONE_LINE, notes };
  const ab = s.age ? ageBand(m, s, now) : null;
  const candidates = m.products.filter((p) => COIN_KINDS.has(p.kind) && p.paidCoins > 0 && p.storeType !== 'auto_renewing');
  const blocks = candidates.map((p) => ({ p, b: productBlock(m, s, p, now, ab) }));
  const buyable = blocks.filter((x) => x.b === null).map((x) => x.p);
  const ageCheck = !s.age;
  if (ageCheck) notes.push(AGE_NOTE);
  const covering = buyable.filter((p) => p.paidCoins >= shortfall).sort(smallestFirst);
  if (covering.length > 0) {
    const p = covering[0]!;
    return { ...base, short: true, headline, status: 'covered', ageCheck, line: `${p.name ?? p.id}（¥${fmt(p.priceYen)}）で足ります`, notes, offer: offerOf(m, s, p, true) };
  }
  if (buyable.length > 0) {
    const p = [...buyable].sort((a, b) => b.paidCoins - a.paidCoins || smallestFirst(a, b))[0]!;
    return {
      ...base, short: true, headline, status: 'largest_only', ageCheck, notes, offer: offerOf(m, s, p, false),
      line: `いちばん大きい${p.name ?? p.id}（¥${fmt(p.priceYen)}）でも、あと${fmt(shortfall - p.paidCoins)}枚足りません`,
    };
  }
  // nothing buyable: the reason of the smallest pack that would have covered it (else of any pack)
  const why = [...blocks].sort((a, b) => Number(b.p.paidCoins >= shortfall) - Number(a.p.paidCoins >= shortfall) || smallestFirst(a.p, b.p))[0]?.b?.code ?? null;
  const blockedCode = why === 'AGE_LIMIT_EXCEEDED' ? why : null;
  return { ...base, short: true, headline, status: 'none_buyable', blockedCode, ageCheck, line: (blockedCode && BLOCKED_LINE[blockedCode]) || NONE_LINE, notes };
}

/** REQ-SHORT-004: add `details.shortfall` to a wallet INSUFFICIENT_COINS (other errors pass through untouched). */
export function attachShortfall(m: Master, s: PlayerState, e: unknown, now: number): void {
  if (!(e instanceof AppError) || e.code !== 'INSUFFICIENT_COINS' || !e.details || e.details.shortfall) return;
  const d = e.details as Partial<CoinNeed>;
  if ((d.coinKind !== 'any' && d.coinKind !== 'paid' && d.coinKind !== 'free') || typeof d.need !== 'number' || typeof d.have !== 'number') return;
  e.details = { ...e.details, shortfall: coinShortfall(m, s, { coinKind: d.coinKind, need: d.need, have: d.have }, now) };
}
