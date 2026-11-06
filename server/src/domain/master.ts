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
import progressionJson from '../../master/progression.json';
import titlesJson from '../../master/titles.json';
import pushJson from '../../master/push.json';
import eventsJson from '../../master/events.json';
import itemsJson from '../../master/items.json';
import { trackSchema, type GoingAptitude, type Going, type Track } from './schemas.js';
import { AppError } from './errors.js';
import { loadSkills, type SkillsMaster } from './skills.js';

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
  | { id: string; name: string; kind: 'decor'; asset: string; price: number; currency: 'any' | 'paidOnly'; notForSale?: boolean };
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
export interface MissionDef { id: string; kind: 'races' | 'wins' | 'top3'; target: number; reward: Reward }
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
}
export type TitleCondition =
  | { kind: 'races' | 'wins' | 'top3' | 'perfectStarts' | 'whipPerfectWins'; value: number }
  | { kind: 'winsByStyle'; style: Style; value: number }
  | { kind: 'startReaction'; value: number }
  | { kind: 'trackWins'; trackId: string; value: number }
  | { kind: 'bestTime'; trackId: string; value: number }
  | { kind: 'classReached'; classId: string }
  | { kind: 'rating'; value: number }
  | { kind: 'bondLevel'; value: number };
export interface TitleDef { id: string; name: string; condition: TitleCondition }
export type PushCategory = 'season' | 'friends' | 'invites' | 'events';
export const PUSH_CATEGORIES: PushCategory[] = ['season', 'friends', 'invites', 'events'];
export interface PushTemplate { category: PushCategory; title: string; body: string; ttlSec: number; timeSensitive: boolean }
/** REQ-PUSH-*: defaults, limits and Japanese templates (master/push.json). */
export interface PushMaster {
  defaults: { categories: Record<PushCategory, boolean>; quietHours: { startHour: number; endHour: number } | null; dailyCap: number };
  maxDevices: number; maxOutbox: number;
  retry: { backoffMs: number[]; maxAttempts: number };
  /** FCM topics for broadcast categories (one send reaches every subscribed device). */
  topics: Partial<Record<PushCategory, string>>;
  seasonReminders: { endDaysBefore: number[]; lastDay: boolean; start: boolean };
  templates: Record<string, PushTemplate>;
}
export interface PoolEntry { templateId: string; ppm: number }
export interface BannerDef {
  id: string; name: string; currency: 'any' | 'paidOnly'; priceSingle: number; priceTen: number;
  pityGroup: string; pityTargets: string[]; pool: PoolEntry[]; guaranteePool: PoolEntry[];
  startAtMs?: number; endAtMs?: number;
}
/** A limited pity group may close at `endAtMs`; leftover points then move to `convertTo` (REQ-GACHA-005). */
export interface PityGroupDef { cost: number; endAtMs?: number; convertTo?: string }
export interface GachaMaster { duplicateMaterial: Record<Rarity, number>; pityGroups: Record<string, PityGroupDef>; banners: BannerDef[] }
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

export function buildBanner(raw: RawBanner, templates: HorseTemplate[]): BannerDef {
  const pool = raw.pool === 'auto' ? expandPool(templates, raw.rates ?? {}, raw.pickup, raw.seasonal) : raw.pool;
  const guaranteePool = raw.guaranteePool ?? expandPool(templates, raw.guaranteeRates ?? {}, raw.pickup && { templateId: raw.pickup.templateId, ppm: Math.round((raw.pickup.ppm * (raw.guaranteeRates?.SSR ?? 0)) / Math.max(1, raw.rates?.SSR ?? 1)) }, raw.seasonal);
  const b: BannerDef = { id: raw.id, name: raw.name, currency: raw.currency, priceSingle: raw.priceSingle, priceTen: raw.priceTen, pityGroup: raw.pityGroup, pityTargets: raw.pityTargets, pool, guaranteePool };
  if (raw.startAtMs !== undefined) b.startAtMs = raw.startAtMs;
  if (raw.endAtMs !== undefined) b.endAtMs = raw.endAtMs;
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
  const g = gachaJson as unknown as { duplicateMaterial: Record<Rarity, number>; pityGroups: Record<string, { cost: number }>; banners: RawBanner[] };
  const p = productsJson as unknown as { firstPurchaseBonusAsPaid: boolean; products: Product[]; display: ShopDisplay; offers: ShopOffersConfig };
  const m: Master = {
    tracks, templates, templateById, litTracks,
    gacha: { duplicateMaterial: g.duplicateMaterial, pityGroups: g.pityGroups, banners: g.banners.map((b) => buildBanner(b, templates)) },
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
  };
  cached = m;
  return m;
}

/** Separates master-only track fields (name, lights) from the race-config track. */
export function splitMasterTrack(raw: Record<string, unknown>): { track: Record<string, unknown>; lights: boolean } {
  const { name: _name, lights, ...track } = raw;
  return { track, lights: lights === true };
}

export function trackById(m: Master, id: string): Track {
  const t = m.tracks.find((x) => x.id === id);
  if (!t) throw new AppError('NOT_FOUND', `track ${id}`);
  return t;
}
