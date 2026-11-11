import { AppError } from './errors.js';
import { randInt, type Rng } from './rng.js';
import type { EventDef } from './master.js';
import { eventStatus } from './events.js';

/** `quarantined` players (REQ-OPS-032) are matched only with each other, or filled with CPU. */
export interface QueueEntry<P = unknown> {
  playerId: string; rating: number; beginner: boolean; enqueuedAt: number; payload: P; quarantined?: boolean;
  /** REQ-UXS-003: this entry's own CPU fill wait (a player's first ranked race waits less). Absent = the queue default. */
  cpuFillAfterMs?: number;
}
export interface Match<P = unknown> { players: QueueEntry<P>[]; cpuCount: number; cpuLevel: number; beginner: boolean; quarantined: boolean }

export interface MatchmakerOptions { maxPlayers: number; cpuFillAfterMs: number; baseWindow: number; widenPerSec: number; maxWindow: number }
export const DEFAULT_MM: MatchmakerOptions = { maxPlayers: 12, cpuFillAfterMs: 15_000, baseWindow: 100, widenPerSec: 25, maxWindow: 600 };

export function cpuLevelFor(avgRating: number, beginner: boolean): number {
  if (beginner) return 1;
  return avgRating < 1400 ? 2 : avgRating < 1600 ? 3 : avgRating < 1800 ? 4 : 5;
}

/** REQ-MM-001..003: rating-window matchmaking with time-based widening and CPU fill. Pure. */
export class MatchmakerCore<P = unknown> {
  private queue: QueueEntry<P>[] = [];
  constructor(private readonly opts: MatchmakerOptions = DEFAULT_MM) {}

  get size() { return this.queue.length; }
  entries() { return [...this.queue]; }
  has(playerId: string) { return this.queue.some((e) => e.playerId === playerId); }

  enqueue(e: QueueEntry<P>) {
    if (this.has(e.playerId)) throw new AppError('ALREADY_QUEUED');
    this.queue.push(e);
  }

  /** Puts players of a match that could not be started back in the queue, keeping their wait time. */
  requeue(entries: QueueEntry<P>[]) {
    for (const e of entries) if (!this.has(e.playerId)) this.queue.push(e);
  }

  cancel(playerId: string) {
    const n = this.queue.length;
    this.queue = this.queue.filter((e) => e.playerId !== playerId);
    if (this.queue.length === n) throw new AppError('NOT_IN_QUEUE');
  }

  window(e: QueueEntry<P>, now: number) {
    const waitedSec = Math.max(0, now - e.enqueuedAt) / 1000;
    return Math.min(this.opts.maxWindow, this.opts.baseWindow + this.opts.widenPerSec * waitedSec);
  }

  tick(now: number): Match<P>[] {
    const matches: Match<P>[] = [];
    for (const [beginner, quarantined] of [[true, false], [false, false], [true, true], [false, true]] as const) {
      const pool = this.queue.filter((e) => e.beginner === beginner && (e.quarantined ?? false) === quarantined).sort((a, b) => a.enqueuedAt - b.enqueuedAt);
      const used = new Set<string>();
      for (const anchor of pool) {
        if (used.has(anchor.playerId)) continue;
        const w = this.window(anchor, now);
        const group = [anchor, ...pool
          .filter((e) => e !== anchor && !used.has(e.playerId) && Math.abs(e.rating - anchor.rating) <= Math.min(w, this.window(e, now)))
          .sort((a, b) => Math.abs(a.rating - anchor.rating) - Math.abs(b.rating - anchor.rating) || a.enqueuedAt - b.enqueuedAt)
          .slice(0, this.opts.maxPlayers - 1)];
        const full = group.length >= this.opts.maxPlayers;
        if (full || now - anchor.enqueuedAt >= (anchor.cpuFillAfterMs ?? this.opts.cpuFillAfterMs)) {
          for (const g of group) used.add(g.playerId);
          const avg = group.reduce((a, g) => a + g.rating, 0) / group.length;
          matches.push({ players: group, cpuCount: this.opts.maxPlayers - group.length, cpuLevel: cpuLevelFor(avg, beginner), beginner, quarantined });
        }
      }
      this.queue = this.queue.filter((e) => !used.has(e.playerId));
    }
    return matches;
  }

  toJSON() { return { queue: this.queue }; }
  static fromJSON<P>(s: { queue: QueueEntry<P>[] }, opts: MatchmakerOptions = DEFAULT_MM) {
    const m = new MatchmakerCore<P>(opts);
    m.queue = [...s.queue];
    return m;
  }
}

/** REQ-MM-004: friend rooms joined by passphrase; host starts; no rating change. */
export interface FriendRoom<P = unknown> {
  passphrase: string; hostId: string; createdAt: number; members: { playerId: string; payload: P }[];
  /** REQ-LINK-015: a rematch room races on the previous race's conditions (snapshot), not the host's current preset. */
  conditions?: import('./presets.js').RoomConditions | null;
  /** REQ-LINK-015: the race this room is the rematch of. */
  rematchOf?: string;
}

/** Upper bound of open rooms in one matchmaker (each host has at most one; this caps total storage). */
export const MAX_OPEN_ROOMS = 20_000;

export class FriendRooms<P = unknown> {
  rooms = new Map<string, FriendRoom<P>>();
  constructor(private readonly maxPlayers = 12, private readonly ttlMs = 30 * 60_000, private readonly minPlayers = 2, private readonly maxRooms = MAX_OPEN_ROOMS) {}

  isMember(passphrase: string, playerId: string, now?: number) {
    if (now !== undefined) this.gc(now);
    return this.rooms.get(passphrase)?.members.some((m) => m.playerId === playerId) ?? false;
  }

  /** Expired rooms are dropped on every operation (and by the matchmaker's alarm). */
  prune(now: number) { return this.gc(now); }

  /** The open room the player hosts, if any. */
  hostedBy(hostId: string): FriendRoom<P> | null {
    for (const r of this.rooms.values()) if (r.hostId === hostId) return r;
    return null;
  }

  /** Puts a room back after a start that failed (members keep their room and passphrase). */
  restore(room: FriendRoom<P>) {
    if (!this.rooms.has(room.passphrase)) this.rooms.set(room.passphrase, room);
  }

  toJSON() { return [...this.rooms.values()]; }
  static fromJSON<P>(rooms: FriendRoom<P>[] | undefined, maxPlayers = 12): FriendRooms<P> {
    const f = new FriendRooms<P>(maxPlayers);
    for (const r of rooms ?? []) f.rooms.set(r.passphrase, r);
    return f;
  }

  /**
   * One open room per host: creating again returns the host's existing room (refreshing its entry), so a
   * single account can no longer fill the matchmaker's storage with rooms.
   */
  create(hostId: string, payload: P, now: number, rng: Rng): FriendRoom<P> {
    this.gc(now);
    const own = this.hostedBy(hostId);
    if (own) {
      const host = own.members.find((m) => m.playerId === hostId);
      if (host) host.payload = payload;
      return own;
    }
    if (this.rooms.size >= this.maxRooms) throw new AppError('RATE_LIMITED', 'too many open friend rooms; try again later');
    let pass: string;
    do pass = String(randInt(rng, 1_000_000)).padStart(6, '0');
    while (this.rooms.has(pass));
    const room: FriendRoom<P> = { passphrase: pass, hostId, createdAt: now, members: [{ playerId: hostId, payload }] };
    this.rooms.set(pass, room);
    return room;
  }

  /**
   * REQ-LINK-015: a rematch room, opened with its members already in (the host must not host another open room; the caller
   * checks). Same passphrase space and lifetime as any friend room.
   */
  createWith(hostId: string, members: { playerId: string; payload: P }[], conditions: import('./presets.js').RoomConditions | null, rematchOf: string, now: number, rng: Rng): FriendRoom<P> {
    this.gc(now);
    if (this.hostedBy(hostId)) throw new AppError('CONFLICT', 'the host already has an open room');
    if (this.rooms.size >= this.maxRooms) throw new AppError('RATE_LIMITED', 'too many open friend rooms; try again later');
    let pass: string;
    do pass = String(randInt(rng, 1_000_000)).padStart(6, '0');
    while (this.rooms.has(pass));
    const room: FriendRoom<P> = { passphrase: pass, hostId, createdAt: now, members: members.slice(0, this.maxPlayers).map((m) => ({ ...m })), conditions, rematchOf };
    this.rooms.set(pass, room);
    return room;
  }

  /** REQ-LINK-007: is the room still open (a room link opens only then)? */
  isOpen(passphrase: string, now: number) { this.gc(now); return this.rooms.has(passphrase); }

  join(passphrase: string, playerId: string, payload: P, now: number): FriendRoom<P> {
    this.gc(now);
    const r = this.rooms.get(passphrase);
    if (!r) throw new AppError('ROOM_NOT_FOUND');
    if (r.members.some((m) => m.playerId === playerId)) return r;
    if (r.members.length >= this.maxPlayers) throw new AppError('ROOM_FULL');
    r.members.push({ playerId, payload });
    return r;
  }

  start(passphrase: string, playerId: string, now?: number): FriendRoom<P> {
    if (now !== undefined) this.gc(now);
    const r = this.rooms.get(passphrase);
    if (!r) throw new AppError('ROOM_NOT_FOUND');
    if (r.hostId !== playerId) throw new AppError('NOT_HOST');
    // REQ-MM-004: a friend race needs at least two humans (a solo room would be a free reward farm)
    if (r.members.length < this.minPlayers) throw new AppError('ROOM_TOO_SMALL', 'a friend race needs at least 2 players');
    this.rooms.delete(passphrase);
    return r;
  }

  private gc(now: number) {
    let n = 0;
    for (const [k, r] of this.rooms) if (now - r.createdAt > this.ttlMs) { this.rooms.delete(k); n++; }
    return n;
  }
}

/**
 * Persisted rows of a matchmaker, keyed for row-level storage (REQ-MM-007): one row per queued player
 * per pool, per assignment and per friend room — never one blob (a single value has a 2 MiB ceiling
 * that a few thousand concurrent players, or one abusive account, would reach).
 */
export type RowMap = Map<string, string>;

/** Rows to write and delete to go from the last persisted state to the current one (only changes). */
export function diffRows(prev: RowMap, next: RowMap): { upserts: [string, string][]; deletes: string[] } {
  const upserts: [string, string][] = [];
  const deletes: string[] = [];
  for (const [k, v] of next) if (prev.get(k) !== v) upserts.push([k, v]);
  for (const k of prev.keys()) if (!next.has(k)) deletes.push(k);
  return { upserts, deletes };
}

/**
 * Marker written for every player of a match *before* the race is created (an await that lets other
 * requests in): while it is present the player counts as in a live race, so a concurrent enqueue,
 * event cancel or friend start cannot slip through the gap. It is replaced by the real assignment, or
 * removed if starting the race fails.
 */
export const PENDING_RACE_ID = 'pending';
export const isPendingAssignment = (a: { raceId: string }) => a.raceId === PENDING_RACE_ID;

/** How long a match assignment counts as a race in progress (start delay + longest race + settle margin). */
export const LIVE_RACE_MS = 6 * 60_000;

/** REQ-MM-005: one live race per player — joining a queue or a race while one is running is refused. */
export function assertNotInLiveRace(assignments: Map<string, { at: number }>, playerId: string, now: number) {
  const a = assignments.get(playerId);
  if (a && now - a.at < LIVE_RACE_MS) throw new AppError('ALREADY_IN_RACE');
}

/**
 * REQ-EVENT-006: one separate pool per event (players never meet ranked players in an event race).
 * Each pool uses the event's own field size and CPU-fill wait. Pools of closed or removed events are
 * dropped on the next tick; the players' held fees are refunded by the player side (stale entry / event close).
 */
export class EventPools<P = unknown> {
  private pools = new Map<string, MatchmakerCore<P>>();

  private optsFor(ev: EventDef): MatchmakerOptions {
    return { ...DEFAULT_MM, maxPlayers: ev.rules.maxPlayers, cpuFillAfterMs: ev.rules.cpuFillAfterMs };
  }

  has(playerId: string) { return [...this.pools.values()].some((p) => p.has(playerId)); }
  eventOf(playerId: string) { return [...this.pools.entries()].find(([, p]) => p.has(playerId))?.[0] ?? null; }
  get size() { return [...this.pools.values()].reduce((a, p) => a + p.size, 0); }

  /** Re-queueing for the same event is an idempotent success ('already'); another event's queue is a conflict. */
  enqueue(ev: EventDef, e: QueueEntry<P>, now: number): 'queued' | 'already' {
    if (eventStatus(ev, now) !== 'open') throw new AppError('EVENT_CLOSED');
    const current = this.eventOf(e.playerId);
    if (current === ev.id) return 'already';
    if (current) throw new AppError('ALREADY_QUEUED', `queued for event ${current}`);
    let pool = this.pools.get(ev.id);
    if (!pool) this.pools.set(ev.id, (pool = new MatchmakerCore<P>(this.optsFor(ev))));
    pool.enqueue(e);
    return 'queued';
  }

  /** Returns false when the player was not queued for this event (nothing to cancel). */
  cancel(eventId: string, playerId: string): boolean {
    const pool = this.pools.get(eventId);
    if (!pool?.has(playerId)) return false;
    pool.cancel(playerId);
    return true;
  }

  /**
   * Puts the players of a match that could not start back in their event's pool. tick() drops a pool
   * once it is empty, so the pool is recreated when needed (otherwise the players would be lost).
   */
  requeue(eventId: string, entries: QueueEntry<P>[], ev?: EventDef) {
    let pool = this.pools.get(eventId);
    if (!pool && ev) this.pools.set(eventId, (pool = new MatchmakerCore<P>(this.optsFor(ev))));
    pool?.requeue(entries);
  }

  /** Matches per event; pools whose event is over (or gone) are emptied and reported as dropped. */
  tick(now: number, events: EventDef[]): { eventId: string; event: EventDef; match: Match<P> }[] {
    const out: { eventId: string; event: EventDef; match: Match<P> }[] = [];
    for (const [id, pool] of [...this.pools]) {
      const ev = events.find((e) => e.id === id);
      if (!ev || eventStatus(ev, now) === 'closed') {
        this.pools.delete(id);
        continue;
      }
      for (const match of pool.tick(now)) out.push({ eventId: id, event: ev, match });
      if (pool.size === 0) this.pools.delete(id);
    }
    return out;
  }

  toJSON(): Record<string, QueueEntry<P>[]> {
    return Object.fromEntries([...this.pools].map(([k, p]) => [k, p.entries()]));
  }
  static fromJSON<P>(s: Record<string, QueueEntry<P>[]> | undefined, events: EventDef[]): EventPools<P> {
    const e = new EventPools<P>();
    for (const [id, queue] of Object.entries(s ?? {})) {
      const ev = events.find((x) => x.id === id);
      if (ev) e.pools.set(id, MatchmakerCore.fromJSON({ queue }, e.optsFor(ev)));
    }
    return e;
  }
}

/** REQ-OPS-033: banned players cannot queue or join rooms. */
export function assertMayRace(entry: { moderation?: 'ok' | 'quarantined' | 'banned' }) {
  if (entry.moderation === 'banned') throw new AppError('BANNED', 'racing is disabled for this account');
}
