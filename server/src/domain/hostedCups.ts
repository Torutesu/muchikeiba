/**
 * プレイヤー主催カップ — player-hosted cups (REQ-CUP-*, contracts/protocol.md §42).
 *
 * A small cup a player opens for friends or their branch: the host picks the rules (the same RoomConditions as a friend
 * room), the entry count, the format (one race, or three races on points) and a time window; players join with their own
 * horse by invitation or by a short join code. Races run through the friend-room machinery (matchmaker → race room,
 * `/v1/match/status`) in the `cup` mode, which is unranked: nothing but the cup's own standings and a cosmetic trophy
 * comes of it (applyRace only records it — see isCupRace in service.ts).
 *
 * Pure rules on the cup's state (one CupDO per cup in production, a map in tests) and on the player's `cups` state.
 */
import { z } from 'zod';
import { AppError } from './errors.js';
import { foldForCompare } from './horses.js';
import { deletionScheduled } from './accountDeletion.js';
import { moderationOf, type PlayerState } from './player.js';
import { validateRoomConditions, type RoomConditions } from './presets.js';
import type { Master } from './master.js';
import type { HeatOutcome } from './tournaments.js';
import type { Emit } from './service.js';

// ------------------------------------------------------------------------------------------------ config

export interface HostedCupsConfig {
  enabled: boolean;
  minCapacity: number;
  maxCapacity: number;
  /** Entrants needed (host included) before the host can start a race. */
  minEntrants: number;
  maxActivePerHost: number;
  /** Cups a player is in at once (hosted ones included). */
  maxEntriesPerPlayer: number;
  nameMaxChars: number;
  minWindowMinutes: number;
  maxWindowHours: number;
  /** The window must open within this many hours of the creation. */
  maxLeadHours: number;
  /** Code lookups / joins by code per player and clock hour (successes and failures alike). */
  joinCodeAttemptsPerHour: number;
  invitesPerCup: number;
  /** best_of_3 points by place (index 0 = 1st); places past the end score 0. */
  pointsByPlace: number[];
  /** A race without a definitive result this long after its start is void. */
  raceTimeoutMinutes: number;
  /** Finished / cancelled cups are kept (viewable) this long, then removed. */
  keepDays: number;
  historyKeep: number;
}

export const HOSTED_CUP_HARD_LIMITS = {
  minCapacity: 2, maxCapacity: 12, maxActivePerHost: 5, maxEntriesPerPlayer: 10, nameMaxChars: 30, joinCodeAttemptsPerHour: 60,
  invitesPerCup: 50, points: 12, maxPoints: 100, maxWindowHours: 7 * 24, maxLeadHours: 14 * 24, keepDays: 30, historyKeep: 50,
};

export const DEFAULT_HOSTED_CUPS: HostedCupsConfig = {
  enabled: true, minCapacity: 4, maxCapacity: 8, minEntrants: 2, maxActivePerHost: 2, maxEntriesPerPlayer: 4, nameMaxChars: 20,
  minWindowMinutes: 15, maxWindowHours: 72, maxLeadHours: 168, joinCodeAttemptsPerHour: 10, invitesPerCup: 30,
  pointsByPlace: [10, 7, 5, 4, 3, 2, 1, 1], raceTimeoutMinutes: 20, keepDays: 7, historyKeep: 20,
};

const configSchema = z.object({
  _note: z.string().optional(),
  enabled: z.boolean(), minCapacity: z.number().int(), maxCapacity: z.number().int(), minEntrants: z.number().int(),
  maxActivePerHost: z.number().int(), maxEntriesPerPlayer: z.number().int(), nameMaxChars: z.number().int(),
  minWindowMinutes: z.number().int(), maxWindowHours: z.number().int(), maxLeadHours: z.number().int(),
  joinCodeAttemptsPerHour: z.number().int(), invitesPerCup: z.number().int(), pointsByPlace: z.array(z.number().int()),
  raceTimeoutMinutes: z.number().int(), keepDays: z.number().int(), historyKeep: z.number().int(),
}).strict();

export function hostedCupsConfig(m: Pick<Master, 'progression'>): HostedCupsConfig {
  return (m.progression as { hostedCups?: HostedCupsConfig }).hostedCups ?? { ...DEFAULT_HOSTED_CUPS, enabled: false };
}

/** REQ-CUP-* §42.4: shape and ceilings (boot and every config version). */
export function hostedCupsProblems(m: Pick<Master, 'progression'>, path = 'progression.hostedCups'): string[] {
  const raw = (m.progression as { hostedCups?: unknown }).hostedCups;
  if (raw === undefined) return [];
  const r = configSchema.safeParse(raw);
  if (!r.success) return r.error.issues.map((i) => `${path}.${i.path.join('.')}: ${i.message}`);
  const c = r.data;
  const H = HOSTED_CUP_HARD_LIMITS;
  const out: string[] = [];
  const within = (k: string, v: number, lo: number, hi: number) => { if (v < lo || v > hi) out.push(`${path}.${k}: must be ${lo}..${hi}`); };
  within('minCapacity', c.minCapacity, H.minCapacity, H.maxCapacity);
  within('maxCapacity', c.maxCapacity, c.minCapacity, H.maxCapacity);
  within('minEntrants', c.minEntrants, 2, c.minCapacity);
  within('maxActivePerHost', c.maxActivePerHost, 1, H.maxActivePerHost);
  within('maxEntriesPerPlayer', c.maxEntriesPerPlayer, c.maxActivePerHost, H.maxEntriesPerPlayer);
  within('nameMaxChars', c.nameMaxChars, 1, H.nameMaxChars);
  within('minWindowMinutes', c.minWindowMinutes, 5, 24 * 60);
  within('maxWindowHours', c.maxWindowHours, Math.ceil(c.minWindowMinutes / 60), H.maxWindowHours);
  within('maxLeadHours', c.maxLeadHours, 0, H.maxLeadHours);
  within('joinCodeAttemptsPerHour', c.joinCodeAttemptsPerHour, 1, H.joinCodeAttemptsPerHour);
  within('invitesPerCup', c.invitesPerCup, 1, H.invitesPerCup);
  within('raceTimeoutMinutes', c.raceTimeoutMinutes, 5, 120);
  within('keepDays', c.keepDays, 1, H.keepDays);
  within('historyKeep', c.historyKeep, 1, H.historyKeep);
  if (c.pointsByPlace.length < 1 || c.pointsByPlace.length > H.points) out.push(`${path}.pointsByPlace: 1..${H.points} values`);
  if (c.pointsByPlace.some((p, i) => p < 0 || p > H.maxPoints || (i > 0 && p > c.pointsByPlace[i - 1]!))) out.push(`${path}.pointsByPlace: non-increasing values in 0..${H.maxPoints}`);
  return out;
}

// ------------------------------------------------------------------------------------------------ cup state

export type CupFormat = 'single' | 'best_of_3';
export const CUP_FORMATS: readonly CupFormat[] = ['single', 'best_of_3'];
export type CupStatus = 'open' | 'running' | 'finished' | 'cancelled';
export type CupCancelReason = 'host_left' | 'host_deleted' | 'ops_deleted' | 'expired';
export type CupTrophy = 'gold' | 'silver' | 'bronze';

export interface CupEntrant<E = unknown> {
  playerId: string; displayName: string; horseId: string; horseName: string; joinedAt: number;
  via: 'host' | 'code' | 'invite';
  /** Withdrew after the first race (scores 0 from then on, stays in the standings). */
  withdrawn: boolean;
  /** The entrant's mute list at join (REQ-CUP-006: checked both ways against later joiners). */
  blocks: string[];
  /** Race entry snapshot (refreshed at each race start). */
  entry: E;
}
export interface CupRace {
  index: number; raceId: string; attempt: number; startAtMs: number;
  status: 'running' | 'done' | 'void';
  /** Place per entrant (null = no-show / not in the race / void). */
  places: Record<string, number | null>;
}
export interface CupStanding { playerId: string; rank: number; points: number; places: (number | null)[] }

export interface CupState<E = unknown> {
  v: 1;
  id: string; code: string; hostId: string; name: string;
  format: CupFormat; capacity: number; conditions: RoomConditions;
  opensAt: number; closesAt: number;
  status: CupStatus; createdAt: number; updatedAt: number;
  /** The host's branch when it was created (lets branch members be invited). */
  teamId: string | null;
  entrants: CupEntrant<E>[];
  invited: string[];
  races: CupRace[];
  standings: CupStanding[] | null;
  partial: boolean;
  cancelReason: CupCancelReason | null;
  finishedAt: number | null;
  /** Entrants (and invitees on a cancel) still to be told the cup closed (CupDO alarm retries). */
  outbox: string[];
}

export const racesTotal = (c: Pick<CupState, 'format'>) => (c.format === 'single' ? 1 : 3);
export const racesDone = (c: Pick<CupState, 'races'>) => c.races.filter((r) => r.status === 'done').length;
export const isClosed = (c: Pick<CupState, 'status'>) => c.status === 'finished' || c.status === 'cancelled';
export const activeEntrants = <E>(c: CupState<E>) => c.entrants.filter((e) => !e.withdrawn);
/** REQ-CUP-008: the race id of attempt `attempt` of race `index` (a retried start reaches the same room). */
export const cupRaceId = (cupId: string, index: number, attempt: number) => `cup-${cupId}-${index}-${attempt}`;

export const CUP_ID_RE = /^cup_[a-z2-7]{16}$/;

// ------------------------------------------------------------------------------------------------ codes (REQ-CUP-003)

export const CUP_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CUP_CODE_LENGTH = 8;

/** A fresh code from a cryptographic source (31^8 ≈ 8.5e11 codes; with the per-player hourly cap, never enumerable). */
export function makeCupCode(randomBytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  let out = '';
  while (out.length < CUP_CODE_LENGTH) {
    for (const b of randomBytes(16)) {
      if (b >= 248) continue; // 248 = 31 × 8: no modulo bias
      out += CUP_CODE_ALPHABET[b % 31];
      if (out.length === CUP_CODE_LENGTH) break;
    }
  }
  return out;
}

/** What a player typed → the stored form (upper case, no hyphens / spaces); null when it cannot be a code. */
export function normalizeCupCode(raw: string): string | null {
  const s = raw.normalize('NFKC').toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== CUP_CODE_LENGTH) return null;
  for (const ch of s) if (!CUP_CODE_ALPHABET.includes(ch)) return null;
  return s;
}
export const displayCupCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
/** Index shard of a code (its first character). */
export const cupCodeShard = (code: string) => code[0]!;

/** Deterministic cup id for (host, idempotency key): a retried create names the same cup. */
export async function cupIdFor(hostId: string, idemKey: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cup|${hostId}|${idemKey}`)));
  const A = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0, acc = 0, out = '';
  for (const b of d) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5 && out.length < 16) { out += A[(acc >> (bits - 5)) & 31]; bits -= 5; }
    if (out.length === 16) break;
  }
  return `cup_${out}`;
}

// ------------------------------------------------------------------------------------------------ create (REQ-CUP-001/002)

/** REQ-CUP-002: the display-name rules (NFKC, no control characters / URLs, the NG list). Never translated. */
export function validateCupName(m: Master, raw: string): string {
  const max = hostedCupsConfig(m).nameMaxChars;
  const t = raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const len = [...t].length;
  if (len < 1 || len > max) throw new AppError('INVALID_NAME', `cup name: 1..${max} characters`);
  if (/[\p{C}]/u.test(t)) throw new AppError('INVALID_NAME', 'control characters');
  if (/https?:|www\.|\.(com|net|jp|io|me)\b/i.test(t)) throw new AppError('INVALID_NAME', 'no URLs');
  const f = foldForCompare(t);
  if (m.ng.exact.some((n) => foldForCompare(n) === f)) throw new AppError('NG_NAME');
  if (m.ng.contains.some((n) => f.includes(foldForCompare(n)))) throw new AppError('NG_NAME');
  return t;
}

export interface CupCreateInput { cupName: string; capacity: number; format: CupFormat; opensAt: number; closesAt: number; conditions: RoomConditions }

/** The checked definition (name, capacity, window, rules). Throws BAD_REQUEST / INVALID_NAME / NG_NAME. */
export function validateCupInput(m: Master, i: CupCreateInput, now: number): CupCreateInput {
  const c = hostedCupsConfig(m);
  if (!c.enabled) throw new AppError('NOT_FOUND', 'hosted cups are not available');
  const cupName = validateCupName(m, i.cupName);
  if (!Number.isInteger(i.capacity) || i.capacity < c.minCapacity || i.capacity > c.maxCapacity) throw new AppError('BAD_REQUEST', `capacity must be ${c.minCapacity}..${c.maxCapacity}`);
  if (!CUP_FORMATS.includes(i.format)) throw new AppError('BAD_REQUEST', 'format must be single or best_of_3');
  const len = i.closesAt - i.opensAt;
  if (len < c.minWindowMinutes * 60_000 || len > c.maxWindowHours * 3_600_000) throw new AppError('BAD_REQUEST', `the window must last ${c.minWindowMinutes} minutes to ${c.maxWindowHours} hours`);
  if (i.closesAt <= now + c.minWindowMinutes * 60_000 / 2) throw new AppError('BAD_REQUEST', 'the window must close in the future');
  if (i.opensAt > now + c.maxLeadHours * 3_600_000) throw new AppError('BAD_REQUEST', `the window must open within ${c.maxLeadHours} hours`);
  const conditions = validateRoomConditions(m, i.conditions);
  return { cupName, capacity: i.capacity, format: i.format, opensAt: Math.max(i.opensAt, now - 60_000), closesAt: i.closesAt, conditions };
}

export function newCup<E>(id: string, code: string, d: CupCreateInput, host: CupEntrant<E>, teamId: string | null, now: number): CupState<E> {
  return {
    v: 1, id, code, hostId: host.playerId, name: d.cupName, format: d.format, capacity: d.capacity, conditions: d.conditions,
    opensAt: d.opensAt, closesAt: d.closesAt, status: 'open', createdAt: now, updatedAt: now, teamId,
    entrants: [host], invited: [], races: [], standings: null, partial: false, cancelReason: null, finishedAt: null, outbox: [],
  };
}

/** Same definition (an idempotent retry of a create carries the same body). */
export const sameDefinition = (c: CupState, d: CupCreateInput, hostId: string) =>
  c.hostId === hostId && c.name === d.cupName && c.format === d.format && c.capacity === d.capacity && c.closesAt === d.closesAt
  && JSON.stringify(c.conditions) === JSON.stringify(d.conditions);

// ------------------------------------------------------------------------------------------------ join / leave / invite

const blockedBetween = <E>(c: CupState<E>, joiner: CupEntrant<E>) =>
  c.entrants.some((e) => e.blocks.includes(joiner.playerId) || joiner.blocks.includes(e.playerId));

/**
 * REQ-CUP-005/006: one join per player (a repeat returns joined: false). Atomic inside the cup's object, so of two
 * joiners for the last slot exactly one gets in. Blocked pairs get the same answer as a bad code (never says why).
 */
export function joinCup<E>(c: CupState<E>, e: CupEntrant<E>, now: number): { joined: boolean } {
  if (c.entrants.some((x) => x.playerId === e.playerId)) return { joined: false };
  if (isClosed(c)) throw new AppError('CUP_CLOSED', 'the cup is over');
  if (c.races.length > 0 || c.status !== 'open') throw new AppError('CUP_CLOSED', 'the cup has started');
  if (now >= c.closesAt) throw new AppError('CUP_CLOSED', 'the cup is closed');
  if (e.via === 'invite' && !c.invited.includes(e.playerId)) throw new AppError('NOT_FOUND', 'no such cup');
  if (blockedBetween(c, e)) throw new AppError('CUP_CODE_INVALID');
  if (c.entrants.length >= c.capacity) throw new AppError('CUP_FULL', 'the cup is full');
  c.entrants.push({ ...e, joinedAt: now, withdrawn: false });
  c.updatedAt = now;
  return { joined: true };
}

export function cancelCup(c: CupState, reason: CupCancelReason, now: number): boolean {
  if (isClosed(c)) return false;
  c.status = 'cancelled';
  c.cancelReason = reason;
  for (const r of c.races) if (r.status === 'running') r.status = 'void'; // the room may still finish: it no longer counts
  c.finishedAt = now;
  c.updatedAt = now;
  // everyone in the cup, and invitees who still have the invitation, are told it closed
  c.outbox = [...new Set([...c.entrants.map((e) => e.playerId), ...c.invited])];
  return true;
}

/** REQ-CUP-011: the host leaving cancels the cup; an entrant leaves before the first race, withdraws after. */
export function leaveCup(c: CupState, playerId: string, now: number): { left: boolean; cancelled: boolean } {
  const e = c.entrants.find((x) => x.playerId === playerId);
  if (!e || isClosed(c)) return { left: false, cancelled: false };
  if (playerId === c.hostId) return { left: true, cancelled: cancelCup(c, 'host_left', now) };
  if (c.races.length === 0) c.entrants = c.entrants.filter((x) => x.playerId !== playerId);
  else if (!e.withdrawn) e.withdrawn = true;
  else return { left: false, cancelled: false };
  c.updatedAt = now;
  if (c.races.length > 0 && activeEntrants(c).length === 0) finishCup(c, now, true);
  return { left: true, cancelled: false };
}

/** REQ-CUP-004: the ids actually added (not yet invited, not in the cup), within invitesPerCup. */
export function addInvites(c: CupState, by: string, ids: string[], max: number, now: number): string[] {
  if (by !== c.hostId) throw new AppError('NOT_HOST');
  if (isClosed(c) || c.races.length > 0 || now >= c.closesAt) throw new AppError('CUP_CLOSED', 'invitations are closed');
  const added: string[] = [];
  for (const id of ids) {
    if (c.invited.length >= max) break;
    if (id === c.hostId || c.invited.includes(id) || c.entrants.some((e) => e.playerId === id)) continue;
    c.invited.push(id);
    added.push(id);
  }
  if (added.length) c.updatedAt = now;
  return added;
}

/** REQ-CUP-016: the account is deleted. */
export function forgetCupPlayer(c: CupState, playerId: string, anonName: string, now: number): 'cancelled' | 'removed' | 'anonymized' | 'none' {
  c.invited = c.invited.filter((x) => x !== playerId);
  c.outbox = c.outbox.filter((x) => x !== playerId);
  if (playerId === c.hostId && !isClosed(c)) { cancelCup(c, 'host_deleted', now); c.outbox = c.outbox.filter((x) => x !== playerId); }
  const e = c.entrants.find((x) => x.playerId === playerId);
  if (!e) return playerId === c.hostId ? 'cancelled' : 'none';
  if (c.races.length === 0 && c.status !== 'cancelled') {
    c.entrants = c.entrants.filter((x) => x.playerId !== playerId);
    c.updatedAt = now;
    return 'removed';
  }
  e.displayName = anonName;
  e.horseName = '';
  e.withdrawn = true;
  e.blocks = [];
  c.updatedAt = now;
  return playerId === c.hostId ? 'cancelled' : 'anonymized';
}

// ------------------------------------------------------------------------------------------------ races (REQ-CUP-008/009)

export interface CupRaceSpec<E> { cupId: string; cupName: string; raceId: string; index: number; playerIds: string[]; entries: E[]; conditions: RoomConditions }

/** Why the host cannot start the next race now (null = can start). */
export function startProblem(m: Master, c: CupState, now: number): string | null {
  if (isClosed(c)) return 'closed';
  if (c.races.some((r) => r.status === 'running')) return 'race_running';
  if (racesDone(c) >= racesTotal(c)) return 'all_raced';
  if (now < c.opensAt) return 'not_open';
  if (now >= c.closesAt) return 'closed';
  if (activeEntrants(c).length < hostedCupsConfig(m).minEntrants) return 'too_few';
  return null;
}

/** The spec of the next race (or of a retried start: same index, next attempt). */
export function nextRaceSpec<E>(m: Master, c: CupState<E>, by: string, now: number): CupRaceSpec<E> {
  if (by !== c.hostId) throw new AppError('NOT_HOST');
  const p = startProblem(m, c, now);
  if (p) throw new AppError('CUP_NOT_READY', p);
  const index = racesDone(c);
  const attempt = c.races.filter((r) => r.index === index).length;
  const racers = activeEntrants(c);
  return { cupId: c.id, cupName: c.name, raceId: cupRaceId(c.id, index, attempt), index, playerIds: racers.map((e) => e.playerId), entries: racers.map((e) => e.entry), conditions: c.conditions };
}

export function markRaceStarted<E>(c: CupState<E>, spec: CupRaceSpec<E>, startAtMs: number, now: number) {
  const attempt = c.races.filter((r) => r.index === spec.index).length;
  c.races.push({ index: spec.index, raceId: spec.raceId, attempt, startAtMs, status: 'running', places: {} });
  c.status = 'running';
  c.updatedAt = now;
}

/** A started race's outcome (null = not final yet). Returns true when the cup changed. */
export function applyCupRaceOutcome(m: Master, c: CupState, raceId: string, o: HeatOutcome | null, now: number): boolean {
  if (isClosed(c)) return false; // a cancelled cup stays cancelled (its race was voided by cancelCup)
  const race = c.races.find((r) => r.raceId === raceId);
  if (!race || race.status !== 'running') return false;
  const timedOut = now - race.startAtMs > hostedCupsConfig(m).raceTimeoutMinutes * 60_000;
  const final = o?.final ?? null;
  if (!final || final.status === 'verifying') {
    if (!timedOut) return false;
    race.status = 'void';
  } else if (final.status === 'void') {
    race.status = 'void';
  } else {
    const noShow = new Set(o!.slots.filter((s) => o!.noShows.includes(s.slot)).map((s) => s.playerId));
    // places among the humans of the cup (the field is humans only, so this equals the race place)
    const slotOf = new Map(o!.slots.map((s) => [s.playerId, s.slot]));
    const humanOrder = final.order.filter((slot) => o!.slots.some((s) => s.slot === slot));
    for (const e of c.entrants) {
      const slot = slotOf.get(e.playerId);
      race.places[e.playerId] = slot === undefined || noShow.has(e.playerId) ? null : humanOrder.indexOf(slot) + 1 || null;
    }
    race.status = 'done';
  }
  c.updatedAt = now;
  c.standings = computeCupStandings(m, c);
  if (racesDone(c) >= racesTotal(c)) finishCup(c, now, false);
  else if (!c.races.some((r) => r.status === 'running')) {
    c.status = 'open'; // waiting for the host's next start (joins stay closed: races.length > 0)
    if (now >= c.closesAt) expireCup(c, now);
  }
  return true;
}

/** REQ-CUP-009: points (best_of_3) or the race place (single); ties by best place, last race, join order. */
export function computeCupStandings(m: Master, c: CupState): CupStanding[] {
  const pts = hostedCupsConfig(m).pointsByPlace;
  const done = c.races.filter((r) => r.status === 'done').sort((a, b) => a.index - b.index);
  const rows = c.entrants.map((e, joinIndex) => {
    const places = done.map((r) => r.places[e.playerId] ?? null);
    const points = c.format === 'single' ? 0 : places.reduce<number>((a, p) => a + (p ? pts[p - 1] ?? 0 : 0), 0);
    const best = Math.min(99, ...places.map((p) => p ?? 99));
    const last = places.length ? places[places.length - 1] ?? 99 : 99;
    return { playerId: e.playerId, points, places, best, last, joinIndex };
  });
  rows.sort((a, b) => (c.format === 'single' ? a.last - b.last : b.points - a.points || a.best - b.best || a.last - b.last) || a.joinIndex - b.joinIndex);
  return rows.map((r, i) => ({ playerId: r.playerId, rank: i + 1, points: r.points, places: r.places }));
}

export function finishCup(c: CupState, now: number, partial: boolean) {
  if (isClosed(c)) return;
  c.status = 'finished';
  c.partial = partial || racesDone(c) < racesTotal(c);
  c.finishedAt = now;
  c.updatedAt = now;
  c.outbox = c.entrants.map((e) => e.playerId);
}

/** REQ-CUP-012: the window closed (a running race is waited for). True when the cup changed. */
export function expireCup(c: CupState, now: number): boolean {
  if (isClosed(c) || now < c.closesAt || c.races.some((r) => r.status === 'running')) return false;
  if (racesDone(c) === 0) return cancelCup(c, 'expired', now);
  finishCup(c, now, true);
  return true;
}

/** When the cup's object should wake next (race poll, window close, removal), null = never. */
export function cupWakeAt(m: Master, c: CupState, now: number, pollMs = 5_000): number | null {
  const running = c.races.find((r) => r.status === 'running');
  if (running) return Math.max(now + 1_000, Math.min(Math.max(running.startAtMs, now) + pollMs, running.startAtMs + hostedCupsConfig(m).raceTimeoutMinutes * 60_000 + 1_000));
  if (c.outbox.length) return now + 30_000;
  if (!isClosed(c)) return c.closesAt;
  return (c.finishedAt ?? now) + hostedCupsConfig(m).keepDays * 86_400_000;
}
export const cupExpiredForGood = (m: Master, c: CupState, now: number) => isClosed(c) && c.outbox.length === 0 && now >= (c.finishedAt ?? now) + hostedCupsConfig(m).keepDays * 86_400_000;

// ------------------------------------------------------------------------------------------------ views

export type CupRole = 'host' | 'entrant' | 'invited' | 'none';
export const roleOf = (c: CupState, playerId: string): CupRole =>
  c.hostId === playerId ? 'host' : c.entrants.some((e) => e.playerId === playerId) ? 'entrant' : c.invited.includes(playerId) ? 'invited' : 'none';

const trophyOf = (rank: number, entrants: number): CupTrophy | null => (rank === 1 && entrants >= 2 ? 'gold' : rank === 2 && entrants >= 2 ? 'silver' : rank === 3 && entrants >= 3 ? 'bronze' : null);

export function cupView(m: Master, c: CupState, viewer: string, now: number) {
  const role = roleOf(c, viewer);
  const name = (pid: string) => c.entrants.find((e) => e.playerId === pid)?.displayName ?? '';
  return {
    cupId: c.id, cupName: c.name, hostId: c.hostId, hostName: name(c.hostId), role,
    code: role === 'host' || role === 'entrant' ? (isClosed(c) ? null : displayCupCode(c.code)) : null,
    format: c.format, capacity: c.capacity, racesTotal: racesTotal(c), racesDone: racesDone(c), conditions: c.conditions,
    opensAt: c.opensAt, closesAt: c.closesAt, status: c.status, partial: c.partial, cancelReason: c.cancelReason, finishedAt: c.finishedAt,
    entrants: c.entrants.map((e) => ({ playerId: e.playerId, displayName: e.displayName, horseName: e.horseName, withdrawn: e.withdrawn })),
    races: c.races.map((r) => ({ index: r.index, raceId: r.raceId, status: r.status, startAtMs: r.startAtMs, places: r.places })),
    standings: (c.standings ?? []).map((s) => ({ ...s, displayName: name(s.playerId), trophy: c.status === 'finished' ? trophyOf(s.rank, c.entrants.length) : null })),
    canStart: role === 'host' && startProblem(m, c, now) === null,
    startProblem: role === 'host' ? startProblem(m, c, now) : null,
    minEntrants: hostedCupsConfig(m).minEntrants,
  };
}
export type CupView = ReturnType<typeof cupView>;

/** REQ-CUP-003: what a code shows before joining (no other player's name but the host's). */
export function cupPreview(c: CupState) {
  return {
    cupId: c.id, cupName: c.name, hostName: c.entrants.find((e) => e.playerId === c.hostId)?.displayName ?? '',
    format: c.format, capacity: c.capacity, entrants: c.entrants.length, conditions: c.conditions, opensAt: c.opensAt, closesAt: c.closesAt,
  };
}

/** What a closed cup tells each player (cupClosed on their object). */
export interface CupClosedNotice {
  cupId: string; cupName: string; format: CupFormat; status: 'finished' | 'cancelled'; partial: boolean;
  cancelReason: CupCancelReason | null; rank: number | null; points: number | null; entrants: number; at: number; role: 'host' | 'entrant' | 'invited';
}
/** §42.7 × §40: the cup's first race started (the activity entry of each entrant). */
export interface CupStartedNotice { cupId: string; cupName: string; raceIndex: number }
export function closedNoticeFor(c: CupState, playerId: string): CupClosedNotice {
  const st = c.standings?.find((s) => s.playerId === playerId) ?? null;
  const role = roleOf(c, playerId);
  return {
    cupId: c.id, cupName: c.name, format: c.format, status: c.status === 'finished' ? 'finished' : 'cancelled', partial: c.partial, cancelReason: c.cancelReason,
    rank: c.status === 'finished' ? st?.rank ?? null : null, points: c.status === 'finished' ? st?.points ?? null : null,
    entrants: c.entrants.length, at: c.finishedAt ?? c.updatedAt, role: role === 'none' ? 'invited' : role,
  };
}

// ------------------------------------------------------------------------------------------------ player side

/** `horseId` (Round 16 integration): the horse entered — the roster's bulk retire refuses it while the cup is active (§44 `cup_entry`). */
export interface PlayerCupRef { cupId: string; role: 'host' | 'entrant'; until: number; noted?: boolean; horseId?: string }
export interface PlayerCupInvite { cupId: string; cupName: string; hostId: string; hostName: string; at: number; until: number }
export interface PlayerCupResult {
  cupId: string; cupName: string; format: CupFormat; rank: number | null; points: number | null; entrants: number; at: number;
  status: 'finished' | 'cancelled'; partial: boolean; cancelReason: CupCancelReason | null; trophy: CupTrophy | null;
}
export interface PlayerCupsState {
  active: PlayerCupRef[]; invites: PlayerCupInvite[]; history: PlayerCupResult[];
  trophies: { gold: number; silver: number; bronze: number };
  /** REQ-CUP-003: code attempts in the current clock hour. */
  codeAttempts: { hour: number; count: number };
}

export function ensureCups(s: PlayerState): PlayerCupsState {
  s.cups ??= { active: [], invites: [], history: [], trophies: { gold: 0, silver: 0, bronze: 0 }, codeAttempts: { hour: 0, count: 0 } };
  return s.cups;
}

const mutedOf = (s: PlayerState): string[] => [...((s as PlayerState & { teamFeed?: { muted: string[] } }).teamFeed?.muted ?? [])];

/** A missed close notice never blocks the limits for good: refs count until the window closed + a day. */
export const REF_GRACE_MS = 86_400_000;

function pruneCups(s: PlayerState, now: number) {
  const st = ensureCups(s);
  st.active = st.active.filter((r) => r.until > now);
  st.invites = st.invites.filter((r) => r.until > now);
  return st;
}

/** REQ-CUP-006/007: may this player host / enter one more cup? Idempotent for a cup already reserved. */
export function reserveCup(m: Master, s: PlayerState, cupId: string, role: 'host' | 'entrant', until: number, now: number, horseId?: string) {
  const c = hostedCupsConfig(m);
  if (!c.enabled) throw new AppError('NOT_FOUND', 'hosted cups are not available');
  if (deletionScheduled(s)) throw new AppError('DELETION_PENDING', 'the account is scheduled for deletion');
  if (moderationOf(s, now) === 'banned') throw new AppError('BANNED');
  const st = pruneCups(s, now);
  const existing = st.active.find((r) => r.cupId === cupId);
  if (!existing) {
    if (role === 'host' && st.active.filter((r) => r.role === 'host').length >= c.maxActivePerHost) throw new AppError('CUP_LIMIT', `at most ${c.maxActivePerHost} hosted cups at a time`);
    if (st.active.length >= c.maxEntriesPerPlayer) throw new AppError('CUP_LIMIT', `at most ${c.maxEntriesPerPlayer} cups at a time`);
    st.active.push({ cupId, role, until: until + REF_GRACE_MS, ...(horseId ? { horseId } : {}) });
  } else if (horseId && !existing.horseId) existing.horseId = horseId;
  return { displayName: s.profile.displayName, blocks: mutedOf(s), teamId: s.team?.teamId ?? null, friends: [...s.friends.ids], already: !!existing };
}

export function releaseCup(s: PlayerState, cupId: string) {
  const st = ensureCups(s);
  const ref = st.active.find((r) => r.cupId === cupId);
  if (ref?.noted) return false; // the cup exists and counts (only a failed create / join is released)
  st.active = st.active.filter((r) => r.cupId !== cupId);
  return true;
}

/** KPI once per cup and role (after the cup accepted the create / join). */
export function noteCupCommitted(s: PlayerState, cupId: string, kind: 'create' | 'join', meta: { format: CupFormat; capacity?: number; via?: string; team?: boolean }, emit: Emit) {
  const ref = ensureCups(s).active.find((r) => r.cupId === cupId);
  if (!ref || ref.noted) return;
  ref.noted = true;
  ensureCups(s).invites = ensureCups(s).invites.filter((i) => i.cupId !== cupId);
  if (kind === 'create') emit({ name: 'cup_create', s1: meta.format, s2: meta.team ? 'team' : 'solo', count: meta.capacity ?? 0 });
  else emit({ name: 'cup_join', s1: meta.via ?? 'code', s2: meta.format });
}

/** REQ-CUP-003: counts one code attempt (success or failure); RATE_LIMITED past the hourly cap. */
export function countCodeAttempt(m: Master, s: PlayerState, now: number) {
  const c = hostedCupsConfig(m);
  if (!c.enabled) throw new AppError('NOT_FOUND', 'hosted cups are not available');
  const st = ensureCups(s);
  const hour = Math.floor(now / 3_600_000);
  if (st.codeAttempts.hour !== hour) st.codeAttempts = { hour, count: 0 };
  if (st.codeAttempts.count >= c.joinCodeAttemptsPerHour) throw new AppError('RATE_LIMITED', 'too many code attempts; try again later');
  st.codeAttempts.count++;
  return { remaining: c.joinCodeAttemptsPerHour - st.codeAttempts.count };
}

/** REQ-CUP-004: an invitation (false = dropped: muted the host, deleted, already in it). */
export function receiveCupInvite(m: Master, s: PlayerState, inv: PlayerCupInvite, now: number): boolean {
  if (!hostedCupsConfig(m).enabled || deletionScheduled(s)) return false;
  const st = pruneCups(s, now);
  if (mutedOf(s).includes(inv.hostId)) return false;
  if (st.active.some((r) => r.cupId === inv.cupId) || st.invites.some((i) => i.cupId === inv.cupId)) return false;
  st.invites.push(inv);
  if (st.invites.length > 20) st.invites.splice(0, st.invites.length - 20);
  return true;
}

/** REQ-CUP-012/014: the cup closed — out of the active list, into the history (once per cup), trophy. */
export function receiveCupClosed(m: Master, s: PlayerState, n: CupClosedNotice, emit: Emit): PlayerCupResult | null {
  const st = ensureCups(s);
  const wasActive = st.active.some((r) => r.cupId === n.cupId);
  st.active = st.active.filter((r) => r.cupId !== n.cupId);
  st.invites = st.invites.filter((i) => i.cupId !== n.cupId);
  if (n.role === 'invited' && !wasActive) return null; // an invitee who never joined only loses the invitation
  if (st.history.some((h) => h.cupId === n.cupId)) return null;
  const trophy = n.status === 'finished' && n.rank !== null ? trophyOf(n.rank, n.entrants) : null;
  const r: PlayerCupResult = { cupId: n.cupId, cupName: n.cupName, format: n.format, rank: n.rank, points: n.points, entrants: n.entrants, at: n.at, status: n.status, partial: n.partial, cancelReason: n.cancelReason, trophy };
  st.history.unshift(r);
  st.history.splice(hostedCupsConfig(m).historyKeep);
  if (trophy) st.trophies[trophy]++;
  emit({ name: 'cup_finish', s1: n.status, s2: n.format, s3: n.cancelReason ?? (n.partial ? 'partial' : ''), place: n.rank ?? 0, count: n.entrants });
  return r;
}

export function playerCupsView(m: Master, s: PlayerState, now: number) {
  const c = hostedCupsConfig(m);
  const st = s.cups;
  const live = (st?.active ?? []).filter((r) => r.until > now);
  return {
    enabled: c.enabled,
    limits: { maxActivePerHost: c.maxActivePerHost, maxEntriesPerPlayer: c.maxEntriesPerPlayer, minCapacity: c.minCapacity, maxCapacity: c.maxCapacity, minEntrants: c.minEntrants, nameMaxChars: c.nameMaxChars, minWindowMinutes: c.minWindowMinutes, maxWindowHours: c.maxWindowHours, maxLeadHours: c.maxLeadHours, pointsByPlace: c.pointsByPlace },
    active: live.map((r) => ({ cupId: r.cupId, role: r.role })),
    invites: (st?.invites ?? []).filter((i) => i.until > now),
    history: st?.history ?? [],
    trophies: st?.trophies ?? { gold: 0, silver: 0, bronze: 0 },
  };
}

/** Cup ids for the account deletion (REQ-CUP-016). */
export const playerCupIds = (s: PlayerState) => [...new Set([...(s.cups?.active ?? []).map((r) => r.cupId), ...(s.cups?.invites ?? []).map((i) => i.cupId)])];
