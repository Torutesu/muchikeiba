import { AppError } from './errors.js';
import type { Currency, PlayerState } from './player.js';

/**
 * Wallet rules (REQ-WAL-*):
 * - paid and free balances are separate, every change is a ledger row
 * - spending uses PAID first (reduces unused paid balance under the Payment Services Act)
 * - balances never go negative; refunds that cannot be covered become `debt`
 */
function ledger(s: PlayerState, at: number, kind: Parameters<typeof push>[2], currency: Currency, delta: number, reason: string, ref: string) {
  push(s, at, kind, currency, delta, reason, ref);
}
function push(s: PlayerState, at: number, kind: 'grant' | 'spend' | 'purchase' | 'bonus' | 'refund' | 'debt' | 'settle', currency: Currency, delta: number, reason: string, ref: string) {
  s.ledgerSeq += 1;
  s.ledger.push({ seq: s.ledgerSeq, at, kind, currency, delta, balanceAfter: currency === 'paid' ? s.wallet.paid : s.wallet.free, reason, ref });
}

function checkInt(n: number) {
  if (!Number.isInteger(n) || n < 0) throw new AppError('BAD_REQUEST', `amount must be a non-negative integer: ${n}`);
}

export function grantFree(s: PlayerState, amount: number, at: number, reason: string, ref: string, kind: 'grant' | 'bonus' = 'grant') {
  checkInt(amount);
  if (amount === 0) return;
  s.wallet.free += amount;
  ledger(s, at, kind, 'free', amount, reason, ref);
}

/** Adds paid coins as a new FIFO lot. Outstanding debt is settled first. Returns lot id. */
export function grantPaid(s: PlayerState, amount: number, priceYen: number, at: number, reason: string, txId: string): string {
  checkInt(amount);
  s.counters.lotSeq += 1;
  const lotId = `lot${s.counters.lotSeq}`;
  const unitPriceMicroYen = amount > 0 ? Math.round((priceYen * 1_000_000) / amount) : 0;
  s.wallet.lots.push({ lotId, txId, granted: amount, remaining: amount, unitPriceMicroYen, at });
  s.wallet.paid += amount;
  ledger(s, at, 'purchase', 'paid', amount, reason, txId);
  if (s.wallet.debt > 0) {
    const settle = Math.min(s.wallet.debt, s.wallet.paid);
    consumePaid(s, settle);
    s.wallet.debt -= settle;
    ledger(s, at, 'settle', 'paid', -settle, 'debt settlement', txId);
  }
  return lotId;
}

function consumePaid(s: PlayerState, amount: number) {
  let left = amount;
  for (const lot of s.wallet.lots) {
    if (left === 0) break;
    const take = Math.min(lot.remaining, left);
    lot.remaining -= take;
    left -= take;
  }
  s.wallet.paid -= amount;
  s.wallet.lots = s.wallet.lots.filter((l) => l.remaining > 0);
}

export interface SpendResult { paid: number; free: number }

/** Spends coins, paid first. `paidOnly` products can only use paid coins. */
export function spend(s: PlayerState, amount: number, opts: { paidOnly: boolean }, at: number, reason: string, ref: string): SpendResult {
  checkInt(amount);
  if (s.wallet.debt > 0 || Object.values(s.itemDebt ?? {}).some((n) => n > 0)) throw new AppError('UNSETTLED_DEBT');
  const available = opts.paidOnly ? s.wallet.paid : s.wallet.paid + s.wallet.free;
  if (available < amount) throw new AppError('INSUFFICIENT_COINS', `need ${amount}, have ${available}`);
  const fromPaid = Math.min(s.wallet.paid, amount);
  const fromFree = amount - fromPaid;
  if (fromPaid > 0) {
    consumePaid(s, fromPaid);
    ledger(s, at, 'spend', 'paid', -fromPaid, reason, ref);
  }
  if (fromFree > 0) {
    s.wallet.free -= fromFree;
    ledger(s, at, 'spend', 'free', -fromFree, reason, ref);
  }
  return { paid: fromPaid, free: fromFree };
}

/**
 * Refund of a purchase: removes the coins it granted (that lot first, then other paid lots).
 * Whatever cannot be removed becomes debt, which blocks gacha/purchases until settled (REQ-PUR-006).
 */
export function refundPaid(s: PlayerState, lotId: string | null, amount: number, at: number, ref: string): { removed: number; debt: number } {
  checkInt(amount);
  let left = amount;
  let removed = 0;
  const lot = lotId ? s.wallet.lots.find((l) => l.lotId === lotId) : undefined;
  if (lot) {
    const take = Math.min(lot.remaining, left);
    lot.remaining -= take;
    s.wallet.paid -= take;
    left -= take;
    removed += take;
    s.wallet.lots = s.wallet.lots.filter((l) => l.remaining > 0);
  }
  const fromOther = Math.min(s.wallet.paid, left);
  if (fromOther > 0) {
    consumePaid(s, fromOther);
    left -= fromOther;
    removed += fromOther;
  }
  if (removed > 0) ledger(s, at, 'refund', 'paid', -removed, 'store refund', ref);
  if (left > 0) {
    s.wallet.debt += left;
    ledger(s, at, 'debt', 'paid', 0, `unsettled refund ${left}`, ref);
  }
  return { removed, debt: left };
}

/**
 * Refund of FREE coins granted with a purchase (first-purchase bonus). Shortfall becomes debt, which is
 * settled by the next paid grant like any other refund debt.
 */
export function clawbackFree(s: PlayerState, amount: number, at: number, ref: string): { removed: number; debt: number } {
  checkInt(amount);
  const removed = Math.min(s.wallet.free, amount);
  if (removed > 0) {
    s.wallet.free -= removed;
    ledger(s, at, 'refund', 'free', -removed, 'store refund (bonus)', ref);
  }
  const left = amount - removed;
  if (left > 0) {
    s.wallet.debt += left;
    ledger(s, at, 'debt', 'free', 0, `unsettled bonus refund ${left}`, ref);
  }
  return { removed, debt: left };
}

/** Outstanding paid balance valued at purchase price, in yen (rounded down). */
export function paidBalanceYen(s: PlayerState): number {
  let micro = 0;
  for (const l of s.wallet.lots) micro += l.remaining * l.unitPriceMicroYen;
  return Math.floor(micro / 1_000_000);
}

export function invariantsHold(s: PlayerState): boolean {
  const lotSum = s.wallet.lots.reduce((a, l) => a + l.remaining, 0);
  return s.wallet.paid >= 0 && s.wallet.free >= 0 && s.wallet.debt >= 0 && lotSum === s.wallet.paid;
}
