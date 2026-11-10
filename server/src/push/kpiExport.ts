/**
 * REQ-DEX-007 (§51): the KPI rows tied to one player, for their data export. Rows are stored in Workers Analytics
 * Engine under a salted hash of the player id (REQ-KPI-005), which is still personal data for us (we hold the salt).
 * They are read back through the Analytics Engine SQL API (the dataset keeps about 90 days). Optional: without
 * `KPI_SQL_ACCOUNT_ID` (var) and `KPI_SQL_TOKEN` (secret, Account Analytics read only) the export says
 * "analytics events: not available" instead.
 */
import type { Env } from '../env.js';
import { hashPlayerId } from '../domain/kpi.js';

export const KPI_EXPORT_WINDOW_DAYS = 90;
export const KPI_EXPORT_MAX_ROWS = 10_000;

/** The SQL (the hashed id is 16 hex chars, checked before it is put in the query). */
export function kpiExportQuery(hashed: string, dataset = 'muchi_kpi'): string {
  if (!/^[0-9a-f]{16}$/.test(hashed)) throw new Error('bad analytics id');
  return `SELECT timestamp, blob1 AS event, blob11 AS source, blob3 AS platform, blob4 AS appVersion, blob6 AS eventDay, blob8 AS s1, blob9 AS s2, blob10 AS s3, `
    + `double1 AS amountYen, double2 AS paidCoins, double3 AS freeCoins, double4 AS place, double5 AS count, double6 AS durationMs, double8 AS isFirst, double9 AS value `
    + `FROM ${dataset} WHERE blob2 = '${hashed}' AND timestamp > NOW() - INTERVAL '${KPI_EXPORT_WINDOW_DAYS}' DAY ORDER BY timestamp LIMIT ${KPI_EXPORT_MAX_ROWS} FORMAT JSON`;
}

export function kpiEventSourceFromEnv(env: Env, fetcher: typeof fetch = fetch) {
  const account = env.KPI_SQL_ACCOUNT_ID, token = env.KPI_SQL_TOKEN, salt = env.KPI_SALT;
  if (!account || !token || !salt) return undefined;
  return async (uid: string) => {
    const q = kpiExportQuery(await hashPlayerId(salt, uid));
    const res = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/analytics_engine/sql`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' }, body: q,
    });
    if (!res.ok) throw new Error(`analytics sql ${res.status}`);
    const j = (await res.json()) as { data?: Record<string, unknown>[] };
    return { rows: j.data ?? [], windowDays: KPI_EXPORT_WINDOW_DAYS };
  };
}
