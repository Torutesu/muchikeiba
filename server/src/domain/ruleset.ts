import defaultRulesetJson from '../../../contracts/ruleset-params.default.json';
import { AppError } from './errors.js';

/**
 * The ruleset is opaque to the server except `rulesetVersion` and `maxTicks`
 * (contracts/protocol.md §2). The key set is defined by contracts/ruleset-params.default.json.
 */
export type Ruleset = { rulesetVersion: string; maxTicks: number } & Record<string, string | number>;

export const DEFAULT_RULESET: Ruleset = Object.freeze({ ...(defaultRulesetJson as unknown as Ruleset) });

/**
 * Keys added after the first ruleset (ground conditions, REQ-RACE-034/035). Replays stored before they existed
 * omit all of them; the engine then uses neutral values that reproduce the old results. All or none.
 * Must equal RulesetParams.OptionalIntKeys in engine/Muchi.Engine (checked by a test).
 */
export const OPTIONAL_RULESET_KEYS: readonly string[] = [
  'goingTurfFirmSpeedPermille', 'goingTurfGoodSpeedPermille', 'goingTurfYieldingSpeedPermille', 'goingTurfSoftSpeedPermille',
  'goingDirtFastSpeedPermille', 'goingDirtGoodSpeedPermille', 'goingDirtMuddySpeedPermille', 'goingDirtSloppySpeedPermille',
  'goingTurfFirmDrainPermille', 'goingTurfGoodDrainPermille', 'goingTurfYieldingDrainPermille', 'goingTurfSoftDrainPermille',
  'goingDirtFastDrainPermille', 'goingDirtGoodDrainPermille', 'goingDirtMuddyDrainPermille', 'goingDirtSloppyDrainPermille',
  'dirtSpeedPermille', 'goingSpecialistPermille',
];

/**
 * Second optional group, added by ruleset 1.1 (docs/spec/balance-targets.md): form variance, CPU level habits and
 * the jockey auto-steer. Absent in 1.0.x rulesets (stored replays/ghosts), which then keep their old behaviour.
 * All or none; independent of the ground group. Must equal RulesetParams.BalanceIntKeys (checked by a test).
 */
export const BALANCE_RULESET_KEYS: readonly string[] = [
  'conditionVariancePermille', 'cpuStaminaReinMinLevel', 'cpuRailMinLevel', 'autoRailIntervalTicks', 'autoRailHoldTicks', 'cpuSloppyMaxLevel',
];

/**
 * Third optional group, added by ruleset 1.2 (docs/spec/balance-targets.md §2): the stamina pool and spurt zone scale
 * with the race distance, so a course's length no longer decides which running style wins. Absent in 1.1.x and older
 * rulesets (nothing scales). All or none. Must equal RulesetParams.DistanceIntKeys (checked by a test).
 */
export const DISTANCE_RULESET_KEYS: readonly string[] = [
  'distanceRefM', 'distanceRefDirtM', 'staminaDistanceScalePermille', 'spurtDistanceScalePermille',
];

const OPTIONAL_GROUPS: { keys: readonly string[]; label: string }[] = [
  { keys: OPTIONAL_RULESET_KEYS, label: 'ground-condition' },
  { keys: BALANCE_RULESET_KEYS, label: 'balance (1.1)' },
  { keys: DISTANCE_RULESET_KEYS, label: 'distance (1.2)' },
];

export function rulesetKeyProblems(candidate: Record<string, unknown>, reference: Record<string, unknown> = DEFAULT_RULESET): string[] {
  const problems: string[] = [];
  const refKeys = new Set(Object.keys(reference));
  const keys = new Set(Object.keys(candidate));
  const absentGroup = new Set<string>();
  for (const g of OPTIONAL_GROUPS) {
    const present = g.keys.filter((k) => keys.has(k)).length;
    if (present !== 0 && present !== g.keys.length) problems.push(`${g.label} keys must be all present or all absent`);
    if (present === 0) for (const k of g.keys) absentGroup.add(k);
  }
  for (const k of refKeys) if (!keys.has(k) && !absentGroup.has(k)) problems.push(`missing key: ${k}`);
  for (const k of keys) if (!refKeys.has(k)) problems.push(`unknown key: ${k}`);
  for (const [k, v] of Object.entries(candidate)) {
    if (k === 'rulesetVersion') {
      if (typeof v !== 'string' || v.length === 0) problems.push('rulesetVersion must be a non-empty string');
    } else if (typeof v !== 'number' || !Number.isInteger(v) || Math.abs(v) > 0x7fffffff) {
      problems.push(`${k} must be a 32-bit integer`);
    }
  }
  return problems;
}

/**
 * Time attack is pure skill: the day's form (conditionVariancePermille, ruleset 1.1) is switched off so a best time
 * never depends on rerolling sessions for good form. The version is suffixed like event rulesets (`+ta`).
 */
export function timeAttackRuleset(base: Ruleset = DEFAULT_RULESET): Ruleset {
  if (!('conditionVariancePermille' in base) || Number(base.conditionVariancePermille) === 0) return base;
  return buildRuleset({ ...base, conditionVariancePermille: 0, rulesetVersion: `${base.rulesetVersion}+ta` });
}

/** Validates and returns a ruleset; overrides (Remote Config) may change values but never the key set. */
export function buildRuleset(overrides: Record<string, string | number> = {}): Ruleset {
  const merged = { ...DEFAULT_RULESET, ...overrides } as Ruleset;
  const problems = rulesetKeyProblems(merged);
  if (problems.length) throw new AppError('CONFIG_INVALID', `ruleset invalid: ${problems.join('; ')}`);
  return merged;
}
