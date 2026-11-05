/**
 * Regression tests for the round-5 realtime/infra review (each failed before its fix).
 */
import { describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { m, makeConfig } from './helpers.js';
import { newPlayer } from '../src/domain/player.js';
import { enqueuePush, nextPushWake, registerDevice, takeDuePushes, unregisterDevice } from '../src/domain/push.js';
import { sweepReplays, type ReplayBucket, type SweepCursorStore } from '../src/domain/retention.js';
import { DAY_MS } from '../src/domain/time.js';
import {
  assertNotInLiveRace, diffRows, EventPools, FriendRooms, isPendingAssignment, PENDING_RACE_ID, type QueueEntry,
} from '../src/domain/matchmaker.js';
import { MAX_ROLLOVER_ATTEMPTS, newRolloverState, rolloverStep } from '../src/domain/leaderboard.js';
import { CRONS, runScheduled } from '../src/domain/scheduled.js';
import { enqueueModeration, flushModeration, MemoryModerationOutbox } from '../src/ops/moderationOutbox.js';
import { RaceRoomCore, CMD } from '../src/domain/raceRoom.js';
import { seededRng, type Rng } from '../src/domain/rng.js';
import { driveSettlement, MAX_SETTLE_ATTEMPTS, newSettleMeta, type SettleDeps } from '../src/race/settlement.js';
import { DirtyTracker } from '../src/domain/dirty.js';
import { authenticateAdmin, type AdminAuthConfig } from '../src/ops/admin.js';
import type { EventDef } from '../src/domain/master.js';

const NOON = Date.UTC(2026, 10, 5, 3);
const code = (f: () => unknown) => { try { f(); return null; } catch (e) { return (e as { code?: string }).code ?? 'ERR'; } };
const rng: Rng = seededRng(7);

describe('HIGH 2: friend rooms cannot exhaust matchmaker storage', () => {
  it('one open room per host: creating again returns the same room', () => {
    const fr = new FriendRooms<null>();
    const a = fr.create('host', null, 1, rng);
    for (let i = 0; i < 5000; i++) expect(fr.create('host', null, 2 + i, rng).passphrase).toBe(a.passphrase);
    expect(fr.rooms.size).toBe(1);
  });

  it('a global cap refuses new rooms instead of growing without bound', () => {
    const fr = new FriendRooms<null>(12, 30 * 60_000, 2, 3);
    for (const h of ['a', 'b', 'c']) fr.create(h, null, 1, rng);
    expect(code(() => fr.create('d', null, 1, rng))).toBe('RATE_LIMITED');
  });

  it('expired rooms are pruned on every operation (membership checks and starts too)', () => {
    const fr = new FriendRooms<null>(12, 1000);
    const r = fr.create('h', null, 0, rng);
    fr.join(r.passphrase, 'x', null, 1);
    expect(fr.isMember(r.passphrase, 'x', 5000)).toBe(false);
    expect(fr.rooms.size).toBe(0);
  });

  it('rows are written as a diff (only changed rows), so persisting is per-row, not one blob', () => {
    const prev = new Map([['q|ranked|a', '1'], ['q|ranked|b', '1'], ['a|c', 'x']]);
    const next = new Map([['q|ranked|a', '1'], ['a|c', 'y'], ['r|123456', 'room']]);
    expect(diffRows(prev, next)).toEqual({ upserts: [['a|c', 'y'], ['r|123456', 'room']], deletes: ['q|ranked|b'] });
  });
});

describe('HIGH 3: undeliverable push items no longer re-arm the alarm every second', () => {
  it('a due item whose only device was unregistered is dropped', () => {
    const s = newPlayer('p', NOON, '2026-11');
    registerDevice(m, s, 'tok-aaaaaaaa', 'ios', NOON);
    enqueuePush(m, s, 'friend_request', { name: 'A' }, NOON);
    unregisterDevice(m, s, 'tok-aaaaaaaa');
    const r = takeDuePushes(m, s, NOON + 1);
    expect(r).toMatchObject({ due: [], undeliverable: 1 });
    expect(nextPushWake(s)).toBeNull(); // nothing left to wake up for
  });

  it('a due item whose template is unknown (e.g. remote-config only) is dropped', () => {
    const s = newPlayer('p', NOON, '2026-11');
    registerDevice(m, s, 'tok-aaaaaaaa', 'ios', NOON);
    enqueuePush(m, s, 'friend_request', { name: 'A' }, NOON);
    const noTemplates = { ...m, push: { ...m.push, templates: {} } };
    expect(takeDuePushes(noTemplates, s, NOON + 1).undeliverable).toBe(1);
    expect(nextPushWake(s)).toBeNull();
  });
});

describe('HIGH 4: the replay sweep resumes where it stopped', () => {
  function bucketWith(fresh: number, expired: number, now: number) {
    const store = new Map<string, { uploaded: Date; customMetadata?: Record<string, string> }>();
    // keys sort fresh/held first: exactly the layout that starved the old sweep
    for (let i = 0; i < fresh; i++) store.set(`replays/a${String(i).padStart(6, '0')}.json`, { uploaded: new Date(now - DAY_MS), ...(i % 10 === 0 ? { customMetadata: { hold: 'verified' } } : {}) });
    for (let i = 0; i < expired; i++) store.set(`replays/z${String(i).padStart(6, '0')}.json`, { uploaded: new Date(now - 60 * DAY_MS) });
    const bucket: ReplayBucket = {
      async list({ prefix, cursor, limit = 1000 }) {
        const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
        const start = cursor ? keys.findIndex((k) => k > cursor) : 0;
        const from = start < 0 ? keys.length : start;
        const page = keys.slice(from, from + limit);
        const truncated = from + limit < keys.length;
        return { objects: page.map((k) => ({ key: k, ...store.get(k)! })), truncated, ...(truncated ? { cursor: page.at(-1)! } : {}) };
      },
      async delete(keys) { for (const k of keys) store.delete(k); },
    };
    return { store, bucket };
  }

  it('without a cursor (old behaviour) expired replays past the first pages are never reached', async () => {
    const now = NOON;
    const { store, bucket } = bucketWith(25_000, 5_000, now);
    for (let day = 0; day < 3; day++) await sweepReplays(bucket, now, 30);
    expect([...store.keys()].filter((k) => k.startsWith('replays/z')).length).toBe(5_000);
  });

  it('with a persisted cursor every expired replay is reached within a few runs', async () => {
    const now = NOON;
    const { store, bucket } = bucketWith(25_000, 5_000, now);
    let saved: string | null = null;
    const cursor: SweepCursorStore = { get: async () => saved, set: async (c) => { saved = c; } };
    await sweepReplays(bucket, now, 30, 20, cursor); // first 20k keys: all fresh or held
    expect(saved).not.toBeNull();
    const r2 = await sweepReplays(bucket, now, 30, 20, cursor);
    expect(r2.deleted).toBe(5_000);
    expect([...store.keys()].filter((k) => k.startsWith('replays/z')).length).toBe(0);
    expect(store.size).toBe(25_000); // fresh and held ones are kept
  });
});

describe('MED 5: no player in two races at once', () => {
  it('a pending placeholder counts as a live race (closes the await gap for enqueue / event cancel)', () => {
    const a = new Map([['p', { raceId: PENDING_RACE_ID, at: 1000 }]]);
    expect(isPendingAssignment({ raceId: PENDING_RACE_ID })).toBe(true);
    expect(code(() => assertNotInLiveRace(a, 'p', 1001))).toBe('ALREADY_IN_RACE');
  });

  it('requeue after a failed event race start keeps the players (the empty pool was dropped by tick)', () => {
    const ev = { id: 'ev1', startAtMs: 0, endAtMs: Number.MAX_SAFE_INTEGER, rules: { maxPlayers: 2, cpuFillAfterMs: 0 } } as unknown as EventDef;
    const pools = new EventPools<null>();
    const e = (id: string): QueueEntry<null> => ({ playerId: id, rating: 1500, beginner: false, enqueuedAt: 0, payload: null });
    pools.enqueue(ev, e('a'), 1);
    const matches = pools.tick(10, [ev]);
    expect(matches).toHaveLength(1);
    expect(pools.has('a')).toBe(false); // pool emptied and deleted
    pools.requeue('ev1', matches[0]!.match.players, ev);
    expect(pools.eventOf('a')).toBe('ev1');
  });
});

describe('MED 6: season/team/event payouts cannot stall forever', () => {
  it('a player that always fails is dead-lettered after the retry cap; everyone after them is paid', async () => {
    let st = newRolloverState('2026-11');
    const paid: string[] = [];
    const ps = ['a', 'b', 'c'].map((p) => ({ playerId: p, classId: 'C' }));
    for (let run = 0; run < MAX_ROLLOVER_ATTEMPTS + 2 && st.status !== 'closed'; run++) {
      st = await rolloverStep(st, ps, () => undefined, async (pid) => { if (pid === 'b') throw new Error('broken'); paid.push(pid); }, 10);
    }
    expect(st.status).toBe('closed');
    expect(paid).toEqual(['a', 'c']);
    expect(st.deadLetter).toEqual([{ id: 'b', error: 'broken', attempts: MAX_ROLLOVER_ATTEMPTS }]);
  });

  it('one failing cron step does not skip the others; older unclosed seasons keep progressing', async () => {
    const calls: string[] = [];
    const done = await runScheduled(CRONS.frequent, Date.UTC(2026, 11, 1, 3), {
      snapshot: async () => { throw new Error('r2 down'); },
      rolloverStep: async (s) => { calls.push(`roll:${s}`); if (s === '2026-11') throw new Error('boom'); return { status: s === '2026-10' ? 'closing' : 'closed' }; },
      sweepReplays: async () => ({ deleted: 0 }),
      teamRolloverStep: async (s) => { calls.push(`team:${s}`); return { status: 'closed' }; },
      eventsStep: async () => ['events:ok'],
    });
    expect(done).toEqual(['snapshot:error', 'rollover:2026-11:error', 'teamRollover:2026-11:closed','rollover:2026-10:closing', 'teamRollover:2026-10:closed', 'rollover:2026-09:closed', 'teamRollover:2026-09:closed', 'events:ok']);
    expect(calls).toContain('roll:2026-10');
  });
});

describe('MED 7: a moderation push that fails is retried, never lost', () => {
  it('stays in the outbox and is delivered on a later flush', async () => {
    const box = new MemoryModerationOutbox();
    const pushed: string[] = [];
    let fail = true;
    const push = async (c: { playerId: string; status: string }) => { if (fail) throw new Error('player DO unavailable'); pushed.push(`${c.playerId}:${c.status}`); };
    enqueueModeration(box, [{ playerId: 'p', status: 'quarantined', until: 99, reason: 'auto' }], 0);
    const r1 = await flushModeration(box, push, 0);
    expect(r1).toMatchObject({ pushed: 0, failed: 1 });
    expect(r1.nextAt).toBeGreaterThan(0);
    fail = false;
    expect(await flushModeration(box, push, 1)).toMatchObject({ pushed: 0 }); // not before the backoff
    expect(await flushModeration(box, push, r1.nextAt!)).toMatchObject({ pushed: 1, nextAt: null });
    expect(pushed).toEqual(['p:quarantined']);
  });

  it('a newer decision for the same player is not deleted by the older push finishing', async () => {
    const box = new MemoryModerationOutbox();
    enqueueModeration(box, [{ playerId: 'p', status: 'quarantined', until: 99, reason: 'auto' }], 0);
    await flushModeration(box, async () => { enqueueModeration(box, [{ playerId: 'p', status: 'banned', until: null, reason: 'admin' }], 0); }, 0);
    expect(box.get('p')?.change.status).toBe('banned');
  });
});

describe('LOW-MED 8: settlement retries are capped', () => {
  it('a player whose result can never be applied is dead-lettered and the room stops retrying', async () => {
    const H = (c: string) => c.repeat(64);
    const cfg = makeConfig(2, 'ranked');
    const r = new RaceRoomCore(cfg, 0, { verifySampleRate: 0, resultWaitMs: 1, rng: seededRng(1) });
    const at = (t: number) => (t + 1) * 50;
    for (const s of r.humanSlots) r.hello(s, -1, 0);
    for (let t = 0; t <= r.minResultTick + 20; t += 20) {
      for (const s of r.humanSlots) r.message(s, { t: 'ping', c: 0 }, at(t));
      r.advance(at(t));
      if (t === 60) r.message(r.humanSlots[0]!, { t: 'in', tick: 62, cmd: CMD.START }, at(t));
    }
    const e = r.minResultTick + 20;
    for (const s of r.humanSlots) r.message(s, { t: 'res', h: H('a'), order: [0, 1] }, at(e));
    expect(r.phase).toBe('final');
    const meta = newSettleMeta({});
    const finished: string[][] = [];
    const d: SettleDeps = {
      verify: async () => { throw new Error('unused'); },
      putReplay: async () => {},
      applyRace: async (pid) => { if (pid === r.config.entrants[r.humanSlots[0]!]!.playerId) throw new Error('corrupt state'); },
      raceFinished: async (p) => { finished.push(p); },
      persist: async () => {},
    };
    let now = 0;
    let res = await driveSettlement(r, meta, d, now);
    for (let i = 0; i < MAX_SETTLE_ATTEMPTS + 5 && res.retryAt !== null; i++) {
      now = res.retryAt;
      res = await driveSettlement(r, meta, d, now);
    }
    expect(res.retryAt).toBeNull();
    expect(meta.settled).toBe(true);
    expect(meta.settleAttempts).toBe(MAX_SETTLE_ATTEMPTS);
    expect(meta.deadLetter).toEqual([r.config.entrants[r.humanSlots[0]!]!.playerId]);
    expect(finished).toHaveLength(1); // players are released for matchmaking
  });
});

describe('LOW 9: a board update during a snapshot is not lost', () => {
  it('an upsert landing while the snapshot writes keeps the board dirty', () => {
    const kv = new Map<string, unknown>();
    const t = new DirtyTracker({ get: <T>(k: string) => (kv.has(k) ? (kv.get(k) as T) : null), put: (k, v) => { kv.set(k, v); } });
    t.mark();
    const gen = t.begin()!; // snapshot reads the rows…
    t.mark(); // …an upsert lands during the awaited R2 writes…
    t.end(gen); // …and the snapshot finishes
    expect(t.begin()).not.toBeNull(); // still dirty: the next run publishes it
    t.end(t.begin()!);
    expect(t.begin()).toBeNull();
  });

  it('honours the dirty flag written by older builds', () => {
    const kv = new Map<string, unknown>([['dirty', true]]);
    const t = new DirtyTracker({ get: <T>(k: string) => (kv.has(k) ? (kv.get(k) as T) : null), put: (k, v) => { kv.set(k, v); } });
    const gen = t.begin();
    expect(gen).not.toBeNull();
    t.end(gen!);
    expect(t.begin()).toBeNull();
  });
});

describe('LOW 10b: Access role keys are matched case-insensitively', () => {
  it('a role configured with capitals still applies', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k', alg: 'ES256' }] });
    const cfg: AdminAuthConfig = { tokens: [], access: { teamDomain: 'team.cloudflareaccess.com', audience: 'aud1', roles: { 'Ops.Lead@Example.com': 'admin' }, jwks } };
    const jwt = await new SignJWT({ email: 'ops.lead@example.com' }).setProtectedHeader({ alg: 'ES256', kid: 'k' }).setIssuer('https://team.cloudflareaccess.com').setAudience('aud1').setExpirationTime('5m').sign(privateKey);
    const req = new Request('https://x/v1/admin/whoami', { headers: { 'cf-access-jwt-assertion': jwt } });
    await expect(authenticateAdmin(req, cfg)).resolves.toMatchObject({ role: 'admin' });
  });
});
