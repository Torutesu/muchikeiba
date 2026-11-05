import { describe, expect, it } from 'vitest';
import { eventPlayersFrom, handle, teamPlayersFrom, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { MemoryTeams, TeamsService } from '../src/domain/teamService.js';
import { EventsService } from '../src/domain/eventService.js';
import { grantFree } from '../src/domain/wallet.js';
import { createHorseFromTemplate } from '../src/domain/horses.js';
import type { PlayerState } from '../src/domain/player.js';
import { m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 5, 3);

function ctx(withServices = true) {
  const repo = new MemoryPlayerRepo();
  const svc = new PlayerService(repo, { master: m, rng: seededRng(3), clock: () => NOW, verifiers: {} });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const teams = new MemoryTeams(() => m, () => NOW);
  const queued: { eventId: string; uid: string }[] = [];
  const c = {
    master: m,
    authenticate: async (req: Request) => {
      const u = req.headers.get('x-test-user');
      if (!u) throw new AppError('UNAUTHORIZED');
      return u;
    },
    player: () => invoker,
    clock: () => NOW,
    ...(withServices ? {
      teams: new TeamsService(() => m, teams, teamPlayersFrom(() => invoker), teams, teams, seededRng(1), () => NOW),
      events: new EventsService(() => m, eventPlayersFrom(() => invoker), {
        enqueue: async (eventId, uid) => { if (!queued.some((q) => q.uid === uid && q.eventId === eventId)) queued.push({ eventId, uid }); return { state: 'queued' }; },
        cancel: async () => ({ state: 'none' }),
      }, { board: async (eventId) => ({ eventId, entries: [] }), rankOf: async () => null }, () => NOW),
    } : {}),
  } as unknown as AppContext;
  return { c, repo, svc, queued };
}

async function call(c: AppContext, method: string, path: string, o: { user?: string; body?: unknown; idem?: string } = {}) {
  const res = await handle(new Request(`https://x${path}`, {
    method, headers: { 'content-type': 'application/json', ...(o.user ? { 'x-test-user': o.user } : {}), ...(o.idem ? { 'idempotency-key': o.idem } : {}) },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  }), {}, c);
  return { status: res.status, body: (await res.json()) as any };
}

describe('HTTP API: teams', () => {
  it('create, /me before /:teamId, join, roles, search, leaderboard, leave', async () => {
    const { c } = ctx();
    const created = await call(c, 'POST', '/v1/teams', { user: 'lead', body: { name: 'あおばRC', joinPolicy: 'open' } });
    expect(created.status).toBe(200);
    const teamId = created.body.teamId as string;
    expect(teamId).toMatch(/^t[0-9a-z]{9}$/);
    expect((await call(c, 'GET', '/v1/teams/me', { user: 'lead' })).body.team.teamId).toBe(teamId);
    expect((await call(c, 'POST', `/v1/teams/${teamId}/join`, { user: 'a' })).body).toEqual({ status: 'joined', teamId });
    expect((await call(c, 'PUT', '/v1/teams/me/roles', { user: 'lead', body: { playerId: 'a', role: 'officer' } })).body.members.find((x: any) => x.playerId === 'a').role).toBe('officer');
    expect((await call(c, 'PUT', '/v1/teams/me', { user: 'lead', body: { announcement: '毎晩集合', joinPolicy: 'approval' } })).body).toMatchObject({ announcement: '毎晩集合', joinPolicy: 'approval' });
    expect((await call(c, 'GET', `/v1/teams/${teamId}`, { user: 'x' })).body.requests).toEqual([]);
    expect((await call(c, 'GET', '/v1/teams/search?q=あおば', { user: 'x' })).body.map((t: any) => t.teamId)).toEqual([teamId]);
    expect((await call(c, 'GET', '/v1/teams/leaderboard/current')).body).toMatchObject({ seasonId: '2026-11', board: 'teams' });
    expect((await call(c, 'POST', `/v1/teams/${teamId}/join`, { user: 'b' })).body.status).toBe('requested');
    expect((await call(c, 'POST', '/v1/teams/me/requests/b/approve', { user: 'a' })).body).toMatchObject({ status: 'joined', playerId: 'b' });
    expect((await call(c, 'POST', '/v1/teams/me/leave', { user: 'b' })).body).toEqual({ left: teamId, disbanded: false });
    expect((await call(c, 'POST', '/v1/teams/me/leave', { user: 'lead' })).body.error.code).toBe('TEAM_LEADER_MUST_TRANSFER');
  });

  it('validates ids and bodies; 404 when teams are not served', async () => {
    const { c } = ctx();
    expect((await call(c, 'GET', '/v1/teams/NOT-AN-ID', { user: 'u' })).status).toBe(400);
    expect((await call(c, 'POST', '/v1/teams', { user: 'u', body: { name: 'x', joinPolicy: 'secret' } })).status).toBe(400);
    expect((await call(c, 'GET', '/v1/teams/me', { user: 'u' })).body).toMatchObject({ team: null });
    expect((await call(c, 'POST', '/v1/teams/me/leave', { user: 'u' })).body.error.code).toBe('NOT_IN_TEAM');
    expect((await call(c, 'GET', '/v1/teams/leaderboard/2026-1x')).status).toBe(400);
    const bare = ctx(false).c;
    expect((await call(bare, 'GET', '/v1/teams/me', { user: 'u' })).status).toBe(404);
  });
});

describe('HTTP API: events', () => {
  it('lists, enqueues with an idempotency key (fee once), board and me', async () => {
    const { c, repo, svc, queued } = ctx();
    await svc.bootstrap('p');
    const s = (await repo.get('p')) as PlayerState;
    const h = createHorseFromTemplate(s, m.templates[0]!, NOW);
    grantFree(s, 100, NOW, 'g', 'g');
    repo.put(s);
    const list = await call(c, 'GET', '/v1/events', { user: 'p' });
    expect(list.body.map((e: any) => e.id)).toContain('sprint_cup_2026_11');
    expect((await call(c, 'POST', '/v1/events/sprint_cup_2026_11/enqueue', { user: 'p', body: { horseId: h.id } })).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const r = await call(c, 'POST', '/v1/events/sprint_cup_2026_11/enqueue', { user: 'p', body: { horseId: h.id }, idem: 'k1' });
    expect(r.body).toMatchObject({ state: 'queued', eventId: 'sprint_cup_2026_11' });
    await call(c, 'POST', '/v1/events/sprint_cup_2026_11/enqueue', { user: 'p', body: { horseId: h.id }, idem: 'k1' });
    expect(((await repo.get('p')) as PlayerState).wallet.free).toBe(70); // the retry did not charge again
    expect(queued).toHaveLength(1); // the retry re-queued idempotently (no second entry, no refund)
    expect((await call(c, 'GET', '/v1/events/sprint_cup_2026_11/leaderboard')).body).toMatchObject({ eventId: 'sprint_cup_2026_11' });
    expect((await call(c, 'GET', '/v1/events/sprint_cup_2026_11/me', { user: 'p' })).body.event.me).toMatchObject({ pending: true });
    expect((await call(c, 'POST', '/v1/events/no_whip_cup_2026_12/enqueue', { user: 'p', body: { horseId: h.id }, idem: 'k2' })).body.error.code).toBe('EVENT_CLOSED');
    expect((await call(c, 'GET', '/v1/events/Bad-Id/me', { user: 'p' })).status).toBe(400);
    expect((await call(c, 'POST', '/v1/events/sprint_cup_2026_11/cancel', { user: 'p' })).body).toEqual({ state: 'none', refunded: true });
  });
});
