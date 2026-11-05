import type { Env } from './env.js';
import { eventPlayersFrom, handle, makeFriendsService, teamPlayersFrom, type AppContext, type PlayerInvoker, type RaceEntry } from './http/app.js';
import { bearer, verifyFirebaseIdToken } from './http/auth.js';
import { parseStoreNotification, storeSettingsFromEnv } from './http/stores.js';
import { accountingStoreIndex } from './do/storeIndex.js';
import { loadMaster } from './domain/master.js';
import { validateGacha } from './domain/gacha.js';
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
import { TeamsService, type TeamPort, type TeamView } from './domain/teamService.js';
import type { TeamSummary } from './domain/teams.js';
import { EventsService } from './domain/eventService.js';
import { eventBoardKey, eventCronPlan, validateEvents } from './domain/events.js';
import { cryptoRng } from './domain/rng.js';
import type { Master } from './domain/master.js';
import type { OpsApi } from './http/admin.js';
import { authenticateAdmin, parseAdminTokens, type AdminAuthConfig, type AdminRole } from './ops/admin.js';
import { activeConfig } from './ops/activeConfig.js';
import type { ResolvedConfig } from './ops/config.js';
import { shardedDirectory } from './do/directory.js';
import { boardKey, indexKey, type RolloverState } from './domain/leaderboard.js';
import { runScheduled } from './domain/scheduled.js';
import { sweepReplays, SWEEP_CURSOR_KEY, type ReplayBucket, type SweepCursorStore } from './domain/retention.js';
import { renderTemplate, seasonReminderFor } from './domain/push.js';
import { fcmFromEnv } from './push/fcm.js';
import { TimeAttackService } from './race/timeAttack.js';
import { HttpVerifierClient } from './domain/verifier.js';
import { taBoardName, type GhostFile, type TaBoardFile, type TaEntry } from './domain/timeAttack.js';
import { devModeRefused } from './http/devMode.js';

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
validateEvents(baseMaster, baseMaster.events); // REQ-EVENT-001

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
  };
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

export function makeContext(env: Env, cfg?: ResolvedConfig): AppContext {
  const master = cfg?.master ?? baseMaster;
  const dev = env.DEV_MODE === '1';
  const ops = makeOpsApi(env);
  const mm = () => stub(env.MATCHMAKER, 'ranked-jp');
  const call = async (p: Promise<Envelope<unknown>>) => unwrap(await p);
  const lb = (seasonId: string) => stub(env.LEADERBOARD, `lb:${seasonId}`);
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
    adminToken: env.ADMIN_TOKEN,
    parseStoreNotification: (platform, req) => parseStoreNotification(platform, req, storeSettingsFromEnv(env, master), accountingStoreIndex(env)),
    ...(ops ? { ops } : {}),
    authenticateAdmin: (req) => authenticateAdmin(req, adminAuthConfig(env)),
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
      sweepReplays: async (t) => sweepReplays(replayBucket(env.REPLAYS), t, Number(env.REPLAY_RETENTION_DAYS ?? (await activeConfig(env)).master.progression.replayRetentionDays), 20, sweepCursor(env.REPLAYS)),
      seasonReminder: (t) => broadcastSeasonReminder(env, t),
      teamRolloverStep: async (seasonId) => unwrap(await (stub(env.LEADERBOARD, `lb:${seasonId}`).teamRolloverStep!(seasonId, now))) as RolloverState,
      eventsStep: (t) => eventsStep(env, t),
    });
    console.log('scheduled', event.cron, done.join(' '));
  },
} satisfies ExportedHandler<Env>;
