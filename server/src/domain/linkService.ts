/**
 * ディープリンク orchestration (REQ-LINK-003..009/013/020/021, contracts/protocol.md §63): the directory shards (link records,
 * lookup limits), the player objects (ban / deletion / block list, KPI) and the targets (rooms, cups, replays, invite / friend
 * codes, teams, help articles).
 *
 * Resolving never says why a link does not open: unknown, expired, revoked, malformed, an owner who is deleted or banned, a block
 * either way and a target that is gone all answer the same `{ state: 'unavailable' }` (and count as a failed lookup).
 */
import { AppError } from './errors.js';
import { activeWindowFor, CLIENT_PLATFORMS, compareVersions, effectiveEnd, parseVersion, shortJst, type ClientPlatform, type MaintenanceConfig } from './maintenance.js';
import { gameDayKey, type DayRule } from './time.js';
import { sha256Hex } from './transferCode.js';
import {
  appUrl, cryptoBytes, LINK_GROUPS, LINK_SCREENS, linkExpiry, linkUrl, makeToken, parseLink, shareText, type LinksConfig, type LinkState, type LinkType, type RandomBytes,
} from './deepLinks.js';

export interface LinkRecord {
  token: string; ownerId: string; type: LinkType; targetKey: string; data: Record<string, string>;
  day: string; createdAt: number; expiresAt: number; revokedAt: number | null;
}
export type PutResult = { status: 'created' | 'existing'; rec: LinkRecord } | { status: 'limit' } | { status: 'taken' };
export interface LinkLimitRules { lookupsPerHour: number; failuresPerHour: number; lockMs: number }

/** The directory shards (DirectoryDO tables in production, memory in tests and the prototype). */
export interface LinkDirectory {
  /**
   * In the owner's shard, atomically: a live link with the same owner / type / target → `existing`; `perDay` links already made
   * on `rec.day` → `limit`; the token taken → `taken` (the caller draws another); else inserted → `created`.
   */
  put(rec: LinkRecord, perDay: number, now: number): Promise<PutResult>;
  get(token: string): Promise<LinkRecord | null>;
  /** Revokes a live link of `ownerId`; the record when it was revoked now, else null. */
  revoke(token: string, ownerId: string, now: number): Promise<LinkRecord | null>;
  /** The owner's live links (newest first) and how many were made on `day`. */
  listOf(ownerId: string, day: string, now: number): Promise<{ links: LinkRecord[]; madeToday: number }>;
  /** Milliseconds until the first locked key unlocks, or null when none is locked. */
  limitCheck(keys: string[], now: number): Promise<number | null>;
  /** Counts one lookup (and a failure when `failed`) on every key. */
  limitNote(keys: string[], now: number, failed: boolean, rules: LinkLimitRules): Promise<void>;
}

export interface LinkParty { exists: boolean; banned: boolean; deleting: boolean; blocks: string[]; displayName: string }
export type LinkKpi = 'link_create' | 'link_resolve' | 'link_revoke' | 'rematch';
/** The player-object side (PlayerService methods through PlayerInvoker). */
export interface LinkPlayers {
  /** Read only; a never-stored / wiped account answers `exists: false`. */
  party(uid: string): Promise<LinkParty>;
  /** BANNED / DELETION_PENDING (read only). */
  checkCreate(uid: string): Promise<unknown>;
  note(uid: string, name: LinkKpi, s1: string, s2?: string, count?: number): Promise<unknown>;
}

export type OpenResult = { state: 'ok'; target: Record<string, unknown> } | { state: 'friends_only' } | null;
/** What each type needs from the rest of the server (built per request from the app context: linkTargetsFrom). */
export interface LinkTargets {
  /** May `uid` share this target? → the stable key (idempotency), what to store, and when the target ends (cups). NOT_FOUND otherwise. */
  prepare(uid: string, type: LinkType, target: Record<string, unknown>): Promise<{ targetKey: string; data: Record<string, string>; endsAt?: number | null }>;
  /** The live target for `viewer` (null = gone → unavailable). */
  open(viewer: string, rec: LinkRecord): Promise<OpenResult>;
}

export interface ResolveMeta { ip: string | null; platform: string | null; version: string | null }
export interface LinkServiceOptions {
  clock?: () => number;
  random?: RandomBytes;
  /** Salt for the viewer / IP hashes of the lookup limits (a server secret; KPI_SALT in production). */
  limitSalt?: string;
  maintenance?: () => MaintenanceConfig;
  dayRule?: () => DayRule;
}

const notFound = () => new AppError('NOT_FOUND', 'links are not available');
const UNAVAILABLE = { state: 'unavailable' as const };

export class LinkService {
  private readonly clock: () => number;
  private readonly rand: RandomBytes;
  constructor(
    private readonly players: LinkPlayers,
    private readonly dir: LinkDirectory,
    private readonly config: () => LinksConfig,
    private readonly opts: LinkServiceOptions = {},
  ) {
    this.clock = opts.clock ?? Date.now;
    this.rand = opts.random ?? cryptoBytes;
  }

  private day(now: number) { return gameDayKey(now, this.opts.dayRule?.() ?? 4); }
  private need() { const c = this.config(); if (!c.enabled) throw notFound(); return c; }
  private view(cfg: LinksConfig, r: LinkRecord) {
    return { token: r.token, url: linkUrl(cfg, r.token), appUrl: appUrl(cfg, r.token), type: r.type, createdAt: r.createdAt, expiresAt: r.expiresAt };
  }

  /** REQ-LINK-003/004: a link to a target the player may share (the same live link again for the same target). */
  async create(uid: string, type: LinkType, target: Record<string, unknown>, targets: LinkTargets) {
    const cfg = this.need();
    await this.players.checkCreate(uid);
    const p = await targets.prepare(uid, type, target);
    const now = this.clock();
    for (let i = 0; i < 8; i++) {
      const rec: LinkRecord = {
        token: makeToken(uid, this.rand), ownerId: uid, type, targetKey: p.targetKey, data: p.data, day: this.day(now),
        createdAt: now, expiresAt: linkExpiry(cfg, type, now, p.endsAt), revokedAt: null,
      };
      if (rec.expiresAt <= now) throw new AppError('NOT_FOUND', 'the target has ended');
      const r = await this.dir.put(rec, cfg.createsPerDay, now);
      if (r.status === 'taken') continue;
      if (r.status === 'limit') throw new AppError('LINK_LIMIT', 'too many links today', 429, { createsPerDay: cfg.createsPerDay });
      await this.safeNote(uid, 'link_create', type, r.status === 'created' ? 'new' : 'existing');
      return { ...this.view(cfg, r.rec), created: r.status === 'created', shareText: shareText(cfg, type, r.rec.token) };
    }
    throw new Error('link token space exhausted');
  }

  async list(uid: string) {
    const cfg = this.config();
    if (!cfg.enabled) return { enabled: false, links: [], createsToday: 0, createsPerDay: cfg.createsPerDay };
    const now = this.clock();
    const r = await this.dir.listOf(uid, this.day(now), now);
    return { enabled: true, links: r.links.map((x) => this.view(cfg, x)), createsToday: r.madeToday, createsPerDay: cfg.createsPerDay };
  }

  /** REQ-LINK-013: only the owner; unknown / someone else's / already revoked → false (idempotent). */
  async revoke(uid: string, raw: string) {
    this.need();
    const token = parseLink(raw, this.config().appScheme);
    const r = token ? await this.dir.revoke(token, uid, this.clock()) : null;
    if (r) await this.safeNote(uid, 'link_revoke', r.type);
    return { revoked: r !== null };
  }

  /** REQ-LINK-005..009: what a link opens for this viewer, or one neutral `unavailable`. */
  async resolve(viewer: string, raw: string, meta: ResolveMeta, targets: LinkTargets) {
    const cfg = this.config();
    const now = this.clock();
    const salt = this.opts.limitSalt ?? '';
    const keys = [`lu:${await sha256Hex(`lu:${salt}:${viewer}`)}`, ...(meta.ip ? [`lip:${await sha256Hex(`lip:${salt}:${meta.ip}`)}`] : [])];
    const rules: LinkLimitRules = { lookupsPerHour: cfg.resolvesPerHour, failuresPerHour: cfg.failuresPerHour, lockMs: cfg.lockMinutes * 60_000 };
    // ① lookup limits (about the viewer / network, never about a token: no oracle)
    const wait = await this.dir.limitCheck(keys, now);
    if (wait !== null) throw new AppError('RATE_LIMITED', 'too many link lookups; try again later', 429, { retryAfterSec: Math.max(1, Math.ceil(wait / 1000)) });
    const out = await this.lookup(viewer, raw, meta, targets, cfg, now);
    await this.dir.limitNote(keys, now, out.state === 'unavailable', rules);
    await this.safeNote(viewer, 'link_resolve', out.state === 'unavailable' ? 'none' : (out as { type: string }).type, out.state);
    return out;
  }

  private async lookup(viewer: string, raw: string, meta: ResolveMeta, targets: LinkTargets, cfg: LinksConfig, now: number):
    Promise<{ state: LinkState; type?: LinkType; [k: string]: unknown }> {
    if (!cfg.enabled) return UNAVAILABLE;
    // ② the record and the parties (one answer for every reason)
    const token = parseLink(raw, cfg.appScheme);
    const rec = token ? await this.dir.get(token) : null;
    if (!rec || rec.revokedAt !== null || now >= rec.expiresAt) return UNAVAILABLE;
    const owner = await this.players.party(rec.ownerId);
    if (!owner.exists || owner.banned || owner.deleting) return UNAVAILABLE;
    if (viewer !== rec.ownerId) {
      const me = await this.players.party(viewer);
      if (owner.blocks.includes(viewer) || me.blocks.includes(rec.ownerId)) return UNAVAILABLE;
      if (me.banned && rec.type !== 'help') return UNAVAILABLE;
    }
    // ③ a type that needs a newer app (unknown platform / version: never gated)
    const min = cfg.minClientVersion[rec.type];
    const platform = meta.platform && (CLIENT_PLATFORMS as readonly string[]).includes(meta.platform) ? meta.platform as ClientPlatform : null;
    if (min && platform && parseVersion(meta.version) && compareVersions(meta.version!, min) < 0) {
      return { state: 'update_required', type: rec.type, minVersion: min, storeUrl: this.opts.maintenance?.().clientVersions[platform].storeUrl ?? null };
    }
    // ④ the target's maintenance group (§46): answered, not refused
    const group = LINK_GROUPS[rec.type];
    const w = group && this.opts.maintenance ? activeWindowFor(this.opts.maintenance(), group, now) : null;
    if (w) return { state: 'maintenance', type: rec.type, endAt: effectiveEnd(w), endsAtJst: shortJst(effectiveEnd(w)), message: w.message.ja };
    // ⑤ the live target
    let open: OpenResult;
    try { open = await targets.open(viewer, rec); }
    catch (e) {
      if (e instanceof AppError && e.status === 429) throw e; // the target's own attempt limit (cup codes)
      if (e instanceof AppError) return UNAVAILABLE;
      throw e;
    }
    if (!open) return UNAVAILABLE;
    if (open.state === 'friends_only') return { state: 'friends_only', type: rec.type };
    return { state: 'ok', type: rec.type, screen: LINK_SCREENS[rec.type], target: open.target, expiresAt: rec.expiresAt };
  }

  private async safeNote(uid: string, name: LinkKpi, s1: string, s2?: string) {
    try { await this.players.note(uid, name, s1, s2); } catch { /* KPI only */ }
  }
}

// ------------------------------------------------------------------------------------------------ shared steps

/** Rows are kept a week after expiry (then purged); a revoked row stays until then too (never handed out again). */
export const LINK_PURGE_AFTER_MS = 7 * 86_400_000;
export interface LinkLimitRow { windowStart: number; lookups: number; failures: number; lockedUntil: number }
/** One lookup on a key within a rolling hour window; the lookup that reaches a limit locks the key. */
export function linkLimitStep(cur: LinkLimitRow | null, now: number, failed: boolean, rules: LinkLimitRules): LinkLimitRow {
  const fresh = !cur || now - cur.windowStart >= 3_600_000;
  const lookups = (fresh ? 0 : cur!.lookups) + 1;
  const failures = (fresh ? 0 : cur!.failures) + (failed ? 1 : 0);
  const windowStart = fresh ? now : cur!.windowStart;
  if (lookups >= rules.lookupsPerHour || failures >= rules.failuresPerHour) return { windowStart: now, lookups: 0, failures: 0, lockedUntil: now + rules.lockMs };
  return { windowStart, lookups, failures, lockedUntil: cur?.lockedUntil ?? 0 };
}
export const isLive = (r: LinkRecord, now: number) => r.revokedAt === null && now < r.expiresAt;

// ------------------------------------------------------------------------------------------------ memory directory

/** The directory in memory (tests, the prototype). Same rules as the DirectoryDO tables. */
export class MemoryLinkDirectory implements LinkDirectory {
  readonly links = new Map<string, LinkRecord>();
  readonly limits = new Map<string, LinkLimitRow>();
  async put(rec: LinkRecord, perDay: number, now: number): Promise<PutResult> {
    for (const [k, v] of this.links) if (v.expiresAt + LINK_PURGE_AFTER_MS < now) this.links.delete(k);
    const same = [...this.links.values()].find((x) => x.ownerId === rec.ownerId && x.type === rec.type && x.targetKey === rec.targetKey && isLive(x, now));
    if (same) return { status: 'existing', rec: { ...same } };
    if ([...this.links.values()].filter((x) => x.ownerId === rec.ownerId && x.day === rec.day).length >= perDay) return { status: 'limit' };
    if (this.links.has(rec.token)) return { status: 'taken' };
    this.links.set(rec.token, { ...rec });
    return { status: 'created', rec: { ...rec } };
  }
  async get(token: string) { const r = this.links.get(token); return r ? { ...r } : null; }
  async revoke(token: string, ownerId: string, now: number) {
    const r = this.links.get(token);
    if (!r || r.ownerId !== ownerId || !isLive(r, now)) return null;
    r.revokedAt = now;
    return { ...r };
  }
  async listOf(ownerId: string, day: string, now: number) {
    const mine = [...this.links.values()].filter((x) => x.ownerId === ownerId);
    return { links: mine.filter((x) => isLive(x, now)).sort((a, b) => b.createdAt - a.createdAt).map((x) => ({ ...x })), madeToday: mine.filter((x) => x.day === day).length };
  }
  async limitCheck(keys: string[], now: number) {
    const waits = keys.map((k) => (this.limits.get(k)?.lockedUntil ?? 0) - now).filter((w) => w > 0);
    return waits.length ? Math.max(...waits) : null;
  }
  async limitNote(keys: string[], now: number, failed: boolean, rules: LinkLimitRules) {
    for (const k of keys) this.limits.set(k, linkLimitStep(this.limits.get(k) ?? null, now, failed, rules));
  }
  /** REQ-LINK-020: account deletion removes the player's links. */
  forget(ownerId: string) { for (const [k, v] of this.links) if (v.ownerId === ownerId) this.links.delete(k); }
}
