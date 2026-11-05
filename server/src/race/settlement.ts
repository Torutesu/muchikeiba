import type { Outbound, RaceRoomCore } from '../domain/raceRoom.js';
import type { Rating } from '../domain/rating.js';
import type { RaceResultForPlayer } from '../domain/rewards.js';
import type { ReplayLog, VerifierOutput } from '../domain/schemas.js';
import { settleRace } from './orchestrate.js';

/**
 * Verification and settlement of a finished race, driven only from the room's alarm (REQ-NET-014).
 * Every step persists its progress before the next await, so a restart, a concurrent socket event or a
 * transient failure can neither verify twice, void a race on one blip, nor pay a player twice
 * (per-player application is also idempotent on the race id).
 */
export interface SettleMeta {
  ratings: Record<string, Rating>;
  settled: boolean;
  verifyAttempts: number;
  settleAttempts: number;
  replayStored: boolean;
  results: Record<string, RaceResultForPlayer> | null;
  pending: string[];
  retryAt: number | null;
}

export const newSettleMeta = (ratings: Record<string, Rating>): SettleMeta => ({
  ratings, settled: false, verifyAttempts: 0, settleAttempts: 0, replayStored: false, results: null, pending: [], retryAt: null,
});

/** Older stored metas only had {ratings, settled}. */
export function upgradeSettleMeta(m: Partial<SettleMeta> & { ratings: Record<string, Rating> }): SettleMeta {
  return { ...newSettleMeta(m.ratings), ...m };
}

export interface SettleDeps {
  verify(log: ReplayLog): Promise<VerifierOutput>;
  putReplay(log: ReplayLog, hold: string | null): Promise<void>;
  applyRace(playerId: string, r: RaceResultForPlayer): Promise<void>;
  /** Frees the players' matchmaking assignment (best effort). */
  raceFinished(playerIds: string[]): Promise<void>;
  persist(): Promise<void>;
}

export const MAX_VERIFY_ATTEMPTS = 3;
export const backoffMs = (attempt: number) => 2000 * 2 ** Math.min(6, Math.max(0, attempt - 1));

export interface DriveResult { out: Outbound[]; retryAt: number | null }

export async function driveSettlement(core: RaceRoomCore, meta: SettleMeta, deps: SettleDeps, now: number): Promise<DriveResult> {
  const out: Outbound[] = [];
  if (meta.retryAt !== null && now < meta.retryAt) return { out, retryAt: meta.retryAt };

  if (core.phase === 'verifying') {
    const log = core.replayLog();
    if (!meta.replayStored) {
      await deps.putReplay(log, core.retentionHold() ?? 'verifying');
      meta.replayStored = true;
    }
    meta.verifyAttempts++;
    meta.retryAt = null;
    await deps.persist(); // the attempt counts even if we crash during the call
    try {
      out.push(...core.applyVerification(await deps.verify(log)));
    } catch (e) {
      if (meta.verifyAttempts < MAX_VERIFY_ATTEMPTS) {
        meta.retryAt = now + backoffMs(meta.verifyAttempts);
        await deps.persist();
        return { out, retryAt: meta.retryAt };
      }
      console.error('verifier unavailable; voiding race', (e as Error).message);
      out.push(...core.applyVerification(null));
    }
    await deps.persist();
  }

  if (core.phase === 'final' && !meta.settled && core.final) {
    const log = core.replayLog();
    if (!meta.results) {
      meta.results = settleRace(core.config, core.final, meta.ratings, log);
      meta.pending = Object.keys(meta.results).sort();
      await deps.persist();
    }
    await deps.putReplay(log, core.retentionHold()); // final version (with the hold reason) replaces any earlier copy
    meta.replayStored = true;
    for (const pid of [...meta.pending]) {
      try {
        await deps.applyRace(pid, meta.results[pid]!);
        meta.pending = meta.pending.filter((x) => x !== pid);
        await deps.persist();
      } catch (e) {
        console.error('applyRace failed; will retry', pid, (e as Error).message);
      }
    }
    if (meta.pending.length > 0) {
      meta.settleAttempts++;
      meta.retryAt = now + backoffMs(meta.settleAttempts);
      await deps.persist();
      return { out, retryAt: meta.retryAt };
    }
    meta.settled = true;
    meta.retryAt = null;
    await deps.persist();
    try {
      await deps.raceFinished(Object.keys(meta.results));
    } catch (e) {
      console.error('raceFinished notify failed', (e as Error).message);
    }
  }
  return { out, retryAt: null };
}
