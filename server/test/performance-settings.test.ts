// REQ-PERF-012/015/018 (contracts/protocol.md §56): the server side of 画質・省電力・通信量 — the optional low variant in the
// asset catalog (validation, backward-compatible view and hash, the scanner's `<key>.low.<ext>`), the two client KPI events
// with their setting/value pairs, and the help article. The settings themselves live on the device (no route, no state).
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import manifestJson from '../../contracts/assets.manifest.json';
import groupsJson from '../../contracts/assets.groups.json';
import { m } from './helpers.js';
import { handle, type AppContext } from '../src/http/app.js';
import { assetCatalogProblems, EMPTY_ASSET_CATALOG, parseAssetCatalog, platformCatalog, type AssetCatalog, type AssetEntry } from '../src/domain/assetCatalog.js';
import { scanAssets, type GroupRule, type ScannedFile } from '../scripts/assetScan.js';
import { clientBatchSchema, clientToKpi, PERF_SETTING_VALUES, PREDOWNLOAD_BUCKETS } from '../src/domain/kpi.js';
import { helpArticle, helpProblems, searchHelp, HELP_CONTEXTS, BASE_HELP } from '../src/domain/help.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const entry = (key: string, over: Partial<AssetEntry> = {}): AssetEntry => ({ key, file: `${key}.bundle`, sha256: sha(key), size: 1000, group: 'race', required: false, ...over });
const low = (key: string, size = 300) => ({ file: `${key}.low.bundle`, sha256: sha(key + '.low'), size });
const catalog = (entries: AssetEntry[]): AssetCatalog => ({ ...EMPTY_ASSET_CATALOG, manifestVersion: 2, platforms: { ios: { entries }, android: { entries: [] } } });

describe('catalog low variants (REQ-PERF-012)', () => {
  it('accepts a smaller copy on an optional entry and serves it in the view', async () => {
    const c = catalog([entry('scene/venue/aoba', { low: low('scene/venue/aoba') }), entry('horse/coat/default', { group: 'boot', required: true })]);
    expect(assetCatalogProblems(c)).toEqual([]);
    expect(() => parseAssetCatalog(JSON.parse(JSON.stringify(c)))).not.toThrow();
    const r = await handle(new Request('https://x/v1/assets/catalog?platform=ios'), {}, { master: { ...m, assetCatalog: c } } as unknown as AppContext);
    const body = await r.json() as { entries: AssetEntry[] };
    expect(body.entries.find((e) => e.key === 'scene/venue/aoba')!.low).toEqual(low('scene/venue/aoba'));
    expect('low' in body.entries.find((e) => e.key === 'horse/coat/default')!).toBe(false);
  });

  it('a catalog without low variants keeps its old shape and hash (old clients and ETags are unaffected)', async () => {
    const plain = catalog([entry('horse/coat/bay'), entry('horse/coat/default', { group: 'boot', required: true })]);
    const parsed = parseAssetCatalog(JSON.parse(JSON.stringify(plain)));
    const v = await platformCatalog(parsed, 'ios', 'https://cdn.example.test');
    expect(JSON.stringify(v.entries)).not.toContain('low');
    // the hash of the exact pre-§56 view object (same fields, same canonical JSON) is unchanged
    const legacy = await platformCatalog(plain, 'ios', 'https://cdn.example.test');
    expect(v.hash).toBe(legacy.hash);
    const withLow = await platformCatalog(catalog([entry('horse/coat/bay', { low: low('horse/coat/bay') }), entry('horse/coat/default', { group: 'boot', required: true })]), 'ios', 'https://cdn.example.test');
    expect(withLow.hash).not.toBe(v.hash);
  });

  it('rejects a low variant on a required entry, not smaller, the same file, or inconsistent with another entry', () => {
    const problems = (e: AssetEntry[]) => assetCatalogProblems(catalog(e)).join('\n');
    expect(problems([entry('horse/coat/default', { group: 'boot', required: true, low: low('horse/coat/default') })])).toMatch(/required entry has no low variant/);
    expect(problems([entry('horse/coat/bay', { low: low('horse/coat/bay', 1000) })])).toMatch(/smaller/);
    expect(problems([entry('horse/coat/bay', { low: { file: 'horse/coat/bay.bundle', sha256: sha('x'), size: 10 } })])).toMatch(/another file/);
    expect(problems([entry('horse/coat/bay', { low: low('horse/coat/bay') }), entry('horse/coat/black', { file: 'horse/coat/bay.low.bundle', sha256: sha('other'), size: 50 })])).toMatch(/different sha256\/size/);
    expect(() => parseAssetCatalog(JSON.parse(JSON.stringify(catalog([entry('horse/coat/bay', { low: { file: '../x.bundle', sha256: sha('x'), size: 10 } })]))))).toThrow();
    expect(() => parseAssetCatalog(JSON.parse(JSON.stringify(catalog([{ ...entry('horse/coat/bay'), low: { ...low('horse/coat/bay'), extra: 1 } } as AssetEntry]))))).toThrow();
  });

  it('the scanner attaches <key>.low.<ext> and reports low files it cannot use', () => {
    const rules = (groupsJson as { rules: GroupRule[] }).rules;
    const manifest = manifestJson as { version: number; keys: string[] };
    const f = (path: string, body = path): ScannedFile => ({ path, size: body.length, sha256: sha(body) });
    const big = 'x'.repeat(5000);
    const { catalog: c, report } = scanAssets({
      manifest, rules, previous: parseAssetCatalog(JSON.parse(JSON.stringify(m.assetCatalog))),
      common: [f('sfx/race/whip.ogg'), f('sfx/race/whip.low.ogg', 'w'), f('horse/coat/black.low.png', 'orphan')],
      platforms: {
        ios: { files: [f('scene/venue/minato.bundle', big), f('scene/venue/minato.low.bundle', 'small'), f('horse/coat/bay.bundle', 'b'), f('horse/coat/bay.low.bundle', 'bigger-than-b')] },
        android: { files: [] },
      },
    });
    const ios = c.platforms.ios!.entries;
    const minato = ios.find((e) => e.key === 'scene/venue/minato')!;
    expect(minato.low).toEqual({ file: 'scene/venue/minato.low.bundle', sha256: sha('small'), size: 5 });
    expect(ios.some((e) => e.key.endsWith('.low') || e.file.includes('.low.') && !e.low)).toBe(false);
    expect(ios.find((e) => e.key === 'sfx/race/whip')!.low).toBeUndefined(); // required: no low variant
    expect(ios.find((e) => e.key === 'horse/coat/bay')!.low).toBeUndefined(); // not smaller
    const orphans = report.orphans.map((o) => `${o.platform}/${o.file}: ${o.reason}`).join('\n');
    expect(orphans).toMatch(/sfx\/race\/whip\.low\.ogg: .*required/);
    expect(orphans).toMatch(/horse\/coat\/bay\.low\.bundle: .*not smaller/);
    expect(orphans).toMatch(/horse\/coat\/black\.low\.png: .*without its file/);
    expect(report.platforms.ios!.uploads.some((u) => u.from === 'ios/scene/venue/minato.low.bundle' && u.sha256 === sha('small'))).toBe(true);
    expect(report.problems).toEqual([]);
  });
});

describe('KPI (REQ-PERF-015)', () => {
  const batch = (events: unknown[]) => clientBatchSchema.parse({ platform: 'ios', appVersion: '1.0.0', events });

  it('perf_setting_change: every valid setting/value pair, with the device class', () => {
    for (const [setting, values] of Object.entries(PERF_SETTING_VALUES)) {
      for (const value of values) {
        const k = clientToKpi(batch([{ name: 'perf_setting_change', at: 1, props: { setting, value, deviceClass: 'mid' } }]).events[0]!);
        expect(k).toEqual({ name: 'perf_setting_change', s1: setting, s2: value, s3: 'mid' });
      }
    }
  });

  it('perf_setting_change: refuses a value of another setting, unknown settings, classes and extra props', () => {
    const bad = [
      { setting: 'graphics', value: '30', deviceClass: 'mid' },
      { setting: 'frameRate', value: 'high', deviceClass: 'mid' },
      { setting: 'dataSaver', value: 'auto', deviceClass: 'mid' },
      { setting: 'volume', value: 'on', deviceClass: 'mid' },
      { setting: 'graphics', value: 'low', deviceClass: 'ultra' },
      { setting: 'graphics', value: 'low', deviceClass: 'low', model: 'iPhone15,2' },
    ];
    for (const props of bad) expect(() => batch([{ name: 'perf_setting_change', at: 1, props }]), JSON.stringify(props)).toThrow();
  });

  it('asset_predownload: the size bucket and the version only', () => {
    for (const bucket of PREDOWNLOAD_BUCKETS) {
      expect(clientToKpi(batch([{ name: 'asset_predownload', at: 1, props: { bucket, variant: 'low' } }]).events[0]!)).toEqual({ name: 'asset_predownload', s1: bucket, s2: 'low' });
    }
    expect(() => batch([{ name: 'asset_predownload', at: 1, props: { bucket: 'lt_10mb', variant: 'full', bytes: 1234 } }])).toThrow();
    expect(() => batch([{ name: 'asset_predownload', at: 1, props: { bucket: '1tb', variant: 'full' } }])).toThrow();
  });
});

describe('help article (REQ-PERF-018)', () => {
  it('data_storage exists in both languages, links the storage screen, is the storage context, and passes the help checks', () => {
    expect(helpProblems(m)).toEqual([]);
    expect(HELP_CONTEXTS).toContain('storage');
    expect(BASE_HELP.contexts.storage).toBe('data_storage');
    const ja = helpArticle(m, 'data_storage', 'ja');
    const en = helpArticle(m, 'data_storage', 'en');
    expect(ja.body).toMatch(/データセーバー/);
    expect(ja.body).toMatch(/この端末にだけ/);
    expect(ja.body).toMatch(/レースの結果や公平さには影響しません/);
    expect(en.body).toMatch(/this device only/);
    expect(JSON.stringify(ja)).not.toMatch(/今だけ|残りわずか|倍|お得|通常価格/);
    expect(ja.links.map((l: { type: string; screen?: string }) => l.screen)).toEqual(['storage', 'performance']);
    expect(searchHelp(m, 'キャッシュ', null, null, 'ja').items.map((r: { id: string }) => r.id)).toContain('data_storage');
    expect(searchHelp(m, 'storage', null, null, 'en').items.map((r: { id: string }) => r.id)).toContain('data_storage');
  });
});
