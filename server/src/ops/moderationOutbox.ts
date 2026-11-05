import type { ModerationChange } from './integrity.js';

/**
 * Moderation changes waiting to be pushed to the players' own objects (REQ-OPS-035).
 *
 * The integrity service decides (quarantine, ban, release) and the player's object enforces it. The
 * decision is stored first, together with the race being marked seen, and the push happens after; if a
 * push fails it stays here and is retried from the integrity object's alarm, so a transient failure can
 * no longer leave a quarantined player matched as "ok". One row per player: a newer decision replaces
 * an older one still waiting (`seq` stops a slow push of the old one from deleting the new one).
 */
export interface OutboxItem { change: ModerationChange; seq: number; attempts: number; nextAt: number; lastError: string | null }

export interface ModerationOutboxStore {
  get(playerId: string): OutboxItem | null;
  put(item: OutboxItem): void;
  delete(playerId: string, seq: number): void;
  due(now: number, limit: number): OutboxItem[];
  nextAt(): number | null;
  nextSeq(): number;
}

export const OUTBOX_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 3_600_000];

export function enqueueModeration(store: ModerationOutboxStore, changes: ModerationChange[], now: number) {
  for (const change of changes) store.put({ change, seq: store.nextSeq(), attempts: 0, nextAt: now, lastError: null });
}

/** Pushes what is due; failed items back off (capped at 1 hour, never dropped). Returns the next wake time. */
export async function flushModeration(store: ModerationOutboxStore, push: (c: ModerationChange) => Promise<void>, now: number, limit = 100): Promise<{ pushed: number; failed: number; nextAt: number | null }> {
  let pushed = 0;
  let failed = 0;
  for (const item of store.due(now, limit)) {
    try {
      await push(item.change);
      store.delete(item.change.playerId, item.seq);
      pushed++;
    } catch (e) {
      failed++;
      const cur = store.get(item.change.playerId);
      if (cur && cur.seq === item.seq) {
        const attempts = item.attempts + 1;
        store.put({ ...item, attempts, nextAt: now + OUTBOX_BACKOFF_MS[Math.min(attempts - 1, OUTBOX_BACKOFF_MS.length - 1)]!, lastError: (e as Error).message });
      }
    }
  }
  return { pushed, failed, nextAt: store.nextAt() };
}

export class MemoryModerationOutbox implements ModerationOutboxStore {
  items = new Map<string, OutboxItem>();
  private seq = 0;
  get(id: string) { return this.items.get(id) ?? null; }
  put(i: OutboxItem) { this.items.set(i.change.playerId, i); }
  delete(id: string, seq: number) { if (this.items.get(id)?.seq === seq) this.items.delete(id); }
  due(now: number, limit: number) { return [...this.items.values()].filter((i) => i.nextAt <= now).sort((a, b) => a.nextAt - b.nextAt).slice(0, limit); }
  nextAt() { const v = [...this.items.values()].map((i) => i.nextAt); return v.length ? Math.min(...v) : null; }
  nextSeq() { return ++this.seq; }
}
