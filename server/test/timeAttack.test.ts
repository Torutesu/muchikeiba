import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { handle, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { TimeAttackService, type GhostStore, type TaBoardPort } from '../src/race/timeAttack.js';
import {
  betterTa, buildTaBoards, jsonEqual, raceTimeMs, validateTaInputs, type GhostFile, type TaBoardFile, type TaEntry,
} from '../src/domain/timeAttack.js';
import type { Master } from '../src/domain/master.js';
import type { ReplayLog, VerifierOutput } from '../src/domain/schemas.js';
import type { VerifierClient } from '../src/domain/verifier.js';
import { jstMonthKey } from '../src/domain/time.js';

const T0 = Date.UTC(2026, 10, 5, 3);
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function setup(master: Master = m) {
  let now = T0;
  const svc = new PlayerService(new MemoryPlayerRepo(), { master, rng: seededRng(7), clock: () => now, verifiers: {} });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  return { svc, invoker, setNow: (t: number) => { now = t; }, now: () => now };
}

async function horseOf(svc: PlayerService, uid: string) {
  const t = await svc.tutorialDraw(uid, 'c:tut');
  return t.results.find((r: { horseId: string | null }) => r.horseId)!.horseId as string;
}

/** Fake verifier: finishes slot 0 at the given tick/frac, hash chosen by the test. */
class FakeVerifier implements VerifierClient {
  calls: ReplayLog[] = [];
  fail = false;
  constructor(public out: (log: ReplayLog) => VerifierOutput) {}
  async verify(log: ReplayLog) {
    this.calls.push(log);
    if (this.fail) throw new Error('verifier down');
    return this.out(log);
  }
}
const finishAt = (tick: number, frac: number, hash = HASH_A) => (): VerifierOutput => ({ resultHash: hash, order: [0], finishTicks: [tick], finishFracs: [frac], checksums: {} });

class MemBoard implements TaBoardPort {
  rows = new Map<string, TaEntry>();
  async upsert(e: TaEntry) {
    const k = `${e.seasonId}|${e.trackId}|${e.playerId}`;
    if (!betterTa(this.rows.get(k), e)) return false;
    this.rows.set(k, e);
    return true;
  }
  async rankOf(seasonId: string, trackId: string, playerId: string) {
    const b = buildTaBoards(seasonId, [...this.rows.values()], 0, 100);
    const r = b.ranks.find((x) => x.trackId === trackId && x.playerId === playerId);
    return r ? { rank: r.rank, total: r.total, generatedAt: 0 } : null;
  }
  async entries(seasonId: string, trackId: string, ids: string[]) {
    return [...this.rows.values()].filter((e) => e.seasonId === seasonId && e.trackId === trackId && ids.includes(e.playerId));
  }
  async snapshot(seasonId: string, trackId: string): Promise<TaBoardFile | null> {
    return buildTaBoards(seasonId, [...this.rows.values()], 0, 100).files.find((f) => f.body.trackId === trackId)?.body ?? null;
  }
}
class MemGhosts implements GhostStore {
  files = new Map<string, GhostFile>();
  async put(k: string, f: GhostFile) { this.files.set(k, structuredClone(f)); }
  async get(k: string) { return this.files.get(k) ?? null; }
}

function service(invoker: PlayerInvoker, verifier: VerifierClient, clock: () => number) {
  const board = new MemBoard();
  const ghosts = new MemGhosts();
  const ta = new TimeAttackService({ player: () => invoker, verifier, board, ghosts, ticketSecret: 'test-secret', clock });
  return { ta, board, ghosts };
}

const TRACK = 'kirameki_turf_2000';

describe('time attack: sessions (REQ-TA-001/002/004)', () => {
  it('issues a single-horse, normalised, server-seeded config', async () => {
    const { svc } = setup();
    const horseId = await horseOf(svc, 'p1');
    const r = await svc.taStart('p1', TRACK, horseId);
    expect(r.config.mode).toBe('timeattack');
    expect(r.config.entrants).toHaveLength(1);
    expect(r.config.entrants[0]!.slot).toBe(0);
    expect(r.config.entrants[0]!.playerId).toBe('p1');
    expect(r.config.raceId).toBe(`ta_${r.sessionId}`);
    const h = r.config.entrants[0]!.horse;
    expect(h.speed + h.stamina + h.burst + h.guts + h.temper).toBeLessThanOrEqual(m.progression.timeAttack.statCap);
    expect(r.expiresAt).toBe(T0 + m.progression.timeAttack.sessionTtlMs);
    const r2 = await svc.taStart('p1', TRACK, horseId);
    expect(r2.sessionId).not.toBe(r.sessionId);
    expect(r2.config.seed).not.toBe(r.config.seed);
  });

  it('enforces the daily attempt cap and resets at JST midnight', async () => {
    const master = structuredClone(m);
    master.templateById = m.templateById;
    master.progression.timeAttack.maxAttemptsPerDay = 2;
    const { svc, setNow } = setup(master);
    const horseId = await horseOf(svc, 'p1');
    await svc.taStart('p1', TRACK, horseId);
    const second = await svc.taStart('p1', TRACK, horseId);
    expect(second.attemptsLeft).toBe(0);
    await expect(svc.taStart('p1', TRACK, horseId)).rejects.toMatchObject({ code: 'TA_LIMIT_REACHED' });
    setNow(T0 + 24 * 3600_000);
    await expect(svc.taStart('p1', TRACK, horseId)).resolves.toBeTruthy();
  });

  it('rejects unknown tracks and inactive horses', async () => {
    const { svc } = setup();
    const horseId = await horseOf(svc, 'p1');
    await expect(svc.taStart('p1', 'nope', horseId)).rejects.toBeInstanceOf(AppError);
    await svc.retire('p1', horseId);
    await expect(svc.taStart('p1', TRACK, horseId)).rejects.toMatchObject({ code: 'HORSE_NOT_ACTIVE' });
  });
});

describe('time attack: input validation (REQ-TA-003)', () => {
  const { svc } = setup();
  const cfgP = horseOf(svc, 'v').then((h) => svc.taStart('v', TRACK, h)).then((r) => r.config);
  it('accepts a clean single-horse log', async () => {
    const cfg = await cfgP;
    expect(validateTaInputs(cfg, [[60, 0, 1], [1500, 0, 32], [1530, 0, 32]], 400)).toHaveLength(3);
  });
  it.each([
    ['another slot', [[60, 1, 1]]],
    ['server-only bits', [[60, 0, 64]]],
    ['zero command', [[60, 0, 0]]],
    ['duplicate tick', [[60, 0, 1], [60, 0, 32]]],
    ['unsorted', [[61, 0, 1], [60, 0, 32]]],
    ['after maxTicks', [[999999, 0, 32]]],
    ['malformed', [['x', 0, 1]]],
  ])('rejects %s', async (_n, inputs) => {
    const cfg = await cfgP;
    expect(() => validateTaInputs(cfg, inputs, 400)).toThrow(AppError);
  });
  it('rejects too many inputs', async () => {
    const cfg = await cfgP;
    const many = Array.from({ length: 5 }, (_, i) => [100 + i, 0, 32]);
    expect(() => validateTaInputs(cfg, many, 4)).toThrow(/too many/);
  });
});

describe('time attack: submit → verify → record (REQ-TA-003/005/007)', () => {
  it('records a verified time, a personal best, milestones once, and publishes ghost + board', async () => {
    const { svc, invoker, now } = setup();
    const v = new FakeVerifier(finishAt(1850, 32768));
    const { ta, board, ghosts } = service(invoker, v, now);
    const horseId = await horseOf(svc, 'p1');
    const s = await ta.start('p1', TRACK, horseId);
    const inputs = [[60, 0, 1], [1700, 0, 32]];
    const r = await ta.submit('p1', { sessionId: s.sessionId, token: s.token, inputs, resultHash: HASH_A, config: s.config });
    const gate = Number(s.config.ruleset.gateOpenTick);
    expect(r.finished).toBe(true);
    expect(r.timeMs).toBe((1850 - gate) * 50 + 25);
    expect(r.timeMs).toBe(raceTimeMs(s.config, 1850, 32768));
    expect(r.seasonBest).toBe(true);
    expect(r.allTimeBest).toBe(true);
    expect(r.published).toBe(true);
    expect(r.milestones.map((x) => x.id)).toContain('ta_first_clear');
    // the verifier re-simulated the ISSUED config with the submitted inputs
    expect(v.calls[0]!.config).toEqual(s.config);
    expect(v.calls[0]!.inputs).toEqual(inputs);
    // ghost and board entry
    const season = jstMonthKey(T0);
    const g = await ta.ghost(season, TRACK, 'p1');
    expect(g.meta.timeMs).toBe(r.timeMs);
    expect(g.log.inputs).toEqual(inputs);
    expect(ghosts.files.size).toBe(1);
    expect((await board.rankOf(season, TRACK, 'p1'))!.rank).toBe(1);
    const free1 = (await svc.view('p1')).wallet.free;

    // a slower second run: recorded, not a PB, no milestone again, board unchanged
    v.out = finishAt(1900, 0, HASH_B);
    const s2 = await ta.start('p1', TRACK, horseId);
    const r2 = await ta.submit('p1', { sessionId: s2.sessionId, token: s2.token, inputs, resultHash: HASH_B });
    expect(r2.seasonBest).toBe(false);
    expect(r2.previousSeasonBestMs).toBe(r.timeMs);
    expect(r2.milestones).toHaveLength(0);
    expect((await svc.view('p1')).wallet.free).toBe(free1);
    expect((await ta.ghost(season, TRACK, 'p1')).meta.timeMs).toBe(r.timeMs);

    const me = await ta.me('p1', TRACK);
    expect(me.seasonBest!.timeMs).toBe(r.timeMs);
    expect(me.rank!.rank).toBe(1);
  });

  it('a retried submit of a verified session returns the stored result without re-verifying', async () => {
    const { svc, invoker, now } = setup();
    const v = new FakeVerifier(finishAt(1850, 0));
    const { ta } = service(invoker, v, now);
    const s = await ta.start('p1', TRACK, await horseOf(svc, 'p1'));
    const body = { sessionId: s.sessionId, token: s.token, inputs: [[60, 0, 1]], resultHash: HASH_A };
    const a = await ta.submit('p1', body);
    const b = await ta.submit('p1', body);
    expect(b.timeMs).toBe(a.timeMs);
    expect(v.calls).toHaveLength(1);
    // a different hash for the same session is a second submission
    await expect(ta.submit('p1', { ...body, resultHash: HASH_B })).rejects.toMatchObject({ code: 'TA_SESSION_USED' });
  });

  it('rejects a run whose re-simulation differs (tampered client) and records nothing', async () => {
    const { svc, invoker, now } = setup();
    const v = new FakeVerifier(finishAt(1700, 0, HASH_B));
    const { ta, board, ghosts } = service(invoker, v, now);
    const s = await ta.start('p1', TRACK, await horseOf(svc, 'p1'));
    await expect(ta.submit('p1', { sessionId: s.sessionId, token: s.token, inputs: [[60, 0, 1]], resultHash: HASH_A })).rejects.toMatchObject({ code: 'TA_RESULT_MISMATCH' });
    expect((await ta.me('p1', TRACK)).seasonBest).toBeNull();
    expect(board.rows.size).toBe(0);
    expect(ghosts.files.size).toBe(0);
    // the rejection is persisted: the session cannot be retried with a "fixed" hash
    await expect(ta.submit('p1', { sessionId: s.sessionId, token: s.token, inputs: [[60, 0, 1]], resultHash: HASH_B })).rejects.toMatchObject({ code: 'TA_SESSION_USED' });
  });

  it('rejects an echoed config that differs from the issued one', async () => {
    const { svc, invoker, now } = setup();
    const { ta } = service(invoker, new FakeVerifier(finishAt(1800, 0)), now);
    const s = await ta.start('p1', TRACK, await horseOf(svc, 'p1'));
    const forged = structuredClone(s.config);
    forged.entrants[0]!.horse.speed = 1000;
    await expect(ta.submit('p1', { sessionId: s.sessionId, token: s.token, inputs: [], resultHash: HASH_A, config: forged })).rejects.toMatchObject({ code: 'TA_CONFIG_MISMATCH' });
    // key order does not matter
    const reorder = (x: unknown): unknown => Array.isArray(x) ? x.map(reorder)
      : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).reverse().map(([k, v]) => [k, reorder(v)])) : x;
    const reordered = reorder(s.config);
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(s.config));
    expect(jsonEqual(reordered, s.config)).toBe(true);
  });

  it('expired sessions, foreign tokens and other players are refused', async () => {
    const { svc, invoker, now, setNow } = setup();
    const { ta } = service(invoker, new FakeVerifier(finishAt(1800, 0)), now);
    const s = await ta.start('p1', TRACK, await horseOf(svc, 'p1'));
    await expect(ta.submit('p2', { sessionId: s.sessionId, token: s.token, inputs: [], resultHash: HASH_A })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(ta.submit('p1', { sessionId: 'other', token: s.token, inputs: [], resultHash: HASH_A })).rejects.toMatchObject({ code: 'TA_SESSION_EXPIRED' });
    setNow(s.expiresAt + 1);
    await expect(ta.submit('p1', { sessionId: s.sessionId, token: s.token, inputs: [], resultHash: HASH_A })).rejects.toMatchObject({ code: 'TA_SESSION_EXPIRED' });
  });

  it('verifier outage: VERIFIER_UNAVAILABLE and the same session can be submitted again', async () => {
    const { svc, invoker, now } = setup();
    const v = new FakeVerifier(finishAt(1800, 0));
    v.fail = true;
    const { ta } = service(invoker, v, now);
    const s = await ta.start('p1', TRACK, await horseOf(svc, 'p1'));
    const body = { sessionId: s.sessionId, token: s.token, inputs: [[60, 0, 1]], resultHash: HASH_A };
    await expect(ta.submit('p1', body)).rejects.toMatchObject({ code: 'VERIFIER_UNAVAILABLE' });
    v.fail = false;
    expect((await ta.submit('p1', body)).finished).toBe(true);
  });

  it('a DNF is verified but sets no time', async () => {
    const { svc, invoker, now } = setup();
    const { ta, board } = service(invoker, new FakeVerifier(() => ({ resultHash: HASH_A, order: [0], finishTicks: [-1], finishFracs: [-1], checksums: {} })), now);
    const s = await ta.start('p1', TRACK, await horseOf(svc, 'p1'));
    const r = await ta.submit('p1', { sessionId: s.sessionId, token: s.token, inputs: [], resultHash: HASH_A });
    expect(r.finished).toBe(false);
    expect(r.timeMs).toBeNull();
    expect(board.rows.size).toBe(0);
  });
});

describe('time attack: boards and ghosts (REQ-TA-006/008)', () => {
  const e = (playerId: string, finishTick: number, finishFrac: number, updatedAt = 0): TaEntry => ({
    playerId, seasonId: '2026-11', trackId: TRACK, timeMs: finishTick * 50, finishTick, finishFrac, displayName: playerId, titleId: null, horseName: 'H', updatedAt,
  });
  it('orders by time then by who got there first', () => {
    const b = buildTaBoards('2026-11', [e('c', 1800, 10), e('a', 1800, 5), e('b', 1790, 60000), e('d', 1800, 5, -1), { ...e('x', 1, 0), seasonId: '2026-10' }], 0, 2);
    expect(b.files).toHaveLength(1);
    expect(b.files[0]!.body.entries.map((r) => r.playerId)).toEqual(['b', 'd']);
    expect(b.files[0]!.body.total).toBe(4);
    expect(b.ranks.find((r) => r.playerId === 'c')!.rank).toBe(4);
  });
  it('a slower run never replaces a better entry', () => {
    expect(betterTa(e('a', 1800, 5), e('a', 1800, 6))).toBe(false);
    expect(betterTa(e('a', 1800, 5), e('a', 1800, 4))).toBe(true);
    expect(betterTa(undefined, e('a', 1800, 5))).toBe(true);
  });

  it('lists top, friend and own ghosts with download paths', async () => {
    const { svc, invoker, now } = setup();
    const v = new FakeVerifier(finishAt(1850, 0));
    const { ta } = service(invoker, v, now);
    for (const [uid, tick] of [['p1', 1850], ['p2', 1820], ['p3', 1900]] as const) {
      v.out = finishAt(tick, 0);
      const s = await ta.start(uid, TRACK, await horseOf(svc, uid));
      await ta.submit(uid, { sessionId: s.sessionId, token: s.token, inputs: [], resultHash: HASH_A });
    }
    // p1 and p3 are friends
    const fr = (svc as unknown as { tx: PlayerService['tx'] }).tx.bind(svc);
    await fr('p1', null, (s) => { s.friends.ids.push('p3'); });
    const top = await ta.ghosts('p1', TRACK, 'top');
    expect(top.ghosts.map((g) => g.playerId)).toEqual(['p2', 'p1', 'p3']);
    expect(top.ghosts[0]!.path).toBe(`/v1/time-attack/ghosts/${jstMonthKey(T0)}/${TRACK}/p2`);
    expect((await ta.ghosts('p1', TRACK, 'friends')).ghosts.map((g) => g.playerId)).toEqual(['p3']);
    expect((await ta.ghosts('p1', TRACK, 'me')).ghosts.map((g) => g.playerId)).toEqual(['p1']);
    await expect(ta.ghost(jstMonthKey(T0), TRACK, 'nobody')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('time attack: HTTP routes', () => {
  it('start/submit/me/ghosts round trip and board name validation', async () => {
    const { svc, invoker, now } = setup();
    const { ta } = service(invoker, new FakeVerifier(finishAt(1850, 0)), now);
    const ctx = {
      master: m, authenticate: async (r: Request) => r.headers.get('x-test-user') ?? '', player: () => invoker, timeAttack: ta, clock: now,
      leaderboard: { board: async (season: string, board: string) => ({ season, board }), myRank: async () => null },
    } as unknown as AppContext;
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await handle(new Request(`https://x${path}`, { method, headers: { 'x-test-user': 'p1', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), {}, ctx);
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    const horseId = await horseOf(svc, 'p1');
    const st = await call('POST', '/v1/time-attack/start', { trackId: TRACK, horseId });
    expect(st.status).toBe(200);
    const sub = await call('POST', '/v1/time-attack/submit', { sessionId: st.json.sessionId, token: st.json.token, inputs: [[60, 0, 1]], resultHash: HASH_A });
    expect(sub.status).toBe(200);
    expect(sub.json.finished).toBe(true);
    expect((await call('GET', `/v1/time-attack/${TRACK}/me`)).json.seasonBest).toBeTruthy();
    expect((await call('GET', `/v1/time-attack/${TRACK}/ghosts?kind=me`)).status).toBe(200);
    expect((await call('GET', `/v1/time-attack/${TRACK}/ghosts?kind=everyone`)).status).toBe(400);
    expect((await call('GET', `/v1/leaderboards/current/ta-${TRACK}`)).status).toBe(200);
    expect((await call('GET', '/v1/leaderboards/current/ta-BAD!')).status).toBe(400);
    const bad = await call('POST', '/v1/time-attack/submit', { sessionId: st.json.sessionId, token: st.json.token, inputs: [], resultHash: 'zz' });
    expect(bad.status).toBe(400);
  });
});
