import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RULESET, buildRuleset, rulesetKeyProblems } from '../src/domain/ruleset.js';
import { raceStartConfigSchema, replayLogSchema, verifierOutputSchema } from '../src/domain/schemas.js';
import { normalizeStats } from '../src/domain/season.js';
import { STAT_KEYS } from '../src/domain/master.js';
import { makeConfig, m } from './helpers.js';
import { goldenConfigs } from '../scripts/golden.js';

const GOLDEN = join(__dirname, '../../contracts/golden');

describe('ruleset (contracts/ruleset-params.default.json)', () => {
  it('default file is valid and exposes the server-read keys', () => {
    expect(rulesetKeyProblems(DEFAULT_RULESET)).toEqual([]);
    expect(typeof DEFAULT_RULESET.rulesetVersion).toBe('string');
    expect(Number.isInteger(DEFAULT_RULESET.maxTicks)).toBe(true);
  });
  it('rejects missing, unknown and non-integer keys', () => {
    const { maxTicks: _m, ...missing } = DEFAULT_RULESET;
    expect(rulesetKeyProblems(missing)).toContain('missing key: maxTicks');
    expect(rulesetKeyProblems({ ...DEFAULT_RULESET, extra: 1 })).toContain('unknown key: extra');
    expect(rulesetKeyProblems({ ...DEFAULT_RULESET, maxTicks: 1.5 })).toContain('maxTicks must be a 32-bit integer');
    expect(() => buildRuleset({ nope: 1 })).toThrow(/unknown key/);
    expect(buildRuleset({ maxTicks: 4000 }).maxTicks).toBe(4000);
  });
});

describe('master data', () => {
  it('tracks: 5 turf and 3 dirt courses (3 overseas-style venues, REQ-TRACK-001) whose segments sum to the distance', () => {
    expect(m.tracks.filter((t) => t.surface === 'turf')).toHaveLength(5);
    expect(m.tracks.filter((t) => t.surface === 'dirt')).toHaveLength(3);
    for (const t of m.tracks) expect(t.segments.reduce((a, s) => a + s.lengthM, 0)).toBe(t.distanceM);
  });
});

describe('race config builder (REQ-MM-005)', () => {
  it('builds a schema-valid config with a uint64 seed and contiguous slots', () => {
    const c = makeConfig(4);
    expect(c.entrants).toHaveLength(12);
    expect(c.entrants.map((e) => e.slot)).toEqual([...Array(12).keys()]);
    expect(BigInt(c.seed) < 1n << 64n).toBe(true);
    expect(c.entrants.filter((e) => e.kind === 'human')).toHaveLength(4);
    expect(new Set(c.entrants.map((e) => e.horse.name)).size).toBe(12);
  });
  it('is deterministic for a given rng and varies with it', () => {
    expect(makeConfig(3, 'ranked', 9, 5)).toEqual(makeConfig(3, 'ranked', 9, 5));
    expect(makeConfig(3, 'ranked', 9, 5).seed).not.toBe(makeConfig(3, 'ranked', 9, 6).seed);
  });
  it('applies the class stat cap to every entrant in ranked (REQ-RATE-003)', () => {
    const c = makeConfig(4, 'ranked');
    for (const e of c.entrants) expect(STAT_KEYS.reduce((a, k) => a + e.horse[k], 0)).toBeLessThanOrEqual(3200);
    const f = makeConfig(4, 'friend');
    expect(f.entrants.some((e) => STAT_KEYS.reduce((a, k) => a + e.horse[k], 0) > 3200)).toBe(true);
  });
  it('normalization keeps proportions and does nothing under the cap', () => {
    const s = { speed: 900, stamina: 800, burst: 900, guts: 700, temper: 700 };
    const n = normalizeStats(s, 2000);
    expect(STAT_KEYS.reduce((a, k) => a + n[k], 0)).toBeLessThanOrEqual(2000);
    expect(n.speed).toBe(Math.floor((900 * 2000) / 4000));
    expect(normalizeStats(s, 5000)).toEqual(s);
  });
  it('schema rejects broken configs', () => {
    const c = makeConfig(2);
    expect(raceStartConfigSchema.safeParse({ ...c, track: { ...c.track, distanceM: c.track.distanceM + 1 } }).success).toBe(false);
    expect(raceStartConfigSchema.safeParse({ ...c, entrants: c.entrants.slice(1) }).success).toBe(false);
    expect(raceStartConfigSchema.safeParse({ ...c, seed: '18446744073709551616' }).success).toBe(false);
    expect(raceStartConfigSchema.safeParse({ ...c, ruleset: { ...c.ruleset, foo: 1 } }).success).toBe(false);
  });
});

describe('golden files (contracts/golden)', () => {
  it('ts-config-*.json are exactly what the builder produces', () => {
    for (const [file, cfg] of Object.entries(goldenConfigs())) {
      const p = join(GOLDEN, file);
      expect(existsSync(p), `${file} missing — run npm run gen:golden`).toBe(true);
      expect(JSON.parse(readFileSync(p, 'utf8')), `${file} is stale (ruleset or master changed) — run npm run gen:golden`).toEqual(cfg);
    }
  });
  it('C# race-*.json goldens (if present) satisfy the TS schemas', () => {
    const files = existsSync(GOLDEN) ? readdirSync(GOLDEN).filter((f) => /^race-.*\.json$/.test(f)) : [];
    for (const f of files) {
      const g = JSON.parse(readFileSync(join(GOLDEN, f), 'utf8'));
      const log = replayLogSchema.safeParse(g.log);
      expect(log.success, `${f}: ${JSON.stringify(log.error?.issues.slice(0, 3))}`).toBe(true);
      const exp = verifierOutputSchema.safeParse(g.expected);
      expect(exp.success, `${f}: ${JSON.stringify(exp.error?.issues.slice(0, 3))}`).toBe(true);
    }
  });
});
