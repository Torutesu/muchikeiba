import type { Env } from '../env.js';
import type { DeletionPorts, RetainedRecord } from '../domain/accountDeletion.js';
import type { PlayerService } from '../domain/service.js';
import type { PlayerInvoker, PlayerMethod } from '../http/app.js';
import { pastSeasons } from '../domain/scheduled.js';
import { jstMonthKey } from '../domain/time.js';
import type { TournamentSummary } from '../domain/tournaments.js';
import { forgetInDirectory, shardedInviteDirectory, shardedStableDirectory } from './directory.js';
import { stableDeletionPort } from '../domain/stable.js';
import { makeStableService } from '../http/stablePorts.js';
import { loadMaster } from '../domain/master.js';
import { unwrap, type Envelope } from './rpc.js';
import { wipePlayerStorage } from './sqlRepo.js';

type Rpc = Record<string, (...a: unknown[]) => Promise<Envelope<unknown>>>;
const stub = (ns: DurableObjectNamespace, name: string) => ns.get(ns.idFromName(name)) as unknown as Rpc;

/**
 * REQ-UXS-040: the account deletion's ports in production. The deleting player's own state is reached through
 * `svc` directly (this object), never through its own stub; other players, teams, boards and tournaments over RPC.
 */
export function deletionPortsFromEnv(env: Env, ctx: DurableObjectState, svc: PlayerService): DeletionPorts {
  const other = (uid: string, m: PlayerMethod, ...args: unknown[]) => {
    const s = env.PLAYER.get(env.PLAYER.idFromName(uid)) as unknown as { invoke(m: PlayerMethod, a: unknown[]): Promise<Envelope<unknown>> };
    return s.invoke(m, [uid, ...args]).then(unwrap);
  };
  const call = async (p: Promise<Envelope<unknown>>) => unwrap(await p);
  // マイ厩舎 (REQ-STABLE-*): the same StableService the HTTP routes use; removeStable only touches the directory
  const invoker = (uid: string) => ({ invoke: ((m: PlayerMethod, ...args: unknown[]) => other(uid, m, ...args.slice(1))) as PlayerInvoker['invoke'] });
  const stables = makeStableService(invoker, shardedStableDirectory(env.DIRECTORY), loadMaster);
  return {
    start: async (uid) => { await svc.deletionStart(uid); },
    snapshot: (uid) => svc.deletionSnapshot(uid),
    markStep: async (uid, step) => { await svc.deletionMarkStep(uid, step); },
    friends: {
      removeFriend: (o, uid) => other(o, 'friendRemove', uid),
      dropOutgoing: (from, uid) => other(from, 'friendCancel', uid),
      dropIncoming: (to, uid) => other(to, 'friendDecline', uid),
    },
    invites: {
      forfeitOwn: (uid) => svc.inviteForfeit(uid),
      retireCode: (uid) => shardedInviteDirectory(env.DIRECTORY).retire(uid),
      anonymizeInstall: (h) => shardedInviteDirectory(env.DIRECTORY).anonymizeInstall(h),
      forgetInvitee: (inviter, uid) => other(inviter, 'inviteForgetInvitee', uid),
      forgetInviter: (invitee, uid) => other(invitee, 'inviteForgetInviter', uid),
    },
    team: {
      members: async (teamId, uid) => ((await call(stub(env.TEAMS, teamId).view!(uid))) as { members: { playerId: string; role: string; joinedAt: number }[] }).members,
      leave: (teamId, uid) => call(stub(env.TEAMS, teamId).leave!(uid)),
      transfer: (teamId, uid, to) => call(stub(env.TEAMS, teamId).transfer!(uid, to)),
      dropRequest: (teamId, uid) => call(stub(env.TEAMS, teamId).dropRequest!(uid)),
      forgetFeed: (teamId, uid) => call(stub(env.TEAMS, teamId).feedForget!(uid)),
    },
    directory: { forget: (uid) => forgetInDirectory(env.DIRECTORY, uid) },
    // layout and like records in this object first, then the visitors' copy (REQ-UXS-040 × REQ-STABLE-003)
    stable: stableDeletionPort((uid) => svc.stableForget(uid), stables),
    leaderboards: {
      forget: async (uid, now) => {
        const current = jstMonthKey(now);
        for (const season of [current, ...pastSeasons(now)]) await call(stub(env.LEADERBOARD, `lb:${season}`).forgetPlayer!(season, uid, season === current, now));
      },
      deleteGhosts: async (keys) => { await env.REPLAYS.delete(keys); },
    },
    events: { forget: async (eventId, uid) => { await call(stub(env.EVENTS, `ev:${eventId}`).forget!(uid)); } },
    ...(env.TOURNAMENTS ? {
      tournaments: {
        forget: async (uid: string, now: number) => {
          const list = (await call(stub(env.TOURNAMENTS!, 'index').indexList!())) as TournamentSummary[];
          for (const t of list) if (t.status !== 'cancelled') await call(stub(env.TOURNAMENTS!, `tour:${t.id}`).forgetPlayer!(uid, now));
        },
      },
    } : {}),
    finalize: async (uid) => {
      const r = await svc.deletionFinalize(uid);
      // the state keeps only the recent ledger; the full audit trail lives in this object's ledger table
      const rows = ctx.storage.sql.exec<{ seq: number; at: number; kind: string; currency: string; delta: number; balance_after: number; reason: string; ref: string }>('SELECT * FROM ledger ORDER BY seq').toArray();
      if (rows.length > r.ledger.length) {
        r.ledger = rows.map((x) => ({ seq: x.seq, at: x.at, kind: x.kind as RetainedRecord['ledger'][number]['kind'], currency: x.currency as 'paid' | 'free', delta: x.delta, balanceAfter: x.balance_after, reason: x.reason, ref: x.ref }));
      }
      return r;
    },
    retain: async (uid, record) => {
      const acc = env.ACCOUNTING.get(env.ACCOUNTING.idFromName('global')) as unknown as { retainDeleted(p: string, r: RetainedRecord): Promise<unknown> };
      await acc.retainDeleted(uid, record);
    },
    wipe: async (uid) => { await wipePlayerStorage(ctx.storage, uid); },
  };
}
