import { AppError } from '../domain/errors.js';
import type { AdminPrincipal, AdminRole } from './admin.js';
import { GRANT_LIMITS, type Grant } from './support.js';

/**
 * REQ-OPS-026: compensation grants with a two-person rule. A grant up to the approval threshold is paid at once (like the
 * direct grant route); a larger one is stored as a pending request that a *different* admin must approve before it is
 * paid. The request's own `opKey` keeps creation idempotent, and the payment uses `comp/<opKey>` as the player-side
 * idempotency key ('/' is outside opKeySchema, so it can never collide with a direct or bulk grant key), so approving
 * twice — or retrying an approval whose payment failed — never pays twice.
 */
export const COMP_APPROVAL_THRESHOLD = GRANT_LIMITS.operator;
/** Hard cap of one request, whoever approves it. */
export const COMP_HARD_CAP = GRANT_LIMITS.admin;
/** A pending request nobody decided on expires (a stale request must be raised again, with fresh context). */
export const COMP_TTL_MS = 72 * 3600 * 1000;

export type CompensationStatus = 'pending' | 'approved' | 'executed' | 'rejected' | 'expired';
export interface CompensationRequest {
  id: string; opKey: string; playerId: string; grant: Grant; reason: string;
  requestedBy: string; requestedRole: AdminRole; requestedAt: number; expiresAt: number;
  needsApproval: boolean; status: CompensationStatus;
  decidedBy: string | null; decidedAt: number | null; decisionNote: string | null;
  executedAt: number | null; error: string | null;
}
export interface CompensationQuery { status?: CompensationStatus; playerId?: string; limit?: number }
export interface CompensationRepo {
  get(id: string): CompensationRequest | null;
  byOpKey(opKey: string): CompensationRequest | null;
  put(r: CompensationRequest): void;
  list(q: CompensationQuery): CompensationRequest[];
  nextSeq(): number;
}

export const compPaymentKey = (opKey: string) => `comp/${opKey}`;

/** Over the threshold → two-person approval. */
export function needsApproval(g: Grant): boolean {
  if ((g.freeCoins ?? 0) > COMP_APPROVAL_THRESHOLD.freeCoins) return true;
  return (g.items ?? []).some((it) => it.qty > COMP_APPROVAL_THRESHOLD.itemQty);
}

export function checkHardCap(g: Grant) {
  if ((g.freeCoins ?? 0) > COMP_HARD_CAP.freeCoins) throw new AppError('FORBIDDEN', `freeCoins over the hard cap ${COMP_HARD_CAP.freeCoins}`);
  for (const it of g.items ?? []) if (it.qty > COMP_HARD_CAP.itemQty) throw new AppError('FORBIDDEN', `${it.itemId} qty over the hard cap ${COMP_HARD_CAP.itemQty}`);
}

const expired = (r: CompensationRequest, now: number) => r.status === 'pending' && now >= r.expiresAt;
const withExpiry = (r: CompensationRequest, now: number): CompensationRequest => (expired(r, now) ? { ...r, status: 'expired' } : r);

export class CompensationStore {
  constructor(private readonly repo: CompensationRepo) {}

  /** Creates a request (or returns the one already created with this opKey — same player and grant only). */
  create(input: { opKey: string; playerId: string; grant: Grant; reason: string }, by: AdminPrincipal, now: number): { request: CompensationRequest; created: boolean } {
    const prev = this.repo.byOpKey(input.opKey);
    if (prev) {
      if (prev.playerId !== input.playerId || JSON.stringify(prev.grant) !== JSON.stringify(input.grant)) throw new AppError('CONFLICT', `opKey ${input.opKey} was already used for another compensation`);
      return { request: withExpiry(prev, now), created: false };
    }
    checkHardCap(input.grant);
    const approval = needsApproval(input.grant);
    const r: CompensationRequest = {
      id: `comp_${this.repo.nextSeq()}`, opKey: input.opKey, playerId: input.playerId, grant: input.grant, reason: input.reason,
      requestedBy: by.id, requestedRole: by.role, requestedAt: now, expiresAt: now + COMP_TTL_MS,
      needsApproval: approval, status: approval ? 'pending' : 'approved',
      decidedBy: approval ? null : by.id, decidedAt: approval ? null : now, decisionNote: approval ? null : 'under the approval threshold',
      executedAt: null, error: null,
    };
    this.repo.put(r);
    return { request: r, created: true };
  }

  get(id: string, now: number): CompensationRequest {
    const r = this.repo.get(id);
    if (!r) throw new AppError('NOT_FOUND', `compensation ${id}`);
    return withExpiry(r, now);
  }

  list(q: CompensationQuery, now: number): CompensationRequest[] {
    // expiry is derived, so 'pending' must not list expired rows and 'expired' must find them
    const rows = this.repo.list({ ...q, ...(q.status === 'expired' ? { status: 'pending' } : {}), limit: 500 }).map((r) => withExpiry(r, now));
    return rows.filter((r) => !q.status || r.status === q.status).slice(0, Math.min(200, q.limit ?? 50));
  }

  /**
   * The second person's decision. Approve: pending → approved (the caller then pays and calls `executed`). An approved
   * request whose payment failed can be approved again to retry the payment (idempotent on the player side).
   */
  approve(id: string, by: AdminPrincipal, note: string, now: number): CompensationRequest {
    const r = this.get(id, now);
    if (by.role !== 'admin') throw new AppError('FORBIDDEN', 'requires role admin');
    if (r.requestedBy === by.id) throw new AppError('FORBIDDEN', 'two-person rule: the requester cannot approve their own compensation');
    if (r.status === 'expired') throw new AppError('CONFLICT', 'request expired; raise a new one');
    if (r.status === 'rejected' || r.status === 'executed') throw new AppError('CONFLICT', `request is ${r.status}`);
    if (r.status === 'approved') return r; // retry of a failed payment
    const next: CompensationRequest = { ...r, status: 'approved', decidedBy: by.id, decidedAt: now, decisionNote: note };
    this.repo.put(next);
    return next;
  }

  reject(id: string, by: AdminPrincipal, note: string, now: number): CompensationRequest {
    const r = this.get(id, now);
    if (r.status !== 'pending') throw new AppError('CONFLICT', `request is ${r.status}`);
    const next: CompensationRequest = { ...r, status: 'rejected', decidedBy: by.id, decidedAt: now, decisionNote: note };
    this.repo.put(next);
    return next;
  }

  /** Records the payment outcome of an approved request. */
  executed(id: string, error: string | null, now: number): CompensationRequest {
    const r = this.repo.get(id);
    if (!r) throw new AppError('NOT_FOUND', `compensation ${id}`);
    if (r.status !== 'approved') return r;
    const next: CompensationRequest = error ? { ...r, error } : { ...r, status: 'executed', executedAt: now, error: null };
    this.repo.put(next);
    return next;
  }
}

export class MemoryCompensationRepo implements CompensationRepo {
  rows: CompensationRequest[] = [];
  private seq = 0;
  get(id: string) { return this.rows.find((r) => r.id === id) ?? null; }
  byOpKey(opKey: string) { return this.rows.find((r) => r.opKey === opKey) ?? null; }
  put(r: CompensationRequest) {
    const i = this.rows.findIndex((x) => x.id === r.id);
    if (i >= 0) this.rows[i] = r; else this.rows.push(r);
  }
  list(q: CompensationQuery) {
    return this.rows
      .filter((r) => (!q.status || r.status === q.status) && (!q.playerId || r.playerId === q.playerId))
      .sort((a, b) => b.requestedAt - a.requestedAt || b.id.localeCompare(a.id))
      .slice(0, q.limit ?? 50);
  }
  nextSeq() { return ++this.seq; }
}
