// Writes contracts/assets.manifest.json from the master data (REQ-ASSET-008). Usage: npm run gen:assets
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMaster } from '../src/domain/master.js';
import { buildAssetManifest, manifestProblems, type CommentaryJson } from '../src/domain/assetManifest.js';
import { visualsProblems } from '../src/domain/visuals.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const MANIFEST_PATH = resolve(root, 'contracts/assets.manifest.json');
export const COMMENTARY_PATH = resolve(root, 'engine/Muchi.Client/Data/commentary-ja.json');

export function renderManifest(): string {
  const m = loadMaster();
  const problems = visualsProblems(m);
  if (problems.length) throw new Error('master/visuals.json:\n' + problems.join('\n'));
  const man = buildAssetManifest(m, JSON.parse(readFileSync(COMMENTARY_PATH, 'utf8')) as CommentaryJson);
  const mp = manifestProblems(man);
  if (mp.length) throw new Error('manifest:\n' + mp.join('\n'));
  return JSON.stringify(man, null, 1) + '\n';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(MANIFEST_PATH, renderManifest());
  console.log('wrote', MANIFEST_PATH);
}
