import { describe, expect, it } from 'vitest';
import { RaceRoomCore, SPECTATE_DELAY_MS, spectateDelayMsFor } from '../src/domain/raceRoom.js';
import { seededRng } from '../src/domain/rng.js';
import { liveRaceOf, SpectateService, LIVE_RACE_TTL_MS, type LiveRace } from '../src/domain/spectate.js';
import { signTicket, verifyTicket } from '../src/http/ticket.js';
import { createRace } from '../src/race/orchestrate.js';
import { makeConfig, m } from './helpers.js';

const START = 1000;
const at = (tick: number) => START + (tick + 1) * 50;
const H = (c: string) => c.repeat(64).slice(0, 64);

function room(mode: 'ranked' | 'friend' | 'tournament', humans = 2) {
  const cfg = makeConfig(humans, mode === 'tournament' ? 'tournament' : mode);
  const r = new RaceRoomCore(cfg, START, { verifySampleRate: 0, resultWaitMs: 5000, rng: seededRng(7) });
  for (const s of r.humanSlots) r.hello(s, -1, 0);
  return r;
}

describe('spectator stream (REQ-SPEC-002..004)', () => {
  it('delay by mode: friend rooms live, races with something at stake 10 s behind', () => {
    expect(spectateDelayMsFor('friend')).toBe(0);
    for (const mode of ['ranked', 'event', 'tournament']) expect(spectateDelayMsFor(mode)).toBe(SPECTATE_DELAY_MS);
    expect(room('friend').spectatorStart()).toMatchObject({ t: 'start', you: -1, spectator: { delayMs: 0 } });
    expect(room('ranked').spectatorStart()).toMatchObject({ you: -1, spectator: { delayMs: 10_000 } });
  });

  it('spectators only get ticks already sent to the players, held back by the delay', () => {
    const live = room('friend');
    live.advance(at(9));
    expect(live.spectatorFrontier(at(9))).toBe(9);
    live.advance(at(10)); // 1 tick: not bundled to the players yet → not to spectators either
    expect(live.lastConfirmedTick).toBe(10);
    expect(live.spectatorFrontier(at(10))).toBe(9);

    const ranked = room('ranked');
    ranked.advance(at(400));
    expect(ranked.spectatorFrontier(at(400))).toBe(-1 + 0 + Math.floor(((at(400) - 10_000 - START) * 20) / 1000));
    expect(ranked.spectatorFrontier(at(400))).toBeLessThan(ranked.lastConfirmedTick - 150);
    // the bundle range carries exactly the confirmed inputs of that range
    expect(ranked.bundleRange(0, 5)).toEqual({ t: 'b', from: 0, to: 5, in: ranked.replayLog().inputs.filter(([t]) => t <= 5) });
  });

  it('the verdict reaches a spectator only after they have seen every tick', () => {
    const r = room('friend');
    const [a, b] = r.humanSlots as [number, number];
    const e = r.minResultTick + 20;
    for (let t = 0; t <= e; t += 20) { r.advance(at(Math.min(t, e))); for (const x of [a, b]) r.message(x, { t: 'ping', c: 0 }, at(Math.min(t, e))); }
    r.advance(at(e));
    expect(r.spectatorFinal(e)).toBeNull(); // still running
    r.message(a, { t: 'res', h: H('a'), order: [a, b] }, at(e));
    r.message(b, { t: 'res', h: H('a'), order: [a, b] }, at(e));
    expect(r.phase).toBe('final');
    expect(r.lastSpectatorTick).toBe(e);
    expect(r.spectatorFinal(e - 1)).toBeNull();
    expect(r.spectatorFinal(r.lastSpectatorTick)).toMatchObject({ t: 'final', status: 'confirmed', h: H('a') });
  });

  it('tournament heats are verified like ranked races, and report no-shows', () => {
    const r = room('tournament', 3);
    const cfg = r.config;
    const fresh = new RaceRoomCore(cfg, START, { verifySampleRate: 0, resultWaitMs: 5000, rng: seededRng(7) });
    const [a, b] = fresh.humanSlots as [number, number, number];
    fresh.hello(a, -1, 0);
    fresh.hello(b, -1, 0);
    expect(fresh.noShowSlots()).toEqual([fresh.humanSlots[2]]);
    expect(fresh.heatSummary()).toMatchObject({ phase: 'running', final: null, noShows: [fresh.humanSlots[2]] });
    expect(fresh.heatSummary().slots.map((s) => s.playerId).sort()).toEqual(['p0', 'p1', 'p2']);
    // a solo human in a tournament heat is never trusted alone
    const solo = new RaceRoomCore(makeConfig(1, 'tournament'), START, { verifySampleRate: 0, resultWaitMs: 5000, rng: seededRng(1) });
    const s0 = solo.humanSlots[0]!;
    solo.hello(s0, -1, 0);
    solo.advance(at(solo.minResultTick + 5));
    const out = solo.message(s0, { t: 'res', h: H('a'), order: [s0] }, at(solo.minResultTick + 5));
    expect(out.some((o) => o.msg.t === 'final' && o.msg.status === 'verifying')).toBe(true);
  });
});

describe('live list and spectator tickets (REQ-SPEC-001/002)', () => {
  const NOW = 10_000_000;
  const mk = (raceId: string, o: Partial<LiveRace>): LiveRace => ({ raceId, mode: 'ranked', startAtMs: NOW - 60_000, trackId: 't', visibility: 'public', playerIds: [], rating: 1500, delayMs: 10_000, title: null, tournamentId: null, ...o });
  const races = [
    mk('r_rank_hi', { playerIds: ['x1', 'x2'], rating: 1900 }),
    mk('r_rank_lo', { playerIds: ['x3', 'x4'], rating: 1400 }),
    mk('r_tour', { mode: 'tournament', playerIds: ['x5'], rating: 1300, title: '杯 1回戦 第1組', tournamentId: 'cup' }),
    mk('r_friend', { mode: 'friend', visibility: 'friends', playerIds: ['pal', 'z'], delayMs: 0 }),
    mk('r_stranger_room', { mode: 'friend', visibility: 'friends', playerIds: ['s1', 's2'], delayMs: 0 }),
    mk('r_old', { startAtMs: NOW - LIVE_RACE_TTL_MS - 1 }),
  ];
  const svc = new SpectateService({
    liveRaces: async () => races,
    liveRace: async (id) => races.find((r) => r.raceId === id) ?? null,
    friendIds: async (u) => (u === 'me' ? ['pal'] : []),
    signTicket: (t) => signTicket(t, 'secret'),
  }, () => NOW);

  it('friends first, then featured public races (tournament heats, then rating); other people\'s rooms hidden', async () => {
    const l = await svc.list('me');
    expect(l.friends.map((r) => r.raceId)).toEqual(['r_friend']);
    expect(l.friends[0]).toMatchObject({ friends: ['pal'], players: 2, you: false });
    expect(l.featured.map((r) => r.raceId)).toEqual(['r_tour', 'r_rank_hi', 'r_rank_lo']);
    expect(JSON.stringify(l)).not.toContain('"playerIds"');
  });

  it('read-only ticket for slot -1; friend rooms only for friends of a participant', async () => {
    const t = await svc.spectate('me', 'r_friend');
    expect(t).toMatchObject({ raceId: 'r_friend', wsPath: '/v1/race/r_friend/ws', delayMs: 0 });
    expect(await verifyTicket(t.ticket, 'secret', 'r_friend', NOW)).toMatchObject({ slot: -1, playerId: 'me' });
    await expect(svc.spectate('me', 'r_stranger_room')).rejects.toThrow(/friends/);
    await expect(svc.spectate('me', 'r_old')).rejects.toThrow(/not live/);
    expect((await svc.spectate('anyone', 'r_rank_hi')).delayMs).toBe(10_000);
  });

  it('every created race except tutorials is listed with its visibility', async () => {
    const humans = [0, 1].map((i) => ({
      playerId: `p${i}`, horse: makeConfig(2).entrants[i]!.horse, rating: { r: 1500 + i * 100, rd: 50, vol: 0.06 }, statCap: 3200, visual: undefined,
    })) as never;
    const ranked = await createRace(m, { mode: 'ranked', humans, cpuCount: 2, cpuLevel: 3, rng: seededRng(1), now: 0, ticketSecret: 's' });
    expect(liveRaceOf(ranked, null)).toMatchObject({ mode: 'ranked', visibility: 'public', rating: 1550, delayMs: 10_000 });
    const friend = await createRace(m, { mode: 'friend', humans, cpuCount: 0, cpuLevel: 3, rng: seededRng(2), now: 0, ticketSecret: 's' });
    expect(liveRaceOf(friend, null)).toMatchObject({ visibility: 'friends', delayMs: 0 });
    const tut = await createRace(m, { mode: 'tutorial', humans: [(humans as never[])[0]!] as never, cpuCount: 11, cpuLevel: 1, rng: seededRng(3), now: 0, ticketSecret: 's' });
    expect(liveRaceOf(tut, null)).toBeNull();
    // tournament heats start at their scheduled time and carry the tournament's stat cap
    const heat = await createRace(m, { mode: 'tournament', humans, cpuCount: 2, cpuLevel: 3, rng: seededRng(4), now: 0, ticketSecret: 's', startAtMs: 60_000, statCap: null, trackId: 'aoba_dirt_1400' });
    expect(heat.startAtMs).toBe(60_000);
    expect(heat.config.mode).toBe('tournament');
    expect(liveRaceOf(heat, { title: '杯 決勝', tournamentId: 'cup' })).toMatchObject({ title: '杯 決勝', tournamentId: 'cup', visibility: 'public' });
  });
});
