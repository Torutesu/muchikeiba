import { DAY_MS } from './time.js';

/**
 * REQ-OPS-001: replay log retention. Replays are written to R2 at `replays/<raceId>.json` with
 * customMetadata `hold` set when the race was reported, disputed, desynced, verified or void.
 * The daily sweep deletes replays older than the retention period unless they are on hold.
 */
export const REPLAY_PREFIX = 'replays/';

export interface ReplayObjectInfo { key: string; uploaded: number; hold: string | null }

export function replaysToDelete(objects: ReplayObjectInfo[], now: number, retentionDays: number): string[] {
  const cutoff = now - retentionDays * DAY_MS;
  return objects.filter((o) => o.key.startsWith(REPLAY_PREFIX) && o.hold === null && o.uploaded < cutoff).map((o) => o.key);
}

/** The part of R2Bucket the sweep needs (lets tests use a fake). */
export interface ReplayBucket {
  list(o: { prefix: string; cursor?: string; limit?: number }): Promise<{ objects: { key: string; uploaded: Date; customMetadata?: Record<string, string> }[]; truncated: boolean; cursor?: string }>;
  delete(keys: string[]): Promise<void>;
}

/** Where the sweep remembers how far it got (survives between daily runs). */
export interface SweepCursorStore {
  get(): Promise<string | null>;
  set(cursor: string | null): Promise<void>;
}

/** Key of the cursor object when it is kept in the replay bucket itself (outside the replay prefix). */
export const SWEEP_CURSOR_KEY = '_sweep/replays-cursor';

/**
 * Walks the replay prefix page by page with bounded work per run. The listing position is persisted
 * after every page and the next run resumes from it, wrapping to the start once the end is reached —
 * restarting from the beginning every run would only ever see the first pages, which fill up with
 * recent and held replays as traffic grows, and expired ones further on would never be deleted.
 */
export async function sweepReplays(bucket: ReplayBucket, now: number, retentionDays: number, maxPages = 20, store?: SweepCursorStore): Promise<{ deleted: number; scanned: number; reachedEnd: boolean }> {
  const resumeFrom = (await store?.get()) ?? null;
  let cursor: string | undefined = resumeFrom ?? undefined;
  let deleted = 0;
  let scanned = 0;
  let reachedEnd = false;
  for (let page = 0; page < maxPages; page++) {
    const res = await bucket.list({ prefix: REPLAY_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
    scanned += res.objects.length;
    const keys = replaysToDelete(res.objects.map((o) => ({ key: o.key, uploaded: o.uploaded.getTime(), hold: o.customMetadata?.hold ?? null })), now, retentionDays);
    for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
    deleted += keys.length;
    if (!res.truncated || !res.cursor) {
      await store?.set(null); // end of the listing: the next run starts over
      // resumed mid-listing and budget left: wrap once to cover the keys before the saved position
      if (reachedEnd || resumeFrom === null) { reachedEnd = true; break; }
      reachedEnd = true;
      cursor = undefined;
      continue;
    }
    cursor = res.cursor;
    await store?.set(cursor); // durable progress after every page
  }
  return { deleted, scanned, reachedEnd };
}
