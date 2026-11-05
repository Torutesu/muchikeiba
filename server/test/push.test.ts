import { describe, expect, it } from 'vitest';
import { decodeJwt, exportPKCS8, generateKeyPair } from 'jose';
import { m } from './helpers.js';
import { newPlayer } from '../src/domain/player.js';
import {
  enqueuePush, inQuietHours, nextPushWake, pushPrefsView, quietHoursEnd, registerDevice, seasonReminderFor, setPushPrefs,
  settlePushes, takeDuePushes, unregisterDevice, type PushMessage,
} from '../src/domain/push.js';
import { classifyFcmError, fcmPayload, FcmSender, FCM_SCOPE, type PushSender, type SendOutcome } from '../src/push/fcm.js';
import { deliverDuePushes } from '../src/push/dispatch.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { FriendsService, MemoryDirectory } from '../src/domain/friends.js';
import { makeFriendsService } from '../src/http/app.js';
import type { PlayerInvoker } from '../src/http/app.js';
import { runScheduled, CRONS } from '../src/domain/scheduled.js';
import { publicProfile } from '../src/domain/stats.js';

const H = 3_600_000;
/** 2026-11-05 12:00 JST */
const NOON = Date.UTC(2026, 10, 5, 3);
/** 2026-11-05 23:30 JST */
const NIGHT = Date.UTC(2026, 10, 5, 14, 30);

function player(now = NOON) {
  const s = newPlayer('p1', now, '2026-11');
  registerDevice(m, s, 'tok-aaaaaaaa', 'ios', now);
  return s;
}

describe('quiet hours (JST)', () => {
  const q = { startHour: 22, endHour: 8 };
  it('wraps midnight', () => {
    expect(inQuietHours(q, NOON)).toBe(false);
    expect(inQuietHours(q, NIGHT)).toBe(true);
    expect(inQuietHours(q, Date.UTC(2026, 10, 5, 22, 59))).toBe(true); // 07:59 JST
    expect(inQuietHours(q, Date.UTC(2026, 10, 5, 23, 0))).toBe(false); // 08:00 JST
    expect(inQuietHours({ startHour: 1, endHour: 5 }, Date.UTC(2026, 10, 5, 17))).toBe(true); // 02:00 JST
    expect(inQuietHours(null, NIGHT)).toBe(false);
  });
  it('ends at the next endHour:00 JST', () => {
    expect(quietHoursEnd(q, NIGHT)).toBe(Date.UTC(2026, 10, 5, 23)); // 2026-11-06 08:00 JST
  });
});

describe('devices and preferences', () => {
  it('keeps the most recently seen devices up to the limit', () => {
    const s = newPlayer('p', NOON, '2026-11');
    for (let i = 0; i < m.push.maxDevices + 2; i++) registerDevice(m, s, `token-${i}-xxxx`, 'android', NOON + i);
    expect(s.push!.devices.map((d) => d.token)).toHaveLength(m.push.maxDevices);
    expect(s.push!.devices.some((d) => d.token === 'token-0-xxxx')).toBe(false);
    registerDevice(m, s, `token-${m.push.maxDevices + 1}-xxxx`, 'ios', NOON + 100); // re-register updates in place
    expect(s.push!.devices).toHaveLength(m.push.maxDevices);
    expect(unregisterDevice(m, s, 'token-3-xxxx').removed).toBe(1);
  });
  it('rejects junk tokens and bad quiet hours', () => {
    const s = newPlayer('p', NOON, '2026-11');
    expect(() => registerDevice(m, s, 'x', 'ios', NOON)).toThrow(/BAD_REQUEST|bad device token/);
    expect(() => setPushPrefs(m, s, { quietHours: { startHour: 25, endHour: 3 } })).toThrow();
  });
  it('lists FCM topics to (un)subscribe from category preferences', () => {
    const s = player();
    expect(pushPrefsView(m, s).topics.subscribe).toContain('season_ja');
    const v = setPushPrefs(m, s, { categories: { season: false } });
    expect(v.topics.unsubscribe).toContain('season_ja');
    expect(v.categories.season).toBe(false);
  });
});

describe('enqueue rules (REQ-PUSH-003/004)', () => {
  it('respects category opt-out and needs a device', () => {
    const s = player();
    setPushPrefs(m, s, { categories: { friends: false } });
    expect(enqueuePush(m, s, 'friend_request', { name: 'A' }, NOON)).toEqual({ status: 'skipped', reason: 'category_off' });
    const bare = newPlayer('p2', NOON, '2026-11');
    expect(enqueuePush(m, bare, 'friend_request', { name: 'A' }, NOON)).toEqual({ status: 'skipped', reason: 'no_devices' });
    expect(enqueuePush(m, s, 'nope', {}, NOON)).toEqual({ status: 'skipped', reason: 'unknown_template' });
  });
  it('drops time-sensitive and defers normal messages during quiet hours', () => {
    const s = player(NIGHT);
    expect(enqueuePush(m, s, 'room_invite', { name: 'A' }, NIGHT)).toEqual({ status: 'skipped', reason: 'quiet_hours' });
    const r = enqueuePush(m, s, 'friend_request', { name: 'A' }, NIGHT);
    expect(r).toMatchObject({ status: 'queued', notBefore: Date.UTC(2026, 10, 5, 23) });
    expect(nextPushWake(s)).toBe(Date.UTC(2026, 10, 5, 23));
    expect(takeDuePushes(m, s, NIGHT).due).toHaveLength(0);
    expect(takeDuePushes(m, s, Date.UTC(2026, 10, 5, 23)).due).toHaveLength(1);
  });
  it('caps messages per JST day', () => {
    const s = player();
    const results = Array.from({ length: m.push.defaults.dailyCap + 2 }, (_, i) => enqueuePush(m, s, 'friend_request', { name: `N${i}` }, NOON + i));
    expect(results.filter((r) => r.status === 'queued')).toHaveLength(m.push.defaults.dailyCap);
    expect(results.at(-1)).toEqual({ status: 'skipped', reason: 'daily_cap' });
    expect(enqueuePush(m, s, 'friend_request', { name: 'X' }, NOON + 24 * H).status).toBe('queued'); // next day resets
  });
  it('renders Japanese templates with variables', () => {
    const s = player();
    enqueuePush(m, s, 'friend_request', { name: 'シンセイ' }, NOON);
    const d = takeDuePushes(m, s, NOON).due[0]!;
    expect(d.message.body).toBe('シンセイさんからフレンド申請が届きました');
    expect(d.message.data).toMatchObject({ templateId: 'friend_request', category: 'friends', name: 'シンセイ' });
    expect(d.tokens).toEqual(['tok-aaaaaaaa']);
  });
});

describe('settle: prune, retry with backoff, give up (REQ-PUSH-005)', () => {
  it('prunes UNREGISTERED tokens and drops the delivered item', () => {
    const s = player();
    registerDevice(m, s, 'tok-bbbbbbbb', 'android', NOON);
    enqueuePush(m, s, 'friend_request', { name: 'A' }, NOON);
    const d = takeDuePushes(m, s, NOON).due[0]!;
    const r = settlePushes(m, s, [{ id: d.id, results: [{ token: 'tok-aaaaaaaa', kind: 'ok' }, { token: 'tok-bbbbbbbb', kind: 'invalid_token' }] }], NOON);
    expect(r).toMatchObject({ sent: 1, pruned: 1, pending: 0 });
    expect(s.push!.devices.map((x) => x.token)).toEqual(['tok-aaaaaaaa']);
  });
  it('retries only the failed tokens with growing backoff, then gives up', () => {
    const s = player();
    registerDevice(m, s, 'tok-bbbbbbbb', 'android', NOON);
    enqueuePush(m, s, 'friend_request', { name: 'A' }, NOON);
    let t = NOON;
    const d0 = takeDuePushes(m, s, t).due[0]!;
    settlePushes(m, s, [{ id: d0.id, results: [{ token: 'tok-aaaaaaaa', kind: 'ok' }, { token: 'tok-bbbbbbbb', kind: 'retry' }] }], t);
    expect(s.push!.outbox[0]).toMatchObject({ attempts: 1, tokens: ['tok-bbbbbbbb'], notBefore: t + m.push.retry.backoffMs[0]! });
    // Retry-After longer than the backoff wins
    t = s.push!.outbox[0]!.notBefore;
    const d1 = takeDuePushes(m, s, t).due[0]!;
    expect(d1.tokens).toEqual(['tok-bbbbbbbb']);
    settlePushes(m, s, [{ id: d1.id, results: [{ token: 'tok-bbbbbbbb', kind: 'retry', retryAfterMs: 999_000 }] }], t);
    expect(s.push!.outbox[0]!.notBefore).toBe(t + 999_000);
    for (let i = 0; i < m.push.retry.maxAttempts; i++) {
      t = s.push!.outbox[0]?.notBefore ?? t;
      const d = takeDuePushes(m, s, t).due[0];
      if (!d) break;
      settlePushes(m, s, [{ id: d.id, results: [{ token: 'tok-bbbbbbbb', kind: 'retry' }] }], t);
    }
    expect(s.push!.outbox).toHaveLength(0); // dropped after maxAttempts
  });
  it('expires stale items (TTL)', () => {
    const s = player();
    enqueuePush(m, s, 'friend_request', { name: 'A' }, NOON);
    expect(takeDuePushes(m, s, NOON + m.push.templates.friend_request!.ttlSec * 1000 + 1)).toEqual({ due: [], expired: 1, undeliverable: 0 });
  });
});

describe('FCM HTTP v1 sender', () => {
  const msg: PushMessage = { title: 't', body: 'b', data: { templateId: 'x', category: 'friends' }, ttlSec: 600, timeSensitive: true };

  it('classifies FCM errors', () => {
    const err = (code: string, status = '') => ({ error: { status, details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: code }] } });
    expect(classifyFcmError(404, err('UNREGISTERED', 'NOT_FOUND'), null).kind).toBe('invalid_token');
    expect(classifyFcmError(400, err('INVALID_ARGUMENT', 'INVALID_ARGUMENT'), null).kind).toBe('invalid_token');
    expect(classifyFcmError(403, err('SENDER_ID_MISMATCH'), null).kind).toBe('invalid_token');
    expect(classifyFcmError(429, err('QUOTA_EXCEEDED'), '120')).toEqual({ kind: 'retry', error: 'QUOTA_EXCEEDED', retryAfterMs: 120_000 });
    expect(classifyFcmError(503, {}, null).kind).toBe('retry');
    expect(classifyFcmError(409, {}, null).kind).toBe('failed');
  });

  it('builds a v1 payload with TTL and priority', () => {
    const p = fcmPayload({ token: 'abc' }, msg).message;
    expect(p).toMatchObject({ token: 'abc', notification: { title: 't', body: 'b' }, android: { ttl: '600s', priority: 'high' }, apns: { headers: { 'apns-priority': '10' } } });
  });

  it('gets an OAuth token with the messaging scope, caches it, and re-authenticates after 401', async () => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const sa = { client_email: 'fcm@proj.iam.gserviceaccount.com', private_key: await exportPKCS8(privateKey) };
    const calls: { url: string; body: string; auth?: string }[] = [];
    const replies: Response[] = [
      Response.json({ name: 'projects/p/messages/1' }),
      Response.json({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }, { status: 404 }),
      new Response('', { status: 401 }),
      Response.json({ name: 'projects/p/messages/2' }),
    ];
    let tokenN = 0;
    const f = (async (url: string, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      calls.push({ url, body, ...(auth ? { auth } : {}) });
      if (url.includes('oauth2')) {
        const assertion = new URLSearchParams(body).get('assertion')!;
        expect(decodeJwt(assertion).scope).toBe(FCM_SCOPE);
        return Response.json({ access_token: `at${++tokenN}`, expires_in: 3600 });
      }
      return replies.shift()!;
    }) as typeof fetch;
    const sender = new FcmSender('proj-1', sa, f, () => NOON);
    expect(await sender.send('t1', msg)).toEqual({ kind: 'ok' });
    expect((await sender.send('t2', msg)).kind).toBe('invalid_token');
    expect((await sender.send('t3', msg)).kind).toBe('retry'); // 401 → token dropped
    expect(await sender.sendTopic('season_ja', msg)).toEqual({ kind: 'ok' });
    expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(2);
    const sends = calls.filter((c) => c.url.includes('fcm.googleapis.com'));
    expect(sends[0]!.url).toBe('https://fcm.googleapis.com/v1/projects/proj-1/messages:send');
    expect(sends[3]!.auth).toBe('Bearer at2');
    expect(JSON.parse(sends[3]!.body).message.topic).toBe('season_ja');
  });
});

describe('event-driven pushes through the service and the alarm loop', () => {
  function setup() {
    let now = NOON;
    const wakes: number[] = [];
    const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(1), clock: () => now, verifiers: {}, onPushWake: (at) => { wakes.push(at); } });
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
    const dir = new MemoryDirectory();
    const friends: FriendsService = makeFriendsService(() => invoker, dir);
    return { svc, dir, friends, wakes, setNow: (t: number) => { now = t; } };
  }

  it('friend request → receiver gets a named push; accept → requester gets one; dead token pruned', async () => {
    const { svc, dir, friends, wakes } = setup();
    await svc.registerDevice('bob', 'bob-token-1', 'android');
    await svc.registerDevice('alice', 'alice-token-1', 'ios');
    await dir.putProfile(publicProfile(await svc.state('alice')));
    await svc.setDisplayName('alice', 'アリス');
    await dir.putProfile(publicProfile(await svc.state('alice')));
    const code = await friends.myCode('bob');
    await friends.request('alice', code.code);
    expect(wakes).toEqual([NOON]);

    const sent: { token: string; msg: PushMessage }[] = [];
    const sender: PushSender = {
      send: async (token, msg): Promise<SendOutcome> => { sent.push({ token, msg }); return token.includes('dead') ? { kind: 'invalid_token' } : { kind: 'ok' }; },
      sendTopic: async () => ({ kind: 'ok' }),
    };
    const ports = { take: (p: string) => svc.pushTake(p), settle: (p: string, o: Parameters<PlayerService['pushSettle']>[1]) => svc.pushSettle(p, o) };
    const r = await deliverDuePushes(ports, 'bob', sender);
    expect(r).toMatchObject({ attempted: 1, sent: 1, pending: 0, nextAt: null });
    expect(sent[0]!.msg.body).toBe('アリスさんからフレンド申請が届きました');

    await svc.registerDevice('alice', 'alice-dead-token', 'android');
    await friends.accept('bob', 'alice');
    const r2 = await deliverDuePushes(ports, 'alice', sender);
    expect(r2.pruned).toBe(1);
    expect(sent.filter((x) => x.token.startsWith('alice')).map((x) => x.msg.title)).toContain('フレンド成立');
    expect((await svc.pushPreferences('alice')).devices).toBe(1);
  });

  it('without FCM configured, due messages are dropped instead of piling up', async () => {
    const { svc } = setup();
    await svc.registerDevice('p', 'p-token-xxxx', 'ios');
    await svc.queuePush('p', 'friend_request', { name: 'A' });
    const r = await deliverDuePushes({ take: (p) => svc.pushTake(p), settle: (p, o) => svc.pushSettle(p, o) }, 'p', null);
    expect(r).toMatchObject({ attempted: 1, sent: 0, pending: 0 });
  });
});

describe('season reminders (REQ-PUSH-006)', () => {
  const at = (y: number, mo: number, d: number) => Date.UTC(y, mo - 1, d, 3, 7); // 12:07 JST
  it('picks start / N days before end / last day', () => {
    expect(seasonReminderFor(m, at(2026, 11, 1))).toEqual({ templateId: 'season_start', vars: { season: '2026年11月' } });
    expect(seasonReminderFor(m, at(2026, 11, 28))).toEqual({ templateId: 'season_end', vars: { days: '2' } });
    expect(seasonReminderFor(m, at(2026, 11, 30))).toEqual({ templateId: 'season_last_day', vars: {} });
    expect(seasonReminderFor(m, at(2026, 2, 26))).toEqual({ templateId: 'season_end', vars: { days: '2' } });
    expect(seasonReminderFor(m, at(2026, 11, 15))).toBeNull();
  });
  it('runs from the noon cron', async () => {
    const deps = { snapshot: async () => ({}), rolloverStep: async () => ({ status: 'closed' }), sweepReplays: async () => ({ deleted: 0 }), seasonReminder: async () => 'season_start' };
    expect(await runScheduled(CRONS.noon, at(2026, 11, 1), deps)).toEqual(['reminder:season_start']);
  });
});
