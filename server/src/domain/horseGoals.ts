/**
 * REQ-HGOAL-001..016: 馬ごとの目標 (per-horse goals, contracts/protocol.md §53).
 *
 * Each horse gets a short chain of goals that tells its story (first win → 10 races → wins on its surface → a time-attack
 * record on its course → a win outside its distance → top-3 in ranked → a tournament title). The chain is a pure function
 * of the horse's aptitudes (surface, distance range, running style, whether it has a unique skill) and the course list:
 * no randomness, no time, no rarity, no stats, nothing purchasable. Shared with C# HorseGoalChain through
 * contracts/horse-goals.vectors.json.
 *
 * Progress comes only from the §34 career record (hallOfFame.ts noteHallRace / noteHallTa / noteHallTournament, behind
 * their once-per-race / session / tournament guards) plus three tallies written in the same place (career.goal). Nothing
 * here moves coins, materials, items or stats: the reward is a ribbon (chainComplete) and the hall plaque's flair.
 */
import { AppError } from './errors.js';
import type { Master } from './master.js';
import type { PlayerState } from './player.js';
import type { CareerRecord } from './hallOfFame.js';
import type { KpiEvent } from './kpi.js';
import { rivalTrackName } from './rival.js';
import { horseSkillId } from './skills.js';

// ------------------------------------------------------------------------------------------- the chain (pure, shared)

export const HGOAL_VERSION = 1 as const;
export const HGOAL_KINDS = ['first_win', 'races', 'surface_win', 'ta_course', 'stretch_win', 'wins', 'ranked_top3', 'tournament_win'] as const;
export type HorseGoalKind = (typeof HGOAL_KINDS)[number];
/** The `need` of each counted goal (version 1; the vectors pin them). */
export const HGOAL_TARGETS = { races: 10, surfaceWins: 3, skillWins: 5, rankedTop3: 5 } as const;
/** §44.3's distance bands (the same limits as roster.ts DISTANCE_BANDS; kept here so hallOfFame.ts can import it without a cycle). */
export const HGOAL_BANDS = { sprint: [0, 1400], mile: [1401, 1800], intermediate: [1801, 2400], long: [2401, 99_999] } as const;
export type GoalBand = keyof typeof HGOAL_BANDS;
const BAND_ORDER: GoalBand[] = ['sprint', 'mile', 'intermediate', 'long'];

export const bandOf = (distanceM: number): GoalBand => BAND_ORDER.find((b) => distanceM <= HGOAL_BANDS[b][1]) ?? 'long';

export interface HorseGoalHorse { surface: 'turf' | 'dirt' | 'both'; distMinM: number; distMaxM: number; style: string; skillId: string | null }
export interface HorseGoalTrack { id: string; name: string; surface: 'turf' | 'dirt'; distanceM: number }
export interface HorseGoalDef { id: string; kind: HorseGoalKind; need: number; params: Record<string, string | number>; text: string }

const BAND_TEXT: Record<GoalBand, string> = {
  sprint: '短距離（1400m以下）で勝つ', mile: 'マイル（1401〜1800m）で勝つ', intermediate: '中距離（1801〜2400m）で勝つ', long: '長距離（2401m以上）で勝つ',
};
const SHORT_SIDE = new Set(['nige', 'senko']);

const runs = (h: HorseGoalHorse, t: HorseGoalTrack) => h.surface === 'both' || h.surface === t.surface;
const gapOf = (h: HorseGoalHorse, d: number) => (d < h.distMinM ? h.distMinM - d : d > h.distMaxM ? d - h.distMaxM : 0);
const idCmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The surface a horse is "best" on: its own, or for `both` the one with more courses inside its range (tie → turf). */
export function bestSurface(h: HorseGoalHorse, tracks: readonly HorseGoalTrack[]): 'turf' | 'dirt' {
  if (h.surface !== 'both') return h.surface;
  const n = (s: 'turf' | 'dirt') => tracks.filter((t) => t.surface === s && gapOf(h, t.distanceM) === 0).length;
  return n('dirt') > n('turf') ? 'dirt' : 'turf';
}

/** The time-attack course: runnable surface, smallest distance gap → closest to the middle of the range → course id. */
export function goalCourse(h: HorseGoalHorse, tracks: readonly HorseGoalTrack[]): HorseGoalTrack | null {
  const mid2 = h.distMinM + h.distMaxM; // twice the middle (integers only)
  return tracks.filter((t) => runs(h, t)).slice().sort((a, b) =>
    gapOf(h, a.distanceM) - gapOf(h, b.distanceM) || Math.abs(2 * a.distanceM - mid2) - Math.abs(2 * b.distanceM - mid2) || idCmp(a.id, b.id))[0] ?? null;
}

/** The band outside the horse's range it should stretch to (front runners shorter, closers longer; null = none possible). */
export function stretchBand(h: HorseGoalHorse, tracks: readonly HorseGoalTrack[]): GoalBand | null {
  const outside = (b: GoalBand) => HGOAL_BANDS[b][1] < h.distMinM || HGOAL_BANDS[b][0] > h.distMaxM;
  const possible = (b: GoalBand) => outside(b) && tracks.some((t) => runs(h, t) && bandOf(t.distanceM) === b);
  const below = BAND_ORDER.filter((b) => HGOAL_BANDS[b][1] < h.distMinM).reverse(); // nearest first
  const above = BAND_ORDER.filter((b) => HGOAL_BANDS[b][0] > h.distMaxM);
  const order = SHORT_SIDE.has(h.style) ? [...below, ...above] : [...above, ...below];
  return order.find(possible) ?? null;
}

/** REQ-HGOAL-001/002: the chain, in story order (6..8 goals). Pure: the same horse and courses give the same chain. */
export function horseGoalChain(h: HorseGoalHorse, tracks: readonly HorseGoalTrack[]): HorseGoalDef[] {
  const T = HGOAL_TARGETS;
  const out: HorseGoalDef[] = [
    { id: 'first_win', kind: 'first_win', need: 1, params: {}, text: '初勝利をあげる' },
    { id: `races:${T.races}`, kind: 'races', need: T.races, params: { n: T.races }, text: `${T.races}戦を走る` },
  ];
  const surface = bestSurface(h, tracks);
  out.push({ id: `surface_win:${surface}`, kind: 'surface_win', need: T.surfaceWins, params: { surface, n: T.surfaceWins }, text: `${surface === 'turf' ? '芝' : 'ダート'}で${T.surfaceWins}勝する` });
  const course = goalCourse(h, tracks);
  if (course) out.push({ id: `ta_course:${course.id}`, kind: 'ta_course', need: 1, params: { trackId: course.id, course: course.name }, text: `タイムアタック ${course.name} で記録を残す` });
  const band = stretchBand(h, tracks);
  if (band) out.push({ id: `stretch_win:${band}`, kind: 'stretch_win', need: 1, params: { band }, text: BAND_TEXT[band] });
  if (h.skillId) out.push({ id: `wins:${T.skillWins}`, kind: 'wins', need: T.skillWins, params: { n: T.skillWins }, text: `${T.skillWins}勝する` });
  out.push({ id: `ranked_top3:${T.rankedTop3}`, kind: 'ranked_top3', need: T.rankedTop3, params: { n: T.rankedTop3 }, text: `ランク戦で3着以内に${T.rankedTop3}回入る` });
  out.push({ id: 'tournament_win', kind: 'tournament_win', need: 1, params: {}, text: '大会で優勝する' });
  return out;
}

/** What the goals count (a plain view of the §34 career record and its goal tallies). */
export interface HorseGoalRecord {
  races: number; wins: number; tournamentWins: number;
  /** Courses with a verified time-attack record. */
  taTracks: string[];
  surfaceWins: { turf: number; dirt: number };
  bandWins: Record<GoalBand, number>;
  rankedPlaces: number;
}
export const emptyGoalRecord = (): HorseGoalRecord => ({ races: 0, wins: 0, tournamentWins: 0, taTracks: [], surfaceWins: { turf: 0, dirt: 0 }, bandWins: { sprint: 0, mile: 0, intermediate: 0, long: 0 }, rankedPlaces: 0 });

/** The counted value of one goal (before capping at need). */
export function goalValue(d: HorseGoalDef, r: HorseGoalRecord): number {
  switch (d.kind) {
    case 'first_win': case 'wins': return r.wins;
    case 'races': return r.races;
    case 'surface_win': return r.surfaceWins[d.params.surface as 'turf' | 'dirt'] ?? 0;
    case 'ta_course': return r.taTracks.includes(String(d.params.trackId)) ? 1 : 0;
    case 'stretch_win': return r.bandWins[d.params.band as GoalBand] ?? 0;
    case 'ranked_top3': return r.rankedPlaces;
    case 'tournament_win': return r.tournamentWins;
  }
}

export interface HorseGoal extends HorseGoalDef { have: number; done: boolean; completedAt: number | null; current: boolean }

/** REQ-HGOAL-003: progress of every goal; `stamped` = completion times already recorded. Pure. */
export function evaluateHorseGoals(chain: readonly HorseGoalDef[], r: HorseGoalRecord, stamped: Readonly<Record<string, number>> = {}): HorseGoal[] {
  const goals = chain.map((d) => {
    const have = Math.min(d.need, Math.max(0, goalValue(d, r)));
    const at = stamped[d.id];
    return { ...d, params: { ...d.params }, have, done: at !== undefined || have >= d.need, completedAt: at ?? null, current: false };
  });
  const cur = goals.find((g) => !g.done);
  if (cur) cur.current = true;
  return goals;
}

// ------------------------------------------------------------------------------------------- config

export interface HorseGoalsConfig { enabled: boolean }
export const horseGoalsConfig = (m: Master): HorseGoalsConfig | null => {
  const c = m.progression.horseGoals;
  return c && c.enabled && m.progression.hall?.enabled ? c : null;
};
/** REQ-HGOAL-015: boot and every remote-config version. */
export function horseGoalsProblems(m: Pick<Master, 'progression'>): string[] {
  const c = (m.progression as { horseGoals?: unknown }).horseGoals as Record<string, unknown> | undefined;
  if (c === undefined) return [];
  const p: string[] = [];
  if (typeof c !== 'object' || c === null) return ['horseGoals must be an object'];
  for (const k of Object.keys(c)) if (k !== 'enabled' && k !== '_note') p.push(`horseGoals.${k} is not a known key`);
  if (typeof c.enabled !== 'boolean') p.push('horseGoals.enabled must be a boolean');
  if (c.enabled === true && !m.progression.hall?.enabled) p.push('horseGoals.enabled needs progression.hall enabled (goals count the career record)');
  return p;
}

// ------------------------------------------------------------------------------------------- state

export interface HorseGoalsState {
  v: 1;
  /** horseId → goal id → completion time (written once, REQ-HGOAL-005). */
  done: Record<string, Record<string, number>>;
  /** The horse whose goal is pinned to the home (REQ-HGOAL-007). */
  pinned: string | null;
}
export function ensureHorseGoals(s: PlayerState): HorseGoalsState {
  s.horseGoals ??= { v: 1, done: {}, pinned: null };
  return s.horseGoals;
}

/** The course list the chain reads (master tracks with their display names, tracks.json). */
export const goalTracks = (m: Master): HorseGoalTrack[] => m.tracks.map((t) => ({ id: t.id, name: rivalTrackName(t.id), surface: t.surface, distanceM: t.distanceM }));

/** The goal record of a horse from its §34 career (absent = nothing counted yet). */
export function goalRecordOf(c: CareerRecord | undefined): HorseGoalRecord {
  if (!c) return emptyGoalRecord();
  const g = c.goal;
  return {
    races: c.races, wins: c.wins, tournamentWins: c.tournamentWins, taTracks: Object.keys(c.bestTa).sort(),
    surfaceWins: { turf: g?.surfaceWins.turf ?? 0, dirt: g?.surfaceWins.dirt ?? 0 },
    bandWins: { sprint: g?.bandWins.sprint ?? 0, mile: g?.bandWins.mile ?? 0, intermediate: g?.bandWins.intermediate ?? 0, long: g?.bandWins.long ?? 0 },
    rankedPlaces: g?.rankedPlaces ?? 0,
  };
}

type Horse = PlayerState['horses'][number];
/** The horse as the chain sees it; the skill is the one it races with (skills.ts horseSkillId: its own, or its template's). */
const goalHorse = (m: Master, h: Horse): HorseGoalHorse => ({ surface: h.surface, distMinM: h.distMinM, distMaxM: h.distMaxM, style: h.style, skillId: horseSkillId(m, h) });

/** The evaluated chain of one owned horse. */
export function goalsOf(m: Master, s: PlayerState, h: Horse): HorseGoal[] {
  return evaluateHorseGoals(horseGoalChain(goalHorse(m, h), goalTracks(m)), goalRecordOf(s.hall?.careers[h.id]), s.horseGoals?.done[h.id] ?? {});
}

/** REQ-HGOAL-009: every goal of the horse is done (the ribbon). */
export function chainCompleteOf(m: Master, s: PlayerState, horseId: string): boolean {
  if (!horseGoalsConfig(m)) return false;
  const h = s.horses.find((x) => x.id === horseId);
  return !!h && goalsOf(m, s, h).every((g) => g.done);
}

/**
 * REQ-HGOAL-005: called right after a counted result (race / time attack / tournament) for that horse. Records the
 * completion time of every goal newly met (once each) and sends hgoal_complete once per goal.
 */
export function noteHorseGoals(m: Master, s: PlayerState, horseId: string | null | undefined, now: number, emit?: (e: KpiEvent) => void) {
  if (!horseGoalsConfig(m) || !horseId) return;
  const h = s.horses.find((x) => x.id === horseId);
  if (!h) return;
  const goals = goalsOf(m, s, h);
  const fresh = goals.filter((g) => g.done && g.completedAt === null);
  if (fresh.length === 0) return;
  const st = ensureHorseGoals(s);
  const rec = (st.done[horseId] ??= {});
  let count = Object.keys(rec).filter((id) => goals.some((g) => g.id === id)).length;
  for (const g of fresh) {
    rec[g.id] = now;
    count += 1;
    emit?.({ name: 'hgoal_complete', s1: g.kind, s2: count === goals.length ? 'chain' : '', count });
  }
}

// ------------------------------------------------------------------------------------------- views

export const HGOAL_NOTICE = '目標は確定したレースの成績だけで進みます。達成の印は見た目だけです。';

function requireCfg(m: Master) {
  const c = horseGoalsConfig(m);
  if (!c) throw new AppError('NOT_FOUND', 'horse goals are not available');
  return c;
}

const chainCompletedAt = (goals: HorseGoal[]) =>
  goals.every((g) => g.done) && goals.every((g) => g.completedAt !== null) ? Math.max(...goals.map((g) => g.completedAt!)) : null;

/** The pinned horse when it still qualifies (owned, active, not complete); otherwise null (REQ-HGOAL-007). */
function pinnedHorse(m: Master, s: PlayerState): { h: Horse; goals: HorseGoal[] } | null {
  const id = s.horseGoals?.pinned;
  if (!id) return null;
  const h = s.horses.find((x) => x.id === id);
  if (!h || h.status !== 'active') return null;
  const goals = goalsOf(m, s, h);
  return goals.some((g) => !g.done) ? { h, goals } : null;
}

/** REQ-HGOAL-010: GET /v1/horses/:horseId/goals. */
export function horseGoalsView(m: Master, s: PlayerState, horseId: string) {
  requireCfg(m);
  const h = s.horses.find((x) => x.id === horseId);
  if (!h) throw new AppError('HORSE_NOT_FOUND', horseId);
  const goals = goalsOf(m, s, h);
  const doneCount = goals.filter((g) => g.done).length;
  const complete = doneCount === goals.length;
  return {
    v: HGOAL_VERSION, horseId, horseName: h.name, status: h.status, pinned: pinnedHorse(m, s)?.h.id === horseId,
    goals, doneCount, total: goals.length, chainComplete: complete, chainCompletedAt: complete ? chainCompletedAt(goals) : null, notice: HGOAL_NOTICE,
  };
}
export type HorseGoalsView = ReturnType<typeof horseGoalsView>;

export interface HorseGoalPin { horseId: string; horseName: string; goal: HorseGoal; doneCount: number; total: number }
/** REQ-HGOAL-007/010: the home's pinned goal (bootstrap `horseGoalPin`, GET /v1/horse-goals/pinned). Never throws. */
export function pinnedGoalView(m: Master, s: PlayerState): HorseGoalPin | null {
  if (!horseGoalsConfig(m)) return null;
  const p = pinnedHorse(m, s);
  if (!p) return null;
  const goal = p.goals.find((g) => g.current)!;
  return { horseId: p.h.id, horseName: p.h.name, goal, doneCount: p.goals.filter((g) => g.done).length, total: p.goals.length };
}

/** REQ-HGOAL-007: PUT /v1/horse-goals/pin. Idempotent; returns whether the pin changed (the KPI is sent only then). */
export function pinHorseGoal(m: Master, s: PlayerState, horseId: string | null, emit?: (e: KpiEvent) => void) {
  requireCfg(m);
  const st = ensureHorseGoals(s);
  const before = pinnedGoalView(m, s)?.horseId ?? null;
  if (horseId === null) {
    st.pinned = null;
    if (before !== null) emit?.({ name: 'hgoal_pin', s1: 'unpin', s2: '' });
    return { pinned: null };
  }
  const h = s.horses.find((x) => x.id === horseId);
  if (!h) throw new AppError('HORSE_NOT_FOUND', horseId);
  if (h.status !== 'active') throw new AppError('NOT_ELIGIBLE', 'a retired horse cannot be pinned');
  if (goalsOf(m, s, h).every((g) => g.done)) throw new AppError('NOT_ELIGIBLE', 'every goal of this horse is done');
  st.pinned = horseId;
  const pinned = pinnedGoalView(m, s)!;
  if (before !== horseId) emit?.({ name: 'hgoal_pin', s1: 'pin', s2: pinned.goal.kind });
  return { pinned };
}

/** REQ-HGOAL-008: what the next-action guide reads (the pinned horse's current goal; null when none). */
export function horseGoalBrief(m: Master, s: PlayerState): { horseId: string; have: number; unitsLeft: number } | null {
  const p = pinnedGoalView(m, s);
  return p ? { horseId: p.horseId, have: p.goal.have, unitsLeft: p.goal.need - p.goal.have } : null;
}
