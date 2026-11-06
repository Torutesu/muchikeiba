import { DurableObject } from 'cloudflare:workers';
import type { RoomConditions } from '../domain/presets.js';
import type { Env } from '../env.js';
import { activeConfig } from '../ops/activeConfig.js';
import {
  assertMayRace, assertNotInLiveRace, diffRows, EventPools, FriendRooms, isPendingAssignment, MatchmakerCore, PENDING_RACE_ID,
  type FriendRoom, type QueueEntry, type RowMap,
} from '../domain/matchmaker.js';
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
const RANKED_POOL = 'ranked';

type StoredAssignment = Assignment & { at: number };
/** Pre-rows storage (a single KV value); read once and migrated to rows. */
interface LegacyPersisted { queue: QueueEntry<RaceEntry>[]; assignments: [string, StoredAssignment][]; friendRooms?: FriendRoom<RaceEntry>[]; events?: Record<string, QueueEntry<RaceEntry>[]> }

/**
 * Ranked queue + event pools + friend rooms + tutorial races (REQ-MM-*). The matching logic is
 * MatchmakerCore / EventPools / FriendRooms; this class persists them and starts race rooms.
 *
 * Storage (REQ-MM-007): one SQLite row per queued player, per assignment and per friend room, written
 * as a diff against what was last persisted — never one blob, whose 2 MiB value limit a few thousand
 * concurrent players (or one account creating rooms) would hit and then break every write.
 *
 * Sharding plan: the instance is named by region/mode (`ranked-jp`), so the capacity of one instance
 * is the ceiling of one region. When a region outgrows it, split by rating band (`ranked-jp:<band>`,
 * a player's band from their rating at enqueue) with friend rooms moved to their own instances keyed
 * by passphrase prefix; the "one live race per player" check then needs the player's own object as the
 * owner of the live-race marker (it already records the active race), not this instance.
 */
export class MatchmakerDO extends DurableObject<Env> {
  private core = new MatchmakerCore<RaceEntry>();
  private friends = new FriendRooms<RaceEntry>();
  private assignments = new Map<string, StoredAssignment>();
  /** REQ-EVENT-006: one pool per event. */
  private events = new EventPools<RaceEntry>();
  /** Rows as last written, so persist() writes only what changed. */
  private persisted: RowMap = new Map();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS mm_rows (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    ctx.blockConcurrencyWhile(async () => {
      const eventsDefs = (await activeConfig(env)).master.events ?? loadMaster().events;
      const rows = new Map(ctx.storage.sql.exec<{ k: string; v: string }>('SELECT k, v FROM mm_rows').toArray().map((r) => [r.k, r.v] as [string, string]));
      if (rows.size > 0) {
        this.load(rows, eventsDefs);
        this.persisted = rows;
        return;
      }
      const legacy = await ctx.storage.get<LegacyPersisted>('mm');
      if (legacy) {
        this.core = MatchmakerCore.fromJSON(legacy);
        this.assignments = new Map(legacy.assignments);
        this.friends = FriendRooms.fromJSON(legacy.friendRooms);
        this.events = EventPools.fromJSON(legacy.events, eventsDefs);
        this.writeRows();
        await ctx.storage.delete('mm');
      }
    });
  }

  private load(rows: RowMap, eventsDefs: Parameters<typeof EventPools.fromJSON>[1]) {
    const queues = new Map<string, QueueEntry<RaceEntry>[]>();
    const rooms: FriendRoom<RaceEntry>[] = [];
    for (const [k, v] of rows) {
      const [kind, ...rest] = k.split('|');
      if (kind === 'q') {
        const pool = rest[0]!;
        const list = queues.get(pool) ?? [];
        list.push(JSON.parse(v) as QueueEntry<RaceEntry>);
        queues.set(pool, list);
      } else if (kind === 'a') {
        this.assignments.set(rest.join('|'), JSON.parse(v) as StoredAssignment);
      } else if (kind === 'r') {
        rooms.push(JSON.parse(v) as FriendRoom<RaceEntry>);
      }
    }
    for (const list of queues.values()) list.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    this.core = MatchmakerCore.fromJSON({ queue: queues.get(RANKED_POOL) ?? [] });
    queues.delete(RANKED_POOL);
    this.events = EventPools.fromJSON(Object.fromEntries(queues), eventsDefs);
    this.friends = FriendRooms.fromJSON(rooms);
  }

  /** Current state as rows (pending placeholders are in-memory only: they guard the await gap). */
  private rows(): RowMap {
    const m: RowMap = new Map();
    for (const e of this.core.entries()) m.set(`q|${RANKED_POOL}|${e.playerId}`, JSON.stringify(e));
    for (const [eventId, list] of Object.entries(this.events.toJSON())) for (const e of list) m.set(`q|${eventId}|${e.playerId}`, JSON.stringify(e));
    for (const [pid, a] of this.assignments) if (!isPendingAssignment(a)) m.set(`a|${pid}`, JSON.stringify(a));
    for (const r of this.friends.toJSON()) m.set(`r|${r.passphrase}`, JSON.stringify(r));
    return m;
  }

  private writeRows() {
    const next = this.rows();
    const { upserts, deletes } = diffRows(this.persisted, next);
    const sql = this.ctx.storage.sql;
    for (const k of deletes) sql.exec('DELETE FROM mm_rows WHERE k = ?', k);
    for (const [k, v] of upserts) sql.exec('INSERT INTO mm_rows (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
    this.persisted = next;
  }

  private async persist() {
    this.writeRows(); // synchronous SQLite writes; the output gate holds replies until they are durable
  }

  /** REQ-MM-005: a player is in at most one queue or race at a time (ranked, event, friend, tutorial). */
  private assertFree(playerId: string, now: number) {
    assertNotInLiveRace(this.assignments, playerId, now);
    if (this.core.has(playerId)) throw new AppError('ALREADY_QUEUED', 'queued for ranked');
    const ev = this.events.eventOf(playerId);
    if (ev) throw new AppError('ALREADY_QUEUED', `queued for event ${ev}`);
  }

  /** Synchronously marks players as racing before the await that creates the race (see PENDING_RACE_ID). */
  private reserve(playerIds: string[], now: number) {
    for (const p of playerIds) this.assignments.set(p, { raceId: PENDING_RACE_ID, slot: -1, ticket: '', startAtMs: 0, wsPath: '', at: now });
  }
  private release(playerIds: string[]) {
    for (const p of playerIds) if (this.assignments.get(p) && isPendingAssignment(this.assignments.get(p)!)) this.assignments.delete(p);
  }

  private async startRace(created: CreatedRace, now: number, eventId: string | null = null) {
    const room = this.env.RACE_ROOM.get(this.env.RACE_ROOM.idFromName(created.config.raceId)) as unknown as DurableObjectStub<RaceRoomDO>;
    await room.init({ config: created.config, startAtMs: created.startAtMs, ratings: created.ratings, eventId, visuals: created.visuals });
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
      assertNotInLiveRace(this.assignments, playerId, Date.now()); // re-check after the await
      if (this.core.has(playerId)) throw new AppError('ALREADY_QUEUED', 'queued for ranked');
      this.assignments.delete(playerId);
      const r = this.events.enqueue(ev, { playerId, rating: entry.rating.r, beginner: false, enqueuedAt: now, payload: entry, quarantined: entry.moderation === 'quarantined' }, now);
      if (r === 'queued') await this.persist();
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + TICK_MS);
      return { state: 'queued', eventId };
    });
  }

  /** The held fee may be refunded only if no race came of the entry: refuse while the race is live (or starting). */
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
      if (a && isPendingAssignment(a)) return { state: 'queued' }; // matched; the room is being created
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
      const r = this.friends.create(playerId, entry, Date.now(), cryptoRng); // one open room per host
      await this.persist();
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 10 * 60_000); // prune expired rooms
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
      // every member must be free: not racing, not starting a race, not queued for ranked or an event
      for (const m of this.friends.rooms.get(passphrase)?.members ?? []) this.assertFree(m.playerId, now);
      const r = this.friends.start(passphrase, playerId, now);
      const members = r.members.map((m) => m.playerId);
      this.reserve(members, now);
      try {
        const cfg = await activeConfig(this.env);
        const host = r.members.find((m) => m.playerId === r.hostId)?.payload as { roomPreset?: RoomConditions | null } | undefined;
        const created = await createRace(cfg.master, { ruleset: cfg.ruleset, mode: 'friend', humans: r.members.map((m) => m.payload), cpuCount: 0, cpuLevel: 3, rng: cryptoRng, now, ticketSecret: this.env.TICKET_SECRET, roomPreset: host?.roomPreset ?? null });
        await this.startRace(created, now);
        await this.persist();
        return created.assignments[playerId];
      } catch (e) {
        this.release(members);
        this.friends.restore(r);
        await this.persist();
        throw e;
      }
    });
  }

  async tutorial(playerId: string, entry: RaceEntry): Promise<Envelope<unknown>> {
    return wrap(async () => {
      const now = Date.now();
      this.assertFree(playerId, now);
      this.reserve([playerId], now);
      try {
        const cfg = await activeConfig(this.env);
        const created = await createRace(cfg.master, { ruleset: cfg.ruleset, mode: 'tutorial', humans: [entry], cpuCount: 11, cpuLevel: 1, rng: cryptoRng, now, ticketSecret: this.env.TICKET_SECRET });
        await this.startRace(created, now);
        await this.persist();
        return created.assignments[playerId];
      } catch (e) {
        this.release([playerId]);
        throw e;
      }
    });
  }

  /** Friend room membership (used to authorize invitations, REQ-SOCIAL-005). */
  async friendMember(passphrase: string, playerId: string): Promise<Envelope<boolean>> {
    return wrap(() => this.friends.isMember(passphrase, playerId, Date.now()));
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
    // match synchronously and reserve every matched player before the first await (REQ-MM-005)
    const ranked = this.core.tick(now);
    const evMatches = this.events.tick(now, cfg.master.events);
    for (const m of ranked) this.reserve(m.players.map((p) => p.playerId), now);
    for (const { match } of evMatches) this.reserve(match.players.map((p) => p.playerId), now);
    for (const m of ranked) {
      try {
        const created = await createRace(cfg.master, { ruleset: cfg.ruleset, mode: 'ranked', humans: m.players.map((p) => p.payload), cpuCount: m.cpuCount, cpuLevel: m.cpuLevel, rng: cryptoRng, now, ticketSecret: this.env.TICKET_SECRET });
        await this.startRace(created, now);
      } catch (e) {
        // never drop dequeued players: put them back with their original wait time (next alarm retries)
        console.error('ranked race start failed; requeueing', e);
        this.release(m.players.map((p) => p.playerId));
        this.core.requeue(m.players);
      }
    }
    // REQ-EVENT-006: event pools (own rules: tracks, ruleset overrides, fixed stats, cap, CPU level)
    for (const { eventId, event, match } of evMatches) {
      try {
        const created = await createRace(cfg.master, {
          ruleset: cfg.ruleset, mode: 'event', event, humans: match.players.map((p) => p.payload),
          cpuCount: match.cpuCount, cpuLevel: event.rules.cpuLevel, rng: cryptoRng, now, ticketSecret: this.env.TICKET_SECRET,
        });
        await this.startRace(created, now, eventId);
      } catch (e) {
        console.error('event race start failed; requeueing', eventId, e);
        this.release(match.players.map((p) => p.playerId));
        this.events.requeue(eventId, match.players, event);
      }
    }
    for (const [k, a] of this.assignments) if (!isPendingAssignment(a) && now - a.at > ASSIGNMENT_TTL_MS) this.assignments.delete(k);
    this.friends.prune(now);
    await this.persist();
    if (this.core.size > 0 || this.events.size > 0) await this.ctx.storage.setAlarm(now + TICK_MS);
    else if (this.friends.rooms.size > 0) await this.ctx.storage.setAlarm(now + 10 * 60_000); // prune idle rooms
  }
}
