import { AppError } from '../domain/errors.js';
import type { PlayerInvoker } from '../http/app.js';
import { signTicket, verifyTicket } from '../http/ticket.js';
import type { VerifierClient } from '../domain/verifier.js';
import { ghostKey, type GhostFile, type TaBoardFile, type TaEntry, type TaResult } from '../domain/timeAttack.js';
import { jstMonthKey } from '../domain/time.js';
import type { Ruleset } from '../domain/ruleset.js';

/** Season time-attack standings (implemented by LeaderboardDO `lb:<seasonId>`). */
export interface TaBoardPort {
  upsert(e: TaEntry): Promise<boolean>;
  rankOf(seasonId: string, trackId: string, playerId: string): Promise<{ rank: number; total: number; generatedAt: number | null } | null>;
  entries(seasonId: string, trackId: string, playerIds: string[]): Promise<TaEntry[]>;
  /** The published snapshot file (R2), or null before the first snapshot. */
  snapshot(seasonId: string, trackId: string): Promise<TaBoardFile | null>;
}

/** Verified ghost runs (R2 `ghosts/…`). */
export interface GhostStore {
  put(key: string, file: GhostFile): Promise<void>;
  get(key: string): Promise<GhostFile | null>;
}

export interface TimeAttackPorts {
  player(uid: string): PlayerInvoker;
  verifier: VerifierClient;
  board: TaBoardPort;
  ghosts: GhostStore;
  ticketSecret: string;
  clock: () => number;
  /** REQ-TA-009: the active remote-config ruleset (time attack must follow it, not the built-in default). */
  activeRuleset?: () => Promise<Ruleset>;
}

export interface SubmitBody { sessionId: string; token: string; inputs: unknown; resultHash: string; config?: unknown }
export type GhostKind = 'top' | 'friends' | 'me';

const raceIdOf = (sessionId: string) => `ta_${sessionId}`;
const ghostPath = (seasonId: string, trackId: string, playerId: string) => `/v1/time-attack/ghosts/${seasonId}/${trackId}/${encodeURIComponent(playerId)}`;

/**
 * Time attack orchestration (REQ-TA-*): start → (device runs the race) → submit → verify → record →
 * publish (leaderboard entry + ghost). Every player-state change goes through the player's own object.
 */
export class TimeAttackService {
  constructor(private readonly p: TimeAttackPorts) {}

  /** REQ-TA-001: issue a session and a short-lived token bound to player + session. */
  async start(uid: string, trackId: string, horseId: string) {
    const ruleset = this.p.activeRuleset ? await this.p.activeRuleset() : undefined;
    const r = await this.p.player(uid).invoke('taStart', uid, trackId, horseId, ruleset);
    const token = await signTicket({ raceId: raceIdOf(r.sessionId), slot: 0, playerId: uid, exp: r.expiresAt }, this.p.ticketSecret);
    return { ...r, token };
  }

  /** REQ-TA-003: submit inputs; the server re-simulates with the config it issued. */
  async submit(uid: string, b: SubmitBody): Promise<TaResult & { published: boolean }> {
    const t = await verifyTicket(b.token, this.p.ticketSecret, raceIdOf(b.sessionId), this.p.clock()).catch(() => {
      throw new AppError('TA_SESSION_EXPIRED', 'invalid or expired session token');
    });
    if (t.playerId !== uid) throw new AppError('UNAUTHORIZED');
    const pl = this.p.player(uid);
    const prep = await pl.invoke('taPrepare', uid, b.sessionId, b.inputs, b.resultHash, b.config);
    if (prep.kind === 'done') return { ...prep.result, published: prep.result.seasonBest };
    let out;
    try {
      out = await this.p.verifier.verify(prep.log);
    } catch (e) {
      await pl.invoke('taAbort', uid, b.sessionId);
      throw new AppError('VERIFIER_UNAVAILABLE', (e as Error).message);
    }
    const rec = await pl.invoke('taRecord', uid, b.sessionId, out, b.resultHash);
    if ('rejected' in rec) throw new AppError('TA_RESULT_MISMATCH', 'the server re-simulation does not match the submitted run');
    let published = false;
    if (rec.finished && rec.seasonBest) published = await this.publish(uid, rec, prep.log);
    return { ...rec, published };
  }

  /** REQ-TA-006/008: ghost first (the board links to it), then the leaderboard entry. Failures leave the PB recorded. */
  private async publish(uid: string, rec: TaResult, log: GhostFile['log']): Promise<boolean> {
    try {
      const prof = await this.p.player(uid).invoke('publicProfile', uid);
      const horseName = log.config.entrants[0]!.horse.name;
      await this.p.ghosts.put(ghostKey(rec.seasonId, rec.trackId, uid), {
        meta: { playerId: uid, displayName: prof.displayName, horseName, seasonId: rec.seasonId, trackId: rec.trackId, timeMs: rec.timeMs!, finishTick: rec.finishTick!, finishFrac: rec.finishFrac! },
        log,
      });
      // REQ-UXS-012: friends whose time this run passed (they were ahead of my previous best, or I had none)
      const friends = await this.p.player(uid).invoke('friendsState', uid).then((f) => f.ids).catch(() => [] as string[]);
      const before = friends.length ? await this.p.board.entries(rec.seasonId, rec.trackId, [uid, ...friends]).catch(() => [] as TaEntry[]) : [];
      const mineBefore = before.find((e) => e.playerId === uid);
      await this.p.board.upsert({
        playerId: uid, seasonId: rec.seasonId, trackId: rec.trackId, timeMs: rec.timeMs!, finishTick: rec.finishTick!, finishFrac: rec.finishFrac!,
        displayName: prof.displayName, titleId: prof.titleId, horseName, updatedAt: this.p.clock(),
      });
      const mine = { finishTick: rec.finishTick!, finishFrac: rec.finishFrac! };
      for (const f of beatenFriends(before.filter((e) => e.playerId !== uid), mineBefore ?? null, mine)) {
        await this.p.player(f).invoke('nudgeTaBeaten', f, prof.displayName, rec.trackId).catch((e) => console.error('ta beaten nudge failed', f, e));
      }
      return true;
    } catch (e) {
      console.error('time attack publish failed', uid, rec.sessionId, e);
      return false;
    }
  }

  /** REQ-TA-006: my bests for a track + my rank in the current season. */
  async me(uid: string, trackId: string) {
    const view = await this.p.player(uid).invoke('taView', uid, trackId);
    const rank = await this.p.board.rankOf(view.seasonId, trackId, uid);
    return { ...view, rank };
  }

  /** REQ-TA-008: ghost candidates (metadata + download path). */
  async ghosts(uid: string, trackId: string, kind: GhostKind, seasonId?: string) {
    const season = seasonId ?? jstMonthKey(this.p.clock());
    let entries: { playerId: string; displayName: string; horseName: string; timeMs: number; rank: number | null }[];
    if (kind === 'top') {
      const snap = await this.p.board.snapshot(season, trackId);
      entries = (snap?.entries ?? []).slice(0, 10).map((e) => ({ playerId: e.playerId, displayName: e.displayName, horseName: e.horseName, timeMs: e.timeMs, rank: e.rank }));
    } else {
      const ids = kind === 'me' ? [uid] : (await this.p.player(uid).invoke('friendsState', uid)).ids;
      const rows = ids.length ? await this.p.board.entries(season, trackId, ids) : [];
      entries = rows.sort((a, b) => a.finishTick - b.finishTick || a.finishFrac - b.finishFrac).map((e) => ({ playerId: e.playerId, displayName: e.displayName, horseName: e.horseName, timeMs: e.timeMs, rank: null }));
    }
    return { seasonId: season, trackId, kind, ghosts: entries.map((e) => ({ ...e, path: ghostPath(season, trackId, e.playerId) })) };
  }

  async ghost(seasonId: string, trackId: string, playerId: string): Promise<GhostFile> {
    const g = await this.p.ghosts.get(ghostKey(seasonId, trackId, playerId));
    if (!g) throw new AppError('NOT_FOUND', 'ghost');
    return g;
  }
}

const fasterThan = (a: { finishTick: number; finishFrac: number }, b: { finishTick: number; finishFrac: number }) => a.finishTick < b.finishTick || (a.finishTick === b.finishTick && a.finishFrac < b.finishFrac);

/** REQ-UXS-012: friends this run overtook: faster than my old best (or I had none) and slower than my new one. */
export function beatenFriends(friends: TaEntry[], oldMine: { finishTick: number; finishFrac: number } | null, newMine: { finishTick: number; finishFrac: number }): string[] {
  return friends.filter((f) => fasterThan(newMine, f) && (!oldMine || fasterThan(f, oldMine))).map((f) => f.playerId);
}
