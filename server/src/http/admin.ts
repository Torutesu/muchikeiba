import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import { BASE_VERSION_ID, bundleDiff, groupProblems, resolveBundle, type ConfigBundle, type ConfigVersion, type Activation, type ActiveConfigInfo, type DryRunOp, type DryRunResult } from '../ops/config.js';
import { OPS_TITLE_KEYS, GIFT_BOX_LIMITS } from '../domain/giftBox.js';
import { compPaymentKey, needsApproval, NEEDS_SECOND_PERSON, COMP_APPROVAL_THRESHOLD, COMP_HARD_CAP, type CompensationGift, type CompensationQuery, type CompensationRequest, type CompensationStatus } from '../ops/compensation.js';
import type { Master } from '../domain/master.js';
import { bannerStatus, carryOverRule, findBanner, finalPityGroup, oddsDisclosure, pityLabel } from '../domain/gacha.js';
import { eventStatus } from '../domain/events.js';
import { exchangeClosesAt } from '../domain/exchange.js';
import { dayRule, gameDayKey } from '../domain/time.js';
import { normalizeInviteCode } from '../domain/invite.js';
import { requireRole, type AdminPrincipal, type AdminRole, type AuditEntry, type AuditInput, type AuditQuery } from '../ops/admin.js';
import { checkGrantLimits, grantSchema, itemIdSchema, TWO_PERSON_REQUIRED, type Grant } from '../ops/support.js';
import type { ModerationChange, ModerationStatus, RaceIntegrityReport, RaceReport } from '../ops/integrity.js';
import type { LeaderboardApi, PlayerInvoker } from './app.js';
import type { PlayerService } from '../domain/service.js';
import { HISTORY_LIMITS, historyQuery, REF_RE } from '../domain/history.js';
import { BASE_BANNED_SILKS, bannedMatch, bannedSilksListSchema, bannedSilksProblems, combinedBanned, type BannedSilksList } from '../domain/bannedSilks.js';
import { VISUALS } from '../domain/visuals.js';
import type { TournamentsService } from '../domain/tournamentService.js';
import { INQUIRY_CATEGORIES, type InquiryCategory, type InquirySummary } from '../domain/help.js';
import { INQUIRY_STATUSES, type InquiryQuery } from '../ops/inquiries.js';
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
    /** REQ-OPS-008: dry run of activate / rollback / cancel (nothing stored). */
    dryRun(op: DryRunOp, by: string, now: number): Promise<DryRunResult>;
  };
  /** REQ-OPS-026: compensation requests under the two-person rule (absent = the routes answer NOT_FOUND). */
  compensations?: {
    create(input: { opKey: string; playerId: string; grant: Grant; reason: string; gift?: CompensationGift }, by: AdminPrincipal, now: number): Promise<{ request: CompensationRequest; created: boolean }>;
    get(id: string, now: number): Promise<CompensationRequest>;
    list(q: CompensationQuery, now: number): Promise<CompensationRequest[]>;
    approve(id: string, by: AdminPrincipal, note: string, now: number): Promise<CompensationRequest>;
    reject(id: string, by: AdminPrincipal, note: string, now: number): Promise<CompensationRequest>;
    executed(id: string, error: string | null, now: number): Promise<CompensationRequest>;
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
  /** REQ-HELP-016: the inquiry index (no text; absent = the inquiry list answers NOT_FOUND). */
  inquiries?: {
    upsert(items: InquirySummary[]): Promise<{ stored: number }>;
    list(q: InquiryQuery): Promise<InquirySummary[]>;
    forgetPlayer(playerId: string): Promise<{ removed: number }>;
  };
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
  /** The shipped master (remote-config versions are resolved on top of it). Absent = no gacha calendar / events view. */
  baseMaster?: Master;
  /** REQ-INV-*: invite code → player id (null for unknown or retired codes). Absent = lookup by code answers NOT_FOUND. */
  inviteLookup?(code: string): Promise<string | null>;
  /** REQ-OPS-015: browser origins of the ops console allowed to call the admin API (CORS, no credentials). */
  consoleOrigins?: readonly string[];
}
const tours = (ctx: AdminContext) => {
  if (!ctx.tournaments) throw new AppError('NOT_FOUND', 'tournaments are not available');
  return ctx.tournaments;
};
const inq = (ctx: AdminContext) => {
  if (!ctx.ops.inquiries) throw new AppError('NOT_FOUND', 'inquiries are not available');
  return ctx.ops.inquiries;
};
const ticketIdSchema = z.string().regex(/^q_[0-9]{1,9}$/);
/** REQ-HELP-016: write ticket summaries to the index and tell the player object (best effort: an unindexed ticket is re-sent later). */
async function reindex(ctx: AdminContext, playerId: string, items: InquirySummary[]) {
  if (!ctx.ops.inquiries || items.length === 0) return;
  try {
    await ctx.ops.inquiries.upsert(items);
    await ctx.player(playerId).invoke('helpInquiryIndexed', playerId, items.map((x) => ({ ticketId: x.ticketId, updatedAt: x.updatedAt })));
  } catch (e) { console.error('inquiry index write failed', playerId, (e as Error).message); }
}
const comps = (ctx: AdminContext) => {
  if (!ctx.ops.compensations) throw new AppError('NOT_FOUND', 'compensations are not available');
  return ctx.ops.compensations;
};

/** The master a config version resolves to (`active` = the version in effect now, `base` = the shipped master). */
async function masterFor(ctx: AdminContext, versionId: string | null, now: number): Promise<{ versionId: string; master: Master }> {
  if (!ctx.baseMaster) throw new AppError('NOT_FOUND', 'master data is not available');
  let id = versionId ?? 'active';
  let bundle: ConfigBundle | null = null;
  if (id === 'active') {
    const a = await ctx.ops.config.active(now, null);
    id = a.versionId;
    bundle = a.bundle;
  } else if (id !== BASE_VERSION_ID) {
    bundle = (await ctx.ops.config.get(id)).bundle;
  }
  return { versionId: id, master: bundle ? resolveBundle(ctx.baseMaster, bundle).master : ctx.baseMaster };
}
async function bundleOf(ctx: AdminContext, id: string): Promise<ConfigBundle> {
  if (id === BASE_VERSION_ID) return {};
  return (await ctx.ops.config.get(id)).bundle;
}

/** REQ-OPS-027: the gacha calendar of one resolved master (game-day aware), as the console draws it. */
export function gachaCalendar(m: Master, now: number) {
  const rule = dayRule(m);
  const lastDay = (endAtMs: number | undefined) => (endAtMs !== undefined ? gameDayKey(endAtMs - 1, rule) : null);
  const chain = (group: string) => {
    const out = [group];
    let cur = group;
    for (let i = 0; i < 16; i++) {
      const g = m.gacha.pityGroups[cur];
      if (!g || g.endAtMs === undefined) break;
      cur = g.convertTo ?? 'standard';
      if (out.includes(cur)) break;
      out.push(cur);
    }
    return out;
  };
  return {
    serverNowMs: now, today: gameDayKey(now, rule), dayRollover: rule,
    banners: m.gacha.banners.map((b) => {
      const pk = b.pickupTemplateId ? m.templateById.get(b.pickupTemplateId) : undefined;
      return {
        id: b.id, name: b.name, currency: b.currency, priceSingle: b.priceSingle, priceTen: b.priceTen,
        status: bannerStatus(b, now), startAtMs: b.startAtMs ?? null, endAtMs: b.endAtMs ?? null, announceAtMs: b.announceAtMs ?? null,
        firstDay: b.startAtMs !== undefined ? gameDayKey(b.startAtMs, rule) : null, lastDay: lastDay(b.endAtMs),
        pityGroup: b.pityGroup, pityLabel: pityLabel(m, b.pityGroup), pityCost: m.gacha.pityGroups[b.pityGroup]?.cost ?? null,
        pityTargets: b.pityTargets.map((id) => ({ templateId: id, name: m.templateById.get(id)?.name ?? id })),
        pickup: pk ? { templateId: pk.id, name: pk.name, rarity: pk.rarity } : null,
        stepUp: b.stepUp ? { afterLast: b.stepUp.afterLast, prices: b.stepUp.steps.map((x) => x.priceTen), finalSlotSteps: b.stepUp.steps.flatMap((x, i) => (x.finalSlotPool ? [i + 1] : [])) } : null,
      };
    }),
    pityGroups: Object.entries(m.gacha.pityGroups).map(([id, g]) => ({
      id, label: pityLabel(m, id), cost: g.cost, endAtMs: g.endAtMs ?? null, lastDay: lastDay(g.endAtMs),
      convertTo: g.endAtMs !== undefined ? g.convertTo ?? 'standard' : null, finalGroup: finalPityGroup(m, id), chain: chain(id),
      banners: m.gacha.banners.filter((b) => b.pityGroup === id).map((b) => b.id),
      carryOver: carryOverRule(m, id),
    })),
  };
}

/** Support flags as stored (`kind:detail…`), split for display. */
export function parseSupportFlags(flags: string[]) {
  const groupOf = (kind: string) => (kind.startsWith('invite_') ? 'invite' : kind.startsWith('ads_') ? 'ads' : kind.startsWith('gift_') ? 'gift'
    : /^(promotion_not_reached|once_duplicate|pass_duplicate|allowance_overlap|purchase_while_)/.test(kind) ? 'purchase'
      : kind.startsWith('team_feed') ? 'social' : 'support');
  return flags.map((raw) => {
    const i = raw.indexOf(':');
    const kind = i < 0 ? raw : raw.slice(0, i);
    return { raw, kind, group: groupOf(kind), detail: i < 0 ? '' : raw.slice(i + 1) };
  });
}
const COMP_STATUSES: CompensationStatus[] = ['pending', 'approved', 'executed', 'rejected', 'expired'];

/** Pays an approved compensation (idempotent per request on the player side) and records the outcome on the request. */
async function payCompensation(ctx: AdminContext, req: CompensationRequest, now: number) {
  const actor = req.needsApproval ? `${req.requestedBy}, approved by ${req.decidedBy}` : req.requestedBy;
  try {
    // a request nobody else approved counts against the player's 24 h single-person budget (QA R11: no split grants)
    // REQ-BOX-010: a compensation lands in the player's gift box (default expiry 90 days)
    const payment = await ctx.player(req.playerId).invoke('adminGrant', req.playerId, req.grant, req.reason, actor, compPaymentKey(req.opKey), !req.needsApproval, { source: 'ops_compensation', titleKey: req.gift?.titleKey ?? 'ops_compensation', ...(req.gift?.expiryDays !== undefined ? { expiryDays: req.gift.expiryDays } : {}) });
    return { request: await comps(ctx).executed(req.id, null, now), payment };
  } catch (e) {
    if (!req.needsApproval && e instanceof AppError && e.code === 'FORBIDDEN' && e.message.startsWith(TWO_PERSON_REQUIRED)) {
      // over the budget: the request waits for a second admin instead of failing
      return { request: await comps(ctx).executed(req.id, NEEDS_SECOND_PERSON, now), payment: null };
    }
    await comps(ctx).executed(req.id, e instanceof AppError ? e.code : 'INTERNAL', now);
    throw e;
  }
}

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
/** REQ-BOX-010: the gift box title and expiry of an ops grant (days, or null = no expiry). */
const giftOptsSchema = {
  titleKey: z.enum(OPS_TITLE_KEYS).optional(),
  expiryDays: z.number().int().min(GIFT_BOX_LIMITS.opsExpiryDays[0]).max(GIFT_BOX_LIMITS.opsExpiryDays[1]).nullable().optional(),
};
const giftOf = (b: { titleKey?: CompensationGift['titleKey']; expiryDays?: number | null }): CompensationGift => ({ ...(b.titleKey ? { titleKey: b.titleKey } : {}), ...(b.expiryDays !== undefined ? { expiryDays: b.expiryDays } : {}) });
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
  { method: 'POST', path: '/v1/admin/config/validate', role: 'viewer', write: false, action: 'config.validate', handler: async (r) => {
    const out = await r.ctx.ops.config.validate(r.body.bundle);
    return { result: { ...out, ok: out.problems.length === 0, groups: groupProblems(out.problems) } };
  } },
  // REQ-OPS-008: dry run of an activation / rollback / cancellation (same checks as the real call, nothing stored)
  { method: 'POST', path: '/v1/admin/config/dry-run', role: 'viewer', write: false, action: 'config.dryrun', handler: async (r) => {
    const op = parse(z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('activate'), versionId: z.string().min(1).max(64), at: z.number().int().optional() }).strict(),
      z.object({ kind: z.literal('rollback'), versionId: z.string().min(1).max(64).nullable().default(null) }).strict(),
      z.object({ kind: z.literal('cancel'), activationId: z.string().min(1).max(64) }).strict(),
    ]), r.body.op) as DryRunOp;
    const out = await r.ctx.ops.config.dryRun(op, r.principal.id, r.now);
    return { result: { ...out, groups: groupProblems(out.problems) }, target: 'versionId' in op && op.versionId ? `config:${op.versionId}` : null };
  } },
  // REQ-OPS-009: path-level diff of two stored bundles (`base` = the shipped master, an empty bundle)
  { method: 'GET', path: '/v1/admin/config/diff', role: 'viewer', write: false, action: 'config.diff', handler: async (r) => {
    const from = r.query.get('from'), to = r.query.get('to');
    if (!from || !to) throw new AppError('BAD_REQUEST', 'from and to are required (version ids or base)');
    const [a, b] = await Promise.all([bundleOf(r.ctx, from), bundleOf(r.ctx, to)]);
    const changes = bundleDiff(a, b);
    return { result: { from, to, changes: changes.slice(0, 500), total: changes.length, truncated: changes.length > 500 } };
  } },
  // ---- gacha calendar & odds preview (REQ-OPS-027) ----
  { method: 'GET', path: '/v1/admin/gacha/calendar', role: 'viewer', write: false, action: 'gacha.calendar', handler: async (r) => {
    const { versionId, master } = await masterFor(r.ctx, r.query.get('versionId'), r.now);
    return { result: { versionId, ...gachaCalendar(master, r.now) } };
  } },
  /** The odds page exactly as players get it from GET /v1/gacha/:bannerId/odds, for any banner of any version (also hidden / future ones). */
  { method: 'GET', path: '/v1/admin/gacha/:bannerId/odds', role: 'viewer', write: false, action: 'gacha.odds.preview', handler: async (r) => {
    const { versionId, master } = await masterFor(r.ctx, r.query.get('versionId'), r.now);
    return { result: { versionId, odds: oddsDisclosure(master, findBanner(master, r.params.bannerId!)) } };
  } },
  // ---- events (REQ-EVENT-*) ----
  { method: 'GET', path: '/v1/admin/events', role: 'viewer', write: false, action: 'events.list', handler: async (r) => {
    const { versionId, master } = await masterFor(r.ctx, r.query.get('versionId'), r.now);
    return { result: { versionId, serverNowMs: r.now, events: master.events.map((ev) => ({ id: ev.id, name: ev.name, startAtMs: ev.startAtMs, endAtMs: ev.endAtMs, status: eventStatus(ev, r.now), trackIds: ev.trackIds, fee: ev.fee, maxPlayers: ev.rules.maxPlayers, entry: ev.entry,
      // REQ-EXCH-012: the exchange list as players get it (read only; changed through config versions)
      exchange: ev.exchange ? { ...ev.exchange, closesAtMs: exchangeClosesAt(ev, ev.exchange, dayRule(master)) } : null })), tracks: master.tracks.map((t) => ({ id: t.id, surface: t.surface, distanceM: t.distanceM })) } };
  } },
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
  // REQ-OPS-020: find a player by invite code (the code a player reads out to support)
  { method: 'GET', path: '/v1/admin/players/lookup', role: 'viewer', write: false, action: 'player.lookup', handler: async (r) => {
    const code = normalizeInviteCode(r.query.get('inviteCode') ?? '');
    if (!code) throw new AppError('BAD_REQUEST', 'inviteCode is not a well-formed invite code');
    if (!r.ctx.inviteLookup) throw new AppError('NOT_FOUND', 'invite codes are not available');
    const playerId = await r.ctx.inviteLookup(code);
    if (!playerId) throw new AppError('NOT_FOUND', 'no player holds this invite code');
    return { result: { playerId, inviteCode: code }, target: `player:${playerId}` };
  } },
  { method: 'GET', path: '/v1/admin/players/:playerId', role: 'viewer', write: false, action: 'player.view', handler: async (r) => {
    const id = parse(pid, r.params.playerId);
    const [state, integrity, compensations] = await Promise.all([
      r.ctx.player(id).invoke('adminView', id), r.ctx.ops.integrity.view(id, r.now),
      r.ctx.ops.compensations ? r.ctx.ops.compensations.list({ playerId: id, limit: 20 }, r.now) : Promise.resolve([]),
    ]);
    return { result: { state, integrity, flags: parseSupportFlags(state.supportFlags), compensations }, target: `player:${id}` };
  } },
  // REQ-HIST-010 (contracts/protocol.md §33.4): the player's purchase / coin / gacha history, read only (audited like every route)
  { method: 'GET', path: '/v1/admin/players/:playerId/history', role: 'viewer', write: false, action: 'player.history.view', handler: async (r) => {
    const id = parse(pid, r.params.playerId);
    const refs = r.query.get('refs');
    if (refs !== null) {
      const list = refs.split(',').map((x) => x.trim()).filter(Boolean);
      if (list.length < 1 || list.length > HISTORY_LIMITS.ticketRefsMax || list.some((x) => !REF_RE.test(x))) throw new AppError('BAD_REQUEST', `refs: 1..${HISTORY_LIMITS.ticketRefsMax} support references (P-/C-/G-)`);
      return { result: await r.ctx.player(id).invoke('adminHistoryRefs', id, list), target: `player:${id}` };
    }
    const kind = r.query.get('kind') ?? 'summary';
    if (kind !== 'summary' && kind !== 'purchases' && kind !== 'coins' && kind !== 'gacha') throw new AppError('BAD_REQUEST', 'kind must be summary|purchases|coins|gacha');
    return { result: await r.ctx.player(id).invoke('adminHistory', id, kind, historyQuery(r.query, kind)), target: `player:${id}` };
  } },
  { method: 'POST', path: '/v1/admin/players/:playerId/grants', role: 'operator', write: true, action: 'player.grant', handler: async (r) => {
    const id = parse(pid, r.params.playerId);
    const b = parse(z.object({ grant: grantSchema, opKey: opKeySchema, reason: z.string(), ...giftOptsSchema }), r.body);
    checkGrantLimits(b.grant, r.principal.role);
    if (needsApproval(b.grant)) throw new AppError('FORBIDDEN', `over ${COMP_APPROVAL_THRESHOLD.freeCoins} coins / ${COMP_APPROVAL_THRESHOLD.itemQty} per item needs two-person approval: POST /v1/admin/compensations`);
    const out = await r.ctx.player(id).invoke('adminGrant', id, b.grant, r.reason!, r.principal.id, b.opKey, true, { source: 'ops_grant', ...giftOf(b) });
    return { result: out, target: `player:${id}`, before: out.before, after: out.after };
  } },
  { method: 'POST', path: '/v1/admin/grants/bulk', role: 'operator', write: true, action: 'player.grant.bulk', handler: async (r) => {
    const b = parse(z.object({
      grant: grantSchema, opKey: opKeySchema, reason: z.string(), ...giftOptsSchema,
      playerIds: z.array(pid).max(BULK_MAX_RECIPIENTS).optional(),
      segment: z.object({ kind: z.literal('leaderboard'), seasonId: z.string().regex(/^\d{4}-\d{2}$/), board: z.string().regex(/^(class-[A-Z]|rating)$/), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(BULK_MAX_RECIPIENTS).default(BULK_MAX_RECIPIENTS) }).strict().optional(),
    }), r.body);
    checkGrantLimits(b.grant, r.principal.role);
    if (needsApproval(b.grant)) throw new AppError('FORBIDDEN', `a bulk grant per recipient is capped at ${COMP_APPROVAL_THRESHOLD.freeCoins} coins / ${COMP_APPROVAL_THRESHOLD.itemQty} per item`);
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
        await r.ctx.player(id).invoke('adminGrant', id, b.grant as Grant, r.reason!, r.principal.id, bulkOpKey(b.opKey, id), true, { source: 'ops_grant', ...giftOf(b) });
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
    const b = parse(z.object({ target: z.enum(['display', 'horse', 'stable']), horseId: z.string().min(1).nullable().default(null), reason: z.string() }), r.body);
    const out = await r.ctx.player(id).invoke('adminResetName', id, b.target, b.horseId);
    return { result: out, target: `player:${id}`, before: out.before, after: out.after };
  } },

  // ---- compensation with the two-person rule (REQ-OPS-026) ----
  { method: 'GET', path: '/v1/admin/compensations', role: 'viewer', write: false, action: 'compensation.list', handler: async (r) => {
    const st = r.query.get('status');
    if (st && !(COMP_STATUSES as string[]).includes(st)) throw new AppError('BAD_REQUEST', `status must be one of ${COMP_STATUSES.join('|')}`);
    const playerId = r.query.get('playerId');
    const q: CompensationQuery = { limit: num(r.query, 'limit', 50), ...(st ? { status: st as CompensationStatus } : {}), ...(playerId ? { playerId } : {}) };
    return { result: { requests: await comps(r.ctx).list(q, r.now), threshold: COMP_APPROVAL_THRESHOLD, hardCap: COMP_HARD_CAP } };
  } },
  { method: 'POST', path: '/v1/admin/compensations', role: 'operator', write: true, action: 'compensation.request', handler: async (r) => {
    const b = parse(z.object({ playerId: pid, grant: grantSchema, opKey: opKeySchema, reason: z.string(), ...giftOptsSchema }).strict(), r.body);
    const gift = giftOf(b);
    const { request, created } = await comps(r.ctx).create({ opKey: b.opKey, playerId: b.playerId, grant: b.grant, reason: r.reason!, ...(Object.keys(gift).length ? { gift } : {}) }, r.principal, r.now);
    const target = `player:${b.playerId}`;
    if (request.status !== 'approved') return { result: { request, created, payment: null }, target, after: { compensation: request.id, status: request.status, grant: request.grant } };
    const paid = await payCompensation(r.ctx, request, r.now);
    if (!paid.payment) return { result: { ...paid, created }, target, after: { compensation: request.id, status: paid.request.status, grant: request.grant, escalated: 'single-person budget' } };
    return { result: { ...paid, created }, target, before: paid.payment.before, after: { compensation: request.id, status: paid.request.status, ...paid.payment.after } };
  } },
  { method: 'POST', path: '/v1/admin/compensations/:id/approve', role: 'admin', write: true, action: 'compensation.approve', handler: async (r) => {
    const b = parse(z.object({ note: z.string().trim().max(500).default(''), reason: z.string() }).strict(), r.body);
    const prev = await comps(r.ctx).get(r.params.id!, r.now);
    const approved = await comps(r.ctx).approve(r.params.id!, r.principal, b.note || r.reason!, r.now);
    const paid = await payCompensation(r.ctx, approved, r.now);
    if (!paid.payment) return { result: paid, target: `player:${approved.playerId}`, before: { compensation: prev.id, status: prev.status }, after: { compensation: prev.id, status: paid.request.status, escalated: 'single-person budget' } };
    return { result: paid, target: `player:${approved.playerId}`, before: { compensation: prev.id, status: prev.status, requestedBy: prev.requestedBy, ...paid.payment.before }, after: { compensation: prev.id, status: paid.request.status, approvedBy: r.principal.id, ...paid.payment.after } };
  } },
  { method: 'POST', path: '/v1/admin/compensations/:id/reject', role: 'operator', write: true, action: 'compensation.reject', handler: async (r) => {
    const b = parse(z.object({ note: z.string().trim().max(500).default(''), reason: z.string() }).strict(), r.body);
    const rej = await comps(r.ctx).reject(r.params.id!, r.principal, b.note || r.reason!, r.now);
    return { result: { request: rej }, target: `player:${rej.playerId}`, before: { compensation: rej.id, status: 'pending' }, after: { compensation: rej.id, status: rej.status } };
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
  { method: 'GET', path: '/v1/admin/tournaments', role: 'viewer', write: false, action: 'tournament.list', handler: async (r) => ({ result: await tours(r.ctx).list() }) },
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

  // ---- ヘルプセンターの問い合わせ (REQ-HELP-016/017, contracts/protocol.md §48.7) ----
  { method: 'GET', path: '/v1/admin/inquiries', role: 'viewer', write: false, action: 'inquiry.list', handler: async (r) => {
    const st = r.query.get('status');
    const cat = r.query.get('category');
    if (st && !(INQUIRY_STATUSES as string[]).includes(st)) throw new AppError('BAD_REQUEST', `status must be one of ${INQUIRY_STATUSES.join('|')}`);
    if (cat && !(INQUIRY_CATEGORIES as readonly string[]).includes(cat)) throw new AppError('BAD_REQUEST', 'unknown category');
    return { result: { items: await inq(r.ctx).list({ ...(st ? { status: st as InquiryQuery['status'] } : {}), ...(cat ? { category: cat as InquiryCategory } : {}), limit: num(r.query, 'limit', 100) }) } };
  } },
  { method: 'GET', path: '/v1/admin/players/:playerId/inquiries/:ticketId', role: 'viewer', write: false, action: 'inquiry.view', handler: async (r) => {
    const playerId = parse(pid, r.params.playerId);
    const ticketId = parse(ticketIdSchema, r.params.ticketId);
    let v: Awaited<ReturnType<PlayerService['adminInquiry']>>;
    try { v = await r.ctx.player(playerId).invoke('adminInquiry', playerId, ticketId); }
    catch (e) {
      // REQ-HELP-018: a deleted account — its rows leave the index (the ticket is gone with the state)
      if (e instanceof AppError && e.code === 'NOT_FOUND' && e.message === 'account deleted') await r.ctx.ops.inquiries?.forgetPlayer(playerId).catch(() => null);
      throw e;
    }
    const { unindexed, ...ticket } = v;
    if (unindexed?.length) await reindex(r.ctx, playerId, unindexed);
    return { result: ticket, target: `player:${playerId}` };
  } },
  { method: 'POST', path: '/v1/admin/players/:playerId/inquiries/:ticketId/reply', role: 'operator', write: true, action: 'inquiry.reply', handler: async (r) => {
    const playerId = parse(pid, r.params.playerId);
    const ticketId = parse(ticketIdSchema, r.params.ticketId);
    const b = parse(z.object({ opKey: opKeySchema, content: z.string().trim().min(1).max(8000), close: z.boolean().optional(), reason: z.string() }).strict(), r.body);
    const out = await r.ctx.player(playerId).invoke('adminInquiryReply', playerId, ticketId, b.content, b.close ?? false, r.principal.id, b.opKey);
    const { replies, duplicate, ...summary } = out;
    await reindex(r.ctx, playerId, [summary]);
    return { result: { ...summary, replies, duplicate }, target: `player:${playerId}`, before: null, after: { ticketId, status: summary.status, replies } };
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

const SECURITY_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

/**
 * REQ-OPS-015: CORS for the ops console. Only origins listed in ADMIN_CONSOLE_ORIGINS get CORS headers; credentials are
 * never allowed (the console sends a bearer token, no cookies), so another site can neither read responses nor ride a
 * session. Unlisted origins get no CORS headers at all and the browser blocks the call.
 */
export function corsHeaders(req: Request, origins: readonly string[] | undefined): Record<string, string> | null {
  const origin = req.headers.get('origin');
  if (!origin || !origins?.includes(origin)) return null;
  return {
    'access-control-allow-origin': origin, vary: 'Origin',
    'access-control-allow-methods': 'GET, POST, PUT', 'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '600',
  };
}

/**
 * Admin API (REQ-OPS-010..015): authenticate → role check → rate limit → run → audit (success and failure).
 * Writes require a `reason` and a JSON body (`content-type: application/json`, which also forces a CORS preflight).
 * Reads are audited too (who looked at which player).
 */
export async function handleAdmin(req: Request, ctx: AdminContext): Promise<Response> {
  const cors = corsHeaders(req, ctx.consoleOrigins);
  if (req.method === 'OPTIONS') return new Response(null, { status: cors ? 204 : 403, headers: { ...SECURITY_HEADERS, ...(cors ?? {}) } });
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...(cors ?? {}) } });
  const url = new URL(req.url);
  const now = (ctx.clock ?? Date.now)();
  let principal: AdminPrincipal | null = null;
  let route: AdminRoute | null = null;
  let params: Record<string, string> = {};
  let reason: string | null = null;
  try {
    // a browser on an unlisted origin never gets here with a token it could read, but refuse it outright anyway
    if (req.headers.get('origin') && !cors && ctx.consoleOrigins?.length) throw new AppError('FORBIDDEN', 'origin not allowed');
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
    if (route.write && !/^application\/json\b/i.test(req.headers.get('content-type') ?? '')) throw new AppError('BAD_REQUEST', 'writes need content-type: application/json');
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
          target: params.playerId ? `player:${params.playerId}` : params.id ? `${route.action.split('.')[0]}:${params.id}` : null, reason, before: null, after: null, result: 'error', error: err?.code ?? 'INTERNAL',
        }, now);
      } catch (ae) {
        console.error('audit write failed', ae);
      }
    }
    if (err) return json({ error: { code: err.code, message: err.message } }, err.status);
    return json({ error: { code: 'INTERNAL', message: 'internal error' } }, 500);
  }
}
