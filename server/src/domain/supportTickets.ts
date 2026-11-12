/**
 * お問い合わせの状況確認 (support tickets & replies) — REQ-TKT-001..020, contracts/protocol.md §73.
 *
 * The §48 inquiries become a thread: five statuses (received / in_progress / answered / resolved / closed), player
 * replies (keyed, rate limited, reopening a resolved or recently closed ticket), an auto-close clock, a retention period,
 * operator status changes and links to existing compensation requests (§22 — nothing is granted here). Tickets stay in
 * the player's state (`help.tickets`); the assignee and internal notes live in the OpsDO (ops/inquiries.ts) and never
 * reach the player or the §51 export.
 *
 * Pure functions on master + state; PlayerService runs them inside its transaction. help.ts owns the ticket type and the
 * §48 functions; this module only uses them at call time (no module-level use, so the import cycle is harmless).
 */
import { AppError } from './errors.js';
import type { Master } from './master.js';
import type { PlayerState } from './player.js';
import type { KpiEvent } from './kpi.js';
import type { Locale } from '../i18n/locale.js';
import { SECRET_SCRUB_RULES } from './clientErrors.js';
import { dayRule, gameDayKey, gameDayStartMs, addJstDays } from './time.js';
import {
  BASE_HELP, INQUIRY_CATEGORY_TEXT, ensureHelp, fillTokens, helpOf, pick, redactPersonal, ticketOf, tokenProblems, tokensOf, wordingProblems,
  type HelpMaster, type InquiryStatus, type InquiryTicket, type Loc, type TokenEnv,
} from './help.js';

export const DAY_MS = 86_400_000;

// ------------------------------------------------------------------------------------------------ config (§73.2)

export interface TicketConfig {
  playerReplyMax: number; repliesPerDay: number; replyIntervalSec: number; messagesMax: number;
  autoCloseDays: number; reopenDays: number; retentionDays: number; slaHours: number;
  noteMax: number; notesMax: number; compensationMax: number; pushOnReply: boolean;
}
export const TICKET_DEFAULTS: TicketConfig = {
  playerReplyMax: 1000, repliesPerDay: 10, replyIntervalSec: 30, messagesMax: 40,
  autoCloseDays: 7, reopenDays: 14, retentionDays: 365, slaHours: 48,
  noteMax: 1000, notesMax: 50, compensationMax: 5, pushOnReply: true,
};
export const TICKET_LIMITS: Record<Exclude<keyof TicketConfig, 'pushOnReply'>, readonly [number, number]> = {
  playerReplyMax: [100, 4000], repliesPerDay: [1, 50], replyIntervalSec: [0, 3600], messagesMax: [10, 200],
  autoCloseDays: [1, 60], reopenDays: [0, 90], retentionDays: [30, 1095], slaHours: [1, 336],
  noteMax: [100, 4000], notesMax: [1, 200], compensationMax: [1, 20],
};
export const REPLY_TEMPLATES_MAX = 20;
export interface ReplyTemplate { id: string; title: Loc; body: Loc }

export const ticketsOf = (h: Pick<HelpMaster, 'config'> = BASE_HELP): TicketConfig => ({ ...TICKET_DEFAULTS, ...(h.config?.tickets ?? {}) });

/** The two ticket placeholders of a reply template (filled before the §48 tokens). */
const TICKET_PLACEHOLDERS = /\{\{(ticket_id|category)\}\}/g;

/** REQ-TKT-002: everything wrong with `help.config.tickets` and `help.replyTemplates` (helpProblems appends these). */
export function ticketProblems(env: TokenEnv, h: HelpMaster): string[] {
  const out: string[] = [];
  const t = h.config?.tickets;
  if (t !== undefined) {
    if (!t || typeof t !== 'object') out.push('help.config.tickets must be an object');
    else {
      for (const k of Object.keys(t)) if (!(k in TICKET_DEFAULTS)) out.push(`help.config.tickets.${k}: unknown key`);
      for (const [k, [lo, hi]] of Object.entries(TICKET_LIMITS)) {
        const v = (t as Record<string, unknown>)[k];
        if (v !== undefined && (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi)) out.push(`help.config.tickets.${k} must be an integer ${lo}..${hi}`);
      }
      if (t.pushOnReply !== undefined && typeof t.pushOnReply !== 'boolean') out.push('help.config.tickets.pushOnReply must be a boolean');
    }
  }
  const ts = h.replyTemplates;
  if (ts === undefined) return out;
  if (!Array.isArray(ts) || ts.length > REPLY_TEMPLATES_MAX) return [...out, `help.replyTemplates: up to ${REPLY_TEMPLATES_MAX} templates`];
  const ids = new Set<string>();
  const max = h.config?.inquiry?.replyMax ?? 2000;
  ts.forEach((x, i) => {
    const at = `help.replyTemplates[${i}]${x?.id ? ` ${x.id}` : ''}`;
    if (typeof x?.id !== 'string' || !/^[a-z0-9_]{2,40}$/.test(x.id)) { out.push(`${at}: bad id`); return; }
    if (ids.has(x.id)) out.push(`${at}: duplicate id`);
    ids.add(x.id);
    const ok = (l: unknown): l is Loc => !!l && typeof (l as Loc).ja === 'string' && typeof (l as Loc).en === 'string' && !!(l as Loc).ja.trim() && !!(l as Loc).en.trim();
    if (!ok(x.title) || !ok(x.body)) { out.push(`${at}: title and body need ja and en`); return; }
    for (const lang of ['ja', 'en'] as const) {
      if ([...x.title[lang]].length > 40) out.push(`${at}.title.${lang}: 1..40 characters`);
      if ([...x.body[lang]].length > max) out.push(`${at}.body.${lang}: 1..${max} characters`);
      out.push(...tokenProblems(env, `${at}.body.${lang}`, x.body[lang].replace(TICKET_PLACEHOLDERS, '')));
    }
    if (/[぀-ヿ㐀-鿿]/.test(x.title.en + x.body.en)) out.push(`${at}.en contains Japanese`);
    const tk = (s: string) => [...tokensOf(s.replace(TICKET_PLACEHOLDERS, '')), ...[...s.matchAll(TICKET_PLACEHOLDERS)].map((mt) => mt[0]).sort()].join();
    if (tk(x.body.ja) !== tk(x.body.en)) out.push(`${at}: ja and en carry different tokens`);
    out.push(...wordingProblems(at, `${x.title.ja}\n${x.body.ja}`, `${x.title.en}\n${x.body.en}`));
  });
  return out;
}

/** REQ-TKT-009: the templates in the ticket's language with the placeholders and §48 tokens filled. */
export function replyTemplatesFor(m: Master, ticketId: string, category: InquiryTicket['category'], lang: Locale, maxWhips = 6) {
  const h = helpOf(m);
  const env: TokenEnv = { m, maxWhips };
  return {
    lang,
    items: (h.replyTemplates ?? BASE_HELP.replyTemplates ?? []).map((x) => ({
      id: x.id, title: pick(x.title, lang),
      body: fillTokens(env, pick(x.body, lang).replace(TICKET_PLACEHOLDERS, (_, k: string) => (k === 'ticket_id' ? ticketId : pick(INQUIRY_CATEGORY_TEXT[category], lang)))),
    })),
  };
}

// ------------------------------------------------------------------------------------------------ status clocks (§73.1)

export const TICKET_STATUSES: readonly InquiryStatus[] = ['received', 'in_progress', 'answered', 'resolved', 'closed'];
/** Waiting for support. */
export const isOpenStatus = (s: InquiryStatus) => s === 'received' || s === 'in_progress';

/** When an answered / resolved ticket closes by itself (null for other statuses). */
export function autoCloseAtOf(t: Pick<InquiryTicket, 'status' | 'updatedAt' | 'autoCloseFrom'>, c: TicketConfig): number | null {
  return t.status === 'answered' || t.status === 'resolved' ? (t.autoCloseFrom ?? t.updatedAt) + c.autoCloseDays * DAY_MS : null;
}
/** The last moment a closed ticket can be reopened by a player reply (null unless closed). */
export function replyUntilOf(t: Pick<InquiryTicket, 'status' | 'updatedAt' | 'closedAt'>, c: TicketConfig): number | null {
  return t.status === 'closed' ? (t.closedAt ?? t.updatedAt) + c.reopenDays * DAY_MS : null;
}
export function canReplyNow(t: InquiryTicket, c: TicketConfig, now: number): boolean {
  if (t.status === 'closed') return now < replyUntilOf(t, c)!;
  return t.messages.length < c.messagesMax;
}

// ------------------------------------------------------------------------------------------------ text (§73.3)

/** Secrets in a person's words: a value after a password word, the query of a URL (tokens hide there), §60's secret rules. */
const PASSWORD_RE = /(?<![A-Za-z])(パスワード|暗証番号|password|passcode|passwd|pw)(\s*(?:は|が|:|：|=|＝)\s*)([^\s、。,]+)/gi;
const URL_QUERY_RE = /(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g;
const REDACTED = '［削除しました］';

/** REQ-TKT-003: §48's personal data replacement + secrets, keeping the text readable for support. */
export function scrubTicketText(text: string): { text: string; n: number } {
  const p = redactPersonal(text);
  let n = p.n;
  let out = p.text.replace(PASSWORD_RE, (_, w: string, sep: string) => { n++; return `${w}${sep}${REDACTED}`; });
  out = out.replace(URL_QUERY_RE, (_, base: string) => { n++; return base; });
  for (const [re, to] of SECRET_SCRUB_RULES) out = out.replace(re, () => { n++; return to; });
  return { text: out, n };
}

const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

// ------------------------------------------------------------------------------------------------ settle (§73.1)

const helpOfState = (s: PlayerState) => (s as PlayerState & { help?: { tickets: InquiryTicket[] } }).help;

/** True when a read must run settleTickets in a transaction (an auto-close or a purge is due). */
export function needsSettle(m: Master, s: PlayerState, now: number): boolean {
  const c = ticketsOf(helpOf(m));
  return (helpOfState(s)?.tickets ?? []).some((t) => {
    const ac = autoCloseAtOf(t, c);
    if (ac !== null && now >= ac) return true;
    return t.status === 'closed' && now >= (t.closedAt ?? t.updatedAt) + c.retentionDays * DAY_MS;
  });
}

/**
 * REQ-TKT-001: answered / resolved tickets without a player reply for autoCloseDays close (closedAt = the due time), and
 * closed tickets older than retentionDays leave the state. Returns the ids that closed and that were removed.
 */
export function settleTickets(m: Master, s: PlayerState, now: number, emit?: (e: KpiEvent) => void) {
  const st = helpOfState(s);
  const closed: string[] = [], removed: string[] = [];
  if (!st) return { closed, removed };
  const c = ticketsOf(helpOf(m));
  for (const t of st.tickets) {
    const ac = autoCloseAtOf(t, c);
    if (ac === null || now < ac) continue;
    t.status = 'closed';
    t.closedAt = ac;
    t.autoCloseFrom = null;
    t.updatedAt = Math.max(now, t.updatedAt + 1);
    t.indexed = false;
    closed.push(t.id);
    emit?.({ name: 'ticket_resolved', s1: t.category, s2: 'auto_closed', durationMs: ac - t.createdAt });
  }
  st.tickets = st.tickets.filter((t) => {
    const gone = t.status === 'closed' && now >= (t.closedAt ?? t.updatedAt) + c.retentionDays * DAY_MS;
    if (gone) removed.push(t.id);
    return !gone;
  });
  return { closed, removed };
}

// ------------------------------------------------------------------------------------------------ player reply (§73.4)

/** REQ-TKT-004: the player's reply (keyed; the same key returns the stored reply's ticket). Returns the ticket id. */
export function playerReply(m: Master, s: PlayerState, ticketId: string, content: string, key: string, now: number, emit?: (e: KpiEvent) => void): string {
  const st = ensureHelp(s);
  const t = ticketOf(s, ticketId);
  if ((t.playerKeys ?? []).includes(key)) return t.id;
  if (s.deletion?.status === 'deleting') throw new AppError('FORBIDDEN', 'account deletion in progress');
  const c = ticketsOf(helpOf(m));
  const raw = content.trim();
  const len = [...raw].length;
  if (len < 1 || len > c.playerReplyMax) throw new AppError('BAD_REQUEST', `content must be 1..${c.playerReplyMax} characters`);
  if (CONTROL.test(raw.replace(/\n/g, ''))) throw new AppError('BAD_REQUEST', 'content has control characters');
  if (t.status === 'closed' && now >= replyUntilOf(t, c)!) throw new AppError('CONFLICT', 'the inquiry is closed; send a new one', undefined, { reason: 'closed' });
  if (t.messages.length >= c.messagesMax) throw new AppError('CONFLICT', `up to ${c.messagesMax} messages in one inquiry; send a new one`, undefined, { reason: 'full' });
  const last = [...t.messages].reverse().find((x) => x.from === 'player')?.at ?? (t.messages.length === 0 ? t.createdAt : 0);
  if (c.replyIntervalSec > 0 && last > 0 && now < last + c.replyIntervalSec * 1000) {
    throw new AppError('RATE_LIMITED', `wait ${c.replyIntervalSec} seconds between messages`, undefined, { reason: 'interval', retryAt: last + c.replyIntervalSec * 1000 });
  }
  const rule = dayRule(m);
  const day = gameDayKey(now, rule);
  if (st.replyDay !== day) { st.replyDay = day; st.repliesToday = 0; }
  if ((st.repliesToday ?? 0) >= c.repliesPerDay) throw new AppError('RATE_LIMITED', `up to ${c.repliesPerDay} messages a day`, undefined, { reason: 'day', retryAt: gameDayStartMs(addJstDays(day, 1), rule) });
  st.repliesToday = (st.repliesToday ?? 0) + 1;
  const red = scrubTicketText(raw);
  const before = t.status;
  t.messages.push({ from: 'player', content: red.text, at: now });
  t.redacted += red.n;
  t.playerKeys = [...(t.playerKeys ?? []), key].slice(-50);
  t.lastPlayerAt = now;
  if (before === 'answered' || before === 'resolved' || before === 'closed') {
    t.status = 'received';
    t.autoCloseFrom = null;
    t.closedAt = null;
    if (before !== 'answered') {
      t.reopens = (t.reopens ?? 0) + 1;
      emit?.({ name: 'ticket_reopen', s1: t.category, s2: before });
    }
  }
  t.updatedAt = now;
  t.indexed = false;
  emit?.({ name: 'ticket_player_reply', s1: t.category, s2: before, value: red.n });
  return t.id;
}

// ------------------------------------------------------------------------------------------------ operator actions (§73.6)

export type OpStatus = 'in_progress' | 'resolved' | 'closed';
export const OP_STATUSES: readonly OpStatus[] = ['in_progress', 'resolved', 'closed'];

/** REQ-TKT-009: an operator sets a status (once per opKey). A closed ticket does not change. */
export function setTicketStatus(m: Master, s: PlayerState, ticketId: string, status: OpStatus, opKey: string, now: number, emit?: (e: KpiEvent) => void) {
  const t = ticketOf(s, ticketId);
  if ((t.statusKeys ?? []).includes(opKey)) return { ticketId: t.id, status: t.status, duplicate: true };
  if (!OP_STATUSES.includes(status)) throw new AppError('BAD_REQUEST', `status must be one of ${OP_STATUSES.join('|')}`);
  if (t.status === 'closed') throw new AppError('CONFLICT', 'inquiry is closed');
  t.statusKeys = [...(t.statusKeys ?? []), opKey].slice(-50);
  if (t.status !== status) {
    t.status = status;
    t.autoCloseFrom = status === 'resolved' ? now : null;
    t.closedAt = status === 'closed' ? now : null;
    if (status === 'in_progress') t.lastPlayerAt ??= t.createdAt;
    t.updatedAt = now;
    t.indexed = false;
    if (status !== 'in_progress') emit?.({ name: 'ticket_resolved', s1: t.category, s2: status, durationMs: now - t.createdAt });
  }
  void m;
  return { ticketId: t.id, status: t.status, duplicate: false };
}

/** REQ-TKT-010: link an existing compensation request id (validated by the caller against the OpsDO). Idempotent. */
export function linkCompensation(m: Master, s: PlayerState, ticketId: string, ref: string, now: number) {
  const t = ticketOf(s, ticketId);
  const c = ticketsOf(helpOf(m));
  const list = t.compensation ?? [];
  if (!list.some((x) => x.ref === ref)) {
    if (list.length >= c.compensationMax) throw new AppError('CONFLICT', `up to ${c.compensationMax} compensations per inquiry`);
    t.compensation = [...list, { ref, at: now }];
    t.updatedAt = now;
    t.indexed = false;
  }
  return { ticketId: t.id, compensation: (t.compensation ?? []).map((x) => ({ ...x })) };
}
