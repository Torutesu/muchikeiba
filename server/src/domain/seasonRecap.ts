/**
 * シーズンの振り返り — the season / year recap (REQ-RECAP-*, contracts/protocol.md §43).
 *
 * Two running records (the current ranked season = JST calendar month, and the current game year = the year of the game
 * day, which rolls over at progression.dayRollover, 04:00 JST) are added to only from inside the existing once-only guards
 * (applyRace's race id guard, the team goal count, the rival week settlement, the replay save). When a period ends, the
 * player's next transaction (rollRecaps, right after rollSeason — the season rollover job's closeSeason is one) freezes it
 * into a small snapshot, once per player per period. Stats that already carry a timestamp (time attack records, hall
 * inductions, closed season records) are read by period instead. Nothing is estimated, random or reported by a client;
 * coins never move here and spending is never shown.
 */
import { z } from 'zod';
import { AppError } from './errors.js';
import { SEASON_HISTORY_KEEP } from './season.js';
import { rivalTrackName } from './rival.js';
import type { Master, Style } from './master.js';
import type { PlayerState } from './player.js';
import type { RaceResultForPlayer } from './rewards.js';
import type { Emit } from './service.js';
import { dayRule, gameDayKey, gameDayStartMs, jstMonthEndMs, jstMonthKey } from './time.js';

// ------------------------------------------------------------------------------------------------ config

export interface SeasonRecapConfig {
  enabled: boolean;
  /** Season recaps kept (newest first). */
  keepSeasons: number;
  /** Year recaps kept (newest first). */
  keepYears: number;
  /** Fewer races than this → the short version. */
  shortBelowRaces: number;
  /** Moments shown at most (2–3). */
  momentsMax: number;
}

export const SEASON_RECAP_LIMITS = { keepSeasons: SEASON_HISTORY_KEEP, keepYears: 10, shortBelowRaces: 20, momentsMin: 2, momentsMax: 3 } as const;
export const DEFAULT_SEASON_RECAP: SeasonRecapConfig = { enabled: true, keepSeasons: 12, keepYears: 3, shortBelowRaces: 3, momentsMax: 3 };

const configSchema = z.object({
  _note: z.string().optional(),
  enabled: z.boolean(), keepSeasons: z.number().int(), keepYears: z.number().int(), shortBelowRaces: z.number().int(), momentsMax: z.number().int(),
}).strict();

export function seasonRecapConfig(m: Master): SeasonRecapConfig | null {
  const c = m.progression.seasonRecap;
  return c && c.enabled ? c : null;
}

/** REQ-RECAP-013: boot and every remote-config version. */
export function seasonRecapProblems(m: Pick<Master, 'progression'>, path = 'progression.seasonRecap'): string[] {
  const raw = (m.progression as { seasonRecap?: unknown }).seasonRecap;
  if (raw === undefined) return [];
  const r = configSchema.safeParse(raw);
  if (!r.success) return r.error.issues.map((i) => `${path}.${i.path.join('.')}: ${i.message}`);
  const c = r.data;
  const L = SEASON_RECAP_LIMITS;
  const out: string[] = [];
  const within = (k: string, v: number, lo: number, hi: number) => { if (v < lo || v > hi) out.push(`${path}.${k}: must be ${lo}..${hi}`); };
  within('keepSeasons', c.keepSeasons, 1, L.keepSeasons);
  within('keepYears', c.keepYears, 1, L.keepYears);
  within('shortBelowRaces', c.shortBelowRaces, 1, L.shortBelowRaces);
  within('momentsMax', c.momentsMax, L.momentsMin, L.momentsMax);
  return out;
}

// ------------------------------------------------------------------------------------------------ state

export type RecapKind = 'season' | 'year';
export interface RecapWin { raceId: string; at: number; horseName: string | null; trackId: string | null; fieldSize: number }
export interface RecapAcc {
  periodId: string;
  /** When this record started (ms). Only the very first record of a player can start mid-period. */
  since: number;
  races: number; wins: number; top3: number;
  bestPlace: number | null; bestPlaceField: number;
  byHorse: Record<string, { horseName: string; races: number; wins: number; first: number }>;
  byStyle: Partial<Record<Style, number>>;
  streak: number; bestStreak: number;
  firstWin: RecapWin | null; bigWin: RecapWin | null;
  rival: { win: number; lose: number; draw: number };
  teamGoal: number;
  replaysSaved: number;
}

export type MomentKind = 'promotion' | 'hall' | 'first_win' | 'big_win' | 'streak' | 'ta_best';
export interface RecapMoment { kind: MomentKind; horseName: string | null; trackId: string | null; n: number | null; from: string | null; to: string | null; at: number }

export interface RecapSnapshot {
  id: string; kind: RecapKind; periodId: string;
  /** The period [from, to) in ms. */
  from: number; to: number;
  builtAt: number;
  /** Set when the record began after the period started (the screen says 「{date}からの記録です」). */
  since: number | null;
  short: boolean;
  races: number; wins: number; top3: number;
  bestFinish: { place: number; fieldSize: number } | null;
  rank: { classId: string; nextClassId: string; finalRank: number | null; promoted: boolean; seasonId: string } | null;
  horse: { horseId: string; horseName: string; races: number; wins: number } | null;
  timeAttack: { trackId: string; timeMs: number; horseName: string; courseBest: boolean } | null;
  style: { style: Style; races: number } | null;
  rival: { win: number; lose: number; draw: number } | null;
  teamGoal: number;
  hall: { count: number; horses: { horseName: string }[] };
  replaysSaved: number;
  moments: RecapMoment[];
  openedAt: number | null; completedAt: number | null;
}

export interface SeasonRecapState {
  acc: { season: RecapAcc | null; year: RecapAcc | null };
  recaps: RecapSnapshot[];
}

export function ensureRecap(s: PlayerState): SeasonRecapState {
  s.seasonRecap ??= { acc: { season: null, year: null }, recaps: [] };
  return s.seasonRecap;
}

// ------------------------------------------------------------------------------------------------ periods

const STYLE_ORDER: readonly Style[] = ['nige', 'senko', 'sashi', 'oikomi'];
/** First instant of the JST month `YYYY-MM`. */
const monthStartMs = (monthKey: string) => {
  const [y, mo] = monthKey.split('-').map(Number) as [number, number];
  return jstMonthEndMs(mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`);
};
/** REQ-RECAP-003: the game year (the year of the game day; rolls over with the daily resets, 04:00 JST). */
export const gameYearOf = (m: Master, now: number) => gameDayKey(now, dayRule(m)).slice(0, 4);
export const seasonPeriodId = (now: number) => jstMonthKey(now);

export function periodBounds(m: Master, kind: RecapKind, periodId: string): { from: number; to: number } {
  if (kind === 'season') return { from: monthStartMs(periodId), to: jstMonthEndMs(periodId) };
  const rule = dayRule(m);
  return { from: gameDayStartMs(`${periodId}-01-01`, rule), to: gameDayStartMs(`${Number(periodId) + 1}-01-01`, rule) };
}
export const recapId = (kind: RecapKind, periodId: string) => `${kind}:${periodId}`;

const newAcc = (periodId: string, since: number): RecapAcc => ({
  periodId, since, races: 0, wins: 0, top3: 0, bestPlace: null, bestPlaceField: 0, byHorse: {}, byStyle: {}, streak: 0, bestStreak: 0,
  firstWin: null, bigWin: null, rival: { win: 0, lose: 0, draw: 0 }, teamGoal: 0, replaysSaved: 0,
});

/** The running record of a period (created on first use). `since` = now only for a player's first record. */
function accFor(m: Master, s: PlayerState, kind: RecapKind, now: number): RecapAcc {
  const st = ensureRecap(s);
  const id = kind === 'season' ? seasonPeriodId(now) : gameYearOf(m, now);
  const cur = st.acc[kind];
  if (cur && cur.periodId === id) return cur;
  // a record that ended before this one was closed by rollRecaps; tracking was continuous, so the new one covers the whole period
  const next = newAcc(id, cur ? periodBounds(m, kind, id).from : now);
  st.acc[kind] = next;
  return next;
}
const eachAcc = (m: Master, s: PlayerState, now: number) => [accFor(m, s, 'season', now), accFor(m, s, 'year', now)];

// ------------------------------------------------------------------------------------------------ recording

/** A record that starts within this long of the period start / the account's creation covers the whole period. */
const SINCE_SLACK_MS = 10 * 60_000;
const COUNTED_MODES = ['ranked', 'friend', 'event', 'tournament'];
const BIG_WIN_MIN_FIELD = 8;

/** REQ-RECAP-001: a confirmed race (applyRace, inside the race id guard). Same set of races as the hall career / stats. */
export function noteRecapRace(m: Master, s: PlayerState, r: RaceResultForPlayer, now: number) {
  if (!seasonRecapConfig(m) || r.void || !COUNTED_MODES.includes(r.mode)) return;
  if (r.mode === 'friend' && (r.humans ?? 0) < 2) return;
  if (s.deletion?.status === 'deleting') return;
  const horse = r.horseId ? s.horses.find((h) => h.id === r.horseId) ?? null : null;
  for (const a of eachAcc(m, s, now)) {
    a.races += 1;
    const won = r.place === 1;
    if (r.place >= 1 && r.place <= 3) a.top3 += 1;
    if (r.place >= 1 && (a.bestPlace === null || r.place < a.bestPlace || (r.place === a.bestPlace && r.fieldSize > a.bestPlaceField))) {
      a.bestPlace = r.place; a.bestPlaceField = r.fieldSize;
    }
    if (horse) {
      const h = (a.byHorse[horse.id] ??= { horseName: horse.name, races: 0, wins: 0, first: now });
      h.horseName = horse.name; h.races += 1; if (won) h.wins += 1;
    }
    const style = r.details?.style;
    if (style) a.byStyle[style] = (a.byStyle[style] ?? 0) + 1;
    if (won) {
      a.wins += 1;
      a.streak += 1;
      a.bestStreak = Math.max(a.bestStreak, a.streak);
      const w: RecapWin = { raceId: r.raceId, at: now, horseName: horse?.name ?? null, trackId: r.details?.trackId ?? null, fieldSize: r.fieldSize };
      a.firstWin ??= w;
      if (!a.bigWin || w.fieldSize > a.bigWin.fieldSize) a.bigWin = w;
    } else a.streak = 0;
  }
}

/** REQ-RECAP-001: a contribution the team goal counted (playerGoalRace / playerGoalTa returned it). */
export function noteRecapTeamGoal(m: Master, s: PlayerState, g: { races: number; wins: number; taPb: number } | null, now: number) {
  if (!g || !seasonRecapConfig(m)) return;
  for (const a of eachAcc(m, s, now)) a.teamGoal += g.races + g.wins + g.taPb;
}

/** REQ-RECAP-001: a settled rival week (settleWeek runs once per week). */
export function noteRecapRival(m: Master, s: PlayerState, outcome: string, now: number) {
  if (!seasonRecapConfig(m) || (outcome !== 'win' && outcome !== 'lose' && outcome !== 'draw')) return;
  for (const a of eachAcc(m, s, now)) a.rival[outcome] += 1;
}

/** REQ-RECAP-001: a new saved replay (commitSave, not on a repeated save of the same race). */
export function noteRecapReplaySaved(m: Master, s: PlayerState, now: number) {
  if (!seasonRecapConfig(m)) return;
  for (const a of eachAcc(m, s, now)) a.replaysSaved += 1;
}

// ------------------------------------------------------------------------------------------------ snapshot

const classIndex = (m: Master, id: string) => m.progression.classes.findIndex((c) => c.id === id);

function rankFor(m: Master, s: PlayerState, kind: RecapKind, periodId: string): RecapSnapshot['rank'] {
  const recs = s.seasonHistory.filter((h) => (kind === 'season' ? h.seasonId === periodId : h.seasonId.startsWith(`${periodId}-`)) && h.races > 0);
  if (recs.length === 0) return null;
  let best: RecapSnapshot['rank'] = null;
  let bestKey = -1;
  for (const h of recs) {
    const top = Math.max(classIndex(m, h.classId), classIndex(m, h.nextClassId));
    const promoted = classIndex(m, h.nextClassId) > classIndex(m, h.classId);
    const cand = { classId: h.classId, nextClassId: h.nextClassId, finalRank: h.rank, promoted, seasonId: h.seasonId };
    // highest class reached (incl. a promotion) → best final rank in the class held → the later season
    const better = top > bestKey || (top === bestKey && best !== null && (cand.finalRank ?? Infinity) < (best.finalRank ?? Infinity));
    if (best === null || better) { best = cand; bestKey = top; }
  }
  return best;
}

function timeAttackFor(m: Master, s: PlayerState, kind: RecapKind, periodId: string, from: number, to: number): RecapSnapshot['timeAttack'] {
  const ta = s.timeAttack;
  if (!ta) return null;
  const cands = Object.entries(ta.seasonBest)
    .filter(([key, b]) => (kind === 'season' ? key.startsWith(`${periodId}:`) : b.at >= from && b.at < to))
    .map(([key, b]) => {
      const trackId = key.slice(key.indexOf(':') + 1);
      return { trackId, timeMs: b.timeMs, horseName: b.horseName, courseBest: ta.allTimeBest[trackId]?.sessionId === b.sessionId, at: b.at };
    });
  if (kind === 'year') {
    // one record per course: the fastest of the year
    const byTrack = new Map<string, (typeof cands)[number]>();
    for (const c of cands) { const p = byTrack.get(c.trackId); if (!p || c.timeMs < p.timeMs) byTrack.set(c.trackId, c); }
    cands.splice(0, cands.length, ...byTrack.values());
  }
  cands.sort((a, b) => Number(b.courseBest) - Number(a.courseBest) || b.at - a.at || a.trackId.localeCompare(b.trackId));
  const c = cands[0];
  return c ? { trackId: c.trackId, timeMs: c.timeMs, horseName: c.horseName, courseBest: c.courseBest } : null;
}

function momentsFor(snap: Omit<RecapSnapshot, 'moments'>, a: RecapAcc, hallFirst: { horseName: string; at: number } | null, max: number): RecapMoment[] {
  const out: RecapMoment[] = [];
  const base = { horseName: null, trackId: null, n: null, from: null, to: null };
  if (snap.rank?.promoted) out.push({ ...base, kind: 'promotion', from: snap.rank.classId, to: snap.rank.nextClassId, at: snap.to - 1 });
  if (hallFirst) out.push({ ...base, kind: 'hall', horseName: hallFirst.horseName, at: hallFirst.at });
  if (a.firstWin) out.push({ ...base, kind: 'first_win', horseName: a.firstWin.horseName, trackId: a.firstWin.trackId, at: a.firstWin.at });
  if (a.bigWin && a.bigWin.fieldSize >= BIG_WIN_MIN_FIELD && a.bigWin.raceId !== a.firstWin?.raceId) {
    out.push({ ...base, kind: 'big_win', horseName: a.bigWin.horseName, trackId: a.bigWin.trackId, n: a.bigWin.fieldSize, at: a.bigWin.at });
  }
  if (a.bestStreak >= 2) out.push({ ...base, kind: 'streak', n: a.bestStreak, at: snap.to - 1 });
  if (snap.timeAttack?.courseBest) out.push({ ...base, kind: 'ta_best', horseName: snap.timeAttack.horseName, trackId: snap.timeAttack.trackId, at: snap.to - 1 });
  return out.slice(0, max);
}

/** Builds the snapshot of a closed record (pure; the caller stores it). Null when the period recorded nothing. */
export function buildSnapshot(m: Master, s: PlayerState, kind: RecapKind, a: RecapAcc, now: number): RecapSnapshot | null {
  const c = seasonRecapConfig(m) ?? DEFAULT_SEASON_RECAP;
  const { from, to } = periodBounds(m, kind, a.periodId);
  const rank = rankFor(m, s, kind, a.periodId);
  const timeAttack = timeAttackFor(m, s, kind, a.periodId, from, to);
  const inducted = (s.hall?.entries ?? []).filter((e) => e.inductedAt >= from && e.inductedAt < to).sort((x, y) => x.inductedAt - y.inductedAt);
  const rival = a.rival.win + a.rival.lose + a.rival.draw > 0 ? { ...a.rival } : null;
  const anything = a.races > 0 || timeAttack !== null || inducted.length > 0 || rival !== null || a.teamGoal > 0 || a.replaysSaved > 0;
  if (!anything) return null;
  const horses = Object.entries(a.byHorse).sort(([ia, x], [ib, y]) => y.races - x.races || y.wins - x.wins || x.first - y.first || ia.localeCompare(ib));
  const top = horses[0];
  const styles = STYLE_ORDER.map((st) => ({ style: st, races: a.byStyle[st] ?? 0 })).filter((x) => x.races > 0).sort((x, y) => y.races - x.races || STYLE_ORDER.indexOf(x.style) - STYLE_ORDER.indexOf(y.style));
  // REQ-RECAP-006: the record began after the period started (and not because the account itself is newer)
  const since = a.since - Math.max(from, s.createdAt) > SINCE_SLACK_MS ? a.since : null;
  const snap: Omit<RecapSnapshot, 'moments'> = {
    id: recapId(kind, a.periodId), kind, periodId: a.periodId, from, to, builtAt: now, since,
    short: a.races < c.shortBelowRaces,
    races: a.races, wins: a.wins, top3: a.top3,
    bestFinish: a.bestPlace !== null ? { place: a.bestPlace, fieldSize: a.bestPlaceField } : null,
    rank,
    horse: top ? { horseId: top[0], horseName: top[1].horseName, races: top[1].races, wins: top[1].wins } : null,
    timeAttack,
    style: styles[0] ?? null,
    rival,
    teamGoal: a.teamGoal,
    hall: { count: inducted.length, horses: inducted.slice(0, 3).map((e) => ({ horseName: e.horseName })) },
    replaysSaved: a.replaysSaved,
    openedAt: null, completedAt: null,
  };
  const first = inducted[0];
  return { ...snap, moments: momentsFor(snap, a, first ? { horseName: first.horseName, at: first.inductedAt } : null, c.momentsMax) };
}

function store(m: Master, st: SeasonRecapState, snap: RecapSnapshot) {
  if (st.recaps.some((x) => x.id === snap.id)) return false; // REQ-RECAP-004: one per player per period
  st.recaps.push(snap);
  const c = seasonRecapConfig(m) ?? DEFAULT_SEASON_RECAP;
  for (const kind of ['season', 'year'] as const) {
    const keep = kind === 'season' ? c.keepSeasons : c.keepYears;
    const mine = st.recaps.filter((x) => x.kind === kind).sort((x, y) => y.periodId.localeCompare(x.periodId));
    const drop = new Set(mine.slice(keep).map((x) => x.id));
    if (drop.size) st.recaps = st.recaps.filter((x) => !drop.has(x.id));
  }
  return true;
}

/**
 * REQ-RECAP-002/003/004: at the start of every transaction (after rollSeason), close the records whose period ended.
 * Idempotent: a closed record is replaced by the new period's record, and a snapshot id is stored once.
 * Returns the ids built in this call (the §40 activity entry belongs here — not written in this round).
 */
export function rollRecaps(m: Master, s: PlayerState, now: number): string[] {
  if (!seasonRecapConfig(m)) return [];
  if (s.deletion?.status === 'deleting') return [];
  const st = ensureRecap(s);
  const built: string[] = [];
  for (const kind of ['season', 'year'] as const) {
    const a = st.acc[kind];
    const cur = kind === 'season' ? seasonPeriodId(now) : gameYearOf(m, now);
    if (!a) { st.acc[kind] = newAcc(cur, now); continue; } // the player's first record starts now (REQ-RECAP-006)
    if (a.periodId === cur) continue;
    const snap = buildSnapshot(m, s, kind, a, now);
    if (snap && store(m, st, snap)) built.push(snap.id);
    st.acc[kind] = newAcc(cur, periodBounds(m, kind, cur).from);
  }
  return built;
}

/** REQ-RECAP-005: the rollover job's final class rank, written once; the year recap's class line is chosen again. */
export function attachRecapRank(m: Master, s: PlayerState, seasonId: string) {
  const st = s.seasonRecap;
  if (!st) return;
  const snap = st.recaps.find((x) => x.id === recapId('season', seasonId));
  if (snap?.rank && snap.rank.finalRank === null) snap.rank = rankFor(m, s, 'season', seasonId) ?? snap.rank;
  const year = st.recaps.find((x) => x.id === recapId('year', seasonId.slice(0, 4)));
  if (year) year.rank = rankFor(m, s, 'year', year.periodId);
}

// ------------------------------------------------------------------------------------------------ views

const STYLE_JA: Record<Style, string> = { nige: '逃げ', senko: '先行', sashi: '差し', oikomi: '追込' };
const fmtTime = (ms: number) => { const t = Math.floor(ms / 100); return `${Math.floor(t / 600)}:${String(Math.floor(t / 10) % 60).padStart(2, '0')}.${t % 10}`; };
const dateOf = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);

export function recapTitle(kind: RecapKind, periodId: string) {
  if (kind === 'year') return `${Number(periodId)}年の振り返り`;
  const [y, mo] = periodId.split('-').map(Number) as [number, number];
  return `${y}年${mo}月シーズン`;
}

function courseName(m: Master, trackId: string | null): string | null {
  if (!trackId || !m.tracks.some((t) => t.id === trackId)) return null;
  return rivalTrackName(trackId); // the master track name (tracks.json), translated at the response boundary
}

export function momentText(m: Master, kind: RecapKind, x: RecapMoment): string {
  const course = courseName(m, x.trackId);
  switch (x.kind) {
    case 'promotion': return `${x.from}級から${x.to}級へ昇格`;
    case 'hall': return '殿堂入り';
    case 'first_win':
      if (kind === 'season') return course ? `シーズン初勝利（${course}）` : 'シーズン初勝利';
      return course ? `この年の初勝利（${course}）` : 'この年の初勝利';
    case 'big_win': return `${x.n}頭立てで1着`;
    case 'streak': return `${x.n}連勝`;
    case 'ta_best': return course ? `タイムアタックの自己ベスト（${course}）` : 'タイムアタックの自己ベスト';
  }
}

export interface RecapStep {
  key: string; label: string; value: string | null; unit: string | null; notes: string[];
  horseName?: string; horses?: { horseName: string }[]; moments?: { kind: MomentKind; text: string; horseName: string | null }[];
}
export interface ShareCardData { card: 'summary' | 'horse' | 'moment' | 'rank'; title: string; headline: string; unit: string | null; lines: string[]; horseName: string | null; rank: boolean }

function stepsOf(m: Master, r: RecapSnapshot): RecapStep[] {
  const steps: RecapStep[] = [];
  const add = (x: Omit<RecapStep, 'notes' | 'unit'> & { notes?: string[]; unit?: string | null }) => steps.push({ unit: null, notes: [], ...x });
  add({ key: 'races', label: '走ったレース', value: String(r.races), unit: '戦', notes: r.top3 > 0 ? [`3着以内 ${r.top3}回`] : [] });
  const horseStep = r.horse ? () => add({ key: 'horse', label: 'いちばん一緒に走った馬', value: null, horseName: r.horse!.horseName, notes: [`${r.horse!.races}戦${r.horse!.wins}勝`] }) : null;
  const bestStep = r.bestFinish ? () => add({ key: 'best_finish', label: '最高着順', value: `${r.bestFinish!.place}着`, notes: [`${r.bestFinish!.fieldSize}頭立て`] }) : null;
  if (r.short) {
    // REQ-RECAP-008: the short version — never an empty screen
    bestStep?.();
    horseStep?.();
    add({ key: 'end', label: '次のシーズンも、あなたのペースで。', value: null });
    return steps;
  }
  if (r.races > 0) add({ key: 'wins', label: '勝利', value: String(r.wins), unit: '勝', notes: [`勝率 ${Math.round((r.wins * 100) / r.races)}%`] });
  bestStep?.();
  if (r.rank) {
    const notes: string[] = [];
    if (r.rank.finalRank !== null) notes.push(`最終順位 ${r.rank.finalRank}位`);
    if (r.rank.promoted) notes.push(`${r.rank.classId}級から${r.rank.nextClassId}級へ昇格`);
    add({ key: 'rank', label: '到達したクラス', value: `${r.rank.promoted ? r.rank.nextClassId : r.rank.classId}級`, notes });
  }
  horseStep?.();
  if (r.timeAttack) {
    const course = courseName(m, r.timeAttack.trackId);
    add({ key: 'time_attack', label: 'タイムアタックの記録', value: fmtTime(r.timeAttack.timeMs), horseName: r.timeAttack.horseName, notes: [...(course ? [course] : []), ...(r.timeAttack.courseBest ? ['このコースの自己ベスト'] : [])] });
  }
  if (r.style) add({ key: 'style', label: 'よく使った脚質', value: STYLE_JA[r.style.style], notes: [`${r.style.races}戦`] });
  if (r.rival) add({ key: 'rival', label: 'ライバルとの週', value: `${r.rival.win}勝${r.rival.lose}敗${r.rival.draw}分`, notes: [] });
  if (r.teamGoal > 0) add({ key: 'team', label: '支部への貢献', value: String(r.teamGoal), unit: '回', notes: ['支部の共同目標に数えられた回数'] });
  if (r.hall.count > 0) add({ key: 'hall', label: '殿堂入りした馬', value: String(r.hall.count), unit: '頭', horses: r.hall.horses, notes: [] });
  if (r.replaysSaved > 0) add({ key: 'replays', label: '保存したリプレイ', value: String(r.replaysSaved), unit: '本', notes: [] });
  if (r.moments.length > 0) add({ key: 'moments', label: '名場面', value: null, moments: r.moments.map((x) => ({ kind: x.kind, text: momentText(m, r.kind, x), horseName: x.horseName })) });
  add({ key: 'end', label: 'おつかれさまでした', value: null });
  return steps;
}

/** REQ-RECAP-011: the share cards. Only the player's own horses and numbers; `rank: true` cards are dropped by 「順位を隠す」. */
function shareCardsOf(m: Master, r: RecapSnapshot): ShareCardData[] {
  const title = recapTitle(r.kind, r.periodId);
  const cards: ShareCardData[] = [{ card: 'summary', title, headline: String(r.races), unit: '戦', lines: r.races > 0 ? [`${r.wins}勝・3着以内 ${r.top3}回`] : [], horseName: null, rank: false }];
  if (r.horse) cards.push({ card: 'horse', title, headline: '', unit: null, lines: ['いちばん一緒に走った馬', `${r.horse.races}戦${r.horse.wins}勝`], horseName: r.horse.horseName, rank: false });
  // the first moment that says nothing about the class; a promotion alone is a rank card (hidden by 「順位を隠す」)
  const mo = r.short ? undefined : r.moments.find((x) => x.kind !== 'promotion') ?? r.moments[0];
  if (mo) cards.push({ card: 'moment', title, headline: '', unit: null, lines: ['名場面', momentText(m, r.kind, mo)], horseName: mo.horseName, rank: mo.kind === 'promotion' });
  if (r.rank && !r.short) {
    cards.push({ card: 'rank', title, headline: `${r.rank.promoted ? r.rank.nextClassId : r.rank.classId}級`, unit: null,
      lines: r.rank.finalRank !== null ? [`最終順位 ${r.rank.finalRank}位`] : [], horseName: null, rank: true });
  }
  return cards;
}

const enabledOrThrow = (m: Master) => { if (!seasonRecapConfig(m)) throw new AppError('NOT_FOUND', 'season recaps are not available'); };
const sorted = (st: SeasonRecapState | undefined) => [...(st?.recaps ?? [])].sort((a, b) => b.to - a.to || (a.kind === 'year' ? -1 : 1));

/** GET /v1/recaps */
export function recapsList(m: Master, s: PlayerState) {
  if (!seasonRecapConfig(m)) return { enabled: false as const, recaps: [], unseen: null };
  const list = sorted(s.seasonRecap);
  return {
    enabled: true as const,
    recaps: list.map((r) => ({ id: r.id, kind: r.kind, periodId: r.periodId, title: recapTitle(r.kind, r.periodId), short: r.short, builtAt: r.builtAt, opened: r.openedAt !== null, completed: r.completedAt !== null })),
    unseen: list.find((r) => r.openedAt === null)?.id ?? null,
  };
}

function find(m: Master, s: PlayerState, id: string) {
  enabledOrThrow(m);
  const r = s.seasonRecap?.recaps.find((x) => x.id === id);
  if (!r) throw new AppError('NOT_FOUND', 'no such recap');
  return r;
}

/** GET /v1/recaps/:id */
export function recapView(m: Master, s: PlayerState, id: string) {
  const r = find(m, s, id);
  return {
    id: r.id, kind: r.kind, periodId: r.periodId, title: recapTitle(r.kind, r.periodId), short: r.short,
    sinceNote: r.since !== null ? `${dateOf(r.since)}からの記録です` : null,
    steps: stepsOf(m, r), shareCards: shareCardsOf(m, r), openedAt: r.openedAt, completedAt: r.completedAt,
  };
}

export type RecapStepName = 'open' | 'complete';
/** POST /v1/recaps/:id/progress — the first time is kept (idempotent); KPI recap_open / recap_complete. */
export function recapProgress(m: Master, s: PlayerState, id: string, step: RecapStepName, now: number, emit: Emit) {
  const r = find(m, s, id);
  const field = step === 'open' ? 'openedAt' : 'completedAt';
  const isFirst = r[field] === null;
  if (isFirst) r[field] = now;
  if (step === 'complete' && r.openedAt === null) r.openedAt = now;
  emit({ name: step === 'open' ? 'recap_open' : 'recap_complete', s1: r.kind, s2: r.periodId, s3: r.short ? 'short' : 'full', isFirst });
  return { openedAt: r.openedAt, completedAt: r.completedAt };
}
