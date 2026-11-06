/**
 * REQ-BREED-010..016: stud lending across two players' objects (see stud.ts for the per-player steps and
 * why each is safe to repeat). Listings are mirrored into a directory for browsing; the owner's object
 * stays the source of truth, so a stale directory row can only ever lead to a NOT_FOUND.
 */
import { AppError } from './errors.js';
import type { StudApplyResult, StudEntry, StudSnapshot, StudVisibility } from './stud.js';

export interface StudPlayers {
  view(u: string): Promise<unknown>;
  list(u: string, horseId: string, visibility: StudVisibility, fee: number, dailyLimit: number): Promise<StudEntry>;
  unlist(u: string, horseId: string): Promise<unknown>;
  peek(owner: string, borrower: string, horseId: string): Promise<StudSnapshot & { remainingToday: number }>;
  reserve(owner: string, opId: string, borrower: string, horseId: string): Promise<StudSnapshot>;
  preview(borrower: string, snap: StudSnapshot & { remainingToday?: number }, damId: string): Promise<unknown>;
  apply(borrower: string, opId: string, snap: StudSnapshot, damId: string, useMaterial: boolean): Promise<StudApplyResult>;
  settle(owner: string, opId: string, ok: boolean, info: { borrowerId: string; horseId: string; fee: number; foalId: string | null }): Promise<{ status: string; paid: number }>;
  acked(borrower: string, opId: string): Promise<unknown>;
  friendIds(u: string): Promise<string[]>;
}

/** Browsable copy of listings. */
export interface StudDirectory {
  put(e: StudEntry): Promise<void>;
  remove(ownerId: string, horseId: string): Promise<void>;
  ofOwners(ownerIds: string[]): Promise<StudEntry[]>;
  publicList(limit: number): Promise<StudEntry[]>;
}

export class MemoryStudDirectory implements StudDirectory {
  readonly rows = new Map<string, StudEntry>();
  async put(e: StudEntry) { this.rows.set(`${e.ownerId}/${e.horseId}`, e); }
  async remove(ownerId: string, horseId: string) { this.rows.delete(`${ownerId}/${horseId}`); }
  async ofOwners(ids: string[]) { return [...this.rows.values()].filter((e) => ids.includes(e.ownerId)); }
  async publicList(limit: number) { return sortListings([...this.rows.values()].filter((e) => e.visibility === 'public')).slice(0, limit); }
}

/** Newest first, then owner/horse for a stable order. */
export const sortListings = (xs: StudEntry[]) => xs.sort((a, b) => b.listedAt - a.listedAt || a.ownerId.localeCompare(b.ownerId) || a.horseId.localeCompare(b.horseId));

export type StudFeeStatus = 'paid' | 'pending';

export class StudService {
  constructor(private readonly p: StudPlayers, private readonly dir: StudDirectory, private readonly browseLimit: () => number = () => 50) {}

  mine(u: string) { return this.p.view(u); }

  async list(u: string, horseId: string, visibility: StudVisibility, fee: number, dailyLimit: number) {
    const e = await this.p.list(u, horseId, visibility, fee, dailyLimit);
    await this.dir.put(e);
    return e;
  }

  async unlist(u: string, horseId: string) {
    const r = await this.p.unlist(u, horseId);
    await this.dir.remove(u, horseId);
    return r;
  }

  /** REQ-BREED-011: friends' stallions (any visibility) or public ones (never my own). */
  async browse(u: string, scope: 'friends' | 'public') {
    const limit = this.browseLimit();
    const rows = scope === 'friends' ? await this.dir.ofOwners(await this.p.friendIds(u)) : (await this.dir.publicList(limit + 1)).filter((e) => e.ownerId !== u);
    return { scope, listings: sortListings(rows).slice(0, limit) };
  }

  async preview(u: string, ownerId: string, horseId: string, damId: string) {
    if (ownerId === u) throw new AppError('NOT_ELIGIBLE', 'breed your own stallion from the normal breeding screen');
    return this.p.preview(u, await this.p.peek(ownerId, u, horseId), damId);
  }

  /**
   * REQ-BREED-012/013: one stud breeding. `clientKey` is the request's idempotency key, so a retried request
   * resumes the same op (reserve and apply return their first results; settle pays at most once).
   */
  async breed(u: string, ownerId: string, horseId: string, damId: string, clientKey: string, useMaterial: boolean): Promise<StudApplyResult & { feeStatus: StudFeeStatus }> {
    if (ownerId === u) throw new AppError('NOT_ELIGIBLE', 'breed your own stallion from the normal breeding screen');
    const opId = `stud:${u}:${clientKey}`;
    const snap = await this.p.reserve(ownerId, opId, u, horseId);
    let r: StudApplyResult;
    try {
      r = await this.p.apply(u, opId, snap, damId, useMaterial);
    } catch (e) {
      // compensation: give the lend back. If apply did commit after all (lost reply), its outbox pays the owner later.
      await this.p.settle(ownerId, opId, false, { borrowerId: u, horseId, fee: 0, foalId: null }).catch(() => undefined);
      throw e;
    }
    return { ...r, feeStatus: await settleOne(this.p, u, { opId, ownerId, horseId, fee: r.fee, foalId: r.foal.id }) };
  }
}

/** Owner settlement + borrower acknowledgement for one op; 'pending' leaves it in the borrower's outbox. */
export async function settleOne(p: Pick<StudPlayers, 'settle' | 'acked'>, borrowerId: string, o: { opId: string; ownerId: string; horseId: string; fee: number; foalId: string }): Promise<StudFeeStatus> {
  try {
    await p.settle(o.ownerId, o.opId, true, { borrowerId, horseId: o.horseId, fee: o.fee, foalId: o.foalId });
    await p.acked(borrowerId, o.opId);
    return 'paid';
  } catch {
    return 'pending';
  }
}

/** Borrower alarm: retry every due fee payment; failed ones back off. Returns how many were paid. */
export async function retryStudOutbox(
  p: Pick<StudPlayers, 'settle' | 'acked'> & { due(u: string): Promise<{ due: { opId: string; ownerId: string; horseId: string; fee: number; foalId: string }[] }>; later(u: string, opId: string): Promise<unknown> },
  borrowerId: string,
) {
  const { due } = await p.due(borrowerId);
  let paid = 0;
  for (const o of due) {
    if ((await settleOne(p, borrowerId, o)) === 'paid') paid++;
    else await p.later(borrowerId, o.opId);
  }
  return { attempted: due.length, paid };
}
