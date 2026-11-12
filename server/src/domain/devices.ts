/**
 * ログイン中の端末とセキュリティ (REQ-DEV-001..020, contracts/protocol.md §70): the pure rules — configuration, the player's
 * `devices` state (signed-in sessions, devices seen, revocations, the security log), the check-in, the sign-out rules and the
 * views. The Worker hashes the install id and derives the session id (http/app.ts) before it calls the player object.
 *
 * Personal data minimisation (docs/planning/03-legal-risk.md §70): no IP (not even hashed), no token, no raw install id —
 * only a per-account hash of the install id, the country code Cloudflare gives, and the coarse label the app sends
 * (platform, OS major, model family with digits stripped, app version). Times are rounded down to the hour.
 */
import { z } from 'zod';
import { AppError } from './errors.js';
import type { Master } from './master.js';
import type { PlayerState } from './player.js';
import { dayRule, gameDayKey } from './time.js';
import { recordActivity } from './activity.js';
import { sessionRevoked, type SessionRevocations } from './sessionRevocation.js';
import type { KpiEvent } from './kpi.js';
import { sha256Hex } from './transferCode.js';

// ------------------------------------------------------------------------------------------------ configuration

export interface DevicesConfig {
  enabled: boolean;
  maxSessions: number;
  knownDevicesMax: number;
  logMax: number;
  logDays: number;
  revokesPerDay: number;
  /** Hours a session must have been signed in before it may sign out a session older than itself (REQ-DEV-006). */
  trustAfterHours: number;
  revokedKeep: number;
  lastSeenRoundMin: number;
}
export const DEFAULT_DEVICES: DevicesConfig = {
  enabled: true, maxSessions: 20, knownDevicesMax: 50, logMax: 50, logDays: 180, revokesPerDay: 10, trustAfterHours: 24, revokedKeep: 200, lastSeenRoundMin: 60,
};
const int = (min: number, max: number) => z.number().int().min(min).max(max);
const configSchema = z.object({
  _note: z.string().optional(),
  enabled: z.boolean(),
  maxSessions: int(5, 50),
  knownDevicesMax: int(10, 200),
  logMax: int(10, 200),
  logDays: int(30, 400),
  revokesPerDay: int(1, 50),
  trustAfterHours: int(0, 168),
  revokedKeep: int(50, 1000),
  lastSeenRoundMin: int(15, 1440),
}).strict();

/** REQ-DEV-* (§70.10): boot and every remote-config version. */
export function devicesProblems(m: Pick<Master, 'progression'>, path = 'progression.devices'): string[] {
  const raw = (m.progression as { devices?: unknown }).devices;
  if (raw === undefined) return [];
  const r = configSchema.safeParse(raw);
  if (!r.success) return r.error.issues.map((i) => `${path}.${i.path.join('.')}: ${i.message}`);
  return r.data.knownDevicesMax < r.data.maxSessions ? [`${path}.knownDevicesMax: must be >= maxSessions`] : [];
}
export const devicesConfig = (m: Pick<Master, 'progression'>): DevicesConfig => ({ ...DEFAULT_DEVICES, ...((m.progression as { devices?: Partial<DevicesConfig> }).devices ?? {}) });

// ------------------------------------------------------------------------------------------------ state (§70.8)

export const DEVICE_PLATFORMS = ['ios', 'android', 'other'] as const;
export type DevicePlatformKind = typeof DEVICE_PLATFORMS[number];
export const LINK_PROVIDERS = ['apple', 'google'] as const;
export type LinkProvider = typeof LINK_PROVIDERS[number];
export const SECURITY_EVENTS = ['new_device', 'signout_device', 'signout_others', 'signout_support', 'transfer_issued', 'transfer_revoked', 'transfer_redeemed', 'link_added', 'link_removed'] as const;
export type SecurityEventKind = typeof SECURITY_EVENTS[number];

export interface DeviceLabelData { platform: DevicePlatformKind; osMajor: number | null; model: string | null; region: string | null }
export interface DeviceSessionRecord extends DeviceLabelData {
  /** `s_` + 16 hex (http/app.ts sessionIdOf). */
  id: string;
  /** Firebase `auth_time` (seconds) of the sign-in. */
  authTime: number;
  /** Per-account hash of the install id (16 hex) or null when the app sent none. */
  device: string | null;
  appVersion: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  /** Providers this session's token carried at its last check-in (REQ-DEV-010; null = not known). */
  providers?: LinkProvider[] | null;
}
export interface SecurityLogEntry {
  at: number; kind: SecurityEventKind;
  device?: DeviceLabelData; count?: number; mode?: 'custom' | 'generated'; by?: 'player' | 'ops'; provider?: LinkProvider;
}
export interface DevicesState {
  /** When this account began recording sessions (ms): sessions signed in before it are not "new devices". */
  since: number;
  sessions: DeviceSessionRecord[];
  known: string[];
  revoked: { id: string; authTime: number; at: number }[];
  othersBefore: { at: number; keep: number | null } | null;
  revokes: { day: string; count: number };
  /** Link providers seen on the account (REQ-DEV-010); null until a token carrying them was seen. */
  providers: LinkProvider[] | null;
  log: SecurityLogEntry[];
}

const HOUR = 3_600_000;
const DAY = 86_400_000;
const peek = (s: PlayerState): DevicesState | undefined => s.devices;
export function ensureDevices(s: PlayerState, now: number): DevicesState {
  return (s.devices ??= { since: now, sessions: [], known: [], revoked: [], othersBefore: null, revokes: { day: '', count: 0 }, providers: null, log: [] });
}

// ------------------------------------------------------------------------------------------------ input (REQ-DEV-002)

/** The model family: letters and single spaces only (`iPhone15,2` → `iPhone`, `Pixel 8 Pro` → `Pixel Pro`), at most 24. */
export function sanitizeModel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.normalize('NFKC').replace(/[^A-Za-z ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24).trim();
  return s.length > 0 ? s : null;
}
/** `cf-ipcountry`: two letters; `XX` (unknown) and `T1` (Tor) are not kept. */
export function regionOf(header: string | null | undefined): string | null {
  const v = (header ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(v) && v !== 'XX' ? v : null;
}
/** `firebase.identities` keys → the providers this feature follows (others ignored). Null when the claim is absent. */
export function providersOf(identities: unknown): LinkProvider[] | null {
  if (!identities || typeof identities !== 'object') return null;
  const keys = Object.keys(identities as Record<string, unknown>);
  return LINK_PROVIDERS.filter((p) => keys.includes(`${p}.com`));
}
export const checkinBodySchema = z.object({
  platform: z.enum(DEVICE_PLATFORMS),
  osMajor: z.number().int().min(0).max(99).nullable().optional(),
  model: z.string().max(64).nullable().optional(),
  appVersion: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,4}$/).nullable().optional(),
}).strict();
export type CheckinBody = z.infer<typeof checkinBodySchema>;

export interface CheckinInput {
  authTime: number | null;
  sessionId: string | null;
  device: string | null;
  platform: DevicePlatformKind;
  osMajor: number | null;
  model: string | null;
  appVersion: string | null;
  region: string | null;
  providers: LinkProvider[] | null;
}

/** The per-account hash of an install id (16 hex): never the raw id (REQ-DEV-001). */
export const deviceHashOf = async (uid: string, installId: string) => (await sha256Hex(`device:${uid}:${installId}`)).slice(0, 16);
/** `s_` + 16 hex of the account, the sign-in and the device hash (§70.1 3.). */
export const sessionIdOf = async (uid: string, authTime: number, device: string | null) => `s_${(await sha256Hex(`session:${uid}:${authTime}:${device ?? ''}`)).slice(0, 16)}`;
/** What the Worker hands the player object for a check-in (hashes first; the raw install id stops here). */
export async function buildCheckinInput(uid: string, authTime: number | null, installId: string | null, b: CheckinBody, country: string | null, identities: unknown): Promise<CheckinInput> {
  const device = installId === null ? null : await deviceHashOf(uid, installId);
  return {
    authTime, sessionId: authTime === null ? null : await sessionIdOf(uid, authTime, device), device, platform: b.platform, osMajor: b.osMajor ?? null,
    model: sanitizeModel(b.model), appVersion: b.appVersion ?? null, region: regionOf(country), providers: providersOf(identities),
  };
}

const floorTo = (ms: number, minutes: number) => ms - (ms % (minutes * 60_000));

// ------------------------------------------------------------------------------------------------ pruning

function prune(c: DevicesConfig, d: DevicesState, now: number, cutoffAt: number | null) {
  const cut = now - c.logDays * DAY;
  d.log = d.log.filter((e) => e.at > cut);
  if (d.log.length > c.logMax) d.log.splice(0, d.log.length - c.logMax);
  // §54.6: sessions signed in before the account moved away are gone (SESSION_REPLACED), never listed
  if (cutoffAt !== null) d.sessions = d.sessions.filter((x) => x.authTime * 1000 >= cutoffAt - 30_000);
  d.sessions = d.sessions.filter((x) => !sessionRevoked(revocationsFrom(d), x.authTime));
  if (d.sessions.length > c.maxSessions) {
    d.sessions.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    d.sessions.splice(c.maxSessions);
  }
  if (d.known.length > c.knownDevicesMax) d.known.splice(0, d.known.length - c.knownDevicesMax);
  if (d.revoked.length > c.revokedKeep) d.revoked.splice(0, d.revoked.length - c.revokedKeep);
}

export function logSecurity(m: Pick<Master, 'progression'>, s: PlayerState, entry: Omit<SecurityLogEntry, 'at'>, now: number) {
  if (s.deletion?.status === 'deleting') return;
  const d = ensureDevices(s, now);
  d.log.push({ at: now, ...entry });
  prune(devicesConfig(m), d, now, s.transfer?.cutoffAt ?? null);
}

const revocationsFrom = (d: DevicesState): SessionRevocations => ({ revoked: d.revoked.map((x) => x.authTime), othersBefore: d.othersBefore });
/** REQ-DEV-008: what the session guard reads (null for an account that never signed anything out). */
export function revocationsOf(s: PlayerState | null): SessionRevocations | null {
  const d = s ? peek(s) : undefined;
  if (!d || (d.revoked.length === 0 && d.othersBefore === null)) return null;
  return revocationsFrom(d);
}

// ------------------------------------------------------------------------------------------------ check-in (REQ-DEV-002/009/010)

const labelOf = (x: DeviceLabelData): DeviceLabelData => ({ platform: x.platform, osMajor: x.osMajor, model: x.model, region: x.region });
const sameLabel = (a: DeviceSessionRecord, i: CheckinInput) => a.platform === i.platform && a.osMajor === i.osMajor && a.model === i.model && a.appVersion === i.appVersion && a.region === i.region;
const sameProviders = (a: readonly string[] | null | undefined, b: readonly string[] | null) => (a ?? null) === null ? b === null : b !== null && a!.length === b.length && a!.every((x) => b.includes(x as LinkProvider));
const findSession = (d: DevicesState | undefined, i: Pick<CheckinInput, 'authTime' | 'device'>) => d?.sessions.find((x) => x.authTime === i.authTime && x.device === i.device);

/** Why a check-in writes nothing (REQ-DEV-002 1.). */
function skipCheckin(m: Master, s: PlayerState | null, i: CheckinInput): boolean {
  if (!devicesConfig(m).enabled || !s || i.authTime === null || i.sessionId === null) return true;
  if (s.deletion?.status === 'deleting') return true;
  if (sessionRevoked(s.devices ? revocationsFrom(s.devices) : null, i.authTime)) return true; // a revoked session within the guard's 30 s
  const cut = s.transfer?.cutoffAt ?? null;
  return cut !== null && i.authTime * 1000 < cut - 30_000;
}

/** True when the check-in would change the stored state (so an unchanged one is a read only). */
export function checkinNeedsWrite(m: Master, s: PlayerState | null, i: CheckinInput, now: number): boolean {
  if (skipCheckin(m, s, i)) return false;
  const d = s!.devices;
  const hit = findSession(d, i);
  if (!hit) return true;
  const c = devicesConfig(m);
  if (hit.lastSeenAt !== floorTo(now, c.lastSeenRoundMin) || !sameLabel(hit, i)) return true;
  if (i.providers !== null && (!sameProviders(hit.providers, i.providers) || !sameProviders(d!.providers, i.providers))) return true;
  return false;
}

export interface CheckinOutcome { recorded: boolean; newDevice: boolean }
export function applyCheckin(m: Master, s: PlayerState, i: CheckinInput, now: number, emit: (e: KpiEvent) => void): CheckinOutcome {
  if (skipCheckin(m, s, i)) return { recorded: false, newDevice: false };
  const c = devicesConfig(m);
  const d = ensureDevices(s, now);
  const seen = floorTo(now, c.lastSeenRoundMin);
  let hit = findSession(d, i);
  let newDevice = false;
  if (!hit) {
    const knownDevice = i.device !== null ? d.known.includes(i.device) : d.sessions.some((x) => x.platform === i.platform && x.model === i.model);
    const firstDevice = d.known.length === 0 && d.sessions.length === 0;
    const preExisting = i.authTime! < Math.floor(d.since / 1000); // auth_time is in whole seconds
    hit = { id: i.sessionId!, authTime: i.authTime!, device: i.device, platform: i.platform, osMajor: i.osMajor, model: i.model, appVersion: i.appVersion, region: i.region, firstSeenAt: seen, lastSeenAt: seen, providers: null };
    d.sessions.push(hit);
    if (!knownDevice && !firstDevice && !preExisting) {
      newDevice = true;
      d.log.push({ at: now, kind: 'new_device', device: labelOf(hit) });
      recordActivity(m, s, { kind: 'new_device', source: `new_device:${hit.id}`, linkId: hit.id }, now);
      emit({ name: 'new_device_notice', s1: hit.platform });
    }
  } else {
    hit.platform = i.platform; hit.osMajor = i.osMajor; hit.model = i.model; hit.appVersion = i.appVersion; hit.region = i.region;
    hit.lastSeenAt = Math.max(hit.lastSeenAt, seen);
  }
  if (i.device !== null && !d.known.includes(i.device)) d.known.push(i.device);
  // REQ-DEV-010: link changes from the token, per session (a token still carrying the old claims cannot flap the log)
  if (i.providers !== null) {
    if (d.providers === null) d.providers = [...i.providers];
    else {
      const prev = hit.providers ?? null;
      const added = prev === null ? i.providers.filter((p) => !d.providers!.includes(p)) : i.providers.filter((p) => !prev.includes(p));
      const removed = prev === null ? [] : prev.filter((p) => !i.providers!.includes(p));
      for (const p of added) if (!d.providers.includes(p)) { d.providers.push(p); d.log.push({ at: now, kind: 'link_added', provider: p }); }
      for (const p of removed) if (d.providers.includes(p)) { d.providers = d.providers.filter((x) => x !== p); d.log.push({ at: now, kind: 'link_removed', provider: p }); }
    }
    hit.providers = [...i.providers];
  }
  prune(c, d, now, s.transfer?.cutoffAt ?? null);
  return { recorded: true, newDevice };
}

// ------------------------------------------------------------------------------------------------ sign-out rules (REQ-DEV-004..007)

/** When the current session may sign out `target` (null = now). Newer sessions: always; older ones after trustAfterHours. */
export function signOutAvailableAt(c: DevicesConfig, currentAuth: number, targetAuth: number, now: number): number | null {
  if (targetAuth > currentAuth) return null;
  const at = currentAuth * 1000 + c.trustAfterHours * HOUR;
  return now >= at ? null : at;
}
const revokesToday = (m: Master, d: DevicesState | undefined, now: number) => (d && d.revokes.day === gameDayKey(now, dayRule(m)) ? d.revokes.count : 0);
function countRevoke(m: Master, d: DevicesState, now: number) {
  const day = gameDayKey(now, dayRule(m));
  d.revokes = d.revokes.day === day ? { day, count: d.revokes.count + 1 } : { day, count: 1 };
}
function assertMayRevoke(m: Master, s: PlayerState, currentAuth: number | null, now: number): asserts currentAuth is number {
  if (!devicesConfig(m).enabled) throw new AppError('NOT_FOUND', 'device sign-out is not available');
  if (s.deletion?.status === 'deleting') throw new AppError('DELETION_PENDING', 'the account is being deleted');
  if (currentAuth === null) throw new AppError('BAD_REQUEST', 'this session cannot be identified');
}
function limitCheck(m: Master, d: DevicesState | undefined, now: number) {
  if (revokesToday(m, d, now) >= devicesConfig(m).revokesPerDay) throw new AppError('RATE_LIMITED', '今日はこれ以上ログアウトできません');
}
const tooSoon = (c: DevicesConfig, at: number) => new AppError('DEVICE_SIGNOUT_TOO_SOON', `この端末でログインしてから${c.trustAfterHours}時間たつと、前からある端末もログアウトできます`, 403, { availableAt: at, trustAfterHours: c.trustAfterHours });

function revoke(d: DevicesState, x: DeviceSessionRecord, now: number) {
  if (!d.revoked.some((r) => r.authTime === x.authTime)) d.revoked.push({ id: x.id, authTime: x.authTime, at: now });
  d.sessions = d.sessions.filter((y) => y !== x);
}

/** POST /v1/account/devices/:sessionId/signout (the current session = `currentAuth`). */
export function signOutDevice(m: Master, s: PlayerState, sessionId: string, currentAuth: number | null, now: number, emit: (e: KpiEvent) => void): { signedOut: number } {
  assertMayRevoke(m, s, currentAuth, now);
  const c = devicesConfig(m);
  const d = peek(s);
  const target = d?.sessions.find((x) => x.id === sessionId);
  if (!target) {
    if (d?.revoked.some((r) => r.id === sessionId)) return { signedOut: 0 }; // idempotent (REQ-DEV-004)
    throw new AppError('NOT_FOUND', 'no such device');
  }
  if (target.authTime === currentAuth) throw new AppError('DEVICE_IS_CURRENT', 'この端末はここからはログアウトできません');
  const at = signOutAvailableAt(c, currentAuth, target.authTime, now);
  if (at !== null) throw tooSoon(c, at);
  limitCheck(m, d, now);
  revoke(d!, target, now);
  countRevoke(m, d!, now);
  d!.log.push({ at: now, kind: 'signout_device', device: labelOf(target) });
  emit({ name: 'device_signout', s1: 'one', count: 1 });
  prune(c, d!, now, s.transfer?.cutoffAt ?? null);
  return { signedOut: 1 };
}

/**
 * POST /v1/account/devices/signout-others (REQ-DEV-005/006). A session signed in for trustAfterHours revokes every other
 * session signed in until now (listed or not, `othersBefore`). A younger one may only sign out listed sessions newer than
 * itself — it cannot reach older sessions the list does not show (an app that never checked in).
 */
export function signOutOthers(m: Master, s: PlayerState, currentAuth: number | null, now: number, emit: (e: KpiEvent) => void): { signedOut: number } {
  assertMayRevoke(m, s, currentAuth, now);
  const c = devicesConfig(m);
  const others = (peek(s)?.sessions ?? []).filter((x) => x.authTime !== currentAuth);
  const trusted = signOutAvailableAt(c, currentAuth, currentAuth, now) === null;
  if (!trusted) {
    const older = others.filter((x) => x.authTime <= currentAuth);
    if (older.length > 0) throw tooSoon(c, currentAuth * 1000 + c.trustAfterHours * HOUR);
  }
  if (others.length === 0) {
    // nobody listed: 200, not counted, nothing logged (REQ-DEV-005). A trusted session still moves the cut so sessions the
    // list never showed (an app that never checked in) are signed out too — silently, like the listed ones would be.
    if (trusted) ensureDevices(s, now).othersBefore = { at: now, keep: currentAuth };
    return { signedOut: 0 };
  }
  limitCheck(m, peek(s), now);
  const d = ensureDevices(s, now);
  for (const x of others) revoke(d, x, now);
  if (trusted) d.othersBefore = { at: now, keep: currentAuth };
  countRevoke(m, d, now);
  d.log.push({ at: now, kind: 'signout_others', count: others.length });
  emit({ name: 'device_signout', s1: 'others', count: others.length });
  prune(c, d, now, s.transfer?.cutoffAt ?? null);
  return { signedOut: others.length };
}

/** REQ-DEV-017: support signs out one session or every session (no trust window, no daily limit; audited by the caller). */
export function supportRevoke(m: Master, s: PlayerState, target: { sessionId: string } | { all: true }, now: number, emit: (e: KpiEvent) => void): { signedOut: number } {
  const d = ensureDevices(s, now);
  let n: number;
  if ('all' in target) {
    n = d.sessions.length;
    for (const x of [...d.sessions]) revoke(d, x, now);
    d.othersBefore = { at: now, keep: null };
  } else {
    const x = d.sessions.find((y) => y.id === target.sessionId);
    if (!x) {
      if (d.revoked.some((r) => r.id === target.sessionId)) return { signedOut: 0 };
      throw new AppError('NOT_FOUND', 'no such device');
    }
    revoke(d, x, now);
    n = 1;
  }
  d.log.push({ at: now, kind: 'signout_support', count: n });
  emit({ name: 'device_signout', s1: 'support', count: n });
  prune(devicesConfig(m), d, now, s.transfer?.cutoffAt ?? null);
  return { signedOut: n };
}

/**
 * REQ-DEV-012: the account moved to another device with a transfer code — every old session is now SESSION_REPLACED, so the
 * list and the devices seen start again (the new device's first check-in is a "first device"). Revocations stay: a session
 * revoked within the cut-off's 30 s clock allowance must not come back.
 */
export function resetAfterTransfer(m: Pick<Master, 'progression'>, s: PlayerState, now: number) {
  const d = ensureDevices(s, now);
  d.sessions = [];
  d.known = [];
  d.since = now;
  d.log.push({ at: now, kind: 'transfer_redeemed' });
  prune(devicesConfig(m), d, now, null);
}

// ------------------------------------------------------------------------------------------------ views (§70.2 / §70.5)

export function devicesView(m: Master, s: PlayerState | null, currentAuth: number | null, now: number) {
  const c = devicesConfig(m);
  const d = s ? peek(s) : undefined;
  const live = s && s.deletion?.status !== 'deleting' ? (d?.sessions ?? []) : [];
  const cur = currentAuth === null ? undefined : live.find((x) => x.authTime === currentAuth);
  const sorted = [...live].sort((a, b) => (a === cur ? -1 : b === cur ? 1 : b.lastSeenAt - a.lastSeenAt || b.authTime - a.authTime));
  const sessions = sorted.map((x) => {
    const isCur = x === cur || (currentAuth !== null && x.authTime === currentAuth);
    const at = isCur || currentAuth === null ? null : signOutAvailableAt(c, currentAuth, x.authTime, now);
    return {
      sessionId: x.id, current: isCur, platform: x.platform, osMajor: x.osMajor, model: x.model, appVersion: x.appVersion, region: x.region,
      firstSeenAt: x.firstSeenAt, lastSeenAt: x.lastSeenAt, canSignOut: !isCur && currentAuth !== null && at === null, availableAt: at,
    };
  });
  const others = sessions.filter((x) => !x.current);
  const trustedAt = currentAuth === null ? null : signOutAvailableAt(c, currentAuth, currentAuth, now);
  const olderBlocked = currentAuth !== null && trustedAt !== null && others.some((x) => x.availableAt !== null);
  const providers = d?.providers ?? [];
  return {
    enabled: c.enabled,
    current: cur?.id ?? null,
    sessions: c.enabled ? sessions : [],
    signOutOthers: { allowed: c.enabled && currentAuth !== null && others.length > 0 && !olderBlocked, availableAt: olderBlocked ? trustedAt : null, count: others.length },
    revokesToday: revokesToday(m, d, now), revokesPerDay: c.revokesPerDay, trustAfterHours: c.trustAfterHours,
    anonymousOnly: providers.length === 0 && !(s?.transfer?.code && now < s.transfer.code.expiresAt),
    lastTransferredAt: s?.transfer?.lastRedeemedAt ?? null,
  };
}

/** Japanese texts; the English is in i18n/en.ts (REQ-DEV-011). */
export const SECURITY_TEXT: Record<string, string> = {
  new_device: '新しい端末でログインがありました',
  signout_device: 'ほかの端末をログアウトしました',
  signout_others: 'この端末以外をすべてログアウトしました',
  signout_support: 'サポートが端末をログアウトしました',
  transfer_issued: '引き継ぎコードを発行しました',
  transfer_issued_custom: '引き継ぎコードを発行しました（パスワードを設定）',
  transfer_revoked: '引き継ぎコードを取り消しました',
  transfer_revoked_ops: 'サポートが引き継ぎコードを取り消しました',
  transfer_redeemed: '引き継ぎコードでこのアカウントが新しい端末に移りました',
  link_added: '{provider}の連携を追加しました',
  link_removed: '{provider}の連携を解除しました',
};
const PROVIDER_NAME: Record<LinkProvider, string> = { apple: 'Apple', google: 'Google' };
export function securityText(e: SecurityLogEntry): string {
  const T = SECURITY_TEXT;
  switch (e.kind) {
    case 'transfer_issued': return e.mode === 'custom' ? T.transfer_issued_custom! : T.transfer_issued!;
    case 'transfer_revoked': return e.by === 'ops' ? T.transfer_revoked_ops! : T.transfer_revoked!;
    case 'link_added': case 'link_removed': return T[e.kind]!.replace('{provider}', e.provider ? PROVIDER_NAME[e.provider] : '');
    default: return T[e.kind]!;
  }
}

export function securityLogView(m: Master, s: PlayerState | null, now: number) {
  const c = devicesConfig(m);
  const cut = now - c.logDays * DAY;
  const log = s && s.deletion?.status !== 'deleting' ? (peek(s)?.log ?? []) : [];
  const items = log.filter((e) => e.at > cut).slice(-c.logMax).reverse().map((e) => ({
    at: e.at, kind: e.kind, text: securityText(e),
    ...(e.device ? { device: { ...e.device } } : {}), ...(e.count !== undefined ? { count: e.count } : {}),
    ...(e.mode ? { mode: e.mode } : {}), ...(e.by ? { by: e.by } : {}), ...(e.provider ? { provider: e.provider } : {}),
  }));
  return { enabled: c.enabled, logDays: c.logDays, items };
}

/** §51 (REQ-DEV-015): labels, regions, times and the log — never auth_time, device hashes, revocations or the devices seen. */
export function exportDevices(s: PlayerState) {
  const d = peek(s);
  if (!d) return { signedInDevices: null, securityLog: null };
  return {
    signedInDevices: d.sessions.map((x) => ({ platform: x.platform, osMajor: x.osMajor, model: x.model, appVersion: x.appVersion, region: x.region, firstSeenAt: x.firstSeenAt, lastSeenAt: x.lastSeenAt })),
    securityLog: d.log.map((e) => ({ at: e.at, kind: e.kind, ...(e.device ? { device: { ...e.device } } : {}), ...(e.count !== undefined ? { count: e.count } : {}), ...(e.mode ? { mode: e.mode } : {}), ...(e.by ? { by: e.by } : {}), ...(e.provider ? { provider: e.provider } : {}) })),
  };
}

/** REQ-DEV-017: the ops console's view (no auth_time, no hashes). */
export function adminDevicesView(m: Master, s: PlayerState | null, now: number) {
  const d = s ? peek(s) : undefined;
  return {
    exists: s !== null,
    sessions: (d?.sessions ?? []).map((x) => ({ sessionId: x.id, platform: x.platform, osMajor: x.osMajor, model: x.model, appVersion: x.appVersion, region: x.region, firstSeenAt: x.firstSeenAt, lastSeenAt: x.lastSeenAt })),
    revokedCount: d?.revoked.length ?? 0,
    othersBeforeAt: d?.othersBefore?.at ?? null,
    knownDevices: d?.known.length ?? 0,
    log: securityLogView(m, s, now).items,
  };
}
