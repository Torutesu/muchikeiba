import { describe, expect, it } from 'vitest';
import { buildSnapshot, newRolloverState, previousSeasonId, rolloverStep, seasonIsOver, acceptEntry, boardKey, indexKey, type SeasonEntry, type BoardFile } from '../src/domain/leaderboard.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { closeSeason, rollSeason, seasonRewardFor } from '../src/domain/season.js';
import { runScheduled, CRONS } from '../src/domain/scheduled.js';
import { replaysToDelete, sweepReplays, type ReplayBucket } from '../src/domain/retention.js';
import { DAY_MS } from '../src/domain/time.js';
import { applyRaceResult, applyRatingChange, type RaceResultForPlayer } from '../src/domain/rewards.js';
import { FriendRooms, MatchmakerCore, assertNotInLiveRace, LIVE_RACE_MS, type QueueEntry } from '../src/domain/matchmaker.js';
import { RaceRoomCore } from '../src/domain/raceRoom.js';
import { driveSettlement, newSettleMeta, MAX_VERIFY_ATTEMPTS, type SettleDeps } from '../src/race/settlement.js';
import { settleRace } from '../src/race/orchestrate.js';
import { CMD } from '../src/domain/raceRoom.js';
import type { SeasonEntry as SE } from '../src/domain/leaderboard.js';
import { freshPlayer, m, makeConfig } from './helpers.js';

const NOV = Date.UTC(2026, 10, 15, 3); // 2026-11 JST
const DEC = Date.UTC(2026, 11, 1, 3); // 2026-12-01 12:00 JST

const entry = (id: string, classId: string, points: number, rating: number, races = 5, updatedAt = 0): SeasonEntry => ({
  playerId: id, seasonId: '2026-11', classId, points, rating, races, displayName: id.toUpperCase(), titleId: null, updatedAt,
});

describe('leaderboard snapshot (REQ-LB-001/003)', () => {
  const es = [
    entry('a', 'C', 100, 1500, 5, 3), entry('b', 'C', 120, 1490), entry('c', 'C', 100, 1500, 5, 1), entry('d', 'B', 50, 1700),
    entry('e', 'B', 80, 1400), entry('ghost', 'C', 0, 2000, 0), { ...entry('old', 'C', 999, 9999), seasonId: '2026-10' },
  ];
  const snap = buildSnapshot('2026-11', es, NOV, 2);
  const file = (k: string) => snap.files.find((f) => f.key === k)!.body as BoardFile;

  it('ranks per class by points, then rating, then who got there first; top N only', () => {
    const c = file(boardKey('2026-11', 'class-C'));
    expect(c.total).toBe(3);
    expect(c.entries.map((e) => [e.rank, e.playerId])).toEqual([[1, 'b'], [2, 'c']]); // c reached 100 before a
    expect(file(boardKey('2026-11', 'class-B')).entries.map((e) => e.playerId)).toEqual(['e', 'd']);
  });
  it('builds an all-class rating board and an index; skips 0-race and other-season entries', () => {
    expect(file(boardKey('2026-11', 'rating')).entries.map((e) => e.playerId)).toEqual(['d', 'a']);
    const idx = snap.files.find((f) => f.key === indexKey('2026-11'))!.body as { boards: { board: string; total: number }[] };
    expect(idx.boards).toEqual([{ board: 'class-B', total: 2, key: boardKey('2026-11', 'class-B') }, { board: 'class-C', total: 3, key: boardKey('2026-11', 'class-C') }, { board: 'rating', total: 5, key: boardKey('2026-11', 'rating') }]);
    expect(snap.ranks.has('ghost')).toBe(false);
    expect(snap.ranks.has('old')).toBe(false);
  });
  it('stores every participant’s rank for "my rank"', () => {
    expect(snap.ranks.get('a')).toEqual({ classId: 'C', classRank: 3, classTotal: 3, ratingRank: 2, ratingTotal: 5 });
  });
  it('refuses entries for another season or after the season started closing', () => {
    expect(acceptEntry('2026-11', 'open', entry('x', 'C', 1, 1))).toBe(true);
    expect(acceptEntry('2026-11', 'closing', entry('x', 'C', 1, 1))).toBe(false);
    expect(acceptEntry('2026-12', 'open', entry('x', 'C', 1, 1))).toBe(false);
  });
});

describe('season boundaries (JST)', () => {
  it('computes the previous season and whether a season is over', () => {
    expect(previousSeasonId(DEC)).toBe('2026-11');
    expect(previousSeasonId(Date.UTC(2027, 0, 1, 0))).toBe('2026-12');
    expect(previousSeasonId(Date.UTC(2026, 10, 30, 15, 0))).toBe('2026-11'); // 12-01 00:00 JST
    expect(seasonIsOver('2026-11', Date.UTC(2026, 10, 30, 14, 59))).toBe(false);
    expect(seasonIsOver('2026-11', Date.UTC(2026, 10, 30, 15, 0))).toBe(true);
  });
});

describe('season rollover (REQ-SEASON-001..003)', () => {
  function setup() {
    let now = NOV;
    const entries: SE[] = [];
    const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(2), clock: () => now, verifiers: {}, onSeasonEntry: (e) => { entries.push(e); } });
    return { svc, entries, setNow: (t: number) => { now = t; } };
  }
  const ranked = (id: string, place: number): RaceResultForPlayer => ({ raceId: `r_${id}_${place}_${Math.random()}`, mode: 'ranked', place, fieldSize: 12, newRating: null, void: false, humans: 2 });

  it('pushes standings after ranked races; closing pays each player once with the final rank', async () => {
    const w = setup();
    for (let i = 0; i < 12; i++) await w.svc.applyRace('top', ranked('top', 1)); // 360 points → promotion C→B
    await w.svc.applyRace('mid', ranked('mid', 6));
    await w.svc.view('lazy');
    expect(w.entries.at(-1)).toMatchObject({ playerId: 'mid', seasonId: '2026-11', points: 8, races: 1 });
    const latest = new Map(w.entries.map((e) => [e.playerId, e]));
    const snap = buildSnapshot('2026-11', [...latest.values()], NOV, 100);

    w.setNow(DEC);
    let st = newRolloverState('2026-11');
    const closes: string[] = [];
    let failOnce = true;
    const close = async (pid: string, rank: number | null) => {
      if (pid === 'top' && failOnce) { failOnce = false; throw new Error('transient'); }
      closes.push(pid);
      await w.svc.closeSeason(pid, '2026-11', rank);
    };
    const participants = [...latest.values()].map((e) => ({ playerId: e.playerId, classId: e.classId }));
    st = await rolloverStep(st, participants, (p) => snap.ranks.get(p), close, 1);
    expect(st).toMatchObject({ status: 'closing', cursor: 'mid', processed: 1 });
    st = await rolloverStep(st, participants, (p) => snap.ranks.get(p), close, 1);
    expect(st).toMatchObject({ status: 'closing', cursor: 'mid', lastError: expect.stringContaining('top') }); // resumable: cursor did not move
    st = await rolloverStep(st, participants, (p) => snap.ranks.get(p), close, 1);
    expect(st).toMatchObject({ cursor: 'top', processed: 2 });
    st = await rolloverStep(st, participants, (p) => snap.ranks.get(p), close, 1);
    expect(st.status).toBe('closed');
    expect(closes).toEqual(['mid', 'top']);

    const top = await w.svc.state('top');
    expect(top.season).toMatchObject({ id: '2026-12', classId: 'B', points: 0, races: 0 });
    expect(top.seasonHistory[0]).toMatchObject({ seasonId: '2026-11', classId: 'C', nextClassId: 'B', rank: 1, rewarded: true });
    const coinsAfter = top.wallet.free;
    // re-running the close (cron overlap) pays nothing more
    expect((await w.svc.closeSeason('top', '2026-11', 1)).status).toBe('already');
    expect((await w.svc.state('top')).wallet.free).toBe(coinsAfter);
    expect(top.ledger.some((l) => l.ref === 'season:2026-11' && l.delta === 300)).toBe(true); // C rank ≤10 band
  });

  it('a player who acted in the new month before the job still gets the old season’s reward', async () => {
    const w = setup();
    await w.svc.applyRace('early', ranked('early', 2));
    w.setNow(DEC);
    await w.svc.bootstrap('early'); // lazy rollSeason closes the season first
    const r = await w.svc.closeSeason('early', '2026-11', 42);
    expect(r).toMatchObject({ status: 'rewarded', reward: { freeCoins: 150 } });
  });

  it('season reward bands and no reward without races', () => {
    expect(seasonRewardFor(m, 'S', 1)).toMatchObject({ freeCoins: 3000 });
    expect(seasonRewardFor(m, 'S', 2)).toMatchObject({ freeCoins: 1500 });
    expect(seasonRewardFor(m, 'S', null)).toMatchObject({ freeCoins: 200 });
    const s = freshPlayer();
    rollSeason(m, s, DEC);
    expect(closeSeason(m, s, '2026-11', null, DEC)).toMatchObject({ status: 'rewarded', reward: null });
    expect(closeSeason(m, s, '2026-10', null, DEC)).toMatchObject({ status: 'no-record' });
  });
});

describe('scheduled dispatch', () => {
  it('runs snapshot + previous-season rollover every 5 minutes and the sweep daily', async () => {
    const calls: string[] = [];
    const deps = {
      snapshot: async (s: string) => { calls.push(`snap ${s}`); },
      rolloverStep: async (s: string) => { calls.push(`roll ${s}`); return { status: 'closed' }; },
      sweepReplays: async () => { calls.push('sweep'); return { deleted: 3 }; },
    };
    // the last ROLLOVER_LOOKBACK seasons are stepped (closed ones are cheap no-ops), newest first
    expect(await runScheduled(CRONS.frequent, DEC, deps)).toEqual(['snapshot', 'rollover:2026-11:closed', 'rollover:2026-10:closed', 'rollover:2026-09:closed']);
    expect(await runScheduled(CRONS.daily, DEC, deps)).toEqual(['sweep:3']);
    expect(await runScheduled('0 0 * * *', DEC, deps)).toEqual(['unknown:0 0 * * *']);
    expect(calls).toEqual(['snap 2026-12', 'roll 2026-11', 'roll 2026-10', 'roll 2026-09', 'sweep']);
  });
});

describe('replay retention (REQ-OPS-001)', () => {
  const now = Date.UTC(2026, 11, 31);
  it('deletes only old replays that are not on hold', () => {
    const objs = [
      { key: 'replays/old.json', uploaded: now - 40 * DAY_MS, hold: null },
      { key: 'replays/old-disputed.json', uploaded: now - 40 * DAY_MS, hold: 'disputed' },
      { key: 'replays/new.json', uploaded: now - 2 * DAY_MS, hold: null },
      { key: 'other/old.json', uploaded: now - 40 * DAY_MS, hold: null },
    ];
    expect(replaysToDelete(objs, now, 30)).toEqual(['replays/old.json']);
  });
  it('sweeps page by page', async () => {
    const store = new Map<string, { uploaded: Date; customMetadata?: Record<string, string> }>();
    for (let i = 0; i < 2500; i++) store.set(`replays/r${String(i).padStart(4, '0')}.json`, { uploaded: new Date(now - (i % 2 ? 40 : 1) * DAY_MS), ...(i % 10 === 1 ? { customMetadata: { hold: 'reported' } } : {}) });
    const bucket: ReplayBucket = {
      async list({ prefix, cursor, limit = 1000 }) {
        const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
        const start = cursor ? keys.findIndex((k) => k > cursor) : 0;
        const page = keys.slice(start, start + limit);
        const truncated = start + limit < keys.length;
        return { objects: page.map((k) => ({ key: k, ...store.get(k)! })), truncated, ...(truncated ? { cursor: page.at(-1)! } : {}) };
      },
      async delete(keys) { for (const k of keys) store.delete(k); },
    };
    const r = await sweepReplays(bucket, now, 30);
    expect(r).toEqual({ deleted: 1000, scanned: 2500, reachedEnd: true }); // 1250 old, 250 of them on hold
    expect(store.size).toBe(1500);
  });
});

describe('room retention hold', () => {
  it('holds reported, disputed, verified and void races; releases clean consensus', () => {
    const mk = () => { const r = new RaceRoomCore(makeConfig(2, 'friend'), 0, { verifySampleRate: 0, resultWaitMs: 1, rng: seededRng(1) }); return r; };
    const r = mk();
    expect(r.retentionHold()).toBeNull();
    r.report();
    expect(r.retentionHold()).toBe('reported');
  });
});

describe('friend race rewards (REQ-REW-004) and rating deltas (REQ-RATE-004)', () => {
  const friend = (raceId: string, humans: number): RaceResultForPlayer => ({ raceId, mode: 'friend', place: 1, fieldSize: humans, newRating: null, void: false, humans });

  it('pays nothing for a solo friend race and caps paid friend races per day', () => {
    const s = freshPlayer();
    expect(applyRaceResult(m, s, friend('solo', 1), NOV)).toMatchObject({ coins: 0, rewarded: false });
    expect(s.seasonPass.xp).toBe(0);
    for (let i = 0; i < m.progression.friendRewardDailyCap; i++) expect(applyRaceResult(m, s, friend(`f${i}`, 2), NOV).rewarded).toBe(true);
    expect(applyRaceResult(m, s, friend('over', 2), NOV)).toMatchObject({ coins: 0, rewarded: false });
    expect(applyRaceResult(m, s, friend('tomorrow', 2), NOV + DAY_MS).rewarded).toBe(true);
  });

  it('applies the rating change as a delta when the rating moved since the race snapshot', () => {
    const s = freshPlayer();
    s.rating = { r: 1600, rd: 80, vol: 0.06, rankedRaces: 10 };
    applyRatingChange(s, { r: 1500, rd: 90, vol: 0.06 }, { r: 1520, rd: 85, vol: 0.059 });
    expect(s.rating).toEqual({ r: 1620, rd: 80, vol: 0.059, rankedRaces: 10 });
    applyRatingChange(s, { r: 1620, rd: 80, vol: 0.059 }, { r: 1630, rd: 75, vol: 0.058 });
    expect(s.rating).toEqual({ r: 1630, rd: 75, vol: 0.058, rankedRaces: 10 });
  });
});

describe('matchmaker hardening (REQ-MM-004/005)', () => {
  it('friend rooms need two humans, survive a JSON round trip and know their members', () => {
    const fr = new FriendRooms<null>();
    const r = fr.create('host', null, 0, seededRng(4));
    expect(() => fr.start(r.passphrase, 'host')).toThrow(expect.objectContaining({ code: 'ROOM_TOO_SMALL' }));
    fr.join(r.passphrase, 'guest', null, 1);
    const copy = FriendRooms.fromJSON<null>(JSON.parse(JSON.stringify(fr.toJSON())));
    expect(copy.isMember(r.passphrase, 'guest')).toBe(true);
    expect(copy.isMember(r.passphrase, 'stranger')).toBe(false);
    expect(copy.start(r.passphrase, 'host').members).toHaveLength(2);
  });
  it('requeues players of a match that failed to start, keeping their wait time', () => {
    const mm = new MatchmakerCore<null>();
    const e: QueueEntry<null> = { playerId: 'a', rating: 1500, beginner: false, enqueuedAt: 5, payload: null };
    mm.enqueue(e);
    const [match] = mm.tick(20_000);
    expect(mm.size).toBe(0);
    mm.requeue(match!.players);
    expect(mm.entries()).toEqual([e]);
    mm.requeue(match!.players);
    expect(mm.size).toBe(1);
  });
  it('refuses a second race while one is live', () => {
    const a = new Map([['p', { at: 1000 }]]);
    expect(() => assertNotInLiveRace(a, 'p', 1000 + LIVE_RACE_MS - 1)).toThrow(expect.objectContaining({ code: 'ALREADY_IN_RACE' }));
    expect(() => assertNotInLiveRace(a, 'p', 1000 + LIVE_RACE_MS)).not.toThrow();
    expect(() => assertNotInLiveRace(a, 'q', 1000)).not.toThrow();
  });
});

describe('settlement driver (REQ-NET-014)', () => {
  const H = (c: string) => c.repeat(64);
  function verifyingRoom() {
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
    r.message(r.humanSlots[0]!, { t: 'res', h: H('a'), order: [0, 1] }, at(e));
    r.message(r.humanSlots[1]!, { t: 'res', h: H('b'), order: [1, 0] }, at(e)); // split → verify
    expect(r.phase).toBe('verifying');
    return r;
  }
  function deps(o: { verifyFails?: number; applyFails?: Record<string, number> } = {}) {
    const log: string[] = [];
    let vf = o.verifyFails ?? 0;
    const af = { ...(o.applyFails ?? {}) };
    const applied: string[] = [];
    const d: SettleDeps = {
      verify: async (l) => { log.push('verify'); if (vf-- > 0) throw new Error('down'); return { resultHash: H('b'), order: l.config.entrants.map((e) => e.slot).reverse(), finishTicks: l.config.entrants.map(() => 1850), checksums: {} }; },
      putReplay: async (_l, hold) => { log.push(`put:${hold}`); },
      applyRace: async (pid) => { if ((af[pid] ?? 0) > 0) { af[pid]!--; throw new Error('player DO busy'); } applied.push(pid); },
      raceFinished: async (p) => { log.push(`finished:${p.join(',')}`); },
      persist: async () => { log.push('persist'); },
    };
    return { d, log, applied };
  }

  it('verifies, then settles every player once and frees their assignment', async () => {
    const r = verifyingRoom();
    const meta = newSettleMeta({});
    const { d, log, applied } = deps();
    const res = await driveSettlement(r, meta, d, 1000);
    expect(res.out.at(-1)!.msg).toMatchObject({ t: 'final', status: 'confirmed', h: H('b') });
    expect(meta).toMatchObject({ settled: true, verifyAttempts: 1, pending: [] });
    expect(applied.sort()).toEqual(['p0', 'p1']);
    expect(log.filter((x) => x.startsWith('put:'))).toEqual(['put:verifying', 'put:disputed']);
    expect(log.at(-1)).toBe('finished:p0,p1');
    const starter = r.config.entrants.find((e) => e.slot === r.humanSlots[0])!.playerId!;
    expect(meta.results![starter]!.details).toMatchObject({ startReactionTicks: 62 - (r.config.ruleset.gateOpenTick as number), finishTick: 1850 });
    // a second drive does nothing
    const again = await driveSettlement(r, meta, d, 2000);
    expect(again.out).toEqual([]);
    expect(applied).toHaveLength(2);
  });

  it('retries a failing verifier with backoff before voiding', async () => {
    const r = verifyingRoom();
    const meta = newSettleMeta({});
    const { d } = deps({ verifyFails: 99 });
    let now = 0;
    for (let i = 1; i < MAX_VERIFY_ATTEMPTS; i++) {
      const res = await driveSettlement(r, meta, d, now);
      expect(r.phase).toBe('verifying');
      expect(res.retryAt).toBeGreaterThan(now);
      expect((await driveSettlement(r, meta, d, now + 1)).out).toEqual([]); // not before retryAt
      now = res.retryAt!;
    }
    await driveSettlement(r, meta, d, now);
    expect(r.final?.status).toBe('void');
    expect(meta.settled).toBe(true);
  });

  it('a transient verifier failure does not void the race', async () => {
    const r = verifyingRoom();
    const meta = newSettleMeta({});
    const { d } = deps({ verifyFails: 1 });
    const first = await driveSettlement(r, meta, d, 0);
    await driveSettlement(r, meta, d, first.retryAt!);
    expect(r.final?.status).toBe('confirmed');
  });

  it('retries only the players whose application failed', async () => {
    const r = verifyingRoom();
    const meta = newSettleMeta({});
    const { d, applied } = deps({ applyFails: { p1: 2 } });
    let res = await driveSettlement(r, meta, d, 0);
    expect(meta.pending).toEqual(['p1']);
    expect(meta.settled).toBe(false);
    res = await driveSettlement(r, meta, d, res.retryAt!);
    res = await driveSettlement(r, meta, d, res.retryAt!);
    expect(meta.settled).toBe(true);
    expect(applied).toEqual(['p0', 'p1']);
  });

  it('settleRace carries humans, rating snapshot and ride details', () => {
    const cfg = makeConfig(2, 'friend');
    const out = settleRace(cfg, { status: 'confirmed', order: [1, 0], hash: H('a'), via: 'consensus', suspects: [] }, { p0: { r: 1500, rd: 300, vol: 0.06 } }, { v: 1, config: cfg, endTick: 10, inputs: [] });
    expect(out.p0).toMatchObject({ humans: 2, oldRating: { r: 1500 }, details: { trackId: cfg.track.id, finishTick: null } });
    const tut = settleRace(makeConfig(1, 'tutorial'), { status: 'confirmed', order: [0], hash: H('a'), via: 'consensus', suspects: [] }, {}, { v: 1, config: makeConfig(1, 'tutorial'), endTick: 10, inputs: [] });
    expect(tut.p0!.details).toBeNull();
  });
});
