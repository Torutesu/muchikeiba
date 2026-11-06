import type { Env } from '../env.js';
import type { DeadLetterItem, DeadLetterRecord, DeadLetterRegistry, DeadLetterSource, DeadLetterStatus } from '../ops/deadLetter.js';
import type { Envelope } from './rpc.js';

/** REQ-OPS-041: dead-letter index on SQLite (inside OpsDO). The owning objects stay the source of truth. */
export class SqlDeadLetterRegistry implements DeadLetterRegistry {
  constructor(private readonly sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS dead_letters (source TEXT NOT NULL, scope TEXT NOT NULL, item_id TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (source, scope, item_id))');
    sql.exec('CREATE INDEX IF NOT EXISTS dead_letters_status ON dead_letters (status, updated_at)');
  }
  async upsert(r: DeadLetterRecord) {
    this.sql.exec('INSERT INTO dead_letters (source, scope, item_id, status, updated_at, json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source, scope, item_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, json = excluded.json',
      r.source, r.scope, r.itemId, r.status, r.updatedAt, JSON.stringify(r));
  }
  async get(source: DeadLetterSource, scope: string, itemId: string) {
    const r = this.sql.exec<{ json: string }>('SELECT json FROM dead_letters WHERE source = ? AND scope = ? AND item_id = ?', source, scope, itemId).toArray()[0];
    return r ? (JSON.parse(r.json) as DeadLetterRecord) : null;
  }
  async list(q: { status?: DeadLetterStatus; source?: DeadLetterSource; limit: number }) {
    const where: string[] = [];
    const args: string[] = [];
    if (q.status) { where.push('status = ?'); args.push(q.status); }
    if (q.source) { where.push('source = ?'); args.push(q.source); }
    return this.sql.exec<{ json: string }>(`SELECT json FROM dead_letters ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`, ...args, Math.min(500, q.limit))
      .toArray().map((r) => JSON.parse(r.json) as DeadLetterRecord);
  }
}

/**
 * Producers call this when items are newly dead-lettered so ops see them in one list (best effort: the owner
 * keeps the truth, and `inspect` on the admin API re-syncs the index from it).
 */
export async function reportDeadLetters(env: Env, source: DeadLetterSource, scope: string, items: DeadLetterItem[], now: number): Promise<void> {
  if (!env.OPS || items.length === 0) return;
  try {
    const ops = env.OPS.get(env.OPS.idFromName('global')) as unknown as { dlRegister(r: DeadLetterRecord[]): Promise<Envelope<unknown>> };
    await ops.dlRegister(items.map((i) => ({ ...i, source, scope, status: 'open' as const, firstSeenAt: now, updatedAt: now })));
  } catch (e) {
    console.error('dead-letter registry update failed', source, scope, (e as Error).message);
  }
}

/** Items in `after` that were not in `before` (by id). */
export const newlyDead = (before: DeadLetterItem[], after: DeadLetterItem[]) => after.filter((a) => !before.some((b) => b.itemId === a.itemId));
