import tracksJson from '../../master/tracks.json';
import horsesJson from '../../master/horses.json';
import gachaJson from '../../master/gacha.json';
import nicksJson from '../../master/nicks.json';
import ngJson from '../../master/ng-names.json';
import ageJson from '../../master/age-limits.json';
import productsJson from '../../master/products.json';
import progressionJson from '../../master/progression.json';
import titlesJson from '../../master/titles.json';
import { trackSchema, type Track } from './schemas.js';
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
  /** REQ-REW-004: friend races that pay rewards per JST day (anti-farming). */
  friendRewardDailyCap: number;
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
  gacha: GachaMaster; nicks: { bonus: number; pairs: [string, string][] }; ng: { exact: string[]; contains: string[] };
  ageLimits: AgeLimits; products: Product[]; firstPurchaseBonusAsPaid: boolean; progression: Progression;
  titles: TitleDef[];
}

export const PPM_TOTAL = 1_000_000;

/** Splits `total` ppm across ids evenly; remainder goes to the first ids (deterministic). */
function split(ids: string[], total: number): PoolEntry[] {
  if (ids.length === 0) return [];
  const base = Math.floor(total / ids.length);
  let rem = total - base * ids.length;
  return ids.map((templateId) => ({ templateId, ppm: base + (rem-- > 0 ? 1 : 0) }));
}

interface RawBanner {
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
  const tracks = (tracksJson as { tracks: unknown[] }).tracks.map((t) => {
    const { name: _name, ...rest } = t as Record<string, unknown>;
    return trackSchema.parse(rest);
  });
  const g = gachaJson as unknown as { duplicateMaterial: Record<Rarity, number>; pityGroups: Record<string, { cost: number }>; banners: RawBanner[] };
  const p = productsJson as unknown as { firstPurchaseBonusAsPaid: boolean; products: Product[] };
  const m: Master = {
    tracks, templates, templateById,
    gacha: { duplicateMaterial: g.duplicateMaterial, pityGroups: g.pityGroups, banners: g.banners.map((b) => buildBanner(b, templates)) },
    nicks: nicksJson as unknown as Master['nicks'],
    ng: ngJson as unknown as Master['ng'],
    ageLimits: ageJson as unknown as AgeLimits,
    products: p.products, firstPurchaseBonusAsPaid: p.firstPurchaseBonusAsPaid,
    progression: progressionJson as unknown as Progression,
    titles: (titlesJson as unknown as { titles: TitleDef[] }).titles,
  };
  cached = m;
  return m;
}

export function trackById(m: Master, id: string): Track {
  const t = m.tracks.find((x) => x.id === id);
  if (!t) throw new AppError('NOT_FOUND', `track ${id}`);
  return t;
}
