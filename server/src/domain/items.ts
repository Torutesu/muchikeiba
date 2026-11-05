import type { ItemQty, Reward } from './master.js';
import type { PlayerState } from './player.js';
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

export function grantReward(s: PlayerState, r: Reward, at: number, reason: string, ref: string) {
  if (r.freeCoins) grantFree(s, r.freeCoins, at, reason, ref);
  if (r.items) addItems(s, r.items);
}
