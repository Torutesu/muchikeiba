import type { Env } from './env.js';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker, type RaceEntry } from './http/app.js';
import { bearer, verifyFirebaseIdToken } from './http/auth.js';
import { parseStoreNotification, storeSettingsFromEnv } from './http/stores.js';
import { accountingStoreIndex } from './do/storeIndex.js';
import { loadMaster } from './domain/master.js';
import { validateGacha } from './domain/gacha.js';
import { unwrap, type Envelope } from './do/rpc.js';
import { AppError } from './domain/errors.js';

export { PlayerDO } from './do/player.js';
export { RaceRoomDO } from './do/raceRoom.js';
export { MatchmakerDO } from './do/matchmaker.js';
export { AccountingDO } from './do/accounting.js';
export { LeaderboardDO } from './do/leaderboard.js';
export { DirectoryDO } from './do/directory.js';
import { shardedDirectory } from './do/directory.js';
import { boardKey, indexKey, type RolloverState } from './domain/leaderboard.js';
import { runScheduled } from './domain/scheduled.js';
import { sweepReplays, type ReplayBucket } from './domain/retention.js';
import { renderTemplate, seasonReminderFor } from './domain/push.js';
import { fcmFromEnv } from './push/fcm.js';

/** REQ-PUSH-006: one FCM topic send reaches every opted-in device (no per-player fan-out). */
async function broadcastSeasonReminder(env: Env, now: number): Promise<string | null> {
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

const master = loadMaster();
validateGacha(master); // fail fast on a broken gacha/master definition (REQ-GACHA-003/008)

type Rpc = Record<string, (...a: unknown[]) => Promise<Envelope<unknown>>>;
const stub = (ns: DurableObjectNamespace, name: string) => ns.get(ns.idFromName(name)) as unknown as Rpc;

export function makeContext(env: Env): AppContext {
  const dev = env.DEV_MODE === '1';
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
    leaderboard: {
      board: async (seasonId, board) => {
        const obj = await env.SNAPSHOTS.get(board === 'index' ? indexKey(seasonId) : boardKey(seasonId, board));
        if (!obj) return { seasonId, board, generatedAt: null, total: 0, entries: [] };
        return obj.json();
      },
      myRank: async (playerId, seasonId) => call(lb(seasonId).rankOf!(playerId)),
    },
    paidBalance: () => (stub(env.ACCOUNTING, 'global') as unknown as { summary(): Promise<unknown> }).summary(),
    adminToken: env.ADMIN_TOKEN,
    parseStoreNotification: (platform, req) => parseStoreNotification(platform, req, storeSettingsFromEnv(env, master), accountingStoreIndex(env)),
  };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * DEV_MODE (x-dev-user impersonation + fake store) only ever works on loopback. If it leaks into a
 * deployed environment, every request fails closed instead of letting anyone mint coins (bug review #12).
 */
export function devModeRefused(req: Request, env: Pick<Env, 'DEV_MODE'>): boolean {
  return env.DEV_MODE === '1' && !LOOPBACK.has(new URL(req.url).hostname);
}
/** R2Bucket → the minimal interface the retention sweep uses. */
const replayBucket = (b: R2Bucket): ReplayBucket => ({
  list: async (o) => {
    const r = await b.list({ prefix: o.prefix, limit: o.limit ?? 1000, include: ['customMetadata'], ...(o.cursor ? { cursor: o.cursor } : {}) });
    return { objects: r.objects.map((x) => ({ key: x.key, uploaded: x.uploaded, ...(x.customMetadata ? { customMetadata: x.customMetadata } : {}) })), truncated: r.truncated, ...(r.truncated ? { cursor: r.cursor } : {}) };
  },
  delete: (keys) => b.delete(keys),
});

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    if (devModeRefused(req, env)) {
      console.error('DEV_MODE is set on a non-loopback host; refusing all requests');
      return Promise.resolve(Response.json({ error: 'DEV_MODE_REFUSED' }, { status: 500 }));
    }
    return handle(req, {}, makeContext(env));
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
      sweepReplays: (t) => sweepReplays(replayBucket(env.REPLAYS), t, Number(env.REPLAY_RETENTION_DAYS ?? master.progression.replayRetentionDays)),
      seasonReminder: (t) => broadcastSeasonReminder(env, t),
    });
    console.log('scheduled', event.cron, done.join(' '));
  },
} satisfies ExportedHandler<Env>;
