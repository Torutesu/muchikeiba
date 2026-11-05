import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import { findBanner, oddsDisclosure } from '../domain/gacha.js';
import type { Master } from '../domain/master.js';
import type { PlayerService } from '../domain/service.js';
import type { SubscriptionStatus, VerifiedReceipt } from '../domain/purchase.js';
import type { PurchaseRecord } from '../domain/player.js';
import { appleAccountToken, googleAccountId } from '../stores/binding.js';
import { FriendsService, type Directory, type FriendPlayers } from '../domain/friends.js';
import { jstMonthKey } from '../domain/time.js';
import type { TimeAttackService } from '../race/timeAttack.js';
import { TA_BOARD_RE } from '../domain/timeAttack.js';

/** Player operations reachable over HTTP (implemented by PlayerDO in production, PlayerService in tests). */
export type PlayerMethod =
  | 'bootstrap' | 'view' | 'setAge' | 'purchaseIntent' | 'purchase' | 'refund' | 'draw' | 'tutorialDraw' | 'pityExchange'
  | 'nameHorse' | 'awaken' | 'retire' | 'breedingPreview' | 'breed' | 'pedigree' | 'claimLogin' | 'missions'
  | 'claimMission' | 'passView' | 'claimPass' | 'applyRace' | 'raceEntry'
  | 'storeRenewal' | 'subscriptionStatus'
  | 'setDisplayName' | 'equipTitle' | 'titles' | 'stats' | 'publicProfile' | 'closeSeason'
  | 'friendSend' | 'friendReceive' | 'friendAccept' | 'friendAccepted' | 'friendDecline' | 'friendCancel' | 'friendRemove' | 'friendInvite' | 'friendsState'
  | 'taStart' | 'taPrepare' | 'taAbort' | 'taRecord' | 'taView';

export interface PlayerInvoker {
  invoke<K extends PlayerMethod>(m: K, ...args: Parameters<PlayerService[K]>): Promise<Awaited<ReturnType<PlayerService[K]>>>;
}

export type RaceEntry = Awaited<ReturnType<PlayerService['raceEntry']>>;

export interface MatchApi {
  enqueue(playerId: string, entry: RaceEntry): Promise<unknown>;
  cancel(playerId: string): Promise<unknown>;
  status(playerId: string): Promise<unknown>;
  friendCreate(playerId: string, entry: RaceEntry): Promise<unknown>;
  friendJoin(passphrase: string, playerId: string, entry: RaceEntry): Promise<unknown>;
  friendStart(passphrase: string, playerId: string): Promise<unknown>;
  tutorial(playerId: string, entry: RaceEntry): Promise<unknown>;
  /** Is the player a member of this friend room (invitation check)? */
  friendMember(passphrase: string, playerId: string): Promise<boolean>;
}
export interface LeaderboardApi {
  /** Public snapshot file (R2), never touches a Durable Object. */
  board(seasonId: string, board: string): Promise<unknown>;
  myRank(playerId: string, seasonId: string): Promise<unknown>;
}
export interface RaceApi {
  websocket(raceId: string, req: Request): Promise<Response>;
  report(raceId: string, playerId: string): Promise<unknown>;
  replay(raceId: string): Promise<unknown>;
}
/** A verified store server notification, resolved to its player (see http/stores.ts). */
export type StoreNotification =
  | { kind: 'refund'; playerId: string; transactionId: string }
  | { kind: 'renewal'; playerId: string; platform: PurchaseRecord['platform']; receipt: VerifiedReceipt }
  | { kind: 'subscription'; playerId: string; platform: PurchaseRecord['platform']; key: string; status: SubscriptionStatus; expiresAt: number | null }
  | { kind: 'ignored'; reason: string };
export interface AppContext {
  master: Master;
  authenticate(req: Request): Promise<string>;
  player(uid: string): PlayerInvoker;
  match: MatchApi;
  race: RaceApi;
  friends: FriendsService;
  leaderboard: LeaderboardApi;
  timeAttack: TimeAttackService;
  clock?: () => number;
  paidBalance(): Promise<unknown>;
  adminToken: string | undefined;
  parseStoreNotification(platform: string, req: Request): Promise<StoreNotification | null>;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const errorResponse = (e: AppError) => json({ error: { code: e.code, message: e.message } }, e.status);

async function body<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new AppError('BAD_REQUEST', 'invalid JSON');
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new AppError('BAD_REQUEST', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}
/**
 * Client idempotency keys live in their own namespace, scoped by endpoint, so a client can never
 * produce a server-internal key such as `refund:<tx>`, `purchase:<tx>` or `race:<raceId>`.
 */
export const clientIdemKey = (req: Request) => {
  const k = req.headers.get('idempotency-key');
  if (!k || k.length > 128) throw new AppError('IDEMPOTENCY_KEY_REQUIRED');
  return `c:${new URL(req.url).pathname}:${k}`;
};
const idem = clientIdemKey;
const id = z.string().min(1).max(64);

/** Constant-time string comparison (length is not secret). */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

type Handler = (req: Request, p: Record<string, string>, ctx: AppContext) => Promise<Response>;
interface Route { method: string; path: string; auth: 'player' | 'admin' | 'none' | 'ws'; handler: (req: Request, p: Record<string, string>, ctx: AppContext, uid: string) => Promise<unknown> }

const ok = (x: unknown) => x;

export const routes: Route[] = [
  { method: 'GET', path: '/v1/health', auth: 'none', handler: async () => ({ ok: true }) },
  // player
  { method: 'POST', path: '/v1/player/bootstrap', auth: 'player', handler: async (_r, _p, c, u) => c.player(u).invoke('bootstrap', u) },
  { method: 'GET', path: '/v1/player', auth: 'player', handler: async (_r, _p, c, u) => c.player(u).invoke('view', u) },
  { method: 'PUT', path: '/v1/player/age', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ birthYear: z.number().int(), birthMonth: z.number().int().min(1).max(12), guardianConsent: z.boolean() }));
    return c.player(u).invoke('setAge', u, b.birthYear, b.birthMonth, b.guardianConsent);
  } },
  // shop
  { method: 'GET', path: '/v1/shop/products', auth: 'none', handler: async (_r, _p, c) => ({ products: c.master.products, notice: '有償コインから先に使われます' }) },
  { method: 'POST', path: '/v1/shop/purchase-intent', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ productId: id }));
    return c.player(u).invoke('purchaseIntent', u, b.productId);
  } },
  { method: 'POST', path: '/v1/shop/purchase', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ platform: z.enum(['apple', 'google', 'fake']), productId: id, receipt: z.string().min(1).max(20000) }));
    return c.player(u).invoke('purchase', u, b.platform, b.productId, b.receipt);
  } },
  { method: 'GET', path: '/v1/shop/store-account', auth: 'player', handler: async (_r, _p, _c, u) => ({ appleAppAccountToken: await appleAccountToken(u), googleObfuscatedAccountId: await googleAccountId(u) }) },
  { method: 'POST', path: '/v1/store/notifications/:platform', auth: 'none', handler: async (r, p, c) => {
    const n = await c.parseStoreNotification(p.platform!, r);
    if (!n) throw new AppError('BAD_REQUEST', 'unrecognized notification');
    // Answer 2xx for verified notifications we cannot apply, or the store retries for days.
    if (n.kind === 'ignored') return { ok: true, ignored: n.reason };
    const pl = c.player(n.playerId);
    try {
      if (n.kind === 'refund') return await pl.invoke('refund', n.playerId, n.transactionId);
      if (n.kind === 'renewal') return await pl.invoke('storeRenewal', n.playerId, n.platform, n.receipt);
      return await pl.invoke('subscriptionStatus', n.playerId, n.platform, n.key, n.status, n.expiresAt);
    } catch (e) {
      if (e instanceof AppError && e.code === 'NOT_FOUND') return { ok: true, ignored: 'purchase not found for player' };
      throw e;
    }
  } },
  // gacha
  { method: 'GET', path: '/v1/gacha/banners', auth: 'none', handler: async (_r, _p, c) => ({ banners: c.master.gacha.banners.map((b) => ({ id: b.id, name: b.name, currency: b.currency, priceSingle: b.priceSingle, priceTen: b.priceTen, startAtMs: b.startAtMs ?? null, endAtMs: b.endAtMs ?? null })) }) },
  { method: 'GET', path: '/v1/gacha/:bannerId/odds', auth: 'none', handler: async (_r, p, c) => oddsDisclosure(c.master, findBanner(c.master, p.bannerId!)) },
  { method: 'POST', path: '/v1/gacha/:bannerId/draw', auth: 'player', handler: async (r, p, c, u) => {
    const b = await body(r, z.object({ count: z.union([z.literal(1), z.literal(10)]) }));
    return c.player(u).invoke('draw', u, p.bannerId!, b.count, idem(r));
  } },
  { method: 'POST', path: '/v1/gacha/tutorial', auth: 'player', handler: async (r, _p, c, u) => c.player(u).invoke('tutorialDraw', u, idem(r)) },
  { method: 'POST', path: '/v1/gacha/:bannerId/pity-exchange', auth: 'player', handler: async (r, p, c, u) => {
    const b = await body(r, z.object({ templateId: id }));
    return c.player(u).invoke('pityExchange', u, p.bannerId!, b.templateId, idem(r));
  } },
  // horses & breeding
  { method: 'GET', path: '/v1/horses', auth: 'player', handler: async (_r, _p, c, u) => ({ horses: (await c.player(u).invoke('view', u)).horses }) },
  { method: 'PUT', path: '/v1/horses/:horseId/name', auth: 'player', handler: async (r, p, c, u) => {
    const b = await body(r, z.object({ name: z.string().min(1).max(40) }));
    return c.player(u).invoke('nameHorse', u, p.horseId!, b.name);
  } },
  { method: 'POST', path: '/v1/horses/:horseId/awaken', auth: 'player', handler: async (r, p, c, u) => c.player(u).invoke('awaken', u, p.horseId!, idem(r)) },
  { method: 'POST', path: '/v1/horses/:horseId/retire', auth: 'player', handler: async (_r, p, c, u) => c.player(u).invoke('retire', u, p.horseId!) },
  { method: 'GET', path: '/v1/horses/:horseId/pedigree', auth: 'player', handler: async (_r, p, c, u) => c.player(u).invoke('pedigree', u, p.horseId!) },
  { method: 'POST', path: '/v1/breeding/preview', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ sireId: id, damId: id }));
    return c.player(u).invoke('breedingPreview', u, b.sireId, b.damId);
  } },
  { method: 'POST', path: '/v1/breeding', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ sireId: id, damId: id }));
    return c.player(u).invoke('breed', u, b.sireId, b.damId, idem(r));
  } },
  // rewards
  { method: 'POST', path: '/v1/rewards/login-bonus', auth: 'player', handler: async (r, _p, c, u) => c.player(u).invoke('claimLogin', u, idem(r)) },
  { method: 'GET', path: '/v1/missions', auth: 'player', handler: async (_r, _p, c, u) => ({ missions: await c.player(u).invoke('missions', u) }) },
  { method: 'POST', path: '/v1/missions/:missionId/claim', auth: 'player', handler: async (r, p, c, u) => c.player(u).invoke('claimMission', u, p.missionId!, idem(r)) },
  { method: 'GET', path: '/v1/season-pass', auth: 'player', handler: async (_r, _p, c, u) => c.player(u).invoke('passView', u) },
  { method: 'POST', path: '/v1/season-pass/claim', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ track: z.enum(['free', 'premium']), level: z.number().int().min(1) }));
    return c.player(u).invoke('claimPass', u, b.track, b.level, idem(r));
  } },
  // matchmaking & races
  { method: 'POST', path: '/v1/match/enqueue', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ horseId: id }));
    return c.match.enqueue(u, await c.player(u).invoke('raceEntry', u, b.horseId));
  } },
  { method: 'POST', path: '/v1/match/cancel', auth: 'player', handler: async (_r, _p, c, u) => c.match.cancel(u) },
  { method: 'GET', path: '/v1/match/status', auth: 'player', handler: async (_r, _p, c, u) => c.match.status(u) },
  { method: 'POST', path: '/v1/friend-rooms', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ horseId: id }));
    return c.match.friendCreate(u, await c.player(u).invoke('raceEntry', u, b.horseId));
  } },
  { method: 'POST', path: '/v1/friend-rooms/:passphrase/join', auth: 'player', handler: async (r, p, c, u) => {
    const b = await body(r, z.object({ horseId: id }));
    return c.match.friendJoin(p.passphrase!, u, await c.player(u).invoke('raceEntry', u, b.horseId));
  } },
  { method: 'POST', path: '/v1/friend-rooms/:passphrase/start', auth: 'player', handler: async (_r, p, c, u) => c.match.friendStart(p.passphrase!, u) },
  { method: 'POST', path: '/v1/race/tutorial', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ horseId: id }));
    return c.match.tutorial(u, await c.player(u).invoke('raceEntry', u, b.horseId));
  } },
  { method: 'GET', path: '/v1/race/:raceId/ws', auth: 'ws', handler: async () => ok(null) },
  { method: 'POST', path: '/v1/race/:raceId/report', auth: 'player', handler: async (_r, p, c, u) => c.race.report(p.raceId!, u) },
  // profile, titles, stats (REQ-STAT-*, REQ-TITLE-*, REQ-SOCIAL-006)
  { method: 'PUT', path: '/v1/player/profile', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ displayName: z.string().min(1).max(40) }));
    return c.player(u).invoke('setDisplayName', u, b.displayName);
  } },
  { method: 'GET', path: '/v1/titles', auth: 'player', handler: async (_r, _p, c, u) => c.player(u).invoke('titles', u) },
  { method: 'PUT', path: '/v1/player/title', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ titleId: id.nullable() }));
    return c.player(u).invoke('equipTitle', u, b.titleId);
  } },
  { method: 'GET', path: '/v1/stats', auth: 'player', handler: async (_r, _p, c, u) => c.player(u).invoke('stats', u) },
  // leaderboards (REQ-LB-*)
  { method: 'GET', path: '/v1/leaderboards/me', auth: 'player', handler: async (_r, _p, c, u) => c.leaderboard.myRank(u, jstMonthKey((c.clock ?? Date.now)())) },
  { method: 'GET', path: '/v1/leaderboards/:seasonId/:board', auth: 'none', handler: async (_r, p, c) => {
    const season = p.seasonId === 'current' ? jstMonthKey((c.clock ?? Date.now)()) : p.seasonId!;
    if (!/^\d{4}-\d{2}$/.test(season) || !(/^(class-[A-Z]|rating|index)$/.test(p.board!) || TA_BOARD_RE.test(p.board!))) throw new AppError('BAD_REQUEST', 'bad season or board');
    return c.leaderboard.board(season, p.board!);
  } },
  // friends (REQ-SOCIAL-*)
  { method: 'GET', path: '/v1/friends', auth: 'player', handler: async (_r, _p, c, u) => c.friends.list(u) },
  { method: 'GET', path: '/v1/friends/code', auth: 'player', handler: async (_r, _p, c, u) => c.friends.myCode(u) },
  { method: 'POST', path: '/v1/friends/requests', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ code: z.string().regex(/^\d{9}$/) }));
    return c.friends.request(u, b.code);
  } },
  { method: 'POST', path: '/v1/friends/requests/:fromId/accept', auth: 'player', handler: async (_r, p, c, u) => c.friends.accept(u, p.fromId!) },
  { method: 'POST', path: '/v1/friends/requests/:fromId/decline', auth: 'player', handler: async (_r, p, c, u) => c.friends.decline(u, p.fromId!) },
  { method: 'DELETE', path: '/v1/friends/requests/:toId', auth: 'player', handler: async (_r, p, c, u) => c.friends.cancel(u, p.toId!) },
  { method: 'DELETE', path: '/v1/friends/:friendId', auth: 'player', handler: async (_r, p, c, u) => c.friends.remove(u, p.friendId!) },
  { method: 'POST', path: '/v1/friend-rooms/:passphrase/invite', auth: 'player', handler: async (r, p, c, u) => {
    const b = await body(r, z.object({ friendId: id }));
    if (!(await c.match.friendMember(p.passphrase!, u))) throw new AppError('NOT_ELIGIBLE', 'not a member of this room');
    return c.friends.invite(u, b.friendId, p.passphrase!);
  } },
  // time attack & ghosts (REQ-TA-*)
  { method: 'POST', path: '/v1/time-attack/start', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ trackId: id, horseId: id }));
    return c.timeAttack.start(u, b.trackId, b.horseId);
  } },
  { method: 'POST', path: '/v1/time-attack/submit', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({
      sessionId: id, token: z.string().min(1).max(2048), resultHash: z.string().regex(/^[0-9a-f]{64}$/),
      inputs: z.array(z.unknown()).max(4000), config: z.unknown().optional(),
    }));
    return c.timeAttack.submit(u, b);
  } },
  { method: 'GET', path: '/v1/time-attack/:trackId/me', auth: 'player', handler: async (_r, p, c, u) => c.timeAttack.me(u, p.trackId!) },
  { method: 'GET', path: '/v1/time-attack/:trackId/ghosts', auth: 'player', handler: async (r, p, c, u) => {
    const q = new URL(r.url).searchParams;
    const kind = q.get('kind') ?? 'top';
    if (kind !== 'top' && kind !== 'friends' && kind !== 'me') throw new AppError('BAD_REQUEST', 'kind must be top|friends|me');
    const season = q.get('seasonId') ?? undefined;
    if (season !== undefined && !/^\d{4}-\d{2}$/.test(season)) throw new AppError('BAD_REQUEST', 'bad season');
    return c.timeAttack.ghosts(u, p.trackId!, kind, season);
  } },
  { method: 'GET', path: '/v1/time-attack/ghosts/:seasonId/:trackId/:playerId', auth: 'player', handler: async (_r, p, c) => {
    if (!/^\d{4}-\d{2}$/.test(p.seasonId!) || !/^[a-z0-9_]{1,48}$/.test(p.trackId!)) throw new AppError('BAD_REQUEST', 'bad season or track');
    return c.timeAttack.ghost(p.seasonId!, p.trackId!, p.playerId!);
  } },
  // admin
  { method: 'GET', path: '/v1/admin/paid-balance', auth: 'admin', handler: async (_r, _p, c) => c.paidBalance() },
  { method: 'GET', path: '/v1/admin/replays/:raceId', auth: 'admin', handler: async (_r, p, c) => c.race.replay(p.raceId!) },
];

function match(path: string, pattern: string): Record<string, string> | null {
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

export const handle: Handler = async (req, _p, ctx) => {
  const url = new URL(req.url);
  try {
    let methodMismatch = false;
    for (const r of routes) {
      const params = match(url.pathname, r.path);
      if (!params) continue;
      if (r.method !== req.method) { methodMismatch = true; continue; }
      if (r.auth === 'ws') {
        if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') throw new AppError('BAD_REQUEST', 'expected websocket upgrade');
        return await ctx.race.websocket(params.raceId!, req);
      }
      let uid = '';
      if (r.auth === 'player') uid = await ctx.authenticate(req);
      if (r.auth === 'admin' && (!ctx.adminToken || !timingSafeEqual(req.headers.get('authorization') ?? '', `Bearer ${ctx.adminToken}`))) throw new AppError('UNAUTHORIZED');
      return json(await r.handler(req, params, ctx, uid));
    }
    return methodMismatch ? json({ error: { code: 'BAD_REQUEST', message: 'method not allowed' } }, 405) : errorResponse(new AppError('NOT_FOUND'));
  } catch (e) {
    if (e instanceof AppError) return errorResponse(e);
    console.error(e);
    return json({ error: { code: 'INTERNAL', message: 'internal error' } }, 500);
  }
};

/** Adapts per-player invocations (Durable Object RPC or PlayerService) to the friends orchestration. */
export function makeFriendsService(player: (uid: string) => PlayerInvoker, dir: Directory): FriendsService {
  const ports: FriendPlayers = {
    send: (u, t) => player(u).invoke('friendSend', u, t),
    receive: (u, f) => player(u).invoke('friendReceive', u, f),
    accept: (u, f) => player(u).invoke('friendAccept', u, f),
    accepted: (u, b) => player(u).invoke('friendAccepted', u, b),
    decline: (u, f) => player(u).invoke('friendDecline', u, f),
    cancel: (u, t) => player(u).invoke('friendCancel', u, t),
    remove: (u, o) => player(u).invoke('friendRemove', u, o),
    invite: (u, f, pass) => player(u).invoke('friendInvite', u, f, pass),
    friendsState: (u) => player(u).invoke('friendsState', u),
  };
  return new FriendsService(ports, dir);
}
