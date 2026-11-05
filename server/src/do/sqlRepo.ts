import type { PlayerState } from '../domain/player.js';
import type { PlayerRepo } from '../domain/service.js';

const LEDGER_KEEP_IN_STATE = 100;

/**
 * PlayerRepo on Durable Object SQLite storage. The state is one JSON row; the full ledger is also
 * appended to a `ledger` table (audit trail) and only the recent tail is kept inside the JSON.
 * All calls are synchronous, so a read-modify-write in one DO cannot interleave.
 */
export class SqlPlayerRepo implements PlayerRepo {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS state (id TEXT PRIMARY KEY, json TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS ledger (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, currency TEXT NOT NULL, delta INTEGER NOT NULL, balance_after INTEGER NOT NULL, reason TEXT NOT NULL, ref TEXT NOT NULL)`);
  }

  get(id: string): PlayerState | null {
    const rows = this.sql.exec<{ json: string }>('SELECT json FROM state WHERE id = ?', id).toArray();
    return rows[0] ? (JSON.parse(rows[0].json) as PlayerState) : null;
  }

  put(s: PlayerState): void {
    const maxRow = this.sql.exec<{ m: number | null }>('SELECT MAX(seq) AS m FROM ledger').toArray()[0];
    const stored = maxRow?.m ?? 0;
    for (const e of s.ledger) {
      if (e.seq <= stored) continue;
      this.sql.exec('INSERT INTO ledger (seq, at, kind, currency, delta, balance_after, reason, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', e.seq, e.at, e.kind, e.currency, e.delta, e.balanceAfter, e.reason, e.ref);
    }
    const trimmed = { ...s, ledger: s.ledger.slice(-LEDGER_KEEP_IN_STATE) };
    this.sql.exec('INSERT INTO state (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json', s.id, JSON.stringify(trimmed));
  }
}
