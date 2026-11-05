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

export function rulesetKeyProblems(candidate: Record<string, unknown>, reference: Record<string, unknown> = DEFAULT_RULESET): string[] {
  const problems: string[] = [];
  const refKeys = new Set(Object.keys(reference));
  const keys = new Set(Object.keys(candidate));
  const optional = new Set(OPTIONAL_RULESET_KEYS);
  const optionalPresent = OPTIONAL_RULESET_KEYS.filter((k) => keys.has(k)).length;
  if (optionalPresent !== 0 && optionalPresent !== OPTIONAL_RULESET_KEYS.length) problems.push('ground-condition keys must be all present or all absent');
  for (const k of refKeys) if (!keys.has(k) && !(optional.has(k) && optionalPresent === 0)) problems.push(`missing key: ${k}`);
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

/** Validates and returns a ruleset; overrides (Remote Config) may change values but never the key set. */
export function buildRuleset(overrides: Record<string, string | number> = {}): Ruleset {
  const merged = { ...DEFAULT_RULESET, ...overrides } as Ruleset;
  const problems = rulesetKeyProblems(merged);
  if (problems.length) throw new AppError('CONFIG_INVALID', `ruleset invalid: ${problems.join('; ')}`);
  return merged;
}
