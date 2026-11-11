/**
 * Build-time asset scanner (REQ-DLV-008). Pure logic: turns the files found in the asset output folder plus the
 * manifest into the delivery catalog (server/master/assets-catalog.json) and a coverage report. The CLI
 * (scripts/scan-assets.ts) does the file system part.
 *
 * Folder layout (unity/AssetDelivery~, docs/handoff-codex-round9.md):
 *   <root>/common/<key>.<ext>          platform-independent files (png, ogg…), used by every platform
 *   <root>/<platform>/<key>.<ext>      platform builds (AssetBundles); override common/ for the same key
 *   <root>/<platform>/bundles.json     optional: {"bundles": {"<file>": ["<key>", …]}} for one file holding several keys
 * The key is the path without its last extension: `ios/horse/coat/bay.bundle` → `horse/coat/bay`,
 * `common/scene/venue/aoba@v2.bundle` → `scene/venue/aoba@v2`.
 */
import { ASSET_FILE_RE, ASSET_PLATFORMS, assetCatalogProblems, assetUrl, sameCatalogContent, type AssetCatalog, type AssetEntry, type AssetGroup, type AssetPlatform } from '../src/domain/assetCatalog.js';
import { ASSET_KEY_RE, ASSET_KINDS, kindOf } from '../src/domain/visuals.js';

export interface ScannedFile {
  /** Path relative to the platform (or common) folder, `/`-separated. */
  path: string;
  size: number;
  sha256: string;
}
export interface ScanInput {
  manifest: { version: number; keys: string[] };
  rules: GroupRule[];
  common: ScannedFile[];
  platforms: Partial<Record<AssetPlatform, { files: ScannedFile[]; bundles?: Record<string, string[]> }>>;
  previous: AssetCatalog;
}
export interface GroupRule { match: string; group: AssetGroup; required: boolean }

export interface OrphanFile { platform: AssetPlatform | 'common'; file: string; reason: string }
export interface PlatformReport {
  /** Manifest keys that have a file. */
  covered: number;
  /** Manifest keys without a file (they degrade to `<kind>/default` at runtime). */
  missing: string[];
  /** Missing count per kind (for a short summary). */
  missingByKind: Record<string, number>;
  /** Keys of dynamic kinds (voice names) that have files but are not listed in the manifest — accepted. */
  dynamicExtra: string[];
  totalBytes: number;
  /** Bytes the FTUE screen may wait for (required boot/ftue, de-duplicated by sha256). */
  blockingBytes: number;
  bytesByGroup: Record<string, number>;
  /** Where each file goes on the CDN (relative to ASSET_CDN_BASE) and where it was read from. */
  uploads: { from: string; to: string; sha256: string; size: number }[];
}
export interface ScanReport {
  manifestKeys: number;
  catalogVersion: number;
  changed: boolean;
  platforms: Partial<Record<AssetPlatform, PlatformReport>>;
  /** Files without a usable key (bad name, unknown kind, not in the manifest, duplicates). */
  orphans: OrphanFile[];
  /** assetCatalogProblems() of the result; the CLI refuses to write the catalog while any exist. */
  problems: string[];
}

const IGNORED = (name: string) => name.startsWith('.') || name.endsWith('.meta') || name.endsWith('.manifest') || /^readme/i.test(name) || name === 'bundles.json';

/** Glob over keys: `*` = one segment (no `/`), `**` = any number of segments. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') { re += '.*'; i++; }
    else if (ch === '*') re += '[^/]*';
    else re += ch.replace(/[.+?^${}()|[\]\\@]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function groupFor(key: string, rules: GroupRule[]): { group: AssetGroup; required: boolean } {
  const base = key.replace(/@v[0-9]+$/, '');
  for (const r of rules) if (globToRegExp(r.match).test(base)) return { group: r.group, required: r.required };
  return { group: 'ondemand', required: false };
}

/** `horse/coat/bay.bundle` → `horse/coat/bay`; null when the name cannot be a key. */
export function keyOfPath(path: string): string | null {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  const key = dot > slash + 1 ? path.slice(0, dot) : path;
  return ASSET_KEY_RE.test(key) ? key : null;
}

export function scanAssets(input: ScanInput): { catalog: AssetCatalog; report: ScanReport } {
  const manifestKeys = new Set(input.manifest.keys);
  const orphans: OrphanFile[] = [];
  const platforms: AssetCatalog['platforms'] = {};
  const reports: Partial<Record<AssetPlatform, PlatformReport>> = {};

  const classify = (where: AssetPlatform | 'common', path: string): string | null => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (IGNORED(name)) return null;
    if (!ASSET_FILE_RE.test(path)) { orphans.push({ platform: where, file: path, reason: 'file name must be lowercase a-z 0-9 _ . @ - (no spaces)' }); return null; }
    const key = keyOfPath(path);
    if (!key) { orphans.push({ platform: where, file: path, reason: 'path does not form an asset key (<kind>/<name>[@vN].<ext>)' }); return null; }
    const kind = kindOf(key);
    if (!ASSET_KINDS[kind]) { orphans.push({ platform: where, file: path, reason: `unknown kind ${kind}` }); return null; }
    if (!manifestKeys.has(key.replace(/@v[0-9]+$/, '')) && !ASSET_KINDS[kind]!.dynamic) { orphans.push({ platform: where, file: path, reason: `key ${key} is not in contracts/assets.manifest.json` }); return null; }
    return key;
  };

  // REQ-PERF-012 (§56.7): `<key>.low.<ext>` is the low variant of `<key>`, attached after the entries are known
  const LOW_RE = /\.low(\.[a-z0-9_]+)$/;
  const lowOf = (path: string): string | null => {
    const m = LOW_RE.exec(path);
    if (!m) return null;
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (IGNORED(name)) return null;
    return keyOfPath(path.slice(0, m.index) + m[1]);
  };
  const commonLow = new Map<string, ScannedFile>();

  // common files are classified once (orphans reported once), then merged into each platform
  const commonByKey = new Map<string, ScannedFile>();
  for (const f of input.common) {
    if (LOW_RE.test(f.path)) {
      const k = lowOf(f.path);
      if (k && ASSET_FILE_RE.test(f.path)) commonLow.set(k, f);
      else orphans.push({ platform: 'common', file: f.path, reason: 'low variant name must be <kind>/<name>[@vN].low.<ext>' });
      continue;
    }
    const key = classify('common', f.path);
    if (key) commonByKey.set(key, f);
  }

  for (const p of ASSET_PLATFORMS) {
    const src = input.platforms[p];
    const byKey = new Map<string, { f: ScannedFile; from: string }>();
    for (const [k, f] of commonByKey) byKey.set(k, { f, from: `common/${f.path}` });
    const inBundles = new Set(Object.keys(src?.bundles ?? {}));
    const lowByKey = new Map<string, { f: ScannedFile; from: string }>();
    for (const [k, f] of commonLow) lowByKey.set(k, { f, from: `common/${f.path}` });
    for (const f of src?.files ?? []) {
      if (inBundles.has(f.path)) continue;
      if (LOW_RE.test(f.path)) {
        const k = lowOf(f.path);
        if (k && ASSET_FILE_RE.test(f.path)) lowByKey.set(k, { f, from: `${p}/${f.path}` });
        else orphans.push({ platform: p, file: f.path, reason: 'low variant name must be <kind>/<name>[@vN].low.<ext>' });
        continue;
      }
      const key = classify(p, f.path);
      if (key) byKey.set(key, { f, from: `${p}/${f.path}` });
    }
    for (const [file, keys] of Object.entries(src?.bundles ?? {})) {
      const f = (src?.files ?? []).find((x) => x.path === file);
      if (!f) { orphans.push({ platform: p, file, reason: 'listed in bundles.json but the file is missing' }); continue; }
      if (!ASSET_FILE_RE.test(file)) { orphans.push({ platform: p, file, reason: 'file name must be lowercase a-z 0-9 _ . @ - (no spaces)' }); continue; }
      for (const key of keys) {
        const kind = ASSET_KEY_RE.test(key) ? kindOf(key) : '';
        if (!ASSET_KINDS[kind]) { orphans.push({ platform: p, file: `${file} → ${key}`, reason: 'bundles.json key is malformed or of an unknown kind' }); continue; }
        if (!manifestKeys.has(key.replace(/@v[0-9]+$/, '')) && !ASSET_KINDS[kind]!.dynamic) { orphans.push({ platform: p, file: `${file} → ${key}`, reason: `key ${key} is not in contracts/assets.manifest.json` }); continue; }
        byKey.set(key, { f: { ...f, path: file }, from: `${p}/${file}` });
      }
    }

    const bundled = new Set(Object.values(src?.bundles ?? {}).flat());
    const lowFrom = new Map<string, string>();
    const entries: AssetEntry[] = [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, { f }]) => {
      const e: AssetEntry = { key, file: f.path, sha256: f.sha256, size: f.size, ...groupFor(key, input.rules) };
      const low = lowByKey.get(key);
      if (low) {
        lowByKey.delete(key);
        if (e.required) orphans.push({ platform: p, file: low.f.path, reason: `${key} is required: required files are always fetched in full (no low variant)` });
        else if (bundled.has(key)) orphans.push({ platform: p, file: low.f.path, reason: `${key} is inside a bundles.json file: low variants are for single-file assets` });
        else if (low.f.size >= f.size) orphans.push({ platform: p, file: low.f.path, reason: `the low variant is not smaller than ${f.path}` });
        else { e.low = { file: low.f.path, sha256: low.f.sha256, size: low.f.size }; lowFrom.set(key, low.from); }
      }
      return e;
    });
    for (const [k, low] of lowByKey) orphans.push({ platform: low.from.startsWith('common/') ? 'common' : p, file: low.f.path, reason: `low variant without its file (${k})` });
    platforms[p] = { entries };

    const coveredKeys = new Set([...byKey.keys()].map((k) => k.replace(/@v[0-9]+$/, '')));
    const missing = input.manifest.keys.filter((k) => !coveredKeys.has(k));
    const missingByKind: Record<string, number> = {};
    for (const k of missing) missingByKind[kindOf(k)] = (missingByKind[kindOf(k)] ?? 0) + 1;
    const bytesByGroup: Record<string, number> = {};
    const seenSha = new Set<string>();
    const blockingSha = new Set<string>();
    let totalBytes = 0;
    let blockingBytes = 0;
    const uploads = new Map<string, PlatformReport['uploads'][number]>();
    for (const e of entries) {
      if (!seenSha.has(e.sha256)) { seenSha.add(e.sha256); totalBytes += e.size; bytesByGroup[e.group] = (bytesByGroup[e.group] ?? 0) + e.size; }
      if (e.required && !blockingSha.has(e.sha256)) { blockingSha.add(e.sha256); blockingBytes += e.size; }
      const to = assetUrl({ baseUrl: '', urlTemplate: input.previous.urlTemplate, platform: p }, e).replace(/^\//, '');
      if (!uploads.has(to)) uploads.set(to, { from: byKey.get(e.key)!.from, to, sha256: e.sha256, size: e.size });
      if (e.low) {
        const lto = assetUrl({ baseUrl: '', urlTemplate: input.previous.urlTemplate, platform: p }, e.low).replace(/^\//, '');
        const from = lowFrom.get(e.key)!;
        if (!uploads.has(lto)) uploads.set(lto, { from, to: lto, sha256: e.low.sha256, size: e.low.size });
      }
    }
    reports[p] = {
      covered: input.manifest.keys.length - missing.length, missing, missingByKind,
      dynamicExtra: [...byKey.keys()].filter((k) => !manifestKeys.has(k.replace(/@v[0-9]+$/, ''))),
      totalBytes, blockingBytes, bytesByGroup, uploads: [...uploads.values()],
    };
  }

  const draft: AssetCatalog = { ...input.previous, manifestVersion: input.manifest.version, platforms };
  const changed = !sameCatalogContent(draft, input.previous);
  const catalog: AssetCatalog = { ...draft, catalogVersion: input.previous.catalogVersion + (changed ? 1 : 0) };
  return {
    catalog,
    report: { manifestKeys: input.manifest.keys.length, catalogVersion: catalog.catalogVersion, changed, platforms: reports, orphans, problems: assetCatalogProblems(catalog) },
  };
}

const mb = (n: number) => `${(n / 1_000_000).toFixed(1)} MB`;

/** Human-readable summary for CI logs. */
export function formatScanReport(r: ScanReport, listAll = false): string {
  const lines: string[] = [];
  lines.push(`asset delivery scan: ${r.manifestKeys} manifest keys, catalogVersion ${r.catalogVersion}${r.changed ? ' (changed → bumped)' : ' (unchanged)'}`);
  for (const [p, x] of Object.entries(r.platforms)) {
    if (!x) continue;
    lines.push(`  ${p}: ${x.covered}/${r.manifestKeys} keys have files, ${x.missing.length} missing (fall back to <kind>/default); ${x.uploads.length} files, ${mb(x.totalBytes)}; FTUE blocking ${mb(x.blockingBytes)}`);
    const kinds = Object.entries(x.missingByKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`);
    if (kinds.length) lines.push(`    missing by kind: ${kinds.join(', ')}`);
    const groups = Object.entries(x.bytesByGroup).map(([g, n]) => `${g} ${mb(n)}`);
    if (groups.length) lines.push(`    bytes by group: ${groups.join(', ')}`);
    if (x.dynamicExtra.length) lines.push(`    dynamic keys outside the manifest (accepted): ${x.dynamicExtra.length}`);
    if (listAll) for (const k of x.missing) lines.push(`    - ${k}`);
  }
  if (r.orphans.length) {
    lines.push(`  files without a key (${r.orphans.length}):`);
    for (const o of r.orphans.slice(0, listAll ? undefined : 50)) lines.push(`    ! ${o.platform}/${o.file}: ${o.reason}`);
    if (!listAll && r.orphans.length > 50) lines.push(`    … ${r.orphans.length - 50} more (--list)`);
  }
  for (const p of r.problems) lines.push(`  PROBLEM ${p}`);
  return lines.join('\n');
}
