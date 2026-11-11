// REQ-CERR-008/009: shared vectors for the client error scrubber and fingerprint (contracts/client-errors.vectors.json).
// The TypeScript server (domain/clientErrors.ts) and the C# client (Muchi.Client ErrorScrubber / ErrorFingerprint,
// ClientErrorsTests) must both produce every output. npm run gen:client-error-vectors rewrites the file;
// test/client-errors.test.ts fails while the committed copy differs.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clientErrorVectorsJson } from '../src/domain/clientErrors.js';

const out = join(import.meta.dirname, '../../contracts/client-errors.vectors.json');
writeFileSync(out, clientErrorVectorsJson());
console.log('wrote', out);
