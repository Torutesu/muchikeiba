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
import { MAINTENANCE_GROUPS } from './maintenance.js';
import { jstDateKey } from './time.js';
import { NEXT_KINDS, NEXT_SLOTS } from './nextKinds.js';
import { PRACTICE_ID_RE, PRACTICE_RESTARTS } from './practiceKinds.js';
import { LNOTIF_KINDS, LNOTIF_PERMISSION_RESULTS } from './lnotifKinds.js';

/** REQ-LINK-021: how a link reached the app (universal / app link, the custom scheme, the Android install referrer, typed). */
/** REQ-PED-016 (§71): where a pedigree tree / the bloodline list was opened from (C# PedigreeSources / BloodlineSources). */
export const PEDIGREE_SOURCES = ['horse', 'breeding', 'stable', 'showcase', 'bloodlines'] as const;
export const BLOODLINE_SOURCES = ['breeding', 'pedigree', 'help'] as const;
export const DEEP_LINK_ENTRIES = ['universal', 'scheme', 'referrer', 'typed'] as const;
export const DEEP_LINK_KPI_TYPES = ['room', 'cup', 'replay', 'invite', 'friend', 'team', 'help', 'none'] as const;
const PRACTICE_TRACK = z.string().regex(/^[a-z0-9_]{1,64}$/);
const PRACTICE_FIELD = z.number().int().min(2).max(12);
const PRACTICE_STRENGTH = z.string().regex(PRACTICE_ID_RE);

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
export const ADVICE_KPI_CONTEXTS = ['ranked', 'friend', 'event', 'challenge', 'timeattack', 'tutorial', 'cup'] as const;
/** REQ-PHOTO-014: where a photo was taken (photoMode.ts PHOTO_SOURCES). */
export const PHOTO_SOURCE_NAMES = ['paused', 'result', 'replay'] as const;
/** REQ-ACT-015: the activity list's kinds and deep-link screens (domain/activity.ts; repeated here to keep kpi.ts import-free). */
export const ACTIVITY_KIND_NAMES = ['friend_request', 'friend_accepted', 'rival_week', 'rival_record', 'stable_like', 'team_cheer', 'tournament_result', 'gift_arrived', 'team_goal_tier', 'team_goal_week', 'replay_share', 'inquiry_answered', 'cup_invited', 'cup_started', 'cup_finished', 'cup_cancelled', 'recap_ready', 'ops_notice', 'qchat_mention', 'data_export_ready', 'class_promoted', 'new_device'] as const;
export const ACTIVITY_SCREEN_NAMES = ['friends', 'rival', 'stable', 'team_feed', 'tournaments', 'gift_box', 'team_goal', 'replay', 'whats_new', 'help_inquiry', 'cups', 'recap', 'safety', 'privacy', 'devices'] as const;
/** REQ-HELP-021: help categories (domain/help.ts HELP_CATEGORY_IDS) plus `all`, and where an article was opened from. */
export const HELP_CATEGORY_NAMES = ['all', 'getting_started', 'races', 'horses', 'scout', 'purchases', 'account', 'deletion', 'accessibility'] as const;
export const HELP_VIEW_SOURCES = ['list', 'search', 'context', 'link', 'related'] as const;
/**
 * REQ-PERF-015 (protocol §56.9): the device settings and the values each may take (Muchi.Client PerformanceSettings.Apply).
 * They live on the device only, so the change is a client event; the server checks the setting/value pair.
 */
export const PERF_SETTING_VALUES = {
  graphics: ['auto', 'low', 'medium', 'high'], frameRate: ['auto', '30', '60'], batterySaver: ['on', 'off'], dataSaver: ['on', 'off'],
} as const;
export const PERF_SETTINGS = Object.keys(PERF_SETTING_VALUES) as (keyof typeof PERF_SETTING_VALUES)[];
export const PERF_DEVICE_CLASSES = ['low', 'mid', 'high'] as const;
/** REQ-PERF-015: what 「すべてダウンロード」 still had to fetch, in decimal-megabyte buckets (AssetStorage.BytesBucket). */
export const PREDOWNLOAD_BUCKETS = ['lt_10mb', '10_50mb', '50_200mb', '200mb_1gb', 'gte_1gb'] as const;
const perfSettingProps = z.object({
  setting: z.enum(['graphics', 'frameRate', 'batterySaver', 'dataSaver']),
  value: z.enum(['auto', 'low', 'medium', 'high', '30', '60', 'on', 'off']),
  deviceClass: z.enum(PERF_DEVICE_CLASSES),
}).strict().refine((p) => (PERF_SETTING_VALUES[p.setting] as readonly string[]).includes(p.value), { message: 'value is not valid for the setting', path: ['value'] });
/** REQ-TUT-015 (§57): where a tip card was read, and the "?" screens (domain/tips.ts TIP_CONTEXTS; repeated here to keep kpi.ts import-free). */
export const TIP_VIEW_SOURCES = ['list', 'context', 'tour', 'lesson'] as const;
export const TIP_CONTEXT_NAMES = ['gacha_odds', 'breeding', 'training', 'roster_bulk_retire'] as const;
const tipId = z.string().regex(/^[a-z0-9_]{2,40}$/);
/** REQ-SHOW-015 (§62): where a trainer card was opened (the screens of protocol §62.6). */
export const SHOWCASE_SOURCES = ['settings', 'friends', 'rival', 'activity', 'cup_lobby', 'spectate', 'hall', 'stable', 'leaderboard', 'team'] as const;
/** REQ-NEW-019 (§64): the release notes sheet's stages, where a page's target leads, and where the past notes were opened from. */
export const RELEASE_NOTES_STAGES = ['shown', 'finished', 'skipped'] as const;
export const RELEASE_TARGET_KIND_NAMES = ['screen', 'help', 'tip'] as const;
export const RELEASE_HISTORY_SOURCES = ['notices', 'tips', 'sheet'] as const;
const appVersionStr = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
const releasePage = z.number().int().min(1).max(5);
/** REQ-CAL-015 (§65): the calendar's kinds and views (calendar.ts CALENDAR_KINDS; repeated here to keep kpi.ts import-free, a test keeps them equal). */
export const CALENDAR_KPI_KINDS = [
  'event', 'event_exchange', 'weekly_challenge', 'team_goal', 'league_season', 'season', 'season_pass', 'banner',
  'tournament_registration', 'tournament', 'cup', 'maintenance', 'comeback',
] as const;
export const CALENDAR_VIEWS = ['month', 'week'] as const;
/** REQ-HL-015 (§72.5): where a highlight reel was opened and the moment kinds (C# HighlightKinds / AnalyticsEvent.HighlightSurfaces, a test keeps them equal). */
export const HIGHLIGHT_SURFACES = ['result', 'my_replays', 'friend_replay', 'link'] as const;
export const HIGHLIGHT_KINDS = ['photo_finish', 'near_miss', 'lead_change', 'whip_burst', 'comeback', 'unique_skill', 'finish'] as const;
/** REQ-CHEER-013: the watchable modes (domain/cheer.ts CHEER_MODES; repeated here to keep kpi.ts import-free). */
export const CHEER_KPI_MODES = ['friend', 'cup', 'ranked', 'event', 'tournament'] as const;
/** Events only the client can observe. Server-known events (purchase, gacha, race results…) are not accepted from clients. */
/** §67.8: `session`, `daily`, `quiet_after` in sheet order, comma-joined (selfLimits.ts PLAYTIME_REASONS). */
const PLAYTIME_REASONS_RE = /^(quiet_after|daily|session)(,(daily|session)){0,2}$/;
const playMin = z.number().int().min(0).max(1440).refine((n) => n % 5 === 0, 'rounded to 5 minutes');
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
  // REQ-ORG-013: the roster organiser's sort or filters changed (sort key + number of filters in use)
  z.object({ name: z.literal('roster_sort'), at: z.number().int(), props: z.object({ sort: z.enum(['rating', 'aptitude', 'age', 'acquired', 'races', 'rarity', 'name']), filters: z.number().int().min(0).max(10) }).strict() }),
  // REQ-RECAP-015: a recap share card handed to the OS share sheet (`hideRank`: the player chose 「順位を隠す」)
  z.object({ name: z.literal('recap_share'), at: z.number().int(), props: z.object({ kind: z.enum(['season', 'year']), card: z.enum(['summary', 'horse', 'moment', 'rank']), hideRank: z.boolean() }).strict() }),
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
  // REQ-MNT-013 (§46): the client met a maintenance window (once per window and endpoint group) / showed or acted on an update prompt
  z.object({ name: z.literal('maintenance_block'), at: z.number().int(), props: z.object({ group: z.enum(MAINTENANCE_GROUPS), windowId: z.string().regex(/^[a-z0-9_-]{1,40}$/) }).strict() }),
  z.object({ name: z.literal('upgrade_prompt'), at: z.number().int(), props: z.object({ kind: z.enum(['required', 'recommended', 'engine']), action: z.enum(['shown', 'store', 'later']), platform: z.enum(['ios', 'android', 'other']) }).strict() }),
  z.object({ name: z.literal('activity_open'), at: z.number().int(), props: z.object({ unread: z.number().int().min(0).max(999) }).strict() }),
  z.object({ name: z.literal('activity_tap'), at: z.number().int(), props: z.object({ kind: z.enum(ACTIVITY_KIND_NAMES), screen: z.enum(ACTIVITY_SCREEN_NAMES) }).strict() }),
  // REQ-NEXT-012: the home's 次にやること card shown (once per kind and game day) / tapped. Closing it is the server event next_card_dismiss.
  z.object({ name: z.literal('next_card_view'), at: z.number().int(), props: z.object({ kind: z.enum(NEXT_KINDS), slot: z.enum(NEXT_SLOTS) }).strict() }),
  z.object({ name: z.literal('next_card_tap'), at: z.number().int(), props: z.object({ kind: z.enum(NEXT_KINDS), slot: z.enum(NEXT_SLOTS) }).strict() }),
  // REQ-HELP-021: a help search (the normalised length, the category and the number of results — never the query) /
  // an article opened (its id and where it was opened from)
  z.object({ name: z.literal('help_search'), at: z.number().int(), props: z.object({ length: z.number().int().min(1).max(64), category: z.enum(HELP_CATEGORY_NAMES), results: z.number().int().min(0).max(100) }).strict() }),
  z.object({ name: z.literal('help_article_view'), at: z.number().int(), props: z.object({ articleId: z.string().regex(/^[a-z0-9_]{2,40}$/), source: z.enum(HELP_VIEW_SOURCES) }).strict() }),
  // REQ-FSUG-014: the おすすめフレンド section was shown (once per screen visit; how many suggestions it held)
  z.object({ name: z.literal('fsug_view'), at: z.number().int(), props: z.object({ shown: z.number().int().min(0).max(30) }).strict() }),
  // REQ-HGOAL-012: a horse's goal panel was opened (detail) / the pinned goal was shown on the home (once per game day); done = goals done
  z.object({ name: z.literal('hgoal_view'), at: z.number().int(), props: z.object({ surface: z.enum(['detail', 'home']), done: z.number().int().min(0).max(8) }).strict() }),
  // REQ-LNOTIF-013 (§61.6): a local notification newly scheduled / opened from the notification; the OS permission answer (or the pre-prompt's later)
  z.object({ name: z.literal('lnotif_scheduled'), at: z.number().int(), props: z.object({ kind: z.enum(LNOTIF_KINDS) }).strict() }),
  z.object({ name: z.literal('lnotif_opened'), at: z.number().int(), props: z.object({ kind: z.enum(LNOTIF_KINDS) }).strict() }),
  z.object({ name: z.literal('lnotif_permission'), at: z.number().int(), props: z.object({ result: z.enum(LNOTIF_PERMISSION_RESULTS) }).strict() }),
  // REQ-PRAC-015 (§50.10): a practice race started / finished on the device. Course, field size and strength only — no inputs,
  // ticks, seed or times (strict). Optional, and it grants nothing: ingestion never touches rewards or records.
  z.object({ name: z.literal('practice_start'), at: z.number().int(), props: z.object({ trackId: PRACTICE_TRACK, fieldSize: PRACTICE_FIELD, strength: PRACTICE_STRENGTH, restart: z.enum(PRACTICE_RESTARTS) }).strict() }),
  z.object({ name: z.literal('practice_finish'), at: z.number().int(), props: z.object({ trackId: PRACTICE_TRACK, fieldSize: PRACTICE_FIELD, strength: PRACTICE_STRENGTH, place: z.number().int().min(0).max(12) }).strict() }),
  // REQ-PERF-015 (§56.9): a device setting changed by the player / 「すべてダウンロード」 started (size bucket, version)
  z.object({ name: z.literal('perf_setting_change'), at: z.number().int(), props: perfSettingProps }),
  z.object({ name: z.literal('asset_predownload'), at: z.number().int(), props: z.object({ bucket: z.enum(PREDOWNLOAD_BUCKETS), variant: z.enum(['full', 'low']) }).strict() }),
  // REQ-TUT-015: a replay started / finished on the device (which one: its id and kind; a replay never reaches the server
  // otherwise), a card read (its id and where), and a screen's "?" button (the screen and the card it opened)
  z.object({ name: z.literal('tutorial_replay'), at: z.number().int(), props: z.object({ tutorialId: tipId, kind: z.enum(['race', 'tour']), stage: z.enum(['start', 'finish']) }).strict() }),
  z.object({ name: z.literal('tip_view'), at: z.number().int(), props: z.object({ tipId, source: z.enum(TIP_VIEW_SOURCES) }).strict() }),
  z.object({ name: z.literal('tip_context_open'), at: z.number().int(), props: z.object({ context: z.enum(TIP_CONTEXT_NAMES), tipId }).strict() }),
  // REQ-NEW-019 (§64): the what's-new sheet (shown / read to the end / closed early, on which page of how many), a page's
  // target tapped (its kind and id), and the past notes list opened (from お知らせ, ヒント or the sheet's last page)
  z.object({ name: z.literal('release_notes_view'), at: z.number().int(), props: z.object({ appVersion: appVersionStr, stage: z.enum(RELEASE_NOTES_STAGES), page: releasePage, pages: releasePage }).strict().refine((p) => p.page <= p.pages, { message: 'page is past the last page', path: ['page'] }) }),
  z.object({ name: z.literal('release_notes_target'), at: z.number().int(), props: z.object({ appVersion: appVersionStr, page: releasePage, kind: z.enum(RELEASE_TARGET_KIND_NAMES), target: tipId }).strict() }),
  z.object({ name: z.literal('release_notes_history'), at: z.number().int(), props: z.object({ source: z.enum(RELEASE_HISTORY_SOURCES) }).strict() }),
  // REQ-CAL-015 (§65): the calendar shown (month / week and how many rows) and a row opened (its kind). Marks are server events (calendar_mark).
  z.object({ name: z.literal('calendar_view'), at: z.number().int(), props: z.object({ view: z.enum(CALENDAR_VIEWS), entries: z.number().int().min(0).max(200) }).strict() }),
  // REQ-DEV-016 (§70.9): ログイン中の端末 / セキュリティの記録 opened (how many rows). Sign-outs and new-device notices are server events.
  z.object({ name: z.literal('device_list_view'), at: z.number().int(), props: z.object({ screen: z.enum(['devices', 'log']), count: z.number().int().min(0).max(200) }).strict() }),
  z.object({ name: z.literal('calendar_entry_open'), at: z.number().int(), props: z.object({ kind: z.enum(CALENDAR_KPI_KINDS) }).strict() }),
  // REQ-HL-015 (§72.5): the highlight reel started (surface, the top moment's kind, how many) / handed to the OS share sheet
  // (card image or replay link). No race, player or tick.
  z.object({ name: z.literal('highlight_view'), at: z.number().int(), props: z.object({ surface: z.enum(HIGHLIGHT_SURFACES), top: z.enum(HIGHLIGHT_KINDS), moments: z.number().int().min(1).max(3) }).strict() }),
  z.object({ name: z.literal('highlight_share'), at: z.number().int(), props: z.object({ surface: z.enum(HIGHLIGHT_SURFACES), via: z.enum(['card', 'link']) }).strict() }),
  // REQ-CHEER-013 (§55.7): ONE row per race, never per tap — cheers this spectator sent / cheers shown to this player (racer
  // with the indicator on, or spectator) in that race. No horse, no target player, no sender ids.
  z.object({ name: z.literal('cheer_send'), at: z.number().int(), props: z.object({ mode: z.enum(CHEER_KPI_MODES), count: z.number().int().min(1).max(1000) }).strict() }),
  z.object({ name: z.literal('cheer_seen'), at: z.number().int(), props: z.object({ mode: z.enum(CHEER_KPI_MODES), role: z.enum(['racer', 'spectator']), count: z.number().int().min(1).max(100_000) }).strict() }),
  // REQ-SHOW-015 (§62): a trainer card was opened (where from, whose: self / friend / other, neutral or not) / its image
  // handed to the OS share sheet (how many pins and records it showed). Never the other player's id.
  z.object({ name: z.literal('showcase_view'), at: z.number().int(), props: z.object({ source: z.enum(SHOWCASE_SOURCES), relation: z.enum(['self', 'friend', 'other']), neutral: z.boolean() }).strict() }),
  z.object({ name: z.literal('showcase_share'), at: z.number().int(), props: z.object({ pins: z.number().int().min(0).max(3), records: z.number().int().min(0).max(4), horse: z.boolean() }).strict() }),
  // REQ-LINK-021 (§63.9): a link reached the app — how it arrived and its type once resolved (`none` when it did not open).
  // Never the token, the target or any id (strict).
  z.object({ name: z.literal('deep_link_open'), at: z.number().int(), props: z.object({ entry: z.enum(DEEP_LINK_ENTRIES), type: z.enum(DEEP_LINK_KPI_TYPES) }).strict() }),
  // REQ-LIMIT-016 (§67.8): the play-time reminder sheet was shown — why (sheet order, comma-joined), the minutes rounded to 5
  // (never the exact play time) and how the player answered. Optional; nothing is granted or taken either way.
  z.object({ name: z.literal('playtime_reminder_shown'), at: z.number().int(), props: z.object({
    reasons: z.string().regex(PLAYTIME_REASONS_RE), sessionMin: playMin, dayMin: playMin, choice: z.enum(['continue', 'stop', 'settings']),
  }).strict() }),
  // REQ-PED-016 (§71): a pedigree tree opened (where from, whose, how many shared ancestors it highlighted) / the bloodline list
  // opened (where from, how many lines). Never a player or horse id (strict).
  z.object({ name: z.literal('pedigree_view'), at: z.number().int(), props: z.object({ source: z.enum(PEDIGREE_SOURCES), relation: z.enum(['self', 'friend', 'other']), shared: z.number().int().min(0).max(14) }).strict() }),
  z.object({ name: z.literal('bloodline_view'), at: z.number().int(), props: z.object({ source: z.enum(BLOODLINE_SOURCES), lines: z.number().int().min(0).max(64) }).strict() }),
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
    case 'roster_sort': return { name: e.name, s1: e.props.sort, value: e.props.filters };
    case 'recap_share': return { name: e.name, s1: e.props.kind, s2: e.props.card, s3: e.props.hideRank ? 'hide_rank' : 'show_rank' };
    case 'ad_offer_view': return { name: e.name, s1: e.props.placementId, s2: e.props.surface };
    case 'ad_start': return { name: e.name, s1: e.props.placementId, s2: e.props.surface, s3: e.props.outcome };
    case 'history_view': return { name: e.name, s1: e.props.tab };
    case 'advice_view': return { name: e.name, s1: e.props.context, count: e.props.horses, value: e.props.suggested ? 1 : 0 };
    case 'advice_follow': return { name: e.name, s1: e.props.context, value: e.props.followed ? 1 : 0 };
    case 'photo_take': return { name: e.name, s1: e.props.source, s2: e.props.look };
    case 'photo_share': return { name: e.name, s1: e.props.source, s2: e.props.framed ? 'framed' : 'plain' };
    case 'activity_open': return { name: e.name, value: e.props.unread };
    case 'maintenance_block': return { name: e.name, s1: e.props.group, s2: e.props.windowId };
    case 'upgrade_prompt': return { name: e.name, s1: e.props.kind, s2: e.props.action, s3: e.props.platform };
    case 'activity_tap': return { name: e.name, s1: e.props.kind, s2: e.props.screen };
    case 'practice_start': return { name: e.name, s1: e.props.trackId, s2: e.props.strength, s3: e.props.restart, count: e.props.fieldSize };
    case 'practice_finish': return { name: e.name, s1: e.props.trackId, s2: e.props.strength, count: e.props.fieldSize, place: e.props.place };
    case 'next_card_view': case 'next_card_tap': return { name: e.name, s1: e.props.kind, s2: e.props.slot };
    case 'help_search': return { name: e.name, s1: e.props.category, value: e.props.length, count: e.props.results };
    case 'help_article_view': return { name: e.name, s1: e.props.articleId, s2: e.props.source };
    case 'fsug_view': return { name: e.name, value: e.props.shown };
    case 'hgoal_view': return { name: e.name, s1: e.props.surface, value: e.props.done };
    case 'perf_setting_change': return { name: e.name, s1: e.props.setting, s2: e.props.value, s3: e.props.deviceClass };
    case 'asset_predownload': return { name: e.name, s1: e.props.bucket, s2: e.props.variant };
    case 'tutorial_replay': return { name: e.name, s1: e.props.tutorialId, s2: e.props.kind, s3: e.props.stage };
    case 'tip_view': return { name: e.name, s1: e.props.tipId, s2: e.props.source };
    case 'tip_context_open': return { name: e.name, s1: e.props.context, s2: e.props.tipId };
    case 'release_notes_view': return { name: e.name, s1: e.props.appVersion, s2: e.props.stage, value: e.props.page, count: e.props.pages };
    case 'release_notes_target': return { name: e.name, s1: e.props.appVersion, s2: e.props.kind, s3: e.props.target, value: e.props.page };
    case 'release_notes_history': return { name: e.name, s1: e.props.source };
    case 'calendar_view': return { name: e.name, s1: e.props.view, value: e.props.entries };
    case 'device_list_view': return { name: e.name, s1: e.props.screen, value: e.props.count };
    case 'calendar_entry_open': return { name: e.name, s1: e.props.kind };
    case 'highlight_view': return { name: e.name, s1: e.props.surface, s2: e.props.top, value: e.props.moments };
    case 'highlight_share': return { name: e.name, s1: e.props.surface, s2: e.props.via };
    case 'cheer_send': return { name: e.name, s1: e.props.mode, count: e.props.count };
    case 'cheer_seen': return { name: e.name, s1: e.props.mode, s2: e.props.role, count: e.props.count };
    case 'lnotif_scheduled': case 'lnotif_opened': return { name: e.name, s1: e.props.kind };
    case 'lnotif_permission': return { name: e.name, s1: e.props.result };
    case 'showcase_view': return { name: e.name, s1: e.props.source, s2: e.props.relation, s3: e.props.neutral ? 'neutral' : 'card' };
    case 'showcase_share': return { name: e.name, count: e.props.pins, value: e.props.records, s1: e.props.horse ? 'horse' : 'none' };
    case 'deep_link_open': return { name: e.name, s1: e.props.entry, s2: e.props.type };
    case 'playtime_reminder_shown': return { name: e.name, s1: e.props.reasons, s2: e.props.choice, value: e.props.sessionMin, count: e.props.dayMin };
    case 'pedigree_view': return { name: e.name, s1: e.props.source, s2: e.props.relation, count: e.props.shared };
    case 'bloodline_view': return { name: e.name, s1: e.props.source, value: e.props.lines };
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
