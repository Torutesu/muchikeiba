/**
 * REQ-PROMO-001..020: 昇級戦と降級の猶予 (ranked promotion series & demotion protection, contracts/protocol.md §68).
 *
 * When a player's season points reach their class's promotion line, the promotion is not confirmed straight away: a short
 * series of ranked races (`races`, pass with `needTop` finishes at or above `topPlace`) decides it. Passing confirms the
 * month's promotion (the class still changes only at the season close, REQ-RATE-002); failing sets the season points back
 * to `promotePoints − setbackPoints` so the player can reach the line and try again. After a promotion at the close, the
 * first `graceRaces` counted ranked races in the new class are a grace window: a demotion the next close would make is
 * stopped once (one shield per class per season, one per promotion).
 *
 * Pure state logic, no I/O. Nothing here grants anything, nothing purchasable is read, ratings and matchmaking are untouched.
 * Every step is keyed by the race id (idempotent) and ordered by the races' start time, so a result delivered twice or
 * late changes nothing. `enabled: false` (or no section) is the kill switch: the old behaviour (the line promotes at the
 * close, no shield).
 */
import { AppError } from './errors.js';
import type { KpiEvent } from './kpi.js';
import type { Master } from './master.js';
import { moderationOf, type PlayerState } from './player.js';
import type { RaceResultForPlayer } from './rewards.js';

// ------------------------------------------------------------------------------------------------ rules (data)

export interface PromotionRules {
  enabled: boolean;
  /** Races in a series (N). */
  races: number;
  /** Finishes at or above `topPlace` needed to pass (K). */
  needTop: number;
  topPlace: number;
  /** A failed series sets the points to `promotePoints − setbackPoints` (or keeps them if lower). */
  setbackPoints: number;
  /** Counted ranked races in a newly reached class during which a demotion is stopped once (0 = no shield). */
  graceRaces: number;
}

export const PROMOTION_DEFAULTS: PromotionRules = { enabled: false, races: 3, needTop: 2, topPlace: 3, setbackPoints: 40, graceRaces: 10 };
const RULE_KEYS = ['enabled', 'races', 'needTop', 'topPlace', 'setbackPoints', 'graceRaces'];
const REWARD_WORDS = /reward|coin|item|grant|gift|xp|bonus|ticket/i;

/** The rules in effect (`enabled: false` when the section is absent — the kill switch). */
export function promotionRulesOf(m: Pick<Master, 'progression'>): PromotionRules {
  const raw = (m.progression as { promotion?: Partial<PromotionRules> }).promotion;
  if (!raw) return PROMOTION_DEFAULTS;
  const out = { ...PROMOTION_DEFAULTS };
  for (const k of RULE_KEYS) if ((raw as Record<string, unknown>)[k] !== undefined) (out as Record<string, unknown>)[k] = (raw as Record<string, unknown>)[k];
  return out;
}
export const promotionEnabled = (m: Pick<Master, 'progression'>) => promotionRulesOf(m).enabled === true;

/** REQ-PROMO-001: boot and every remote-config version. */
export function promotionProblems(m: Pick<Master, 'progression'>): string[] {
  const raw = (m.progression as { promotion?: unknown }).promotion;
  if (raw === undefined) return [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return ['progression.promotion must be an object'];
  const c = raw as Record<string, unknown>;
  const p: string[] = [];
  for (const k of Object.keys(c)) {
    if (RULE_KEYS.includes(k) || k === '_note') continue;
    p.push(REWARD_WORDS.test(k) ? `progression.promotion.${k}: the promotion series never grants anything` : `progression.promotion.${k} is not a known key`);
  }
  const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  if (typeof c.enabled !== 'boolean') p.push('progression.promotion.enabled must be a boolean');
  if (!int(c.races, 1, 5)) p.push('progression.promotion.races must be an integer 1..5');
  if (!int(c.needTop, 1, int(c.races, 1, 5) ? (c.races as number) : 5)) p.push('progression.promotion.needTop must be an integer 1..races');
  const places = m.progression.seasonPointsByPlace?.length ?? 0;
  if (!int(c.topPlace, 1, Math.max(1, places))) p.push(`progression.promotion.topPlace must be an integer 1..${Math.max(1, places)}`);
  if (!int(c.graceRaces, 0, 100)) p.push('progression.promotion.graceRaces must be an integer 0..100');
  if (!int(c.setbackPoints, 1, 1_000_000)) p.push('progression.promotion.setbackPoints must be a positive integer');
  else {
    for (const cl of m.progression.classes ?? []) {
      if (cl.promotePoints === null) continue;
      const floor = Math.max(0, cl.demoteBelowPoints ?? 0);
      if (cl.promotePoints - (c.setbackPoints as number) < floor) p.push(`progression.promotion.setbackPoints: class ${cl.id} would fall below ${floor} (promotePoints ${cl.promotePoints})`);
    }
  }
  return p;
}

// ------------------------------------------------------------------------------------------------ state

export type PromoStatus = 'active' | 'passed' | 'failed' | 'season_end';
export type PromoPip = 'top' | 'miss' | 'open' | 'skip';
export interface PromoResult { raceId: string; place: number; top: boolean; cpu: boolean; at: number }
export interface PromoSeries {
  id: string; seasonId: string; classId: string; toClassId: string; line: number;
  /** Rules when it started (a config change never changes a running series). */
  races: number; needTop: number; topPlace: number;
  startedAt: number;
  /** Start time of the race that started the series (races that started before it are not part of it); null = unknown. */
  afterStartAtMs: number | null;
  results: PromoResult[];
  status: PromoStatus;
  endedAt: number | null;
  /** The points after a failed series' setback. */
  setbackTo: number | null;
  /** The result sheet was seen (POST /v1/promotion/ack). */
  seen: boolean;
}
export interface PromotionState {
  series: PromoSeries | null;
  /** Ended series, newest first. */
  history: PromoSeries[];
  /** `season:class` keys of passed series. */
  passed: string[];
  /** Series started this season, by `season:class`. */
  attempts: Record<string, number>;
  /** Points taken back this season by failed series (season missions still count them, REQ-PROMO-012). */
  setback: { seasonId: string; points: number } | null;
  grace: { classId: string; races: number; since: string } | null;
  shields: { seasonId: string; classId: string; at: number }[];
}
export const PROMO_HISTORY_KEEP = 10;
export const PROMO_KEYS_KEEP = 24;

const peek = (s: PlayerState) => s.promotion;
export function ensurePromotion(s: PlayerState): PromotionState {
  s.promotion ??= { series: null, history: [], passed: [], attempts: {}, setback: null, grace: null, shields: [] };
  return s.promotion;
}
const keyOf = (seasonId: string, classId: string) => `${seasonId}:${classId}`;

/** REQ-PROMO-012: points earned this season (the current points plus what failed series took back). */
export function seasonPointsEarned(s: PlayerState): number {
  const sb = peek(s)?.setback;
  return s.season.points + (sb && sb.seasonId === s.season.id ? sb.points : 0);
}

const nextClassOf = (m: Pick<Master, 'progression'>, classId: string) => {
  const cs = m.progression.classes;
  const i = cs.findIndex((c) => c.id === classId);
  return i >= 0 && i < cs.length - 1 ? { cur: cs[i]!, next: cs[i + 1]! } : null;
};

// ------------------------------------------------------------------------------------------------ races

/** REQ-PROMO-003: does this applied result count for the series and the grace window? */
export function promoCounted(m: Pick<Master, 'progression'>, s: PlayerState, r: RaceResultForPlayer, now: number): boolean {
  if (!promotionEnabled(m)) return false;
  if (r.mode !== 'ranked' || r.void || r.suspect) return false;
  if (moderationOf(s, now) !== 'ok') return false;
  if (s.deletion?.status === 'deleting') return false;
  return true;
}

const tally = (x: PromoSeries) => ({ tops: x.results.filter((r) => r.top).length, misses: x.results.filter((r) => !r.top).length });

export interface PromoRaceOutcome { started: PromoSeries | null; ended: PromoSeries | null; counted: boolean }

/**
 * REQ-PROMO-004..007: after a ranked result was applied (season points already added). Either moves the running series
 * one race (and ends it when decided), or starts a series when the line was reached. Also counts the grace window.
 */
export function notePromotionRace(m: Pick<Master, 'progression'>, s: PlayerState, r: RaceResultForPlayer, now: number, emit?: (e: KpiEvent) => void): PromoRaceOutcome {
  const out: PromoRaceOutcome = { started: null, ended: null, counted: false };
  if (!promoCounted(m, s, r, now)) return out;
  out.counted = true;
  const st = ensurePromotion(s);
  // REQ-PROMO-010: the grace window counts every counted race in the class it was given for
  if (st.grace) {
    if (st.grace.classId !== s.season.classId) st.grace = null;
    else if (++st.grace.races >= promotionRulesOf(m).graceRaces) st.grace = null;
  }
  const cur = st.series;
  if (cur && cur.status === 'active' && cur.seasonId === s.season.id && cur.classId === s.season.classId) {
    if (cur.results.some((x) => x.raceId === r.raceId)) return out;
    // a race that started before the series' first race is not part of it (late / out-of-order delivery)
    if (r.startAtMs !== undefined && cur.afterStartAtMs !== null && r.startAtMs <= cur.afterStartAtMs) return out;
    const cpu = r.details?.cpuAssisted === true;
    cur.results.push({ raceId: r.raceId, place: r.place, top: !cpu && r.place >= 1 && r.place <= cur.topPlace, cpu, at: now });
    const { tops, misses } = tally(cur);
    if (tops >= cur.needTop) endSeries(st, cur, 'passed', now);
    else if (misses > cur.races - cur.needTop) {
      const target = Math.max(0, cur.line - promotionRulesOf(m).setbackPoints);
      const lost = Math.max(0, s.season.points - target);
      s.season.points -= lost;
      cur.setbackTo = s.season.points;
      if (lost > 0) st.setback = { seasonId: s.season.id, points: (st.setback?.seasonId === s.season.id ? st.setback.points : 0) + lost };
      endSeries(st, cur, 'failed', now);
    }
    if (cur.status !== 'active') {
      out.ended = cur;
      emit?.({ name: 'promo_series_end', s1: cur.status === 'passed' ? 'pass' : 'fail', s2: cur.classId, s3: cur.toClassId, count: tally(cur).tops, value: cur.results.length });
    }
    return out;
  }
  // REQ-PROMO-004: start when the line is reached (the race that reached it is not part of the series)
  const nc = nextClassOf(m, s.season.classId);
  if (!nc || nc.cur.promotePoints === null) return out;
  const key = keyOf(s.season.id, s.season.classId);
  if (st.passed.includes(key) || s.season.points < nc.cur.promotePoints) return out;
  for (const k of Object.keys(st.attempts)) if (!k.startsWith(`${s.season.id}:`)) delete st.attempts[k];
  const n = (st.attempts[key] ?? 0) + 1;
  st.attempts[key] = n;
  const rules = promotionRulesOf(m);
  if (cur && cur.status !== 'active') pushHistory(st, cur);
  st.series = {
    id: `${key}:${n}`, seasonId: s.season.id, classId: s.season.classId, toClassId: nc.next.id, line: nc.cur.promotePoints,
    races: rules.races, needTop: rules.needTop, topPlace: rules.topPlace, startedAt: now, afterStartAtMs: r.startAtMs ?? null,
    results: [], status: 'active', endedAt: null, setbackTo: null, seen: false,
  };
  out.started = st.series;
  emit?.({ name: 'promo_series_start', s1: s.season.classId, s2: nc.next.id, s3: st.series.id, value: s.season.points, count: n });
  return out;
}

function endSeries(st: PromotionState, x: PromoSeries, status: Exclude<PromoStatus, 'active'>, now: number) {
  x.status = status;
  x.endedAt = now;
  if (status === 'passed') {
    const key = keyOf(x.seasonId, x.classId);
    if (!st.passed.includes(key)) st.passed.push(key);
    if (st.passed.length > PROMO_KEYS_KEEP) st.passed.splice(0, st.passed.length - PROMO_KEYS_KEEP);
  }
}
function pushHistory(st: PromotionState, x: PromoSeries) {
  if (st.history.some((h) => h.id === x.id)) return;
  st.history.unshift(x);
  if (st.history.length > PROMO_HISTORY_KEEP) st.history.length = PROMO_HISTORY_KEEP;
}

// ------------------------------------------------------------------------------------------------ season close

/** REQ-PROMO-011: would the shield stop a demotion from `classId` at the close of `seasonId`? */
export function shieldApplies(m: Pick<Master, 'progression'>, s: PlayerState, seasonId: string, classId: string): boolean {
  if (!promotionEnabled(m)) return false;
  const st = peek(s);
  if (!st?.grace || st.grace.classId !== classId) return false;
  if (st.grace.races >= promotionRulesOf(m).graceRaces) return false;
  return !st.shields.some((x) => x.seasonId === seasonId && x.classId === classId);
}

export interface PromoCloseOutcome {
  /** How the closed season's promotion came about (absent = no series involved). */
  promo?: 'series' | 'series_open';
  shielded: boolean;
  /** Counted races the grace window had seen when the shield was used. */
  graceRaces?: number;
  /** A series still running at the close (resolved by the points: `season_end`). */
  ended: PromoSeries | null;
}

/**
 * REQ-PROMO-008..011: called by rollSeason with the closing season's class and the class it decided (after the shield).
 * Resolves a running series by the points (no carry-over), gives a grace window after a promotion, records a shield.
 */
export function closePromotionSeason(m: Pick<Master, 'progression'>, s: PlayerState, seasonId: string, fromClassId: string, toClassId: string, shielded: boolean, now: number): PromoCloseOutcome {
  const out: PromoCloseOutcome = { shielded: false, ended: null };
  const cs = m.progression.classes;
  const promoted = cs.findIndex((c) => c.id === toClassId) > cs.findIndex((c) => c.id === fromClassId);
  const grants = promoted && promotionEnabled(m) && promotionRulesOf(m).graceRaces > 0;
  // no state yet: only a promotion that opens a grace window needs one
  const st = peek(s) ?? (grants ? ensurePromotion(s) : undefined);
  if (!st) return out;
  const x = st.series;
  if (x && x.seasonId === seasonId) {
    if (x.status === 'active') {
      endSeries(st, x, 'season_end', now);
      out.ended = x;
      if (promoted) out.promo = 'series_open';
    } else if (x.status === 'passed' && promoted) out.promo = 'series';
  }
  if (!out.promo && promoted && st.passed.includes(keyOf(seasonId, fromClassId))) out.promo = 'series';
  if (x && x.status !== 'active') { pushHistory(st, x); st.series = null; }
  if (shielded) {
    out.graceRaces = st.grace?.races ?? 0;
    st.shields.push({ seasonId, classId: fromClassId, at: now });
    if (st.shields.length > PROMO_KEYS_KEEP) st.shields.splice(0, st.shields.length - PROMO_KEYS_KEEP);
    st.grace = null;
    out.shielded = true;
  } else if (grants) {
    st.grace = { classId: toClassId, races: 0, since: seasonId };
  } else if (st.grace && st.grace.classId !== toClassId) st.grace = null;
  for (const k of Object.keys(st.attempts)) if (k.startsWith(`${seasonId}:`)) delete st.attempts[k];
  if (st.setback && st.setback.seasonId === seasonId) st.setback = null;
  return out;
}

// ------------------------------------------------------------------------------------------------ view / ack

export function pipsOf(x: PromoSeries): PromoPip[] {
  const out: PromoPip[] = x.results.map((r) => (r.top ? 'top' : 'miss'));
  while (out.length < x.races) out.push(x.status === 'active' ? 'open' : 'skip');
  return out.slice(0, x.races);
}

export function seriesView(x: PromoSeries) {
  const { tops, misses } = tally(x);
  return {
    id: x.id, status: x.status, races: x.races, needTop: x.needTop, topPlace: x.topPlace,
    results: x.results.map((r) => ({ raceId: r.raceId, place: r.place, top: r.top, cpu: r.cpu })),
    pips: pipsOf(x), next: x.status === 'active' ? Math.min(x.races, x.results.length + 1) : null, tops, misses,
    startedAt: x.startedAt, endedAt: x.endedAt, setbackTo: x.setbackTo, seen: x.seen,
  };
}
export type PromoSeriesView = ReturnType<typeof seriesView>;

/** REQ-PROMO-013: GET /v1/promotion. */
export function promotionView(m: Pick<Master, 'progression'>, s: PlayerState) {
  const rules = promotionRulesOf(m);
  const st = peek(s);
  const nc = nextClassOf(m, s.season.classId);
  const base = {
    enabled: rules.enabled, seasonId: s.season.id, classId: s.season.classId, toClassId: nc?.next.id ?? null,
    line: nc?.cur.promotePoints ?? null, points: s.season.points, earned: seasonPointsEarned(s),
    rules: { races: rules.races, needTop: rules.needTop, topPlace: rules.topPlace, setbackPoints: rules.setbackPoints, graceRaces: rules.graceRaces },
  };
  if (!rules.enabled) return { ...base, series: null, passedThisSeason: false, grace: null, shieldUsedThisSeason: false };
  const x = st?.series && st.series.seasonId === s.season.id && st.series.classId === s.season.classId ? st.series : null;
  const g = st?.grace && st.grace.classId === s.season.classId && st.grace.races < rules.graceRaces ? st.grace : null;
  return {
    ...base,
    series: x ? seriesView(x) : null,
    passedThisSeason: !!st?.passed.includes(keyOf(s.season.id, s.season.classId)),
    grace: g ? { classId: g.classId, racesLeft: rules.graceRaces - g.races } : null,
    shieldUsedThisSeason: !!st?.shields.some((y) => y.seasonId === s.season.id),
  };
}

/** REQ-PROMO-014: the result sheet of an ended series was seen (idempotent). */
export function ackPromotion(s: PlayerState, seriesId: string): { seriesId: string; seen: true } {
  const st = peek(s);
  const x = st?.series?.id === seriesId ? st.series : st?.history.find((h) => h.id === seriesId);
  if (!x || x.status === 'active') throw new AppError('NOT_FOUND', 'no ended promotion series with that id');
  x.seen = true;
  return { seriesId, seen: true };
}
