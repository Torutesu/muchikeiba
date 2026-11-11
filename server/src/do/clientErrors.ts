import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { wrap } from './rpc.js';
import type { ClientErrorBatch, ClientErrorPlatform, ClientErrorsConfig } from '../domain/clientErrors.js';
import {
  ClientErrorsCore, groupOrder, type ClientErrorDay, type ClientErrorGroup, type ClientErrorQuery, type ClientErrorRepo, type ClientErrorSample, type IngestWho,
} from '../ops/clientErrors.js';

/**
 * REQ-CERR-010..012 (§60.5): the client error store on SQLite. Groups keep their JSON (versions / platforms / alert) with
 * the columns the console sorts and filters on; days and samples are plain rows. Bounded: `maxGroups` rows, a few samples
 * per group, rows past `retentionDays` purged a few at a time on every accepted batch.
 */
export class SqlClientErrorRepo implements ClientErrorRepo {
  constructor(private readonly sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS ce_batches (key TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS ce_batches_at ON ce_batches (at)');
    sql.exec('CREATE TABLE IF NOT EXISTS ce_rates (key TEXT PRIMARY KEY, w INTEGER NOT NULL, n INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS ce_groups (fp TEXT PRIMARY KEY, category TEXT NOT NULL, count INTEGER NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, alert_at INTEGER, json TEXT NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS ce_groups_last ON ce_groups (last_seen)');
    sql.exec('CREATE TABLE IF NOT EXISTS ce_days (fp TEXT NOT NULL, day TEXT NOT NULL, app_version TEXT NOT NULL, platform TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (fp, day, app_version, platform))');
    sql.exec('CREATE INDEX IF NOT EXISTS ce_days_day ON ce_days (day)');
    sql.exec('CREATE TABLE IF NOT EXISTS ce_samples (id INTEGER PRIMARY KEY AUTOINCREMENT, fp TEXT NOT NULL, at INTEGER NOT NULL, player_id TEXT, json TEXT NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS ce_samples_fp ON ce_samples (fp, id)');
    sql.exec('CREATE INDEX IF NOT EXISTS ce_samples_player ON ce_samples (player_id)');
    sql.exec('CREATE INDEX IF NOT EXISTS ce_samples_at ON ce_samples (at)');
  }
  hasBatch(key: string) { return this.sql.exec('SELECT 1 FROM ce_batches WHERE key = ?', key).toArray().length > 0; }
  claimBatch(key: string, now: number) { this.sql.exec('INSERT OR IGNORE INTO ce_batches (key, at) VALUES (?, ?)', key, now); }
  peek(key: string, w: number) {
    const r = this.sql.exec<{ w: number; n: number }>('SELECT w, n FROM ce_rates WHERE key = ?', key).toArray()[0];
    return r && r.w === w ? r.n : 0;
  }
  bump(key: string, w: number) {
    const n = this.peek(key, w) + 1;
    this.sql.exec('INSERT INTO ce_rates (key, w, n) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET w = excluded.w, n = excluded.n', key, w, n);
    return n;
  }
  group(fp: string) {
    const r = this.sql.exec<{ json: string }>('SELECT json FROM ce_groups WHERE fp = ?', fp).toArray()[0];
    return r ? (JSON.parse(r.json) as ClientErrorGroup) : null;
  }
  putGroup(g: ClientErrorGroup) {
    this.sql.exec('INSERT INTO ce_groups (fp, category, count, first_seen, last_seen, alert_at, json) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(fp) DO UPDATE SET count = excluded.count, last_seen = excluded.last_seen, alert_at = excluded.alert_at, json = excluded.json',
      g.fingerprint, g.category, g.count, g.firstSeen, g.lastSeen, g.alert?.at ?? null, JSON.stringify(g));
  }
  groupCount() { return this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM ce_groups').one().n; }
  addDay(fp: string, day: string, v: string, p: ClientErrorPlatform, n: number) {
    this.sql.exec('INSERT INTO ce_days (fp, day, app_version, platform, n) VALUES (?, ?, ?, ?, ?) ON CONFLICT(fp, day, app_version, platform) DO UPDATE SET n = n + excluded.n', fp, day, v, p, n);
  }
  days(fp: string, from: string): ClientErrorDay[] {
    return this.sql.exec<{ day: string; app_version: string; platform: string; n: number }>('SELECT day, app_version, platform, n FROM ce_days WHERE fp = ? AND day >= ? ORDER BY day, app_version, platform', fp, from).toArray()
      .map((r) => ({ fingerprint: fp, day: r.day, appVersion: r.app_version, platform: r.platform as ClientErrorPlatform, count: r.n }));
  }
  addSample(s: Omit<ClientErrorSample, 'id'>, keep: number) {
    this.sql.exec('INSERT INTO ce_samples (fp, at, player_id, json) VALUES (?, ?, ?, ?)', s.fingerprint, s.at, s.playerId, JSON.stringify(s));
    this.sql.exec('DELETE FROM ce_samples WHERE fp = ? AND id NOT IN (SELECT id FROM ce_samples WHERE fp = ? ORDER BY id DESC LIMIT ?)', s.fingerprint, s.fingerprint, keep);
  }
  private sampleRows(where: string, ...args: (string | number)[]) {
    return this.sql.exec<{ id: number; player_id: string | null; json: string }>(`SELECT id, player_id, json FROM ce_samples ${where}`, ...args).toArray()
      .map((r) => ({ ...(JSON.parse(r.json) as ClientErrorSample), id: r.id, playerId: r.player_id }));
  }
  samples(fp: string) { return this.sampleRows('WHERE fp = ? ORDER BY id DESC', fp); }
  list(q: ClientErrorQuery) {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.category) { where.push('category = ?'); args.push(q.category); }
    const order = q.sort === 'last' ? 'last_seen DESC, count DESC' : q.sort === 'new' ? 'first_seen DESC, count DESC' : 'count DESC, last_seen DESC';
    // platform / version filters read the JSON (the table is bounded by maxGroups)
    const rows = this.sql.exec<{ json: string }>(`SELECT json FROM ce_groups ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}`, ...args).toArray()
      .map((r) => JSON.parse(r.json) as ClientErrorGroup)
      .filter((g) => (!q.platform || (g.platforms[q.platform] ?? 0) > 0) && (!q.appVersion || (g.versions[q.appVersion] ?? 0) > 0));
    return rows.sort(groupOrder(q.sort ?? 'count')).slice(0, q.limit);
  }
  alerts(since: number, limit: number) {
    return this.sql.exec<{ json: string }>('SELECT json FROM ce_groups WHERE alert_at IS NOT NULL AND alert_at >= ? ORDER BY alert_at DESC LIMIT ?', since, limit).toArray().map((r) => JSON.parse(r.json) as ClientErrorGroup);
  }
  byCategory() {
    const o: Record<string, number> = {};
    for (const r of this.sql.exec<{ category: string; n: number }>('SELECT category, COUNT(*) AS n FROM ce_groups GROUP BY category').toArray()) o[r.category] = r.n;
    return o;
  }
  samplesOf(pid: string) { return this.sampleRows('WHERE player_id = ? ORDER BY id', pid); }
  anonymise(pid: string) {
    const rows = this.sampleRows('WHERE player_id = ?', pid);
    for (const r of rows) this.sql.exec('UPDATE ce_samples SET player_id = NULL, json = ? WHERE id = ?', JSON.stringify({ ...r, playerId: null }), r.id);
    return rows.length;
  }
  forgetRates(key: string) {
    const n = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM ce_rates WHERE key = ?', key).one().n;
    this.sql.exec('DELETE FROM ce_rates WHERE key = ?', key);
    return n;
  }
  purge(before: number, beforeDay: string, batchBefore: number, rateBefore: number, limit: number) {
    this.sql.exec('DELETE FROM ce_days WHERE rowid IN (SELECT rowid FROM ce_days WHERE day < ? LIMIT ?)', beforeDay, limit);
    const old = this.sql.exec<{ fp: string }>('SELECT fp FROM ce_groups WHERE last_seen < ? LIMIT ?', before, limit).toArray();
    for (const g of old) { this.sql.exec('DELETE FROM ce_groups WHERE fp = ?', g.fp); this.sql.exec('DELETE FROM ce_samples WHERE fp = ?', g.fp); }
    this.sql.exec('DELETE FROM ce_samples WHERE id IN (SELECT id FROM ce_samples WHERE at < ? LIMIT ?)', before, limit);
    this.sql.exec('DELETE FROM ce_batches WHERE key IN (SELECT key FROM ce_batches WHERE at < ? LIMIT ?)', batchBefore, limit * 4);
    this.sql.exec('DELETE FROM ce_rates WHERE key IN (SELECT key FROM ce_rates WHERE w < ? LIMIT ?)', rateBefore, limit * 4);
  }
}

/**
 * REQ-CERR-*: singleton `global` (wrangler migration v7). Its own object so player error traffic never queues behind the
 * remote config (`OpsDO.configActive`, the players' hot path) or the admin audit log.
 */
export class ClientErrorsDO extends DurableObject<Env> {
  private readonly core: ClientErrorsCore;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new ClientErrorsCore(new SqlClientErrorRepo(ctx.storage.sql));
  }
  ceIngest(b: ClientErrorBatch, who: IngestWho, now: number, c: ClientErrorsConfig) { return wrap(() => { const r = this.core.ingest(b, who, now, c); return { accepted: r.accepted, dropped: r.dropped, duplicate: r.duplicate }; }); }
  ceList(q: ClientErrorQuery, now: number, c: ClientErrorsConfig) { return wrap(() => this.core.list(q, now, c)); }
  ceGet(fp: string, now: number) { return wrap(() => this.core.get(fp, now)); }
  ceMadeBy(pid: string) { return wrap(() => this.core.madeBy(pid)); }
  ceForget(pid: string) { return wrap(() => this.core.forgetPlayer(pid)); }
}
