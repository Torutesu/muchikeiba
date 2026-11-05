/**
 * Push delivery loop, run from the player's Durable Object alarm (REQ-PUSH-005).
 *
 * Why an alarm and not Cloudflare Queues: the outbox already lives in the player's own storage, the alarm
 * is durable across eviction and deploys, retries/backoff are just a later alarm, and it needs no extra
 * paid binding. Request handlers only append to the outbox and set the alarm — they never wait on FCM.
 */
import type { DeliveryOutcome, DueDelivery } from '../domain/push.js';
import type { PushSender } from './fcm.js';

export interface PushPorts {
  take(playerId: string): Promise<{ due: DueDelivery[]; expired: number }>;
  settle(playerId: string, outcomes: DeliveryOutcome[]): Promise<{ sent: number; pruned: number; retried: number; dropped: number; pending: number; nextAt: number | null }>;
}

export async function deliverDuePushes(ports: PushPorts, playerId: string, sender: PushSender | null) {
  const { due, expired } = await ports.take(playerId);
  const outcomes: DeliveryOutcome[] = [];
  for (const d of due) {
    const results = [];
    for (const token of d.tokens) {
      if (!sender) { results.push({ token, kind: 'failed' as const }); continue; }
      const r = await sender.send(token, d.message);
      results.push({ token, kind: r.kind, ...(r.retryAfterMs !== undefined ? { retryAfterMs: r.retryAfterMs } : {}) });
    }
    outcomes.push({ id: d.id, results });
  }
  const settled = await ports.settle(playerId, outcomes);
  return { ...settled, expired, attempted: due.length };
}
