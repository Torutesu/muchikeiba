import type { Give } from './giftBox.js';
import { AppError } from './errors.js';
import { assetKeys } from './visuals.js';
import { addItems, grantReward } from './items.js';
import { STAT_KEYS, type EventDef, type EventFee, type Master, type Reward } from './master.js';
import type { HorseInstance, PlayerState } from './player.js';
import { buildRuleset, DEFAULT_RULESET, type Ruleset } from './ruleset.js';
import { grantFree, spendFree } from './wallet.js';

/**
 * イベントレース REQ-EVENT-*. Pure logic. Definitions come from master/events.json or remote config;
 * the matchmaker keeps a separate pool per event, races run with mode "event" and the event's own
 * ruleset (overrides validated against the key set, version suffixed), and the EventDO ranks players.
 */

export const EVENT_ID_RE = /^[a-z0-9_]{1,40}$/;
/** Races may settle a little after the event ends; entries are accepted until endAt + grace, rewards start after. */
export const EVENT_SETTLE_GRACE_MS = 15 * 60_000;
/** A pending entry fee older than this (no race came of it) is refunded automatically. */
export const STALE_ENTRY_MS = 30 * 60_000;

export interface PlayerEventState {
  points: number; races: number; wins: number;
  /** Milestone point thresholds already paid. */
  milestones: number[];
  /** Entry fee held for a queued/started race. */
  pending: { entryId: string; fee: EventFee; at: number } | null;
  /** REQ-EVENT-008: rank reward paid (idempotency). */
  closed: boolean; rank: number | null;
}

export type EventStatus = 'upcoming' | 'open' | 'closed';

export function eventStatus(ev: EventDef, now: number): EventStatus {
  if (now < ev.startAtMs) return 'upcoming';
  if (now < ev.endAtMs) return 'open';
  return 'closed';
}

export function findEvent(m: Master, id: string): EventDef {
  const ev = m.events.find((e) => e.id === id);
  if (!ev) throw new AppError('NOT_FOUND', `event ${id}`);
  return ev;
}

// ------------------------------------------------------------------------------------- validation

const PROTECTED_KEYS = new Set(['rulesetVersion', 'maxTicks']);

/** REQ-EVENT-001: checks every definition (used at boot, in remote config staging and in tests). */
export function eventProblems(m: Pick<Master, 'tracks' | 'progression'>, events: EventDef[], base: Ruleset = DEFAULT_RULESET): string[] {
  const p: string[] = [];
  const ids = new Set<string>();
  const classIds = new Set(m.progression.classes.map((c) => c.id));
  for (const ev of events) {
    const at = `event ${ev.id}`;
    if (!EVENT_ID_RE.test(ev.id)) p.push(`${at}: bad id`);
    if (ids.has(ev.id)) p.push(`${at}: duplicate id`);
    ids.add(ev.id);
    if (!ev.name) p.push(`${at}: name required`);
    if (!(Number.isInteger(ev.startAtMs) && Number.isInteger(ev.endAtMs) && ev.startAtMs < ev.endAtMs)) p.push(`${at}: startAtMs must be before endAtMs`);
    if (!ev.trackIds?.length) p.push(`${at}: at least one track`);
    for (const t of ev.trackIds ?? []) if (!m.tracks.some((x) => x.id === t)) p.push(`${at}: unknown track ${t}`);
    for (const c of ev.entry?.classIds ?? []) if (!classIds.has(c)) p.push(`${at}: unknown class ${c}`);
    for (const st of ev.entry?.styles ?? []) if (!['nige', 'senko', 'sashi', 'oikomi'].includes(st)) p.push(`${at}: unknown style ${st}`);
    if (!Number.isInteger(ev.entry?.minRankedRaces) || ev.entry.minRankedRaces < 0) p.push(`${at}: minRankedRaces`);
    const f = ev.fee;
    if (!f || !['none', 'free', 'item'].includes(f.kind)) p.push(`${at}: fee.kind must be none|free|item (never paid coins)`);
    else if (f.kind === 'free' && !(Number.isInteger(f.freeCoins) && f.freeCoins > 0)) p.push(`${at}: fee.freeCoins`);
    else if (f.kind === 'item' && !(f.itemId && Number.isInteger(f.qty) && f.qty > 0)) p.push(`${at}: fee item`);
    const r = ev.rules;
    if (!r) p.push(`${at}: rules required`);
    else {
      for (const k of Object.keys(r.rulesetOverrides ?? {})) {
        if (PROTECTED_KEYS.has(k)) p.push(`${at}: ruleset override of ${k} is not allowed`);
        else if (!(k in base)) p.push(`${at}: unknown ruleset key ${k}`);
      }
      try {
        eventRuleset(base, ev);
      } catch (e) {
        p.push(`${at}: ${(e as Error).message}`);
      }
      if (r.fixedStats) for (const k of STAT_KEYS) if (!(Number.isInteger(r.fixedStats[k]) && r.fixedStats[k] >= 0 && r.fixedStats[k] <= 1000)) p.push(`${at}: fixedStats.${k} must be 0..1000`);
      if (r.statCap !== null && !(Number.isInteger(r.statCap) && r.statCap > 0)) p.push(`${at}: statCap`);
      if (!(Number.isInteger(r.cpuLevel) && r.cpuLevel >= 1 && r.cpuLevel <= 5)) p.push(`${at}: cpuLevel 1..5`);
      if (!(Number.isInteger(r.maxPlayers) && r.maxPlayers >= 2 && r.maxPlayers <= 12)) p.push(`${at}: maxPlayers 2..12`);
      if (!(Number.isInteger(r.cpuFillAfterMs) && r.cpuFillAfterMs >= 1000)) p.push(`${at}: cpuFillAfterMs`);
    }
    if (!ev.points || ev.points.byPlace.length > 12 || ev.points.byPlace.some((x) => !Number.isInteger(x) || x < 0) || !(Number.isInteger(ev.points.participation) && ev.points.participation >= 0)) {
      p.push(`${at}: points`);
    }
    const ms = (ev.milestones ?? []).map((x) => x.points);
    if (ms.some((x, i) => !Number.isInteger(x) || x <= 0 || (i > 0 && x <= ms[i - 1]!))) p.push(`${at}: milestones must be ascending positive points`);
    const rr = ev.rankRewards ?? [];
    if (rr.some((b, i) => i < rr.length - 1 && (b.maxRank === null || (rr[i + 1]!.maxRank !== null && rr[i + 1]!.maxRank! <= b.maxRank)))) p.push(`${at}: rankRewards must be ascending maxRank with null last`);
    // REQ-BREED-022: a horse reward names a known template; a seasonal one only inside its window
    const byId = (m as Partial<Pick<Master, 'templateById'>>).templateById;
    for (const r of [...(ev.milestones ?? []), ...rr].map((x) => x.reward)) {
      if (!r?.horse) continue;
      const t = byId?.get(r.horse);
      if (byId && !t) p.push(`${at}: reward horse ${r.horse} unknown`);
      if (t?.seasonal && (ev.startAtMs < t.seasonal.startAtMs || ev.endAtMs > t.seasonal.endAtMs)) p.push(`${at}: seasonal reward horse ${r.horse} outside its window`);
    }
  }
  return p;
}

export function validateEvents(m: Pick<Master, 'tracks' | 'progression'>, events: EventDef[], base: Ruleset = DEFAULT_RULESET) {
  const p = eventProblems(m, events, base);
  if (p.length) throw new AppError('CONFIG_INVALID', p.join('; '));
}

/**
 * REQ-EVENT-003: the event's ruleset = active ruleset + overrides. The key set never changes (verified by
 * buildRuleset) and the version is suffixed so a replay log states exactly which rules were used.
 */
export function eventRuleset(base: Ruleset, ev: EventDef): Ruleset {
  const o = ev.rules.rulesetOverrides ?? {};
  if (Object.keys(o).length === 0) return base;
  for (const k of Object.keys(o)) if (PROTECTED_KEYS.has(k)) throw new AppError('CONFIG_INVALID', `ruleset override of ${k} is not allowed`);
  return buildRuleset({ ...base, ...o, rulesetVersion: `${base.rulesetVersion}+ev.${ev.id}` });
}

// ------------------------------------------------------------------------------------- entry

export function ensureEvent(s: PlayerState, eventId: string): PlayerEventState {
  s.events ??= {};
  return (s.events[eventId] ??= { points: 0, races: 0, wins: 0, milestones: [], pending: null, closed: false, rank: null });
}

/** REQ-EVENT-002: reasons the player (with this horse) may not enter; empty = eligible. */
export function entryProblems(ev: EventDef, s: PlayerState, horse: HorseInstance | null, now: number): string[] {
  const p: string[] = [];
  if (eventStatus(ev, now) !== 'open') p.push('event_not_open');
  if (ev.entry.classIds && !ev.entry.classIds.includes(s.season.classId)) p.push('class');
  if (s.rating.rankedRaces < ev.entry.minRankedRaces) p.push('ranked_races');
  if (horse) {
    if (ev.entry.styles && !ev.entry.styles.includes(horse.style)) p.push('style');
    if (horse.status !== 'active') p.push('horse_not_active');
  }
  return p;
}

function chargeFee(s: PlayerState, fee: EventFee, now: number, ref: string) {
  if (fee.kind === 'free') spendFree(s, fee.freeCoins, now, 'event entry fee', ref);
  else if (fee.kind === 'item') {
    const have = s.items[fee.itemId] ?? 0;
    if (have < fee.qty) throw new AppError('INSUFFICIENT_ITEMS', `need ${fee.qty} ${fee.itemId}`);
    s.items[fee.itemId] = have - fee.qty;
    if (s.items[fee.itemId] === 0) delete s.items[fee.itemId];
  }
}

function refundFee(s: PlayerState, fee: EventFee, now: number, ref: string) {
  if (fee.kind === 'free') grantFree(s, fee.freeCoins, now, 'event entry fee refund', ref);
  else if (fee.kind === 'item') addItems(s, [{ itemId: fee.itemId, qty: fee.qty }]);
}

/**
 * REQ-EVENT-004: takes the entry fee and holds it for the race. A fee held longer than STALE_ENTRY_MS
 * without a race result is refunded first (lost queue entry). Returns the existing entry if one is held.
 */
export function enterEvent(ev: EventDef, s: PlayerState, horse: HorseInstance, entryId: string, now: number) {
  const st = ensureEvent(s, ev.id);
  if (st.pending && now - st.pending.at >= STALE_ENTRY_MS) cancelEntry(s, ev.id, st.pending.entryId, now);
  if (st.pending) return { entryId: st.pending.entryId, fee: st.pending.fee, existing: true };
  const problems = entryProblems(ev, s, horse, now);
  if (problems.includes('event_not_open')) throw new AppError('EVENT_CLOSED');
  if (problems.length) throw new AppError('NOT_ELIGIBLE', problems.join(','));
  chargeFee(s, ev.fee, now, `event:${ev.id}:${entryId}`);
  st.pending = { entryId, fee: ev.fee, at: now };
  return { entryId, fee: ev.fee, existing: false };
}

/** Refunds a held fee (queue cancelled, matchmaking refused, or the race was void). Idempotent. */
export function cancelEntry(s: PlayerState, eventId: string, entryId: string | null, now: number) {
  const st = ensureEvent(s, eventId);
  if (!st.pending || (entryId !== null && st.pending.entryId !== entryId)) return { refunded: false };
  refundFee(s, st.pending.fee, now, `event:${eventId}:${st.pending.entryId}`);
  st.pending = null;
  return { refunded: true };
}

// ------------------------------------------------------------------------------------- results

export const pointsFor = (ev: EventDef, place: number) => (ev.points.byPlace[place - 1] ?? 0) + ev.points.participation;

/**
 * REQ-EVENT-005: applies one event race (the caller makes this idempotent per race id). A void race
 * refunds the held fee and scores nothing. Milestone rewards are paid once each.
 */
export function applyEventResult(ev: EventDef, s: PlayerState, r: { raceId: string; place: number; void: boolean }, now: number, m?: Pick<Master, 'templateById'>) {
  const st = ensureEvent(s, ev.id);
  if (r.void) {
    const c = cancelEntry(s, ev.id, null, now);
    return { gained: 0, total: st.points, races: st.races, milestones: [] as Reward[], refunded: c.refunded };
  }
  st.pending = null; // the fee was consumed by this race
  const gained = pointsFor(ev, r.place);
  st.points += gained;
  st.races += 1;
  if (r.place === 1) st.wins += 1;
  const paid: Reward[] = [];
  for (const ms of ev.milestones) {
    if (st.points >= ms.points && !st.milestones.includes(ms.points)) {
      st.milestones.push(ms.points);
      grantReward(s, ms.reward, now, `event ${ev.id} ${ms.points}pt`, `event:${ev.id}:ms:${ms.points}`, m);
      paid.push(ms.reward);
    }
  }
  return { gained, total: st.points, races: st.races, milestones: paid, refunded: false };
}

export function eventRankReward(ev: EventDef, rank: number | null): Reward | null {
  for (const b of ev.rankRewards) if (b.maxRank === null || (rank !== null && rank <= b.maxRank)) return b.reward;
  return null;
}

/** REQ-EVENT-008: final rank reward, once; players who never raced get nothing. */
/** `give` (REQ-BOX-001): where the rank reward goes (the service passes the gift box; absent = straight into the wallet). */
export function closeEventForPlayer(ev: EventDef, s: PlayerState, rank: number | null, now: number, m?: Pick<Master, 'templateById'>, give?: Give) {
  const st = ensureEvent(s, ev.id);
  if (st.closed) return { status: 'already' as const, reward: null };
  st.closed = true;
  st.rank = rank;
  // a fee still held when the event is over can never be used: give it back
  if (st.pending) cancelEntry(s, ev.id, null, now);
  const reward = st.races > 0 ? eventRankReward(ev, rank) : null;
  if (reward) {
    if (give) give(reward, `event ${ev.id} rank ${rank ?? '-'}`, `event:${ev.id}:rank`, 'event', rank);
    else grantReward(s, reward, now, `event ${ev.id} rank ${rank ?? '-'}`, `event:${ev.id}:rank`, m);
  }
  return { status: 'rewarded' as const, reward };
}

// ------------------------------------------------------------------------------------- board

export interface EventEntry { playerId: string; eventId: string; points: number; races: number; wins: number; displayName: string; updatedAt: number }
export interface EventBoardRow { rank: number; playerId: string; displayName: string; points: number; races: number; wins: number }
export interface EventBoardFile { eventId: string; generatedAt: number; total: number; entries: EventBoardRow[] }

export const eventBoardKey = (eventId: string) => `events/${eventId}/board.json`;

/** Points desc → wins desc → reached earlier → player id. */
export function compareEvent(a: EventEntry, b: EventEntry) {
  return b.points - a.points || b.wins - a.wins || a.updatedAt - b.updatedAt || (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0);
}

export function buildEventBoard(eventId: string, entries: EventEntry[], now: number, topN: number) {
  const list = entries.filter((e) => e.eventId === eventId && e.races > 0).sort(compareEvent);
  const ranks = new Map(list.map((e, i) => [e.playerId, { rank: i + 1, total: list.length }]));
  const file: EventBoardFile = {
    eventId, generatedAt: now, total: list.length,
    entries: list.slice(0, topN).map((e, i) => ({ rank: i + 1, playerId: e.playerId, displayName: e.displayName, points: e.points, races: e.races, wins: e.wins })),
  };
  return { file, ranks };
}

// ------------------------------------------------------------------------------------- views

export function eventPublic(ev: EventDef, now: number) {
  return {
    id: ev.id, name: ev.name, banner: assetKeys.eventBanner(ev.id), status: eventStatus(ev, now), startAtMs: ev.startAtMs, endAtMs: ev.endAtMs, trackIds: ev.trackIds,
    entry: ev.entry, fee: ev.fee,
    rules: { fixedStats: ev.rules.fixedStats, statCap: ev.rules.statCap, rulesetOverrides: ev.rules.rulesetOverrides, maxPlayers: ev.rules.maxPlayers },
    points: ev.points, milestones: ev.milestones, rankRewards: ev.rankRewards,
  };
}

export function eventsForPlayer(m: Master, s: PlayerState, now: number) {
  return m.events
    .filter((ev) => now < ev.endAtMs + 7 * 24 * 3600_000) // hide events closed more than a week ago
    .sort((a, b) => a.startAtMs - b.startAtMs)
    .map((ev) => {
      const st = s.events?.[ev.id];
      const problems = entryProblems(ev, s, null, now).filter((x) => x !== 'event_not_open');
      return {
        ...eventPublic(ev, now), eligible: problems.length === 0, notEligibleReasons: problems,
        me: st ? { points: st.points, races: st.races, wins: st.wins, milestones: st.milestones, pending: st.pending !== null, closed: st.closed, rank: st.rank } : null,
      };
    });
}

// ------------------------------------------------------------------------------------- cron

/** Start notifications are only sent this long after the start (a late cron must not announce an old event). */
export const START_NOTICE_WINDOW_MS = 6 * 3600_000;
/** After rewards are paid, the event's object is still visited this long (resumable steps) and then ignored. */
const CLOSE_VISIT_MS = 7 * 24 * 3600_000;

export interface EventCronAction { eventId: string; snapshot: boolean; notifyStart: boolean; close: boolean }

/** REQ-EVENT-007..009: what the 5-minute cron does for each configured event at `now`. */
export function eventCronPlan(events: EventDef[], now: number): EventCronAction[] {
  const out: EventCronAction[] = [];
  for (const ev of events) {
    const closeAt = ev.endAtMs + EVENT_SETTLE_GRACE_MS;
    const live = now >= ev.startAtMs && now < closeAt;
    const notifyStart = now >= ev.startAtMs && now < ev.startAtMs + START_NOTICE_WINDOW_MS && now < ev.endAtMs;
    const close = now >= closeAt && now < closeAt + CLOSE_VISIT_MS;
    if (live || notifyStart || close) out.push({ eventId: ev.id, snapshot: live, notifyStart, close });
  }
  return out;
}
