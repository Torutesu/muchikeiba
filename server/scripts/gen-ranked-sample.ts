// Quality pass 2 (docs/quality/ranked.md): writes contracts/ranked-fields.sample.json — ranked fields exactly as the matchmaker
// issues them to a player on the partner horse in every class, which the C# ranked harness rides (engine/Muchi.Verifier/RankedHarness.cs).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMaster } from '../src/domain/master.js';
import { rankedSampleJson } from '../src/domain/rankedSample.js';

const out = join(import.meta.dirname, '../../contracts/ranked-fields.sample.json');
writeFileSync(out, await rankedSampleJson(loadMaster()));
console.log('wrote', out);
