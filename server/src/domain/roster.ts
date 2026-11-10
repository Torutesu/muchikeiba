/**
 * REQ-ORG-001..016: 厩舎の整理 (horse roster organiser, contracts/protocol.md §44).
 *
 * Sort / filter / search the stable, favourites and locks, and bulk actions. A bulk action repeats the existing single-horse
 * rule exactly (today the only way to part with a horse is 引退, `horses.ts` retire → `hallOfFame.ts` noteHallRetire), inside
 * one PlayerDO transaction: every horse is checked first, and one refusal refuses the whole request (nothing changes).
 * Retiring pays nothing back, so no coin / material flow changes (no economy target).
 *
 * The sort / filter / search function is pure and shared with the client (C# RosterSorter, contracts/roster-query.vectors.json).
 */
import { z } from 'zod';
import { AppError } from './errors.js';
import type { Master, Stats } from './master.js';
import { STAT_KEYS } from './master.js';
import type { HorseInstance, PlayerState } from './player.js';
import { effectiveStats, getHorse, normalizeName, retire } from './horses.js';
import { noteHallRetire, type Ceremony } from './hallOfFame.js';
import { dayRule, gameDayIndex } from './time.js';
import type { Emit } from './service.js';
import type { Going } from './schemas.js';

// ------------------------------------------------------------------ state

export interface RosterState {
  locked: string[];
  favorites: string[];
  /** REQ-ORG-011: tournaments the player is registered for, by tournament id (written by TournamentsService after it succeeds). */
  tournaments?: Record<string, { horseId: string; untilMs: number }>;
}

export const ROSTER_LIMITS = { bulkMax: 50, queryMaxChars: 20, tournamentGraceMs: 24 * 3_600_000, tournamentFallbackMs: 14 * 24 * 3_600_000 } as const;
export const BULK_ACTIONS = ['retire'] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];
/** REQ-ORG-009: refusal reasons, in the order they are listed. */
export const BULK_REASONS = ['not_found', 'locked', 'partner', 'not_active', 'on_loan', 'in_training', 'tournament_entry', 'hall_pending'] as const;
export type BulkReason = (typeof BULK_REASONS)[number];
export const ROSTER_NOTICE = 'まとめて引退しても、コインや素材は返ってきません';

export function ensureRoster(s: PlayerState): RosterState {
  s.roster ??= { locked: [], favorites: [] };
  return s.roster;
}
const peek = (s: PlayerState): RosterState | undefined => s.roster;
export const isLocked = (s: PlayerState, horseId: string) => peek(s)?.locked.includes(horseId) ?? false;
export const isFavorite = (s: PlayerState, horseId: string) => peek(s)?.favorites.includes(horseId) ?? false;

/** REQ-ORG-005: every action that consumes / removes a horse goes through this. */
export function assertNotLocked(s: PlayerState, horseId: string) {
  if (isLocked(s, horseId)) throw new AppError('HORSE_LOCKED', `horse ${horseId} is locked`);
}

function setFlag(list: string[], id: string, on: boolean): string[] {
  const rest = list.filter((x) => x !== id);
  return on ? [...rest, id] : rest;
}
export function setLock(s: PlayerState, horseId: string, locked: boolean) {
  getHorse(s, horseId);
  const r = ensureRoster(s);
  r.locked = setFlag(r.locked, horseId, locked);
  return { horseId, locked };
}
export function setFavorite(s: PlayerState, horseId: string, favorite: boolean) {
  getHorse(s, horseId);
  const r = ensureRoster(s);
  r.favorites = setFlag(r.favorites, horseId, favorite);
  return { horseId, favorite };
}

/** REQ-ORG-011: the player registered (horseId) or unregistered (null) for a tournament. */
export function noteTournamentEntry(s: PlayerState, tournamentId: string, horseId: string | null, untilMs: number) {
  const r = ensureRoster(s);
  const t = (r.tournaments ??= {});
  if (horseId) t[tournamentId] = { horseId, untilMs };
  else delete t[tournamentId];
}
function tournamentOf(s: PlayerState, horseId: string, now: number): string | null {
  const t = peek(s)?.tournaments;
  if (!t) return null;
  for (const [id, e] of Object.entries(t).sort((a, b) => a[0].localeCompare(b[0]))) if (e.horseId === horseId && now < e.untilMs) return id;
  return null;
}
/** Drops expired tournament records (inside a transaction). */
export function pruneRoster(s: PlayerState, now: number) {
  const t = peek(s)?.tournaments;
  if (!t) return;
  for (const [id, e] of Object.entries(t)) if (now >= e.untilMs) delete t[id];
}

// ------------------------------------------------------------------ blocks (REQ-ORG-009)

/** Why a bulk `action` would refuse this horse right now (empty = allowed), in BULK_REASONS order. */
export function bulkReasons(s: PlayerState, horseId: string, action: BulkAction, now: number): BulkReason[] {
  const h = s.horses.find((x) => x.id === horseId);
  if (!h) return ['not_found'];
  const out: BulkReason[] = [];
  if (isLocked(s, horseId)) out.push('locked');
  if (s.flags.partnerHorseId === horseId) out.push('partner');
  if (action === 'retire' && h.status !== 'active') out.push('not_active');
  const stud = s.stud;
  if (stud && (stud.listings.some((l) => l.horseId === horseId) || Object.values(stud.reservations).some((r) => r.horseId === horseId))) out.push('on_loan');
  const open = s.training?.open;
  if (open && open.horseId === horseId && now < open.expiresAt) out.push('in_training');
  if (tournamentOf(s, horseId, now)) out.push('tournament_entry');
  const cer = s.hall?.ceremonies[horseId];
  if (cer && cer.ackedAt === null) out.push('hall_pending');
  return out;
}

// ------------------------------------------------------------------ rows (REQ-ORG-001)

export interface RosterRow {
  horseId: string; name: string; templateId: string | null; rarity: string; sex: string; style: string;
  surface: 'turf' | 'dirt' | 'both'; distMinM: number; distMaxM: number; goingAptitude: 'any' | 'fast' | 'heavy'; status: 'active' | 'retired';
  rating: number; skillId: string | null; partner: boolean; locked: boolean; favorite: boolean;
  acquiredSeq: number; bornAt: number; ageDays: number; races: number; wins: number; blocks: BulkReason[];
  appearance?: unknown;
}

const seqOf = (id: string) => { const n = Number(id.replace(/^\D+/, '')); return Number.isFinite(n) ? n : 0; };
const statsTotal = (st: Stats | undefined) => (st ? STAT_KEYS.reduce((a, k) => a + (st[k] ?? 0), 0) : 0);

export function rosterRow(m: Master, s: PlayerState, h: HorseInstance, now: number): RosterRow {
  const career = s.hall?.careers[h.id];
  const rule = dayRule(m);
  return {
    horseId: h.id, name: h.name, templateId: h.templateId, rarity: h.rarity, sex: h.sex, style: h.style,
    surface: h.surface, distMinM: h.distMinM, distMaxM: h.distMaxM, goingAptitude: h.goingAptitude ?? 'any', status: h.status,
    rating: statsTotal(effectiveStats(m, h)) + statsTotal(h.trained), skillId: h.skillId ?? null,
    partner: s.flags.partnerHorseId === h.id, locked: isLocked(s, h.id), favorite: isFavorite(s, h.id),
    acquiredSeq: seqOf(h.id), bornAt: h.bornAt, ageDays: Math.max(0, gameDayIndex(now, rule) - gameDayIndex(h.bornAt, rule)),
    races: career?.races ?? 0, wins: career?.wins ?? 0, blocks: bulkReasons(s, h.id, 'retire', now),
    ...(h.appearance ? { appearance: h.appearance } : {}),
  };
}

// ------------------------------------------------------------------ query (REQ-ORG-002/003, shared with C# RosterSorter)

export const SORT_KEYS = ['rating', 'aptitude', 'age', 'acquired', 'races', 'rarity', 'name'] as const;
export const DISTANCE_BANDS = { sprint: [0, 1400], mile: [1401, 1800], intermediate: [1801, 2400], long: [2401, 99_999] } as const;
export type DistanceBand = keyof typeof DISTANCE_BANDS;
const flag = z.enum(['0', '1']).transform((v) => v === '1');
export const rosterQuerySchema = z.object({
  sort: z.enum(SORT_KEYS).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  trackId: z.string().min(1).max(64).optional(),
  going: z.enum(['firm', 'good', 'yielding', 'soft', 'fast', 'muddy', 'sloppy']).optional(),
  surface: z.enum(['turf', 'dirt']).optional(),
  band: z.enum(['sprint', 'mile', 'intermediate', 'long']).optional(),
  style: z.enum(['nige', 'senko', 'sashi', 'oikomi']).optional(),
  status: z.enum(['active', 'retired', 'all']).optional(),
  skill: flag.optional(), partner: flag.optional(), locked: flag.optional(), favorite: flag.optional(),
  favoritesFirst: flag.optional(),
  q: z.string().max(ROSTER_LIMITS.queryMaxChars).optional(),
}).strict();
export type RosterQueryInput = z.input<typeof rosterQuerySchema>;

/** A resolved query: the course is given as surface + distance so the client can run it without the track list. */
export interface RosterQuery {
  sort: (typeof SORT_KEYS)[number]; dir: 'asc' | 'desc';
  course: { surface: 'turf' | 'dirt'; distanceM: number; going: Going | null } | null;
  surface: 'turf' | 'dirt' | null; band: DistanceBand | null; style: string | null; status: 'active' | 'retired' | 'all';
  skill: boolean | null; partner: boolean | null; locked: boolean | null; favorite: boolean | null; favoritesFirst: boolean; q: string;
}
export const DEFAULT_QUERY: RosterQuery = {
  sort: 'acquired', dir: 'desc', course: null, surface: null, band: null, style: null, status: 'all',
  skill: null, partner: null, locked: null, favorite: null, favoritesFirst: true, q: '',
};

export function parseRosterQuery(m: Master, raw: Record<string, string | undefined>): RosterQuery {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (v !== undefined && v !== '') clean[k] = v;
  const r = rosterQuerySchema.safeParse(clean);
  if (!r.success) throw new AppError('BAD_REQUEST', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const d = r.data;
  let course: RosterQuery['course'] = null;
  if (d.trackId) {
    const t = m.tracks.find((x) => x.id === d.trackId);
    if (!t) throw new AppError('BAD_REQUEST', 'unknown trackId');
    course = { surface: t.surface, distanceM: t.distanceM, going: (d.going as Going | undefined) ?? null };
  }
  if ((d.sort ?? DEFAULT_QUERY.sort) === 'aptitude' && !course) throw new AppError('BAD_REQUEST', 'sort=aptitude needs a trackId');
  return {
    sort: d.sort ?? DEFAULT_QUERY.sort, dir: d.dir ?? DEFAULT_QUERY.dir, course,
    surface: d.surface ?? null, band: d.band ?? null, style: d.style ?? null, status: d.status ?? 'all',
    skill: d.skill ?? null, partner: d.partner ?? null, locked: d.locked ?? null, favorite: d.favorite ?? null,
    favoritesFirst: d.favoritesFirst ?? true, q: d.q ?? '',
  };
}

/** Wetness of a going: -2 firm/fast, 0 good, 1 yielding/muddy, 2 soft/sloppy (RaceSim.GoingSpecialistPermille's steps). */
export function goingWet(g: Going | null): number {
  switch (g) {
    case 'firm': case 'fast': return -2;
    case 'yielding': case 'muddy': return 1;
    case 'soft': case 'sloppy': return 2;
    default: return 0;
  }
}

/** REQ-ORG-002: aptitude for a course (the engine's conditions: out-of-range penalty, surface, ground preference). */
export function aptitudeFor(h: Pick<RosterRow, 'surface' | 'distMinM' | 'distMaxM' | 'goingAptitude'>, c: NonNullable<RosterQuery['course']>) {
  const surfaceOk = h.surface === 'both' || h.surface === c.surface;
  const gap = c.distanceM < h.distMinM ? h.distMinM - c.distanceM : c.distanceM > h.distMaxM ? c.distanceM - h.distMaxM : 0;
  const distanceOk = gap === 0;
  const wet = goingWet(c.going);
  const goingFit = h.goingAptitude === 'fast' ? -wet : h.goingAptitude === 'heavy' ? wet : 0;
  const score = (surfaceOk ? 200 : 0) + Math.max(0, 200 - Math.floor(gap / 2)) + 25 * goingFit;
  const mark = surfaceOk && distanceOk ? (goingFit >= 0 ? '◎' : '○') : surfaceOk || distanceOk ? '△' : '×';
  return { score, mark, surfaceOk, distanceOk, goingFit };
}

/** Name folding for search: normalizeName (NFKC, no spaces, hiragana → katakana, one long-vowel mark), lower case. */
export const foldSearch = (s: string) => normalizeName(s).toLowerCase();

const RARITY_RANK: Record<string, number> = { R: 1, SR: 2, SSR: 3 };

function sortValue(r: RosterRow, q: RosterQuery): number {
  switch (q.sort) {
    case 'rating': return r.rating;
    case 'aptitude': return q.course ? aptitudeFor(r, q.course).score : 0;
    case 'age': return r.ageDays;
    case 'races': return r.races;
    case 'rarity': return RARITY_RANK[r.rarity] ?? 0;
    case 'acquired': default: return r.acquiredSeq;
  }
}

/** REQ-ORG-002/003: filter, search and sort. Ties → acquiredSeq ascending. Pure, deterministic; the client runs the same rules. */
export function applyRosterQuery<T extends RosterRow>(rows: readonly T[], q: RosterQuery): T[] {
  const needle = q.q ? foldSearch(q.q) : '';
  const band = q.band ? DISTANCE_BANDS[q.band] : null;
  const out = rows.filter((r) => {
    if (q.status !== 'all' && r.status !== q.status) return false;
    if (q.surface && r.surface !== 'both' && r.surface !== q.surface) return false;
    if (band && (r.distMaxM < band[0] || r.distMinM > band[1])) return false;
    if (q.style && r.style !== q.style) return false;
    if (q.skill !== null && (r.skillId !== null) !== q.skill) return false;
    if (q.partner !== null && r.partner !== q.partner) return false;
    if (q.locked !== null && r.locked !== q.locked) return false;
    if (q.favorite !== null && r.favorite !== q.favorite) return false;
    if (needle && !foldSearch(r.name).includes(needle)) return false;
    return true;
  });
  const sign = q.dir === 'asc' ? 1 : -1;
  return out.sort((a, b) => {
    if (q.favoritesFirst && a.favorite !== b.favorite) return a.favorite ? -1 : 1;
    let c: number;
    if (q.sort === 'name') c = a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    else c = sortValue(a, q) - sortValue(b, q);
    if (c !== 0) return sign * c;
    return a.acquiredSeq - b.acquiredSeq;
  });
}

export function rosterView(m: Master, s: PlayerState, now: number, q: RosterQuery = DEFAULT_QUERY) {
  const rows = s.horses.map((h) => rosterRow(m, s, h, now));
  const owned = new Set(s.horses.map((h) => h.id));
  return {
    total: rows.length, active: rows.filter((r) => r.status === 'active').length, retired: rows.filter((r) => r.status === 'retired').length,
    locked: (peek(s)?.locked ?? []).filter((id) => owned.has(id)).length, favorites: (peek(s)?.favorites ?? []).filter((id) => owned.has(id)).length,
    bulkMax: ROSTER_LIMITS.bulkMax, actions: [...BULK_ACTIONS], partnerHorseId: s.flags.partnerHorseId ?? null,
    horses: applyRosterQuery(rows, q), notice: ROSTER_NOTICE,
  };
}

// ------------------------------------------------------------------ bulk (REQ-ORG-006..010)

export const bulkBodySchema = z.object({
  action: z.enum(BULK_ACTIONS),
  horseIds: z.array(z.string().min(1).max(32)).min(1).max(ROSTER_LIMITS.bulkMax),
  confirmToken: z.string().max(64).optional(),
}).strict();

/** What a bulk action gives back. Retiring gives nothing back (REQ-HORSE-004); kept as a shape so the screen always states it. */
export interface BulkRefund { paidCoins: number; freeCoins: number; materials: Record<string, number>; items: Record<string, number> }
const refundOf = (_action: BulkAction, _horses: readonly string[]): BulkRefund => ({ paidCoins: 0, freeCoins: 0, materials: {}, items: {} });

/** FNV-1a 32-bit (a staleness mark, not a secret). */
function fnv(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

function checkIds(ids: readonly string[]) {
  if (new Set(ids).size !== ids.length) throw new AppError('BAD_REQUEST', 'duplicate horseIds');
}

export function bulkPreview(s: PlayerState, action: BulkAction, horseIds: readonly string[], now: number) {
  checkIds(horseIds);
  const horses = horseIds.map((id) => {
    const h = s.horses.find((x) => x.id === id);
    const reasons = bulkReasons(s, id, action, now);
    return { horseId: id, name: h?.name ?? '', ok: reasons.length === 0, reasons };
  });
  const refund = refundOf(action, horseIds);
  const sig = JSON.stringify([action, horses.map((h) => [h.horseId, h.reasons, s.horses.find((x) => x.id === h.horseId)?.status ?? null]), refund]);
  const eligible = horses.filter((h) => h.ok).length;
  return {
    action, count: horses.length, eligible, refused: horses.length - eligible, horses, refund,
    canConfirm: eligible === horses.length, confirmToken: `r1-${fnv(sig)}`,
  };
}

/**
 * REQ-ORG-008: all or nothing. Checks every horse first (one refusal → ROSTER_BULK_REFUSED, nothing changes), checks the token
 * against a fresh preview (ROSTER_BULK_STALE), then runs the single-horse rule for each horse in order. Runs inside one
 * PlayerService transaction, so an unexpected failure part-way drops the whole draft.
 */
export function runBulk(m: Master, s: PlayerState, action: BulkAction, horseIds: readonly string[], confirmToken: string | undefined, now: number, emit: Emit) {
  const p = bulkPreview(s, action, horseIds, now);
  if (!p.canConfirm) throw new AppError('ROSTER_BULK_REFUSED', `${p.refused} horse(s) cannot be retired`, undefined, { horses: p.horses.filter((h) => !h.ok) });
  if (!confirmToken || confirmToken !== p.confirmToken) throw new AppError('ROSTER_BULK_STALE', 'the confirmation no longer matches; preview again');
  const done: { horseId: string; name: string; ceremony: Ceremony | null }[] = [];
  for (const id of horseIds) {
    assertNotLocked(s, id);
    const h = retire(s, id); // the single-horse rule (REQ-HORSE-004)
    done.push({ horseId: h.id, name: h.name, ceremony: noteHallRetire(m, s, h, now, emit) }); // REQ-HOF-003, one ceremony per horse
  }
  emit({ name: 'roster_bulk_action', s1: action, count: done.length });
  return { action, count: done.length, horses: done, refund: p.refund };
}
