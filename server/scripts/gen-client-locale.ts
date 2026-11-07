// REQ-L10N-011: the server's English string tables for the clients (npm run gen:client-locale). The C# client and the
// Unity game layer translate names inside race configs and server texts cached offline with it (Muchi.Client Loc).
// test/l10n.test.ts fails while the committed copy differs.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clientLocaleJson } from '../src/i18n/clientLocale.js';

const out = join(import.meta.dirname, '../../engine/Muchi.Client/Resources/Muchi/server-en.json');
writeFileSync(out, clientLocaleJson());
console.log('wrote', out);
