import { STAT_KEYS, trackById, type Master, type Stats } from './master.js';
import type { HorseInstance } from './player.js';
import { raceStats } from './training.js';
import { normalizeStats } from './season.js';
import { buildRuleset, rulesetForMode } from './ruleset.js';
import { randInt, randU64Decimal, type Rng } from './rng.js';
import { raceStartConfigSchema, type Entrant, type GoingAptitude, type NetParams, type RaceHorse, type RaceMode, type RaceStartConfig } from './schemas.js';
import type { Ground } from './ground.js';
import { capSkill, horseSkill, rulesetSkillCaps, templateSkill, toRaceSkill, type SkillDef } from './skills.js';

export const DEFAULT_NET: NetParams = { tickHz: 20, inputDelayTicks: 3, bundleIntervalTicks: 2, checksumIntervalTicks: 20, disconnectGraceMs: 3000 };

/** REQ-TRAIN-003: base + awakening + training growth; ranked/tournament/time attack normalise it to the class cap below. */
export function toRaceHorse(m: Master, h: HorseInstance): RaceHorse {
  return { id: h.id, name: h.name, ...raceStats(m, h), style: h.style, distMinM: h.distMinM, distMaxM: h.distMaxM, surface: h.surface, ...aptField(h.goingAptitude), ...skillField(horseSkill(m, h)) };
}

/** REQ-UXS-050: the horse's unique skill as the master defines it (buildRaceConfig caps it for the race). Absent = none. */
function skillField(d: SkillDef | null): { skill?: RaceHorse['skill'] } {
  return d ? { skill: toRaceSkill(d) } : {};
}

/** goingAptitude is only sent when it is not "any" (absent = any; keeps configs of plain horses unchanged). */
function aptField(a: GoingAptitude | undefined): { goingAptitude?: GoingAptitude } {
  return a && a !== 'any' ? { goingAptitude: a } : {};
}

function withStats(h: RaceHorse, st: Stats): RaceHorse {
  const out = { ...h };
  for (const k of STAT_KEYS) out[k] = st[k];
  return out;
}

export interface HumanEntry { playerId: string; horse: RaceHorse; cpuLevel?: number }

export interface BuildRaceInput {
  raceId: string;
  mode: RaceMode;
  trackId: string;
  humans: HumanEntry[];
  cpuCount: number;
  cpuLevel: number;
  /** Ranked: class stat cap applied to every entrant (REQ-RATE-003). */
  statCap: number | null;
  rng: Rng;
  net?: Partial<NetParams>;
  rulesetOverrides?: Record<string, string | number>;
  /** REQ-RACE-034/036: ground and lighting; omitted = no fields sent (good ground by day). */
  ground?: Ground | null;
  /** REQ-EVENT-003: every entrant (players and CPU) races with exactly these stats. */
  fixedStats?: Stats | null;
  /**
   * REQ-UXS-003: beginner matches scale CPU stats by this permille (after the class normalization), so a new
   * player on the partner horse finishes top 3 about 70% of the time (balance target R10). Absent/1000 = unchanged.
   */
  cpuStatPermille?: number;
  /**
   * REQ-MM-011 (ranked, progression.rankedField.cpuStatTotalByClass): every CPU horse is scaled (up or down) to this stat
   * total after the class normalization, keeping its balance between stats (each ≤ 1000); cpuStatPermille applies after.
   * Absent = the template's stats (capped), as before.
   */
  cpuStatTotal?: number | null;
  /**
   * REQ-CAREER-004 (§66): the CPU field is drawn only from templates of these running styles (a 騎手の道 race such as
   * 「前が速い」). Absent = every eligible template (the draw and every existing config are unchanged).
   */
  cpuStyles?: readonly string[];
}

/**
 * REQ-UXS-050 (docs/planning/06 §7.1): which skill an entrant races with. None in time attack (a pure riding test whose medals
 * come from skill-less runs), the tutorial, events with fixed stats (every runner identical) or a ruleset without the skill
 * keys (the engine would ignore it). Races that normalise stats (ranked, tournaments, capped events) cap every effect at
 * `rankedCaps`, like the stat normalisation; every race caps at the ruleset's `skillMax*`.
 */
function raceSkill(m: Master, input: BuildRaceInput, ruleset: Record<string, unknown>, s: RaceHorse['skill']): RaceHorse['skill'] | undefined {
  const caps = rulesetSkillCaps(ruleset);
  // REQ-WCH-007: weekly challenges are a riding test on normalised stats too (no skills: a bought horse's skill cannot help)
  if (!s || !caps || input.mode === 'timeattack' || input.mode === 'challenge' || input.mode === 'tutorial' || input.fixedStats) return undefined;
  const capped = capSkill(s, caps);
  return input.statCap === null ? capped : capSkill(capped, m.skills.rankedCaps);
}

function withSkill(h: RaceHorse, s: RaceHorse['skill'] | undefined): RaceHorse {
  const { skill: _drop, ...rest } = h;
  return s ? { ...rest, skill: s } : rest;
}

/** REQ-MM-011: `h`'s stats scaled to `total` (floor per stat, each ≤ 1000; the balance between stats kept). */
export function scaleToTotal(h: Stats, total: number): Stats {
  const cur = STAT_KEYS.reduce((a, k) => a + h[k], 0);
  const out = {} as Stats;
  for (const k of STAT_KEYS) out[k] = cur > 0 ? Math.min(1000, Math.floor((h[k] * total) / cur)) : 0;
  return out;
}

/** REQ-MM-005: builds a validated RaceStartConfig. Seed comes from `rng` (crypto in production). */
export function buildRaceConfig(m: Master, input: BuildRaceInput): RaceStartConfig {
  const total = input.humans.length + input.cpuCount;
  if (total < 1 || total > 12) throw new Error(`entrant count ${total} out of range`);
  const seed = randU64Decimal(input.rng);
  const raw: Omit<Entrant, 'slot'>[] = input.humans.map((h) => ({ kind: 'human' as const, playerId: h.playerId, cpuLevel: h.cpuLevel ?? 3, horse: h.horse }));
  const used = new Set(input.humans.map((h) => h.horse.name));
  // limited horses (REQ-BREED-020) and gift-only horses (REQ-UXS-002) never appear as CPU
  const candidates = m.templates.filter((t) => !t.seasonal && !t.giftOnly && !used.has(t.name) && (!input.cpuStyles || input.cpuStyles.includes(t.style)));
  if (candidates.length < input.cpuCount) throw new Error(`only ${candidates.length} CPU horses for ${input.cpuCount} places`);
  for (let i = 0; i < input.cpuCount; i++) {
    const t = candidates.splice(randInt(input.rng, candidates.length), 1)[0]!;
    // CPU horses race with their template's skill: deterministic, no draw (REQ-UXS-050)
    raw.push({ kind: 'cpu', playerId: null, cpuLevel: input.cpuLevel, horse: { id: `cpu_${t.id}`, name: t.name, ...t.stats, style: t.style, distMinM: t.distMinM, distMaxM: t.distMaxM, surface: t.surface, ...aptField(t.goingAptitude), ...skillField(templateSkill(m, t)) } });
  }
  // random gate draw (Fisher-Yates)
  for (let i = raw.length - 1; i > 0; i--) {
    const j = randInt(input.rng, i + 1);
    [raw[i], raw[j]] = [raw[j]!, raw[i]!];
  }
  const fixed = input.fixedStats ?? null;
  const cpuPm = input.cpuStatPermille ?? 1000;
  const scale = (h: RaceHorse): RaceHorse => {
    const out = { ...h };
    for (const k of STAT_KEYS) out[k] = Math.floor((h[k] * cpuPm) / 1000);
    return out;
  };
  // ruleset 1.4 rollout (progression.raceTactics): the tactics group for the modes switched on (time attack / challenge / tutorial never)
  const ruleset = rulesetForMode(buildRuleset(input.rulesetOverrides), input.mode, m.progression.raceTactics);
  const entrants: Entrant[] = raw.map((e, slot) => {
    const horse = fixed ? withStats(e.horse, fixed) : input.statCap === null ? e.horse : withStats(e.horse, normalizeStats(e.horse, input.statCap));
    // REQ-UXS-003: weaker CPUs in the beginner match (stats only; skills are capped like every runner's, REQ-UXS-050)
    const sized = e.kind === 'cpu' && input.cpuStatTotal && !fixed ? withStats(horse, scaleToTotal(horse, input.cpuStatTotal)) : horse;
    const scaled = e.kind === 'cpu' && cpuPm !== 1000 && !fixed ? scale(sized) : sized;
    return { slot, ...e, horse: withSkill(scaled, raceSkill(m, input, ruleset, e.horse.skill)) };
  });
  const config: RaceStartConfig = {
    v: 1, raceId: input.raceId, mode: input.mode, seed,
    track: input.ground ? { ...trackById(m, input.trackId), going: input.ground.going, night: input.ground.night } : trackById(m, input.trackId),
    net: { ...DEFAULT_NET, ...input.net },
    ruleset,
    entrants,
  };
  return raceStartConfigSchema.parse(config);
}
