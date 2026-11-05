import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { loadMaster } from '../domain/master.js';
import { ConfigStore, type Activation, type ConfigRepo, type ConfigVersion } from '../ops/config.js';
import { auditValue, RateLimiter, type AuditEntry, type AuditInput, type AuditQuery, type AuditRepo } from '../ops/admin.js';
import { wrap, type Envelope } from './rpc.js';

/** ConfigRepo on SQLite (versions are immutable rows; activations are append-only except `cancelled`). */
export class SqlConfigRepo implements ConfigRepo {
  constructor(private readonly sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS config_versions (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, json TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS config_activations (id TEXT PRIMARY KEY, at INTEGER NOT NULL, json TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS ops_seq (kind TEXT PRIMARY KEY, n INTEGER NOT NULL)');
  }
  versions() { return this.sql.exec<{ json: string }>('SELECT json FROM config_versions ORDER BY created_at').toArray().map((r) => JSON.parse(r.json) as ConfigVersion); }
  version(id: string) { const r = this.sql.exec<{ json: string }>('SELECT json FROM config_versions WHERE id = ?', id).toArray()[0]; return r ? (JSON.parse(r.json) as ConfigVersion) : null; }
  versionByHash(hash: string) { const r = this.sql.exec<{ json: string }>('SELECT json FROM config_versions WHERE hash = ?', hash).toArray()[0]; return r ? (JSON.parse(r.json) as ConfigVersion) : null; }
  putVersion(v: ConfigVersion) { this.sql.exec('INSERT INTO config_versions (id, hash, created_at, json) VALUES (?, ?, ?, ?)', v.id, v.hash, v.createdAt, JSON.stringify(v)); }
  activations() { return this.sql.exec<{ json: string }>('SELECT json FROM config_activations').toArray().map((r) => JSON.parse(r.json) as Activation); }
  putActivation(a: Activation) { this.sql.exec('INSERT INTO config_activations (id, at, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json', a.id, a.at, JSON.stringify(a)); }
  nextSeq(kind: 'version' | 'activation') {
    const n = (this.sql.exec<{ n: number }>('SELECT n FROM ops_seq WHERE kind = ?', kind).toArray()[0]?.n ?? 0) + 1;
    this.sql.exec('INSERT INTO ops_seq (kind, n) VALUES (?, ?) ON CONFLICT(kind) DO UPDATE SET n = excluded.n', kind, n);
    return n;
  }
}

export class SqlAuditRepo implements AuditRepo {
  constructor(private readonly sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, json TEXT NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS audit_target ON audit (target)');
    sql.exec('CREATE INDEX IF NOT EXISTS audit_actor ON audit (actor)');
  }
  append(e: Omit<AuditEntry, 'seq'>): AuditEntry {
    this.sql.exec('INSERT INTO audit (at, actor, action, target, json) VALUES (?, ?, ?, ?, ?)', e.at, e.actor, e.action, e.target, JSON.stringify(e));
    const seq = this.sql.exec<{ s: number }>('SELECT last_insert_rowid() AS s').one().s;
    return { ...e, seq };
  }
  query(q: AuditQuery): AuditEntry[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.actor) { where.push('actor = ?'); args.push(q.actor); }
    if (q.target) { where.push('target = ?'); args.push(q.target); }
    if (q.action) { where.push('action = ?'); args.push(q.action); }
    if (q.beforeSeq) { where.push('seq < ?'); args.push(q.beforeSeq); }
    const sql = `SELECT seq, json FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`;
    return this.sql.exec<{ seq: number; json: string }>(sql, ...args, Math.min(200, q.limit ?? 50)).toArray().map((r) => ({ ...(JSON.parse(r.json) as AuditEntry), seq: r.seq }));
  }
}

/**
 * Singleton `global` (REQ-OPS-002..014): remote config versions/activations, admin audit log and
 * admin rate limits. Admin traffic is tiny, so one object serializes it; the hot path for players is
 * `configActive`, which every isolate calls at most once per CACHE_MS (and gets no bundle when unchanged).
 */
export class OpsDO extends DurableObject<Env> {
  private readonly config: ConfigStore;
  private readonly audits: SqlAuditRepo;
  private readonly limiter = new RateLimiter();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = new ConfigStore(new SqlConfigRepo(ctx.storage.sql), loadMaster());
    this.audits = new SqlAuditRepo(ctx.storage.sql);
  }

  configActive(now: number, knownHash: string | null) { return wrap(() => this.config.activeFor(now, knownHash)); }
  configValidate(bundle: unknown) { return wrap(() => ({ problems: this.config.validate(bundle) })); }
  configStage(bundle: unknown, by: string, note: string, now: number) { return wrap(() => this.config.stage(bundle, by, note, now)); }
  configSchedule(versionId: string, at: number, by: string, reason: string, now: number) { return wrap(() => this.config.schedule(versionId, at, by, reason, now)); }
  configCancel(activationId: string, now: number) { return wrap(() => this.config.cancel(activationId, now)); }
  configRollback(versionId: string | null, by: string, reason: string, now: number) { return wrap(() => this.config.rollback(versionId, by, reason, now)); }
  configList(now: number) { return wrap(() => this.config.list(now)); }
  configGet(id: string) { return wrap(() => this.config.get(id)); }

  admit(principalId: string, kind: 'read' | 'write', now: number): Promise<Envelope<boolean>> {
    return wrap(() => { this.limiter.take(principalId, kind, now); return true; });
  }
  audit(e: AuditInput, now: number): Promise<Envelope<AuditEntry>> {
    return wrap(() => this.audits.append({ ...e, before: auditValue(e.before), after: auditValue(e.after), at: now }));
  }
  auditQuery(q: AuditQuery): Promise<Envelope<AuditEntry[]>> { return wrap(() => this.audits.query(q)); }
}
