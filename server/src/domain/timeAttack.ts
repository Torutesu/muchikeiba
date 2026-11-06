import { timeAttackRuleset, type Ruleset } from './ruleset.js';
import { AppError } from './errors.js';
import { trackById, type Master, type Reward } from './master.js';
import type { PlayerState } from './player.js';
import { getHorse } from './horses.js';
import { grantReward } from './items.js';
import { buildRaceConfig, toRaceHorse } from './raceConfig.js';
import type { Rng } from './rng.js';
import { inputTripleSchema, type InputTriple, type RaceStartConfig, type ReplayLog, type VerifierOutput } from './schemas.js';
import { dayRule, gameDayKey, jstMonthKey, sameGameDay, type DayRule } from './time.js';

/**
 * Time attack (REQ-TA-*). The player races alone on the device (OfflineRace) against the clock and
 * optional ghosts, then submits only their inputs. The server re-simulates the run with the config it
 * issued (C# verifier), so a time is recorded only if the same engine reproduces it.
 *
 * Pure logic on one PlayerState; orchestration (tokens, verifier, leaderboard, ghost storage) lives in
 * src/race/timeAttack.ts.
 */

export interface TimeAttackConfig {
  /** Stat cap applied to the player's horse (same normalisation as ranked, REQ-TA-002). */
  statCap: number;
  /** Sessions a player may start per JST day (REQ-TA-004). */
  maxAttemptsPerDay: number;
  /** Session lifetime: a run must be submitted within this time after start. */
  sessionTtlMs: number;
  /** Most inputs accepted in one submission (anti-abuse; a real run needs well under 200). */
  maxInputs: number;
  /** Sessions kept per player (older ones are pruned). */
  keepSessions: number;
  /** Personal-best milestones (REQ-TA-007): reached once ever per milestone id. trackId null = any track. */
  milestones: { id: string; trackId: string | null; maxTimeMs: number | null; reward: Reward }[];
  topN: number;
}

export type TaSessionStatus = 'issued' | 'submitted' | 'verified' | 'rejected';

export interface TaSession {
  id: string;
  trackId: string;
  horseId: string;
  seasonId: string;
  config: RaceStartConfig;
  issuedAt: number;
  expiresAt: number;
  status: TaSessionStatus;
  /** Set once verified (returned again on a retried submit). */
  result: TaResult | null;
}

export interface TaBest {
  timeMs: number; finishTick: number; finishFrac: number; sessionId: string; horseId: string; horseName: string; at: number;
}

export interface TimeAttackState {
  sessions: TaSession[];
  /** `bonus`: extra attempts today from a rewarded ad (REQ-AD-008). */
  daily: { date: string; count: number; bonus?: number };
  /** Best per `${seasonId}:${trackId}` (REQ-TA-005) and all time per trackId. */
  seasonBest: Record<string, TaBest>;
  allTimeBest: Record<string, TaBest>;
  milestones: string[];
}

export interface TaResult {
  sessionId: string;
  trackId: string;
  seasonId: string;
  finished: boolean;
  timeMs: number | null;
  finishTick: number | null;
  finishFrac: number | null;
  resultHash: string;
  seasonBest: boolean;
  allTimeBest: boolean;
  previousSeasonBestMs: number | null;
  milestones: { id: string; reward: Reward }[];
}

export const newTimeAttackState = (): TimeAttackState => ({ sessions: [], daily: { date: '', count: 0 }, seasonBest: {}, allTimeBest: {}, milestones: [] });

export function taState(s: PlayerState): TimeAttackState {
  s.timeAttack ??= newTimeAttackState();
  return s.timeAttack;
}

const bestKey = (seasonId: string, trackId: string) => `${seasonId}:${trackId}`;

/** Race time in ms from the gate opening — must match C# OfflineRace.FinishTimeMs exactly. */
export function raceTimeMs(config: RaceStartConfig, finishTick: number, finishFrac: number): number {
  const gate = Number(config.ruleset.gateOpenTick);
  const msPerTick = Math.floor(1000 / config.net.tickHz);
  return (finishTick - gate) * msPerTick + Math.floor((finishFrac * msPerTick) / 65536);
}

/** Lexicographic (tick, frac): smaller is faster. */
const faster = (a: { finishTick: number; finishFrac: number }, b: { finishTick: number; finishFrac: number }) =>
  a.finishTick < b.finishTick || (a.finishTick === b.finishTick && a.finishFrac < b.finishFrac);

/** REQ-TA-001/002/004: issue a session (config is fixed by the server: seed, track, ruleset, normalised horse). */
export function startTimeAttack(m: Master, s: PlayerState, cfg: TimeAttackConfig, trackId: string, horseId: string, sessionId: string, rng: Rng, now: number, baseRuleset?: Ruleset) {
  trackById(m, trackId); // NOT_FOUND for unknown tracks
  const h = getHorse(s, horseId);
  if (h.status !== 'active') throw new AppError('HORSE_NOT_ACTIVE');
  const st = taState(s);
  const today = gameDayKey(now, dayRule(m));
  if (!sameGameDay(st.daily.date, today)) st.daily = { date: today, count: 0 };
  const limit = cfg.maxAttemptsPerDay + (st.daily.bonus ?? 0); // REQ-AD-008: + today's attempts from a rewarded ad
  if (st.daily.count >= limit) throw new AppError('TA_LIMIT_REACHED', `${limit}/day`);
  st.daily.count++;
  const config = buildRaceConfig(m, {
    raceId: `ta_${sessionId}`, mode: 'timeattack', trackId, cpuCount: 0, cpuLevel: 3, statCap: cfg.statCap, rng,
    // REQ-TA-009: the ACTIVE remote-config ruleset (not the built-in default), with the day's form switched off
    // (`+ta`). It is embedded in the session's config, so a ruleset change mid-session never affects this run.
    rulesetOverrides: timeAttackRuleset(baseRuleset),
    humans: [{ playerId: s.id, horse: toRaceHorse(m, h) }],
  });
  const session: TaSession = { id: sessionId, trackId, horseId, seasonId: jstMonthKey(now), config, issuedAt: now, expiresAt: now + cfg.sessionTtlMs, status: 'issued', result: null };
  st.sessions.push(session);
  if (st.sessions.length > cfg.keepSessions) st.sessions.splice(0, st.sessions.length - cfg.keepSessions);
  return { sessionId, config, expiresAt: session.expiresAt, attemptsLeft: limit - st.daily.count };
}

function findSession(s: PlayerState, sessionId: string): TaSession {
  const x = taState(s).sessions.find((q) => q.id === sessionId);
  if (!x) throw new AppError('NOT_FOUND', `session ${sessionId}`);
  return x;
}

/** Structural equality for JSON values (key order independent). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => jsonEqual(x, bb[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * REQ-TA-003: validates a submitted input list for a single-horse run: slot 0 only, client command bits
 * only (no CPU_TAKEOVER/HUMAN_RESUME), strictly increasing ticks inside the race, bounded length.
 */
export function validateTaInputs(config: RaceStartConfig, inputs: unknown, maxInputs: number): InputTriple[] {
  if (!Array.isArray(inputs)) throw new AppError('BAD_REQUEST', 'inputs must be an array');
  if (inputs.length > maxInputs) throw new AppError('BAD_REQUEST', `too many inputs (max ${maxInputs})`);
  const maxTicks = Number(config.ruleset.maxTicks);
  const out: InputTriple[] = [];
  let prev = -1;
  for (const raw of inputs) {
    const r = inputTripleSchema.safeParse(raw);
    if (!r.success) throw new AppError('BAD_REQUEST', 'malformed input');
    const [tick, slot, cmd] = r.data;
    if (slot !== 0) throw new AppError('BAD_REQUEST', 'time attack has one horse (slot 0)');
    if (cmd & ~0x3f || cmd === 0) throw new AppError('BAD_REQUEST', 'invalid command bits');
    if (tick >= maxTicks) throw new AppError('BAD_REQUEST', 'input after maxTicks');
    if (tick <= prev) throw new AppError('BAD_REQUEST', 'inputs must have strictly increasing ticks');
    prev = tick;
    out.push([tick, slot, cmd]);
  }
  return out;
}

export type PrepareOutcome = { kind: 'verify'; log: ReplayLog } | { kind: 'done'; result: TaResult };

/**
 * REQ-TA-003: one submission per session. Marks the session `submitted` and returns the replay log
 * built from the ISSUED config (the client never supplies the config; an echoed one must match).
 * A retried submit of an already verified session with the same result hash returns the stored result.
 */
export function prepareSubmit(s: PlayerState, cfg: TimeAttackConfig, sessionId: string, inputs: unknown, resultHash: string, echoedConfig: unknown, now: number): PrepareOutcome {
  const x = findSession(s, sessionId);
  if (x.status === 'verified' && x.result && x.result.resultHash === resultHash) return { kind: 'done', result: x.result };
  if (x.status !== 'issued') throw new AppError('TA_SESSION_USED');
  if (now > x.expiresAt) throw new AppError('TA_SESSION_EXPIRED');
  if (echoedConfig !== undefined && echoedConfig !== null && !jsonEqual(echoedConfig, x.config)) throw new AppError('TA_CONFIG_MISMATCH');
  const ins = validateTaInputs(x.config, inputs, cfg.maxInputs);
  x.status = 'submitted';
  return { kind: 'verify', log: { v: 1, config: x.config, endTick: -1, inputs: ins } };
}

/** The verifier could not be reached: the run may be submitted again (same session, until it expires). */
export function abortSubmit(s: PlayerState, sessionId: string) {
  const x = findSession(s, sessionId);
  if (x.status === 'submitted') x.status = 'issued';
  return { sessionId, status: x.status };
}

/**
 * REQ-TA-003/005/007: apply the verifier's re-simulation. A run whose hash differs from what the client
 * computed is rejected (tampered or desynced client) and nothing is recorded.
 */
export function recordResult(m: Master, s: PlayerState, cfg: TimeAttackConfig, sessionId: string, out: VerifierOutput, claimedHash: string, now: number): TaResult | { rejected: true; sessionId: string } {
  const x = findSession(s, sessionId);
  if (x.status === 'verified' && x.result) return x.result;
  if (x.status !== 'submitted') throw new AppError('TA_SESSION_USED');
  if (out.resultHash !== claimedHash) {
    // returned (not thrown) so the rejection is persisted; the orchestrator turns it into TA_RESULT_MISMATCH
    x.status = 'rejected';
    return { rejected: true, sessionId };
  }
  const st = taState(s);
  const idx = out.order.indexOf(0);
  const finishTick = idx >= 0 ? out.finishTicks[idx]! : -1;
  const finishFrac = idx >= 0 && out.finishFracs ? Math.max(0, out.finishFracs[idx]!) : 0;
  const finished = finishTick >= 0;
  const result: TaResult = {
    sessionId, trackId: x.trackId, seasonId: x.seasonId, finished, resultHash: out.resultHash,
    timeMs: finished ? raceTimeMs(x.config, finishTick, finishFrac) : null,
    finishTick: finished ? finishTick : null, finishFrac: finished ? finishFrac : null,
    seasonBest: false, allTimeBest: false, previousSeasonBestMs: st.seasonBest[bestKey(x.seasonId, x.trackId)]?.timeMs ?? null, milestones: [],
  };
  if (finished) {
    const horse = x.config.entrants[0]!.horse;
    const best: TaBest = { timeMs: result.timeMs!, finishTick, finishFrac, sessionId, horseId: x.horseId, horseName: horse.name, at: now };
    const sk = bestKey(x.seasonId, x.trackId);
    const prevSeason = st.seasonBest[sk];
    if (!prevSeason || faster(best, prevSeason)) { st.seasonBest[sk] = best; result.seasonBest = true; }
    const prevAll = st.allTimeBest[x.trackId];
    if (!prevAll || faster(best, prevAll)) { st.allTimeBest[x.trackId] = best; result.allTimeBest = true; }
    for (const ms of cfg.milestones) {
      if (st.milestones.includes(ms.id)) continue;
      if (ms.trackId !== null && ms.trackId !== x.trackId) continue;
      if (ms.maxTimeMs !== null && result.timeMs! > ms.maxTimeMs) continue;
      st.milestones.push(ms.id);
      grantReward(s, ms.reward, now, `time attack milestone ${ms.id}`, `ta:${sessionId}`);
      result.milestones.push({ id: ms.id, reward: ms.reward });
    }
  }
  x.status = 'verified';
  x.result = result;
  return result;
}

/** REQ-TA-006: what the player sees for one track (bests, attempts left today, milestones). */
export function timeAttackView(s: PlayerState, cfg: TimeAttackConfig, trackId: string, now: number, day: DayRule) {
  const st = taState(s);
  const seasonId = jstMonthKey(now);
  const today = gameDayKey(now, day);
  return {
    trackId, seasonId,
    seasonBest: st.seasonBest[bestKey(seasonId, trackId)] ?? null,
    allTimeBest: st.allTimeBest[trackId] ?? null,
    attemptsLeft: cfg.maxAttemptsPerDay - (sameGameDay(st.daily.date, today) ? st.daily.count - (st.daily.bonus ?? 0) : 0),
    milestones: cfg.milestones.filter((ms) => ms.trackId === null || ms.trackId === trackId).map((ms) => ({ id: ms.id, maxTimeMs: ms.maxTimeMs, reward: ms.reward, reached: st.milestones.includes(ms.id) })),
  };
}

// ---------------------------------------------------------------- leaderboard (REQ-TA-006)

export interface TaEntry {
  playerId: string; seasonId: string; trackId: string; timeMs: number; finishTick: number; finishFrac: number;
  displayName: string; titleId: string | null; horseName: string; updatedAt: number;
}
export interface TaRow { rank: number; playerId: string; displayName: string; titleId: string | null; horseName: string; timeMs: number }
export interface TaBoardFile { seasonId: string; board: string; trackId: string; generatedAt: number; total: number; entries: TaRow[] }

export const taBoardName = (trackId: string) => `ta-${trackId}`;
export const TA_BOARD_RE = /^ta-[a-z0-9_]{1,48}$/;

/** Faster first, then earlier, then player id (total order). */
export function compareTa(a: TaEntry, b: TaEntry) {
  return a.finishTick - b.finishTick || a.finishFrac - b.finishFrac || a.updatedAt - b.updatedAt || (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0);
}

/** Keep the faster entry (a slower re-submission never replaces a better one). */
export function betterTa(prev: TaEntry | undefined, next: TaEntry): boolean {
  return !prev || next.finishTick < prev.finishTick || (next.finishTick === prev.finishTick && next.finishFrac < prev.finishFrac);
}

export function buildTaBoards(seasonId: string, entries: TaEntry[], now: number, topN: number) {
  const byTrack = new Map<string, TaEntry[]>();
  for (const e of entries) {
    if (e.seasonId !== seasonId) continue;
    let l = byTrack.get(e.trackId);
    if (!l) byTrack.set(e.trackId, (l = []));
    l.push(e);
  }
  const files: { board: string; body: TaBoardFile }[] = [];
  const ranks: { playerId: string; trackId: string; rank: number; total: number }[] = [];
  for (const trackId of [...byTrack.keys()].sort()) {
    const list = byTrack.get(trackId)!.sort(compareTa);
    list.forEach((e, i) => ranks.push({ playerId: e.playerId, trackId, rank: i + 1, total: list.length }));
    const board = taBoardName(trackId);
    files.push({
      board,
      body: { seasonId, board, trackId, generatedAt: now, total: list.length, entries: list.slice(0, topN).map((e, i) => ({ rank: i + 1, playerId: e.playerId, displayName: e.displayName, titleId: e.titleId, horseName: e.horseName, timeMs: e.timeMs })) },
    });
  }
  return { files, ranks };
}

// ---------------------------------------------------------------- ghosts (REQ-TA-008)

export const ghostKey = (seasonId: string, trackId: string, playerId: string) => `ghosts/${seasonId}/${trackId}/${playerId}.json`;

export interface GhostMeta { playerId: string; displayName: string; horseName: string; seasonId: string; trackId: string; timeMs: number; finishTick: number; finishFrac: number }
export interface GhostFile { meta: GhostMeta; log: ReplayLog }
