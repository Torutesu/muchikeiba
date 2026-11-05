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
        ctx.waitUntil(acc.record(snap));
      },
    });
  }

  async invoke(method: PlayerMethod, args: unknown[]): Promise<Envelope<unknown>> {
    return wrap(() => (this.svc[method] as (...a: unknown[]) => unknown)(...args));
  }
}
