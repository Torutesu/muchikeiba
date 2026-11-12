import defaultRulesetJson from '../../../contracts/ruleset-params.default.json';
import tacticsRulesetJson from '../../../contracts/ruleset-params.1.4.0.json';
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

/**
 * Fourth optional group, added by ruleset 1.3 (固有スキル, docs/planning/06-ux-experience-spec.md §7.1): ceilings for every
 * skill effect. Absent in 1.2.x and older rulesets, where a horse's skill is ignored by the engine (old replays verify).
 * All or none. Must equal RulesetParams.SkillIntKeys (checked by a test).
 */
export const SKILL_RULESET_KEYS: readonly string[] = [
  'skillMaxSpeedPermille', 'skillMaxAccelPermille', 'skillMaxDrainSavePermille', 'skillMaxRecoverPermille', 'skillMaxDurationTicks',
];

/**
 * Fifth optional group, added by ruleset 1.4 (docs/quality/race-play.md): tactics — the spurt is the rider's 仕掛け (hold the
 * whip to gather, release to go: 一閃), 会心 whips on the rhythm, the slingshot out of a slipstream. Absent in 1.3 and older
 * (the default ruleset stays 1.3.0 until the rollout, `progression.raceTactics`). All or none. Must equal
 * RulesetParams.TacticsIntKeys (checked by a test). In 1.4, START (bit 0) after departure means WHIP_RELEASE (protocol §3).
 */
export const TACTICS_RULESET_KEYS: readonly string[] = [
  'goWindowPermille', 'autoGoPermille', 'gatherSpeedPermille', 'gatherDrainPermille', 'gatherMaxTicks',
  'kickSpeedBonusMmPerSec', 'kickAccelBonusMmPerSec2', 'kickTicks', 'rhythmFromTicks', 'rhythmToTicks', 'rhythmBonusPermille',
  'slingshotMinSlipTicks', 'slingshotSpeedBonusMmPerSec', 'slingshotAccelBonusMmPerSec2', 'slingshotTicks', 'goLinePermille', 'cpuTacticsMinLevel',
  'longSpurtBonusPermille',
];

/** Ruleset 1.4.0 (contracts/ruleset-params.1.4.0.json): 1.3.0 plus the tactics group and the CPU whip rhythm. Verifier first (docs/ops/deploy.md). */
export const TACTICS_RULESET: Ruleset = Object.freeze({ ...(tacticsRulesetJson as unknown as Ruleset) });

const OPTIONAL_GROUPS: { keys: readonly string[]; label: string }[] = [
  { keys: OPTIONAL_RULESET_KEYS, label: 'ground-condition' },
  { keys: BALANCE_RULESET_KEYS, label: 'balance (1.1)' },
  { keys: DISTANCE_RULESET_KEYS, label: 'distance (1.2)' },
  { keys: SKILL_RULESET_KEYS, label: 'skill (1.3)' },
  { keys: TACTICS_RULESET_KEYS, label: 'tactics (1.4)' },
];

export function rulesetKeyProblems(candidate: Record<string, unknown>, reference: Record<string, unknown> = DEFAULT_RULESET): string[] {
  const problems: string[] = [];
  // a group absent from the reference (1.4 tactics while the default is 1.3) is still a known group: all or none
  const refKeys = new Set([...Object.keys(reference), ...OPTIONAL_GROUPS.flatMap((g) => g.keys)]);
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

/** Ruleset 1.4 rollout switch per mode (`progression.raceTactics`, docs/ops/deploy.md: verifier first, then modes one by one). */
export interface RaceTacticsRollout {
  /** The tactics ruleset version the switch turns on (only "1.4.0" exists). */
  ruleset: string;
  /** Mode → on. `practice` = device practice races (§50), `career` = §66 career races when that mode exists; absent = off. */
  modes: Partial<Record<string, boolean>>;
}

export const TACTICS_MODES = ['ranked', 'friend', 'cup', 'event', 'tournament', 'practice', 'career', 'timeattack', 'challenge', 'tutorial'] as const;

/** Remote-config / boot check of `progression.raceTactics`: the one tactics version, known modes, booleans. */
export function raceTacticsProblems(r: unknown): string[] {
  if (r === undefined) return [];
  const o = r as Partial<RaceTacticsRollout> | null;
  if (!o || typeof o !== 'object') return ['progression.raceTactics must be an object'];
  const p: string[] = [];
  if (o.ruleset !== TACTICS_RULESET.rulesetVersion) p.push(`progression.raceTactics.ruleset must be ${TACTICS_RULESET.rulesetVersion}`);
  if (!o.modes || typeof o.modes !== 'object') p.push('progression.raceTactics.modes must be an object');
  else for (const [k, v] of Object.entries(o.modes)) {
    if (!(TACTICS_MODES as readonly string[]).includes(k)) p.push(`progression.raceTactics.modes: unknown mode ${k}`);
    else if (typeof v !== 'boolean') p.push(`progression.raceTactics.modes.${k} must be a boolean`);
    else if (v && (k === 'timeattack' || k === 'challenge' || k === 'tutorial')) p.push(`progression.raceTactics.modes.${k} cannot be switched on (medals, ghosts, FTUE)`);
  }
  return p;
}

/** Is the 1.4 tactics ruleset switched on for this mode? Time attack, weekly challenges and the tutorial never (medals, ghosts, FTUE). */
export function tacticsOn(rollout: RaceTacticsRollout | undefined, mode: string): boolean {
  if (!rollout || mode === 'timeattack' || mode === 'challenge' || mode === 'tutorial') return false;
  return rollout.modes?.[mode] === true;
}

/**
 * The ruleset a race of `mode` runs on: `base` (the active ruleset) unless the rollout switches tactics on for the mode. Then
 * the tactics group (and the 1.4 CPU whip rhythm) is added: on the shipped 1.3.0 base the result is exactly 1.4.0; on any other
 * base the version is suffixed (`<base>+t1.4`, like `+ta`) so a version always names one set of values. A base that already
 * has the tactics keys is returned as it is.
 */
export function rulesetForMode(base: Ruleset, mode: string, rollout: RaceTacticsRollout | undefined): Ruleset {
  if (!tacticsOn(rollout, mode) || TACTICS_RULESET_KEYS.every((k) => k in base)) return base;
  if (rollout!.ruleset !== TACTICS_RULESET.rulesetVersion) throw new AppError('CONFIG_INVALID', `raceTactics.ruleset ${rollout!.ruleset} is not ${TACTICS_RULESET.rulesetVersion}`);
  const extra: Record<string, string | number> = { cpuWhipIntervalTicks: TACTICS_RULESET.cpuWhipIntervalTicks! };
  for (const k of TACTICS_RULESET_KEYS) extra[k] = TACTICS_RULESET[k]!;
  const shipped = base.rulesetVersion === DEFAULT_RULESET.rulesetVersion && canonical(base) === canonical(DEFAULT_RULESET);
  return buildRuleset({ ...base, ...extra, rulesetVersion: shipped ? TACTICS_RULESET.rulesetVersion : `${base.rulesetVersion}+t1.4` });
}

const canonical = (r: Record<string, unknown>): string => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]]));

/** Engine level (§46.4) that knows ruleset 1.4 (C# Muchi.Net.EngineInfo.Level 2). */
export const TACTICS_ENGINE_LEVEL = 2;

/**
 * The engine level a race on `ruleset` needs (§46.4): an app below it is refused at the room (VERSION_MISMATCH, close 4026)
 * instead of racing a ruleset it cannot simulate. 1.4 tactics → TACTICS_ENGINE_LEVEL; older rulesets → `base` (ENGINE_LEVEL).
 */
export function raceEngineLevel(ruleset: Record<string, unknown>, base = 1): number {
  return TACTICS_RULESET_KEYS.some((k) => k in ruleset) ? Math.max(base, TACTICS_ENGINE_LEVEL) : base;
}
