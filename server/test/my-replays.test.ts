import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { m, makeConfig } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import type { AppError } from '../src/domain/errors.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import type { Master } from '../src/domain/master.js';
import {
  DEFAULT_MY_REPLAYS, MY_REPLAYS_HARD_LIMITS, myReplaysProblems, playabilityOf, savedReplayKey, sourceReplayKey, type MyReplaysConfig,
} from '../src/domain/myReplays.js';
import { MemoryReplayStore, MyReplaysService } from '../src/domain/myReplaysService.js';
import { handle, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { settleRace } from '../src/race/orchestrate.js';
import { runAccountDeletion } from '../src/domain/accountDeletion.js';
import { clientBatchSchema } from '../src/domain/kpi.js';
import type { RaceStartConfig } from '../src/domain/schemas.js';
import type { RaceResultForPlayer } from '../src/domain/rewards.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 11, 8, 3);
const cfg = m.progression.myReplays as MyReplaysConfig;
const withCfg = (patch: Partial<MyReplaysConfig>, base: Master = m): Master => ({ ...base, progression: { ...base.progression, myReplays: { ...cfg, ...patch } } as Master['progression'] });
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as AppError).code; } return 'NO_ERROR'; };

/** A config whose human slots are ridden by the given players (slot = index). */
function raceConfig(raceId: string, players: string[], mode: RaceStartConfig['mode'] = 'ranked'): RaceStartConfig {
  const c = makeConfig(players.length, mode, 12 - players.length) as RaceStartConfig;
  // humans first (slot = index in `players`), then the CPUs
  const humans = c.entrants.filter((e) => e.kind === 'human').map((e, i) => ({ ...e, playerId: players[i]! }));
  const entrants = [...humans, ...c.entrants.filter((e) => e.kind === 'cpu')].map((e, slot) => ({ ...e, slot }));
  return { ...c, raceId, entrants };
}

function world(master: Master = m) {
  let now = T0;
  const kpi: KpiRecord[] = [];
  const repo = new MemoryPlayerRepo();
  const svc = new PlayerService(repo, { master, rng: seededRng(9), clock: () => now, verifiers: {}, onKpi: (_id, recs) => { kpi.push(...recs); } });
  // one call at a time, like a Durable Object's input gate (concurrent saves interleave between calls, not inside one)
  let gate: Promise<unknown> = Promise.resolve();
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => {
    const run = gate.then(() => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args));
    gate = run.catch(() => undefined);
    return run;
  }) as PlayerInvoker['invoke'] };
  const store = new MemoryReplayStore();
  const replays = new MyReplaysService(() => master, () => invoker, store);
  let n = 0;
  const k = () => `c:t:${n++}`;
  const player = async (id: string) => { await svc.bootstrap(id); await svc.grantPartner(id, 'アイボウ', k()); };
  /** A confirmed race: the room writes the source log to R2, then each human gets settleRace's result. */
  const race = async (raceId: string, order: string[], opts: { finishTicks?: number[]; mode?: RaceStartConfig['mode']; write?: boolean; void?: boolean } = {}) => {
    const c = raceConfig(raceId, order, opts.mode);
    const log = { v: 1 as const, config: c, endTick: 1500, inputs: [[60, 0, 1], [61, 1, 1]] as [number, number, number][] };
    if (opts.write !== false) await store.put(sourceReplayKey(raceId), JSON.stringify(log));
    const slots = order.map((_, i) => i);
    const final = opts.void
      ? { status: 'void' as const, order: [], hash: '', via: 'none' as const, suspects: [] }
      : { status: 'confirmed' as const, order: [...slots, ...c.entrants.slice(order.length).map((e) => e.slot)], hash: 'a'.repeat(63) + raceId.length % 10, via: 'consensus' as const, suspects: [],
        ...(opts.finishTicks ? { finishTicks: [...opts.finishTicks, ...c.entrants.slice(order.length).map((_, i) => 2000 + i)] } : {}) };
    const results = settleRace(c, final, {}, log);
    for (const [pid, r] of Object.entries(results)) await svc.applyRace(pid, r);
    return { config: c, log, results };
  };
  const befriend = async (a: string, b: string) => {
    for (const [x, y] of [[a, b], [b, a]] as const) { const s = await svc.state(x); s.friends.ids.push(y); await repo.put(s); }
  };
  return { svc, repo, store, replays, kpi, k, player, race, befriend, now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('REQ-MYRP-001/002 recent races and best moments', () => {
  it('settleRace carries the slot, result hash, ruleset version and the gap to the neighbouring places', () => {
    const c = raceConfig('rx', ['a', 'b']);
    const out = settleRace(c, { status: 'confirmed', order: [0, 1, ...c.entrants.slice(2).map((e) => e.slot)], hash: 'f'.repeat(64), via: 'consensus', suspects: [],
      finishTicks: [1000, 1001, ...c.entrants.slice(2).map((_, i) => 1100 + i)] }, {});
    expect(out.a!.replay).toEqual({ slot: 0, resultHash: 'f'.repeat(64), rulesetVersion: c.ruleset.rulesetVersion, trackId: c.track.id, marginTicks: 1 });
    expect(out.b!.replay!.marginTicks).toBe(1);
    const noTicks = settleRace(c, { status: 'confirmed', order: c.entrants.map((e) => e.slot), hash: 'f'.repeat(64), via: 'consensus', suspects: [] }, {});
    expect(noTicks.a!.replay!.marginTicks).toBeNull();
    expect(settleRace(c, { status: 'void', order: [], hash: '', via: 'none', suspects: [] }, {}).a!.replay).toBeUndefined();
  });

  it('remembers each confirmed race once; wins, photo finishes and course bests become moments; void / tutorial are skipped', async () => {
    const w = world();
    await w.player('a'); await w.player('b');
    await w.race('r1', ['a', 'b'], { finishTicks: [1000, 1010] }); // a wins, b 10 ticks behind (no photo)
    w.advance(1000);
    await w.race('r2', ['b', 'a'], { finishTicks: [1000, 1001] }); // a 2nd by one tick: photo
    await w.race('r3', ['a', 'b'], { void: true });
    const { results } = await w.race('r4', ['a'], { mode: 'tutorial' });
    await w.svc.applyRace('a', { ...results.a!, raceId: 'r1', mode: 'ranked', replay: { ...results.a!.replay!, slot: 0 } } as RaceResultForPlayer); // the same race twice: ignored
    const again = (await w.svc.state('a'));
    expect(again.myReplays!.recent.map((r) => r.raceId).sort()).toEqual(['r1', 'r2']);
    const v = await w.svc.myReplays('a') as any;
    expect(v).toMatchObject({ enabled: true, maxSaved: 20, used: 0, titleMaxChars: 24 });
    expect(v.moments.map((x: any) => [x.raceId, x.moment])).toEqual([['r2', 'photo'], ['r1', 'win']]);
    expect(v.moments[0]).toMatchObject({ place: 2, fieldSize: 12, slot: 1, saved: false, expiresAt: T0 + 1000 + cfg.momentDays * DAY });
    const vb = await w.svc.myReplays('b') as any;
    expect(vb.moments.map((x: any) => x.raceId)).toEqual(['r2']); // b won r2
    expect(vb.recent.map((x: any) => x.raceId)).toEqual(['r1']);
  });

  it('a personal best on the course (not CPU-ridden, not the first run there) is a moment', async () => {
    const w = world();
    await w.player('a');
    const s = await w.svc.state('a');
    s.stats.byTrack['kirameki_turf_2000'] = { races: 3, wins: 0, bestFinishTick: 1500 };
    await w.repo.put(s);
    const c = raceConfig('pb1', ['a']);
    const base: RaceResultForPlayer = { raceId: 'pb1', mode: 'ranked', place: 4, fieldSize: 12, newRating: null, void: false, humans: 1,
      details: { trackId: 'kirameki_turf_2000', style: 'senko', finishTick: 1400, startReactionTicks: 2, whips: 3, whipMashed: false, cpuAssisted: false },
      replay: { slot: 0, resultHash: 'b'.repeat(64), rulesetVersion: String(c.ruleset.rulesetVersion), trackId: c.track.id, marginTicks: 30 } };
    await w.svc.applyRace('a', base);
    await w.svc.applyRace('a', { ...base, raceId: 'pb2', details: { ...base.details!, finishTick: 1300, cpuAssisted: true } });
    const rec = (await w.svc.state('a')).myReplays!.recent;
    expect(rec.find((r) => r.raceId === 'pb1')!.moment).toBe('pb');
    expect(rec.find((r) => r.raceId === 'pb2')!.moment).toBeNull();
  });

  it('moments rotate out after momentsKeep / momentDays; plain races keep recentKeep', async () => {
    const w = world(withCfg({ momentsKeep: 2, recentKeep: 2 }));
    await w.player('a'); await w.player('b');
    for (let i = 0; i < 4; i++) { await w.race(`w${i}`, ['a', 'b']); w.advance(60_000); }
    for (let i = 0; i < 3; i++) { await w.race(`l${i}`, ['b', 'a'], { finishTicks: [1000, 1050] }); w.advance(60_000); }
    let v = await w.svc.myReplays('a') as any;
    expect(v.moments.map((x: any) => x.raceId)).toEqual(['w3', 'w2']);
    expect(v.recent.map((x: any) => x.raceId)).toEqual(['l2', 'l1']);
    w.advance(cfg.momentDays * DAY);
    v = await w.svc.myReplays('a') as any;
    expect(v.moments).toEqual([]);
    expect(v.recent).toEqual([]);
  });
});

describe('REQ-MYRP-003/004 saving', () => {
  it('copies the source log + result hash outside the swept prefix, once; a retry with the same key returns the first answer', async () => {
    const w = world();
    await w.player('a'); await w.player('b');
    const { log } = await w.race('r1', ['a', 'b']);
    const key = w.k();
    const out = await w.replays.save('a', 'r1', '差し切った日', key) as any;
    expect(out).toMatchObject({ alreadySaved: false, saved: { raceId: 'r1', replayTitle: '差し切った日', favorite: false, public: false, place: 1, slot: 0, playable: true, reason: null } });
    const file = JSON.parse((await w.store.get(savedReplayKey('a', 'r1')))!);
    expect(file).toEqual({ v: 1, log, resultHash: out.saved.resultHash });
    expect(savedReplayKey('a', 'r1').startsWith('replays/')).toBe(false);
    expect(await w.replays.save('a', 'r1', '別の名前', key)).toEqual(out); // same key: stored answer
    const again = await w.replays.save('a', 'r1', '別の名前', w.k()) as any;
    expect(again).toMatchObject({ alreadySaved: true, saved: { replayTitle: '差し切った日' } }); // one record, title unchanged
    expect(again.view.used).toBe(1);
    expect(w.kpi.filter((e) => e.name === 'replay_save')).toEqual([expect.objectContaining({ s1: 'moment', s2: 'ranked', s3: 'win', place: 1 })]);
    // the source being swept later does not touch the saved copy
    await w.store.delete(sourceReplayKey('r1'));
    expect((await w.replays.data('a', 'r1')).replayLog.inputs).toEqual(log.inputs);
  });

  it('only own recent races; the free cap; expired sources are dropped; oversize refused; titles moderated', async () => {
    const w = world(withCfg({ maxSaved: 2 }));
    await w.player('a'); await w.player('b'); await w.player('c');
    await w.race('r1', ['a', 'b']); await w.race('r2', ['a', 'b']); await w.race('r3', ['a', 'b']);
    await w.race('rc', ['c', 'b']);
    expect(await code(w.replays.save('a', 'rc', null, w.k()))).toBe('NOT_FOUND'); // c's race
    expect(await code(w.replays.save('a', '../x', null, w.k()))).toBe('NOT_FOUND');
    expect(await code(w.replays.save('a', 'r1', 'http://spam.example', w.k()))).toBe('INVALID_NAME');
    expect(await code(w.replays.save('a', 'r1', 'x'.repeat(25), w.k()))).toBe('INVALID_NAME');
    expect(await code(w.replays.save('a', 'r1', m.ng.exact[0]!, w.k()))).toBe('NG_NAME');
    expect(await w.store.get(savedReplayKey('a', 'r1'))).toBeNull(); // nothing uploaded for a refused title
    await w.replays.save('a', 'r1', null, w.k());
    await w.replays.save('a', 'r2', '  全角　スペース  ', w.k());
    expect((await w.svc.myReplays('a') as any).saved.find((x: any) => x.raceId === 'r2').replayTitle).toBe('全角 スペース');
    expect(await code(w.replays.save('a', 'r3', null, w.k()))).toBe('REPLAY_LIMIT');
    expect(await w.store.get(savedReplayKey('a', 'r3'))).toBeNull();
    await w.store.delete(sourceReplayKey('r3'));
    await w.replays.remove('a', 'r2');
    expect(await code(w.replays.save('a', 'r3', null, w.k()))).toBe('REPLAY_EXPIRED');
    expect((await w.svc.myReplays('a') as any).moments.map((x: any) => x.raceId)).not.toContain('r3');
    const big = world(withCfg({ maxBytes: 300 }));
    await big.player('a'); await big.player('b');
    await big.race('r1', ['a', 'b']);
    expect(await code(big.replays.save('a', 'r1', null, big.k()))).toBe('REPLAY_TOO_LARGE');
  });

  it('two saves racing for the last slot: one wins, the loser leaves no copy behind', async () => {
    const w = world(withCfg({ maxSaved: 1 }));
    await w.player('a'); await w.player('b');
    await w.race('r1', ['a', 'b']); await w.race('r2', ['a', 'b']);
    const res = await Promise.allSettled([w.replays.save('a', 'r1', null, w.k()), w.replays.save('a', 'r2', null, w.k())]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const kept = (await w.svc.myReplays('a') as any).saved.map((x: any) => x.raceId);
    expect(kept).toHaveLength(1);
    const copies = [...w.store.files.keys()].filter((k) => k.startsWith('myreplays/'));
    expect(copies).toEqual([savedReplayKey('a', kept[0])]);
  });
});

describe('REQ-MYRP-005/006 rename, favourite, public, delete', () => {
  it('patches are value replacements (idempotent); favourites list first; delete removes the copy and is idempotent', async () => {
    const w = world();
    await w.player('a'); await w.player('b');
    await w.race('r1', ['a', 'b']); w.advance(1000); await w.race('r2', ['b', 'a']);
    await w.replays.save('a', 'r1', null, w.k()); w.advance(1000);
    await w.replays.save('a', 'r2', null, w.k());
    expect((await w.svc.myReplays('a') as any).saved.map((x: any) => x.raceId)).toEqual(['r2', 'r1']);
    const p1 = await w.replays.update('a', 'r1', { favorite: true, replayTitle: '名勝負' });
    expect(await w.replays.update('a', 'r1', { favorite: true, replayTitle: '名勝負' })).toEqual(p1);
    expect((await w.svc.myReplays('a') as any).saved.map((x: any) => x.raceId)).toEqual(['r1', 'r2']);
    expect((await w.replays.update('a', 'r1', { replayTitle: null }) as any).saved.replayTitle).toBeNull();
    expect(await code(w.replays.update('a', 'nope', { favorite: true }))).toBe('NOT_FOUND');
    expect((await w.replays.remove('a', 'r1') as any).deleted).toBe(true);
    expect(await w.store.get(savedReplayKey('a', 'r1'))).toBeNull();
    expect((await w.replays.remove('a', 'r1') as any).deleted).toBe(false);
  });
});

describe('REQ-MYRP-007/008 replay data and playability', () => {
  it('returns the log as stored, other humans redacted to p<slot>, horse names with who rode them, and a replay_view', async () => {
    const w = world();
    await w.player('a'); await w.player('b');
    const { log } = await w.race('r1', ['a', 'b']);
    await w.replays.save('a', 'r1', null, w.k());
    const d = await w.replays.data('a', 'r1') as any;
    expect(d).toMatchObject({ raceId: 'r1', owner: 'me', focusSlot: 0, playable: true, reason: null, rulesetVersion: log.config.ruleset.rulesetVersion });
    expect(d.replayLog.inputs).toEqual(log.inputs);
    expect(d.replayLog.config.entrants[0].playerId).toBe('a');
    expect(d.replayLog.config.entrants[1].playerId).toBe('p1');
    expect(JSON.stringify(d)).not.toContain('"b"');
    expect(d.entrants.slice(0, 3).map((e: any) => e.owner)).toEqual(['you', 'player', 'cpu']);
    const { entrants: _a, ...cfgRest } = d.replayLog.config;
    const { entrants: _b, ...origRest } = log.config;
    expect(cfgRest).toEqual(origRest); // everything the engine reads is unchanged
    expect(w.kpi.filter((e) => e.name === 'replay_view')).toEqual([expect.objectContaining({ s1: 'own', s2: 'playable', s3: 'ranked' })]);
    // a recent (unsaved) race plays from the source until it is swept
    await w.race('r2', ['b', 'a']);
    expect((await w.replays.data('a', 'r2') as any).focusSlot).toBe(1);
    await w.store.delete(sourceReplayKey('r2'));
    expect(await code(w.replays.data('a', 'r2'))).toBe('REPLAY_EXPIRED');
    expect(await code(w.replays.data('a', 'r2'))).toBe('NOT_FOUND');
  });

  it('retired and unknown rulesets are not playable (the list says so, nothing else changes); the shipped and legacy rulesets are', async () => {
    const w = world();
    await w.player('a'); await w.player('b');
    const { config } = await w.race('r1', ['a', 'b']);
    await w.replays.save('a', 'r1', null, w.k());
    const v = String(config.ruleset.rulesetVersion);
    const retired = withCfg({ retiredRulesets: [v.split('.').slice(0, 2).join('.')] });
    expect(playabilityOf(retired, v)).toEqual({ playable: false, reason: 'ruleset_retired' });
    expect(playabilityOf(retired, `${v}+ev.no_whip`)).toEqual({ playable: false, reason: 'ruleset_retired' });
    expect(playabilityOf(withCfg({ retiredRulesets: ['1.0'] }), '1.0.10')).toMatchObject({ reason: 'ruleset_retired' });
    expect(playabilityOf(withCfg({ retiredRulesets: ['1.0'] }), '1.01.0')).toMatchObject({ playable: true });
    expect(playabilityOf(m, v, { ...config.ruleset, futureKey: 1 })).toEqual({ playable: false, reason: 'ruleset_unknown' });
    const r = world(retired);
    r.store.files.clear();
    await r.player('a'); await r.player('b');
    await r.race('r1', ['a', 'b']);
    await r.replays.save('a', 'r1', null, r.k());
    expect((await r.svc.myReplays('a') as any).saved[0]).toMatchObject({ playable: false, reason: 'ruleset_retired' });
    expect(await r.replays.data('a', 'r1')).toMatchObject({ playable: false, reason: 'ruleset_retired' });
    expect(r.kpi.filter((e) => e.name === 'replay_view').at(-1)).toMatchObject({ s2: 'ruleset_retired' });
    // every golden and legacy golden (rulesets 1.0 .. current) is playable with the shipped config
    const dir = join(__dirname, '../../contracts/golden');
    const files = [...readdirSync(dir).filter((f) => f.startsWith('race-')).map((f) => join(dir, f)), ...readdirSync(join(dir, 'legacy')).map((f) => join(dir, 'legacy', f))];
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const g = JSON.parse(readFileSync(f, 'utf8'));
      expect(playabilityOf(m, g.log.config.ruleset.rulesetVersion, g.log.config.ruleset), f).toEqual({ playable: true, reason: null });
    }
  });
});

describe('REQ-MYRP-010/011 friends and privacy', () => {
  it('friends see public saves only (no favourite flag); strangers, blocks either way, bans and deletion hide everything with a 404', async () => {
    const w = world();
    for (const p of ['a', 'b', 'f', 'x']) await w.player(p);
    await w.befriend('a', 'f');
    await w.race('r1', ['a', 'b']); await w.race('r2', ['a', 'b']);
    await w.replays.save('a', 'r1', 'みてね', w.k()); await w.replays.save('a', 'r2', null, w.k());
    await w.replays.update('a', 'r1', { public: true, favorite: true });
    const list = await w.replays.friendList('f', 'a') as any;
    expect(list.replays.map((r: any) => r.raceId)).toEqual(['r1']);
    expect(list.replays[0].favorite).toBeUndefined();
    expect(list.displayName).toBe((await w.svc.state('a')).profile.displayName);
    const d = await w.replays.friendData('f', 'a', 'r1') as any;
    expect(d).toMatchObject({ owner: 'friend', replayTitle: 'みてね', focusSlot: 0 });
    expect(d.entrants.slice(0, 2).map((e: any) => e.owner)).toEqual(['owner_player', 'player']);
    expect(d.replayLog.config.entrants[1].playerId).toBe('p1');
    expect(w.kpi.filter((e) => e.name === 'replay_view').at(-1)).toMatchObject({ s1: 'friend' });
    expect(await code(w.replays.friendData('f', 'a', 'r2'))).toBe('NOT_FOUND'); // private
    expect(await code(w.replays.friendList('x', 'a'))).toBe('NOT_FOUND'); // not a friend
    expect(await code(w.replays.friendList('a', 'a'))).toBe('NOT_FOUND');
    // blocked by the owner (支部フィードのミュート = the block list) / the viewer blocked the owner
    const own = await w.svc.state('a'); (own as any).teamFeed = { muted: ['f'], postedIn: [] }; await w.repo.put(own);
    expect(await code(w.replays.friendList('f', 'a'))).toBe('NOT_FOUND');
    (own as any).teamFeed = { muted: [], postedIn: [] }; await w.repo.put(own);
    const vs = await w.svc.state('f'); (vs as any).teamFeed = { muted: ['a'], postedIn: [] }; await w.repo.put(vs);
    expect(await code(w.replays.friendData('f', 'a', 'r1'))).toBe('NOT_FOUND');
    (vs as any).teamFeed = { muted: [], postedIn: [] }; await w.repo.put(vs);
    // banned owner
    const ban = await w.svc.state('a'); ban.moderation = { status: 'banned', until: null, reason: 't', at: 0 }; await w.repo.put(ban);
    expect(await code(w.replays.friendList('f', 'a'))).toBe('NOT_FOUND');
    delete ban.moderation; await w.repo.put(ban);
    expect((await w.replays.friendList('f', 'a') as any).replays).toHaveLength(1);
    // scheduled deletion: hidden from friends, cannot save or publish, can still list, play, unpublish and delete
    const del = await w.svc.state('a'); del.deletion = { status: 'scheduled', requestedAt: T0, deleteAt: T0 + 14 * DAY, steps: [], attempts: 0 }; await w.repo.put(del);
    expect(await code(w.replays.friendList('f', 'a'))).toBe('NOT_FOUND');
    await w.race('r3', ['a', 'b']);
    expect(await code(w.replays.save('a', 'r3', null, w.k()))).toBe('DELETION_PENDING');
    expect(await code(w.replays.update('a', 'r2', { public: true }))).toBe('DELETION_PENDING');
    expect((await w.replays.update('a', 'r1', { public: false }) as any).saved.public).toBe(false);
    expect((await w.replays.data('a', 'r1') as any).playable).toBe(true);
    expect((await w.replays.remove('a', 'r2') as any).deleted).toBe(true);
  });
});

describe('REQ-MYRP-012 account deletion', () => {
  it('the snapshot lists the saved copies and the replays step deletes them', async () => {
    const w = world();
    await w.player('a'); await w.player('b');
    await w.race('r1', ['a', 'b']);
    await w.replays.save('a', 'r1', null, w.k());
    const snap = await w.svc.deletionSnapshot('a');
    expect(snap.replayKeys).toEqual([savedReplayKey('a', 'r1')]);
    const deleted: string[][] = [];
    const ports = {
      start: async () => undefined, snapshot: async () => snap, markStep: async () => undefined,
      friends: { removeFriend: async () => undefined, dropOutgoing: async () => undefined, dropIncoming: async () => undefined },
      team: {}, directory: { forget: async () => undefined },
      leaderboards: { forget: async () => undefined, deleteGhosts: async () => undefined },
      replays: { deleteAll: async (keys: string[]) => { deleted.push(keys); } },
      finalize: async () => ({ rev: 1 }) as never, retain: async () => undefined, wipe: async () => undefined,
    };
    const r = await runAccountDeletion(ports as never, 'a', 0);
    expect(r.done).toContain('replays');
    expect(deleted).toEqual([[savedReplayKey('a', 'r1')]]);
  });
});

describe('REQ-MYRP-013 config', () => {
  it('the shipped config is valid; hard limits and the retention window are enforced', () => {
    expect(myReplaysProblems(m)).toEqual([]);
    expect(cfg).toMatchObject({ ...DEFAULT_MY_REPLAYS, retiredRulesets: [] });
    const bad = (p: Partial<MyReplaysConfig>) => myReplaysProblems(withCfg(p));
    expect(bad({ maxSaved: MY_REPLAYS_HARD_LIMITS.maxSaved + 1 })).toEqual([expect.stringContaining('maxSaved')]);
    expect(bad({ maxBytes: 2 * 1024 * 1024 })).toEqual([expect.stringContaining('maxBytes')]);
    expect(bad({ momentDays: m.progression.replayRetentionDays })).toEqual([expect.stringContaining('momentDays')]);
    expect(bad({ titleMaxChars: 0 })).toEqual([expect.stringContaining('titleMaxChars')]);
    expect(bad({ freeCoins: 10 } as never)).not.toEqual([]); // strict: there is nothing that could pay
  });
});

describe('REQ-MYRP-014 KPI', () => {
  it('replay_share is a client event; replay_save / replay_view are server-only', () => {
    expect(clientBatchSchema.safeParse({ platform: 'ios', appVersion: '1', events: [{ name: 'replay_share', at: 1, props: { surface: 'my_replays' } }] }).success).toBe(true);
    expect(clientBatchSchema.safeParse({ platform: 'ios', appVersion: '1', events: [{ name: 'replay_share', at: 1, props: { surface: 'x' } }] }).success).toBe(false);
    expect(clientBatchSchema.safeParse({ platform: 'ios', appVersion: '1', events: [{ name: 'replay_save', at: 1, props: {} }] }).success).toBe(false);
  });
});

describe('§37 HTTP', () => {
  it('routes, idempotency key, validation; titles never translated in English', async () => {
    const w = world();
    await w.player('u'); await w.player('v');
    await w.race('r1', ['u', 'v']);
    const svc = w.svc;
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
    const c = { master: m, authenticate: async () => 'u', player: () => invoker, clock: w.now, myReplays: w.replays } as unknown as AppContext;
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await handle(new Request(`https://x${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), {}, c);
      return { status: res.status, body: (await res.json()) as any };
    };
    expect((await call('GET', '/v1/replays')).body).toMatchObject({ enabled: true, used: 0 });
    expect((await call('POST', '/v1/replays', { raceId: 'r1' })).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await call('POST', '/v1/replays', { raceId: 'r1', extra: 1 }, { 'idempotency-key': 'k1' })).status).toBe(400);
    // a title equal to a translated table entry stays as typed
    const s = await call('POST', '/v1/replays', { raceId: 'r1', replayTitle: '1着' }, { 'idempotency-key': 'k1', 'accept-language': 'en' });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.saved.replayTitle).toBe('1着');
    expect((await call('PATCH', '/v1/replays/r1', {})).status).toBe(400);
    expect((await call('PATCH', '/v1/replays/r1', { public: true })).body.saved.public).toBe(true);
    const d = await call('GET', '/v1/replays/r1/data', undefined, { 'accept-language': 'en' });
    expect(d.body.replayTitle).toBe('1着');
    const stored = JSON.parse((await w.store.get(savedReplayKey('u', 'r1')))!);
    expect(d.body.replayLog.config.entrants[0].horse.name).toBe(stored.log.config.entrants[0].horse.name); // the log is never translated
    expect((await call('GET', '/v1/replays/zz/data')).status).toBe(404);
    expect((await call('GET', '/v1/friends/v/replays')).status).toBe(404);
    expect((await call('DELETE', '/v1/replays/r1')).body.deleted).toBe(true);
    expect((await call('DELETE', '/v1/replays/r1')).body.deleted).toBe(false);
    const off = { ...c, myReplays: undefined } as AppContext;
    expect((await handle(new Request('https://x/v1/replays'), {}, off)).status).toBe(404);
  });
});
