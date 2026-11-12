import { AppError } from '../domain/errors.js';
import { surveyWindowProblems, SURVEY_ID_RE, type LiveSurvey, type SurveyAnswers, type SurveyDef, type SurveySegment } from '../domain/surveys.js';

/**
 * The survey store (REQ-SURVEY-003/011/014..018, contracts/protocol.md §69.2/§69.5–69.7). Lives in the OpsDO singleton
 * (two more SQLite tables created with CREATE TABLE IF NOT EXISTS — no new Durable Object, no wrangler migration):
 *  - `surveys`: the definitions (draft → published window → ended), with an edit revision;
 *  - `survey_answers`: one row per (survey, player) — the de-duplication key — holding the cleaned answers, the analytics
 *    segment (null when the player's analytics choice was off) and the free texts ops hid. Results are counted on read.
 * Ops see free texts without player ids. A deleted account's rows are anonymised: the owner becomes `anon:<seq>`, the
 * segment and the free texts go, the choices and scale values stay in the counts.
 */
export type SurveyStatus = 'draft' | 'scheduled' | 'live' | 'ended';
export interface SurveyRecord {
  def: SurveyDef; rev: number;
  createdAt: number; createdBy: string; updatedAt: number; updatedBy: string;
  publishedAt: number | null; publishedBy: string | null; startAt: number | null; endAt: number | null; closedAt: number | null;
}
export interface SurveyAnswerRow {
  surveyId: string; seq: number; owner: string; at: number; rev: number; answers: SurveyAnswers; segment: SurveySegment | null; hidden: string[];
}
export interface SurveyRepo {
  get(id: string): SurveyRecord | null;
  put(r: SurveyRecord): void;
  list(): SurveyRecord[];
  answer(surveyId: string, owner: string): SurveyAnswerRow | null;
  /** Inserts (seq assigned by the repo); returns the stored row. */
  insertAnswer(r: Omit<SurveyAnswerRow, 'seq'>): SurveyAnswerRow;
  putAnswer(r: SurveyAnswerRow): void;
  answers(surveyId: string): SurveyAnswerRow[];
  answerBySeq(surveyId: string, seq: number): SurveyAnswerRow | null;
  count(surveyId: string): number;
  ofOwner(owner: string): SurveyAnswerRow[];
}

export const statusOf = (r: SurveyRecord, now: number): SurveyStatus => {
  if (r.publishedAt === null || r.startAt === null || r.endAt === null) return 'draft';
  const end = Math.min(r.endAt, r.closedAt ?? Infinity);
  if (now >= end) return 'ended';
  return now < r.startAt ? 'scheduled' : 'live';
};
/** The effective end (the window's end or an early close). */
const endOf = (r: SurveyRecord) => Math.min(r.endAt ?? Infinity, r.closedAt ?? Infinity);

export interface SurveyIngest { surveyId: string; playerId: string; rev: number; at: number; answers: SurveyAnswers; segment: SurveySegment | null }

const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n * 1000) / d) / 10);
/** CSV field: quoted, and a leading = + - @ (or tab / CR) defused so a spreadsheet never runs it as a formula. */
export function csvField(v: string): string {
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${s.replace(/"/g, '""')}"`;
}

export class SurveysCore {
  constructor(private readonly repo: SurveyRepo) {}

  private record(id: string): SurveyRecord {
    if (!SURVEY_ID_RE.test(id)) throw new AppError('NOT_FOUND', 'unknown survey');
    const r = this.repo.get(id);
    if (!r) throw new AppError('NOT_FOUND', 'unknown survey');
    return r;
  }
  private invalid(problems: string[]): never {
    throw new AppError('BAD_REQUEST', `invalid survey: ${problems.slice(0, 5).join('; ')}`, undefined, { problems });
  }

  /**
   * REQ-SURVEY-016: a new draft (its id must be new). The admin route has already checked `def` with surveyDefProblems
   * against the master in effect (remote config resolved) and normalised it; the store keeps it as given.
   */
  create(def: SurveyDef, by: string, now: number) {
    if (!SURVEY_ID_RE.test(def.id)) throw new AppError('BAD_REQUEST', 'bad survey id');
    if (this.repo.get(def.id)) throw new AppError('CONFLICT', `survey ${def.id} already exists`);
    const r: SurveyRecord = { def, rev: 1, createdAt: now, createdBy: by, updatedAt: now, updatedBy: by, publishedAt: null, publishedBy: null, startAt: null, endAt: null, closedAt: null };
    this.repo.put(r);
    return this.summary(r, now);
  }

  /** REQ-SURVEY-016: edit a draft (the caller sends the revision it edited; a newer one → 409). */
  update(id: string, def: SurveyDef, rev: number, by: string, now: number) {
    const r = this.record(id);
    if (statusOf(r, now) !== 'draft') throw new AppError('CONFLICT', 'a published survey cannot change (its answers would mean something else)');
    if (rev !== r.rev) throw new AppError('CONFLICT', `the survey changed (rev ${r.rev}); reload it`);
    if (def.id !== id) throw new AppError('BAD_REQUEST', 'the id cannot change');
    const next: SurveyRecord = { ...r, def, rev: r.rev + 1, updatedAt: now, updatedBy: by };
    this.repo.put(next);
    return this.summary(next, now);
  }

  /** REQ-SURVEY-003/016: publish a draft for a window (at most `maxLive` scheduled or live at once). */
  publish(id: string, startAt: number, endAt: number, maxLive: number, by: string, now: number) {
    const r = this.record(id);
    if (statusOf(r, now) !== 'draft') throw new AppError('CONFLICT', 'already published');
    const p = surveyWindowProblems(startAt, endAt, now);
    if (p.length) this.invalid(p);
    const busy = this.repo.list().filter((x) => { const s = statusOf(x, now); return s === 'live' || s === 'scheduled'; }).length;
    if (busy >= maxLive) throw new AppError('CONFLICT', `at most ${maxLive} surveys may be scheduled or live at once`);
    const next: SurveyRecord = { ...r, publishedAt: now, publishedBy: by, startAt, endAt, updatedAt: now, updatedBy: by };
    this.repo.put(next);
    return this.summary(next, now);
  }

  /** REQ-SURVEY-016: close early (a scheduled one ends before it starts). Idempotent for an ended survey. */
  close(id: string, by: string, now: number) {
    const r = this.record(id);
    const st = statusOf(r, now);
    if (st === 'draft') throw new AppError('CONFLICT', 'a draft is not published');
    if (st === 'ended') return this.summary(r, now);
    const next: SurveyRecord = { ...r, closedAt: now, updatedAt: now, updatedBy: by };
    this.repo.put(next);
    return this.summary(next, now);
  }

  summary(r: SurveyRecord, now: number) {
    return {
      id: r.def.id, title: r.def.title, status: statusOf(r, now), rev: r.rev, questions: r.def.questions.length, placements: r.def.placements,
      startAt: r.startAt, endAt: r.endAt, closedAt: r.closedAt, publishedAt: r.publishedAt, publishedBy: r.publishedBy,
      createdAt: r.createdAt, createdBy: r.createdBy, updatedAt: r.updatedAt, updatedBy: r.updatedBy, answers: this.repo.count(r.def.id),
    };
  }
  list(now: number) {
    const order: Record<SurveyStatus, number> = { live: 0, scheduled: 1, draft: 2, ended: 3 };
    return this.repo.list().map((r) => this.summary(r, now)).sort((a, b) => order[a.status] - order[b.status] || b.updatedAt - a.updatedAt);
  }
  get(id: string, now: number) { const r = this.record(id); return { ...this.summary(r, now), def: r.def }; }

  /** The player routes' view: live surveys (and scheduled ones, so a cache sees the start) with the effective end. */
  live(now: number): LiveSurvey[] {
    return this.repo.list().filter((r) => { const s = statusOf(r, now); return s === 'live' || s === 'scheduled'; })
      .map((r) => ({ def: r.def, rev: r.rev, startAt: r.startAt!, endAt: endOf(r) }));
  }
  /** One survey as the player routes see it, whatever its status (null = unknown or draft). */
  one(id: string): LiveSurvey | null {
    if (!SURVEY_ID_RE.test(id)) return null;
    const r = this.repo.get(id);
    if (!r || r.publishedAt === null || r.startAt === null) return null;
    return { def: r.def, rev: r.rev, startAt: r.startAt, endAt: endOf(r) };
  }

  /** REQ-SURVEY-011: one row per (survey, player); a second write of the same answer is a no-op. */
  recordAnswer(x: SurveyIngest): { stored: boolean } {
    if (!this.repo.get(x.surveyId)) throw new AppError('NOT_FOUND', 'unknown survey');
    if (this.repo.answer(x.surveyId, x.playerId)) return { stored: false };
    this.repo.insertAnswer({ surveyId: x.surveyId, owner: x.playerId, at: x.at, rev: x.rev, answers: x.answers, segment: x.segment, hidden: [] });
    return { stored: true };
  }
  ingest(xs: SurveyIngest[]) {
    let stored = 0;
    for (const x of xs) {
      try { if (this.recordAnswer(x).stored) stored++; } catch (e) { if (!(e instanceof AppError && e.code === 'NOT_FOUND')) throw e; } // a deleted survey: drop
    }
    return { stored, received: xs.length };
  }

  /** REQ-SURVEY-017/018: counts, percentages, scale averages, free texts (no player ids). */
  results(id: string, now: number) {
    const r = this.record(id);
    const rows = this.repo.answers(id);
    const segmented = rows.filter((x) => x.segment !== null);
    const platforms: Record<string, number> = { ios: 0, android: 0, editor: 0, unknown: 0 };
    for (const x of segmented) platforms[x.segment!.platform] = (platforms[x.segment!.platform] ?? 0) + 1;
    const classes: Record<string, number> = {};
    for (const x of segmented) classes[x.segment!.classId] = (classes[x.segment!.classId] ?? 0) + 1;
    const questions = r.def.questions.map((q) => {
      const vals = rows.map((x) => ({ row: x, v: x.answers[q.id] })).filter((x) => x.v !== undefined);
      const base = { id: q.id, kind: q.kind, required: q.required, text: q.text, answered: vals.length, skipped: rows.length - vals.length };
      if (q.kind === 'single' || q.kind === 'multi') {
        const counts = new Map<string, number>((q.options ?? []).map((o) => [o.id, 0]));
        for (const { v } of vals) for (const o of Array.isArray(v) ? v : [v]) if (counts.has(String(o))) counts.set(String(o), counts.get(String(o))! + 1);
        return { ...base, options: (q.options ?? []).map((o) => ({ id: o.id, text: o.text, count: counts.get(o.id)!, pct: pct(counts.get(o.id)!, vals.length) })) };
      }
      if (q.kind === 'scale') {
        const counts = [0, 0, 0, 0, 0];
        let sum = 0;
        for (const { v } of vals) { counts[(v as number) - 1]! += 1; sum += v as number; }
        return { ...base, labels: q.labels, scale: { counts, pct: counts.map((c) => pct(c, vals.length)), average: vals.length ? Math.round((sum / vals.length) * 100) / 100 : null } };
      }
      const texts = vals.map(({ row, v }) => ({ ref: `${row.seq}.${q.id}`, text: String(v), at: row.at, hidden: row.hidden.includes(q.id) }))
        .sort((a, b) => b.at - a.at);
      return { ...base, texts };
    });
    return { survey: this.summary(r, now), total: rows.length, segmented: segmented.length, unsegmented: rows.length - segmented.length, platforms, classes, questions };
  }

  /** REQ-SURVEY-017: one line per answer, no player ids, hidden texts as (hidden). */
  csv(id: string, now: number) {
    const r = this.record(id);
    const qs = r.def.questions;
    const head = ['answer', 'at', 'platform', 'class', ...qs.map((q) => q.id)];
    const lines = [head.map(csvField).join(',')];
    for (const x of this.repo.answers(id).sort((a, b) => a.seq - b.seq)) {
      const cells = [String(x.seq), new Date(x.at).toISOString(), x.segment?.platform ?? '', x.segment?.classId ?? '', ...qs.map((q) => {
        const v = x.answers[q.id];
        if (v === undefined) return '';
        if (q.kind === 'text' && x.hidden.includes(q.id)) return '(hidden)';
        return Array.isArray(v) ? v.join('|') : String(v);
      })];
      lines.push(cells.map(csvField).join(','));
    }
    return { filename: `${id}-${new Date(now).toISOString().slice(0, 10)}.csv`, csv: lines.join('\r\n') + '\r\n', rows: lines.length - 1 };
  }

  /** REQ-SURVEY-018: hide / show one free text (`<seq>.<questionId>`). */
  hideText(id: string, ref: string, hidden: boolean) {
    const r = this.record(id);
    const m = /^([0-9]{1,9})\.([a-z][a-z0-9_]{0,23})$/.exec(ref);
    const q = m ? r.def.questions.find((x) => x.id === m[2] && x.kind === 'text') : undefined;
    const row = m && q ? this.repo.answerBySeq(id, Number(m[1])) : null;
    if (!m || !q || !row || row.answers[q.id] === undefined) throw new AppError('NOT_FOUND', 'unknown text');
    const set = new Set(row.hidden);
    if (hidden) set.add(q.id); else set.delete(q.id);
    this.repo.putAnswer({ ...row, hidden: [...set] });
    return { ref, hidden };
  }

  /** REQ-SURVEY-014: a deleted account — rows anonymised, segment and free texts removed (choices stay in the counts). */
  forgetPlayer(playerId: string) {
    const rows = this.repo.ofOwner(playerId);
    for (const x of rows) {
      const texts = new Set(this.repo.get(x.surveyId)?.def.questions.filter((q) => q.kind === 'text').map((q) => q.id) ?? []);
      const answers = Object.fromEntries(Object.entries(x.answers).filter(([k]) => !texts.has(k)));
      this.repo.putAnswer({ ...x, owner: `anon:${x.seq}`, segment: null, answers, hidden: [] });
    }
    return { anonymised: rows.length };
  }
}

/** In-memory repo (tests, the prototype and local tooling). */
export class MemorySurveyRepo implements SurveyRepo {
  private defs = new Map<string, SurveyRecord>();
  private rows = new Map<string, SurveyAnswerRow>();
  private seq = 0;
  private k = (s: string, o: string) => `${s}\u0000${o}`;
  get(id: string) { const r = this.defs.get(id); return r ? structuredClone(r) : null; }
  put(r: SurveyRecord) { this.defs.set(r.def.id, structuredClone(r)); }
  list() { return [...this.defs.values()].map((r) => structuredClone(r)); }
  answer(s: string, o: string) { const r = this.rows.get(this.k(s, o)); return r ? structuredClone(r) : null; }
  insertAnswer(r: Omit<SurveyAnswerRow, 'seq'>) { const row = { ...structuredClone(r), seq: ++this.seq }; this.rows.set(this.k(r.surveyId, r.owner), row); return structuredClone(row); }
  putAnswer(r: SurveyAnswerRow) {
    for (const [k, x] of this.rows) if (x.surveyId === r.surveyId && x.seq === r.seq) this.rows.delete(k);
    this.rows.set(this.k(r.surveyId, r.owner), structuredClone(r));
  }
  answers(s: string) { return [...this.rows.values()].filter((r) => r.surveyId === s).map((r) => structuredClone(r)); }
  answerBySeq(s: string, seq: number) { const r = [...this.rows.values()].find((x) => x.surveyId === s && x.seq === seq); return r ? structuredClone(r) : null; }
  count(s: string) { return [...this.rows.values()].filter((r) => r.surveyId === s).length; }
  ofOwner(o: string) { return [...this.rows.values()].filter((r) => r.owner === o).map((r) => structuredClone(r)); }
}

/**
 * REQ-SURVEY-003: the player routes read the live definitions at most once per SURVEY_CACHE_MS per Worker isolate (like the
 * remote config, §22). An admin write through the same isolate drops the copy at once; other isolates see it within 30 s.
 */
export const SURVEY_CACHE_MS = 30_000;
const liveCache = new WeakMap<object, { at: number; live: LiveSurvey[] }>();
export async function liveSurveysCached(api: { live(now: number): Promise<LiveSurvey[]> }, now: number): Promise<LiveSurvey[]> {
  const c = liveCache.get(api);
  if (c && now - c.at < SURVEY_CACHE_MS && now >= c.at) return c.live;
  try {
    const live = await api.live(now);
    liveCache.set(api, { at: now, live });
    return live;
  } catch (e) {
    console.error('surveys unavailable', (e as Error).message);
    return c?.live ?? []; // the game never waits on a survey
  }
}
export function invalidateSurveyCache(api: object) { liveCache.delete(api); }
