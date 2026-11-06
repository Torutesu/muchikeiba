import { jstMonthKey } from './time.js';

/**
 * Cron expressions configured in wrangler.toml (UTC). None of them resets anything per game day: daily resets
 * are lazy (keyed by gameDayKey on the next request, REQ-DAY-001), so the 04:00 JST rollover needs no cron.
 * Seasons roll over on the calendar month (REQ-DAY-004); the 03:23 JST sweep is maintenance only.
 */
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
  /** REQ-TEAM-008: advance the previous season's team reward payout by one bounded step. */
  teamRolloverStep?(seasonId: string): Promise<{ status: string }>;
  /** REQ-EVENT-007..009: event boards, start notifications and end-of-event rewards; returns a short log. */
  eventsStep?(now: number): Promise<string[]>;
  /** REQ-LEAGUE-001..003: the current season's team league (after the past seasons' rollovers, which finalize last month's league). */
  leagueStep?(seasonId: string): Promise<{ status: string }>;
  /** REQ-TOUR-005: wake active tournaments (fallback for their own alarms); returns a short log. */
  tournamentsStep?(now: number): Promise<string[]>;
  /** REQ-UXS-012: "registration closes soon" nudges for tournaments closing within the lead time. */
  tournamentClosingStep?(now: number): Promise<string[]>;
  /** REQ-UXS-040: drop anonymised records of deleted accounts past their legal retention. */
  purgeRetained?(now: number): Promise<{ purged: number }>;
}

/** How many past seasons the cron keeps stepping until they report closed (a stalled one is not abandoned). */
export const ROLLOVER_LOOKBACK = 3;

/** The `n` seasons before `now`'s season, newest first ("YYYY-MM"). */
export function pastSeasons(now: number, n = ROLLOVER_LOOKBACK): string[] {
  const out: string[] = [];
  let [y, m] = jstMonthKey(now).split('-').map(Number) as [number, number];
  for (let i = 0; i < n; i++) {
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
    out.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return out;
}

/**
 * REQ-LB-001 / REQ-SEASON-001 / REQ-OPS-001: dispatch for the Worker's scheduled() handler.
 * Every step is idempotent, so overlapping or repeated runs are harmless. Each step runs in its own
 * try: one failing step (a snapshot, one season's rollover) never skips the others in the same run.
 * Rollovers are stepped for the last few seasons, not only the previous one, so a season whose payout
 * stalled or ran past month end keeps progressing (closed seasons answer with a cheap no-op).
 */
export async function runScheduled(cron: string, now: number, deps: ScheduledDeps) {
  const done: string[] = [];
  const step = async (name: string, f: () => Promise<string | string[]>) => {
    try {
      const r = await f();
      done.push(...(Array.isArray(r) ? r : [r]));
    } catch (e) {
      console.error('scheduled step failed', name, e);
      done.push(`${name}:error`);
    }
  };
  if (cron === CRONS.frequent) {
    await step('snapshot', async () => { await deps.snapshot(jstMonthKey(now)); return 'snapshot'; });
    for (const season of pastSeasons(now)) {
      await step(`rollover:${season}`, async () => `rollover:${season}:${(await deps.rolloverStep(season)).status}`);
      const team = deps.teamRolloverStep;
      if (team) await step(`teamRollover:${season}`, async () => `teamRollover:${season}:${(await team(season)).status}`);
    }
    const league = deps.leagueStep;
    if (league) await step('league', async () => `league:${(await league(jstMonthKey(now))).status}`);
    const events = deps.eventsStep;
    if (events) await step('events', () => events(now));
    const tours = deps.tournamentsStep;
    if (tours) await step('tournaments', () => tours(now));
    const closing = deps.tournamentClosingStep;
    if (closing) await step('tournamentClosing', () => closing(now));
  } else if (cron === CRONS.noon) {
    await step('reminder', async () => `reminder:${(deps.seasonReminder ? await deps.seasonReminder(now) : null) ?? 'none'}`);
  } else if (cron === CRONS.daily) {
    await step('sweep', async () => `sweep:${(await deps.sweepReplays(now)).deleted}`);
    const purge = deps.purgeRetained;
    if (purge) await step('purgeRetained', async () => `purgeRetained:${(await purge(now)).purged}`);
  } else {
    done.push(`unknown:${cron}`);
  }
  return done;
}
