import type { Rarity, Sex, Stats, Style } from './master.js';

export type Currency = 'paid' | 'free';

/** Append-only ledger row (REQ-WAL-001). */
export interface LedgerEntry {
  seq: number; at: number; kind: 'grant' | 'spend' | 'purchase' | 'bonus' | 'refund' | 'debt' | 'settle';
  currency: Currency; delta: number; balanceAfter: number; reason: string; ref: string;
}

/** Paid coins are tracked in FIFO lots with their purchase unit price (REQ-WAL-005). */
export interface PaidLot { lotId: string; txId: string; granted: number; remaining: number; unitPriceMicroYen: number; at: number }

export interface HorseInstance {
  id: string; templateId: string | null; name: string; rarity: Rarity; sex: Sex; style: Style;
  distMinM: number; distMaxM: number; surface: 'turf' | 'dirt' | 'both'; line: string;
  base: Stats; awakening: number; bornAt: number; status: 'active' | 'retired';
  sireId: string | null; damId: string | null; sireName: string | null; damName: string | null; named: boolean;
}

export interface PurchaseRecord {
  txId: string; platform: 'apple' | 'google' | 'fake'; productId: string; priceYen: number; at: number;
  paidCoinsGranted: number; bonusCoinsGranted: number; lotId: string | null; refunded: boolean; limitBreach: boolean;
}

export interface PlayerState {
  v: 1;
  id: string;
  createdAt: number;
  wallet: { paid: number; free: number; debt: number; lots: PaidLot[] };
  ledger: LedgerEntry[];
  ledgerSeq: number;
  idem: { key: string; result: unknown }[];
  horses: HorseInstance[];
  items: Record<string, number>;
  materials: { awakening: number };
  pity: Record<string, number>;
  purchases: PurchaseRecord[];
  firstPurchased: string[];
  monthlySpendYen: Record<string, number>;
  age: { birthYear: number; birthMonth: number; guardianConsent: boolean; setAt: number } | null;
  flags: { tutorialGachaUsed: boolean };
  seasonPass: { expiresAt: number; xp: number; claimed: { free: number[]; premium: number[] }; seasonId: string };
  loginBonus: { streakDay: number; lastClaimDate: string | null };
  missions: { date: string; progress: Record<string, number>; claimed: string[] };
  breeding: { date: string | null; count: number };
  rating: { r: number; rd: number; vol: number; rankedRaces: number };
  season: { id: string; classId: string; points: number };
  counters: { horseSeq: number; lotSeq: number };
}

export function newPlayer(id: string, now: number, seasonId: string): PlayerState {
  return {
    v: 1, id, createdAt: now,
    wallet: { paid: 0, free: 0, debt: 0, lots: [] },
    ledger: [], ledgerSeq: 0, idem: [], horses: [], items: {}, materials: { awakening: 0 }, pity: {},
    purchases: [], firstPurchased: [], monthlySpendYen: {}, age: null, flags: { tutorialGachaUsed: false },
    seasonPass: { expiresAt: 0, xp: 0, claimed: { free: [], premium: [] }, seasonId },
    loginBonus: { streakDay: 0, lastClaimDate: null },
    missions: { date: '', progress: {}, claimed: [] },
    breeding: { date: null, count: 0 },
    rating: { r: 1500, rd: 350, vol: 0.06, rankedRaces: 0 },
    season: { id: seasonId, classId: 'C', points: 0 },
    counters: { horseSeq: 0, lotSeq: 0 },
  };
}

/** Public view returned by the API (no ledger dump). */
export function playerView(s: PlayerState) {
  return {
    id: s.id,
    wallet: { paid: s.wallet.paid, free: s.wallet.free, total: s.wallet.paid + s.wallet.free, debt: s.wallet.debt },
    items: s.items, materials: s.materials, pity: s.pity, horses: s.horses,
    ageRegistered: s.age !== null, flags: s.flags, seasonPass: s.seasonPass, loginBonus: s.loginBonus,
    rating: { r: Math.round(s.rating.r), rd: Math.round(s.rating.rd), rankedRaces: s.rating.rankedRaces }, season: s.season,
  };
}
