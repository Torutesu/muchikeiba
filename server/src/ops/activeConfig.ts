import type { Env } from '../env.js';
import { loadMaster } from '../domain/master.js';
import { unwrap, type Envelope } from '../do/rpc.js';
import { ConfigResolver, type ActiveConfigInfo, type ResolvedConfig } from './config.js';

/**
 * The remote config in effect (REQ-OPS-005). Every isolate (Worker, PlayerDO, MatchmakerDO…) caches it
 * for CACHE_MS and asks the OpsDO again only after that, or when a scheduled activation is due. The
 * bundle travels only when the caller does not know its hash yet. If the OpsDO cannot be reached the
 * last known config (or the built-in base) keeps serving: config delivery never takes the game down.
 */
export const CACHE_MS = 30_000;

const resolver = new ConfigResolver(loadMaster());
let cache: { value: ResolvedConfig; fetchedAt: number; nextChangeAt: number | null } | null = null;

type OpsRpc = { configActive(now: number, knownHash: string | null): Promise<Envelope<ActiveConfigInfo>> };

export async function activeConfig(env: Pick<Env, 'OPS'>, now = Date.now()): Promise<ResolvedConfig> {
  if (cache && now - cache.fetchedAt < CACHE_MS && (cache.nextChangeAt === null || now < cache.nextChangeAt)) return cache.value;
  if (!env.OPS) return resolver.baseConfig();
  try {
    const ops = env.OPS.get(env.OPS.idFromName('global')) as unknown as OpsRpc;
    let info = unwrap(await ops.configActive(now, cache?.value.hash ?? null));
    let value = resolver.resolve(info);
    if (!value) {
      info = unwrap(await ops.configActive(now, null)); // our cached hash was not the active one
      value = resolver.resolve(info) ?? resolver.baseConfig();
    }
    cache = { value, fetchedAt: now, nextChangeAt: info.nextChangeAt };
    return value;
  } catch (e) {
    console.error('remote config unavailable; serving last known', (e as Error).message);
    return cache?.value ?? resolver.baseConfig();
  }
}

/** Test hook. */
export function resetActiveConfigCache() { cache = null; }
