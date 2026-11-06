/**
 * 支部対抗シーズン — team-vs-team monthly league (REQ-LEAGUE-*). Pure domain: no I/O, time injected.
 *
 * One league per season (JST month), kept by that season's LeaderboardDO:
 *  - teams are split into ordered divisions (top first). A season starts from the previous season's
 *    promotion/relegation result; teams new to the league start in the lowest division;
 *  - the month is cut into `weeks` matchup windows. At the start of a window every division pairs its
 *    teams by standing (league points, then score difference, then the team's current season points —
 *    the "points band"), avoiding last week's opponent where possible; an odd team out gets a bye;
 *  - a matchup is scored from the members' ranked results inside the window: each side's score is how
 *    much its members' contributions (REQ-TEAM-005: capped, tenure-aware) grew between the window's start
 *    and end, per membership stint — a member who leaves keeps the growth they made inside the window
 *    (frozen at the leave), so a departure never wipes the team's week (QA r7 #6);
 *  - at the season's end the final tables decide places, promotion and relegation, and the league reward
 *    (paid with the team season reward through the team rollover, so the same idempotency, tenure rule
 *    and dead-letter handling apply).
 */
import type { Master, Reward } from './master.js';
import { AppError } from './errors.js';
import { weatherProblems } from './ground.js';
import type { TeamSummary } from './teams.js';
import { seasonEndMs } from './teams.js';

const DAY_MS = 86_400_000;
const JST_OFFSET_MS = 9 * 3600_000;

export interface LeagueDivision { id: string; name: string }
export interface LeagueRewardBand { divisionId: string; maxPlace: number | null; reward: Reward }
export interface LeagueConfig {
  /** Ordered top → bottom. */
  divisions: LeagueDivision[];
  /** Matchup windows per season (the last window absorbs the month's remaining days). */
  weeks: number;
  /** Members a team needs (when the window opens, or when it is admitted late) to be paired that week. */
  minMembers: number;
  /**
   * Hours after a window opens during which a team that was not on the season board yet (no member has
   * raced this season, e.g. right after the month turned) or had too few members is still admitted: it
   * takes a waiting bye slot or meets another late team. Its starting points are its points when the
   * window opened (0 when it was not on the board).
   */
  lateEntryHours: number;
  winPoints: number; drawPoints: number; lossPoints: number; byePoints: number;
  /** Teams moving up from / down out of each division at season end (per boundary). */
  promote: number; relegate: number;
  /** Per division, ascending `maxPlace` (null = any place). First match wins. */
  rewards: LeagueRewardBand[];
  /** Divisions in the published snapshot list at most this many rows. */
  topN: number;
}

export interface LeagueRow {
  teamId: string; name: string; divisionId: string;
  played: number; won: number; drawn: number; lost: number; byes: number;
  leaguePoints: number; scoreFor: number; scoreAgainst: number;
}
export interface LeagueMatch {
  a: string; b: string | null;
  /** Team season points when the window opened. */
  aStart: number; bStart: number;
  aScore: number | null; bScore: number | null;
}
export interface LeagueWeek {
  index: number; startMs: number; endMs: number;
  status: 'pending' | 'open' | 'scored' | 'skipped';
  matches: Record<string, LeagueMatch[]>;
  /** Every known team's season points when the window opened (late entries start from these, or 0). */
  starts?: Record<string, number>;
  /** Per team, each stint's contribution when the window opened (TeamSummary.stints; a stint not listed started at 0). */
  stintStarts?: Record<string, Record<string, number>>;
}
export interface LeaguePlace { divisionId: string; place: number; size: number }
export interface LeagueFinal { places: Record<string, LeaguePlace>; next: Record<string, string>; at: number }
export interface LeagueState {
  v: 1; seasonId: string;
  divisionOf: Record<string, string>;
  weeks: LeagueWeek[];
  table: Record<string, LeagueRow>;
  final: LeagueFinal | null;
}

// --------------------------------------------------------------------------------------------- time

/** JST month "YYYY-MM" → the instant it starts. */
export function seasonStartMs(seasonId: string): number {
  const [y, mo] = seasonId.split('-').map(Number) as [number, number];
  return Date.UTC(y, mo - 1, 1) - JST_OFFSET_MS;
}

/** The season's matchup windows: `weeks` × 7 days, the last one running to the end of the month. */
export function weekWindows(seasonId: string, weeks: number): { index: number; startMs: number; endMs: number }[] {
  const start = seasonStartMs(seasonId);
  const end = seasonEndMs(seasonId);
  const out: { index: number; startMs: number; endMs: number }[] = [];
  for (let i = 0; i < weeks; i++) {
    const s = start + i * 7 * DAY_MS;
    const e = i === weeks - 1 ? end : Math.min(end, start + (i + 1) * 7 * DAY_MS);
    if (s >= end) break;
    out.push({ index: i, startMs: s, endMs: e });
  }
  return out;
}

// --------------------------------------------------------------------------------------------- setup

export function newLeague(seasonId: string, cfg: LeagueConfig, carry: Record<string, string>): LeagueState {
  const valid = new Set(cfg.divisions.map((d) => d.id));
  const divisionOf: Record<string, string> = {};
  for (const [t, d] of Object.entries(carry)) if (valid.has(d)) divisionOf[t] = d;
  return {
    v: 1, seasonId, divisionOf, table: {}, final: null,
    weeks: weekWindows(seasonId, cfg.weeks).map((w) => ({ ...w, status: 'pending' as const, matches: {} })),
  };
}

const lowest = (cfg: LeagueConfig) => cfg.divisions[cfg.divisions.length - 1]!.id;

function rowOf(st: LeagueState, t: TeamSummary, divisionId: string): LeagueRow {
  const r = (st.table[t.teamId] ??= { teamId: t.teamId, name: t.name, divisionId, played: 0, won: 0, drawn: 0, lost: 0, byes: 0, leaguePoints: 0, scoreFor: 0, scoreAgainst: 0 });
  r.name = t.name;
  return r;
}

/** Standing order inside a division: league points → score difference → score for → team id. */
export function compareRows(a: LeagueRow, b: LeagueRow): number {
  return b.leaguePoints - a.leaguePoints
    || (b.scoreFor - b.scoreAgainst) - (a.scoreFor - a.scoreAgainst)
    || b.scoreFor - a.scoreFor
    || (a.teamId < b.teamId ? -1 : a.teamId > b.teamId ? 1 : 0);
}

function lastOpponent(st: LeagueState, teamId: string, beforeWeek: number): string | null {
  for (let i = beforeWeek - 1; i >= 0; i--) {
    for (const ms of Object.values(st.weeks[i]?.matches ?? {})) {
      for (const m of ms) {
        if (m.a === teamId) return m.b;
        if (m.b === teamId) return m.a;
      }
    }
    if (st.weeks[i]?.status === 'scored') return null;
  }
  return null;
}

/**
 * REQ-LEAGUE-002: pairs one division for a week. Order = standing, then the team's current season points
 * (so week 1, where everyone is level, pairs teams of similar strength). Adjacent teams meet; when that
 * would repeat last week's matchup and a swap with the next team avoids it, the two are swapped.
 */
export function pairDivision(st: LeagueState, divisionId: string, teams: TeamSummary[], weekIndex: number): LeagueMatch[] {
  const pts = new Map(teams.map((t) => [t.teamId, t.points]));
  const order = teams
    .map((t) => ({ id: t.teamId, r: st.table[t.teamId]!, pts: t.points }))
    .sort((x, y) => y.r.leaguePoints - x.r.leaguePoints
      || (y.r.scoreFor - y.r.scoreAgainst) - (x.r.scoreFor - x.r.scoreAgainst)
      || y.pts - x.pts
      || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    .map((x) => x.id);
  const out: LeagueMatch[] = [];
  const ids = [...order];
  while (ids.length >= 2) {
    const a = ids.shift()!;
    let j = 0;
    if (lastOpponent(st, a, weekIndex) === ids[0] && ids.length >= 2) j = 1;
    const b = ids.splice(j, 1)[0]!;
    out.push({ a, b, aStart: pts.get(a)!, bStart: pts.get(b)!, aScore: null, bScore: null });
  }
  if (ids.length === 1) out.push({ a: ids[0]!, b: null, aStart: pts.get(ids[0]!)!, bStart: 0, aScore: null, bScore: null });
  void divisionId;
  return out;
}

/** Opens window `i`: teams with enough members take part; teams new to the league join the lowest division. */
export function openWeek(st: LeagueState, cfg: LeagueConfig, i: number, teams: TeamSummary[]): void {
  const w = st.weeks[i]!;
  const active = teams.filter((t) => t.season === st.seasonId && t.members >= cfg.minMembers);
  for (const t of active) {
    const d = (st.divisionOf[t.teamId] ??= lowest(cfg));
    rowOf(st, t, d).divisionId = d;
  }
  w.matches = {};
  w.starts = Object.fromEntries(teams.filter((t) => t.season === st.seasonId).map((t) => [t.teamId, t.points]));
  w.stintStarts = Object.fromEntries(teams.filter((t) => t.season === st.seasonId && t.stints).map((t) => [t.teamId, { ...t.stints! }]));
  for (const div of cfg.divisions) {
    const inDiv = active.filter((t) => st.divisionOf[t.teamId] === div.id);
    if (inDiv.length > 0) w.matches[div.id] = pairDivision(st, div.id, inDiv, i);
  }
  w.status = 'open';
}

/**
 * REQ-LEAGUE-002: admits teams that became eligible after window `i` opened (see `lateEntryHours`). Per
 * division (in team-id order, so the result does not depend on arrival order inside one tick) a late team
 * first takes the division's bye slot, then late teams meet each other; an odd one out gets the bye.
 * Returns true when a team was admitted.
 */
export function admitLate(st: LeagueState, cfg: LeagueConfig, i: number, teams: TeamSummary[]): boolean {
  const w = st.weeks[i]!;
  if (w.status !== 'open') return false;
  const inWeek = new Set<string>();
  for (const ms of Object.values(w.matches)) for (const m of ms) { inWeek.add(m.a); if (m.b) inWeek.add(m.b); }
  const late = teams
    .filter((t) => t.season === st.seasonId && t.members >= cfg.minMembers && !inWeek.has(t.teamId))
    .sort((x, y) => (x.teamId < y.teamId ? -1 : x.teamId > y.teamId ? 1 : 0));
  if (late.length === 0) return false;
  const startOf = (id: string) => w.starts?.[id] ?? 0;
  for (const t of late) {
    const d = (st.divisionOf[t.teamId] ??= lowest(cfg));
    rowOf(st, t, d).divisionId = d;
    const ms = (w.matches[d] ??= []);
    const bye = ms.find((m) => m.b === null);
    if (bye) { bye.b = t.teamId; bye.bStart = startOf(t.teamId); }
    else ms.push({ a: t.teamId, b: null, aStart: startOf(t.teamId), bStart: 0, aScore: null, bScore: null });
  }
  return true;
}

/**
 * REQ-LEAGUE-003: one side's score for window `w`: the growth of every stint's contribution since the window
 * opened (departed members' stints stay in the summary, frozen at the leave). Summaries from older builds
 * (no stints) fall back to the team's points now minus at the start.
 */
export function windowScore(w: LeagueWeek, teamId: string, start: number, now: TeamSummary | undefined): number {
  if (!now) return 0;
  const base = w.stintStarts?.[teamId];
  // stints are comparable when they were snapshotted at the open, or the team was not on the board then (all from 0)
  if (now.stints && (base || !(teamId in (w.starts ?? {})))) {
    let sum = 0;
    for (const [k, v] of Object.entries(now.stints)) sum += Math.max(0, v - (base?.[k] ?? 0));
    return sum;
  }
  return Math.max(0, now.points - start);
}

/** REQ-LEAGUE-003: scores window `i` from the teams' summaries now (growth inside the window). */
export function scoreWeek(st: LeagueState, cfg: LeagueConfig, i: number, teamsNow: Map<string, TeamSummary>): void {
  const w = st.weeks[i]!;
  if (w.status !== 'open') return;
  for (const ms of Object.values(w.matches)) {
    for (const m of ms) {
      const a = st.table[m.a]!;
      m.aScore = windowScore(w, m.a, m.aStart, teamsNow.get(m.a));
      if (m.b === null) {
        a.byes++;
        a.leaguePoints += cfg.byePoints;
        continue;
      }
      const b = st.table[m.b]!;
      m.bScore = windowScore(w, m.b, m.bStart, teamsNow.get(m.b));
      a.played++; b.played++;
      a.scoreFor += m.aScore; a.scoreAgainst += m.bScore;
      b.scoreFor += m.bScore; b.scoreAgainst += m.aScore;
      if (m.aScore > m.bScore) { a.won++; b.lost++; a.leaguePoints += cfg.winPoints; b.leaguePoints += cfg.lossPoints; }
      else if (m.aScore < m.bScore) { b.won++; a.lost++; b.leaguePoints += cfg.winPoints; a.leaguePoints += cfg.lossPoints; }
      else { a.drawn++; b.drawn++; a.leaguePoints += cfg.drawPoints; b.leaguePoints += cfg.drawPoints; }
    }
  }
  w.status = 'scored';
}

/**
 * REQ-LEAGUE-001..003: brings the league up to `now`. Scores every opened window that has ended, opens the
 * window containing `now`, and marks windows that ended before they could be opened as skipped (the cron
 * was down). Idempotent; returns true when the state changed. A finalized league no longer changes.
 */
export function leagueTick(st: LeagueState, cfg: LeagueConfig, teams: TeamSummary[], now: number): boolean {
  if (st.final) return false;
  let changed = false;
  const pts = new Map(teams.map((t) => [t.teamId, t]));
  for (const w of st.weeks) {
    if (w.status === 'open' && now < w.endMs && now < w.startMs + cfg.lateEntryHours * 3_600_000 && admitLate(st, cfg, w.index, teams)) changed = true;
    if (w.status === 'open' && now >= w.endMs) { scoreWeek(st, cfg, w.index, pts); changed = true; }
    if (w.status === 'pending' && now >= w.endMs) { w.status = 'skipped'; changed = true; }
    if (w.status === 'pending' && now >= w.startMs && now < w.endMs) { openWeek(st, cfg, w.index, teams); changed = true; }
  }
  return changed;
}

// --------------------------------------------------------------------------------------------- end of season

export function divisionTable(st: LeagueState, divisionId: string): LeagueRow[] {
  return Object.values(st.table).filter((r) => r.divisionId === divisionId).sort(compareRows);
}

/**
 * REQ-LEAGUE-004: closes the league. Scores what is still open, fixes every team's place and the next
 * season's divisions: the top `promote` of a division (except the top one) go up, the bottom `relegate`
 * (except the lowest one) go down. Teams with no row (never active) carry their division unchanged.
 */
export function finalizeLeague(st: LeagueState, cfg: LeagueConfig, teams: TeamSummary[], now: number): LeagueFinal {
  if (st.final) return st.final;
  const pts = new Map(teams.map((t) => [t.teamId, t]));
  for (const w of st.weeks) {
    if (w.status === 'open') scoreWeek(st, cfg, w.index, pts);
    else if (w.status === 'pending') w.status = 'skipped';
  }
  const places: Record<string, LeaguePlace> = {};
  const next: Record<string, string> = { ...st.divisionOf };
  cfg.divisions.forEach((div, di) => {
    const table = divisionTable(st, div.id);
    table.forEach((r, i) => {
      places[r.teamId] = { divisionId: div.id, place: i + 1, size: table.length };
      if (di > 0 && i < cfg.promote) next[r.teamId] = cfg.divisions[di - 1]!.id;
      else if (di < cfg.divisions.length - 1 && i >= table.length - cfg.relegate && table.length > cfg.promote) next[r.teamId] = cfg.divisions[di + 1]!.id;
    });
  });
  st.final = { places, next, at: now };
  return st.final;
}

export function leagueRewardFor(cfg: LeagueConfig, place: LeaguePlace | null | undefined): Reward | null {
  if (!place) return null;
  for (const b of cfg.rewards) {
    if (b.divisionId !== place.divisionId) continue;
    if (b.maxPlace === null || place.place <= b.maxPlace) return b.reward;
  }
  return null;
}

// --------------------------------------------------------------------------------------------- views

export interface LeagueBoardFile {
  seasonId: string; board: string; generatedAt: number; divisionId: string; divisionName: string;
  total: number; currentWeek: number | null; final: boolean;
  entries: (LeagueRow & { place: number })[];
  weeks: { index: number; startMs: number; endMs: number; status: LeagueWeek['status']; matches: LeagueMatch[] }[];
}

export const leagueBoardName = (divisionId: string) => `league-${divisionId}`;
export const LEAGUE_BOARD_RE = /^league-[a-z0-9_]{1,16}$/;

export function currentWeekIndex(st: LeagueState, now: number): number | null {
  const w = st.weeks.find((x) => now >= x.startMs && now < x.endMs);
  return w ? w.index : null;
}

/** REQ-LEAGUE-005: one published file per division (read by the public GET without touching the object). */
export function buildLeagueBoards(st: LeagueState, cfg: LeagueConfig, now: number): LeagueBoardFile[] {
  const cur = currentWeekIndex(st, now);
  return cfg.divisions.map((div) => {
    const table = divisionTable(st, div.id);
    return {
      seasonId: st.seasonId, board: leagueBoardName(div.id), generatedAt: now, divisionId: div.id, divisionName: div.name,
      total: table.length, currentWeek: cur, final: st.final !== null,
      entries: table.slice(0, cfg.topN).map((r, i) => ({ ...r, place: i + 1 })),
      weeks: st.weeks.map((w) => ({ index: w.index, startMs: w.startMs, endMs: w.endMs, status: w.status, matches: w.matches[div.id] ?? [] })),
    };
  });
}

/** REQ-LEAGUE-005: one team's view — its division table, its matchups and (after the season) its place. */
export function teamLeagueView(st: LeagueState | null, cfg: LeagueConfig, teamId: string, now: number) {
  if (!st) return { seasonId: null, divisionId: null, divisionName: null, row: null, place: null, table: [], matches: [], currentWeek: null, final: null };
  const divisionId = st.table[teamId]?.divisionId ?? st.divisionOf[teamId] ?? null;
  const div = cfg.divisions.find((d) => d.id === divisionId) ?? null;
  const table = divisionId ? divisionTable(st, divisionId) : [];
  const idx = table.findIndex((r) => r.teamId === teamId);
  const matches = st.weeks.map((w) => {
    const m = (divisionId ? w.matches[divisionId] ?? [] : []).find((x) => x.a === teamId || x.b === teamId) ?? null;
    if (!m) return { index: w.index, startMs: w.startMs, endMs: w.endMs, status: w.status, opponent: null, opponentName: null, myScore: null, opponentScore: null, bye: false };
    const mine = m.a === teamId;
    const opp = mine ? m.b : m.a;
    return {
      index: w.index, startMs: w.startMs, endMs: w.endMs, status: w.status,
      opponent: opp, opponentName: opp ? st.table[opp]?.name ?? null : null,
      myScore: mine ? m.aScore : m.bScore, opponentScore: mine ? m.bScore : m.aScore, bye: m.b === null,
    };
  });
  const final = st.final?.places[teamId] ?? null;
  return {
    seasonId: st.seasonId, divisionId, divisionName: div?.name ?? null,
    row: idx >= 0 ? { ...table[idx]!, place: idx + 1 } : null,
    place: idx >= 0 ? idx + 1 : null,
    table: table.slice(0, cfg.topN).map((r, i) => ({ ...r, place: i + 1 })),
    matches, currentWeek: currentWeekIndex(st, now),
    final: final ? { ...final, reward: leagueRewardFor(cfg, final), nextDivisionId: st.final?.next[teamId] ?? null } : null,
  };
}

// --------------------------------------------------------------------------------------------- validation

/** Problems in a league config (boot and remote config, REQ-OPS-003). */
export function leagueProblems(cfg: unknown, knownItems?: Set<string>): string[] {
  const p: string[] = [];
  const c = cfg as Partial<LeagueConfig> | undefined;
  if (!c || typeof c !== 'object') return ['league: missing'];
  if (!Array.isArray(c.divisions) || c.divisions.length < 1) return ['league.divisions must be a non-empty array'];
  const ids = new Set<string>();
  for (const d of c.divisions) {
    if (!d || typeof d.id !== 'string' || !/^[a-z0-9_]{1,16}$/.test(d.id)) p.push(`league.divisions: bad id ${JSON.stringify(d?.id)}`);
    else if (ids.has(d.id)) p.push(`league.divisions: duplicate id ${d.id}`);
    else ids.add(d.id);
    if (!d || typeof d.name !== 'string' || d.name.length === 0) p.push(`league.divisions[${d?.id}]: name required`);
  }
  const int = (k: keyof LeagueConfig, min: number, max: number) => {
    const v = c[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) p.push(`league.${String(k)} must be an integer ${min}..${max}`);
  };
  int('weeks', 1, 5); int('minMembers', 1, 100); int('lateEntryHours', 0, 168);
  int('winPoints', 0, 100); int('drawPoints', 0, 100); int('lossPoints', 0, 100); int('byePoints', 0, 100);
  int('promote', 0, 100); int('relegate', 0, 100); int('topN', 1, 1000);
  if (typeof c.winPoints === 'number' && typeof c.drawPoints === 'number' && typeof c.lossPoints === 'number' && !(c.winPoints > c.drawPoints && c.drawPoints >= c.lossPoints)) p.push('league: winPoints > drawPoints >= lossPoints required');
  if (typeof c.byePoints === 'number' && typeof c.winPoints === 'number' && c.byePoints > c.winPoints) p.push('league.byePoints must not exceed winPoints');
  if (!Array.isArray(c.rewards)) p.push('league.rewards must be an array');
  else c.rewards.forEach((b, i) => {
    if (!ids.has(b?.divisionId)) p.push(`league.rewards[${i}]: unknown division ${b?.divisionId}`);
    if (b?.maxPlace !== null && (typeof b?.maxPlace !== 'number' || !Number.isInteger(b.maxPlace) || b.maxPlace < 1)) p.push(`league.rewards[${i}].maxPlace must be null or >= 1`);
    p.push(...coinItemRewardProblems(`league.rewards[${i}].reward`, b?.reward, knownItems));
  });
  return p;
}

/**
 * QA r7 #7: rewards paid through the team rollover (team season reward, league reward) may hold free coins
 * and items only — strictly, like the tournament prize schema. The rollover pays without the template
 * table, so a `horse` (or any unknown key) would only fail at payout time; it is refused up front.
 */
export function coinItemRewardProblems(path: string, r: unknown, knownItems?: Set<string>): string[] {
  const p: string[] = [];
  if (!r || typeof r !== 'object' || Array.isArray(r)) return [`${path} required`];
  const o = r as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== 'freeCoins' && k !== 'items') p.push(`${path}: ${k} is not allowed here (free coins and items only)`);
  if (o.freeCoins !== undefined && (!Number.isInteger(o.freeCoins) || (o.freeCoins as number) < 0 || (o.freeCoins as number) > 100_000)) p.push(`${path}.freeCoins must be 0..100000`);
  if (o.items !== undefined) {
    if (!Array.isArray(o.items) || o.items.length > 8) p.push(`${path}.items must be an array of at most 8`);
    else o.items.forEach((it: unknown, j) => {
      const x = it as Record<string, unknown> | null;
      if (!x || typeof x !== 'object') { p.push(`${path}.items[${j}] must be an object`); return; }
      for (const k of Object.keys(x)) if (k !== 'itemId' && k !== 'qty') p.push(`${path}.items[${j}]: unknown key ${k}`);
      if (typeof x.itemId !== 'string' || x.itemId.length === 0) p.push(`${path}.items[${j}].itemId required`);
      else if (knownItems && !knownItems.has(x.itemId)) p.push(`${path}: unknown item ${x.itemId}`);
      if (!Number.isInteger(x.qty) || (x.qty as number) < 1 || (x.qty as number) > 100) p.push(`${path}.items[${j}].qty must be 1..100`);
    });
  }
  return p;
}

/** QA r7 #7: the team season reward bands (paid by the team rollover, like the league reward). */
export function teamRewardProblems(bands: unknown, knownItems?: Set<string>): string[] {
  if (!Array.isArray(bands)) return ['teams.seasonRewards must be an array'];
  return bands.flatMap((b: { reward?: unknown } | null, i) => coinItemRewardProblems(`teams.seasonRewards[${i}].reward`, b?.reward, knownItems));
}

/** Boot check of the shipped master (index.ts), like validateGacha / validateItems: league and per-course climate. */
export function validateLeagueAndWeather(m: Pick<Master, 'progression' | 'tracks'>): void {
  const p = [...leagueProblems(m.progression.league), ...teamRewardProblems(m.progression.teams.seasonRewards), ...weatherProblems(m.progression.weather, m.tracks)];
  if (p.length) throw new AppError('CONFIG_INVALID', p.join('; '));
}
