/**
 * 広告・分析の同意管理 (ad tracking & analytics consent, REQ-CNS-001..020, contracts/protocol.md §58).
 *
 * Separate from the terms / privacy policy consent (REQ-UXS-001, onboarding.ts): the player chooses
 *  - personalised ads (opt-in; the rewarded ads of §21 are non-personalised otherwise), and
 *  - analytics (optional KPI events; the essential ones — purchases, refunds, paid coin use, ad rewards, consent,
 *    deletion, data export, reports — are always kept, kpiConsent.ts).
 * The device reports what the OS decided (iOS App Tracking Transparency, Google UMP / CMP for the EEA) and the server
 * works out what is in effect each time it is read, so an age registered later or an ATT change applies at once.
 *
 * Refusing costs nothing: no reward, cap or feature depends on these choices (Apple 5.1.1(iv), GDPR "freely given").
 * Nothing here moves coins or items (no E number). The routes are never gated by maintenance or the version gate (§46).
 */
import { z } from 'zod';
import { AppError } from './errors.js';
import type { Master } from './master.js';
import type { PlayerState } from './player.js';
import type { Emit } from './service.js';
import { ageBand } from './purchase.js';
import { dayRule, gameDayIndex } from './time.js';

export const ATT_STATUSES = ['not_determined', 'restricted', 'denied', 'authorized', 'unavailable'] as const;
export type AttStatus = typeof ATT_STATUSES[number];
export const CMP_STATUSES = ['not_required', 'required', 'obtained', 'unknown'] as const;
export type CmpStatus = typeof CMP_STATUSES[number];
export const PRIVACY_OS = ['ios', 'android', 'other'] as const;
export const CHOICE_SOURCES = ['prompt', 'settings'] as const;
export type ChoiceSource = typeof CHOICE_SOURCES[number] | 'platform';
export type ChoiceKey = 'personalized_ads' | 'analytics' | 'att' | 'cmp' | 'prompt';
/** Strongest first: the one reason shown next to a switch whose value does not apply. */
export const LOCK_REASONS = ['minor', 'under18', 'age_unknown', 'att', 'cmp'] as const;
export type LockReason = typeof LOCK_REASONS[number];
export type PromptMoment = 'ad_offer' | 'next_home';

export interface PrivacyPlatform { os: typeof PRIVACY_OS[number]; att: AttStatus | null; gdprApplies: boolean | null; cmp: CmpStatus | null; at: number }
export interface PrivacyHistoryRow { at: number; key: ChoiceKey; value: string; source: ChoiceSource; version: string }
export interface PrivacyChoicesState {
  /** null = never chosen (the §58.3 default applies). */
  personalizedAds: boolean | null;
  analytics: boolean | null;
  decidedVersion: string | null;
  decidedAt: number | null;
  updatedAt: number;
  rev: number;
  promptShownAt: number | null;
  promptShownVersion: string | null;
  platform: PrivacyPlatform | null;
  history: PrivacyHistoryRow[];
}
export const PRIVACY_HISTORY_KEEP = 50;
/** GDPR Art. 8 upper bound where the EEA rules apply; elsewhere (and when the region is unknown) 13. */
export const CHILD_AGE = { default: 13, eea: 16 } as const;
/** REQ-AD-009 (kept): personalised ads only for a registered age of 18 or more. */
export const PERSONALIZED_MIN_AGE = 18;
/** When §21's config is absent, the same FTUE gate as its defaults. */
const FTUE_DEFAULTS = { minRankedRaces: 3, minGameDay: 2 } as const;

export const privacyChoicesBodySchema = z.object({
  privacyVersion: z.string().min(1).max(32),
  source: z.enum(CHOICE_SOURCES),
  personalizedAds: z.boolean().optional(),
  analytics: z.boolean().optional(),
}).strict();
export type PrivacyChoicesBody = z.infer<typeof privacyChoicesBodySchema>;
export const privacyPlatformBodySchema = z.object({
  os: z.enum(PRIVACY_OS),
  att: z.enum(ATT_STATUSES).optional(),
  gdprApplies: z.boolean().nullable().optional(),
  cmp: z.enum(CMP_STATUSES).optional(),
}).strict();
export type PrivacyPlatformBody = z.infer<typeof privacyPlatformBodySchema>;
export const privacyPromptBodySchema = z.object({ privacyVersion: z.string().min(1).max(32) }).strict();

const policyVersion = (m: Master): string | null => m.progression.consent?.privacyVersion ?? null;

function ensure(s: PlayerState, now: number): PrivacyChoicesState {
  s.privacyChoices ??= {
    personalizedAds: null, analytics: null, decidedVersion: null, decidedAt: null, updatedAt: now, rev: 0,
    promptShownAt: null, promptShownVersion: null, platform: null, history: [],
  };
  return s.privacyChoices;
}

/** The registered age (existing `age`, counted like `ageBand`), or null when not registered. */
function registeredAge(m: Master, s: PlayerState, now: number): number | null {
  if (!s.age) return null;
  return ageBand(m, s, now)?.age ?? null;
}

/** REQ-CNS-006: under 13, or under 16 where the EEA rules apply (the device's UMP `gdprApplies`). */
export function isChild(m: Master, s: PlayerState, now: number): boolean {
  const age = registeredAge(m, s, now);
  if (age === null) return false;
  const eea = s.privacyChoices?.platform?.gdprApplies === true;
  return age < (eea ? CHILD_AGE.eea : CHILD_AGE.default);
}

/** What applies now (REQ-CNS-003/004). Read-only. */
export function effectiveChoices(m: Master, s: PlayerState, now: number) {
  const c = s.privacyChoices;
  const p = c?.platform ?? null;
  const age = registeredAge(m, s, now);
  const minor = isChild(m, s, now);
  const eea = p?.gdprApplies === true;
  const guardian = s.age?.guardianConsent === true;
  // personalised ads: opt-in
  const adsValue = c?.personalizedAds ?? false;
  let adsLock: LockReason | null = null;
  if (minor) adsLock = 'minor';
  else if (age !== null && age < PERSONALIZED_MIN_AGE) adsLock = 'under18';
  else if (age === null) adsLock = 'age_unknown';
  else if (p?.os === 'ios' && p.att !== 'authorized') adsLock = 'att';
  else if (eea && p?.cmp !== 'obtained' && p?.cmp !== 'not_required') adsLock = 'cmp';
  // analytics: on by default except children and the EEA (consent first there)
  const analyticsValue = c?.analytics ?? !(minor || eea);
  const analyticsLock: LockReason | null = minor && !guardian ? 'minor' : null;
  return {
    minor, age, eea,
    personalizedAds: { value: adsValue, effective: adsValue && adsLock === null, locked: adsLock },
    analytics: { value: analyticsValue, effective: analyticsValue && analyticsLock === null, locked: analyticsLock },
  };
}

/** REQ-CNS-013: optional KPI events may be written for this player (kpiConsent.ts decides per event). */
export const analyticsAllowed = (m: Master, s: PlayerState, now: number) => effectiveChoices(m, s, now).analytics.effective;

/** REQ-CNS-007: past the FTUE (§21's gate: ranked races and the game day); never on the install day. */
function pastFtue(m: Master, s: PlayerState, now: number): boolean {
  const ads = m.progression.ads as { minRankedRaces?: number; minGameDay?: number } | undefined;
  const minRaces = ads?.minRankedRaces ?? FTUE_DEFAULTS.minRankedRaces;
  const minDay = ads?.minGameDay ?? FTUE_DEFAULTS.minGameDay;
  const day = gameDayIndex(now, dayRule(m)) - gameDayIndex(s.createdAt, dayRule(m)) + 1;
  return s.rating.rankedRaces >= minRaces && day >= minDay;
}

/**
 * REQ-CNS-010 (§21 adRequest): REQ-AD-009 (unknown age or under 18 → non-personalised, the under-16 tag) combined with
 * the effective choice. `extras.npa` is the AdMob network extra.
 */
export function adRequestConfig(m: Master, s: PlayerState, now: number) {
  const e = effectiveChoices(m, s, now);
  const age = e.age;
  const nonPersonalized = age === null || age < PERSONALIZED_MIN_AGE || !e.personalizedAds.effective;
  return {
    npa: nonPersonalized ? 1 : 0,
    nonPersonalized,
    underAgeOfConsent: age !== null && age < 16,
    ageKnown: age !== null,
    tagForChildDirected: e.minor,
    extras: nonPersonalized ? { npa: '1' } : {},
  };
}

/**
 * GET /v1/privacy/choices (REQ-CNS-002). `adsOffered`: §21 would show an offer now (the first prompt waits for the first
 * offer card); the service passes it so this module does not import ads.ts (ads.ts imports this one).
 */
export function privacyChoicesView(m: Master, s: PlayerState, now: number, adsOffered = false) {
  const c = s.privacyChoices ?? null;
  const cur = policyVersion(m);
  const e = effectiveChoices(m, s, now);
  const required = cur !== null && c?.decidedVersion !== cur;
  let prompt: PromptMoment | null = null;
  if (required && c?.promptShownVersion !== cur && pastFtue(m, s, now)) {
    prompt = c?.decidedVersion ? 'next_home' : adsOffered ? 'ad_offer' : 'next_home';
  }
  return {
    policyVersion: cur,
    decidedVersion: c?.decidedVersion ?? null, decidedAt: c?.decidedAt ?? null, updatedAt: c?.updatedAt ?? null, rev: c?.rev ?? 0,
    required, prompt, minor: e.minor,
    personalizedAds: e.personalizedAds,
    analytics: e.analytics,
    platform: c?.platform ? { ...c.platform } : null,
    adRequest: adRequestConfig(m, s, now),
    kpi: { optional: e.analytics.effective },
  };
}
export type PrivacyChoicesView = ReturnType<typeof privacyChoicesView>;

function notDeleting(s: PlayerState) {
  if (s.deletion?.status === 'deleting') throw new AppError('DELETION_PENDING', 'the account is being deleted');
}
function currentVersion(m: Master, sent: string): string {
  const cur = policyVersion(m);
  if (cur === null) throw new AppError('NOT_FOUND', 'consent is not configured');
  if (sent !== cur) throw new AppError('CONSENT_VERSION_MISMATCH', `current privacy policy version is ${cur}`);
  return cur;
}
const onOff = (v: boolean) => (v ? 'on' : 'off');
function note(c: PrivacyChoicesState, row: PrivacyHistoryRow) {
  c.history.push(row);
  if (c.history.length > PRIVACY_HISTORY_KEEP) c.history.splice(0, c.history.length - PRIVACY_HISTORY_KEEP);
}

/**
 * PUT /v1/privacy/choices (REQ-CNS-005): records a decision under the current policy version. Keys left out keep the
 * value in effect (the default becomes the decision). The same body again changes nothing (no rev, no KPI).
 */
export function setPrivacyChoices(m: Master, s: PlayerState, body: PrivacyChoicesBody, now: number, emit: Emit, adsOffered = false) {
  const r = privacyChoicesBodySchema.safeParse(body);
  if (!r.success) throw new AppError('BAD_REQUEST', 'privacy: ' + r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  notDeleting(s);
  const version = currentVersion(m, r.data.privacyVersion);
  const before = effectiveChoices(m, s, now);
  const nextAds = r.data.personalizedAds ?? before.personalizedAds.value;
  const nextAnalytics = r.data.analytics ?? before.analytics.value;
  // REQ-CNS-006: a child turns analytics on only with the guardian's consent; personalised ads never
  if (before.minor && nextAnalytics && !(s.age?.guardianConsent === true) && r.data.analytics === true) throw new AppError('NOT_ELIGIBLE', 'analytics: a guardian has to agree first');
  if (before.minor && r.data.personalizedAds === true) throw new AppError('NOT_ELIGIBLE', 'personalised ads are off for children');
  const c0 = s.privacyChoices;
  const same = c0 && c0.decidedVersion === version && c0.personalizedAds === nextAds && c0.analytics === nextAnalytics;
  if (same) return privacyChoicesView(m, s, now, adsOffered);
  const c = ensure(s, now);
  const changed: [ChoiceKey, boolean][] = [];
  if (c.personalizedAds !== nextAds) changed.push(['personalized_ads', nextAds]);
  if (c.analytics !== nextAnalytics) changed.push(['analytics', nextAnalytics]);
  c.personalizedAds = nextAds;
  c.analytics = nextAnalytics;
  c.decidedVersion = version;
  c.decidedAt = now;
  c.updatedAt = now;
  c.rev += 1;
  for (const [k, v] of changed) {
    note(c, { at: now, key: k, value: onOff(v), source: r.data.source, version });
    emit({ name: 'consent_change', s1: k, s2: onOff(v), s3: r.data.source });
  }
  if (changed.length === 0) note(c, { at: now, key: 'prompt', value: 'confirmed', source: r.data.source, version });
  return privacyChoicesView(m, s, now, adsOffered);
}

/** PUT /v1/privacy/platform (REQ-CNS-009): what the OS / CMP decided. Fields left out keep their stored value. */
export function setPrivacyPlatform(m: Master, s: PlayerState, body: PrivacyPlatformBody, now: number, emit: Emit, adsOffered = false) {
  const r = privacyPlatformBodySchema.safeParse(body);
  if (!r.success) throw new AppError('BAD_REQUEST', 'privacy platform: ' + r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  notDeleting(s);
  const prev = s.privacyChoices?.platform ?? null;
  const next: PrivacyPlatform = {
    os: r.data.os,
    att: r.data.att ?? (r.data.os === prev?.os ? prev?.att ?? null : null),
    gdprApplies: r.data.gdprApplies !== undefined ? r.data.gdprApplies : prev?.gdprApplies ?? null,
    cmp: r.data.cmp ?? prev?.cmp ?? null,
    at: now,
  };
  if (prev && prev.os === next.os && prev.att === next.att && prev.gdprApplies === next.gdprApplies && prev.cmp === next.cmp) return privacyChoicesView(m, s, now, adsOffered);
  const c = ensure(s, now);
  const version = policyVersion(m) ?? '';
  c.platform = next;
  c.updatedAt = now;
  c.rev += 1;
  if (next.att !== null && next.att !== (prev?.att ?? null)) {
    note(c, { at: now, key: 'att', value: next.att, source: 'platform', version });
    emit({ name: 'consent_change', s1: 'att', s2: next.att, s3: 'platform' });
  }
  if (next.cmp !== null && next.cmp !== (prev?.cmp ?? null)) {
    note(c, { at: now, key: 'cmp', value: next.cmp, source: 'platform', version });
    emit({ name: 'consent_change', s1: 'cmp', s2: next.cmp, s3: 'platform' });
  }
  return privacyChoicesView(m, s, now, adsOffered);
}

/** POST /v1/privacy/prompt-shown (REQ-CNS-007): the pre-prompt was shown; once per policy version. */
export function notePrivacyPromptShown(m: Master, s: PlayerState, privacyVersion: string, now: number, adsOffered = false) {
  notDeleting(s);
  const version = currentVersion(m, privacyVersion);
  if (s.privacyChoices?.promptShownVersion === version) return privacyChoicesView(m, s, now, adsOffered);
  const c = ensure(s, now);
  c.promptShownAt = now;
  c.promptShownVersion = version;
  note(c, { at: now, key: 'prompt', value: 'shown', source: 'prompt', version });
  return privacyChoicesView(m, s, now, adsOffered);
}

/** The compact block in GET /v1/player and the bootstrap. */
export function privacyChoicesBadge(m: Master, s: PlayerState, now: number, adsOffered = false) {
  const v = privacyChoicesView(m, s, now, adsOffered);
  return { required: v.required, prompt: v.prompt, policyVersion: v.policyVersion, personalizedAds: v.personalizedAds, analytics: v.analytics, adRequest: v.adRequest };
}
