import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULESET, TACTICS_ENGINE_LEVEL, TACTICS_RULESET, TACTICS_RULESET_KEYS, buildRuleset, raceEngineLevel, raceTacticsProblems,
  rulesetForMode, rulesetKeyProblems, tacticsOn, timeAttackRuleset, type RaceTacticsRollout,
} from '../src/domain/ruleset.js';
import { buildRaceConfig, toRaceHorse } from '../src/domain/raceConfig.js';
import { practiceCatalog } from '../src/domain/practice.js';
import { createHorseFromTemplate } from '../src/domain/horses.js';
import { seededRng } from '../src/domain/rng.js';
import { ENGINE_LEVEL, engineMismatch } from '../src/domain/maintenance.js';
import type { Master } from '../src/domain/master.js';
import { freshPlayer, m } from './helpers.js';
import { goldenConfigs } from '../scripts/golden.js';

const repo = (p: string) => join(__dirname, '../..', p);
const NOW = Date.UTC(2026, 10, 12, 3);
const withRollout = (modes: Record<string, boolean>): Master => ({ ...m, progression: { ...m.progression, raceTactics: { ruleset: '1.4.0', modes } } });

describe('ruleset 1.4 tactics (docs/quality/race-play.md, protocol §14.1)', () => {
  it('the key group equals the engine list, is all-or-none, and 1.4.0 = 1.3.0 + the group + the CPU whip rhythm', () => {
    const cs = readFileSync(repo('engine/Muchi.Engine/RulesetParams.cs'), 'utf8');
    const block = cs.slice(cs.indexOf('TacticsIntKeys ='), cs.indexOf('/// <summary>Builds params from a key/value map'));
    expect([...block.matchAll(/"([a-z][A-Za-z0-9]+)"/g)].map((x) => x[1])).toEqual([...TACTICS_RULESET_KEYS]);
    expect(DEFAULT_RULESET.rulesetVersion).toBe('1.3.0');
    expect(TACTICS_RULESET.rulesetVersion).toBe('1.4.0');
    for (const k of TACTICS_RULESET_KEYS) expect(DEFAULT_RULESET).not.toHaveProperty(k);
    const diff = Object.keys(TACTICS_RULESET).filter((k) => k !== 'rulesetVersion' && TACTICS_RULESET[k] !== DEFAULT_RULESET[k]);
    expect(diff.sort()).toEqual([...TACTICS_RULESET_KEYS, 'cpuWhipIntervalTicks'].sort());
    expect(rulesetKeyProblems(TACTICS_RULESET)).toEqual([]);
    expect(rulesetKeyProblems({ ...DEFAULT_RULESET, goWindowPermille: 2500 }).join()).toMatch(/tactics \(1\.4\) keys must be all present or all absent/);
  });

  it('the shipped switch: only practice, never time attack / challenge / tutorial; the rollout check refuses bad values', () => {
    const r = m.progression.raceTactics!;
    expect(r.ruleset).toBe('1.4.0');
    expect(raceTacticsProblems(r)).toEqual([]);
    expect(tacticsOn(r, 'practice')).toBe(true);
    for (const mode of ['ranked', 'friend', 'cup', 'event', 'tournament']) expect(tacticsOn(r, mode)).toBe(false);
    const all = { ruleset: '1.4.0', modes: { ranked: true, timeattack: true, challenge: true, tutorial: true } } as RaceTacticsRollout;
    expect(tacticsOn(all, 'ranked')).toBe(true);
    for (const mode of ['timeattack', 'challenge', 'tutorial']) expect(tacticsOn(all, mode)).toBe(false);
    expect(raceTacticsProblems(all).join()).toMatch(/timeattack cannot be switched on/);
    expect(raceTacticsProblems({ ruleset: '1.5.0', modes: {} }).join()).toMatch(/must be 1\.4\.0/);
    expect(raceTacticsProblems({ ruleset: '1.4.0', modes: { arcade: true } }).join()).toMatch(/unknown mode arcade/);
  });

  it('rulesetForMode: 1.3.0 + the group = exactly 1.4.0; another active ruleset gets a suffixed version; off modes untouched', () => {
    const on = { ruleset: '1.4.0', modes: { friend: true } };
    expect(rulesetForMode(DEFAULT_RULESET, 'friend', on)).toEqual(TACTICS_RULESET);
    expect(rulesetForMode(DEFAULT_RULESET, 'ranked', on)).toBe(DEFAULT_RULESET);
    const tuned = buildRuleset({ maxWhips: 5, rulesetVersion: '1.3.1' });
    const t = rulesetForMode(tuned, 'friend', on);
    expect(t.rulesetVersion).toBe('1.3.1+t1.4');
    expect(t.maxWhips).toBe(5);
    expect(t.goLinePermille).toBe(TACTICS_RULESET.goLinePermille);
    expect(rulesetForMode(TACTICS_RULESET, 'friend', on)).toBe(TACTICS_RULESET);
    // time attack's own ruleset is never switched
    expect(rulesetForMode(timeAttackRuleset(), 'timeattack', { ruleset: '1.4.0', modes: { timeattack: true } })).toEqual(timeAttackRuleset());
  });

  it('buildRaceConfig carries 1.4.0 for a switched mode and 1.3.0 otherwise (ranked fairness: stats still capped)', () => {
    const s = freshPlayer('p1');
    const h = createHorseFromTemplate(s, m.templates[0]!, 0);
    const base = { raceId: 'r', trackId: 'kirameki_turf_2000', humans: [{ playerId: 'p1', horse: toRaceHorse(m, h) }], cpuCount: 5, cpuLevel: 3, rng: seededRng(1) };
    const ranked14 = buildRaceConfig(withRollout({ ranked: true }), { ...base, mode: 'ranked', statCap: 3200 });
    expect(ranked14.ruleset.rulesetVersion).toBe('1.4.0');
    for (const e of ranked14.entrants) expect(Object.values({ s: e.horse.speed, st: e.horse.stamina, b: e.horse.burst, g: e.horse.guts, t: e.horse.temper }).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(3200);
    expect(buildRaceConfig(m, { ...base, mode: 'ranked', statCap: 3200 }).ruleset.rulesetVersion).toBe('1.3.0');
    expect(buildRaceConfig(withRollout({ ranked: true }), { ...base, mode: 'timeattack', statCap: 3200, cpuCount: 0, rulesetOverrides: timeAttackRuleset() }).ruleset.rulesetVersion).toBe('1.3.0+ta');
  });

  it('practice gets 1.4 only for an app whose engine knows it; a 1.4 race needs engine level 2 at the room', () => {
    const s = freshPlayer('p1');
    expect(practiceCatalog(m, s, NOW).ruleset.rulesetVersion).toBe('1.4.0');
    expect(practiceCatalog(m, s, NOW, DEFAULT_RULESET, null).ruleset.rulesetVersion).toBe('1.3.0');
    expect(practiceCatalog(m, s, NOW, DEFAULT_RULESET, 1).ruleset.rulesetVersion).toBe('1.3.0');
    expect(practiceCatalog(m, s, NOW, DEFAULT_RULESET, TACTICS_ENGINE_LEVEL).ruleset.rulesetVersion).toBe('1.4.0');
    expect(raceEngineLevel(DEFAULT_RULESET, ENGINE_LEVEL)).toBe(ENGINE_LEVEL);
    expect(raceEngineLevel(TACTICS_RULESET, ENGINE_LEVEL)).toBe(TACTICS_ENGINE_LEVEL);
    expect(engineMismatch(1, raceEngineLevel(TACTICS_RULESET))).toBe(true);
    expect(engineMismatch(2, raceEngineLevel(TACTICS_RULESET))).toBe(false);
    expect(engineMismatch(undefined, raceEngineLevel(TACTICS_RULESET))).toBe(false); // bots / verifier / pre-§46 apps as before
    const cs = readFileSync(repo('engine/Muchi.Net/EngineInfo.cs'), 'utf8');
    expect(Number(/public const int Level = (\d+);/.exec(cs)![1])).toBe(TACTICS_ENGINE_LEVEL);
  });

  it('the 1.3 TS goldens stay on 1.3.0 and the new friend golden is 1.4.0', () => {
    const g = goldenConfigs();
    expect(g['ts-config-friend.json']!.ruleset.rulesetVersion).toBe('1.3.0');
    expect(g['ts-config-ranked.json']!.ruleset.rulesetVersion).toBe('1.3.0');
    expect(g['ts-config-friend-tactics.json']!.ruleset.rulesetVersion).toBe('1.4.0');
  });
});
