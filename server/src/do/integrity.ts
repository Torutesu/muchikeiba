import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { IntegrityCore, statusOf, type IntegrityRepo, type ModerationChange, type ModerationStatus, type PlayerIntegrity, type RaceIntegrityReport, type RaceReport } from '../ops/integrity.js';
import { unwrap, wrap, type Envelope } from './rpc.js';
import { dropModeration, enqueueModeration, flushModeration, retryModerationNow, stuckModeration, type ModerationOutboxStore, type OutboxItem } from '../ops/moderationOutbox.js';
import { MODERATION_DEAD_AFTER, type DeadLetterItem, type RetryOutcome } from '../ops/deadLetter.js';
import { newlyDead, reportDeadLetters } from './deadLetters.js';
import { PlayerReportsCore, queueOrder, type PlayerReport, type PlayerReportFilter, type PlayerReportRepo, type ReportAction, type SubmitInput } from '../ops/playerReports.js';
import type { ReporterStats, ReportsConfig } from '../domain/reports.js';

/**
 * REQ-RPT-007/013/016: the player-report queue (§47.7). `reporters` is a space-delimited id list for the deletion's
 * anonymisation lookup; the JSON holds the whole report. Tables are created on first use (no wrangler migration).
 */
export class SqlPlayerReportRepo implements PlayerReportRepo {
  constructor(private readonly sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS player_reports (id TEXT PRIMARY KEY, key TEXT NOT NULL, status TEXT NOT NULL, target_id TEXT NOT NULL, kind TEXT NOT NULL, score INTEGER NOT NULL, last_at INTEGER NOT NULL, resolved_at INTEGER, reporters TEXT NOT NULL, json TEXT NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS player_reports_key ON player_reports (key, status)');
    sql.exec('CREATE INDEX IF NOT EXISTS player_reports_target ON player_reports (target_id)');
    sql.exec('CREATE TABLE IF NOT EXISTS player_report_reporters (reporter_id TEXT PRIMARY KEY, json TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS player_report_seq (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL)');
  }
  private rows(where: string, ...args: (string | number)[]) {
    return this.sql.exec<{ json: string }>(`SELECT json FROM player_reports ${where}`, ...args).toArray().map((r) => JSON.parse(r.json) as PlayerReport);
  }
  get(id: string) { return this.rows('WHERE id = ?', id)[0] ?? null; }
  put(r: PlayerReport) {
    this.sql.exec(
      'INSERT INTO player_reports (id, key, status, target_id, kind, score, last_at, resolved_at, reporters, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, score = excluded.score, last_at = excluded.last_at, resolved_at = excluded.resolved_at, reporters = excluded.reporters, json = excluded.json',
      r.id, r.key, r.status, r.targetId, r.content.kind, r.score, r.lastAt, r.resolution?.at ?? null, ` ${r.reporters.map((e) => e.reporterId).join(' ')} `, JSON.stringify(r),
    );
  }
  openByKey(key: string) { return this.rows("WHERE key = ? AND status = 'open'", key)[0] ?? null; }
  list(f: PlayerReportFilter) {
    const where: string[] = [];
    const args: string[] = [];
    if (f.status) { where.push('status = ?'); args.push(f.status); }
    if (f.kind) { where.push('kind = ?'); args.push(f.kind); }
    if (f.targetId) { where.push('target_id = ?'); args.push(f.targetId); }
    const order = f.status === 'resolved' ? 'resolved_at DESC' : "CASE status WHEN 'open' THEN 0 ELSE 1 END, score DESC, last_at DESC";
    // the category filter reads the JSON (a report can carry several categories)
    const rows = this.rows(`${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ?`, ...args, f.category ? 2000 : f.limit);
    return rows.filter((r) => !f.category || r.categories[f.category] !== undefined).sort(queueOrder).slice(0, f.limit);
  }
  byReporter(id: string) { return this.rows('WHERE reporters LIKE ?', `% ${id} %`).filter((r) => r.reporters.some((e) => e.reporterId === id)); }
  byTarget(id: string) { return this.rows('WHERE target_id = ?', id); }
  resolvedBefore(t: number, limit: number) { return this.rows("WHERE status = 'resolved' AND resolved_at < ? ORDER BY resolved_at LIMIT ?", t, limit); }
  remove(id: string) { this.sql.exec('DELETE FROM player_reports WHERE id = ?', id); }
  stats(id: string) { const r = this.sql.exec<{ json: string }>('SELECT json FROM player_report_reporters WHERE reporter_id = ?', id).toArray()[0]; return r ? (JSON.parse(r.json) as ReporterStats) : null; }
  putStats(s: ReporterStats) { this.sql.exec('INSERT INTO player_report_reporters (reporter_id, json) VALUES (?, ?) ON CONFLICT(reporter_id) DO UPDATE SET json = excluded.json', s.reporterId, JSON.stringify(s)); }
  removeStats(id: string) { this.sql.exec('DELETE FROM player_report_reporters WHERE reporter_id = ?', id); }
  nextSeq() {
    this.sql.exec('INSERT INTO player_report_seq (id, seq) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET seq = seq + 1');
    return this.sql.exec<{ seq: number }>('SELECT seq FROM player_report_seq WHERE id = 1').one().seq;
  }
}

/** SQLite-backed moderation outbox (one row per player; see ops/moderationOutbox.ts). */
export class SqlModerationOutbox implements ModerationOutboxStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS moderation_outbox (player_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, next_at INTEGER NOT NULL, json TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS moderation_seq (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL)');
  }
  get(id: string) { const r = this.sql.exec<{ json: string }>('SELECT json FROM moderation_outbox WHERE player_id = ?', id).toArray()[0]; return r ? (JSON.parse(r.json) as OutboxItem) : null; }
  put(i: OutboxItem) {
    this.sql.exec('INSERT INTO moderation_outbox (player_id, seq, next_at, json) VALUES (?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET seq = excluded.seq, next_at = excluded.next_at, json = excluded.json', i.change.playerId, i.seq, i.nextAt, JSON.stringify(i));
  }
  delete(id: string, seq: number) { this.sql.exec('DELETE FROM moderation_outbox WHERE player_id = ? AND seq = ?', id, seq); }
  due(now: number, limit: number) { return this.sql.exec<{ json: string }>('SELECT json FROM moderation_outbox WHERE next_at <= ? ORDER BY next_at LIMIT ?', now, limit).toArray().map((r) => JSON.parse(r.json) as OutboxItem); }
  nextAt() { const r = this.sql.exec<{ t: number | null }>('SELECT MIN(next_at) AS t FROM moderation_outbox').one(); return r.t ?? null; }
  nextSeq() {
    this.sql.exec('INSERT INTO moderation_seq (id, seq) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET seq = seq + 1');
    return this.sql.exec<{ seq: number }>('SELECT seq FROM moderation_seq WHERE id = 1').one().seq;
  }
}

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
  reports(f: { status?: RaceReport['status']; raceId?: string; reporterId?: string; limit: number }) {
    const where: string[] = [];
    const args: string[] = [];
    if (f.status) { where.push('status = ?'); args.push(f.status); }
    if (f.raceId) { where.push('race_id = ?'); args.push(f.raceId); }
    if (f.reporterId) { where.push("json_extract(json, '$.reporterId') = ?"); args.push(f.reporterId); }
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
  private readonly outbox: ModerationOutboxStore;
  private readonly playerReports: PlayerReportsCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new IntegrityCore(new SqlIntegrityRepo(ctx.storage.sql));
    this.playerReports = new PlayerReportsCore(new SqlPlayerReportRepo(ctx.storage.sql));
    this.outbox = new SqlModerationOutbox(ctx.storage.sql);
  }

  private async pushOne(c: ModerationChange) {
    const p = this.env.PLAYER.get(this.env.PLAYER.idFromName(c.playerId)) as unknown as { invoke(m: string, a: unknown[]): Promise<Envelope<unknown>> };
    unwrap(await p.invoke('setModeration', [c.playerId, c.status, c.until, c.reason]));
  }

  /**
   * The decisions are written to the outbox (in the same synchronous step as the core's own writes),
   * then pushed; anything that fails stays queued and is retried by the alarm (REQ-OPS-035).
   */
  private async push(changes: ModerationChange[]) {
    const now = Date.now();
    enqueueModeration(this.outbox, changes, now);
    const r = await flushModeration(this.outbox, (c) => this.pushOne(c), now);
    if (r.failed > 0) console.error('moderation push failed; queued for retry', r.failed);
    await this.armAlarm(r.nextAt);
  }

  private async armAlarm(at: number | null) {
    if (at === null) return;
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || at < cur) await this.ctx.storage.setAlarm(Math.max(at, Date.now() + 1000));
  }

  override async alarm() {
    const now = Date.now();
    const toItems = (xs: OutboxItem[]): DeadLetterItem[] => xs.map((i) => ({ itemId: i.change.playerId, error: i.lastError ?? 'push failed', attempts: i.attempts }));
    const before = toItems(stuckModeration(this.outbox, MODERATION_DEAD_AFTER));
    const r = await flushModeration(this.outbox, (c) => this.pushOne(c), now);
    // QA r6 #6: decisions that just crossed MODERATION_DEAD_AFTER failed pushes go to the ops dead-letter index
    await reportDeadLetters(this.env, 'moderation', 'global', newlyDead(before, toItems(stuckModeration(this.outbox, MODERATION_DEAD_AFTER))), now);
    if (r.nextAt !== null) await this.ctx.storage.setAlarm(Math.max(r.nextAt, Date.now() + 1000));
  }

  /** Ops view of decisions still waiting to reach players' objects. */
  pendingModeration() { return wrap(() => this.outbox.due(Number.MAX_SAFE_INTEGER, 500)); }

  // ---- dead letters (REQ-OPS-041): decisions that failed to reach the player MODERATION_DEAD_AFTER+ times ----
  dlList(): Promise<Envelope<DeadLetterItem[]>> {
    return wrap(() => stuckModeration(this.outbox, MODERATION_DEAD_AFTER).map((i) => ({ itemId: i.change.playerId, error: i.lastError ?? 'push failed', attempts: i.attempts })));
  }
  dlRetry(playerId: string): Promise<Envelope<RetryOutcome>> {
    return wrap(async () => {
      const r = await retryModerationNow(this.outbox, playerId, (c) => this.pushOne(c), Date.now());
      await this.armAlarm(this.outbox.nextAt());
      return r;
    });
  }
  dlDismiss(playerId: string): Promise<Envelope<boolean>> { return wrap(() => dropModeration(this.outbox, playerId)); }

  recordRace(r: RaceIntegrityReport) {
    return wrap(async () => {
      const changes = this.core.recordRace(r);
      await this.push(changes);
      return changes;
    });
  }
  report(raceId: string, reporterId: string, now: number) { return wrap(() => this.core.addReport(raceId, reporterId, now)); }
  reports(status: RaceReport['status'] | undefined, limit: number) { return wrap(() => this.core.reports(status, limit)); }
  /** REQ-DEX-007: the reports a player made (their data export; no resolution notes). */
  reportsBy(reporterId: string) { return wrap(() => this.core.reportsBy(reporterId)); }
  resolveReport(id: string, resolution: string, by: string, now: number) { return wrap(() => this.core.resolveReport(id, resolution, by, now)); }
  view(playerId: string, now: number) { return wrap(() => this.core.view(playerId, now)); }
  // ---- player reports (REQ-RPT-007/013/014/016, §47.7–47.8) ----
  prSubmit(x: SubmitInput, now: number, cfg: ReportsConfig) { return wrap(() => this.playerReports.submit(x, now, cfg)); }
  prList(f: PlayerReportFilter) { return wrap(() => this.playerReports.list(f)); }
  prGet(id: string, cfg: ReportsConfig) { return wrap(() => this.playerReports.get(id, cfg)); }
  prCheck(id: string, action: ReportAction) { return wrap(() => this.playerReports.assertActionable(id, action)); }
  prResolve(id: string, action: ReportAction, by: string, note: string, now: number) { return wrap(() => this.playerReports.resolve(id, action, by, note, now)); }
  prForget(uid: string) { return wrap(() => this.playerReports.forgetPlayer(uid)); }
  /** REQ-DEX-007 (Round 18 integration): the §47 reports a player made, for their data export (no target, no decision note). */
  prMadeBy(uid: string) { return wrap(() => this.playerReports.madeBy(uid)); }
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
