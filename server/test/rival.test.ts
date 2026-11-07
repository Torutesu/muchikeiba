import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import type { AppError } from '../src/domain/errors.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import type { Master } from '../src/domain/master.js';
import {
  cpuRivalFor, pairWeek, rivalProblems, weekEndMs, weekIdAt, RIVAL_HARD_LIMITS, type RivalConfig, type RivalEntry,
} from '../src/domain/rival.js';
import { MemoryRivalRegistry, RivalService, rivalPlayersFrom } from '../src/domain/rivalService.js';
import { resolveBundle } from '../src/ops/config.js';
import { handle, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { settleRace } from '../src/race/orchestrate.js';
import { makeConfig } from './helpers.js';
import { runAccountDeletion } from '../src/domain/accountDeletion.js';

const JST = 9 * 3600_000;
const jst = (y: number, mo: number, d: number, h = 12, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - JST;
const DAY = 86_400_000;
const cfg = m.progression.rival as RivalConfig;
const withRival = (patch: Partial<RivalConfig>, base: Master = m): Master => ({ ...base, progression: { ...base.progression, rival: { ...cfg, ...patch } } as Master['progression'] });
// 2026-12-07 is a Monday; the game day rolls over at 04:00 JST from 2026-12-01 on
const W1 = '2026-12-07', W2 = '2026-12-14', W3 = '2026-12-21';

function world(master: Master = m, start = jst(2026, 12, 8)) {
  let now = start;
  const kpi: KpiRecord[] = [];
  const reg = new MemoryRivalRegistry(() => master, () => now);
  let svcRef: PlayerService | null = null;
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svcRef as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svcRef, args)) as PlayerInvoker['invoke'] };
  const rival = new RivalService(() => master, rivalPlayersFrom(() => invoker), reg);
  const repo = new MemoryPlayerRepo();
  const svc = new PlayerService(repo, {
    master, rng: seededRng(5), clock: () => now, verifiers: {}, onKpi: (_id, recs) => { kpi.push(...recs); },
    onRival: (u) => rival.apply(u),
  });
  svcRef = svc;
  let n = 0;
  const k = () => `c:t:${n++}`;
  const names = ['アイボウ', 'ハヤテ', 'ミカヅキ', 'カゼノコ', 'ホシゾラ'];
  let ni = 0;
  const player = async (id: string, rating = 1500) => {
    await svc.bootstrap(id);
    await svc.grantPartner(id, names[ni++ % names.length]!, k());
    const s = await svc.state(id);
    s.rating.r = rating;
    await repo.put(s);
  };
  let race = 0;
  /** A confirmed ranked race; `field` = every human's place (the same object both rivals receive). */
  const ranked = async (field: Record<string, number>, mode: 'ranked' | 'friend' = 'ranked') => {
    const raceId = `r${race++}`;
    const f = Object.entries(field).map(([playerId, place]) => ({ playerId, place }));
    for (const [pid, place] of Object.entries(field)) {
      await svc.applyRace(pid, { raceId, mode, place, fieldSize: 12, newRating: null, void: false, humans: f.length, field: f });
    }
    return raceId;
  };
  return { svc, repo, reg, rival, kpi, k, player, ranked, now: () => now, at: (t: number) => { now = t; }, advance: (ms: number) => { now += ms; } };
}
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as AppError).code; } return 'NO_ERROR'; };
const entry = (playerId: string, rating: number, classId = 'C', blocked: string[] = []): RivalEntry => ({
  playerId, classId, rating, rankedAt: 0, blocked, updatedAt: 0,
  card: { displayName: playerId, titleId: null, classId, silks: { pattern: 'solid', colors: ['#000'], cap: 'solid' }, partner: null },
});

describe('REQ-RIVAL-001 the game week', () => {
  it('starts on Monday at the game-day rollover (04:00 JST) and lasts 7 game days', () => {
    expect(weekIdAt(m, jst(2026, 12, 7, 4, 0))).toBe(W1);
    expect(weekIdAt(m, jst(2026, 12, 7, 3, 59))).toBe('2026-11-30'); // still Sunday's game day
    expect(weekIdAt(m, jst(2026, 12, 13, 23, 0))).toBe(W1);
    expect(weekIdAt(m, jst(2026, 12, 14, 3, 59))).toBe(W1);
    expect(weekIdAt(m, jst(2026, 12, 14, 4, 0))).toBe(W2);
    expect(weekEndMs(m, W1)).toBe(jst(2026, 12, 14, 4, 0));
    expect(weekIdAt(withRival({ weekStartsOn: 0 }), jst(2026, 12, 8))).toBe('2026-12-06');
  });
});

describe('REQ-RIVAL-003 pairing (pure, deterministic)', () => {
  const es = [entry('a', 1500), entry('b', 1510), entry('c', 1490), entry('d', 1505), entry('e', 1900), entry('x', 1500, 'B')];
  it('same seed + same candidates → same pairs whatever the input order; classes never mix; a far rating is left over', () => {
    const p1 = pairWeek(cfg, W2, es);
    const p2 = pairWeek(cfg, W2, [...es].reverse());
    expect([...p1.entries()].sort()).toEqual([...p2.entries()].sort());
    for (const [a, b] of p1) { expect(p1.get(b)).toBe(a); expect(es.find((e) => e.playerId === a)!.classId).toBe(es.find((e) => e.playerId === b)!.classId); }
    expect(p1.has('e')).toBe(false); // 400 above everyone in class C
    expect(p1.has('x')).toBe(false); // alone in class B
    expect(p1.size).toBe(4);
  });
  it('blocked either way and withdrawn players are never paired', () => {
    const p = pairWeek(cfg, W2, [entry('a', 1500, 'C', ['b']), entry('b', 1500)]);
    expect(p.size).toBe(0);
    expect(pairWeek(cfg, W2, [entry('a', 1500), entry('b', 1500, 'C', ['a'])]).size).toBe(0);
    expect(pairWeek(cfg, W2, [entry('a', 1500), entry('b', 1500)], new Set(['b'])).size).toBe(0);
  });
  it('the CPU rival is a pure function of the week and the player', () => {
    expect(cpuRivalFor(cfg, W2, 'p').id).toBe(cpuRivalFor(cfg, W2, 'p').id);
    const ids = new Set(Array.from({ length: 40 }, (_, i) => cpuRivalFor(cfg, W2, `p${i}`).id));
    expect(ids.size).toBeGreaterThan(1);
  });
});

describe('REQ-RIVAL-012 config validation', () => {
  it('the shipped config is valid; rewards above ¥200, streak-free order and limits are enforced', () => {
    expect(rivalProblems(m)).toEqual([]);
    expect(rivalProblems(withRival({ rewards: { ...cfg.rewards, win: { freeCoins: RIVAL_HARD_LIMITS.freeCoinsPerWeek + 1 } } })).join()).toMatch(/at most 100/);
    expect(rivalProblems(withRival({ rewards: { ...cfg.rewards, lose: { freeCoins: 50 } } })).join()).toMatch(/win ≥ draw ≥ lose/);
    expect(rivalProblems(withRival({ rewards: { ...cfg.rewards, no_contest: { freeCoins: 15 } } })).join()).toMatch(/no_contest/);
    expect(rivalProblems(withRival({ challengesPerDay: 99 })).join()).toMatch(/challengesPerDay/);
    expect(rivalProblems(withRival({ rewards: { ...cfg.rewards, win: { freeCoins: 20, items: [{ itemId: 'gacha_ticket', qty: 1 }] } as never } })).join()).toMatch(/rewards/);
    expect(rivalProblems(withRival({ cpuRivals: [cfg.cpuRivals[0]!, cfg.cpuRivals[0]!] })).join()).toMatch(/duplicate/);
  });
  it('remote config is validated too', () => {
    expect(() => resolveBundle(m, { progression: { rival: { ...cfg, rewards: { ...cfg.rewards, win: { freeCoins: 500 } } } } })).toThrow(/at most 100/);
  });
});

describe('REQ-RIVAL-002..007 a human pair over two weeks', () => {
  async function paired() {
    const w = world();
    await w.player('a', 1500);
    await w.player('b', 1520);
    // week 1: both race ranked → candidates for week 2
    await w.ranked({ a: 3, b: 5 });
    expect(w.reg.store(W1).entries.has('a')).toBe(true);
    w.at(jst(2026, 12, 15));
    return w;
  }
  it('pairs last week\'s candidates; the confirmed field gives the higher finisher a point on both sides', async () => {
    const w = await paired();
    const va = await w.rival.view('a');
    expect(va).toMatchObject({ enabled: true, weekId: W2, rival: { kind: 'human', playerId: 'b', card: { displayName: expect.any(String), partner: { name: 'ハヤテ' } } } });
    // the card is the public copy only
    expect(Object.keys((va as any).rival.card).sort()).toEqual(['classId', 'displayName', 'partner', 'silks', 'titleId']);
    await w.rival.view('b');
    await w.ranked({ a: 2, b: 7 });
    await w.ranked({ a: 9, b: 4 });
    await w.ranked({ a: 1, b: 2, c: 3 });
    await w.ranked({ a: 6 }); // the rival was not in this race: no point
    const a2 = await w.rival.view('a');
    const b2 = await w.rival.view('b');
    expect((a2 as any).score).toMatchObject({ me: 2, them: 1, rankedRaces: 4 });
    expect((b2 as any).score).toMatchObject({ me: 1, them: 2, rankedRaces: 3 });
    // week 1 (no human candidate yet) was settled against the CPU rival the registry assigned then
    expect(w.kpi.filter((x) => x.name === 'rival_race' && x.s1 === 'human').length).toBe(6);
  });
  it('races before the first sync of the week are counted once the rival is known', async () => {
    const w = await paired();
    await w.ranked({ a: 2, b: 7 });
    await w.ranked({ a: 2, b: 7 });
    expect((await w.rival.view('a') as any).score).toMatchObject({ me: 2, them: 0 });
  });
  it('a void race and a re-delivered race never score', async () => {
    const w = await paired();
    await w.rival.view('a');
    await w.svc.applyRace('a', { raceId: 'v1', mode: 'ranked', place: 0, fieldSize: 12, newRating: null, void: true, humans: 2 });
    const id = await w.ranked({ a: 1, b: 2 });
    await w.svc.applyRace('a', { raceId: id, mode: 'ranked', place: 1, fieldSize: 12, newRating: null, void: false, humans: 2, field: [{ playerId: 'a', place: 1 }, { playerId: 'b', place: 2 }] });
    expect((await w.rival.view('a') as any).score).toMatchObject({ me: 1, them: 0, rankedRaces: 1 });
  });
  it('settlement at week end: fixed free coins, once, a title for the first week won, the result sheet', async () => {
    const w = await paired();
    await w.rival.view('a'); await w.rival.view('b');
    for (let i = 0; i < 3; i++) await w.ranked({ a: 1, b: 2 });
    w.at(jst(2026, 12, 21, 4, 0)); // Monday 04:00 = week 3
    const before = (await w.svc.state('a')).wallet;
    const va = await w.rival.view('a') as any;
    expect(va.result).toMatchObject({ weekId: W2, outcome: 'win', me: 3, them: 0, freeCoins: cfg.rewards.win.freeCoins, newTitles: ['rival_first'] });
    const after = (await w.svc.state('a')).wallet;
    expect(after.free - before.free).toBe(cfg.rewards.win.freeCoins);
    expect(after.paid).toBe(before.paid);
    expect((await w.svc.state('a')).titles).toContain('rival_first');
    // a second sync never pays again; the sheet stays until seen
    await w.rival.view('a');
    expect((await w.svc.state('a')).wallet.free).toBe(after.free);
    await w.rival.seen('a', W2);
    expect((await w.rival.view('a') as any).result).toBeNull();
    const vb = await w.rival.view('b') as any;
    expect(vb.result).toMatchObject({ outcome: 'lose', freeCoins: cfg.rewards.lose.freeCoins, newTitles: [] });
    expect(vb.record).toMatchObject({ weeksWon: 0, weeksPlayed: 1 });
    expect(w.kpi.filter((x) => x.name === 'rival_week_result' && x.s3 === W2).map((x) => x.s1).sort()).toEqual(['lose', 'win']);
  });
  it('a week with fewer than minRacesForResult own ranked races pays nothing', async () => {
    const w = await paired();
    await w.ranked({ a: 1, b: 2 });
    w.at(jst(2026, 12, 22));
    const free = (await w.svc.state('a')).wallet.free;
    expect((await w.rival.view('a') as any).result).toMatchObject({ outcome: 'not_enough', freeCoins: 0 });
    expect((await w.svc.state('a')).wallet.free).toBe(free);
  });
  it('REQ-RIVAL-005: a tied score is broken by the time-attack bests of the week (the registry copy of both)', async () => {
    const w = await paired();
    await w.rival.view('a'); await w.rival.view('b');
    for (let i = 0; i < 3; i++) await w.ranked({ a: 1, b: 2 });
    for (let i = 0; i < 3; i++) await w.ranked({ a: 2, b: 1 });
    // verified runs recorded on each object (the same path PlayerService.taRecord takes)
    const ta = async (pid: string, trackId: string, ms: number) => {
      const s = await w.svc.state(pid);
      const { noteRivalTa } = await import('../src/domain/rival.js');
      await w.svc.tx(pid, null, (st, now) => { noteRivalTa(m, st, trackId, ms, now); });
      void s;
    };
    await ta('a', 'aoba_turf_1600', 70_000);
    await ta('b', 'aoba_turf_1600', 71_000);
    await ta('b', 'kirameki_turf_2000', 88_000);
    const v = await w.rival.view('a') as any;
    expect(v.timeAttack.find((x: any) => x.trackId === 'aoba_turf_1600')).toMatchObject({ me: 70_000, rival: 71_000, faster: 'me' });
    expect(v.score).toMatchObject({ me: 3, them: 3, taMe: 1, taThem: 0 });
    w.at(jst(2026, 12, 22));
    expect((await w.rival.view('a') as any).result).toMatchObject({ outcome: 'win', taMe: 1, taThem: 0 });
    expect((await w.rival.view('b') as any).result).toMatchObject({ outcome: 'lose' });
  });
  it('REQ-RIVAL-013: the rival taking my course this week queues one 「ライバルが記録を更新」 push, inside the daily cap', async () => {
    const w = await paired();
    await w.svc.registerDevice('a', 'tok_aaaaaaaa', 'ios');
    await w.rival.view('a'); await w.rival.view('b');
    const { noteRivalTa } = await import('../src/domain/rival.js');
    const ta = (pid: string, ms: number) => w.svc.tx(pid, null, (st, now) => { noteRivalTa(m, st, 'aoba_turf_1600', ms, now); });
    await ta('a', 70_000);
    await ta('b', 71_000); // slower: nothing
    await ta('b', 69_000); // took the course
    await ta('b', 68_000); // already notified for this course this week
    const out = (await w.svc.state('a')).push!.outbox;
    expect(out.filter((x) => x.templateId === 'rival_record')).toHaveLength(1);
    expect(out.find((x) => x.templateId === 'rival_record')!.vars).toMatchObject({ name: (await w.svc.state('b')).profile.displayName, course: '青葉競馬場 芝1600m' });
  });
});

describe('REQ-RIVAL-003 CPU rival', () => {
  it('a player with no candidate last week gets the named CPU rival; ranked places score against its target place', async () => {
    const w = world(m, jst(2026, 12, 15));
    await w.player('solo');
    const v = await w.rival.view('solo') as any;
    const cpu = cpuRivalFor(cfg, W2, 'solo');
    expect(v.rival).toMatchObject({ kind: 'cpu', cpuId: cpu.id, name: cpu.name, personality: cpu.personality });
    await w.ranked({ solo: cpu.targetPlace });
    await w.ranked({ solo: cpu.targetPlace + 1 });
    expect((await w.rival.view('solo') as any).score).toMatchObject({ me: 1, them: 1 });
    // the late joiner keeps the same CPU all week
    expect((await w.rival.view('solo') as any).rival.cpuId).toBe(cpu.id);
  });
});

describe('REQ-RIVAL-011 privacy: opt out, block, deletion', () => {
  async function pairedWorld() {
    const w = world();
    await w.player('a'); await w.player('b');
    await w.ranked({ a: 1, b: 2 });
    w.at(jst(2026, 12, 15));
    await w.rival.view('a'); await w.rival.view('b');
    return w;
  }
  it('opting out dissolves the pair for both (no contest), hides the card and is never paired again', async () => {
    const w = await pairedWorld();
    for (let i = 0; i < 3; i++) await w.ranked({ a: 1, b: 2 });
    await w.rival.setOptOut('b', true);
    const va = await w.rival.view('a') as any;
    expect(va.rival).toMatchObject({ kind: 'human', dissolved: true, playerId: null, card: null });
    expect(va.challenge).toBeNull();
    expect((await w.rival.view('b') as any)).toMatchObject({ optOut: true, rival: null });
    await w.ranked({ a: 1, b: 2 }); // after the dissolution: no point
    w.at(jst(2026, 12, 22));
    expect((await w.rival.view('a') as any).result).toMatchObject({ outcome: 'no_contest', freeCoins: cfg.rewards.no_contest.freeCoins, me: 3 });
    // week 3: b raced in week 2 but is opted out → a gets the CPU
    expect((await w.rival.view('a') as any).rival.kind).toBe('cpu');
    expect(w.reg.store(W2).entries.has('b')).toBe(false);
  });
  it('blocking the rival uses the one block list, dissolves the pair and they are never paired again', async () => {
    const w = await pairedWorld();
    expect(await w.rival.block('a')).toMatchObject({ blocked: 'b', dissolved: true });
    expect((await w.svc.state('a') as { teamFeed?: { muted: string[] } }).teamFeed?.muted).toContain('b');
    expect((await w.rival.view('b') as any).rival).toMatchObject({ dissolved: true, card: null });
    for (let i = 0; i < 2; i++) await w.ranked({ a: 1, b: 2 });
    w.at(jst(2026, 12, 22));
    await w.rival.view('a');
    expect((await w.rival.view('a') as any).rival.kind).toBe('cpu');
    expect((await w.rival.view('b') as any).rival.kind).toBe('cpu');
  });
  it('an account scheduled for deletion is withdrawn; the deletion run forgets it in the registry', async () => {
    const w = await pairedWorld();
    await w.ranked({ a: 1, b: 2 });
    // the transaction that schedules the deletion sends the withdrawal (post-transaction hook)
    await w.svc.tx('b', null, (s, now) => { s.deletion = { status: 'scheduled', requestedAt: now, deleteAt: now + DAY, steps: [], attempts: 0 } as never; });
    expect((await w.rival.view('a') as any).rival).toMatchObject({ dissolved: true, card: null });
    expect(w.reg.store(W2).withdrawnSet.has('b')).toBe(true);
    await w.reg.forget(W2, 'b');
    expect(w.reg.store(W2).tas.has('b')).toBe(false);
  });
  it('the deletion run has a rival step', async () => {
    const forgot: string[] = [];
    const ports = {
      snapshot: async () => ({ steps: [], friends: [], incoming: [], outgoing: [], teamId: null, eventIds: [], ghostKeys: [], invite: null, postedIn: [] }) as never,
      markStep: async () => undefined, friends: { removeFriend: async () => 0, dropOutgoing: async () => 0, dropIncoming: async () => 0 },
      directory: { forget: async () => undefined }, leaderboards: { forget: async () => undefined, deleteGhosts: async () => undefined },
      rival: { forget: async (uid: string) => { forgot.push(uid); } },
      finalize: async () => ({ rev: 1 }) as never, retain: async () => undefined, wipe: async () => undefined,
    };
    const r = await runAccountDeletion(ports as never, 'gone', 0);
    expect(r.done).toContain('rival');
    expect(forgot).toEqual(['gone']);
  });
});

describe('REQ-RIVAL-008 ライバルと走る (friend-room challenge, unranked)', () => {
  it('invites only this week\'s live rival, within the daily cap; the race shows but never scores', async () => {
    const w = world();
    await w.player('a'); await w.player('b'); await w.player('c');
    await w.ranked({ a: 1, b: 2 });
    w.at(jst(2026, 12, 15));
    await w.rival.view('a'); await w.rival.view('b');
    expect(await w.rival.challenge('a', 'room1')).toMatchObject({ ok: true, rivalId: 'b' });
    expect((await w.svc.state('b')).friends.invites).toEqual([expect.objectContaining({ from: 'a', passphrase: 'room1' })]);
    expect(await code(w.rival.challenge('c', 'room2'))).toBe('NOT_ELIGIBLE'); // c's rival is a CPU
    await w.rival.challenge('a', 'room1');
    await w.rival.challenge('a', 'room1');
    expect(await code(w.rival.challenge('a', 'room1'))).toBe('RIVAL_CHALLENGE_LIMIT');
    await w.ranked({ a: 1, b: 2 }, 'friend');
    const v = await w.rival.view('a') as any;
    expect(v.score).toMatchObject({ me: 0, them: 0 });
    expect(v.recent[0]).toMatchObject({ mode: 'friend', me: 1, them: 2, point: null });
  });
});

describe('REQ-RIVAL-004 the confirmed result carries the human field', () => {
  it('settleRace puts every human place on every rider (ranked and friend), never on a void race', () => {
    const config = makeConfig(3);
    const humans = config.entrants.filter((e) => e.kind === 'human');
    const order = config.entrants.map((e) => e.slot);
    const out = settleRace(config, { status: 'confirmed', order, hash: 'h', via: 'consensus', suspects: [] }, {});
    for (const h of humans) expect(out[h.playerId!]!.field).toEqual(humans.map((x) => ({ playerId: x.playerId, place: order.indexOf(x.slot) + 1 })));
    const v = settleRace(config, { status: 'void', order: [], hash: '', via: 'none', suspects: [] }, {});
    expect(v[humans[0]!.playerId!]!.field).toBeUndefined();
  });
});

describe('REQ-RIVAL-009 HTTP routes', () => {
  it('GET /v1/rival, PUT settings, POST block / challenge / results seen', async () => {
    const w = world();
    await w.player('u'); await w.player('v');
    await w.ranked({ u: 1, v: 2 });
    w.at(jst(2026, 12, 15));
    const svc = w.svc;
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
    const members = new Set(['room9']);
    const c = { master: m, authenticate: async () => 'u', player: () => invoker, clock: w.now, rival: w.rival, match: { friendMember: async (p: string) => members.has(p) } } as unknown as AppContext;
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await handle(new Request(`https://x${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), {}, c);
      return { status: res.status, body: (await res.json()) as any };
    };
    expect((await call('GET', '/v1/rival')).body).toMatchObject({ enabled: true, rival: { kind: 'human', playerId: 'v' } });
    expect((await call('POST', '/v1/rival/challenge', { passphrase: 'nope' })).body.error.code).toBe('NOT_ELIGIBLE');
    const ch = await call('POST', '/v1/rival/challenge', { passphrase: 'room9' });
    expect(ch.body, JSON.stringify(ch.body)).toMatchObject({ ok: true });
    expect((await call('PUT', '/v1/rival/settings', { optOut: 'yes' })).status).toBe(400);
    expect((await call('POST', '/v1/rival/results/bad/seen')).status).toBe(400);
    expect((await call('POST', '/v1/rival/block')).body).toMatchObject({ blocked: 'v' });
    expect((await call('PUT', '/v1/rival/settings', { optOut: true })).body).toEqual({ optOut: true });
    expect((await call('GET', '/v1/rival')).body).toMatchObject({ optOut: true, rival: null });
    const off = { ...c, rival: undefined } as AppContext;
    const r = await handle(new Request('https://x/v1/rival'), {}, off);
    expect(await r.json()).toEqual({ enabled: false });
  });
  it('KPI rival_view once per game day', async () => {
    const w = world(m, jst(2026, 12, 15));
    await w.player('q');
    await w.rival.view('q'); await w.rival.view('q');
    expect(w.kpi.filter((x) => x.name === 'rival_view')).toHaveLength(1);
    w.advance(DAY);
    await w.rival.view('q');
    expect(w.kpi.filter((x) => x.name === 'rival_view')).toHaveLength(2);
  });
});
