/**
 * REQ-REV-001..016: レビュー依頼のタイミング (in-app store review prompt, contracts/protocol.md §59).
 *
 * The app asks for an App Store / Google Play rating only through the OS's own in-app review API, and only at a happy
 * moment (first win, first tournament title, hall induction, a horse's goal chain complete). Never right after a loss, a
 * purchase, an error, a refund or a maintenance notice, never during the FTUE, never twice in one session, at most
 * `maxPerYear` (≤ 3, Apple's own limit) per 365 days with a cool-down. The rules are data (progression.reviewPrompt,
 * validated at boot and for every remote-config version) and the decision is a pure function over a small summary
 * (decideReviewPrompt; C# ReviewPromptPolicy.Decide agrees through contracts/review-prompt.vectors.json).
 *
 * NOTHING is granted for a review (Apple 5.6.1, Google Play's incentivised-ratings policy): no coins, items, XP, titles or
 * mission progress. The server never learns whether a review was written (the OS does not say) and there is no route that
 * could reward one. Rule keys such as `reward` / `coins` fail validation (unknown keys).
 */
import { AppError } from './errors.js';
import type { Master } from './master.js';
import type { PlayerState } from './player.js';
import type { KpiEvent } from './kpi.js';
import { deletionScheduled } from './accountDeletion.js';
import { visibleWindows } from './maintenance.js';

// ------------------------------------------------------------------------------------------- rules (data)

export const REVIEW_VERSION = 1 as const;
export const REVIEW_MOMENTS = ['first_win', 'first_tournament_win', 'hall_induction', 'horse_goal_chain'] as const;
export type ReviewMoment = (typeof REVIEW_MOMENTS)[number];
export const REVIEW_PLATFORMS = ['ios', 'android', 'editor'] as const;
export type ReviewPlatform = (typeof REVIEW_PLATFORMS)[number];
export const REVIEW_QUIET_KEYS = ['loss', 'purchase', 'refund', 'error', 'maintenanceNotice'] as const;
export type ReviewQuietKey = (typeof REVIEW_QUIET_KEYS)[number];
/** Decision order (protocol §59.3): the first reason that applies wins. */
export const REVIEW_REASONS = [
  'disabled', 'moment', 'account_closing', 'ftue', 'session', 'maintenance', 'refund', 'purchase', 'error', 'loss',
  'too_new', 'too_few_races', 'year_cap', 'cool_down',
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];
export const REVIEW_STEPS = ['soft_yes', 'soft_no', 'soft_dismiss', 'native_requested'] as const;
export type ReviewStep = (typeof REVIEW_STEPS)[number];

export interface ReviewPromptRules {
  enabled: boolean;
  moments: ReviewMoment[];
  minDaysSinceInstall: number;
  minRacesPlayed: number;
  /** Prompts per 365 days (1..3 — Apple shows at most 3 a year anyway). */
  maxPerYear: number;
  coolDownDays: number;
  quietMinutes: Record<ReviewQuietKey, number>;
  /** The optional pre-question (§59.6). Default off; android can never be on (Google Play guideline). */
  softAsk: { ios: boolean; android: boolean };
}

/** Used when the master has no section (never prompts: the feature is opt-in data). */
export const REVIEW_RULES_OFF: ReviewPromptRules = {
  enabled: false, moments: [], minDaysSinceInstall: 3, minRacesPlayed: 10, maxPerYear: 3, coolDownDays: 120,
  quietMinutes: { loss: 30, purchase: 1440, refund: 43200, error: 30, maintenanceNotice: 60 }, softAsk: { ios: false, android: false },
};

export function reviewRulesOf(m: Pick<Master, 'progression'>): ReviewPromptRules {
  const c = (m.progression as { reviewPrompt?: ReviewPromptRules & { _note?: string } }).reviewPrompt;
  if (!c) return REVIEW_RULES_OFF;
  const { _note, ...rules } = c as ReviewPromptRules & { _note?: string };
  void _note;
  return rules;
}

const RULE_KEYS = ['enabled', 'moments', 'minDaysSinceInstall', 'minRacesPlayed', 'maxPerYear', 'coolDownDays', 'quietMinutes', 'softAsk', '_note'];
const REWARD_WORDS = /reward|coin|item|grant|gift|xp|bonus/i;

/** REQ-REV-002/008/009: boot and every remote-config version. */
export function reviewPromptProblems(m: Pick<Master, 'progression'>): string[] {
  const raw = (m.progression as { reviewPrompt?: unknown }).reviewPrompt;
  if (raw === undefined) return [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return ['reviewPrompt must be an object'];
  const c = raw as Record<string, unknown>;
  const p: string[] = [];
  const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  for (const k of Object.keys(c)) {
    if (RULE_KEYS.includes(k)) continue;
    p.push(REWARD_WORDS.test(k)
      ? `reviewPrompt.${k}: reviews are never rewarded (App Store 5.6.1 / Google Play policy)`
      : `reviewPrompt.${k} is not a known key`);
  }
  if (typeof c.enabled !== 'boolean') p.push('reviewPrompt.enabled must be a boolean');
  if (!Array.isArray(c.moments)) p.push('reviewPrompt.moments must be an array');
  else {
    for (const x of c.moments) if (!(REVIEW_MOMENTS as readonly unknown[]).includes(x)) p.push(`reviewPrompt.moments: unknown moment ${String(x)}`);
    if (new Set(c.moments).size !== c.moments.length) p.push('reviewPrompt.moments: duplicates');
    if (c.enabled === true && c.moments.length === 0) p.push('reviewPrompt.moments: at least one moment when enabled');
  }
  if (!int(c.minDaysSinceInstall, 0, 365)) p.push('reviewPrompt.minDaysSinceInstall must be an integer 0..365');
  if (!int(c.minRacesPlayed, 0, 1000)) p.push('reviewPrompt.minRacesPlayed must be an integer 0..1000');
  if (!int(c.maxPerYear, 1, 3)) p.push('reviewPrompt.maxPerYear must be an integer 1..3 (Apple shows at most 3 a year)');
  if (!int(c.coolDownDays, 30, 365)) p.push('reviewPrompt.coolDownDays must be an integer 30..365');
  const q = c.quietMinutes as Record<string, unknown> | undefined;
  if (typeof q !== 'object' || q === null || Array.isArray(q)) p.push('reviewPrompt.quietMinutes must be an object');
  else {
    for (const k of REVIEW_QUIET_KEYS) if (!int(q[k], 0, 525_600)) p.push(`reviewPrompt.quietMinutes.${k} must be an integer 0..525600`);
    for (const k of Object.keys(q)) if (!(REVIEW_QUIET_KEYS as readonly string[]).includes(k)) p.push(`reviewPrompt.quietMinutes.${k} is not a known key`);
  }
  const s = c.softAsk as Record<string, unknown> | undefined;
  if (typeof s !== 'object' || s === null || Array.isArray(s)) p.push('reviewPrompt.softAsk must be an object');
  else {
    if (typeof s.ios !== 'boolean') p.push('reviewPrompt.softAsk.ios must be a boolean');
    if (typeof s.android !== 'boolean') p.push('reviewPrompt.softAsk.android must be a boolean');
    if (s.android === true) p.push('reviewPrompt.softAsk.android must stay false (Google Play in-app review guidelines forbid asking for an opinion before the rating card)');
    for (const k of Object.keys(s)) if (k !== 'ios' && k !== 'android') p.push(`reviewPrompt.softAsk.${k} is not a known key`);
  }
  return p;
}

// ------------------------------------------------------------------------------------------- the decision (pure, shared)

export interface ReviewPromptSummary {
  platform: ReviewPlatform;
  moment: string;
  now: number;
  installedAt: number;
  racesPlayed: number;
  inFtue: boolean;
  accountClosing: boolean;
  sessionPrompted: boolean;
  /** A §46 maintenance window is announced or running right now. */
  maintenanceVisible: boolean;
  /** The player owes coins after a refund (wallet.debt > 0). */
  coinDebt: boolean;
  /** Minutes since the last such event; null = none / unknown. */
  minutesSince: Record<ReviewQuietKey, number | null>;
  /** Times of earlier prompts (ms). */
  history: number[];
}
export interface ReviewDecision { show: boolean; reason: ReviewReason | null; style: 'soft' | 'native' | null }

const DAY_MS = 86_400_000;
const within = (since: number | null, quiet: number) => since !== null && since < quiet;

/** REQ-REV-003 (§59.3): whether to ask, and how. Pure: same rules + summary → same answer (TS ↔ C# vectors). */
export function decideReviewPrompt(r: ReviewPromptRules, x: ReviewPromptSummary): ReviewDecision {
  const no = (reason: ReviewReason): ReviewDecision => ({ show: false, reason, style: null });
  const q = r.quietMinutes;
  if (!r.enabled) return no('disabled');
  if (!(r.moments as readonly string[]).includes(x.moment)) return no('moment');
  if (x.accountClosing) return no('account_closing');
  if (x.inFtue) return no('ftue');
  if (x.sessionPrompted) return no('session');
  if (x.maintenanceVisible || within(x.minutesSince.maintenanceNotice, q.maintenanceNotice)) return no('maintenance');
  if (x.coinDebt || within(x.minutesSince.refund, q.refund)) return no('refund');
  if (within(x.minutesSince.purchase, q.purchase)) return no('purchase');
  if (within(x.minutesSince.error, q.error)) return no('error');
  if (within(x.minutesSince.loss, q.loss)) return no('loss');
  if (Math.floor((x.now - x.installedAt) / DAY_MS) < r.minDaysSinceInstall) return no('too_new');
  if (x.racesPlayed < r.minRacesPlayed) return no('too_few_races');
  const recent = x.history.filter((at) => x.now - at < 365 * DAY_MS);
  if (recent.length >= r.maxPerYear) return no('year_cap');
  if (recent.some((at) => x.now - at < r.coolDownDays * DAY_MS)) return no('cool_down');
  const soft = x.platform === 'android' ? r.softAsk.android : r.softAsk.ios;
  return { show: true, reason: null, style: soft ? 'soft' : 'native' };
}

// ------------------------------------------------------------------------------------------- state

export interface ReviewPromptEntry {
  id: string; at: number; moment: string; platform: ReviewPlatform; style: 'soft' | 'native'; sessionId: string;
  answer: 'soft_yes' | 'soft_no' | 'soft_dismiss' | null; nativeAt: number | null;
}
export interface ReviewPromptState { v: 1; seq: number; history: ReviewPromptEntry[]; lastSessionId: string | null }
export const REVIEW_HISTORY_MAX = 10;
export const REVIEW_HISTORY_DAYS = 400;

export function ensureReviewPrompt(s: PlayerState): ReviewPromptState {
  s.reviewPrompt ??= { v: 1, seq: 0, history: [], lastSessionId: null };
  return s.reviewPrompt;
}

/** What the server knows itself (REQ-REV-004). */
export interface ReviewServerSummary {
  installedAt: number; racesPlayed: number; inFtue: boolean; accountClosing: boolean; maintenanceVisible: boolean; coinDebt: boolean;
  minutesSincePurchase: number | null; minutesSinceRefund: number | null; lastSessionId: string | null; history: number[];
}
const minutesSince = (now: number, at: number | null) => (at === null ? null : Math.max(0, Math.floor((now - at) / 60_000)));
const latest = (xs: number[]) => (xs.length ? Math.max(...xs) : null);

export function reviewServerSummary(m: Master, s: PlayerState, now: number): ReviewServerSummary {
  const purchaseAt = latest(s.purchases.map((p) => p.at));
  // a refund leaves a `refund` (coins taken back) or `debt` (already spent) row in the coin ledger
  const refundAt = latest(s.ledger.filter((e) => e.kind === 'refund' || e.kind === 'debt').map((e) => e.at));
  return {
    installedAt: s.createdAt, racesPlayed: s.stats.races,
    inFtue: !s.flags.tutorialGachaUsed,
    accountClosing: deletionScheduled(s),
    maintenanceVisible: m.maintenance ? visibleWindows(m.maintenance, now).length > 0 : false,
    coinDebt: s.wallet.debt > 0,
    minutesSincePurchase: minutesSince(now, purchaseAt), minutesSinceRefund: minutesSince(now, refundAt),
    lastSessionId: s.reviewPrompt?.lastSessionId ?? null,
    history: (s.reviewPrompt?.history ?? []).map((h) => h.at),
  };
}

export interface ReviewClientFacts {
  inFtue: boolean; minutesSinceLoss: number | null; minutesSinceError: number | null; minutesSinceMaintenanceNotice: number | null;
}
export interface ReviewCheckInput { moment: string; platform: ReviewPlatform; sessionId: string; client: ReviewClientFacts }

/** REQ-REV-004: the server's facts merged with the device's (FTUE: either side in it → in it). */
export function mergeSummary(sv: ReviewServerSummary, i: ReviewCheckInput, now: number): ReviewPromptSummary {
  return {
    platform: i.platform, moment: i.moment, now, installedAt: sv.installedAt, racesPlayed: sv.racesPlayed,
    inFtue: sv.inFtue || i.client.inFtue, accountClosing: sv.accountClosing,
    sessionPrompted: sv.lastSessionId !== null && sv.lastSessionId === i.sessionId,
    maintenanceVisible: sv.maintenanceVisible, coinDebt: sv.coinDebt,
    minutesSince: {
      loss: i.client.minutesSinceLoss, purchase: sv.minutesSincePurchase, refund: sv.minutesSinceRefund,
      error: i.client.minutesSinceError, maintenanceNotice: i.client.minutesSinceMaintenanceNotice,
    },
    history: sv.history,
  };
}

// ------------------------------------------------------------------------------------------- API

/** GET /v1/review-prompt: the rules and the server's half of the summary, for the device's pre-check (no writes). */
export function reviewPromptStatus(m: Master, s: PlayerState, now: number) {
  const rules = reviewRulesOf(m);
  const sv = reviewServerSummary(m, s, now);
  const recent = sv.history.filter((at) => now - at < 365 * DAY_MS);
  return { v: REVIEW_VERSION, rules, history: { count365: recent.length, lastAt: latest(sv.history) }, serverSummary: sv };
}

export interface ReviewPromptCheck { v: 1; show: boolean; style: 'soft' | 'native' | null; reason: ReviewReason | null; promptId: string | null }

/** REQ-REV-005/006: POST /v1/review-prompt/check. Records the prompt (and counts it) only when it says yes. */
export function checkReviewPrompt(m: Master, s: PlayerState, i: ReviewCheckInput, now: number, emit?: (e: KpiEvent) => void): ReviewPromptCheck {
  const d = decideReviewPrompt(reviewRulesOf(m), mergeSummary(reviewServerSummary(m, s, now), i, now));
  if (!d.show) return { v: REVIEW_VERSION, show: false, style: null, reason: d.reason, promptId: null };
  const st = ensureReviewPrompt(s);
  st.seq += 1;
  const id = `rp_${st.seq}`;
  st.history.push({ id, at: now, moment: i.moment, platform: i.platform, style: d.style!, sessionId: i.sessionId, answer: null, nativeAt: null });
  st.history = st.history.filter((h) => now - h.at < REVIEW_HISTORY_DAYS * DAY_MS).slice(-REVIEW_HISTORY_MAX);
  st.lastSessionId = i.sessionId;
  emit?.({ name: 'review_prompt_eligible', s1: i.moment, s2: i.platform, s3: d.style! });
  return { v: REVIEW_VERSION, show: true, style: d.style, reason: null, promptId: id };
}

const SOFT_KPI = { soft_yes: 'yes', soft_no: 'not_really', soft_dismiss: 'dismissed' } as const;

/** REQ-REV-007: POST /v1/review-prompt/:promptId/answer. Each answer is written once; nothing is ever granted. */
export function answerReviewPrompt(s: PlayerState, promptId: string, step: ReviewStep, now: number, emit?: (e: KpiEvent) => void) {
  const e = s.reviewPrompt?.history.find((h) => h.id === promptId);
  if (!e) throw new AppError('NOT_FOUND', 'unknown review prompt');
  if (step === 'native_requested') {
    if (!(e.style === 'native' || e.answer === 'soft_yes')) throw new AppError('NOT_ELIGIBLE', 'the store review is asked only after yes (or directly)');
    if (e.nativeAt === null) {
      e.nativeAt = now;
      emit?.({ name: 'review_prompt_shown', s1: e.moment, s2: e.platform, s3: e.style });
    }
    return { promptId, next: 'none' as const, helpCategory: null };
  }
  if (e.style !== 'soft') throw new AppError('NOT_ELIGIBLE', 'this prompt had no pre-question');
  if (e.answer !== null && e.answer !== step) throw new AppError('CONFLICT', 'already answered');
  if (e.answer === null) {
    e.answer = step;
    emit?.({ name: 'review_soft_answer', s1: SOFT_KPI[step], s2: e.moment, s3: e.platform });
  }
  return step === 'soft_yes' ? { promptId, next: 'store_review' as const, helpCategory: null }
    : step === 'soft_no' ? { promptId, next: 'help_inquiry' as const, helpCategory: 'other' as const }
    : { promptId, next: 'none' as const, helpCategory: null };
}
