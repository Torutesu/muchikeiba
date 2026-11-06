import { STAT_KEYS, trackById, type Master, type Stats } from './master.js';
import type { HorseInstance } from './player.js';
import { effectiveStats } from './horses.js';
import { normalizeStats } from './season.js';
import { buildRuleset } from './ruleset.js';
import { randInt, randU64Decimal, type Rng } from './rng.js';
import { raceStartConfigSchema, type Entrant, type GoingAptitude, type NetParams, type RaceHorse, type RaceMode, type RaceStartConfig } from './schemas.js';
import type { Ground } from './ground.js';

export const DEFAULT_NET: NetParams = { tickHz: 20, inputDelayTicks: 3, bundleIntervalTicks: 2, checksumIntervalTicks: 20, disconnectGraceMs: 3000 };

export function toRaceHorse(m: Master, h: HorseInstance): RaceHorse {
  return { id: h.id, name: h.name, ...effectiveStats(m, h), style: h.style, distMinM: h.distMinM, distMaxM: h.distMaxM, surface: h.surface, ...aptField(h.goingAptitude) };
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
}

/** REQ-MM-005: builds a validated RaceStartConfig. Seed comes from `rng` (crypto in production). */
export function buildRaceConfig(m: Master, input: BuildRaceInput): RaceStartConfig {
  const total = input.humans.length + input.cpuCount;
  if (total < 1 || total > 12) throw new Error(`entrant count ${total} out of range`);
  const seed = randU64Decimal(input.rng);
  const raw: Omit<Entrant, 'slot'>[] = input.humans.map((h) => ({ kind: 'human' as const, playerId: h.playerId, cpuLevel: h.cpuLevel ?? 3, horse: h.horse }));
  const used = new Set(input.humans.map((h) => h.horse.name));
  const candidates = m.templates.filter((t) => !t.seasonal && !used.has(t.name)); // limited horses never appear as CPU (REQ-BREED-020)
  for (let i = 0; i < input.cpuCount; i++) {
    const t = candidates.splice(randInt(input.rng, candidates.length), 1)[0]!;
    raw.push({ kind: 'cpu', playerId: null, cpuLevel: input.cpuLevel, horse: { id: `cpu_${t.id}`, name: t.name, ...t.stats, style: t.style, distMinM: t.distMinM, distMaxM: t.distMaxM, surface: t.surface, ...aptField(t.goingAptitude) } });
  }
  // random gate draw (Fisher-Yates)
  for (let i = raw.length - 1; i > 0; i--) {
    const j = randInt(input.rng, i + 1);
    [raw[i], raw[j]] = [raw[j]!, raw[i]!];
  }
  const fixed = input.fixedStats ?? null;
  const entrants: Entrant[] = raw.map((e, slot) => ({
    slot, ...e,
    horse: fixed ? withStats(e.horse, fixed) : input.statCap === null ? e.horse : withStats(e.horse, normalizeStats(e.horse, input.statCap)),
  }));
  const config: RaceStartConfig = {
    v: 1, raceId: input.raceId, mode: input.mode, seed,
    track: input.ground ? { ...trackById(m, input.trackId), going: input.ground.going, night: input.ground.night } : trackById(m, input.trackId),
    net: { ...DEFAULT_NET, ...input.net },
    ruleset: buildRuleset(input.rulesetOverrides),
    entrants,
  };
  return raceStartConfigSchema.parse(config);
}
