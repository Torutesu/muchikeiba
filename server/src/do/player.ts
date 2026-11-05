import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { loadMaster } from '../domain/master.js';
import { PlayerService } from '../domain/service.js';
import { cryptoRng } from '../domain/rng.js';
import { systemClock } from '../domain/time.js';
import type { PlayerMethod } from '../http/app.js';
import { makeVerifiers } from '../http/stores.js';
import { SqlPlayerRepo } from './sqlRepo.js';
import { wrap, type Envelope } from './rpc.js';

/** One player = one Durable Object (wallet, ledger, horses, gacha pity, purchases). */
export class PlayerDO extends DurableObject<Env> {
  private readonly svc: PlayerService;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.svc = new PlayerService(new SqlPlayerRepo(ctx.storage.sql), {
      master: loadMaster(), rng: cryptoRng, clock: systemClock, verifiers: makeVerifiers(env.DEV_MODE === '1'),
      onPaidBalance: (snap) => {
        const acc = env.ACCOUNTING.get(env.ACCOUNTING.idFromName('global')) as unknown as { record(s: typeof snap): Promise<void> };
        // Ordering is safe (seq-guarded); retry once so a transient failure does not leave a stale balance.
        ctx.waitUntil(acc.record(snap).catch(() => acc.record(snap)).catch((e) => console.error('paid balance record failed', snap.playerId, e)));
      },
    });
  }

  async invoke(method: PlayerMethod, args: unknown[]): Promise<Envelope<unknown>> {
    return wrap(() => (this.svc[method] as (...a: unknown[]) => unknown)(...args));
  }
}
