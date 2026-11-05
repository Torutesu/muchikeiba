import { STAT_KEYS, trackById, type Master, type Stats } from './master.js';
import type { HorseInstance } from './player.js';
import { effectiveStats } from './horses.js';
import { normalizeStats } from './season.js';
import { buildRuleset } from './ruleset.js';
import { randInt, randU64Decimal, type Rng } from './rng.js';
import { raceStartConfigSchema, type Entrant, type NetParams, type RaceHorse, type RaceMode, type RaceStartConfig } from './schemas.js';

export const DEFAULT_NET: NetParams = { tickHz: 20, inputDelayTicks: 3, bundleIntervalTicks: 2, checksumIntervalTicks: 20, disconnectGraceMs: 3000 };

export function toRaceHorse(m: Master, h: HorseInstance): RaceHorse {
  return { id: h.id, name: h.name, ...effectiveStats(m, h), style: h.style, distMinM: h.distMinM, distMaxM: h.distMaxM, surface: h.surface };
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
}

/** REQ-MM-005: builds a validated RaceStartConfig. Seed comes from `rng` (crypto in production). */
export function buildRaceConfig(m: Master, input: BuildRaceInput): RaceStartConfig {
  const total = input.humans.length + input.cpuCount;
  if (total < 1 || total > 12) throw new Error(`entrant count ${total} out of range`);
  const seed = randU64Decimal(input.rng);
  const raw: Omit<Entrant, 'slot'>[] = input.humans.map((h) => ({ kind: 'human' as const, playerId: h.playerId, cpuLevel: h.cpuLevel ?? 3, horse: h.horse }));
  const used = new Set(input.humans.map((h) => h.horse.name));
  const candidates = m.templates.filter((t) => !used.has(t.name));
  for (let i = 0; i < input.cpuCount; i++) {
    const t = candidates.splice(randInt(input.rng, candidates.length), 1)[0]!;
    raw.push({ kind: 'cpu', playerId: null, cpuLevel: input.cpuLevel, horse: { id: `cpu_${t.id}`, name: t.name, ...t.stats, style: t.style, distMinM: t.distMinM, distMaxM: t.distMaxM, surface: t.surface } });
  }
  // random gate draw (Fisher-Yates)
  for (let i = raw.length - 1; i > 0; i--) {
    const j = randInt(input.rng, i + 1);
    [raw[i], raw[j]] = [raw[j]!, raw[i]!];
  }
  const entrants: Entrant[] = raw.map((e, slot) => ({ slot, ...e, horse: input.statCap === null ? e.horse : withStats(e.horse, normalizeStats(e.horse, input.statCap)) }));
  const config: RaceStartConfig = {
    v: 1, raceId: input.raceId, mode: input.mode, seed,
    track: trackById(m, input.trackId),
    net: { ...DEFAULT_NET, ...input.net },
    ruleset: buildRuleset(input.rulesetOverrides),
    entrants,
  };
  return raceStartConfigSchema.parse(config);
}
