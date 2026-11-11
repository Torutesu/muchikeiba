// Round 21 integration: §62 トレーナーカード, §63 ディープリンク・再戦, §64 アップデートのお知らせ, §65 予定表 against each
// other and against Rounds 17–20 (§46 maintenance, §47 blocks, §48 help, §51 data export, §54 transfer, §57 tips,
// §58 KPI consent and the one-prompt rule, §60 error reports, §61 local notifications, account deletion).
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clientEventSchema } from '../src/domain/kpi.js';
import { KPI_ESSENTIAL, KPI_EVENT_CLASS, kpiClassOf } from '../src/domain/kpiConsent.js';
import { DEFAULT_MAINTENANCE, EXEMPT_ROUTES, endpointGroup, gateRequest, jstToMs, type MaintenanceConfig } from '../src/domain/maintenance.js';
import { routes } from '../src/http/app.js';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const csFiles = (dir: string) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.cs')).map((f) => read(join(dir, f))).join('\n');

/** Every KPI event Round 21 added (server rows and client events). */
const R21_KPI = {
  showcase: ['showcase_save', 'showcase_view', 'showcase_share'],
  links: ['link_create', 'link_resolve', 'link_revoke', 'rematch', 'deep_link_open'],
  releaseNotes: ['release_notes_view', 'release_notes_target', 'release_notes_history'],
  calendar: ['calendar_view', 'calendar_entry_open', 'calendar_mark'],
};
const ALL_R21_KPI = Object.values(R21_KPI).flat();

describe('§58 KPI classification of the Round 21 events (REQ-CNS-012, §58.7)', () => {
  it('every Round 21 event is classified, and all of them are optional (engagement only; none is a legal / payment / security record)', () => {
    for (const n of ALL_R21_KPI) {
      expect(KPI_EVENT_CLASS[n], n).toBe('optional');
      expect(kpiClassOf(n), n).toBe('optional');
      expect(n in KPI_ESSENTIAL, n).toBe(false);
    }
  });
  it('§58.7 in the protocol lists every Round 21 event with its class', () => {
    const p = read('contracts/protocol.md');
    const s = p.slice(p.indexOf('### 58.7'), p.indexOf('### 58.8'));
    for (const n of ALL_R21_KPI) expect(s, n).toContain(n);
  });
  it('the Round 21 client events are built by Muchi.Client and documented in docs/ops/kpi-queries.md', () => {
    const names = clientEventSchema.options.map((o) => (o.shape.name as unknown as { value: string }).value);
    const cs = csFiles('engine/Muchi.Client');
    const q = read('docs/ops/kpi-queries.md');
    for (const n of ['showcase_view', 'showcase_share', 'deep_link_open', 'release_notes_view', 'release_notes_target', 'release_notes_history', 'calendar_view', 'calendar_entry_open']) {
      expect(names, n).toContain(n);
      expect(cs, n).toContain(`"${n}"`);
    }
    for (const n of ALL_R21_KPI) expect(q, n).toContain(n);
  });
});

describe('§46 gates × Round 21 routes (§46.2)', () => {
  const START = jstToMs('2026-11-12T02:00')!;
  const win = (scope: MaintenanceConfig['windows'][number]['scope']): MaintenanceConfig => ({
    ...structuredClone(DEFAULT_MAINTENANCE),
    windows: [{ id: 'm1', startAtMs: START, endAtMs: START + 4 * 3600_000, scope, message: { ja: '点検中', en: 'Checks' } }],
    clientVersions: { ios: { min: '9.0.0', recommended: '9.0.0', storeUrl: 'https://apps.apple.com/jp/app/id1234567890' }, android: DEFAULT_MAINTENANCE.clientVersions.android },
  });
  const none = { platform: null, version: null, engine: null };
  const old = { platform: 'ios', version: '1.0.0', engine: null };
  const GROUPS: Record<string, string> = {
    'GET /v1/showcase': 'social', 'PUT /v1/showcase': 'social', 'GET /v1/showcase/:playerId': 'social',
    'GET /v1/links': 'social', 'POST /v1/links': 'social', 'DELETE /v1/links/:token': 'social',
    'POST /v1/friend-rooms/rematch/:raceId': 'ranked', 'GET /v1/friend-rooms/rematch/:raceId': 'ranked', 'DELETE /v1/friend-rooms/rematch/:raceId': 'ranked',
    'POST /v1/release-notes/check': 'core', 'POST /v1/release-notes/seen': 'core', 'GET /v1/release-notes': 'core',
    'GET /v1/calendar': 'core', 'PUT /v1/calendar/marks/:entryId': 'core', 'DELETE /v1/calendar/marks/:entryId': 'core',
  };
  it('every Round 21 route exists and sits in its group; only the link resolve is exempt', () => {
    const have = new Set(routes.map((r) => `${r.method} ${r.path}`));
    for (const [r, g] of Object.entries(GROUPS)) {
      const [, path] = r.split(' ');
      expect(have.has(r), r).toBe(true);
      expect(endpointGroup(path!), r).toBe(g);
      expect((EXEMPT_ROUTES as readonly string[]).includes(r), r).toBe(false);
    }
    expect(have.has('POST /v1/links/resolve')).toBe(true);
    expect(EXEMPT_ROUTES).toContain('POST /v1/links/resolve');
    // every /v1 route of the round's families is listed above (a later route must be placed on purpose)
    const r21 = routes.map((r) => `${r.method} ${r.path}`).filter((r) => /\/v1\/(showcase|links|friend-rooms\/rematch|release-notes|calendar)/.test(r));
    expect(r21.filter((r) => !(r in GROUPS) && r !== 'POST /v1/links/resolve')).toEqual([]);
  });
  it('a window on the group closes it; an `all` window closes core; the resolve answers in any window and from an outdated app', () => {
    for (const [r, g] of Object.entries(GROUPS)) {
      const [method, path] = r.split(' ');
      const p = path!.replace(':playerId', 'p_x').replace(':token', 'AbCd2345EfGh').replace(':raceId', 'r_1').replace(':entryId', 'season_1');
      expect(gateRequest(win(g === 'core' ? 'all' : [g]), method!, p, none, START)?.code, r).toBe('MAINTENANCE');
      if (g !== 'core') expect(gateRequest(win(['gacha']), method!, p, none, START), r).toBeNull();
    }
    expect(gateRequest(win('all'), 'POST', '/v1/links/resolve', none, START)).toBeNull();
    expect(gateRequest(win('all'), 'POST', '/v1/links/resolve', old, START)).toBeNull();
    // the web fallback page and the app-site association files are outside /v1: never gated (universal links keep verifying)
    for (const p of ['/l/AbCd2345EfGh', '/.well-known/apple-app-site-association', '/.well-known/assetlinks.json']) expect(gateRequest(win('all'), 'GET', p, old, START), p).toBeNull();
  });
  it('§46.2 names every Round 21 route family', () => {
    const p = read('contracts/protocol.md');
    const s46 = p.slice(p.indexOf('### 46.2'), p.indexOf('### 46.3'));
    for (const r of ['/v1/showcase', '/v1/links', '/v1/links/resolve', '/v1/friend-rooms/rematch', '/v1/release-notes', '/v1/calendar', '/l/', '/.well-known/']) expect(s46, r).toContain(r);
  });
});
