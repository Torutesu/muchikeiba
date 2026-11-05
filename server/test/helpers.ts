import { loadMaster } from '../src/domain/master.js';
import { buildRaceConfig, toRaceHorse } from '../src/domain/raceConfig.js';
import { seededRng } from '../src/domain/rng.js';
import { newPlayer } from '../src/domain/player.js';
import { createHorseFromTemplate } from '../src/domain/horses.js';
import type { RaceMode } from '../src/domain/schemas.js';

export const m = loadMaster();

export function makeConfig(humans: number, mode: RaceMode = 'ranked', cpu = 12 - humans, seed = 1) {
  const p = newPlayer('tmp', 0, '2026-11');
  const hs = Array.from({ length: humans }, (_, i) => ({ playerId: `p${i}`, horse: toRaceHorse(m, createHorseFromTemplate(p, m.templates[i % m.templates.length]!, 0)) }));
  return buildRaceConfig(m, { raceId: `r_test_${seed}`, mode, trackId: 'kirameki_turf_2000', humans: hs, cpuCount: cpu, cpuLevel: 3, statCap: mode === 'ranked' ? 3200 : null, rng: seededRng(seed) });
}

export function freshPlayer(id = 'p1', now = Date.UTC(2026, 10, 5)) {
  return newPlayer(id, now, '2026-11');
}
