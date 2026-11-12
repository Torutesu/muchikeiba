// Quality pass 2 (docs/quality/ranked.md): ranked race fields exactly as the server issues them — the matchmaker's CPU fill
// (MatchmakerCore → rankedMatchRules → createRace → buildRaceConfig), the class cap, the course draw, the day's going — for
// one player on the partner horse (as given, and as a typical day-30 horse) in every class. The C# ranked harness
// (engine/Muchi.Verifier/RankedHarness.cs) rides these fields with a button-masher, an average and a skilled rider and
// measures win / top-3 rates (docs/spec/balance-targets.md §2.5, BalanceTests.RankedFieldsMeetTheWinnabilityTargets).
// contracts/ranked-fields.sample.json is written by scripts/gen-ranked-sample.ts; test/ranked-balance.test.ts fails while
// the committed copy differs. The file is compact (horses, courses and the net block once; races refer to them by key) and
// expands back to the exact configs (expandRankedSample, checked by the test).
import type { Master, Stats } from './master.js';
import { newPlayer, type HorseInstance } from './player.js';
import { createHorseFromTemplate } from './horses.js';
import { toRaceHorse } from './raceConfig.js';
import { classDef } from './season.js';
import { MatchmakerCore, DEFAULT_MM } from './matchmaker.js';
import { createRace, rankedMatchRules } from '../race/orchestrate.js';
import type { RaceEntry } from '../http/app.js';
import { DEFAULT_RULESET, type Ruleset } from './ruleset.js';
import { seededRng } from './rng.js';
import type { RaceStartConfig } from './schemas.js';

export const RANKED_SAMPLE_NOW = Date.UTC(2026, 10, 10, 3);
/** Races per class × horse (the harness rides every rider on the same fields). */
export const RANKED_SAMPLE_RACES = 160;

/**
 * A typical rating per class (assumption, docs/quality/ranked.md §1.2): a player's rating rises with the class it reached,
 * so a higher class also meets stronger CPU riders (cpuLevelFor: < 1400 → 2, < 1600 → 3, < 1800 → 4, else 5).
 */
export const RANKED_SAMPLE_RATINGS: Record<string, number> = { C: 1500, B: 1550, A: 1650, S: 1800 };

/**
 * The typical day-30 horse (assumption, docs/quality/ranked.md §1.2): the partner after a month of daily training — the SR
 * growth potential used up (240 points, spread like the economy sim's menus: ウッド/坂路/併せ馬) — and one awakening level.
 */
export const DAY30_TRAINED: Stats = { speed: 72, stamina: 48, burst: 60, guts: 36, temper: 24 };
export const DAY30_AWAKENING = 1;

export interface RankedSampleRace { raceId: string; seed: string; track: string; playerSlot: number; entrants: [string, number, string | null][] }
/** `stage`: beginner = the first `beginnerRaces` ranked races; ramp = the 10 races after them; regular = from then on. */
export interface RankedSampleSet { classId: string; horse: 'starter' | 'day30'; stage: 'beginner' | 'ramp' | 'regular'; beginner: boolean; rating: number; statCap: number; races: RankedSampleRace[] }
export interface RankedSample {
  _note: string;
  ruleset: Ruleset; net: RaceStartConfig['net'];
  /** progression.raceFreeCoinsByPlace.ranked: the harness weighs each rider's places with it (the economy sim assumes uniform places). */
  coinsByPlace: number[];
  tracks: Record<string, RaceStartConfig['track']>;
  horses: Record<string, RaceStartConfig['entrants'][number]['horse']>;
  sets: RankedSampleSet[];
}

function sampleHorses(m: Master): { starter: HorseInstance; day30: HorseInstance } {
  const s = newPlayer('sample', RANKED_SAMPLE_NOW, 'S2026-11');
  const t = m.templateById.get('t_partner')!;
  const starter = createHorseFromTemplate(s, t, RANKED_SAMPLE_NOW);
  const day30 = createHorseFromTemplate(s, t, RANKED_SAMPLE_NOW);
  day30.awakening = DAY30_AWAKENING;
  day30.trained = { ...DAY30_TRAINED };
  return { starter, day30 };
}

/** One ranked race as the matchmaker starts it for a lone player (the queue fills the field with CPUs after the wait). */
export async function issueRankedSampleRace(m: Master, ruleset: Ruleset, horse: 'starter' | 'day30', classId: string, rating: number, rankedRaces: number, i: number, now: number): Promise<RaceStartConfig> {
  const h = sampleHorses(m)[horse];
  const cls = classDef(m, classId);
  const beginner = rankedRaces < m.progression.beginnerRaces;
  const entry = {
    moderation: 'ok', playerId: 'p_sample', horse: toRaceHorse(m, h), rating: { r: rating, rd: 120, vol: 0.06 },
    classId: cls.id, statCap: cls.statCap, beginner, rankedRaces,
  } as unknown as RaceEntry;
  const mm = new MatchmakerCore<RaceEntry>(DEFAULT_MM);
  mm.enqueue({ playerId: entry.playerId, rating, beginner, enqueuedAt: now, payload: entry });
  const [match] = mm.tick(now + DEFAULT_MM.cpuFillAfterMs);
  const rng = seededRng(7100 + i);
  const created = await createRace(m, { ruleset, mode: 'ranked', humans: match!.players.map((p) => p.payload), rng, now, ticketSecret: 'sample', ...rankedMatchRules(m, match!) });
  return created.config;
}

export async function rankedSample(m: Master, races = RANKED_SAMPLE_RACES, ruleset: Ruleset = DEFAULT_RULESET): Promise<RankedSample> {
  const out: RankedSample = { _note: 'Generated by server/scripts/gen-ranked-sample.ts (npm run gen:ranked-sample). Do not edit.', ruleset, net: null as unknown as RaceStartConfig['net'], coinsByPlace: [...(m.progression.raceFreeCoinsByPlace.ranked ?? [])], tracks: {}, horses: {}, sets: [] };
  const trackKey = new Map<string, string>();
  const horseKey = new Map<string, string>();
  const key = <T>(map: Map<string, string>, store: Record<string, T>, prefix: string, v: T) => {
    const j = JSON.stringify(v);
    let k = map.get(j);
    if (!k) { k = prefix + map.size; map.set(j, k); store[k] = v; }
    return k;
  };
  const plan: { classId: string; horse: 'starter' | 'day30'; stage: RankedSampleSet['stage'] }[] = [
    { classId: 'C', horse: 'starter', stage: 'beginner' },
    { classId: 'C', horse: 'starter', stage: 'ramp' },
    ...m.progression.classes.flatMap((c) => (['starter', 'day30'] as const).map((horse) => ({ classId: c.id, horse, stage: 'regular' as const }))),
  ];
  const br = m.progression.beginnerRaces;
  let n = 0;
  for (const p of plan) {
    const rating = p.stage === 'regular' ? RANKED_SAMPLE_RATINGS[p.classId] ?? 1500 : 1500;
    const set: RankedSampleSet = { classId: p.classId, horse: p.horse, stage: p.stage, beginner: p.stage === 'beginner', rating, statCap: classDef(m, p.classId).statCap, races: [] };
    for (let i = 0; i < races; i++, n++) {
      const rankedRaces = p.stage === 'beginner' ? i % br : p.stage === 'ramp' ? br + (i % 10) : br + 40;
      // the clock moves 7 h per race so the day's going and day/night vary like a week of play
      const cfg = await issueRankedSampleRace(m, ruleset, p.horse, p.classId, rating, rankedRaces, n, RANKED_SAMPLE_NOW + i * 7 * 3600_000);
      out.net ??= cfg.net;
      const playerSlot = cfg.entrants.findIndex((e) => e.kind === 'human');
      set.races.push({
        raceId: cfg.raceId, seed: cfg.seed, track: key(trackKey, out.tracks, 't', cfg.track), playerSlot,
        entrants: cfg.entrants.map((e) => [key(horseKey, out.horses, 'h', e.horse), e.cpuLevel, e.playerId ?? null]),
      });
    }
    out.sets.push(set);
  }
  return out;
}

/** The exact RaceStartConfig of a sample race (the inverse of the compaction above). */
export function expandRankedRace(s: RankedSample, r: RankedSampleRace): RaceStartConfig {
  return {
    v: 1, raceId: r.raceId, mode: 'ranked', seed: r.seed, track: s.tracks[r.track]!, net: s.net, ruleset: s.ruleset,
    entrants: r.entrants.map(([h, cpuLevel, playerId], slot) => ({ slot, kind: playerId ? 'human' : 'cpu', playerId, cpuLevel, horse: s.horses[h]! })),
  } as RaceStartConfig;
}

export async function rankedSampleJson(m: Master): Promise<string> {
  return JSON.stringify(await rankedSample(m)) + '\n';
}
