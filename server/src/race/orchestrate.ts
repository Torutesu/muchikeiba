import type { EventDef, Master } from '../domain/master.js';
import { eventRuleset } from '../domain/events.js';
import { DEFAULT_RULESET, type Ruleset } from '../domain/ruleset.js';
import { buildRaceConfig } from '../domain/raceConfig.js';
import { groundFor } from '../domain/ground.js';
import { randInt, randomId, type Rng } from '../domain/rng.js';
import type { RaceMode, RaceStartConfig, ReplayLog } from '../domain/schemas.js';
import { raceDetailsFor } from '../domain/stats.js';
import { updateRace, type Rating } from '../domain/rating.js';
import type { FinalOutcome } from '../domain/raceRoom.js';
import type { RaceResultForPlayer } from '../domain/rewards.js';
import type { RaceEntry } from '../http/app.js';
import { signTicket } from '../http/ticket.js';
import { assetKeys, startVisuals, type StartVisuals } from '../domain/visuals.js';
import { roomGround, roomScene, type RoomConditions } from '../domain/presets.js';
import { friendRoomBondPermille } from '../domain/bond.js';
import { STAT_KEYS } from '../domain/master.js';

export const START_DELAY_MS = 6000; // time for clients to connect + countdown before tick 0
export const TICKET_TTL_MS = 10 * 60_000;

export interface Assignment { raceId: string; slot: number; ticket: string; startAtMs: number; wsPath: string }

export interface CreatedRace {
  config: RaceStartConfig; startAtMs: number; ratings: Record<string, Rating>; assignments: Record<string, Assignment>;
  /** REQ-ASSET-006: looks of every runner + the track scene; sent in `start` beside the (hashed) config. */
  visuals: StartVisuals;
}

export interface CreateRaceOptions {
  mode: RaceMode; humans: RaceEntry[]; cpuCount: number; cpuLevel: number; rng: Rng; now: number; ticketSecret: string;
  trackId?: string; ruleset?: Ruleset;
  /** REQ-EVENT-003: event races choose among the event's tracks and apply its entrant rules. */
  event?: EventDef;
  /** REQ-ROOM-003: friend rooms race on the host's chosen conditions (null/absent = as before). */
  roomPreset?: RoomConditions | null;
  /** REQ-TOUR-005: tournament heats start at their scheduled time (default now + START_DELAY_MS). */
  startAtMs?: number;
  /** REQ-TOUR-003: the tournament's stat cap (null = none); overrides the mode's own rule. */
  statCap?: number | null;
}

export async function createRace(m: Master, o: CreateRaceOptions): Promise<CreatedRace> {
  const raceId = randomId('r', o.rng);
  const ev = o.event;
  const room = o.mode === 'friend' ? o.roomPreset ?? null : null;
  const trackId = o.trackId
    ?? (room?.trackId && m.tracks.some((t) => t.id === room.trackId) ? room.trackId : undefined)
    ?? (ev ? ev.trackIds[randInt(o.rng, ev.trackIds.length)]! : o.mode === 'tutorial' ? 'aoba_turf_1600' : m.tracks[randInt(o.rng, m.tracks.length)]!.id);
  const statCap = o.statCap !== undefined ? o.statCap : ev ? ev.rules.statCap : o.mode === 'ranked' ? Math.min(...o.humans.map((h) => h.statCap)) : null;
  const ruleset = ev ? eventRuleset(o.ruleset ?? DEFAULT_RULESET, ev) : o.ruleset;
  const config = buildRaceConfig(m, {
    raceId, mode: o.mode, trackId, statCap, cpuCount: o.cpuCount, cpuLevel: o.cpuLevel, rng: o.rng,
    // REQ-RACE-037: the day's going for this course; night at lit venues in the evening. REQ-ROOM-003: a friend
    // room with host conditions uses those instead (rooms without conditions are unchanged).
    ground: room ? roomGround(m, room, trackId, o.now) : groundFor(m, trackId, o.mode, o.now),
    humans: o.humans.map((h) => ({ playerId: h.playerId, horse: o.mode === 'friend' ? friendBond(m, h) : h.horse, cpuLevel: 3 })),
    // REQ-OPS-006: the active ruleset is embedded in the config, so the replay log carries it to the verifier
    ...(ruleset ? { rulesetOverrides: ruleset } : {}),
    ...(ev?.rules.fixedStats ? { fixedStats: ev.rules.fixedStats } : {}),
  });
  const startAtMs = Math.max(o.startAtMs ?? 0, o.now + START_DELAY_MS);
  const assignments: Record<string, Assignment> = {};
  for (const e of config.entrants) {
    if (e.kind !== 'human') continue;
    const ticket = await signTicket({ raceId, slot: e.slot, playerId: e.playerId!, exp: startAtMs + TICKET_TTL_MS }, o.ticketSecret);
    assignments[e.playerId!] = { raceId, slot: e.slot, ticket, startAtMs, wsPath: `/v1/race/${raceId}/ws` };
  }
  const ratings: Record<string, Rating> = {};
  for (const h of o.humans) ratings[h.playerId] = h.rating;
  // entries queued by older builds have no `visual`; startVisuals falls back to derived looks
  const visuals = startVisuals(config, Object.fromEntries(o.humans.map((h) => [h.playerId, (h as { visual?: RaceEntry['visual'] }).visual])), undefined, m.bannedSilks);
  if (room) visuals.scene = { ...roomScene(room), keys: { weather: assetKeys.weather(room.weather) } };
  return { config, startAtMs, ratings, assignments, visuals };
}

/**
 * REQ-BOND-006: friend rooms only, and only when the operator enables it (off by default): a tiny stat bump
 * from the horse's bond level. Ranked, event, tutorial and time attack never call this.
 */
function friendBond(m: Master, h: RaceEntry): RaceEntry['horse'] {
  const level = (h as { visual?: { bondLevel?: number } }).visual?.bondLevel ?? 1;
  const pm = friendRoomBondPermille(m.progression.bond, level);
  if (pm === 0) return h.horse;
  const out = { ...h.horse };
  for (const k of STAT_KEYS) out[k] = Math.min(1000, Math.floor((out[k] * (1000 + pm)) / 1000));
  return out;
}

/**
 * Turns a final race outcome into per-player results (places, rating updates for ranked, ride details
 * for statistics/titles derived from the confirmed input log when it is given).
 */
export function settleRace(config: RaceStartConfig, final: FinalOutcome, ratings: Record<string, Rating>, log?: ReplayLog, eventId: string | null = null): Record<string, RaceResultForPlayer> {
  const ev = eventId ? { eventId } : {};
  const out: Record<string, RaceResultForPlayer> = {};
  const humans = config.entrants.filter((e) => e.kind === 'human');
  if (final.status === 'void') {
    for (const h of humans) out[h.playerId!] = { raceId: config.raceId, mode: config.mode, place: 0, fieldSize: config.entrants.length, newRating: null, void: true, ...ev };
    return out;
  }
  const placeOf = new Map(final.order.map((slot, i) => [slot, i + 1]));
  const humanOrder = humans.slice().sort((a, b) => (placeOf.get(a.slot) ?? 99) - (placeOf.get(b.slot) ?? 99)).map((e) => e.playerId!);
  const newRatings = config.mode === 'ranked' && humanOrder.length >= 2
    ? updateRace(new Map(humanOrder.map((p) => [p, ratings[p] ?? { r: 1500, rd: 350, vol: 0.06 }])), humanOrder)
    : new Map<string, Rating>();
  const finishOf = new Map<number, number>();
  if (final.finishTicks && final.finishTicks.length === final.order.length) final.order.forEach((slot, i) => finishOf.set(slot, final.finishTicks![i]!));
  for (const h of humans) {
    const ft = finishOf.get(h.slot);
    out[h.playerId!] = {
      raceId: config.raceId, mode: config.mode, place: placeOf.get(h.slot) ?? config.entrants.length,
      fieldSize: config.entrants.length, newRating: newRatings.get(h.playerId!) ?? null, void: false,
      details: log && config.mode !== 'tutorial' ? raceDetailsFor(config, log, h.slot, ft === undefined || ft < 0 ? null : ft) : null,
      humans: humans.length,
      oldRating: ratings[h.playerId!] ?? null,
      ...ev,
    };
  }
  return out;
}
