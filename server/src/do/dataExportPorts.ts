import type { Env } from '../env.js';
import type { Master } from '../domain/master.js';
import type { PlayerService } from '../domain/service.js';
import type { DataExportJobPorts, ExportStore } from '../domain/dataExportService.js';
import type { PlayerReportMade } from '../domain/dataExport.js';
import { shardedDirectory } from './directory.js';
import { unwrap, type Envelope } from './rpc.js';
import { kpiEventSourceFromEnv } from '../push/kpiExport.js';

/** REQ-DEX-009: the private R2 bucket (REPLAYS) under `private/data-export/` — never the public SNAPSHOTS bucket. */
export function r2ExportStore(bucket: R2Bucket): ExportStore {
  return {
    put: async (key, body, contentType) => { await bucket.put(key, body, { httpMetadata: { contentType } }); },
    get: async (key) => { const o = await bucket.get(key); return o ? o.body : null; },
    delete: async (keys) => { for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000)); },
  };
}

/**
 * REQ-DEX-*: the export job's ports in production. The player's own state through `svc` (this object); the directory,
 * the integrity queue and Analytics Engine over RPC / HTTP, each optional for the document.
 */
export function dataExportPortsFromEnv(env: Env, svc: PlayerService, master: () => Master, store: ExportStore): DataExportJobPorts {
  const kpiEvents = kpiEventSourceFromEnv(env);
  return {
    master,
    take: (uid) => svc.dataExportTake(uid),
    collect: (uid) => svc.dataExportCollect(uid),
    profiles: async (ids) => (await shardedDirectory(env.DIRECTORY).profiles(ids)).filter((p) => !(p as { banned?: boolean }).banned),
    ...(env.INTEGRITY ? {
      reportsMade: async (uid: string) => {
        const s = env.INTEGRITY!.get(env.INTEGRITY!.idFromName('global')) as unknown as { reportsBy(u: string): Promise<Envelope<{ raceId: string; at: number; status: string }[]>> };
        return unwrap(await s.reportsBy(uid));
      },
      // §47 (Round 18 integration): the player reports this player made, from the same singleton
      playerReportsMade: async (uid: string) => {
        const s = env.INTEGRITY!.get(env.INTEGRITY!.idFromName('global')) as unknown as { prMadeBy(u: string): Promise<Envelope<PlayerReportMade[]>> };
        return unwrap(await s.prMadeBy(uid));
      },
    } : {}),
    ...(kpiEvents ? { kpiEvents } : {}),
    store,
    ready: (uid, rid, info) => svc.dataExportReady(uid, rid, info),
    failed: (uid, rid, reason) => svc.dataExportFailed(uid, rid, reason),
  };
}
