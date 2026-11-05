import { previousSeasonId } from './leaderboard.js';
import { jstMonthKey } from './time.js';

/** Cron expressions configured in wrangler.toml (UTC). */
export const CRONS = {
  /** Leaderboard snapshots + season rollover progress, every 5 minutes. */
  frequent: '*/5 * * * *',
  /** Replay retention sweep, daily at 03:23 JST. */
  daily: '23 18 * * *',
  /** Season reminder broadcast (FCM topic), daily at 12:07 JST — outside everyone's default quiet hours. */
  noon: '7 3 * * *',
} as const;

export interface ScheduledDeps {
  /** Rebuild and publish the current season's leaderboard snapshot (no-op when nothing changed). */
  snapshot(seasonId: string): Promise<unknown>;
  /** Advance the previous season's rollover by one bounded step (no-op once closed). */
  rolloverStep(seasonId: string): Promise<{ status: string }>;
  sweepReplays(now: number): Promise<{ deleted: number }>;
  /** REQ-PUSH-006: broadcast today's season reminder if there is one; returns the template sent or null. */
  seasonReminder?(now: number): Promise<string | null>;
}

/**
 * REQ-LB-001 / REQ-SEASON-001 / REQ-OPS-001: dispatch for the Worker's scheduled() handler.
 * Every step is idempotent, so overlapping or repeated runs are harmless.
 */
export async function runScheduled(cron: string, now: number, deps: ScheduledDeps) {
  const done: string[] = [];
  if (cron === CRONS.frequent) {
    await deps.snapshot(jstMonthKey(now));
    done.push('snapshot');
    const prev = previousSeasonId(now);
    const r = await deps.rolloverStep(prev);
    done.push(`rollover:${prev}:${r.status}`);
  } else if (cron === CRONS.noon) {
    const t = deps.seasonReminder ? await deps.seasonReminder(now) : null;
    done.push(`reminder:${t ?? 'none'}`);
  } else if (cron === CRONS.daily) {
    const r = await deps.sweepReplays(now);
    done.push(`sweep:${r.deleted}`);
  } else {
    done.push(`unknown:${cron}`);
  }
  return done;
}
