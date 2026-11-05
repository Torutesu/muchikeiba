import type { Env } from './env.js';
import { handle, type AppContext, type PlayerInvoker, type RaceEntry } from './http/app.js';
import { bearer, verifyFirebaseIdToken } from './http/auth.js';
import { parseStoreNotification } from './http/stores.js';
import { loadMaster } from './domain/master.js';
import { validateGacha } from './domain/gacha.js';
import { unwrap, type Envelope } from './do/rpc.js';
import { AppError } from './domain/errors.js';

export { PlayerDO } from './do/player.js';
export { RaceRoomDO } from './do/raceRoom.js';
export { MatchmakerDO } from './do/matchmaker.js';
export { AccountingDO } from './do/accounting.js';

const master = loadMaster();
validateGacha(master); // fail fast on a broken gacha/master definition (REQ-GACHA-003/008)

type Rpc = Record<string, (...a: unknown[]) => Promise<Envelope<unknown>>>;
const stub = (ns: DurableObjectNamespace, name: string) => ns.get(ns.idFromName(name)) as unknown as Rpc;

export function makeContext(env: Env): AppContext {
  const dev = env.DEV_MODE === '1';
  const mm = () => stub(env.MATCHMAKER, 'ranked-jp');
  const call = async (p: Promise<Envelope<unknown>>) => unwrap(await p);
  return {
    master,
    async authenticate(req) {
      const devUser = req.headers.get('x-dev-user');
      if (dev && devUser) return devUser;
      return verifyFirebaseIdToken(bearer(req), env.FIREBASE_PROJECT_ID);
    },
    player(uid): PlayerInvoker {
      const s = stub(env.PLAYER, uid);
      return { invoke: (async (m: string, ...args: unknown[]) => call(s.invoke!(m, args))) as PlayerInvoker['invoke'] };
    },
    match: {
      enqueue: (p, e: RaceEntry) => call(mm().enqueue!(p, e)),
      cancel: (p) => call(mm().cancel!(p)),
      status: (p) => call(mm().status!(p)),
      friendCreate: (p, e) => call(mm().friendCreate!(p, e)),
      friendJoin: (pass, p, e) => call(mm().friendJoin!(pass, p, e)),
      friendStart: (pass, p) => call(mm().friendStart!(pass, p)),
      tutorial: (p, e) => call(mm().tutorial!(p, e)),
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
    paidBalance: () => (stub(env.ACCOUNTING, 'global') as unknown as { summary(): Promise<unknown> }).summary(),
    adminToken: env.ADMIN_TOKEN,
    parseStoreNotification: (platform, req) => parseStoreNotification(platform, req, dev),
  };
}

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, {}, makeContext(env));
  },
} satisfies ExportedHandler<Env>;
