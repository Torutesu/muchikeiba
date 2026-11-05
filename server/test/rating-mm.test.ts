import { describe, expect, it } from 'vitest';
import { updateRace, updateRating } from '../src/domain/rating.js';
import { FriendRooms, MatchmakerCore, cpuLevelFor, type QueueEntry } from '../src/domain/matchmaker.js';
import { rollSeason } from '../src/domain/season.js';
import { seededRng } from '../src/domain/rng.js';
import { freshPlayer, m } from './helpers.js';
import type { AppError } from '../src/domain/errors.js';

const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as AppError).code; } return 'NO_ERROR'; };

describe('Glicko-2 (REQ-RATE-001)', () => {
  it('matches the reference example from Glickman (2012)', () => {
    const r = updateRating({ r: 1500, rd: 200, vol: 0.06 }, [
      { opponent: { r: 1400, rd: 30, vol: 0.06 }, score: 1 },
      { opponent: { r: 1550, rd: 100, vol: 0.06 }, score: 0 },
      { opponent: { r: 1700, rd: 300, vol: 0.06 }, score: 0 },
    ]);
    expect(r.r).toBeCloseTo(1464.06, 1);
    expect(r.rd).toBeCloseTo(151.52, 1);
    expect(r.vol).toBeCloseTo(0.05999, 4);
  });
  it('decomposes a race into human pairs: winner up, loser down, symmetric field stays balanced', () => {
    const base = { r: 1500, rd: 200, vol: 0.06 };
    const ratings = new Map([['a', base], ['b', base], ['c', base]]);
    const out = updateRace(ratings, ['a', 'b', 'c']);
    expect(out.get('a')!.r).toBeGreaterThan(1500);
    expect(out.get('c')!.r).toBeLessThan(1500);
    expect(out.get('b')!.r).toBeCloseTo(1500, 5);
    expect(out.get('a')!.r - 1500).toBeCloseTo(1500 - out.get('c')!.r, 5);
  });
});

describe('season classes (REQ-RATE-002)', () => {
  it('promotes / demotes at season rollover and resets points and pass', () => {
    const s = freshPlayer();
    s.season.points = 350;
    s.seasonPass.xp = 900;
    const r = rollSeason(m, s, Date.UTC(2026, 11, 2));
    expect(r).toEqual({ closed: true, from: 'C', to: 'B' });
    expect(s.season).toEqual({ id: '2026-12', classId: 'B', points: 0, races: 0 });
    expect(s.seasonPass.xp).toBe(0);
    s.season.points = 10;
    expect(rollSeason(m, s, Date.UTC(2027, 0, 2)).to).toBe('C');
    expect(rollSeason(m, s, Date.UTC(2027, 0, 3)).closed).toBe(false);
  });
});

describe('matchmaker (REQ-MM-001..003)', () => {
  const e = (id: string, rating: number, at: number, beginner = false): QueueEntry<null> => ({ playerId: id, rating, beginner, enqueuedAt: at, payload: null });

  it('starts immediately with 12 close players', () => {
    const mm = new MatchmakerCore<null>();
    for (let i = 0; i < 12; i++) mm.enqueue(e(`p${i}`, 1500 + i * 5, 0));
    const r = mm.tick(1);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ cpuCount: 0, beginner: false });
    expect(mm.size).toBe(0);
  });
  it('does not mix far ratings early, widens the window over time, fills with CPU after 15s', () => {
    const mm = new MatchmakerCore<null>();
    mm.enqueue(e('low', 1200, 0));
    mm.enqueue(e('high', 1700, 0));
    expect(mm.tick(5000)).toEqual([]);
    const r = mm.tick(15_000);
    // 500 apart: window at 15s = 100 + 25*15 = 475 < 500 → separate CPU-filled races
    expect(r).toHaveLength(2);
    expect(r.every((x) => x.players.length === 1 && x.cpuCount === 11)).toBe(true);
    const mm2 = new MatchmakerCore<null>();
    mm2.enqueue(e('a', 1500, 0));
    mm2.enqueue(e('b', 1800, 0));
    const r2 = mm2.tick(15_000);
    expect(r2).toHaveLength(1);
    expect(r2[0]!.players.map((p) => p.playerId)).toEqual(['a', 'b']);
  });
  it('keeps beginners separate with easy CPU', () => {
    const mm = new MatchmakerCore<null>();
    mm.enqueue(e('new', 1500, 0, true));
    mm.enqueue(e('vet', 1500, 0, false));
    const r = mm.tick(15_000);
    expect(r).toHaveLength(2);
    expect(r.find((x) => x.beginner)!.cpuLevel).toBe(1);
    expect(cpuLevelFor(1900, false)).toBe(5);
  });
  it('queue errors and persistence', () => {
    const mm = new MatchmakerCore<null>();
    mm.enqueue(e('a', 1500, 0));
    expect(code(() => mm.enqueue(e('a', 1500, 0)))).toBe('ALREADY_QUEUED');
    const copy = MatchmakerCore.fromJSON<null>(JSON.parse(JSON.stringify(mm.toJSON())));
    expect(copy.has('a')).toBe(true);
    mm.cancel('a');
    expect(code(() => mm.cancel('a'))).toBe('NOT_IN_QUEUE');
  });
  it('friend rooms: passphrase join, host-only start, capacity', () => {
    const fr = new FriendRooms<null>(3);
    const room = fr.create('host', null, 0, seededRng(1));
    expect(room.passphrase).toMatch(/^\d{6}$/);
    fr.join(room.passphrase, 'a', null, 1);
    fr.join(room.passphrase, 'b', null, 1);
    expect(code(() => fr.join(room.passphrase, 'c', null, 1))).toBe('ROOM_FULL');
    expect(code(() => fr.start(room.passphrase, 'a'))).toBe('NOT_HOST');
    expect(fr.start(room.passphrase, 'host').members).toHaveLength(3);
    expect(code(() => fr.join('000000', 'x', null, 1))).toBe('ROOM_NOT_FOUND');
  });
});
