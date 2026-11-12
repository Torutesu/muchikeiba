import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { m } from './helpers.js';
import { courseFits, rankedCourse, rankedCpuLevel, rankedCpuStatTotal, rankedFieldProblems, rankedRampPermille, type RankedFieldConfig } from '../src/domain/rankedField.js';
import { expandRankedRace, issueRankedSampleRace, rankedSample, rankedSampleJson, RANKED_SAMPLE_NOW, type RankedSample } from '../src/domain/rankedSample.js';
import { rankedMatchRules, createRace } from '../src/race/orchestrate.js';
import { buildRaceConfig, scaleToTotal, toRaceHorse } from '../src/domain/raceConfig.js';
import { newPlayer } from '../src/domain/player.js';
import { createHorseFromTemplate } from '../src/domain/horses.js';
import { seededRng } from '../src/domain/rng.js';
import { STAT_KEYS, type Master } from '../src/domain/master.js';
import { resolveBundle } from '../src/ops/config.js';
import type { RaceEntry } from '../src/http/app.js';
import type { Match } from '../src/domain/matchmaker.js';

// Quality pass 2 (docs/quality/ranked.md, REQ-MM-009..012, docs/spec/balance-targets.md §2.5): the ranked card.
const rf = m.progression.rankedField!;
const partner = () => toRaceHorse(m, createHorseFromTemplate(newPlayer('x', 0, '2026-11'), m.templateById.get('t_partner')!, 0));
const entry = (o: Partial<RaceEntry> & { rankedRaces?: number }) => ({ playerId: 'a', horse: partner(), classId: 'C', statCap: 2800, rating: { r: 1500, rd: 120, vol: 0.06 }, beginner: false, firstRace: null, ...o }) as unknown as RaceEntry;
const match = (payloads: RaceEntry[], o: Partial<Match<RaceEntry>> = {}): Match<RaceEntry> => ({
  players: payloads.map((p, i) => ({ playerId: `p${i}`, rating: 1500, beginner: false, enqueuedAt: 0, payload: p })), cpuCount: 12 - payloads.length, cpuLevel: 3, beginner: false, quarantined: false, ...o,
});

describe('REQ-MM-009 the ranked course fits the horses', () => {
  it('a turf 1600–2400 horse only draws turf courses in its range; every one of them comes up', () => {
    const h = partner();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(rankedCourse(m, [h], seededRng(i)));
    const fit = m.tracks.filter((t) => courseFits(t, h)).map((t) => t.id).sort();
    expect([...seen].sort()).toEqual(fit);
    expect(fit.length).toBeGreaterThanOrEqual(3);
    for (const id of seen) expect(m.tracks.find((t) => t.id === id)!.surface).toBe('turf');
  });

  it('horses with nothing in common still get a course that fits as many as possible (never no course)', () => {
    const turf = partner();
    const dirt = { distMinM: 1200, distMaxM: 1400, surface: 'dirt' };
    const both = { distMinM: 1400, distMaxM: 2000, surface: 'both' };
    for (let i = 0; i < 50; i++) {
      const id = rankedCourse(m, [turf, dirt, both], seededRng(i));
      const t = m.tracks.find((x) => x.id === id)!;
      expect([turf, dirt, both].filter((h) => courseFits(t, h)).length).toBe(2);
    }
    const none = { distMinM: 9000, distMaxM: 9999, surface: 'turf' };
    expect(m.tracks.map((t) => t.id)).toContain(rankedCourse(m, [none], seededRng(1)));
  });

  it('createRace uses it for ranked only (one draw from the race rng); off = any course as before', async () => {
    const humans = [entry({})];
    const tracks = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const c = await createRace(m, { mode: 'ranked', humans, cpuCount: 11, cpuLevel: 3, rng: seededRng(i), now: 0, ticketSecret: 's' });
      tracks.add(c.config.track.id);
      expect(courseFits(c.config.track, humans[0]!.horse)).toBe(true);
    }
    expect(tracks.size).toBeGreaterThan(1);
    const off: Master = { ...m, progression: { ...m.progression, rankedField: { ...rf, courseFitsHorses: false } } };
    const anyTracks = new Set<string>();
    for (let i = 0; i < 60; i++) anyTracks.add((await createRace(off, { mode: 'ranked', humans, cpuCount: 11, cpuLevel: 3, rng: seededRng(i), now: 0, ticketSecret: 's' })).config.track.id);
    expect(anyTracks.size).toBe(m.tracks.length);
    // friend rooms keep the host's course or any course (the ranked rule is not theirs)
    const friend = new Set<string>();
    for (let i = 0; i < 60; i++) friend.add((await createRace(m, { mode: 'friend', humans: [entry({}), entry({ playerId: 'b' })], cpuCount: 0, cpuLevel: 3, rng: seededRng(i), now: 0, ticketSecret: 's' })).config.track.id);
    expect(friend.size).toBe(m.tracks.length);
  });
});

describe('REQ-MM-010..011 CPU level, strength and the ramp per class', () => {
  it('the CPU level is the rating level clamped to the class band', () => {
    const cfg: RankedFieldConfig = { courseFitsHorses: true, cpuLevelByClass: { C: { min: 2, max: 3 }, S: { min: 4, max: 5 } } };
    expect(rankedCpuLevel(cfg, 'C', 5)).toBe(3);
    expect(rankedCpuLevel(cfg, 'C', 1)).toBe(2);
    expect(rankedCpuLevel(cfg, 'S', 2)).toBe(4);
    expect(rankedCpuLevel(cfg, 'B', 2)).toBe(2); // no band: as before
    expect(rankedCpuLevel(undefined, 'C', 4)).toBe(4);
  });

  it('the ramp follows the beginner matches and ends at full strength', () => {
    const ramp = rf.rampCpuStatPermille ?? [];
    const br = m.progression.beginnerRaces;
    expect(rankedRampPermille(rf, br - 1, br)).toBe(1000); // a beginner race is the beginner match's business
    ramp.forEach((v, i) => expect(rankedRampPermille(rf, br + i, br)).toBe(v));
    expect(rankedRampPermille(rf, br + ramp.length, br)).toBe(1000);
    // the ramp starts above the beginner matches' strength and rises (no step back down)
    expect(ramp[0]!).toBeGreaterThan(m.progression.beginnerMatch!.cpuStatPermille);
    for (let i = 1; i < ramp.length; i++) expect(ramp[i]!).toBeGreaterThanOrEqual(ramp[i - 1]!);
  });

  it('rankedMatchRules: class band, class strength, the ramp only while every rider is in it, never in a quarantined pool', () => {
    const br = m.progression.beginnerRaces;
    const lv = rankedCpuLevel(rf, 'C', 3);
    expect(rankedMatchRules(m, match([entry({ rankedRaces: br + 50 })]))).toEqual({ cpuCount: 11, cpuLevel: lv, cpuStatTotal: rankedCpuStatTotal(rf, 'C') });
    const ramp = rankedMatchRules(m, match([entry({ rankedRaces: br })]));
    expect(ramp.cpuStatPermille).toBe(rf.rampCpuStatPermille![0]);
    // a veteran in the match: full strength (the ramp is for a field of new riders)
    expect(rankedMatchRules(m, match([entry({ rankedRaces: br }), entry({ playerId: 'b', rankedRaces: 80 })])).cpuStatPermille).toBeUndefined();
    // an entry queued by an older build (no race count): full strength
    expect(rankedMatchRules(m, match([entry({})])).cpuStatPermille).toBeUndefined();
    // the class of the match is the class of its stat cap (the lowest)
    const mixed = rankedMatchRules(m, match([entry({ classId: 'S', statCap: 4000, rankedRaces: 80 }), entry({ playerId: 'b', classId: 'B', statCap: 3200, rankedRaces: 80 })], { cpuLevel: 5 }));
    expect(mixed.cpuLevel).toBe(rankedCpuLevel(rf, 'B', 5));
    expect(mixed.cpuStatTotal).toBe(rankedCpuStatTotal(rf, 'B'));
    const q = rankedMatchRules(m, match([entry({ rankedRaces: br })], { quarantined: true, cpuLevel: 3 }));
    expect(q).toEqual({ cpuCount: 11, cpuLevel: 3 });
  });

  it('CPU horses race at the class total, their balance kept; the human horse is untouched; events and other modes never', () => {
    const human = { playerId: 'x', horse: partner() };
    const mk = (total?: number) => buildRaceConfig(m, { raceId: 'r', mode: 'ranked', trackId: 'aoba_turf_1600', humans: [human], cpuCount: 11, cpuLevel: 3, statCap: 3200, rng: seededRng(3), ...(total ? { cpuStatTotal: total } : {}) });
    const a = mk(), b = mk(3100);
    for (let i = 0; i < 12; i++) {
      const ea = a.entrants[i]!, eb = b.entrants[i]!;
      if (ea.kind === 'human') { expect(eb.horse).toEqual(ea.horse); continue; }
      const sum = STAT_KEYS.reduce((s, k) => s + eb.horse[k], 0);
      expect(sum).toBeGreaterThan(3100 - STAT_KEYS.length);
      expect(sum).toBeLessThanOrEqual(3100);
      expect(eb.horse.speed).toBe(scaleToTotal(ea.horse, 3100).speed);
    }
    expect(scaleToTotal({ speed: 900, stamina: 900, burst: 900, guts: 900, temper: 900 }, 5000).speed).toBe(1000);
  });

  it('the shipped config and the boot / remote-config check', () => {
    const classes = m.progression.classes.map((c) => c.id);
    expect(rankedFieldProblems(rf, classes)).toEqual([]);
    expect(rf.courseFitsHorses).toBe(true);
    // every class has a band and a strength; both rise (or hold) up the ladder
    const lv = classes.map((c) => rf.cpuLevelByClass![c]!);
    const tot = classes.map((c) => rf.cpuStatTotalByClass![c]!);
    for (let i = 1; i < classes.length; i++) {
      expect(lv[i]!.min).toBeGreaterThanOrEqual(lv[i - 1]!.min);
      expect(tot[i]!).toBeGreaterThanOrEqual(tot[i - 1]!);
    }
    // a class's CPU field is never above the class cap (players at the cap meet an even field at most)
    classes.forEach((c, i) => expect(tot[i]!).toBeLessThanOrEqual(m.progression.classes.find((x) => x.id === c)!.statCap));
    expect(rankedFieldProblems({ courseFitsHorses: 'yes' }, classes)).toEqual(['progression.rankedField.courseFitsHorses must be a boolean']);
    expect(rankedFieldProblems({ courseFitsHorses: true, cpuLevelByClass: { Z: { min: 1, max: 2 }, C: { min: 4, max: 2 } } }, classes)).toHaveLength(2);
    expect(rankedFieldProblems({ courseFitsHorses: true, cpuStatTotalByClass: { C: 99999 } }, classes)).toHaveLength(1);
    expect(rankedFieldProblems({ courseFitsHorses: true, rampCpuStatPermille: [900, 800] }, classes)).toHaveLength(1);
    expect(rankedFieldProblems({ courseFitsHorses: true, extra: 1 }, classes)).toEqual(['progression.rankedField: unknown key extra']);
    expect(() => resolveBundle(m, { progression: { rankedField: { courseFitsHorses: true, rampCpuStatPermille: [1200] } } } as never)).toThrow(/rampCpuStatPermille/);
    expect(resolveBundle(m, { progression: { rankedField: { ...rf, courseFitsHorses: false } } } as never).master.progression.rankedField!.courseFitsHorses).toBe(false);
  });
});

describe('contracts/ranked-fields.sample.json (the fields the C# ranked harness rides)', () => {
  it('is what the server issues (npm run gen:ranked-sample)', async () => {
    expect(readFileSync(join(import.meta.dirname, '../../contracts/ranked-fields.sample.json'), 'utf8')).toBe(await rankedSampleJson(m));
  }, 120_000);

  it('expands back to exactly the configs createRace returns (the compaction loses nothing)', async () => {
    const small = await rankedSample(m, 3);
    const full = JSON.parse(readFileSync(join(import.meta.dirname, '../../contracts/ranked-fields.sample.json'), 'utf8')) as RankedSample;
    expect(full.sets.map((s) => `${s.classId}/${s.horse}/${s.stage}`)).toEqual(small.sets.map((s) => `${s.classId}/${s.horse}/${s.stage}`));
    for (const set of small.sets) {
      for (const r of set.races) {
        const cfg = expandRankedRace(small, r);
        expect(cfg.entrants[r.playerSlot]!.kind).toBe('human');
        // the course always fits the player's horse (REQ-MM-009) and the CPUs race at the class total (REQ-MM-012)
        expect(courseFits(cfg.track, cfg.entrants[r.playerSlot]!.horse)).toBe(true);
      }
    }
    // re-issue every race of the first set through the real path (matchmaker → rankedMatchRules → createRace) and compare whole configs
    for (const [i, r] of small.sets[1]!.races.entries()) {
      const real = await issueRankedSampleRace(m, small.ruleset, 'starter', 'C', 1500, m.progression.beginnerRaces + i, 3 + i, RANKED_SAMPLE_NOW + i * 7 * 3600_000);
      expect(expandRankedRace(small, r)).toEqual(real);
    }
  }, 120_000);
});
