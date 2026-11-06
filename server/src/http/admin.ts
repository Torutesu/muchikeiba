import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import type { ConfigBundle, ConfigVersion, Activation, ActiveConfigInfo } from '../ops/config.js';
import { requireRole, type AdminPrincipal, type AdminRole, type AuditEntry, type AuditInput, type AuditQuery } from '../ops/admin.js';
import { checkGrantLimits, grantSchema, itemIdSchema, type Grant } from '../ops/support.js';
import type { ModerationChange, ModerationStatus, RaceIntegrityReport, RaceReport } from '../ops/integrity.js';
import type { LeaderboardApi, PlayerInvoker } from './app.js';
import { BASE_BANNED_SILKS, bannedMatch, bannedSilksListSchema, bannedSilksProblems, combinedBanned, type BannedSilksList } from '../domain/bannedSilks.js';
import { VISUALS } from '../domain/visuals.js';
import type { TournamentsService } from '../domain/tournamentService.js';
import { DEAD_LETTER_SOURCES, type DeadLetterApi, type DeadLetterSource, type DeadLetterStatus } from '../ops/deadLetter.js';

const dl = (ctx: AdminContext): DeadLetterApi => {
  if (!ctx.ops.deadLetters) throw new AppError('NOT_FOUND', 'dead letters are not available');
  return ctx.ops.deadLetters;
};
const dlSource = (s: string | undefined): DeadLetterSource => {
  if (!s || !(DEAD_LETTER_SOURCES as readonly string[]).includes(s)) throw new AppError('BAD_REQUEST', `source must be one of ${DEAD_LETTER_SOURCES.join('|')}`);
  return s as DeadLetterSource;
};
const dlScope = z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/);

/** Ops backend as seen by the admin API (Durable Objects in production, in-memory in tests). */
export interface OpsApi {
  admit(principalId: string, kind: 'read' | 'write', now: number): Promise<unknown>;
  audit(e: AuditInput, now: number): Promise<unknown>;
  auditQuery(q: AuditQuery): Promise<AuditEntry[]>;
  config: {
    active(now: number, knownHash: string | null): Promise<ActiveConfigInfo>;
    validate(bundle: unknown): Promise<{ problems: string[] }>;
    stage(bundle: unknown, by: string, note: string, now: number): Promise<{ version: ConfigVersion; created: boolean }>;
    schedule(versionId: string, at: number, by: string, reason: string, now: number): Promise<Activation>;
    cancel(activationId: string, now: number): Promise<Activation>;
    rollback(versionId: string | null, by: string, reason: string, now: number): Promise<Activation>;
    list(now: number): Promise<unknown>;
    get(id: string): Promise<ConfigVersion>;
  };
  integrity: {
    recordRace(r: RaceIntegrityReport): Promise<ModerationChange[]>;
    report(raceId: string, reporterId: string, now: number): Promise<RaceReport>;
    reports(status: RaceReport['status'] | undefined, limit: number): Promise<RaceReport[]>;
    resolveReport(id: string, resolution: string, by: string, now: number): Promise<RaceReport>;
    view(playerId: string, now: number): Promise<unknown>;
    list(status: ModerationStatus | 'flagged' | undefined, now: number, limit: number): Promise<unknown>;
    ban(playerId: string, until: number | null, reason: string, by: string, now: number): Promise<ModerationChange>;
    unban(playerId: string, reason: string, by: string, now: number): Promise<ModerationChange>;
    release(playerId: string, reason: string, by: string, now: number): Promise<ModerationChange>;
  };
  /** REQ-OPS-041: dead letters (optional so deployments/tests without the owners still boot). */
  deadLetters?: DeadLetterApi;
}

export interface AdminContext {
  ops: OpsApi;
  authenticateAdmin(req: Request): Promise<AdminPrincipal>;
  player(uid: string): PlayerInvoker;
  leaderboard: LeaderboardApi;
  paidBalance(): Promise<unknown>;
  replay(raceId: string): Promise<unknown>;
  clock?: () => number;
  /** REQ-TOUR-001/010 (absent = tournament routes answer NOT_FOUND). */
  tournaments?: TournamentsService;
}
const tours = (ctx: AdminContext) => {
  if (!ctx.tournaments) throw new AppError('NOT_FOUND', 'tournaments are not available');
  return ctx.tournaments;
};

interface Outcome { result: unknown; target?: string | null; before?: unknown; after?: unknown }
interface AdminRoute {
  method: string; path: string; role: AdminRole; write: boolean; action: string;
  handler(req: AdminRequest): Promise<Outcome>;
}
interface AdminRequest { params: Record<string, string>; query: URLSearchParams; body: Record<string, unknown>; principal: AdminPrincipal; ctx: AdminContext; now: number; reason: string | null }

/** Every write carries a human reason; it lands in the audit log (REQ-OPS-012). */
const reasonSchema = z.string().trim().min(3).max(500);
const pid = z.string().min(1).max(128);
const opKeySchema = z.string().regex(/^[A-Za-z0-9_.:-]{4,100}$/);
/** Bulk grant per-recipient op key; '/' is outside opKeySchema so it can never equal a single-grant key. */
export const bulkOpKey = (opKey: string, playerId: string) => `bulk/${opKey}/${playerId}`;
export const BULK_MAX_RECIPIENTS = 200;
export const BULK_MAX_TOTAL_COINS = 1_000_000;

function parse<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new AppError('BAD_REQUEST', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}
const num = (q: URLSearchParams, k: string, def: number) => {
  const v = q.get(k);
  if (v === null) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new AppError('BAD_REQUEST', `${k} must be a non-negative integer`);
  return n;
};

export const adminRoutes: AdminRoute[] = [
  // ---- who am I / existing reports ----
  { method: 'GET', path: '/v1/admin/whoami', role: 'viewer', write: false, action: 'whoami', handler: async (r) => ({ result: r.principal }) },
  { method: 'GET', path: '/v1/admin/paid-balance', role: 'viewer', write: false, action: 'accounting.view', handler: async (r) => ({ result: await r.ctx.paidBalance() }) },
  { method: 'GET', path: '/v1/admin/replays/:raceId', role: 'viewer', write: false, action: 'replay.view', handler: async (r) => ({ result: await r.ctx.replay(r.params.raceId!), target: `race:${r.params.raceId}` }) },
  { method: 'GET', path: '/v1/admin/audit', role: 'viewer', write: false, action: 'audit.view', handler: async (r) => {
    const q: AuditQuery = { limit: num(r.query, 'limit', 50) };
    for (const k of ['actor', 'target', 'action'] as const) { const v = r.query.get(k); if (v) q[k] = v; }
    const before = r.query.get('beforeSeq');
    if (before) q.beforeSeq = num(r.query, 'beforeSeq', 0);
    return { result: { entries: await r.ctx.ops.auditQuery(q) } };
  } },

  // ---- remote config (REQ-OPS-002..007) ----
  { method: 'GET', path: '/v1/admin/config', role: 'viewer', write: false, action: 'config.list', handler: async (r) => ({ result: await r.ctx.ops.config.list(r.now) }) },
  { method: 'GET', path: '/v1/admin/config/versions/:id', role: 'viewer', write: false, action: 'config.view', handler: async (r) => ({ result: await r.ctx.ops.config.get(r.params.id!), target: `config:${r.params.id}` }) },
  { method: 'POST', path: '/v1/admin/config/validate', role: 'viewer', write: false, action: 'config.validate', handler: async (r) => ({ result: await r.ctx.ops.config.validate(r.body.bundle) }) },
  { method: 'POST', path: '/v1/admin/config/versions', role: 'operator', write: true, action: 'config.stage', handler: async (r) => {
    const b = parse(z.object({ bundle: z.record(z.string(), z.unknown()), note: z.string().max(500).default(''), reason: z.string() }), r.body);
    const out = await r.ctx.ops.config.stage(b.bundle as ConfigBundle, r.principal.id, b.note, r.now);
    return { result: out, target: `config:${out.version.id}`, after: { id: out.version.id, hash: out.version.hash, rulesetVersion: out.version.rulesetVersion, created: out.created } };
  } },
  { method: 'POST', path: '/v1/admin/config/activations', role: 'admin', write: true, action: 'config.activate', handler: async (r) => {
    const b = parse(z.object({ versionId: z.string().min(1), at: z.number().int().optional(), reason: z.string() }), r.body);
    const before = await r.ctx.ops.config.active(r.now, 'x'); // hash only
    const a = await r.ctx.ops.config.schedule(b.versionId, b.at ?? r.now, r.principal.id, r.reason!, r.now);
    return { result: a, target: `config:${b.versionId}`, before: { activeVersion: before.versionId }, after: a };
  } },
  { method: 'POST', path: '/v1/admin/config/activations/:id/cancel', role: 'admin', write: true, action: 'config.cancel', handler: async (r) => {
    const a = await r.ctx.ops.config.cancel(r.params.id!, r.now);
    return { result: a, target: `config:${a.versionId}`, after: a };
  } },
  { method: 'POST', path: '/v1/admin/config/rollback', role: 'admin', write: true, action: 'config.rollback', handler: async (r) => {
    const b = parse(z.object({ versionId: z.string().min(1).nullable().default(null), reason: z.string() }), r.body);
    const before = await r.ctx.ops.config.active(r.now, 'x');
    const a = await r.ctx.ops.config.rollback(b.versionId, r.principal.id, r.reason!, r.now);
    return { result: a, target: `config:${a.versionId}`, before: { activeVersion: before.versionId }, after: { activeVersion: a.versionId } };
  } },

  // ---- support (REQ-OPS-020..025) ----
  { method: 'GET', path: '/v1/admin/players/:playerId', role: 'viewer', write: false, action: 'player.view', handler: async (r) => {
    const id = parse(pid, r.params.playerId);
    const [state, integrity] = await Promise.all([r.ctx.player(id).invoke('adminView', id), r.ctx.ops.integrity.view(id, r.now)]);
    return { result: { state, integrity }, target: `player:${id}` };
  } },
  { method: 'POST', path: '/v1/admin/players/:playerId/grants', role: 'operator', write: true, action: 'player.grant', handler: async (r) => {
    const id = parse(pid, r.params.playerId);
    const b = parse(z.object({ grant: grantSchema, opKey: opKeySchema, reason: z.string() }), r.body);
    checkGrantLimits(b.grant, r.principal.role);
    const out = await r.ctx.player(id).invoke('adminGrant', id, b.grant, r.reason!, r.principal.id, b.opKey);
    return { result: out, target: `player:${id}`, before: out.before, after: out.after };
  } },
  { method: 'POST', path: '/v1/admin/grants/bulk', role: 'operator', write: true, action: 'player.grant.bulk', handler: async (r) => {
    const b = parse(z.object({
      grant: grantSchema, opKey: opKeySchema, reason: z.string(),
      playerIds: z.array(pid).max(BULK_MAX_RECIPIENTS).optional(),
      segment: z.object({ kind: z.literal('leaderboard'), seasonId: z.string().regex(/^\d{4}-\d{2}$/), board: z.string().regex(/^(class-[A-Z]|rating)$/), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(BULK_MAX_RECIPIENTS).default(BULK_MAX_RECIPIENTS) }).strict().optional(),
    }), r.body);
    checkGrantLimits(b.grant, r.principal.role);
    if (!b.playerIds === !b.segment) throw new AppError('BAD_REQUEST', 'give exactly one of playerIds or segment');
    let ids = b.playerIds ?? [];
    let total: number | null = null;
    if (b.segment) {
      const file = (await r.ctx.leaderboard.board(b.segment.seasonId, b.segment.board)) as { entries?: { playerId: string }[]; total?: number };
      total = file.total ?? file.entries?.length ?? 0;
      ids = (file.entries ?? []).slice(b.segment.offset, b.segment.offset + b.segment.limit).map((e) => e.playerId);
    }
    ids = [...new Set(ids)];
    if ((b.grant.freeCoins ?? 0) * ids.length > BULK_MAX_TOTAL_COINS) throw new AppError('FORBIDDEN', `bulk grant over the ${BULK_MAX_TOTAL_COINS} coin cap; split it`);
    const results: { playerId: string; ok: boolean; error?: string }[] = [];
    for (const id of ids) {
      try {
        // per-recipient key: re-running the same bulk call never grants twice. '/' cannot appear in a client
        // opKey (opKeySchema), so bulk keys never collide with single-grant keys (review r5 #5).
        await r.ctx.player(id).invoke('adminGrant', id, b.grant as Grant, r.reason!, r.principal.id, bulkOpKey(b.opKey, id));
        results.push({ playerId: id, ok: true });
      } catch (e) {
        results.push({ playerId: id, ok: false, error: e instanceof AppError ? e.code : 'INTERNAL' });
      }
    }
    const next = b.segment && total !== null && b.segment.offset + b.segment.limit < total ? b.segment.offset + b.segment.limit : null;
    return { result: { granted: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok), nextOffset: next }, target: b.segment ? `segment:${b.segment.seasonId}/${b.segment.board}` : `players:${ids.length}`, after: { grant: b.grant, recipients: ids } };
  } },
  { method: 'POST', path: '/v1/admin/players/:playerId/debt/settle', role: 'operator', write: true, action: 'player.debt.settle', handler: async (r) => {
    const id = parse(pid, r.params.playerId);
    const b = parse(z.object({ coins: z.number().int().min(0).default(0), items: z.record(itemIdSchema, z.number().int().min(1)).default({}), opKey: opKeySchema, reason: z.string() }), r.body);
    const out = await r.ctx.player(id).invoke('adminSettleDebt', id, b.coins, b.items, r.reason!, r.principal.id, b.opKey);
    return { result: out, target: `player:${id}`, before: out.before, after: out.after };
  } },
  { method: 'PUT', path: '/v1/admin/players/:playerId/age', role: 'operator', write: true, action: 'player.age.correct', handler: async (r) => {
    const id = parse(pid, r.params.playerId);
    const b = parse(z.object({ birthYear: z.number().int(), birthMonth: z.number().int().min(1).max(12), guardianConsent: z.boolean(), reason: z.string() }), r.body);
    const out = await r.ctx.player(id).invoke('adminCorrectAge', id, b.birthYear, b.birthMonth, b.guardianConsent, r.principal.id);
    return { result: out, target: `player:${id}`, before: out.before, after: out.after };
  } },
  { method: 'POST', path: '/v1/admin/players/:playerId/name-reset', role: 'operator', write: true, action: 'player.name.reset', handler: async (r) => {
    const id = parse(pid, r.params.playerId);
    const b = parse(z.object({ target: z.enum(['display', 'horse']), horseId: z.string().min(1).nullable().default(null), reason: z.string() }), r.body);
    const out = await r.ctx.player(id).invoke('adminResetName', id, b.target, b.horseId);
    return { result: out, target: `player:${id}`, before: out.before, after: out.after };
  } },

  // ---- anti-cheat & reports (REQ-OPS-030..035) ----
  { method: 'GET', path: '/v1/admin/integrity/players', role: 'viewer', write: false, action: 'integrity.list', handler: async (r) => {
    const st = r.query.get('status');
    if (st && !['ok', 'quarantined', 'banned', 'flagged'].includes(st)) throw new AppError('BAD_REQUEST', 'bad status');
    return { result: { players: await r.ctx.ops.integrity.list((st ?? undefined) as ModerationStatus | 'flagged' | undefined, r.now, num(r.query, 'limit', 100)) } };
  } },
  { method: 'GET', path: '/v1/admin/integrity/players/:playerId', role: 'viewer', write: false, action: 'integrity.view', handler: async (r) => ({ result: await r.ctx.ops.integrity.view(r.params.playerId!, r.now), target: `player:${r.params.playerId}` }) },
  { method: 'POST', path: '/v1/admin/integrity/players/:playerId/release', role: 'operator', write: true, action: 'integrity.release', handler: async (r) => {
    const id = parse(pid, r.params.playerId);
    const c = await r.ctx.ops.integrity.release(id, r.reason!, r.principal.id, r.now);
    return { result: c, target: `player:${id}`, before: { status: 'quarantined' }, after: { status: c.status } };
  } },
  { method: 'POST', path: '/v1/admin/integrity/players/:playerId/ban', role: 'admin', write: true, action: 'integrity.ban', handler: async (r) => {
    const id = parse(pid, r.params.playerId);
    const b = parse(z.object({ until: z.number().int().nullable().default(null), reason: z.string() }), r.body);
    const before = (await r.ctx.ops.integrity.view(id, r.now)) as { status: string };
    const c = await r.ctx.ops.integrity.ban(id, b.until, r.reason!, r.principal.id, r.now);
    return { result: c, target: `player:${id}`, before: { status: before.status }, after: { status: c.status, until: c.until } };
  } },
  { method: 'POST', path: '/v1/admin/integrity/players/:playerId/unban', role: 'admin', write: true, action: 'integrity.unban', handler: async (r) => {
    const id = parse(pid, r.params.playerId);
    const c = await r.ctx.ops.integrity.unban(id, r.reason!, r.principal.id, r.now);
    return { result: c, target: `player:${id}`, before: { status: 'banned' }, after: { status: c.status } };
  } },
  // ---- dead letters (REQ-OPS-041) ----
  // ---- tournaments (REQ-TOUR-001/010) ----
  { method: 'POST', path: '/v1/admin/tournaments', role: 'operator', write: true, action: 'tournament.create', handler: async (r) => {
    const out = (await tours(r.ctx).adminCreate(r.body.tournament, r.principal.id)) as { id: string };
    return { result: out, target: `tournament:${out.id}`, after: r.body.tournament };
  } },
  { method: 'GET', path: '/v1/admin/tournaments/:id', role: 'viewer', write: false, action: 'tournament.view', handler: async (r) => ({ result: await tours(r.ctx).detail(r.params.id!), target: `tournament:${r.params.id}` }) },
  { method: 'POST', path: '/v1/admin/tournaments/:id/cancel', role: 'operator', write: true, action: 'tournament.cancel', handler: async (r) => ({
    result: await tours(r.ctx).adminCancel(r.params.id!, r.reason!, r.principal.id), target: `tournament:${r.params.id}`,
  }) },
  { method: 'GET', path: '/v1/admin/dead-letters', role: 'viewer', write: false, action: 'deadletter.list', handler: async (r) => {
    const st = r.query.get('status') ?? 'open';
    if (!['open', 'resolved', 'dismissed', 'all'].includes(st)) throw new AppError('BAD_REQUEST', 'status must be open|resolved|dismissed|all');
    const src = r.query.get('source');
    const items = await dl(r.ctx).list({ ...(st !== 'all' ? { status: st as DeadLetterStatus } : {}), ...(src ? { source: dlSource(src) } : {}), limit: Math.min(500, num(r.query, 'limit', 100)) });
    return { result: { items } };
  } },
  { method: 'GET', path: '/v1/admin/dead-letters/:source/:scope', role: 'viewer', write: false, action: 'deadletter.inspect', handler: async (r) => {
    const source = dlSource(r.params.source);
    const scope = parse(dlScope, r.params.scope);
    return { result: { items: await dl(r.ctx).inspect(source, scope, r.now) }, target: `deadletter:${source}/${scope}` };
  } },
  { method: 'POST', path: '/v1/admin/dead-letters/:source/:scope/:itemId/retry', role: 'operator', write: true, action: 'deadletter.retry', handler: async (r) => {
    const source = dlSource(r.params.source);
    const scope = parse(dlScope, r.params.scope);
    const itemId = parse(pid, r.params.itemId);
    const rec = await dl(r.ctx).retry(source, scope, itemId, r.principal.id, r.now);
    return { result: rec, target: `deadletter:${source}/${scope}/${itemId}`, after: { status: rec.status, error: rec.status === 'open' ? rec.error : null } };
  } },
  { method: 'POST', path: '/v1/admin/dead-letters/:source/:scope/:itemId/dismiss', role: 'admin', write: true, action: 'deadletter.dismiss', handler: async (r) => {
    const source = dlSource(r.params.source);
    const scope = parse(dlScope, r.params.scope);
    const itemId = parse(pid, r.params.itemId);
    const b = parse(z.object({ note: z.string().trim().min(3).max(500), reason: z.string() }), r.body);
    const rec = await dl(r.ctx).dismiss(source, scope, itemId, r.principal.id, b.note, r.now);
    return { result: rec, target: `deadletter:${source}/${scope}/${itemId}`, before: { status: 'open' }, after: { status: rec.status, note: b.note } };
  } },

  // ---- banned real silks (REQ-OPS-040) ----
  { method: 'GET', path: '/v1/admin/silks/banned', role: 'viewer', write: false, action: 'silks.banned.view', handler: async (r) => {
    const a = await r.ctx.ops.config.active(r.now, null);
    const list = (a.bundle?.bannedSilks as BannedSilksList | undefined) ?? BASE_BANNED_SILKS;
    return { result: { versionId: a.versionId, source: a.bundle?.bannedSilks ? 'remote-config' : 'master/banned-silks.json', list } };
  } },
  { method: 'POST', path: '/v1/admin/silks/banned/check', role: 'viewer', write: false, action: 'silks.banned.check', handler: async (r) => {
    const s = parse(z.object({ pattern: z.string(), colors: z.array(z.string()).min(2).max(3), cap: z.string() }).strict(), r.body.silks);
    const a = await r.ctx.ops.config.active(r.now, null);
    const list = (a.bundle?.bannedSilks as BannedSilksList | undefined) ?? BASE_BANNED_SILKS;
    return { result: { banned: bannedMatch(combinedBanned(list, VISUALS), s) } };
  } },
  /**
   * Imports a full replacement list: validated against the visuals catalogue, then staged as a NEW remote-config
   * version on top of the active bundle (activation stays a separate admin step, like every config change).
   */
  { method: 'POST', path: '/v1/admin/silks/banned/import', role: 'admin', write: true, action: 'silks.banned.import', handler: async (r) => {
    const b = parse(z.object({ list: bannedSilksListSchema, reason: z.string() }).strict(), r.body);
    const list = b.list as BannedSilksList;
    const problems = bannedSilksProblems(list, VISUALS);
    if (problems.length) throw new AppError('BAD_REQUEST', problems.join('; '));
    const active = await r.ctx.ops.config.active(r.now, null);
    const bundle = { ...(active.bundle ?? {}), bannedSilks: list } as ConfigBundle;
    const out = await r.ctx.ops.config.stage(bundle, r.principal.id, `banned silks import: ${list.entries.length} entries`, r.now);
    const before = (active.bundle?.bannedSilks as BannedSilksList | undefined) ?? BASE_BANNED_SILKS;
    return { result: { ...out, entries: list.entries.length, note: 'staged; activate it with POST /v1/admin/config/activations' }, target: `config:${out.version.id}`, before: { entries: before.entries.length, basedOn: active.versionId }, after: { entries: list.entries.length, version: out.version.id } };
  } },

  { method: 'GET', path: '/v1/admin/reports', role: 'viewer', write: false, action: 'reports.list', handler: async (r) => {
    const st = r.query.get('status');
    if (st && st !== 'open' && st !== 'resolved') throw new AppError('BAD_REQUEST', 'bad status');
    return { result: { reports: await r.ctx.ops.integrity.reports((st ?? undefined) as RaceReport['status'] | undefined, num(r.query, 'limit', 100)) } };
  } },
  { method: 'POST', path: '/v1/admin/reports/:reportId/resolve', role: 'operator', write: true, action: 'reports.resolve', handler: async (r) => {
    const b = parse(z.object({ resolution: z.string().trim().min(2).max(200), reason: z.string() }), r.body);
    const rep = await r.ctx.ops.integrity.resolveReport(r.params.reportId!, b.resolution, r.principal.id, r.now);
    return { result: rep, target: `race:${rep.raceId}`, before: { status: 'open' }, after: { status: rep.status, resolution: rep.resolution } };
  } },
];

function matchPath(path: string, pattern: string): Record<string, string> | null {
  const a = path.split('/');
  const b = pattern.split('/');
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < b.length; i++) {
    if (b[i]!.startsWith(':')) {
      if (!a[i]) return null;
      params[b[i]!.slice(1)] = decodeURIComponent(a[i]!);
    } else if (a[i] !== b[i]) return null;
  }
  return params;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

/**
 * Admin API (REQ-OPS-010..014): authenticate → role check → rate limit → run → audit (success and failure).
 * Writes require a `reason`. Reads are audited too (who looked at which player).
 */
export async function handleAdmin(req: Request, ctx: AdminContext): Promise<Response> {
  const url = new URL(req.url);
  const now = (ctx.clock ?? Date.now)();
  let principal: AdminPrincipal | null = null;
  let route: AdminRoute | null = null;
  let params: Record<string, string> = {};
  let reason: string | null = null;
  try {
    principal = await ctx.authenticateAdmin(req);
    let methodMismatch = false;
    for (const r of adminRoutes) {
      const p = matchPath(url.pathname, r.path);
      if (!p) continue;
      if (r.method !== req.method) { methodMismatch = true; continue; }
      route = r;
      params = p;
      break;
    }
    if (!route) return json({ error: { code: methodMismatch ? 'BAD_REQUEST' : 'NOT_FOUND', message: methodMismatch ? 'method not allowed' : 'NOT_FOUND' } }, methodMismatch ? 405 : 404);
    requireRole(principal, route.role);
    await ctx.ops.admit(principal.id, route.write ? 'write' : 'read', now);
    let body: Record<string, unknown> = {};
    if (req.method !== 'GET') {
      try {
        const raw = await req.json();
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) body = raw as Record<string, unknown>;
        else throw new Error('not an object');
      } catch {
        if (route.write) throw new AppError('BAD_REQUEST', 'JSON object body required');
      }
    }
    if (route.write) reason = parse(reasonSchema, body.reason);
    const out = await route.handler({ params, query: url.searchParams, body, principal, ctx, now, reason });
    await ctx.ops.audit({
      actor: principal.id, role: principal.role, action: route.action, method: req.method, path: url.pathname,
      target: out.target ?? null, reason, before: out.before ?? null, after: out.after ?? null, result: 'ok',
    }, now);
    return json(out.result);
  } catch (e) {
    const err = e instanceof AppError ? e : null;
    if (!err) console.error(e);
    if (principal && route) {
      try {
        await ctx.ops.audit({
          actor: principal.id, role: principal.role, action: route.action, method: req.method, path: url.pathname,
          target: params.playerId ? `player:${params.playerId}` : null, reason, before: null, after: null, result: 'error', error: err?.code ?? 'INTERNAL',
        }, now);
      } catch (ae) {
        console.error('audit write failed', ae);
      }
    }
    if (err) return json({ error: { code: err.code, message: err.message } }, err.status);
    return json({ error: { code: 'INTERNAL', message: 'internal error' } }, 500);
  }
}
