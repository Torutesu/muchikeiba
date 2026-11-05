import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { loadMaster } from '../domain/master.js';
import { PlayerService } from '../domain/service.js';
import { cryptoRng } from '../domain/rng.js';
import { systemClock } from '../domain/time.js';
import type { PlayerMethod } from '../http/app.js';
import { makeVerifiers, storeSettingsFromEnv } from '../http/stores.js';
import { accountingStoreIndex } from './storeIndex.js';
import { SqlPlayerRepo } from './sqlRepo.js';
import { wrap, type Envelope } from './rpc.js';
import { activeConfig } from '../ops/activeConfig.js';
import { shardedDirectory } from './directory.js';

/** One player = one Durable Object (wallet, ledger, horses, gacha pity, purchases). */
export class PlayerDO extends DurableObject<Env> {
  private readonly svc: PlayerService;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const master = loadMaster();
    this.svc = new PlayerService(new SqlPlayerRepo(ctx.storage.sql), {
      master, rng: cryptoRng, clock: systemClock, verifiers: makeVerifiers(storeSettingsFromEnv(env, master)),
      storeIndex: accountingStoreIndex(env),
      onPaidBalance: (snap) => {
        const acc = env.ACCOUNTING.get(env.ACCOUNTING.idFromName('global')) as unknown as { record(s: typeof snap): Promise<void> };
        // Ordering is safe (seq-guarded); retry once so a transient failure does not leave a stale balance.
        ctx.waitUntil(acc.record(snap).catch(() => acc.record(snap)).catch((e) => console.error('paid balance record failed', snap.playerId, e)));
      },
      onSeasonEntry: (e) => {
        const lb = env.LEADERBOARD.get(env.LEADERBOARD.idFromName(`lb:${e.seasonId}`)) as unknown as { upsert(x: typeof e): Promise<unknown> };
        ctx.waitUntil(lb.upsert(e));
      },
      onProfile: (p) => {
        ctx.waitUntil(shardedDirectory(env.DIRECTORY).putProfile(p));
      },
    });
  }

  async invoke(method: PlayerMethod, args: unknown[]): Promise<Envelope<unknown>> {
    return wrap(async () => {
      this.svc.setMaster((await activeConfig(this.env)).master); // REQ-OPS-005: gacha schedule, rewards… follow remote config
      return (this.svc[method] as (...a: unknown[]) => unknown)(...args);
    });
  }
}
