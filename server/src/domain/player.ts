import type { GoingAptitude } from './schemas.js';
import type { BondState } from './bond.js';
import type { PresetsState } from './presets.js';
import type { Rarity, Reward, Sex, Stats, Style } from './master.js';
import type { PushState } from './push.js';
import type { KpiState } from './kpi.js';
import type { TimeAttackState } from './timeAttack.js';
import type { PlayerTeamState } from './teams.js';
import type { PlayerEventState } from './events.js';
import { appearanceOf, defaultSilks, effectiveSilks, type Appearance, type Silks } from './visuals.js';
import type { BannedSilksList } from './bannedSilks.js';
import type { PassSeasonRecord, ShopState } from './shop.js';
import type { ConsentState, OnboardingState, SeasonMissionState } from './onboarding.js';
import type { NudgeState } from './nudges.js';
import type { DeletionState } from './accountDeletion.js';
import type { ReferralState } from './invite.js';
import type { ComebackState } from './comeback.js';

export type Currency = 'paid' | 'free';

/** Append-only ledger row (REQ-WAL-001). */
export interface LedgerEntry {
  /** `forfeit`: balances given up when the account is deleted (REQ-UXS-040). */
  seq: number; at: number; kind: 'grant' | 'spend' | 'purchase' | 'bonus' | 'refund' | 'debt' | 'settle' | 'forfeit';
  currency: Currency; delta: number; balanceAfter: number; reason: string; ref: string;
}

/** Paid coins are tracked in FIFO lots with their purchase unit price (REQ-WAL-005). */
export interface PaidLot { lotId: string; txId: string; granted: number; remaining: number; unitPriceMicroYen: number; at: number }

export interface HorseInstance {
  id: string; templateId: string | null; name: string; rarity: Rarity; sex: Sex; style: Style;
  distMinM: number; distMaxM: number; surface: 'turf' | 'dirt' | 'both'; line: string;
  base: Stats; awakening: number; bornAt: number; status: 'active' | 'retired';
  sireId: string | null; damId: string | null; sireName: string | null; damName: string | null; named: boolean;
  /** Ground preference (REQ-RACE-035). Absent = any (horses created before it existed). */
  goingAptitude?: GoingAptitude;
  /** Look (REQ-ASSET-003). Filled by migratePlayer for horses stored before it existed. */
  appearance?: Appearance;
  /** REQ-BREED-014: the sire was another player's stallion (lineage records both sides). */
  studSire?: { ownerId: string; horseId: string; sireName: string | null; damName: string | null };
  /** REQ-BREED-017: a trait inherited from a grandparent (隔世遺伝). */
  atavism?: { trait: 'style' | 'goingAptitude'; value: string; from: string };
  /** 固有スキル id (REQ-UXS-050): from the template, or inherited by a foal. Absent on a foal = none (see skills.ts horseSkillId). */
  skillId?: string;
  /** REQ-TRAIN-003: stat points gained from training (training.ts). Counts in races (normalised in ranked), not in breeding. */
  trained?: Stats;
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
  /** JST month of the store purchase (purchasedAt), used for the monthly limit. */
  month?: string;
  /** Sandbox purchase: coins credited as FREE coins (never paid lots; review r5 #7). */
  sandboxFreeGranted?: number;
  /** Season pass: end of the period this purchase paid for (review r5 #6). */
  passUntil?: number;
  /** REQ-UXS-020: the season (JST month) a per-season pass purchase covers. */
  passSeasonId?: string;
  /** REQ-UXS-018/021: free coins granted later because of this purchase (daily pack, pass rewards); held from stud fees like the bonus. */
  linkedFree?: number;
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

import type { AdsState } from './ads.js';

export interface PlayerState {
  v: 1;
  id: string;
  createdAt: number;
  wallet: { paid: number; free: number; debt: number; lots: PaidLot[] };
  ledger: LedgerEntry[];
  ledgerSeq: number;
  idem: { key: string; result: unknown }[];
  /**
   * QA r6 #3: race results already applied to this player, by raceId → applied-at (ms). Separate from the
   * client idempotency ring (which holds only IDEM_KEEP keys shared with client calls), so a settlement or
   * dead-letter retry long after the fact can never apply the same race twice. Pruned by age.
   */
  appliedRaces?: Record<string, number>;
  /** Event board updates that could not be delivered after a race was applied; re-sent on the next race. */
  pendingEventPushes?: Record<string, unknown>;
  horses: HorseInstance[];
  items: Record<string, number>;
  materials: { awakening: number };
  pity: Record<string, number>;
  /** REQ-GACHA-014: step-up 10-pulls done per banner id (absent until the first one). */
  stepUp?: Record<string, number>;
  purchases: PurchaseRecord[];
  firstPurchased: string[];
  monthlySpendYen: Record<string, number>;
  age: { birthYear: number; birthMonth: number; guardianConsent: boolean; setAt: number } | null;
  /** partnerHorseId: the first partner granted by POST /v1/player/partner (REQ-UXS-002). */
  flags: { tutorialGachaUsed: boolean; partnerHorseId?: string };
  /** `boostXp`: XP added by a Pass+ purchase this season (REQ-UXS-019; removed again if it is refunded). */
  seasonPass: { expiresAt: number; xp: number; claimed: { free: number[]; premium: number[] }; seasonId: string; boostXp?: number;
    /** REQ-UXS-040: given up by an account deletion (no automatic grant at the season close). */
    forfeitedAt?: number };
  /**
   * streakDay: normal 7-day cycle days claimed. beginnerDay (REQ-UXS-013): beginner-table days claimed; absent on
   * states stored before it existed (players who never claimed start the beginner table, the others skip it).
   */
  loginBonus: { streakDay: number; lastClaimDate: string | null; beginnerDay?: number };
  missions: { date: string; progress: Record<string, number>; claimed: string[] };
  breeding: { date: string | null; count: number };
  rating: { r: number; rd: number; vol: number; rankedRaces: number };
  season: { id: string; classId: string; points: number; races: number };
  counters: { horseSeq: number; lotSeq: number };
  /** Items owed back after a refund of a purchase whose items were already used (settled by later grants). */
  itemDebt?: Record<string, number>;
  /** Flags for customer support (e.g. `monthly_limit_breach:2026-11`). */
  supportFlags?: string[];
  /** QA R11 (REQ-OPS-026): single-person support grants of the last 24 h (the budget that splitting cannot get around). */
  supportGrants?: { at: number; freeCoins: number; items: Record<string, number> }[];
  /** Store subscriptions (auto-renewing season pass), keyed by original transaction id. Optional for older states. */
  storeSubscriptions?: Record<string, { platform: PurchaseRecord['platform']; status: string; expiresAt: number | null; updatedAt: number }>;
  profile: { displayName: string; titleId: string | null; lastSeenAt: number; lastPushedAt: number; silks?: Silks };
  stats: PlayerStats;
  titles: string[];
  friends: FriendsState;
  seasonHistory: SeasonRecord[];
  /** Friend-race rewards paid today (daily cap, REQ-REW-004). */
  friendRewards: { date: string; count: number };
  /** Time attack sessions, bests and milestones (REQ-TA-*). Created lazily. */
  timeAttack?: TimeAttackState;
  /** REQ-PUSH-*: devices, preferences, outbox (created on first use; see push.ts ensurePush). */
  push?: PushState;
  /** REQ-KPI-*: first_open flag and client ingestion rate counters (see kpi.ts ensureKpi). */
  kpi?: KpiState;
  /** REQ-TEAM-*: team membership, cooldown and paid team seasons (created on first use; see teams.ts ensureTeam). */
  team?: PlayerTeamState;
  /** REQ-EVENT-*: per-event progress, pending entry fee and paid rewards (see events.ts). */
  events?: Record<string, PlayerEventState>;
  /** REQ-TOUR-007: tournament results (paid once per tournament; newest kept). */
  tournaments?: Record<string, { name: string; rank: number; at: number; reward: Reward | null }>;
  /** Anti-cheat status pushed by the integrity service (REQ-OPS-035). Absent = ok. */
  moderation?: { status: 'ok' | 'quarantined' | 'banned'; until: number | null; reason: string; at: number };
  /** REQ-BOND-*: care points per horse and account-wide level rewards already paid (created on first care). */
  bond?: BondState;
  /** REQ-ROOM-*: course look and private-room conditions (created on first change). */
  presets?: PresetsState;
  /** Results of admin money operations by op key; never evicted, so an opKey can never pay twice (review r5 #4). */
  adminOps?: Record<string, unknown>;
  /** REQ-ITEM-006: equipped cosmetics (tack per slot, stable decor slots). Optional for older states. */
  equipment?: Equipment;
  /** REQ-ITEM-008: append-only log of item spends and cosmetic purchases (last ITEM_LOG_KEEP kept). */
  itemLog?: ItemLogEntry[];
  /** REQ-ITEM-003: extra breedings bought with material today (JST date). */
  breedingExtra?: { date: string; count: number };
  /** REQ-BREED-010..016: stud lending, both as owner and as borrower (created on first use; see stud.ts). */
  stud?: StudState;
  /** REQ-UXS-017/018: offer triggers and views, daily-pack entitlements (created on first use; see shop.ts). */
  shop?: ShopState;
  /** REQ-UXS-021: closed seasons' pass results incl. rewards granted automatically at the close (newest last). */
  passHistory?: PassSeasonRecord[];
  /** REQ-UXS-010: wins counted for today's first-win bonus (game day). */
  dailyWins?: { date: string; count: number };
  /** REQ-UXS-001: terms / privacy versions consented to. */
  consent?: ConsentState;
  /** REQ-UXS-014/015: unlock counters and beginner mission progress (see onboarding.ts). */
  onboarding?: OnboardingState;
  /** REQ-UXS-016: this season's mission progress. */
  seasonMissions?: SeasonMissionState;
  /** REQ-UXS-012: personal push nudges already scheduled / sent. */
  nudges?: NudgeState;
  /** REQ-UXS-040: account deletion request (confirmation token, then the scheduled deletion). */
  deletion?: DeletionState;
  /** REQ-INV-*: invite code redemption, invitees, milestone outbox (created on first use; see invite.ts). */
  referral?: ReferralState;
  /** REQ-CB-*: last active game day, the comeback window, lapse reminders and what's-new position (comeback.ts). */
  comeback?: ComebackState;
  /** REQ-AD-*: rewarded ads — preference, today's counts, sessions, seen transaction ids (created on first use; ads.ts ensureAds). */
  ads?: AdsState;
  /** REQ-TRAIN-*: today's training slots, the open session, per-horse fatigue and log (training.ts ensureTraining). */
  training?: import('./training.js').TrainingState;
  /** REQ-BOX-*: プレゼントボックス — unclaimed entries and the recent history (giftBox.ts ensureGiftBox). */
  giftBox?: import('./giftBox.js').GiftBoxState;
  /** REQ-ASSIST-*: かんたん操作 setting, the last-place streak and the one-time suggestion (assist.ts ensureAssist). */
  assist?: import('./assist.js').AssistState;
  /** REQ-RIVAL-*: opt-out, this week's rival and score, unsettled weeks, results (rival.ts ensureRival). */
  rival?: import('./rival.js').RivalState;
  /** REQ-HIST-004: one record per gacha draw, last 90 days (history.ts recordGachaLog; the Durable Object keeps older ones in SQL). */
  gachaLog?: import('./history.js').GachaLogState;
  /** REQ-WCH-*: weekly challenge sessions, this and last week's progress, earned badges (weeklyChallenge.ts wchState). */
  weeklyChallenge?: import('./weeklyChallenge.js').WeeklyChallengeState;
}

export interface StudListing { horseId: string; visibility: 'friends' | 'public'; fee: number; dailyLimit: number; listedAt: number }
export interface StudHistoryEntry {
  opId: string; role: 'lent' | 'borrowed'; at: number; ownerId: string; borrowerId: string; horseId: string; horseName: string;
  /** Fee charged to the borrower / paid out to the owner (owner side may be less: daily earn cap). */
  fee: number; paid: number; foalId: string | null;
}
export interface StudState {
  listings: StudListing[];
  /** Owner: reservations in flight by opId (released when settled or after reserveTtlMs). */
  reservations: Record<string, { horseId: string; borrowerId: string; fee: number; at: number; date: string }>;
  /**
   * Owner: settled opIds, so a retried settlement never pays twice and a retried reserve resumes the same
   * horse (pruned by age). Older records are a bare settled-at number.
   */
  settled: Record<string, number | { at: number; horseId: string; borrowerId: string; fee: number }>;
  /** Owner: today's lends per horse and coins earned (JST date). */
  lends: { date: string; byHorse: Record<string, number>; earned: number };
  /** Borrower: stud breedings applied, by opId → result (never applied twice). */
  applied: Record<string, { at: number; result: unknown }>;
  /** Borrower: fee payments the owner has not acknowledged yet (retried from the object's alarm). */
  outbox: { opId: string; ownerId: string; horseId: string; fee: number; foalId: string; at: number; nextAt: number; attempts: number }[];
  /** Borrower: stud breedings today (JST date). */
  borrows: { date: string; count: number };
  history: StudHistoryEntry[];
}

export interface Equipment { tack: Partial<Record<'bridle' | 'saddlecloth', string>>; decor: (string | null)[] }
export interface ItemLogEntry { seq: number; at: number; itemId: string; delta: number; reason: string; ref: string }
export const ITEM_LOG_KEEP = 200;

/** Effective moderation status at `now` (expired quarantines/bans read as ok). */
export function moderationOf(s: PlayerState, now: number): 'ok' | 'quarantined' | 'banned' {
  const m = s.moderation;
  if (!m || m.status === 'ok') return 'ok';
  if (m.until !== null && now >= m.until) return 'ok';
  return m.status;
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
  // REQ-ASSET-003/005: looks for horses and silks stored before the visual contract existed
  for (const h of x.horses) h.appearance ??= appearanceOf(h, x.id);
  x.profile.silks ??= defaultSilks(`p:${x.id}`);
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
    profile: { displayName: defaultDisplayName(id), titleId: null, lastSeenAt: now, lastPushedAt: 0, silks: defaultSilks(`p:${id}`) },
    stats: newStats(),
    titles: [],
    friends: { ids: [], incoming: [], outgoing: [], invites: [] },
    seasonHistory: [],
    friendRewards: { date: '', count: 0 },
  };
}

/** Public view returned by the API (no ledger dump). `extra`: computed sections (consent, unlocks, …; service.ts). */
export function playerView<E extends object = object>(s: PlayerState, banned?: BannedSilksList, extra?: E) {
  return {
    ...(extra ?? ({} as E)),
    id: s.id,
    wallet: { paid: s.wallet.paid, free: s.wallet.free, total: s.wallet.paid + s.wallet.free, debt: s.wallet.debt },
    items: s.items, materials: s.materials, pity: s.pity, stepUp: s.stepUp ?? {}, horses: s.horses,
    ageRegistered: s.age !== null, flags: s.flags, seasonPass: s.seasonPass, loginBonus: s.loginBonus,
    rating: { r: Math.round(s.rating.r), rd: Math.round(s.rating.rd), rankedRaces: s.rating.rankedRaces }, season: s.season,
    profile: { displayName: s.profile.displayName, titleId: s.profile.titleId, silks: effectiveSilks(s.profile.silks, `p:${s.id}`, banned) }, titles: s.titles, stats: s.stats,
    equipment: s.equipment ?? { tack: {}, decor: [] },
    seasonHistory: s.seasonHistory,
  };
}
