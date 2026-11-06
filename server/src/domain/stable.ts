/**
 * REQ-STABLE-*: マイ厩舎 (My Stable) — docs/planning/06-ux-experience-spec.md §7.2, REQ-UXS-060.
 *
 * - The layout (theme, plate name, decor slots, featured horses) lives in the owner's PlayerState and is
 *   validated there: only owned 厩舎の飾り (decor cosmetics, REQ-ITEM-004/006) and own active horses.
 * - What visitors see is a public snapshot derived from that state and copied into the sharded
 *   DirectoryDO (like public profiles, REQ-SOCIAL-004, and stud listings). Visiting never touches the
 *   owner's object. The snapshot is re-derived after every transaction of the owner (PlayerService.tx →
 *   onStable), so renames, support name resets, bans, retired horses and banned silks reach it.
 * - Likes are capped per game day (likesPerDay) and per target per day (likesPerTargetPerDay), cannot be
 *   given to yourself, and NEVER pay coins to either side (docs/planning/06 §5: RMT / coin funnelling is
 *   ruled out). Cumulative likes only unlock looks (themes). Remote config cannot exceed STABLE_HARD_LIMITS.
 * - A like spans two objects: the liker's step (cap check + idempotency key) produces a deterministic
 *   likeId; the target's step counts each likeId once. A failed second step is completed by retrying the
 *   request with the same idempotency key (the first step replays its stored result).
 */
import { z } from 'zod';
import { AppError } from './errors.js';
import type { Master } from './master.js';
import { moderationOf, type HorseInstance, type PlayerState } from './player.js';
import { foldForCompare } from './horses.js';
import { horseBondLevel } from './bond.js';
import { appearanceOf, assetKeys, effectiveSilks, type Appearance, type Silks } from './visuals.js';
import { gameDayKey } from './time.js';
import type { KpiEvent } from './kpi.js';
import stableJson from '../../master/stable.json';

// ------------------------------------------------------------------------------------------- config

export interface StableTheme {
  id: string; name: string;
  /** Decor slots this theme offers (the base `items.decorSlots` 3 → themes extend it). */
  slots: number;
  /** The one free theme every player has. */
  default?: boolean;
  /** Unlocked by cumulative likes received (looks only, never coins). */
  unlockLikes?: number;
  /** Unlocked by owning this cosmetic (a future 厩舎テーマ一式 sale). */
  unlockItem?: string;
}
export interface StableConfig {
  likesPerDay: number;
  likesPerTargetPerDay: number;
  featuredMax: number;
  nameMaxChars: number;
  recommendedLimit: number;
  themes: StableTheme[];
}

/** Legal / anti-farming guard: a remote config can never raise these. */
export const STABLE_HARD_LIMITS = { likesPerDay: 10, likesPerTargetPerDay: 1, featuredMax: 5, nameMaxChars: 20, recommendedLimit: 50, slots: 10, themes: 50 };

const THEME_ID_RE = /^[a-z0-9_]{1,40}$/;
export const stableThemeSchema = z.object({
  id: z.string(), name: z.string().min(1).max(40), slots: z.number().int(),
  default: z.boolean().optional(), unlockLikes: z.number().int().optional(), unlockItem: z.string().min(1).max(64).optional(),
}).strict();
/** Remote-config `stable` (replaces the whole section). Strict: there is no field that could pay coins. */
export const stableConfigSchema = z.object({
  likesPerDay: z.number().int(), likesPerTargetPerDay: z.number().int(), featuredMax: z.number().int(),
  nameMaxChars: z.number().int(), recommendedLimit: z.number().int(), themes: z.array(stableThemeSchema),
}).strict();

const BASE_STABLE: StableConfig = (() => {
  const { _note: _n, ...rest } = stableJson as unknown as StableConfig & { _note?: string };
  return rest;
})();

export const stableConfig = (m: Master): StableConfig => m.stable ?? BASE_STABLE;

export function stableConfigProblems(c: StableConfig, m: Master): string[] {
  const p: string[] = [];
  const intIn = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  const H = STABLE_HARD_LIMITS;
  if (!intIn(c.likesPerDay, 0, H.likesPerDay)) p.push(`stable.likesPerDay must be 0..${H.likesPerDay}`);
  if (!intIn(c.likesPerTargetPerDay, 1, H.likesPerTargetPerDay)) p.push(`stable.likesPerTargetPerDay must be 1..${H.likesPerTargetPerDay}`);
  if (!intIn(c.featuredMax, 0, H.featuredMax)) p.push(`stable.featuredMax must be 0..${H.featuredMax}`);
  if (!intIn(c.nameMaxChars, 1, H.nameMaxChars)) p.push(`stable.nameMaxChars must be 1..${H.nameMaxChars}`);
  if (!intIn(c.recommendedLimit, 1, H.recommendedLimit)) p.push(`stable.recommendedLimit must be 1..${H.recommendedLimit}`);
  if (!Array.isArray(c.themes) || c.themes.length === 0 || c.themes.length > H.themes) p.push(`stable.themes must have 1..${H.themes} entries`);
  const ids = new Set<string>();
  const cosmetics = new Set((m.items?.cosmetics ?? []).map((x) => x.id));
  for (const t of c.themes ?? []) {
    if (!THEME_ID_RE.test(t.id) || t.id === 'default') p.push(`stable theme ${t.id}: id must be [a-z0-9_]{1,40} and not "default"`);
    if (ids.has(t.id)) p.push(`stable theme ${t.id}: duplicate`);
    ids.add(t.id);
    if (!intIn(t.slots, 0, H.slots)) p.push(`stable theme ${t.id}: slots must be 0..${H.slots}`);
    if (t.unlockLikes !== undefined && !intIn(t.unlockLikes, 1, 1_000_000)) p.push(`stable theme ${t.id}: unlockLikes must be ≥ 1`);
    if (t.unlockItem !== undefined && !cosmetics.has(t.unlockItem)) p.push(`stable theme ${t.id}: unknown unlockItem ${t.unlockItem}`);
    if (t.default && (t.unlockLikes !== undefined || t.unlockItem !== undefined)) p.push(`stable theme ${t.id}: the default theme cannot be locked`);
    if (!t.default && t.unlockLikes === undefined && t.unlockItem === undefined) p.push(`stable theme ${t.id}: a non-default theme needs unlockLikes or unlockItem`);
  }
  if ((c.themes ?? []).filter((t) => t.default).length !== 1) p.push('stable.themes: exactly one default theme');
  return p;
}

export const themeKey = (id: string) => assetKeys.stableTheme(id);

// ------------------------------------------------------------------------------------------- state

export interface StableLayout { theme: string; name: string | null; slots: (string | null)[]; featuredHorseIds: string[]; updatedAt: number }
export interface StableState {
  layout: StableLayout | null;
  /** Cumulative likes received (unlocks themes; never coins). */
  likes: number;
  /** Receiver side: likeIds already counted (last LIKE_IDS_KEEP) and today's count per liker. */
  recv: { day: string; from: Record<string, number>; ids: string[] };
  /** Liker side: likes given today, in total and per target. */
  given: { day: string; count: number; to: Record<string, number> };
}
const LIKE_IDS_KEEP = 300;

export function ensureStable(s: PlayerState): StableState {
  const x = s as PlayerState & { stable?: StableState };
  x.stable ??= { layout: null, likes: 0, recv: { day: '', from: {}, ids: [] }, given: { day: '', count: 0, to: {} } };
  return x.stable;
}
const peek = (s: PlayerState): StableState | undefined => (s as PlayerState & { stable?: StableState }).stable;

// ------------------------------------------------------------------------------------------- rules

const ownsItem = (s: PlayerState, id: string) => (s.items[id] ?? 0) > 0;
const defaultTheme = (c: StableConfig) => c.themes.find((t) => t.default) ?? c.themes[0]!;

export function themeUnlocked(t: StableTheme, s: PlayerState): boolean {
  if (t.default) return true;
  const likes = peek(s)?.likes ?? 0;
  return (t.unlockLikes !== undefined && likes >= t.unlockLikes) || (t.unlockItem !== undefined && ownsItem(s, t.unlockItem));
}

/** 表札: NFKC, 1..nameMaxChars, no control characters / URLs, NG list (same rules as display names, REQ-SOCIAL-006). */
export function validateStableName(m: Master, raw: string): string {
  const max = stableConfig(m).nameMaxChars;
  const name = raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const len = [...name].length;
  if (len < 1 || len > max) throw new AppError('INVALID_NAME', `1〜${max}文字`);
  if (/[\p{C}]/u.test(name)) throw new AppError('INVALID_NAME', 'control characters');
  if (/https?:|www\.|\.(com|net|jp)\b/i.test(name)) throw new AppError('INVALID_NAME', 'no URLs');
  const f = foldForCompare(name);
  if (m.ng.exact.some((n) => foldForCompare(n) === f)) throw new AppError('NG_NAME');
  if (m.ng.contains.some((n) => f.includes(foldForCompare(n)))) throw new AppError('NG_NAME');
  return name;
}
const safeName = (m: Master, n: string | null) => {
  if (n === null) return null;
  try { return validateStableName(m, n); } catch { return null; } // NG list grew since it was saved
};

const decorDef = (m: Master, id: string) => {
  const c = m.items.cosmetics.find((x) => x.id === id);
  return c && c.kind === 'decor' ? c : null;
};

export interface StableInput { theme: string; name: string | null; slots: (string | null)[]; featuredHorseIds: string[] }

/** REQ-STABLE-002: validate and store a layout. Only owned decor (REQ-ITEM-006 rules) and own active horses. */
export function setStable(m: Master, s: PlayerState, input: StableInput, now: number, emit?: (e: KpiEvent) => void): StableLayout {
  if (moderationOf(s, now) === 'banned') throw new AppError('BANNED', 'this account cannot edit its stable');
  const c = stableConfig(m);
  const theme = c.themes.find((t) => t.id === input.theme);
  if (!theme) throw new AppError('BAD_REQUEST', `unknown theme ${input.theme}`);
  if (!themeUnlocked(theme, s)) throw new AppError('NOT_ELIGIBLE', `theme ${theme.id} is locked`);
  if (input.slots.length > theme.slots) throw new AppError('BAD_REQUEST', `theme ${theme.id} has ${theme.slots} decor slots`);
  const seen = new Set<string>();
  for (const id of input.slots) {
    if (id === null) continue;
    if (!m.items.cosmetics.some((x) => x.id === id)) throw new AppError('NOT_FOUND', `cosmetic ${id}`);
    if (!decorDef(m, id)) throw new AppError('BAD_REQUEST', `${id} is not decor`);
    if (!ownsItem(s, id)) throw new AppError('NOT_ELIGIBLE', `${id} is not owned`);
    if (seen.has(id)) throw new AppError('BAD_REQUEST', `${id} is placed twice`);
    seen.add(id);
  }
  if (input.featuredHorseIds.length > c.featuredMax) throw new AppError('BAD_REQUEST', `at most ${c.featuredMax} featured horses`);
  if (new Set(input.featuredHorseIds).size !== input.featuredHorseIds.length) throw new AppError('BAD_REQUEST', 'a horse is featured twice');
  for (const hid of input.featuredHorseIds) {
    const h = s.horses.find((x) => x.id === hid);
    if (!h) throw new AppError('HORSE_NOT_FOUND', hid);
    if (h.status !== 'active') throw new AppError('HORSE_NOT_ACTIVE', `${hid} is retired`);
  }
  const name = input.name === null ? null : validateStableName(m, input.name);
  const st = ensureStable(s);
  st.layout = { theme: theme.id, name, slots: [...input.slots], featuredHorseIds: [...input.featuredHorseIds], updatedAt: now };
  emit?.({ name: 'stable_save', s1: theme.id, count: input.slots.filter((x) => x !== null).length, value: input.featuredHorseIds.length });
  return st.layout;
}

/** Support / moderation: drop an offensive plate name (the client then shows "<displayName>の厩舎"). */
export function resetStableName(s: PlayerState) {
  const st = ensureStable(s);
  const before = st.layout?.name ?? null;
  if (st.layout) st.layout.name = null;
  return { before, after: null };
}

/**
 * REQ-UXS-040: account deletion. Drops the layout and every like record of the deleting player (the likes it
 * received, today's per-liker counters and the likeIds that name other players). The likes it gave stay in the
 * other stables' totals as plain counts. While a deletion runs the stable is never published again
 * (stableSnapshot is null) and arriving likes are not counted.
 */
export function forgetStable(s: PlayerState) {
  const x = s as PlayerState & { stable?: StableState };
  const had = !!x.stable?.layout;
  delete x.stable;
  return { removed: had };
}
const deleting = (s: PlayerState) => s.deletion?.status === 'deleting';

/** Removes the layout (the public copy follows through onStable). Likes counters stay with the account. */
export function clearStable(s: PlayerState) {
  const st = ensureStable(s);
  const had = st.layout !== null;
  st.layout = null;
  return { removed: had };
}

// ------------------------------------------------------------------------------------------- snapshot

export interface StableHorse { horseId: string; name: string; rarity: HorseInstance['rarity']; style: HorseInstance['style']; appearance: Appearance; bondLevel: number }
/** What visitors see (copied to the directory). Never wallet, items or purchase data. */
export interface StableSnapshot {
  v: 1;
  playerId: string; displayName: string; titleId: string | null; classId: string; silks: Silks;
  /** 表札 (null = show "<displayName>の厩舎"). */
  name: string | null;
  theme: { id: string; name: string; key: string };
  /** One entry per slot of the theme; null = empty slot. `key` is the decor asset key (contracts/assets.md). */
  slots: ({ itemId: string; name: string; key: string } | null)[];
  /** 馬房: the featured horses, or the top active horses when none are chosen (`auto`). */
  horses: StableHorse[];
  autoHorses: boolean;
  /** トロフィー棚 (automatic from titles, stats and tournaments). */
  trophies: { titleIds: string[]; races: number; wins: number; top3: number; tournamentWins: number; tournamentPodiums: number };
  likes: number;
  updatedAt: number;
}

const RARITY_RANK: Record<string, number> = { R: 0, SR: 1, SSR: 2 };
const statSum = (h: HorseInstance) => Object.values(h.base).reduce((a, n) => a + n, 0);
export function topActiveHorses(s: PlayerState, n: number): HorseInstance[] {
  return s.horses.filter((h) => h.status === 'active')
    .sort((a, b) => (RARITY_RANK[b.rarity] ?? 0) - (RARITY_RANK[a.rarity] ?? 0) || b.awakening - a.awakening || statSum(b) - statSum(a) || a.id.localeCompare(b.id))
    .slice(0, n);
}

/** Effective theme: the saved one while it still exists and is unlocked, else the default. */
function effectiveTheme(c: StableConfig, s: PlayerState, id: string): StableTheme {
  const t = c.themes.find((x) => x.id === id);
  return t && themeUnlocked(t, s) ? t : defaultTheme(c);
}

/** REQ-STABLE-003: the public copy, or null when there is nothing to show (never saved, or the account is banned). */
export function stableSnapshot(m: Master, s: PlayerState, now: number): StableSnapshot | null {
  const st = peek(s);
  if (!st?.layout) return null;
  if (moderationOf(s, now) === 'banned' || deleting(s)) return null;
  const c = stableConfig(m);
  const L = st.layout;
  const theme = effectiveTheme(c, s, L.theme);
  const slots = Array.from({ length: theme.slots }, (_, i) => {
    const id = L.slots[i] ?? null;
    const d = id ? decorDef(m, id) : null;
    return d && ownsItem(s, d.id) ? { itemId: d.id, name: d.name, key: d.asset } : null;
  });
  let chosen = L.featuredHorseIds.map((id) => s.horses.find((h) => h.id === id)).filter((h): h is HorseInstance => !!h && h.status === 'active').slice(0, c.featuredMax);
  const autoHorses = chosen.length === 0;
  if (autoHorses) chosen = topActiveHorses(s, c.featuredMax);
  const tours = Object.values(s.tournaments ?? {});
  return {
    v: 1, playerId: s.id, displayName: s.profile.displayName, titleId: s.profile.titleId, classId: s.season.classId,
    silks: effectiveSilks(s.profile.silks, `p:${s.id}`, m.bannedSilks),
    name: safeName(m, L.name),
    theme: { id: theme.id, name: theme.name, key: themeKey(theme.id) },
    slots,
    horses: chosen.map((h) => ({ horseId: h.id, name: h.name, rarity: h.rarity, style: h.style, appearance: appearanceOf(h, s.id), bondLevel: horseBondLevel(m, s, h.id) })),
    autoHorses,
    trophies: {
      titleIds: s.titles.slice(-12), races: s.stats.races, wins: s.stats.wins, top3: s.stats.top3,
      tournamentWins: tours.filter((t) => t.rank === 1).length, tournamentPodiums: tours.filter((t) => t.rank >= 1 && t.rank <= 3).length,
    },
    likes: st.likes,
    updatedAt: L.updatedAt,
  };
}

/** Change detector for PlayerService.tx: the snapshot as JSON ('' = nothing published). */
export const stableSnapshotKey = (m: Master, s: PlayerState, now: number) => {
  if (!peek(s)?.layout) return '';
  const snap = stableSnapshot(m, s, now);
  return snap ? JSON.stringify(snap) : 'hidden';
};

export interface StableSummary { playerId: string; displayName: string; titleId: string | null; name: string | null; themeKey: string; likes: number; decorCount: number; horseCount: number; updatedAt: number }
export const summaryOf = (x: StableSnapshot): StableSummary => ({
  playerId: x.playerId, displayName: x.displayName, titleId: x.titleId, name: x.name, themeKey: x.theme.key, likes: x.likes,
  decorCount: x.slots.filter((y) => y !== null).length, horseCount: x.horses.length, updatedAt: x.updatedAt,
});

// ------------------------------------------------------------------------------------------- views

const rolledGiven = (st: StableState | undefined, day: string) => (st && st.given.day === day ? st.given : { day, count: 0, to: {} as Record<string, number> });

/** GET /v1/stable: my layout (or the default one built from the equipped decor), themes, decor and likes. */
export function stableView(m: Master, s: PlayerState, now: number) {
  const c = stableConfig(m);
  const st = peek(s);
  const def = defaultTheme(c);
  const layout: Omit<StableLayout, 'updatedAt'> & { updatedAt: number | null } = st?.layout ?? {
    theme: def.id, name: null, featuredHorseIds: [], updatedAt: null,
    slots: (s.equipment?.decor ?? []).filter((id): id is string => !!id && !!decorDef(m, id) && ownsItem(s, id)).slice(0, def.slots),
  };
  const given = rolledGiven(st, gameDayKey(now));
  return {
    saved: !!st?.layout,
    layout,
    themes: c.themes.map((t) => ({ id: t.id, name: t.name, key: themeKey(t.id), slots: t.slots, unlocked: themeUnlocked(t, s), unlockLikes: t.unlockLikes ?? null, unlockItem: t.unlockItem ?? null })),
    decor: m.items.cosmetics.filter((x) => x.kind === 'decor').map((x) => ({ itemId: x.id, name: x.name, key: (x as { asset: string }).asset, owned: ownsItem(s, x.id), price: x.price, currency: x.currency })),
    featuredMax: c.featuredMax,
    nameMaxChars: c.nameMaxChars,
    likes: { received: st?.likes ?? 0, givenToday: given.count, perDay: c.likesPerDay, perTargetPerDay: c.likesPerTargetPerDay },
    /** What visitors see right now (null until the first save, or while the account is banned). */
    preview: stableSnapshot(m, s, now),
    notice: 'いいねにコインは付きません。累計いいねで厩舎のテーマが解放されます。',
  };
}

export type StableRelation = 'self' | 'friend' | 'other';
export interface ViewerStatus { relation: StableRelation; likedToday: number; likesLeftToday: number; canLike: boolean }

/** The visitor's side of a visit: relation and whether a like is possible (no writes). */
export function viewerStatus(m: Master, s: PlayerState, target: string, now: number): ViewerStatus {
  const c = stableConfig(m);
  const relation: StableRelation = target === s.id ? 'self' : s.friends.ids.includes(target) ? 'friend' : 'other';
  const g = rolledGiven(peek(s), gameDayKey(now));
  const likedToday = g.to[target] ?? 0;
  const left = Math.max(0, c.likesPerDay - g.count);
  return { relation, likedToday, likesLeftToday: left, canLike: relation !== 'self' && left > 0 && likedToday < c.likesPerTargetPerDay && moderationOf(s, now) !== 'banned' };
}

// ------------------------------------------------------------------------------------------- likes

export interface LikeGiven { likeId: string; target: string; day: string; remainingToday: number }

/** REQ-STABLE-005 liker step (run with the client's idempotency key): caps, self-like, bans. No coins. */
export function stableLikeGive(m: Master, s: PlayerState, target: string, now: number, emit?: (e: KpiEvent) => void): LikeGiven {
  if (target === s.id) throw new AppError('NOT_ELIGIBLE', 'you cannot like your own stable');
  if (moderationOf(s, now) === 'banned') throw new AppError('BANNED', 'likes are disabled for this account');
  const c = stableConfig(m);
  const st = ensureStable(s);
  const day = gameDayKey(now);
  st.given = rolledGiven(st, day);
  if ((st.given.to[target] ?? 0) >= c.likesPerTargetPerDay) throw new AppError('ALREADY_LIKED', 'you already liked this stable today');
  if (st.given.count >= c.likesPerDay) throw new AppError('LIKE_LIMIT', `${c.likesPerDay} likes per day`);
  const likeId = `${s.id}:${day}:${st.given.count}`;
  st.given.count += 1;
  st.given.to[target] = (st.given.to[target] ?? 0) + 1;
  const remainingToday = Math.max(0, c.likesPerDay - st.given.count);
  emit?.({ name: 'stable_like', s1: s.friends.ids.includes(target) ? 'friend' : 'other', value: remainingToday });
  return { likeId, target, day, remainingToday };
}

/** REQ-STABLE-005 target step: counts each likeId once and at most likesPerTargetPerDay per liker per day. */
export function stableLikeReceive(m: Master, s: PlayerState, from: string, likeId: string, now: number) {
  const c = stableConfig(m);
  if (deleting(s)) return { counted: false, likes: peek(s)?.likes ?? 0 }; // REQ-UXS-040: the account is going away
  const st = ensureStable(s);
  if (from === s.id || st.recv.ids.includes(likeId)) return { counted: false, likes: st.likes };
  const day = likeId.split(':').slice(-2, -1)[0] ?? gameDayKey(now);
  if (st.recv.day !== day) st.recv = { day, from: {}, ids: st.recv.ids };
  st.recv.ids.push(likeId);
  if (st.recv.ids.length > LIKE_IDS_KEEP) st.recv.ids.splice(0, st.recv.ids.length - LIKE_IDS_KEEP);
  if ((st.recv.from[from] ?? 0) >= c.likesPerTargetPerDay) return { counted: false, likes: st.likes };
  st.recv.from[from] = (st.recv.from[from] ?? 0) + 1;
  st.likes += 1;
  return { counted: true, likes: st.likes };
}

// ------------------------------------------------------------------------------------------- orchestration

/** Public copies, sharded by owner in DirectoryDO (production) or in memory (tests). */
export interface StableDirectory {
  put(x: StableSnapshot): Promise<void>;
  remove(playerId: string): Promise<void>;
  get(playerId: string): Promise<StableSnapshot | null>;
  ofPlayers(ids: string[]): Promise<StableSnapshot[]>;
  /** Most liked first (then most recently updated). */
  top(limit: number): Promise<StableSnapshot[]>;
}

export const sortStables = (xs: StableSnapshot[]) => xs.sort((a, b) => b.likes - a.likes || b.updatedAt - a.updatedAt || a.playerId.localeCompare(b.playerId));

export class MemoryStableDirectory implements StableDirectory {
  readonly rows = new Map<string, StableSnapshot>();
  async put(x: StableSnapshot) { this.rows.set(x.playerId, structuredClone(x)); }
  async remove(id: string) { this.rows.delete(id); }
  async get(id: string) { return this.rows.get(id) ?? null; }
  async ofPlayers(ids: string[]) { return ids.map((id) => this.rows.get(id)).filter((x): x is StableSnapshot => !!x); }
  async top(limit: number) { return sortStables([...this.rows.values()]).slice(0, limit); }
}

/** Per-player steps (PlayerDO RPC in production, PlayerService in tests). */
export interface StablePlayers {
  mine(u: string): Promise<ReturnType<typeof stableView>>;
  save(u: string, input: StableInput): Promise<{ layout: StableLayout; snapshot: StableSnapshot | null }>;
  visit(u: string, target: string): Promise<ViewerStatus>;
  give(u: string, target: string, idemKey: string): Promise<LikeGiven>;
  receive(target: string, from: string, likeId: string): Promise<{ counted: boolean; likes: number; snapshot: StableSnapshot | null }>;
  friendIds(u: string): Promise<string[]>;
}

export class StableService {
  constructor(private readonly p: StablePlayers, private readonly dir: StableDirectory, private readonly cfg: () => StableConfig) {}

  mine(u: string) { return this.p.mine(u); }

  /** PUT /v1/stable: validated in the owner's object, then the public copy is written. */
  async save(u: string, input: StableInput) {
    const r = await this.p.save(u, input);
    if (r.snapshot) await this.dir.put(r.snapshot);
    else await this.dir.remove(u);
    return r;
  }

  /** GET /v1/stable/:playerId: the directory copy (never the owner's object) + the visitor's like status. */
  async visit(u: string, target: string) {
    const stable = await this.dir.get(target);
    if (!stable) throw new AppError('NOT_FOUND', 'this stable is not open yet');
    const viewer = await this.p.visit(u, target);
    return { stable, viewer };
  }

  /** GET /v1/stable/visits: friends' stables and a few recommended ones (most liked, not mine, not empty). */
  async visits(u: string) {
    const friendIds = await this.p.friendIds(u);
    const friends = sortStables(await this.dir.ofPlayers(friendIds)).map(summaryOf);
    const limit = this.cfg().recommendedLimit;
    const skip = new Set([u, ...friendIds]);
    const recommended = (await this.dir.top(limit * 3)).filter((x) => !skip.has(x.playerId) && (x.slots.some((y) => y !== null) || x.name !== null)).slice(0, limit).map(summaryOf);
    return { friends, recommended };
  }

  /** POST /v1/stable/:playerId/like (idempotency key required). No coins for either side. */
  async like(u: string, target: string, idemKey: string) {
    if (u === target) throw new AppError('NOT_ELIGIBLE', 'you cannot like your own stable');
    if (!(await this.dir.get(target))) throw new AppError('NOT_FOUND', 'this stable is not open yet');
    const g = await this.p.give(u, target, idemKey);
    const r = await this.p.receive(target, u, g.likeId);
    if (r.snapshot) await this.dir.put(r.snapshot);
    else await this.dir.remove(target);
    return { playerId: target, likes: r.likes, remainingToday: g.remainingToday };
  }

  /**
   * Account deletion hook (DELETE /v1/player): removes the public copy so nobody can visit or like the
   * stable any more. The layout and like counters live in the player's own state and go with it; call
   * this before (or after) wiping the player's object — it never touches that object.
   */
  async removeStable(playerId: string) {
    await this.dir.remove(playerId);
    return { removed: true };
  }
}

/**
 * REQ-UXS-040: the account deletion's `stable` port. `forget` clears the layout and like records in the
 * deleting player's own object (PlayerService.stableForget), then StableService.removeStable drops the
 * visitors' copy. Both are idempotent, so a resumed deletion can run it again.
 */
export function stableDeletionPort(forget: (uid: string) => Promise<unknown>, service: Pick<StableService, 'removeStable'>) {
  return {
    async removeStable(uid: string) {
      await forget(uid);
      await service.removeStable(uid);
    },
  };
}
