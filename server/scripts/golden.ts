import { loadMaster } from '../src/domain/master.js';
import { buildRaceConfig, toRaceHorse } from '../src/domain/raceConfig.js';
import { seededRng } from '../src/domain/rng.js';
import { newPlayer } from '../src/domain/player.js';
import { createHorseFromTemplate } from '../src/domain/horses.js';
import type { RaceStartConfig } from '../src/domain/schemas.js';
import { eventRuleset } from '../src/domain/events.js';
import { DEFAULT_RULESET, timeAttackRuleset } from '../src/domain/ruleset.js';
import { startChallenge, weeklyChallengeConfig } from '../src/domain/weeklyChallenge.js';
import { addJstDays, dayRule, gameWeekStartMs } from '../src/domain/time.js';

/** Configs written to contracts/golden for the C# side to run (contracts/protocol.md §9). Fixed seeds. */
export function goldenConfigs(): Record<string, RaceStartConfig> {
  const m = loadMaster();
  const p = newPlayer('golden', 0, '2026-11');
  const horse = (tid: string) => toRaceHorse(m, createHorseFromTemplate(p, m.templateById.get(tid)!, 0));
  const ranked = buildRaceConfig(m, {
    raceId: 'r_golden_ranked', mode: 'ranked', trackId: 'kirameki_turf_2000',
    humans: [{ playerId: 'p_alice', horse: horse('t_akatsuki') }, { playerId: 'p_bob', horse: horse('t_harukaze') }, { playerId: 'p_carol', horse: horse('t_natsu') }],
    cpuCount: 9, cpuLevel: 3, statCap: 3200, rng: seededRng(20261105),
    ground: { going: 'yielding', night: false }, // REQ-RACE-034: ranked races carry the day's going
  });
  const friend = buildRaceConfig(m, {
    raceId: 'r_golden_friend', mode: 'friend', trackId: 'minato_turf_2400',
    humans: [{ playerId: 'p_alice', horse: horse('t_ginga') }, { playerId: 'p_bob', horse: horse('t_tsukikage') }],
    cpuCount: 4, cpuLevel: 2, statCap: null, rng: seededRng(42),
    ground: { going: 'soft', night: true }, // lit venue, evening: heavy turf under the lights
  });
  // dirt at the lit venue, sloppy, night (REQ-RACE-034/036): dirt-bred horses with ground preferences
  const dirt = buildRaceConfig(m, {
    raceId: 'r_golden_dirt_night', mode: 'ranked', trackId: 'minato_dirt_1800',
    humans: [{ playerId: 'p_alice', horse: horse('t_sunaarashi') }, { playerId: 'p_bob', horse: horse('t_kawarabi') }],
    cpuCount: 10, cpuLevel: 4, statCap: 3200, rng: seededRng(1800),
    ground: { going: 'sloppy', night: true },
  });
  // time attack (REQ-TA-002): exactly what startTimeAttack builds — one human, no CPU, normalised stats
  const timeattack = buildRaceConfig(m, {
    raceId: 'ta_golden', mode: 'timeattack', trackId: 'kirameki_turf_2000', rulesetOverrides: timeAttackRuleset(), // as startTimeAttack issues it
    humans: [{ playerId: 'p_alice', horse: horse('t_akatsuki') }],
    cpuCount: 0, cpuLevel: 3, statCap: m.progression.timeAttack.statCap, rng: seededRng(777),
  });
  // event race (REQ-EVENT-003): exactly what createRace builds for an event — event track, ruleset
  // overrides (maxWhips 0, version suffixed) and fixed stats for every entrant incl. CPU
  const ev = m.events.find((e) => e.id === 'no_whip_cup_2026_12')!;
  const event = buildRaceConfig(m, {
    raceId: 'r_golden_event', mode: 'event', trackId: ev.trackIds[0]!,
    humans: [{ playerId: 'p_alice', horse: horse('t_akatsuki') }, { playerId: 'p_bob', horse: horse('t_harukaze') }],
    cpuCount: 6, cpuLevel: ev.rules.cpuLevel, statCap: ev.rules.statCap, rng: seededRng(1225),
    rulesetOverrides: eventRuleset(DEFAULT_RULESET, ev), fixedStats: ev.rules.fixedStats,
  });
  // REQ-WCH-003: every weekly challenge exactly as startChallenge issues it with the loan horse (C# WeeklyChallengeTests
  // rides them: the time limits are reachable, the device evaluation equals the verified one)
  const challenges: Record<string, RaceStartConfig> = {};
  const wc = weeklyChallengeConfig(m);
  wc?.rotation.forEach((w, i) => {
    const now = gameWeekStartMs(addJstDays(wc.anchorWeekId, 7 * i), dayRule(m)) + 3_600_000;
    w.challenges.forEach((ch, j) => {
      const s = newPlayer('p_alice', 0, '2026-11');
      challenges[`ts-config-challenge-${ch.id}.json`] = startChallenge(m, s, ch.id, { loan: true }, `golden_${ch.id}`, seededRng(3100 + i * 10 + j), now, () => undefined).config;
    });
  });
  return { 'ts-config-ranked.json': ranked, 'ts-config-friend.json': friend, 'ts-config-timeattack.json': timeattack, 'ts-config-dirt-night.json': dirt, 'ts-config-event.json': event, ...challenges };
}
