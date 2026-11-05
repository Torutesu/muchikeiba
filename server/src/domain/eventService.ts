import { AppError } from './errors.js';
import type { Master } from './master.js';
import { eventStatus, findEvent } from './events.js';

/**
 * REQ-EVENT-*: player-facing event actions. Entering takes the fee on the player's object, then queues
 * the player in the event's own pool; a refused queue entry refunds the fee (no money is ever lost to a
 * failed request).
 */

export interface EventPlayers {
  /** Matchmaker snapshot (horse, rating, class, moderation); same as ranked. */
  raceEntry(uid: string, horseId: string): Promise<Record<string, unknown> & { playerId: string }>;
  enter(uid: string, eventId: string, horseId: string, idemKey: string): Promise<{ entryId: string; existing: boolean }>;
  cancel(uid: string, eventId: string, entryId: string | null): Promise<{ refunded: boolean }>;
  view(uid: string): Promise<unknown[]>;
}

export interface EventMatch {
  enqueue(eventId: string, uid: string, entry: Record<string, unknown>): Promise<unknown>;
  cancel(eventId: string, uid: string): Promise<unknown>;
}

export interface EventBoards {
  board(eventId: string): Promise<unknown>;
  rankOf(eventId: string, uid: string): Promise<{ rank: number; total: number; generatedAt: number | null } | null>;
}

export class EventsService {
  constructor(
    private readonly master: () => Master,
    private readonly players: EventPlayers,
    private readonly match: EventMatch,
    private readonly boards: EventBoards,
    private readonly clock: () => number = Date.now,
  ) {}

  list(uid: string) { return this.players.view(uid); }

  /** REQ-EVENT-002/004: eligibility + fee on the player, then the event pool. */
  async enqueue(uid: string, eventId: string, horseId: string, idemKey: string) {
    const ev = findEvent(this.master(), eventId);
    if (eventStatus(ev, this.clock()) !== 'open') throw new AppError('EVENT_CLOSED');
    const entry = await this.players.raceEntry(uid, horseId);
    const e = await this.players.enter(uid, eventId, horseId, idemKey);
    try {
      const r = await this.match.enqueue(eventId, uid, { ...entry, eventEntryId: e.entryId });
      return { ...(r as object), eventId, entryId: e.entryId };
    } catch (err) {
      // Refund only a fee THIS call charged. An existing entry may be backing a live event race (the pool
      // answers ALREADY_IN_RACE); refunding it would let every race be run for free (review r5 #2).
      if (!e.existing) await this.players.cancel(uid, eventId, e.entryId);
      throw err;
    }
  }

  async cancel(uid: string, eventId: string) {
    await this.match.cancel(eventId, uid);
    const r = await this.players.cancel(uid, eventId, null);
    return { state: 'none', refunded: r.refunded };
  }

  board(eventId: string) {
    findEvent(this.master(), eventId);
    return this.boards.board(eventId);
  }

  async me(uid: string, eventId: string) {
    findEvent(this.master(), eventId);
    const all = (await this.players.view(uid)) as { id: string }[];
    return { event: all.find((e) => e.id === eventId) ?? null, rank: await this.boards.rankOf(eventId, uid) };
  }
}
