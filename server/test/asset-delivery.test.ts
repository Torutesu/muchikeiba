// REQ-DLV-001..010: asset delivery catalog — endpoint (ETag/304, platforms), validation in remote config, build-time scanner.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import manifestJson from '../../contracts/assets.manifest.json';
import groupsJson from '../../contracts/assets.groups.json';
import { m } from './helpers.js';
import { handle, type AppContext } from '../src/http/app.js';
import {
  assetCatalogProblems, assetUrl, DEFAULT_ASSET_POLICY, DELIVERY_HARD_LIMITS, EMPTY_ASSET_CATALOG, etagMatches, parseAssetCatalog, platformCatalog,
  type AssetCatalog, type AssetEntry,
} from '../src/domain/assetCatalog.js';
import { ConfigStore, MemoryConfigRepo, resolveBundle } from '../src/ops/config.js';
import { globToRegExp, groupFor, keyOfPath, scanAssets, type GroupRule, type ScannedFile } from '../scripts/assetScan.js';
import { scanFolder } from '../scripts/scan-assets.js';
import { lintDeployConfig } from '../scripts/deployLint.js';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const entry = (key: string, over: Partial<AssetEntry> = {}): AssetEntry => ({ key, file: `${key}.bundle`, sha256: sha(key), size: 1000, group: 'race', required: false, ...over });
const catalog = (entries: AssetEntry[], over: Partial<AssetCatalog> = {}): AssetCatalog => ({ ...EMPTY_ASSET_CATALOG, manifestVersion: 2, platforms: { ios: { entries }, android: { entries: [] } }, ...over });
const ctx = (master = m, cdn?: string) => ({ master, ...(cdn ? { assetCdnBase: cdn } : {}) }) as unknown as AppContext;
const get = (path: string, headers: Record<string, string> = {}) => new Request(`https://x${path}`, { headers });

describe('GET /v1/assets/catalog (REQ-DLV-001/002)', () => {
  const master = { ...m, assetCatalog: catalog([entry('horse/coat/bay'), entry('horse/coat/default', { group: 'boot', required: true })]) };

  it('serves the platform view with an ETag, CDN base from env and the policy', async () => {
    const r = await handle(get('/v1/assets/catalog?platform=ios'), {}, ctx(master, 'https://cdn.example.test/'));
    expect(r.status).toBe(200);
    const body = await r.json() as { hash: string; baseUrl: string; entries: AssetEntry[]; platform: string; policy: unknown; groups: string[]; catalogVersion: number };
    expect(r.headers.get('etag')).toBe(`"${body.hash}"`);
    expect(r.headers.get('cache-control')).toMatch(/max-age/);
    expect(body).toMatchObject({ platform: 'ios', baseUrl: 'https://cdn.example.test', catalogVersion: 1, policy: DEFAULT_ASSET_POLICY });
    expect(body.groups).toEqual(['boot', 'ftue', 'home', 'race', 'shop', 'ondemand']);
    expect(body.entries.map((e) => e.key)).toEqual(['horse/coat/bay', 'horse/coat/default']); // sorted
    expect(assetUrl(body as never, body.entries[0]!)).toBe(`https://cdn.example.test/ios/${sha('horse/coat/bay')}/horse/coat/bay.bundle`);
  });

  it('answers 304 to a matching If-None-Match (also weak / list forms) and 200 after a change', async () => {
    const first = await handle(get('/v1/assets/catalog?platform=ios'), {}, ctx(master));
    const etag = first.headers.get('etag')!;
    const again = await handle(get('/v1/assets/catalog?platform=ios', { 'if-none-match': etag }), {}, ctx(master));
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    expect(again.headers.get('etag')).toBe(etag);
    expect((await handle(get('/v1/assets/catalog?platform=ios', { 'if-none-match': `"x", W/${etag}` }), {}, ctx(master))).status).toBe(304);
    const bumped = { ...m, assetCatalog: { ...master.assetCatalog, catalogVersion: 2 } };
    const changed = await handle(get('/v1/assets/catalog?platform=ios', { 'if-none-match': etag }), {}, ctx(bumped));
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);
    // the platform and the CDN base are part of the view
    const android = await handle(get('/v1/assets/catalog?platform=android', { 'if-none-match': etag }), {}, ctx(master));
    expect(android.status).toBe(200);
    expect(((await android.json()) as { entries: unknown[] }).entries).toEqual([]);
    expect((await handle(get('/v1/assets/catalog?platform=ios', { 'if-none-match': etag }), {}, ctx(master, 'https://other.example.test'))).status).toBe(200);
  });

  it('rejects a missing or unknown platform; GET /v1/config reports assetCatalogVersion', async () => {
    expect((await handle(get('/v1/assets/catalog'), {}, ctx())).status).toBe(400);
    expect((await handle(get('/v1/assets/catalog?platform=webgl'), {}, ctx())).status).toBe(400);
    const cfg = await (await handle(get('/v1/config'), {}, ctx({ ...m, assetCatalog: { ...EMPTY_ASSET_CATALOG, catalogVersion: 7 } }))).json() as { assetCatalogVersion: number };
    expect(cfg.assetCatalogVersion).toBe(7);
  });

  it('the shipped base catalog is valid and served (no art yet: empty, every key falls back)', async () => {
    expect(m.assetCatalog).toBeDefined();
    expect(assetCatalogProblems(m.assetCatalog!)).toEqual([]);
    const v = await platformCatalog(m.assetCatalog!, 'android', undefined);
    expect(v.baseUrl).toBe('');
    expect(v.manifestVersion).toBe((manifestJson as { version: number }).version);
  });

  it('etagMatches handles absent headers and *', () => {
    expect(etagMatches(null, '"a"')).toBe(false);
    expect(etagMatches('*', '"a"')).toBe(true);
    expect(etagMatches('"b"', '"a"')).toBe(false);
  });
});

describe('catalog validation (REQ-DLV-004/005)', () => {
  it('flags bad keys, unsafe files, inconsistent hashes, defaults outside boot, required outside boot/ftue and FTUE budget', () => {
    expect(() => parseAssetCatalog({ ...catalog([]), platforms: { ios: { entries: [entry('Horse/Coat')] } } })).toThrow(/malformed asset key/);
    expect(() => parseAssetCatalog({ ...catalog([]), platforms: { ios: { entries: [entry('horse/coat/bay', { file: '../etc/passwd' })] } } })).toThrow(/file must be/);
    expect(() => parseAssetCatalog({ ...catalog([]), policy: { ...DEFAULT_ASSET_POLICY, tutorialMaxWaitMs: DELIVERY_HARD_LIMITS.tutorialMaxWaitMs + 1 } })).toThrow(/tutorialMaxWaitMs/);
    const p = assetCatalogProblems(catalog([
      entry('nope/kind/x'),
      entry('horse/coat/bay', { file: 'shared.bundle' }),
      entry('horse/coat/gray', { file: 'shared.bundle', sha256: sha('other') }),
      entry('horse/face/default', { group: 'race' }),
      entry('scene/venue/aoba', { group: 'race', required: true }),
      entry('scene/venue/minato', { group: 'ftue', required: true, size: DEFAULT_ASSET_POLICY.ftueBlockingMaxBytes + 1 }),
    ])).join('\n');
    expect(p).toMatch(/unknown kind nope\/kind/);
    expect(p).toMatch(/file shared.bundle is listed with different sha256/);
    expect(p).toMatch(/horse\/face\/default: <kind>\/default must be required in group boot/);
    expect(p).toMatch(/scene\/venue\/aoba: only boot\/ftue entries may be required/);
    expect(p).toMatch(/over policy.ftueBlockingMaxBytes/);
    expect(assetCatalogProblems(catalog([entry('horse/coat/bay'), entry('horse/coat/bay')])).join()).toMatch(/duplicate key/);
  });

  it('keeps hosts and secrets out of config: the template must start at {base} and has no query', () => {
    expect(assetCatalogProblems(catalog([], { urlTemplate: 'https://evil.example/{sha256}' })).join()).toMatch(/must start with "\{base\}\/"/);
    expect(assetCatalogProblems(catalog([], { urlTemplate: '{base}/{file}?token=abc' })).join()).toMatch(/query or fragment/);
    expect(assetCatalogProblems(catalog([], { urlTemplate: '{base}/{secret}/{file}' })).join()).toMatch(/unknown placeholder \{secret\}/);
    expect(assetCatalogProblems(catalog([], { urlTemplate: '{base}/{platform}' })).join()).toMatch(/needs \{sha256\} or \{file\}/);
  });

  it('remote config: a new catalog must bump catalogVersion; an invalid one is refused; a valid one is served', async () => {
    const base = m.assetCatalog!;
    const next = catalog([entry('horse/coat/bay')], { catalogVersion: base.catalogVersion });
    expect(() => resolveBundle(m, { assets: next })).toThrow(/catalogVersion was not bumped/);
    expect(() => resolveBundle(m, { assets: { ...next, catalogVersion: base.catalogVersion + 1, urlTemplate: 'https://x/{file}' } })).toThrow(/must start with/);
    const ok = resolveBundle(m, { assets: { ...next, catalogVersion: base.catalogVersion + 1 } });
    expect(ok.master.assetCatalog!.platforms.ios!.entries).toHaveLength(1);
    const r = await handle(get('/v1/assets/catalog?platform=ios'), {}, ctx(ok.master));
    expect(((await r.json()) as { entries: unknown[]; catalogVersion: number })).toMatchObject({ catalogVersion: base.catalogVersion + 1 });
    // without `assets` the shipped catalog stays
    expect(resolveBundle(m, {}).master.assetCatalog).toBe(base);
  });

  it('a catalogVersion names one content across stored config versions', async () => {
    const s = new ConfigStore(new MemoryConfigRepo(), m);
    const v = m.assetCatalog!.catalogVersion + 1;
    await s.stage({ assets: catalog([entry('horse/coat/bay')], { catalogVersion: v }) }, 'ops', 'first art drop', 1);
    expect(s.validate({ assets: catalog([entry('horse/coat/gray')], { catalogVersion: v }) }).join()).toMatch(/already used by cfg_1/);
    expect(s.validate({ assets: catalog([entry('horse/coat/gray')], { catalogVersion: v + 1 }) })).toEqual([]);
  });

  it('deploy lint: ASSET_CDN_BASE is required and must be https without a trailing slash', () => {
    const toml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'wrangler.toml'), 'utf8');
    const msgs = (t: string) => lintDeployConfig(t, 'staging', { allowPlaceholders: true }).filter((i) => i.level === 'error').map((i) => i.message).join('\n');
    expect(msgs(toml)).not.toMatch(/ASSET_CDN_BASE/);
    expect(msgs(toml.replace('ASSET_CDN_BASE = "https://assets-staging.REPLACE_ME.example"', 'ASSET_CDN_BASE = "http://assets/"'))).toMatch(/ASSET_CDN_BASE must be https/);
    expect(msgs(toml.replace('ASSET_CDN_BASE = "https://assets-staging.REPLACE_ME.example"\n', ''))).toMatch(/ASSET_CDN_BASE is required/);
  });
});

describe('build-time scanner (REQ-DLV-008)', () => {
  const rules = (groupsJson as { rules: GroupRule[] }).rules;
  const manifest = manifestJson as { version: number; keys: string[] };
  const f = (path: string, body = path): ScannedFile => ({ path, size: body.length, sha256: sha(body) });

  it('globs and group rules: defaults → boot/required, tutorial course → ftue, voice names → ondemand', () => {
    expect(globToRegExp('sfx/race/*').test('sfx/race/whip')).toBe(true);
    expect(globToRegExp('sfx/race/*').test('sfx/race/a/b')).toBe(false);
    expect(globToRegExp('**/default').test('voice/ja/num/default')).toBe(true);
    expect(groupFor('horse/coat/default', rules)).toEqual({ group: 'boot', required: true });
    expect(groupFor('scene/venue/aoba@v2', rules)).toEqual({ group: 'ftue', required: false });
    expect(groupFor('voice/ja/name/n47ab6ba076960abe', rules).group).toBe('ondemand');
    expect(groupFor('scene/venue/minato', rules).group).toBe('race');
    expect(groupFor('banner/gacha/standard', rules).group).toBe('shop');
    expect(keyOfPath('horse/coat/bay.bundle')).toBe('horse/coat/bay');
    expect(keyOfPath('scene/venue/aoba@v2.bundle')).toBe('scene/venue/aoba@v2');
    expect(keyOfPath('Horse/Coat.png')).toBeNull();
  });

  it('every manifest key reaches a group and nothing in the manifest would be required outside boot/ftue', () => {
    for (const k of manifest.keys) {
      const g = groupFor(k, rules);
      if (g.required) expect(['boot', 'ftue']).toContain(g.group);
    }
  });

  it('builds the catalog from files, flags keys without files and files without keys, bumps the version on change', () => {
    const previous = parseAssetCatalog(JSON.parse(JSON.stringify(m.assetCatalog)));
    const { catalog: c, report } = scanAssets({
      manifest, rules, previous,
      common: [f('sfx/race/whip.ogg'), f('voice/ja/name/n0000000000000001.ogg'), f('README.md'), f('sfx/race/whip.ogg.meta')],
      platforms: {
        ios: { files: [f('horse/coat/bay.bundle', 'ios-bay'), f('scene/aoba.bundle', 'ios-aoba'), f('Bad Name.png'), f('horse/coat/zebra.bundle'), f('weird/kind/x.png')], bundles: { 'scene/aoba.bundle': ['scene/venue/aoba', 'scene/surface/aoba_turf'] } },
        android: { files: [f('horse/coat/bay.bundle', 'android-bay')] },
      },
    });
    expect(report.changed).toBe(true);
    expect(c.catalogVersion).toBe(previous.catalogVersion + 1);
    const ios = c.platforms.ios!.entries;
    expect(ios.map((e) => e.key)).toEqual(['horse/coat/bay', 'scene/surface/aoba_turf', 'scene/venue/aoba', 'sfx/race/whip', 'voice/ja/name/n0000000000000001']);
    expect(ios.find((e) => e.key === 'scene/venue/aoba')!.file).toBe('scene/aoba.bundle');
    expect(ios.find((e) => e.key === 'sfx/race/whip')).toMatchObject({ group: 'ftue', required: true });
    expect(c.platforms.android!.entries.find((e) => e.key === 'horse/coat/bay')!.sha256).toBe(sha('android-bay'));
    expect(report.platforms.ios!.covered).toBe(4); // bay, aoba ×2, whip (the dynamic voice name is extra)
    expect(report.platforms.ios!.missing).toHaveLength(manifest.keys.length - 4);
    expect(report.platforms.ios!.dynamicExtra).toEqual(['voice/ja/name/n0000000000000001']);
    expect(report.platforms.ios!.uploads.filter((u) => u.from === 'ios/scene/aoba.bundle')).toHaveLength(1); // one file, two keys
    expect(report.platforms.ios!.uploads[0]!.to).toMatch(/^ios\/[0-9a-f]{64}\//);
    const orphans = report.orphans.map((o) => `${o.platform}/${o.file}`);
    expect(orphans).toEqual(expect.arrayContaining(['ios/Bad Name.png', 'ios/horse/coat/zebra.bundle', 'ios/weird/kind/x.png']));
    expect(orphans.some((o) => o.includes('README') || o.endsWith('.meta'))).toBe(false);
    expect(report.problems).toEqual([]);
    // same files again → unchanged, same version
    const again = scanAssets({ manifest, rules, previous: c, common: [f('sfx/race/whip.ogg'), f('voice/ja/name/n0000000000000001.ogg')], platforms: {
      ios: { files: [f('horse/coat/bay.bundle', 'ios-bay'), f('scene/aoba.bundle', 'ios-aoba')], bundles: { 'scene/aoba.bundle': ['scene/venue/aoba', 'scene/surface/aoba_turf'] } },
      android: { files: [f('horse/coat/bay.bundle', 'android-bay')] },
    } });
    expect(again.report.changed).toBe(false);
    expect(again.catalog.catalogVersion).toBe(c.catalogVersion);
  });

  it('reports a FTUE budget problem when required files are too big (the CLI then refuses to write)', () => {
    const big = 'x'.repeat(DEFAULT_ASSET_POLICY.ftueBlockingMaxBytes + 1);
    const { report } = scanAssets({ manifest, rules, previous: m.assetCatalog!, common: [{ path: 'sfx/race/whip.ogg', size: big.length, sha256: sha(big) }], platforms: {} });
    expect(report.problems.join()).toMatch(/ftueBlockingMaxBytes/);
  });

  it('scans a real folder (common + platform + bundles.json); a missing folder reports every key as missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muchi-assets-'));
    mkdirSync(join(dir, 'common', 'sfx', 'ui'), { recursive: true });
    mkdirSync(join(dir, 'ios', 'scene'), { recursive: true });
    writeFileSync(join(dir, 'common', 'sfx', 'ui', 'tap.ogg'), 'tap');
    writeFileSync(join(dir, 'ios', 'scene', 'minato.bundle'), 'minato');
    writeFileSync(join(dir, 'ios', 'bundles.json'), JSON.stringify({ bundles: { 'scene/minato.bundle': ['scene/venue/minato', 'scene/night/minato'] } }));
    const { catalog: c, report } = scanFolder(dir);
    expect(c.platforms.ios!.entries.map((e) => e.key)).toEqual(['scene/night/minato', 'scene/venue/minato', 'sfx/ui/tap']);
    expect(c.platforms.android!.entries.map((e) => e.key)).toEqual(['sfx/ui/tap']);
    expect(c.platforms.ios!.entries[2]).toMatchObject({ sha256: sha('tap'), size: 3, file: 'sfx/ui/tap.ogg' });
    expect(report.orphans).toEqual([]);
    const none = scanFolder(join(dir, 'does-not-exist'));
    expect(none.report.platforms.ios!.covered).toBe(0);
    expect(none.report.platforms.ios!.missing).toHaveLength(manifest.keys.length);
    expect(none.report.changed).toBe(false); // the committed catalog matches an empty folder
  });
});
