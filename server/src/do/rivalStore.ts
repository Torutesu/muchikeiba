import type { PairRow, RivalRegistry, RivalWeekStore } from '../domain/rivalService.js';
import { unwrap, type Envelope } from './rpc.js';
import type { RivalCard, RivalEntry } from '../domain/rival.js';

/**
 * REQ-RIVAL-*: one game week's rival registry in SQLite (contracts/protocol.md §28). Lives in a LeaderboardDO instance
 * named `rival:<weekId>` (the leaderboard tables there stay empty), so weeks never contend with each other or with the
 * season boards, and no new Durable Object class / migration is needed. Tables are created on first use.
 */
export class SqlRivalWeekStore implements RivalWeekStore {
  private static ready = new WeakSet<SqlStorage>();
  constructor(private readonly sql: SqlStorage) {
    if (SqlRivalWeekStore.ready.has(sql)) return;
    sql.exec('CREATE TABLE IF NOT EXISTS rv_entries (player_id TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS rv_cards (player_id TEXT PRIMARY KEY, body TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS rv_pairs (player_id TEXT PRIMARY KEY, kind TEXT NOT NULL, rival_id TEXT, cpu_id TEXT, dissolved_at INTEGER)');
    sql.exec('CREATE TABLE IF NOT EXISTS rv_withdrawn (player_id TEXT PRIMARY KEY)');
    sql.exec('CREATE TABLE IF NOT EXISTS rv_ta (player_id TEXT NOT NULL, track_id TEXT NOT NULL, time_ms INTEGER NOT NULL, PRIMARY KEY (player_id, track_id))');
    sql.exec('CREATE TABLE IF NOT EXISTS rv_notified (k TEXT PRIMARY KEY)');
    sql.exec('CREATE TABLE IF NOT EXISTS rv_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    SqlRivalWeekStore.ready.add(sql);
  }
  paired() { return this.sql.exec('SELECT v FROM rv_kv WHERE k = ?', 'paired').toArray().length > 0; }
  setPaired(at: number) { this.sql.exec('INSERT OR REPLACE INTO rv_kv (k, v) VALUES (?, ?)', 'paired', String(at)); }
  entry(pid: string) {
    const r = this.sql.exec<{ body: string }>('SELECT body FROM rv_entries WHERE player_id = ?', pid).toArray()[0];
    return r ? (JSON.parse(r.body) as RivalEntry) : null;
  }
  putEntry(e: RivalEntry) { this.sql.exec('INSERT OR REPLACE INTO rv_entries (player_id, body, updated_at) VALUES (?, ?, ?)', e.playerId, JSON.stringify(e), e.updatedAt); }
  deleteEntry(pid: string) { this.sql.exec('DELETE FROM rv_entries WHERE player_id = ?', pid); }
  entriesAfter(after: string, limit: number) {
    return this.sql.exec<{ body: string }>('SELECT body FROM rv_entries WHERE player_id > ? ORDER BY player_id LIMIT ?', after, limit).toArray().map((r) => JSON.parse(r.body) as RivalEntry);
  }
  pair(pid: string): PairRow | null {
    const r = this.sql.exec<{ kind: string; rival_id: string | null; cpu_id: string | null; dissolved_at: number | null }>('SELECT kind, rival_id, cpu_id, dissolved_at FROM rv_pairs WHERE player_id = ?', pid).toArray()[0];
    return r ? { kind: r.kind as PairRow['kind'], rivalId: r.rival_id, cpuId: r.cpu_id, dissolvedAt: r.dissolved_at } : null;
  }
  putPair(pid: string, row: PairRow) {
    this.sql.exec('INSERT OR REPLACE INTO rv_pairs (player_id, kind, rival_id, cpu_id, dissolved_at) VALUES (?, ?, ?, ?, ?)', pid, row.kind, row.rivalId, row.cpuId, row.dissolvedAt);
  }
  card(pid: string) {
    const r = this.sql.exec<{ body: string }>('SELECT body FROM rv_cards WHERE player_id = ?', pid).toArray()[0];
    return r ? (JSON.parse(r.body) as RivalCard) : null;
  }
  putCard(pid: string, c: RivalCard) { this.sql.exec('INSERT OR REPLACE INTO rv_cards (player_id, body) VALUES (?, ?)', pid, JSON.stringify(c)); }
  deleteCard(pid: string) { this.sql.exec('DELETE FROM rv_cards WHERE player_id = ?', pid); }
  isWithdrawn(pid: string) { return this.sql.exec('SELECT 1 FROM rv_withdrawn WHERE player_id = ?', pid).toArray().length > 0; }
  setWithdrawn(pid: string, on: boolean) {
    if (on) this.sql.exec('INSERT OR IGNORE INTO rv_withdrawn (player_id) VALUES (?)', pid);
    else this.sql.exec('DELETE FROM rv_withdrawn WHERE player_id = ?', pid);
  }
  withdrawnAll() { return this.sql.exec<{ player_id: string }>('SELECT player_id FROM rv_withdrawn').toArray().map((r) => r.player_id); }
  ta(pid: string) {
    return Object.fromEntries(this.sql.exec<{ track_id: string; time_ms: number }>('SELECT track_id, time_ms FROM rv_ta WHERE player_id = ?', pid).toArray().map((r) => [r.track_id, r.time_ms]));
  }
  putTa(pid: string, trackId: string, ms: number) { this.sql.exec('INSERT OR REPLACE INTO rv_ta (player_id, track_id, time_ms) VALUES (?, ?, ?)', pid, trackId, ms); }
  deleteTa(pid: string) { this.sql.exec('DELETE FROM rv_ta WHERE player_id = ?', pid); }
  notified(k: string) { return this.sql.exec('SELECT 1 FROM rv_notified WHERE k = ?', k).toArray().length > 0; }
  addNotified(k: string) { this.sql.exec('INSERT OR IGNORE INTO rv_notified (k) VALUES (?)', k); }
}

type RivalRpc = Record<string, (...a: unknown[]) => Promise<Envelope<unknown>>>;

/** The week registries over Durable Object RPC (LeaderboardDO instances `rival:<weekId>`). */
export function durableRivalRegistry(ns: DurableObjectNamespace, clock: () => number = Date.now): RivalRegistry {
  const w = (weekId: string) => ns.get(ns.idFromName(`rival:${weekId}`)) as unknown as RivalRpc;
  const call = async <T>(p: Promise<Envelope<unknown>>) => unwrap(await p) as T;
  return {
    ensurePaired: (weekId) => call(w(weekId).rivalEnsurePaired!(weekId, clock())),
    assignment: (weekId, pid) => call(w(weekId).rivalAssignment!(weekId, pid, clock())),
    register: async (weekId, e) => { await call(w(weekId).rivalRegister!(weekId, e, clock())); },
    withdraw: async (weekId, pid) => { await call(w(weekId).rivalWithdraw!(weekId, pid, clock())); },
    dissolve: async (weekId, pid) => { await call(w(weekId).rivalDissolve!(weekId, pid, clock())); },
    taBest: (weekId, pid, t, ms) => call(w(weekId).rivalTaBest!(weekId, pid, t, ms)),
    forget: async (weekId, pid) => { await call(w(weekId).rivalForget!(weekId, pid, clock())); },
  };
}
