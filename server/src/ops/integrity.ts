import { AppError } from '../domain/errors.js';

/**
 * Anti-cheat operations (REQ-OPS-030..035). Races report the players whose result hash disagreed with
 * the final result (suspects) and whose checksums diverged (desync). Flags are weighted in a rolling
 * window; crossing the threshold quarantines the player automatically (ranked matches only against other
 * quarantined players or CPU). Bans are an admin decision. Player reports go to a review queue and never
 * quarantine anyone by themselves (so reports cannot be weaponised).
 */
export type ModerationStatus = 'ok' | 'quarantined' | 'banned';

export interface IntegrityPolicy {
  windowMs: number;
  weights: { suspect: number; desync: number };
  quarantineScore: number;
  quarantineMs: number;
  maxEvents: number;
}
export const DEFAULT_INTEGRITY: IntegrityPolicy = {
  windowMs: 7 * 86_400_000,
  weights: { suspect: 1, desync: 0.5 }, // desync is often a bad connection, a disagreeing result hash is not
  quarantineScore: 3,
  quarantineMs: 14 * 86_400_000,
  maxEvents: 50,
};

export interface IntegrityEvent { raceId: string; at: number; kind: 'suspect' | 'desync' }
export interface PlayerIntegrity {
  playerId: string;
  events: IntegrityEvent[];
  quarantinedUntil: number | null;
  banned: { at: number; until: number | null; reason: string; by: string } | null;
  notes: { at: number; by: string; action: string; reason: string }[];
  updatedAt: number;
}

export interface RaceIntegrityReport {
  raceId: string; mode: 'ranked' | 'friend' | 'tutorial' | 'timeattack' | 'event' | 'tournament' | 'challenge' | 'cup'; at: number;
  /** Player ids (humans only). */
  suspects: string[]; desync: string[];
}

export interface RaceReport { id: string; raceId: string; reporterId: string; at: number; status: 'open' | 'resolved'; resolution: string | null; resolvedBy: string | null; resolvedAt: number | null }

export interface IntegrityRepo {
  player(id: string): PlayerIntegrity | null;
  putPlayer(p: PlayerIntegrity): void;
  players(filter: { status?: ModerationStatus | 'flagged'; now: number; limit: number }): PlayerIntegrity[];
  raceSeen(raceId: string): boolean;
  markRace(raceId: string, at: number): void;
  report(id: string): RaceReport | null;
  putReport(r: RaceReport): void;
  reports(filter: { status?: RaceReport['status']; raceId?: string; reporterId?: string; limit: number }): RaceReport[];
}

export function statusOf(p: PlayerIntegrity | null, now: number): ModerationStatus {
  if (!p) return 'ok';
  if (p.banned && (p.banned.until === null || now < p.banned.until)) return 'banned';
  if (p.quarantinedUntil !== null && now < p.quarantinedUntil) return 'quarantined';
  return 'ok';
}

export function scoreOf(p: PlayerIntegrity, now: number, policy = DEFAULT_INTEGRITY): number {
  return p.events.filter((e) => now - e.at < policy.windowMs).reduce((a, e) => a + policy.weights[e.kind], 0);
}

const blank = (playerId: string, now: number): PlayerIntegrity => ({ playerId, events: [], quarantinedUntil: null, banned: null, notes: [], updatedAt: now });

export interface ModerationChange { playerId: string; status: ModerationStatus; until: number | null; reason: string }

export class IntegrityCore {
  constructor(private readonly repo: IntegrityRepo, private readonly policy: IntegrityPolicy = DEFAULT_INTEGRITY) {}

  /** Records one settled race (idempotent per race). Returns the players whose moderation status changed. */
  recordRace(r: RaceIntegrityReport): ModerationChange[] {
    if (r.mode === 'tutorial' || this.repo.raceSeen(r.raceId)) return [];
    this.repo.markRace(r.raceId, r.at);
    const changes: ModerationChange[] = [];
    const add = (pid: string, kind: IntegrityEvent['kind']) => {
      const p = this.repo.player(pid) ?? blank(pid, r.at);
      if (p.events.some((e) => e.raceId === r.raceId && e.kind === kind)) return;
      const before = statusOf(p, r.at);
      p.events = [...p.events, { raceId: r.raceId, at: r.at, kind }].slice(-this.policy.maxEvents);
      if (before === 'ok' || before === 'quarantined') {
        if (scoreOf(p, r.at, this.policy) >= this.policy.quarantineScore) {
          p.quarantinedUntil = r.at + this.policy.quarantineMs; // re-flagging extends the quarantine
          p.notes = [...p.notes, { at: r.at, by: 'system', action: 'quarantine', reason: `score ${scoreOf(p, r.at, this.policy)} (race ${r.raceId})` }].slice(-50);
        }
      }
      p.updatedAt = r.at;
      this.repo.putPlayer(p);
      const after = statusOf(p, r.at);
      if (after !== before) changes.push({ playerId: pid, status: after, until: p.quarantinedUntil, reason: 'automatic quarantine' });
    };
    for (const pid of new Set(r.suspects)) add(pid, 'suspect');
    for (const pid of new Set(r.desync)) if (!r.suspects.includes(pid)) add(pid, 'desync');
    return changes;
  }

  view(playerId: string, now: number) {
    const p = this.repo.player(playerId) ?? blank(playerId, now);
    return { ...p, status: statusOf(p, now), score: scoreOf(p, now, this.policy) };
  }

  list(status: ModerationStatus | 'flagged' | undefined, now: number, limit = 100) {
    return this.repo.players({ ...(status ? { status } : {}), now, limit: Math.min(500, limit) }).map((p) => ({ playerId: p.playerId, status: statusOf(p, now), score: scoreOf(p, now, this.policy), quarantinedUntil: p.quarantinedUntil, banned: p.banned, updatedAt: p.updatedAt }));
  }

  ban(playerId: string, until: number | null, reason: string, by: string, now: number): ModerationChange {
    if (until !== null && until <= now) throw new AppError('BAD_REQUEST', 'ban end must be in the future');
    const p = this.repo.player(playerId) ?? blank(playerId, now);
    p.banned = { at: now, until, reason, by };
    p.notes = [...p.notes, { at: now, by, action: 'ban', reason }].slice(-50);
    p.updatedAt = now;
    this.repo.putPlayer(p);
    return { playerId, status: 'banned', until, reason };
  }

  unban(playerId: string, reason: string, by: string, now: number): ModerationChange {
    const p = this.repo.player(playerId);
    if (!p?.banned) throw new AppError('CONFLICT', 'player is not banned');
    p.banned = null;
    p.notes = [...p.notes, { at: now, by, action: 'unban', reason }].slice(-50);
    p.updatedAt = now;
    this.repo.putPlayer(p);
    return { playerId, status: statusOf(p, now), until: p.quarantinedUntil, reason };
  }

  /** Lifts a quarantine (e.g. after review found a bad connection). Flags in the window are cleared. */
  release(playerId: string, reason: string, by: string, now: number): ModerationChange {
    const p = this.repo.player(playerId);
    if (!p || statusOf(p, now) !== 'quarantined') throw new AppError('CONFLICT', 'player is not quarantined');
    p.quarantinedUntil = null;
    p.events = p.events.filter((e) => now - e.at >= this.policy.windowMs);
    p.notes = [...p.notes, { at: now, by, action: 'release', reason }].slice(-50);
    p.updatedAt = now;
    this.repo.putPlayer(p);
    return { playerId, status: statusOf(p, now), until: null, reason };
  }

  /** A player reported a race (REQ-NET / reports queue). One open report per (race, reporter). */
  addReport(raceId: string, reporterId: string, now: number): RaceReport {
    const id = `rep_${raceId}_${reporterId}`;
    const existing = this.repo.report(id);
    if (existing) return existing;
    const r: RaceReport = { id, raceId, reporterId, at: now, status: 'open', resolution: null, resolvedBy: null, resolvedAt: null };
    this.repo.putReport(r);
    return r;
  }

  reports(status: RaceReport['status'] | undefined, limit = 100) {
    return this.repo.reports({ ...(status ? { status } : {}), limit: Math.min(500, limit) });
  }

  /**
   * REQ-DEX-007 (§51): the reports a player made, for their data export — the race, when, and whether it is still open.
   * Never the resolution note or who resolved it (operator notes about the race, possibly about another player).
   */
  reportsBy(reporterId: string, limit = 500) {
    return this.repo.reports({ reporterId, limit: Math.min(1000, limit) }).map((r) => ({ raceId: r.raceId, at: r.at, status: r.status }));
  }

  resolveReport(id: string, resolution: string, by: string, now: number): RaceReport {
    const r = this.repo.report(id);
    if (!r) throw new AppError('NOT_FOUND', `report ${id}`);
    if (r.status === 'resolved') return r;
    const done: RaceReport = { ...r, status: 'resolved', resolution, resolvedBy: by, resolvedAt: now };
    this.repo.putReport(done);
    return done;
  }
}

export class MemoryIntegrityRepo implements IntegrityRepo {
  ps = new Map<string, PlayerIntegrity>();
  races = new Map<string, number>();
  rs = new Map<string, RaceReport>();
  player(id: string) { const p = this.ps.get(id); return p ? structuredClone(p) : null; }
  putPlayer(p: PlayerIntegrity) { this.ps.set(p.playerId, structuredClone(p)); }
  players(f: { status?: ModerationStatus | 'flagged'; now: number; limit: number }) {
    return [...this.ps.values()]
      .filter((p) => !f.status || (f.status === 'flagged' ? p.events.length > 0 : statusOf(p, f.now) === f.status))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, f.limit);
  }
  raceSeen(id: string) { return this.races.has(id); }
  markRace(id: string, at: number) { this.races.set(id, at); }
  report(id: string) { return this.rs.get(id) ?? null; }
  putReport(r: RaceReport) { this.rs.set(r.id, r); }
  reports(f: { status?: RaceReport['status']; raceId?: string; reporterId?: string; limit: number }) {
    return [...this.rs.values()].filter((r) => (!f.status || r.status === f.status) && (!f.raceId || r.raceId === f.raceId) && (!f.reporterId || r.reporterId === f.reporterId)).sort((a, b) => b.at - a.at).slice(0, f.limit);
  }
}
