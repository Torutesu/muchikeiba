import { jstDateKey } from './time.js';

/** 資金決済法: unused paid balance on base dates (Mar 31 / Sep 30) above ¥10M requires filing + 50% deposit. */
export const PAYMENT_ACT_THRESHOLD_YEN = 10_000_000;

export interface PaidBalanceSnapshot { playerId: string; date: string; paidCoins: number; paidYen: number }

export function isBaseDate(ms: number): boolean {
  const d = jstDateKey(ms).slice(5);
  return d === '03-31' || d === '09-30';
}

export function aggregatePaidBalances(snapshots: PaidBalanceSnapshot[]) {
  // keep the latest snapshot per player
  const latest = new Map<string, PaidBalanceSnapshot>();
  for (const s of snapshots) {
    const prev = latest.get(s.playerId);
    if (!prev || prev.date <= s.date) latest.set(s.playerId, s);
  }
  let totalCoins = 0;
  let totalYen = 0;
  for (const s of latest.values()) {
    totalCoins += s.paidCoins;
    totalYen += s.paidYen;
  }
  return {
    players: latest.size,
    totalPaidCoins: totalCoins,
    totalPaidYen: totalYen,
    exceedsThreshold: totalYen > PAYMENT_ACT_THRESHOLD_YEN,
    /** Required deposit if exceeded: at least half of the balance. */
    requiredDepositYen: totalYen > PAYMENT_ACT_THRESHOLD_YEN ? Math.ceil(totalYen / 2) : 0,
  };
}
