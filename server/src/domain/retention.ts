import { DAY_MS } from './time.js';

/**
 * REQ-OPS-001: replay log retention. Replays are written to R2 at `replays/<raceId>.json` with
 * customMetadata `hold` set when the race was reported, disputed, desynced, verified or void.
 * The daily sweep deletes replays older than the retention period unless they are on hold.
 */
export const REPLAY_PREFIX = 'replays/';

export interface ReplayObjectInfo { key: string; uploaded: number; hold: string | null }

/**
 * REQ-OPS-001a: how long each hold reason keeps a replay (days since upload). A reason that is absent or
 * null is kept until ops act (reported / disputed / desync / void need a human). "verified" only proves the
 * verifier settled a solo or contested race; nothing is pending on it, so it expires after a bounded period
 * (otherwise held replays grow with traffic forever). Ghost runs live under `ghosts/` and are never swept here.
 */
export type HoldPolicy = Partial<Record<string, number | null>>;
export const DEFAULT_HOLD_POLICY: HoldPolicy = { verified: 90 };

/** Hold reasons that need a human decision: never expire automatically, whatever a config says (QA r6 #2). */
export const MANUAL_HOLDS = ['reported', 'disputed', 'desync', 'void'] as const;
/** Hold reasons that may carry a number of days. */
export const EXPIRING_HOLDS = ['verified', 'verifying'] as const;

/** Validation for `progression.replayHoldDays` (boot and remote config): manual holds must stay null, expiring ones ≥ 1 day. */
export function holdPolicyProblems(holds: unknown): string[] {
  if (holds === undefined) return [];
  if (holds === null || typeof holds !== 'object' || Array.isArray(holds)) return ['replayHoldDays: must be an object'];
  const p: string[] = [];
  for (const [k, v] of Object.entries(holds as Record<string, unknown>)) {
    if ((MANUAL_HOLDS as readonly string[]).includes(k)) { if (v !== null) p.push(`replayHoldDays.${k}: must be null (kept until ops act)`); continue; }
    if (!(EXPIRING_HOLDS as readonly string[]).includes(k)) { p.push(`replayHoldDays.${k}: unknown hold reason`); continue; }
    if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 1)) p.push(`replayHoldDays.${k}: must be an integer ≥ 1 or null`);
  }
  return p;
}

export function replaysToDelete(objects: ReplayObjectInfo[], now: number, retentionDays: number, holds: HoldPolicy = DEFAULT_HOLD_POLICY): string[] {
  const cutoff = now - retentionDays * DAY_MS;
  return objects.filter((o) => {
    if (!o.key.startsWith(REPLAY_PREFIX)) return false;
    if (o.hold === null) return o.uploaded < cutoff;
    if ((MANUAL_HOLDS as readonly string[]).includes(o.hold)) return false; // defence in depth: never auto-delete
    const days = holds[o.hold];
    if (typeof days !== 'number' || days < 1) return false;
    // a held replay is never deleted earlier than an unheld one would be
    return o.uploaded < now - Math.max(days, retentionDays) * DAY_MS;
  }).map((o) => o.key);
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
export async function sweepReplays(bucket: ReplayBucket, now: number, retentionDays: number, maxPages = 20, store?: SweepCursorStore, holds: HoldPolicy = DEFAULT_HOLD_POLICY): Promise<{ deleted: number; scanned: number; reachedEnd: boolean }> {
  const resumeFrom = (await store?.get()) ?? null;
  let cursor: string | undefined = resumeFrom ?? undefined;
  let deleted = 0;
  let scanned = 0;
  let reachedEnd = false;
  for (let page = 0; page < maxPages; page++) {
    const res = await bucket.list({ prefix: REPLAY_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
    scanned += res.objects.length;
    const keys = replaysToDelete(res.objects.map((o) => ({ key: o.key, uploaded: o.uploaded.getTime(), hold: o.customMetadata?.hold ?? null })), now, retentionDays, holds);
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
