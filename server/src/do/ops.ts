import { DurableObject } from 'cloudflare:workers';
import { mergeDeadLetter, normalizeDlScope } from '../ops/deadLetter.js';
import type { Env } from '../env.js';
import { loadMaster } from '../domain/master.js';
import { ConfigStore, type Activation, type ConfigRepo, type ConfigVersion } from '../ops/config.js';
import { auditValue, RateLimiter, type AuditEntry, type AuditInput, type AuditQuery, type AuditRepo } from '../ops/admin.js';
import { wrap, type Envelope } from './rpc.js';
import { SqlDeadLetterRegistry } from './deadLetters.js';
import type { DeadLetterRecord, DeadLetterSource, DeadLetterStatus } from '../ops/deadLetter.js';
import type { DryRunOp } from '../ops/config.js';
import type { AdminPrincipal } from '../ops/admin.js';
import type { Grant } from '../ops/support.js';
import { CompensationStore, type CompensationGift, type CompensationQuery, type CompensationRepo, type CompensationRequest } from '../ops/compensation.js';
import { InquiryIndex, type InquiryIndexRepo, type InquiryNote, type InquiryQuery } from '../ops/inquiries.js';
import type { InquirySummary } from '../domain/help.js';

/** REQ-HELP-016: the inquiry index on SQLite (one row per ticket, no text; added with CREATE TABLE IF NOT EXISTS — no migration). */
export class SqlInquiryIndexRepo implements InquiryIndexRepo {
  constructor(private readonly sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS inquiries (player_id TEXT NOT NULL, ticket_id TEXT NOT NULL, status TEXT NOT NULL, category TEXT NOT NULL, updated_at INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (player_id, ticket_id))');
    sql.exec('CREATE INDEX IF NOT EXISTS inquiries_status ON inquiries (status, updated_at)');
    // §73.6 (REQ-TKT-008/009): the support desk — assignee and internal notes (never in the player's state; no migration)
    sql.exec('CREATE TABLE IF NOT EXISTS inquiry_desk (player_id TEXT NOT NULL, ticket_id TEXT NOT NULL, assignee TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (player_id, ticket_id))');
    sql.exec('CREATE TABLE IF NOT EXISTS inquiry_notes (player_id TEXT NOT NULL, ticket_id TEXT NOT NULL, op_key TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (player_id, ticket_id, op_key))');
  }
  all() {
    return this.sql.exec<{ json: string }>('SELECT json FROM inquiries ORDER BY updated_at DESC LIMIT 20000').toArray().map((r) => JSON.parse(r.json) as InquirySummary);
  }
  removeTicket(playerId: string, ticketId: string) {
    for (const t of ['inquiries', 'inquiry_desk', 'inquiry_notes']) this.sql.exec(`DELETE FROM ${t} WHERE player_id = ? AND ticket_id = ?`, playerId, ticketId);
  }
  assignee(playerId: string, ticketId: string) {
    return this.sql.exec<{ assignee: string }>('SELECT assignee FROM inquiry_desk WHERE player_id = ? AND ticket_id = ?', playerId, ticketId).toArray()[0]?.assignee ?? null;
  }
  assignees() {
    return new Map(this.sql.exec<{ player_id: string; ticket_id: string; assignee: string }>('SELECT player_id, ticket_id, assignee FROM inquiry_desk').toArray().map((r) => [`${r.player_id}\u0000${r.ticket_id}`, r.assignee] as [string, string]));
  }
  setAssignee(playerId: string, ticketId: string, assignee: string | null, at: number) {
    if (assignee === null) this.sql.exec('DELETE FROM inquiry_desk WHERE player_id = ? AND ticket_id = ?', playerId, ticketId);
    else this.sql.exec('INSERT INTO inquiry_desk (player_id, ticket_id, assignee, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id, ticket_id) DO UPDATE SET assignee = excluded.assignee, updated_at = excluded.updated_at', playerId, ticketId, assignee, at);
  }
  notes(playerId: string, ticketId: string) {
    return this.sql.exec<{ op_key: string; by: string; at: number; text: string }>('SELECT op_key, by, at, text FROM inquiry_notes WHERE player_id = ? AND ticket_id = ? ORDER BY at, op_key', playerId, ticketId)
      .toArray().map((r) => ({ opKey: r.op_key, by: r.by, at: r.at, text: r.text }));
  }
  addNote(playerId: string, ticketId: string, n: InquiryNote & { opKey: string }) {
    this.sql.exec('INSERT OR IGNORE INTO inquiry_notes (player_id, ticket_id, op_key, by, at, text) VALUES (?, ?, ?, ?, ?, ?)', playerId, ticketId, n.opKey, n.by, n.at, n.text);
  }
  get(playerId: string, ticketId: string) {
    const r = this.sql.exec<{ json: string }>('SELECT json FROM inquiries WHERE player_id = ? AND ticket_id = ?', playerId, ticketId).toArray()[0];
    return r ? (JSON.parse(r.json) as InquirySummary) : null;
  }
  put(r: InquirySummary) {
    this.sql.exec('INSERT INTO inquiries (player_id, ticket_id, status, category, updated_at, json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(player_id, ticket_id) DO UPDATE SET status = excluded.status, category = excluded.category, updated_at = excluded.updated_at, json = excluded.json',
      r.playerId, r.ticketId, r.status, r.category, r.updatedAt, JSON.stringify(r));
  }
  list(q: InquiryQuery) {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.status === 'open') where.push("status IN ('received', 'in_progress')");
    else if (q.status) { where.push('status = ?'); args.push(q.status); }
    if (q.category) { where.push('category = ?'); args.push(q.category); }
    const sql = `SELECT json FROM inquiries ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`;
    return this.sql.exec<{ json: string }>(sql, ...args, q.limit ?? 100).toArray().map((r) => JSON.parse(r.json) as InquirySummary);
  }
  removePlayer(playerId: string) {
    const n = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM inquiries WHERE player_id = ?', playerId).one().n;
    this.sql.exec('DELETE FROM inquiries WHERE player_id = ?', playerId);
    this.sql.exec('DELETE FROM inquiry_desk WHERE player_id = ?', playerId);
    this.sql.exec('DELETE FROM inquiry_notes WHERE player_id = ?', playerId);
    return n;
  }
}

/** REQ-OPS-026: compensation requests on SQLite (one JSON row per request; opKey unique). */
export class SqlCompensationRepo implements CompensationRepo {
  constructor(private readonly sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS compensations (id TEXT PRIMARY KEY, op_key TEXT UNIQUE NOT NULL, player_id TEXT NOT NULL, status TEXT NOT NULL, requested_at INTEGER NOT NULL, json TEXT NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS compensations_player ON compensations (player_id)');
    sql.exec('CREATE TABLE IF NOT EXISTS ops_seq (kind TEXT PRIMARY KEY, n INTEGER NOT NULL)');
  }
  private one(where: string, arg: string) {
    const r = this.sql.exec<{ json: string }>(`SELECT json FROM compensations WHERE ${where} = ?`, arg).toArray()[0];
    return r ? (JSON.parse(r.json) as CompensationRequest) : null;
  }
  get(id: string) { return this.one('id', id); }
  byOpKey(opKey: string) { return this.one('op_key', opKey); }
  put(r: CompensationRequest) {
    this.sql.exec('INSERT INTO compensations (id, op_key, player_id, status, requested_at, json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, json = excluded.json',
      r.id, r.opKey, r.playerId, r.status, r.requestedAt, JSON.stringify(r));
  }
  list(q: CompensationQuery) {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.status) { where.push('status = ?'); args.push(q.status); }
    if (q.playerId) { where.push('player_id = ?'); args.push(q.playerId); }
    const sql = `SELECT json FROM compensations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY requested_at DESC, id DESC LIMIT ?`;
    return this.sql.exec<{ json: string }>(sql, ...args, q.limit ?? 50).toArray().map((r) => JSON.parse(r.json) as CompensationRequest);
  }
  nextSeq() {
    const n = (this.sql.exec<{ n: number }>("SELECT n FROM ops_seq WHERE kind = 'compensation'").toArray()[0]?.n ?? 0) + 1;
    this.sql.exec("INSERT INTO ops_seq (kind, n) VALUES ('compensation', ?) ON CONFLICT(kind) DO UPDATE SET n = excluded.n", n);
    return n;
  }
}

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
  private readonly deadLetters: SqlDeadLetterRegistry;
  private readonly compensations: CompensationStore;
  private readonly inquiries: InquiryIndex;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = new ConfigStore(new SqlConfigRepo(ctx.storage.sql), loadMaster());
    this.audits = new SqlAuditRepo(ctx.storage.sql);
    this.deadLetters = new SqlDeadLetterRegistry(ctx.storage.sql);
    this.compensations = new CompensationStore(new SqlCompensationRepo(ctx.storage.sql));
    this.inquiries = new InquiryIndex(new SqlInquiryIndexRepo(ctx.storage.sql));
  }

  // ---- inquiry index (REQ-HELP-016) ----
  inqUpsert(items: InquirySummary[]) { return wrap(() => this.inquiries.upsert(items)); }
  inqList(q: InquiryQuery) { return wrap(() => this.inquiries.list(q)); }
  // §73.6 (REQ-TKT-007..009)
  inqExport(q: InquiryQuery) { return wrap(() => this.inquiries.exportCsv(q)); }
  inqDesk(playerId: string, ticketId: string) { return wrap(() => this.inquiries.desk(playerId, ticketId)); }
  inqAssign(playerId: string, ticketId: string, assignee: string | null, now: number) { return wrap(() => this.inquiries.assign(playerId, ticketId, assignee, now)); }
  inqNote(playerId: string, ticketId: string, n: InquiryNote & { opKey: string }, max: number) { return wrap(() => this.inquiries.addNote(playerId, ticketId, n, max)); }
  inqForget(playerId: string) { return wrap(() => this.inquiries.forgetPlayer(playerId)); }

  // ---- dead-letter index (REQ-OPS-041) ----
  /** Producers register newly dead-lettered items; an item ops already resolved/dismissed is not reopened by a stale report. */
  dlRegister(rs: DeadLetterRecord[]) {
    return wrap(async () => {
      for (const r of rs) {
        const prev = await this.deadLetters.get(r.source, normalizeDlScope(r.source, r.scope), r.itemId);
        const next = mergeDeadLetter(prev, r);
        if (next) await this.deadLetters.upsert(next);
      }
      return rs.length;
    });
  }
  dlUpsert(r: DeadLetterRecord) { return wrap(() => this.deadLetters.upsert({ ...r, scope: normalizeDlScope(r.source, r.scope) })); }
  dlGet(source: DeadLetterSource, scope: string, itemId: string) { return wrap(() => this.deadLetters.get(source, normalizeDlScope(source, scope), itemId)); }
  dlList(q: { status?: DeadLetterStatus; source?: DeadLetterSource; limit: number }) { return wrap(() => this.deadLetters.list(q)); }

  configActive(now: number, knownHash: string | null) { return wrap(() => this.config.activeFor(now, knownHash)); }
  configValidate(bundle: unknown) { return wrap(() => ({ problems: this.config.validate(bundle) })); }
  configStage(bundle: unknown, by: string, note: string, now: number) { return wrap(() => this.config.stage(bundle, by, note, now)); }
  configSchedule(versionId: string, at: number, by: string, reason: string, now: number) { return wrap(() => this.config.schedule(versionId, at, by, reason, now)); }
  configCancel(activationId: string, now: number) { return wrap(() => this.config.cancel(activationId, now)); }
  configRollback(versionId: string | null, by: string, reason: string, now: number) { return wrap(() => this.config.rollback(versionId, by, reason, now)); }
  configList(now: number) { return wrap(() => this.config.list(now)); }
  configGet(id: string) { return wrap(() => this.config.get(id)); }
  configDryRun(op: DryRunOp, by: string, now: number) { return wrap(() => this.config.dryRun(op, by, now)); }

  // ---- compensation requests (REQ-OPS-026) ----
  compCreate(input: { opKey: string; playerId: string; grant: Grant; reason: string; gift?: CompensationGift }, by: AdminPrincipal, now: number) { return wrap(() => this.compensations.create(input, by, now)); }
  compGet(id: string, now: number) { return wrap(() => this.compensations.get(id, now)); }
  compList(q: CompensationQuery, now: number) { return wrap(() => this.compensations.list(q, now)); }
  compApprove(id: string, by: AdminPrincipal, note: string, now: number) { return wrap(() => this.compensations.approve(id, by, note, now)); }
  compReject(id: string, by: AdminPrincipal, note: string, now: number) { return wrap(() => this.compensations.reject(id, by, note, now)); }
  compExecuted(id: string, error: string | null, now: number) { return wrap(() => this.compensations.executed(id, error, now)); }

  admit(principalId: string, kind: 'read' | 'write', now: number): Promise<Envelope<boolean>> {
    return wrap(() => { this.limiter.take(principalId, kind, now); return true; });
  }
  audit(e: AuditInput, now: number): Promise<Envelope<AuditEntry>> {
    return wrap(() => this.audits.append({ ...e, before: auditValue(e.before), after: auditValue(e.after), at: now }));
  }
  auditQuery(q: AuditQuery): Promise<Envelope<AuditEntry[]>> { return wrap(() => this.audits.query(q)); }
}
