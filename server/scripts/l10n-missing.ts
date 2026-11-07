// Lists the player-facing Japanese master texts that have no English yet (npm run l10n:missing).
import { loadMaster } from '../src/domain/master.js';
import { masterTexts } from '../src/i18n/validate.js';
import { CODE_EN } from '../src/i18n/en.js';

const m = loadMaster();
const table = m.locale?.en ?? {};
const seen = new Set<string>();
for (const { path, text } of masterTexts(m)) {
  if (seen.has(text) || table[text] !== undefined || CODE_EN[text] !== undefined) continue;
  seen.add(text);
  console.log(JSON.stringify({ path, text }));
}
