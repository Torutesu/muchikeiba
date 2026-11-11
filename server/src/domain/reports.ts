/**
 * 通報 (report a player) — REQ-RPT-001..009/014..017, contracts/protocol.md §47.
 *
 * A report goes to the ops review queue (ops/playerReports.ts) and nowhere else: no count of reports hides or punishes
 * anyone by itself (the same rule as race reports, REQ-OPS-034), and the reported player never learns who reported them
 * (nothing here is ever part of a player-facing view of the target).
 *
 * This file holds the pure rules: the categories and what each may be about, the note check, the reporter's daily
 * limits (on the reporter's own state), the snapshot taken from the target's state (the server copies the reported text
 * when the report arrives, never the text the device sent) and the reporter weight used to order the queue.
 */
import { z } from 'zod';
import { AppError } from './errors.js';
import type { Master } from './master.js';
import type { PlayerState } from './player.js';
import { deletionScheduled } from './accountDeletion.js';
import { dayRule, gameDayKey } from './time.js';

export const REPORT_CATEGORIES = ['name', 'text', 'cheating', 'harassment', 'other'] as const;
export type ReportCategory = typeof REPORT_CATEGORIES[number];
export const REPORT_SOURCES = ['profile', 'friends', 'team_feed', 'stable', 'hall', 'replay', 'photo', 'cup_lobby'] as const;
export type ReportSource = typeof REPORT_SOURCES[number];
export const REPORT_CONTENT_KINDS = ['player', 'display_name', 'horse_name', 'stable_name', 'replay_title', 'photo_caption', 'race'] as const;
export type ReportContentKind = typeof REPORT_CONTENT_KINDS[number];

/** protocol §47.4: which content each category may be about (anything else is 400). */
export const CATEGORY_KINDS: Record<ReportCategory, readonly ReportContentKind[]> = {
  name: ['display_name', 'horse_name', 'stable_name'],
  text: ['replay_title', 'photo_caption'],
  cheating: ['race'],
  harassment: REPORT_CONTENT_KINDS,
  other: REPORT_CONTENT_KINDS,
};
/** Labels of the report sheet (server-built; English at the response boundary, i18n/en.ts). */
export const REPORT_CATEGORY_LABELS: Record<ReportCategory, string> = {
  name: '不適切な名前',
  text: '不適切なキャプション・文',
  cheating: '不正の疑い',
  harassment: '嫌がらせ',
  other: 'その他',
};

export interface ReportContent { kind: ReportContentKind; horseId?: string; raceId?: string; photoId?: string }
const refRe = /^[A-Za-z0-9_:.-]{1,128}$/;
export const reportContentSchema = z.object({
  kind: z.enum(REPORT_CONTENT_KINDS),
  horseId: z.string().min(1).max(40).regex(refRe).optional(),
  raceId: z.string().min(1).max(128).regex(refRe).optional(),
  photoId: z.string().min(1).max(40).regex(refRe).optional(),
}).strict();

/** The key each content kind needs (protocol §47.4). */
export const CONTENT_REF: Record<ReportContentKind, 'horseId' | 'raceId' | 'photoId' | null> = {
  player: null, display_name: null, stable_name: null, horse_name: 'horseId', replay_title: 'raceId', photo_caption: 'photoId', race: 'raceId',
};
export const contentRef = (c: ReportContent): string | null => {
  const k = CONTENT_REF[c.kind];
  return k ? c[k] ?? null : null;
};

/** REQ-RPT-015: `progression.reports` (absent → REPORTS_DEFAULTS). */
export interface ReportsConfig {
  enabled: boolean;
  perDay: number;
  perTargetPerDay: number;
  noteMaxChars: number;
  /** Reviewed reports a reporter needs before their weight can drop. */
  minResolved: number;
  lowSharePermille: number;
  lowWeight: number;
  veryLowSharePermille: number;
  veryLowWeight: number;
  /** Resolved reports are purged this many days after the decision. */
  resolvedKeepDays: number;
}
export const REPORTS_DEFAULTS: ReportsConfig = {
  enabled: true, perDay: 10, perTargetPerDay: 2, noteMaxChars: 100,
  minResolved: 5, lowSharePermille: 500, lowWeight: 500, veryLowSharePermille: 800, veryLowWeight: 250, resolvedKeepDays: 365,
};
export const FULL_WEIGHT = 1000;

export function reportsConfig(m: Pick<Master, 'progression'>): ReportsConfig {
  return { ...REPORTS_DEFAULTS, ...((m.progression as { reports?: Partial<ReportsConfig> }).reports ?? {}) };
}

/** REQ-RPT-015: boot and remote-config validation. */
export function reportsProblems(m: Pick<Master, 'progression'>, path = 'progression.reports'): string[] {
  const raw = (m.progression as { reports?: unknown }).reports;
  if (raw === undefined) return [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [`${path} must be an object`];
  const out: string[] = [];
  for (const k of Object.keys(raw)) if (!(k in REPORTS_DEFAULTS) && !k.startsWith('_')) out.push(`${path}.${k} is unknown`);
  const c = reportsConfig(m);
  if (typeof c.enabled !== 'boolean') out.push(`${path}.enabled must be true or false`);
  const int = (k: keyof ReportsConfig, lo: number, hi: number) => {
    const v = c[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) out.push(`${path}.${k} must be an integer ${lo}..${hi}`);
  };
  int('perDay', 1, 50);
  int('perTargetPerDay', 1, Number.isInteger(c.perDay) ? c.perDay : 1);
  int('noteMaxChars', 0, 200);
  int('minResolved', 1, 100);
  int('veryLowSharePermille', 1, 1000);
  int('lowSharePermille', 1, Number.isInteger(c.veryLowSharePermille) ? c.veryLowSharePermille : 1000);
  int('lowWeight', 1, FULL_WEIGHT);
  int('veryLowWeight', 1, Number.isInteger(c.lowWeight) ? c.lowWeight : FULL_WEIGHT);
  int('resolvedKeepDays', 30, 3650);
  return out;
}

/** REQ-RPT-002: the category / content pair and the key the content needs. */
export function checkReportShape(category: ReportCategory, content: ReportContent) {
  if (!CATEGORY_KINDS[category].includes(content.kind)) throw new AppError('BAD_REQUEST', `a ${category} report cannot be about ${content.kind}`);
  const need = CONTENT_REF[content.kind];
  for (const k of ['horseId', 'raceId', 'photoId'] as const) {
    if (k === need && !content[k]) throw new AppError('BAD_REQUEST', `content.${k} is required for ${content.kind}`);
    if (k !== need && content[k] !== undefined) throw new AppError('BAD_REQUEST', `content.${k} does not belong to ${content.kind}`);
  }
}

/** REQ-RPT-003: the optional note — length and control characters only; never NG-checked or translated (ops read it). */
export function validateNote(m: Pick<Master, 'progression'>, raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const t = raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (t === '') return null;
  const max = reportsConfig(m).noteMaxChars;
  if ([...t].length > max) throw new AppError('BAD_REQUEST', max === 0 ? 'notes are off' : `the note is at most ${max} characters`);
  if (/\p{C}/u.test(t)) throw new AppError('BAD_REQUEST', 'control characters in the note');
  return t;
}

// ------------------------------------------------------------------------------------------- reporter side

export interface ReporterState { day: string; count: number; perTarget: Record<string, number> }
const peek = (s: PlayerState) => (s as PlayerState & { reports?: ReporterState }).reports;
function rolled(s: PlayerState, day: string): ReporterState {
  const x = s as PlayerState & { reports?: ReporterState };
  if (!x.reports || x.reports.day !== day) x.reports = { day, count: 0, perTarget: {} };
  return x.reports;
}

export function remainingToday(m: Master, s: PlayerState, now: number): number {
  const c = reportsConfig(m);
  const r = peek(s);
  const used = r && r.day === gameDayKey(now, dayRule(m)) ? r.count : 0;
  return Math.max(0, c.perDay - used);
}

const enabledOrThrow = (m: Pick<Master, 'progression'>) => { if (!reportsConfig(m).enabled) throw new AppError('NOT_FOUND', 'reports are not available'); };

/** REQ-RPT-006: the reporter's checks; counts the report on the reporter's state (game day, 04:00 JST). */
export function takeReportAllowance(m: Master, s: PlayerState, target: string, now: number) {
  enabledOrThrow(m);
  if (target === s.id) throw new AppError('BAD_REQUEST', 'you cannot report yourself');
  if (deletionScheduled(s)) throw new AppError('DELETION_PENDING', 'the account is scheduled for deletion');
  const c = reportsConfig(m);
  const r = rolled(s, gameDayKey(now, dayRule(m)));
  if (r.count >= c.perDay) throw new AppError('RATE_LIMITED', `at most ${c.perDay} reports a day`);
  if ((r.perTarget[target] ?? 0) >= c.perTargetPerDay) throw new AppError('RATE_LIMITED', `at most ${c.perTargetPerDay} reports a day about the same player`);
  r.count += 1;
  r.perTarget[target] = (r.perTarget[target] ?? 0) + 1;
  return { remainingToday: Math.max(0, c.perDay - r.count) };
}

/** REQ-RPT-001/002: GET /v1/reports/options (the sheet's categories, the note limit and today's allowance). */
export function reportOptions(m: Master, s: PlayerState, now: number) {
  const c = reportsConfig(m);
  return {
    enabled: c.enabled,
    categories: REPORT_CATEGORIES.map((id) => ({ id, label: REPORT_CATEGORY_LABELS[id], kinds: [...CATEGORY_KINDS[id]] })),
    noteMaxChars: c.noteMaxChars,
    remainingToday: c.enabled ? remainingToday(m, s, now) : 0,
  };
}

// ------------------------------------------------------------------------------------------- target side

export interface ReportSnapshot { displayName: string; text: string | null; raceId: string | null; takenAt: number }

/**
 * REQ-RPT-004: what was reported, copied from the TARGET's state when the report arrives. Content that is not there
 * (or not visible to other players: a private replay) is NOT_FOUND, the same answer as an unknown player.
 */
export function reportSnapshotOf(s: PlayerState, content: ReportContent, now: number): ReportSnapshot {
  const base = { displayName: s.profile.displayName, raceId: null as string | null, takenAt: now };
  switch (content.kind) {
    case 'player':
    case 'display_name':
      return { ...base, text: s.profile.displayName };
    case 'horse_name': {
      const h = s.horses.find((x) => x.id === content.horseId);
      if (!h) throw new AppError('NOT_FOUND', 'no such horse');
      return { ...base, text: h.name };
    }
    case 'stable_name': {
      const name = (s as PlayerState & { stable?: { layout?: { name: string | null } } }).stable?.layout?.name ?? null;
      if (!name) throw new AppError('NOT_FOUND', 'no stable name');
      return { ...base, text: name };
    }
    case 'replay_title': {
      const r = s.myReplays?.saved.find((x) => x.raceId === content.raceId);
      if (!r || !r.public || !r.replayTitle) throw new AppError('NOT_FOUND', 'no such replay');
      return { ...base, text: r.replayTitle, raceId: r.raceId };
    }
    case 'photo_caption': {
      const p = s.photos?.records.find((x) => x.id === content.photoId);
      if (!p || !p.caption) throw new AppError('NOT_FOUND', 'no such photo');
      return { ...base, text: p.caption, raceId: p.source.raceId };
    }
    case 'race':
      return { ...base, text: null, raceId: content.raceId ?? null };
  }
}

// ------------------------------------------------------------------------------------------- reporter weight

export interface ReporterStats { reporterId: string; submitted: number; dismissed: number; actioned: number; updatedAt: number }

/**
 * REQ-RPT-014: the reporter's weight (permille) — simple and explainable. Once `minResolved` of their reports were
 * reviewed, a dismissed share ≥ veryLowSharePermille gives veryLowWeight, ≥ lowSharePermille gives lowWeight, else full.
 * The weight only orders the queue; a report is never dropped and a high score never acts on its own.
 */
export function reporterWeight(c: ReportsConfig, st: ReporterStats | null): number {
  if (!st) return FULL_WEIGHT;
  const reviewed = st.dismissed + st.actioned;
  if (reviewed < c.minResolved) return FULL_WEIGHT;
  const share = Math.floor((st.dismissed * 1000) / reviewed);
  if (share >= c.veryLowSharePermille) return c.veryLowWeight;
  if (share >= c.lowSharePermille) return c.lowWeight;
  return FULL_WEIGHT;
}
