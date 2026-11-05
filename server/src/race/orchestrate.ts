import type { Master } from '../domain/master.js';
import type { Ruleset } from '../domain/ruleset.js';
import { buildRaceConfig } from '../domain/raceConfig.js';
import { randInt, randomId, type Rng } from '../domain/rng.js';
import type { RaceMode, RaceStartConfig, ReplayLog } from '../domain/schemas.js';
import { raceDetailsFor } from '../domain/stats.js';
import { updateRace, type Rating } from '../domain/rating.js';
import type { FinalOutcome } from '../domain/raceRoom.js';
import type { RaceResultForPlayer } from '../domain/rewards.js';
import type { RaceEntry } from '../http/app.js';
import { signTicket } from '../http/ticket.js';

export const START_DELAY_MS = 6000; // time for clients to connect + countdown before tick 0
export const TICKET_TTL_MS = 10 * 60_000;

export interface Assignment { raceId: string; slot: number; ticket: string; startAtMs: number; wsPath: string }

export interface CreatedRace { config: RaceStartConfig; startAtMs: number; ratings: Record<string, Rating>; assignments: Record<string, Assignment> }

export async function createRace(m: Master, o: { mode: RaceMode; humans: RaceEntry[]; cpuCount: number; cpuLevel: number; rng: Rng; now: number; ticketSecret: string; trackId?: string; ruleset?: Ruleset }): Promise<CreatedRace> {
  const raceId = randomId('r', o.rng);
  const trackId = o.trackId ?? (o.mode === 'tutorial' ? 'aoba_turf_1600' : m.tracks[randInt(o.rng, m.tracks.length)]!.id);
  const statCap = o.mode === 'ranked' ? Math.min(...o.humans.map((h) => h.statCap)) : null;
  const config = buildRaceConfig(m, {
    raceId, mode: o.mode, trackId, statCap, cpuCount: o.cpuCount, cpuLevel: o.cpuLevel, rng: o.rng,
    humans: o.humans.map((h) => ({ playerId: h.playerId, horse: h.horse, cpuLevel: 3 })),
    // REQ-OPS-006: the active ruleset is embedded in the config, so the replay log carries it to the verifier
    ...(o.ruleset ? { rulesetOverrides: o.ruleset } : {}),
  });
  const startAtMs = o.now + START_DELAY_MS;
  const assignments: Record<string, Assignment> = {};
  for (const e of config.entrants) {
    if (e.kind !== 'human') continue;
    const ticket = await signTicket({ raceId, slot: e.slot, playerId: e.playerId!, exp: o.now + TICKET_TTL_MS }, o.ticketSecret);
    assignments[e.playerId!] = { raceId, slot: e.slot, ticket, startAtMs, wsPath: `/v1/race/${raceId}/ws` };
  }
  const ratings: Record<string, Rating> = {};
  for (const h of o.humans) ratings[h.playerId] = h.rating;
  return { config, startAtMs, ratings, assignments };
}

/**
 * Turns a final race outcome into per-player results (places, rating updates for ranked, ride details
 * for statistics/titles derived from the confirmed input log when it is given).
 */
export function settleRace(config: RaceStartConfig, final: FinalOutcome, ratings: Record<string, Rating>, log?: ReplayLog): Record<string, RaceResultForPlayer> {
  const out: Record<string, RaceResultForPlayer> = {};
  const humans = config.entrants.filter((e) => e.kind === 'human');
  if (final.status === 'void') {
    for (const h of humans) out[h.playerId!] = { raceId: config.raceId, mode: config.mode, place: 0, fieldSize: config.entrants.length, newRating: null, void: true };
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
    };
  }
  return out;
}
