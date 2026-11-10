/**
 * REQ-HOF-*: 殿堂 (hall of fame) and the retirement ceremony — contracts/protocol.md §34.
 *
 * - A per-horse career record is kept in the owner's PlayerState from CONFIRMED results only: applyRace (once per
 *   raceId, the same modes REQ-STAT-001 counts), verified time-attack runs (taRecord) and tournament final ranks
 *   (tournamentClose with the registered horse). Nothing a client claims and nothing purchasable writes it.
 * - Retiring a horse through POST /v1/horses/:horseId/retire freezes a ceremony: highlight lines picked by fixed rules
 *   from the record (no randomness) and, when the record meets the criteria, a permanent hall entry (殿堂入り). The
 *   ceremony is produced once per horse; acknowledging it is idempotent.
 * - Hall entries are never removed (breeding, stud lending, renaming keep them); only the account deletion takes them.
 * - Visitors read a public copy in the sharded DirectoryDO (like マイ厩舎, REQ-STABLE-003): friends and members of the
 *   same branch may look, the owner's visibility setting and the block list (team-feed mute) apply both ways, and a
 *   banned / deleting / private / empty hall has no copy. Every refusal answers NOT_FOUND (never says why).
 * - The reward is cosmetic only: the 「殿堂の額縁」 decor (not for sale), once per account at the first induction.
 */
import { AppError } from './errors.js';
import type { Master } from './master.js';
import { moderationOf, type HorseInstance, type PlayerState } from './player.js';
import { appearanceOf, effectiveSilks, type Appearance, type Silks } from './visuals.js';
import type { RaceResultForPlayer } from './rewards.js';
import type { KpiEvent } from './kpi.js';
import { grantReward, logItem } from './items.js';
import { rivalTrackName } from './rival.js';
import { bandOf, chainCompleteOf, goalsOf, horseGoalsConfig, type GoalBand } from './horseGoals.js';

// ------------------------------------------------------------------------------------------- config

export interface HallCriteria {
  /** 殿堂入り when the horse won at least this many counted races (0 = this rule is off). */
  winsMin: number;
  /** 殿堂入り when the horse won a tournament (final rank 1). */
  tournamentWin: boolean;
  /** 殿堂入り when the horse is the player's partner (REQ-UXS-002) and ran at least this many counted races (0 = off). */
  partnerRacesMin: number;
}
export interface HallConfig {
  enabled: boolean;
  criteria: HallCriteria;
  /** Highlight lines on a ceremony / plaque (1..8). */
  highlightsMax: number;
  /** Default and largest page of a hall listing. */
  pageSize: number;
  pageSizeMax: number;
  /** Decor cosmetic granted once at the first induction (must be decor, notForSale, price 0). */
  rewardItemId: string;
}

export const HALL_HARD_LIMITS = { highlightsMax: 8, pageSizeMax: 50, winsMin: 1000, partnerRacesMin: 5000 };
export const HALL_VISIBILITIES = ['friends_team', 'friends', 'private'] as const;
export type HallVisibility = (typeof HALL_VISIBILITIES)[number];

export const hallConfig = (m: Master): HallConfig | null => {
  const c = m.progression.hall;
  return c && c.enabled ? c : null;
};

export function hallProblems(m: Master): string[] {
  const c = m.progression.hall;
  if (!c) return [];
  const p: string[] = [];
  const intIn = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  const H = HALL_HARD_LIMITS;
  if (typeof c.enabled !== 'boolean') p.push('hall.enabled must be a boolean');
  if (!c.criteria) { p.push('hall.criteria is required'); return p; }
  if (!intIn(c.criteria.winsMin, 0, H.winsMin)) p.push(`hall.criteria.winsMin must be 0..${H.winsMin}`);
  if (typeof c.criteria.tournamentWin !== 'boolean') p.push('hall.criteria.tournamentWin must be a boolean');
  if (!intIn(c.criteria.partnerRacesMin, 0, H.partnerRacesMin)) p.push(`hall.criteria.partnerRacesMin must be 0..${H.partnerRacesMin}`);
  if (c.criteria.winsMin === 0 && !c.criteria.tournamentWin && c.criteria.partnerRacesMin === 0) p.push('hall.criteria: at least one rule must be on');
  if (!intIn(c.highlightsMax, 1, H.highlightsMax)) p.push(`hall.highlightsMax must be 1..${H.highlightsMax}`);
  if (!intIn(c.pageSizeMax, 1, H.pageSizeMax)) p.push(`hall.pageSizeMax must be 1..${H.pageSizeMax}`);
  if (!intIn(c.pageSize, 1, c.pageSizeMax ?? H.pageSizeMax)) p.push('hall.pageSize must be 1..pageSizeMax');
  const item = m.items.cosmetics.find((x) => x.id === c.rewardItemId);
  // REQ-HOF-008: the reward is a look that cannot be bought (no paid shortcut to the frame either)
  if (!item) p.push(`hall.rewardItemId: unknown cosmetic ${c.rewardItemId}`);
  else if (item.kind !== 'decor' || !item.notForSale || item.price !== 0) p.push(`hall.rewardItemId ${c.rewardItemId} must be a not-for-sale decor (price 0)`);
  return p;
}

// ------------------------------------------------------------------------------------------- state

export type HallMode = 'ranked' | 'friend' | 'event' | 'tournament';
export interface BiggestWin { raceId: string; mode: HallMode; fieldSize: number; humans: number; trackId: string | null; at: number }
export interface CareerRecord {
  horseId: string;
  races: number; wins: number; places: number;
  byMode: Partial<Record<HallMode, { races: number; wins: number }>>;
  /** Fastest verified time-attack run per course (ms). */
  bestTa: Record<string, { timeMs: number; at: number }>;
  /** Tournament final ranks with this horse (newest last, TOURNAMENTS_KEEP kept; wins are never dropped first). */
  tournaments: { tournamentId: string; name: string; rank: number; at: number }[];
  tournamentWins: number;
  biggestWin: BiggestWin | null;
  /** Ranked races in which the weekly human rival finished behind this horse (REQ-RIVAL-004, when known at the race). */
  rivalWins: number;
  firstRaceAt: number | null; lastRaceAt: number | null;
  /** REQ-HGOAL-003 (§53): tallies the per-horse goals count, written in noteHallRace's guard (absent = none since §53). */
  goal?: { surfaceWins: { turf?: number; dirt?: number }; bandWins: Partial<Record<GoalBand, number>>; rankedPlaces: number };
}
export type HighlightKind = 'tournament_win' | 'partner' | 'wins' | 'biggest_win' | 'rival_wins' | 'ta_best' | 'places' | 'career_span';
export interface Highlight { kind: HighlightKind; text: string; params: Record<string, string | number> }
export type InductReason = 'wins' | 'tournament' | 'partner';
export interface Ceremony {
  horseId: string; horseName: string; retiredAt: number; partner: boolean;
  career: CareerLine; highlights: Highlight[];
  inducted: boolean; reasons: InductReason[];
  /** First induction of the account: the frame was granted with this ceremony. */
  rewardItemId: string | null;
  ackedAt: number | null;
}
export interface CareerLine { races: number; wins: number; places: number; tournamentWins: number; firstRaceAt: number | null; lastRaceAt: number | null }
export interface HallEntryRecord {
  horseId: string; horseName: string; rarity: HorseInstance['rarity']; sex: HorseInstance['sex']; appearance: Appearance;
  partner: boolean; reasons: InductReason[]; inductedAt: number; career: CareerLine; highlights: Highlight[];
}
export interface HallState {
  careers: Record<string, CareerRecord>;
  ceremonies: Record<string, Ceremony>;
  entries: HallEntryRecord[];
  visibility: HallVisibility;
  /** The frame was granted (once per account). */
  rewarded: boolean;
}

const TOURNAMENTS_KEEP = 20;

export function ensureHall(s: PlayerState): HallState {
  s.hall ??= { careers: {}, ceremonies: {}, entries: [], visibility: 'friends_team', rewarded: false };
  return s.hall;
}
const peek = (s: PlayerState): HallState | undefined => s.hall;

const newCareer = (horseId: string): CareerRecord => ({
  horseId, races: 0, wins: 0, places: 0, byMode: {}, bestTa: {}, tournaments: [], tournamentWins: 0, biggestWin: null, rivalWins: 0, firstRaceAt: null, lastRaceAt: null,
});
const careerOf = (s: PlayerState, horseId: string) => {
  const h = ensureHall(s);
  return (h.careers[horseId] ??= newCareer(horseId));
};
const owns = (s: PlayerState, horseId: string | undefined | null): horseId is string => !!horseId && s.horses.some((h) => h.id === horseId);

// ------------------------------------------------------------------------------------------- recording (confirmed results)

const HALL_MODES: readonly string[] = ['ranked', 'friend', 'event', 'tournament'];
const MODE_WEIGHT: Record<HallMode, number> = { tournament: 4, event: 3, ranked: 2, friend: 1 };

/** Bigger win first: mode (tournament > event > ranked > friend), then field size, then human riders, then the earlier one. */
export const biggerWin = (a: BiggestWin, b: BiggestWin | null) =>
  !b || MODE_WEIGHT[a.mode] - MODE_WEIGHT[b.mode] > 0
  || (a.mode === b.mode && (a.fieldSize > b.fieldSize || (a.fieldSize === b.fieldSize && a.humans > b.humans)));

/**
 * REQ-HOF-001: a confirmed race (called inside applyRace's per-race guard, so once per raceId). Counts the same races
 * as the player statistics (REQ-STAT-001): ranked, event, tournament, and friend races with at least 2 human riders.
 * Void and tutorial races and results without a horse id (older rooms) are not counted.
 */
export function noteHallRace(m: Master, s: PlayerState, r: RaceResultForPlayer, now: number, rivalWin: boolean) {
  if (!hallConfig(m) || r.void || !HALL_MODES.includes(r.mode) || !owns(s, r.horseId)) return;
  if (r.mode === 'friend' && (r.humans ?? 0) < 2) return;
  const mode = r.mode as HallMode;
  const c = careerOf(s, r.horseId);
  c.races += 1;
  const bm = (c.byMode[mode] ??= { races: 0, wins: 0 });
  bm.races += 1;
  if (r.place === 1) {
    c.wins += 1;
    bm.wins += 1;
    const w: BiggestWin = { raceId: r.raceId, mode, fieldSize: r.fieldSize, humans: r.humans ?? 1, trackId: r.details?.trackId ?? null, at: now };
    if (biggerWin(w, c.biggestWin)) c.biggestWin = w;
  }
  if (r.place >= 1 && r.place <= 3) c.places += 1;
  if (rivalWin && r.mode === 'ranked') c.rivalWins += 1;
  // REQ-HGOAL-003 (§53): the same counted race also feeds the per-horse goals (surface / distance band of the win, ranked top 3)
  const g = (c.goal ??= { surfaceWins: {}, bandWins: {}, rankedPlaces: 0 });
  const t = r.details?.trackId ? m.tracks.find((x) => x.id === r.details!.trackId) : undefined;
  if (r.place === 1 && t) {
    g.surfaceWins[t.surface] = (g.surfaceWins[t.surface] ?? 0) + 1;
    const b = bandOf(t.distanceM);
    g.bandWins[b] = (g.bandWins[b] ?? 0) + 1;
  }
  if (r.mode === 'ranked' && r.place >= 1 && r.place <= 3) g.rankedPlaces += 1;
  c.firstRaceAt ??= now;
  c.lastRaceAt = now;
}

/** REQ-HOF-001: a verified, finished time-attack run (taRecord, once per session). Keeps the fastest per course. */
export function noteHallTa(m: Master, s: PlayerState, horseId: string, trackId: string, timeMs: number, now: number) {
  if (!hallConfig(m) || !owns(s, horseId) || !Number.isFinite(timeMs) || timeMs <= 0) return;
  const c = careerOf(s, horseId);
  const prev = c.bestTa[trackId];
  if (!prev || timeMs < prev.timeMs) c.bestTa[trackId] = { timeMs, at: now };
}

/** REQ-HOF-001: a tournament final rank (tournamentClose, behind its once-per-tournament guard) with the registered horse. */
export function noteHallTournament(m: Master, s: PlayerState, horseId: string | null | undefined, tournamentId: string, name: string, rank: number, now: number) {
  if (!hallConfig(m) || !owns(s, horseId) || !Number.isInteger(rank) || rank < 1) return;
  const c = careerOf(s, horseId);
  if (c.tournaments.some((t) => t.tournamentId === tournamentId)) return;
  c.tournaments.push({ tournamentId, name, rank, at: now });
  if (rank === 1) c.tournamentWins += 1;
  // bounded: drop the oldest non-win first (a title is a career highlight)
  while (c.tournaments.length > TOURNAMENTS_KEEP) {
    const i = c.tournaments.findIndex((t) => t.rank !== 1);
    c.tournaments.splice(i >= 0 ? i : 0, 1);
  }
}

// ------------------------------------------------------------------------------------------- rules (deterministic)

const isPartner = (s: PlayerState, horseId: string) => s.flags.partnerHorseId === horseId;
const lineOf = (c: CareerRecord): CareerLine => ({ races: c.races, wins: c.wins, places: c.places, tournamentWins: c.tournamentWins, firstRaceAt: c.firstRaceAt, lastRaceAt: c.lastRaceAt });
const DAY_MS = 86_400_000;
const MODE_JA: Record<HallMode, string> = { tournament: '大会', event: 'イベント', ranked: 'ランク戦', friend: 'フレンド戦' };
const fmtTime = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  const sec = ((ms % 60_000) / 1000).toFixed(1).padStart(4, '0');
  return `${m}:${sec}`;
};

/** REQ-HOF-005: which criteria the record meets (empty = not inducted). Only counted race results; no item, coin or rarity. */
export function inductReasons(cfg: HallConfig, c: CareerRecord, partner: boolean): InductReason[] {
  const out: InductReason[] = [];
  if (cfg.criteria.winsMin > 0 && c.wins >= cfg.criteria.winsMin) out.push('wins');
  if (cfg.criteria.tournamentWin && c.tournamentWins > 0) out.push('tournament');
  if (partner && cfg.criteria.partnerRacesMin > 0 && c.races >= cfg.criteria.partnerRacesMin) out.push('partner');
  return out;
}

/**
 * REQ-HOF-003: the highlight lines, picked in this fixed order from the record (each only when it has data), at most
 * highlightsMax: tournament title → partner → wins → biggest win → rival wins → best time attack → top-3 finishes →
 * career span. The time-attack line names the course of the most recent best (ties: course id). No randomness.
 */
export function pickHighlights(m: Master, cfg: HallConfig, c: CareerRecord, partner: boolean): Highlight[] {
  const trackName = (id: string | null) => (id ? rivalTrackName(id) : '');
  const out: Highlight[] = [];
  const titles = c.tournaments.filter((t) => t.rank === 1);
  if (titles.length > 0) {
    const first = titles.slice().sort((a, b) => a.at - b.at || a.tournamentId.localeCompare(b.tournamentId))[0]!;
    out.push(titles.length === 1
      ? { kind: 'tournament_win', text: `大会「${first.name}」優勝`, params: { tournament: first.name, n: 1 } }
      : { kind: 'tournament_win', text: `大会優勝${titles.length}回（初優勝「${first.name}」）`, params: { tournament: first.name, n: titles.length } });
  }
  if (partner && c.races > 0) out.push({ kind: 'partner', text: `最初の相棒として${c.races}戦をともに走った`, params: { n: c.races } });
  if (c.wins > 0) out.push({ kind: 'wins', text: `通算${c.races}戦${c.wins}勝`, params: { races: c.races, wins: c.wins } });
  if (c.biggestWin) {
    const b = c.biggestWin;
    const course = trackName(b.trackId);
    out.push(course
      ? { kind: 'biggest_win', text: `最大の勝利：${course}の${MODE_JA[b.mode]}（${b.fieldSize}頭立て）`, params: { course, mode: MODE_JA[b.mode], n: b.fieldSize } }
      : { kind: 'biggest_win', text: `最大の勝利：${MODE_JA[b.mode]}（${b.fieldSize}頭立て）`, params: { mode: MODE_JA[b.mode], n: b.fieldSize } });
  }
  if (c.rivalWins > 0) out.push({ kind: 'rival_wins', text: `ライバルに${c.rivalWins}回先着`, params: { n: c.rivalWins } });
  const ta = Object.entries(c.bestTa).sort((a, b) => b[1].at - a[1].at || a[0].localeCompare(b[0]))[0];
  if (ta) out.push({ kind: 'ta_best', text: `タイムアタック ${trackName(ta[0])}：${fmtTime(ta[1].timeMs)}`, params: { course: trackName(ta[0]), time: fmtTime(ta[1].timeMs) } });
  if (c.places > 0 && c.wins === 0) out.push({ kind: 'places', text: `3着以内${c.places}回`, params: { n: c.places } });
  if (c.firstRaceAt !== null && c.lastRaceAt !== null) {
    const days = Math.max(1, Math.floor((c.lastRaceAt - c.firstRaceAt) / DAY_MS) + 1);
    out.push({ kind: 'career_span', text: `現役${days}日・${c.races}戦`, params: { days, n: c.races } });
  }
  return out.slice(0, cfg.highlightsMax);
}

// ------------------------------------------------------------------------------------------- retirement

/**
 * REQ-HOF-003/004/005/008: called once when the horse is retired through the retire endpoint (retire() refuses a horse
 * that is not active, so this never runs twice for a horse). Freezes the ceremony, inducts a qualifying horse and grants
 * the frame at the account's first induction. A horse already holding a ceremony keeps it.
 */
export function noteHallRetire(m: Master, s: PlayerState, h: HorseInstance, now: number, emit?: (e: KpiEvent) => void): Ceremony | null {
  const cfg = hallConfig(m);
  if (!cfg) return null;
  const st = ensureHall(s);
  const existing = st.ceremonies[h.id];
  if (existing) return existing;
  const c = st.careers[h.id] ?? newCareer(h.id);
  const partner = isPartner(s, h.id);
  const reasons = inductReasons(cfg, c, partner);
  const highlights = pickHighlights(m, cfg, c, partner);
  const inducted = reasons.length > 0 && !st.entries.some((e) => e.horseId === h.id);
  let rewardItemId: string | null = null;
  if (inducted) {
    st.entries.push({ horseId: h.id, horseName: h.name, rarity: h.rarity, sex: h.sex, appearance: appearanceOf(h, s.id), partner, reasons, inductedAt: now, career: lineOf(c), highlights });
    if (!st.rewarded) {
      st.rewarded = true;
      if ((s.items[cfg.rewardItemId] ?? 0) === 0) {
        grantReward(s, { items: [{ itemId: cfg.rewardItemId, qty: 1 }] }, now, 'hall of fame first induction', `hall:${h.id}`);
        logItem(s, now, cfg.rewardItemId, 1, 'hall_induction', `hall:${h.id}`);
        rewardItemId = cfg.rewardItemId;
      }
    }
    emit?.({ name: 'hof_induct', s1: reasons.join('+'), s2: partner ? 'partner' : '', count: c.races, value: c.wins });
  }
  const cer: Ceremony = { horseId: h.id, horseName: h.name, retiredAt: now, partner, career: lineOf(c), highlights, inducted, reasons, rewardItemId, ackedAt: null };
  st.ceremonies[h.id] = cer;
  return cer;
}

/** REQ-HOF-004: POST /v1/hall/ceremonies/:horseId/ack — idempotent (a repeat returns the first acknowledgement). */
export function ackCeremony(s: PlayerState, horseId: string, now: number) {
  const cer = peek(s)?.ceremonies[horseId];
  if (!cer) throw new AppError('NOT_FOUND', 'no retirement ceremony for this horse');
  const already = cer.ackedAt !== null;
  if (!already) cer.ackedAt = now;
  return { horseId, ackedAt: cer.ackedAt!, already };
}

export function setHallVisibility(s: PlayerState, v: string) {
  if (!(HALL_VISIBILITIES as readonly string[]).includes(v)) throw new AppError('BAD_REQUEST', `visibility must be one of ${HALL_VISIBILITIES.join(', ')}`);
  ensureHall(s).visibility = v as HallVisibility;
  return { visibility: v as HallVisibility };
}

// ------------------------------------------------------------------------------------------- views

/** A plaque as shown (my hall and visitors). `horseName` follows the live horse (support name resets reach it). */
export interface Plaque extends HallEntryRecord { frame: boolean; goalsComplete?: boolean }
/** REQ-HGOAL-009 (§53): `goalsComplete` = the horse finished its goal chain (flair only; absent when goals are off or not done). */
const plaqueOf = (m: Master, s: PlayerState, e: HallEntryRecord, frame: boolean): Plaque => ({
  ...e, horseName: s.horses.find((h) => h.id === e.horseId)?.name ?? e.horseName, frame, ...(chainCompleteOf(m, s, e.horseId) ? { goalsComplete: true } : {}),
});

const sortEntries = (xs: Plaque[]) => xs.sort((a, b) => b.inductedAt - a.inductedAt || a.horseId.localeCompare(b.horseId));
const cursorOf = (e: Plaque) => `${e.inductedAt}_${e.horseId}`;

/** Keyset pagination, newest first. Cursor = `<inductedAt>_<horseId>` of the last entry seen. */
export function pageOf(cfg: HallConfig, all: Plaque[], cursor: string | null, limit: number | null) {
  const n = limit === null ? cfg.pageSize : Math.max(1, Math.min(cfg.pageSizeMax, Math.floor(limit)));
  const sorted = sortEntries(all.slice());
  let start = 0;
  if (cursor) {
    const mt = /^(\d{1,16})_(.{1,128})$/.exec(cursor);
    if (!mt) throw new AppError('BAD_REQUEST', 'bad cursor');
    const at = Number(mt[1]);
    const id = mt[2]!;
    start = sorted.findIndex((e) => e.inductedAt < at || (e.inductedAt === at && e.horseId.localeCompare(id) > 0));
    if (start < 0) start = sorted.length;
  }
  const entries = sorted.slice(start, start + n);
  const more = start + n < sorted.length;
  return { entries, nextCursor: more && entries.length ? cursorOf(entries[entries.length - 1]!) : null, total: sorted.length };
}

const frameOwned = (cfg: HallConfig, s: PlayerState) => (s.items[cfg.rewardItemId] ?? 0) > 0;
const criteriaView = (cfg: HallConfig) => ({ winsMin: cfg.criteria.winsMin, tournamentWin: cfg.criteria.tournamentWin, partnerRacesMin: cfg.criteria.partnerRacesMin });
const NOTICE = '殿堂入りは確定したレースの成績だけで決まります（購入やアイテムでは決まりません）。';

function requireCfg(m: Master): HallConfig {
  const cfg = hallConfig(m);
  if (!cfg) throw new AppError('NOT_FOUND', 'the hall of fame is not available');
  return cfg;
}

/** REQ-HOF-009: GET /v1/hall — my plaques (paginated), ceremonies not yet shown, criteria, the frame and my visibility. */
export function myHallView(m: Master, s: PlayerState, cursor: string | null, limit: number | null) {
  const cfg = requireCfg(m);
  const st = peek(s);
  const frame = frameOwned(cfg, s);
  const page = pageOf(cfg, (st?.entries ?? []).map((e) => plaqueOf(m, s, e, frame)), cursor, limit);
  const pending = Object.values(st?.ceremonies ?? {}).filter((c) => c.ackedAt === null).sort((a, b) => b.retiredAt - a.retiredAt || a.horseId.localeCompare(b.horseId)).slice(0, 20)
    .map((c) => ({ ...c, horseName: s.horses.find((h) => h.id === c.horseId)?.name ?? c.horseName }));
  return {
    ...page, relation: 'self' as const, visibility: st?.visibility ?? 'friends_team',
    frame: { itemId: cfg.rewardItemId, owned: frame }, criteria: criteriaView(cfg), pendingCeremonies: pending, notice: NOTICE,
  };
}

/** REQ-HOF-010: GET /v1/horses/:horseId/career — the record, progress toward each rule, the ceremony and the plaque. */
export function horseCareerView(m: Master, s: PlayerState, horseId: string) {
  const cfg = requireCfg(m);
  const h = s.horses.find((x) => x.id === horseId);
  if (!h) throw new AppError('HORSE_NOT_FOUND', horseId);
  const st = peek(s);
  const c = st?.careers[horseId] ?? newCareer(horseId);
  const partner = isPartner(s, horseId);
  const reasons = inductReasons(cfg, c, partner);
  const entry = st?.entries.find((e) => e.horseId === horseId) ?? null;
  const cer = st?.ceremonies[horseId] ?? null;
  return {
    horseId, horseName: h.name, status: h.status, partner,
    career: { ...lineOf(c), byMode: c.byMode, bestTa: c.bestTa, tournaments: c.tournaments.slice().sort((a, b) => b.at - a.at), biggestWin: c.biggestWin, rivalWins: c.rivalWins },
    progress: {
      wins: cfg.criteria.winsMin > 0 ? { have: c.wins, need: cfg.criteria.winsMin } : null,
      tournamentWin: cfg.criteria.tournamentWin ? c.tournamentWins > 0 : null,
      partnerRaces: partner && cfg.criteria.partnerRacesMin > 0 ? { have: c.races, need: cfg.criteria.partnerRacesMin } : null,
    },
    qualifies: reasons.length > 0, reasons,
    /** What the ceremony would show if the horse retired now (frozen at retirement). */
    preview: h.status === 'active' ? pickHighlights(m, cfg, c, partner) : null,
    ceremony: cer ? { ...cer, horseName: h.name } : null,
    entry: entry ? plaqueOf(m, s, entry, frameOwned(cfg, s)) : null,
    /** REQ-HGOAL-009 (§53): the goal chain in one line (null when goals are off). */
    goals: horseGoalsConfig(m) ? (() => { const g = goalsOf(m, s, h); const d = g.filter((x) => x.done).length; return { doneCount: d, total: g.length, chainComplete: d === g.length }; })() : null,
  };
}

// ------------------------------------------------------------------------------------------- public copy & visiting

/** What visitors may read (copied to the directory). `teamId`, `visibility` and `blocked` never leave the server. */
export interface HallSnapshot {
  v: 1;
  playerId: string; displayName: string; titleId: string | null; silks: Silks;
  teamId: string | null; visibility: Exclude<HallVisibility, 'private'>; blocked: string[];
  frame: boolean;
  entries: Plaque[];
  updatedAt: number;
}

const blockList = (s: PlayerState): string[] => (s as PlayerState & { teamFeed?: { muted: string[] } }).teamFeed?.muted ?? [];

/** REQ-HOF-011: the public copy, or null (no entries, private, banned, deletion running, hall disabled). */
export function hallSnapshot(m: Master, s: PlayerState, now: number): HallSnapshot | null {
  const cfg = hallConfig(m);
  const st = peek(s);
  if (!cfg || !st || st.entries.length === 0 || st.visibility === 'private') return null;
  if (moderationOf(s, now) === 'banned' || s.deletion?.status === 'deleting' || s.deletion?.status === 'scheduled') return null;
  const frame = frameOwned(cfg, s);
  return {
    v: 1, playerId: s.id, displayName: s.profile.displayName, titleId: s.profile.titleId,
    silks: effectiveSilks(s.profile.silks, `p:${s.id}`, m.bannedSilks),
    teamId: s.team?.teamId ?? null, visibility: st.visibility, blocked: [...blockList(s)].sort(),
    frame, entries: sortEntries(st.entries.map((e) => plaqueOf(m, s, e, frame))), updatedAt: Math.max(...st.entries.map((e) => e.inductedAt)),
  };
}

/** Change detector for PlayerService.tx ('' = nothing published). */
export const hallSnapshotKey = (m: Master, s: PlayerState, now: number) => {
  const snap = hallSnapshot(m, s, now);
  return snap ? JSON.stringify(snap) : '';
};

export type HallRelation = 'self' | 'friend' | 'team';
/** The visitor's side, read from the visitor's own object (friends, branch, block list). */
export interface HallViewer { friendIds: string[]; teamId: string | null; blocked: string[] }
export const hallViewerOf = (s: PlayerState): HallViewer => ({ friendIds: [...s.friends.ids], teamId: s.team?.teamId ?? null, blocked: [...blockList(s)] });

/**
 * REQ-HOF-012: may this viewer see the copy? Friend (either list) or the same branch; `friends` visibility needs a friend;
 * blocked either way → no. Null = refuse (the caller answers NOT_FOUND, the same as no hall).
 */
export function hallRelation(snap: HallSnapshot, viewerId: string, v: HallViewer): HallRelation | null {
  if (snap.blocked.includes(viewerId) || v.blocked.includes(snap.playerId)) return null;
  if (v.friendIds.includes(snap.playerId)) return 'friend';
  if (snap.visibility === 'friends_team' && v.teamId !== null && v.teamId === snap.teamId) return 'team';
  return null;
}

/** Public copies, sharded by owner in DirectoryDO (production) or in memory (tests). */
export interface HallDirectory {
  put(x: HallSnapshot): Promise<void>;
  remove(playerId: string): Promise<void>;
  get(playerId: string): Promise<HallSnapshot | null>;
}
export class MemoryHallDirectory implements HallDirectory {
  readonly rows = new Map<string, HallSnapshot>();
  async put(x: HallSnapshot) { this.rows.set(x.playerId, structuredClone(x)); }
  async remove(id: string) { this.rows.delete(id); }
  async get(id: string) { return this.rows.get(id) ?? null; }
}

/** Per-player steps (PlayerDO RPC in production, PlayerService in tests). */
export interface HallPlayers {
  /** My hall (+ the hof_view KPI, relation self; no state is written). */
  mine(u: string, cursor: string | null, limit: number | null): Promise<ReturnType<typeof myHallView>>;
  /** The visitor's own object, read only: friends, branch, block list. */
  viewerOf(u: string): Promise<HallViewer>;
  /** The hof_view KPI of a visit (no state is written). */
  noteView(u: string, relation: HallRelation, count: number): Promise<unknown>;
}

export class HallService {
  constructor(private readonly p: HallPlayers, private readonly dir: HallDirectory, private readonly cfg: () => HallConfig | null) {}

  mine(u: string, cursor: string | null, limit: number | null) { return this.p.mine(u, cursor, limit); }

  /** REQ-HOF-012/013: GET /v1/hall/:playerId — the directory copy (never the owner's object). */
  async visit(u: string, target: string, cursor: string | null, limit: number | null) {
    const cfg = this.cfg();
    if (!cfg) throw new AppError('NOT_FOUND', 'the hall of fame is not available');
    if (u === target) return this.p.mine(u, cursor, limit);
    const snap = await this.dir.get(target);
    if (!snap) throw new AppError('NOT_FOUND', 'no hall to show');
    const v = await this.p.viewerOf(u);
    const relation = hallRelation(snap, u, v);
    if (!relation) throw new AppError('NOT_FOUND', 'no hall to show');
    const page = pageOf(cfg, snap.entries, cursor, limit);
    await this.p.noteView(u, relation, page.entries.length);
    return {
      owner: { playerId: snap.playerId, displayName: snap.displayName, titleId: snap.titleId, silks: snap.silks },
      relation, ...page, frame: { itemId: cfg.rewardItemId, owned: snap.frame },
    };
  }

  /** Account deletion: drops the visitors' copy (idempotent; the hall itself goes with the player's state). */
  async removeHall(playerId: string) {
    await this.dir.remove(playerId);
    return { removed: true };
  }
}
