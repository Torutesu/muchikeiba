/**
 * ライバル (weekly rival) — REQ-RIVAL-001..016, contracts/protocol.md §28.
 *
 * Every game week (starts on `weekStartsOn`, Monday by default, at the game-day rollover — progression.dayRollover,
 * 04:00 JST) each player gets one rival:
 * - a human of similar rating in the same class who also played ranked last week, paired deterministically from a seed
 *   (the week id) and the sorted candidate list (pairWeek), or
 * - a named CPU rival with a personality when nobody fits (late joiners, odd one out, no candidates, rating gap).
 * The pairing lives in a registry object per week (LeaderboardDO instance `rival:<weekId>`, do/rivalStore.ts; tests use
 * MemoryRivalRegistry): players register there during week W as candidates for week W+1. Nothing here assumes that the
 * registry and the player objects are consistent at every instant: the player keeps its own copy of everything it needs
 * to settle a week (races, its time-attack bests, the rival's bests as last seen), and the registry only answers "who is
 * my rival, was the pair dissolved, what are their week bests".
 *
 * Head to head: a confirmed ranked race (same trust rule as settlement: consensus or verifier, never void) in which
 * both rivals finished gives the higher finisher a point. Both player objects receive the same confirmed result
 * (RaceResultForPlayer.field), so their tallies mirror without talking to each other. Against a CPU rival every ranked
 * race counts: the player scores when they finish at or above the personality's `targetPlace`, the CPU otherwise.
 * Time attack: each side's best time this week per course; at week end it only breaks a tied head-to-head score
 * (courses where you were faster). Friend-room challenges (ライバルと走る) are shown but never score (unranked).
 *
 * Rewards (legal, docs/planning/03 「ライバル」): a fixed free-coin amount per result (win / draw / lose / no contest),
 * only with `minRacesForResult` own ranked races in the week, ≤ RIVAL_HARD_LIMITS.freeCoinsPerWeek (100 coins ≈ ¥160 <
 * ¥200 総付景品). No randomness, no streak bonus (titles count total weeks won, not consecutive ones, and are cosmetic),
 * free coins only (paid coins are never granted). Economy E16 (docs/spec/balance-targets.md 4.14).
 *
 * Privacy: the rival sees only the public card (display name, title, class, silks, partner horse) — the public profile
 * copy plus the partner horse. Blocked players (the team-feed mute list is the one block list), opted-out players,
 * banned players and accounts scheduled for deletion are never paired; a block / opt-out / deletion dissolves the
 * current pair for both sides.
 */
import { z } from 'zod';
import { AppError } from './errors.js';
import type { Master, Style } from './master.js';
import { moderationOf, type PlayerState } from './player.js';
import { deletionScheduled } from './accountDeletion.js';
import { addJstDays, dayRule, gameDayKey, gameWeekEndMs, gameWeekId, sameGameDay } from './time.js';
import { grantFree } from './wallet.js';
import { appearanceOf, effectiveSilks, type Appearance, type Silks } from './visuals.js';
import { ensureFeed, playerMute } from './teamFeed.js';
import { evaluateTitles } from './stats.js';
import { recordActivity } from './activity.js';
import type { KpiEvent } from './kpi.js';
import type { RaceResultForPlayer } from './rewards.js';
import tracksJson from '../../master/tracks.json';

const TRACK_NAMES: Record<string, string> = Object.fromEntries((tracksJson as { tracks: { id: string; name?: string }[] }).tracks.map((t) => [t.id, t.name ?? t.id]));
export const rivalTrackName = (trackId: string) => TRACK_NAMES[trackId] ?? trackId;

// ------------------------------------------------------------------------------------------------ config

export type RivalOutcome = 'win' | 'lose' | 'draw' | 'no_contest';
export type TaMedal = 'bronze' | 'silver' | 'gold';
export interface RivalCpuDef {
  id: string; name: string;
  /** Personality key and its one line (shown on the card). */
  personality: string; line: string;
  style: Style;
  /** The player scores in a ranked race when finishing at this place or better (12-horse field). */
  targetPlace: number;
  /** Its time-attack "best" per course = that medal's time (progression.timeAttack.milestones). */
  taMedal: TaMedal;
}
export interface RivalConfig {
  enabled: boolean;
  /** Weekday the game week starts on (0 = Sunday … 6 = Saturday), at the game-day rollover. */
  weekStartsOn: number;
  /** Largest rating difference of a human pair. */
  maxRatingGap: number;
  /** ± seeded jitter on the rating sort (so the same neighbours are not paired every week). */
  jitter: number;
  /** How far down the sorted class list a player looks for a partner. */
  pairWindow: number;
  /** Own ranked races in the week needed for a result reward. */
  minRacesForResult: number;
  rewards: Record<RivalOutcome, { freeCoins: number }>;
  /** ライバルと走る (friend-room challenge) invitations per game day. */
  challengesPerDay: number;
  /** Races kept for the "recent races" list of the week. */
  recentKeep: number;
  cpuRivals: RivalCpuDef[];
}

/** Legal / anti-abuse ceilings a remote config can never exceed. 100 free coins ≈ ¥160 (< ¥200 per grant). */
export const RIVAL_HARD_LIMITS = { freeCoinsPerWeek: 100, challengesPerDay: 10, maxRatingGap: 600, jitter: 200, pairWindow: 8, recentKeep: 30, cpuRivals: 20, weeksKept: 4, resultsKept: 8 } as const;

const int = z.number().int();
const cpuSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]{1,40}$/), name: z.string().min(1).max(20), personality: z.string().regex(/^[a-z_]{1,20}$/), line: z.string().min(1).max(60),
  style: z.enum(['nige', 'senko', 'sashi', 'oikomi']), targetPlace: int.min(1).max(12), taMedal: z.enum(['bronze', 'silver', 'gold']),
}).strict();
const rewardSchema = z.object({ freeCoins: int.min(0) }).strict();
export const rivalConfigSchema = z.object({
  _note: z.string().optional(),
  enabled: z.boolean(), weekStartsOn: int.min(0).max(6), maxRatingGap: int.min(0), jitter: int.min(0), pairWindow: int.min(1),
  minRacesForResult: int.min(1).max(50),
  rewards: z.object({ win: rewardSchema, draw: rewardSchema, lose: rewardSchema, no_contest: rewardSchema }).strict(),
  challengesPerDay: int.min(0), recentKeep: int.min(1), cpuRivals: z.array(cpuSchema).min(1),
}).strict();

export const rivalConfig = (m: Pick<Master, 'progression'>): RivalConfig | null => {
  const c = (m.progression as { rival?: RivalConfig }).rival;
  return c && c.enabled ? c : null;
};

/** REQ-RIVAL-012: boot and every remote-config version. */
export function rivalProblems(m: Pick<Master, 'progression' | 'titles'>, path = 'progression.rival'): string[] {
  const raw = (m.progression as { rival?: unknown }).rival;
  if (raw === undefined) return [];
  const r = rivalConfigSchema.safeParse(raw);
  if (!r.success) return r.error.issues.map((i) => `${path}.${i.path.join('.')}: ${i.message}`);
  const c = r.data as RivalConfig;
  const H = RIVAL_HARD_LIMITS;
  const out: string[] = [];
  for (const [k, v] of Object.entries(c.rewards)) if (v.freeCoins > H.freeCoinsPerWeek) out.push(`${path}.rewards.${k}.freeCoins: at most ${H.freeCoinsPerWeek} (≈ ¥160, under the ¥200 premium limit)`);
  const w = c.rewards;
  if (!(w.win.freeCoins >= w.draw.freeCoins && w.draw.freeCoins >= w.lose.freeCoins)) out.push(`${path}.rewards: must be win ≥ draw ≥ lose`);
  if (w.no_contest.freeCoins > w.draw.freeCoins) out.push(`${path}.rewards.no_contest: must be ≤ draw (dissolving a pair never pays more)`);
  if (c.challengesPerDay > H.challengesPerDay) out.push(`${path}.challengesPerDay: at most ${H.challengesPerDay}`);
  if (c.maxRatingGap > H.maxRatingGap) out.push(`${path}.maxRatingGap: at most ${H.maxRatingGap}`);
  if (c.jitter > H.jitter) out.push(`${path}.jitter: at most ${H.jitter}`);
  if (c.pairWindow > H.pairWindow) out.push(`${path}.pairWindow: at most ${H.pairWindow}`);
  if (c.recentKeep > H.recentKeep) out.push(`${path}.recentKeep: at most ${H.recentKeep}`);
  if (c.cpuRivals.length > H.cpuRivals) out.push(`${path}.cpuRivals: at most ${H.cpuRivals}`);
  const ids = new Set<string>();
  for (const x of c.cpuRivals) { if (ids.has(x.id)) out.push(`${path}.cpuRivals: duplicate id ${x.id}`); ids.add(x.id); }
  // titles for weeks won: cumulative (never "in a row"), cosmetic only
  for (const t of m.titles) {
    const cond = t.condition as { kind: string; value?: number };
    if (cond.kind === 'rivalWeeksWon' && !(Number.isInteger(cond.value) && cond.value! >= 1 && cond.value! <= 520)) out.push(`titles.${t.id}: rivalWeeksWon needs a value 1..520`);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ week

/**
 * REQ-RIVAL-001: the game week of `now` = the game day key ("YYYY-MM-DD") of its first day. The shared game week of
 * time.ts (gameWeekId), the same one the weekly challenge (§31) and the team goal (§32) use.
 */
export function weekIdAt(m: Pick<Master, 'progression'>, now: number, weekStartsOn = rivalConfig(m)?.weekStartsOn ?? 1): string {
  return gameWeekId(now, dayRule(m), weekStartsOn);
}
/** First instant of the next week (the rollover of its first game day). */
export const weekEndMs = (m: Pick<Master, 'progression'>, weekId: string) => gameWeekEndMs(weekId, dayRule(m));
export const prevWeekId = (weekId: string) => addJstDays(weekId, -7);

// ------------------------------------------------------------------------------------------------ public card / registry entry

export interface RivalCard {
  displayName: string; titleId: string | null; classId: string; silks: Silks;
  partner: { name: string; rarity: string; style: string; appearance: Appearance } | null;
}
/** What a player registers in week W as a candidate for week W+1 (REQ-RIVAL-002). */
export interface RivalEntry {
  playerId: string; classId: string; rating: number; rankedAt: number;
  /** The player's block list (the team-feed mute list): never paired with these, either way round. */
  blocked: string[];
  card: RivalCard;
  updatedAt: number;
}
/** REQ-RIVAL-010: the public card — the public profile fields plus the partner horse. Nothing else leaves the object. */
export function rivalCard(m: Master, s: PlayerState): RivalCard {
  const horses = s.horses.filter((h) => h.status === 'active');
  const p = horses.find((h) => h.id === s.flags.partnerHorseId) ?? horses[0] ?? null;
  return {
    displayName: s.profile.displayName, titleId: s.profile.titleId, classId: s.season.classId, silks: effectiveSilks(s.profile.silks, `p:${s.id}`, m.bannedSilks),
    partner: p ? { name: p.name, rarity: p.rarity, style: p.style, appearance: appearanceOf(p, s.id) } : null,
  };
}

/** REQ-RIVAL-011: never paired / pair dissolved. */
export const rivalWithdrawn = (s: PlayerState, now: number) => !!s.rival?.optOut || deletionScheduled(s) || moderationOf(s, now) === 'banned';

// ------------------------------------------------------------------------------------------------ pairing (pure, deterministic)

/** FNV-1a 32-bit (stable across runtimes). */
export function fnv32(x: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < x.length; i++) { h ^= x.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

export function cpuRivalFor(c: RivalConfig, weekId: string, playerId: string): RivalCpuDef {
  return c.cpuRivals[fnv32(`cpu:${weekId}:${playerId}`) % c.cpuRivals.length]!;
}

/**
 * REQ-RIVAL-003: the week's human pairs from last week's candidates. Deterministic: per class, candidates are sorted by
 * rating + a jitter seeded by (weekId, playerId) (ties: player id); walking that list, each unpaired player takes the
 * first unpaired player within `pairWindow` places who is within `maxRatingGap` and blocked by neither side. The
 * input order does not matter (the list is sorted first). Players left over get a CPU rival.
 */
export function pairWeek(c: RivalConfig, weekId: string, entries: RivalEntry[], withdrawn: ReadonlySet<string> = new Set()): Map<string, string> {
  const pairs = new Map<string, string>();
  const byClass = new Map<string, RivalEntry[]>();
  for (const e of entries) {
    if (withdrawn.has(e.playerId)) continue;
    let l = byClass.get(e.classId);
    if (!l) byClass.set(e.classId, (l = []));
    l.push(e);
  }
  const span = 2 * c.jitter + 1;
  const key = (e: RivalEntry) => e.rating + (fnv32(`${weekId}:${e.playerId}`) % span) - c.jitter;
  for (const classId of [...byClass.keys()].sort()) {
    const list = byClass.get(classId)!.map((e) => ({ e, k: key(e) })).sort((a, b) => b.k - a.k || (a.e.playerId < b.e.playerId ? -1 : 1)).map((x) => x.e);
    for (let i = 0; i < list.length; i++) {
      const a = list[i]!;
      if (pairs.has(a.playerId)) continue;
      for (let j = i + 1; j < list.length && j <= i + c.pairWindow; j++) {
        const b = list[j]!;
        if (pairs.has(b.playerId) || b.playerId === a.playerId) continue;
        if (Math.abs(a.rating - b.rating) > c.maxRatingGap) continue;
        if (a.blocked.includes(b.playerId) || b.blocked.includes(a.playerId)) continue;
        pairs.set(a.playerId, b.playerId);
        pairs.set(b.playerId, a.playerId);
        break;
      }
    }
  }
  return pairs;
}

// ------------------------------------------------------------------------------------------------ player state

export type RivalAssign =
  | { kind: 'human'; rivalId: string; card: RivalCard | null; dissolvedAt: number | null; dissolvedBy?: 'me' }
  | { kind: 'cpu'; cpuId: string };
export interface RivalRace { raceId: string; at: number; mode: 'ranked' | 'friend'; me: number; them: number | null; point: 'me' | 'them' | null }
/** A ranked race of the week before the player knew its rival (the human field is kept until the next sync). */
export interface PendingRivalRace { raceId: string; at: number; me: number; field: { playerId: string; place: number }[] }
export interface RivalWeek {
  weekId: string;
  assignment: RivalAssign | null;
  me: number; them: number;
  races: RivalRace[];
  pending: PendingRivalRace[];
  rankedRaces: number;
  /** Own best time-attack time (ms) per course this week, and the rival's as last seen in the registry. */
  ta: Record<string, number>;
  rivalTa: Record<string, number>;
}
export type RivalResultOutcome = RivalOutcome | 'not_enough';
export interface RivalResult {
  /** rivalName: the human rival's display name (player text, never translated); cpuId for a CPU week. */
  weekId: string; outcome: RivalResultOutcome; kind: 'human' | 'cpu'; rivalName: string | null; cpuId?: string;
  me: number; them: number; taMe: number; taThem: number; freeCoins: number; settledAt: number; newTitles: string[];
}
export interface RivalState {
  optOut: boolean;
  /** Unsettled weeks (the current one last); a week is settled at the first sync after it ended. */
  weeks: RivalWeek[];
  results: RivalResult[];
  /** weekId of a result the week-result sheet has not shown yet. */
  unseen: string | null;
  weeksWon: number; weeksPlayed: number;
  viewDay?: string;
  challenges?: { day: string; count: number };
  /** Game day of the last 「ライバルが記録を更新」 push (REQ-RIVAL-013). */
  pushDay?: string;
}

export function ensureRival(s: PlayerState): RivalState {
  s.rival ??= { optOut: false, weeks: [], results: [], unseen: null, weeksWon: 0, weeksPlayed: 0 };
  return s.rival;
}

const newWeek = (weekId: string): RivalWeek => ({ weekId, assignment: null, me: 0, them: 0, races: [], pending: [], rankedRaces: 0, ta: {}, rivalTa: {} });

/** The current week's record (created; older unsettled weeks are kept, at most RIVAL_HARD_LIMITS.weeksKept). */
export function currentWeek(m: Master, s: PlayerState, now: number): RivalWeek {
  const r = ensureRival(s);
  const id = weekIdAt(m, now);
  let w = r.weeks.find((x) => x.weekId === id);
  if (!w) {
    w = newWeek(id);
    r.weeks.push(w);
    r.weeks.sort((a, b) => (a.weekId < b.weekId ? -1 : 1));
    // a player who never syncs: the oldest unsettled weeks are dropped without a result (no rival was ever known)
    if (r.weeks.length > RIVAL_HARD_LIMITS.weeksKept) r.weeks.splice(0, r.weeks.length - RIVAL_HARD_LIMITS.weeksKept);
  }
  return w;
}

const cpuDef = (c: RivalConfig, id: string) => c.cpuRivals.find((x) => x.id === id) ?? null;
const live = (a: RivalAssign | null, at: number) => a?.kind === 'cpu' || (a?.kind === 'human' && (a.dissolvedAt === null || at < a.dissolvedAt));

function trim(m: Master, w: RivalWeek) {
  const keep = rivalConfig(m)?.recentKeep ?? 10;
  if (w.races.length > keep) w.races.splice(0, w.races.length - keep);
}

/** Counts one ranked race against the week's known rival (REQ-RIVAL-004). */
function countRanked(m: Master, w: RivalWeek, p: PendingRivalRace, emit?: (e: KpiEvent) => void) {
  const c = rivalConfig(m);
  const a = w.assignment;
  if (!c || !a || !live(a, p.at)) return;
  let them: number | null = null;
  if (a.kind === 'human') {
    them = p.field.find((f) => f.playerId === a.rivalId)?.place ?? null;
    if (them === null) return; // the rival was not in this race
  }
  const target = a.kind === 'cpu' ? cpuDef(c, a.cpuId)?.targetPlace ?? 6 : null;
  const mine = a.kind === 'human' ? p.me < them! : p.me <= target!;
  if (mine) w.me++; else w.them++;
  w.races.push({ raceId: p.raceId, at: p.at, mode: 'ranked', me: p.me, them, point: mine ? 'me' : 'them' });
  trim(m, w);
  emit?.({ name: 'rival_race', s1: a.kind, s2: mine ? 'me' : 'them', place: p.me, value: them ?? target! });
}

/**
 * REQ-RIVAL-004: a settled race (called from PlayerService.applyRace). Ranked: counted against the rival when the week's
 * assignment is known, else kept with its human field until the next sync. Friend (ライバルと走る): shown, never scored.
 */
export function noteRivalRace(m: Master, s: PlayerState, r: RaceResultForPlayer, now: number, emit: (e: KpiEvent) => void) {
  if (!rivalConfig(m) || r.void || s.rival?.optOut) return;
  if (r.mode !== 'ranked' && r.mode !== 'friend') return;
  const w = currentWeek(m, s, now);
  const field = (r.field ?? []).filter((f) => f.playerId !== s.id);
  if (r.mode === 'friend') {
    const a = w.assignment;
    const them = a?.kind === 'human' && live(a, now) ? field.find((f) => f.playerId === a.rivalId)?.place ?? null : null;
    if (them === null) return;
    w.races.push({ raceId: r.raceId, at: now, mode: 'friend', me: r.place, them, point: null });
    trim(m, w);
    emit({ name: 'rival_race', s1: 'challenge', s2: r.place < them ? 'me' : 'them', place: r.place, value: them });
    return;
  }
  w.rankedRaces++;
  const p: PendingRivalRace = { raceId: r.raceId, at: now, me: r.place, field };
  if (w.assignment) countRanked(m, w, p, emit);
  else if (w.pending.length < 60) w.pending.push(p); // bounded; a player who races 60+ times before syncing loses the rest
}

/** REQ-RIVAL-005: a verified time-attack run of this week. Returns true when it is a new weekly best for the course. */
export function noteRivalTa(m: Master, s: PlayerState, trackId: string, timeMs: number, now: number): boolean {
  if (!rivalConfig(m) || s.rival?.optOut) return false;
  const w = currentWeek(m, s, now);
  const prev = w.ta[trackId];
  if (prev !== undefined && prev <= timeMs) return false;
  w.ta[trackId] = timeMs;
  return true;
}

// ------------------------------------------------------------------------------------------------ registry sync & settlement

/** What the registry answers for one player and week (do/rivalStore.ts, MemoryRivalRegistry). */
export interface RegistryWeek {
  weekId: string;
  assignment: RivalAssign;
  /** Week bests (ms per course) both sides reported to the registry. */
  ta: { me: Record<string, number>; rival: Record<string, number> };
}

function applyRegistry(m: Master, w: RivalWeek, d: RegistryWeek, emit: (e: KpiEvent) => void) {
  const a = d.assignment;
  const cur = w.assignment;
  if (!cur || cur.kind !== a.kind || (a.kind === 'human' && cur.kind === 'human' && cur.rivalId !== a.rivalId) || (a.kind === 'cpu' && cur.kind === 'cpu' && cur.cpuId !== a.cpuId)) {
    // first sight of the week's rival (or the registry's answer replaces a local guess): recount from scratch
    w.assignment = { ...a };
    const all = [...w.pending];
    w.pending = [];
    w.me = 0; w.them = 0; w.races = w.races.filter((x) => x.mode === 'friend');
    for (const p of all) countRanked(m, w, p, emit);
  } else if (a.kind === 'human' && cur.kind === 'human') {
    // the registry's dissolution wins; a local one (I blocked) is kept until the registry has it too
    if (a.dissolvedAt !== null && (cur.dissolvedAt === null || a.dissolvedAt < cur.dissolvedAt)) cur.dissolvedAt = a.dissolvedAt;
    // a deleted / withdrawn rival's card is dropped (null); after my own block I keep none either
    cur.card = a.card === null || cur.dissolvedBy === 'me' ? null : a.card;
  }
  w.rivalTa = { ...d.ta.rival };
}

function taCompare(m: Master, w: RivalWeek): { taMe: number; taThem: number } {
  const theirs = rivalTaOf(m, w);
  let taMe = 0, taThem = 0;
  for (const [t, ms] of Object.entries(w.ta)) {
    const o = theirs[t];
    if (o === undefined) continue;
    if (ms < o) taMe++; else if (o < ms) taThem++;
  }
  return { taMe, taThem };
}

/** The rival's time-attack bests: the registry's copy, or the CPU's medal times on the courses I ran. */
export function rivalTaOf(m: Master, w: RivalWeek): Record<string, number> {
  const c = rivalConfig(m);
  const a = w.assignment;
  if (a?.kind === 'human') return a.dissolvedAt === null ? w.rivalTa : {};
  if (a?.kind !== 'cpu' || !c) return {};
  const medal = cpuDef(c, a.cpuId)?.taMedal ?? 'silver';
  const out: Record<string, number> = {};
  for (const ms of m.progression.timeAttack.milestones) {
    if (ms.trackId && ms.maxTimeMs !== null && ms.id.endsWith(`_${medal}`) && w.ta[ms.trackId] !== undefined) out[ms.trackId] = ms.maxTimeMs;
  }
  return out;
}


/** REQ-RIVAL-006/007: one ended week → result, fixed reward, counters, titles. Idempotent (the week is removed). */
function settleWeek(m: Master, s: PlayerState, w: RivalWeek, now: number, emit: (e: KpiEvent) => void): RivalResult | null {
  const c = rivalConfig(m)!;
  const r = ensureRival(s);
  if (r.results.some((x) => x.weekId === w.weekId)) return null;
  const a = w.assignment;
  if (!a) return null; // the rival was never known (no sync while the registry had it): no result
  const dissolved = a.kind === 'human' && a.dissolvedAt !== null;
  const { taMe, taThem } = dissolved ? { taMe: 0, taThem: 0 } : taCompare(m, w);
  let outcome: RivalResultOutcome = dissolved ? 'no_contest'
    : w.me !== w.them ? (w.me > w.them ? 'win' : 'lose')
      : taMe !== taThem ? (taMe > taThem ? 'win' : 'lose') : 'draw';
  if (w.rankedRaces < c.minRacesForResult) outcome = 'not_enough';
  const freeCoins = outcome === 'not_enough' ? 0 : c.rewards[outcome].freeCoins;
  // REQ-RIVAL-007: free coins only, fixed by the result; nothing while the account is being deleted
  const paid = freeCoins > 0 && !deletionScheduled(s) ? freeCoins : 0;
  if (paid > 0) grantFree(s, paid, now, `rival week ${w.weekId} ${outcome}`, `rival:${w.weekId}`);
  if (outcome !== 'not_enough') r.weeksPlayed++;
  if (outcome === 'win') r.weeksWon++;
  const newTitles = outcome === 'win' ? evaluateTitles(m, s) : [];
  const res: RivalResult = {
    weekId: w.weekId, outcome, kind: a.kind, rivalName: a.kind === 'human' ? a.card?.displayName ?? null : null, ...(a.kind === 'cpu' ? { cpuId: a.cpuId } : {}), me: w.me, them: w.them, taMe, taThem, freeCoins: paid, settledAt: now, newTitles };
  r.results.push(res);
  if (r.results.length > RIVAL_HARD_LIMITS.resultsKept) r.results.splice(0, r.results.length - RIVAL_HARD_LIMITS.resultsKept);
  r.unseen = w.weekId;
  recordActivity(m, s, { kind: 'rival_week', source: `rival_week:${w.weekId}`, vars: { outcome } }, now); // REQ-ACT-002
  emit({ name: 'rival_week_result', s1: outcome, s2: a.kind, s3: w.weekId, count: w.me, value: w.them, freeCoins: paid, place: w.rankedRaces });
  return res;
}

/**
 * REQ-RIVAL-006: the sync step (GET /v1/rival): apply what the registry answered for each unsettled week, settle every
 * week that has ended, emit rival_view once per game day. `data` comes from the server-side RivalService, never a client.
 */
export function rivalSync(m: Master, s: PlayerState, now: number, data: Record<string, RegistryWeek | null>, emit: (e: KpiEvent) => void, quiet = false) {
  const c = rivalConfig(m);
  if (!c) return;
  const r = ensureRival(s);
  if (r.optOut) { r.weeks = []; return; }
  const cur = currentWeek(m, s, now);
  for (const w of r.weeks) { const d = data[w.weekId]; if (d) applyRegistry(m, w, d, emit); }
  for (const w of [...r.weeks]) {
    if (w.weekId >= cur.weekId) continue;
    // a human week settles only on a fresh registry answer (dissolution, final time-attack bests); a CPU week needs none.
    // A week whose rival is not known yet (registry down) waits for the next sync instead of being dropped.
    if (!w.assignment || (w.assignment.kind === 'human' && !data[w.weekId])) continue;
    settleWeek(m, s, w, now, emit);
    r.weeks = r.weeks.filter((x) => x !== w);
  }
  const day = gameDayKey(now, dayRule(m));
  if (!quiet && !sameGameDay(r.viewDay, day)) {
    r.viewDay = day;
    emit({ name: 'rival_view', s1: cur.assignment?.kind ?? 'none', count: cur.me, value: cur.them });
  }
}

/** Weeks the sync needs from the registry (unsettled ones, the current one included). */
export function weeksToSync(m: Master, s: PlayerState, now: number): string[] {
  if (!rivalConfig(m) || s.rival?.optOut) return [];
  const cur = weekIdAt(m, now);
  return [...new Set([...(s.rival?.weeks ?? []).map((w) => w.weekId), cur])].filter((w) => w <= cur).sort();
}

// ------------------------------------------------------------------------------------------------ player actions

/** REQ-RIVAL-011: opt out (dissolves this week's pair, no new rival) / back in. */
export function rivalSetOptOut(m: Master, s: PlayerState, optOut: boolean) {
  if (!rivalConfig(m)) throw new AppError('NOT_FOUND', 'rivals are not available');
  const r = ensureRival(s);
  r.optOut = optOut;
  if (optOut) r.weeks = []; // the open week is dropped without a result
  return { optOut };
}

/** REQ-RIVAL-011: block this week's human rival — the shared block list (team-feed mute) and the pair is dissolved. */
export function rivalBlock(m: Master, s: PlayerState, now: number) {
  if (!rivalConfig(m)) throw new AppError('NOT_FOUND', 'rivals are not available');
  const w = currentWeek(m, s, now);
  const a = w.assignment;
  if (a?.kind !== 'human') throw new AppError('NOT_ELIGIBLE', 'no human rival this week');
  playerMute(m, s, a.rivalId, true);
  if (a.dissolvedAt === null) { a.dissolvedAt = now; a.dissolvedBy = 'me'; }
  a.card = null;
  return { blocked: a.rivalId, dissolved: true };
}

/** REQ-RIVAL-008: ライバルと走る — the sender side (rival known, live, under the daily cap). Returns the rival id. */
export function rivalChallengeCheck(m: Master, s: PlayerState, now: number): string {
  const c = rivalConfig(m);
  if (!c) throw new AppError('NOT_FOUND', 'rivals are not available');
  if (deletionScheduled(s)) throw new AppError('DELETION_PENDING', 'the account is scheduled for deletion');
  const w = currentWeek(m, s, now);
  const a = w.assignment;
  if (a?.kind !== 'human' || !live(a, now)) throw new AppError('NOT_ELIGIBLE', 'no human rival to challenge this week');
  const r = ensureRival(s);
  const day = gameDayKey(now, dayRule(m));
  if (!r.challenges || !sameGameDay(r.challenges.day, day)) r.challenges = { day, count: 0 };
  if (r.challenges.count >= c.challengesPerDay) throw new AppError('RIVAL_CHALLENGE_LIMIT', `at most ${c.challengesPerDay} challenges per day`);
  r.challenges.count++;
  return a.rivalId;
}

/** REQ-RIVAL-008: the receiver side — only from this week's live rival, never from a blocked player. */
export function rivalChallengeReceive(m: Master, s: PlayerState, fromId: string, passphrase: string, now: number) {
  const c = rivalConfig(m);
  if (!c || s.rival?.optOut) throw new AppError('NOT_ELIGIBLE', 'rivals are off');
  if (ensureFeed(s).muted.includes(fromId)) throw new AppError('NOT_ELIGIBLE', 'blocked');
  const w = currentWeek(m, s, now);
  const a = w.assignment;
  if (a?.kind !== 'human' || a.rivalId !== fromId || !live(a, now)) throw new AppError('NOT_ELIGIBLE', 'not your rival this week');
  s.friends.invites = s.friends.invites.filter((x) => !(x.from === fromId && x.passphrase === passphrase));
  s.friends.invites.push({ from: fromId, passphrase, at: now });
  const max = m.progression.social.maxInvites;
  if (s.friends.invites.length > max) s.friends.invites.splice(0, s.friends.invites.length - max);
  return { ok: true };
}

export function rivalSeen(s: PlayerState, weekId: string) {
  const r = ensureRival(s);
  if (r.unseen === weekId) r.unseen = null;
  return { unseen: r.unseen };
}

// ------------------------------------------------------------------------------------------------ outbound (registry updates after a transaction)

export interface RivalOutbound { displayName: string; weekId: string; regKey: string; entry: RivalEntry | null; withdraw: boolean; dissolveMine: boolean; ta: Record<string, number> }

/** What this player's state says the registry should know (compared before / after each transaction). */
export function rivalOutbound(m: Master, s: PlayerState, now: number): RivalOutbound | null {
  if (!rivalConfig(m)) return null;
  const weekId = weekIdAt(m, now);
  const w = s.rival?.weeks.find((x) => x.weekId === weekId);
  const withdraw = rivalWithdrawn(s, now);
  // quarantined players (REQ-OPS-032, matched only with each other) are not offered as anyone's rival
  const raced = !withdraw && !!w && w.rankedRaces > 0 && moderationOf(s, now) !== 'quarantined';
  const card = raced ? rivalCard(m, s) : null;
  const blocked = [...ensureFeedPeek(s)];
  const regKey = withdraw ? 'withdraw' : raced ? JSON.stringify([s.season.classId, Math.round(s.rating.r), blocked, card]) : '';
  return {
    displayName: s.profile.displayName, weekId, regKey, withdraw,
    entry: raced ? { playerId: s.id, classId: s.season.classId, rating: Math.round(s.rating.r), rankedAt: now, blocked, card: card!, updatedAt: now } : null,
    dissolveMine: w?.assignment?.kind === 'human' && w.assignment.dissolvedBy === 'me',
    ta: { ...(w?.ta ?? {}) },
  };
}
const ensureFeedPeek = (s: PlayerState): string[] => (s as PlayerState & { teamFeed?: { muted: string[] } }).teamFeed?.muted ?? [];

export interface RivalUpdate { playerId: string; displayName: string; weekId: string; entry?: RivalEntry; withdraw?: true; dissolve?: true; ta?: { trackId: string; timeMs: number }[] }

/** The registry update a transaction produced (null = nothing changed). */
export function rivalUpdateOf(playerId: string, before: RivalOutbound | null, after: RivalOutbound | null): RivalUpdate | null {
  if (!after) return null;
  const same = before && before.weekId === after.weekId;
  const u: RivalUpdate = { playerId, displayName: after.displayName, weekId: after.weekId };
  if (!same || before!.regKey !== after.regKey) {
    if (after.withdraw) u.withdraw = true;
    else if (after.entry) u.entry = after.entry;
  }
  if (after.dissolveMine && !(same && before!.dissolveMine)) u.dissolve = true;
  const ta = Object.entries(after.ta).filter(([t, ms]) => !same || before!.ta[t] === undefined || ms < before!.ta[t]!).map(([trackId, timeMs]) => ({ trackId, timeMs }));
  if (ta.length) u.ta = ta;
  return u.entry || u.withdraw || u.dissolve || u.ta ? u : null;
}

// ------------------------------------------------------------------------------------------------ view

/** REQ-RIVAL-009: GET /v1/rival (after the sync). */
export function rivalView(m: Master, s: PlayerState, now: number) {
  const c = rivalConfig(m);
  if (!c) return { enabled: false as const };
  const r = ensureRival(s);
  const rules = { rankedOnly: true, challengeUnranked: true, fixedRewards: true, noStreakRewards: true, taBreaksTies: true };
  const rewards = { win: c.rewards.win.freeCoins, draw: c.rewards.draw.freeCoins, lose: c.rewards.lose.freeCoins, noContest: c.rewards.no_contest.freeCoins, minRaces: c.minRacesForResult };
  const titles = m.titles.filter((t) => (t.condition as { kind: string }).kind === 'rivalWeeksWon')
    .map((t) => ({ titleId: t.id, name: t.name, weeksWon: (t.condition as unknown as { value: number }).value, unlocked: s.titles.includes(t.id) }))
    .sort((a, b) => a.weeksWon - b.weeksWon);
  const record = { weeksWon: r.weeksWon, weeksPlayed: r.weeksPlayed, titles, nextTitle: titles.find((t) => !t.unlocked) ?? null };
  // results: the human's name as stored (player text), the CPU's name from the config (translated in English)
  const shown = (x: RivalResult) => ({ ...x, rivalName: x.kind === 'human' ? x.rivalName : null, cpuName: x.kind === 'cpu' && x.cpuId ? cpuDef(c, x.cpuId)?.name ?? null : null });
  const unseen = r.unseen ? r.results.find((x) => x.weekId === r.unseen) ?? null : null;
  const result = unseen ? shown(unseen) : null;
  const history = r.results.slice().reverse().map(shown);
  const weekId = weekIdAt(m, now);
  if (r.optOut) return { enabled: true as const, optOut: true, weekId, weekEndsAt: weekEndMs(m, weekId), rival: null, score: null, recent: [], timeAttack: [], result, history, record, rewards, challenge: null, rules };
  const w = r.weeks.find((x) => x.weekId === weekId) ?? newWeek(weekId);
  const a = w.assignment;
  let rival: unknown = null;
  if (a?.kind === 'cpu') {
    const d = cpuDef(c, a.cpuId);
    rival = d ? { kind: 'cpu', cpuId: d.id, name: d.name, personality: d.personality, line: d.line, style: d.style, targetPlace: d.targetPlace, taMedal: d.taMedal } : null;
  } else if (a?.kind === 'human') {
    rival = { kind: 'human', playerId: a.dissolvedAt === null ? a.rivalId : null, card: a.dissolvedAt === null ? a.card : null, dissolved: a.dissolvedAt !== null };
  }
  const theirs = rivalTaOf(m, w);
  const tracks = [...new Set([...Object.keys(w.ta), ...Object.keys(theirs)])].sort();
  const timeAttack = tracks.map((t) => {
    const me = w.ta[t] ?? null, them = theirs[t] ?? null;
    return { trackId: t, trackName: rivalTrackName(t), me, rival: them, faster: me !== null && them !== null ? (me < them ? 'me' : them < me ? 'rival' : null) : null };
  });
  const day = gameDayKey(now, dayRule(m));
  const used = r.challenges && sameGameDay(r.challenges.day, day) ? r.challenges.count : 0;
  const canChallenge = a?.kind === 'human' && live(a, now);
  return {
    enabled: true as const, optOut: false, weekId, weekEndsAt: weekEndMs(m, weekId),
    rival, score: { me: w.me, them: w.them, rankedRaces: w.rankedRaces, minRaces: c.minRacesForResult, ...taCompare(m, w) },
    recent: w.races.slice().reverse(), timeAttack, result, history, record, rewards,
    challenge: canChallenge ? { left: Math.max(0, c.challengesPerDay - used), perDay: c.challengesPerDay } : null,
    rules,
  };
}
