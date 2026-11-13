/**
 * Quality pass 2 (docs/quality/shop.md §3.2): the purchase receipt — what the store purchase just put in the player's
 * hands, what each thing does in play, and the ONE next step that uses it (the SR+ ticket → the scout screen, a silks
 * pattern → the silks editor with it on, the pass → the pass screen, the daily pack → today's claim). Returned with
 * POST /v1/shop/purchase as `receipt` (additive). Built from the purchase record and master data only; the client shows
 * it as is (REQ-UXS-022: the client never builds wording about what a product holds).
 *
 * Legal guard rails: quantities stated plainly, paid and free named separately, the first-purchase bonus stated as free
 * coins (never 「倍」); no upsell on the receipt (the next step only ever uses what was bought — never another product).
 */
import type { Master, Product, Reward } from './master.js';
import type { PlayerState, PurchaseRecord } from './player.js';
import { findProduct } from './purchase.js';
import { VISUALS, type VisualsMaster } from './visuals.js';
import { seasonEndMs } from './pass.js';

const fmt = (n: number) => n.toLocaleString('en-US');
const itemLabel = (m: Master, id: string) =>
  m.shopDisplay?.itemLabels[id] ?? m.items.tickets[id]?.name ?? m.items.cosmetics.find((c) => c.id === id)?.name ?? id;

/** What an item does for the player in play (products.json display.itemPurposes; null when the master says nothing). */
export const itemPurpose = (m: Pick<Master, 'shopDisplay'>, id: string): string | null => m.shopDisplay?.itemPurposes?.[id] ?? null;

/** The silks body pattern an item unlocks (visuals.json unlockItem), if any. */
export function patternUnlockedBy(itemId: string, v: VisualsMaster = VISUALS): string | null {
  return v.silks.patterns.find((p) => p.unlockItem === itemId)?.id ?? null;
}

/** The sum of `levels` identical rewards (a pass track's total, stated plainly). */
export function rewardTimes(r: Reward, levels: number): Reward {
  return {
    ...(r.freeCoins ? { freeCoins: r.freeCoins * levels } : {}),
    ...(r.items?.length ? { items: r.items.map((it) => ({ itemId: it.itemId, qty: it.qty * levels })) } : {}),
  };
}

export type ReceiptLineKind = 'paid_coins' | 'free_coins' | 'bonus_free_coins' | 'item' | 'pass' | 'pass_levels' | 'allowance';
export interface ReceiptLine {
  kind: ReceiptLineKind; label: string; purpose: string | null; itemId?: string; qty?: number;
  /** The pass: the real season end (exclusive) — the client writes the date in the player's language. */
  endsAt?: number;
}
export type ReceiptAction = 'use_sr_ticket' | 'wear_silks' | 'open_pass' | 'claim_allowance' | 'scout';
export interface ReceiptNext { action: ReceiptAction; label: string; itemId: string | null; pattern: string | null }
export interface PurchaseReceipt {
  txId: string; productId: string; name: string; priceYen: number; at: number;
  lines: ReceiptLine[];
  wallet: { paid: number; free: number };
  /** The one step that uses what was bought (never another product). */
  next: ReceiptNext | null;
  /** Plain facts the player should keep (no auto-renewal, where the history is). */
  notes: string[];
}

export const RECEIPT_HISTORY_NOTE = '購入の記録は「その他」→「購入履歴」でいつでも確かめられます';
export const RECEIPT_SANDBOX_NOTE = 'テスト購入のため、コインは無償コインとして付与しました';

/** The next step for what was bought: the SR+ ticket first (the headline of a starter pack), then the pass, the daily pack, a silks pattern, coins. */
function nextOf(m: Master, p: Product): ReceiptNext | null {
  const items = p.items ?? [];
  const sr = items.find((it) => m.items.tickets[it.itemId]?.kind === 'srPlus');
  if (sr) return { action: 'use_sr_ticket', label: `${itemLabel(m, sr.itemId)}を使う`, itemId: sr.itemId, pattern: null };
  if (p.kind === 'season_pass') return { action: 'open_pass', label: 'シーズンパスを見る', itemId: null, pattern: null };
  if (p.kind === 'allowance') return { action: 'claim_allowance', label: '今日の分を受け取る', itemId: null, pattern: null };
  for (const it of items) {
    const pattern = patternUnlockedBy(it.itemId);
    if (pattern) return { action: 'wear_silks', label: '勝負服に着せてみる', itemId: it.itemId, pattern };
  }
  if (p.paidCoins > 0) return { action: 'scout', label: 'スカウトへ', itemId: null, pattern: null };
  return null;
}

/** The receipt of a credited purchase record (also for a duplicate delivery: the same receipt again). */
export function purchaseReceipt(m: Master, s: PlayerState, rec: PurchaseRecord): PurchaseReceipt {
  const p = findProduct(m, rec.productId);
  const lines: ReceiptLine[] = [];
  if (rec.paidCoinsGranted > 0) lines.push({ kind: 'paid_coins', label: `有償コイン${fmt(rec.paidCoinsGranted)}枚`, purpose: null, qty: rec.paidCoinsGranted });
  if ((rec.sandboxFreeGranted ?? 0) > 0) lines.push({ kind: 'free_coins', label: `無償コイン${fmt(rec.sandboxFreeGranted!)}枚`, purpose: null, qty: rec.sandboxFreeGranted });
  if (rec.bonusCoinsGranted > 0) {
    const asPaid = m.firstPurchaseBonusAsPaid === true;
    lines.push({ kind: 'bonus_free_coins', label: `はじめての購入の${asPaid ? '有償' : '無償'}コイン${fmt(rec.bonusCoinsGranted)}枚`, purpose: null, qty: rec.bonusCoinsGranted });
  }
  if (p.kind === 'season_pass') {
    const pr = m.progression.passRewards.premium;
    const levels = Math.floor(m.progression.passMaxLevel / pr.every);
    const until = rec.passUntil ?? (rec.passSeasonId ? seasonEndMs(rec.passSeasonId) : null);
    lines.push({ kind: 'pass', label: `シーズンパス有料ライン 全${levels}段`, purpose: '届いている段の報酬は、パスの画面ですぐ受け取れます', ...(until !== null ? { endsAt: until } : {}) });
    if (p.pass?.levels) lines.push({ kind: 'pass_levels', label: `パスのレベル＋${p.pass.levels}`, purpose: null, qty: p.pass.levels });
  }
  if (p.allowance) lines.push({ kind: 'allowance', label: `${p.allowance.days}日間、毎日 無償コイン${fmt(p.allowance.dailyFreeCoins)}枚（1日1回受け取り）`, purpose: null, qty: p.allowance.dailyFreeCoins });
  for (const it of p.items ?? []) lines.push({ kind: 'item', label: `${itemLabel(m, it.itemId)}×${it.qty}`, purpose: itemPurpose(m, it.itemId), itemId: it.itemId, qty: it.qty });
  const notes: string[] = [];
  if (rec.sandbox) notes.push(RECEIPT_SANDBOX_NOTE);
  if (p.kind === 'season_pass') notes.push(m.shopDisplay?.notices['shop.pass_season_only'] ?? '購入したシーズン（暦月）の終わりまで有効です');
  if (p.kind === 'season_pass' || p.kind === 'allowance') notes.push(m.shopDisplay?.notices['shop.no_auto_renew'] ?? '自動更新はありません。期間が終わっても料金は発生しません');
  notes.push(RECEIPT_HISTORY_NOTE);
  return {
    txId: rec.txId, productId: p.id, name: p.name ?? p.id, priceYen: rec.priceYen, at: rec.at, lines,
    wallet: { paid: s.wallet.paid, free: s.wallet.free }, next: nextOf(m, p), notes,
  };
}
