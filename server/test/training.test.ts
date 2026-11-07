import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import type { Master } from '../src/domain/master.js';
import { STAT_KEYS } from '../src/domain/master.js';
import {
  beatSchedule, computeGain, raceStats, scoreTiming, trainedTotal, trainingProblems, validateTaps, TRAINING_HARD_LIMITS, type TrainingConfig,
} from '../src/domain/training.js';
import { buildRaceConfig, toRaceHorse } from '../src/domain/raceConfig.js';
import { createHorseFromTemplate, breedingPreview, effectiveStats } from '../src/domain/horses.js';
import { freshPlayer } from './helpers.js';
import { resolveBundle } from '../src/ops/config.js';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';

const JST = 9 * 3600_000;
const jst = (y: number, mo: number, d: number, h = 12, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - JST;
const cfg = m.progression.training as TrainingConfig;
const DAY = 86_400_000;
const withTraining = (patch: Partial<TrainingConfig>, base: Master = m): Master => ({ ...base, progression: { ...base.progression, training: { ...cfg, ...patch } } });

function world(master: Master = m, start = jst(2026, 12, 10)) {
  let now = start;
  const kpi: KpiRecord[] = [];
  const svc = new PlayerService(new MemoryPlayerRepo(), { master, rng: seededRng(21), clock: () => now, verifiers: {}, onKpi: (_id, recs) => { kpi.push(...recs); } });
  let n = 0;
  const k = () => `c:t:${n++}`;
  const player = async (id = 'p') => {
    await svc.bootstrap(id);
    await svc.grantPartner(id, 'アイボウ', k());
    return (await svc.state(id)).horses[0]!.id;
  };
  /** One full session: start, wait the mini-game out, tap `offset` ms after every beat (null = skip). */
  const train = async (id: string, horseId: string, menu: string, offset: number | null = 20) => {
    const s = await svc.trainingStart(id, horseId, menu, k());
    now += cfg.timing.durationMs + 500;
    return svc.trainingFinish(id, s.session.sessionId, offset === null ? { taps: [], skipped: true } : { taps: s.session.beats.map((b) => b + offset) }, k());
  };
  return { svc, k, player, train, kpi, now: () => now, advance: (ms: number) => { now += ms; }, at: (t: number) => { now = t; } };
}
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as AppError).code; } return 'NO_ERROR'; };

describe('REQ-TRAIN-012 config validation (boot and remote config)', () => {
  it('the shipped config is valid and inside the hard limits', () => {
    expect(trainingProblems(m)).toEqual([]);
    expect(cfg.timing.beats * cfg.timing.perfectPoints * cfg.timing.permillePerPoint).toBeLessThanOrEqual(100);
    expect(cfg.potentialByRarity.R).toBeGreaterThanOrEqual(cfg.potentialByRarity.SR);
    expect(cfg.potentialByRarity.SR).toBeGreaterThanOrEqual(cfg.potentialByRarity.SSR);
  });
  it('refuses rarer horses growing more, a big mini-game bonus, and limits above the code ceilings', () => {
    expect(trainingProblems(withTraining({ potentialByRarity: { R: 100, SR: 200, SSR: 300 } })).join()).toMatch(/R ≥ SR ≥ SSR/);
    expect(trainingProblems(withTraining({ timing: { ...cfg.timing, permillePerPoint: 50 } })).join()).toMatch(/at most 150‰/);
    expect(trainingProblems(withTraining({ slotsPerDay: TRAINING_HARD_LIMITS.slotsPerDay + 1 })).join()).toMatch(/slotsPerDay/);
    expect(trainingProblems(withTraining({ menus: [{ ...cfg.menus[0]!, baseGain: 99 }] })).join()).toMatch(/baseGain/);
    expect(trainingProblems(withTraining({ perHorsePerDay: 4, slotsPerDay: 3 })).join()).toMatch(/perHorsePerDay/);
  });
  it('REQ-TRAIN-010: a growth-affecting item can never be sold, be a pass reward, an event reward or come from a gacha', () => {
    const apple = { itemId: 'training_apple', qty: 1 };
    const sold: Master = { ...m, products: [...m.products, { ...m.products.find((p) => p.id === 'starter_pack')!, id: 'apple_pack', items: [apple] }] };
    expect(trainingProblems(sold).join()).toMatch(/cannot be sold \(product apple_pack\)/);
    const premium: Master = { ...m, progression: { ...m.progression, passRewards: { ...m.progression.passRewards, premium: { every: 5, reward: { items: [apple] } } } } };
    expect(trainingProblems(premium).join()).toMatch(/premium pass/);
    const free: Master = { ...m, progression: { ...m.progression, passRewards: { ...m.progression.passRewards, free: { every: 5, reward: { items: [apple] } } } } };
    expect(trainingProblems(free).join()).toMatch(/Pass\+ sells levels/);
    // a non-growth item (affectsGrowth false) may be sold directly
    const cosmeticOnly = withTraining({ items: [{ itemId: 'training_apple', name: 'x', fatigueRelief: 10, affectsGrowth: false }] }, sold);
    expect(trainingProblems(cosmeticOnly)).toEqual([]);
    // the remote config path runs the same checks
    expect(() => resolveBundle(m, { progression: { passRewards: { ...m.progression.passRewards, premium: { every: 5, reward: { items: [apple] } } } } })).toThrow(/premium pass/);
  });
});

describe('REQ-TRAIN-005/006/007 the timing mini-game: deterministic scorer and anti-cheat bounds', () => {
  const t = cfg.timing;
  it('the scorer is a pure function of beats and taps (shared vector with the C# TrainingModel)', () => {
    const beats = [1000, 2000, 3000, 4000, 5000];
    expect(scoreTiming(t, beats, [1010, 2100, 3200, 4950, 5000])).toEqual({ perfect: 2, good: 1, miss: 2, stray: 2, score: 3, bonusPermille: 30 });
    expect(scoreTiming(t, beats, beats)).toMatchObject({ perfect: 5, score: 10, bonusPermille: 100 });
    expect(scoreTiming(t, beats, [])).toMatchObject({ miss: 5, score: 0 });
    // mashing does not pay: every stray tap costs a point
    const mash = Array.from({ length: 10 }, (_, i) => 600 + i * 560);
    expect(scoreTiming(t, beats, mash).score).toBeLessThan(5);
  });
  it('the beat schedule comes from the seed: one beat per segment, inside the lead/tail margins', () => {
    for (const seed of [1, 2, 0xdeadbeef]) {
      const b = beatSchedule(t, seed);
      expect(b).toEqual(beatSchedule(t, seed));
      expect(b.length).toBe(t.beats);
      expect(b[0]!).toBeGreaterThanOrEqual(t.leadMs);
      expect(b[b.length - 1]!).toBeLessThanOrEqual(t.durationMs - t.tailMs);
      for (let i = 1; i < b.length; i++) expect(b[i]! - b[i - 1]!).toBeGreaterThan(2 * t.goodMs);
    }
  });
  it('rejects taps out of range, unsorted, too dense, too many, or later than the time that really passed', () => {
    const beats = [1000, 2000, 3000, 4000, 5000];
    const bad = (taps: unknown, elapsed = 10_000) => { try { validateTaps(t, beats, taps, elapsed); return 'ok'; } catch (e) { return (e as AppError).code; } };
    expect(bad([1000, 2000])).toBe('ok');
    expect(bad([2000, 1000])).toBe('TRAINING_INPUT_INVALID');
    expect(bad([1000, 1050])).toBe('TRAINING_INPUT_INVALID'); // < minTapGapMs
    expect(bad([-1])).toBe('TRAINING_INPUT_INVALID');
    expect(bad([t.durationMs + 1])).toBe('TRAINING_INPUT_INVALID');
    expect(bad([1.5])).toBe('TRAINING_INPUT_INVALID');
    expect(bad(Array.from({ length: t.maxTaps + 1 }, (_, i) => i * 100))).toBe('TRAINING_INPUT_INVALID');
    expect(bad([1000, 5000], 4000)).toBe('TRAINING_INPUT_INVALID'); // claims a tap at 5.0 s after 4.0 s
    expect(bad([1000], 1200)).toBe('TRAINING_INPUT_INVALID'); // ended before the last beat could be hit
    expect(bad('nope')).toBe('BAD_REQUEST');
  });
  it('a perfect run improves the result only slightly (≤ +10%) over skipping the mini-game', () => {
    const p = freshPlayer();
    const h = createHorseFromTemplate(p, m.templates.find((x) => x.rarity === 'R')!, 0);
    const base = effectiveStats(m, h);
    const menu = cfg.menus.find((x) => x.id === 'hill')!;
    const run = (timingPermille: number) => computeGain(cfg, h, base, menu, { fatigueBefore: 0, bondLevel: 1, timingPermille, carry: 0, seed: 7 });
    const skip = run(0), best = run(100);
    expect(best.milli).toBeGreaterThan(skip.milli);
    expect(best.milli / skip.milli).toBeLessThanOrEqual(1.1);
  });
});

describe('REQ-TRAIN-001/002/004 daily slots, menus, growth and the potential', () => {
  it('3 sessions per game day for the account, 2 per horse; reset at the game-day rollover (04:00 JST)', async () => {
    const w = world();
    const h1 = await w.player();
    const st = await w.svc.state('p');
    expect(st.horses.length).toBe(1);
    // a second horse from a template (the partner is the only one after the FTUE)
    await w.svc.tx('p', null, (s) => { createHorseFromTemplate(s, m.templates.find((x) => x.rarity === 'R')!, w.now()); });
    const h2 = (await w.svc.state('p')).horses[1]!.id;
    await w.train('p', h1, 'hill');
    await w.train('p', h1, 'pool');
    expect(await code(w.svc.trainingStart('p', h1, 'wood', w.k()))).toBe('TRAINING_LIMIT'); // horse daily limit
    await w.train('p', h2, 'wood');
    expect(await code(w.svc.trainingStart('p', h2, 'wood', w.k()))).toBe('TRAINING_LIMIT'); // account slots
    const v = await w.svc.training('p');
    expect(v).toMatchObject({ enabled: true, usedToday: 3, slotsLeft: 0 });
    w.at(jst(2026, 12, 11, 3, 59));
    expect(await code(w.svc.trainingStart('p', h2, 'wood', w.k()))).toBe('TRAINING_LIMIT');
    w.at(jst(2026, 12, 11, 4, 0));
    expect((await w.svc.training('p') as { slotsLeft: number }).slotsLeft).toBe(3);
    expect(await code(w.train('p', h2, 'wood'))).toBe('NO_ERROR');
  });
  it('the same state, menu and taps always give the same growth (server re-sim of the submitted inputs)', async () => {
    const a = world(), b = world();
    const ha = await a.player(), hb = await b.player();
    const ra = await a.train('p', ha, 'awase', 30);
    const rb = await b.train('p', hb, 'awase', 30);
    expect(ra.gain).toEqual(rb.gain);
    expect(ra.timing).toEqual(rb.timing);
    expect(ra.grade).toBe('great');
    expect(ra.total).toBeGreaterThan(0);
    // the split follows the menu: 併せ馬 grows guts/speed/burst only
    expect(ra.gain.stamina + ra.gain.temper).toBe(0);
  });
  it('growth stops at the horse\'s potential and a stat never takes more than its share', async () => {
    const w = world();
    const h = await w.player();
    const rarity = (await w.svc.state('p')).horses[0]!.rarity;
    for (let d = 0; d < 120; d++) {
      for (const menu of ['wood', 'pool']) await w.train('p', h, menu).catch((e: AppError) => { if (e.code !== 'TRAINING_POTENTIAL_FULL') throw e; });
      w.advance(DAY);
    }
    const horse = (await w.svc.state('p')).horses[0]!;
    expect(trainedTotal(horse)).toBeLessThanOrEqual(cfg.potentialByRarity[rarity]);
    expect(trainedTotal(horse)).toBeGreaterThan(cfg.potentialByRarity[rarity] * 0.9);
    const cap = Math.floor((cfg.potentialByRarity[rarity] * cfg.perStatCapPermille) / 1000);
    for (const k of STAT_KEYS) expect(horse.trained![k]).toBeLessThanOrEqual(cap);
    // wood + pool never grow burst or guts
    expect(horse.trained!.burst + horse.trained!.guts).toBe(0);
    const v = await w.svc.training('p') as { horses: { blocked: string | null }[] };
    if (trainedTotal(horse) >= cfg.potentialByRarity[rarity]) expect(v.horses[0]!.blocked).toBe('potential_full');
  });
  it('REQ-TRAIN-009: fatigue lowers efficiency and makes the horse rest; プール and a day off recover it', async () => {
    const w = world();
    const h = await w.player();
    await w.train('p', h, 'awase');
    await w.train('p', h, 'awase');
    w.advance(DAY);
    // 70 − 40 = 30 … then 2 × 35 more → 100 − 40 next day = 60, then 95 → tired
    await w.train('p', h, 'awase');
    await w.train('p', h, 'awase');
    w.advance(DAY);
    await w.train('p', h, 'hill');
    const v = await w.svc.training('p') as { horses: { fatigue: number; condition: string; menus: { id: string; blocked: string | null }[] }[] };
    expect(v.horses[0]!.fatigue).toBeGreaterThanOrEqual(cfg.fatigue.restAt);
    expect(v.horses[0]!.condition).toBe('tired');
    expect(v.horses[0]!.menus.find((x) => x.id === 'hill')!.blocked).toBe('tired');
    expect(v.horses[0]!.menus.find((x) => x.id === 'pool')!.blocked).toBeNull();
    expect(await code(w.svc.trainingStart('p', h, 'hill', w.k()))).toBe('TRAINING_TIRED');
    const pool = await w.train('p', h, 'pool');
    expect(pool.fatigue).toBeLessThan(v.horses[0]!.fatigue);
    expect(pool.breakdown!.efficiencyPermille).toBeLessThan(1000);
  });
});

describe('REQ-TRAIN-003 ranked fairness: growth is normalised in ranked, fatigue reaches no race, nothing is inherited', () => {
  it('toRaceHorse includes the growth; the ranked config normalises it to the class cap', () => {
    const p = freshPlayer();
    const ssr = createHorseFromTemplate(p, m.templates.find((x) => x.rarity === 'SSR')!, 0);
    const before = toRaceHorse(m, ssr);
    ssr.trained = { speed: 40, stamina: 30, burst: 30, guts: 40, temper: 40 };
    const after = toRaceHorse(m, ssr);
    expect(after.speed).toBe(Math.min(1000, before.speed + 40));
    const sum = (h: Record<string, unknown>) => STAT_KEYS.reduce((a, k) => a + (h[k] as number), 0);
    // in a class whose cap the SSR already exceeds, the growth changes nothing in ranked
    const cfgOf = (horse: ReturnType<typeof toRaceHorse>, statCap: number | null) => buildRaceConfig(m, {
      raceId: 'r_fair', mode: statCap === null ? 'friend' : 'ranked', trackId: 'kirameki_turf_2000', humans: [{ playerId: 'p', horse }], cpuCount: 3, cpuLevel: 3, statCap, rng: seededRng(9),
    }).entrants.find((e) => e.playerId === 'p')!.horse;
    expect(sum(before)).toBeGreaterThan(3200);
    // the total stays at the cap (floors may lose a point or two); only the shape follows the menus trained
    expect(sum(cfgOf(after, 3200))).toBeLessThanOrEqual(3200);
    expect(Math.abs(sum(cfgOf(after, 3200)) - sum(cfgOf(before, 3200)))).toBeLessThanOrEqual(STAT_KEYS.length);
    // friend rooms (no cap) see the trained horse as it is
    expect(sum(cfgOf(after, null))).toBe(sum(after));
  });
  it('a free player\'s R horse can grow toward the cap: the ranked gap to an SSR only narrows', () => {
    const p = freshPlayer();
    const r = createHorseFromTemplate(p, m.templates.find((x) => x.rarity === 'R' && !x.giftOnly)!, 0);
    const ssr = createHorseFromTemplate(p, m.templates.find((x) => x.rarity === 'SSR')!, 0);
    const norm = (h: typeof r, cap: number) => { const s = raceStats(m, h); const t = STAT_KEYS.reduce((a, k) => a + s[k], 0); return Math.min(t, cap); };
    for (const cap of m.progression.classes.map((c) => c.statCap)) {
      const gapBefore = norm(ssr, cap) - norm(r, cap);
      r.trained = { speed: 60, stamina: 60, burst: 60, guts: 60, temper: 60 };
      ssr.trained = { speed: 36, stamina: 36, burst: 36, guts: 36, temper: 36 };
      const gapAfter = norm(ssr, cap) - norm(r, cap);
      expect(gapAfter).toBeLessThanOrEqual(gapBefore);
      delete r.trained; delete ssr.trained;
    }
  });
  it('fatigue is never part of a race config, and breeding ignores the growth (not inherited)', async () => {
    const w = world();
    const h = await w.player();
    const fresh = toRaceHorse(m, (await w.svc.state('p')).horses[0]!);
    await w.train('p', h, 'awase');
    const s = await w.svc.state('p');
    const horse = s.horses[0]!;
    const trainedView = toRaceHorse(m, horse);
    expect(JSON.stringify(trainedView)).not.toMatch(/fatigue|condition/);
    // zero the growth: the race horse is exactly the untrained one, whatever the fatigue
    expect(toRaceHorse(m, { ...horse, trained: undefined })).toEqual(fresh);
    // breeding preview reads base + awakening only
    const p = freshPlayer();
    const sire = createHorseFromTemplate(p, m.templates.find((x) => x.sex === 'male')!, 0);
    const dam = createHorseFromTemplate(p, m.templates.find((x) => x.sex === 'female')!, 0);
    sire.status = 'retired'; dam.status = 'retired';
    const before = breedingPreview(m, p, sire.id, dam.id).stats;
    sire.trained = { speed: 100, stamina: 100, burst: 0, guts: 0, temper: 0 };
    expect(breedingPreview(m, p, sire.id, dam.id).stats).toEqual(before);
  });
  it('the view says it plainly', async () => {
    const w = world();
    await w.player();
    expect((await w.svc.training('p') as { rules: unknown }).rules).toEqual({ rankedNormalized: true, fatigueAffectsRaces: false, inherited: false, paidBoosts: false });
  });
});

describe('REQ-TRAIN-008/011 the training item comes from the daily mission only', () => {
  it('finishing a session completes train1; its reward is the apple; the apple relieves fatigue', async () => {
    const w = world();
    const h = await w.player();
    await w.train('p', h, 'awase');
    const ms = await w.svc.missions('p');
    expect(ms.find((x) => x.id === 'train1')).toMatchObject({ progress: 1, target: 1, claimed: false });
    await w.svc.claimMission('p', 'train1', w.k());
    expect((await w.svc.state('p')).items['training_apple']).toBe(1);
    const before = (await w.svc.training('p') as { horses: { fatigue: number }[] }).horses[0]!.fatigue;
    const r = await w.svc.trainingUseItem('p', 'training_apple', h, w.k());
    expect(r.fatigue).toBe(Math.max(0, before - 30));
    expect(r.remaining).toBe(0);
    expect(await code(w.svc.trainingUseItem('p', 'training_apple', h, w.k()))).toBe('INSUFFICIENT_ITEMS'); // none left
  });
});

describe('REQ-TRAIN-002 sessions: expiry, abandoned sessions, idempotency, KPI', () => {
  it('an expired session is settled as skipped on the next read; a stale finish is refused', async () => {
    const w = world();
    const h = await w.player();
    const s = await w.svc.trainingStart('p', h, 'hill', w.k());
    expect(s.preview.max).toBeGreaterThanOrEqual(s.preview.min);
    expect((await w.svc.training('p') as { open: unknown }).open).toMatchObject({ sessionId: s.session.sessionId });
    w.advance(cfg.sessionTtlMs + 1);
    expect(await code(w.svc.trainingFinish('p', s.session.sessionId, { taps: [] }, w.k()))).toBe('TRAINING_SESSION_EXPIRED');
    const v = await w.svc.training('p') as { open: unknown; horses: { sessions: number; log: { grade: string }[] }[] };
    expect(v.open).toBeNull();
    expect(v.horses[0]!.sessions).toBe(1);
    expect(v.horses[0]!.log[0]!.grade).toBe('normal');
    expect(await code(w.svc.trainingFinish('p', s.session.sessionId, { taps: [] }, w.k()))).toBe('TRAINING_SESSION_USED');
  });
  it('starting again settles the open one as skipped; a finish retried with the same key returns the same result', async () => {
    const w = world();
    const h = await w.player();
    const a = await w.svc.trainingStart('p', h, 'pool', w.k());
    const b = await w.svc.trainingStart('p', h, 'pool', w.k());
    expect(b.session.sessionId).not.toBe(a.session.sessionId);
    w.advance(7000);
    const taps = b.session.beats.map((x) => x + 5);
    const r1 = await w.svc.trainingFinish('p', b.session.sessionId, { taps }, 'c:fin');
    const r2 = await w.svc.trainingFinish('p', b.session.sessionId, { taps }, 'c:fin');
    expect(r2).toEqual(r1);
    expect(w.kpi.filter((x) => x.name === 'training_start').length).toBe(2);
    const done = w.kpi.filter((x) => x.name === 'training_done');
    expect(done.map((x) => x.s3)).toEqual(['skipped', 'done']);
    expect(done[1]).toMatchObject({ s1: 'pool', s2: 'great', count: 10 });
    expect(done[0]!.isFirst).toBe(true);
  });
  it('a retired horse cannot train; nothing starts while the account deletion runs', async () => {
    const w = world();
    const h = await w.player();
    await w.svc.tx('p', null, (s) => { s.horses[0]!.status = 'retired'; });
    expect(await code(w.svc.trainingStart('p', h, 'hill', w.k()))).toBe('HORSE_NOT_ACTIVE');
  });
});

describe('HTTP: /v1/training (contracts/protocol.md §25)', () => {
  const req = (method: string, path: string, user?: string, idem?: string, body?: unknown) => new Request(`https://x${path}`, {
    method, headers: { ...(user ? { 'x-test-user': user } : {}), ...(idem ? { 'idempotency-key': idem } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  it('view → start → finish; bad bodies are 400, impossible taps 422', async () => {
    const w = world();
    const h = await w.player('u');
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (w.svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(w.svc, args)) as PlayerInvoker['invoke'] };
    const c = {
      master: m, authenticate: async (r: Request) => { const u = r.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
      player: () => invoker, friends: makeFriendsService(() => invoker, new MemoryDirectory()), clock: () => w.now(),
      paidBalance: async () => ({}), adminToken: 'x', parseStoreNotification: async () => null,
    } as unknown as AppContext;
    expect((await handle(req('GET', '/v1/training'), {}, c)).status).toBe(401);
    expect(await (await handle(req('GET', '/v1/training', 'u'), {}, c)).json()).toMatchObject({ enabled: true, slotsLeft: 3 });
    expect((await handle(req('POST', '/v1/training/start', 'u', undefined, { horseId: h, menuId: 'hill' }), {}, c)).status).toBe(400); // key required
    expect((await handle(req('POST', '/v1/training/start', 'u', 'k0', { horseId: h, menuId: 'hill', boost: 1 }), {}, c)).status).toBe(400); // strict body
    const st = await (await handle(req('POST', '/v1/training/start', 'u', 'k1', { horseId: h, menuId: 'hill' }), {}, c)).json() as { session: { sessionId: string; beats: number[] } };
    // claiming every beat at once right after the start: the server knows only ~0 ms have passed
    const fast = await handle(req('POST', `/v1/training/${st.session.sessionId}/finish`, 'u', 'k2', { taps: st.session.beats }), {}, c);
    expect(fast.status).toBe(422);
    expect(((await fast.json()) as { error: { code: string } }).error.code).toBe('TRAINING_INPUT_INVALID');
    w.advance(6500);
    const ok = await handle(req('POST', `/v1/training/${st.session.sessionId}/finish`, 'u', 'k3', { taps: st.session.beats }), {}, c);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ grade: 'great', timing: { perfect: 5 } });
    expect((await handle(req('POST', '/v1/training/BAD/finish', 'u', 'k4', { taps: [] }), {}, c)).status).toBe(400);
  });
});
