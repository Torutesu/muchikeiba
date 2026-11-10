// 練習レース (REQ-PRAC-001..018, contracts/protocol.md §50): the catalog the device builds its races from, the master check,
// the optional KPI path — and, explicitly, that practice grants nothing and has no server path for a result.
import { describe, expect, it } from 'vitest';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { DEFAULT_RULESET } from '../src/domain/ruleset.js';
import { createHorseFromTemplate } from '../src/domain/horses.js';
import { clientBatchSchema, clientToKpi, type KpiRecord } from '../src/domain/kpi.js';
import { goingsFor, raceStartConfigSchema } from '../src/domain/schemas.js';
import { practiceCatalog, practiceOf, practiceProblems, PRACTICE_MAX_HORSES } from '../src/domain/practice.js';
import { cpuLevelFor } from '../src/domain/matchmaker.js';
import { catalogFor, translateText } from '../src/i18n/catalog.js';
import { hasJapanese } from '../src/i18n/locale.js';
import type { Master } from '../src/domain/master.js';
import { m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 10, 3); // Tue 12:00 JST

function setup() {
  let now = NOW;
  const recs: KpiRecord[] = [];
  const repo = new MemoryPlayerRepo();
  const svc = new PlayerService(repo, { master: m, rng: seededRng(7), clock: () => now, verifiers: { fake: new FakeStoreVerifier() }, onKpi: (_id, rs) => { recs.push(...rs); } });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const c: AppContext = {
    master: m,
    authenticate: async (req) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
    player: () => invoker,
    match: {} as AppContext['match'],
    friends: makeFriendsService(() => invoker, new MemoryDirectory()),
    leaderboard: { board: async () => ({ entries: [], total: 0 }), myRank: async () => ({}) },
    timeAttack: {} as AppContext['timeAttack'],
    clock: () => now,
    race: { websocket: async () => new Response(null), report: async () => ({}), replay: async (id) => ({ raceId: id }) },
    paidBalance: async () => ({}),
    adminToken: undefined,
    parseStoreNotification: async () => null,
    activeRuleset: async () => DEFAULT_RULESET,
  };
  const req = async (user: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await handle(new Request(`https://x${path}`, { method, headers: { 'x-test-user': user, 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), {}, c);
    return { status: res.status, body: (await res.json()) as any };
  };
  const give = async (uid: string, templateId: string) => {
    await svc.bootstrap(uid);
    const s = repo.get(uid)!;
    const h = createHorseFromTemplate(s, m.templateById.get(templateId)!, now);
    repo.put(s);
    return h.id;
  };
  return { svc, repo, req, give, recs, at: (t: number) => { now = t; } };
}

describe('REQ-PRAC-002 GET /v1/practice/catalog', () => {
  it('returns every course with its goings, lights and today\'s ground, the field size and the strengths', async () => {
    const w = setup();
    await w.svc.bootstrap('p');
    const r = await w.req('p', 'GET', '/v1/practice/catalog');
    expect(r.status).toBe(200);
    const cat = r.body;
    expect(cat.v).toBe(1);
    expect(cat.enabled).toBe(true);
    expect(cat.fieldSize).toEqual({ min: 2, max: 12, default: 8 });
    // REQ-PRAC-004: every course of the game (there are no per-player course locks)
    expect(cat.courses.map((x: { trackId: string }) => x.trackId)).toEqual(m.tracks.map((t) => t.id));
    for (const c of cat.courses) {
      const t = m.tracks.find((x) => x.id === c.trackId)!;
      expect(c.goings).toEqual([...goingsFor(t.surface)]);
      expect(c.lights).toBe(m.litTracks.has(t.id));
      expect(c.goings).toContain(c.today.going);
      if (!c.lights) expect(c.today.night).toBe(false);
      expect(c.segments.reduce((a: number, s: { lengthM: number }) => a + s.lengthM, 0)).toBe(c.distanceM);
      expect(c.name.length).toBeGreaterThan(0);
    }
    expect(cat.ruleset).toEqual(DEFAULT_RULESET);
    expect(cat.net.tickHz).toBe(20);
  });

  it('REQ-PRAC-003: the strengths come from the existing CPU definitions (beginner match, the rating bands)', async () => {
    const w = setup();
    await w.svc.bootstrap('p');
    const cat = (await w.req('p', 'GET', '/v1/practice/catalog')).body;
    const bm = m.progression.beginnerMatch!;
    expect(cat.strengths.map((s: { id: string; cpuLevel: number; cpuStatPermille: number }) => [s.id, s.cpuLevel, s.cpuStatPermille])).toEqual([
      ['easy', bm.cpuLevel, bm.cpuStatPermille],
      ['normal', cpuLevelFor(1500, false), 1000],
      ['strong', cpuLevelFor(1700, false), 1000],
      ['top', cpuLevelFor(1900, false), 1000],
    ]);
    // the numbers the C# offline fallback (PracticeCatalog.Fallback) pins — keep both in step
    expect(cat.strengths.map((s: { cpuLevel: number; cpuStatPermille: number }) => `${s.cpuLevel}/${s.cpuStatPermille}`)).toEqual(['1/780', '3/1000', '4/1000', '5/1000']);
    expect(cat.defaultStrength).toBe('normal');
  });

  it('CPU pool = the buildRaceConfig pool (no limited or gift-only horses); own active horses with the partner flag, race stats, capped skills', async () => {
    const w = setup();
    const partnerId = await w.give('p', 't_kohaku');
    const s = w.repo.get('p')!;
    s.flags.partnerHorseId = partnerId;
    const retired = createHorseFromTemplate(s, m.templateById.get('t_ginga')!, NOW);
    retired.status = 'retired';
    w.repo.put(s);
    const cat = (await w.req('p', 'GET', '/v1/practice/catalog')).body;
    const pool = m.templates.filter((t) => !t.seasonal && !t.giftOnly);
    expect(cat.cpuHorses.map((h: { id: string }) => h.id)).toEqual(pool.map((t) => `cpu_${t.id}`));
    const active = w.repo.get('p')!.horses.filter((h) => h.status === 'active');
    expect(cat.horses.map((h: { id: string }) => h.id)).toEqual(active.slice(0, PRACTICE_MAX_HORSES).map((h) => h.id));
    expect(cat.horses.some((h: { id: string }) => h.id === retired.id)).toBe(false);
    expect(cat.horses.filter((h: { partner: boolean }) => h.partner).map((h: { id: string }) => h.id)).toEqual([partnerId]);
    const caps = { speed: DEFAULT_RULESET.skillMaxSpeedPermille as number | undefined };
    for (const h of [...cat.horses, ...cat.cpuHorses]) {
      for (const k of ['speed', 'stamina', 'burst', 'guts', 'temper']) expect(h[k]).toBeGreaterThanOrEqual(0), expect(h[k]).toBeLessThanOrEqual(1000);
      if (h.skill && caps.speed !== undefined) expect(h.skill.speedPermille).toBeLessThanOrEqual(caps.speed);
    }
    // every entry is a valid engine horse (it goes straight into a RaceStartConfig on the device)
    const cfg = { v: 1, raceId: 'practice_1', mode: 'friend', seed: '1', track: { id: 'x', surface: 'turf', distanceM: 1000, segments: [{ kind: 'straight', lengthM: 1000 }] }, net: cat.net, ruleset: cat.ruleset,
      entrants: [cat.horses[0], ...cat.cpuHorses.slice(0, 11)].map((h: Record<string, unknown>, slot: number) => { const { partner: _p, ...horse } = h; return { slot, kind: slot === 0 ? 'human' : 'cpu', playerId: slot === 0 ? 'local' : null, cpuLevel: 3, horse }; }) };
    expect(raceStartConfigSchema.safeParse(cfg).success).toBe(true);
  });

  it('is read-only: nothing is saved (a new player is not even created), and a deleting account can read it', async () => {
    const w = setup();
    const r = await w.req('ghost', 'GET', '/v1/practice/catalog');
    expect(r.status).toBe(200);
    expect(r.body.horses).toEqual([]);
    expect(w.repo.get('ghost') ?? null).toBeNull();
    await w.svc.bootstrap('p');
    const before = JSON.stringify(w.repo.get('p'));
    await w.req('p', 'GET', '/v1/practice/catalog');
    expect(JSON.stringify(w.repo.get('p'))).toBe(before);
  });

  it('English: strength names and notes, and course names, are translated at the boundary (player horse names are not)', async () => {
    const w = setup();
    await w.svc.bootstrap('p');
    const r = await w.req('p', 'GET', '/v1/practice/catalog?lang=en');
    expect(r.body.strengths.map((s: { name: string }) => s.name)).toEqual(['Easy', 'Normal', 'Strong', 'Strongest']);
    for (const s of r.body.strengths) expect(hasJapanese(s.note)).toBe(false);
    for (const c of r.body.courses) expect(hasJapanese(c.name)).toBe(false);
    const cat = catalogFor(m);
    for (const d of practiceOf(m).strengths) { expect(translateText(d.name, cat)).not.toBeNull(); expect(translateText(d.note, cat)).not.toBeNull(); }
  });
});

describe('REQ-PRAC-003 master/practice.json check', () => {
  const broken = (patch: (p: ReturnType<typeof practiceOf>) => void): Master => {
    const p = structuredClone(practiceOf(m));
    patch(p);
    return { ...m, practice: p };
  };
  it('the shipped file passes', () => { expect(practiceProblems(m)).toEqual([]); });
  it('catches field sizes, duplicate ids, a missing default, out-of-range CPU levels and shop words', () => {
    expect(practiceProblems(broken((p) => { p.fieldSize = { min: 1, max: 12, default: 8 }; })).join()).toMatch(/fieldSize/);
    expect(practiceProblems(broken((p) => { p.fieldSize = { min: 2, max: 13, default: 8 }; })).join()).toMatch(/fieldSize/);
    expect(practiceProblems(broken((p) => { p.fieldSize = { min: 4, max: 12, default: 3 }; })).join()).toMatch(/fieldSize/);
    expect(practiceProblems(broken((p) => { p.strengths.push({ ...p.strengths[0]! }); })).join()).toMatch(/duplicate/);
    expect(practiceProblems(broken((p) => { p.defaultStrength = 'nope'; })).join()).toMatch(/defaultStrength/);
    expect(practiceProblems(broken((p) => { p.strengths[1] = { id: 'x', name: 'x', note: 'x', from: 'rating', rating: 99999 }; })).join()).toMatch(/rating/);
    expect(practiceProblems(broken((p) => { p.strengths[0]!.name = '今だけ最強'; })).join()).toMatch(/今だけ/);
    expect(practiceProblems(broken((p) => { p.strengths[0]!.note = '報酬が2倍'; })).join()).toMatch(/報酬|倍/);
    const lowBm: Master = { ...m, progression: { ...m.progression, beginnerMatch: { ...m.progression.beginnerMatch!, cpuStatPermille: 400 } } };
    expect(practiceProblems(lowBm).join()).toMatch(/cpuStatPermille/);
  });
});

describe('REQ-PRAC-015 KPI practice_start / practice_finish', () => {
  const batch = (events: unknown[]) => clientBatchSchema.safeParse({ platform: 'android', appVersion: '1.0.0', events });
  it('accepts course, field size, strength, restart and place, mapped to fixed columns', () => {
    const r = batch([
      { name: 'practice_start', at: NOW, props: { trackId: 'minato_turf_2400', fieldSize: 8, strength: 'strong', restart: 'same_seed' } },
      { name: 'practice_finish', at: NOW, props: { trackId: 'minato_turf_2400', fieldSize: 8, strength: 'strong', place: 3 } },
    ]);
    expect(r.success).toBe(true);
    expect(clientToKpi(r.data!.events[0]!)).toEqual({ name: 'practice_start', s1: 'minato_turf_2400', s2: 'strong', s3: 'same_seed', count: 8 });
    expect(clientToKpi(r.data!.events[1]!)).toEqual({ name: 'practice_finish', s1: 'minato_turf_2400', s2: 'strong', count: 8, place: 3 });
  });
  it('refuses per-input data, the seed, times, and out-of-range values (strict props)', () => {
    const base = { trackId: 'aoba_turf_1600', fieldSize: 8, strength: 'easy', place: 1 };
    expect(batch([{ name: 'practice_finish', at: NOW, props: { ...base, inputs: [[100, 0, 4]] } }]).success).toBe(false);
    expect(batch([{ name: 'practice_finish', at: NOW, props: { ...base, seed: '123' } }]).success).toBe(false);
    expect(batch([{ name: 'practice_finish', at: NOW, props: { ...base, timeMs: 95_000 } }]).success).toBe(false);
    expect(batch([{ name: 'practice_finish', at: NOW, props: { ...base, place: 13 } }]).success).toBe(false);
    expect(batch([{ name: 'practice_start', at: NOW, props: { trackId: 'aoba_turf_1600', fieldSize: 1, strength: 'easy', restart: 'none' } }]).success).toBe(false);
    expect(batch([{ name: 'practice_start', at: NOW, props: { trackId: 'aoba_turf_1600', fieldSize: 13, strength: 'easy', restart: 'none' } }]).success).toBe(false);
    expect(batch([{ name: 'practice_start', at: NOW, props: { trackId: 'aoba_turf_1600', fieldSize: 8, strength: 'easy', restart: 'again' } }]).success).toBe(false);
  });
});

describe('REQ-PRAC-011 practice grants nothing and has no server path for a result', () => {
  /** Everything a race could move: wallet, items, missions, pass, season / rating, stats, hall, recap, rival, team goal, exchange, collection, bond, replays. */
  const rewardView = (s: Record<string, unknown>) => {
    const { kpi: _kpi, updatedAt: _u, rev: _r, ...rest } = s as Record<string, unknown> & { kpi?: unknown; updatedAt?: unknown; rev?: unknown };
    return JSON.stringify(rest);
  };
  it('a practice session (catalog + both KPI events, many times) leaves every reward and record unchanged', async () => {
    const w = setup();
    await w.give('p', 't_kohaku');
    // one ordinary transaction first, so the state is settled the way every tx leaves it (the test put the horse in directly)
    await w.req('p', 'POST', '/v1/analytics/events', { platform: 'android', appVersion: '1.0.0', events: [{ name: 'session_start', at: NOW, props: {} }] });
    const before = rewardView(w.repo.get('p') as never);
    const s0 = w.repo.get('p')!;
    const wallet0 = structuredClone(s0.wallet);
    w.recs.length = 0; // the bootstrap's own server events (first_open…)
    for (let i = 0; i < 3; i++) {
      expect((await w.req('p', 'GET', '/v1/practice/catalog')).status).toBe(200);
      const ev = (place: number) => ({ platform: 'android', appVersion: '1.0.0', events: [
        { name: 'practice_start', at: NOW, props: { trackId: 'kirameki_turf_2000', fieldSize: 12, strength: 'top', restart: i === 0 ? 'none' : 'new_seed' } },
        { name: 'practice_finish', at: NOW, props: { trackId: 'kirameki_turf_2000', fieldSize: 12, strength: 'top', place } },
      ] });
      const r = await w.req('p', 'POST', '/v1/analytics/events', ev(1));
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ accepted: 2, dropped: 0 });
    }
    const after = w.repo.get('p')!;
    expect(after.wallet).toEqual(wallet0);
    const diff = Object.keys(after).filter((k) => k !== 'kpi' && JSON.stringify((after as never)[k]) !== JSON.stringify((JSON.parse(before) as never)[k]));
    expect(diff).toEqual([]);
    expect(rewardView(after as never)).toBe(before);
    expect(w.recs.filter((x) => x.name.startsWith('practice_')).length).toBe(6);
    // no server event of a race (race_finish / rewards) came out of it
    expect(w.recs.every((x) => x.source === 'client')).toBe(true);
  });

  it('there is no route that takes a practice result', async () => {
    const w = setup();
    await w.svc.bootstrap('p');
    for (const path of ['/v1/practice/result', '/v1/practice/finish', '/v1/practice/submit', '/v1/practice']) {
      const r = await w.req('p', 'POST', path, { place: 1, inputs: [] });
      expect(r.status, path).toBe(404);
    }
    // a practice config is not a race the server can settle: the race config schema has no practice mode
    expect(raceStartConfigSchema.shape.mode.safeParse('practice').success).toBe(false);
  });

  it('REQ-PRAC-012: a practice race is not a race the player can save to My Replays (the server never had it)', async () => {
    const w = setup();
    await w.svc.bootstrap('p');
    await expect(w.svc.replayPrepareSave('p', 'practice_00000000000000ff', null)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('the catalog builder itself is pure over the state (no hidden writes)', () => {
    const st = { horses: [], flags: { tutorialGachaUsed: false } } as unknown as Parameters<typeof practiceCatalog>[1];
    const frozen = Object.freeze(st);
    expect(() => practiceCatalog(m, frozen, NOW)).not.toThrow();
  });
});
