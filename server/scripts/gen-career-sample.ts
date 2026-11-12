// REQ-CAREER-019: writes contracts/career-configs.sample.json — every 騎手の道 race config exactly as the server issues it to a
// player riding the partner, which the C# CareerRun tests race, verify and evaluate (engine/Muchi.Engine.Tests/CareerTests.cs).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMaster } from '../src/domain/master.js';
import { careerSampleJson } from '../src/domain/careerSample.js';

const out = join(import.meta.dirname, '../../contracts/career-configs.sample.json');
writeFileSync(out, careerSampleJson(loadMaster()));
console.log('wrote', out);
