import { AppError } from '../domain/errors.js';
import { INQUIRY_CATEGORIES, type InquiryCategory, type InquiryStatus, type InquirySummary } from '../domain/help.js';

/**
 * REQ-HELP-016: the ops index of player inquiries (contracts/protocol.md §48.7). One row per ticket with ids, category,
 * status, language, the number of attached rows and the times — never the text (support opens a ticket from the player's
 * own object, and that read is audited). Upserts are idempotent and never go back to an older version of a ticket.
 */
export interface InquiryQuery { status?: InquiryStatus; category?: InquiryCategory; limit?: number }
export interface InquiryIndexRepo {
  get(playerId: string, ticketId: string): InquirySummary | null;
  put(r: InquirySummary): void;
  list(q: InquiryQuery): InquirySummary[];
  removePlayer(playerId: string): number;
}
export const INQUIRY_STATUSES: InquiryStatus[] = ['received', 'answered', 'closed'];
export const INQUIRY_LIST_MAX = 200;

const valid = (r: InquirySummary) =>
  typeof r.playerId === 'string' && r.playerId.length > 0 && r.playerId.length <= 128 && /^q_[0-9]{1,9}$/.test(r.ticketId)
  && (INQUIRY_CATEGORIES as readonly string[]).includes(r.category) && INQUIRY_STATUSES.includes(r.status) && (r.lang === 'ja' || r.lang === 'en')
  && Number.isInteger(r.attachments) && Number.isInteger(r.createdAt) && Number.isInteger(r.updatedAt);

export class InquiryIndex {
  constructor(private readonly repo: InquiryIndexRepo) {}

  /** Stores the newer of the stored and the given version of each ticket (returns how many were written or already current). */
  upsert(items: InquirySummary[]): { stored: number } {
    let stored = 0;
    for (const r of items) {
      if (!valid(r)) throw new AppError('BAD_REQUEST', 'bad inquiry summary');
      const prev = this.repo.get(r.playerId, r.ticketId);
      if (!prev || prev.updatedAt <= r.updatedAt) this.repo.put({ ...r });
      stored++;
    }
    return { stored };
  }

  list(q: InquiryQuery): InquirySummary[] {
    const limit = Math.min(Math.max(1, q.limit ?? 100), INQUIRY_LIST_MAX);
    return this.repo.list({ ...q, limit });
  }

  /** REQ-HELP-018: a deleted account's rows leave the index. */
  forgetPlayer(playerId: string): { removed: number } { return { removed: this.repo.removePlayer(playerId) }; }
}

export class MemoryInquiryIndexRepo implements InquiryIndexRepo {
  private rows = new Map<string, InquirySummary>();
  private k = (p: string, t: string) => `${p}\u0000${t}`;
  get(p: string, t: string) { return this.rows.get(this.k(p, t)) ?? null; }
  put(r: InquirySummary) { this.rows.set(this.k(r.playerId, r.ticketId), r); }
  list(q: InquiryQuery) {
    return [...this.rows.values()]
      .filter((r) => (!q.status || r.status === q.status) && (!q.category || r.category === q.category))
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
      .slice(0, q.limit ?? 100);
  }
  removePlayer(p: string) {
    let n = 0;
    for (const [k, r] of this.rows) if (r.playerId === p) { this.rows.delete(k); n++; }
    return n;
  }
}
