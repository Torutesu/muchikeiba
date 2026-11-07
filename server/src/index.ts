import type { Env } from './env.js';
import { eventPlayersFrom, friendIdsFrom, handle, makeFriendsService, makeInviteService, makeStudService, teamPlayersFrom, tournamentPlayersFrom, type AppContext, type PlayerInvoker, type RaceEntry } from './http/app.js';
import { bearer, verifyFirebaseIdToken } from './http/auth.js';
import { parseStoreNotification, storeSettingsFromEnv } from './http/stores.js';
import { accountingStoreIndex } from './do/storeIndex.js';
import { loadMaster } from './domain/master.js';
import { validateGacha } from './domain/gacha.js';
import { validateSkills } from './domain/skills.js';
import { DEFAULT_RULESET } from './domain/ruleset.js';
import { validateItems } from './domain/itemShop.js';
import { unwrap, type Envelope } from './do/rpc.js';
import { AppError } from './domain/errors.js';

export { PlayerDO } from './do/player.js';
export { RaceRoomDO } from './do/raceRoom.js';
export { MatchmakerDO } from './do/matchmaker.js';
export { AccountingDO } from './do/accounting.js';
export { LeaderboardDO } from './do/leaderboard.js';
export { DirectoryDO } from './do/directory.js';
export { OpsDO } from './do/ops.js';
export { IntegrityDO } from './do/integrity.js';
export { TeamDO, TeamDirectoryDO } from './do/team.js';
export { EventDO } from './do/event.js';
export { TournamentDO } from './do/tournament.js';
import { tournamentSnapshotKey } from './do/tournament.js';
import { SpectateService, SPECTATE_RATE } from './domain/spectate.js';
import { TournamentsService, type TournamentBackend } from './domain/tournamentService.js';
import type { TournamentSummary } from './domain/tournaments.js';
import { signTicket } from './http/ticket.js';
import { TeamsService, type TeamFeedPage, type TeamLeagueView, type TeamPort, type TeamView } from './domain/teamService.js';
import { stampsProblems, type FeedItem } from './domain/teamFeed.js';
import type { TeamSummary } from './domain/teams.js';
import { EventsService } from './domain/eventService.js';
import { eventBoardKey, eventCronPlan, validateEvents } from './domain/events.js';
import { cryptoRng } from './domain/rng.js';
import type { Master } from './domain/master.js';
import type { OpsApi } from './http/admin.js';
import { authenticateAdmin, parseAdminTokens, RateLimiter, type AdminAuthConfig, type AdminRole } from './ops/admin.js';
import { DeadLetterService, type DeadLetterOwner, type DeadLetterRegistry, type DeadLetterSource } from './ops/deadLetter.js';
import { activeConfig } from './ops/activeConfig.js';
import type { ResolvedConfig } from './ops/config.js';
import { shardedDirectory, shardedInviteDirectory, shardedStableDirectory, shardedStudDirectory } from './do/directory.js';
import { makeStableService } from './http/stablePorts.js';
import { boardKey, indexKey, type RolloverState } from './domain/leaderboard.js';
import { validateLeagueAndWeather } from './domain/league.js';
import { runScheduled } from './domain/scheduled.js';
import { DEFAULT_HOLD_POLICY, sweepReplays, SWEEP_CURSOR_KEY, type ReplayBucket, type SweepCursorStore } from './domain/retention.js';
import { renderTemplate, seasonReminderFor } from './domain/push.js';
import { fcmFromEnv } from './push/fcm.js';
import { TimeAttackService } from './race/timeAttack.js';
import { HttpVerifierClient } from './domain/verifier.js';
import { taBoardName, type GhostFile, type TaBoardFile, type TaEntry } from './domain/timeAttack.js';
import { devModeRefused } from './http/devMode.js';
import { validateUx } from './domain/onboarding.js';
import type { TournamentClosingInfo } from './domain/nudges.js';
import { jstMonthKey } from './domain/time.js';
import { collectItemIds } from './domain/visuals.js';
import { parseAdUnits, RemoteKeySource, StaticKeySource, type PemKey, type SsvKeySource } from './ads/ssv.js';

/** REQ-AD-006: SSV key sources are cached per isolate (the remote set is fetched at most once a day / per unknown key id). */
const ssvSources = new Map<string, SsvKeySource>();
function ssvKeys(env: Env): SsvKeySource | null {
  const k = env.ADS_SSV_KEYS ? 'static:' + env.ADS_SSV_KEYS : env.ADS_SSV_KEYS_URL ? 'url:' + env.ADS_SSV_KEYS_URL : null;
  if (!k) return null;
  let src = ssvSources.get(k);
  if (!src) {
    src = env.ADS_SSV_KEYS ? new StaticKeySource(JSON.parse(env.ADS_SSV_KEYS) as PemKey[]) : new RemoteKeySource({ url: env.ADS_SSV_KEYS_URL! });
    ssvSources.set(k, src);
  }
  return src;
}
/** REQ-AD-006: failed SSV callbacks per source IP and valid ones per player (per isolate; the player object also caps sessions per day). */
const ssvLimiter = new RateLimiter({ read: { capacity: 30, refillPerSec: 1 }, write: { capacity: 30, refillPerSec: 1 } }, 'ssv');

/** REQ-PUSH-006: one FCM topic send reaches every opted-in device (no per-player fan-out). */
async function broadcastSeasonReminder(env: Env, now: number): Promise<string | null> {
  const { master } = await activeConfig(env); // follow remote config (REQ-OPS-005)
  const r = seasonReminderFor(master, now);
  if (!r) return null;
  const t = master.push.templates[r.templateId];
  const topic = t && master.push.topics[t.category];
  const sender = fcmFromEnv(env);
  if (!t || !topic || !sender) return null;
  const out = await sender.sendTopic(topic, renderTemplate(t, r.templateId, r.vars));
  if (out.kind !== 'ok') console.error('season reminder failed', r.templateId, out);
  return r.templateId;
}

const baseMaster = loadMaster();
validateGacha(baseMaster); // fail fast on a broken gacha/master definition (REQ-GACHA-003/008)
validateItems(baseMaster); // REQ-ITEM-*: tickets may not reach paid-only banners, cosmetics reference real assets/patterns
{ const sp = stampsProblems(baseMaster); if (sp.length) throw new Error('master/stamps.json: ' + sp.join('; ')); } // REQ-TEAMFEED-002
validateEvents(baseMaster, baseMaster.events); // REQ-EVENT-001
validateLeagueAndWeather(baseMaster); // REQ-LEAGUE-* and per-course climate (REQ-TRACK-003)
validateUx(baseMaster, new Set(collectItemIds(baseMaster))); // REQ-UXS-*: onboarding, missions, experiments, deletion
validateSkills(baseMaster, DEFAULT_RULESET); // REQ-UXS-050: unknown skills, effects above the ruleset caps, rarity/style fit

/** REQ-TEAM-*: team orchestration over TeamDOs, the team directory and the season board in LeaderboardDO. */
function makeTeamsService(env: Env, master: () => Master, player: (uid: string) => PlayerInvoker): TeamsService {
  const call = async (p: Promise<Envelope<unknown>>) => unwrap(await p);
  const team = (id: string) => stub(env.TEAMS, id);
  const port: TeamPort = {
    create: async (id, init) => (await call(team(id).create!(id, init))) as TeamView,
    view: async (id, viewer) => (await call(team(id).view!(viewer))) as TeamView,
    reserve: async (id, p) => { await call(team(id).reserve!(p)); },
    release: async (id, p) => { await call(team(id).release!(p)); },
    commit: async (id, m) => { await call(team(id).commit!(m)); },
    request: async (id, p, n) => (await call(team(id).request!(p, n))) as 'requested' | 'already',
    checkRequest: async (id, a, p) => { await call(team(id).checkRequest!(a, p)); },
    dropRequest: async (id, p) => (await call(team(id).dropRequest!(p))) as boolean,
    decline: async (id, a, p) => (await call(team(id).decline!(a, p))) as boolean,
    leave: async (id, p) => (await call(team(id).leave!(p))) as { disbanded: boolean },
    kick: async (id, a, t) => { await call(team(id).kick!(a, t)); },
    setRole: async (id, a, t, r) => { await call(team(id).setRole!(a, t, r)); },
    transfer: async (id, a, t) => { await call(team(id).transfer!(a, t)); },
    update: async (id, a, patch) => { await call(team(id).update!(a, patch)); },
    disband: async (id, a) => { await call(team(id).disband!(a)); },
    managers: async (id) => (await call(team(id).managers!())) as string[],
    reportPoints: async (id, p, s, pts, n) => { await call(team(id).reportPoints!(p, s, pts, n)); },
    // REQ-TEAMFEED-*
    feedPost: async (id, p, s) => (await call(team(id).feedPost!(p, s))) as FeedItem,
    feedRace: async (id, p, r) => (await call(team(id).feedRace!(p, r))) as FeedItem | null,
    feedReact: async (id, p, seq, s) => (await call(team(id).feedReact!(p, seq, s))) as { ownerId: string; isNew: boolean; kind: 'stamp' | 'race' },
    feedReport: async (id, p, seq) => (await call(team(id).feedReport!(p, seq))) as { ownerId: string; first: boolean },
    feedPage: async (id, v, muted, before, limit) => (await call(team(id).feedPage!(v, muted, before, limit))) as TeamFeedPage,
    feedForget: async (id, p) => (await call(team(id).feedForget!(p))) as { removed: number },
  };
  const dir = () => stub(env.TEAM_DIRECTORY, 'global');
  return new TeamsService(master, port, teamPlayersFrom(player), {
    search: async (q, limit) => (await call(dir().search!(q, limit))) as TeamSummary[],
  }, {
    board: async (seasonId) => {
      const obj = await env.SNAPSHOTS.get(boardKey(seasonId, 'teams'));
      return obj ? obj.json() : { seasonId, board: 'teams', generatedAt: null, total: 0, entries: [] };
    },
    rankOf: async (seasonId, teamId) => (await call(stub(env.LEADERBOARD, `lb:${seasonId}`).teamRankOf!(teamId))) as { rank: number; total: number; generatedAt: number | null } | null,
    leagueOf: async (seasonId, teamId) => (await call(stub(env.LEADERBOARD, `lb:${seasonId}`).leagueOf!(teamId, Date.now()))) as TeamLeagueView,
  }, cryptoRng);
}

/** REQ-EVENT-007..009: one cron pass over the configured events. */
async function eventsStep(env: Env, now: number): Promise<string[]> {
  const { master } = await activeConfig(env);
  const log: string[] = [];
  for (const a of eventCronPlan(master.events, now)) {
    const ev = stub(env.EVENTS, `ev:${a.eventId}`);
    try {
      if (a.snapshot) unwrap(await ev.snapshot!(a.eventId, now));
      if (a.notifyStart && (unwrap(await ev.markStartNotified!()) as boolean)) {
        const def = master.events.find((e) => e.id === a.eventId)!;
        const t = master.push.templates.event_start;
        const topic = master.push.topics.events;
        const sender = fcmFromEnv(env);
        if (t && topic && sender) {
          const out = await sender.sendTopic(topic, renderTemplate(t, 'event_start', { event: def.name }));
          if (out.kind !== 'ok') console.error('event start push failed', a.eventId, out);
        }
        log.push(`eventStart:${a.eventId}`);
      }
      if (a.close) log.push(`eventClose:${a.eventId}:${(unwrap(await ev.closeStep!(a.eventId, now)) as RolloverState).status}`);
    } catch (e) {
      log.push(`eventError:${a.eventId}`);
      console.error('event cron step failed', a.eventId, (e as Error).message);
    }
  }
  return log;
}

/** REQ-TOUR-005: cron fallback — wake every active tournament (its own alarms do the work). */
async function tournamentsStep(env: Env, now: number): Promise<string[]> {
  if (!env.TOURNAMENTS) return [];
  const list = unwrap(await stub(env.TOURNAMENTS, 'index').indexList!()) as TournamentSummary[];
  const log: string[] = [];
  for (const t of list) {
    if (t.status === 'finished' || t.status === 'cancelled') continue;
    try {
      const r = unwrap(await stub(env.TOURNAMENTS, `tour:${t.id}`).wake!(now)) as { status: string };
      log.push(`tournament:${t.id}:${r.status}`);
    } catch (e) {
      log.push(`tournamentError:${t.id}`);
      console.error('tournament wake failed', t.id, (e as Error).message);
    }
  }
  return log;
}

/**
 * REQ-UXS-012: when a tournament's registration closes within the lead time, nudge (once) the players who raced
 * ranked this season in an eligible class and have not registered; each player's object checks the rest
 * (ranked races, preferences, quiet hours, daily cap). Bounded by nudges.tournamentClosingMaxTargets.
 */
async function tournamentClosingStep(env: Env, now: number): Promise<string[]> {
  if (!env.TOURNAMENTS) return [];
  const { master } = await activeConfig(env);
  const cfg = master.progression.nudges;
  if (!cfg || cfg.tournamentClosingMaxTargets === 0) return [];
  const list = unwrap(await stub(env.TOURNAMENTS, 'index').indexList!()) as TournamentSummary[];
  const log: string[] = [];
  for (const t of list) {
    if (t.status === 'finished' || t.status === 'cancelled' || t.registrationClosesAtMs <= now || t.registrationClosesAtMs - now > cfg.tournamentClosingLeadMs) continue;
    try {
      const info = unwrap(await stub(env.TOURNAMENTS, `tour:${t.id}`).closingNudge!(now, cfg.tournamentClosingLeadMs)) as (TournamentClosingInfo & { registered: string[] }) | null;
      if (!info) continue;
      const registered = new Set(info.registered);
      const ids = (unwrap(await stub(env.LEADERBOARD, `lb:${jstMonthKey(now)}`).activePlayers!(info.classIds, cfg.tournamentClosingMaxTargets + registered.size)) as string[]).filter((p) => !registered.has(p)).slice(0, cfg.tournamentClosingMaxTargets);
      const { registered: _r, ...nudge } = info;
      let sent = 0;
      for (const p of ids) {
        try { await stub(env.PLAYER, p).invoke!('nudgeTournamentClosing', [p, nudge]); sent++; } catch (e) { console.error('tournament closing nudge failed', p, (e as Error).message); }
      }
      log.push(`tournamentClosing:${t.id}:${sent}`);
    } catch (e) {
      log.push(`tournamentClosingError:${t.id}`);
      console.error('tournament closing step failed', t.id, (e as Error).message);
    }
  }
  return log;
}

/** REQ-TOUR-*: TournamentBackend over TournamentDO instances (`tour:<id>`, index `index`). */
function tournamentBackend(env: Env): TournamentBackend {
  const call = async (p: Promise<Envelope<unknown>>) => unwrap(await p);
  const tour = (id: string) => stub(env.TOURNAMENTS!, `tour:${id}`);
  return {
    list: async () => (await call(stub(env.TOURNAMENTS!, 'index').indexList!())) as TournamentSummary[],
    view: (id, now) => call(tour(id).view!(now)),
    published: async (id) => {
      const obj = await env.SNAPSHOTS.get(tournamentSnapshotKey(id));
      return obj ? obj.json() : null;
    },
    me: (id, p, now) => call(tour(id).me!(p, now)),
    register: (id, p, h, e, now) => call(tour(id).register!(p, h, e, now)),
    unregister: (id, p, now) => call(tour(id).unregister!(p, now)),
    create: (def, by, now) => call(tour(def.id).create!(def, by, now)),
    cancel: (id, reason, _by, now) => call(tour(id).cancel!(reason, now)),
  };
}

type Rpc = Record<string, (...a: unknown[]) => Promise<Envelope<unknown>>>;
const stub = (ns: DurableObjectNamespace, name: string) => ns.get(ns.idFromName(name)) as unknown as Rpc;

/** Ops backend over the OpsDO / IntegrityDO singletons (REQ-OPS-*). */
export function makeOpsApi(env: Env): OpsApi | undefined {
  if (!env.OPS || !env.INTEGRITY) return undefined;
  const ops = () => stub(env.OPS!, 'global');
  const integ = () => stub(env.INTEGRITY!, 'global');
  const call = async <T>(p: Promise<Envelope<unknown>>) => unwrap(await p) as T;
  return {
    admit: (id, kind, now) => call(ops().admit!(id, kind, now)),
    audit: (e, now) => call(ops().audit!(e, now)),
    auditQuery: (q) => call(ops().auditQuery!(q)),
    config: {
      active: (now, known) => call(ops().configActive!(now, known)),
      validate: (b) => call(ops().configValidate!(b)),
      stage: (b, by, note, now) => call(ops().configStage!(b, by, note, now)),
      schedule: (v, at, by, reason, now) => call(ops().configSchedule!(v, at, by, reason, now)),
      cancel: (id, now) => call(ops().configCancel!(id, now)),
      rollback: (v, by, reason, now) => call(ops().configRollback!(v, by, reason, now)),
      list: (now) => call(ops().configList!(now)),
      get: (id) => call(ops().configGet!(id)),
    },
    integrity: {
      recordRace: (r) => call(integ().recordRace!(r)),
      report: (raceId, reporter, now) => call(integ().report!(raceId, reporter, now)),
      reports: (st, limit) => call(integ().reports!(st, limit)),
      resolveReport: (id, res, by, now) => call(integ().resolveReport!(id, res, by, now)),
      view: (pid, now) => call(integ().view!(pid, now)),
      list: (st, now, limit) => call(integ().list!(st, now, limit)),
      ban: (pid, until, reason, by, now) => call(integ().ban!(pid, until, reason, by, now)),
      unban: (pid, reason, by, now) => call(integ().unban!(pid, reason, by, now)),
      release: (pid, reason, by, now) => call(integ().release!(pid, reason, by, now)),
    },
    deadLetters: makeDeadLetters(env),
  };
}

/** REQ-OPS-041: dead letters — index in OpsDO, truth (and retry/dismiss) in the owning objects. */
function makeDeadLetters(env: Env): DeadLetterService {
  const call = async <T>(p: Promise<Envelope<unknown>>) => unwrap(await p) as T;
  const ops = () => stub(env.OPS!, 'global');
  const registry: DeadLetterRegistry = {
    upsert: async (r) => { await call(ops().dlUpsert!(r)); },
    get: (s, sc, i) => call(ops().dlGet!(s, sc, i)),
    list: (q) => call(ops().dlList!(q)),
  };
  const lb = (seasonId: string) => stub(env.LEADERBOARD, `lb:${seasonId}`);
  const rollover = (kind: 'season' | 'team'): DeadLetterOwner => ({
    list: (scope) => call(lb(scope).dlList!(kind)),
    retry: (scope, id) => call(lb(scope).dlRetry!(kind, scope, id)),
    dismiss: async (scope, id, by, note, now) => { await call(lb(scope).dlDismiss!(kind, id, by, note, now)); },
  });
  const owners: Partial<Record<DeadLetterSource, DeadLetterOwner>> = {
    season: rollover('season'),
    team: rollover('team'),
    event: {
      list: (scope) => call(stub(env.EVENTS, `ev:${scope}`).dlList!()),
      retry: (scope, id) => call(stub(env.EVENTS, `ev:${scope}`).dlRetry!(scope, id)),
      dismiss: async (scope, id, by, note, now) => { await call(stub(env.EVENTS, `ev:${scope}`).dlDismiss!(id, by, note, now)); },
    },
    ...(env.TOURNAMENTS ? {
      tournament: {
        list: (scope: string) => call(stub(env.TOURNAMENTS!, `tour:${scope}`).dlList!()),
        retry: (scope: string, id: string) => call(stub(env.TOURNAMENTS!, `tour:${scope}`).dlRetry!(id)),
        dismiss: async (scope: string, id: string, by: string, note: string, now: number) => { await call(stub(env.TOURNAMENTS!, `tour:${scope}`).dlDismiss!(id, by, note, now)); },
      } satisfies DeadLetterOwner,
    } : {}),
    settlement: {
      list: (scope) => call(stub(env.RACE_ROOM, scope).dlList!()),
      retry: (scope, id) => call(stub(env.RACE_ROOM, scope).dlRetry!(id)),
      dismiss: async (scope, id, by, note, now) => { await call(stub(env.RACE_ROOM, scope).dlDismiss!(id, by, note, now)); },
    },
    ...(env.INTEGRITY ? {
      moderation: {
        list: () => call(stub(env.INTEGRITY!, 'global').dlList!()),
        retry: (_scope: string, id: string) => call(stub(env.INTEGRITY!, 'global').dlRetry!(id)),
        dismiss: async (_scope: string, id: string) => { await call(stub(env.INTEGRITY!, 'global').dlDismiss!(id)); },
      } satisfies DeadLetterOwner,
    } : {}),
  };
  return new DeadLetterService(registry, owners);
}

export function adminAuthConfig(env: Env): AdminAuthConfig {
  return {
    tokens: parseAdminTokens(env.ADMIN_TOKENS),
    legacyToken: env.ADMIN_TOKEN,
    access: env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD
      ? { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD, roles: JSON.parse(env.ACCESS_ROLES ?? '{}') as Record<string, AdminRole> }
      : undefined,
  };
}

/** QA r7 #8: spectator ticket rate per viewer (per isolate; the room itself allows one socket per player). */
const spectateLimiter = new RateLimiter({ read: SPECTATE_RATE, write: SPECTATE_RATE }, 'spectate');

export function makeContext(env: Env, cfg?: ResolvedConfig): AppContext {
  const master = cfg?.master ?? baseMaster;
  const dev = env.DEV_MODE === '1';
  const ops = makeOpsApi(env);
  const mm = () => stub(env.MATCHMAKER, 'ranked-jp');
  const call = async (p: Promise<Envelope<unknown>>) => unwrap(await p);
  const lb = (seasonId: string) => stub(env.LEADERBOARD, `lb:${seasonId}`);
  const adKeys = ssvKeys(env);
  const adUnits = parseAdUnits(env.ADS_AD_UNITS);
  const player = (uid: string): PlayerInvoker => {
    const s = stub(env.PLAYER, uid);
    return { invoke: (async (m: string, ...args: unknown[]) => call(s.invoke!(m, args))) as PlayerInvoker['invoke'] };
  };
  return {
    master,
    async authenticate(req) {
      const devUser = req.headers.get('x-dev-user');
      if (dev && devUser) return devUser;
      return verifyFirebaseIdToken(bearer(req), env.FIREBASE_PROJECT_ID);
    },
    player,
    match: {
      enqueue: (p, e: RaceEntry) => call(mm().enqueue!(p, e)),
      cancel: (p) => call(mm().cancel!(p)),
      status: (p) => call(mm().status!(p)),
      friendCreate: (p, e) => call(mm().friendCreate!(p, e)),
      friendJoin: (pass, p, e) => call(mm().friendJoin!(pass, p, e)),
      friendStart: (pass, p) => call(mm().friendStart!(pass, p)),
      tutorial: (p, e) => call(mm().tutorial!(p, e)),
      friendMember: async (pass, p) => (await call(mm().friendMember!(pass, p))) as boolean,
    },
    race: {
      websocket: (raceId, req) => (env.RACE_ROOM.get(env.RACE_ROOM.idFromName(raceId)) as unknown as { fetch(r: Request): Promise<Response> }).fetch(req),
      report: async (raceId, playerId) => (stub(env.RACE_ROOM, raceId) as unknown as { report(p: string): Promise<unknown> }).report(playerId),
      replay: async (raceId) => {
        const obj = await env.REPLAYS.get(`replays/${raceId}.json`);
        if (!obj) throw new AppError('NOT_FOUND');
        return obj.json();
      },
    },
    friends: makeFriendsService((uid) => player(uid), shardedDirectory(env.DIRECTORY)),
    stud: makeStudService(player, shardedStudDirectory(env.DIRECTORY), () => master),
    stable: makeStableService(player, shardedStableDirectory(env.DIRECTORY), () => master),
    invite: makeInviteService(player, shardedInviteDirectory(env.DIRECTORY), shardedDirectory(env.DIRECTORY), () => master), // REQ-INV-*
    teams: makeTeamsService(env, () => master, player),
    events: new EventsService(() => master, eventPlayersFrom(player), {
      enqueue: (eventId, p, e) => call(mm().eventEnqueue!(eventId, p, e)),
      cancel: (eventId, p) => call(mm().eventCancel!(eventId, p)),
    }, {
      board: async (eventId) => {
        const obj = await env.SNAPSHOTS.get(eventBoardKey(eventId));
        return obj ? obj.json() : { eventId, generatedAt: null, total: 0, entries: [] };
      },
      rankOf: async (eventId, p) => (await call(stub(env.EVENTS, `ev:${eventId}`).rankOf!(p))) as { rank: number; total: number; generatedAt: number | null } | null,
    }),
    spectate: new SpectateService({
      liveRaces: async () => (await call(mm().liveRaces!())) as never,
      liveRace: async (raceId) => (await call(mm().liveRace!(raceId))) as never,
      friendIds: friendIdsFrom(player),
      signTicket: (t) => signTicket(t, env.TICKET_SECRET),
      admit: (uid, now) => spectateLimiter.take(uid, 'read', now),
    }),
    ...(env.TOURNAMENTS ? { tournaments: new TournamentsService(() => master, tournamentBackend(env), tournamentPlayersFrom(player)) } : {}),
    leaderboard: {
      board: async (seasonId, board) => {
        const obj = await env.SNAPSHOTS.get(board === 'index' ? indexKey(seasonId) : boardKey(seasonId, board));
        if (!obj) return { seasonId, board, generatedAt: null, total: 0, entries: [] };
        return obj.json();
      },
      myRank: async (playerId, seasonId) => call(lb(seasonId).rankOf!(playerId)),
    },
    timeAttack: new TimeAttackService({
      player,
      verifier: new HttpVerifierClient(env.VERIFIER_URL, undefined, undefined, env.VERIFIER_TOKEN),
      ticketSecret: env.TICKET_SECRET,
      clock: () => Date.now(),
      activeRuleset: async () => (await activeConfig(env)).ruleset, // REQ-TA-009
      board: {
        upsert: async (e) => (await call(lb(e.seasonId).upsertTimeAttack!(e))) as boolean,
        rankOf: async (seasonId, trackId, pid) => (await call(lb(seasonId).taRankOf!(trackId, pid))) as { rank: number; total: number; generatedAt: number | null } | null,
        entries: async (seasonId, trackId, ids) => (await call(lb(seasonId).taEntriesFor!(seasonId, trackId, ids))) as TaEntry[],
        snapshot: async (seasonId, trackId) => {
          const obj = await env.SNAPSHOTS.get(boardKey(seasonId, taBoardName(trackId)));
          return obj ? ((await obj.json()) as TaBoardFile) : null;
        },
      },
      ghosts: {
        put: async (key, file) => { await env.REPLAYS.put(key, JSON.stringify(file), { httpMetadata: { contentType: 'application/json' } }); },
        get: async (key) => {
          const obj = await env.REPLAYS.get(key);
          return obj ? ((await obj.json()) as GhostFile) : null;
        },
      },
    }),
    paidBalance: () => (stub(env.ACCOUNTING, 'global') as unknown as { summary(): Promise<unknown> }).summary(),
    retainedRefund: (anonId, txId) => (stub(env.ACCOUNTING, 'global') as unknown as { retainedRefund(a: string, t: string, n: number): Promise<unknown | null> }).retainedRefund(anonId, txId, Date.now()),
    adminToken: env.ADMIN_TOKEN,
    parseStoreNotification: (platform, req) => parseStoreNotification(platform, req, storeSettingsFromEnv(env, master), accountingStoreIndex(env)),
    ...(ops ? { ops } : {}),
    authenticateAdmin: (req) => authenticateAdmin(req, adminAuthConfig(env)),
    ...(env.ASSET_CDN_BASE ? { assetCdnBase: env.ASSET_CDN_BASE } : {}),
    ...(adKeys ? { ads: { keys: adKeys, ...(adUnits ? { adUnits } : {}), admit: (key: string, now: number) => ssvLimiter.take(key, 'write', now) } } : {}),
    configInfo: async () => ({ versionId: cfg?.versionId ?? 'base', hash: cfg?.hash ?? 'base', rulesetVersion: cfg?.ruleset.rulesetVersion ?? '', activatedAt: cfg?.activatedAt ?? null }),
  };
}

export { devModeRefused } from './http/devMode.js';
/** R2Bucket → the minimal interface the retention sweep uses. */
const replayBucket = (b: R2Bucket): ReplayBucket => ({
  list: async (o) => {
    const r = await b.list({ prefix: o.prefix, limit: o.limit ?? 1000, include: ['customMetadata'], ...(o.cursor ? { cursor: o.cursor } : {}) });
    return { objects: r.objects.map((x) => ({ key: x.key, uploaded: x.uploaded, ...(x.customMetadata ? { customMetadata: x.customMetadata } : {}) })), truncated: r.truncated, ...(r.truncated ? { cursor: r.cursor } : {}) };
  },
  delete: (keys) => b.delete(keys),
});
/** The sweep's position lives next to the replays (outside the `replays/` prefix it lists). */
const sweepCursor = (b: R2Bucket): SweepCursorStore => ({
  get: async () => (await (await b.get(SWEEP_CURSOR_KEY))?.text()) || null,
  set: async (c) => { if (c === null) await b.delete(SWEEP_CURSOR_KEY); else await b.put(SWEEP_CURSOR_KEY, c); },
});

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    if (devModeRefused(req, env)) {
      console.error('DEV_MODE is set on a non-loopback host; refusing all requests');
      return Promise.resolve(Response.json({ error: 'DEV_MODE_REFUSED' }, { status: 500 }));
    }
    return activeConfig(env).then((cfg) => handle(req, {}, makeContext(env, cfg)));
  },
  /** Cron triggers (wrangler.toml [triggers]): leaderboards, season rollover, replay retention. */
  async scheduled(event: ScheduledController, env: Env) {
    const lb = (seasonId: string) => env.LEADERBOARD.get(env.LEADERBOARD.idFromName(`lb:${seasonId}`)) as unknown as {
      snapshot(s: string, now: number): Promise<Envelope<unknown>>; rolloverStep(s: string, now: number): Promise<Envelope<RolloverState>>;
    };
    const now = event.scheduledTime;
    const done = await runScheduled(event.cron, now, {
      snapshot: async (seasonId) => unwrap(await lb(seasonId).snapshot(seasonId, now)),
      rolloverStep: async (seasonId) => unwrap(await lb(seasonId).rolloverStep(seasonId, now)),
      sweepReplays: async (t) => sweepReplays(replayBucket(env.REPLAYS), t, Number(env.REPLAY_RETENTION_DAYS ?? (await activeConfig(env)).master.progression.replayRetentionDays), 20, sweepCursor(env.REPLAYS),
        (await activeConfig(env)).master.progression.replayHoldDays ?? DEFAULT_HOLD_POLICY),
      seasonReminder: (t) => broadcastSeasonReminder(env, t),
      teamRolloverStep: async (seasonId) => unwrap(await (stub(env.LEADERBOARD, `lb:${seasonId}`).teamRolloverStep!(seasonId, now))) as RolloverState,
      eventsStep: (t) => eventsStep(env, t),
      leagueStep: async (seasonId) => unwrap(await (stub(env.LEADERBOARD, `lb:${seasonId}`).leagueStep!(seasonId, now))) as { status: string },
      tournamentsStep: (t) => tournamentsStep(env, t),
      tournamentClosingStep: (t) => tournamentClosingStep(env, t),
      purgeRetained: async (t) => (env.ACCOUNTING.get(env.ACCOUNTING.idFromName('global')) as unknown as { purgeRetained(n: number): Promise<{ purged: number }> }).purgeRetained(t),
    });
    console.log('scheduled', event.cron, done.join(' '));
  },
} satisfies ExportedHandler<Env>;
