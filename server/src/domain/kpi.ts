/**
 * KPI analytics (REQ-KPI-*). Events go to Workers Analytics Engine as fixed-position columns
 * (docs/ops/kpi-queries.md documents the layout and the queries).
 *
 * Analytics Engine has no JOIN, so every row is denormalised with what retention / payer queries need:
 * the player's install cohort (JST day), days since install and payer status at event time.
 * Privacy (REQ-KPI-005): no PII; the player id is replaced by a salted SHA-256 prefix before writing.
 */
import { z } from 'zod';
import { AppError } from './errors.js';
import type { PlayerState } from './player.js';
import { jstDateKey } from './time.js';

/** Event-specific fields. Strings go to blob8-10, numbers to double1-6/8/9 (see BLOB/DOUBLE below). */
export interface KpiEvent {
  name: string;
  s1?: string; s2?: string; s3?: string;
  amountYen?: number; paidCoins?: number; freeCoins?: number; place?: number; count?: number; durationMs?: number;
  isFirst?: boolean; value?: number;
}
export interface KpiRecord extends KpiEvent {
  source: 'server' | 'client';
  at: number;
  cohortDay: string;
  eventDay: string;
  daysSinceInstall: number;
  payer: boolean;
  platform: string;
  appVersion: string;
}

/** Column layout — never reorder (queries depend on positions). */
export const BLOB = { event: 1, player: 2, platform: 3, appVersion: 4, cohortDay: 5, eventDay: 6, payer: 7, s1: 8, s2: 9, s3: 10, source: 11 } as const;
export const DOUBLE = { amountYen: 1, paidCoins: 2, freeCoins: 3, place: 4, count: 5, durationMs: 6, daysSinceInstall: 7, isFirst: 8, value: 9 } as const;

const DAY = 86_400_000;
const JST = 9 * 3_600_000;
const jstDayIndex = (ms: number) => Math.floor((ms + JST) / DAY);

export const isPayer = (s: PlayerState) => s.purchases.some((p) => !p.refunded && p.priceYen > 0 && !p.sandbox);

export function kpiRecord(s: PlayerState, now: number, e: KpiEvent, source: 'server' | 'client' = 'server', client?: { platform: string; appVersion: string; at?: number }): KpiRecord {
  const at = client?.at ?? now;
  return {
    ...e, source, at,
    cohortDay: jstDateKey(s.createdAt), eventDay: jstDateKey(at),
    daysSinceInstall: Math.max(0, jstDayIndex(at) - jstDayIndex(s.createdAt)),
    payer: isPayer(s), platform: client?.platform ?? '', appVersion: client?.appVersion ?? '',
  };
}

/** Analytics Engine data point. `index1` = hashed player, so sampling keeps a player's rows together. */
export function toDataPoint(r: KpiRecord, hashedPlayer: string) {
  const blobs: string[] = new Array(11).fill('');
  blobs[BLOB.event - 1] = r.name;
  blobs[BLOB.player - 1] = hashedPlayer;
  blobs[BLOB.platform - 1] = r.platform;
  blobs[BLOB.appVersion - 1] = r.appVersion;
  blobs[BLOB.cohortDay - 1] = r.cohortDay;
  blobs[BLOB.eventDay - 1] = r.eventDay;
  blobs[BLOB.payer - 1] = r.payer ? 'payer' : 'nonpayer';
  blobs[BLOB.s1 - 1] = (r.s1 ?? '').slice(0, 64);
  blobs[BLOB.s2 - 1] = (r.s2 ?? '').slice(0, 64);
  blobs[BLOB.s3 - 1] = (r.s3 ?? '').slice(0, 64);
  blobs[BLOB.source - 1] = r.source;
  const doubles: number[] = new Array(9).fill(0);
  doubles[DOUBLE.amountYen - 1] = r.amountYen ?? 0;
  doubles[DOUBLE.paidCoins - 1] = r.paidCoins ?? 0;
  doubles[DOUBLE.freeCoins - 1] = r.freeCoins ?? 0;
  doubles[DOUBLE.place - 1] = r.place ?? 0;
  doubles[DOUBLE.count - 1] = r.count ?? 0;
  doubles[DOUBLE.durationMs - 1] = r.durationMs ?? 0;
  doubles[DOUBLE.daysSinceInstall - 1] = r.daysSinceInstall;
  doubles[DOUBLE.isFirst - 1] = r.isFirst ? 1 : 0;
  doubles[DOUBLE.value - 1] = r.value ?? 0;
  return { indexes: [hashedPlayer], blobs, doubles };
}

/** Salted SHA-256 → 16 hex chars. Same player → same id across events; not reversible without the salt. */
export async function hashPlayerId(salt: string, playerId: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${playerId}`));
  return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- client events (REQ-KPI-003)

const str = (max: number) => z.string().min(1).max(max).regex(/^[\w\-.:]+$/);

/**
 * REQ-UXS-030: the fixed FTUE step list (docs/planning/06 §8.1). The index is the step's funnel position; a
 * client may send it, but it must match. `value` is an optional number (race1_win: retries before the win).
 */
export const TUTORIAL_STEPS = ['consent', 'race1_start', 'race1_whip', 'race1_win', 'named', 'gacha_done', 'race2_done', 'home'] as const;
export type TutorialStep = typeof TUTORIAL_STEPS[number];
export const tutorialStepIndex = (step: TutorialStep) => TUTORIAL_STEPS.indexOf(step) + 1;
const tutorialStepProps = z.object({
  step: z.enum(TUTORIAL_STEPS), index: z.number().int().min(0).max(100).optional(), value: z.number().int().min(0).max(1_000_000).optional(),
}).strict().refine((p) => p.index === undefined || p.index === tutorialStepIndex(p.step), { message: 'index does not match the step', path: ['index'] });
/** §5.1 offer triggers T1..T8. */
export const OFFER_TRIGGERS = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'] as const;
const offerProps = z.object({ offerId: str(64), trigger: z.enum(OFFER_TRIGGERS) }).strict();
/** REQ-AD-010: where an ad offer card was shown (domain/ads.ts AdSurface). */
export const AD_SURFACE_NAMES = ['home', 'result', 'time_attack', 'shop'] as const;
const adProps = z.object({ placementId: str(32), surface: z.enum(AD_SURFACE_NAMES) }).strict();
/** REQ-HIST-011: the history screen's tabs (contracts/protocol.md §33.5). */
export const HISTORY_TABS = ['purchases', 'coins_paid', 'coins_free', 'gacha'] as const;
/** REQ-ADV-011: where the pre-race advice was shown (contracts/protocol.md §39.7; the same names as the advice contexts). */
export const ADVICE_KPI_CONTEXTS = ['ranked', 'friend', 'event', 'challenge', 'timeattack', 'tutorial'] as const;
/** REQ-PHOTO-014: where a photo was taken (photoMode.ts PHOTO_SOURCES). */
export const PHOTO_SOURCE_NAMES = ['paused', 'result', 'replay'] as const;
/** REQ-ACT-015: the activity list's kinds and deep-link screens (domain/activity.ts; repeated here to keep kpi.ts import-free). */
export const ACTIVITY_KIND_NAMES = ['friend_request', 'friend_accepted', 'rival_week', 'rival_record', 'stable_like', 'team_cheer', 'tournament_result', 'gift_arrived', 'team_goal_tier', 'team_goal_week', 'replay_share', 'ops_notice'] as const;
export const ACTIVITY_SCREEN_NAMES = ['friends', 'rival', 'stable', 'team_feed', 'tournaments', 'gift_box', 'team_goal', 'replay', 'whats_new', 'safety'] as const;
/** Events only the client can observe. Server-known events (purchase, gacha, race results…) are not accepted from clients. */
export const clientEventSchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('session_start'), at: z.number().int(), props: z.object({}).strict().optional() }),
  z.object({ name: z.literal('session_end'), at: z.number().int(), props: z.object({ durationMs: z.number().int().min(0).max(86_400_000) }) }),
  z.object({ name: z.literal('tutorial_step'), at: z.number().int(), props: tutorialStepProps }),
  z.object({ name: z.literal('screen_view'), at: z.number().int(), props: z.object({ screen: str(32) }) }),
  // REQ-CMT-012: a commentary pack sample started (try before buy)
  z.object({ name: z.literal('commentary_pack_sample'), at: z.number().int(), props: z.object({ packId: str(32), owned: z.boolean() }) }),
  // REQ-ASSIST-011: `assist` = the かんたん操作 level that rides this race (absent = off)
  z.object({ name: z.literal('race_start'), at: z.number().int(), props: z.object({ mode: z.enum(['ranked', 'friend', 'tutorial', 'offline', 'time_attack']), assist: z.enum(['off', 'whip', 'full']).optional() }) }),
  z.object({ name: z.literal('purchase_flow'), at: z.number().int(), props: z.object({ stage: z.enum(['open', 'cancel', 'fail', 'store_success']), productId: str(64) }) }),
  z.object({ name: z.literal('push_open'), at: z.number().int(), props: z.object({ templateId: str(32) }) }),
  z.object({ name: z.literal('push_permission'), at: z.number().int(), props: z.object({ granted: z.boolean() }) }),
  // REQ-UXS-030
  z.object({ name: z.literal('feature_unlock'), at: z.number().int(), props: z.object({ feature: str(32) }).strict() }),
  z.object({ name: z.literal('offer_view'), at: z.number().int(), props: offerProps }),
  z.object({ name: z.literal('offer_click'), at: z.number().int(), props: offerProps }),
  z.object({ name: z.literal('race_quit'), at: z.number().int(), props: z.object({ mode: z.enum(['ranked', 'friend', 'tutorial', 'offline', 'time_attack', 'event', 'tournament']), remainingM: z.number().int().min(0).max(10_000) }).strict() }),
  z.object({ name: z.literal('account_link'), at: z.number().int(), props: z.object({ provider: z.enum(['apple', 'google']) }).strict() }),
  // REQ-UXS-072: a replay handed to the OS share sheet (the player shared; cancelled shares are not sent)
  z.object({ name: z.literal('share'), at: z.number().int(), props: z.object({ kind: z.enum(['replay_video', 'replay_image']) }).strict() }),
  // REQ-INV-011: the invite code handed to the OS share sheet or copied (redemptions and milestones are server events)
  // REQ-MYRP-014: a saved replay handed to the OS share sheet (own list or a friend's public replay)
  z.object({ name: z.literal('replay_share'), at: z.number().int(), props: z.object({ surface: z.enum(['my_replays', 'friend_replay']) }).strict() }),
  z.object({ name: z.literal('invite_share'), at: z.number().int(), props: z.object({ channel: z.enum(['os_share', 'copy_code', 'copy_link']) }).strict() }),
  // REQ-AD-010: rewarded ads. The reward itself is the server event ad_reward (from the SSV callback, never the client).
  z.object({ name: z.literal('ad_offer_view'), at: z.number().int(), props: adProps }),
  z.object({ name: z.literal('ad_start'), at: z.number().int(), props: z.object({ placementId: str(32), surface: z.enum(AD_SURFACE_NAMES), outcome: z.enum(['shown', 'no_fill', 'failed', 'closed_early']) }).strict() }),
  // REQ-HIST-011: a history tab was opened (the lists are read-only GETs, so the view is a client event)
  z.object({ name: z.literal('history_view'), at: z.number().int(), props: z.object({ tab: z.enum(HISTORY_TABS) }).strict() }),
  // REQ-ADV-011: the advice panel was shown (once per screen visit) / the race was entered with the suggested horse or not
  z.object({ name: z.literal('advice_view'), at: z.number().int(), props: z.object({ context: z.enum(ADVICE_KPI_CONTEXTS), horses: z.number().int().min(0).max(30), suggested: z.boolean() }).strict() }),
  z.object({ name: z.literal('advice_follow'), at: z.number().int(), props: z.object({ context: z.enum(ADVICE_KPI_CONTEXTS), followed: z.boolean() }).strict() }),
  // REQ-PHOTO-014: a photo was taken / handed to the OS share sheet (cancelled shares are not sent; saves are the server's photo_save)
  z.object({ name: z.literal('photo_take'), at: z.number().int(), props: z.object({ source: z.enum(PHOTO_SOURCE_NAMES), look: z.string().regex(/^[a-z0-9_]{1,32}$/) }).strict() }),
  z.object({ name: z.literal('photo_share'), at: z.number().int(), props: z.object({ source: z.enum(PHOTO_SOURCE_NAMES), framed: z.boolean() }).strict() }),
  // REQ-ACT-015: the activity list was opened (unread count then) / an entry was tapped (its kind and deep link)
  z.object({ name: z.literal('activity_open'), at: z.number().int(), props: z.object({ unread: z.number().int().min(0).max(999) }).strict() }),
  z.object({ name: z.literal('activity_tap'), at: z.number().int(), props: z.object({ kind: z.enum(ACTIVITY_KIND_NAMES), screen: z.enum(ACTIVITY_SCREEN_NAMES) }).strict() }),
]);
export type ClientEvent = z.infer<typeof clientEventSchema>;

export const clientBatchSchema = z.object({
  platform: z.enum(['ios', 'android', 'editor']),
  appVersion: z.string().min(1).max(32),
  events: z.array(clientEventSchema).min(1).max(50),
});
export type ClientBatch = z.infer<typeof clientBatchSchema>;

export function clientToKpi(e: ClientEvent): KpiEvent {
  switch (e.name) {
    case 'session_start': return { name: e.name };
    case 'session_end': return { name: e.name, durationMs: e.props.durationMs };
    // index stays in double9 (the column layout never changes); the optional value goes to double5 (count)
    case 'tutorial_step': return { name: e.name, s1: e.props.step, value: tutorialStepIndex(e.props.step), ...(e.props.value !== undefined ? { count: e.props.value } : {}) };
    case 'screen_view': return { name: e.name, s1: e.props.screen };
    case 'commentary_pack_sample': return { name: e.name, s1: e.props.packId, s2: e.props.owned ? 'owned' : 'not_owned' };
    case 'race_start': return { name: 'client_race_start', s1: e.props.mode, ...(e.props.assist && e.props.assist !== 'off' ? { s2: e.props.assist } : {}) };
    case 'purchase_flow': return { name: e.name, s1: e.props.stage, s2: e.props.productId };
    case 'push_open': return { name: e.name, s1: e.props.templateId };
    case 'push_permission': return { name: e.name, value: e.props.granted ? 1 : 0 };
    case 'feature_unlock': return { name: e.name, s1: e.props.feature };
    case 'offer_view': case 'offer_click': return { name: e.name, s1: e.props.offerId, s2: e.props.trigger };
    case 'race_quit': return { name: e.name, s1: e.props.mode, value: e.props.remainingM };
    case 'account_link': return { name: e.name, s1: e.props.provider };
    case 'share': return { name: e.name, s1: e.props.kind };
    case 'invite_share': return { name: e.name, s1: e.props.channel };
    case 'replay_share': return { name: e.name, s1: e.props.surface };
    case 'ad_offer_view': return { name: e.name, s1: e.props.placementId, s2: e.props.surface };
    case 'ad_start': return { name: e.name, s1: e.props.placementId, s2: e.props.surface, s3: e.props.outcome };
    case 'history_view': return { name: e.name, s1: e.props.tab };
    case 'advice_view': return { name: e.name, s1: e.props.context, count: e.props.horses, value: e.props.suggested ? 1 : 0 };
    case 'advice_follow': return { name: e.name, s1: e.props.context, value: e.props.followed ? 1 : 0 };
    case 'photo_take': return { name: e.name, s1: e.props.source, s2: e.props.look };
    case 'photo_share': return { name: e.name, s1: e.props.source, s2: e.props.framed ? 'framed' : 'plain' };
    case 'activity_open': return { name: e.name, value: e.props.unread };
    case 'activity_tap': return { name: e.name, s1: e.props.kind, s2: e.props.screen };
  }
}

export interface KpiLimits { batchesPerMinute: number; eventsPerDay: number; maxPastMs: number; maxFutureMs: number }
export const DEFAULT_KPI_LIMITS: KpiLimits = { batchesPerMinute: 30, eventsPerDay: 2000, maxPastMs: 7 * DAY, maxFutureMs: 5 * 60_000 };

/** abSent: experiments whose ab_assign row was emitted (REQ-UXS-032). */
export interface KpiState { firstOpenSent: boolean; minute: number; batches: number; day: string; events: number; abSent?: string[] }
export function ensureKpi(s: PlayerState): KpiState {
  const x = s as PlayerState & { kpi?: KpiState };
  x.kpi ??= { firstOpenSent: false, minute: 0, batches: 0, day: '', events: 0 };
  return x.kpi;
}

/** REQ-KPI-004: per-player ingestion rate limit. Events outside the accepted time window are dropped, not rejected. */
export function admitClientBatch(s: PlayerState, b: ClientBatch, now: number, limits: KpiLimits = DEFAULT_KPI_LIMITS): ClientEvent[] {
  const k = ensureKpi(s);
  const minute = Math.floor(now / 60_000);
  if (k.minute !== minute) { k.minute = minute; k.batches = 0; }
  const day = jstDateKey(now);
  if (k.day !== day) { k.day = day; k.events = 0; }
  if (k.batches >= limits.batchesPerMinute) throw new AppError('RATE_LIMITED', 'too many analytics batches');
  const fresh = b.events.filter((e) => e.at >= now - limits.maxPastMs && e.at <= now + limits.maxFutureMs);
  if (k.events + fresh.length > limits.eventsPerDay) throw new AppError('RATE_LIMITED', 'daily analytics quota exceeded');
  k.batches += 1;
  k.events += fresh.length;
  return fresh;
}
