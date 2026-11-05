import type { ItemQty, Reward } from './master.js';
import type { PlayerState } from './player.js';
import { grantFree } from './wallet.js';

export function addItems(s: PlayerState, items: ItemQty[]) {
  for (const it of items) s.items[it.itemId] = (s.items[it.itemId] ?? 0) + it.qty;
}

export function grantReward(s: PlayerState, r: Reward, at: number, reason: string, ref: string) {
  if (r.freeCoins) grantFree(s, r.freeCoins, at, reason, ref);
  if (r.items) addItems(s, r.items);
}
