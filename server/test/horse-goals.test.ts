import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import type { AppError } from '../src/domain/errors.js';
import { createHorseFromTemplate } from '../src/domain/horses.js';
import {
  HGOAL_KINDS, HGOAL_NOTICE, emptyGoalRecord, evaluateHorseGoals, goalTracks, horseGoalChain, horseGoalsProblems, noteHorseGoals,
  type HorseGoalHorse, type HorseGoalRecord, type HorseGoalTrack,
} from '../src/domain/horseGoals.js';
import { noteHallTa, myHallView } from '../src/domain/hallOfFame.js';
import { computeNextActions, nextActionConfig, nextActionProblems, nextActionSummary } from '../src/domain/nextAction.js';
import { bettingWordsIn } from '../src/domain/bettingWords.js';
import { catalogFor, translateText } from '../src/i18n/catalog.js';
import { clientBatchSchema, clientToKpi, type KpiRecord } from '../src/domain/kpi.js';
import type { RaceResultForPlayer } from '../src/domain/rewards.js';
import type { Master } from '../src/domain/master.js';
import type { PlayerState } from '../src/domain/player.js';
import { m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 10, 3);
const VECTORS_PATH = join(__dirname, '..', '..', 'contracts', 'horse-goals.vectors.json');

function world(master: Master = m) {
  const clock = { now: NOW };
  const kpi: KpiRecord[] = [];
  const svc = new PlayerService(new MemoryPlayerRepo(), {
    master, rng: seededRng(11), clock: () => clock.now, verifiers: {}, onKpi: (_id, recs) => { kpi.push(...recs); },
  });
  return { svc, clock, kpi };
}
type W = ReturnType<typeof world>;

/** A horse with fixed aptitudes (the chain depends only on these). */
async function horse(w: W, id: string, o: Partial<HorseGoalHorse> & { retired?: boolean } = {}) {
  return w.svc.tx(id, null, (s, now) => {
    const h = createHorseFromTemplate(s, m.templates[0]!, now);
    h.surface = o.surface ?? 'turf'; h.distMinM = o.distMinM ?? 1600; h.distMaxM = o.distMaxM ?? 2000; h.style = (o.style ?? 'senko') as typeof h.style;
    h.templateId = null; // the skill is only what the test sets (no template fallback)
    if (o.skillId) h.skillId = o.skillId; else delete h.skillId;
    if (o.retired) h.status = 'retired';
    s.flags.partnerHorseId ??= h.id;
    return h.id;
  });
}
let seq = 0;
const race = (horseId: string, place: number, o: Partial<RaceResultForPlayer> = {}, trackId = 'aoba_turf_1600'): RaceResultForPlayer => ({
  raceId: `hg${++seq}`, mode: 'ranked', place, fieldSize: 8, newRating: null, void: false, humans: 2, horseId,
  details: { trackId, style: 'senko', finishTick: 1000, startReactionTicks: 2, whips: 3, whipMashed: false, cpuAssisted: false }, ...o,
});
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as AppError).code; } };
const st = async (w: W, id: string) => (await w.svc.state(id)) as PlayerState;

const TRACKS: HorseGoalTrack[] = goalTracks(m);

describe('馬ごとの目標: the chain (REQ-HGOAL-001/002)', () => {
  it('a mid-distance turf front runner without a skill: 7 goals in story order', () => {
    const c = horseGoalChain({ surface: 'turf', distMinM: 1600, distMaxM: 2000, style: 'senko', skillId: null }, TRACKS);
    expect(c.map((g) => g.id)).toEqual(['first_win', 'races:10', 'surface_win:turf', 'ta_course:aoba_turf_1600', 'stretch_win:sprint', 'ranked_top3:5', 'tournament_win']);
    expect(c.find((g) => g.kind === 'ta_course')!.text).toBe('タイムアタック 青葉競馬場 芝1600m で記録を残す');
  });
  it('a closer stretches longer when it can, a horse covering every runnable band has no stretch goal, a skill adds 5 wins', () => {
    const closer = horseGoalChain({ surface: 'turf', distMinM: 1200, distMaxM: 1600, style: 'oikomi', skillId: 'sk_x' }, TRACKS);
    expect(closer.map((g) => g.id)).toContain('stretch_win:intermediate');
    expect(closer.map((g) => g.id)).toContain('wins:5');
    const wide = horseGoalChain({ surface: 'turf', distMinM: 1000, distMaxM: 2400, style: 'sashi', skillId: null }, TRACKS);
    expect(wide.some((g) => g.kind === 'stretch_win')).toBe(false); // no 2401 m+ course exists
    expect(wide.length).toBe(6);
  });
  it('`both` picks the surface with more courses in range (tie → turf); the same input gives the same chain', () => {
    const dirtish = { surface: 'both' as const, distMinM: 1400, distMaxM: 1800, style: 'nige', skillId: null };
    expect(horseGoalChain(dirtish, TRACKS).find((g) => g.kind === 'surface_win')!.params.surface).toBe('dirt');
    expect(horseGoalChain(dirtish, TRACKS)).toEqual(horseGoalChain(dirtish, [...TRACKS].reverse()));
  });
  it('every text has English, no betting / urgency words in either language (REQ-HGOAL-013/014)', () => {
    const cat = catalogFor(m);
    const texts = new Set<string>([HGOAL_NOTICE]);
    for (const surface of ['turf', 'dirt', 'both'] as const) for (const style of ['nige', 'senko', 'sashi', 'oikomi']) for (const [a, b] of [[1000, 1400], [1200, 1600], [1600, 2000], [1800, 2400], [2000, 2400], [1000, 2400]])
      for (const g of horseGoalChain({ surface, distMinM: a!, distMaxM: b!, style, skillId: style === 'sashi' ? 'sk' : null }, TRACKS)) texts.add(g.text);
    const kinds = new Set<string>();
    for (const surface of ['turf', 'dirt'] as const) for (const g of horseGoalChain({ surface, distMinM: 1000, distMaxM: 1300, style: 'sashi', skillId: 'sk' }, TRACKS)) kinds.add(g.kind);
    expect(texts.size).toBeGreaterThan(10);
    for (const t of texts) {
      const en = translateText(t, cat) ?? t;
      expect(en, t).not.toMatch(/[぀-ヿ一-鿿]/);
      expect(bettingWordsIn(t), t).toEqual([]);
      expect(bettingWordsIn(en), en).toEqual([]);
      for (const w of ['倍', '今だけ', '残りわずか', 'お得', '通常価格']) expect(t).not.toContain(w);
    }
    expect(HGOAL_KINDS.length).toBe(8);
  });
});

describe('馬ごとの目標: progress (REQ-HGOAL-003)', () => {
  it('evaluates have / done / current from a record; completion stamps win over a lower count', () => {
    const chain = horseGoalChain({ surface: 'turf', distMinM: 1600, distMaxM: 2000, style: 'senko', skillId: null }, TRACKS);
    const r: HorseGoalRecord = { ...emptyGoalRecord(), races: 12, wins: 2, surfaceWins: { turf: 2, dirt: 0 } };
    const g = evaluateHorseGoals(chain, r);
    expect(g.map((x) => [x.id, x.have, x.done])).toEqual([
      ['first_win', 1, true], ['races:10', 10, true], ['surface_win:turf', 2, false], ['ta_course:aoba_turf_1600', 0, false],
      ['stretch_win:sprint', 0, false], ['ranked_top3:5', 0, false], ['tournament_win', 0, false]]);
    expect(g.find((x) => x.current)!.id).toBe('surface_win:turf');
    expect(evaluateHorseGoals(chain, r, { 'surface_win:turf': 5 }).find((x) => x.current)!.id).toBe('ta_course:aoba_turf_1600');
  });

  it('counts only §34 races: once per race id, not cup / void / tutorial / solo friend; surface, band and ranked top 3 tallies', async () => {
    const w = world();
    const h = await horse(w, 'a');
    await w.svc.applyRace('a', race(h, 1));
    const dup = race(h, 1);
    await w.svc.applyRace('a', dup);
    await w.svc.applyRace('a', dup); // same race id again: once
    await w.svc.applyRace('a', race(h, 1, { mode: 'cup' }));
    await w.svc.applyRace('a', race(h, 1, { void: true }));
    await w.svc.applyRace('a', race(h, 1, { mode: 'friend', humans: 1 }));
    await w.svc.applyRace('a', race(h, 1, { mode: 'event' }, 'bellmoor_turf_1200')); // a sprint win, not ranked
    await w.svc.applyRace('a', race(h, 3)); // ranked top 3
    await w.svc.applyRace('a', race(h, 1, {}, 'aoba_dirt_1400')); // dirt win
    const v = await w.svc.horseGoals('a', h);
    const by = Object.fromEntries(v.goals.map((g) => [g.id, g]));
    expect(by['races:10']!.have).toBe(5);
    expect(by['surface_win:turf']!.have).toBe(3);
    expect(by['surface_win:turf']!.done).toBe(true);
    expect(by['stretch_win:sprint']!.done).toBe(true); // bellmoor 1200 m + aoba dirt 1400 m are sprints
    expect(by['ranked_top3:5']!.have).toBe(4);
    const c = (await st(w, 'a')).hall!.careers[h]!;
    expect(c.goal).toEqual({ surfaceWins: { turf: 3, dirt: 1 }, bandWins: { mile: 2, sprint: 2 }, rankedPlaces: 4 });
    // missions are untouched by goals: no coin moves when a goal completes (REQ-HGOAL-004)
    const before = (await st(w, 'a')).wallet;
    await w.svc.tx('a', null, (s, now) => noteHorseGoals(m, s, h, now));
    expect((await st(w, 'a')).wallet).toEqual(before);
  });

  it('records each completion once with hgoal_complete; the last goal sends chain; time attack and tournament count', async () => {
    const w = world();
    const h = await horse(w, 'b', { surface: 'turf', distMinM: 1600, distMaxM: 2000, style: 'senko' });
    await w.svc.applyRace('b', race(h, 1));
    let done = w.kpi.filter((k) => k.name === 'hgoal_complete');
    expect(done.map((k) => k.s1)).toEqual(['first_win']);
    await w.svc.applyRace('b', race(h, 1)); // nothing new for first_win
    expect(w.kpi.filter((k) => k.name === 'hgoal_complete').length).toBe(1);
    for (let i = 0; i < 8; i++) await w.svc.applyRace('b', race(h, 2));
    await w.svc.applyRace('b', race(h, 1, {}, 'bellmoor_turf_1200'));
    await w.svc.tx('b', null, (s, now, emit) => { noteHallTa(m, s, h, 'aoba_turf_1600', 95_000, now); noteHorseGoals(m, s, h, now, emit); });
    await w.svc.tournamentClose('b', 't1', 1, null, '秋の陣', h);
    const v = await w.svc.horseGoals('b', h);
    expect(v.goals.filter((g) => !g.done).map((g) => [g.id, g.have])).toEqual([]);
    expect(v.chainComplete).toBe(true);
    expect(v.doneCount).toBe(v.total);
    expect(v.chainCompletedAt).toBe(NOW);
    done = w.kpi.filter((k) => k.name === 'hgoal_complete');
    expect(new Set(done.map((k) => k.s1)).size).toBe(done.length); // once per goal
    expect(done.length).toBe(v.total);
    expect(done[done.length - 1]!.s2).toBe('chain');
    expect(done[done.length - 1]!.s1).toBe('tournament_win');
    // ranked fairness: stats / skill / items untouched by finishing the chain
    const s = await st(w, 'b');
    const hh = s.horses.find((x) => x.id === h)!;
    expect(hh.trained).toBeUndefined();
    // the career view and the hall plaque carry the ribbon (REQ-HGOAL-009)
    expect((await w.svc.horseCareer('b', h)).goals).toEqual({ doneCount: v.total, total: v.total, chainComplete: true });
    await w.svc.retire('b', h);
    const hall = myHallView(m, await st(w, 'b'), null, null);
    expect(hall.entries[0]!.goalsComplete).toBe(true);
    // retired: the goals are kept
    const after = await w.svc.horseGoals('b', h);
    expect(after.status).toBe('retired');
    expect(after.chainComplete).toBe(true);
  });
});

describe('馬ごとの目標: pin, home and next action (REQ-HGOAL-007/008)', () => {
  it('pins one horse idempotently, refuses retired / complete / unknown, reads a stale pin as none', async () => {
    const w = world();
    const h1 = await horse(w, 'c');
    const h2 = await horse(w, 'c', { surface: 'dirt', distMinM: 1400, distMaxM: 1800 });
    const old = await horse(w, 'c', { retired: true });
    const r = await w.svc.pinHorseGoal('c', h1);
    expect(r.pinned!.horseId).toBe(h1);
    expect(r.pinned!.goal.id).toBe('first_win');
    await w.svc.pinHorseGoal('c', h1);
    expect(w.kpi.filter((k) => k.name === 'hgoal_pin').map((k) => [k.s1, k.s2])).toEqual([['pin', 'first_win']]);
    await w.svc.pinHorseGoal('c', h2); // replaces
    expect((await w.svc.pinnedHorseGoal('c')).pinned!.horseId).toBe(h2);
    expect((await w.svc.horseGoals('c', h1)).pinned).toBe(false);
    expect(await code(w.svc.pinHorseGoal('c', old))).toBe('NOT_ELIGIBLE');
    expect(await code(w.svc.pinHorseGoal('c', 'h_nope'))).toBe('HORSE_NOT_FOUND');
    expect((await w.svc.view('c') as { horseGoalPin: { horseId: string } | null }).horseGoalPin!.horseId).toBe(h2);
    await w.svc.tx('c', null, (s) => { s.horses.find((x) => x.id === h2)!.status = 'retired'; });
    expect((await w.svc.pinnedHorseGoal('c')).pinned).toBeNull();
    await w.svc.pinHorseGoal('c', null);
    expect(w.kpi.filter((k) => k.name === 'hgoal_pin').map((k) => k.s1)).toEqual(['pin', 'pin']); // unpin of a stale pin: no change
  });

  it('horse_goal_near: only with real progress and within the threshold; opens horse_goals, never the shop', async () => {
    expect(nextActionProblems(m)).toEqual([]);
    const cfg = nextActionConfig(m)!;
    const rule = cfg.rules.find((x) => x.kind === 'horse_goal_near')!;
    expect(rule.threshold).toBe(2);
    const w = world();
    const h = await horse(w, 'd');
    await w.svc.applyRace('d', race(h, 1));
    for (let i = 0; i < 7; i++) await w.svc.applyRace('d', race(h, 4));
    await w.svc.pinHorseGoal('d', h); // current = races:10 with 8 done → 2 left
    const s = await st(w, 'd');
    const x = { ...nextActionSummary(m, s, w.clock.now), onboarding: false, deleting: false };
    expect(x.horseGoal).toEqual({ horseId: h, have: 8, unitsLeft: 2 });
    const only = { ...cfg, rules: [rule, { kind: 'race' as const, priority: 0 }] };
    const r = computeNextActions(only, x);
    expect(r.primary).toMatchObject({ kind: 'horse_goal_near', screen: 'horse_goals', count: 2, refId: h, deadlineAt: null, dismissible: true });
    expect(computeNextActions(only, { ...x, horseGoal: { horseId: h, have: 0, unitsLeft: 1 } }).primary!.kind).toBe('race'); // no progress yet
    expect(computeNextActions(only, { ...x, horseGoal: { horseId: h, have: 2, unitsLeft: 3 } }).primary!.kind).toBe('race');
    const bad = { ...m, progression: { ...m.progression, nextActions: { ...cfg, rules: cfg.rules.map((q) => (q.kind === 'horse_goal_near' ? { ...q, threshold: 11 } : q)) } } } as Master;
    expect(nextActionProblems(bad).join()).toMatch(/threshold must be 1..10/);
  });
});

describe('馬ごとの目標: config, KPI, deletion (REQ-HGOAL-012/015, §53.9)', () => {
  it('needs the hall; disabled = 404 and nothing recorded', async () => {
    expect(horseGoalsProblems(m)).toEqual([]);
    const noHall = { ...m, progression: { ...m.progression, hall: { ...m.progression.hall!, enabled: false } } } as Master;
    expect(horseGoalsProblems(noHall).join()).toMatch(/needs progression.hall/);
    expect(horseGoalsProblems({ ...m, progression: { ...m.progression, horseGoals: { enabled: true, coins: 5 } } } as unknown as Master).join()).toMatch(/not a known key/);
    const off = { ...m, progression: { ...m.progression, horseGoals: { enabled: false } } } as Master;
    const w = world(off);
    const h = await horse(w, 'e');
    await w.svc.applyRace('e', race(h, 1));
    expect(await code(w.svc.horseGoals('e', h))).toBe('NOT_FOUND');
    expect((await st(w, 'e')).horseGoals).toBeUndefined();
    expect((await w.svc.pinnedHorseGoal('e')).pinned).toBeNull();
  });
  it('hgoal_view is a client event (surface, done)', () => {
    const b = clientBatchSchema.parse({ platform: 'ios', appVersion: '1.0', events: [{ name: 'hgoal_view', at: 1, props: { surface: 'home', done: 3 } }] });
    expect(clientToKpi(b.events[0]!)).toEqual({ name: 'hgoal_view', s1: 'home', value: 3 });
    expect(clientBatchSchema.safeParse({ platform: 'ios', appVersion: '1.0', events: [{ name: 'hgoal_view', at: 1, props: { surface: 'shop', done: 3 } }] }).success).toBe(false);
  });
  it('account deletion removes the goals with the state', async () => {
    const w = world();
    const h = await horse(w, 'f');
    await w.svc.applyRace('f', race(h, 1));
    await w.svc.pinHorseGoal('f', h);
    expect((await st(w, 'f')).horseGoals!.done[h]).toBeDefined();
    await w.svc.wipe('f');
    const fresh = await st(w, 'f'); // a fresh state (the wiped one is gone)
    expect(fresh.horseGoals).toBeUndefined();
    expect(fresh.hall).toBeUndefined();
  });
});

describe('馬ごとの目標: shared vectors (TS ↔ C# HorseGoalChain)', () => {
  it('matches contracts/horse-goals.vectors.json', () => {
    const v = vectors();
    if (process.env.UPDATE_VECTORS === '1') writeFileSync(VECTORS_PATH, JSON.stringify(v, null, 2) + '\n');
    const file = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as ReturnType<typeof vectors>;
    expect(file).toEqual(v);
  });
});

function vectors() {
  const horses: [string, HorseGoalHorse][] = [
    ['turf mile-intermediate senko', { surface: 'turf', distMinM: 1600, distMaxM: 2000, style: 'senko', skillId: null }],
    ['turf sprinter oikomi with skill', { surface: 'turf', distMinM: 1000, distMaxM: 1400, style: 'oikomi', skillId: 'sk_sueashi' }],
    ['dirt nige mile', { surface: 'dirt', distMinM: 1600, distMaxM: 1800, style: 'nige', skillId: null }],
    ['dirt sashi sprint (no longer dirt band runnable beyond)', { surface: 'dirt', distMinM: 1000, distMaxM: 1400, style: 'sashi', skillId: null }],
    ['both nige (dirt has more courses)', { surface: 'both', distMinM: 1400, distMaxM: 1800, style: 'nige', skillId: 'sk_kirameki' }],
    ['both stayer sashi (tie → turf)', { surface: 'both', distMinM: 2000, distMaxM: 2400, style: 'sashi', skillId: null }],
    ['turf wide range (no stretch)', { surface: 'turf', distMinM: 1000, distMaxM: 2400, style: 'senko', skillId: null }],
    ['turf stayer nige (shorter side)', { surface: 'turf', distMinM: 2200, distMaxM: 3000, style: 'nige', skillId: null }],
    ['turf out of every course (gap ranks the course)', { surface: 'turf', distMinM: 2600, distMaxM: 3200, style: 'oikomi', skillId: 'sk' }],
  ];
  const records: [string, HorseGoalRecord, Record<string, number>][] = [
    ['empty', emptyGoalRecord(), {}],
    ['started', { ...emptyGoalRecord(), races: 4, wins: 1, surfaceWins: { turf: 1, dirt: 0 }, bandWins: { sprint: 0, mile: 1, intermediate: 0, long: 0 }, rankedPlaces: 2 }, {}],
    ['busy', { races: 25, wins: 6, tournamentWins: 0, taTracks: ['aoba_turf_1600', 'aoba_dirt_1400', 'minato_dirt_1800', 'bellmoor_turf_1200'], surfaceWins: { turf: 3, dirt: 3 }, bandWins: { sprint: 2, mile: 2, intermediate: 2, long: 0 }, rankedPlaces: 7 }, {}],
    ['stamped beats count', { ...emptyGoalRecord(), races: 2 }, { 'races:10': 1794000000000, first_win: 1793000000000 }],
    ['all done', { races: 40, wins: 12, tournamentWins: 1, taTracks: TRACKS.map((t) => t.id), surfaceWins: { turf: 6, dirt: 6 }, bandWins: { sprint: 3, mile: 3, intermediate: 3, long: 0 }, rankedPlaces: 9 }, {}],
  ];
  const cases = [];
  for (const [hn, h] of horses) for (const [rn, r, stamped] of records) {
    const chain = horseGoalChain(h, TRACKS);
    cases.push({ name: `${hn} / ${rn}`, horse: h, record: r, stamped, expect: evaluateHorseGoals(chain, r, stamped) });
  }
  return {
    _note: 'REQ-HGOAL-001..003 (contracts/protocol.md §53): server/src/domain/horseGoals.ts horseGoalChain + evaluateHorseGoals and C# Muchi.Client HorseGoalChain.Build + Evaluate must agree. Regenerate with UPDATE_VECTORS=1 npx vitest run test/horse-goals.test.ts.',
    v: 1, tracks: TRACKS, cases,
  };
}
