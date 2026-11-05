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

/**
 * Walks the replay prefix page by page (bounded work per run; the next run continues naturally because
 * deleted keys disappear from the listing). Returns how many were deleted and kept.
 */
export async function sweepReplays(bucket: ReplayBucket, now: number, retentionDays: number, maxPages = 20): Promise<{ deleted: number; scanned: number }> {
  let cursor: string | undefined;
  let deleted = 0;
  let scanned = 0;
  for (let page = 0; page < maxPages; page++) {
    const res = await bucket.list({ prefix: REPLAY_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
    scanned += res.objects.length;
    const keys = replaysToDelete(res.objects.map((o) => ({ key: o.key, uploaded: o.uploaded.getTime(), hold: o.customMetadata?.hold ?? null })), now, retentionDays);
    for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
    deleted += keys.length;
    if (!res.truncated || !res.cursor) break;
    cursor = res.cursor;
  }
  return { deleted, scanned };
}
