import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { IntegrityCore, statusOf, type IntegrityRepo, type ModerationChange, type ModerationStatus, type PlayerIntegrity, type RaceIntegrityReport, type RaceReport } from '../ops/integrity.js';
import { unwrap, wrap, type Envelope } from './rpc.js';

export class SqlIntegrityRepo implements IntegrityRepo {
  constructor(private readonly sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS integrity_players (player_id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, has_events INTEGER NOT NULL, json TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS integrity_races (race_id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS race_reports (id TEXT PRIMARY KEY, race_id TEXT NOT NULL, status TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL)');
  }
  player(id: string) { const r = this.sql.exec<{ json: string }>('SELECT json FROM integrity_players WHERE player_id = ?', id).toArray()[0]; return r ? (JSON.parse(r.json) as PlayerIntegrity) : null; }
  putPlayer(p: PlayerIntegrity) {
    this.sql.exec('INSERT INTO integrity_players (player_id, updated_at, has_events, json) VALUES (?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET updated_at = excluded.updated_at, has_events = excluded.has_events, json = excluded.json', p.playerId, p.updatedAt, p.events.length > 0 ? 1 : 0, JSON.stringify(p));
  }
  players(f: { status?: ModerationStatus | 'flagged'; now: number; limit: number }) {
    // status is time-dependent, so filter after reading the most recently updated rows
    const rows = this.sql.exec<{ json: string }>(`SELECT json FROM integrity_players ${f.status === 'flagged' ? 'WHERE has_events = 1' : ''} ORDER BY updated_at DESC LIMIT 2000`).toArray().map((r) => JSON.parse(r.json) as PlayerIntegrity);
    return rows.filter((p) => !f.status || f.status === 'flagged' || statusOf(p, f.now) === f.status).slice(0, f.limit);
  }
  raceSeen(id: string) { return this.sql.exec('SELECT 1 FROM integrity_races WHERE race_id = ?', id).toArray().length > 0; }
  markRace(id: string, at: number) { this.sql.exec('INSERT OR IGNORE INTO integrity_races (race_id, at) VALUES (?, ?)', id, at); }
  report(id: string) { const r = this.sql.exec<{ json: string }>('SELECT json FROM race_reports WHERE id = ?', id).toArray()[0]; return r ? (JSON.parse(r.json) as RaceReport) : null; }
  putReport(r: RaceReport) { this.sql.exec('INSERT INTO race_reports (id, race_id, status, at, json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, json = excluded.json', r.id, r.raceId, r.status, r.at, JSON.stringify(r)); }
  reports(f: { status?: RaceReport['status']; raceId?: string; limit: number }) {
    const where: string[] = [];
    const args: string[] = [];
    if (f.status) { where.push('status = ?'); args.push(f.status); }
    if (f.raceId) { where.push('race_id = ?'); args.push(f.raceId); }
    return this.sql.exec<{ json: string }>(`SELECT json FROM race_reports ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC LIMIT ?`, ...args, f.limit).toArray().map((r) => JSON.parse(r.json) as RaceReport);
  }
}

/**
 * Singleton `global` (REQ-OPS-030..035): anti-cheat flags per player, moderation decisions and the
 * race-report queue. Only races with suspects or desync are sent here, so its load is small. Status
 * changes are pushed to the player's own object, which gates matchmaking and purchases.
 */
export class IntegrityDO extends DurableObject<Env> {
  private readonly core: IntegrityCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new IntegrityCore(new SqlIntegrityRepo(ctx.storage.sql));
  }

  private async push(changes: ModerationChange[]) {
    for (const c of changes) {
      const p = this.env.PLAYER.get(this.env.PLAYER.idFromName(c.playerId)) as unknown as { invoke(m: string, a: unknown[]): Promise<Envelope<unknown>> };
      unwrap(await p.invoke('setModeration', [c.playerId, c.status, c.until, c.reason]));
    }
  }

  recordRace(r: RaceIntegrityReport) {
    return wrap(async () => {
      const changes = this.core.recordRace(r);
      await this.push(changes);
      return changes;
    });
  }
  report(raceId: string, reporterId: string, now: number) { return wrap(() => this.core.addReport(raceId, reporterId, now)); }
  reports(status: RaceReport['status'] | undefined, limit: number) { return wrap(() => this.core.reports(status, limit)); }
  resolveReport(id: string, resolution: string, by: string, now: number) { return wrap(() => this.core.resolveReport(id, resolution, by, now)); }
  view(playerId: string, now: number) { return wrap(() => this.core.view(playerId, now)); }
  list(status: ModerationStatus | 'flagged' | undefined, now: number, limit: number) { return wrap(() => this.core.list(status, now, limit)); }
  ban(playerId: string, until: number | null, reason: string, by: string, now: number) {
    return wrap(async () => { const c = this.core.ban(playerId, until, reason, by, now); await this.push([c]); return c; });
  }
  unban(playerId: string, reason: string, by: string, now: number) {
    return wrap(async () => { const c = this.core.unban(playerId, reason, by, now); await this.push([c]); return c; });
  }
  release(playerId: string, reason: string, by: string, now: number) {
    return wrap(async () => { const c = this.core.release(playerId, reason, by, now); await this.push([c]); return c; });
  }
}
