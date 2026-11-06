import type { ItemQty, Master, Reward } from './master.js';
import { createHorseFromTemplate } from './horses.js';
import { ITEM_LOG_KEEP, type PlayerState } from './player.js';
import { AppError } from './errors.js';
import { grantFree } from './wallet.js';

/** Grants items. Items owed after a refund (itemDebt) are settled first. */
export function addItems(s: PlayerState, items: ItemQty[]) {
  for (const it of items) {
    let qty = it.qty;
    const owed = s.itemDebt?.[it.itemId] ?? 0;
    if (owed > 0) {
      const settle = Math.min(owed, qty);
      qty -= settle;
      s.itemDebt![it.itemId] = owed - settle;
      if (s.itemDebt![it.itemId] === 0) delete s.itemDebt![it.itemId];
    }
    if (qty > 0) s.items[it.itemId] = (s.items[it.itemId] ?? 0) + qty;
  }
}

/** Removes items granted by a refunded purchase. What was already used becomes itemDebt. */
export function clawbackItems(s: PlayerState, items: ItemQty[]): Record<string, number> {
  const owed: Record<string, number> = {};
  for (const it of items) {
    const have = s.items[it.itemId] ?? 0;
    const take = Math.min(have, it.qty);
    if (take > 0) s.items[it.itemId] = have - take;
    if (s.items[it.itemId] === 0) delete s.items[it.itemId];
    const short = it.qty - take;
    if (short > 0) {
      s.itemDebt ??= {};
      s.itemDebt[it.itemId] = (s.itemDebt[it.itemId] ?? 0) + short;
      owed[it.itemId] = short;
    }
  }
  return owed;
}

export const hasItemDebt = (s: PlayerState) => Object.values(s.itemDebt ?? {}).some((n) => n > 0);

export function grantReward(s: PlayerState, r: Reward, at: number, reason: string, ref: string, m?: Pick<Master, 'templateById'>) {
  if (r.freeCoins) grantFree(s, r.freeCoins, at, reason, ref);
  if (r.items) addItems(s, r.items);
  if (r.horse) {
    // REQ-BREED-022: horse rewards (event milestones / rank rewards) need the template table
    const t = m?.templateById.get(r.horse);
    if (!t) throw new AppError('CONFIG_INVALID', `reward horse ${r.horse} cannot be granted here`);
    createHorseFromTemplate(s, t, at);
  }
  if (r.broodmare) {
    // REQ-UXS-013: a broodmare (retired female) so breeding can be tried without retiring a racer
    const t = m?.templateById.get(r.broodmare);
    if (!t || t.sex !== 'female') throw new AppError('CONFIG_INVALID', `reward broodmare ${r.broodmare} cannot be granted here`);
    createHorseFromTemplate(s, t, at).status = 'retired';
  }
  // REQ-UXS-016: season pass experience (the pass level follows from it, capped at passMaxLevel)
  if (r.passXp) s.seasonPass.xp += r.passXp;
}

/** REQ-ITEM-008: item movements initiated by the player are logged (item ledger, capped). */
export function logItem(s: PlayerState, at: number, itemId: string, delta: number, reason: string, ref: string) {
  s.itemLog ??= [];
  const seq = (s.itemLog[s.itemLog.length - 1]?.seq ?? 0) + 1;
  s.itemLog.push({ seq, at, itemId, delta, reason, ref });
  if (s.itemLog.length > ITEM_LOG_KEEP) s.itemLog.splice(0, s.itemLog.length - ITEM_LOG_KEEP);
}

/**
 * Spends owned items. Refused while any item or coin debt is open (items granted by a refunded
 * purchase must be settled before more are used — REQ-PUR-006).
 */
export function consumeItem(s: PlayerState, itemId: string, qty: number, at: number, reason: string, ref: string) {
  if (!Number.isInteger(qty) || qty <= 0) throw new AppError('BAD_REQUEST', 'qty must be a positive integer');
  if (s.wallet.debt > 0 || hasItemDebt(s)) throw new AppError('UNSETTLED_DEBT');
  const have = s.items[itemId] ?? 0;
  if (have < qty) throw new AppError('INSUFFICIENT_ITEMS', `need ${qty} ${itemId}, have ${have}`);
  s.items[itemId] = have - qty;
  if (s.items[itemId] === 0) delete s.items[itemId];
  logItem(s, at, itemId, -qty, reason, ref);
}
