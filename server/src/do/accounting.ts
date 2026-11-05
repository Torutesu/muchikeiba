import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { aggregatePaidBalances, type PaidBalanceSnapshot } from '../domain/accounting.js';

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
