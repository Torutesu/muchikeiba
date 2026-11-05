import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { loadMaster } from '../domain/master.js';
import {
  acceptEntry, buildSnapshot, newRolloverState, rolloverStep, seasonIsOver,
  type RankInfo, type RolloverState, type SeasonEntry,
} from '../domain/leaderboard.js';
import { unwrap, wrap, type Envelope } from './rpc.js';

type EntryRow = { player_id: string; season_id: string; class_id: string; points: number; rating: number; races: number; display_name: string; title_id: string | null; updated_at: number };
type RankRow = { player_id: string; class_id: string; class_rank: number; class_total: number; rating_rank: number; rating_total: number };

/**
 * One season's standings (REQ-LB-*, REQ-SEASON-*). Named `lb:<seasonId>`, so seasons never contend.
 * Players' DOs push their standing after ranked races; the cron publishes snapshots to R2 (read by
 * the public GET endpoints without touching this object) and stores everyone's rank for "my rank".
 */
export class LeaderboardDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS entries (player_id TEXT PRIMARY KEY, season_id TEXT NOT NULL, class_id TEXT NOT NULL, points INTEGER NOT NULL, rating INTEGER NOT NULL, races INTEGER NOT NULL, display_name TEXT NOT NULL, title_id TEXT, updated_at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ranks (player_id TEXT PRIMARY KEY, class_id TEXT NOT NULL, class_rank INTEGER NOT NULL, class_total INTEGER NOT NULL, rating_rank INTEGER NOT NULL, rating_total INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
  }

  private kvGet<T>(k: string): T | null {
    const r = this.sql.exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', k).toArray()[0];
    return r ? (JSON.parse(r.v) as T) : null;
  }
  private kvPut(k: string, v: unknown) {
    this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v));
  }
  private rollover(seasonId: string): RolloverState { return this.kvGet<RolloverState>('rollover') ?? newRolloverState(seasonId); }

  private entries(): SeasonEntry[] {
    return this.sql.exec<EntryRow>('SELECT * FROM entries').toArray().map((r) => ({
      playerId: r.player_id, seasonId: r.season_id, classId: r.class_id, points: r.points, rating: r.rating, races: r.races,
      displayName: r.display_name, titleId: r.title_id, updatedAt: r.updated_at,
    }));
  }

  async upsert(e: SeasonEntry): Promise<Envelope<boolean>> {
    return wrap(() => {
      if (!acceptEntry(e.seasonId, this.rollover(e.seasonId).status, e)) return false;
      this.sql.exec(
        `INSERT INTO entries (player_id, season_id, class_id, points, rating, races, display_name, title_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(player_id) DO UPDATE SET class_id = excluded.class_id, points = excluded.points, rating = excluded.rating, races = excluded.races,
           display_name = excluded.display_name, title_id = excluded.title_id, updated_at = excluded.updated_at WHERE excluded.updated_at >= entries.updated_at`,
        e.playerId, e.seasonId, e.classId, e.points, e.rating, e.races, e.displayName, e.titleId, e.updatedAt,
      );
      this.kvPut('dirty', true);
      return true;
    });
  }

  /** REQ-LB-001: publish snapshot files and store ranks. Skipped when nothing changed (cheap cron). */
  async snapshot(seasonId: string, now: number, force = false): Promise<Envelope<{ published: boolean; files: number }>> {
    return wrap(async () => {
      if (!force && !this.kvGet<boolean>('dirty')) return { published: false, files: 0 };
      const snap = buildSnapshot(seasonId, this.entries(), now, loadMaster().progression.leaderboard.topN);
      for (const f of snap.files) {
        await this.env.SNAPSHOTS.put(f.key, JSON.stringify(f.body), { httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=60' } });
      }
      this.sql.exec('DELETE FROM ranks');
      for (const [pid, r] of snap.ranks) {
        this.sql.exec('INSERT INTO ranks (player_id, class_id, class_rank, class_total, rating_rank, rating_total) VALUES (?, ?, ?, ?, ?, ?)', pid, r.classId, r.classRank, r.classTotal, r.ratingRank, r.ratingTotal);
      }
      this.kvPut('dirty', false);
      this.kvPut('generatedAt', now);
      return { published: true, files: snap.files.length };
    });
  }

  /** REQ-LB-003: the player's rank as of the last snapshot plus the live standing. */
  async rankOf(playerId: string): Promise<Envelope<unknown>> {
    return wrap(() => {
      const r = this.sql.exec<RankRow>('SELECT * FROM ranks WHERE player_id = ?', playerId).toArray()[0];
      const e = this.sql.exec<EntryRow>('SELECT * FROM entries WHERE player_id = ?', playerId).toArray()[0];
      const rank: RankInfo | null = r ? { classId: r.class_id, classRank: r.class_rank, classTotal: r.class_total, ratingRank: r.rating_rank, ratingTotal: r.rating_total } : null;
      return { rank, standing: e ? { classId: e.class_id, points: e.points, rating: e.rating, races: e.races } : null, generatedAt: this.kvGet<number>('generatedAt') };
    });
  }

  /** REQ-SEASON-001/003: one bounded, resumable rollover step (no-op while the season is running or once closed). */
  async rolloverStep(seasonId: string, now: number): Promise<Envelope<RolloverState>> {
    return wrap(async () => {
      let st = this.rollover(seasonId);
      if (st.status === 'closed' || !seasonIsOver(seasonId, now)) return st;
      if (st.status === 'open') {
        unwrap(await this.snapshot(seasonId, now, true)); // final standings → final ranks
        st = { ...st, status: 'closing' };
        this.kvPut('rollover', st);
      }
      const batch = loadMaster().progression.leaderboard.rolloverBatch;
      const participants = this.sql.exec<{ player_id: string; class_id: string }>('SELECT player_id, class_id FROM entries WHERE player_id > ? AND races > 0 ORDER BY player_id LIMIT ?', st.cursor, batch)
        .toArray().map((r) => ({ playerId: r.player_id, classId: r.class_id }));
      const ranks = new Map(this.sql.exec<RankRow>('SELECT * FROM ranks').toArray().map((r) => [r.player_id, { classId: r.class_id, classRank: r.class_rank, classTotal: r.class_total, ratingRank: r.rating_rank, ratingTotal: r.rating_total }]));
      st = await rolloverStep(st, participants, (p) => ranks.get(p), async (pid, rank) => {
        const stub = this.env.PLAYER.get(this.env.PLAYER.idFromName(pid)) as unknown as { invoke(m: string, a: unknown[]): Promise<Envelope<unknown>> };
        unwrap(await stub.invoke('closeSeason', [pid, seasonId, rank]));
        this.kvPut('rollover', { ...st, cursor: pid }); // durable cursor after every player
      }, batch);
      this.kvPut('rollover', st);
      return st;
    });
  }
}
