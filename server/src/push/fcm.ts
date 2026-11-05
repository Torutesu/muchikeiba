/**
 * Firebase Cloud Messaging HTTP v1 sender (REQ-PUSH-001).
 * Auth: service-account JWT → OAuth token (google/serviceAuth.ts, scope firebase.messaging), cached.
 * Responses are classified so the outbox can prune dead tokens and retry transient failures.
 */
import { defaultFetch, GoogleOAuth, type Fetch, type ServiceAccount } from '../google/serviceAuth.js';
import type { PushMessage, SendKind } from '../domain/push.js';

export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

export interface SendOutcome { kind: SendKind; retryAfterMs?: number; error?: string }

export interface PushSender {
  send(token: string, msg: PushMessage): Promise<SendOutcome>;
  sendTopic(topic: string, msg: PushMessage): Promise<SendOutcome>;
}

interface FcmErrorBody { error?: { code?: number; status?: string; message?: string; details?: { '@type'?: string; errorCode?: string }[] } }

/** Maps an FCM v1 error response to what the outbox should do with that token. */
export function classifyFcmError(status: number, body: FcmErrorBody, retryAfterHeader: string | null): SendOutcome {
  const fcmCode = body.error?.details?.find((d) => d.errorCode)?.errorCode ?? '';
  const st = body.error?.status ?? '';
  const error = fcmCode || st || String(status);
  if (fcmCode === 'UNREGISTERED' || status === 404 || st === 'NOT_FOUND') return { kind: 'invalid_token', error };
  if (fcmCode === 'INVALID_ARGUMENT' || st === 'INVALID_ARGUMENT' || fcmCode === 'SENDER_ID_MISMATCH' || status === 403) return { kind: 'invalid_token', error };
  if (status === 429 || status >= 500 || status === 401 || fcmCode === 'QUOTA_EXCEEDED' || fcmCode === 'UNAVAILABLE' || fcmCode === 'INTERNAL') {
    const secs = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    return { kind: 'retry', error, ...(Number.isFinite(secs) && secs > 0 ? { retryAfterMs: secs * 1000 } : {}) };
  }
  return { kind: 'failed', error };
}

/** FCM v1 request body for one message (token or topic target). */
export function fcmPayload(target: { token: string } | { topic: string }, msg: PushMessage) {
  const ttl = Math.max(0, Math.floor(msg.ttlSec));
  return {
    message: {
      ...target,
      notification: { title: msg.title, body: msg.body },
      data: msg.data,
      android: { ttl: `${ttl}s`, priority: msg.timeSensitive ? 'high' : 'normal', notification: { channel_id: msg.data.category ?? 'default' } },
      apns: {
        headers: { 'apns-priority': msg.timeSensitive ? '10' : '5', 'apns-expiration': String(Math.floor(Date.now() / 1000) + ttl) },
        payload: { aps: { sound: 'default', ...(msg.timeSensitive ? { 'interruption-level': 'time-sensitive' } : {}) } },
      },
    },
  };
}

export class FcmSender implements PushSender {
  private readonly auth: GoogleOAuth;
  constructor(private readonly projectId: string, sa: ServiceAccount, private readonly f: Fetch = defaultFetch, now: () => number = Date.now) {
    this.auth = new GoogleOAuth(sa, { scope: FCM_SCOPE, errorPrefix: 'fcm' }, f, now);
  }

  send(token: string, msg: PushMessage) { return this.post({ token }, msg); }
  sendTopic(topic: string, msg: PushMessage) { return this.post({ topic }, msg); }

  private async post(target: { token: string } | { topic: string }, msg: PushMessage): Promise<SendOutcome> {
    let token: string;
    try {
      token = await this.auth.accessToken();
    } catch (e) {
      return { kind: 'retry', error: `oauth: ${(e as Error).message}` };
    }
    let res: Response;
    try {
      res = await this.f(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(fcmPayload(target, msg)),
      });
    } catch (e) {
      return { kind: 'retry', error: `network: ${(e as Error).message}` };
    }
    if (res.ok) return { kind: 'ok' };
    if (res.status === 401) this.auth.invalidate();
    let body: FcmErrorBody = {};
    try { body = (await res.json()) as FcmErrorBody; } catch { /* non-JSON error body */ }
    return classifyFcmError(res.status, body, res.headers.get('retry-after'));
  }
}

/** FCM is optional: without a project id and service account, pushes are queued and then dropped. */
export function fcmFromEnv(env: { FCM_PROJECT_ID?: string; FCM_SERVICE_ACCOUNT_JSON?: string; GOOGLE_SERVICE_ACCOUNT_JSON?: string }): FcmSender | null {
  const raw = env.FCM_SERVICE_ACCOUNT_JSON ?? env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  let sa: ServiceAccount;
  try { sa = JSON.parse(raw) as ServiceAccount; } catch { console.error('FCM service account JSON is invalid'); return null; }
  const project = env.FCM_PROJECT_ID ?? sa.project_id;
  return project ? new FcmSender(project, sa) : null;
}
