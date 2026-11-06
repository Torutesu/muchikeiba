import { AppError } from './errors.js';
import { spectateDelayMsFor } from './raceRoom.js';
import type { RaceMode } from './schemas.js';
import type { CreatedRace } from '../race/orchestrate.js';

/**
 * REQ-SPEC-*: watching live races. A spectator joins the race room with a ticket for slot -1 and gets the
 * same confirmed input bundles as the players (delayed for races with something at stake), never inputs.
 */

/** A race stays in the live list this long after its start (then it is surely over). */
export const LIVE_RACE_TTL_MS = 15 * 60_000;
/** Spectator tickets last as long as a race can (they only open a read-only socket). */
export const SPECTATOR_TICKET_TTL_MS = LIVE_RACE_TTL_MS;
/** Number of featured races in the public list (highest average rating first). */
export const FEATURED_LIMIT = 20;

export type LiveVisibility = 'public' | 'friends';

export interface LiveRace {
  raceId: string;
  mode: RaceMode;
  startAtMs: number;
  trackId: string;
  /** public: ranked / event / tournament heats; friends: friend rooms (participants and their friends). */
  visibility: LiveVisibility;
  playerIds: string[];
  /** Average rating of the humans (featured ordering). */
  rating: number;
  delayMs: number;
  title: string | null;
  tournamentId: string | null;
}

/** The live-list record for a race just created (tutorials are not watchable). */
export function liveRaceOf(created: CreatedRace, extra: { title?: string; tournamentId?: string } | null): LiveRace | null {
  const c = created.config;
  if (c.mode === 'tutorial' || c.mode === 'timeattack') return null;
  const humans = c.entrants.filter((e) => e.kind === 'human').map((e) => e.playerId!);
  const ratings = humans.map((p) => created.ratings[p]?.r ?? 1500);
  return {
    raceId: c.raceId, mode: c.mode, startAtMs: created.startAtMs, trackId: c.track.id,
    visibility: c.mode === 'friend' ? 'friends' : 'public',
    playerIds: humans,
    rating: ratings.length ? Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length) : 0,
    delayMs: spectateDelayMsFor(c.mode),
    title: extra?.title ?? null,
    tournamentId: extra?.tournamentId ?? null,
  };
}

export interface SpectatePorts {
  liveRaces(): Promise<LiveRace[]>;
  liveRace(raceId: string): Promise<LiveRace | null>;
  /** The viewer's friend ids. */
  friendIds(uid: string): Promise<string[]>;
  signTicket(t: { raceId: string; slot: number; playerId: string; exp: number }): Promise<string>;
}

export interface LiveRaceView extends Omit<LiveRace, 'playerIds'> {
  players: number;
  /** Friends of the viewer racing in it. */
  friends: string[];
  you: boolean;
}

export class SpectateService {
  constructor(private readonly p: SpectatePorts, private readonly clock: () => number = Date.now) {}

  private canWatch(l: LiveRace, uid: string, friends: Set<string>) {
    if (l.visibility === 'public') return true;
    return l.playerIds.includes(uid) || l.playerIds.some((p) => friends.has(p));
  }

  private view(l: LiveRace, uid: string, friends: Set<string>): LiveRaceView {
    const { playerIds, ...rest } = l;
    return { ...rest, players: playerIds.length, friends: playerIds.filter((p) => friends.has(p)), you: playerIds.includes(uid) };
  }

  /** REQ-SPEC-001: friends' races first, then featured public races (tournament heats, then by rating). */
  async list(uid: string) {
    const now = this.clock();
    const friends = new Set(await this.p.friendIds(uid));
    const all = (await this.p.liveRaces()).filter((l) => now - l.startAtMs < LIVE_RACE_TTL_MS && this.canWatch(l, uid, friends));
    const withFriends = all.filter((l) => l.playerIds.some((p) => friends.has(p)) || l.playerIds.includes(uid));
    const featured = all
      .filter((l) => !withFriends.includes(l))
      .sort((a, b) => Number(b.mode === 'tournament') - Number(a.mode === 'tournament') || b.rating - a.rating || b.startAtMs - a.startAtMs)
      .slice(0, FEATURED_LIMIT);
    return {
      friends: withFriends.sort((a, b) => b.startAtMs - a.startAtMs).map((l) => this.view(l, uid, friends)),
      featured: featured.map((l) => this.view(l, uid, friends)),
      generatedAt: now,
    };
  }

  /** REQ-SPEC-002: a read-only ticket (slot -1) for the race's WebSocket. */
  async spectate(uid: string, raceId: string) {
    const l = await this.p.liveRace(raceId);
    const now = this.clock();
    if (!l || now - l.startAtMs >= LIVE_RACE_TTL_MS) throw new AppError('NOT_FOUND', 'race is not live');
    if (l.visibility !== 'public' && !this.canWatch(l, uid, new Set(await this.p.friendIds(uid)))) throw new AppError('FORBIDDEN', 'friend races can be watched by friends of a participant');
    const ticket = await this.p.signTicket({ raceId, slot: -1, playerId: uid, exp: now + SPECTATOR_TICKET_TTL_MS });
    return { raceId, ticket, wsPath: `/v1/race/${raceId}/ws`, startAtMs: l.startAtMs, delayMs: l.delayMs, mode: l.mode, title: l.title, tournamentId: l.tournamentId };
  }
}
