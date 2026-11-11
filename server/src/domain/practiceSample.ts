// REQ-PRAC-002/017: a practice catalog as the server writes it, for the C# client tests (contracts/practice-catalog.sample.json,
// written by scripts/gen-practice-sample.ts; test/practice.test.ts fails while the committed copy differs). A fixed player
// (three template horses, the first is the partner) at a fixed time over the default ruleset.
import defaultRuleset from '../../../contracts/ruleset-params.default.json';
import type { Master } from './master.js';
import { newPlayer } from './player.js';
import { createHorseFromTemplate } from './horses.js';
import { practiceCatalog } from './practice.js';
import type { Ruleset } from './ruleset.js';

export const PRACTICE_SAMPLE_NOW = Date.UTC(2026, 10, 10, 3);

export function practiceSampleJson(m: Master): string {
  const s = newPlayer('sample', PRACTICE_SAMPLE_NOW, 'S2026-11');
  const ids = ['t_kohaku', 't_ginga', 't_sunaarashi'].map((t) => createHorseFromTemplate(s, m.templateById.get(t)!, PRACTICE_SAMPLE_NOW).id);
  s.flags.partnerHorseId = ids[0];
  return JSON.stringify(practiceCatalog(m, s, PRACTICE_SAMPLE_NOW, defaultRuleset as unknown as Ruleset), null, 1) + '\n';
}
