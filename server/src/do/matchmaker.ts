import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { loadMaster } from '../domain/master.js';
import { assertNotInLiveRace, FriendRooms, MatchmakerCore, type FriendRoom, type QueueEntry } from '../domain/matchmaker.js';
import { cryptoRng } from '../domain/rng.js';
import { AppError } from '../domain/errors.js';
import type { RaceEntry } from '../http/app.js';
import { createRace, type Assignment, type CreatedRace } from '../race/orchestrate.js';
import { wrap, type Envelope } from './rpc.js';
import type { RaceRoomDO } from './raceRoom.js';

const ASSIGNMENT_TTL_MS = 10 * 60_000;
const TICK_MS = 1000;

interface Persisted { queue: QueueEntry<RaceEntry>[]; assignments: [string, Assignment & { at: number }][]; friendRooms?: FriendRoom<RaceEntry>[] }

/**
 * Ranked queue + friend rooms + tutorial races (REQ-MM-*). One instance per region/mode shard.
 * The matching logic is MatchmakerCore; this class only persists it and starts race rooms.
 */
export class MatchmakerDO extends DurableObject<Env> {
  private core = new MatchmakerCore<RaceEntry>();
  private friends = new FriendRooms<RaceEntry>();
  private assignments = new Map<string, Assignment & { at: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const s = await ctx.storage.get<Persisted>('mm');
      if (s) {
        this.core = MatchmakerCore.fromJSON(s);
        this.assignments = new Map(s.assignments);
        this.friends = FriendRooms.fromJSON(s.friendRooms);
      }
    });
  }

  private async persist() {
    await this.ctx.storage.put<Persisted>('mm', { queue: this.core.entries(), assignments: [...this.assignments], friendRooms: this.friends.toJSON() });
  }

  private async startRace(created: CreatedRace, now: number) {
    const room = this.env.RACE_ROOM.get(this.env.RACE_ROOM.idFromName(created.config.raceId)) as unknown as DurableObjectStub<RaceRoomDO>;
    await room.init({ config: created.config, startAtMs: created.startAtMs, ratings: created.ratings });
    for (const [pid, a] of Object.entries(created.assignments)) this.assignments.set(pid, { ...a, at: now });
  }

  async enqueue(playerId: string, entry: RaceEntry): Promise<Envelope<unknown>> {
    return wrap(async () => {
      assertNotInLiveRace(this.assignments, playerId, Date.now()); // REQ-MM-005: no second race while one runs
      this.assignments.delete(playerId);
      this.core.enqueue({ playerId, rating: entry.rating.r, beginner: entry.beginner, enqueuedAt: Date.now(), payload: entry });
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
      return { state: 'none' };
    });
  }

  async friendCreate(playerId: string, entry: RaceEntry): Promise<Envelope<unknown>> {
    return wrap(async () => {
      const r = this.friends.create(playerId, entry, Date.now(), cryptoRng);
      await this.persist();
      return { passphrase: r.passphrase, members: r.members.map((m) => m.playerId) };
    });
  }

  async friendJoin(passphrase: string, playerId: string, entry: RaceEntry): Promise<Envelope<unknown>> {
    return wrap(async () => {
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
      const created = await createRace(loadMaster(), { mode: 'friend', humans: r.members.map((m) => m.payload), cpuCount: 0, cpuLevel: 3, rng: cryptoRng, now, ticketSecret: this.env.TICKET_SECRET });
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
      const created = await createRace(loadMaster(), { mode: 'tutorial', humans: [entry], cpuCount: 11, cpuLevel: 1, rng: cryptoRng, now, ticketSecret: this.env.TICKET_SECRET });
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
    for (const m of this.core.tick(now)) {
      try {
        const created = await createRace(loadMaster(), { mode: 'ranked', humans: m.players.map((p) => p.payload), cpuCount: m.cpuCount, cpuLevel: m.cpuLevel, rng: cryptoRng, now, ticketSecret: this.env.TICKET_SECRET });
        await this.startRace(created, now);
      } catch (e) {
        // never drop dequeued players: put them back with their original wait time (next alarm retries)
        console.error('ranked race start failed; requeueing', e);
        this.core.requeue(m.players);
      }
    }
    for (const [k, a] of this.assignments) if (now - a.at > ASSIGNMENT_TTL_MS) this.assignments.delete(k);
    await this.persist();
    if (this.core.size > 0) await this.ctx.storage.setAlarm(now + TICK_MS);
  }
}
