import { AppError } from '../domain/errors.js';
import { INQUIRY_CATEGORIES, type InquiryCategory, type InquiryStatus, type InquirySummary } from '../domain/help.js';
import { DAY_MS, TICKET_DEFAULTS, TICKET_STATUSES, isOpenStatus } from '../domain/supportTickets.js';

/**
 * REQ-HELP-016: the ops index of player inquiries (contracts/protocol.md §48.7). One row per ticket with ids, category,
 * status, language, the number of attached rows and the times — never the text (support opens a ticket from the player's
 * own object, and that read is audited). Upserts are idempotent and never go back to an older version of a ticket.
 *
 * Round 23 (§73.6, REQ-TKT-006..009): the queue computes the auto-close from the row's clocks, filters by language,
 * assignee and waiting time, shows the SLA age, exports CSV without text, and keeps the support desk's own data — the
 * assignee and internal notes — next to the index (never in the player's state: they are not shown to the player and are
 * not part of the §51 export). Closed rows past the retention period leave with their desk data when the queue is read.
 */
export type InquiryStatusFilter = InquiryStatus | 'open';
export interface InquiryQuery {
  status?: InquiryStatusFilter; category?: InquiryCategory; limit?: number;
  // §73.6
  lang?: 'ja' | 'en'; assignee?: string | null; minAgeMs?: number; now?: number; slaHours?: number; retentionDays?: number;
}
export interface InquiryNote { by: string; at: number; text: string }
export interface InquiryDesk { assignee: string | null; notes: InquiryNote[] }
/** A queue row: the summary with the computed status, the assignee and the waiting clock. */
export interface InquiryQueueRow extends InquirySummary { assignee: string | null; waitingMs: number | null; slaBreached: boolean }

export interface InquiryIndexRepo {
  get(playerId: string, ticketId: string): InquirySummary | null;
  put(r: InquirySummary): void;
  list(q: InquiryQuery): InquirySummary[];
  removePlayer(playerId: string): number;
  // §73.6 (the desk)
  all(): InquirySummary[];
  removeTicket(playerId: string, ticketId: string): void;
  assignee(playerId: string, ticketId: string): string | null;
  assignees(): Map<string, string>;
  setAssignee(playerId: string, ticketId: string, assignee: string | null, at: number): void;
  notes(playerId: string, ticketId: string): (InquiryNote & { opKey: string })[];
  addNote(playerId: string, ticketId: string, n: InquiryNote & { opKey: string }): void;
}
export const INQUIRY_STATUSES: InquiryStatus[] = [...TICKET_STATUSES];
export const INQUIRY_STATUS_FILTERS: InquiryStatusFilter[] = [...TICKET_STATUSES, 'open'];
export const INQUIRY_LIST_MAX = 200;
export const INQUIRY_EXPORT_MAX = 2000;

const optNum = (v: unknown) => v === undefined || v === null || Number.isInteger(v);
const valid = (r: InquirySummary) =>
  typeof r.playerId === 'string' && r.playerId.length > 0 && r.playerId.length <= 128 && /^q_[0-9]{1,9}$/.test(r.ticketId)
  && (INQUIRY_CATEGORIES as readonly string[]).includes(r.category) && INQUIRY_STATUSES.includes(r.status) && (r.lang === 'ja' || r.lang === 'en')
  && Number.isInteger(r.attachments) && Number.isInteger(r.createdAt) && Number.isInteger(r.updatedAt)
  && optNum(r.firstReplyAt) && optNum(r.autoCloseAt) && optNum(r.closedAt) && optNum(r.waitingSince);
const key = (p: string, t: string) => `${p}\u0000${t}`;

/** §73.1: the row as the queue shows it at `now` (an auto-close that is due reads as closed). */
export function effectiveRow(r: InquirySummary, now: number): InquirySummary {
  if (r.autoCloseAt !== undefined && r.autoCloseAt !== null && now >= r.autoCloseAt && (r.status === 'answered' || r.status === 'resolved')) {
    return { ...r, status: 'closed', closedAt: r.autoCloseAt, autoCloseAt: null };
  }
  return r;
}
const waitingOf = (r: InquirySummary, now: number) => (isOpenStatus(r.status) ? now - (r.waitingSince ?? r.updatedAt) : null);

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

  /** REQ-HELP-016 / REQ-TKT-006: the queue (computed status, filters, waiting clock); purges rows past the retention. */
  list(q: InquiryQuery, max = INQUIRY_LIST_MAX): InquiryQueueRow[] {
    const limit = Math.min(Math.max(1, q.limit ?? 100), max);
    if (q.now === undefined) {
      // the §48 form (no clock): stored rows, stored status
      return this.repo.list({ ...q, limit }).map((r) => ({ ...r, assignee: this.repo.assignee(r.playerId, r.ticketId), waitingMs: null, slaBreached: false }));
    }
    const now = q.now;
    const keepMs = (q.retentionDays ?? TICKET_DEFAULTS.retentionDays) * DAY_MS;
    const slaMs = (q.slaHours ?? TICKET_DEFAULTS.slaHours) * 3_600_000;
    const who = this.repo.assignees();
    const rows: InquiryQueueRow[] = [];
    for (const raw of this.repo.all()) {
      const r = effectiveRow(raw, now);
      if (r.status === 'closed' && now >= (r.closedAt ?? r.updatedAt) + keepMs) { this.repo.removeTicket(r.playerId, r.ticketId); continue; }
      const assignee = who.get(key(r.playerId, r.ticketId)) ?? null;
      const waitingMs = waitingOf(r, now);
      if (q.status === 'open' ? !isOpenStatus(r.status) : q.status && r.status !== q.status) continue;
      if (q.category && r.category !== q.category) continue;
      if (q.lang && r.lang !== q.lang) continue;
      if (q.assignee !== undefined && assignee !== q.assignee) continue;
      if (q.minAgeMs !== undefined && (waitingMs === null || waitingMs < q.minAgeMs)) continue;
      rows.push({ ...r, assignee, waitingMs, slaBreached: waitingMs !== null && waitingMs >= slaMs });
    }
    // waiting tickets: the longest wait first; the rest: newest first
    rows.sort((a, b) => (a.waitingMs !== null && b.waitingMs !== null ? b.waitingMs - a.waitingMs : a.waitingMs !== null ? -1 : b.waitingMs !== null ? 1 : b.updatedAt - a.updatedAt || b.createdAt - a.createdAt));
    return rows.slice(0, limit);
  }

  /** REQ-TKT-007: CSV of the queue — ids, category, status, language, counts, times, assignee, waiting hours; never any text. */
  exportCsv(q: InquiryQuery): { csv: string; rows: number } {
    const rows = this.list({ ...q, limit: INQUIRY_EXPORT_MAX }, INQUIRY_EXPORT_MAX);
    const iso = (t: number | null | undefined) => (t === null || t === undefined ? '' : new Date(t).toISOString());
    const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const head = 'ticket_id,player_id,category,status,lang,attachments,created_at,updated_at,first_reply_at,closed_at,assignee,waiting_hours,sla_breached';
    const lines = rows.map((r) => [r.ticketId, r.playerId, r.category, r.status, r.lang, String(r.attachments), iso(r.createdAt), iso(r.updatedAt), iso(r.firstReplyAt), iso(r.closedAt),
      r.assignee ?? '', r.waitingMs === null ? '' : (r.waitingMs / 3_600_000).toFixed(1), r.slaBreached ? '1' : '0'].map(cell).join(','));
    return { csv: [head, ...lines].join('\n') + '\n', rows: rows.length };
  }

  /** REQ-TKT-008: the desk data of one ticket (operators only). */
  desk(playerId: string, ticketId: string): InquiryDesk {
    return { assignee: this.repo.assignee(playerId, ticketId), notes: this.repo.notes(playerId, ticketId).map(({ by, at, text }) => ({ by, at, text })) };
  }
  assign(playerId: string, ticketId: string, assignee: string | null, now: number): InquiryDesk {
    if (assignee !== null && !/^[A-Za-z0-9_.@:-]{1,64}$/.test(assignee)) throw new AppError('BAD_REQUEST', 'bad assignee');
    this.repo.setAssignee(playerId, ticketId, assignee, now);
    return this.desk(playerId, ticketId);
  }
  /** An internal note (once per opKey; at most `max` per ticket). The text was scrubbed by the caller. */
  addNote(playerId: string, ticketId: string, n: InquiryNote & { opKey: string }, max: number): InquiryDesk & { duplicate: boolean } {
    const prev = this.repo.notes(playerId, ticketId);
    if (prev.some((x) => x.opKey === n.opKey)) return { ...this.desk(playerId, ticketId), duplicate: true };
    if (prev.length >= max) throw new AppError('CONFLICT', `up to ${max} notes per inquiry`);
    this.repo.addNote(playerId, ticketId, n);
    return { ...this.desk(playerId, ticketId), duplicate: false };
  }

  /** REQ-HELP-018: a deleted account's rows (and §73 desk data) leave the index. */
  forgetPlayer(playerId: string): { removed: number } { return { removed: this.repo.removePlayer(playerId) }; }
}

export class MemoryInquiryIndexRepo implements InquiryIndexRepo {
  private rows = new Map<string, InquirySummary>();
  private who = new Map<string, string>();
  private noteRows = new Map<string, (InquiryNote & { opKey: string })[]>();
  get(p: string, t: string) { return this.rows.get(key(p, t)) ?? null; }
  put(r: InquirySummary) { this.rows.set(key(r.playerId, r.ticketId), r); }
  list(q: InquiryQuery) {
    return [...this.rows.values()]
      .filter((r) => (!q.status || (q.status === 'open' ? isOpenStatus(r.status) : r.status === q.status)) && (!q.category || r.category === q.category))
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
      .slice(0, q.limit ?? 100);
  }
  all() { return [...this.rows.values()]; }
  removeTicket(p: string, t: string) { const k = key(p, t); this.rows.delete(k); this.who.delete(k); this.noteRows.delete(k); }
  removePlayer(p: string) {
    let n = 0;
    for (const [k, r] of this.rows) if (r.playerId === p) { this.rows.delete(k); n++; }
    for (const k of [...this.who.keys(), ...this.noteRows.keys()]) if (k.startsWith(`${p}\u0000`)) { this.who.delete(k); this.noteRows.delete(k); }
    return n;
  }
  assignee(p: string, t: string) { return this.who.get(key(p, t)) ?? null; }
  assignees() { return new Map(this.who); }
  setAssignee(p: string, t: string, a: string | null) { if (a === null) this.who.delete(key(p, t)); else this.who.set(key(p, t), a); }
  notes(p: string, t: string) { return [...(this.noteRows.get(key(p, t)) ?? [])]; }
  addNote(p: string, t: string, n: InquiryNote & { opKey: string }) { this.noteRows.set(key(p, t), [...this.notes(p, t), n]); }
}
