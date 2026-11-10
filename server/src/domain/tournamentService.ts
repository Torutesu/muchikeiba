import { AppError } from './errors.js';
import { ROSTER_LIMITS } from './roster.js';
import type { Master } from './master.js';
import { tournamentDefSchema, tournamentProblems, TOURNAMENT_ID_RE, type EligibilityInfo, type TournamentDef, type TournamentSummary } from './tournaments.js';

/**
 * REQ-TOUR-*: player and admin entry points. The tournament itself lives in its own object (TournamentDO
 * `tour:<id>`, in-memory in tests); a small index object lists them. Finished tournaments are also
 * published to R2 (history, read without touching a Durable Object).
 */

export interface TournamentEntryInfo { entry: Record<string, unknown> & { playerId: string; rating: { r: number } }; displayName: string; info: EligibilityInfo }

export interface TournamentBackend {
  list(now: number): Promise<TournamentSummary[]>;
  view(id: string, now: number): Promise<unknown | null>;
  /** Published snapshot (R2) — null when not published yet. */
  published(id: string): Promise<unknown | null>;
  me(id: string, playerId: string, now: number): Promise<unknown>;
  register(id: string, playerId: string, horseId: string, e: TournamentEntryInfo, now: number): Promise<unknown>;
  unregister(id: string, playerId: string, now: number): Promise<unknown>;
  create(def: TournamentDef, by: string, now: number): Promise<unknown>;
  cancel(id: string, reason: string, by: string, now: number): Promise<unknown>;
}

export interface TournamentPlayers {
  tournamentEntry(uid: string, horseId: string): Promise<TournamentEntryInfo>;
  history(uid: string): Promise<unknown>;
  /** REQ-ORG-011: the player registered `horseId` (null = unregistered) until `untilMs` (optional; a failure never undoes the registration). */
  noteEntry?(uid: string, tournamentId: string, horseId: string | null, untilMs: number): Promise<void>;
}

export const tournamentIdParam = (s: string) => {
  if (!TOURNAMENT_ID_RE.test(s)) throw new AppError('BAD_REQUEST', 'bad tournament id');
  return s;
};

export class TournamentsService {
  constructor(
    private readonly master: () => Master,
    private readonly backend: TournamentBackend,
    private readonly players: TournamentPlayers,
    private readonly clock: () => number = Date.now,
  ) {}

  /** REQ-TOUR-009: upcoming / open / running first (by start), then recent results. */
  async list() {
    const now = this.clock();
    const all = (await this.backend.list(now)).map((t) => (t.status === 'scheduled' && now >= t.registrationOpensAtMs ? { ...t, status: 'registration' as const } : t));
    const active = all.filter((t) => t.status !== 'finished' && t.status !== 'cancelled').sort((a, b) => a.startsAtMs - b.startsAtMs);
    const past = all.filter((t) => t.status === 'finished' || t.status === 'cancelled').sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    return { tournaments: [...active, ...past], generatedAt: now };
  }

  async detail(id: string) {
    const now = this.clock();
    const v = await this.backend.view(tournamentIdParam(id), now);
    if (v) return v;
    const pub = await this.backend.published(id);
    if (pub) return pub;
    throw new AppError('NOT_FOUND', 'no such tournament');
  }

  me(uid: string, id: string) { return this.backend.me(tournamentIdParam(id), uid, this.clock()); }

  /** REQ-TOUR-002/003: eligibility is checked on the player's object data, then registered in the tournament. */
  async register(uid: string, id: string, horseId: string) {
    tournamentIdParam(id);
    const e = await this.players.tournamentEntry(uid, horseId);
    const r = await this.backend.register(id, uid, horseId, e, this.clock());
    await this.noteEntry(uid, id, horseId);
    return r;
  }

  async unregister(uid: string, id: string) {
    const r = await this.backend.unregister(tournamentIdParam(id), uid, this.clock());
    await this.noteEntry(uid, id, null);
    return r;
  }

  /** REQ-ORG-011: best effort — the horse counts as entered until the start + 24 h (or 14 days when the start is unknown). */
  private async noteEntry(uid: string, id: string, horseId: string | null) {
    if (!this.players.noteEntry) return;
    try {
      const now = this.clock();
      const v = horseId ? ((await this.backend.view(id, now)) as { startsAtMs?: number } | null) : null;
      const until = typeof v?.startsAtMs === 'number' ? v.startsAtMs + ROSTER_LIMITS.tournamentGraceMs : now + ROSTER_LIMITS.tournamentFallbackMs;
      await this.players.noteEntry(uid, id, horseId, until);
    } catch (e) { console.error('roster tournament note failed', uid, id, e); }
  }

  history(uid: string) { return this.players.history(uid); }

  // ---- admin (REQ-TOUR-001/010) ----
  async adminCreate(raw: unknown, by: string) {
    const r = tournamentDefSchema.safeParse(raw);
    if (!r.success) throw new AppError('BAD_REQUEST', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const p = tournamentProblems(this.master(), r.data);
    if (p.length) throw new AppError('BAD_REQUEST', p.join('; '));
    if (r.data.registrationClosesAtMs <= this.clock()) throw new AppError('BAD_REQUEST', 'registration must close in the future');
    return this.backend.create(r.data, by, this.clock());
  }

  adminCancel(id: string, reason: string, by: string) { return this.backend.cancel(tournamentIdParam(id), reason, by, this.clock()); }
}
