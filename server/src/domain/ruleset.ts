import defaultRulesetJson from '../../../contracts/ruleset-params.default.json';
import { AppError } from './errors.js';

/**
 * The ruleset is opaque to the server except `rulesetVersion` and `maxTicks`
 * (contracts/protocol.md §2). The key set is defined by contracts/ruleset-params.default.json.
 */
export type Ruleset = { rulesetVersion: string; maxTicks: number } & Record<string, string | number>;

export const DEFAULT_RULESET: Ruleset = Object.freeze({ ...(defaultRulesetJson as unknown as Ruleset) });

export function rulesetKeyProblems(candidate: Record<string, unknown>, reference: Record<string, unknown> = DEFAULT_RULESET): string[] {
  const problems: string[] = [];
  const refKeys = new Set(Object.keys(reference));
  const keys = new Set(Object.keys(candidate));
  for (const k of refKeys) if (!keys.has(k)) problems.push(`missing key: ${k}`);
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
