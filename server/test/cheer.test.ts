// 観戦中の応援 (REQ-CHEER-001..016, contracts/protocol.md §55): the wire shapes, the rate limit, the window fan-out with the
// single block list, the race's aggregate and its replay moments, KPI rows per race, the texts, and above all that a cheer
// never reaches the lockstep core (no input, no replay log entry, no change to the result).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { m, makeConfig } from './helpers.js';
import {
  blockHidden, cheerAdmit, cheerAdvert, cheerFanout, cheerMoments, cheerSummary, cheerSummaryKey, cheerTextProblems, cheerableMode, emptyTally,
  parseCheerSummary, tallyAdd, withCheerAdvert, CHEER_BUCKET_TICKS, CHEER_KINDS, CHEER_MIN_INTERVAL_MS, CHEER_TEXT, CHEER_WINDOW_MS, type PendingCheer,
} from '../src/domain/cheer.js';
import { clientMessageSchema, type RaceStartConfig } from '../src/domain/schemas.js';
import { RaceRoomCore } from '../src/domain/raceRoom.js';
import { seededRng } from '../src/domain/rng.js';
import { clientBatchSchema, clientToKpi } from '../src/domain/kpi.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { MemoryReplayStore, MyReplaysService } from '../src/domain/myReplaysService.js';
import { sourceReplayKey } from '../src/domain/myReplays.js';
import { settleRace } from '../src/race/orchestrate.js';
import type { PlayerInvoker } from '../src/http/app.js';

const START = 1000;
const at = (tick: number) => START + (tick + 1) * 50;

describe('REQ-CHEER-002/003 wire shapes (§55.2–55.3) and backward compatibility (§4)', () => {
  it('the cheer message: a preset kind for a slot, nothing else (no free text)', () => {
    expect(clientMessageSchema.safeParse({ t: 'cheer', slot: 3, kind: 'go' }).success).toBe(true);
    for (const k of CHEER_KINDS) expect(clientMessageSchema.safeParse({ t: 'cheer', slot: 0, kind: k }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ t: 'cheer', slot: 3, kind: 'boo' }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ t: 'cheer', slot: 3, kind: 'go', text: 'hi' }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ t: 'cheer', slot: 12, kind: 'go' }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ t: 'cheer', slot: -1, kind: 'go' }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ t: 'cheer', slot: 1.5, kind: 'go' }).success).toBe(false);
  });

  it('existing messages still parse unchanged (old clients keep working against the new room)', () => {
    expect(clientMessageSchema.safeParse({ t: 'hello', raceId: 'r', token: 'x', lastTick: -1 }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ t: 'in', tick: 5, cmd: 32 }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ t: 'ping', c: 1 }).success).toBe(true);
    // a hello must not grow fields a new client could send to an OLD room (its schema is strict): cheers need none
    expect(clientMessageSchema.safeParse({ t: 'hello', raceId: 'r', token: 'x', lastTick: -1, cheer: true }).success).toBe(false);
  });

  it('the spectator start advertises cheers only when the room takes them; racers and old shapes are untouched', () => {
    const cfg = makeConfig(2, 'friend');
    const room = new RaceRoomCore(cfg, START, { verifySampleRate: 0, resultWaitMs: 5000, rng: seededRng(1) });
    const spec = room.spectatorStart();
    expect(withCheerAdvert(spec, true)).toMatchObject({ t: 'start', you: -1, spectator: { delayMs: 0, cheer: { kinds: ['go', 'close', 'hold'], minIntervalMs: CHEER_MIN_INTERVAL_MS, windowMs: CHEER_WINDOW_MS } } });
    expect(withCheerAdvert(spec, false)).toEqual(spec);
    const racerStart = room.hello(room.humanSlots[0]!, -1, 0)[0]!.msg;
    expect(withCheerAdvert(racerStart, true)).toEqual(racerStart); // no `spectator` → unchanged
    expect(cheerAdvert().kinds).toEqual([...CHEER_KINDS]);
  });

  it('REQ-CHEER-001: watchable modes only', () => {
    for (const mode of ['friend', 'cup', 'ranked', 'event', 'tournament']) expect(cheerableMode(mode)).toBe(true);
    for (const mode of ['tutorial', 'timeattack', 'practice']) expect(cheerableMode(mode)).toBe(false);
  });
});

describe('REQ-CHEER-006/009: a cheer never touches the race', () => {
  function run(withCheers: boolean) {
    const cfg = makeConfig(2, 'friend');
    const room = new RaceRoomCore(cfg, START, { verifySampleRate: 0, resultWaitMs: 5000, rng: seededRng(3) });
    const [a, b] = room.humanSlots as [number, number];
    room.hello(a, -1, 0); room.hello(b, -1, 0);
    const errs: unknown[] = [];
    for (let t = 0; t < 400; t += 5) {
      room.advance(at(t));
      room.message(a, { t: 'in', tick: t + 2, cmd: t % 40 === 0 ? 32 : 0 }, at(t));
      room.message(b, { t: 'ping', c: 0 }, at(t));
      if (withCheers) errs.push(...room.message(a, { t: 'cheer', slot: b, kind: 'go' }, at(t)).map((o) => o.msg));
    }
    return { log: room.replayLog(), snap: room.toJSON(), errs };
  }

  it('a racer socket that sends a cheer gets NOT_SPECTATOR and the log, the snapshot and the inputs are identical', () => {
    const plain = run(false);
    const cheered = run(true);
    expect(cheered.log).toEqual(plain.log);
    expect(JSON.stringify(cheered.snap)).toBe(JSON.stringify(plain.snap));
    expect(cheered.errs.every((e) => (e as { code: string }).code === 'NOT_SPECTATOR')).toBe(true);
    expect(JSON.stringify(cheered.log)).not.toContain('cheer');
  });

  it('the room DO keeps cheers outside the core snapshot (separate storage key, never in the replay log put)', () => {
    const src = readFileSync(join(import.meta.dirname, '../src/do/raceRoom.ts'), 'utf8');
    expect(src).toContain("storage.put('cheer'");
    // the core is never told about a cheer: the cheer branch returns before core.message
    const i = src.indexOf("if (msg.t === 'cheer')");
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(src.indexOf('const out = core.message(att.slot, msg, now);'));
  });
});

describe('REQ-CHEER-004/006 who may cheer, and how often', () => {
  const base = { enabled: true, spectator: true, sentTick: 100, fin: false, lastAt: null as number | null, slot: 2, entrants: 12, now: 50_000 };
  it('one cheer per 2 s per spectator; racers, off, finished, not started and bad slots are refused', () => {
    expect(cheerAdmit(base)).toBeNull();
    expect(cheerAdmit({ ...base, lastAt: 50_000 - CHEER_MIN_INTERVAL_MS + 1 })).toBe('CHEER_RATE_LIMITED');
    expect(cheerAdmit({ ...base, lastAt: 50_000 - CHEER_MIN_INTERVAL_MS })).toBeNull();
    expect(cheerAdmit({ ...base, lastAt: 60_000 })).toBeNull(); // a clock that went back never locks a spectator out
    expect(cheerAdmit({ ...base, spectator: false })).toBe('NOT_SPECTATOR');
    expect(cheerAdmit({ ...base, enabled: false })).toBe('CHEER_OFF');
    expect(cheerAdmit({ ...base, fin: true })).toBe('CHEER_NOT_LIVE');
    expect(cheerAdmit({ ...base, sentTick: -1 })).toBe('CHEER_NOT_LIVE');
    expect(cheerAdmit({ ...base, slot: 12 })).toBe('BAD_MESSAGE');
    expect(cheerAdmit({ ...base, slot: 5, entrants: 5 })).toBe('BAD_MESSAGE');
  });

  it('none of the refusals is fatal for a client (RaceSession.FatalRoomErrors)', () => {
    const cs = readFileSync(join(import.meta.dirname, '../../engine/Muchi.Client/RaceSession.cs'), 'utf8');
    const fatal = cs.match(/FatalRoomErrors = \{([^}]*)\}/)![1]!;
    for (const code of ['CHEER_OFF', 'NOT_SPECTATOR', 'CHEER_NOT_LIVE', 'CHEER_RATE_LIMITED', 'CHEER_UNAVAILABLE', 'BAD_MESSAGE']) expect(fatal).not.toContain(`"${code}"`);
  });
});

describe('REQ-CHEER-005/007/008 window fan-out with the single block list', () => {
  const C = (from: string, slot: number, kind: PendingCheer['kind']): PendingCheer => ({ from, slot, kind });
  const lists = (o: Record<string, string[]>) => new Map(Object.entries(o).map(([k, v]) => [k, new Set(v) as ReadonlySet<string>]));

  it('aggregates per slot and kind, sorted, without sender ids; one string shared when nobody blocks', () => {
    const cheers = [C('s1', 3, 'go'), C('s2', 3, 'go'), C('s3', 1, 'hold'), C('s1', 3, 'close')];
    const out = cheerFanout(cheers, [{ key: 'A', playerId: 'p0' }, { key: 'B', playerId: 's1' }], blockHidden(lists({ p0: [], s1: [], s2: [], s3: [] })));
    expect(JSON.parse(out.get('A')!)).toEqual({ t: 'cheers', n: [[1, 'hold', 1], [3, 'go', 2], [3, 'close', 1]] });
    expect(out.get('B')).toBe(out.get('A')); // same serialized string
    expect(out.get('A')).not.toContain('s1');
  });

  it('either side blocking hides that sender\'s cheers from that recipient only', () => {
    const cheers = [C('troll', 3, 'go'), C('friend', 3, 'go')];
    const l = lists({ racer: ['troll'], other: [], troll: [], friend: [], hater: ['racer'] });
    const out = cheerFanout([...cheers, C('hater', 3, 'hold')], [{ key: 'racer', playerId: 'racer' }, { key: 'other', playerId: 'other' }], blockHidden(l));
    expect(JSON.parse(out.get('racer')!).n).toEqual([[3, 'go', 1]]); // troll (racer blocked) and hater (blocked racer) hidden
    expect(JSON.parse(out.get('other')!).n).toEqual([[3, 'go', 2], [3, 'hold', 1]]);
  });

  it('fail closed: a recipient whose list is unknown gets nothing; an unknown sender list hides that sender; own cheers always show', () => {
    const l = lists({ a: [], s: [] });
    const out = cheerFanout([C('s', 0, 'go'), C('ghost', 0, 'go')], [{ key: 'a', playerId: 'a' }, { key: 'u', playerId: 'unknown' }, { key: 'n', playerId: null }, { key: 's', playerId: 's' }], blockHidden(l));
    expect(JSON.parse(out.get('a')!).n).toEqual([[0, 'go', 1]]); // ghost has no known list → hidden
    expect(out.get('u')).toBeNull();
    expect(out.get('n')).toBeNull();
    expect(JSON.parse(out.get('s')!).n).toEqual([[0, 'go', 1]]);
    // a window whose only cheers are hidden sends nothing
    expect(cheerFanout([C('ghost', 0, 'go')], [{ key: 'a', playerId: 'a' }], blockHidden(l)).get('a')).toBeNull();
  });

  it('bandwidth is bounded: 200 spectators cheering at the cap still make one small message per socket per window', () => {
    const cheers = Array.from({ length: 200 }, (_, i) => C(`s${i}`, i % 12, CHEER_KINDS[i % 3]!));
    const l = lists(Object.fromEntries([...Array.from({ length: 200 }, (_, i) => [`s${i}`, []]), ['r', []]]));
    const out = cheerFanout(cheers, Array.from({ length: 201 }, (_, i) => ({ key: i, playerId: i === 200 ? 'r' : `s${i}` })), blockHidden(l));
    const sizes = new Set([...out.values()].map((s) => s!.length));
    expect(sizes.size).toBe(1);
    expect([...sizes][0]!).toBeLessThan(12 * 3 * 16 + 32); // at most 36 [slot,kind,count] rows
  });
});

describe('REQ-CHEER-011/012 the race\'s aggregate and 「応援の多かった瞬間」', () => {
  it('counts per bucket of race ticks, with no ids; moments are the busiest buckets in race order', () => {
    const t = emptyTally();
    for (let i = 0; i < 5; i++) tallyAdd(t, 400 + i);   // bucket 10
    for (let i = 0; i < 2; i++) tallyAdd(t, 41);        // bucket 1 (below the moment minimum)
    for (let i = 0; i < 4; i++) tallyAdd(t, 1210);      // bucket 30
    for (let i = 0; i < 4; i++) tallyAdd(t, 820);       // bucket 20
    for (let i = 0; i < 3; i++) tallyAdd(t, 1600);      // bucket 40
    const s = cheerSummary(t);
    expect(s).toEqual({ v: 1, bucketTicks: CHEER_BUCKET_TICKS, total: 18, buckets: [[1, 2], [10, 5], [20, 4], [30, 4], [40, 3]] });
    expect(cheerMoments(s)).toEqual([{ tick: 400, count: 5 }, { tick: 800, count: 4 }, { tick: 1200, count: 4 }]);
    expect(cheerSummaryKey('r1')).toBe('replays/r1.cheers.json'); // swept with the replay logs (same prefix and retention)
    expect(JSON.stringify(s).length).toBeLessThan(400);
  });

  it('a missing or bad file means no marker (never an error)', () => {
    expect(cheerMoments(null)).toEqual([]);
    expect(parseCheerSummary(null)).toBeNull();
    expect(parseCheerSummary('nope')).toBeNull();
    expect(parseCheerSummary(JSON.stringify({ v: 2, bucketTicks: 40, buckets: [] }))).toBeNull();
    expect(parseCheerSummary(JSON.stringify({ v: 1, bucketTicks: 40, buckets: [[1, -3]] }))).toBeNull();
    expect(parseCheerSummary(JSON.stringify({ v: 1, bucketTicks: 40, total: 999, buckets: [[1, 3]] }))!.total).toBe(3); // total recomputed
  });

  it('saved and recent replays carry the moments; the log and the hash are untouched', async () => {
    let now = Date.UTC(2026, 11, 8, 3);
    const repo = new MemoryPlayerRepo();
    const svc = new PlayerService(repo, { master: m, rng: seededRng(9), clock: () => now, verifiers: {} });
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
    const store = new MemoryReplayStore();
    const replays = new MyReplaysService(() => m, () => invoker, store);
    await svc.bootstrap('a'); await svc.grantPartner('a', 'アイボウ', 'c:t:0');
    const c0 = makeConfig(1, 'friend', 11) as RaceStartConfig;
    const c = { ...c0, raceId: 'rc1', entrants: c0.entrants.map((e) => (e.kind === 'human' ? { ...e, playerId: 'a' } : e)) };
    const log = { v: 1 as const, config: c, endTick: 1500, inputs: [[60, 0, 1]] as [number, number, number][] };
    await store.put(sourceReplayKey('rc1'), JSON.stringify(log));
    const t = emptyTally(); for (let i = 0; i < 6; i++) tallyAdd(t, 900);
    await store.put(cheerSummaryKey('rc1'), JSON.stringify(cheerSummary(t)));
    const final = { status: 'confirmed' as const, order: c.entrants.map((e) => e.slot), hash: 'b'.repeat(64), via: 'consensus' as const, suspects: [] };
    for (const [pid, r] of Object.entries(settleRace(c, final, {}, log))) await svc.applyRace(pid, r);
    const recent = await replays.data('a', 'rc1') as { cheerMoments: unknown; replayLog: { inputs: unknown }; resultHash: string };
    expect(recent.cheerMoments).toEqual([{ tick: 880, count: 6 }]);
    expect(recent.replayLog.inputs).toEqual(log.inputs);
    expect(recent.resultHash).toBe('b'.repeat(64));
    now += 1000;
    await replays.save('a', 'rc1', null, 'c:t:1');
    await store.delete(cheerSummaryKey('rc1')); // the copy keeps them after the source is swept
    expect((await replays.data('a', 'rc1') as { cheerMoments: unknown }).cheerMoments).toEqual([{ tick: 880, count: 6 }]);
    // a race nobody cheered: an empty list
    const c2 = { ...c, raceId: 'rc2' };
    await store.put(sourceReplayKey('rc2'), JSON.stringify({ ...log, config: c2 }));
    for (const [pid, r] of Object.entries(settleRace(c2, final, {}, { ...log, config: c2 }))) await svc.applyRace(pid, r);
    expect((await replays.data('a', 'rc2') as { cheerMoments: unknown }).cheerMoments).toEqual([]);
  });
});

describe('REQ-CHEER-013 KPI: one row per race, not per tap', () => {
  it('cheer_send / cheer_seen are client events with a count; no horse or player ids', () => {
    const b = clientBatchSchema.parse({ platform: 'ios', appVersion: '1.0', events: [
      { name: 'cheer_send', at: 1, props: { mode: 'friend', count: 12 } },
      { name: 'cheer_seen', at: 2, props: { mode: 'ranked', role: 'racer', count: 40 } },
    ] });
    expect(b.events.map(clientToKpi)).toEqual([{ name: 'cheer_send', s1: 'friend', count: 12 }, { name: 'cheer_seen', s1: 'ranked', s2: 'racer', count: 40 }]);
    for (const bad of [{ mode: 'friend', count: 0 }, { mode: 'tutorial', count: 1 }, { mode: 'friend', count: 1, slot: 3 }, { mode: 'friend', count: 1001 }]) {
      expect(clientBatchSchema.safeParse({ platform: 'ios', appVersion: '1.0', events: [{ name: 'cheer_send', at: 1, props: bad }] }).success).toBe(false);
    }
    expect(clientBatchSchema.safeParse({ platform: 'ios', appVersion: '1.0', events: [{ name: 'cheer_seen', at: 1, props: { mode: 'friend', role: 'host', count: 1 } }] }).success).toBe(false);
  });
});

describe('REQ-CHEER-014 texts', () => {
  it('preset phrases only, both languages, no betting words', () => {
    expect(cheerTextProblems()).toEqual([]);
    for (const k of CHEER_KINDS) { expect(CHEER_TEXT[k].ja).toMatch(/！$/); expect(CHEER_TEXT[k].en).toMatch(/!$/); }
    // the client tables carry the same phrases (engine Cheer.cs, prototype)
    const cs = readFileSync(join(import.meta.dirname, '../../engine/Muchi.Client/Cheer.cs'), 'utf8');
    for (const k of CHEER_KINDS) { expect(cs).toContain(`"${CHEER_TEXT[k].ja}"`); }
    const en = JSON.parse(readFileSync(join(import.meta.dirname, '../../engine/Muchi.Client/Resources/Muchi/ui-en.json'), 'utf8')).strings as Record<string, string>;
    for (const k of CHEER_KINDS) expect(en[CHEER_TEXT[k].ja]).toBe(CHEER_TEXT[k].en);
  });
});
