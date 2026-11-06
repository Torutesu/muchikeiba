import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dayRule } from '../src/domain/time.js';
import { m, makeConfig } from './helpers.js';
import { dailyGoing, groundFor, inNightWindow, jstHour, weatherProblems } from '../src/domain/ground.js';
import { buildRaceConfig, toRaceHorse } from '../src/domain/raceConfig.js';
import { OPTIONAL_RULESET_KEYS, BALANCE_RULESET_KEYS, DISTANCE_RULESET_KEYS, DEFAULT_RULESET, rulesetKeyProblems } from '../src/domain/ruleset.js';
import { raceStartConfigSchema, replayLogSchema } from '../src/domain/schemas.js';
import { createHorseFromTemplate, breed, goingAptitudeOdds } from '../src/domain/horses.js';
import { newPlayer, type HorseInstance } from '../src/domain/player.js';
import { seededRng } from '../src/domain/rng.js';
import { createRace } from '../src/race/orchestrate.js';
import type { Master } from '../src/domain/master.js';

const repo = (p: string) => join(__dirname, '../..', p);
// 2026-11-05 15:00 JST = 06:00 UTC
const DAY = Date.UTC(2026, 10, 5, 6);
const HOUR = 3600_000;

describe('daily going (REQ-RACE-037)', () => {
  const w = m.progression.weather;
  const turf = m.tracks.find((t) => t.id === 'kirameki_turf_2000')!;

  it('is the same all day for a course and changes between days', () => {
    const g = dailyGoing(w, turf, DAY, dayRule(m));
    for (let h = -6; h < 9; h++) expect(dailyGoing(w, turf, DAY + h * HOUR, dayRule(m))).toBe(g); // 09:00..23:59 JST
    const seen = new Set<string>();
    for (let d = 0; d < 60; d++) seen.add(dailyGoing(w, turf, DAY + d * 24 * HOUR, dayRule(m)));
    expect(seen.size).toBeGreaterThan(2);
  });

  it('follows the configured weights over many days and only uses names valid for the surface', () => {
    const count: Record<string, number> = {};
    const dirt = m.tracks.find((t) => t.surface === 'dirt')!;
    for (let d = 0; d < 4000; d++) {
      const g = dailyGoing(w, turf, Date.UTC(2020, 0, 1, 6) + d * 24 * HOUR, dayRule(m));
      count[g] = (count[g] ?? 0) + 1;
      expect(['fast', 'good', 'muddy', 'sloppy']).toContain(dailyGoing(w, dirt, Date.UTC(2020, 0, 1, 6) + d * 24 * HOUR, dayRule(m)));
    }
    const total = Object.values(w.turf).reduce((a, b) => a + (b ?? 0), 0);
    for (const [name, wt] of Object.entries(w.turf)) expect(Math.abs((count[name] ?? 0) / 4000 - wt! / total)).toBeLessThan(0.04);
    expect(Object.keys(count).every((k) => ['firm', 'good', 'yielding', 'soft'].includes(k))).toBe(true);
  });

  it('night only at lit venues inside the JST evening window (wrapping midnight)', () => {
    expect(inNightWindow(18, 18, 4)).toBe(true);
    expect(inNightWindow(23, 18, 4)).toBe(true);
    expect(inNightWindow(3, 18, 4)).toBe(true);
    expect(inNightWindow(4, 18, 4)).toBe(false);
    expect(inNightWindow(12, 18, 4)).toBe(false);
    const evening = Date.UTC(2026, 10, 5, 11); // 20:00 JST
    expect(jstHour(evening)).toBe(20);
    expect(groundFor(m, 'minato_dirt_1800', 'ranked', evening)!.night).toBe(true);
    expect(groundFor(m, 'minato_dirt_1800', 'ranked', DAY)!.night).toBe(false);
    expect(groundFor(m, 'kirameki_turf_2000', 'ranked', evening)!.night).toBe(false); // no floodlights
  });

  it('tutorial and time attack race without weather fields', () => {
    expect(groundFor(m, 'kirameki_turf_2000', 'tutorial', DAY)).toBeNull();
    expect(groundFor(m, 'kirameki_turf_2000', 'timeattack', DAY)).toBeNull();
    expect(groundFor(m, 'kirameki_turf_2000', 'friend', DAY)).not.toBeNull();
  });

  it('operator overrides win (course-specific over global) and may force night; wrong-surface names are ignored', () => {
    const mm: Master = { ...m, progression: { ...m.progression, weather: { ...m.progression.weather, overrides: [
      { fromMs: DAY - HOUR, toMs: DAY + HOUR, going: 'soft' },
      { trackId: 'minato_turf_2400', fromMs: DAY - HOUR, toMs: DAY + HOUR, going: 'firm', night: true },
      { trackId: 'aoba_dirt_1400', fromMs: DAY - HOUR, toMs: DAY + HOUR, going: 'soft' },
    ] } } };
    expect(groundFor(mm, 'kirameki_turf_2000', 'ranked', DAY)).toEqual({ going: 'soft', night: false });
    expect(groundFor(mm, 'minato_turf_2400', 'ranked', DAY)).toEqual({ going: 'firm', night: true });
    expect(groundFor(mm, 'aoba_dirt_1400', 'ranked', DAY)!.going).toBe(dailyGoing(mm.progression.weather, m.tracks.find((t) => t.id === 'aoba_dirt_1400')!, DAY, dayRule(m)));
    expect(groundFor(mm, 'kirameki_turf_2000', 'ranked', DAY + 2 * HOUR)!.going).toBe(dailyGoing(m.progression.weather, m.tracks.find((t) => t.id === 'kirameki_turf_2000')!, DAY + 2 * HOUR, dayRule(m)));
  });

  it('validates weather config for remote config', () => {
    expect(weatherProblems(m.progression.weather)).toEqual([]);
    expect(weatherProblems({ ...m.progression.weather, turf: { mud: 3 } }).join()).toMatch(/unknown going mud/);
    expect(weatherProblems({ ...m.progression.weather, dirt: { fast: 0, good: 0 } }).join()).toMatch(/all be zero/);
    expect(weatherProblems({ ...m.progression.weather, nightFromHourJst: 25 }).join()).toMatch(/0\.\.23/);
    expect(weatherProblems({ ...m.progression.weather, overrides: [{ fromMs: 2, toMs: 1, going: 'soft' }] }).join()).toMatch(/fromMs < toMs/);
  });
});

describe('race configs carry ground (REQ-RACE-034/035)', () => {
  it('ranked/friend races get the day\'s going; tutorial gets none', async () => {
    const p = newPlayer('g', 0, '2026-11');
    const entry = { playerId: 'p0', horse: toRaceHorse(m, createHorseFromTemplate(p, m.templateById.get('t_akatsuki')!, 0)), statCap: 3200, rating: { r: 1500, rd: 350, vol: 0.06 } };
    const ranked = await createRace(m, { mode: 'ranked', humans: [entry as never], cpuCount: 11, cpuLevel: 3, rng: seededRng(3), now: DAY, ticketSecret: 's', trackId: 'minato_dirt_1800' });
    expect(ranked.config.track.going).toBe(groundFor(m, 'minato_dirt_1800', 'ranked', DAY)!.going);
    expect(ranked.config.track.night).toBe(false);
    const tut = await createRace(m, { mode: 'tutorial', humans: [entry as never], cpuCount: 11, cpuLevel: 1, rng: seededRng(3), now: DAY, ticketSecret: 's' });
    expect(tut.config.track.going).toBeUndefined();
    expect(tut.config.track.night).toBeUndefined();
  });

  it('a going must match the track surface; old configs without the fields stay valid', () => {
    const c = makeConfig(1);
    expect(c.track.going).toBeUndefined();
    expect(raceStartConfigSchema.safeParse(c).success).toBe(true);
    expect(raceStartConfigSchema.safeParse({ ...c, track: { ...c.track, going: 'soft', night: true } }).success).toBe(true);
    expect(raceStartConfigSchema.safeParse({ ...c, track: { ...c.track, going: 'sloppy' } }).success).toBe(false); // dirt name on turf
  });

  it('goingAptitude is sent only when it is a real preference', () => {
    const p = newPlayer('a', 0, '2026-11');
    const heavy = toRaceHorse(m, createHorseFromTemplate(p, m.templateById.get('t_ginga')!, 0));
    const plain = toRaceHorse(m, createHorseFromTemplate(p, m.templateById.get('t_akatsuki')!, 0));
    expect(heavy.goingAptitude).toBe('heavy');
    expect('goingAptitude' in plain).toBe(false);
    const cfg = buildRaceConfig(m, { raceId: 'r', mode: 'friend', trackId: 'aoba_dirt_1400', humans: [{ playerId: 'p', horse: plain }], cpuCount: 11, cpuLevel: 3, statCap: null, rng: seededRng(9) });
    for (const e of cfg.entrants.filter((x) => x.kind === 'cpu')) {
      const tpl = m.templates.find((t) => `cpu_${t.id}` === e.horse.id)!;
      expect(e.horse.goingAptitude).toBe(tpl.goingAptitude && tpl.goingAptitude !== 'any' ? tpl.goingAptitude : undefined);
    }
  });

  it('master has dirt courses, a lit venue and dirt-bred templates', () => {
    expect(m.tracks.some((t) => t.surface === 'dirt')).toBe(true);
    expect(m.litTracks.size).toBeGreaterThan(0);
    expect(m.templates.filter((t) => t.surface === 'dirt').length).toBeGreaterThanOrEqual(3);
    for (const t of m.tracks) expect(t).not.toHaveProperty('lights');
  });
});

describe('ruleset ground keys', () => {
  it('match the engine list and are all in the default file', () => {
    const cs = readFileSync(repo('engine/Muchi.Engine/RulesetParams.cs'), 'utf8');
    const block = cs.slice(cs.indexOf('OptionalIntKeys ='), cs.indexOf('OptionalNeutralValues'));
    const engineKeys = [...block.matchAll(/"([a-z][A-Za-z]+)"/g)].map((x) => x[1]);
    expect(engineKeys).toEqual([...OPTIONAL_RULESET_KEYS]);
    for (const k of OPTIONAL_RULESET_KEYS) expect(DEFAULT_RULESET).toHaveProperty(k);
  });

  it('the balance key group matches the engine list and is all-or-none', () => {
    const cs = readFileSync(repo('engine/Muchi.Engine/RulesetParams.cs'), 'utf8');
    const block = cs.slice(cs.indexOf('BalanceIntKeys ='), cs.indexOf('BalanceNeutralValues'));
    const engineKeys = [...block.matchAll(/"([a-z][A-Za-z]+)"/g)].map((x) => x[1]);
    expect(engineKeys).toEqual([...BALANCE_RULESET_KEYS]);
    const v100: Record<string, unknown> = { ...DEFAULT_RULESET };
    for (const k of BALANCE_RULESET_KEYS) delete v100[k];
    expect(rulesetKeyProblems(v100)).toEqual([]);
    expect(rulesetKeyProblems({ ...v100, cpuSloppyMaxLevel: 3 }).join()).toMatch(/balance \(1\.1\) keys must be all present or all absent/);
  });

  it('the distance key group (1.2) matches the engine list and is all-or-none', () => {
    const cs = readFileSync(repo('engine/Muchi.Engine/RulesetParams.cs'), 'utf8');
    const block = cs.slice(cs.indexOf('DistanceIntKeys ='), cs.indexOf('DistanceNeutralValues'));
    const engineKeys = [...block.matchAll(/"([a-z][A-Za-z]+)"/g)].map((x) => x[1]);
    expect(engineKeys).toEqual([...DISTANCE_RULESET_KEYS]);
    expect(DEFAULT_RULESET.rulesetVersion).toBe('1.3.0');
    for (const k of DISTANCE_RULESET_KEYS) expect(DEFAULT_RULESET).toHaveProperty(k);
    const v110: Record<string, unknown> = { ...DEFAULT_RULESET };
    for (const k of DISTANCE_RULESET_KEYS) delete v110[k];
    expect(rulesetKeyProblems(v110)).toEqual([]);
    expect(rulesetKeyProblems({ ...v110, distanceRefM: 2000 }).join()).toMatch(/distance \(1\.2\) keys must be all present or all absent/);
  });

  it('every archived golden (ruleset 1.0, 1.0.0, 1.1.0 and 1.2.0) still validates', () => {
    const dir = repo('contracts/golden/legacy');
    for (const f of readdirSync(dir)) {
      const doc = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
      expect(replayLogSchema.safeParse(doc.log).success, f).toBe(true);
    }
  });

  it('a pre-ground ruleset (all optional keys absent) is valid; a partial set is not', () => {
    const legacy: Record<string, unknown> = { ...DEFAULT_RULESET };
    for (const k of [...OPTIONAL_RULESET_KEYS, ...BALANCE_RULESET_KEYS, ...DISTANCE_RULESET_KEYS]) delete legacy[k];
    expect(rulesetKeyProblems(legacy)).toEqual([]);
    const partial = { ...legacy, goingSpecialistPermille: 8 };
    expect(rulesetKeyProblems(partial).join()).toMatch(/all present or all absent/);
  });

  it('legacy golden replay logs (before the ground keys) still validate', () => {
    for (const f of ['race-turf2000-cpu12', 'race-turf1600-mixed']) {
      const doc = JSON.parse(readFileSync(repo(`contracts/golden/legacy/${f}.ruleset-1.0.json`), 'utf8'));
      expect(replayLogSchema.safeParse(doc.log).success).toBe(true);
    }
  });
});

describe('breeding passes on ground preferences (REQ-RACE-035)', () => {
  it('odds come from one function used by breed() and the preview', () => {
    expect(goingAptitudeOdds({}, {})).toEqual({ any: 1000, fast: 0, heavy: 0 });
    expect(goingAptitudeOdds({ goingAptitude: 'heavy' }, { goingAptitude: 'heavy' })).toEqual({ any: 200, fast: 0, heavy: 800 });
    expect(goingAptitudeOdds({ goingAptitude: 'fast' }, {})).toEqual({ any: 500, fast: 500, heavy: 0 });
    expect(goingAptitudeOdds({ goingAptitude: 'fast' }, { goingAptitude: 'heavy' })).toEqual({ any: 200, fast: 400, heavy: 400 });
  });

  it('two heavy-ground parents mostly give heavy-ground foals', () => {
    const mm: Master = { ...m, progression: { ...m.progression, breedingPerDay: 100000 } };
    const s = newPlayer('b', 0, '2026-11');
    const sire = createHorseFromTemplate(s, m.templateById.get('t_ginga')!, 0); // male, heavy
    const damTpl = m.templates.find((t) => t.sex === 'female')!;
    const dam = createHorseFromTemplate(s, damTpl, 0);
    dam.goingAptitude = 'heavy';
    for (const h of [sire, dam] as HorseInstance[]) h.status = 'retired';
    const rng = seededRng(77);
    let heavy = 0;
    const n = 400;
    for (let i = 0; i < n; i++) if (breed(mm, s, sire.id, dam.id, rng, i).foal.goingAptitude === 'heavy') heavy++;
    expect(heavy / n).toBeGreaterThan(0.72);
    expect(heavy / n).toBeLessThan(0.88);
  });
});
