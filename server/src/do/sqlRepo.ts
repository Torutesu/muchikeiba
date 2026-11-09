import type { Currency, LedgerEntry, PlayerState } from '../domain/player.js';
import type { PlayerRepo } from '../domain/service.js';
import { HISTORY_LIMITS, type GachaLogEntry } from '../domain/history.js';
import { DAY_MS } from '../domain/time.js';

const LEDGER_KEEP_IN_STATE = 100;
/** REQ-HIST-013: gacha records kept inside the state JSON; the rest live in the `gacha_log` table (90 days). */
const GACHA_KEEP_IN_STATE = 20;

function ensurePlayerSchema(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS state (id TEXT PRIMARY KEY, json TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS ledger (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, currency TEXT NOT NULL, delta INTEGER NOT NULL, balance_after INTEGER NOT NULL, reason TEXT NOT NULL, ref TEXT NOT NULL)`);
  // r10: the deletion tombstone (player id + wipe time only, no personal data) — written right after the wipe
  sql.exec(`CREATE TABLE IF NOT EXISTS deleted (id TEXT PRIMARY KEY, at INTEGER NOT NULL)`);
  // REQ-HIST-004: one row per gacha draw (dropped after 90 days by put)
  sql.exec(`CREATE TABLE IF NOT EXISTS gacha_log (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, json TEXT NOT NULL)`);
}

/**
 * REQ-UXS-040: the account deletion's last step. deleteAll() also drops the SQL tables, while this object (and its
 * repo) can keep serving calls until it is evicted: the empty tables are created again, so those calls see "no
 * player" (PlayerService answers deliveries to a wiped player as no-ops) instead of failing on a missing table.
 */
export async function wipePlayerStorage(storage: DurableObjectStorage, playerId?: string) {
  await storage.deleteAll();
  ensurePlayerSchema(storage.sql);
  // r10: remember that this id was deleted, so a late delivery (a race result settled after the wipe) is ACKed as a no-op
  // instead of creating a fresh player under the deleted id (PlayerService.applyRace)
  if (playerId) storage.sql.exec('INSERT INTO deleted (id, at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING', playerId, Date.now());
}

/**
 * PlayerRepo on Durable Object SQLite storage. The state is one JSON row; the full ledger is also
 * appended to a `ledger` table (audit trail) and only the recent tail is kept inside the JSON.
 * All calls are synchronous, so a read-modify-write in one DO cannot interleave.
 */
export class SqlPlayerRepo implements PlayerRepo {
  constructor(private readonly sql: SqlStorage) {
    ensurePlayerSchema(sql);
  }

  /** r10: true once this id's account deletion wiped the storage (wipePlayerStorage wrote the tombstone). */
  tombstoned(id: string): boolean {
    return this.sql.exec<{ id: string }>('SELECT id FROM deleted WHERE id = ?', id).toArray().length > 0;
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
    // REQ-HIST-004/013: gacha records move to their table; rows past the 90-day window are deleted on every write
    const log = s.gachaLog;
    if (log && log.entries.length > 0) {
      const gmax = this.sql.exec<{ m: number | null }>('SELECT MAX(seq) AS m FROM gacha_log').toArray()[0]?.m ?? 0;
      for (const e of log.entries) if (e.seq > gmax) this.sql.exec('INSERT INTO gacha_log (seq, at, json) VALUES (?, ?, ?)', e.seq, e.at, JSON.stringify(e));
    }
    this.sql.exec('DELETE FROM gacha_log WHERE at <= ?', Date.now() - HISTORY_LIMITS.gachaDays * DAY_MS);
    const trimmed = { ...s, ledger: s.ledger.slice(-LEDGER_KEEP_IN_STATE), ...(log ? { gachaLog: { seq: log.seq, entries: log.entries.slice(-GACHA_KEEP_IN_STATE) } } : {}) };
    this.sql.exec('INSERT INTO state (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json', s.id, JSON.stringify(trimmed));
  }

  /** REQ-HIST-003: the full ledger (the state keeps only the recent tail), newest first. */
  ledgerPage(_id: string, q: { beforeSeq: number | null; sinceAt: number; limit: number; currency: Currency | null }): LedgerEntry[] {
    const rows = this.sql.exec<{ seq: number; at: number; kind: string; currency: string; delta: number; balance_after: number; reason: string; ref: string }>(
      'SELECT seq, at, kind, currency, delta, balance_after, reason, ref FROM ledger WHERE seq < ? AND at > ? AND (? IS NULL OR currency = ?) ORDER BY seq DESC LIMIT ?',
      q.beforeSeq ?? Number.MAX_SAFE_INTEGER, q.sinceAt, q.currency, q.currency, q.limit,
    ).toArray();
    return rows.map((x) => ({ seq: x.seq, at: x.at, kind: x.kind as LedgerEntry['kind'], currency: x.currency as Currency, delta: x.delta, balanceAfter: x.balance_after, reason: x.reason, ref: x.ref }));
  }

  /** REQ-HIST-004: gacha records of the window, newest first. */
  gachaPage(_id: string, q: { beforeSeq: number | null; sinceAt: number; limit: number }): GachaLogEntry[] {
    return this.sql.exec<{ json: string }>('SELECT json FROM gacha_log WHERE seq < ? AND at > ? ORDER BY seq DESC LIMIT ?', q.beforeSeq ?? Number.MAX_SAFE_INTEGER, q.sinceAt, q.limit)
      .toArray().map((r) => JSON.parse(r.json) as GachaLogEntry);
  }
}
