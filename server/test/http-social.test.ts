import { describe, expect, it } from 'vitest';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { m } from './helpers.js';

function ctx(): AppContext {
  const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(3), clock: () => Date.UTC(2026, 10, 5, 3), verifiers: {} });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  return {
    master: m,
    authenticate: async (req) => {
      const u = req.headers.get('x-test-user');
      if (!u) throw new AppError('UNAUTHORIZED');
      return u;
    },
    player: () => invoker,
    match: {
      enqueue: async () => ({}), cancel: async () => ({}), status: async () => ({}), friendCreate: async () => ({}), friendJoin: async () => ({}),
      friendStart: async () => ({}), tutorial: async () => ({}), friendMember: async (pass) => pass === '123456',
    },
    race: { websocket: async () => new Response(null), report: async () => ({}), replay: async () => ({}) },
    friends: makeFriendsService(() => invoker, new MemoryDirectory()),
    leaderboard: { board: async (season, board) => ({ season, board }), myRank: async (p, season) => ({ p, season }) },
    timeAttack: {} as AppContext['timeAttack'],
    clock: () => Date.UTC(2026, 10, 5, 3),
    paidBalance: async () => ({}),
    adminToken: 'x',
    parseStoreNotification: async () => null,
  } as AppContext;
}

async function call(c: AppContext, method: string, path: string, o: { user?: string; body?: unknown } = {}) {
  const res = await handle(new Request(`https://x${path}`, {
    method, headers: { 'content-type': 'application/json', ...(o.user ? { 'x-test-user': o.user } : {}) },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  }), {}, c);
  return { status: res.status, body: (await res.json()) as any };
}

describe('HTTP API: profile, titles, stats', () => {
  it('sets a display name (NG checked), lists titles, refuses locked titles, returns stats', async () => {
    const c = ctx();
    expect((await call(c, 'PUT', '/v1/player/profile', { user: 'u', body: { displayName: 'ゲートの鬼' } })).body).toEqual({ displayName: 'ゲートの鬼' });
    expect((await call(c, 'PUT', '/v1/player/profile', { user: 'u', body: { displayName: 'ダービー王' } })).body.error.code).toBe('NG_NAME');
    expect((await call(c, 'GET', '/v1/titles', { user: 'u' })).body.titles).toHaveLength(m.titles.length);
    expect((await call(c, 'PUT', '/v1/player/title', { user: 'u', body: { titleId: 'first_win' } })).body.error.code).toBe('NOT_ELIGIBLE');
    expect((await call(c, 'PUT', '/v1/player/title', { user: 'u', body: { titleId: null } })).body).toEqual({ titleId: null });
    expect((await call(c, 'GET', '/v1/stats', { user: 'u' })).body).toMatchObject({ races: 0, wins: 0 });
    expect((await call(c, 'GET', '/v1/player', { user: 'u' })).body.profile).toMatchObject({ displayName: 'ゲートの鬼', titleId: null });
  });
});

describe('HTTP API: leaderboards', () => {
  it('resolves the current season, validates names and returns my rank', async () => {
    const c = ctx();
    expect((await call(c, 'GET', '/v1/leaderboards/current/class-C')).body).toEqual({ season: '2026-11', board: 'class-C' });
    expect((await call(c, 'GET', '/v1/leaderboards/2026-10/rating')).body).toEqual({ season: '2026-10', board: 'rating' });
    expect((await call(c, 'GET', '/v1/leaderboards/nope/rating')).status).toBe(400);
    expect((await call(c, 'GET', '/v1/leaderboards/2026-10/secret')).status).toBe(400);
    expect((await call(c, 'GET', '/v1/leaderboards/me')).status).toBe(401);
    expect((await call(c, 'GET', '/v1/leaderboards/me', { user: 'u' })).body).toEqual({ p: 'u', season: '2026-11' });
  });
});

describe('HTTP API: friends', () => {
  it('code → request → accept → list → invite → remove', async () => {
    const c = ctx();
    const bob = (await call(c, 'GET', '/v1/friends/code', { user: 'bob' })).body.code;
    expect(bob).toMatch(/^\d{9}$/);
    expect((await call(c, 'POST', '/v1/friends/requests', { user: 'alice', body: { code: 'abc' } })).status).toBe(400);
    expect((await call(c, 'POST', '/v1/friends/requests', { user: 'alice', body: { code: bob } })).body).toEqual({ status: 'requested', playerId: 'bob' });
    expect((await call(c, 'GET', '/v1/friends', { user: 'bob' })).body.incoming[0]).toMatchObject({ playerId: 'alice' });
    expect((await call(c, 'POST', '/v1/friends/requests/alice/accept', { user: 'bob' })).body).toEqual({ status: 'friends', playerId: 'alice' });
    expect((await call(c, 'GET', '/v1/friends', { user: 'alice' })).body.friends.map((f: { playerId: string }) => f.playerId)).toEqual(['bob']);
    expect((await call(c, 'POST', '/v1/friend-rooms/999999/invite', { user: 'alice', body: { friendId: 'bob' } })).body.error.code).toBe('NOT_ELIGIBLE');
    expect((await call(c, 'POST', '/v1/friend-rooms/123456/invite', { user: 'alice', body: { friendId: 'bob' } })).body).toEqual({ ok: true });
    expect((await call(c, 'GET', '/v1/friends', { user: 'bob' })).body.invites[0]).toMatchObject({ passphrase: '123456', from: { playerId: 'alice' } });
    expect((await call(c, 'DELETE', '/v1/friends/bob', { user: 'alice' })).body).toEqual({ ok: true });
    expect((await call(c, 'GET', '/v1/friends', { user: 'bob' })).body.friends).toEqual([]);
  });
  it('decline and cancel', async () => {
    const c = ctx();
    const bob = (await call(c, 'GET', '/v1/friends/code', { user: 'bob' })).body.code;
    await call(c, 'POST', '/v1/friends/requests', { user: 'alice', body: { code: bob } });
    await call(c, 'POST', '/v1/friends/requests/alice/decline', { user: 'bob' });
    expect((await call(c, 'GET', '/v1/friends', { user: 'alice' })).body.outgoing).toEqual([]);
    await call(c, 'POST', '/v1/friends/requests', { user: 'alice', body: { code: bob } });
    await call(c, 'DELETE', '/v1/friends/requests/bob', { user: 'alice' });
    expect((await call(c, 'GET', '/v1/friends', { user: 'bob' })).body.incoming).toEqual([]);
  });
});
