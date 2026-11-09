import { describe, expect, it } from 'vitest';
import { handle, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { hallPlayersFrom } from '../src/http/hallPorts.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { createHorseFromTemplate } from '../src/domain/horses.js';
import { ensureTeam } from '../src/domain/teams.js';
import {
  HallService, MemoryHallDirectory, biggerWin, hallConfig, hallProblems, hallSnapshot, noteHallTa, pickHighlights, type HallSnapshot,
} from '../src/domain/hallOfFame.js';
import type { RaceResultForPlayer } from '../src/domain/rewards.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import type { Master } from '../src/domain/master.js';
import type { PlayerState } from '../src/domain/player.js';
import { m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 5, 3);
const DAY = 86_400_000;
const cfg = hallConfig(m)!;
const FRAME = cfg.rewardItemId;

interface World {
  svc: PlayerService; dir: MemoryHallDirectory; hall: HallService; clock: { now: number };
  kpi: { id: string; r: KpiRecord }[]; invoker: PlayerInvoker; repo: MemoryPlayerRepo;
}

function world(master: Master = m): World {
  const clock = { now: NOW };
  const kpi: World['kpi'] = [];
  const dir = new MemoryHallDirectory();
  const repo = new MemoryPlayerRepo();
  const svc = new PlayerService(repo, {
    master, rng: seededRng(7), clock: () => clock.now, verifiers: {},
    onKpi: (id, recs) => { for (const r of recs) kpi.push({ id, r }); },
    onHall: async (id: string, snap: HallSnapshot | null) => { if (snap) await dir.put(snap); else await dir.remove(id); },
  });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  return { svc, dir, hall: new HallService(hallPlayersFrom(() => invoker), dir, () => hallConfig(master)), clock, kpi, invoker, repo };
}

async function horse(w: World, id: string, opts: { partner?: boolean; friends?: string[]; team?: string; tpl?: number } = {}) {
  return w.svc.tx(id, null, (s, now) => {
    const h = createHorseFromTemplate(s, m.templates[opts.tpl ?? 0]!, now);
    if (opts.partner) s.flags.partnerHorseId = h.id;
    for (const f of opts.friends ?? []) if (!s.friends.ids.includes(f)) s.friends.ids.push(f);
    if (opts.team) ensureTeam(s).teamId = opts.team;
    return h.id;
  });
}

let seq = 0;
const race = (horseId: string, place: number, o: Partial<RaceResultForPlayer> = {}): RaceResultForPlayer => ({
  raceId: `r${++seq}`, mode: 'ranked', place, fieldSize: 8, newRating: null, void: false, humans: 2, horseId,
  details: { trackId: 'aoba_turf_1600', style: 'senko', finishTick: 1000, startReactionTicks: 2, whips: 3, whipMashed: false, cpuAssisted: false }, ...o,
});
async function wins(w: World, id: string, horseId: string, n: number) {
  for (let i = 0; i < n; i++) { await w.svc.applyRace(id, race(horseId, 1)); w.clock.now += 3600_000; }
}
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as AppError).code; } };
const st = async (w: World, id: string) => (await w.svc.state(id)) as PlayerState;

describe('殿堂: config (REQ-HOF-005/007/008)', () => {
  it('the base master is valid and the reward is a not-for-sale decor', () => {
    expect(hallProblems(m)).toEqual([]);
    const item = m.items.cosmetics.find((c) => c.id === FRAME)!;
    expect(item).toMatchObject({ kind: 'decor', price: 0, notForSale: true });
  });
  it('rejects a buyable reward, no rule on and out-of-range limits', () => {
    const bad = (h: object) => hallProblems({ ...m, progression: { ...m.progression, hall: { ...cfg, ...h } } } as Master);
    expect(bad({ rewardItemId: 'decor_flower_box' }).join()).toMatch(/not-for-sale/);
    expect(bad({ criteria: { winsMin: 0, tournamentWin: false, partnerRacesMin: 0 } }).join()).toMatch(/at least one rule/);
    expect(bad({ highlightsMax: 9 }).join()).toMatch(/highlightsMax/);
    expect(bad({ pageSize: 60 }).join()).toMatch(/pageSize/);
  });
});

describe('殿堂: career record from confirmed results (REQ-HOF-001/002)', () => {
  it('counts ranked/event/tournament and 2-human friend races once per race; ignores void, tutorial, solo friend, unknown horses', async () => {
    const w = world();
    const h = await horse(w, 'a');
    const r1 = race(h, 1);
    await w.svc.applyRace('a', r1);
    await w.svc.applyRace('a', r1); // duplicate settlement
    await w.svc.applyRace('a', race(h, 2, { mode: 'event', eventId: undefined }));
    await w.svc.applyRace('a', race(h, 3, { mode: 'friend', humans: 1 }));
    await w.svc.applyRace('a', race(h, 1, { mode: 'friend', humans: 2, fieldSize: 10 }));
    await w.svc.applyRace('a', race(h, 0, { void: true }));
    await w.svc.applyRace('a', race(h, 1, { mode: 'tutorial' }));
    await w.svc.applyRace('a', race('h_nope', 1));
    await w.svc.applyRace('a', race(h, 1, { horseId: undefined }));
    const c = (await st(w, 'a')).hall!.careers[h]!;
    expect(c).toMatchObject({ races: 3, wins: 2, places: 3, byMode: { ranked: { races: 1, wins: 1 }, event: { races: 1, wins: 0 }, friend: { races: 1, wins: 1 } } });
    expect(Object.keys((await st(w, 'a')).hall!.careers)).toEqual([h]);
    // biggest win: ranked beats a friend race even with a smaller field
    expect(c.biggestWin).toMatchObject({ mode: 'ranked', fieldSize: 8 });
    expect(biggerWin({ raceId: 'x', mode: 'tournament', fieldSize: 4, humans: 2, trackId: null, at: 0 }, c.biggestWin)).toBe(true);
  });

  it('records verified time attack bests and tournament ranks with the registered horse (once per tournament)', async () => {
    const w = world();
    const h = await horse(w, 'a');
    await w.svc.tx('a', null, (s, now) => {
      // the helper taRecord calls for a verified, finished run (once per session)
      noteHallTa(m, s, h, 'aoba_turf_1600', 96_000, now);
      noteHallTa(m, s, h, 'aoba_turf_1600', 97_000, now); // slower: kept
      noteHallTa(m, s, h, 'aoba_turf_1600', 95_500, now);
      noteHallTa(m, s, 'h_nope', 'aoba_turf_1600', 90_000, now);
    });
    await w.svc.tournamentClose('a', 'cup1', 1, null, '秋の陣', h);
    await w.svc.tournamentClose('a', 'cup1', 1, null, '秋の陣', h); // retry
    await w.svc.tournamentClose('a', 'cup2', 3, null, '冬の陣', h);
    await w.svc.tournamentClose('a', 'cup3', 1, null, '春の陣', null); // horse unknown: not attributed
    const c = (await st(w, 'a')).hall!.careers[h]!;
    expect(c.tournamentWins).toBe(1);
    expect(c.tournaments.map((t) => [t.tournamentId, t.rank])).toEqual([['cup1', 1], ['cup2', 3]]);
    expect(c.bestTa).toEqual({ aoba_turf_1600: { timeMs: 95_500, at: NOW } });
  });

  it('a ranked race won against the weekly rival counts as a rival win', async () => {
    const w = world();
    const h = await horse(w, 'a');
    await w.svc.tx('a', null, (s, now) => {
      s.rival = { optOut: false, weeks: [], results: [], unseen: null, weeksWon: 0, weeksPlayed: 0 };
      return now;
    });
    // simulate the rival bookkeeping having counted the race (noteRivalRace runs first in applyRace)
    const r = race(h, 1);
    await w.svc.tx('a', null, (s) => { s.rival!.weeks.push({ weekId: 'w', assignment: null, me: 1, them: 0, races: [{ raceId: r.raceId, at: 0, mode: 'ranked', me: 1, them: 2, point: 'me' }], pending: [], rankedRaces: 1, ta: {}, rivalTa: {} }); });
    await w.svc.applyRace('a', r);
    expect((await st(w, 'a')).hall!.careers[h]!.rivalWins).toBe(1);
  });
});

describe('殿堂: retirement ceremony (REQ-HOF-003/004)', () => {
  it('retire returns a deterministic ceremony once; ack is idempotent', async () => {
    const w = world();
    const h = await horse(w, 'a');
    await wins(w, 'a', h, 3);
    await w.svc.applyRace('a', race(h, 2));
    const out = await w.svc.retire('a', h);
    expect(out.status).toBe('retired');
    expect(out.ceremony).toMatchObject({ horseId: h, inducted: false, reasons: [], ackedAt: null, career: { races: 4, wins: 3, places: 4 } });
    expect(out.ceremony!.highlights.map((x) => x.kind)).toEqual(['wins', 'biggest_win', 'career_span']);
    expect(out.ceremony!.highlights[0]!.text).toBe('通算4戦3勝');
    expect(await code(w.svc.retire('a', h))).toBe('HORSE_NOT_ACTIVE');
    expect((await w.svc.hallMine('a', null, null)).pendingCeremonies.map((c) => c.horseId)).toEqual([h]);
    const a1 = await w.svc.hallAck('a', h);
    w.clock.now += 1000;
    const a2 = await w.svc.hallAck('a', h);
    expect(a1).toMatchObject({ already: false });
    expect(a2).toEqual({ horseId: h, ackedAt: a1.ackedAt, already: true });
    expect((await w.svc.hallMine('a', null, null)).pendingCeremonies).toEqual([]);
    expect(await code(w.svc.hallAck('a', 'h_nope'))).toBe('NOT_FOUND');
  });

  it('highlights follow the fixed order and the cap; same record → same lines', () => {
    const c = {
      horseId: 'h', races: 40, wins: 12, places: 25, byMode: {}, tournamentWins: 2, rivalWins: 3, firstRaceAt: NOW, lastRaceAt: NOW + 9 * DAY,
      bestTa: { aoba_turf_1600: { timeMs: 95_400, at: NOW + DAY }, kirameki_turf_2000: { timeMs: 121_000, at: NOW + 2 * DAY } },
      tournaments: [{ tournamentId: 't2', name: '冬の陣', rank: 1, at: NOW + 5 * DAY }, { tournamentId: 't1', name: '秋の陣', rank: 1, at: NOW }],
      biggestWin: { raceId: 'r', mode: 'tournament' as const, fieldSize: 12, humans: 6, trackId: 'aoba_turf_1600', at: NOW },
    };
    const all = pickHighlights(m, { ...cfg, highlightsMax: 8 }, c, true);
    expect(all.map((x) => x.kind)).toEqual(['tournament_win', 'partner', 'wins', 'biggest_win', 'rival_wins', 'ta_best', 'career_span']);
    expect(all[0]!.text).toBe('大会優勝2回（初優勝「秋の陣」）');
    expect(all[5]!.params).toMatchObject({ time: '2:01.0' });
    expect(all[6]!.text).toBe('現役10日・40戦');
    expect(pickHighlights(m, cfg, c, true)).toEqual(all.slice(0, cfg.highlightsMax));
    expect(JSON.stringify(pickHighlights(m, cfg, c, true))).toBe(JSON.stringify(pickHighlights(m, cfg, structuredClone(c), true)));
  });

  it('a horse retired with no race has a ceremony without highlights; broodmares from rewards have none', async () => {
    const w = world();
    const h = await horse(w, 'a');
    const out = await w.svc.retire('a', h);
    expect(out.ceremony).toMatchObject({ inducted: false, highlights: [] });
    expect((await w.svc.horseCareer('a', h)).ceremony).not.toBeNull();
  });
});

describe('殿堂入り (REQ-HOF-005/006/008)', () => {
  it('wins ≥ winsMin inducts; the frame is granted once per account; KPI hof_induct', async () => {
    const w = world();
    const h1 = await horse(w, 'a');
    const h2 = await horse(w, 'a', { tpl: 1 });
    await wins(w, 'a', h1, cfg.criteria.winsMin);
    await wins(w, 'a', h2, cfg.criteria.winsMin);
    const c1 = (await w.svc.retire('a', h1)).ceremony!;
    expect(c1).toMatchObject({ inducted: true, reasons: ['wins'], rewardItemId: FRAME });
    expect((await st(w, 'a')).items[FRAME]).toBe(1);
    const c2 = (await w.svc.retire('a', h2)).ceremony!;
    expect(c2).toMatchObject({ inducted: true, rewardItemId: null });
    expect((await st(w, 'a')).items[FRAME]).toBe(1);
    const kp = w.kpi.filter((k) => k.r.name === 'hof_induct');
    expect(kp.map((k) => [k.r.s1, k.r.value])).toEqual([['wins', cfg.criteria.winsMin], ['wins', cfg.criteria.winsMin]]);
    const mine = await w.svc.hallMine('a', null, null);
    expect(mine.total).toBe(2);
    expect(mine.entries.every((e) => e.frame)).toBe(true);
  });

  it('a tournament title or the partner with enough races also inducts; one short does not', async () => {
    const w = world();
    const t = await horse(w, 'a');
    await w.svc.applyRace('a', race(t, 5));
    await w.svc.tournamentClose('a', 'cup', 1, null, '秋の陣', t);
    expect((await w.svc.retire('a', t)).ceremony).toMatchObject({ inducted: true, reasons: ['tournament'] });
    const p = await horse(w, 'b', { partner: true });
    for (let i = 0; i < cfg.criteria.partnerRacesMin - 1; i++) await w.svc.applyRace('b', race(p, 4));
    const progress = await w.svc.horseCareer('b', p);
    expect(progress.progress.partnerRaces).toEqual({ have: cfg.criteria.partnerRacesMin - 1, need: cfg.criteria.partnerRacesMin });
    expect(progress.qualifies).toBe(false);
    await w.svc.applyRace('b', race(p, 4));
    expect((await w.svc.horseCareer('b', p)).qualifies).toBe(true);
    const cer = (await w.svc.retire('b', p)).ceremony!;
    expect(cer).toMatchObject({ inducted: true, reasons: ['partner'], partner: true });
    expect(cer.highlights[0]!.kind).toBe('partner');
    const q = await horse(w, 'c');
    await wins(w, 'c', q, cfg.criteria.winsMin - 1);
    expect((await w.svc.retire('c', q)).ceremony).toMatchObject({ inducted: false });
    expect((await w.svc.hallMine('c', null, null)).total).toBe(0);
  });

  it('plaques are permanent: renaming follows the live name, a horse gone from the list keeps its plaque', async () => {
    const w = world();
    const h = await horse(w, 'a');
    await wins(w, 'a', h, cfg.criteria.winsMin);
    await w.svc.retire('a', h);
    await w.svc.tx('a', null, (s) => { s.horses.find((x) => x.id === h)!.name = 'ミドリノカゼ'; });
    expect((await w.svc.hallMine('a', null, null)).entries[0]!.horseName).toBe('ミドリノカゼ');
    await w.svc.tx('a', null, (s) => { s.horses = s.horses.filter((x) => x.id !== h); });
    const e = (await w.svc.hallMine('a', null, null)).entries[0]!;
    expect(e.horseId).toBe(h);
  });

  it('paginates newest first with a stable keyset cursor', async () => {
    const w = world();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const h = await horse(w, 'a', { tpl: i % 3 });
      await w.svc.tournamentClose('a', `cup${i}`, 1, null, '杯', h);
      w.clock.now += 1000;
      await w.svc.retire('a', h);
      ids.push(h);
    }
    const p1 = await w.svc.hallMine('a', null, 2);
    expect(p1.entries.map((e) => e.horseId)).toEqual([ids[4], ids[3]]);
    expect(p1.total).toBe(5);
    // a new induction between pages does not shift the next page
    const h6 = await horse(w, 'a');
    await w.svc.tournamentClose('a', 'cup6', 1, null, '杯', h6);
    w.clock.now += 1000;
    await w.svc.retire('a', h6);
    const p2 = await w.svc.hallMine('a', p1.nextCursor, 2);
    expect(p2.entries.map((e) => e.horseId)).toEqual([ids[2], ids[1]]);
    const p3 = await w.svc.hallMine('a', p2.nextCursor, 2);
    expect(p3.entries.map((e) => e.horseId)).toEqual([ids[0]]);
    expect(p3.nextCursor).toBeNull();
    expect(await code(w.svc.hallMine('a', 'garbage', 2))).toBe('BAD_REQUEST');
    expect((await w.svc.hallMine('a', null, 999)).entries.length).toBe(6); // capped at pageSizeMax
  });
});

async function inducted(w: World, id: string, opts: Parameters<typeof horse>[2] = {}) {
  const h = await horse(w, id, opts);
  await w.svc.tournamentClose(id, `cup-${id}-${h}`, 1, null, '秋の陣', h);
  await w.svc.retire(id, h);
  return h;
}

describe('殿堂: visiting (REQ-HOF-011/012/013/016)', () => {
  it('friends and branch members can look; strangers, blocks and private settings get NOT_FOUND', async () => {
    const w = world();
    await inducted(w, 'a', { friends: ['f'], team: 't1' });
    await horse(w, 'f', { friends: ['a'] });
    await horse(w, 'm', { team: 't1' });
    await horse(w, 'x', { team: 't2' });
    const fv = await w.hall.visit('f', 'a', null, null);
    expect(fv).toMatchObject({ relation: 'friend', total: 1, owner: { playerId: 'a' } });
    expect(JSON.stringify(fv)).not.toMatch(/teamId|blocked|visibility/);
    expect((await w.hall.visit('m', 'a', null, null)).relation).toBe('team');
    expect(await code(w.hall.visit('x', 'a', null, null))).toBe('NOT_FOUND');
    expect(await code(w.hall.visit('f', 'nobody', null, null))).toBe('NOT_FOUND');
    expect(w.kpi.filter((k) => k.r.name === 'hof_view').map((k) => [k.id, k.r.s1])).toEqual([['f', 'friend'], ['m', 'team']]);
    // friends-only: the branch member loses access, the friend keeps it
    await w.svc.hallSettings('a', 'friends');
    expect(await code(w.hall.visit('m', 'a', null, null))).toBe('NOT_FOUND');
    expect((await w.hall.visit('f', 'a', null, null)).relation).toBe('friend');
    // private: the copy is removed
    await w.svc.hallSettings('a', 'private');
    expect(w.dir.rows.has('a')).toBe(false);
    expect(await code(w.hall.visit('f', 'a', null, null))).toBe('NOT_FOUND');
    expect((await w.hall.visit('a', 'a', null, null)).relation).toBe('self');
    await w.svc.hallSettings('a', 'friends_team');
    // the owner blocks the branch member (team-feed mute = the block list) / the viewer blocks the owner
    await w.svc.tx('a', null, (s) => { (s as PlayerState & { teamFeed?: unknown }).teamFeed = { muted: ['m'], postedIn: [] }; });
    expect(await code(w.hall.visit('m', 'a', null, null))).toBe('NOT_FOUND');
    await w.svc.tx('f', null, (s) => { (s as PlayerState & { teamFeed?: unknown }).teamFeed = { muted: ['a'], postedIn: [] }; });
    expect(await code(w.hall.visit('f', 'a', null, null))).toBe('NOT_FOUND');
    expect(await code(w.svc.hallSettings('a', 'everyone'))).toBe('BAD_REQUEST');
  });

  it('banned or deleting owners have no copy; deleted accounts disappear', async () => {
    const w = world();
    await inducted(w, 'a', { friends: ['f'] });
    await horse(w, 'f', { friends: ['a'] });
    expect(w.dir.rows.has('a')).toBe(true);
    await w.svc.tx('a', null, (s, now) => { s.moderation = { status: 'banned', until: null, reason: 'x', at: now }; });
    expect(w.dir.rows.has('a')).toBe(false);
    await w.svc.tx('a', null, (s) => { delete s.moderation; });
    expect(w.dir.rows.has('a')).toBe(true);
    await w.svc.tx('a', null, (s) => { s.deletion = { status: 'deleting', steps: [], attempts: 0 } as unknown as NonNullable<PlayerState['deletion']>; });
    expect(w.dir.rows.has('a')).toBe(false);
    expect(await code(w.hall.visit('f', 'a', null, null))).toBe('NOT_FOUND');
    await w.hall.removeHall('a');
    expect(w.dir.rows.has('a')).toBe(false);
  });

  it('the public copy follows the owner name and an empty hall publishes nothing', async () => {
    const w = world();
    await horse(w, 'e');
    expect(hallSnapshot(m, await st(w, 'e'), NOW)).toBeNull();
    await inducted(w, 'a', { friends: ['f'] });
    await w.svc.setDisplayName('a', 'ほしぞら');
    expect(w.dir.rows.get('a')!.displayName).toBe('ほしぞら');
  });

  it('a disabled hall answers NOT_FOUND and records nothing', async () => {
    const off = { ...m, progression: { ...m.progression, hall: { ...cfg, enabled: false } } } as Master;
    const w = world(off);
    const h = await horse(w, 'a');
    await wins(w, 'a', h, 3);
    expect((await st(w, 'a')).hall).toBeUndefined();
    expect((await w.svc.retire('a', h)).ceremony).toBeNull();
    expect(await code(w.svc.hallMine('a', null, null))).toBe('NOT_FOUND');
    expect(await code(w.hall.visit('b', 'a', null, null))).toBe('NOT_FOUND');
  });
});

// ------------------------------------------------------------------------------------------- HTTP

function ctx(w: World): AppContext {
  return {
    master: m,
    authenticate: async (req: Request) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
    player: () => w.invoker,
    hall: w.hall,
    clock: () => w.clock.now,
  } as unknown as AppContext;
}
async function call(c: AppContext, method: string, path: string, o: { user?: string; body?: unknown; lang?: string } = {}) {
  const res = await handle(new Request(`https://x${path}`, {
    method, headers: { 'content-type': 'application/json', ...(o.user ? { 'x-test-user': o.user } : {}), ...(o.lang ? { 'accept-language': o.lang } : {}) },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  }), {}, c);
  return { status: res.status, body: (await res.json()) as any };
}

describe('HTTP API: /v1/hall (REQ-HOF-009/010/012)', () => {
  it('retire → ceremony → ack, my hall, horse career, visit, settings; English keeps names', async () => {
    const w = world();
    const h = await horse(w, 'a', { friends: ['b'] });
    await horse(w, 'b', { friends: ['a'] });
    await w.svc.tx('a', null, (s) => { s.horses.find((x) => x.id === h)!.name = '決勝'; });
    await wins(w, 'a', h, cfg.criteria.winsMin);
    const c = ctx(w);
    expect((await call(c, 'GET', '/v1/hall')).status).toBe(401);
    const car = await call(c, 'GET', `/v1/horses/${h}/career`, { user: 'a' });
    expect(car.body).toMatchObject({ horseId: h, status: 'active', qualifies: true, progress: { wins: { have: cfg.criteria.winsMin, need: cfg.criteria.winsMin } } });
    expect(car.body.preview.length).toBeGreaterThan(0);
    expect((await call(c, 'GET', '/v1/horses/h_nope/career', { user: 'a' })).status).toBe(404);
    const ret = await call(c, 'POST', `/v1/horses/${h}/retire`, { user: 'a', lang: 'en' });
    expect(ret.body.ceremony).toMatchObject({ inducted: true, horseName: '決勝' });
    expect(ret.body.ceremony.highlights[0].text).toBe(`${cfg.criteria.winsMin} races, ${cfg.criteria.winsMin} wins`);
    const mine = await call(c, 'GET', '/v1/hall?limit=1', { user: 'a', lang: 'en' });
    expect(mine.body).toMatchObject({ total: 1, relation: 'self', visibility: 'friends_team', frame: { itemId: FRAME, owned: true } });
    expect(mine.body.entries[0].horseName).toBe('決勝');
    expect(mine.body.notice).not.toMatch(/[ぁ-んァ-ン]/);
    expect((await call(c, 'GET', '/v1/hall?limit=0', { user: 'a' })).status).toBe(400);
    expect((await call(c, 'POST', `/v1/hall/ceremonies/${h}/ack`, { user: 'a' })).body.already).toBe(false);
    expect((await call(c, 'POST', `/v1/hall/ceremonies/${h}/ack`, { user: 'a' })).body.already).toBe(true);
    expect((await call(c, 'GET', '/v1/hall/a', { user: 'b' })).body).toMatchObject({ relation: 'friend', total: 1 });
    expect((await call(c, 'PUT', '/v1/hall/settings', { user: 'a', body: { visibility: 'nobody' } })).status).toBe(400);
    expect((await call(c, 'PUT', '/v1/hall/settings', { user: 'a', body: { visibility: 'private' } })).body).toEqual({ visibility: 'private' });
    expect((await call(c, 'GET', '/v1/hall/a', { user: 'b' })).status).toBe(404);
    expect((await call({ ...c, hall: undefined } as AppContext, 'GET', '/v1/hall', { user: 'a' })).status).toBe(404);
  });
});
