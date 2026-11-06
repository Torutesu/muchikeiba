/**
 * npm run scan:assets [-- --dir <folder>] [--out <catalog.json>] [--check] [--list] [--json <report.json>]
 *
 * Scans the asset output folder (default unity/AssetDelivery~, layout in scripts/assetScan.ts) against
 * contracts/assets.manifest.json and writes server/master/assets-catalog.json (catalogVersion bumped when the content
 * changed). --check only reports (CI: non-failing coverage report). Exit 1 only when writing was asked for and the
 * resulting catalog is invalid (e.g. required FTUE files over the byte budget); nothing is written then.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_PLATFORMS, parseAssetCatalog, type AssetPlatform } from '../src/domain/assetCatalog.js';
import { formatScanReport, scanAssets, type GroupRule, type ScannedFile } from './assetScan.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_DELIVERY_DIR = resolve(root, 'unity/AssetDelivery~');
export const CATALOG_PATH = resolve(root, 'server/master/assets-catalog.json');
export const GROUPS_PATH = resolve(root, 'contracts/assets.groups.json');
const MANIFEST_PATH = resolve(root, 'contracts/assets.manifest.json');

/** Every file under `dir` (recursive), path relative to `dir` with `/`. Empty when the folder does not exist. */
export function listFiles(dir: string): ScannedFile[] {
  if (!existsSync(dir)) return [];
  const out: ScannedFile[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) { if (!name.startsWith('.')) walk(full); continue; }
      if (!st.isFile() || st.size === 0) continue;
      out.push({ path: relative(dir, full).split(sep).join('/'), size: st.size, sha256: createHash('sha256').update(readFileSync(full)).digest('hex') });
    }
  };
  walk(dir);
  return out;
}

export function scanFolder(dir: string, previousPath = CATALOG_PATH) {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { version: number; keys: string[] };
  const rules = (JSON.parse(readFileSync(GROUPS_PATH, 'utf8')) as { rules: GroupRule[] }).rules;
  const previous = parseAssetCatalog(JSON.parse(readFileSync(previousPath, 'utf8')));
  const platforms: Partial<Record<AssetPlatform, { files: ScannedFile[]; bundles?: Record<string, string[]> }>> = {};
  for (const p of ASSET_PLATFORMS) {
    const pdir = join(dir, p);
    const bundlesPath = join(pdir, 'bundles.json');
    const bundles = existsSync(bundlesPath) ? (JSON.parse(readFileSync(bundlesPath, 'utf8')) as { bundles: Record<string, string[]> }).bundles : undefined;
    platforms[p] = { files: listFiles(pdir), ...(bundles ? { bundles } : {}) };
  }
  return scanAssets({ manifest, rules, common: listFiles(join(dir, 'common')), platforms, previous });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const dir = resolve(value('--dir') ?? DEFAULT_DELIVERY_DIR);
  const out = resolve(value('--out') ?? CATALOG_PATH);
  const check = args.includes('--check');
  const { catalog, report } = scanFolder(dir, existsSync(out) ? out : CATALOG_PATH);
  console.log(`folder: ${relative(root, dir) || dir}${existsSync(dir) ? '' : ' (does not exist yet: every key falls back)'}`);
  console.log(formatScanReport(report, args.includes('--list')));
  const jsonOut = value('--json');
  if (jsonOut) writeFileSync(resolve(jsonOut), JSON.stringify(report, null, 1) + '\n');
  if (check) process.exit(0);
  if (report.problems.length) {
    console.error(`\nnot written: ${report.problems.length} problem(s) in the resulting catalog`);
    process.exit(1);
  }
  writeFileSync(out, JSON.stringify(catalog, null, 1) + '\n');
  console.log(`\nwrote ${relative(root, out)} (catalogVersion ${catalog.catalogVersion})`);
}
