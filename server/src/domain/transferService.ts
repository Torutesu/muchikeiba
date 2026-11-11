/**
 * 引き継ぎコード orchestration (REQ-TRF-*, contracts/protocol.md §54): the player objects (state, the one serialised
 * consume), the directory shards (hash records, attempt limits, audit) and the custom token signer.
 *
 * Redeem never says whether an id exists: an unknown id, a wrong password, a locked, used or revoked code all answer the
 * same TRANSFER_INVALID after the same amount of hashing (a dummy PBKDF2 when there is no record).
 */
import { AppError } from './errors.js';
import { shardOf } from './friends.js';
import {
  codeRef, digestEqual, formatCodeId, formatGenerated, hashPassword, makeCodeId, makeGeneratedPassword, newSalt, normalizeCodeId, normalizeInput,
  passwordProblems, sha256Hex, TRANSFER_KDF, cryptoBytes, type RandomBytes, type TransferConfig, type TransferMode,
} from './transferCode.js';

export interface TransferRecord {
  codeId: string; playerId: string; salt: string; hash: string; kdf: string; iterations: number; issuedAt: number; expiresAt: number;
}
export type BeginResult =
  | { status: 'ok' | 'expired'; rec: TransferRecord; lockedNow: boolean }
  | { status: 'locked'; playerId: string }
  | { status: 'none' };
export type AuditEvent = 'issued' | 'revoked' | 'ops_revoked' | 'redeemed' | 'failed' | 'locked' | 'expired' | 'refused';
export interface AuditRow { playerId: string; at: number; event: AuditEvent; codeRef: string; ipRef: string | null; devRef: string | null }
export interface LimitRule { prefix: string; perHour: number }

/** The directory shards (DirectoryDO tables in production, memory in tests and the prototype). */
export interface TransferDirectory {
  /** Inserts a record; false when the id is taken (the caller draws another). */
  put(rec: TransferRecord, now: number): Promise<boolean>;
  /** Counts one attempt on the code and returns it (locked / missing → no record). */
  begin(codeId: string, now: number, maxAttempts: number, lockMs: number): Promise<BeginResult>;
  /** Removes the record (consumed or revoked) when it still belongs to `playerId`. */
  remove(codeId: string, playerId: string): Promise<void>;
  /** Milliseconds until the first locked key unlocks, or null when none is locked. */
  limitCheck(keys: string[], now: number): Promise<number | null>;
  limitFail(keys: string[], now: number, rules: LimitRule[], lockMs: number): Promise<void>;
  audit(row: AuditRow): Promise<void>;
  auditOf(playerId: string, limit: number): Promise<AuditRow[]>;
}

export interface TransferProgress { paidCoins: number; freeCoins: number; horses: number; races: number; purchases: number }
/** The player-object side (PlayerService methods through PlayerInvoker). */
export interface TransferPlayers {
  view(uid: string): Promise<Record<string, unknown>>;
  checkIssue(uid: string): Promise<unknown>;
  issued(uid: string, codeId: string, mode: TransferMode): Promise<{ previous: string | null; issuedAt: number; expiresAt: number }>;
  revoke(uid: string, by: 'player' | 'ops'): Promise<{ revoked: string | null }>;
  progress(uid: string): Promise<TransferProgress | null>;
  redeemed(uid: string, codeId: string): Promise<{ displayName: string; cutoffAt: number }>;
  noteFail(uid: string, reason: FailReason): Promise<unknown>;
  admin(uid: string): Promise<unknown>;
  /** A retried redeem from the same account with the same idempotency key (null = none within the hour). */
  redeemReplay(uid: string, key: string): Promise<{ playerId: string; displayName: string } | null>;
  redeemRemember(uid: string, key: string, playerId: string, displayName: string): Promise<unknown>;
}
export interface CustomTokenSigner { sign(uid: string, nowMs: number): Promise<string> }
export type FailReason = 'invalid' | 'expired' | 'locked' | 'refused_banned' | 'refused_deletion' | 'same_account';

export interface RedeemInput { codeId: string; password: string; confirmDiscard?: boolean }
export interface RedeemMeta { ip: string | null; installId: string | null; idemKey?: string | null }
export interface TransferServiceOptions {
  clock?: () => number;
  random?: RandomBytes;
  /** PBKDF2 iterations for new records (default TRANSFER_KDF.iterations, the Workers maximum). Tests may lower it. */
  iterations?: number;
  /** Salt for the IP / device hashes (a server secret; KPI_SALT in production). */
  limitSalt?: string;
  /** The isolate that served a redeem learns the new cut-off at once (SessionGuard.note). */
  onRedeemed?: (uid: string, cutoffAt: number) => void;
}

const invalid = () => new AppError('TRANSFER_INVALID', 'the transfer code is not valid', 400);
const DUMMY_SALT = '00'.repeat(TRANSFER_KDF.saltBytes);

export class TransferService {
  private readonly clock: () => number;
  private readonly rand: RandomBytes;
  private readonly iterations: number;
  constructor(
    private readonly players: TransferPlayers,
    private readonly dir: TransferDirectory,
    private readonly config: () => TransferConfig,
    private readonly signer: CustomTokenSigner | null,
    private readonly opts: TransferServiceOptions = {},
  ) {
    this.clock = opts.clock ?? Date.now;
    this.rand = opts.random ?? cryptoBytes;
    this.iterations = opts.iterations ?? TRANSFER_KDF.iterations;
  }

  /** Off by remote config, or no key to sign custom tokens with (REQ-TRF-011). */
  enabled(): boolean { return this.config().enabled && this.signer !== null; }
  private need() { if (!this.enabled()) throw new AppError('NOT_FOUND', 'transfer codes are not available'); return this.config(); }

  async view(uid: string) {
    if (!this.enabled()) return { enabled: false };
    return { enabled: true, ...(await this.players.view(uid)) };
  }

  /** REQ-TRF-001: a new code (the previous one stops working). The generated password is returned once, here only. */
  async issue(uid: string, body: { mode: 'custom'; password: string } | { mode: 'generated' }) {
    const cfg = this.need();
    let pw: string;
    if (body.mode === 'custom') {
      pw = normalizeInput(body.password);
      const rules = passwordProblems(pw, cfg);
      if (rules.length) throw new AppError('TRANSFER_PASSWORD_WEAK', 'the password does not meet the rules', 400, { rules });
    } else pw = makeGeneratedPassword(this.rand);
    await this.players.checkIssue(uid); // banned / deletion / today's limit, before the hash is computed
    const now = this.clock();
    const salt = newSalt(this.rand);
    const hash = await hashPassword(pw, salt, this.iterations);
    let codeId = '';
    for (let i = 0; i < 8 && !codeId; i++) {
      const id = makeCodeId(shardOf(uid), this.rand);
      const rec: TransferRecord = { codeId: id, playerId: uid, salt, hash, kdf: TRANSFER_KDF.name, iterations: this.iterations, issuedAt: now, expiresAt: now + cfg.expiryDays * 86_400_000 };
      if (await this.dir.put(rec, now)) codeId = id;
    }
    if (!codeId) throw new Error('transfer code space exhausted');
    let r: Awaited<ReturnType<TransferPlayers['issued']>>;
    try { r = await this.players.issued(uid, codeId, body.mode); }
    catch (e) { await this.dir.remove(codeId, uid).catch(() => undefined); throw e; }
    if (r.previous) await this.dir.remove(r.previous, uid).catch((e) => console.error('transfer: previous code not removed', (e as Error).message));
    await this.safeAudit({ playerId: uid, at: now, event: 'issued', codeRef: await codeRef(codeId), ipRef: null, devRef: null });
    return { codeId: formatCodeId(codeId), mode: body.mode, ...(body.mode === 'generated' ? { password: formatGenerated(pw) } : {}), issuedAt: r.issuedAt, expiresAt: r.expiresAt };
  }

  async revoke(uid: string, by: 'player' | 'ops' = 'player') {
    if (by === 'player') this.need();
    const r = await this.players.revoke(uid, by);
    if (r.revoked) {
      await this.dir.remove(r.revoked, uid).catch((e) => console.error('transfer: revoked code not removed', (e as Error).message));
      await this.safeAudit({ playerId: uid, at: this.clock(), event: by === 'ops' ? 'ops_revoked' : 'revoked', codeRef: await codeRef(r.revoked), ipRef: null, devRef: null });
    }
    return { revoked: r.revoked !== null };
  }

  /** REQ-TRF-005..012: the new device enters id + password and gets a custom token for the original account. */
  async redeem(requester: string, input: RedeemInput, meta: RedeemMeta) {
    const cfg = this.need();
    // ⓪ a retry after a lost response (same account, same key, within the hour): sign again for the same account
    if (meta.idemKey) {
      const prev = await this.players.redeemReplay(requester, meta.idemKey);
      if (prev) return { customToken: await this.signer!.sign(prev.playerId, this.clock()), expiresInSec: 3600, displayName: prev.displayName };
    }
    // ① this device's own progress is lost on switching: the player confirms first (same as switching with Apple / Google)
    if (!input.confirmDiscard) {
      const p = await this.players.progress(requester);
      if (p) throw new AppError('TRANSFER_CONFIRM_REQUIRED', 'this device has progress that will be left behind', 409, { ...p });
    }
    const now = this.clock();
    const salt = this.opts.limitSalt ?? '';
    const ipRef = meta.ip ? await sha256Hex(`ip:${salt}:${meta.ip}`) : null;
    const devRef = await sha256Hex(`dev:${salt}:${meta.installId ?? `uid:${requester}`}`);
    const keys = [...(ipRef ? [`ip:${ipRef}`] : []), `dev:${devRef}`];
    const refs = { ipRef: ipRef?.slice(0, 8) ?? null, devRef: devRef.slice(0, 8) };
    // ② IP / device lock (not about any code: no oracle)
    const wait = await this.dir.limitCheck(keys, now);
    if (wait !== null) {
      await this.fail(requester, 'locked');
      throw new AppError('TRANSFER_LOCKED', 'too many attempts; try again later', 429, { retryAfterSec: Math.max(1, Math.ceil(wait / 1000)) });
    }
    // ③ the record (one attempt counted on it) and the password; a dummy hash when there is nothing to compare
    const id = normalizeCodeId(input.codeId);
    const pw = normalizeInput(input.password);
    const b: BeginResult = id ? await this.dir.begin(id, now, cfg.maxAttemptsPerCode, cfg.codeLockMinutes * 60_000) : { status: 'none' };
    const rec = b.status === 'ok' || b.status === 'expired' ? b.rec : null;
    const digest = await hashPassword(pw, rec?.salt ?? DUMMY_SALT, rec?.iterations ?? this.iterations);
    const match = rec !== null && digestEqual(digest, rec.hash);
    if (!match) {
      await this.dir.limitFail(keys, now, [{ prefix: 'ip:', perHour: cfg.ipFailuresPerHour }, { prefix: 'dev:', perHour: cfg.deviceFailuresPerHour }], cfg.limitLockMinutes * 60_000);
      const owner = rec?.playerId ?? (b.status === 'locked' ? b.playerId : null);
      if (owner && id) await this.safeAudit({ playerId: owner, at: now, event: b.status === 'locked' || (rec && (b as { lockedNow: boolean }).lockedNow) ? 'locked' : 'failed', codeRef: await codeRef(id), ...refs });
      await this.fail(requester, 'invalid');
      throw invalid();
    }
    const cref = await codeRef(rec.codeId);
    if (b.status === 'expired') {
      await this.safeAudit({ playerId: rec.playerId, at: now, event: 'expired', codeRef: cref, ...refs });
      await this.fail(requester, 'expired');
      throw new AppError('TRANSFER_EXPIRED', 'the transfer code has expired', 410);
    }
    if (rec.playerId === requester) { await this.fail(requester, 'same_account'); throw new AppError('TRANSFER_SAME_ACCOUNT', 'this code belongs to the account on this device', 409); }
    // ④ sign before consuming: a signing problem must not burn the code
    const customToken = await this.signer!.sign(rec.playerId, now);
    let done: { displayName: string; cutoffAt: number };
    try { done = await this.players.redeemed(rec.playerId, rec.codeId); }
    catch (e) {
      if (e instanceof AppError && e.code === 'TRANSFER_REFUSED') {
        const reason = (e.details?.reason === 'banned' ? 'refused_banned' : 'refused_deletion') as FailReason;
        await this.safeAudit({ playerId: rec.playerId, at: now, event: 'refused', codeRef: cref, ...refs });
        await this.fail(requester, reason);
      } else if (e instanceof AppError && (e.code === 'TRANSFER_INVALID' || e.code === 'NOT_FOUND')) {
        await this.fail(requester, 'invalid');
        throw invalid();
      }
      throw e;
    }
    await this.dir.remove(rec.codeId, rec.playerId).catch((e) => console.error('transfer: consumed code not removed', (e as Error).message));
    await this.safeAudit({ playerId: rec.playerId, at: now, event: 'redeemed', codeRef: cref, ...refs });
    this.opts.onRedeemed?.(rec.playerId, done.cutoffAt);
    if (meta.idemKey) await this.players.redeemRemember(requester, meta.idemKey, rec.playerId, done.displayName).catch((e) => console.error('transfer: replay record not written', (e as Error).message));
    return { customToken, expiresInSec: 3600, displayName: done.displayName };
  }

  /** REQ-TRF-013: ops view (state + the directory audit). */
  async adminView(uid: string) {
    return { state: await this.players.admin(uid), audit: await this.dir.auditOf(uid, 100), enabled: this.enabled() };
  }

  private async fail(uid: string, reason: FailReason) {
    try { await this.players.noteFail(uid, reason); } catch { /* KPI only */ }
  }
  private async safeAudit(row: AuditRow) {
    try { await this.dir.audit(row); } catch (e) { console.error('transfer audit write failed', (e as Error).message); }
  }
}

// ------------------------------------------------------------------------------------------------ memory directory

/** The directory in memory (tests, the prototype). Same rules as the DirectoryDO tables. */
export class MemoryTransferDirectory implements TransferDirectory {
  readonly codes = new Map<string, TransferRecord & { attempts: number; lockedUntil: number }>();
  readonly limits = new Map<string, { windowStart: number; failures: number; lockedUntil: number }>();
  readonly rows: AuditRow[] = [];
  async put(rec: TransferRecord, now: number) {
    for (const [k, v] of this.codes) if (v.expiresAt + PURGE_AFTER_MS < now) this.codes.delete(k);
    if (this.codes.has(rec.codeId)) return false;
    this.codes.set(rec.codeId, { ...rec, attempts: 0, lockedUntil: 0 });
    return true;
  }
  async begin(codeId: string, now: number, maxAttempts: number, lockMs: number): Promise<BeginResult> {
    const r = this.codes.get(codeId);
    if (!r) return { status: 'none' };
    if (r.lockedUntil > now) return { status: 'locked', playerId: r.playerId };
    const s = beginStep(r.attempts, now, maxAttempts, lockMs);
    r.attempts = s.attempts; r.lockedUntil = s.lockedUntil;
    const { attempts: _a, lockedUntil: _l, ...rec } = r;
    return { status: now >= r.expiresAt ? 'expired' : 'ok', rec, lockedNow: s.lockedNow };
  }
  async remove(codeId: string, playerId: string) { if (this.codes.get(codeId)?.playerId === playerId) this.codes.delete(codeId); }
  async limitCheck(keys: string[], now: number) {
    const waits = keys.map((k) => (this.limits.get(k)?.lockedUntil ?? 0) - now).filter((w) => w > 0);
    return waits.length ? Math.max(...waits) : null;
  }
  async limitFail(keys: string[], now: number, rules: LimitRule[], lockMs: number) {
    for (const k of keys) {
      const per = rules.find((r) => k.startsWith(r.prefix))?.perHour;
      if (!per) continue;
      this.limits.set(k, limitStep(this.limits.get(k) ?? null, now, per, lockMs));
    }
  }
  async audit(row: AuditRow) {
    this.rows.push(row);
    const mine = this.rows.filter((x) => x.playerId === row.playerId);
    if (mine.length > AUDIT_KEEP) this.rows.splice(this.rows.indexOf(mine[0]!), 1);
  }
  async auditOf(playerId: string, limit: number) { return this.rows.filter((x) => x.playerId === playerId).slice(-limit).reverse(); }
  forget(playerId: string) {
    for (const [k, v] of this.codes) if (v.playerId === playerId) this.codes.delete(k);
    for (let i = this.rows.length - 1; i >= 0; i--) if (this.rows[i]!.playerId === playerId) this.rows.splice(i, 1);
  }
}

/** Rows of codes past expiry are kept a week (a correct password then still hears "expired"), audit rows 180 days. */
export const PURGE_AFTER_MS = 7 * 86_400_000;
export const AUDIT_KEEP = 100;
export const AUDIT_DAYS = 180;

/** One attempt on a code: the attempt that reaches the maximum still runs, then the code locks and the count restarts. */
export function beginStep(attempts: number, now: number, maxAttempts: number, lockMs: number) {
  const next = attempts + 1;
  return next >= maxAttempts ? { attempts: 0, lockedUntil: now + lockMs, lockedNow: true } : { attempts: next, lockedUntil: 0, lockedNow: false };
}
/** One failure on an IP / device key within a rolling hour window. */
export function limitStep(cur: { windowStart: number; failures: number; lockedUntil: number } | null, now: number, perHour: number, lockMs: number) {
  const fresh = !cur || now - cur.windowStart >= 3_600_000;
  const failures = (fresh ? 0 : cur!.failures) + 1;
  const windowStart = fresh ? now : cur!.windowStart;
  return failures >= perHour ? { windowStart: now, failures: 0, lockedUntil: now + lockMs } : { windowStart, failures, lockedUntil: cur?.lockedUntil ?? 0 };
}
