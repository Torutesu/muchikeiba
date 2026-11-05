import { AppError } from './errors.js';
import { randInt, type Rng } from './rng.js';

export interface QueueEntry<P = unknown> { playerId: string; rating: number; beginner: boolean; enqueuedAt: number; payload: P }
export interface Match<P = unknown> { players: QueueEntry<P>[]; cpuCount: number; cpuLevel: number; beginner: boolean }

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
    for (const beginner of [true, false]) {
      const pool = this.queue.filter((e) => e.beginner === beginner).sort((a, b) => a.enqueuedAt - b.enqueuedAt);
      const used = new Set<string>();
      for (const anchor of pool) {
        if (used.has(anchor.playerId)) continue;
        const w = this.window(anchor, now);
        const group = [anchor, ...pool
          .filter((e) => e !== anchor && !used.has(e.playerId) && Math.abs(e.rating - anchor.rating) <= Math.min(w, this.window(e, now)))
          .sort((a, b) => Math.abs(a.rating - anchor.rating) - Math.abs(b.rating - anchor.rating) || a.enqueuedAt - b.enqueuedAt)
          .slice(0, this.opts.maxPlayers - 1)];
        const full = group.length >= this.opts.maxPlayers;
        if (full || now - anchor.enqueuedAt >= this.opts.cpuFillAfterMs) {
          for (const g of group) used.add(g.playerId);
          const avg = group.reduce((a, g) => a + g.rating, 0) / group.length;
          matches.push({ players: group, cpuCount: this.opts.maxPlayers - group.length, cpuLevel: cpuLevelFor(avg, beginner), beginner });
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
export interface FriendRoom<P = unknown> { passphrase: string; hostId: string; createdAt: number; members: { playerId: string; payload: P }[] }

export class FriendRooms<P = unknown> {
  rooms = new Map<string, FriendRoom<P>>();
  constructor(private readonly maxPlayers = 12, private readonly ttlMs = 30 * 60_000) {}

  create(hostId: string, payload: P, now: number, rng: Rng): FriendRoom<P> {
    this.gc(now);
    let pass: string;
    do pass = String(randInt(rng, 1_000_000)).padStart(6, '0');
    while (this.rooms.has(pass));
    const room: FriendRoom<P> = { passphrase: pass, hostId, createdAt: now, members: [{ playerId: hostId, payload }] };
    this.rooms.set(pass, room);
    return room;
  }

  join(passphrase: string, playerId: string, payload: P, now: number): FriendRoom<P> {
    this.gc(now);
    const r = this.rooms.get(passphrase);
    if (!r) throw new AppError('ROOM_NOT_FOUND');
    if (r.members.some((m) => m.playerId === playerId)) return r;
    if (r.members.length >= this.maxPlayers) throw new AppError('ROOM_FULL');
    r.members.push({ playerId, payload });
    return r;
  }

  start(passphrase: string, playerId: string): FriendRoom<P> {
    const r = this.rooms.get(passphrase);
    if (!r) throw new AppError('ROOM_NOT_FOUND');
    if (r.hostId !== playerId) throw new AppError('NOT_HOST');
    this.rooms.delete(passphrase);
    return r;
  }

  private gc(now: number) {
    for (const [k, r] of this.rooms) if (now - r.createdAt > this.ttlMs) this.rooms.delete(k);
  }
}
