import { AppError } from '../domain/errors.js';
import { DAY_MS } from '../domain/time.js';
import {
  contentRef, reporterWeight, type ReportCategory, type ReportContent, type ReportContentKind, type ReportSnapshot, type ReportSource,
  type ReporterStats, type ReportsConfig,
} from '../domain/reports.js';
import { foldForCompare } from '../domain/horses.js';
import type { PlayerReportMade } from '../domain/dataExport.js';

/**
 * The player-report review queue (REQ-RPT-007/013/014/016, contracts/protocol.md §47.7–47.8). Lives in the singleton
 * IntegrityDO next to the race reports (SQLite tables created on first use: no new Durable Object class, no migration).
 *
 * - Collapse: one OPEN report per (target, content kind, content ref, folded snapshot text). A new reporter joins it
 *   (count + weight), the same reporter again changes nothing.
 * - Score = the sum of the reporters' weights at the time they reported (permille). It orders the queue; nothing here
 *   ever hides or punishes anyone by itself.
 * - Reporter stats (dismissed / actioned) feed the weight; reviewed at resolution time.
 * - Reporter ids are ops-only data: no player API reads this store.
 */
export type PlayerReportStatus = 'open' | 'resolved';
export const REPORT_ACTIONS = ['dismiss', 'warn', 'rename', 'hide', 'ban'] as const;
export type ReportAction = typeof REPORT_ACTIONS[number];
/** The anonymised reporter id after the reporter's account deletion (REQ-RPT-016). */
export const DELETED_REPORTER = 'deleted';

export interface ReportEntry { reporterId: string; at: number; weight: number; category: ReportCategory; source: ReportSource; note: string | null }
export interface PlayerReport {
  id: string; key: string; status: PlayerReportStatus;
  targetId: string; targetDeleted: boolean;
  /** The first category (the queue's filter); every category with its count is in `categories`. */
  category: ReportCategory;
  categories: Partial<Record<ReportCategory, number>>;
  content: { kind: ReportContentKind; ref: string | null };
  snapshot: ReportSnapshot;
  reporters: ReportEntry[];
  count: number; score: number; firstAt: number; lastAt: number;
  resolution: { action: ReportAction; by: string; at: number; note: string } | null;
}

export interface PlayerReportFilter { status?: PlayerReportStatus; category?: ReportCategory; kind?: ReportContentKind; targetId?: string; limit: number }

export interface PlayerReportRepo {
  get(id: string): PlayerReport | null;
  put(r: PlayerReport): void;
  openByKey(key: string): PlayerReport | null;
  list(f: PlayerReportFilter): PlayerReport[];
  byReporter(reporterId: string): PlayerReport[];
  byTarget(targetId: string): PlayerReport[];
  /** Resolved reports decided before `before` (oldest first, at most `limit`). */
  resolvedBefore(before: number, limit: number): PlayerReport[];
  remove(id: string): void;
  stats(reporterId: string): ReporterStats | null;
  putStats(s: ReporterStats): void;
  removeStats(reporterId: string): void;
  nextSeq(): number;
}

export interface SubmitInput {
  reporterId: string; targetId: string; category: ReportCategory; source: ReportSource;
  content: ReportContent; snapshot: ReportSnapshot; note: string | null;
}
export type SubmitOutcome = 'new' | 'collapsed' | 'duplicate';

/** Purged per submission (keeps the work per call small). */
const PURGE_BATCH = 20;

export function reportKey(targetId: string, content: ReportContent, snapshot: ReportSnapshot): string {
  return [targetId, content.kind, contentRef(content) ?? '', foldForCompare(snapshot.text ?? '')].join('|');
}

export class PlayerReportsCore {
  constructor(private readonly repo: PlayerReportRepo) {}

  /** REQ-RPT-007/014: store or collapse; also purges a few resolved reports past `resolvedKeepDays` (REQ-RPT-016). */
  submit(x: SubmitInput, now: number, c: ReportsConfig): { report: PlayerReport; outcome: SubmitOutcome } {
    for (const old of this.repo.resolvedBefore(now - c.resolvedKeepDays * DAY_MS, PURGE_BATCH)) this.repo.remove(old.id);
    const key = reportKey(x.targetId, x.content, x.snapshot);
    const st = this.repo.stats(x.reporterId);
    const weight = reporterWeight(c, st);
    const entry: ReportEntry = { reporterId: x.reporterId, at: now, weight, category: x.category, source: x.source, note: x.note };
    const open = this.repo.openByKey(key);
    if (open?.reporters.some((e) => e.reporterId === x.reporterId)) return { report: open, outcome: 'duplicate' };
    this.repo.putStats({ reporterId: x.reporterId, submitted: (st?.submitted ?? 0) + 1, dismissed: st?.dismissed ?? 0, actioned: st?.actioned ?? 0, updatedAt: now });
    if (open) {
      open.reporters.push(entry);
      open.count += 1;
      open.score += weight;
      open.categories[x.category] = (open.categories[x.category] ?? 0) + 1;
      open.lastAt = now;
      this.repo.put(open);
      return { report: open, outcome: 'collapsed' };
    }
    const r: PlayerReport = {
      id: `prp_${this.repo.nextSeq()}`, key, status: 'open', targetId: x.targetId, targetDeleted: false,
      category: x.category, categories: { [x.category]: 1 }, content: { kind: x.content.kind, ref: contentRef(x.content) },
      snapshot: { ...x.snapshot }, reporters: [entry], count: 1, score: weight, firstAt: now, lastAt: now, resolution: null,
    };
    this.repo.put(r);
    return { report: r, outcome: 'new' };
  }

  list(f: PlayerReportFilter) {
    return this.repo.list({ ...f, limit: Math.max(1, Math.min(500, f.limit)) }).map((r) => ({
      id: r.id, status: r.status, targetId: r.targetId, targetDeleted: r.targetDeleted, category: r.category, categories: r.categories,
      content: r.content, snapshot: r.snapshot, count: r.count, score: r.score, firstAt: r.firstAt, lastAt: r.lastAt, resolution: r.resolution,
    }));
  }

  /** The detail view: every reporter with weight and note, plus their current weight (ops only). */
  get(id: string, c: ReportsConfig) {
    const r = this.repo.get(id);
    if (!r) throw new AppError('NOT_FOUND', `report ${id}`);
    return { ...r, reporters: r.reporters.map((e) => ({ ...e, currentWeight: e.reporterId === DELETED_REPORTER ? null : reporterWeight(c, this.repo.stats(e.reporterId)) })) };
  }

  /** Checks an action may run on this report (before its side effect runs). */
  assertActionable(id: string, action: ReportAction): PlayerReport {
    const r = this.repo.get(id);
    if (!r) throw new AppError('NOT_FOUND', `report ${id}`);
    if (r.status !== 'open') throw new AppError('CONFLICT', 'the report is already resolved');
    if (r.targetDeleted && (action === 'warn' || action === 'rename' || action === 'hide')) throw new AppError('CONFLICT', 'the reported player deleted the account');
    return r;
  }

  /** REQ-RPT-013/014: closes the report once; every (non-anonymised) reporter's dismissed / actioned count moves. */
  resolve(id: string, action: ReportAction, by: string, note: string, now: number): PlayerReport {
    const r = this.assertActionable(id, 'dismiss'); // the action's own check ran before its side effect
    r.status = 'resolved';
    r.resolution = { action, by, at: now, note };
    this.repo.put(r);
    for (const e of r.reporters) {
      if (e.reporterId === DELETED_REPORTER) continue;
      const st = this.repo.stats(e.reporterId) ?? { reporterId: e.reporterId, submitted: 0, dismissed: 0, actioned: 0, updatedAt: now };
      if (action === 'dismiss') st.dismissed += 1;
      else st.actioned += 1;
      st.updatedAt = now;
      this.repo.putStats(st);
    }
    return r;
  }

  /**
   * REQ-RPT-016 (account deletion, idempotent): reports BY the player keep their entry with the reporter replaced by
   * `deleted` and the note dropped; the reporter stats go. Reports ABOUT the player are kept and marked `targetDeleted`.
   */
  /**
   * REQ-DEX-007 (Round 18 integration): the reports this player made, for their data export — what, why, from where, their
   * own note and whether support has looked at it. Never the reported player's id, the snapshot or the decision note.
   */
  madeBy(uid: string): PlayerReportMade[] {
    return this.repo.byReporter(uid).flatMap((r) => r.reporters.filter((e) => e.reporterId === uid).map((e) => ({
      at: e.at, category: e.category, source: e.source, contentKind: r.content.kind, note: e.note, status: r.status,
    }))).sort((a, b) => a.at - b.at);
  }
  forgetPlayer(uid: string) {
    let anonymised = 0;
    let marked = 0;
    for (const r of this.repo.byReporter(uid)) {
      r.reporters = r.reporters.map((e) => (e.reporterId === uid ? { ...e, reporterId: DELETED_REPORTER, note: null } : e));
      this.repo.put(r);
      anonymised += 1;
    }
    for (const r of this.repo.byTarget(uid)) {
      if (r.targetDeleted) continue;
      r.targetDeleted = true;
      this.repo.put(r);
      marked += 1;
    }
    this.repo.removeStats(uid);
    return { anonymised, marked };
  }
}

const matches = (r: PlayerReport, f: PlayerReportFilter) =>
  (!f.status || r.status === f.status) && (!f.category || r.categories[f.category] !== undefined) && (!f.kind || r.content.kind === f.kind) && (!f.targetId || r.targetId === f.targetId);
/** Open: highest score first, then newest; resolved: newest decision first. */
export const queueOrder = (a: PlayerReport, b: PlayerReport) =>
  a.status !== b.status ? (a.status === 'open' ? -1 : 1)
    : a.status === 'open' ? b.score - a.score || b.lastAt - a.lastAt
      : (b.resolution?.at ?? 0) - (a.resolution?.at ?? 0);

export class MemoryPlayerReportRepo implements PlayerReportRepo {
  rs = new Map<string, PlayerReport>();
  st = new Map<string, ReporterStats>();
  seq = 0;
  get(id: string) { const r = this.rs.get(id); return r ? structuredClone(r) : null; }
  put(r: PlayerReport) { this.rs.set(r.id, structuredClone(r)); }
  openByKey(key: string) { const r = [...this.rs.values()].find((x) => x.key === key && x.status === 'open'); return r ? structuredClone(r) : null; }
  list(f: PlayerReportFilter) { return [...this.rs.values()].filter((r) => matches(r, f)).sort(queueOrder).slice(0, f.limit).map((r) => structuredClone(r)); }
  byReporter(id: string) { return [...this.rs.values()].filter((r) => r.reporters.some((e) => e.reporterId === id)).map((r) => structuredClone(r)); }
  byTarget(id: string) { return [...this.rs.values()].filter((r) => r.targetId === id).map((r) => structuredClone(r)); }
  resolvedBefore(t: number, limit: number) {
    return [...this.rs.values()].filter((r) => r.status === 'resolved' && (r.resolution?.at ?? 0) < t).sort((a, b) => (a.resolution?.at ?? 0) - (b.resolution?.at ?? 0)).slice(0, limit).map((r) => structuredClone(r));
  }
  remove(id: string) { this.rs.delete(id); }
  stats(id: string) { const s = this.st.get(id); return s ? { ...s } : null; }
  putStats(s: ReporterStats) { this.st.set(s.reporterId, { ...s }); }
  removeStats(id: string) { this.st.delete(id); }
  nextSeq() { return ++this.seq; }
}
