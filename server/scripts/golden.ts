import { loadMaster } from '../src/domain/master.js';
import { buildRaceConfig, toRaceHorse } from '../src/domain/raceConfig.js';
import { seededRng } from '../src/domain/rng.js';
import { newPlayer } from '../src/domain/player.js';
import { createHorseFromTemplate } from '../src/domain/horses.js';
import type { RaceStartConfig } from '../src/domain/schemas.js';

/** Configs written to contracts/golden for the C# side to run (contracts/protocol.md §9). Fixed seeds. */
export function goldenConfigs(): Record<string, RaceStartConfig> {
  const m = loadMaster();
  const p = newPlayer('golden', 0, '2026-11');
  const horse = (tid: string) => toRaceHorse(m, createHorseFromTemplate(p, m.templateById.get(tid)!, 0));
  const ranked = buildRaceConfig(m, {
    raceId: 'r_golden_ranked', mode: 'ranked', trackId: 'kirameki_turf_2000',
    humans: [{ playerId: 'p_alice', horse: horse('t_akatsuki') }, { playerId: 'p_bob', horse: horse('t_harukaze') }, { playerId: 'p_carol', horse: horse('t_natsu') }],
    cpuCount: 9, cpuLevel: 3, statCap: 3200, rng: seededRng(20261105),
  });
  const friend = buildRaceConfig(m, {
    raceId: 'r_golden_friend', mode: 'friend', trackId: 'minato_turf_2400',
    humans: [{ playerId: 'p_alice', horse: horse('t_ginga') }, { playerId: 'p_bob', horse: horse('t_tsukikage') }],
    cpuCount: 4, cpuLevel: 2, statCap: null, rng: seededRng(42),
  });
  // time attack (REQ-TA-002): exactly what startTimeAttack builds — one human, no CPU, normalised stats
  const timeattack = buildRaceConfig(m, {
    raceId: 'ta_golden', mode: 'timeattack', trackId: 'kirameki_turf_2000',
    humans: [{ playerId: 'p_alice', horse: horse('t_akatsuki') }],
    cpuCount: 0, cpuLevel: 3, statCap: m.progression.timeAttack.statCap, rng: seededRng(777),
  });
  return { 'ts-config-ranked.json': ranked, 'ts-config-friend.json': friend, 'ts-config-timeattack.json': timeattack };
}
