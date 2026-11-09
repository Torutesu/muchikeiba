import { z } from 'zod';
import { visualsCatalog, VISUALS } from '../domain/visuals.js';
import { AppError } from '../domain/errors.js';
import { ASSET_PLATFORMS, catalogEtag, EMPTY_ASSET_CATALOG, etagMatches, platformCatalog, type AssetPlatform } from '../domain/assetCatalog.js';
import { bannerList, findVisibleBanner, oddsDisclosure } from '../domain/gacha.js';
import { shopProducts } from '../domain/shop.js';
import { skillCatalog } from '../domain/skills.js';
import { ticketDisclosure } from '../domain/itemShop.js';
import type { Master } from '../domain/master.js';
import type { PlayerService } from '../domain/service.js';
import type { SubscriptionStatus, VerifiedReceipt } from '../domain/purchase.js';
import type { PurchaseRecord } from '../domain/player.js';
import { appleAccountToken, googleAccountId } from '../stores/binding.js';
import { FriendsService, type Directory, type FriendPlayers } from '../domain/friends.js';
import { dayRule, jstMonthKey } from '../domain/time.js';
import { handleAdmin, type OpsApi } from './admin.js';
import type { AdminPrincipal } from '../ops/admin.js';
import { clientBatchSchema } from '../domain/kpi.js';
import type { TimeAttackService } from '../race/timeAttack.js';
import type { WeeklyChallengeService } from '../race/weeklyChallenge.js';
import { TA_BOARD_RE } from '../domain/timeAttack.js';
import { LEAGUE_BOARD_RE } from '../domain/league.js';
import { TeamsService, type TeamPlayers } from '../domain/teamService.js';
import { EventsService, type EventPlayers } from '../domain/eventService.js';
import { TEAM_ID_RE } from '../domain/teams.js';
import { REPORT_REASONS, STAMP_ID_RE } from '../domain/teamFeed.js';
import { EVENT_ID_RE } from '../domain/events.js';
import { goingSchema } from '../domain/schemas.js';
import { StudService, type StudDirectory, type StudPlayers } from '../domain/studService.js';
import type { SpectateService } from '../domain/spectate.js';
import type { TournamentEntryInfo, TournamentPlayers, TournamentsService } from '../domain/tournamentService.js';
import type { StableService } from '../domain/stable.js';
import { InviteService, type InviteDirectory, type InvitePlayers } from '../domain/invite.js';
import { SsvError, verifyAdMobCallback, type SsvKeySource } from '../ads/ssv.js';
import { LOCALES, resolveLocale, type Locale } from '../i18n/locale.js';
import { catalogFor, localize, type Catalog } from '../i18n/catalog.js';

/** Player operations reachable over HTTP (implemented by PlayerDO in production, PlayerService in tests). */
export type PlayerMethod =
  | 'bootstrap' | 'view' | 'setAge' | 'purchaseIntent' | 'purchase' | 'refund' | 'draw' | 'tutorialDraw' | 'pityExchange' | 'gachaStatus'
  | 'nameHorse' | 'awaken' | 'retire' | 'breedingPreview' | 'breed' | 'pedigree' | 'claimLogin' | 'missions'
  | 'claimMission' | 'passView' | 'claimPass' | 'applyRace' | 'raceEntry'
  | 'shopProducts' | 'shopOffers' | 'markOfferViewed' | 'allowance' | 'claimAllowance' | 'firstWinBonus'
  | 'storeRenewal' | 'subscriptionStatus'
  | 'setDisplayName' | 'equipTitle' | 'titles' | 'stats' | 'publicProfile' | 'closeSeason' | 'setSilks'
  | 'useTicket' | 'cosmetics' | 'buyCosmetic' | 'setEquipment'
  | 'friendSend' | 'friendReceive' | 'friendAccept' | 'friendAccepted' | 'friendDecline' | 'friendCancel' | 'friendRemove' | 'friendInvite' | 'friendsState'
  | 'adminView' | 'adminGrant' | 'adminSettleDebt' | 'adminCorrectAge' | 'adminResetName' | 'setModeration'
  | 'registerDevice' | 'unregisterDevice' | 'pushPreferences' | 'setPushPreferences' | 'kpiIngest'
  | 'taStart' | 'taPrepare' | 'taAbort' | 'taRecord' | 'taView'
  | 'teamPrepareJoin' | 'teamCommitJoin' | 'teamAbortJoin' | 'teamAddOutgoing' | 'teamRemoveOutgoing' | 'teamLeft' | 'teamState' | 'teamSeasonReward' | 'queuePush'
  | 'eventsView' | 'eventEnter' | 'eventCancel' | 'eventClose' | 'tournamentEntry' | 'tournamentClose' | 'tournamentHistory'
  | 'bond' | 'bondLevels' | 'care' | 'presets' | 'setCourseLook' | 'setRoomConditions'
  | 'studView' | 'studList' | 'studUnlist' | 'studPeek' | 'studReserve' | 'studSettle' | 'studPreview' | 'studApply' | 'studAcked' | 'studDue' | 'studRetryLater'
  | 'stableMine' | 'stableSave' | 'stableVisit' | 'stableLikeGive' | 'stableLikeReceive' | 'stableClear' | 'stableForget'
  | 'recordConsent' | 'grantPartner' | 'missionsAll' | 'requestDeletion' | 'cancelDeletion' | 'deletionDue' | 'deletionSnapshot' | 'deletionMarkStep'
  | 'deletionRetryLater' | 'deletionFinalize' | 'deletionStart' | 'runNudges' | 'nudgeTaBeaten' | 'nudgeTournamentClosing'
  | 'stampCatalog' | 'stampCheck' | 'stampPosted' | 'feedViewer' | 'feedMutes' | 'feedMute' | 'feedReported' | 'cheerPush'
  | 'inviteView' | 'inviteAttempt' | 'inviteAccept' | 'inviteRevert' | 'inviteCommit' | 'inviteFlag' | 'inviteMilestone' | 'inviteDue' | 'inviteAcked'
  | 'inviteRetryLater' | 'inviteForgetInvitee' | 'inviteForgetInviter' | 'inviteForfeit'
  | 'comeback' | 'comebackClaimLogin' | 'comebackClaimMission' | 'comebackWelcomed' | 'whatsNew' | 'whatsNewSeen'
  | 'ads' | 'setAdPref' | 'adStart' | 'adSession' | 'adReward'
  | 'collection' | 'achievements' | 'claimAchievement' | 'claimAllAchievements'
  | 'training' | 'trainingStart' | 'trainingFinish' | 'trainingUseItem'
  | 'wchView' | 'wchStart' | 'wchPrepare' | 'wchAbort' | 'wchRecord';

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
  /** REQ-WCH-*: 週替わりチャレンジ. Absent → the routes answer NOT_FOUND. */
  weeklyChallenge?: WeeklyChallengeService;
  /** REQ-TEAM-*: 支部. Absent in contexts that do not serve teams (routes answer NOT_FOUND). */
  teams?: TeamsService;
  /** REQ-EVENT-*: event races. */
  events?: EventsService;
  /** REQ-BREED-010..016: stud lending. */
  stud?: StudService;
  /** REQ-SPEC-*: live race list + spectator tickets. */
  spectate?: SpectateService;
  /** REQ-TOUR-*: tournaments. */
  tournaments?: TournamentsService;
  /** REQ-STABLE-*: マイ厩舎 (http/stablePorts.ts makeStableService). */
  stable?: StableService;
  /** REQ-INV-*: friend invite codes (makeInviteService). Absent → the routes answer NOT_FOUND. */
  invite?: InviteService;
  clock?: () => number;
  paidBalance(): Promise<unknown>;
  /**
   * REQ-UXS-040: a store refund whose transaction belongs to a deleted account (AccountingDO.retainedRefund, keyed by the
   * anonymous id the store index points to). Null = no retained record under that id.
   */
  retainedRefund?(anonId: string, transactionId: string): Promise<unknown | null>;
  adminToken: string | undefined;
  parseStoreNotification(platform: string, req: Request): Promise<StoreNotification | null>;
  /** Live-ops backend (REQ-OPS-*). When present, /v1/admin/* is served by http/admin.ts with roles and audit. */
  ops?: OpsApi;
  authenticateAdmin?(req: Request): Promise<AdminPrincipal>;
  /** The shipped master before remote config (admin gacha calendar / odds preview resolve versions on it). Defaults to `master`. */
  baseMaster?: Master;
  /** REQ-OPS-020: admin lookup of a player by invite code (the invite directory). */
  inviteLookup?(code: string): Promise<string | null>;
  /** REQ-OPS-015: ops console origins allowed by CORS on /v1/admin/* (wrangler var ADMIN_CONSOLE_ORIGINS, comma-separated). */
  adminConsoleOrigins?: readonly string[];
  /** Active remote config summary for clients (REQ-OPS-007). */
  configInfo?(): Promise<ClientConfigInfo>;
  /**
   * REQ-AD-006: rewarded-ad server-side verification (the network's key set and the ad unit map from env). Absent =
   * the SSV callback answers NOT_FOUND (no reward can ever be granted; offers still list but cannot pay out).
   */
  ads?: { keys: SsvKeySource; adUnits?: Record<string, string>; admit?(key: string, now: number): void };
  /** REQ-DLV-002: CDN base URL for asset downloads (wrangler var ASSET_CDN_BASE). Unset → catalog baseUrl "" (bundled assets only). */
  assetCdnBase?: string;
}
export interface ClientConfigInfo { versionId: string; hash: string; rulesetVersion: string; activatedAt: number | null }

const json = (data: unknown, status = 200, lang?: Locale) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...(lang ? { 'content-language': lang, vary: 'accept-language' } : {}) } });
const errorResponse = (e: AppError, l?: { lang: Locale; cat: Catalog }) =>
  json(l ? localize({ error: { code: e.code, message: e.message } }, l.lang, l.cat) : { error: { code: e.code, message: e.message } }, e.status, l?.lang);

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

const weekly = (c: AppContext) => {
  if (!c.weeklyChallenge) throw new AppError('NOT_FOUND', 'weekly challenges are not available');
  return c.weeklyChallenge;
};
const teams = (c: AppContext) => {
  if (!c.teams) throw new AppError('NOT_FOUND', 'teams are not available');
  return c.teams;
};
const events = (c: AppContext) => {
  if (!c.events) throw new AppError('NOT_FOUND', 'events are not available');
  return c.events;
};
const stud = (c: AppContext) => {
  if (!c.stud || !c.master.progression.stud) throw new AppError('NOT_FOUND', 'stud lending is not available');
  return c.stud;
};
const spectate = (c: AppContext) => {
  if (!c.spectate) throw new AppError('NOT_FOUND', 'spectating is not available');
  return c.spectate;
};
const tournaments = (c: AppContext) => {
  if (!c.tournaments) throw new AppError('NOT_FOUND', 'tournaments are not available');
  return c.tournaments;
};
const stable = (c: AppContext) => {
  if (!c.stable) throw new AppError('NOT_FOUND', 'stables are not available');
  return c.stable;
};
const invite = (c: AppContext) => {
  if (!c.invite || !c.master.progression.invite) throw new AppError('NOT_FOUND', 'invites are not available');
  return c.invite;
};
/** REQ-INV-005: the app's install id (random per install, kept in the keychain / keystore). Only a hash is stored. */
const installIdSchema = z.string().min(8).max(128).regex(/^[\w\-.:]+$/);
const playerIdParam = (s: string) => {
  if (s.length < 1 || s.length > 128 || /[\s/]/.test(s)) throw new AppError('BAD_REQUEST', 'bad player id');
  return s;
};
const teamIdParam = (s: string) => {
  if (!TEAM_ID_RE.test(s)) throw new AppError('BAD_REQUEST', 'bad team id');
  return s;
};
const seqParam = (s: string) => {
  if (!/^\d{1,9}$/.test(s) || Number(s) < 1) throw new AppError('BAD_REQUEST', 'bad feed item');
  return Number(s);
};
const stampId = z.string().regex(STAMP_ID_RE);
const missionIdParam = (s: string) => {
  if (!/^[a-z0-9_]{1,40}$/.test(s)) throw new AppError('BAD_REQUEST', 'bad mission id');
  return s;
};
const offerIdParam = (s: string) => {
  if (!/^[a-z0-9_]{1,64}$/i.test(s)) throw new AppError('BAD_REQUEST', 'bad offer id');
  return s;
};
const eventIdParam = (s: string) => {
  if (!EVENT_ID_RE.test(s)) throw new AppError('BAD_REQUEST', 'bad event id');
  return s;
};

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
  // REQ-OPS-007: clients cache master data per config version and refetch when it changes
  { method: 'GET', path: '/v1/config', auth: 'none', handler: async (_r, _p, c) => ({ ...(c.configInfo ? await c.configInfo() : { versionId: 'base', hash: 'base', rulesetVersion: null, activatedAt: null }), visualsVersion: VISUALS.version, assetCatalogVersion: (c.master.assetCatalog ?? EMPTY_ASSET_CATALOG).catalogVersion, dayRollover: dayRule(c.master) }) }, // REQ-DAY-006, REQ-DLV-*
  // REQ-DLV-001..004: asset delivery catalog per platform (contracts/protocol.md §16). Public; ETag = view hash, 304 on match.
  { method: 'GET', path: '/v1/assets/catalog', auth: 'none', handler: async (r, _p, c) => {
    const platform = new URL(r.url).searchParams.get('platform');
    if (!platform || !(ASSET_PLATFORMS as readonly string[]).includes(platform)) throw new AppError('BAD_REQUEST', `platform must be one of ${ASSET_PLATFORMS.join('|')}`);
    const view = await platformCatalog(c.master.assetCatalog ?? EMPTY_ASSET_CATALOG, platform as AssetPlatform, c.assetCdnBase);
    const etag = catalogEtag(view);
    const headers = { etag, 'cache-control': 'public, max-age=60, must-revalidate', vary: 'accept-encoding' };
    if (etagMatches(r.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers });
    return new Response(JSON.stringify(view), { status: 200, headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } });
  } },
  // visual contract (REQ-ASSET-*, contracts/assets.md): catalog the client caches by `version`
  { method: 'GET', path: '/v1/visuals', auth: 'none', handler: async (_r, _p, c) => visualsCatalog(c.master) },
  { method: 'PUT', path: '/v1/player/silks', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ pattern: z.string().min(1).max(40), colors: z.array(z.string().min(1).max(40)).min(2).max(3), cap: z.string().min(1).max(40) }));
    return c.player(u).invoke('setSilks', u, b);
  } },
  // player
  { method: 'POST', path: '/v1/player/bootstrap', auth: 'player', handler: async (_r, _p, c, u) => c.player(u).invoke('bootstrap', u) },
  { method: 'GET', path: '/v1/player', auth: 'player', handler: async (_r, _p, c, u) => c.player(u).invoke('view', u) },
  // REQ-UXS-001: terms / privacy consent (the versions the app showed; must be the current ones)
  { method: 'POST', path: '/v1/player/consent', auth: 'player', handler: async (r, _p, c, u) => {
    const v = z.string().min(1).max(32);
    const b = await body(r, z.object({ termsVersion: v, privacyVersion: v }).strict());
    return c.player(u).invoke('recordConsent', u, b.termsVersion, b.privacyVersion);
  } },
  // REQ-UXS-002: the tutorial horse, granted once and named (separate from POST /v1/gacha/tutorial)
  { method: 'POST', path: '/v1/player/partner', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ name: z.string().min(1).max(40) }).strict());
    return c.player(u).invoke('grantPartner', u, b.name, idem(r));
  } },
  // REQ-UXS-040: account deletion (1: no token → confirmation token; 2: token → scheduled after the cancel window)
  { method: 'DELETE', path: '/v1/player', auth: 'player', handler: async (r, _p, c, u) => {
    const q = new URL(r.url).searchParams.get('confirmToken');
    const text = await r.text();
    let raw: unknown = {};
    if (text.trim()) {
      try { raw = JSON.parse(text); } catch { throw new AppError('BAD_REQUEST', 'invalid JSON'); }
    }
    const b = z.object({ confirmToken: z.string().min(1).max(64).optional() }).strict().safeParse(raw);
    if (!b.success) throw new AppError('BAD_REQUEST', b.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    return c.player(u).invoke('requestDeletion', u, b.data.confirmToken ?? q ?? null);
  } },
  { method: 'POST', path: '/v1/player/deletion/cancel', auth: 'player', handler: async (_r, _p, c, u) => c.player(u).invoke('cancelDeletion', u) },
  { method: 'PUT', path: '/v1/player/age', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ birthYear: z.number().int(), birthMonth: z.number().int().min(1).max(12), guardianConsent: z.boolean() }));
    return c.player(u).invoke('setAge', u, b.birthYear, b.birthMonth, b.guardianConsent);
  } },
  // shop
  // REQ-UXS-022: display data built on the server (contents, quantities, free-coin first-purchase bonus, legal notice keys)
  // r10: `?mine=1` (authenticated) adds the player's ownership (owned / ownedReason / purchasedThisSeason)
  { method: 'GET', path: '/v1/shop/products', auth: 'none', handler: async (r, _p, c) => {
    if (new URL(r.url).searchParams.get('mine') !== '1') return shopProducts(c.master);
    const u = await c.authenticate(r);
    return c.player(u).invoke('shopProducts', u);
  } },
  // REQ-UXS-017: offers to show (triggers, shown-once records); bought offers are never returned
  { method: 'GET', path: '/v1/shop/offers', auth: 'player', handler: async (_r, _p, c, u) => c.player(u).invoke('shopOffers', u) },
  { method: 'POST', path: '/v1/shop/offers/:offerId/view', auth: 'player', handler: async (_r, p, c, u) => c.player(u).invoke('markOfferViewed', u, offerIdParam(p.offerId!)) },
  // REQ-UXS-018: 厩舎手当 (30-day daily-coin pack)
  { method: 'GET', path: '/v1/shop/allowance', auth: 'player', handler: async (_r, _p, c, u) => c.player(u).invoke('allowance', u) },
  { method: 'POST', path: '/v1/shop/allowance/claim', auth: 'player', handler: async (r, _p, c, u) => c.player(u).invoke('claimAllowance', u, idem(r)) },
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
      if (e instanceof AppError && e.code === 'NOT_FOUND') {
        // a deleted account: the store index points to its anonymous retained record (7-year legal retention)
        if (n.kind === 'refund' && c.retainedRefund) {
          const r = await c.retainedRefund(n.playerId, n.transactionId);
          if (r) return r;
        }
        return { ok: true, ignored: 'purchase not found for player' };
      }
      throw e;
    }
  } },
  // gacha
  // REQ-UXS-050: unique skill catalog (condition/effect text generated from the engine values; no odds: no random draw)
  { method: 'GET', path: '/v1/skills', auth: 'none', handler: async (_r, _p, c) => skillCatalog(c.master) },
  // REQ-GACHA-011: active + announced banners only, sorted, with the real end times and the server clock
  { method: 'GET', path: '/v1/gacha/banners', auth: 'none', handler: async (_r, _p, c) => bannerList(c.master, (c.clock ?? Date.now)()) },
  // REQ-GACHA-012..014: the player's pity meter, carry-over rule and step-up progress
  { method: 'GET', path: '/v1/gacha/status', auth: 'player', handler: async (_r, _p, c, u) => c.player(u).invoke('gachaStatus', u) },
  { method: 'GET', path: '/v1/gacha/:bannerId/odds', auth: 'none', handler: async (_r, p, c) => oddsDisclosure(c.master, findVisibleBanner(c.master, p.bannerId!, (c.clock ?? Date.now)())) },
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
  // stable care / bond (REQ-BOND-*): never affects ranked, event or time attack stats
  { method: 'GET', path: '/v1/bond', auth: 'player', handler: async (_r, _p, c, u) => c.player(u).invoke('bondLevels', u) },
  { method: 'GET', path: '/v1/horses/:horseId/bond', auth: 'player', handler: async (_r, p, c, u) => c.player(u).invoke('bond', u, p.horseId!) },
  { method: 'POST', path: '/v1/horses/:horseId/care', auth: 'player', handler: async (r, p, c, u) => {
    const b = await body(r, z.object({ action: z.string().min(1).max(40) }));
    return c.player(u).invoke('care', u, p.horseId!, b.action, idem(r));
  } },
  // presets: course look and private-room conditions (REQ-ROOM-*)
  { method: 'GET', path: '/v1/presets', auth: 'player', handler: async (_r, _p, c, u) => c.player(u).invoke('presets', u) },
  { method: 'PUT', path: '/v1/presets/course-look', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ lookId: z.string().min(1).max(40).nullable() }));
    return c.player(u).invoke('setCourseLook', u, b.lookId);
  } },
  { method: 'PUT', path: '/v1/presets/room', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({
      trackId: z.string().min(1).max(64).nullable(), going: goingSchema.nullable(), night: z.boolean().nullable(),
      weather: z.string().min(1).max(20), temperatureC: z.number().int(), windKmh: z.number().int(),
    }));
    return c.player(u).invoke('setRoomConditions', u, b);
  } },
  { method: 'DELETE', path: '/v1/presets/room', auth: 'player', handler: async (_r, _p, c, u) => c.player(u).invoke('setRoomConditions', u, null) },
  { method: 'POST', path: '/v1/breeding/preview', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ sireId: id, damId: id }));
    return c.player(u).invoke('breedingPreview', u, b.sireId, b.damId);
  } },
  { method: 'POST', path: '/v1/breeding', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ sireId: id, damId: id, useMaterial: z.boolean().optional() }));
    return c.player(u).invoke('breed', u, b.sireId, b.damId, idem(r), b.useMaterial ?? false);
  } },
  // stud lending (REQ-BREED-010..016): fees in free coins only
  { method: 'GET', path: '/v1/stud/mine', auth: 'player', handler: async (_r, _p, c, u) => stud(c).mine(u) },
  { method: 'PUT', path: '/v1/stud/listings/:horseId', auth: 'player', handler: async (r, p, c, u) => {
    const b = await body(r, z.object({ visibility: z.enum(['friends', 'public']), fee: z.number().int().min(0), dailyLimit: z.number().int().min(1) }));
    return stud(c).list(u, p.horseId!, b.visibility, b.fee, b.dailyLimit);
  } },
  { method: 'DELETE', path: '/v1/stud/listings/:horseId', auth: 'player', handler: async (_r, p, c, u) => stud(c).unlist(u, p.horseId!) },
  { method: 'GET', path: '/v1/stud/browse', auth: 'player', handler: async (r, _p, c, u) => {
    const scope = new URL(r.url).searchParams.get('scope') ?? 'friends';
    if (scope !== 'friends' && scope !== 'public') throw new AppError('BAD_REQUEST', 'scope must be friends|public');
    return stud(c).browse(u, scope);
  } },
  { method: 'POST', path: '/v1/stud/preview', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ ownerId: id, horseId: id, damId: id }));
    return stud(c).preview(u, b.ownerId, b.horseId, b.damId);
  } },
  { method: 'POST', path: '/v1/stud/breed', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ ownerId: id, horseId: id, damId: id, useMaterial: z.boolean().optional(), expectedFee: z.number().int().min(0).optional() }));
    return stud(c).breed(u, b.ownerId, b.horseId, b.damId, idem(r), b.useMaterial ?? false, b.expectedFee);
  } },
  // items & cosmetics (REQ-ITEM-*)
  { method: 'GET', path: '/v1/items/tickets', auth: 'none', handler: async (_r, _p, c) => ({ tickets: Object.keys(c.master.items.tickets).map((t) => ticketDisclosure(c.master, t)) }) },
  { method: 'GET', path: '/v1/items/tickets/:itemId/odds', auth: 'none', handler: async (_r, p, c) => ticketDisclosure(c.master, p.itemId!) },
  { method: 'POST', path: '/v1/items/tickets/:itemId/use', auth: 'player', handler: async (r, p, c, u) => {
    const b = await body(r, z.object({ bannerId: id.optional() }));
    return c.player(u).invoke('useTicket', u, p.itemId!, b.bannerId ?? null, idem(r));
  } },
  { method: 'GET', path: '/v1/shop/cosmetics', auth: 'player', handler: async (_r, _p, c, u) => c.player(u).invoke('cosmetics', u) },
  { method: 'POST', path: '/v1/shop/cosmetics/:itemId/buy', auth: 'player', handler: async (r, p, c, u) => c.player(u).invoke('buyCosmetic', u, p.itemId!, idem(r)) },
  { method: 'PUT', path: '/v1/player/equipment', auth: 'player', handler: async (r, _p, c, u) => {
    const slotId = id.nullable().optional();
    const b = await body(r, z.object({ tack: z.object({ bridle: slotId, saddlecloth: slotId }).strict().optional(), decor: z.array(id.nullable()).max(10).optional() }).strict());
    const patch: { tack?: Record<string, string | null>; decor?: (string | null)[] } = {};
    if (b.tack) patch.tack = Object.fromEntries(Object.entries(b.tack).filter(([, v]) => v !== undefined)) as Record<string, string | null>;
    if (b.decor) patch.decor = b.decor;
    return c.player(u).invoke('setEquipment', u, patch);
  } },
  // マイ厩舎 (REQ-STABLE-*): /visits before /:playerId
  { method: 'GET', path: '/v1/stable', auth: 'player', handler: async (_r, _p, c, u) => stable(c).mine(u) },
  { method: 'PUT', path: '/v1/stable', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ theme: z.string().min(1).max(40), name: z.string().min(1).max(40).nullable(), slots: z.array(id.nullable()).max(10), featuredHorseIds: z.array(id).max(10) }).strict());
    return stable(c).save(u, b);
  } },
  { method: 'GET', path: '/v1/stable/visits', auth: 'player', handler: async (_r, _p, c, u) => stable(c).visits(u) },
  { method: 'GET', path: '/v1/stable/:playerId', auth: 'player', handler: async (_r, p, c, u) => stable(c).visit(u, playerIdParam(p.playerId!)) },
  { method: 'POST', path: '/v1/stable/:playerId/like', auth: 'player', handler: async (r, p, c, u) => stable(c).like(u, playerIdParam(p.playerId!), idem(r)) },
  // rewards
  { method: 'POST', path: '/v1/rewards/login-bonus', auth: 'player', handler: async (r, _p, c, u) => c.player(u).invoke('claimLogin', u, idem(r)) },
  // daily (REQ-REW-002), beginner (REQ-UXS-015) and season missions (REQ-UXS-016); first-win bonus (REQ-UXS-010); one claim endpoint for all
  { method: 'GET', path: '/v1/missions', auth: 'player', handler: async (_r, _p, c, u) => c.player(u).invoke('missionsAll', u) },
  { method: 'POST', path: '/v1/missions/:missionId/claim', auth: 'player', handler: async (r, p, c, u) => c.player(u).invoke('claimMission', u, p.missionId!, idem(r)) },
  // returning players (REQ-CB-001..012) and the what's-new card (REQ-CB-008)
  { method: 'GET', path: '/v1/comeback', auth: 'player', handler: async (_r, _p, c, u) => c.player(u).invoke('comeback', u) },
  { method: 'POST', path: '/v1/comeback/login', auth: 'player', handler: async (r, _p, c, u) => c.player(u).invoke('comebackClaimLogin', u, idem(r)) },
  { method: 'POST', path: '/v1/comeback/missions/:missionId/claim', auth: 'player', handler: async (r, p, c, u) => c.player(u).invoke('comebackClaimMission', u, missionIdParam(p.missionId!), idem(r)) },
  { method: 'POST', path: '/v1/comeback/welcome', auth: 'player', handler: async (_r, _p, c, u) => c.player(u).invoke('comebackWelcomed', u) },
  { method: 'GET', path: '/v1/whats-new', auth: 'player', handler: async (_r, _p, c, u) => c.player(u).invoke('whatsNew', u) },
  { method: 'POST', path: '/v1/whats-new/seen', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ upTo: z.number().int().min(0) }));
    return c.player(u).invoke('whatsNewSeen', u, b.upTo);
  } },
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
  { method: 'POST', path: '/v1/race/:raceId/report', auth: 'player', handler: async (_r, p, c, u) => {
    const r = (await c.race.report(p.raceId!, u)) as { ok?: boolean };
    // REQ-OPS-034: reports of races the player was in go to the review queue
    if (r?.ok && c.ops) await c.ops.integrity.report(p.raceId!, u, (c.clock ?? Date.now)());
    return r;
  } },
  // spectating (REQ-SPEC-*)
  { method: 'GET', path: '/v1/races/live', auth: 'player', handler: async (_r, _p, c, u) => spectate(c).list(u) },
  { method: 'POST', path: '/v1/race/:raceId/spectate', auth: 'player', handler: async (_r, p, c, u) => spectate(c).spectate(u, p.raceId!) },
  // tournaments (REQ-TOUR-*)
  { method: 'GET', path: '/v1/tournaments', auth: 'none', handler: async (_r, _p, c) => tournaments(c).list() },
  { method: 'GET', path: '/v1/tournaments/history/me', auth: 'player', handler: async (_r, _p, c, u) => tournaments(c).history(u) },
  { method: 'GET', path: '/v1/tournaments/:tournamentId', auth: 'none', handler: async (_r, p, c) => tournaments(c).detail(p.tournamentId!) },
  { method: 'GET', path: '/v1/tournaments/:tournamentId/me', auth: 'player', handler: async (_r, p, c, u) => tournaments(c).me(u, p.tournamentId!) },
  { method: 'POST', path: '/v1/tournaments/:tournamentId/register', auth: 'player', handler: async (r, p, c, u) => {
    const b = await body(r, z.object({ horseId: id }));
    return tournaments(c).register(u, p.tournamentId!, b.horseId);
  } },
  { method: 'POST', path: '/v1/tournaments/:tournamentId/unregister', auth: 'player', handler: async (_r, p, c, u) => tournaments(c).unregister(u, p.tournamentId!) },
  // profile, titles, stats (REQ-STAT-*, REQ-TITLE-*, REQ-SOCIAL-006)
  { method: 'PUT', path: '/v1/player/profile', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ displayName: z.string().min(1).max(40) }));
    return c.player(u).invoke('setDisplayName', u, b.displayName);
  } },
  { method: 'GET', path: '/v1/titles', auth: 'player', handler: async (_r, _p, c, u) => c.player(u).invoke('titles', u) },
  // 図鑑・実績 (REQ-COL-*, REQ-ACH-*)
  { method: 'GET', path: '/v1/collection', auth: 'player', handler: async (_r, _p, c, u) => c.player(u).invoke('collection', u) },
  { method: 'GET', path: '/v1/achievements', auth: 'player', handler: async (_r, _p, c, u) => c.player(u).invoke('achievements', u) },
  { method: 'POST', path: '/v1/achievements/claim-all', auth: 'player', handler: async (r, _p, c, u) => c.player(u).invoke('claimAllAchievements', u, idem(r)) },
  { method: 'POST', path: '/v1/achievements/:achievementId/tiers/:tier/claim', auth: 'player', handler: async (r, p, c, u) => {
    const tier = Number(p.tier);
    if (!Number.isInteger(tier) || tier < 1 || tier > 5) throw new AppError('BAD_REQUEST', 'bad tier');
    return c.player(u).invoke('claimAchievement', u, missionIdParam(p.achievementId!), tier, idem(r));
  } },
  { method: 'PUT', path: '/v1/player/title', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ titleId: id.nullable() }));
    return c.player(u).invoke('equipTitle', u, b.titleId);
  } },
  { method: 'GET', path: '/v1/stats', auth: 'player', handler: async (_r, _p, c, u) => c.player(u).invoke('stats', u) },
  // leaderboards (REQ-LB-*)
  { method: 'GET', path: '/v1/leaderboards/me', auth: 'player', handler: async (_r, _p, c, u) => c.leaderboard.myRank(u, jstMonthKey((c.clock ?? Date.now)())) },
  { method: 'GET', path: '/v1/leaderboards/:seasonId/:board', auth: 'none', handler: async (_r, p, c) => {
    const season = p.seasonId === 'current' ? jstMonthKey((c.clock ?? Date.now)()) : p.seasonId!;
    if (!/^\d{4}-\d{2}$/.test(season) || !(/^(class-[A-Z]|rating|index)$/.test(p.board!) || TA_BOARD_RE.test(p.board!) || LEAGUE_BOARD_RE.test(p.board!))) throw new AppError('BAD_REQUEST', 'bad season or board');
    return c.leaderboard.board(season, p.board!);
  } },
  // teams / 支部 (REQ-TEAM-*) — /me routes before /:teamId
  { method: 'GET', path: '/v1/teams/me', auth: 'player', handler: async (_r, _p, c, u) => teams(c).me(u) },
  { method: 'POST', path: '/v1/teams', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ name: z.string().min(1).max(40), joinPolicy: z.enum(['open', 'approval']), announcement: z.string().max(400).optional() }));
    return teams(c).create(u, b.name, b.joinPolicy, b.announcement ?? '');
  } },
  { method: 'PUT', path: '/v1/teams/me', auth: 'player', handler: async (r, _p, c, u) => {
    const emblemSchema = z.object({ shape: z.string().min(1).max(40), symbol: z.string().min(1).max(40), colors: z.tuple([z.string().min(1).max(40), z.string().min(1).max(40)]) });
    const b = await body(r, z.object({ announcement: z.string().max(400).optional(), joinPolicy: z.enum(['open', 'approval']).optional(), emblem: emblemSchema.optional() }));
    return teams(c).update(u, { ...(b.announcement !== undefined ? { announcement: b.announcement } : {}), ...(b.joinPolicy ? { joinPolicy: b.joinPolicy } : {}), ...(b.emblem ? { emblem: b.emblem } : {}) });
  } },
  { method: 'DELETE', path: '/v1/teams/me', auth: 'player', handler: async (_r, _p, c, u) => teams(c).disband(u) },
  { method: 'POST', path: '/v1/teams/me/leave', auth: 'player', handler: async (_r, _p, c, u) => teams(c).leave(u) },
  { method: 'POST', path: '/v1/teams/me/kick', auth: 'player', handler: async (r, _p, c, u) => teams(c).kick(u, (await body(r, z.object({ playerId: id }))).playerId) },
  { method: 'PUT', path: '/v1/teams/me/roles', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ playerId: id, role: z.enum(['officer', 'member']) }));
    return teams(c).setRole(u, b.playerId, b.role);
  } },
  { method: 'POST', path: '/v1/teams/me/transfer', auth: 'player', handler: async (r, _p, c, u) => teams(c).transfer(u, (await body(r, z.object({ playerId: id }))).playerId) },
  { method: 'POST', path: '/v1/teams/me/requests/:playerId/approve', auth: 'player', handler: async (_r, p, c, u) => teams(c).approve(u, p.playerId!) },
  { method: 'POST', path: '/v1/teams/me/requests/:playerId/decline', auth: 'player', handler: async (_r, p, c, u) => teams(c).decline(u, p.playerId!) },
  // 支部対抗シーズン (REQ-LEAGUE-005): my team's league; division tables are leaderboard boards `league-<divisionId>`
  { method: 'GET', path: '/v1/league/me', auth: 'player', handler: async (_r, _p, c, u) => teams(c).league(u) },
  // REQ-TEAMFEED-*: cheer stamps and the team feed (fixed stamps only, no free text)
  { method: 'GET', path: '/v1/stamps', auth: 'player', handler: async (_r, _p, c, u) => teams(c).stamps(u) },
  { method: 'GET', path: '/v1/teams/me/feed', auth: 'player', handler: async (r, _p, c, u) => {
    const q = new URL(r.url).searchParams;
    const num = (k: string, max: number) => {
      const v = q.get(k);
      if (v === null || v === '') return null;
      if (!/^\d{1,9}$/.test(v) || Number(v) < 1 || Number(v) > max) throw new AppError('BAD_REQUEST', `bad ${k}`);
      return Number(v);
    };
    return teams(c).feed(u, num('before', 999_999_999), num('limit', 500));
  } },
  { method: 'POST', path: '/v1/teams/me/feed/stamps', auth: 'player', handler: async (r, _p, c, u) => teams(c).postStamp(u, (await body(r, z.object({ stampId: stampId }).strict())).stampId) },
  { method: 'PUT', path: '/v1/teams/me/feed/:seq/reaction', auth: 'player', handler: async (r, p, c, u) => teams(c).react(u, seqParam(p.seq!), (await body(r, z.object({ stampId: stampId.nullable() }).strict())).stampId) },
  { method: 'POST', path: '/v1/teams/me/feed/:seq/report', auth: 'player', handler: async (r, p, c, u) => teams(c).report(u, seqParam(p.seq!), (await body(r, z.object({ reason: z.enum(REPORT_REASONS) }).strict())).reason) },
  { method: 'GET', path: '/v1/teams/me/feed/mutes', auth: 'player', handler: async (_r, _p, c, u) => teams(c).mutes(u) },
  { method: 'PUT', path: '/v1/teams/me/feed/mutes', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ playerId: id, muted: z.boolean() }).strict());
    return teams(c).mute(u, playerIdParam(b.playerId), b.muted);
  } },
  { method: 'GET', path: '/v1/teams/search', auth: 'player', handler: async (r, _p, c) => teams(c).search(new URL(r.url).searchParams.get('q') ?? '') },
  { method: 'GET', path: '/v1/teams/leaderboard/:seasonId', auth: 'none', handler: async (_r, p, c) => {
    const season = p.seasonId === 'current' ? jstMonthKey((c.clock ?? Date.now)()) : p.seasonId!;
    if (!/^\d{4}-\d{2}$/.test(season)) throw new AppError('BAD_REQUEST', 'bad season');
    return teams(c).leaderboard(season);
  } },
  { method: 'GET', path: '/v1/teams/:teamId', auth: 'player', handler: async (_r, p, c, u) => teams(c).view(teamIdParam(p.teamId!), u) },
  { method: 'POST', path: '/v1/teams/:teamId/join', auth: 'player', handler: async (_r, p, c, u) => teams(c).join(u, teamIdParam(p.teamId!)) },
  { method: 'DELETE', path: '/v1/teams/:teamId/request', auth: 'player', handler: async (_r, p, c, u) => teams(c).cancelRequest(u, teamIdParam(p.teamId!)) },
  // event races (REQ-EVENT-*)
  { method: 'GET', path: '/v1/events', auth: 'player', handler: async (_r, _p, c, u) => events(c).list(u) },
  { method: 'POST', path: '/v1/events/:eventId/enqueue', auth: 'player', handler: async (r, p, c, u) => {
    const b = await body(r, z.object({ horseId: id }));
    return events(c).enqueue(u, eventIdParam(p.eventId!), b.horseId, idem(r));
  } },
  { method: 'POST', path: '/v1/events/:eventId/cancel', auth: 'player', handler: async (_r, p, c, u) => events(c).cancel(u, eventIdParam(p.eventId!)) },
  { method: 'GET', path: '/v1/events/:eventId/leaderboard', auth: 'none', handler: async (_r, p, c) => events(c).board(eventIdParam(p.eventId!)) },
  { method: 'GET', path: '/v1/events/:eventId/me', auth: 'player', handler: async (_r, p, c, u) => events(c).me(u, eventIdParam(p.eventId!)) },
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
  // friend invite codes (REQ-INV-*, contracts/protocol.md §19)
  { method: 'GET', path: '/v1/invite', auth: 'player', handler: async (r, _p, c, u) => {
    const raw = r.headers.get('x-install-id');
    const inst = raw === null ? null : installIdSchema.safeParse(raw);
    if (inst && !inst.success) throw new AppError('BAD_REQUEST', 'bad x-install-id');
    return invite(c).view(u, inst?.data ?? null);
  } },
  { method: 'POST', path: '/v1/invite/redeem', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ code: z.string().min(1).max(32), installId: installIdSchema }).strict());
    return invite(c).redeem(u, b.code, b.installId);
  } },
  // push notifications (REQ-PUSH-*)
  { method: 'PUT', path: '/v1/push/devices', auth: 'player', handler: async (r, _p, c, u) => {
    // REQ-L10N-007: the device's language (body `locale`, else the request's ?lang= / Accept-Language)
    const b = await body(r, z.object({ token: z.string().min(8).max(4096), platform: z.enum(['ios', 'android']), locale: z.enum(LOCALES).optional() }));
    return c.player(u).invoke('registerDevice', u, b.token, b.platform, b.locale ?? resolveLocale(r));
  } },
  { method: 'POST', path: '/v1/push/devices/unregister', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ token: z.string().min(1).max(4096) }));
    return c.player(u).invoke('unregisterDevice', u, b.token);
  } },
  { method: 'GET', path: '/v1/push/preferences', auth: 'player', handler: async (r, _p, c, u) => c.player(u).invoke('pushPreferences', u, resolveLocale(r)) },
  { method: 'PUT', path: '/v1/push/preferences', auth: 'player', handler: async (r, _p, c, u) => {
    const hour = z.number().int().min(0).max(23);
    const b = await body(r, z.object({
      categories: z.object({ season: z.boolean(), friends: z.boolean(), invites: z.boolean(), events: z.boolean(), comeback: z.boolean() }).partial().optional(),
      quietHours: z.object({ startHour: hour, endHour: hour }).nullable().optional(),
    }));
    return c.player(u).invoke('setPushPreferences', u, {
      ...(b.categories ? { categories: b.categories } : {}),
      ...(b.quietHours !== undefined ? { quietHours: b.quietHours } : {}),
    }, resolveLocale(r));
  } },
  // analytics (REQ-KPI-003)
  { method: 'POST', path: '/v1/analytics/events', auth: 'player', handler: async (r, _p, c, u) => c.player(u).invoke('kpiIngest', u, await body(r, clientBatchSchema)) },
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
  // 週替わりチャレンジ weekly challenge (REQ-WCH-*, contracts/protocol.md §31)
  { method: 'GET', path: '/v1/challenges/weekly', auth: 'player', handler: async (_r, _p, c, u) => weekly(c).view(u) },
  { method: 'POST', path: '/v1/challenges/weekly/:challengeId/start', auth: 'player', handler: async (r, p, c, u) => {
    if (!/^[a-z0-9_]{1,40}$/.test(p.challengeId!)) throw new AppError('BAD_REQUEST', 'bad challenge id');
    const b = await body(r, z.union([z.object({ horseId: id }).strict(), z.object({ loan: z.literal(true) }).strict()]));
    return weekly(c).start(u, p.challengeId!, b, idem(r));
  } },
  { method: 'POST', path: '/v1/challenges/weekly/submit', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({
      sessionId: id, token: z.string().min(1).max(2048), resultHash: z.string().regex(/^[0-9a-f]{64}$/),
      inputs: z.array(z.unknown()).max(4000), config: z.unknown().optional(),
    }).strict());
    return weekly(c).submit(u, b);
  } },
  // rewarded ads (REQ-AD-*, contracts/protocol.md §21)
  { method: 'GET', path: '/v1/ads', auth: 'player', handler: async (_r, _p, c, u) => c.player(u).invoke('ads', u) },
  { method: 'PUT', path: '/v1/ads/preferences', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ mode: z.enum(['auto', 'on', 'off']) }).strict());
    return c.player(u).invoke('setAdPref', u, b.mode);
  } },
  { method: 'GET', path: '/v1/ads/sessions/:sessionId', auth: 'player', handler: async (_r, p, c, u) => {
    if (!/^ad_[0-9a-f]{16}$/.test(p.sessionId!)) throw new AppError('BAD_REQUEST', 'bad session id');
    return c.player(u).invoke('adSession', u, p.sessionId!);
  } },
  // the ad network's server-side verification callback (no player auth: the signature is the authentication)
  { method: 'GET', path: '/v1/ads/ssv/admob', auth: 'none', handler: async (r, _p, c) => {
    if (!c.ads) throw new AppError('NOT_FOUND', 'rewarded ads are not configured');
    const now = (c.clock ?? Date.now)();
    let cb;
    try {
      cb = await verifyAdMobCallback(rawQuery(r.url), c.ads.keys, c.ads.adUnits);
    } catch (e) {
      if (e instanceof SsvError) {
        // r10 QA: only FAILED callbacks count against the source IP. Every valid callback comes from the ad network's
        // few servers, so a per-IP budget on them would throttle real rewards; valid ones are limited per player below.
        c.ads.admit?.('ip:' + (r.headers.get('cf-connecting-ip') ?? '?'), now);
        throw new AppError('UNAUTHORIZED', e.message);
      }
      throw e;
    }
    playerIdParam(cb.userId);
    c.ads.admit?.('u:' + cb.userId, now);
    const out = await c.player(cb.userId).invoke('adReward', cb.userId, cb);
    return { ok: true, status: out.status };
  } },
  { method: 'POST', path: '/v1/ads/:placementId/start', auth: 'player', handler: async (r, p, c, u) => {
    if (!/^[a-z0-9_]{1,32}$/.test(p.placementId!)) throw new AppError('BAD_REQUEST', 'bad placement id');
    return c.player(u).invoke('adStart', u, p.placementId!, idem(r));
  } },
  // 調教 training (REQ-TRAIN-*, contracts/protocol.md §25)
  { method: 'GET', path: '/v1/training', auth: 'player', handler: async (_r, _p, c, u) => c.player(u).invoke('training', u) },
  { method: 'POST', path: '/v1/training/start', auth: 'player', handler: async (r, _p, c, u) => {
    const b = await body(r, z.object({ horseId: z.string().min(1).max(40), menuId: z.string().regex(/^[a-z0-9_]{1,24}$/) }).strict());
    return c.player(u).invoke('trainingStart', u, b.horseId, b.menuId, idem(r));
  } },
  { method: 'POST', path: '/v1/training/:sessionId/finish', auth: 'player', handler: async (r, p, c, u) => {
    if (!/^tr_[a-z0-9_]{1,40}$/.test(p.sessionId!)) throw new AppError('BAD_REQUEST', 'bad session id');
    const b = await body(r, z.object({ taps: z.array(z.number().int()).max(40), skipped: z.boolean().optional() }).strict());
    return c.player(u).invoke('trainingFinish', u, p.sessionId!, b, idem(r));
  } },
  { method: 'POST', path: '/v1/training/items/:itemId/use', auth: 'player', handler: async (r, p, c, u) => {
    if (!/^[a-z0-9_]{1,40}$/.test(p.itemId!)) throw new AppError('BAD_REQUEST', 'bad item id');
    const b = await body(r, z.object({ horseId: z.string().min(1).max(40) }).strict());
    return c.player(u).invoke('trainingUseItem', u, p.itemId!, b.horseId, idem(r));
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
  if (url.pathname.startsWith('/v1/admin/') && ctx.ops && ctx.authenticateAdmin) {
    return handleAdmin(req, {
      ops: ctx.ops, authenticateAdmin: (r) => ctx.authenticateAdmin!(r), player: ctx.player, leaderboard: ctx.leaderboard,
      paidBalance: () => ctx.paidBalance(), replay: (id) => ctx.race.replay(id), ...(ctx.clock ? { clock: ctx.clock } : {}),
      ...(ctx.tournaments ? { tournaments: ctx.tournaments } : {}),
      baseMaster: ctx.baseMaster ?? ctx.master,
      ...(ctx.inviteLookup ? { inviteLookup: ctx.inviteLookup } : {}),
      ...(ctx.adminConsoleOrigins ? { consoleOrigins: ctx.adminConsoleOrigins } : {}),
    });
  }
  // REQ-L10N-001..003: `?lang=` / Accept-Language; Japanese is rendered by the domain, English translated here
  const l10n = { lang: resolveLocale(req), cat: catalogFor(ctx.master) };
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
      const out = await r.handler(req, params, ctx, uid);
      return out instanceof Response ? out : json(localize(out, l10n.lang, l10n.cat), 200, l10n.lang);
    }
    return methodMismatch ? json({ error: { code: 'BAD_REQUEST', message: 'method not allowed' } }, 405) : errorResponse(new AppError('NOT_FOUND'), l10n);
  } catch (e) {
    if (e instanceof AppError) return errorResponse(e, l10n);
    console.error(e);
    return json({ error: { code: 'INTERNAL', message: 'internal error' } }, 500);
  }
};

/** Adapts per-player invocations (Durable Object RPC or PlayerService) to the friends orchestration. */
export function makeFriendsService(player: (uid: string) => PlayerInvoker, dir: Directory): FriendsService {
  const ports: FriendPlayers = {
    send: (u, t) => player(u).invoke('friendSend', u, t),
    receive: (u, f, name) => player(u).invoke('friendReceive', u, f, name),
    accept: (u, f) => player(u).invoke('friendAccept', u, f),
    accepted: (u, b, name) => player(u).invoke('friendAccepted', u, b, name),
    decline: (u, f) => player(u).invoke('friendDecline', u, f),
    cancel: (u, t) => player(u).invoke('friendCancel', u, t),
    remove: (u, o) => player(u).invoke('friendRemove', u, o),
    invite: (u, f, pass, name) => player(u).invoke('friendInvite', u, f, pass, name),
    friendsState: (u) => player(u).invoke('friendsState', u),
  };
  return new FriendsService(ports, dir);
}

/**
 * REQ-AD-006: the query string exactly as it arrived (after `?`, before any `#`). The SSV signature covers these bytes,
 * so it is not re-serialised through URL (which percent-encodes some characters, e.g. `'`).
 */
export function rawQuery(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return '';
  const h = url.indexOf('#', q);
  return url.slice(q + 1, h < 0 ? undefined : h);
}

/** Adapts per-player invocations to the invite orchestration (REQ-INV-*). */
export function invitePlayersFrom(player: (uid: string) => PlayerInvoker): InvitePlayers {
  return {
    attempt: (u, h) => player(u).invoke('inviteAttempt', u, h),
    view: (u, h) => player(u).invoke('inviteView', u, h),
    accept: (o, i, h, name) => player(o).invoke('inviteAccept', o, i, h, name),
    revert: (o, i, unfriend) => player(o).invoke('inviteRevert', o, i, unfriend),
    commit: (u, o, code, h, f) => player(u).invoke('inviteCommit', u, o, code, h, f),
    flag: (u, f) => player(u).invoke('inviteFlag', u, f),
    unfriend: (u, o) => player(u).invoke('friendRemove', u, o),
  };
}
export function makeInviteService(player: (uid: string) => PlayerInvoker, codes: InviteDirectory, dir: Directory, master: () => Master): InviteService {
  return new InviteService(invitePlayersFrom(player), codes, dir, master);
}
/** Adapts per-player invocations to the team orchestration (REQ-TEAM-*). */
export function teamPlayersFrom(player: (uid: string) => PlayerInvoker): TeamPlayers {
  return {
    prepareJoin: (u, t) => player(u).invoke('teamPrepareJoin', u, t),
    commitJoin: (u, t) => player(u).invoke('teamCommitJoin', u, t),
    abortJoin: (u, t) => player(u).invoke('teamAbortJoin', u, t),
    addOutgoing: (u, t) => player(u).invoke('teamAddOutgoing', u, t),
    removeOutgoing: (u, t) => player(u).invoke('teamRemoveOutgoing', u, t),
    left: (u, t, byChoice) => player(u).invoke('teamLeft', u, t, byChoice),
    state: (u) => player(u).invoke('teamState', u),
    push: (u, templateId, vars) => player(u).invoke('queuePush', u, templateId, vars),
    stampCatalog: (u) => player(u).invoke('stampCatalog', u),
    stampCheck: (u, s) => player(u).invoke('stampCheck', u, s),
    stampPosted: (u, s, k, t, ref) => player(u).invoke('stampPosted', u, s, k, t, ref ?? null),
    feedViewer: (u, first) => player(u).invoke('feedViewer', u, first),
    feedMutes: (u) => player(u).invoke('feedMutes', u),
    feedMute: (u, t, muted) => player(u).invoke('feedMute', u, t, muted),
    feedReported: (u, t, seq, by, reason) => player(u).invoke('feedReported', u, t, seq, by, reason),
    cheerPush: (u, from, name) => player(u).invoke('cheerPush', u, from, name),
  };
}

/** Adapts per-player invocations to the tournament orchestration (REQ-TOUR-*). */
export function tournamentPlayersFrom(player: (uid: string) => PlayerInvoker): TournamentPlayers {
  return {
    tournamentEntry: async (u, h) => (await player(u).invoke('tournamentEntry', u, h)) as unknown as TournamentEntryInfo,
    history: (u) => player(u).invoke('tournamentHistory', u),
  };
}

/** REQ-SPEC-001: the viewer's friend ids (for friend-room visibility). */
export const friendIdsFrom = (player: (uid: string) => PlayerInvoker) => async (u: string) => (await player(u).invoke('friendsState', u)).ids;

/** Adapts per-player invocations to the event orchestration (REQ-EVENT-*). */
export function eventPlayersFrom(player: (uid: string) => PlayerInvoker): EventPlayers {
  return {
    raceEntry: (u, h) => player(u).invoke('raceEntry', u, h),
    enter: (u, e, h, k) => player(u).invoke('eventEnter', u, e, h, k),
    cancel: (u, e, entryId) => player(u).invoke('eventCancel', u, e, entryId),
    view: (u) => player(u).invoke('eventsView', u),
  };
}

/** Adapts per-player invocations to the stud lending orchestration (REQ-BREED-010..016). */
export function studPlayersFrom(player: (uid: string) => PlayerInvoker): StudPlayers {
  return {
    view: (u) => player(u).invoke('studView', u),
    list: (u, h, v, f, l) => player(u).invoke('studList', u, h, v, f, l),
    unlist: (u, h) => player(u).invoke('studUnlist', u, h),
    peek: (o, b, h) => player(o).invoke('studPeek', o, b, h),
    reserve: (o, op, b, h, fee) => player(o).invoke('studReserve', o, op, b, h, fee),
    preview: (b, snap, d) => player(b).invoke('studPreview', b, snap, d),
    apply: (b, op, snap, d, um) => player(b).invoke('studApply', b, op, snap, d, um),
    settle: (o, op, ok, info) => player(o).invoke('studSettle', o, op, ok, info),
    acked: (b, op) => player(b).invoke('studAcked', b, op),
    friendIds: async (u) => (await player(u).invoke('friendsState', u)).ids,
  };
}

export function makeStudService(player: (uid: string) => PlayerInvoker, dir: StudDirectory, master: () => Master): StudService {
  return new StudService(studPlayersFrom(player), dir, () => master().progression.stud?.browseLimit ?? 50);
}
