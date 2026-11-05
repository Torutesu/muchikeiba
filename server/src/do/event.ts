import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { activeConfig } from '../ops/activeConfig.js';
import { buildEventBoard, EVENT_SETTLE_GRACE_MS, eventBoardKey, type EventEntry } from '../domain/events.js';
import { newRolloverState, rolloverStep, type RolloverState } from '../domain/leaderboard.js';
import type { EventDef } from '../domain/master.js';
import { unwrap, wrap, type Envelope } from './rpc.js';

type Row = { player_id: string; points: number; races: number; wins: number; display_name: string; updated_at: number };

/**
 * One event race = one Durable Object `ev:<eventId>` (REQ-EVENT-007/008). Players' objects push their
 * event standing after each event race; the cron publishes the board to R2 (read by the public
 * endpoint without touching this object) and, after the event, pays rank rewards resumably.
 */
export class EventDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS entries (player_id TEXT PRIMARY KEY, points INTEGER NOT NULL, races INTEGER NOT NULL, wins INTEGER NOT NULL, display_name TEXT NOT NULL, updated_at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS ranks (player_id TEXT PRIMARY KEY, rank INTEGER NOT NULL, total INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  }

  private kvGet<T>(k: string): T | null {
    const r = this.sql.exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', k).toArray()[0];
    return r ? (JSON.parse(r.v) as T) : null;
  }
  private kvPut(k: string, v: unknown) {
    this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v));
  }
  private entries(eventId: string): EventEntry[] {
    return this.sql.exec<Row>('SELECT * FROM entries').toArray().map((r) => ({
      playerId: r.player_id, eventId, points: r.points, races: r.races, wins: r.wins, displayName: r.display_name, updatedAt: r.updated_at,
    }));
  }
  private async event(eventId: string): Promise<EventDef | null> {
    return (await activeConfig(this.env)).master.events.find((e) => e.id === eventId) ?? null;
  }

  /** Last write wins per player; refused after the event (plus settle grace) or once rewards started. */
  async upsert(e: EventEntry): Promise<Envelope<boolean>> {
    return wrap(async () => {
      const ev = await this.event(e.eventId);
      const st = this.kvGet<RolloverState>('close');
      if (!ev || (st && st.status !== 'open') || e.updatedAt >= ev.endAtMs + EVENT_SETTLE_GRACE_MS) return false;
      this.sql.exec(
        `INSERT INTO entries (player_id, points, races, wins, display_name, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(player_id) DO UPDATE SET points = excluded.points, races = excluded.races, wins = excluded.wins,
           display_name = excluded.display_name, updated_at = excluded.updated_at WHERE excluded.updated_at >= entries.updated_at`,
        e.playerId, e.points, e.races, e.wins, e.displayName, e.updatedAt,
      );
      this.kvPut('dirty', true);
      return true;
    });
  }

  /** REQ-EVENT-007: publish the board (skipped when nothing changed). */
  async snapshot(eventId: string, now: number, force = false): Promise<Envelope<{ published: boolean }>> {
    return wrap(async () => {
      if (!force && !this.kvGet<boolean>('dirty')) return { published: false };
      const topN = (await activeConfig(this.env)).master.progression.leaderboard.topN;
      const b = buildEventBoard(eventId, this.entries(eventId), now, topN);
      await this.env.SNAPSHOTS.put(eventBoardKey(eventId), JSON.stringify(b.file), { httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=60' } });
      this.sql.exec('DELETE FROM ranks');
      for (const [pid, r] of b.ranks) this.sql.exec('INSERT INTO ranks (player_id, rank, total) VALUES (?, ?, ?)', pid, r.rank, r.total);
      this.kvPut('dirty', false);
      this.kvPut('generatedAt', now);
      return { published: true };
    });
  }

  async rankOf(playerId: string): Promise<Envelope<{ rank: number; total: number; generatedAt: number | null } | null>> {
    return wrap(() => {
      const r = this.sql.exec<{ rank: number; total: number }>('SELECT rank, total FROM ranks WHERE player_id = ?', playerId).toArray()[0];
      return r ? { rank: r.rank, total: r.total, generatedAt: this.kvGet<number>('generatedAt') } : null;
    });
  }

  /** REQ-EVENT-009: true exactly once (the start notification is sent by whoever gets true). */
  async markStartNotified(): Promise<Envelope<boolean>> {
    return wrap(() => {
      if (this.kvGet<boolean>('startNotified')) return false;
      this.kvPut('startNotified', true);
      return true;
    });
  }

  /** REQ-EVENT-008: one bounded, resumable step of paying final rank rewards (after end + settle grace). */
  async closeStep(eventId: string, now: number): Promise<Envelope<RolloverState>> {
    return wrap(async () => {
      const ev = await this.event(eventId);
      let st = this.kvGet<RolloverState>('close') ?? newRolloverState(eventId);
      if (!ev || st.status === 'closed' || now < ev.endAtMs + EVENT_SETTLE_GRACE_MS) return st;
      if (st.status === 'open') {
        st = { ...st, status: 'closing' };
        this.kvPut('close', st); // no more entries
        unwrap(await this.snapshot(eventId, now, true)); // final ranks
      }
      const batch = (await activeConfig(this.env)).master.progression.leaderboard.rolloverBatch;
      const todo = this.sql.exec<{ player_id: string }>('SELECT player_id FROM entries WHERE player_id > ? AND races > 0 ORDER BY player_id LIMIT ?', st.cursor, batch).toArray()
        .map((r) => ({ playerId: r.player_id, classId: '' }));
      const ranks = new Map(this.sql.exec<{ player_id: string; rank: number; total: number }>('SELECT * FROM ranks').toArray().map((r) => [r.player_id, r]));
      st = await rolloverStep(st, todo, (pid) => {
        const r = ranks.get(pid);
        return r ? { classId: '', classRank: r.rank, classTotal: r.total, ratingRank: 0, ratingTotal: 0 } : undefined;
      }, async (pid, rank) => {
        const p = this.env.PLAYER.get(this.env.PLAYER.idFromName(pid)) as unknown as { invoke(m: string, a: unknown[]): Promise<Envelope<unknown>> };
        unwrap(await p.invoke('eventClose', [pid, eventId, rank]));
        this.kvPut('close', { ...st, cursor: pid });
      }, batch);
      this.kvPut('close', st);
      return st;
    });
  }
}
