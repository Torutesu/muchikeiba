import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { activeConfig } from '../ops/activeConfig.js';
import { assertMayRace, assertNotInLiveRace, EventPools, FriendRooms, MatchmakerCore, type FriendRoom, type QueueEntry } from '../domain/matchmaker.js';
import { findEvent } from '../domain/events.js';
import { loadMaster } from '../domain/master.js';
import { cryptoRng } from '../domain/rng.js';
import { AppError } from '../domain/errors.js';
import type { RaceEntry } from '../http/app.js';
import { createRace, type Assignment, type CreatedRace } from '../race/orchestrate.js';
import { wrap, type Envelope } from './rpc.js';
import type { RaceRoomDO } from './raceRoom.js';

const ASSIGNMENT_TTL_MS = 10 * 60_000;
const TICK_MS = 1000;

interface Persisted { queue: QueueEntry<RaceEntry>[]; assignments: [string, Assignment & { at: number }][]; friendRooms?: FriendRoom<RaceEntry>[]; events?: Record<string, QueueEntry<RaceEntry>[]> }

/**
 * Ranked queue + friend rooms + tutorial races (REQ-MM-*). One instance per region/mode shard.
 * The matching logic is MatchmakerCore; this class only persists it and starts race rooms.
 */
export class MatchmakerDO extends DurableObject<Env> {
  private core = new MatchmakerCore<RaceEntry>();
  private friends = new FriendRooms<RaceEntry>();
  private assignments = new Map<string, Assignment & { at: number }>();
  /** REQ-EVENT-006: one pool per event. */
  private events = new EventPools<RaceEntry>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const s = await ctx.storage.get<Persisted>('mm');
      if (s) {
        this.core = MatchmakerCore.fromJSON(s);
        this.assignments = new Map(s.assignments);
        this.friends = FriendRooms.fromJSON(s.friendRooms);
        this.events = EventPools.fromJSON(s.events, (await activeConfig(env)).master.events ?? loadMaster().events);
      }
    });
  }

  private async persist() {
    await this.ctx.storage.put<Persisted>('mm', { queue: this.core.entries(), assignments: [...this.assignments], friendRooms: this.friends.toJSON(), events: this.events.toJSON() });
  }

  private async startRace(created: CreatedRace, now: number, eventId: string | null = null) {
    const room = this.env.RACE_ROOM.get(this.env.RACE_ROOM.idFromName(created.config.raceId)) as unknown as DurableObjectStub<RaceRoomDO>;
    await room.init({ config: created.config, startAtMs: created.startAtMs, ratings: created.ratings, eventId });
    for (const [pid, a] of Object.entries(created.assignments)) this.assignments.set(pid, { ...a, at: now });
  }

  /** REQ-EVENT-006: queue for an event race (the fee was taken by the player's object). */
  async eventEnqueue(eventId: string, playerId: string, entry: RaceEntry): Promise<Envelope<unknown>> {
    return wrap(async () => {
      const now = Date.now();
      assertNotInLiveRace(this.assignments, playerId, now);
      assertMayRace(entry);
      if (this.core.has(playerId)) throw new AppError('ALREADY_QUEUED', 'queued for ranked');
      const ev = findEvent((await activeConfig(this.env)).master, eventId);
      this.assignments.delete(playerId);
      const r = this.events.enqueue(ev, { playerId, rating: entry.rating.r, beginner: false, enqueuedAt: now, payload: entry, quarantined: entry.moderation === 'quarantined' }, now);
      if (r === 'queued') await this.persist();
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + TICK_MS);
      return { state: 'queued', eventId };
    });
  }

  /** The held fee may be refunded only if no race came of the entry: refuse while the race is live. */
  async eventCancel(eventId: string, playerId: string): Promise<Envelope<unknown>> {
    return wrap(async () => {
      if (!this.events.cancel(eventId, playerId)) {
        assertNotInLiveRace(this.assignments, playerId, Date.now());
        return { state: 'none', wasQueued: false };
      }
      await this.persist();
      return { state: 'none', wasQueued: true };
    });
  }

  async enqueue(playerId: string, entry: RaceEntry): Promise<Envelope<unknown>> {
    return wrap(async () => {
      assertNotInLiveRace(this.assignments, playerId, Date.now()); // REQ-MM-005: no second race while one runs
      assertMayRace(entry);
      if (this.events.has(playerId)) throw new AppError('ALREADY_QUEUED', 'queued for an event race');
      this.assignments.delete(playerId);
      this.core.enqueue({ playerId, rating: entry.rating.r, beginner: entry.beginner, enqueuedAt: Date.now(), payload: entry, quarantined: entry.moderation === 'quarantined' });
      await this.persist();
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
      return { state: 'queued' };
    });
  }

  async cancel(playerId: string): Promise<Envelope<unknown>> {
    return wrap(async () => {
      this.core.cancel(playerId);
      await this.persist();
      return { state: 'none' };
    });
  }

  async status(playerId: string): Promise<Envelope<unknown>> {
    return wrap(() => {
      const a = this.assignments.get(playerId);
      if (a && Date.now() - a.at < ASSIGNMENT_TTL_MS) return { state: 'matched', ...a };
      if (this.core.has(playerId)) return { state: 'queued' };
      const eventId = this.events.eventOf(playerId);
      if (eventId) return { state: 'queued', eventId };
      return { state: 'none' };
    });
  }

  async friendCreate(playerId: string, entry: RaceEntry): Promise<Envelope<unknown>> {
    return wrap(async () => {
      assertMayRace(entry);
      const r = this.friends.create(playerId, entry, Date.now(), cryptoRng);
      await this.persist();
      return { passphrase: r.passphrase, members: r.members.map((m) => m.playerId) };
    });
  }

  async friendJoin(passphrase: string, playerId: string, entry: RaceEntry): Promise<Envelope<unknown>> {
    return wrap(async () => {
      assertMayRace(entry);
      const r = this.friends.join(passphrase, playerId, entry, Date.now());
      await this.persist();
      return { passphrase: r.passphrase, members: r.members.map((m) => m.playerId) };
    });
  }

  async friendStart(passphrase: string, playerId: string): Promise<Envelope<unknown>> {
    return wrap(async () => {
      const now = Date.now();
      for (const m of this.friends.rooms.get(passphrase)?.members ?? []) assertNotInLiveRace(this.assignments, m.playerId, now);
      const r = this.friends.start(passphrase, playerId);
      const cfg = await activeConfig(this.env);
      const created = await createRace(cfg.master, { ruleset: cfg.ruleset, mode: 'friend', humans: r.members.map((m) => m.payload), cpuCount: 0, cpuLevel: 3, rng: cryptoRng, now, ticketSecret: this.env.TICKET_SECRET });
      await this.startRace(created, now);
      await this.persist();
      return created.assignments[playerId];
    });
  }

  async tutorial(playerId: string, entry: RaceEntry): Promise<Envelope<unknown>> {
    return wrap(async () => {
      if (this.core.has(playerId)) throw new AppError('ALREADY_QUEUED');
      const now = Date.now();
      assertNotInLiveRace(this.assignments, playerId, now);
      const cfg = await activeConfig(this.env);
      const created = await createRace(cfg.master, { ruleset: cfg.ruleset, mode: 'tutorial', humans: [entry], cpuCount: 11, cpuLevel: 1, rng: cryptoRng, now, ticketSecret: this.env.TICKET_SECRET });
      await this.startRace(created, now);
      await this.persist();
      return created.assignments[playerId];
    });
  }

  /** Friend room membership (used to authorize invitations, REQ-SOCIAL-005). */
  async friendMember(passphrase: string, playerId: string): Promise<Envelope<boolean>> {
    return wrap(() => this.friends.isMember(passphrase, playerId));
  }

  /** Called by the race room once a race is settled: the players are free to queue again. */
  async raceFinished(raceId: string, playerIds: string[]): Promise<Envelope<unknown>> {
    return wrap(async () => {
      for (const p of playerIds) if (this.assignments.get(p)?.raceId === raceId) this.assignments.delete(p);
      await this.persist();
      return { ok: true };
    });
  }

  override async alarm() {
    const now = Date.now();
    const cfg = await activeConfig(this.env);
    for (const m of this.core.tick(now)) {
      try {
        const created = await createRace(cfg.master, { ruleset: cfg.ruleset, mode: 'ranked', humans: m.players.map((p) => p.payload), cpuCount: m.cpuCount, cpuLevel: m.cpuLevel, rng: cryptoRng, now, ticketSecret: this.env.TICKET_SECRET });
        await this.startRace(created, now);
      } catch (e) {
        // never drop dequeued players: put them back with their original wait time (next alarm retries)
        console.error('ranked race start failed; requeueing', e);
        this.core.requeue(m.players);
      }
    }
    // REQ-EVENT-006: event pools (own rules: tracks, ruleset overrides, fixed stats, cap, CPU level)
    for (const { eventId, event, match } of this.events.tick(now, cfg.master.events)) {
      try {
        const created = await createRace(cfg.master, {
          ruleset: cfg.ruleset, mode: 'event', event, humans: match.players.map((p) => p.payload),
          cpuCount: match.cpuCount, cpuLevel: event.rules.cpuLevel, rng: cryptoRng, now, ticketSecret: this.env.TICKET_SECRET,
        });
        await this.startRace(created, now, eventId);
      } catch (e) {
        console.error('event race start failed; requeueing', eventId, e);
        this.events.requeue(eventId, match.players);
      }
    }
    for (const [k, a] of this.assignments) if (now - a.at > ASSIGNMENT_TTL_MS) this.assignments.delete(k);
    await this.persist();
    if (this.core.size > 0 || this.events.size > 0) await this.ctx.storage.setAlarm(now + TICK_MS);
  }
}
