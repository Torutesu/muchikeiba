/**
 * Writes KPI records to Workers Analytics Engine (REQ-KPI-002). writeDataPoint is fire-and-forget and
 * never blocks the request; without the binding or the salt nothing is written (and nothing leaks).
 */
import { hashPlayerId, toDataPoint, type KpiRecord } from '../domain/kpi.js';

export interface AnalyticsSink { writeDataPoint(p: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void }

export function makeKpiWriter(dataset: AnalyticsSink | undefined, salt: string | undefined) {
  if (!dataset || !salt) return null;
  return async (playerId: string, records: KpiRecord[]) => {
    const hashed = await hashPlayerId(salt, playerId);
    for (const r of records) {
      try {
        dataset.writeDataPoint(toDataPoint(r, hashed));
      } catch (e) {
        console.error('analytics write failed', r.name, e);
      }
    }
  };
}
