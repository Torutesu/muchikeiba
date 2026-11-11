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
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { MemoryLinkDirectory } from '../src/domain/linkService.js';
import { buildExportDocument, DEX_CLASSIFICATION } from '../src/domain/dataExport.js';
import { MemoryExportStore, runDataExportJob, type DataExportJobPorts } from '../src/domain/dataExportService.js';
import { runAccountDeletion, type DeletionPorts } from '../src/domain/accountDeletion.js';

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

describe('§51 data export and account deletion × Round 21 state', () => {
  const NOW = Date.UTC(2026, 10, 11, 3);
  async function seeded() {
    let now = NOW;
    const repo = new MemoryPlayerRepo();
    const svc = new PlayerService(repo, { master: m, rng: seededRng(21), clock: () => now, verifiers: {} });
    await svc.bootstrap('dx');
    await svc.tx('dx', null, (st) => {
      st.showcase = { horseId: null, pins: [], taTrackIds: [], phraseId: null, backgroundId: 'bg_default', updatedAt: now };
      st.releaseNotes = { seen: ['1.2.0'], baseline: '1.1.0' };
      st.calendar = { marks: [{ id: 'season_1', kind: 'season', until: now + 86_400_000 }] };
      return true;
    });
    const links = new MemoryLinkDirectory();
    await links.put({ token: 'AbCd2345EfGh', ownerId: 'dx', type: 'room', targetKey: 'room:123456', data: {}, day: '2026-11-11', createdAt: now, expiresAt: now + 86_400_000, revokedAt: null }, 30, now);
    return { svc, repo, links, now: () => now, advance: (ms: number) => { now += ms; } };
  }
  it('showcase (profile), releaseNotes and calendar (play) are exported and classified; the links the player made are listed without their tokens', async () => {
    const w = await seeded();
    const s = await w.svc.state('dx');
    const mine = (await w.links.listOf('dx', '2026-11-11', w.now())).links;
    const doc = buildExportDocument(m, s, { ledger: [], gacha: [], names: {}, reportsMade: [], kpiEvents: null, linksMade: mine }, 'dex_r21', 'ja', w.now());
    expect(doc.unclassified).toEqual([]);
    expect(DEX_CLASSIFICATION.showcase).toEqual({ section: 'profile' });
    expect(DEX_CLASSIFICATION.releaseNotes).toEqual({ section: 'play' });
    expect(DEX_CLASSIFICATION.calendar).toEqual({ section: 'play' });
    expect(doc.profile.showcase).toMatchObject({ backgroundId: 'bg_default' });
    expect(doc.play.releaseNotes).toEqual({ seen: ['1.2.0'], baseline: '1.1.0' });
    expect(doc.play.calendar).toEqual({ marks: [{ id: 'season_1', kind: 'season', until: w.now() + 86_400_000 }] });
    expect(doc.social.links).toEqual({ available: true, items: [{ type: 'room', createdAt: w.now(), expiresAt: w.now() + 86_400_000 }] });
    expect(JSON.stringify(doc)).not.toContain('AbCd2345EfGh');
    // the directory could not be read → said so, the export still completes
    const doc2 = buildExportDocument(m, s, { ledger: [], gacha: [], names: {}, reportsMade: [], kpiEvents: null, linksMade: null }, 'dex_r21b', 'ja', w.now());
    expect(doc2.social.links).toEqual({ available: false, items: [] });
    // §51.5 names the Round 21 parts
    const p = read('contracts/protocol.md');
    const s515 = p.slice(p.indexOf('### 51.5'), p.indexOf('### 51.6'));
    for (const k of ['§62', '§63', '§64', '§65']) expect(s515, k).toContain(k);
  });
  it('the export job reads the links through its optional port (a failing directory never fails the export)', async () => {
    const w = await seeded();
    const store = new MemoryExportStore();
    let ready: unknown = null;
    const ports: DataExportJobPorts = {
      master: () => m,
      take: async () => ({ requestId: 'dex_job', lang: 'ja', attempt: 1 }),
      collect: async (u) => ({ state: await w.svc.state(u), ledger: [], gacha: [], now: w.now() }),
      linksMade: async (u) => (await w.links.listOf(u, '2026-11-11', w.now())).links,
      store, ready: async (_u, _r, info) => { ready = info; }, failed: async () => undefined,
    };
    expect((await runDataExportJob(ports, 'dx')).status).toBe('ready');
    const body = JSON.parse([...store.files.values()].find((f) => f.contentType.startsWith('application/json'))!.body) as { social: { links: unknown } };
    expect(body.social.links).toMatchObject({ available: true, items: [{ type: 'room' }] });
    expect(ready).toBeTruthy();
    const broken: DataExportJobPorts = { ...ports, linksMade: async () => { throw new Error('down'); } };
    store.files.clear();
    expect((await runDataExportJob(broken, 'dx')).status).toBe('ready');
    const body2 = JSON.parse([...store.files.values()].find((f) => f.contentType.startsWith('application/json'))!.body) as { social: { links: unknown } };
    expect(body2.social.links).toEqual({ available: false, items: [] });
  });
  it('deletion wipes showcase, releaseNotes and calendar with the state, and the directory forgets the links (every link turns unavailable)', async () => {
    const w = await seeded();
    const tok = (await w.svc.requestDeletion('dx', null)) as { confirmToken: string };
    await w.svc.requestDeletion('dx', tok.confirmToken);
    w.advance(15 * 86_400_000);
    const ports = {
      start: async (u: string) => { await w.svc.deletionStart(u); }, snapshot: (u: string) => w.svc.deletionSnapshot(u),
      markStep: async (u: string, st: never) => { await w.svc.deletionMarkStep(u, st); },
      friends: { removeFriend: async () => undefined, dropOutgoing: async () => undefined, dropIncoming: async () => undefined },
      directory: { forget: async (u: string) => { w.links.forget(u); } }, leaderboards: { forget: async () => undefined, deleteGhosts: async () => undefined },
      finalize: (u: string) => w.svc.deletionFinalize(u), retain: async () => undefined, wipe: (u: string) => w.svc.wipe(u),
    } as unknown as DeletionPorts;
    const before = await w.svc.state('dx');
    expect([!!before.showcase, !!before.releaseNotes, !!before.calendar]).toEqual([true, true, true]);
    await runAccountDeletion(ports, 'dx', w.now());
    expect(w.repo.get('dx')).toBeNull();
    expect(await w.links.get('AbCd2345EfGh')).toBeNull();
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
