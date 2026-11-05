import tracksJson from '../../master/tracks.json';
import { BASE_BANNED_SILKS, type BannedSilksList } from './bannedSilks.js';
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
import { trackSchema, type GoingAptitude, type Going, type Track } from './schemas.js';
import { AppError } from './errors.js';

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
}
export interface ItemQty { itemId: string; qty: number }
export interface Reward { freeCoins?: number; items?: ItemQty[] }
export interface Product {
  id: string; kind: 'coins' | 'starter' | 'season_pass'; priceYen: number; paidCoins: number;
  once?: boolean; items?: ItemQty[]; durationDays?: number;
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
}
export interface WeatherOverride { trackId?: string; fromMs: number; toMs: number; going: Going; night?: boolean }
export interface WeatherConfig {
  salt: string;
  /** Relative weights per going name. */
  turf: Partial<Record<'firm' | 'good' | 'yielding' | 'soft', number>>;
  dirt: Partial<Record<'fast' | 'good' | 'muddy' | 'sloppy', number>>;
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
  | { kind: 'rating'; value: number };
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
  titles: TitleDef[];
  push: PushMaster;
  /** REQ-EVENT-*: event race definitions. */
  events: EventDef[];
  /** REQ-ASSET-010: real registered silks players may not reproduce (master/banned-silks.json or a remote-config import). */
  bannedSilks?: BannedSilksList;
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
}

export function expandPool(templates: HorseTemplate[], rates: Partial<Record<Rarity, number>>, pickup?: { templateId: string; ppm: number }): PoolEntry[] {
  const out: PoolEntry[] = [];
  for (const r of RARITY_ORDER) {
    const total = rates[r] ?? 0;
    if (total === 0) continue;
    const ids = templates.filter((t) => t.rarity === r).map((t) => t.id);
    if (ids.length === 0) throw new AppError('CONFIG_INVALID', `no templates of rarity ${r}`);
    if (pickup && ids.includes(pickup.templateId)) {
      out.push({ templateId: pickup.templateId, ppm: pickup.ppm });
      out.push(...split(ids.filter((id) => id !== pickup.templateId), total - pickup.ppm));
    } else out.push(...split(ids, total));
  }
  return out;
}

export function buildBanner(raw: RawBanner, templates: HorseTemplate[]): BannerDef {
  const pool = raw.pool === 'auto' ? expandPool(templates, raw.rates ?? {}, raw.pickup) : raw.pool;
  const guaranteePool = raw.guaranteePool ?? expandPool(templates, raw.guaranteeRates ?? {}, raw.pickup && { templateId: raw.pickup.templateId, ppm: Math.round((raw.pickup.ppm * (raw.guaranteeRates?.SSR ?? 0)) / Math.max(1, raw.rates?.SSR ?? 1)) });
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
  const p = productsJson as unknown as { firstPurchaseBonusAsPaid: boolean; products: Product[] };
  const m: Master = {
    tracks, templates, templateById, litTracks,
    gacha: { duplicateMaterial: g.duplicateMaterial, pityGroups: g.pityGroups, banners: g.banners.map((b) => buildBanner(b, templates)) },
    nicks: nicksJson as unknown as Master['nicks'],
    ng: ngJson as unknown as Master['ng'],
    ageLimits: ageJson as unknown as AgeLimits,
    products: p.products, firstPurchaseBonusAsPaid: p.firstPurchaseBonusAsPaid,
    progression: progressionJson as unknown as Progression,
    titles: (titlesJson as unknown as { titles: TitleDef[] }).titles,
    push: pushJson as unknown as PushMaster,
    events: (eventsJson as unknown as { events: EventDef[] }).events,
    bannedSilks: BASE_BANNED_SILKS,
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
