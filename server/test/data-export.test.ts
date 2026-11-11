import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import type { Master } from '../src/domain/master.js';
import type { PlayerState } from '../src/domain/player.js';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import {
  buildExportDocument, classifyKey, dataExportProblems, dexKey, DEX_CLASSIFICATION, DEX_EXTENSION_KEYS, DEX_SECTIONS, DEX_SUMMARY, DATA_EXPORT_DEFAULTS,
  serializeExport, summaryLines, type DataExportConfig,
} from '../src/domain/dataExport.js';
import { DataExportService, MemoryExportStore, runDataExportJob, signDexLink, sweepDataExports, verifyDexLink, type DataExportJobPorts } from '../src/domain/dataExportService.js';
import { runAccountDeletion, type DeletionPorts } from '../src/domain/accountDeletion.js';
import { catalogFor, localize, untranslated, PLAYER_TEXT_KEYS } from '../src/i18n/catalog.js';
import { hasJapanese } from '../src/i18n/locale.js';
import { kpiExportQuery } from '../src/push/kpiExport.js';
import { MemoryIntegrityRepo, IntegrityCore } from '../src/ops/integrity.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 10, 3);
const SECRET = 'test-ticket-secret-0123456789abcdef';
const cfg = m.progression.dataExport as DataExportConfig;
const withCfg = (patch: Partial<DataExportConfig> | null): Master => ({ ...m, progression: { ...m.progression, dataExport: patch === null ? undefined : { ...cfg, ...patch } } as Master['progression'] });
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as AppError).code; } return 'NO_ERROR'; };

function world(master: Master = m) {
  let now = T0;
  const kpi: KpiRecord[] = [];
  const repo = new MemoryPlayerRepo();
  const fake = new FakeStoreVerifier();
  const svc = new PlayerService(repo, { master, rng: seededRng(5), clock: () => now, verifiers: { fake }, onKpi: (_id, recs) => { kpi.push(...recs); } });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const store = new MemoryExportStore();
  const dex = new DataExportService(() => master, () => invoker, store, SECRET, () => now);
  const names: Record<string, string> = {};
  let failPut = 0;
  const failing = { ...store, put: async (k: string, b: string, ct: string) => { if (failPut > 0) { failPut--; throw new Error('r2 down'); } await store.put(k, b, ct); }, get: store.get.bind(store), delete: store.delete.bind(store) };
  const ports = (extra: Partial<DataExportJobPorts> = {}): DataExportJobPorts => ({
    master: () => master, take: (u) => svc.dataExportTake(u), collect: (u) => svc.dataExportCollect(u),
    profiles: async (ids) => ids.filter((i) => names[i]).map((i) => ({ playerId: i, displayName: names[i]! })),
    store: failing, ready: (u, r, i) => svc.dataExportReady(u, r, i), failed: (u, r, why) => svc.dataExportFailed(u, r, why), ...extra,
  });
  const sweep = (u: string) => sweepDataExports({ expiring: (x) => svc.dataExportExpiring(x), deleted: (x, k) => svc.dataExportDeleted(x, k), store }, u);
  let n = 0;
  const k = () => `c:/v1/player/data-export:${n++}`;
  const buy = (pid: string, productId: string, priceYen: number) => svc.purchase(pid, 'fake', productId, fake.issue({ transactionId: `fake:ORDER-${++n}`, productId, purchasedAt: now, priceYen }));
  const c = {
    master, authenticate: async (req: Request) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
    player: () => invoker, friends: makeFriendsService(() => invoker, new MemoryDirectory()), clock: () => now,
    paidBalance: async () => ({}), adminToken: 'x', parseStoreNotification: async () => null, dataExport: dex,
  } as unknown as AppContext;
  const http = async (method: string, path: string, user?: string, headers: Record<string, string> = {}) => {
    const res = await handle(new Request(`https://x${path}`, { method, headers: { ...(user ? { 'x-test-user': user } : {}), ...headers } }), {}, c);
    return res;
  };
  return {
    svc, repo, store, dex, kpi, k, buy, ports, sweep, names, c, http,
    failPuts: (x: number) => { failPut = x; },
    now: () => now, advance: (ms: number) => { now += ms; },
  };
}
type W = ReturnType<typeof world>;

/** A player with purchases, gacha, friends, a block, a stud borrow from another player, a rival week and a support flag naming a reporter. */
async function seeded(w: W) {
  await w.svc.bootstrap('u1');
  await w.svc.grantPartner('u1', 'アイボウ', 'c:p');
  await w.svc.setAge('u1', 1990, 1, false);
  await w.buy('u1', 'coin_480', 480);
  await w.svc.draw('u1', 'standard', 1, 'c:d1');
  await w.svc.setAccessibility('u1', { textSize: 'largest' });
  const s = await w.svc.state('u1');
  s.friends.ids.push('f1', 'f2');
  s.friends.incoming.push({ from: 'stranger', at: T0 });
  s.friends.outgoing.push({ to: 'f3', at: T0 });
  (s as PlayerState & { teamFeed?: { muted: string[]; postedIn: string[] } }).teamFeed = { muted: ['blocked1'], postedIn: ['team_a'] };
  s.supportFlags = ['team_feed_report:team_a:4:reporter_secret:spam'];
  s.stud = { listings: [], reservations: {}, settled: {}, lends: { date: '', byHorse: {}, earned: 0 }, applied: {}, outbox: [], borrows: { date: '', count: 0 },
    history: [{ opId: 'op1', role: 'borrowed', at: T0, ownerId: 'owner_secret', borrowerId: 'u1', horseId: 'h9', horseName: 'ヨソノウマ', fee: 10, paid: 10, foalId: 'f9' }] };
  s.referral = { installs: ['hash1'], attempts: [], invitedBy: { playerId: 'inviter_secret', code: 'ABCD-1234', at: T0, installHash: 'hash1', milestones: [] }, invitees: [{ playerId: 'invitee_secret', at: T0, counted: true, milestones: [] }], outbox: [] };
  s.push = { devices: [{ token: 'fcm-token-very-secret-XYZ123', platform: 'ios', addedAt: T0, lastSeenAt: T0 }], prefs: { categories: { season: true, friends: true, invites: true, events: true, comeback: true, gifts: true, reminders: false }, quietHours: null }, outbox: [], sent: { date: '', count: 0 }, seq: 0 };
  s.moderation = { status: 'ok', until: null, reason: 'detector-x internal note', at: T0 };
  await w.repo.put(s);
  w.names.f1 = 'トモダチ'; w.names.f2 = 'ナカマ'; w.names.f3 = 'シリアイ'; w.names.blocked1 = 'イヤナヒト';
}

async function requestAndBuild(w: W, uid = 'u1') {
  const r = await w.dex.request(uid, 'ja', w.k());
  const job = await runDataExportJob(w.ports(), uid);
  return { r, job };
}
const jsonOf = (w: W, uid: string, rid: string) => JSON.parse(w.store.files.get(dexKey(uid, rid, 'json'))!.body);

describe('REQ-DEX-006 every PlayerState key is classified (exported or excluded with a reason)', () => {
  const src = readFileSync(join(__dirname, '../src/domain/player.ts'), 'utf8');
  const body = src.slice(src.indexOf('export interface PlayerState {'), src.indexOf('\n}\n', src.indexOf('export interface PlayerState {')));
  const declared = [...body.matchAll(/^ {2}([a-zA-Z]+)\??:/gm)].map((x) => x[1]!);
  it('the interface keys', () => {
    expect(declared.length).toBeGreaterThan(70);
    expect(declared.filter((k2) => classifyKey(k2) === null)).toEqual([]);
  });
  it('keys modules add with `PlayerState & { key?: … }`', () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d, { withFileTypes: true })) { if (f.isDirectory()) walk(join(d, f.name)); else if (f.name.endsWith('.ts')) files.push(join(d, f.name)); } };
    walk(join(__dirname, '../src'));
    const ext = new Set<string>();
    for (const f of files) for (const x of readFileSync(f, 'utf8').matchAll(/PlayerState & \{ ?([a-zA-Z]+)\??:/g)) ext.add(x[1]!);
    expect([...ext].filter((k2) => classifyKey(k2) === null)).toEqual([]);
    for (const k2 of ext) if (!declared.includes(k2)) expect(DEX_EXTENSION_KEYS as readonly string[]).toContain(k2);
  });
  it('a populated state has no unclassified key, and every exported class names a real section', async () => {
    const w = world();
    await seeded(w);
    const s = await w.svc.state('u1');
    expect(Object.keys(s).filter((k2) => classifyKey(k2) === null)).toEqual([]);
    for (const c of Object.values(DEX_CLASSIFICATION)) if ('section' in c) expect(DEX_SECTIONS).toContain(c.section);
    const doc = buildExportDocument(m, s, { ledger: s.ledger, gacha: s.gachaLog?.entries ?? [], names: {}, reportsMade: [], kpiEvents: null }, 'dex_x', 'ja', w.now());
    expect(doc.unclassified).toEqual([]);
    expect(doc.notIncluded.map((x) => x.key)).toEqual(expect.arrayContaining(['idem', 'supportFlags', 'otherPlayersData']));
  });
  it('Round 19 integration: tips (seen ids) and transfer (history, code expiry — never the code id, password or hash) are exported', async () => {
    const w = world();
    await seeded(w);
    const s = await w.svc.state('u1');
    s.tips = { seen: ['whip_window', 'scout_pity_tip'] };
    s.transfer = {
      code: { id: 'ABCD2345EFGH', mode: 'custom', issuedAt: T0, expiresAt: T0 + 30 * DAY }, issues: { day: '2026-11-10', count: 1 },
      cutoffAt: T0 - DAY, lastRedeemedAt: T0 - DAY, history: [{ at: T0 - DAY, event: 'redeemed' }, { at: T0, event: 'issued', mode: 'custom' }],
      redeemedAs: { key: 'idem-secret-key', playerId: 'other_account_secret', displayName: 'ベツノカオ', at: T0 - DAY },
    };
    expect(classifyKey('tips')).toEqual({ section: 'play' });
    expect(classifyKey('transfer')).toEqual({ section: 'account' });
    const doc = buildExportDocument(m, s, { ledger: s.ledger, gacha: [], names: {}, reportsMade: [], kpiEvents: null }, 'dex_x', 'ja', w.now());
    expect(doc.unclassified).toEqual([]);
    expect(doc.play.tips).toEqual({ seen: ['whip_window', 'scout_pity_tip'] });
    expect(doc.account.transfer).toEqual({
      code: { mode: 'custom', issuedAt: T0, expiresAt: T0 + 30 * DAY, expired: false }, issuesToday: { day: '2026-11-10', count: 1 },
      lastTransferredAt: T0 - DAY, oldDeviceCutoffAt: T0 - DAY, history: [{ at: T0 - DAY, event: 'redeemed' }, { at: T0, event: 'issued', mode: 'custom' }],
    });
    const raw = JSON.stringify(doc);
    for (const secret of ['ABCD2345EFGH', 'ABCD-2345-EFGH', 'idem-secret-key', 'other_account_secret']) expect(raw).not.toContain(secret);
  });
  it('an unknown key shows up as unclassified (the test above would then fail)', async () => {
    const w = world();
    await seeded(w);
    const s = await w.svc.state('u1') as PlayerState & { brandNew?: number };
    s.brandNew = 1;
    expect(buildExportDocument(m, s, { ledger: [], gacha: [], names: null, reportsMade: null, kpiEvents: null }, 'dex_x', 'ja', w.now()).unclassified).toEqual(['brandNew']);
  });
});

describe('REQ-DEX-002..005 request, idempotency, async build, activity', () => {
  it('queues once, builds on the alarm, then is ready with signed links and one activity entry', async () => {
    const w = world();
    await seeded(w);
    const key = w.k();
    const a = await w.dex.request('u1', 'ja', key);
    expect(a).toMatchObject({ enabled: true, status: 'queued', created: true, canRequest: false, download: null });
    // the same key returns the stored answer; a new key while queued returns the running request (no second request)
    expect(await w.dex.request('u1', 'ja', key)).toMatchObject({ requestId: a.requestId, created: true });
    expect(await w.dex.request('u1', 'ja', w.k())).toMatchObject({ requestId: a.requestId, created: false });
    expect(w.kpi.filter((r) => r.name === 'dex_request')).toHaveLength(1);
    // nothing is built on the request path
    expect(w.store.files.size).toBe(0);
    const job = await runDataExportJob(w.ports(), 'u1');
    expect(job).toMatchObject({ status: 'ready', requestId: a.requestId });
    expect(await runDataExportJob(w.ports(), 'u1')).toEqual({ status: 'idle' });
    const v = await w.dex.view('u1');
    expect(v).toMatchObject({ status: 'ready', requestId: a.requestId, canRequest: false });
    expect(v.download!.json.url).toMatch(/^\/v1\/data-export\/file\?p=u1&r=dex_[a-z0-9]+&f=json&e=\d+&s=/);
    expect(v.download!.linkExpiresAt).toBe(w.now() + cfg.linkTtlMinutes * 60_000);
    expect(v.expiresAt).toBe(w.now() + cfg.keepDays * DAY);
    const act = await w.svc.activity('u1');
    expect(act.items.filter((x) => x.kind === 'data_export_ready')).toMatchObject([{ category: 'account', link: { screen: 'privacy', id: a.requestId } }]);
    const ready = w.kpi.filter((r) => r.name === 'dex_ready');
    expect(ready).toHaveLength(1);
    expect(ready[0]!.value).toBe(v.sizeBytes);
  });

  it('a build that died mid-way is taken again after the lease; a late report for an old request deletes its files', async () => {
    const w = world();
    await seeded(w);
    const a = await w.dex.request('u1', 'ja', w.k());
    expect(await w.svc.dataExportTake('u1')).toMatchObject({ requestId: a.requestId, attempt: 1 });
    expect(await w.svc.dataExportTake('u1')).toBeNull(); // leased
    w.advance(6 * 60_000);
    expect(await w.svc.dataExportTake('u1')).toMatchObject({ attempt: 2 });
    // a build that keeps dying is given up after maxAttempts leases (never retried forever)
    for (let i = 3; i <= cfg.maxAttempts; i++) { w.advance(6 * 60_000); expect(await w.svc.dataExportTake('u1')).toMatchObject({ attempt: i }); }
    w.advance(6 * 60_000);
    expect(await w.svc.dataExportTake('u1')).toBeNull();
    expect(await w.dex.view('u1')).toMatchObject({ status: 'failed', canRequest: true });
    expect(await w.svc.dataExportReady('u1', 'dex_old', { sizeBytes: 1, summaryBytes: 1, sha256: 'x', truncated: 0 })).toBe(false);
    expect((await w.svc.state('u1')).dataExport!.pendingDeletes).toEqual(expect.arrayContaining([dexKey('u1', 'dex_old', 'json'), dexKey('u1', 'dex_old', 'summary')]));
  });

  it('a failing build backs off, gives up after maxAttempts, and the player may ask again at once', async () => {
    const w = world(withCfg({ maxAttempts: 2 }));
    await seeded(w);
    await w.dex.request('u1', 'ja', w.k());
    w.failPuts(10);
    expect(await runDataExportJob(w.ports(), 'u1')).toMatchObject({ status: 'failed' });
    expect(await w.dex.view('u1')).toMatchObject({ status: 'queued' });
    expect(await runDataExportJob(w.ports(), 'u1')).toEqual({ status: 'idle' }); // backing off (1 min)
    w.advance(61_000);
    expect(await runDataExportJob(w.ports(), 'u1')).toMatchObject({ status: 'failed' });
    expect(await w.dex.view('u1')).toMatchObject({ status: 'failed', canRequest: true, nextAvailableAt: null });
    w.failPuts(0);
    expect(await w.dex.request('u1', 'ja', w.k())).toMatchObject({ status: 'queued', created: true });
  });
});

describe('REQ-DEX-004/011 cooldown, expiry and deletion of the files', () => {
  it('once per cooldownDays (counted from a ready request); files are deleted after keepDays', async () => {
    const w = world(withCfg({ keepDays: 3, cooldownDays: 7 }));
    await seeded(w);
    const { r } = await requestAndBuild(w);
    expect(w.store.files.size).toBe(2);
    // while ready: asking again returns the same export
    expect(await w.dex.request('u1', 'ja', w.k())).toMatchObject({ requestId: r.requestId, created: false });
    w.advance(3 * DAY);
    expect(await w.dex.view('u1')).toMatchObject({ status: 'expired', download: null, canRequest: false, nextAvailableAt: T0 + 7 * DAY });
    const err = await w.dex.request('u1', 'ja', w.k()).catch((e: AppError) => e);
    expect(err).toMatchObject({ code: 'DATA_EXPORT_COOLDOWN', status: 429, details: { availableAt: T0 + 7 * DAY } });
    expect(await w.sweep('u1')).toBe(2);
    expect(w.store.files.size).toBe(0);
    expect(await w.sweep('u1')).toBe(0);
    w.advance(4 * DAY);
    expect(await w.dex.request('u1', 'ja', w.k())).toMatchObject({ created: true, status: 'queued' });
  });

  it('a signed link: works for its file only, fails when tampered, expired, or the export expired', async () => {
    const w = world();
    await seeded(w);
    const { r } = await requestAndBuild(w);
    const v = await w.dex.view('u1');
    const res = await w.http('GET', v.download!.json.url); // no auth header: the signature is the authorisation
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="muchi-issen-data-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const doc = await res.json() as Record<string, unknown>;
    expect(doc).toMatchObject({ format: 'muchi-issen/personal-data-export', version: 1, playerId: 'u1', requestId: r.requestId });
    const sum = await w.http('GET', v.download!.summary.url);
    expect(sum.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await sum.text()).toContain('プレイヤーID: u1');
    expect(w.kpi.filter((x) => x.name === 'dex_download').map((x) => [x.s1, x.isFirst])).toEqual([['json', true], ['summary', false]]);
    // tampering with the player id or the file kind breaks the signature
    expect((await w.http('GET', v.download!.json.url.replace('p=u1', 'p=u2'))).status).toBe(403);
    expect((await w.http('GET', v.download!.json.url.replace('f=json', 'f=summary'))).status).toBe(403);
    expect((await w.http('GET', '/v1/data-export/file?p=u1')).status).toBe(403);
    w.advance(cfg.linkTtlMinutes * 60_000);
    expect((await w.http('GET', v.download!.json.url)).status).toBe(410);
    // a fresh link from the status works again until the export itself expires
    const v2 = await w.dex.view('u1');
    expect((await w.http('GET', v2.download!.json.url)).status).toBe(200);
    const late = await signDexLink(SECRET, 'u1', r.requestId!, 'json', w.now() + cfg.keepDays * DAY + DAY);
    w.advance(cfg.keepDays * DAY);
    expect((await w.http('GET', late)).status).toBe(404);
  });

  it('a link never outlives the export, and verifyDexLink checks shape, signature and time', async () => {
    const exp = T0 + 60_000;
    const url = await signDexLink(SECRET, 'u1', 'dex_abc', 'json', exp);
    const q = new URL(`https://x${url}`).searchParams;
    expect(await verifyDexLink(SECRET, q, T0)).toEqual({ playerId: 'u1', requestId: 'dex_abc', f: 'json' });
    expect(await code(verifyDexLink('other-secret', q, T0))).toBe('LINK_INVALID');
    expect(await code(verifyDexLink(SECRET, q, exp))).toBe('LINK_EXPIRED');
  });
});

describe('REQ-DEX-007/008 the document: complete, own data only, paid and free apart', () => {
  it('has every section, keeps paid / free apart, and nothing private about other players', async () => {
    const w = world();
    await seeded(w);
    const { r } = await requestAndBuild(w);
    const doc = jsonOf(w, 'u1', r.requestId!);
    for (const sec of DEX_SECTIONS) expect(doc).toHaveProperty(sec);
    expect(doc.sections).toEqual([...DEX_SECTIONS]);
    expect(doc.wallet.paid).toBeGreaterThan(0);
    expect(doc.coinHistory.paid.every((x: { currency: string }) => x.currency === 'paid')).toBe(true);
    expect(doc.coinHistory.free.every((x: { currency: string }) => x.currency === 'free')).toBe(true);
    expect(doc.purchases.items[0]).toMatchObject({ productId: 'coin_480', priceYen: 480, storeTransactionId: expect.stringMatching(/^fake:ORDER-/) });
    expect(doc.gacha.items).toHaveLength(1);
    expect(doc.settings.accessibility).toMatchObject({ textSize: 'largest' });
    expect(doc.horses.items.map((h: { name: string }) => h.name)).toContain('アイボウ');
    expect(doc.social.friends).toEqual([{ playerId: 'f1', name: 'トモダチ' }, { playerId: 'f2', name: 'ナカマ' }]);
    expect(doc.social.friendRequestsSent).toEqual([{ playerId: 'f3', name: 'シリアイ', at: T0 }]);
    expect(doc.social.friendRequestsReceived).toBe(1);
    expect(doc.social.blocks).toEqual([{ playerId: 'blocked1', name: 'イヤナヒト' }]);
    expect(doc.devices).toEqual([{ platform: 'ios', addedAt: T0, lastSeenAt: T0, locale: null, pushTokenEnd: '…XYZ123' }]);
    expect(doc.account.moderation).toEqual({ status: 'ok', until: null, at: T0 });
    expect(doc.account.age).toMatchObject({ birthYear: 1990 });
    const raw = JSON.stringify(doc);
    // other players' ids / private data, operator notes and secrets never appear
    for (const secret of ['stranger', 'reporter_secret', 'owner_secret', 'inviter_secret', 'invitee_secret', 'fcm-token-very-secret', 'detector-x']) expect(raw).not.toContain(secret);
    expect(doc.play.stud.history).toEqual([{ role: 'borrowed', at: T0, horseId: 'h9', horseName: 'ヨソノウマ', fee: 10, paid: 10, foalId: 'f9' }]);
    expect(doc.reportsMade).toEqual({ available: false, items: [], today: null });
    expect(doc.analytics.events.available).toBe(false);
    expect(doc.unclassified).toEqual([]);
  });

  it('reports the player made (no resolution notes), analytics rows and a directory that cannot be reached', async () => {
    const w = world();
    await seeded(w);
    const core = new IntegrityCore(new MemoryIntegrityRepo());
    core.addReport('race_1', 'u1', T0);
    core.addReport('race_2', 'someone_else', T0);
    core.resolveReport('rep_race_1_u1', 'operator note about another player', 'ops-bob', T0 + 1);
    await w.dex.request('u1', 'ja', w.k());
    await runDataExportJob(w.ports({
      reportsMade: async (u) => core.reportsBy(u), kpiEvents: async () => ({ rows: [{ event: 'first_open', timestamp: '2026-11-10 03:00:00' }], windowDays: 90 }),
      profiles: async () => { throw new Error('directory down'); },
    }), 'u1');
    const v = await w.dex.view('u1');
    const doc = jsonOf(w, 'u1', v.requestId!);
    expect(doc.reportsMade).toEqual({ available: true, items: [{ kind: 'race', raceId: 'race_1', at: T0, status: 'resolved' }], today: null });
    expect(JSON.stringify(doc)).not.toContain('operator note');
    expect(JSON.stringify(doc)).not.toContain('ops-bob');
    expect(doc.analytics.events).toEqual({ available: true, windowDays: 90, rows: [{ event: 'first_open', timestamp: '2026-11-10 03:00:00' }] });
    expect(doc.social.namesAvailable).toBe(false);
    expect(doc.social.friends).toEqual([{ playerId: 'f1', name: null }, { playerId: 'f2', name: null }]);
  });

  it('streaming-friendly layout and the size cap (oldest coin rows first, listed in truncated and the summary)', async () => {
    const w = world();
    await seeded(w);
    const s = await w.svc.state('u1');
    for (let i = 0; i < 400; i++) s.ledger.push({ seq: 1000 + i, at: T0 - (400 - i) * 1000, kind: 'grant', currency: 'free', delta: 1, balanceAfter: i, reason: 'login bonus', ref: `x${i}` });
    const doc = buildExportDocument(m, s, { ledger: s.ledger, gacha: [], names: {}, reportsMade: [], kpiEvents: null }, 'dex_cap', 'ja', w.now());
    const full = serializeExport(structuredClone(doc), 50_000_000);
    expect(full.truncated).toBe(0);
    expect(full.body.split('\n')[1]).toBe('"format":"muchi-issen/personal-data-export",');
    expect(JSON.parse(full.body)).toEqual(JSON.parse(JSON.stringify(doc)));
    const capped = serializeExport(doc, full.bytes - 20_000);
    expect(capped.bytes).toBeLessThanOrEqual(full.bytes - 20_000);
    expect(capped.truncated).toBeGreaterThan(0);
    const parsed = JSON.parse(capped.body);
    expect(parsed.truncated).toEqual([{ section: 'coinHistory', omitted: capped.truncated }]);
    expect(parsed.coinHistory.free[0].ref).not.toBe('C-1000'); // the oldest went first
    expect(summaryLines(doc).some((l) => l.label.includes(`${capped.truncated}行省略`))).toBe(true);
  });
});

describe('REQ-DEX-013 account deletion', () => {
  it('works while the deletion is scheduled, is refused once it runs, and the run deletes the files', async () => {
    const w = world();
    await seeded(w);
    const tok = await w.svc.requestDeletion('u1', null) as { confirmToken: string };
    await w.svc.requestDeletion('u1', tok.confirmToken);
    const { r } = await requestAndBuild(w);
    expect(await w.dex.view('u1')).toMatchObject({ status: 'ready', deletionScheduled: true, deletionNote: expect.any(String) });
    expect(w.store.files.size).toBe(2);
    await w.svc.deletionStart('u1');
    expect(await w.dex.view('u1')).toMatchObject({ canRequest: false });
    const deleted: string[][] = [];
    const ports = {
      start: async () => undefined, snapshot: (u: string) => w.svc.deletionSnapshot(u), markStep: async (u: string, st: never) => { await w.svc.deletionMarkStep(u, st); },
      friends: { removeFriend: async () => undefined, dropOutgoing: async () => undefined, dropIncoming: async () => undefined },
      directory: { forget: async () => undefined }, leaderboards: { forget: async () => undefined, deleteGhosts: async () => undefined },
      dataExports: { deleteAll: async (keys: string[]) => { deleted.push(keys); await w.store.delete(keys); } },
      finalize: (u: string) => w.svc.deletionFinalize(u), retain: async () => undefined, wipe: (u: string) => w.svc.wipe(u),
    } as unknown as DeletionPorts;
    await runAccountDeletion(ports, 'u1', w.now());
    expect(deleted).toEqual([[dexKey('u1', r.requestId!, 'json'), dexKey('u1', r.requestId!, 'summary')]]);
    expect(w.store.files.size).toBe(0);
    // a late link / sweep never re-creates the wiped account
    const url = await signDexLink(SECRET, 'u1', r.requestId!, 'json', w.now() + 60_000);
    expect((await w.http('GET', url)).status).toBe(404);
    expect(await w.sweep('u1')).toBe(0);
    expect(await w.svc.dataExportTake('u1')).toBeNull();
    expect(await w.repo.get('u1')).toBeNull();
  });

  it('a request during the deletion run is refused', async () => {
    const w = world();
    await seeded(w);
    const tok = await w.svc.requestDeletion('u1', null) as { confirmToken: string };
    await w.svc.requestDeletion('u1', tok.confirmToken);
    await w.svc.deletionStart('u1');
    expect(await code(w.dex.request('u1', 'ja', w.k()))).toBe('DELETION_PENDING');
  });
});

describe('REQ-DEX-012/014/015 HTTP, ops, English', () => {
  it('auth, idempotency key, own data only; disabled → 404', async () => {
    const w = world();
    await seeded(w);
    expect((await w.http('GET', '/v1/player/data-export')).status).toBe(401);
    expect((await w.http('POST', '/v1/player/data-export', 'u1')).status).toBe(400); // Idempotency-Key required
    const post = await w.http('POST', '/v1/player/data-export', 'u1', { 'idempotency-key': 'a1' });
    expect(post.status).toBe(200);
    expect(await post.json()).toMatchObject({ status: 'queued', created: true });
    // another player sees only their own (nothing requested)
    expect(await (await w.http('GET', '/v1/player/data-export', 'u2')).json()).toMatchObject({ status: 'none', requestId: null });
    const off = world(withCfg({ enabled: false }));
    off.c.master = withCfg({ enabled: false });
    expect((await off.http('GET', '/v1/player/data-export', 'u1')).status).toBe(404);
  });

  it('English: the status, the activity text and the summary have no Japanese left (player text kept)', async () => {
    const w = world();
    await seeded(w);
    await w.http('POST', '/v1/player/data-export', 'u1', { 'idempotency-key': 'en1', 'accept-language': 'en' });
    await runDataExportJob(w.ports(), 'u1');
    const v = await (await w.http('GET', '/v1/player/data-export', 'u1', { 'accept-language': 'en' })).json() as { statusText: string; requestId: string };
    expect(untranslated(v)).toEqual([]);
    expect(v.statusText).toBe('Ready to download');
    const act = await (await w.http('GET', '/v1/activity', 'u1', { 'accept-language': 'en' })).json() as { items: { kind: string; text: string }[] };
    expect(act.items.find((x) => x.kind === 'data_export_ready')!.text).toBe('Your data download is ready');
    const summary = w.store.files.get(dexKey('u1', v.requestId, 'summary'))!.body;
    const labels = summary.split('\n').filter(Boolean).map((l) => l.split(': ')[0]!);
    expect(labels.filter((l) => hasJapanese(l))).toEqual([]);
    expect(summary).toContain('Display name: '); // the value (a player name) is never translated
    const doc = jsonOf(w, 'u1', v.requestId);
    expect(doc.language).toBe('en');
    expect(untranslated(doc.coinHistory, PLAYER_TEXT_KEYS)).toEqual([]);
    for (const t of Object.values(DEX_SUMMARY)) expect(hasJapanese(localize(t.replace('{n}', '3'), 'en', catalogFor(m)))).toBe(false);
  });

  it('ops see status and the audit log, never contents, links or file keys', async () => {
    const w = world();
    await seeded(w);
    await requestAndBuild(w);
    const v = await w.dex.view('u1');
    await w.http('GET', v.download!.json.url);
    const a = await w.svc.dataExportAdmin('u1');
    expect(a).toMatchObject({ status: 'ready', downloads: 1, attempts: 1 });
    expect(a.audit.map((x) => x.event)).toEqual(['downloaded', 'ready', 'building', 'requested']);
    const raw = JSON.stringify(a);
    expect(raw).not.toContain('private/data-export');
    expect(raw).not.toContain('/v1/data-export/file');
    expect(raw).not.toContain('アイボウ');
  });
});

describe('REQ-DEX-016 config and the analytics query', () => {
  it('validates ranges and keepDays ≤ cooldownDays', () => {
    expect(dataExportProblems(m)).toEqual([]);
    expect(dataExportProblems(withCfg({ cooldownDays: 0 }))).toContain('progression.dataExport.cooldownDays must be an integer 1..30');
    expect(dataExportProblems(withCfg({ keepDays: 10, cooldownDays: 7 }))).toEqual(['progression.dataExport.keepDays must be at most cooldownDays']);
    expect(dataExportProblems(withCfg({ maxBytes: 10 }))).toHaveLength(1);
    expect(dataExportProblems({ progression: { ...m.progression, dataExport: { enabled: true, extra: 1 } as never } })).toEqual(['progression.dataExport.extra is unknown']);
    expect(DATA_EXPORT_DEFAULTS.keepDays).toBeLessThanOrEqual(DATA_EXPORT_DEFAULTS.cooldownDays);
  });
  it('the analytics SQL only takes a hashed id', () => {
    expect(kpiExportQuery('0123456789abcdef')).toContain("WHERE blob2 = '0123456789abcdef'");
    expect(() => kpiExportQuery("x' OR 1=1 --")).toThrow();
  });
});
