/**
 * メンテナンス・強制アップデート (REQ-MNT-001..016, contracts/protocol.md §46).
 *
 * Remote-config driven (bundle key `maintenance`, validated in ops/config.ts like every other section):
 *   - maintenance windows: start / end (stored as epoch ms, entered and shown in JST), a scope (`all` or endpoint groups
 *     such as gacha / shop / ranked / teams) and a message in Japanese and English;
 *   - the client version gate: minimum supported and recommended version per platform (iOS / Android) with the store URL,
 *     and the minimum lockstep engine level (the race handshake, §4 `hello.engine`).
 *
 * The gate runs once at the entry of a request (http/app.ts handle): a request that passed it always completes — nothing
 * is cut mid-transaction. Some routes are never gated (EXEMPT): store receipts and store server notifications (資金決済法:
 * a paid coin purchase that was started is always granted), the rewarded-ad callback, account deletion, the race socket
 * and result submissions of runs already under way (in-flight races settle), and the status endpoints themselves.
 */
import { z } from 'zod';
import { AppError } from './errors.js';
import { bettingWordsIn } from './bettingWords.js';

/**
 * The shop wording rules for a player-facing message (docs/planning/03). Same list as commentaryPacks PACK_LEGAL_WORDS_JA
 * (a test keeps them equal; not imported, so kpi.ts → maintenance.ts stays free of the wallet / collection imports).
 */
export const LEGAL_WORDS_JA: readonly string[] = ['倍', 'お得', '今だけ', '残りわずか', '通常価格'];

// cups: Round 16 hosted cups (/v1/cups*), a race group of their own (Round 17 integration). Roster, recap and the home's
// next card are `core` (closed only by `all`).
export const MAINTENANCE_GROUPS = ['gacha', 'shop', 'ranked', 'teams', 'events', 'tournaments', 'training', 'time_attack', 'social', 'cups', 'core'] as const;
export type MaintenanceGroup = typeof MAINTENANCE_GROUPS[number];
/** Groups a window may name (`core` = everything not in another group; only `all` closes it). */
export const SCOPE_GROUPS = MAINTENANCE_GROUPS.filter((g) => g !== 'core') as Exclude<MaintenanceGroup, 'core'>[];
export const CLIENT_PLATFORMS = ['ios', 'android'] as const;
export type ClientPlatform = typeof CLIENT_PLATFORMS[number];

export const MAINTENANCE_LIMITS = {
  maxWindows: 20,
  minMinutes: 5,
  maxHours: 24,
  /** Default announcement lead when a window has no announceAtMs (shown in-game this long before the start). */
  defaultAnnounceHours: 24,
  maxAnnounceDays: 14,
  messageMax: 200,
  /** Hosts a store URL may point to (an update button never leads anywhere else). */
  storeHosts: ['apps.apple.com', 'itunes.apple.com', 'play.google.com'] as readonly string[],
  maxEngineLevel: 1000,
} as const;

/** The lockstep engine level this server speaks (C# `EngineInfo.Level`). Bumped together when the race math changes shape. */
export const ENGINE_LEVEL = 1;

const int = z.number().int();
const semver = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
const text = (max: number) => z.string().trim().min(1).max(max);

export const maintenanceWindowSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  startAtMs: int.min(0),
  endAtMs: int.min(0),
  /** Shown in-game (what's new, the home banner, GET /v1/maintenance `upcoming`) from this time. Default: start − 24 h. */
  announceAtMs: int.min(0).optional(),
  scope: z.union([z.literal('all'), z.array(z.enum(SCOPE_GROUPS as [string, ...string[]])).min(1).max(SCOPE_GROUPS.length)]),
  message: z.object({ ja: text(MAINTENANCE_LIMITS.messageMax), en: text(MAINTENANCE_LIMITS.messageMax * 2) }).strict(),
  /** Cancelled (or ended early) by ops at this time: from then on the window is not active and not announced. */
  cancelledAtMs: int.min(0).optional(),
}).strict();
export type MaintenanceWindow = z.infer<typeof maintenanceWindowSchema>;

const platformVersionSchema = z.object({
  min: semver,
  recommended: semver,
  /** The store page the update button opens. Required once `min` is above 0.0.0. */
  storeUrl: z.string().url().max(300).nullable(),
}).strict();
export type PlatformVersion = z.infer<typeof platformVersionSchema>;

export const maintenanceConfigSchema = z.object({
  windows: z.array(maintenanceWindowSchema).max(MAINTENANCE_LIMITS.maxWindows),
  clientVersions: z.object({ ios: platformVersionSchema, android: platformVersionSchema }).strict(),
  /** Requests carrying a lower `x-engine-level` (race groups) and race sockets with a lower `hello.engine` are refused. */
  minEngineLevel: int.min(1).max(MAINTENANCE_LIMITS.maxEngineLevel),
}).strict();
export type MaintenanceConfig = z.infer<typeof maintenanceConfigSchema>;

export const DEFAULT_MAINTENANCE: MaintenanceConfig = {
  windows: [],
  clientVersions: { ios: { min: '0.0.0', recommended: '0.0.0', storeUrl: null }, android: { min: '0.0.0', recommended: '0.0.0', storeUrl: null } },
  minEngineLevel: 1,
};

export const maintenanceOf = (m: { maintenance?: MaintenanceConfig }): MaintenanceConfig => m.maintenance ?? DEFAULT_MAINTENANCE;

// ----------------------------------------------------------------------------------------------- versions

/** `1.2.10` → [1, 2, 10]; null when not x.y.z. */
export function parseVersion(v: string | null | undefined): [number, number, number] | null {
  const m = v ? /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(v.trim()) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
/** Numeric x.y.z compare (`1.10.0` > `1.9.9`). Unparseable sorts lowest. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a) ?? [-1, -1, -1], y = parseVersion(b) ?? [-1, -1, -1];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

// ----------------------------------------------------------------------------------------------- validation

const JST_MS = 9 * 3600_000;
/** `2026-11-12T02:00` (JST, minutes) → epoch ms; null when malformed. */
export function jstToMs(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!) - JST_MS;
  return Number.isFinite(ms) && msToJst(ms) === s ? ms : null;
}
/** epoch ms → `2026-11-12T02:00` (JST). */
export const msToJst = (ms: number) => new Date(ms + JST_MS).toISOString().slice(0, 16);
/** epoch ms → `11/12 02:00` (JST, what the screens print). */
export const shortJst = (ms: number) => { const s = msToJst(ms); return `${s.slice(5, 7)}/${s.slice(8, 10)} ${s.slice(11, 16)}`; };

export const announceAt = (w: MaintenanceWindow) => w.announceAtMs ?? w.startAtMs - MAINTENANCE_LIMITS.defaultAnnounceHours * 3600_000;
/** When the window really stops blocking (its end, or an earlier cancellation). */
export const effectiveEnd = (w: MaintenanceWindow) => (w.cancelledAtMs !== undefined ? Math.min(w.endAtMs, w.cancelledAtMs) : w.endAtMs);

/** Every problem of a maintenance section (empty = valid). Run at boot (defaults) and on every remote config version. */
export function maintenanceProblems(raw: unknown): string[] {
  const r = maintenanceConfigSchema.safeParse(raw);
  if (!r.success) return r.error.issues.map((i) => `maintenance.${i.path.join('.')}: ${i.message}`);
  const c = r.data;
  const out: string[] = [];
  const ids = new Set<string>();
  for (const w of c.windows) {
    const at = `maintenance.windows[${w.id}]`;
    if (ids.has(w.id)) out.push(`${at}: duplicate id`);
    ids.add(w.id);
    const minutes = (w.endAtMs - w.startAtMs) / 60_000;
    if (w.endAtMs <= w.startAtMs) out.push(`${at}: endAtMs must be after startAtMs`);
    else if (minutes < MAINTENANCE_LIMITS.minMinutes) out.push(`${at}: shorter than ${MAINTENANCE_LIMITS.minMinutes} minutes`);
    else if (minutes > MAINTENANCE_LIMITS.maxHours * 60) out.push(`${at}: longer than ${MAINTENANCE_LIMITS.maxHours} hours`);
    if (w.announceAtMs !== undefined) {
      if (w.announceAtMs > w.startAtMs) out.push(`${at}: announceAtMs must not be after startAtMs`);
      if (w.startAtMs - w.announceAtMs > MAINTENANCE_LIMITS.maxAnnounceDays * 86_400_000) out.push(`${at}: announced more than ${MAINTENANCE_LIMITS.maxAnnounceDays} days ahead`);
    }
    if (Array.isArray(w.scope) && new Set(w.scope).size !== w.scope.length) out.push(`${at}: duplicate scope group`);
    // the player-facing message follows the shop / betting wording rules (docs/planning/03); English is checked by the locale lint
    for (const word of LEGAL_WORDS_JA) if (w.message.ja.includes(word)) out.push(`${at}: message uses 「${word}」`);
    for (const word of bettingWordsIn(w.message.ja + ' ' + w.message.en)) out.push(`${at}: message uses a betting word (${word})`);
  }
  // one clear error at a time: windows may not overlap (a cancelled window ends at its cancellation)
  const live = c.windows.filter((w) => effectiveEnd(w) > w.startAtMs).sort((a, b) => a.startAtMs - b.startAtMs);
  for (let i = 1; i < live.length; i++) {
    if (live[i]!.startAtMs < effectiveEnd(live[i - 1]!)) out.push(`maintenance.windows[${live[i]!.id}]: overlaps ${live[i - 1]!.id}`);
  }
  for (const p of CLIENT_PLATFORMS) {
    const v = c.clientVersions[p];
    const at = `maintenance.clientVersions.${p}`;
    if (compareVersions(v.recommended, v.min) < 0) out.push(`${at}: recommended ${v.recommended} is below min ${v.min}`);
    const gated = compareVersions(v.recommended, '0.0.0') > 0;
    if (gated && !v.storeUrl) out.push(`${at}: storeUrl is required when a version is set`);
    if (v.storeUrl) {
      let host = '';
      try { const u = new URL(v.storeUrl); host = u.protocol === 'https:' ? u.hostname : ''; } catch { /* reported below */ }
      if (!MAINTENANCE_LIMITS.storeHosts.includes(host)) out.push(`${at}: storeUrl must be an https link to ${MAINTENANCE_LIMITS.storeHosts.join(' / ')}`);
      if (p === 'ios' && host === 'play.google.com') out.push(`${at}: storeUrl points to Google Play`);
      if (p === 'android' && host !== 'play.google.com' && host !== '') out.push(`${at}: storeUrl points to the App Store`);
    }
  }
  return out;
}

/** The English for each window message, keyed by the Japanese (merged into the locale table by ops/config.ts). */
export function maintenanceLocale(c: MaintenanceConfig): Record<string, string> {
  return Object.fromEntries(c.windows.map((w) => [w.message.ja, w.message.en]));
}

// ----------------------------------------------------------------------------------------------- endpoint groups

/**
 * Routes that are never gated (neither maintenance nor the version gate), as `METHOD path-pattern`:
 *   - status / bootstrap reads the maintenance and update screens need;
 *   - POST /v1/shop/purchase (store receipts) and store server notifications: a purchase already paid in the store is
 *     always granted (資金決済法), also from an outdated app; GET /v1/shop/store-account (the token the receipt carries);
 *   - the rewarded-ad server callback (the view already happened);
 *   - account deletion and its cancellation, and the personal data export (§51: request, status, download) — legal rights, never closed;
 *   - in-flight runs settle: the race socket, and the result submissions of time attack / weekly challenge /
 *     training sessions that were started before the window; leaving a queue (match / event cancel);
 *   - the KPI ingest (maintenance_block / upgrade_prompt are reported through it) and the purchase history;
 *   - the ad / analytics choices (§58: GET/PUT /v1/privacy/choices, PUT /v1/privacy/platform, POST /v1/privacy/prompt-shown);
 *   - client error reports (§60).
 */
export const EXEMPT_ROUTES: readonly string[] = [
  'GET /v1/health', 'GET /v1/config', 'GET /v1/maintenance', 'GET /v1/assets/catalog', 'GET /v1/visuals',
  'POST /v1/shop/purchase', 'GET /v1/shop/store-account', 'POST /v1/store/notifications/:platform',
  'GET /v1/ads/ssv/admob',
  'DELETE /v1/player', 'POST /v1/player/deletion/cancel',
  'GET /v1/race/:raceId/ws',
  'POST /v1/time-attack/submit', 'POST /v1/challenges/weekly/submit', 'POST /v1/training/:sessionId/finish',
  // Round 22 (§66, REQ-CAREER-014): a 騎手の道 run already raced on the device settles like the weekly challenge's
  'POST /v1/career/submit',
  'POST /v1/match/cancel', 'POST /v1/events/:eventId/cancel',
  'POST /v1/analytics/events',
  'GET /v1/history/summary', 'GET /v1/history/:kind', 'POST /v1/history/support-ticket',
  // Round 17 integration: support stays reachable during any window and from an outdated app — the help center (articles,
  // search, inquiries: how players reach support), reports and the block list (safety). An article vote is not support.
  'GET /v1/help', 'GET /v1/help/articles/:articleId', 'GET /v1/help/search',
  'GET /v1/help/inquiries', 'GET /v1/help/inquiries/:ticketId', 'POST /v1/help/inquiries', 'POST /v1/help/inquiries/:ticketId/read',
  'GET /v1/reports/options', 'POST /v1/reports', 'GET /v1/blocks', 'PUT /v1/blocks/:playerId', 'DELETE /v1/blocks/:playerId',
  // Round 18 integration: the personal data export (§51) is a legal right like the account deletion — asking for it, its
  // status and the signed download stay open in any window and from an outdated app (the build runs in the player's alarm)
  'GET /v1/player/data-export', 'POST /v1/player/data-export', 'GET /v1/data-export/file',
  // Round 19 (§54, REQ-TRF-016): 引き継ぎコード is account access like sign-in and deletion — a player changing phones is
  // never locked out by a window or an old app. It moves no coins; ops stop it with progression.transfer.enabled.
  'GET /v1/transfer/code', 'POST /v1/transfer/code', 'DELETE /v1/transfer/code', 'POST /v1/transfer/redeem',
  // Round 20 (§58, REQ-CNS-015): the ad / analytics choices are a privacy right like the data export — withdrawing consent
  // must work in any window and from an outdated app
  'GET /v1/privacy/choices', 'PUT /v1/privacy/choices', 'PUT /v1/privacy/platform', 'POST /v1/privacy/prompt-shown',
  // R20 integration (§46.2, REQ-UXS-001): the terms / privacy policy consent is the same kind of privacy right — it was
  // falling into `core`, so a player asked to re-consent after a policy update was locked out by an `all` window
  'POST /v1/player/consent',
  // Round 20 (§60, REQ-CERR-004): client error reports — an outdated app's crashes are the ones ops most needs to see
  'POST /v1/client-errors',
];

const PREFIX_GROUPS: [string, MaintenanceGroup][] = [
  ['/v1/gacha', 'gacha'], ['/v1/items', 'gacha'],
  ['/v1/shop', 'shop'], ['/v1/silks/parts', 'shop'], ['/v1/commentary/packs', 'shop'],
  ['/v1/match', 'ranked'], ['/v1/friend-rooms', 'ranked'], ['/v1/race', 'ranked'], ['/v1/races', 'ranked'],
  ['/v1/teams', 'teams'], ['/v1/league', 'teams'], ['/v1/stamps', 'teams'],
  ['/v1/events', 'events'],
  ['/v1/tournaments', 'tournaments'],
  ['/v1/training', 'training'],
  ['/v1/time-attack', 'time_attack'], ['/v1/challenges', 'time_attack'], ['/v1/career', 'time_attack'], // §66: verified solo races
  ['/v1/friends', 'social'], ['/v1/invite', 'social'], ['/v1/stable', 'social'], ['/v1/rival', 'social'],
  ['/v1/cups', 'cups'],
];

function patternMatch(path: string, pattern: string): boolean {
  const a = path.split('/'), b = pattern.split('/');
  return a.length === b.length && b.every((seg, i) => (seg.startsWith(':') ? a[i] !== '' : seg === a[i]));
}
export function isExempt(method: string, path: string): boolean {
  return EXEMPT_ROUTES.some((r) => { const i = r.indexOf(' '); return r.slice(0, i) === method && patternMatch(path, r.slice(i + 1)); });
}
/** The endpoint group of a request path (KPI `maintenance_block` s1 and the window scope). */
export function endpointGroup(path: string): MaintenanceGroup {
  for (const [prefix, g] of PREFIX_GROUPS) if (path === prefix || path.startsWith(`${prefix}/`)) return g;
  return 'core';
}
/** Groups that run lockstep / verified races (the engine-level gate applies to them). */
export const RACE_GROUPS: readonly MaintenanceGroup[] = ['ranked', 'events', 'tournaments', 'time_attack', 'cups'];

// ----------------------------------------------------------------------------------------------- the gate

export const windowCovers = (w: MaintenanceWindow, g: MaintenanceGroup) => w.scope === 'all' || (g !== 'core' && (w.scope as string[]).includes(g));
export const isActive = (w: MaintenanceWindow, now: number) => w.startAtMs <= now && now < effectiveEnd(w);
export function activeWindowFor(c: MaintenanceConfig, g: MaintenanceGroup, now: number): MaintenanceWindow | null {
  return c.windows.find((w) => isActive(w, now) && windowCovers(w, g)) ?? null;
}

export const MAINTENANCE_TEXT = 'メンテナンス中です';
export const MAINTENANCE_NEWS_TITLE = 'メンテナンスのお知らせ';
export const UPGRADE_TEXT = 'アプリを最新版に更新してください';
export const ENGINE_UPGRADE_TEXT = 'レースに参加するにはアプリの更新が必要です';

export interface ClientHeaders { platform: string | null; version: string | null; engine: number | null }
export function clientHeaders(h: { get(name: string): string | null }): ClientHeaders {
  const e = h.get('x-engine-level');
  const engine = e !== null && /^\d{1,4}$/.test(e) ? Number(e) : null;
  return { platform: h.get('x-client-platform')?.toLowerCase() ?? null, version: h.get('x-client-version'), engine };
}

export type ClientStatus = 'ok' | 'recommended' | 'required' | 'unknown';
/** Where a client version stands (`unknown`: no / other platform or no parseable version — never gated). */
export function clientStatus(c: MaintenanceConfig, platform: string | null, version: string | null): ClientStatus {
  if (!platform || !(CLIENT_PLATFORMS as readonly string[]).includes(platform) || !parseVersion(version)) return 'unknown';
  const v = c.clientVersions[platform as ClientPlatform];
  if (compareVersions(version!, v.min) < 0) return 'required';
  if (compareVersions(version!, v.recommended) < 0) return 'recommended';
  return 'ok';
}

function upgradeError(c: MaintenanceConfig, platform: string | null, version: string | null, reason: 'version' | 'engine', engine?: number | null): AppError {
  const v = platform && (CLIENT_PLATFORMS as readonly string[]).includes(platform) ? c.clientVersions[platform as ClientPlatform] : null;
  return new AppError('UPGRADE_REQUIRED', reason === 'engine' ? ENGINE_UPGRADE_TEXT : UPGRADE_TEXT, 426, {
    reason, platform: v ? platform : null, version: version ?? null,
    minVersion: v?.min ?? null, recommendedVersion: v?.recommended ?? null, storeUrl: v?.storeUrl ?? null,
    ...(reason === 'engine' ? { engineLevel: engine ?? null, minEngineLevel: Math.max(c.minEngineLevel, ENGINE_LEVEL) } : {}),
  });
}

export function maintenanceError(w: MaintenanceWindow, g: MaintenanceGroup, now: number): AppError {
  const end = effectiveEnd(w);
  return new AppError('MAINTENANCE', MAINTENANCE_TEXT, 503, {
    windowId: w.id, group: g, scope: w.scope, startAt: w.startAtMs, endAt: end, endsAtJst: shortJst(end),
    retryAfterSec: Math.max(1, Math.ceil((end - now) / 1000)), message: w.message.ja,
  });
}

/**
 * The single entry check (REQ-MNT-003/006). Order: exempt routes pass; then the version gate (426, an outdated app
 * cannot be fixed by waiting); then the engine level for race groups (426 reason engine); then an active window (503).
 * Returns null when the request may proceed.
 */
export function gateRequest(c: MaintenanceConfig, method: string, path: string, h: ClientHeaders, now: number): AppError | null {
  if (!path.startsWith('/v1/') || path.startsWith('/v1/admin/') || isExempt(method, path)) return null;
  if (clientStatus(c, h.platform, h.version) === 'required') return upgradeError(c, h.platform, h.version, 'version');
  const g = endpointGroup(path);
  if (RACE_GROUPS.includes(g) && h.engine !== null && h.engine < Math.max(c.minEngineLevel, ENGINE_LEVEL)) return upgradeError(c, h.platform, h.version, 'engine', h.engine);
  const w = activeWindowFor(c, g, now);
  return w ? maintenanceError(w, g, now) : null;
}

/**
 * Race socket handshake (§4 `hello.engine`, REQ-MNT-008): a client that names an engine level below the room's need
 * is refused (err VERSION_MISMATCH, close 4026) before it takes its seat. A hello without `engine` (apps before
 * Round 17, bots) is accepted as before. `required` = the level the race needs (ENGINE_LEVEL today).
 */
export function engineMismatch(engine: number | undefined, required = ENGINE_LEVEL): boolean {
  return engine !== undefined && engine < required;
}

// ----------------------------------------------------------------------------------------------- views

export interface WindowView {
  id: string; scope: 'all' | string[]; startAt: number; endAt: number; announceAt: number;
  startJst: string; endJst: string; message: string; status: 'announced' | 'active';
}
const viewOf = (w: MaintenanceWindow, now: number): WindowView => ({
  id: w.id, scope: w.scope, startAt: w.startAtMs, endAt: effectiveEnd(w), announceAt: announceAt(w),
  startJst: shortJst(w.startAtMs), endJst: shortJst(effectiveEnd(w)), message: w.message.ja, status: isActive(w, now) ? 'active' : 'announced',
});
/** Windows players can see now: running ones and announced upcoming ones (not cancelled), earliest first. */
export function visibleWindows(c: MaintenanceConfig, now: number): WindowView[] {
  return c.windows
    .filter((w) => effectiveEnd(w) > now && effectiveEnd(w) > w.startAtMs && announceAt(w) <= now)
    .sort((a, b) => a.startAtMs - b.startAtMs)
    .map((w) => viewOf(w, now));
}

/** GET /v1/maintenance (public, never gated; REQ-MNT-004/005). */
export function maintenanceStatus(c: MaintenanceConfig, h: ClientHeaders, now: number) {
  const windows = visibleWindows(c, now);
  const platform = h.platform && (CLIENT_PLATFORMS as readonly string[]).includes(h.platform) ? (h.platform as ClientPlatform) : null;
  const v = platform ? c.clientVersions[platform] : null;
  return {
    serverNowMs: now,
    active: windows.filter((w) => w.status === 'active'),
    upcoming: windows.filter((w) => w.status === 'announced'),
    client: {
      platform, version: h.version ?? null, status: clientStatus(c, h.platform, h.version),
      minVersion: v?.min ?? null, recommendedVersion: v?.recommended ?? null, storeUrl: v?.storeUrl ?? null,
      minEngineLevel: Math.max(c.minEngineLevel, ENGINE_LEVEL),
    },
  };
}

/** The ops console's view of one window (REQ-MNT-011). */
export function adminWindowView(w: MaintenanceWindow, now: number) {
  const end = effectiveEnd(w);
  const status = w.cancelledAtMs !== undefined && w.cancelledAtMs <= w.startAtMs ? 'cancelled'
    : end <= now ? (w.cancelledAtMs !== undefined && w.cancelledAtMs < w.endAtMs ? 'ended_early' : 'ended')
      : isActive(w, now) ? 'active' : announceAt(w) <= now ? 'announced' : 'scheduled';
  return {
    ...w, status, announceAt: announceAt(w), effectiveEndAt: end,
    startJst: msToJst(w.startAtMs), endJst: msToJst(w.endAtMs), announceJst: msToJst(announceAt(w)),
    groups: w.scope === 'all' ? [...MAINTENANCE_GROUPS] : w.scope,
  };
}

/** The in-game banner exactly as players would see it, both languages (console preview, REQ-MNT-011). */
export function bannerPreview(w: MaintenanceWindow) {
  const times = `${shortJst(w.startAtMs)}〜${shortJst(w.endAtMs)}`;
  return {
    ja: { label: MAINTENANCE_NEWS_TITLE, times: `${times}（日本時間）`, message: w.message.ja, during: MAINTENANCE_TEXT },
    en: { label: 'Scheduled maintenance', times: `${shortJst(w.startAtMs)}–${shortJst(w.endAtMs)} (JST)`, message: w.message.en, during: 'Under maintenance' },
  };
}

/** Admin input for a window: JST strings (`startJst`) or epoch ms. */
export const windowInputSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  startJst: z.string().optional(), endJst: z.string().optional(), announceJst: z.string().optional(),
  startAtMs: int.optional(), endAtMs: int.optional(), announceAtMs: int.optional(),
  scope: maintenanceWindowSchema.shape.scope,
  message: maintenanceWindowSchema.shape.message,
}).strict();
export function windowFromInput(i: z.infer<typeof windowInputSchema>): MaintenanceWindow {
  const pick = (jst: string | undefined, ms: number | undefined, key: string): number | undefined => {
    if (jst !== undefined) {
      const v = jstToMs(jst);
      if (v === null) throw new AppError('BAD_REQUEST', `${key}: expected YYYY-MM-DDTHH:mm (JST)`);
      return v;
    }
    return ms;
  };
  const startAtMs = pick(i.startJst, i.startAtMs, 'startJst');
  const endAtMs = pick(i.endJst, i.endAtMs, 'endJst');
  const announceAtMs = pick(i.announceJst, i.announceAtMs, 'announceJst');
  if (startAtMs === undefined || endAtMs === undefined) throw new AppError('BAD_REQUEST', 'start and end are required');
  return { id: i.id, startAtMs, endAtMs, ...(announceAtMs !== undefined ? { announceAtMs } : {}), scope: i.scope, message: i.message };
}
