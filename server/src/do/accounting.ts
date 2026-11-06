import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { aggregatePaidBalances, type PaidBalanceSnapshot } from '../domain/accounting.js';
import { applyRetainedRefund, type RetainedRecord } from '../domain/accountDeletion.js';
import { AppError } from '../domain/errors.js';

/**
 * Latest unused paid-coin balance per player, for the Payment Services Act base-date check (REQ-WAL-005).
 * Snapshots carry the player's ledger sequence so late or reordered deliveries never overwrite a newer one.
 * `closeDay` freezes the day's totals so the balance on a base date (03-31 / 09-30) stays on record.
 */
export class AccountingDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS paid (player_id TEXT PRIMARY KEY, date TEXT NOT NULL, coins INTEGER NOT NULL, yen INTEGER NOT NULL)');
    const cols = sql.exec<{ name: string }>('PRAGMA table_info(paid)').toArray().map((c) => c.name);
    if (!cols.includes('seq')) sql.exec('ALTER TABLE paid ADD COLUMN seq INTEGER NOT NULL DEFAULT 0');
    sql.exec('CREATE TABLE IF NOT EXISTS paid_daily (date TEXT PRIMARY KEY, players INTEGER NOT NULL, coins INTEGER NOT NULL, yen INTEGER NOT NULL, closed_at INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS store_tx (key TEXT PRIMARY KEY, player_id TEXT NOT NULL, at INTEGER NOT NULL)');
  }

  /** Global store-transaction owner index (first claim wins): one receipt credits one player; routes store notifications. */
  async claimStoreKey(key: string, playerId: string): Promise<string> {
    this.ctx.storage.sql.exec('INSERT INTO store_tx (key, player_id, at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING', key, playerId, Date.now());
    return this.ctx.storage.sql.exec<{ player_id: string }>('SELECT player_id FROM store_tx WHERE key = ?', key).one().player_id;
  }

  async lookupStoreKey(key: string): Promise<string | null> {
    const rows = this.ctx.storage.sql.exec<{ player_id: string }>('SELECT player_id FROM store_tx WHERE key = ?', key).toArray();
    return rows[0]?.player_id ?? null;
  }

  /**
   * REQ-UXS-040: keeps a deleted account's legally required records under a random id (no link to the account):
   * the store transactions point to that id from now on, and the player's paid balance row goes (forfeited).
   * Idempotent per anonId; a rebuilt record (higher `rev`: something was credited during the deletion) replaces it.
   */
  async retainDeleted(playerId: string, record: RetainedRecord) {
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS retained (anon_id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL, retain_until INTEGER NOT NULL, record TEXT NOT NULL)');
    sql.exec('INSERT INTO retained (anon_id, deleted_at, retain_until, record) VALUES (?, ?, ?, ?) ON CONFLICT(anon_id) DO UPDATE SET record = excluded.record WHERE json_extract(excluded.record, \'$.rev\') >= coalesce(json_extract(retained.record, \'$.rev\'), 0)', record.anonId, record.deletedAt, record.retainUntil, JSON.stringify(record));
    sql.exec('UPDATE store_tx SET player_id = ? WHERE player_id = ?', record.anonId, playerId);
    sql.exec('DELETE FROM paid WHERE player_id = ?', playerId);
    return { ok: true };
  }

  /**
   * REQ-UXS-040 × REQ-PUR-006: a store refund that resolved to a deleted account's anonymous id. Recorded on the retained
   * record (applyRetainedRefund). Null when `anonId` has no retained record (the caller treats it as unknown).
   */
  async retainedRefund(anonId: string, txId: string, nowMs: number) {
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS retained (anon_id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL, retain_until INTEGER NOT NULL, record TEXT NOT NULL)');
    const row = sql.exec<{ record: string }>('SELECT record FROM retained WHERE anon_id = ?', anonId).toArray()[0];
    if (!row) return null;
    try {
      const { record, result } = applyRetainedRefund(JSON.parse(row.record) as RetainedRecord, txId, nowMs);
      if (!result.alreadyRefunded) sql.exec('UPDATE retained SET record = ? WHERE anon_id = ?', JSON.stringify(record), anonId);
      return result;
    } catch (e) {
      if (e instanceof AppError && e.code === 'NOT_FOUND') return null;
      throw e;
    }
  }

  /** Daily: drops retained records past their legal retention. */
  async purgeRetained(nowMs: number) {
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS retained (anon_id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL, retain_until INTEGER NOT NULL, record TEXT NOT NULL)');
    const n = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM retained WHERE retain_until <= ?', nowMs).one().n;
    sql.exec('DELETE FROM retained WHERE retain_until <= ?', nowMs);
    return { purged: n };
  }

  async record(s: PaidBalanceSnapshot) {
    this.ctx.storage.sql.exec(
      'INSERT INTO paid (player_id, date, coins, yen, seq) VALUES (?, ?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET date = excluded.date, coins = excluded.coins, yen = excluded.yen, seq = excluded.seq WHERE excluded.seq >= paid.seq',
      s.playerId, s.date, s.paidCoins, s.paidYen, s.seq,
    );
  }

  private current() {
    const rows = this.ctx.storage.sql.exec<{ player_id: string; date: string; coins: number; yen: number; seq: number }>('SELECT player_id, date, coins, yen, seq FROM paid').toArray();
    return aggregatePaidBalances(rows.map((r) => ({ playerId: r.player_id, date: r.date, paidCoins: r.coins, paidYen: r.yen, seq: r.seq })));
  }

  async summary() {
    const daily = this.ctx.storage.sql.exec<{ date: string; players: number; coins: number; yen: number }>('SELECT date, players, coins, yen FROM paid_daily ORDER BY date DESC LIMIT 400').toArray();
    return { ...this.current(), daily };
  }

  /** Freeze the totals for `date` (JST yyyy-mm-dd). Called by the daily cron; re-running overwrites the same day. */
  async closeDay(date: string, nowMs: number) {
    const c = this.current();
    const players = this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM paid WHERE coins > 0').one().n;
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO paid_daily (date, players, coins, yen, closed_at) VALUES (?, ?, ?, ?, ?)', date, players, c.totalPaidCoins, c.totalPaidYen, nowMs);
    return { date, players, coins: c.totalPaidCoins, yen: c.totalPaidYen };
  }
}
