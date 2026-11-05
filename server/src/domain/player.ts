import type { Rarity, Sex, Stats, Style } from './master.js';
import type { PushState } from './push.js';
import type { KpiState } from './kpi.js';

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
  /** Sandbox / license-test purchase (no real money; priceYen 0). */
  sandbox?: boolean;
  /** Subscription id across renewals. */
  originalTxId?: string;
  /** Lot of a first-purchase bonus granted as PAID coins (firstPurchaseBonusAsPaid). */
  bonusLotId?: string | null;
}

/** REQ-STAT-001: per-player race statistics (ranked + friend races; tutorial excluded). */
export interface PlayerStats {
  races: number; wins: number; top3: number;
  byStyle: Partial<Record<Style, { races: number; wins: number }>>;
  byTrack: Record<string, { races: number; wins: number; bestFinishTick: number | null }>;
  /** Wins with at least 3 whips and no mashing (no two whips inside the diminishing window). */
  whipPerfectWins: number;
  /** Ticks between the gate opening and the player's START input (0 = perfect). */
  bestStartReactionTicks: number | null;
  /** Starts with a reaction of at most 1 tick. */
  perfectStarts: number;
}

/** Closed season record kept for rewards (REQ-SEASON-002). */
export interface SeasonRecord { seasonId: string; classId: string; points: number; races: number; nextClassId: string; rank: number | null; rewarded: boolean }

export interface FriendsState {
  ids: string[];
  incoming: { from: string; at: number }[];
  outgoing: { to: string; at: number }[];
  invites: { from: string; passphrase: string; at: number }[];
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
  season: { id: string; classId: string; points: number; races: number };
  counters: { horseSeq: number; lotSeq: number };
  /** Items owed back after a refund of a purchase whose items were already used (settled by later grants). */
  itemDebt?: Record<string, number>;
  /** Flags for customer support (e.g. `monthly_limit_breach:2026-11`). */
  supportFlags?: string[];
  /** Store subscriptions (auto-renewing season pass), keyed by original transaction id. Optional for older states. */
  storeSubscriptions?: Record<string, { platform: PurchaseRecord['platform']; status: string; expiresAt: number | null; updatedAt: number }>;
  profile: { displayName: string; titleId: string | null; lastSeenAt: number; lastPushedAt: number };
  stats: PlayerStats;
  titles: string[];
  friends: FriendsState;
  seasonHistory: SeasonRecord[];
  /** Friend-race rewards paid today (daily cap, REQ-REW-004). */
  friendRewards: { date: string; count: number };
  /** REQ-PUSH-*: devices, preferences, outbox (created on first use; see push.ts ensurePush). */
  push?: PushState;
  /** REQ-KPI-*: first_open flag and client ingestion rate counters (see kpi.ts ensureKpi). */
  kpi?: KpiState;
}

export const newStats = (): PlayerStats => ({ races: 0, wins: 0, top3: 0, byStyle: {}, byTrack: {}, whipPerfectWins: 0, bestStartReactionTicks: null, perfectStarts: 0 });
export const defaultDisplayName = (id: string) => `騎手${id.replace(/[^A-Za-z0-9]/g, '').slice(-4).toUpperCase() || '0000'}`;

/** Fills fields added after a player's state was first stored (states are never rewritten in bulk). */
export function migratePlayer(s: PlayerState): PlayerState {
  const x = s as Partial<PlayerState> & PlayerState;
  if (x.season.races === undefined) x.season.races = 0;
  x.profile ??= { displayName: defaultDisplayName(x.id), titleId: null, lastSeenAt: 0, lastPushedAt: 0 };
  x.stats ??= newStats();
  x.titles ??= [];
  x.friends ??= { ids: [], incoming: [], outgoing: [], invites: [] };
  x.seasonHistory ??= [];
  x.friendRewards ??= { date: '', count: 0 };
  return x;
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
    season: { id: seasonId, classId: 'C', points: 0, races: 0 },
    counters: { horseSeq: 0, lotSeq: 0 },
    profile: { displayName: defaultDisplayName(id), titleId: null, lastSeenAt: now, lastPushedAt: 0 },
    stats: newStats(),
    titles: [],
    friends: { ids: [], incoming: [], outgoing: [], invites: [] },
    seasonHistory: [],
    friendRewards: { date: '', count: 0 },
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
    profile: { displayName: s.profile.displayName, titleId: s.profile.titleId }, titles: s.titles, stats: s.stats,
    seasonHistory: s.seasonHistory,
  };
}
