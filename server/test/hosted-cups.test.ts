import { describe, expect, it } from 'vitest';
import { m, makeConfig } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import type { AppError } from '../src/domain/errors.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import type { Master } from '../src/domain/master.js';
import {
  CUP_CODE_ALPHABET, DEFAULT_HOSTED_CUPS, computeCupStandings, cupIdFor, hostedCupsProblems, makeCupCode, normalizeCupCode, validateCupName,
  type CupState, type HostedCupsConfig,
} from '../src/domain/hostedCups.js';
import { HostedCupsService, MemoryCupBackend, type CupPorts } from '../src/domain/hostedCupService.js';
import { handle, type AppContext, type PlayerInvoker, type RaceEntry } from '../src/http/app.js';
import { createRace, settleRace } from '../src/race/orchestrate.js';
import { liveRaceOf } from '../src/domain/spectate.js';
import { DELETION_STEPS, deletionSnapshot, runAccountDeletion, type DeletionPorts } from '../src/domain/accountDeletion.js';
import type { HeatOutcome } from '../src/domain/tournaments.js';
import type { RaceStartConfig } from '../src/domain/schemas.js';
import type { RoomConditions } from '../src/domain/presets.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 11, 8, 3);
const cfg = m.progression.hostedCups as HostedCupsConfig;
const withCfg = (patch: Partial<HostedCupsConfig>): Master => ({ ...m, progression: { ...m.progression, hostedCups: { ...cfg, ...patch } } as Master['progression'] });
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as AppError).code; } return 'NO_ERROR'; };
const RULES: RoomConditions = { trackId: 'aoba_turf_1600', going: 'good', night: false, weather: 'sunny', temperatureC: 18, windKmh: 0 };

function world(master: Master = m) {
  let now = T0;
  const kpi: KpiRecord[] = [];
  const repo = new MemoryPlayerRepo();
  const svc = new PlayerService(repo, { master, rng: seededRng(4), clock: () => now, verifiers: {}, onKpi: (_id, recs) => { kpi.push(...recs); } });
  // one call at a time per player, like a Durable Object's input gate
  const gates = new Map<string, Promise<unknown>>();
  const invoker = (uid: string): PlayerInvoker => ({ invoke: (async (method: string, ...args: unknown[]) => {
    const run = (gates.get(uid) ?? Promise.resolve()).then(() => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args));
    gates.set(uid, run.catch(() => undefined));
    return run;
  }) as PlayerInvoker['invoke'] });
  const started: { raceId: string; playerIds: string[]; conditions: RoomConditions }[] = [];
  const outcomes = new Map<string, HeatOutcome | null>();
  const busy = new Set<string>();
  const ports: Omit<CupPorts<RaceEntry>, 'releaseCode'> = {
    refreshEntry: async (pid, horseId) => (await svc.raceEntry(pid, horseId)) as RaceEntry,
    startRace: async (spec) => {
      for (const p of spec.playerIds) if (busy.has(p)) throw Object.assign(new Error(), { code: 'ALREADY_IN_RACE' });
      started.push({ raceId: spec.raceId, playerIds: spec.playerIds, conditions: spec.conditions });
      return { raceId: spec.raceId, startAtMs: now + 10_000 };
    },
    raceOutcome: async (raceId) => outcomes.get(raceId) ?? null,
    notifyClosed: async (pid, n) => { await invoker(pid).invoke('cupClosed', pid, n); },
  };
  const teams = new Map<string, string[]>();
  const backend = new MemoryCupBackend<RaceEntry>(() => master, ports, () => now);
  const cups = new HostedCupsService<RaceEntry>(() => master, backend, invoker, () => now, async (teamId) => teams.get(teamId) ?? []);
  let n = 0;
  const k = () => `c:t:${n++}`;
  const player = async (id: string, name = id.toUpperCase()) => {
    await svc.bootstrap(id);
    await svc.grantPartner(id, 'アイボウ', k());
    const s = await svc.state(id);
    s.profile.displayName = name;
    await repo.put(s);
    return s.horses[0]!.id;
  };
  const horse = async (id: string) => (await svc.state(id)).horses[0]!.id;
  const befriend = async (a: string, b: string) => {
    for (const [x, y] of [[a, b], [b, a]] as const) { const s = await svc.state(x); s.friends.ids.push(y); await repo.put(s); }
  };
  const mute = async (a: string, b: string) => { await svc.feedMute(a, b, true); };
  const body = (patch: Record<string, unknown> = {}) => ({ cupName: '金曜の夜カップ', capacity: 4, format: 'single' as const, opensAt: now, closesAt: now + 3 * HOUR, conditions: RULES, ...patch });
  /** Host creates a cup and the others join by code; returns the cup id and code. */
  const cupWith = async (host: string, others: string[], patch: Record<string, unknown> = {}) => {
    const c = await cups.create(host, { ...body(patch), horseId: await horse(host) } as never, k());
    for (const o of others) await cups.join(o, { code: c.cup.code!, horseId: await horse(o) }, k());
    return { cupId: c.cup.cupId, code: c.cup.code! };
  };
  /** Confirmed outcome of a started race: `order` = player ids in finish order. */
  const finish = (raceId: string, order: string[], opts: { noShow?: string[]; void?: boolean } = {}) => {
    const slots = order.map((p, i) => ({ slot: i, playerId: p }));
    outcomes.set(raceId, { phase: 'finished', final: opts.void ? { status: 'void', order: [] } : { status: 'confirmed', order: slots.map((s) => s.slot) }, slots, noShows: slots.filter((s) => opts.noShow?.includes(s.playerId)).map((s) => s.slot) });
  };
  return { svc, repo, kpi, backend, cups, ports, started, outcomes, busy, teams, k, player, horse, befriend, mute, body, cupWith, finish, invoker, now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('§42 config and codes (REQ-CUP-003, §42.4)', () => {
  it('the shipped config is valid; ceilings are enforced', () => {
    expect(hostedCupsProblems(m)).toEqual([]);
    expect(cfg).toMatchObject({ enabled: true, minCapacity: 4, maxCapacity: 8, maxActivePerHost: 2, joinCodeAttemptsPerHour: 10 });
    expect(hostedCupsProblems(withCfg({ maxCapacity: 20 }))).toEqual(expect.arrayContaining([expect.stringContaining('maxCapacity')]));
    expect(hostedCupsProblems(withCfg({ pointsByPlace: [5, 7] }))).toEqual(expect.arrayContaining([expect.stringContaining('pointsByPlace')]));
    expect(hostedCupsProblems(withCfg({ joinCodeAttemptsPerHour: 1000 }))).toHaveLength(1);
    expect(hostedCupsProblems({ progression: { ...m.progression, hostedCups: { ...DEFAULT_HOSTED_CUPS, extra: 1 } } } as never)).not.toEqual([]);
  });

  it('codes are 8 characters of a 31-letter alphabet from a cryptographic source, no look-alikes; input is normalized', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const c = makeCupCode();
      expect(c).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{8}$/);
      seen.add(c);
    }
    expect(seen.size).toBe(2000);
    expect(CUP_CODE_ALPHABET).not.toMatch(/[01IOL]/);
    // a biased byte source still yields only alphabet letters (rejection sampling, no modulo bias)
    expect(makeCupCode(() => new Uint8Array(16).fill(255).map((_, i) => (i % 2 ? 255 : 30)))).toBe('99999999');
    expect(normalizeCupCode('k7pm-q2xd')).toBe('K7PMQ2XD');
    expect(normalizeCupCode(' K7PM Q2XD ')).toBe('K7PMQ2XD');
    expect(normalizeCupCode('ＫＭＰＭＱ２ＸＤ')).toBe('KMPMQ2XD');
    expect(normalizeCupCode('K7PM-Q2X0')).toBeNull();
    expect(normalizeCupCode('K7PM')).toBeNull();
  });

  it('the cup id is derived from host + idempotency key', async () => {
    expect(await cupIdFor('a', 'k')).toBe(await cupIdFor('a', 'k'));
    expect(await cupIdFor('a', 'k')).not.toBe(await cupIdFor('b', 'k'));
    expect(await cupIdFor('a', 'k')).toMatch(/^cup_[a-z2-7]{16}$/);
  });

  it('REQ-CUP-002: cup names follow the display-name rules', () => {
    expect(validateCupName(m, '  金曜の夜カップ ')).toBe('金曜の夜カップ');
    expect(() => validateCupName(m, '')).toThrow();
    expect(() => validateCupName(m, 'あ'.repeat(21))).toThrow();
    expect(() => validateCupName(m, 'join www.example.com')).toThrow();
    expect(() => validateCupName(m, 'see https://x')).toThrow();
    expect(() => validateCupName(m, 'a\u0007b')).toThrow();
    const ng = m.ng.exact[0] ?? m.ng.contains[0]!;
    expect(() => validateCupName(m, ng)).toThrow(/NG_NAME/);
  });
});

describe('§42 create (REQ-CUP-001/007)', () => {
  it('idempotent per key; a different body under the same key is a conflict; the host is the first entrant', async () => {
    const w = world();
    const h = await w.player('h');
    const b = { ...w.body(), horseId: h };
    const a = await w.cups.create('h', b, 'c:k1');
    expect(a.created).toBe(true);
    expect(a.cup).toMatchObject({ role: 'host', status: 'open', capacity: 4, racesTotal: 1, entrants: [{ playerId: 'h', displayName: 'H', horseName: 'アイボウ' }] });
    expect(a.cup.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const again = await w.cups.create('h', b, 'c:k1');
    expect(again).toMatchObject({ created: false, cup: { cupId: a.cup.cupId, code: a.cup.code } });
    expect(await code(w.cups.create('h', { ...b, capacity: 6 }, 'c:k1'))).toBe('CONFLICT');
    expect((await w.cups.list('h')).active).toHaveLength(1);
    expect(w.kpi.filter((r) => r.name === 'cup_create')).toEqual([expect.objectContaining({ s1: 'single', s2: 'solo', count: 4 })]);
  });

  it('validates capacity, format, window and rules (the room-conditions checks); usePreset copies the saved preset', async () => {
    const w = world();
    const h = await w.player('h');
    const t = w.now();
    const bad = async (patch: Record<string, unknown>) => code(w.cups.create('h', { ...w.body(patch), horseId: h } as never, w.k()));
    expect(await bad({ capacity: 3 })).toBe('BAD_REQUEST');
    expect(await bad({ capacity: 9 })).toBe('BAD_REQUEST');
    expect(await bad({ closesAt: t + 5 * MIN })).toBe('BAD_REQUEST');
    expect(await bad({ closesAt: t + 100 * HOUR })).toBe('BAD_REQUEST');
    expect(await bad({ opensAt: t + 200 * HOUR, closesAt: t + 201 * HOUR })).toBe('BAD_REQUEST');
    expect(await bad({ conditions: { ...RULES, trackId: 'nope' } })).toBe('NOT_FOUND');
    expect(await bad({ conditions: { ...RULES, going: 'sloppy' } })).toBe('BAD_REQUEST');
    expect(await bad({ cupName: 'http://spam' })).toBe('INVALID_NAME');
    expect(await code(w.cups.create('h', { ...w.body(), conditions: undefined, usePreset: true, horseId: h } as never, w.k()))).toBe('BAD_REQUEST');
    await w.svc.setRoomConditions('h', { ...RULES, trackId: 'kirameki_turf_2000' });
    const c = await w.cups.create('h', { ...w.body(), conditions: undefined, usePreset: true, horseId: h } as never, w.k());
    expect(c.cup.conditions.trackId).toBe('kirameki_turf_2000');
    // nothing was reserved by the failed attempts
    expect((await w.cups.list('h')).active).toHaveLength(1);
  });

  it('limits: hosted cups per host, cups per player; closed cups stop counting', async () => {
    const w = world();
    await w.player('h');
    const a = await w.cupWith('h', []);
    await w.cupWith('h', []);
    expect(await code(w.cupWith('h', []))).toBe('CUP_LIMIT');
    await w.cups.leave('h', a.cupId); // host leaves = cancelled
    await w.cupWith('h', []);
    // entries: 4 at most (hosted included)
    const w2 = world();
    for (const p of ['p', 'a', 'b', 'c', 'd']) await w2.player(p);
    const cs = [await w2.cupWith('a', []), await w2.cupWith('b', []), await w2.cupWith('c', []), await w2.cupWith('d', [])];
    for (const c of cs.slice(0, 4)) await w2.cups.join('p', { code: c.code, horseId: await w2.horse('p') }, w2.k());
    const e = await w2.cupWith('a', []);
    expect(await code(w2.cups.join('p', { code: e.code, horseId: await w2.horse('p') }, w2.k()))).toBe('CUP_LIMIT');
  });

  it('a player scheduled for deletion or banned cannot create', async () => {
    const w = world();
    const h = await w.player('h');
    const s = await w.svc.state('h');
    s.deletion = { status: 'scheduled', requestedAt: 0, deleteAt: w.now() + HOUR, steps: [], attempts: 0 } as never;
    await w.repo.put(s);
    expect(await code(w.cups.create('h', { ...w.body(), horseId: h }, w.k()))).toBe('DELETION_PENDING');
  });
});

describe('§42 join (REQ-CUP-003/005/006)', () => {
  it('by code: preview, join once, the repeat is joined: false; the code is shown to members only', async () => {
    const w = world();
    await w.player('h'); await w.player('a'); await w.player('x');
    const { cupId, code: c } = await w.cupWith('h', []);
    const pre = await w.cups.lookup('a', c.toLowerCase());
    expect(pre).toMatchObject({ cupId, cupName: '金曜の夜カップ', hostName: 'H', entrants: 1, capacity: 4, role: 'none' });
    expect(pre).not.toHaveProperty('code');
    const j = await w.cups.join('a', { code: c, horseId: await w.horse('a') }, w.k());
    expect(j.joined).toBe(true);
    expect(j.cup.code).toBe(c);
    expect((await w.cups.join('a', { code: c, horseId: await w.horse('a') }, w.k())).joined).toBe(false);
    expect(await code(w.cups.get('x', cupId))).toBe('NOT_FOUND');
    expect(w.kpi.filter((r) => r.name === 'cup_join')).toEqual([expect.objectContaining({ s1: 'code', s2: 'single' })]);
  });

  it('wrong codes say nothing; attempts are capped per hour (successes and failures alike)', async () => {
    const w = world();
    await w.player('h'); await w.player('a');
    const { code: c } = await w.cupWith('h', []);
    expect(await code(w.cups.lookup('a', 'AAAA-AAAA'))).toBe('CUP_CODE_INVALID');
    expect(await code(w.cups.lookup('a', 'nonsense'))).toBe('CUP_CODE_INVALID');
    for (let i = 0; i < 7; i++) await code(w.cups.lookup('a', `BBBB-BBB${'CDEFGHJ'[i]}`));
    await w.cups.lookup('a', c); // the 10th
    expect(await code(w.cups.lookup('a', c))).toBe('RATE_LIMITED');
    expect(await code(w.cups.join('a', { code: c, horseId: await w.horse('a') }, w.k()))).toBe('RATE_LIMITED');
    w.advance(HOUR);
    expect((await w.cups.join('a', { code: c, horseId: await w.horse('a') }, w.k())).joined).toBe(true);
  });

  it('the last slot: two joiners at once, exactly one gets in; the other is CUP_FULL and keeps no reservation', async () => {
    const w = world();
    for (const p of ['h', 'a', 'b', 'c', 'd']) await w.player(p);
    const { cupId, code: c } = await w.cupWith('h', ['a', 'b']);
    const [r1, r2] = await Promise.allSettled([
      w.cups.join('c', { code: c, horseId: await w.horse('c') }, w.k()),
      w.cups.join('d', { code: c, horseId: await w.horse('d') }, w.k()),
    ]);
    const ok = [r1, r2].filter((r) => r.status === 'fulfilled');
    const failed = [r1, r2].filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect((failed[0]!.reason as AppError).code).toBe('CUP_FULL');
    expect(w.backend.cups.get(cupId)!.entrants).toHaveLength(4);
    const loser = r1.status === 'rejected' ? 'c' : 'd';
    expect((await w.cups.list(loser)).active).toHaveLength(0);
  });

  it('REQ-CUP-006: muted either way → cannot join (same answer as a bad code)', async () => {
    const w = world();
    for (const p of ['h', 'a', 'b', 'c']) await w.player(p);
    const { code: c } = await w.cupWith('h', ['a']);
    await w.mute('a', 'b'); // an entrant muted the joiner
    expect(await code(w.cups.lookup('b', c))).toBe('CUP_CODE_INVALID');
    expect(await code(w.cups.join('b', { code: c, horseId: await w.horse('b') }, w.k()))).toBe('CUP_CODE_INVALID');
    await w.mute('c', 'h'); // the joiner muted the host
    expect(await code(w.cups.join('c', { code: c, horseId: await w.horse('c') }, w.k()))).toBe('CUP_CODE_INVALID');
    expect((await w.cups.list('b')).active).toHaveLength(0);
  });

  it('REQ-CUP-004: invitations — mutual friends and the branch; others / muted are skipped; invitees join by id', async () => {
    const w = world();
    for (const p of ['h', 'f', 'g', 'x', 't1', 't2']) await w.player(p);
    await w.svc.registerDevice('f', 'token-for-f-device', 'ios');
    await w.befriend('h', 'f'); await w.befriend('h', 'g');
    await w.mute('g', 'h');
    const { cupId } = await w.cupWith('h', []);
    const s = await w.svc.state('h'); s.team = { teamId: 'tm1', role: 'member' } as never; await w.repo.put(s);
    w.teams.set('tm1', ['h', 't1', 't2']);
    expect(await code(w.cups.join('f', { cupId, horseId: await w.horse('f') }, w.k()))).toBe('NOT_FOUND');
    const r = await w.cups.invite('h', cupId, { friendIds: ['f', 'g', 'x'] });
    expect(r.invited).toBe(1); // g muted the host (dropped on g's side), x is not a friend
    expect((await w.cups.invite('h', cupId, { team: true })).invited).toBe(2);
    expect((await w.cups.list('f')).invites).toEqual([expect.objectContaining({ cupId, cupName: '金曜の夜カップ', hostName: 'H' })]);
    expect((await w.svc.state('f')).push?.outbox?.some((o) => o.templateId === 'cup_invite')).toBe(true);
    expect(await code(w.cups.invite('f', cupId, { friendIds: ['h'] }))).toBe('NOT_FOUND');
    const j = await w.cups.join('f', { cupId, horseId: await w.horse('f') }, w.k());
    expect(j.joined).toBe(true);
    expect((await w.cups.list('f')).invites).toEqual([]);
    expect(w.kpi.filter((k) => k.name === 'cup_join').map((k) => k.s1)).toEqual(['invite']);
    expect(await code(w.cups.invite('f', cupId, { friendIds: ['h'] }))).toBe('NOT_HOST');
  });
});

describe('§42 races and standings (REQ-CUP-008/009/010)', () => {
  it('single race: only the host starts, in the window, with enough entrants; joins close once started; the result gives trophies', async () => {
    const w = world();
    for (const p of ['h', 'a', 'b', 'late']) await w.player(p);
    const { cupId, code: c } = await w.cupWith('h', [], { opensAt: w.now() + HOUR, closesAt: w.now() + 4 * HOUR });
    expect(await code(w.cups.start('h', cupId))).toBe('CUP_NOT_READY'); // not open yet
    w.advance(HOUR);
    expect(await code(w.cups.start('h', cupId))).toBe('CUP_NOT_READY'); // too few
    for (const p of ['a', 'b']) await w.cups.join(p, { code: c, horseId: await w.horse(p) }, w.k());
    expect(await code(w.cups.start('a', cupId))).toBe('NOT_HOST');
    expect((await w.cups.get('h', cupId)).canStart).toBe(true);
    const r = await w.cups.start('h', cupId);
    expect(r).toMatchObject({ raceId: `cup-${cupId}-0-0`, raceIndex: 0 });
    expect(w.started[0]).toEqual({ raceId: r.raceId, playerIds: ['h', 'a', 'b'], conditions: RULES });
    expect(await code(w.cups.join('late', { code: c, horseId: await w.horse('late') }, w.k()))).toBe('CUP_CLOSED');
    expect(await code(w.cups.invite('h', cupId, { friendIds: ['late'] }))).toBe('CUP_CLOSED');
    expect(await code(w.cups.start('h', cupId))).toBe('CUP_NOT_READY'); // the race is running
    await w.backend.tickAll(); // no result yet
    expect((await w.cups.get('h', cupId)).status).toBe('running');
    w.finish(r.raceId, ['b', 'h', 'a']);
    await w.backend.tickAll();
    const v = await w.cups.get('h', cupId);
    expect(v).toMatchObject({ status: 'finished', partial: false, code: null, racesDone: 1 });
    expect(v.standings.map((s) => [s.playerId, s.rank, s.trophy])).toEqual([['b', 1, 'gold'], ['h', 2, 'silver'], ['a', 3, 'bronze']]);
    // players: out of the active list, into the history, trophy counted, profile shows counts only
    const b = await w.cups.list('b');
    expect(b.active).toEqual([]);
    expect(b.history[0]).toMatchObject({ cupId, cupName: '金曜の夜カップ', rank: 1, status: 'finished', trophy: 'gold', entrants: 3 });
    expect(b.trophies).toEqual({ gold: 1, silver: 0, bronze: 0 });
    expect((await w.svc.publicProfile('b') as { cupTrophies?: unknown }).cupTrophies).toEqual({ gold: 1, silver: 0, bronze: 0 });
    expect(w.kpi.filter((k) => k.name === 'cup_finish').map((k) => [k.s1, k.place])).toEqual(expect.arrayContaining([['finished', 1], ['finished', 2], ['finished', 3]]));
    // the code no longer works
    expect(await code(w.cups.lookup('late', c))).toBe('CUP_CODE_INVALID');
    // a repeated notice is a no-op (once per cup)
    await w.svc.cupClosed('b', { cupId, cupName: 'x', format: 'single', status: 'finished', partial: false, cancelReason: null, rank: 1, points: 0, entrants: 3, at: 0, role: 'entrant' });
    expect((await w.cups.list('b')).trophies.gold).toBe(1);
  });

  it('best_of_3: points by place; a void race does not count and is re-run as the next attempt; no-shows score 0', async () => {
    const w = world();
    for (const p of ['h', 'a', 'b']) await w.player(p);
    const { cupId } = await w.cupWith('h', ['a', 'b'], { format: 'best_of_3' });
    let r = await w.cups.start('h', cupId);
    w.finish(r.raceId, ['a', 'h', 'b']);
    await w.backend.tickAll();
    r = await w.cups.start('h', cupId);
    expect(r.raceId).toBe(`cup-${cupId}-1-0`);
    w.finish(r.raceId, [], { void: true });
    await w.backend.tickAll();
    expect((await w.cups.get('h', cupId)).racesDone).toBe(1);
    r = await w.cups.start('h', cupId);
    expect(r.raceId).toBe(`cup-${cupId}-1-1`);
    w.finish(r.raceId, ['h', 'b', 'a'], { noShow: ['a'] });
    await w.backend.tickAll();
    r = await w.cups.start('h', cupId);
    w.finish(r.raceId, ['h', 'a', 'b']);
    await w.backend.tickAll();
    const v = await w.cups.get('a', cupId);
    expect(v.status).toBe('finished');
    // h: 7 + 10 + 10 = 27, a: 10 + 0 + 7 = 17, b: 5 + 7 + 5 = 17 → a ahead of b on the best place (1st)
    expect(v.standings.map((s) => [s.playerId, s.points, s.places])).toEqual([['h', 27, [2, 1, 1]], ['a', 17, [1, null, 2]], ['b', 17, [3, 2, 3]]]);
  });

  it('a race without a result is void after the timeout; an entrant busy in another race blocks the start', async () => {
    const w = world();
    for (const p of ['h', 'a']) await w.player(p);
    const { cupId } = await w.cupWith('h', ['a']);
    w.busy.add('a');
    expect(await code(w.cups.start('h', cupId))).not.toBe('NO_ERROR');
    expect((await w.cups.get('h', cupId)).races).toEqual([]);
    w.busy.clear();
    await w.cups.start('h', cupId);
    w.advance(cfg.raceTimeoutMinutes * MIN + 20_000);
    await w.backend.tickAll();
    const v = await w.cups.get('h', cupId);
    expect(v.races[0]!.status).toBe('void');
    expect(v.canStart).toBe(true);
  });

  it('a retired horse leaves its rider out of the race (refreshed entries)', async () => {
    const w = world();
    for (const p of ['h', 'a', 'b']) await w.player(p);
    const { cupId } = await w.cupWith('h', ['a', 'b']);
    const s = await w.svc.state('b'); s.horses[0]!.status = 'retired'; await w.repo.put(s);
    await w.cups.start('h', cupId);
    expect(w.started[0]!.playerIds).toEqual(['h', 'a']);
  });

  it('standings ties: points, best place, last race, join order', () => {
    const c = { format: 'best_of_3', entrants: [{ playerId: 'x' }, { playerId: 'y' }, { playerId: 'z' }], races: [
      { index: 0, status: 'done', places: { x: 2, y: 1, z: 3 } }, { index: 1, status: 'done', places: { x: 1, y: 2, z: 3 } },
    ] } as unknown as CupState;
    expect(computeCupStandings(m, c).map((s) => s.playerId)).toEqual(['x', 'y', 'z']); // 17 each for x/y; same best; x last race 1st
  });
});

describe('§42 leaving, expiry, ops delete (REQ-CUP-011/012/015)', () => {
  it('an entrant leaves before the first race (slot freed), withdraws after; the host leaving cancels the cup', async () => {
    const w = world();
    for (const p of ['h', 'a', 'b']) await w.player(p);
    const { cupId, code: c } = await w.cupWith('h', ['a', 'b'], { format: 'best_of_3' });
    expect(await w.cups.leave('a', cupId)).toMatchObject({ left: true, cancelled: false, cup: null });
    expect((await w.cups.list('a')).active).toEqual([]);
    expect(await w.cups.leave('a', cupId)).toMatchObject({ left: false });
    await w.cups.join('a', { code: c, horseId: await w.horse('a') }, w.k());
    const r = await w.cups.start('h', cupId);
    w.finish(r.raceId, ['a', 'b', 'h']);
    await w.backend.tickAll();
    const out = await w.cups.leave('b', cupId);
    expect(out.left).toBe(true);
    expect(out.cup!.entrants.find((e) => e.playerId === 'b')!.withdrawn).toBe(true);
    const host = await w.cups.leave('h', cupId);
    expect(host).toMatchObject({ left: true, cancelled: true });
    for (const p of ['h', 'a', 'b']) {
      const l = await w.cups.list(p);
      expect(l.active).toEqual([]);
      expect(l.history[0]).toMatchObject({ cupId, status: 'cancelled', cancelReason: 'host_left', trophy: null });
    }
    expect((await w.cups.list('a')).trophies).toEqual({ gold: 0, silver: 0, bronze: 0 });
  });

  it('the window closes: no race → cancelled (expired); some races → finished as partial; then removed after keepDays', async () => {
    const w = world();
    for (const p of ['h', 'a']) await w.player(p);
    const one = await w.cupWith('h', ['a']);
    const two = await w.cupWith('h', ['a'], { format: 'best_of_3' });
    const r = await w.cups.start('h', two.cupId);
    w.finish(r.raceId, ['h', 'a']);
    await w.backend.tickAll();
    w.advance(3 * HOUR);
    await w.backend.tickAll();
    expect(w.backend.cups.get(one.cupId)).toMatchObject({ status: 'cancelled', cancelReason: 'expired' });
    expect(w.backend.cups.get(two.cupId)).toMatchObject({ status: 'finished', partial: true });
    const hist = (await w.cups.list('a')).history;
    expect(hist.map((x) => [x.status, x.partial])).toEqual(expect.arrayContaining([['cancelled', false], ['finished', true]]));
    expect((await w.cups.list('a')).trophies.silver).toBe(1);
  });

  it('a missed close notice never blocks the limits for good (refs expire after the window + a day)', async () => {
    const w = world();
    await w.player('h');
    const ports = w.ports as { notifyClosed: CupPorts<RaceEntry>['notifyClosed'] };
    ports.notifyClosed = async () => { throw new Error('down'); };
    await w.cupWith('h', []); await w.cupWith('h', []);
    w.advance(3 * HOUR);
    await w.backend.tickAll();
    expect(await code(w.cupWith('h', []))).toBe('CUP_LIMIT');
    w.advance(24 * HOUR);
    expect(await code(w.cupWith('h', []))).toBe('NO_ERROR');
  });

  it('ops delete cancels the cup and tells everyone', async () => {
    const w = world();
    for (const p of ['h', 'a']) await w.player(p);
    const { cupId } = await w.cupWith('h', ['a']);
    expect(await w.cups.adminDelete(cupId)).toMatchObject({ status: 'cancelled', cancelReason: 'ops_deleted' });
    expect((await w.cups.list('a')).history[0]).toMatchObject({ cupId, cancelReason: 'ops_deleted' });
    expect(await code(w.cups.adminDelete('cup_zzzzzzzzzzzzzzzz'))).toBe('NOT_FOUND');
  });
});

describe('§42 unranked (REQ-CUP-013) and the race path (REQ-CUP-008)', () => {
  it('a cup race result changes no rating, season, coins, missions, pass, stats or rival — it is only recorded', async () => {
    const w = world();
    for (const p of ['a', 'b']) await w.player(p);
    const before = structuredClone(await w.svc.state('a'));
    const c = makeConfig(2, 'cup', 0) as RaceStartConfig;
    const humans = c.entrants.map((e, i) => ({ ...e, playerId: ['a', 'b'][i]! }));
    const conf = { ...c, raceId: 'cup-cup_x-0-0', entrants: humans };
    const res = settleRace(conf, { status: 'confirmed', order: [0, 1], hash: 'f'.repeat(64), via: 'consensus', suspects: [] }, {}, { v: 1, config: conf, endTick: 100, inputs: [] });
    const out = await w.svc.applyRace('a', res.a!);
    expect(out).toMatchObject({ coins: 0, rewarded: false, seasonPoints: 0 });
    const after = await w.svc.state('a');
    expect(after.wallet).toEqual(before.wallet);
    expect(after.rating).toEqual(before.rating);
    expect(after.season).toEqual(before.season);
    expect(after.seasonPass).toEqual(before.seasonPass);
    expect(after.missions).toEqual(before.missions);
    expect(after.stats).toEqual(before.stats);
    expect(after.rival ?? null).toEqual(before.rival ?? null);
    expect(after.appliedRaces?.['cup-cup_x-0-0']).toBeDefined();
    expect(after.myReplays?.recent[0]?.raceId).toBe('cup-cup_x-0-0');
    expect(w.kpi.filter((k) => k.name === 'race_finish').map((k) => k.s1)).toEqual(['cup']);
    await w.svc.applyRace('a', res.a!); // a repeated settle changes nothing
    expect((await w.svc.state('a')).myReplays?.recent).toHaveLength(1);
  });

  it('createRace(mode cup) uses the cup rules, humans only, no bond bump; watchable by friends only', async () => {
    const p = await (async () => { const w = world(); await w.player('a'); await w.player('b'); return [await w.svc.raceEntry('a', await w.horse('a')), await w.svc.raceEntry('b', await w.horse('b'))]; })();
    const bonded = p.map((e) => ({ ...e, visual: { ...(e as { visual?: object }).visual, bondLevel: 10 } })) as RaceEntry[];
    const mm = { ...m, progression: { ...m.progression, bond: { ...m.progression.bond, friendRoomEffect: { ...m.progression.bond.friendRoomEffect, enabled: true, permillePerLevel: 5, maxPermille: 30 } } } } as Master;
    const created = await createRace(mm, { mode: 'cup', humans: bonded, cpuCount: 0, cpuLevel: 3, rng: seededRng(1), now: T0, ticketSecret: 's', roomPreset: { ...RULES, going: 'soft' }, raceId: 'cup-cup_x-0-0' });
    expect(created.config).toMatchObject({ raceId: 'cup-cup_x-0-0', mode: 'cup' });
    expect(created.config.track.id).toBe('aoba_turf_1600');
    expect(created.config.entrants.every((e) => e.kind === 'human')).toBe(true);
    expect(created.config.entrants[0]!.horse).toEqual(expect.objectContaining({ speed: bonded[0]!.horse.speed }));
    expect(liveRaceOf(created, null)!.visibility).toBe('friends');
    expect(JSON.stringify(created.config)).toContain('soft');
    // the same entries in a friend room do get the bond bump (so the cup's equality above is meaningful)
    const friend = await createRace(mm, { mode: 'friend', humans: bonded, cpuCount: 0, cpuLevel: 3, rng: seededRng(1), now: T0, ticketSecret: 's', roomPreset: RULES, raceId: 'r-f' });
    expect(friend.config.entrants[0]!.horse.speed).toBeGreaterThan(bonded[0]!.horse.speed);
  });
});

describe('§42 account deletion (REQ-CUP-016)', () => {
  it('the hosted cup is cancelled, an entry before the first race removed, after it anonymised', async () => {
    const w = world();
    for (const p of ['h', 'a', 'z']) await w.player(p);
    const hosted = await w.cupWith('z', ['a']);
    const pre = await w.cupWith('h', ['z']);
    const raced = await w.cupWith('a', ['z', 'h'], { format: 'best_of_3' });
    const r = await w.cups.start('a', raced.cupId);
    w.finish(r.raceId, ['z', 'a', 'h']);
    await w.backend.tickAll();
    const snap = deletionSnapshot(await w.svc.state('z'));
    expect(snap.cupIds?.sort()).toEqual([hosted.cupId, pre.cupId, raced.cupId].sort());
    expect(DELETION_STEPS).toContain('cups');
    const ports = {
      start: (uid: string) => w.svc.deletionStart(uid), snapshot: (uid: string) => w.svc.deletionSnapshot(uid), markStep: async (uid: string, st: string) => { await w.svc.deletionMarkStep(uid, st as never); },
      friends: { removeFriend: async () => undefined, dropOutgoing: async () => undefined, dropIncoming: async () => undefined },
      directory: { forget: async () => undefined }, leaderboards: { forget: async () => undefined, deleteGhosts: async () => undefined },
      cups: { forget: (cupId: string, uid: string) => w.backend.forget(cupId, uid, '退会したプレイヤー') },
      finalize: (uid: string) => w.svc.deletionFinalize(uid), retain: async () => undefined, wipe: async (uid: string) => { await w.repo.delete?.(uid); },
    } as unknown as DeletionPorts;
    const s = await w.svc.state('z'); s.deletion = { status: 'scheduled', requestedAt: 0, deleteAt: w.now(), steps: [], attempts: 0 } as never; await w.repo.put(s);
    await runAccountDeletion(ports, 'z', w.now());
    expect(w.backend.cups.get(hosted.cupId)).toMatchObject({ status: 'cancelled', cancelReason: 'host_deleted' });
    expect(w.backend.cups.get(pre.cupId)!.entrants.map((e) => e.playerId)).toEqual(['h']);
    const anon = w.backend.cups.get(raced.cupId)!.entrants.find((e) => e.playerId === 'z')!;
    expect(anon).toMatchObject({ displayName: '退会したプレイヤー', horseName: '', withdrawn: true });
    expect((await w.cups.list('a')).history[0]).toMatchObject({ cupId: hosted.cupId, cancelReason: 'host_deleted' });
  });
});

describe('§42 HTTP', () => {
  it('routes, idempotency keys, names never translated in English', async () => {
    const w = world();
    for (const p of ['u', 'v']) await w.player(p, 'ゆう');
    let who = 'u';
    const c = { master: m, authenticate: async () => who, player: w.invoker, clock: w.now, hostedCups: w.cups } as unknown as AppContext;
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await handle(new Request(`https://x${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), {}, c);
      return { status: res.status, body: (await res.json()) as any };
    };
    expect((await call('GET', '/v1/cups')).body).toMatchObject({ enabled: true, active: [], limits: { maxActivePerHost: 2 } });
    const b = { ...w.body({ cupName: '1着' }), horseId: await w.horse('u') };
    expect((await call('POST', '/v1/cups', b)).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await call('POST', '/v1/cups', { ...b, extra: 1 }, { 'idempotency-key': 'k1' })).status).toBe(400);
    const cr = await call('POST', '/v1/cups', b, { 'idempotency-key': 'k1', 'accept-language': 'en' });
    expect(cr.status, JSON.stringify(cr.body)).toBe(200);
    expect(cr.body.cup).toMatchObject({ cupName: '1着', hostName: 'ゆう' });
    expect((await call('POST', '/v1/cups', b, { 'idempotency-key': 'k1' })).body.created).toBe(false);
    who = 'v';
    expect((await call('POST', '/v1/cups/lookup', { code: cr.body.cup.code }, { 'accept-language': 'en' })).body.cupName).toBe('1着');
    const j = await call('POST', '/v1/cups/join', { code: cr.body.cup.code, horseId: await w.horse('v') }, { 'idempotency-key': 'j1' });
    expect(j.body.joined).toBe(true);
    expect((await call('POST', '/v1/cups/join', { horseId: 'h1' }, { 'idempotency-key': 'j2' })).status).toBe(400);
    expect((await call('GET', `/v1/cups/${cr.body.cup.cupId}`)).body.role).toBe('entrant');
    expect((await call('POST', `/v1/cups/${cr.body.cup.cupId}/start`)).body.error.code).toBe('NOT_HOST');
    expect((await call('POST', `/v1/cups/${cr.body.cup.cupId}/leave`)).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await call('POST', `/v1/cups/${cr.body.cup.cupId}/leave`, undefined, { 'idempotency-key': 'l1' })).body.left).toBe(true);
    expect((await call('GET', '/v1/cups/not-a-cup')).status).toBe(404);
    expect((await call('POST', '/v1/cups/lookup', { code: 'ZZZZ-ZZZZ' })).body.error.code).toBe('CUP_CODE_INVALID');
    const off = { ...c, hostedCups: undefined } as AppContext;
    expect((await handle(new Request('https://x/v1/cups'), {}, off)).status).toBe(404);
  });
});
