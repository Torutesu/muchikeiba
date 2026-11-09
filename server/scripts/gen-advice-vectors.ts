// REQ-ADV-002: shared vectors for the pre-race advice (contracts/race-advice.vectors.json). The TypeScript server and the
// C# client (engine/Muchi.Client/RaceAdvice.cs, RaceAdviceTests) must both turn every `input` into exactly `output`.
// npm run gen:advice-vectors rewrites the file; test/race-advice.test.ts fails while the committed copy differs.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { adviceVectorsJson } from '../src/domain/raceAdviceVectors.js';

const out = join(import.meta.dirname, '../../contracts/race-advice.vectors.json');
writeFileSync(out, adviceVectorsJson());
console.log('wrote', out);
