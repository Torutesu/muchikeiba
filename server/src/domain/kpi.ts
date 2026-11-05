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
/** Events only the client can observe. Server-known events (purchase, gacha, race results…) are not accepted from clients. */
export const clientEventSchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('session_start'), at: z.number().int(), props: z.object({}).strict().optional() }),
  z.object({ name: z.literal('session_end'), at: z.number().int(), props: z.object({ durationMs: z.number().int().min(0).max(86_400_000) }) }),
  z.object({ name: z.literal('tutorial_step'), at: z.number().int(), props: z.object({ step: str(32), index: z.number().int().min(0).max(100) }) }),
  z.object({ name: z.literal('screen_view'), at: z.number().int(), props: z.object({ screen: str(32) }) }),
  z.object({ name: z.literal('race_start'), at: z.number().int(), props: z.object({ mode: z.enum(['ranked', 'friend', 'tutorial', 'offline', 'time_attack']) }) }),
  z.object({ name: z.literal('purchase_flow'), at: z.number().int(), props: z.object({ stage: z.enum(['open', 'cancel', 'fail', 'store_success']), productId: str(64) }) }),
  z.object({ name: z.literal('push_open'), at: z.number().int(), props: z.object({ templateId: str(32) }) }),
  z.object({ name: z.literal('push_permission'), at: z.number().int(), props: z.object({ granted: z.boolean() }) }),
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
    case 'tutorial_step': return { name: e.name, s1: e.props.step, value: e.props.index };
    case 'screen_view': return { name: e.name, s1: e.props.screen };
    case 'race_start': return { name: 'client_race_start', s1: e.props.mode };
    case 'purchase_flow': return { name: e.name, s1: e.props.stage, s2: e.props.productId };
    case 'push_open': return { name: e.name, s1: e.props.templateId };
    case 'push_permission': return { name: e.name, value: e.props.granted ? 1 : 0 };
  }
}

export interface KpiLimits { batchesPerMinute: number; eventsPerDay: number; maxPastMs: number; maxFutureMs: number }
export const DEFAULT_KPI_LIMITS: KpiLimits = { batchesPerMinute: 30, eventsPerDay: 2000, maxPastMs: 7 * DAY, maxFutureMs: 5 * 60_000 };

export interface KpiState { firstOpenSent: boolean; minute: number; batches: number; day: string; events: number }
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
