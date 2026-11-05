import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { aggregatePaidBalances, type PaidBalanceSnapshot } from '../domain/accounting.js';

/** Latest unused paid-coin balance per player, for the Payment Services Act base-date check (REQ-WAL-005). */
export class AccountingDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS paid (player_id TEXT PRIMARY KEY, date TEXT NOT NULL, coins INTEGER NOT NULL, yen INTEGER NOT NULL)');
  }

  async record(s: PaidBalanceSnapshot) {
    this.ctx.storage.sql.exec('INSERT INTO paid (player_id, date, coins, yen) VALUES (?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET date = excluded.date, coins = excluded.coins, yen = excluded.yen', s.playerId, s.date, s.paidCoins, s.paidYen);
  }

  async summary() {
    const rows = this.ctx.storage.sql.exec<{ player_id: string; date: string; coins: number; yen: number }>('SELECT player_id, date, coins, yen FROM paid').toArray();
    return aggregatePaidBalances(rows.map((r) => ({ playerId: r.player_id, date: r.date, paidCoins: r.coins, paidYen: r.yen })));
  }
}
