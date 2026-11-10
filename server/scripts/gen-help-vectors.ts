// REQ-HELP-006: shared vectors for the help search fold (contracts/help-fold.vectors.json). The TypeScript server
// (help.ts helpFold / helpQueryWords) and the C# client (Muchi.Client HelpText.Fold / Words, ApiClientHelpTests) must both
// turn every `input` into exactly `fold` and `words`. npm run gen:help-vectors rewrites the file; test/help.test.ts fails
// while the committed copy differs.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { helpFoldVectorsJson } from '../src/domain/help.js';

const out = join(import.meta.dirname, '../../contracts/help-fold.vectors.json');
writeFileSync(out, helpFoldVectorsJson());
console.log('wrote', out);
