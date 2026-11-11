/**
 * 引き継ぎコード (REQ-TRF-001..020, contracts/protocol.md §54): the pure rules — configuration, the code id and password
 * formats, the password rules, the PBKDF2 hash, the player's `transfer` state and the session cut-off of an old device.
 * The orchestration (directory, player objects, the custom token) is transferService.ts.
 *
 * Nothing here ever logs a code id or a password, and neither is ever put into KPI rows or the audit (only `codeRef`,
 * a short SHA-256 prefix of the id).
 */
import { z } from 'zod';
import { AppError } from './errors.js';
import type { Master } from './master.js';
import type { PlayerState } from './player.js';
import { moderationOf } from './player.js';
import { deletionScheduled } from './accountDeletion.js';
import { dayRule, gameDayKey } from './time.js';

// ------------------------------------------------------------------------------------------------ configuration

export interface TransferConfig {
  enabled: boolean;
  /** Days a code stays valid after it was issued (1..90). */
  expiryDays: number;
  /** Wrong passwords on one code before it locks (looks like an unknown id from outside). */
  maxAttemptsPerCode: number;
  codeLockMinutes: number;
  /** Failures from one IP / one device within an hour before they lock (429 TRANSFER_LOCKED). */
  ipFailuresPerHour: number;
  deviceFailuresPerHour: number;
  limitLockMinutes: number;
  /** Codes issued per game day (04:00 JST). */
  issuesPerDay: number;
  passwordMin: number;
  passwordMax: number;
}

export const DEFAULT_TRANSFER: TransferConfig = {
  enabled: true, expiryDays: 30, maxAttemptsPerCode: 5, codeLockMinutes: 60, ipFailuresPerHour: 20, deviceFailuresPerHour: 10,
  limitLockMinutes: 60, issuesPerDay: 5, passwordMin: 8, passwordMax: 32,
};

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const configSchema = z.object({
  _note: z.string().optional(),
  enabled: z.boolean(),
  expiryDays: int(1, 90),
  maxAttemptsPerCode: int(3, 10),
  codeLockMinutes: int(15, 1440),
  ipFailuresPerHour: int(5, 200),
  deviceFailuresPerHour: int(3, 50),
  limitLockMinutes: int(15, 1440),
  issuesPerDay: int(1, 20),
  passwordMin: int(8, 16),
  passwordMax: int(16, 64),
}).strict();

/** REQ-TRF-018: boot and every remote-config version. */
export function transferProblems(m: Pick<Master, 'progression'>, path = 'progression.transfer'): string[] {
  const raw = (m.progression as { transfer?: unknown }).transfer;
  if (raw === undefined) return [];
  const r = configSchema.safeParse(raw);
  if (!r.success) return r.error.issues.map((i) => `${path}.${i.path.join('.')}: ${i.message}`);
  const out: string[] = [];
  if (r.data.passwordMax < r.data.passwordMin) out.push(`${path}.passwordMax: must be >= passwordMin`);
  if (r.data.deviceFailuresPerHour > r.data.ipFailuresPerHour) out.push(`${path}.deviceFailuresPerHour: must not exceed ipFailuresPerHour (one IP serves many devices)`);
  return out;
}

export const transferConfig = (m: Pick<Master, 'progression'>): TransferConfig => ({ ...DEFAULT_TRANSFER, ...((m.progression as { transfer?: Partial<TransferConfig> }).transfer ?? {}) });

// ------------------------------------------------------------------------------------------------ code id and passwords

/** 31 characters without 0 1 O I L (REQ-TRF-002). */
export const ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const ID_LENGTH = 9;
export const PW_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
export const GENERATED_LENGTH = 12;
export const TRANSFER_SHARDS = 16;
export const TRANSFER_MODES = ['custom', 'generated'] as const;
export type TransferMode = typeof TRANSFER_MODES[number];

/** NFKC (full-width → half-width), then spaces and dashes removed. The same on issue and on entry. */
export function normalizeInput(raw: string): string {
  return raw.normalize('NFKC').replace(/[\s\-‐‑‒–—―−ーｰ]/g, '');
}
/** The canonical 9-character id, or null when it is not one (unknown characters, wrong length). */
export function normalizeCodeId(raw: string): string | null {
  const s = normalizeInput(raw).toUpperCase();
  if (s.length !== ID_LENGTH) return null;
  for (const ch of s) if (!ID_ALPHABET.includes(ch)) return null;
  return s;
}
export const formatCodeId = (id: string) => `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6, 9)}`;
export const formatGenerated = (pw: string) => `${pw.slice(0, 4)}-${pw.slice(4, 8)}-${pw.slice(8, 12)}`;
/** The directory shard of a code: the first character's position mod 16 (= the owner's player shard). */
export const codeShard = (id: string) => ID_ALPHABET.indexOf(id[0]!) % TRANSFER_SHARDS;

export type RandomBytes = (n: number) => Uint8Array;
export const cryptoBytes: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

/** Unbiased picks from an alphabet (rejection sampling on bytes). */
function pick(alphabet: string, n: number, rand: RandomBytes): string {
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < n) {
    for (const b of rand(n * 2)) {
      if (b >= limit) continue;
      out += alphabet[b % alphabet.length];
      if (out.length === n) break;
    }
  }
  return out;
}
/** A new id whose first character puts it in the owner's shard. */
export function makeCodeId(shard: number, rand: RandomBytes = cryptoBytes): string {
  const firsts = [...ID_ALPHABET].filter((_, i) => i % TRANSFER_SHARDS === shard);
  const first = firsts[rand(1)[0]! % firsts.length]!;
  return first + pick(ID_ALPHABET, ID_LENGTH - 1, rand);
}
export const makeGeneratedPassword = (rand: RandomBytes = cryptoBytes) => pick(PW_ALPHABET, GENERATED_LENGTH, rand);

/** REQ-TRF-003: lower-cased, compared after normalisation. Kept short on purpose: the length / mix rules do most of the work. */
export const COMMON_PASSWORDS: readonly string[] = [
  'password1', 'password12', 'password123', 'passw0rd', 'p@ssw0rd', 'qwerty123', 'qwerty12', 'qwer1234', 'asdf1234', 'abcd1234', 'abc12345', 'a1234567',
  'abc123456', '1234abcd', '1q2w3e4r', '1qaz2wsx', 'zaq12wsx', 'iloveyou1', 'monkey123', 'dragon123', 'baseball1', 'letmein1', 'welcome1', 'muchi1234', 'keiba1234',
];
export const PASSWORD_RULES = ['length', 'charset', 'mix', 'common'] as const;
export type PasswordRule = typeof PASSWORD_RULES[number];

/** Every rule a (normalised) custom password breaks; empty = acceptable. */
export function passwordProblems(pw: string, cfg: Pick<TransferConfig, 'passwordMin' | 'passwordMax'>): PasswordRule[] {
  const out: PasswordRule[] = [];
  const len = [...pw].length;
  if (len < cfg.passwordMin || len > cfg.passwordMax) out.push('length');
  if (!/^[\x21-\x7e]*$/.test(pw)) out.push('charset');
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) out.push('mix');
  if (COMMON_PASSWORDS.includes(pw.toLowerCase())) out.push('common');
  return out;
}
/** The rule lines the issue screen shows (Japanese; English at the response boundary, i18n/en.ts). */
export function passwordRuleTexts(cfg: Pick<TransferConfig, 'passwordMin' | 'passwordMax'>): { id: PasswordRule; text: string }[] {
  return [
    { id: 'length', text: `${cfg.passwordMin}〜${cfg.passwordMax}文字` },
    { id: 'charset', text: '半角の英数字と記号' },
    { id: 'mix', text: '英字と数字を両方使う' },
    { id: 'common', text: 'よく使われるパスワードは使えません' },
  ];
}

// ------------------------------------------------------------------------------------------------ the hash (REQ-TRF-004)

/** PBKDF2-HMAC-SHA256 at the Workers maximum of 100,000 iterations; stored per record so it can be raised later. */
export const TRANSFER_KDF = { name: 'pbkdf2-sha256', iterations: 100_000, saltBytes: 16, hashBytes: 32 } as const;

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));

export async function hashPassword(pw: string, saltHex: string, iterations: number = TRANSFER_KDF.iterations): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(saltHex), iterations }, key, TRANSFER_KDF.hashBytes * 8);
  return hex(new Uint8Array(bits));
}
export const newSalt = (rand: RandomBytes = cryptoBytes) => hex(rand(TRANSFER_KDF.saltBytes));
/** Constant-time comparison of two hex digests. */
export function digestEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
export async function sha256Hex(s: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
}
/** The audit's reference to a code: never the id itself. */
export const codeRef = async (codeId: string) => (await sha256Hex(`transfer-code:${codeId}`)).slice(0, 8);

// ------------------------------------------------------------------------------------------------ player state (§54.5)

export type TransferEvent = 'issued' | 'revoked' | 'redeemed' | 'ops_revoked';
export interface TransferState {
  code: { id: string; mode: TransferMode; issuedAt: number; expiresAt: number } | null;
  issues: { day: string; count: number };
  /** REQ-TRF-010: sessions signed in before this (ms) belong to the old device. */
  cutoffAt: number | null;
  lastRedeemedAt: number | null;
  history: { at: number; event: TransferEvent; mode?: TransferMode }[];
  /**
   * On the REDEEMING (new device's) account: the last successful redeem under the client's idempotency key, so a retry
   * after a lost response gets a fresh custom token for the same account instead of "invalid" (the code is already used).
   * No token is stored — it is signed again. Kept one hour.
   */
  redeemedAs?: { key: string; playerId: string; displayName: string; at: number } | null;
}
export const REDEEM_REPLAY_MS = 3_600_000;
export const HISTORY_KEEP = 20;

export function ensureTransfer(s: PlayerState): TransferState {
  return (s.transfer ??= { code: null, issues: { day: '', count: 0 }, cutoffAt: null, lastRedeemedAt: null, history: [] });
}
function remember(t: TransferState, at: number, event: TransferEvent, mode?: TransferMode) {
  t.history.push({ at, event, ...(mode ? { mode } : {}) });
  if (t.history.length > HISTORY_KEEP) t.history.splice(0, t.history.length - HISTORY_KEEP);
}
const issuesToday = (m: Master, t: TransferState | undefined, now: number) => (t && t.issues.day === gameDayKey(now, dayRule(m)) ? t.issues.count : 0);

/** GET /v1/transfer/code (the player part; `enabled` is decided by the service). */
export function transferStateView(m: Master, s: PlayerState, now: number) {
  const cfg = transferConfig(m);
  const t = s.transfer;
  const c = t?.code ?? null;
  return {
    code: c ? { codeId: formatCodeId(c.id), mode: c.mode, issuedAt: c.issuedAt, expiresAt: c.expiresAt, expired: now >= c.expiresAt } : null,
    lastTransferredAt: t?.lastRedeemedAt ?? null,
    issuesToday: issuesToday(m, t, now), issuesPerDay: cfg.issuesPerDay,
    rules: passwordRuleTexts(cfg), passwordMin: cfg.passwordMin, passwordMax: cfg.passwordMax, expiryDays: cfg.expiryDays,
  };
}

/** REQ-TRF-001: who may issue (checked before the hash is computed and again inside the issuing transaction). */
export function assertMayIssue(m: Master, s: PlayerState, now: number) {
  if (moderationOf(s, now) === 'banned') throw new AppError('BANNED', 'transfer codes are disabled for this account');
  if (deletionScheduled(s) || s.deletion?.status === 'deleting') throw new AppError('DELETION_PENDING', 'the account is scheduled for deletion');
  if (issuesToday(m, s.transfer, now) >= transferConfig(m).issuesPerDay) throw new AppError('TRANSFER_ISSUE_LIMIT', 'too many transfer codes today', 429);
}

/** Records a new code (the directory row is already written); returns the code it replaced, if any. */
export function issueTransfer(m: Master, s: PlayerState, codeId: string, mode: TransferMode, now: number): { previous: string | null; expiresAt: number } {
  assertMayIssue(m, s, now);
  const t = ensureTransfer(s);
  const day = gameDayKey(now, dayRule(m));
  t.issues = t.issues.day === day ? { day, count: t.issues.count + 1 } : { day, count: 1 };
  const previous = t.code?.id ?? null;
  const expiresAt = now + transferConfig(m).expiryDays * 86_400_000;
  t.code = { id: codeId, mode, issuedAt: now, expiresAt };
  remember(t, now, 'issued', mode);
  return { previous, expiresAt };
}

export function revokeTransfer(s: PlayerState, now: number, by: 'player' | 'ops'): string | null {
  const t = s.transfer;
  const id = t?.code?.id ?? null;
  if (!t || !id) return null;
  t.code = null;
  remember(t, now, by === 'ops' ? 'ops_revoked' : 'revoked');
  return id;
}

export type RefusedReason = 'banned' | 'deletion_pending';
/**
 * REQ-TRF-005/012: the owner's side of a redeem (one PlayerDO transaction, so two devices entering the same code at once
 * succeed once). The code must still be the current one; banned and deleting accounts are refused.
 */
export function redeemTransfer(s: PlayerState, codeId: string, now: number): void {
  const t = s.transfer;
  if (!t?.code || t.code.id !== codeId) throw new AppError('TRANSFER_INVALID', 'the transfer code is not valid', 400);
  if (moderationOf(s, now) === 'banned') throw refused('banned');
  if (deletionScheduled(s) || s.deletion?.status === 'deleting') throw refused('deletion_pending');
  if (now >= t.code.expiresAt) throw new AppError('TRANSFER_EXPIRED', 'the transfer code has expired', 410);
  t.code = null;
  t.cutoffAt = now;
  t.lastRedeemedAt = now;
  remember(t, now, 'redeemed');
}
export const refused = (reason: RefusedReason) => new AppError('TRANSFER_REFUSED', 'this account cannot be transferred', 403, { reason });

/** REQ-TRF-009: what the redeeming device would leave behind (its own anonymous account). */
export function progressOf(s: PlayerState | null) {
  if (!s) return null;
  const gifts = s.giftBox?.box?.length ?? 0;
  const p = { paidCoins: s.wallet.paid, freeCoins: s.wallet.free, horses: s.horses.length, races: s.stats.races, purchases: s.purchases.length };
  const any = p.paidCoins > 0 || p.freeCoins > 0 || p.horses > 0 || p.races > 0 || p.purchases > 0 || gifts > 0;
  return any ? p : null;
}

// ------------------------------------------------------------------------------------------------ old device (REQ-TRF-010)

/** Clock difference allowed between Firebase's auth_time and this server's cut-off. */
export const SESSION_SKEW_MS = 30_000;
/** True when a token signed in at `authTimeSec` belongs to a device the account has moved away from. */
export function sessionReplaced(cutoffAt: number | null, authTimeSec: number | null): boolean {
  if (cutoffAt === null) return false;
  if (authTimeSec === null) return true;
  return authTimeSec * 1000 < cutoffAt - SESSION_SKEW_MS;
}
export const sessionReplacedError = () => new AppError('SESSION_REPLACED', 'この端末のデータは別の端末に引き継がれました', 401);

/**
 * Per-isolate cache of each account's cut-off (30 s), so the check costs one PlayerDO read per player per isolate and
 * half minute. The isolate that served the redeem learns the new cut-off at once (`note`).
 */
export class SessionGuard {
  private readonly cache = new Map<string, { cutoff: number | null; at: number }>();
  constructor(private readonly lookup: (uid: string) => Promise<number | null>, private readonly clock: () => number = Date.now, private readonly ttlMs = 30_000, private readonly max = 5000) {}
  note(uid: string, cutoff: number | null) {
    this.cache.delete(uid);
    this.cache.set(uid, { cutoff, at: this.clock() });
    if (this.cache.size > this.max) this.cache.delete(this.cache.keys().next().value!);
  }
  async check(uid: string, authTimeSec: number | null): Promise<void> {
    const now = this.clock();
    let hit = this.cache.get(uid);
    if (!hit || now - hit.at > this.ttlMs) {
      this.note(uid, await this.lookup(uid));
      hit = this.cache.get(uid)!;
    }
    if (sessionReplaced(hit.cutoff, authTimeSec)) throw sessionReplacedError();
  }
}
