import type { Env } from '../env.js';
import type { StoreTxIndex } from '../stores/binding.js';

/** StoreTxIndex backed by the global AccountingDO (one SQLite table; purchases are low volume). */
export function accountingStoreIndex(env: Env): StoreTxIndex {
  const acc = () => env.ACCOUNTING.get(env.ACCOUNTING.idFromName('global')) as unknown as {
    claimStoreKey(key: string, playerId: string): Promise<string>;
    lookupStoreKey(key: string): Promise<string | null>;
  };
  return { claim: (k, p) => acc().claimStoreKey(k, p), lookup: (k) => acc().lookupStoreKey(k) };
}
