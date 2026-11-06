import { describe, expect, it } from 'vitest';
import {
  advanceCount, cancelTournament, computeStandings, heatResults, newTournament, planHeats, playerView, publicView, register, stepTournament,
  tournamentDeadLetters, tournamentDefSchema, retryPayout, unregister, HEAT_CREATE_LEAD_MS, PAYOUT_MAX_ATTEMPTS,
  type HeatOutcome, type Registrant, type TournamentDefInput, type TournamentPorts, type TournamentState,
} from '../src/domain/tournaments.js';
import { TournamentsService, type TournamentBackend, type TournamentEntryInfo } from '../src/domain/tournamentService.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { createHorseFromTemplate } from '../src/domain/horses.js';
import { handle, tournamentPlayersFrom, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { AppError } from '../src/domain/errors.js';
import type { PlayerState } from '../src/domain/player.js';
import { m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 6, 3);
const OPEN = NOW - 60_000;
const CLOSE = NOW + 10 * 60_000;
const START = CLOSE + 10 * 60_000;

const defInput = (o: Partial<TournamentDefInput> = {}): TournamentDefInput => ({
  id: 'cup_test', name: 'テスト杯', trackIds: ['aoba_dirt_1400'], registrationOpensAtMs: OPEN, registrationClosesAtMs: CLOSE, startsAtMs: START,
  heatSize: 2, fieldSize: 4, advancePerHeat: 1, maxEntrants: 16, minEntrants: 2,
  prizes: [{ maxRank: 1, reward: { freeCoins: 500 } }, { maxRank: 3, reward: { freeCoins: 100 } }],
  ...o,
});
const def = (o: Partial<TournamentDefInput> = {}) => tournamentDefSchema.parse(defInput(o));
const okInfo = { classId: 'C', rankedRaces: 10, style: 'senko', horseActive: true, moderation: 'ok' as const };
const reg = (playerId: string, rating: number, at = NOW): Registrant<{ playerId: string }> => ({ playerId, displayName: playerId.toUpperCase(), horseId: `h_${playerId}`, rating, registeredAt: at, entry: { playerId } });

/** In-memory heats: the test decides each race's outcome. */
class FakeHeats implements TournamentPorts<{ playerId: string }> {
  n = 0;
  created: { raceId: string; players: string[]; startAtMs: number; cpuCount: number; statCap: number | null }[] = [];
  outcomes = new Map<string, HeatOutcome | null>();
  pushes: { pid: string; templateId: string; vars: Record<string, string> }[] = [];
  awards: { pid: string; rank: number; reward: unknown }[] = [];
  failAward = new Set<string>();
  async refreshEntry() { return null; }
  async createHeat(spec: Parameters<TournamentPorts<unknown>['createHeat']>[0]) {
    const raceId = `r_${++this.n}`;
    this.created.push({ raceId, players: spec.heat.playerIds, startAtMs: spec.heat.startAtMs, cpuCount: spec.cpuCount, statCap: spec.statCap });
    return { raceId, assignments: Object.fromEntries(spec.heat.playerIds.map((p, i) => [p, { raceId, slot: i, ticket: `t_${raceId}_${p}`, startAtMs: spec.heat.startAtMs, wsPath: `/v1/race/${raceId}/ws` }])) };
  }
  async heatResult(raceId: string) { return this.outcomes.get(raceId) ?? { phase: 'running', final: null, slots: [], noShows: [] }; }
  async notify(pid: string, templateId: string, vars: Record<string, string>) { this.pushes.push({ pid, templateId, vars }); }
  async award(pid: string, _t: string, rank: number, reward: unknown) {
    if (this.failAward.has(pid)) throw new Error('player object down');
    this.awards.push({ pid, rank, reward });
  }
  /** Finish a heat: `order` = player ids in finish order (CPU slots after the humans); noShow = ids that never connected. */
  finish(raceId: string, order: string[], noShow: string[] = [], status: 'confirmed' | 'void' = 'confirmed') {
    const c = this.created.find((x) => x.raceId === raceId)!;
    const slots = c.players.map((p, i) => ({ slot: i, playerId: p }));
    const slotOf = (p: string) => slots.find((s) => s.playerId === p)!.slot;
    this.outcomes.set(raceId, { phase: 'final', final: { status, order: status === 'void' ? [] : order.map(slotOf) }, slots, noShows: noShow.map(slotOf) });
  }
}

async function run(t: TournamentState<{ playerId: string }>, now: number, ports: FakeHeats) {
  return stepTournament(t, now, ports, async () => {});
}

describe('tournament brackets (REQ-TOUR-004)', () => {
  it('snake-seeds balanced heats', () => {
    expect(planHeats(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 4)).toEqual([['a', 'd', 'e', 'h'], ['b', 'c', 'f', 'g']]);
    expect(planHeats(Array.from({ length: 13 }, (_, i) => `p${i}`), 12).map((h) => h.length)).toEqual([7, 6]);
    expect(planHeats(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a'], ['b', 'e'], ['c', 'd']]); // the top seed gets the bye
    expect(planHeats([], 12)).toEqual([]);
  });

  it('every heat of two or more eliminates someone; a lone player can go on', () => {
    const d = def({ heatSize: 12, fieldSize: 12, advancePerHeat: 11 });
    expect(advanceCount(d, 12)).toBe(11);
    expect(advanceCount(d, 3)).toBe(2);
    expect(advanceCount(d, 1)).toBe(1);
  });

  it('validates the definition', () => {
    expect(tournamentDefSchema.safeParse(defInput({ advancePerHeat: 2 })).success).toBe(false); // must be < heatSize
    expect(tournamentDefSchema.safeParse(defInput({ fieldSize: 1 })).success).toBe(false);
    expect(tournamentDefSchema.safeParse(defInput({ registrationClosesAtMs: START })).success).toBe(false); // no time to create heats
    expect(tournamentDefSchema.safeParse(defInput({ id: 'Bad Id' })).success).toBe(false);
    expect(tournamentDefSchema.safeParse(defInput()).success).toBe(true);
  });
});

describe('tournament registration (REQ-TOUR-002/003)', () => {
  it('window, eligibility, capacity, re-register keeps the slot, unregister', () => {
    const t = newTournament<{ playerId: string }>(def({ maxEntrants: 2, entry: { classIds: ['B'], minRankedRaces: 5, styles: null } }), 'ops', NOW);
    expect(() => register(t, reg('a', 1500), okInfo, NOW)).toThrow(/class/);
    expect(() => register(t, reg('a', 1500), { ...okInfo, classId: 'B', rankedRaces: 1 }, NOW)).toThrow(/ranked_races/);
    expect(() => register(t, reg('a', 1500), { ...okInfo, classId: 'B', moderation: 'quarantined' }, NOW)).toThrow(/moderation/);
    const b = { ...okInfo, classId: 'B' };
    expect(register(t, reg('a', 1500), b, NOW)).toEqual({ registered: true, existing: false });
    register(t, reg('b', 1500), b, NOW);
    expect(() => register(t, reg('c', 1500), b, NOW)).toThrow(AppError);
    expect(register(t, { ...reg('a', 1600, NOW + 5), horseId: 'h2' }, b, NOW + 5)).toEqual({ registered: true, existing: true });
    expect(t.registrants.a!.registeredAt).toBe(NOW);
    expect(t.registrants.a!.horseId).toBe('h2');
    expect(unregister(t, 'a', NOW)).toBe(true);
    expect(unregister(t, 'a', NOW)).toBe(false);
    expect(() => register(t, reg('d', 1500), b, CLOSE)).toThrow(/closed/);
    const early = newTournament<{ playerId: string }>(def(), 'ops', NOW);
    expect(() => register(early, reg('a', 1500), okInfo, OPEN - 1)).toThrow(/closed/);
  });

  it('too few entrants cancels at the close', async () => {
    const t = newTournament<{ playerId: string }>(def({ minEntrants: 3 }), 'ops', NOW);
    register(t, reg('a', 1500), okInfo, NOW);
    register(t, reg('b', 1500), okInfo, NOW);
    const r = await run(t, CLOSE, new FakeHeats());
    expect(t.status).toBe('cancelled');
    expect(t.cancelReason).toBe('not_enough_entrants');
    expect(r.wakeAt).toBeNull();
  });
});

describe('tournament run (REQ-TOUR-005..008)', () => {
  it('heats → final → standings → prizes, with reminders, no-shows and CPU fill', async () => {
    const t = newTournament<{ playerId: string }>(def({ statCap: 2800 }), 'ops', NOW);
    for (const [p, r] of [['a', 1700], ['b', 1600], ['c', 1500], ['d', 1400]] as const) register(t, reg(p, r), okInfo, NOW);
    const f = new FakeHeats();
    let r = await run(t, CLOSE, f);
    expect(t.status).toBe('running');
    expect(t.rounds[0]!.heats.map((h) => h.playerIds)).toEqual([['a', 'd'], ['b', 'c']]);
    expect(r.wakeAt).toBe(START - 300_000); // first-round reminder
    r = await run(t, START - 300_000, f);
    expect(f.pushes.map((x) => x.pid).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(f.pushes[0]).toMatchObject({ templateId: 'tournament_heat_soon', vars: { tournament: 'テスト杯', minutes: '5', round: '1回戦' } });
    expect(r.wakeAt).toBe(START - HEAT_CREATE_LEAD_MS);
    await run(t, START - HEAT_CREATE_LEAD_MS, f);
    expect(f.created.map((c) => [c.players, c.cpuCount, c.statCap])).toEqual([[['a', 'd'], 2, 2800], [['b', 'c'], 2, 2800]]);
    expect(playerView(t, 'a', START).heat).toMatchObject({ round: 0, raceId: 'r_1', assignment: { ticket: 't_r_1_a', slot: 0 } });
    const pub = JSON.stringify(publicView(t, START));
    expect(pub).not.toContain('t_r_1_a'); // tickets never in the public view
    // heat 1: d beats a; heat 2: c wins but b... b wins, c never connected
    f.finish('r_1', ['d', 'a']);
    f.finish('r_2', ['c', 'b'], ['c']);
    await run(t, START + 60_000, f);
    expect(t.rounds[0]!.done).toBe(true);
    expect(t.rounds[0]!.heats[1]!.results).toEqual([
      { playerId: 'c', place: 1, noShow: true, advanced: false },
      { playerId: 'b', place: 2, noShow: false, advanced: true },
    ]);
    expect(t.rounds[1]).toMatchObject({ final: true, startAtMs: START + 60_000 + t.def.roundGapMs });
    expect(t.rounds[1]!.heats[0]!.playerIds).toEqual(['b', 'd']); // seeded by rating
    expect(playerView(t, 'a', START + 60_000)).toMatchObject({ eliminated: true });
    const fr = t.rounds[1]!.startAtMs;
    await run(t, fr - HEAT_CREATE_LEAD_MS, f);
    expect(f.pushes.filter((x) => x.vars.round === '決勝').map((x) => x.pid).sort()).toEqual(['b', 'd']);
    f.finish('r_3', ['d', 'b']);
    f.failAward.add('c');
    await run(t, fr + 60_000, f);
    expect(t.standings!.map((s) => [s.playerId, s.rank])).toEqual([['d', 1], ['b', 2], ['a', 3], ['c', 4]]);
    expect(f.awards.find((x) => x.pid === 'd')).toMatchObject({ rank: 1, reward: { freeCoins: 500 } });
    expect(f.awards.find((x) => x.pid === 'a')).toMatchObject({ rank: 3, reward: { freeCoins: 100 } });
    expect(t.status).toBe('paying');
    // c's prize keeps failing → dead letter after the retry budget, then the tournament finishes
    let dead: unknown[] = [];
    for (let i = 1, now = fr + 60_000; i < PAYOUT_MAX_ATTEMPTS; i++) {
      now += 10 * 60_000;
      dead = (await run(t, now, f)).newlyDead;
    }
    expect(dead).toEqual([{ itemId: 'c', error: 'player object down', attempts: PAYOUT_MAX_ATTEMPTS }]);
    expect(t.status).toBe('finished');
    expect(tournamentDeadLetters(t)).toHaveLength(1);
    f.failAward.clear();
    expect(await retryPayout(t, 'c', f.award.bind(f), fr + 3_600_000)).toEqual({ ok: true });
    expect(tournamentDeadLetters(t)).toEqual([]);
    expect(f.awards.filter((x) => x.pid === 'c')).toHaveLength(1);
  });

  it('a void heat advances the players who showed up by seed; a lost room times out', async () => {
    const t = newTournament<{ playerId: string }>(def(), 'ops', NOW);
    for (const [p, r] of [['a', 1700], ['b', 1600], ['c', 1500], ['d', 1400]] as const) register(t, reg(p, r), okInfo, NOW);
    const f = new FakeHeats();
    await run(t, CLOSE, f);
    await run(t, START - HEAT_CREATE_LEAD_MS, f);
    f.finish('r_1', [], [], 'void');
    f.outcomes.set('r_2', null); // room gone
    await run(t, START + 60_000, f);
    expect(t.rounds[0]!.heats[0]!.status).toBe('void');
    expect(t.rounds[0]!.heats[0]!.results!.filter((x) => x.advanced).map((x) => x.playerId)).toEqual(['a']);
    expect(t.rounds[0]!.heats[1]!.status).toBe('created'); // still waiting
    await run(t, START + 21 * 60_000, f);
    expect(t.rounds[0]!.heats[1]!.status).toBe('void');
    expect(t.rounds[1]!.heats[0]!.playerIds).toEqual(['a', 'b']);
  });

  it('shared ranks for players knocked out in the same round at the same place', () => {
    const t = newTournament<{ playerId: string }>(def(), 'ops', NOW);
    for (const [p, r] of [['a', 1700], ['b', 1600], ['c', 1500], ['d', 1400]] as const) register(t, reg(p, r), okInfo, NOW);
    t.rounds = [
      { index: 0, final: false, startAtMs: 0, notified: true, done: true, heats: [
        { id: '0-0', round: 0, index: 0, playerIds: ['a', 'd'], raceId: 'x', startAtMs: 0, trackId: 't', status: 'finished', createAttempts: 1, results: [{ playerId: 'a', place: 1, noShow: false, advanced: true }, { playerId: 'd', place: 2, noShow: false, advanced: false }] },
        { id: '0-1', round: 0, index: 1, playerIds: ['b', 'c'], raceId: 'y', startAtMs: 0, trackId: 't', status: 'finished', createAttempts: 1, results: [{ playerId: 'b', place: 1, noShow: false, advanced: true }, { playerId: 'c', place: 2, noShow: false, advanced: false }] },
      ] },
      { index: 1, final: true, startAtMs: 0, notified: true, done: true, heats: [
        { id: '1-0', round: 1, index: 0, playerIds: ['a', 'b'], raceId: 'z', startAtMs: 0, trackId: 't', status: 'finished', createAttempts: 1, results: [{ playerId: 'b', place: 1, noShow: false, advanced: false }, { playerId: 'a', place: 2, noShow: false, advanced: false }] },
      ] },
    ];
    expect(computeStandings(t).map((s) => [s.playerId, s.rank])).toEqual([['b', 1], ['a', 2], ['c', 3], ['d', 3]]);
  });

  it('heat results ignore CPU slots and order humans by finish', () => {
    const t = newTournament<{ playerId: string }>(def({ heatSize: 4, fieldSize: 6, advancePerHeat: 2 }), 'ops', NOW);
    for (const p of ['a', 'b', 'c']) register(t, reg(p, 1500), okInfo, NOW);
    const heat = { id: '0-0', round: 0, index: 0, playerIds: ['a', 'b', 'c'], raceId: 'r', startAtMs: 0, trackId: 't', status: 'created' as const, createAttempts: 1, results: null };
    // slots: a=0, b=1, c=2; CPUs 3..5 finish in between
    const res = heatResults(t, heat, { phase: 'final', final: { status: 'confirmed', order: [4, 2, 3, 0, 5, 1] }, slots: [{ slot: 0, playerId: 'a' }, { slot: 1, playerId: 'b' }, { slot: 2, playerId: 'c' }], noShows: [] });
    expect(res).toEqual([
      { playerId: 'c', place: 2, noShow: false, advanced: true },
      { playerId: 'a', place: 4, noShow: false, advanced: true },
      { playerId: 'b', place: 6, noShow: false, advanced: false },
    ]);
  });

  it('cancel stops the schedule (no prizes)', async () => {
    const t = newTournament<{ playerId: string }>(def(), 'ops', NOW);
    register(t, reg('a', 1), okInfo, NOW);
    register(t, reg('b', 1), okInfo, NOW);
    expect(cancelTournament(t, 'typo in the rules', NOW)).toBe(true);
    const f = new FakeHeats();
    expect((await run(t, START, f)).wakeAt).toBeNull();
    expect(f.created).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------- player + HTTP

/** In-memory TournamentBackend: the same pure functions the Durable Object drives. */
class MemoryTournamentBackend implements TournamentBackend {
  t = new Map<string, TournamentState<unknown>>();
  async list(now: number) { return [...this.t.values()].map((x) => publicView(x, now)); }
  async view(id: string, now: number) { const x = this.t.get(id); return x ? publicView(x, now) : null; }
  async published() { return null; }
  async me(id: string, p: string, now: number) { return playerView(this.need(id), p, now); }
  async register(id: string, p: string, horseId: string, e: TournamentEntryInfo, now: number) {
    const t = this.need(id);
    return { ...register(t, { playerId: p, displayName: e.displayName, horseId, rating: e.entry.rating.r, registeredAt: now, entry: e.entry }, e.info, now), ...playerView(t, p, now) };
  }
  async unregister(id: string, p: string, now: number) { return { removed: unregister(this.need(id), p, now) }; }
  async create(d: ReturnType<typeof def>, by: string, now: number) { this.t.set(d.id, newTournament(d, by, now)); return publicView(this.t.get(d.id)!, now); }
  async cancel(id: string, reason: string, _by: string, now: number) { cancelTournament(this.need(id), reason, now); return publicView(this.need(id), now); }
  need(id: string) { const x = this.t.get(id); if (!x) throw new AppError('NOT_FOUND'); return x; }
}

function ctx() {
  const repo = new MemoryPlayerRepo();
  const svc = new PlayerService(repo, { master: m, rng: seededRng(3), clock: () => NOW, verifiers: {} });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const backend = new MemoryTournamentBackend();
  const tournaments = new TournamentsService(() => m, backend, tournamentPlayersFrom(() => invoker), () => NOW);
  const c = {
    master: m, player: () => invoker, clock: () => NOW, tournaments,
    authenticate: async (req: Request) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
  } as unknown as AppContext;
  return { c, repo, svc, backend, tournaments };
}
async function call(c: AppContext, method: string, path: string, o: { user?: string; body?: unknown } = {}) {
  const res = await handle(new Request(`https://x${path}`, {
    method, headers: { 'content-type': 'application/json', ...(o.user ? { 'x-test-user': o.user } : {}) },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  }), {}, c);
  return { status: res.status, body: (await res.json()) as any };
}
async function withHorse(svc: PlayerService, repo: MemoryPlayerRepo, id: string) {
  await svc.bootstrap(id);
  const s = (await repo.get(id)) as PlayerState;
  const h = createHorseFromTemplate(s, m.templates[0]!, NOW);
  repo.put(s);
  return h.id;
}

describe('tournaments over HTTP (REQ-TOUR-001/002/009)', () => {
  it('admin create validates against master; players list, register, me, unregister', async () => {
    const { c, svc, repo, tournaments } = ctx();
    await expect(tournaments.adminCreate({ ...defInput(), trackIds: ['nope'] }, 'ops')).rejects.toThrow(/unknown track/);
    await expect(tournaments.adminCreate({ ...defInput(), prizes: [{ maxRank: 1, reward: { items: [{ itemId: 'nope', qty: 1 }] } }] }, 'ops')).rejects.toThrow(/unknown item/);
    await expect(tournaments.adminCreate({ ...defInput(), registrationOpensAtMs: NOW - 2 * 3600_000, registrationClosesAtMs: NOW - 3600_000 }, 'ops')).rejects.toThrow(/future/);
    await tournaments.adminCreate(defInput(), 'ops');
    const list = await call(c, 'GET', '/v1/tournaments');
    expect(list.body.tournaments.map((x: any) => [x.id, x.status])).toEqual([['cup_test', 'registration']]);
    expect((await call(c, 'GET', '/v1/tournaments/cup_test')).body).toMatchObject({ name: 'テスト杯', heatSize: 2, rounds: [] });
    expect((await call(c, 'GET', '/v1/tournaments/BAD!')).status).toBe(400);
    const horseId = await withHorse(svc, repo, 'p1');
    expect((await call(c, 'POST', '/v1/tournaments/cup_test/register', { user: 'p1', body: {} })).status).toBe(400);
    const r = await call(c, 'POST', '/v1/tournaments/cup_test/register', { user: 'p1', body: { horseId } });
    expect(r.body).toMatchObject({ registered: true, existing: false, horseId });
    expect((await call(c, 'GET', '/v1/tournaments/cup_test/me', { user: 'p1' })).body).toMatchObject({ registered: true, heat: null, standing: null });
    expect((await call(c, 'POST', '/v1/tournaments/cup_test/register', { user: 'p1', body: { horseId: 'h_missing' } })).body.error.code).toBe('HORSE_NOT_FOUND');
    expect((await call(c, 'POST', '/v1/tournaments/cup_test/unregister', { user: 'p1' })).body).toEqual({ removed: true });
    expect((await call(c, 'GET', '/v1/tournaments/nope_cup')).status).toBe(404);
  });

  it('prizes are paid once per tournament and kept in the player history', async () => {
    const { c, svc, repo } = ctx();
    await withHorse(svc, repo, 'p1');
    const before = ((await repo.get('p1')) as PlayerState).wallet.free;
    expect(await svc.tournamentClose('p1', 'cup_test', 1, { freeCoins: 500 }, 'テスト杯')).toEqual({ status: 'rewarded', reward: { freeCoins: 500 } });
    expect(await svc.tournamentClose('p1', 'cup_test', 1, { freeCoins: 500 }, 'テスト杯')).toMatchObject({ status: 'already' });
    expect(((await repo.get('p1')) as PlayerState).wallet.free).toBe(before + 500);
    const h = await call(c, 'GET', '/v1/tournaments/history/me', { user: 'p1' });
    expect(h.body.history).toEqual([{ tournamentId: 'cup_test', name: 'テスト杯', rank: 1, at: NOW, reward: { freeCoins: 500 } }]);
  });

  it('eligibility comes from the player object (class, ranked races, moderation)', async () => {
    const { svc, repo, tournaments } = ctx();
    await tournaments.adminCreate(defInput({ entry: { classIds: null, minRankedRaces: 3, styles: null } }), 'ops');
    const horseId = await withHorse(svc, repo, 'rookie');
    await expect(tournaments.register('rookie', 'cup_test', horseId)).rejects.toThrow(/ranked_races/);
  });
});
