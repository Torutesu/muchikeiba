/**
 * POST /v1/reports orchestration (REQ-RPT-001..009, contracts/protocol.md §47.4). Order, so that nothing is counted or
 * stored for a report that cannot be made:
 *   1. shape and note (400), not about yourself;
 *   2. the snapshot from the TARGET's object (404 for an unknown / deleted player or missing content);
 *   3. a `race` report: the reporter must have been in that race — the race room answers and puts the replay on hold
 *      (the same check as POST /v1/race/:raceId/report);
 *   4. the reporter's object: daily limits, the optional block and the report_submit KPI row, in one transaction;
 *   5. the ops queue (collapses duplicates; the answer never says whether it did).
 */
import { z } from 'zod';
import { AppError } from './errors.js';
import type { Master } from './master.js';
import type { PlayerInvoker } from '../http/app.js';
import type { PlayerReportsApi } from '../http/admin.js';
import {
  checkReportShape, reportContentSchema, reportsConfig, REPORT_CATEGORIES, REPORT_SOURCES, validateNote, type ReportCategory, type ReportContent, type ReportSource,
} from './reports.js';

export const reportBodySchema = z.object({
  targetId: z.string().min(1).max(128),
  category: z.enum(REPORT_CATEGORIES),
  source: z.enum(REPORT_SOURCES),
  content: reportContentSchema,
  note: z.string().max(1000).nullable().optional(),
  alsoBlock: z.boolean().optional(),
}).strict();
export type ReportBody = { targetId: string; category: ReportCategory; source: ReportSource; content: ReportContent; note?: string | null; alsoBlock?: boolean };

export class ReportsService {
  constructor(
    private readonly master: () => Master,
    private readonly player: (uid: string) => PlayerInvoker,
    private readonly queue: () => PlayerReportsApi | undefined,
    private readonly raceReport: (raceId: string, playerId: string) => Promise<unknown>,
    private readonly clock: () => number = Date.now,
    /** Round 18 integration (§52): the branch's copy of a quick chat phrase. Absent → `qchat` reports answer NOT_FOUND. */
    private readonly qchatCopy?: (reporter: string, teamId: string, seq: number) => Promise<{ playerId: string; phraseId: string; at: number; text: string; slots: { name: string; value: string }[] }>,
  ) {}

  async submit(u: string, b: ReportBody) {
    const m = this.master();
    const cfg = reportsConfig(m);
    const q = this.queue();
    if (!cfg.enabled || !q) throw new AppError('NOT_FOUND', 'reports are not available');
    checkReportShape(b.category, b.content);
    const note = validateNote(m, b.note);
    if (b.targetId === u) throw new AppError('BAD_REQUEST', 'you cannot report yourself');
    let snapshot = await this.player(b.targetId).invoke('reportSnapshot', b.targetId, b.content);
    if (b.content.kind === 'qchat') {
      // §47 × §52: the phrase as the branch showed it, copied from the TeamDO (only from the reporter's own branch)
      const [teamId, seqText] = b.content.feedRef!.split(':') as [string, string];
      if (!this.qchatCopy) throw new AppError('NOT_FOUND', 'no such phrase');
      const q = await this.qchatCopy(u, teamId, Number(seqText));
      if (q.playerId !== b.targetId) throw new AppError('NOT_FOUND', 'no such phrase');
      snapshot = { ...snapshot, text: q.text, qchat: { teamId, seq: Number(seqText), phraseId: q.phraseId, slots: q.slots, postedAt: q.at } };
    }
    if (b.content.kind === 'race') {
      const r = (await this.raceReport(b.content.raceId!, u)) as { ok?: boolean } | null;
      if (!r?.ok) throw new AppError('NOT_ELIGIBLE', 'you can only report a race you were in');
    }
    const mine = await this.player(u).invoke('reportCommit', u, b.targetId, b.category, b.content.kind, b.source, b.alsoBlock === true);
    await q.submit({ reporterId: u, targetId: b.targetId, category: b.category, source: b.source, content: b.content, snapshot, note }, this.clock(), cfg);
    return { received: true as const, blocked: mine.blocked, remainingToday: mine.remainingToday };
  }
}
