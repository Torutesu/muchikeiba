import tracksJson from '../../master/tracks.json';
import { BASE_BANNED_SILKS, type BannedSilksList } from './bannedSilks.js';
import type { BondConfig } from './bond.js';
import type { RoomsConfig } from './presets.js';
import type { StableConfig } from './stable.js';
import horsesJson from '../../master/horses.json';
import gachaJson from '../../master/gacha.json';
import nicksJson from '../../master/nicks.json';
import ngJson from '../../master/ng-names.json';
import ageJson from '../../master/age-limits.json';
import productsJson from '../../master/products.json';
import type { TimeAttackConfig } from './timeAttack.js';
import type { AdsConfig } from './ads.js';
import progressionJson from '../../master/progression.json';
import titlesJson from '../../master/titles.json';
import pushJson from '../../master/push.json';
import eventsJson from '../../master/events.json';
import itemsJson from '../../master/items.json';
import assetsCatalogJson from '../../master/assets-catalog.json';
import changelogJson from '../../master/changelog.json';
import { parseAssetCatalog, type AssetCatalog } from './assetCatalog.js';
import type { StampsMaster } from './teamFeed.js';
import stampsJson from '../../master/stamps.json';
import localeEnJson from '../../master/locale-en.json';
import type { CollectionMaster } from './collection.js';
import collectionJson from '../../master/collection.json';
import photoJson from '../../master/photo.json';
import { trackSchema, type GoingAptitude, type Going, type Track } from './schemas.js';
import { AppError } from './errors.js';
import { loadSkills, type SkillsMaster } from './skills.js';
import { addJstDays, DAY_MS, dayRule, gameDayStartMs, type DayRule } from './time.js';

export type Rarity = 'R' | 'SR' | 'SSR';
export const RARITY_ORDER: Rarity[] = ['R', 'SR', 'SSR'];
export type Style = 'nige' | 'senko' | 'sashi' | 'oikomi';
export type Sex = 'male' | 'female';
export type Stats = { speed: number; stamina: number; burst: number; guts: number; temper: number };
export const STAT_KEYS: (keyof Stats)[] = ['speed', 'stamina', 'burst', 'guts', 'temper'];

export interface HorseTemplate {
  id: string; name: string; rarity: Rarity; sex: Sex; style: Style; distMinM: number; distMaxM: number;
  surface: 'turf' | 'dirt' | 'both'; line: string; sireName: string; damName: string; stats: Stats;
  /** Ground preference (REQ-RACE-035). Absent = any. */
  goingAptitude?: GoingAptitude;
  /**
   * REQ-BREED-020: a limited-time (季節限定) horse. Obtainable only from banners that list it in `seasonal`
   * and events that reward it, inside this window; horses already owned stay owned after it ends.
   */
  seasonal?: SeasonalInfo;
  /**
   * REQ-UXS-002/013: a horse handed out by the game itself (the first partner, the beginner broodmare). Never in a
   * gacha pool, a ticket table or a CPU field (validated), so it cannot be bought or drawn.
   */
  giftOnly?: boolean;
  /** 固有スキル (master/skills.json; REQ-UXS-050). Same rarity as the horse and fits its running style. */
  skillId?: string;
}
export interface SeasonalInfo { seasonId: string; label: string; startAtMs: number; endAtMs: number }
export interface ItemQty { itemId: string; qty: number }
import type { LeagueConfig } from './league.js';
/** `horse`: a template id granted as a horse (event rewards only; REQ-BREED-022). */
export interface Reward {
  freeCoins?: number; items?: ItemQty[]; horse?: string;
  /** REQ-UXS-013: a female template granted as a broodmare (retired, ready to breed). */
  broodmare?: string;
  /** REQ-UXS-016: season pass experience (season missions only). */
  passXp?: number;
}
/**
 * Store product (master/products.json). REQ-PUR-*, REQ-UXS-017..022.
 * - `storeType`: how the product is registered in the stores. `consumable` (coins, the daily pack, the
 *   per-season pass: Google consumes it so it can be bought again), `non_consumable` (once-only bundles:
 *   Google acknowledges it), `auto_renewing` (store subscription; none are sold since REQ-UXS-020, the
 *   subscription paths stay for old purchases and tests).
 * - `once`: one purchase per account (`classId` set: one per class). Refunds keep it used.
 */
export type ProductKind = 'coins' | 'starter' | 'season_pass' | 'allowance' | 'promotion';
export type StoreType = 'consumable' | 'non_consumable' | 'auto_renewing';
export interface Product {
  id: string; kind: ProductKind; priceYen: number; paidCoins: number;
  once?: boolean; items?: ItemQty[];
  /** Legacy auto-renewing pass only (store period is authoritative). Per-season passes ignore it. */
  durationDays?: number;
  /** Display name (REQ-UXS-022). */
  name?: string;
  storeType?: StoreType;
  /** Shop tab (REQ-UXS-022 / spec 06 §6.8). */
  tab?: 'recommended' | 'coins' | 'pass';
  /** REQ-UXS-018: daily free coins for `days` game days from the purchase day (claimed daily). */
  allowance?: { days: number; dailyFreeCoins: number };
  /** REQ-UXS-019: season pass extras (Pass+: levels added at purchase). */
  pass?: { levels: number };
  /** REQ-UXS-019: promotion pack of this class (offered and sellable once the class is reached). */
  classId?: string;
}
/** REQ-UXS-017: when offers are shown (spec 06 §5.1). */
export interface ShopOffersConfig { starterPlaceAtOrWorse: number; starterAfterRankedRaces: number; passAfterRankedRaces: number }
/** Shop display texts and labels (master/products.json `display`, REQ-UXS-022). */
export interface ShopDisplay {
  itemLabels: Record<string, string>;
  notices: Record<string, string>;
  legalLinks: { key: string; title: string }[];
}
/** REQ-ITEM-001..003: what tickets and materials do. */
export type TicketDef =
  | { kind: 'single'; name: string; banners: string[] }
  | { kind: 'srPlus'; name: string; rates: Partial<Record<Rarity, number>> }
  /** REQ-UXS-015: one 10-pull (with the slot-10 SR+ guarantee) on an eligible banner, from that banner's own tables. */
  | { kind: 'ten'; name: string; banners: string[] };
/** REQ-ITEM-004..007: cosmetics sold for coins (no stat effect). */
/** `notForSale`: comes only with a product or reward (price 0; REQ-UXS-019 Pass+ tack). */
export type CosmeticDef =
  | { id: string; name: string; kind: 'silks'; pattern: string; price: number; currency: 'any' | 'paidOnly'; notForSale?: boolean }
  | { id: string; name: string; kind: 'tack'; slot: TackSlot; asset: string; price: number; currency: 'any' | 'paidOnly'; notForSale?: boolean }
  | { id: string; name: string; kind: 'decor'; asset: string; price: number; currency: 'any' | 'paidOnly'; notForSale?: boolean }
  /** REQ-TEAMFEED-002: a team-feed stamp sold directly for coins (asset stamp/<id>; master/stamps.json says which stamp it unlocks). */
  | { id: string; name: string; kind: 'stamp'; asset: string; price: number; currency: 'any' | 'paidOnly'; notForSale?: boolean }
  /** REQ-SILK-005: a 勝負服エディタ part sold directly (master/silks-editor.json names this item as the part's source). */
  | { id: string; name: string; kind: 'silks_part'; part: 'color' | 'sleeve' | 'cap'; ref: string; asset: string; price: number; currency: 'any' | 'paidOnly'; notForSale?: boolean }
  /** REQ-PHOTO-005: a photo-mode frame or stamp sold directly for coins (asset photo/frame|stamp/<id>; master/photo.json says which item it unlocks). */
  | { id: string; name: string; kind: 'photo'; asset: string; price: number; currency: 'any' | 'paidOnly'; notForSale?: boolean };
export type TackSlot = 'bridle' | 'saddlecloth';
export const TACK_SLOTS: TackSlot[] = ['bridle', 'saddlecloth'];
export interface ItemsMaster {
  tickets: Record<string, TicketDef>;
  breedingMaterial: { itemId: string; cost: number; extraPerDay: number };
  decorSlots: number;
  cosmetics: CosmeticDef[];
}
export interface AgeBand { id: string; minAge: number; maxAge: number; monthlyLimitYen: number | null }
export interface AgeLimits { status: string; guardianConsentUnderAge: number; bands: AgeBand[] }
export interface ClassDef { id: string; statCap: number; promotePoints: number | null; demoteBelowPoints: number | null }
/** `training` (REQ-TRAIN-011): finished training sessions (training.ts). */
export interface MissionDef { id: string; kind: 'races' | 'wins' | 'top3' | 'training'; target: number; reward: Reward }
export interface CollectionMissionDef { id: string; kind: 'collect'; templateIds: string[]; reward: Reward }
export interface Progression {
  classes: ClassDef[]; seasonPointsByPlace: number[];
  raceFreeCoinsByPlace: Record<'ranked' | 'friend' | 'tutorial', number[]>;
  passXpPerRace: number; passXpPerLevel: number; passMaxLevel: number;
  passRewards: Record<'free' | 'premium', { every: number; reward: Reward }>;
  loginBonus: ({ day: number } & Reward)[]; dailyMissions: MissionDef[]; collectionMissions: CollectionMissionDef[];
  awakeningCost: number[]; awakeningStatPermillePerLevel: number; breedingPerDay: number; beginnerRaces: number;
  /** REQ-SEASON-002: per closed class, rank bands in ascending maxRank; maxRank null = participation. */
  seasonRewards: Record<string, { maxRank: number | null; reward: Reward }[]>;
  social: { maxFriends: number; maxIncoming: number; maxOutgoing: number; maxInvites: number; inviteTtlMs: number; profilePushIntervalMs: number };
  leaderboard: { topN: number; rolloverBatch: number };
  replayRetentionDays: number;
  /** REQ-OPS-001a: days a held replay is kept per hold reason (absent/null = until ops act). */
  replayHoldDays?: Record<string, number | null>;
  /** REQ-REW-004: friend races that pay rewards per JST day (anti-farming). */
  friendRewardDailyCap: number;
  /** REQ-TA-*: time attack rules. */
  timeAttack: TimeAttackConfig;
  /** REQ-AD-*: opt-in rewarded video ads (validated by ads.ts adsProblems). Absent = no ads. */
  ads?: AdsConfig;
  /** REQ-RACE-037: daily ground per course and night racing at lit venues. */
  weather: WeatherConfig;
  /** REQ-TEAM-*: 支部 (teams). */
  teams: TeamsConfig;
  /** REQ-BOND-*: stable care / bond (never affects ranked/event/time attack stats). */
  bond: BondConfig;
  /** REQ-ROOM-*: private-room condition choices. */
  rooms: RoomsConfig;
  /** REQ-LEAGUE-*: 支部対抗シーズン (team-vs-team monthly league). */
  league: LeagueConfig;
  /** REQ-BREED-010..016: stud lending between players (free coins only, capped). Absent = disabled. */
  stud?: StudConfig;
  /** REQ-BREED-017: atavism (隔世遺伝) chance per breeding, in permille. Absent = 0. */
  atavismPermille?: number;
  /** REQ-UXS-010: free coins for the 1st, 2nd, 3rd win (1st place) of the game day in these modes. Absent = none. */
  firstWinBonus?: { modes: string[]; freeCoinsByWin: number[] };
  /** REQ-UXS-*: onboarding, consent, unlocks, beginner/season missions, experiments, account deletion (onboarding.ts). */
  consent?: import('./onboarding.js').ConsentConfig;
  partner?: import('./onboarding.js').PartnerConfig;
  beginnerMatch?: import('./onboarding.js').BeginnerMatchConfig;
  beginnerLoginBonus?: ({ day: number } & Reward)[];
  unlocks?: import('./onboarding.js').UnlockDef[];
  beginnerMissions?: import('./onboarding.js').BeginnerMissionDef[];
  seasonMissions?: import('./onboarding.js').SeasonMissionDef[];
  experiments?: import('./onboarding.js').ExperimentDef[];
  accountDeletion?: import('./accountDeletion.js').AccountDeletionConfig;
  nudges?: import('./nudges.js').NudgeConfig;
  /** REQ-DAY-001: the game-day rollover hour (JST) with its switch-over instant. Absent = DEFAULT_DAY_ROLLOVER. */
  dayRollover?: import('./time.js').DayRollover;
  /** REQ-INV-*: friend invite codes (invite.ts). Absent = invites disabled. */
  invite?: import('./invite.js').InviteConfig;
  /** REQ-CB-*: returning-player campaign (comeback.ts). Absent = disabled. */
  comeback?: import('./comeback.js').ComebackConfig;
  /** REQ-TRAIN-*: 調教 (training.ts, validated by trainingProblems). Absent = no training. */
  training?: import('./training.js').TrainingConfig;
  /** REQ-BOX-*: プレゼントボックス (giftBox.ts, validated by giftBoxProblems). Absent = rewards are granted directly. */
  giftBox?: import('./giftBox.js').GiftBoxConfig;
  /** REQ-RIVAL-*: weekly rival (rival.ts, validated by rivalProblems). Absent / disabled = no rivals. */
  rival?: import('./rival.js').RivalConfig;
  /** REQ-WCH-*: 週替わりチャレンジ (weeklyChallenge.ts, validated by weeklyChallengeProblems). Absent = no weekly challenges. */
  weeklyChallenge?: import('./weeklyChallenge.js').WeeklyChallengeConfig;
  /** REQ-TGOAL-*: 支部の共同目標 (teamGoal.ts, validated by teamGoalProblems). Absent = no team goals. */
  teamGoal?: import('./teamGoal.js').TeamGoalConfig;
  /** REQ-HOF-*: 殿堂 and the retirement ceremony (hallOfFame.ts, validated by hallProblems). Absent / disabled = none. */
  hall?: import('./hallOfFame.js').HallConfig;
  /** REQ-MYRP-*: マイリプレイ (myReplays.ts, validated by myReplaysProblems). Absent / disabled = no saved replays. */
  myReplays?: import('./myReplays.js').MyReplaysConfig;
  /** REQ-ACT-010: アクティビティ limits (activity.ts, validated by activityProblems). Absent = ACTIVITY_DEFAULTS. */
  activity?: Partial<import('./activity.js').ActivityConfig>;
  /** REQ-RPT-015: 通報 limits and reporter weights (reports.ts, validated by reportsProblems). Absent = REPORTS_DEFAULTS. */
  reports?: Partial<import('./reports.js').ReportsConfig>;
}
export interface StudConfig {
  /** Highest fee an owner may ask, in free coins. */
  feeMax: number;
  /** Highest daily lend limit an owner may set per listed stallion. */
  dailyLimitMax: number;
  /** Free coins an owner can earn from lending per JST day; fees above it are not paid out (sink). */
  dailyEarnCap: number;
  /** Stud breedings a borrower may make per JST day (on top of the normal breeding allowance rules). */
  borrowPerDay: number;
  maxListings: number;
  /** A reservation not settled within this time is released (the borrower was never charged). */
  reserveTtlMs: number;
  /** Delay before the borrower's object retries an unsettled fee payment. */
  retryMs: number;
  historyKeep: number;
  browseLimit: number;
}
export interface WeatherOverride { trackId?: string; fromMs: number; toMs: number; going: Going; night?: boolean }
export interface WeatherConfig {
  salt: string;
  /** Relative weights per going name. */
  turf: Partial<Record<'firm' | 'good' | 'yielding' | 'soft', number>>;
  dirt: Partial<Record<'fast' | 'good' | 'muddy' | 'sloppy', number>>;
  /** REQ-TRACK-003: per-course climate (weights for that course's surface only); courses not listed use turf / dirt. */
  byTrack?: Record<string, Partial<Record<Going, number>> | string>;
  /** Races at lit venues between these JST hours (from inclusive, to exclusive; may wrap midnight) run at night. */
  nightFromHourJst: number; nightToHourJst: number;
  /** Modes that get weather; others (tutorial, time attack) race on good ground by day with no fields sent. */
  modes: string[];
  overrides: WeatherOverride[];
}

/** REQ-TEAM-*: team limits, anti-abuse rules and season reward bands (ascending maxRank; null = any rank). */
export interface TeamsConfig {
  maxMembers: number; maxOfficers: number; memberPointsCap: number; rejoinCooldownMs: number; rewardMinDays: number;
  maxPendingRequests: number; requestTtlMs: number; maxOutgoingRequests: number; announcementMax: number;
  formerMemberKeepMs: number; topN: number; rolloverBatch: number;
  seasonRewards: { maxRank: number | null; reward: Reward }[];
}

/** REQ-EVENT-*: one event race definition (master/events.json or remote config). */
export type EventFee = { kind: 'none' } | { kind: 'free'; freeCoins: number } | { kind: 'item'; itemId: string; qty: number };
export interface EventDef {
  id: string; name: string; startAtMs: number; endAtMs: number; trackIds: string[];
  entry: { classIds: string[] | null; styles: Style[] | null; minRankedRaces: number };
  fee: EventFee;
  rules: {
    /** Changes to ruleset values (the key set never changes; rulesetVersion becomes `<active>+ev.<id>`). */
    rulesetOverrides: Record<string, number>;
    /** Every entrant (players and CPU) races with these stats when set. */
    fixedStats: Stats | null;
    /** Stat total cap applied to every entrant (like ranked normalization); null = none. */
    statCap: number | null;
    cpuLevel: number; maxPlayers: number; cpuFillAfterMs: number;
  };
  points: { byPlace: number[]; participation: number };
  milestones: { points: number; reward: Reward }[];
  rankRewards: { maxRank: number | null; reward: Reward }[];
  /** REQ-EXCH-*: the event's exchange shop (contracts/protocol.md §30). Absent = the event has none. */
  exchange?: EventExchange;
}
/** REQ-EXCH-002: what one exchange line gives. Exactly one of the keys; never anything random. */
export type ExchangeItemKind = 'coins' | 'material' | 'ticket' | 'cosmetic' | 'commentary_pack' | 'horse';
export interface ExchangeItemDef {
  id: string; name: string; kind: ExchangeItemKind;
  /** Event points per unit (fixed). */
  price: number;
  /** Units one player can take from this line during the event (per event, never restocked). */
  stock: number;
  reward: { freeCoins?: number; items?: ItemQty[]; horse?: string };
}
/** REQ-EXCH-001: event points (free, earned only by racing the event) and the fixed-price exchange list. */
export interface EventExchange {
  /** Points per race result: byPlace[place-1] + participation, at most dailyCap per game day (REQ-DAY-001). */
  earn: { byPlace: number[]; participation: number; dailyCap: number };
  /** The exchange stays open this many whole game days after the game day the event ends in. */
  graceDays: number;
  /** REQ-EXCH-006: points left when the exchange closes become ceil(points / pointsPerUnit) of itemId. */
  leftover: { itemId: string; pointsPerUnit: number };
  items: ExchangeItemDef[];
}
export type TitleCondition =
  | { kind: 'races' | 'wins' | 'top3' | 'perfectStarts' | 'whipPerfectWins'; value: number }
  | { kind: 'winsByStyle'; style: Style; value: number }
  | { kind: 'startReaction'; value: number }
  | { kind: 'trackWins'; trackId: string; value: number }
  | { kind: 'bestTime'; trackId: string; value: number }
  | { kind: 'classReached'; classId: string }
  | { kind: 'rating'; value: number }
  | { kind: 'bondLevel'; value: number }
  /** REQ-ACH-006: reached tier `tier` of achievement `achievementId` (master/collection.json). */
  | { kind: 'achievement'; achievementId: string; tier: number }
  /** REQ-RIVAL-007: weekly rival wins in total (not in a row), cosmetic only. */
  | { kind: 'rivalWeeksWon'; value: number };
export interface TitleDef { id: string; name: string; condition: TitleCondition }
/** `comeback` (REQ-CB-007): lapse reminders, opt-in (06 §3.5: a re-engagement push needs its own category and consent). */
/** `gifts` (REQ-BOX-011): a compensation arrived in the gift box. */
export type PushCategory = 'season' | 'friends' | 'invites' | 'events' | 'comeback' | 'gifts';
export const PUSH_CATEGORIES: PushCategory[] = ['season', 'friends', 'invites', 'events', 'comeback', 'gifts'];
export interface PushTemplate { category: PushCategory; title: string; body: string; ttlSec: number; timeSensitive: boolean }
/** REQ-PUSH-*: defaults, limits and Japanese templates (master/push.json). */
export interface PushMaster {
  defaults: { categories: Record<PushCategory, boolean>; quietHours: { startHour: number; endHour: number } | null; dailyCap: number };
  maxDevices: number; maxOutbox: number;
  retry: { backoffMs: number[]; maxAttempts: number };
  /** FCM topics for broadcast categories (one send reaches every subscribed device). */
  topics: Partial<Record<PushCategory, string>>;
  /** REQ-L10N-007: the topics of other languages (an English device subscribes to these instead). */
  topicsByLocale?: Partial<Record<'ja' | 'en', Partial<Record<PushCategory, string>>>>;
  seasonReminders: { endDaysBefore: number[]; lastDay: boolean; start: boolean };
  templates: Record<string, PushTemplate>;
}
export interface PoolEntry { templateId: string; ppm: number }
/**
 * REQ-GACHA-014: one step of a step-up banner (10-pulls only). `finalSlotPool` (optional) is the table slot 10 is ALWAYS
 * drawn from on this step (e.g. SSR only), disclosed per step from the same data.
 */
export interface StepDef { priceTen: number; finalSlotPool?: PoolEntry[] }
/** After the last step: start again at step 1 (`loop`) or stay on the last step (`repeatLast`). */
export interface StepUpDef { steps: StepDef[]; afterLast: 'loop' | 'repeatLast' }
export interface BannerDef {
  id: string; name: string; currency: 'any' | 'paidOnly'; priceSingle: number; priceTen: number;
  pityGroup: string; pityTargets: string[]; pool: PoolEntry[]; guaranteePool: PoolEntry[];
  /** REQ-GACHA-011: open from startAtMs (inclusive) to endAtMs (exclusive); listed as upcoming from announceAtMs. */
  startAtMs?: number; endAtMs?: number; announceAtMs?: number;
  /** The featured horse (its own ppm is in `pool`; shown on the banner and the odds page). */
  pickupTemplateId?: string;
  stepUp?: StepUpDef;
}
/**
 * A limited pity group may close at `endAtMs`; leftover points then move 1:1 to `convertTo` (default `standard`) and
 * never expire (REQ-GACHA-005 / REQ-GACHA-013). `label` names the group on the pity meter ("恒常" …).
 */
export interface PityGroupDef { cost: number; endAtMs?: number; convertTo?: string; label?: string }
/** Upcoming banners are listed this many days before they open unless the banner says otherwise (REQ-GACHA-011). */
export const DEFAULT_ANNOUNCE_DAYS = 3;
export interface GachaMaster {
  duplicateMaterial: Record<Rarity, number>; pityGroups: Record<string, PityGroupDef>; banners: BannerDef[];
  /**
   * REQ-DAY-001: the definitions written as game days (banner startDay/endDay, pity group endDay), kept so a config
   * version that changes progression.dayRollover re-resolves them (rescheduleGacha). Absent in hand-built test masters.
   */
  daySchedules?: GameDaySchedules;
}
export interface GameDaySchedules { banners: Record<string, RawBanner>; pityEndDays: Record<string, string> }

/** The game-day written parts of raw banners / pity groups (see GachaMaster.daySchedules). */
export function gameDaySchedules(banners: RawBanner[], pityGroups: Record<string, RawPityGroup>): GameDaySchedules {
  const out: GameDaySchedules = { banners: {}, pityEndDays: {} };
  for (const b of banners) if (b.startDay !== undefined || b.endDay !== undefined) out.banners[b.id] = b;
  for (const [id, g] of Object.entries(pityGroups)) if (g.endDay !== undefined) out.pityEndDays[id] = g.endDay;
  return out;
}
export interface Master {
  tracks: Track[]; templates: HorseTemplate[]; templateById: Map<string, HorseTemplate>;
  /** Track ids of venues with floodlights (night racing possible). Master-only; never sent in a race config. */
  litTracks: Set<string>;
  gacha: GachaMaster; nicks: { bonus: number; pairs: [string, string][] }; ng: { exact: string[]; contains: string[] };
  ageLimits: AgeLimits; products: Product[]; firstPurchaseBonusAsPaid: boolean; progression: Progression;
  /** REQ-UXS-022: shop display texts (absent in hand-built test masters → built-in fallbacks). */
  shopDisplay?: ShopDisplay;
  /** REQ-UXS-017: offer triggers (absent → defaults in shop.ts). */
  shopOffers?: ShopOffersConfig;
  titles: TitleDef[];
  push: PushMaster;
  /** REQ-EVENT-*: event race definitions. */
  events: EventDef[];
  /** REQ-ASSET-010: real registered silks players may not reproduce (master/banned-silks.json or a remote-config import). */
  bannedSilks?: BannedSilksList;
  /** REQ-ITEM-*: tickets, materials and cosmetics. */
  items: ItemsMaster;
  /** REQ-STABLE-*: マイ厩舎 (master/stable.json is used when absent; remote config may replace it). */
  stable?: StableConfig;
  /** REQ-UXS-050: unique skills (master/skills.json). */
  skills: SkillsMaster;
  /** REQ-DLV-*: asset delivery catalog (master/assets-catalog.json; remote config `assets` may replace it). Absent → EMPTY_ASSET_CATALOG. */
  assetCatalog?: AssetCatalog;
  /** REQ-TEAMFEED-*: team cheer stamps (master/stamps.json; teamFeed.ts stampsOf falls back to it when absent). */
  stamps?: StampsMaster;
  /** REQ-CB-008: what's new entries (master/changelog.json; remote config `changelog` may replace it). */
  changelog?: import('./comeback.js').ChangelogEntry[];
  /**
   * REQ-L10N-004: the English of every player-facing Japanese text above, keyed by the Japanese (master/locale-en.json;
   * remote config `locale.en` adds to it). Absent in hand-built test masters (responses then stay Japanese).
   */
  locale?: { en: Record<string, string> };
  /** REQ-COL-* / REQ-ACH-*: 図鑑 lore and achievements (master/collection.json; collection.ts collectionOf falls back to it when absent). */
  collection?: CollectionMaster;
  /** REQ-SILK-*: 勝負服エディタ parts (master/silks-editor.json; silksEditor.ts silksEditorOf falls back to it when absent). */
  silksEditor?: import('./silksEditor.js').SilksEditorMaster;
  /** REQ-CMT-*: 実況パック (master/commentary-packs.json; commentaryPacks.ts commentaryPacksOf falls back to it when absent). */
  commentaryPacks?: import('./commentaryPacks.js').CommentaryPacksMaster;
  /** REQ-PHOTO-*: photo mode looks / frames / stamps (master/photo.json; photoMode.ts photoOf falls back to it when absent). */
  photo?: import('./photoMode.js').PhotoMaster;
}

export const PPM_TOTAL = 1_000_000;

/** Splits `total` ppm across ids evenly; remainder goes to the first ids (deterministic). */
function split(ids: string[], total: number): PoolEntry[] {
  if (ids.length === 0) return [];
  const base = Math.floor(total / ids.length);
  let rem = total - base * ids.length;
  return ids.map((templateId) => ({ templateId, ppm: base + (rem-- > 0 ? 1 : 0) }));
}

export interface RawBanner {
  id: string; name: string; currency: 'any' | 'paidOnly'; priceSingle: number; priceTen: number; pityGroup: string;
  pityTargets: string[]; pool: 'auto' | PoolEntry[]; rates?: Partial<Record<Rarity, number>>;
  guaranteeRates?: Partial<Record<Rarity, number>>; guaranteePool?: PoolEntry[];
  pickup?: { templateId: string; ppm: number }; startAtMs?: number; endAtMs?: number;
  /** REQ-BREED-020: seasonal templates added to this banner's auto pools (by rarity, like any other). */
  seasonal?: string[];
  /**
   * REQ-GACHA-011: schedule as game days (opens at the rollover of startDay, closes at the rollover after endDay, which
   * is the last day). Use either these or startAtMs/endAtMs, not both.
   */
  startDay?: string; endDay?: string;
  /** Listed as upcoming from this instant (or `announceDays` game days before the start; default DEFAULT_ANNOUNCE_DAYS). */
  announceAtMs?: number; announceDays?: number;
  /** REQ-GACHA-014: step-up steps; `finalSlotRates` builds the slot-10 table of that step like guaranteeRates. */
  stepUp?: { steps: { priceTen: number; finalSlotRates?: Partial<Record<Rarity, number>> }[]; afterLast: 'loop' | 'repeatLast' };
}
export interface RawPityGroup { cost: number; endAtMs?: number; endDay?: string; convertTo?: string; label?: string }

/**
 * The exclusive end (ms) of a schedule whose last game day is `endDay`: the start of the next game day under the
 * master's day rule (REQ-DAY-001; across the 0 → 4 switch that day is 28 h, so not start + 24 h).
 */
export const endOfGameDay = (endDay: string, rule: DayRule) => gameDayStartMs(addJstDays(endDay, 1), rule);

/** Resolves `endDay` of pity groups (REQ-GACHA-011) into endAtMs with the master's game-day rule. */
export function buildPityGroups(raw: Record<string, RawPityGroup>, rule: DayRule): Record<string, PityGroupDef> {
  const out: Record<string, PityGroupDef> = {};
  for (const [id, g] of Object.entries(raw)) {
    if (g.endDay !== undefined && g.endAtMs !== undefined) throw new AppError('CONFIG_INVALID', `pity group ${id}: use endDay or endAtMs, not both`);
    const d: PityGroupDef = { cost: g.cost };
    const end = g.endDay !== undefined ? endOfGameDay(g.endDay, rule) : g.endAtMs;
    if (end !== undefined) d.endAtMs = end;
    if (g.convertTo !== undefined) d.convertTo = g.convertTo;
    if (g.label !== undefined) d.label = g.label;
    out[id] = d;
  }
  return out;
}

/**
 * Auto pool by rarity. Seasonal templates (REQ-BREED-020) are left out unless listed in `seasonal`, so a
 * permanent banner or a ticket table never offers a limited horse.
 */
export function expandPool(templates: HorseTemplate[], rates: Partial<Record<Rarity, number>>, pickup?: { templateId: string; ppm: number }, seasonal: string[] = []): PoolEntry[] {
  const out: PoolEntry[] = [];
  for (const r of RARITY_ORDER) {
    const total = rates[r] ?? 0;
    if (total === 0) continue;
    const ids = templates.filter((t) => t.rarity === r && !t.giftOnly && (!t.seasonal || seasonal.includes(t.id))).map((t) => t.id);
    if (ids.length === 0) throw new AppError('CONFIG_INVALID', `no templates of rarity ${r}`);
    if (pickup && ids.includes(pickup.templateId)) {
      out.push({ templateId: pickup.templateId, ppm: pickup.ppm });
      out.push(...split(ids.filter((id) => id !== pickup.templateId), total - pickup.ppm));
    } else out.push(...split(ids, total));
  }
  return out;
}

/**
 * REQ-DAY-001: banners and pity groups written as game days, resolved again under another day rule (a config version
 * that changes progression.dayRollover but not the gacha keeps every game-day schedule on the rollover).
 */
export function rescheduleGacha(g: GachaMaster, templates: HorseTemplate[], rule: DayRule): GachaMaster {
  const sch = g.daySchedules;
  if (!sch) return g;
  const pityGroups: Record<string, PityGroupDef> = {};
  for (const [id, d] of Object.entries(g.pityGroups)) {
    const day = sch.pityEndDays[id];
    pityGroups[id] = day === undefined ? d : { ...d, endAtMs: endOfGameDay(day, rule) };
  }
  return { ...g, pityGroups, banners: g.banners.map((b) => (sch.banners[b.id] ? buildBanner(sch.banners[b.id]!, templates, rule) : b)) };
}

/** `rule` = the master's game-day rule (progression.dayRollover): startDay/endDay/announceDays are game days. */
export function buildBanner(raw: RawBanner, templates: HorseTemplate[], rule: DayRule): BannerDef {
  const pool = raw.pool === 'auto' ? expandPool(templates, raw.rates ?? {}, raw.pickup, raw.seasonal) : raw.pool;
  const guaranteePool = raw.guaranteePool ?? expandPool(templates, raw.guaranteeRates ?? {}, raw.pickup && { templateId: raw.pickup.templateId, ppm: Math.round((raw.pickup.ppm * (raw.guaranteeRates?.SSR ?? 0)) / Math.max(1, raw.rates?.SSR ?? 1)) }, raw.seasonal);
  const b: BannerDef = { id: raw.id, name: raw.name, currency: raw.currency, priceSingle: raw.priceSingle, priceTen: raw.priceTen, pityGroup: raw.pityGroup, pityTargets: raw.pityTargets, pool, guaranteePool };
  if (raw.startDay !== undefined && raw.startAtMs !== undefined) throw new AppError('CONFIG_INVALID', 'use startDay or startAtMs, not both');
  if (raw.endDay !== undefined && raw.endAtMs !== undefined) throw new AppError('CONFIG_INVALID', 'use endDay or endAtMs, not both');
  if (raw.announceDays !== undefined && raw.announceAtMs !== undefined) throw new AppError('CONFIG_INVALID', 'use announceDays or announceAtMs, not both');
  const start = raw.startDay !== undefined ? gameDayStartMs(raw.startDay, rule) : raw.startAtMs;
  const end = raw.endDay !== undefined ? endOfGameDay(raw.endDay, rule) : raw.endAtMs;
  if (start !== undefined) {
    b.startAtMs = start;
    const days = raw.announceDays ?? DEFAULT_ANNOUNCE_DAYS;
    // announceDays game days before a game-day start (at that day's rollover); before an instant start, days × 24 h
    b.announceAtMs = raw.announceAtMs ?? (raw.startDay !== undefined ? gameDayStartMs(addJstDays(raw.startDay, -days), rule) : start - days * DAY_MS);
  } else if (raw.announceAtMs !== undefined || raw.announceDays !== undefined) throw new AppError('CONFIG_INVALID', 'an announcement needs a start');
  if (end !== undefined) b.endAtMs = end;
  if (raw.pickup) b.pickupTemplateId = raw.pickup.templateId;
  if (raw.stepUp) {
    b.stepUp = {
      afterLast: raw.stepUp.afterLast,
      steps: raw.stepUp.steps.map((st) => {
        const d: StepDef = { priceTen: st.priceTen };
        if (st.finalSlotRates) {
          const ssr = raw.rates?.SSR ?? 0;
          const pk = raw.pickup && ssr > 0 ? { templateId: raw.pickup.templateId, ppm: Math.round((raw.pickup.ppm * (st.finalSlotRates.SSR ?? 0)) / ssr) } : undefined;
          d.finalSlotPool = expandPool(templates, st.finalSlotRates, pk, raw.seasonal);
        }
        return d;
      }),
    };
  }
  return b;
}

let cached: Master | undefined;

export function loadMaster(): Master {
  if (cached) return cached;
  const templates = (horsesJson as { templates: HorseTemplate[] }).templates;
  const templateById = new Map(templates.map((t) => [t.id, t]));
  const split = (tracksJson as { tracks: Record<string, unknown>[] }).tracks.map(splitMasterTrack);
  const tracks = split.map((x) => trackSchema.parse(x.track));
  const litTracks = new Set(split.filter((x) => x.lights).map((x) => tracks[split.indexOf(x)]!.id));
  const g = gachaJson as unknown as { duplicateMaterial: Record<Rarity, number>; pityGroups: Record<string, RawPityGroup>; banners: RawBanner[] };
  const p = productsJson as unknown as { firstPurchaseBonusAsPaid: boolean; products: Product[]; display: ShopDisplay; offers: ShopOffersConfig };
  const rule = dayRule({ progression: progressionJson as unknown as Progression }); // REQ-DAY-001: banner game days
  const m: Master = {
    tracks, templates, templateById, litTracks,
    gacha: { duplicateMaterial: g.duplicateMaterial, pityGroups: buildPityGroups(g.pityGroups, rule), banners: g.banners.map((b) => buildBanner(b, templates, rule)), daySchedules: gameDaySchedules(g.banners, g.pityGroups) },
    nicks: nicksJson as unknown as Master['nicks'],
    ng: ngJson as unknown as Master['ng'],
    ageLimits: ageJson as unknown as AgeLimits,
    products: p.products, firstPurchaseBonusAsPaid: p.firstPurchaseBonusAsPaid, shopDisplay: p.display, shopOffers: p.offers,
    progression: progressionJson as unknown as Progression,
    titles: (titlesJson as unknown as { titles: TitleDef[] }).titles,
    push: pushJson as unknown as PushMaster,
    events: (eventsJson as unknown as { events: EventDef[] }).events,
    bannedSilks: BASE_BANNED_SILKS,
    items: itemsJson as unknown as ItemsMaster,
    skills: loadSkills(),
    assetCatalog: parseAssetCatalog(assetsCatalogJson),
    stamps: stampsJson as unknown as StampsMaster,
    changelog: (changelogJson as unknown as { entries: import('./comeback.js').ChangelogEntry[] }).entries,
    locale: { en: (localeEnJson as unknown as { strings: Record<string, string> }).strings },
    collection: collectionJson as unknown as CollectionMaster,
    photo: photoJson as unknown as import('./photoMode.js').PhotoMaster,
  };
  cached = m;
  return m;
}

/** Separates master-only track fields (name, lights) from the race-config track. */
export function splitMasterTrack(raw: Record<string, unknown>): { track: Record<string, unknown>; lights: boolean } {
  const { name: _name, lights, en: _en, ...track } = raw;
  return { track, lights: lights === true };
}

export function trackById(m: Master, id: string): Track {
  const t = m.tracks.find((x) => x.id === id);
  if (!t) throw new AppError('NOT_FOUND', `track ${id}`);
  return t;
}
