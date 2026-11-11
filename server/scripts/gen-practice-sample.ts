// REQ-PRAC-017: writes contracts/practice-catalog.sample.json — a catalog exactly as GET /v1/practice/catalog answers, which the
// C# PracticeCatalog / PracticeSession tests parse and race (engine/Muchi.Engine.Tests/PracticeTests.cs).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMaster } from '../src/domain/master.js';
import { practiceSampleJson } from '../src/domain/practiceSample.js';

const out = join(import.meta.dirname, '../../contracts/practice-catalog.sample.json');
writeFileSync(out, practiceSampleJson(loadMaster()));
console.log('wrote', out);
