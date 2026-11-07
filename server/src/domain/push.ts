/**
 * Push notifications — pure per-player logic (REQ-PUSH-*). No I/O: delivery happens in push/dispatch.ts
 * from the player's Durable Object alarm, so request paths never wait on FCM.
 *
 * State lives on the player (one Durable Object per player = naturally sharded):
 *   devices   registered FCM tokens (several devices per player, oldest-seen dropped beyond maxDevices)
 *   prefs     per-category opt-in, quiet hours (JST)
 *   outbox    queued messages with notBefore / expiry / attempts (retry with backoff)
 *   sent      per-JST-day counter for the daily cap
 */
import { AppError } from './errors.js';
import { PUSH_CATEGORIES, type Master, type PushCategory, type PushTemplate } from './master.js';
import type { PlayerState } from './player.js';
import { dayRule, gameDayKey, jstDateKey, sameGameDay } from './time.js';
import { catalogFor, textIn } from '../i18n/catalog.js';
import { DEFAULT_LOCALE, LOCALES, type Locale } from '../i18n/locale.js';

export type DevicePlatform = 'ios' | 'android';
/** `locale` (REQ-L10N-007): the language the app registered the token with; absent (old records) = Japanese. */
export interface PushDevice { token: string; platform: DevicePlatform; addedAt: number; lastSeenAt: number; locale?: Locale }
export interface QuietHours { startHour: number; endHour: number }
export interface PushPrefs { categories: Record<PushCategory, boolean>; quietHours: QuietHours | null }
export interface OutboxItem {
  id: string; templateId: string; vars: Record<string, string>; category: PushCategory;
  createdAt: number; notBefore: number; expiresAt: number; attempts: number;
  /** Tokens still to deliver (null = every registered device at send time). */
  tokens: string[] | null;
}
export interface PushState {
  devices: PushDevice[];
  prefs: PushPrefs;
  outbox: OutboxItem[];
  sent: { date: string; count: number };
  seq: number;
}

/** What the dispatcher sends to one device. */
export interface PushMessage { title: string; body: string; data: Record<string, string>; ttlSec: number; timeSensitive: boolean }
/**
 * `message` is the Japanese; `messages` holds the message per locale and `tokenLocales` the locale of each token that
 * is not Japanese (REQ-L10N-007). Send each token `messageFor(d, token)`.
 */
export interface DueDelivery { id: string; message: PushMessage; tokens: string[]; messages?: Partial<Record<Locale, PushMessage>>; tokenLocales?: Record<string, Locale> }
export const messageFor = (d: DueDelivery, token: string): PushMessage => d.messages?.[d.tokenLocales?.[token] ?? DEFAULT_LOCALE] ?? d.message;
/** Result of one device send (push/fcm.ts classifies FCM responses into these). */
export type SendKind = 'ok' | 'invalid_token' | 'retry' | 'failed';
export interface SendResult { token: string; kind: SendKind; retryAfterMs?: number }
export interface DeliveryOutcome { id: string; results: SendResult[] }

const HOUR = 3_600_000;
const JST = 9 * HOUR;

export function ensurePush(m: Master, s: PlayerState): PushState {
  const x = s as PlayerState & { push?: PushState };
  x.push ??= {
    devices: [], outbox: [], sent: { date: '', count: 0 }, seq: 0,
    prefs: { categories: { ...m.push.defaults.categories }, quietHours: m.push.defaults.quietHours ? { ...m.push.defaults.quietHours } : null },
  };
  // categories added after the state was stored (REQ-CB-007 `comeback`) take the master default (opt-in = off)
  for (const c of PUSH_CATEGORIES) x.push.prefs.categories[c] ??= m.push.defaults.categories[c] ?? false;
  return x.push;
}

export function render(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
}

/**
 * A template rendered in a locale (REQ-L10N-007): the English template from the master's string table, and the
 * variables the server built in Japanese (「決勝」, 「2026年11月」, master names) translated too. Player-written values
 * (display names, team names) have no entry and are sent as written. `data` keeps the raw variables.
 */
export function renderTemplate(t: PushTemplate, templateId: string, vars: Record<string, string>, locale: Locale = 'ja', m?: Pick<Master, 'locale'>): PushMessage {
  const cat = locale === 'ja' ? null : catalogFor(m ?? {});
  const tx = (x: string) => (cat ? textIn(locale, x, cat) : x);
  const v = cat ? Object.fromEntries(Object.entries(vars).map(([k, x]) => [k, tx(x)])) : vars;
  return {
    title: render(tx(t.title), v), body: render(tx(t.body), v),
    data: { templateId, category: t.category, ...vars, ...(locale === 'ja' ? {} : { locale }) },
    ttlSec: t.ttlSec, timeSensitive: t.timeSensitive,
  };
}

// ---------------------------------------------------------------- quiet hours (JST)

export const jstHour = (ms: number) => Math.floor(((ms + JST) % (24 * HOUR)) / HOUR);

export function inQuietHours(q: QuietHours | null, ms: number): boolean {
  if (!q || q.startHour === q.endHour) return false;
  const h = jstHour(ms);
  return q.startHour > q.endHour ? h >= q.startHour || h < q.endHour : h >= q.startHour && h < q.endHour;
}

/** First instant at or after `ms` when quiet hours are over (the next endHour:00 JST). */
export function quietHoursEnd(q: QuietHours, ms: number): number {
  const dayStart = Math.floor((ms + JST) / (24 * HOUR)) * 24 * HOUR - JST;
  let t = dayStart + q.endHour * HOUR;
  while (t <= ms) t += 24 * HOUR;
  return t;
}

// ---------------------------------------------------------------- devices & preferences

export function registerDevice(m: Master, s: PlayerState, token: string, platform: DevicePlatform, now: number, locale: Locale = DEFAULT_LOCALE) {
  if (token.length < 8 || token.length > 4096) throw new AppError('BAD_REQUEST', 'bad device token');
  const p = ensurePush(m, s);
  const d = p.devices.find((x) => x.token === token);
  if (d) {
    d.platform = platform;
    d.lastSeenAt = now;
    if (locale === DEFAULT_LOCALE) delete d.locale; else d.locale = locale;
  } else {
    p.devices.push({ token, platform, addedAt: now, lastSeenAt: now, ...(locale === DEFAULT_LOCALE ? {} : { locale }) });
    p.devices.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    p.devices.splice(m.push.maxDevices);
  }
  return { devices: p.devices.length };
}

export function unregisterDevice(m: Master, s: PlayerState, token: string) {
  const p = ensurePush(m, s);
  const before = p.devices.length;
  p.devices = p.devices.filter((x) => x.token !== token);
  return { removed: before - p.devices.length, devices: p.devices.length };
}

export interface PrefsPatch { categories?: Partial<Record<PushCategory, boolean>>; quietHours?: QuietHours | null }

export function setPushPrefs(m: Master, s: PlayerState, patch: PrefsPatch, locale: Locale = DEFAULT_LOCALE) {
  const p = ensurePush(m, s);
  for (const [k, v] of Object.entries(patch.categories ?? {})) {
    if (!PUSH_CATEGORIES.includes(k as PushCategory)) throw new AppError('BAD_REQUEST', `unknown category ${k}`);
    p.prefs.categories[k as PushCategory] = v === true;
  }
  if (patch.quietHours !== undefined) {
    const q = patch.quietHours;
    if (q && !([q.startHour, q.endHour].every((h) => Number.isInteger(h) && h >= 0 && h <= 23))) throw new AppError('BAD_REQUEST', 'quiet hours must be 0-23');
    p.prefs.quietHours = q ? { startHour: q.startHour, endHour: q.endHour } : null;
  }
  return pushPrefsView(m, s, locale);
}

/**
 * Preferences plus the FCM topics the app must subscribe to / unsubscribe from (broadcast categories such
 * as season reminders are sent once per topic instead of once per player — REQ-PUSH-006).
 */
/** REQ-L10N-007: the broadcast topic of a category in a locale (`topicsByLocale`, else the Japanese topic). */
export const topicFor = (m: Pick<Master, 'push'>, cat: PushCategory, locale: Locale): string | undefined =>
  locale === DEFAULT_LOCALE ? m.push.topics[cat] : m.push.topicsByLocale?.[locale]?.[cat] ?? m.push.topics[cat];

export function pushPrefsView(m: Master, s: PlayerState, locale: Locale = DEFAULT_LOCALE) {
  const p = ensurePush(m, s);
  const subscribe: string[] = [];
  const unsubscribe: string[] = [];
  for (const cat of Object.keys(m.push.topics) as PushCategory[]) {
    const mine = topicFor(m, cat, locale);
    if (!mine) continue;
    (p.prefs.categories[cat] ? subscribe : unsubscribe).push(mine);
    // the same category in the other languages: never received twice after a language switch
    for (const l of LOCALES) { const t = topicFor(m, cat, l); if (t && t !== mine && !unsubscribe.includes(t)) unsubscribe.push(t); }
  }
  return { categories: p.prefs.categories, quietHours: p.prefs.quietHours, dailyCap: m.push.defaults.dailyCap, devices: p.devices.length, topics: { subscribe, unsubscribe } };
}

// ---------------------------------------------------------------- queueing

export type EnqueueResult = { status: 'queued'; id: string; notBefore: number } | { status: 'skipped'; reason: 'unknown_template' | 'category_off' | 'no_devices' | 'quiet_hours' | 'daily_cap' };

/** REQ-PUSH-003/004: apply preferences, quiet hours and the daily cap, then queue. Never throws for the caller's flow. */
export function enqueuePush(m: Master, s: PlayerState, templateId: string, vars: Record<string, string>, now: number): EnqueueResult {
  const t = m.push.templates[templateId];
  if (!t) return { status: 'skipped', reason: 'unknown_template' };
  const p = ensurePush(m, s);
  if (!p.prefs.categories[t.category]) return { status: 'skipped', reason: 'category_off' };
  if (p.devices.length === 0) return { status: 'skipped', reason: 'no_devices' };
  let notBefore = now;
  if (inQuietHours(p.prefs.quietHours, now)) {
    if (t.timeSensitive) return { status: 'skipped', reason: 'quiet_hours' };
    notBefore = quietHoursEnd(p.prefs.quietHours!, now);
  }
  const day = gameDayKey(notBefore, dayRule(m));
  if (!sameGameDay(p.sent.date, day)) p.sent = { date: day, count: 0 };
  if (p.sent.count >= m.push.defaults.dailyCap) return { status: 'skipped', reason: 'daily_cap' };
  p.sent.count += 1;
  p.seq += 1;
  const id = `${now.toString(36)}-${p.seq}`;
  p.outbox.push({ id, templateId, vars, category: t.category, createdAt: now, notBefore, expiresAt: notBefore + t.ttlSec * 1000, attempts: 0, tokens: null });
  if (p.outbox.length > m.push.maxOutbox) p.outbox.splice(0, p.outbox.length - m.push.maxOutbox);
  return { status: 'queued', id, notBefore };
}

/** Earliest time the outbox needs attention (alarm), or null when empty. */
export function nextPushWake(s: PlayerState): number | null {
  const p = (s as PlayerState & { push?: PushState }).push;
  if (!p || p.outbox.length === 0) return null;
  return Math.min(...p.outbox.map((x) => Math.min(x.notBefore, x.expiresAt)));
}

/** Drops expired items and returns the deliveries due now (the outbox keeps them until settled). */
export function takeDuePushes(m: Master, s: PlayerState, now: number): { due: DueDelivery[]; expired: number; undeliverable: number } {
  const p = ensurePush(m, s);
  const before = p.outbox.length;
  p.outbox = p.outbox.filter((x) => x.expiresAt > now);
  const expired = before - p.outbox.length;
  const all = p.devices.map((d) => d.token);
  const due: DueDelivery[] = [];
  const dead = new Set<string>();
  for (const x of p.outbox) {
    if (x.notBefore > now) continue;
    const t = m.push.templates[x.templateId];
    const tokens = (x.tokens ?? all).filter((tk) => all.includes(tk));
    // A due item with no device left or no template can never be delivered: drop it now, otherwise its
    // past notBefore would re-arm the alarm every second until it expires (up to its TTL).
    if (!t || tokens.length === 0) { dead.add(x.id); continue; }
    const tokenLocales: Record<string, Locale> = {};
    for (const d of p.devices) if (d.locale && d.locale !== DEFAULT_LOCALE && tokens.includes(d.token)) tokenLocales[d.token] = d.locale;
    const used = new Set(Object.values(tokenLocales));
    const delivery: DueDelivery = { id: x.id, message: renderTemplate(t, x.templateId, x.vars), tokens };
    if (used.size > 0) {
      delivery.tokenLocales = tokenLocales;
      delivery.messages = { ja: delivery.message };
      for (const l of used) delivery.messages[l] = renderTemplate(t, x.templateId, x.vars, l, m);
    }
    due.push(delivery);
  }
  if (dead.size > 0) p.outbox = p.outbox.filter((x) => !dead.has(x.id));
  return { due, expired, undeliverable: dead.size };
}

/** REQ-PUSH-005: prune dead tokens, reschedule transient failures with backoff, drop finished items. */
export function settlePushes(m: Master, s: PlayerState, outcomes: DeliveryOutcome[], now: number) {
  const p = ensurePush(m, s);
  const sum = { sent: 0, pruned: 0, retried: 0, dropped: 0 };
  const dead = new Set<string>();
  for (const o of outcomes) {
    const item = p.outbox.find((x) => x.id === o.id);
    if (!item) continue;
    const retry: string[] = [];
    let retryAfter = 0;
    for (const r of o.results) {
      if (r.kind === 'ok') sum.sent++;
      else if (r.kind === 'invalid_token') dead.add(r.token);
      else if (r.kind === 'retry') { retry.push(r.token); retryAfter = Math.max(retryAfter, r.retryAfterMs ?? 0); }
    }
    const handled = new Set(o.results.map((r) => r.token));
    const untouched = (item.tokens ?? []).filter((t) => !handled.has(t));
    const remaining = [...retry, ...untouched];
    if (remaining.length === 0 || (retry.length > 0 && item.attempts + 1 >= m.push.retry.maxAttempts)) {
      if (retry.length > 0) sum.dropped++;
      p.outbox = p.outbox.filter((x) => x !== item);
      continue;
    }
    item.attempts += retry.length > 0 ? 1 : 0;
    const backoff = m.push.retry.backoffMs[Math.min(item.attempts - 1, m.push.retry.backoffMs.length - 1)] ?? 60_000;
    item.notBefore = now + Math.max(backoff, retryAfter);
    item.tokens = remaining;
    sum.retried++;
  }
  if (dead.size > 0) {
    const n = p.devices.length;
    p.devices = p.devices.filter((d) => !dead.has(d.token));
    sum.pruned = n - p.devices.length;
  }
  return { ...sum, pending: p.outbox.length };
}

// ---------------------------------------------------------------- season reminders (broadcast, cron)

const daysInMonth = (y: number, mon: number) => new Date(Date.UTC(y, mon, 0)).getUTCDate();

/** REQ-PUSH-006: which season reminder (if any) the daily noon cron should broadcast today. */
export function seasonReminderFor(m: Master, now: number): { templateId: string; vars: Record<string, string> } | null {
  const [y, mo, d] = jstDateKey(now).split('-').map(Number) as [number, number, number];
  const left = daysInMonth(y, mo) - d;
  const r = m.push.seasonReminders;
  if (r.start && d === 1) return { templateId: 'season_start', vars: { season: `${y}年${mo}月` } };
  if (r.lastDay && left === 0) return { templateId: 'season_last_day', vars: {} };
  if (r.endDaysBefore.includes(left)) return { templateId: 'season_end', vars: { days: String(left) } };
  return null;
}
