// REQ-RPT-001..020: 通報とブロック管理 (contracts/protocol.md §47).
import { describe, expect, it } from 'vitest';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { memoryOps } from '../src/ops/memoryOps.js';
import { authenticateAdmin, type AdminAuthConfig } from '../src/ops/admin.js';
import { sha256Hex } from '../src/ops/hash.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import type { Master } from '../src/domain/master.js';
import {
  CATEGORY_KINDS, REPORT_CATEGORIES, REPORT_CONTENT_KINDS, REPORTS_DEFAULTS, checkReportShape, reporterWeight, reportsConfig, reportsProblems, validateNote,
} from '../src/domain/reports.js';
import { BLOCK_EFFECTS, BLOCK_FEATURES } from '../src/domain/blocks.js';
import { DELETED_REPORTER, MemoryPlayerReportRepo, PlayerReportsCore } from '../src/ops/playerReports.js';
import { DELETION_STEPS } from '../src/domain/accountDeletion.js';
import { ensureFeed } from '../src/domain/teamFeed.js';
import { MemoryStableDirectory, StableService, stableConfig } from '../src/domain/stable.js';
import { stablePlayersFrom } from '../src/http/stablePorts.js';
import { createHorseFromTemplate } from '../src/domain/horses.js';
import { untranslated } from '../src/i18n/catalog.js';
import { m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 10, 3); // 12:00 JST
const DAY = 86_400_000;
const TOKENS = { viewer: 'viewer-token-0123456789', operator: 'operator-token-0123456789', admin: 'admin-token-0123456789' };
type Who = keyof typeof TOKENS;

async function setup(master: Master = m, opts: { raceMembers?: Record<string, string[]> } = {}) {
  let now = NOW;
  const kpi: { id: string; r: KpiRecord }[] = [];
  const repo = new MemoryPlayerRepo();
  const dir = new MemoryDirectory();
  const svc = new PlayerService(repo, { master, rng: seededRng(5), clock: () => now, verifiers: {}, onProfile: (p) => dir.putProfile(p), onKpi: (id, recs) => { for (const r of recs) kpi.push({ id, r }); } });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const ops = memoryOps(master, () => invoker);
  const held: string[] = [];
  const auth: AdminAuthConfig = { tokens: await Promise.all((Object.keys(TOKENS) as Who[]).map(async (name) => ({ name, role: name, sha256: await sha256Hex(TOKENS[name]) }))) };
  const c: AppContext = {
    master,
    authenticate: async (req) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
    player: () => invoker,
    match: {} as AppContext['match'],
    friends: makeFriendsService(() => invoker, dir),
    leaderboard: { board: async () => ({ entries: [], total: 0 }), myRank: async () => ({}) },
    timeAttack: {} as AppContext['timeAttack'],
    clock: () => now,
    race: {
      websocket: async () => new Response(null),
      report: async (raceId, pid) => { if (!(opts.raceMembers?.[raceId] ?? []).includes(pid)) return { ok: false }; held.push(raceId); return { ok: true }; },
      replay: async (id) => ({ raceId: id }),
    },
    paidBalance: async () => ({}),
    adminToken: undefined,
    parseStoreNotification: async () => null,
    ops: ops.api,
    authenticateAdmin: (req) => authenticateAdmin(req, auth),
    baseMaster: master,
  };
  const call = async (user: string, path: string, init: { method?: string; body?: unknown; lang?: string } = {}) => {
    const res = await handle(new Request(`https://x${path}`, {
      method: init.method ?? 'GET', headers: { 'x-test-user': user, 'content-type': 'application/json', 'idempotency-key': `k${Math.random()}`, ...(init.lang ? { 'accept-language': init.lang } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }), {}, c);
    return { status: res.status, body: (await res.json()) as any };
  };
  const admin = async (who: Who, method: string, path: string, body?: unknown) => {
    const res = await handle(new Request(`https://x${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKENS[who]}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), {}, c);
    return { status: res.status, body: (await res.json()) as any };
  };
  const join = async (id: string, name: string) => { await svc.setDisplayName(id, name); };
  const report = (u: string, body: Record<string, unknown>) => call(u, '/v1/reports', { method: 'POST', body: { source: 'profile', ...body } });
  return { svc, repo, dir, ops, c, call, admin, join, report, kpi, held, setNow: (t: number) => { now = t; }, now: () => now };
}

describe('report rules (REQ-RPT-002/003/015)', () => {
  it('ships a valid default config and rejects out-of-range ones', () => {
    expect(reportsProblems(m)).toEqual([]);
    expect(reportsConfig(m)).toEqual(REPORTS_DEFAULTS);
    const bad = (r: object) => reportsProblems({ progression: { ...m.progression, reports: r } } as Master).join('; ');
    expect(bad({ perDay: 0 })).toMatch(/perDay/);
    expect(bad({ perDay: 3, perTargetPerDay: 4 })).toMatch(/perTargetPerDay/);
    expect(bad({ lowSharePermille: 900, veryLowSharePermille: 800 })).toMatch(/lowSharePermille/);
    expect(bad({ lowWeight: 200, veryLowWeight: 300 })).toMatch(/veryLowWeight/);
    expect(bad({ resolvedKeepDays: 7 })).toMatch(/resolvedKeepDays/);
    expect(bad({ surprise: 1 })).toMatch(/unknown/);
  });

  it('every category maps to known kinds; mismatched kinds and missing / extra refs are 400', () => {
    for (const c of REPORT_CATEGORIES) for (const k of CATEGORY_KINDS[c]) expect(REPORT_CONTENT_KINDS).toContain(k);
    expect(() => checkReportShape('name', { kind: 'replay_title', raceId: 'r1' })).toThrow(/cannot be about/);
    expect(() => checkReportShape('cheating', { kind: 'display_name' })).toThrow(/cannot be about/);
    expect(() => checkReportShape('name', { kind: 'horse_name' })).toThrow(/horseId is required/);
    expect(() => checkReportShape('name', { kind: 'display_name', raceId: 'x' })).toThrow(/does not belong/);
    expect(() => checkReportShape('harassment', { kind: 'player' })).not.toThrow();
  });

  it('the note: NFKC, trimmed, length-checked, no control characters, empty = none', () => {
    expect(validateNote(m, '  ＡＢＣ  ')).toBe('ABC');
    expect(validateNote(m, '   ')).toBeNull();
    expect(validateNote(m, undefined)).toBeNull();
    expect(validateNote(m, 'あ'.repeat(100))).toHaveLength(100);
    expect(() => validateNote(m, 'あ'.repeat(101))).toThrow(/at most 100/);
    expect(() => validateNote(m, 'a\u0007b')).toThrow(/control/);
  });

  it('reporter weight drops only after minResolved reviews, by the dismissed share (REQ-RPT-014)', () => {
    const c = REPORTS_DEFAULTS;
    const st = (dismissed: number, actioned: number) => ({ reporterId: 'x', submitted: dismissed + actioned, dismissed, actioned, updatedAt: 0 });
    expect(reporterWeight(c, null)).toBe(1000);
    expect(reporterWeight(c, st(4, 0))).toBe(1000); // not enough reviews yet
    expect(reporterWeight(c, st(5, 0))).toBe(250);
    expect(reporterWeight(c, st(3, 2))).toBe(500); // 60%
    expect(reporterWeight(c, st(2, 3))).toBe(1000); // 40%
    expect(reporterWeight(c, st(8, 2))).toBe(250); // 80%
  });
});

describe('POST /v1/reports (REQ-RPT-001/004..009)', () => {
  it('snapshots the target text server-side; a later rename does not change what ops see', async () => {
    const w = await setup();
    await w.join('bad', 'ワルイナマエ');
    const r = await w.report('me', { targetId: 'bad', category: 'name', content: { kind: 'display_name' }, note: '  不快です ' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ received: true, blocked: false, remainingToday: 9 });
    await w.join('bad', 'イイナマエ');
    const q = await w.admin('viewer', 'GET', '/v1/admin/player-reports?status=open');
    expect(q.body.reports).toHaveLength(1);
    expect(q.body.reports[0]).toMatchObject({ targetId: 'bad', category: 'name', content: { kind: 'display_name', ref: null }, snapshot: { displayName: 'ワルイナマエ', text: 'ワルイナマエ', takenAt: NOW }, count: 1, score: 1000 });
    const d = await w.admin('viewer', 'GET', `/v1/admin/player-reports/${q.body.reports[0].id}`);
    expect(d.body.reporters).toEqual([expect.objectContaining({ reporterId: 'me', note: '不快です', weight: 1000, source: 'profile' })]);
  });

  it('collapses the same target + content + text; the same reporter twice counts once; the answer never says so', async () => {
    const w = await setup();
    await w.join('bad', 'ワルイナマエ');
    for (const u of ['a', 'b', 'c']) expect((await w.report(u, { targetId: 'bad', category: 'name', content: { kind: 'display_name' } })).body.received).toBe(true);
    const again = await w.report('a', { targetId: 'bad', category: 'harassment', content: { kind: 'display_name' } });
    expect(Object.keys(again.body).sort()).toEqual(['blocked', 'received', 'remainingToday']);
    const q = (await w.admin('viewer', 'GET', '/v1/admin/player-reports')).body.reports;
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ count: 3, score: 3000, categories: { name: 3 } });
    // a different text (after a rename) is a new report
    await w.join('bad', 'ベツノナマエ');
    await w.report('d', { targetId: 'bad', category: 'name', content: { kind: 'display_name' } });
    expect((await w.admin('viewer', 'GET', '/v1/admin/player-reports')).body.reports).toHaveLength(2);
  });

  it('rate limits per reporter and per target per game day; resets at 04:00 JST', async () => {
    const w = await setup();
    for (let i = 0; i < 11; i++) await w.join(`t${i}`, `タゲ${i}`);
    expect((await w.report('me', { targetId: 't0', category: 'harassment', content: { kind: 'player' } })).status).toBe(200);
    expect((await w.report('me', { targetId: 't0', category: 'other', content: { kind: 'player' } })).status).toBe(200);
    const third = await w.report('me', { targetId: 't0', category: 'name', content: { kind: 'display_name' } });
    expect(third.status).toBe(429);
    for (let i = 1; i <= 8; i++) expect((await w.report('me', { targetId: `t${i}`, category: 'harassment', content: { kind: 'player' } })).status).toBe(200);
    const over = await w.report('me', { targetId: 't9', category: 'harassment', content: { kind: 'player' } });
    expect(over.status).toBe(429);
    expect((await w.call('me', '/v1/reports/options')).body.remainingToday).toBe(0);
    w.setNow(Date.UTC(2026, 10, 10, 19)); // 04:00 JST on the 11th
    expect((await w.report('me', { targetId: 't9', category: 'harassment', content: { kind: 'player' } })).body.remainingToday).toBe(9);
  });

  it('refuses yourself, unknown players, private replays and missing content; nothing is counted', async () => {
    const w = await setup();
    await w.join('me', 'ワタシ');
    await w.join('t', 'アイテ');
    expect((await w.report('me', { targetId: 'me', category: 'harassment', content: { kind: 'player' } })).status).toBe(400);
    expect((await w.report('me', { targetId: 'ghost', category: 'harassment', content: { kind: 'player' } })).status).toBe(404);
    await w.svc.tx('t', null, (s) => { (s as any).myReplays = { saved: [{ raceId: 'r1', replayTitle: 'ひみつ', public: false }], moments: [], recent: [] }; });
    expect((await w.report('me', { targetId: 't', category: 'text', content: { kind: 'replay_title', raceId: 'r1' } })).status).toBe(404);
    expect((await w.report('me', { targetId: 't', category: 'name', content: { kind: 'horse_name', horseId: 'nope' } })).status).toBe(404);
    expect((await w.report('me', { targetId: 't', category: 'name', content: { kind: 'stable_name' } })).status).toBe(404);
    expect((await w.report('me', { targetId: 't', category: 'name', content: { kind: 'display_name' }, note: 'x'.repeat(101) })).status).toBe(400);
    expect((await w.report('me', { targetId: 't', category: 'name', content: { kind: 'display_name' }, extra: 1 })).status).toBe(400);
    expect((await w.call('me', '/v1/reports/options')).body.remainingToday).toBe(10);
    expect(w.kpi.filter((k) => k.r.name === 'report_submit')).toHaveLength(0);
  });

  it('snapshots horse names, stable names, public replay titles and photo captions', async () => {
    const w = await setup();
    await w.join('t', 'アイテ');
    const horseId = await w.svc.tx('t', null, (s, now) => {
      const h = createHorseFromTemplate(s, m.templates[0]!, now);
      h.name = 'ヘンナウマ';
      (s as any).stable = { layout: { theme: 'standard', name: 'ヘンナキュウシャ', slots: [], featuredHorseIds: [], updatedAt: now }, likes: 0, recv: { day: '', from: {}, ids: [] }, given: { day: '', count: 0, to: {} } };
      (s as any).myReplays = { saved: [{ raceId: 'r9', replayTitle: 'ヘンナタイトル', public: true }], moments: [], recent: [] };
      s.photos = { seq: 1, records: [{ id: 'ph_1', caption: 'ヘンナキャプション', source: { raceId: 'r8' } } as any] };
      return h.id;
    });
    await w.report('me', { targetId: 't', category: 'name', source: 'stable', content: { kind: 'horse_name', horseId } });
    await w.report('me', { targetId: 't', category: 'name', source: 'stable', content: { kind: 'stable_name' } });
    await w.report('u2', { targetId: 't', category: 'text', source: 'replay', content: { kind: 'replay_title', raceId: 'r9' } });
    await w.report('u2', { targetId: 't', category: 'text', source: 'photo', content: { kind: 'photo_caption', photoId: 'ph_1' } });
    const texts = (await w.admin('viewer', 'GET', '/v1/admin/player-reports')).body.reports.map((r: any) => [r.content.kind, r.snapshot.text, r.snapshot.raceId]);
    expect(texts).toEqual(expect.arrayContaining([['horse_name', 'ヘンナウマ', null], ['stable_name', 'ヘンナキュウシャ', null], ['replay_title', 'ヘンナタイトル', 'r9'], ['photo_caption', 'ヘンナキャプション', 'r8']]));
  });

  it('cheating needs a race the reporter was in; the replay is held and ops get the replay + verifier result', async () => {
    const w = await setup(m, { raceMembers: { race_1: ['me', 'cheat'] } });
    await w.join('cheat', 'ハヤスギ');
    expect((await w.report('outsider', { targetId: 'cheat', category: 'cheating', content: { kind: 'race', raceId: 'race_1' } })).body.error.code).toBe('NOT_ELIGIBLE');
    expect((await w.call('outsider', '/v1/reports/options')).body.remainingToday).toBe(10);
    const ok = await w.report('me', { targetId: 'cheat', category: 'cheating', source: 'replay', content: { kind: 'race', raceId: 'race_1' } });
    expect(ok.status).toBe(200);
    expect(w.held).toEqual(['race_1']);
    await w.ops.api.integrity.recordRace({ raceId: 'race_1', mode: 'ranked', at: NOW, suspects: ['cheat'], desync: [] });
    const id = (await w.admin('viewer', 'GET', '/v1/admin/player-reports?category=cheating')).body.reports[0].id;
    const d = await w.admin('viewer', 'GET', `/v1/admin/player-reports/${id}`);
    expect(d.body.race).toEqual({ raceId: 'race_1', replay: '/v1/admin/replays/race_1', integrity: { status: 'ok', events: [{ raceId: 'race_1', at: NOW, kind: 'suspect' }] } });
  });

  it('also block: the one block list, KPI rows report_submit + block_add with no target id or note', async () => {
    const w = await setup();
    await w.join('bad', 'ワルイ');
    const r = await w.report('me', { targetId: 'bad', category: 'harassment', source: 'team_feed', content: { kind: 'player' }, note: 'ひみつのメモ', alsoBlock: true });
    expect(r.body.blocked).toBe(true);
    expect(ensureFeed(await w.svc.state('me')).muted).toEqual(['bad']);
    const rows = w.kpi.filter((k) => k.id === 'me' && ['report_submit', 'block_add'].includes(k.r.name)).map((k) => [k.r.name, k.r.s1, k.r.s2 ?? null, k.r.s3 ?? null]);
    expect(rows).toEqual([['block_add', 'report', null, null], ['report_submit', 'harassment', 'player', 'team_feed']]);
    expect(JSON.stringify(w.kpi)).not.toMatch(/bad|ひみつ/);
  });

  it('the reported player never sees the reporter or that a report exists (REQ-RPT-008)', async () => {
    const w = await setup();
    await w.join('bad', 'ワルイ');
    await w.report('reporter_x', { targetId: 'bad', category: 'name', content: { kind: 'display_name' }, note: 'note' });
    for (const p of ['/v1/player', '/v1/activity', '/v1/blocks', '/v1/reports/options']) {
      const r = await w.call('bad', p);
      expect(JSON.stringify(r.body)).not.toMatch(/reporter_x/);
    }
    expect(JSON.stringify(await w.svc.state('bad'))).not.toMatch(/reporter_x/);
  });

  it('deletion pending reporters cannot report; reports can be switched off', async () => {
    const w = await setup({ ...m, progression: { ...m.progression, reports: { enabled: false } } } as Master);
    await w.join('t', 'アイテ');
    expect((await w.report('me', { targetId: 't', category: 'harassment', content: { kind: 'player' } })).status).toBe(404);
    expect((await w.call('me', '/v1/reports/options')).body).toMatchObject({ enabled: false, remainingToday: 0 });
    const w2 = await setup();
    await w2.join('t', 'アイテ');
    await w2.svc.tx('me', null, (s, now) => { s.deletion = { status: 'scheduled', requestedAt: now, dueAt: now + 14 * DAY } as any; });
    expect((await w2.report('me', { targetId: 't', category: 'harassment', content: { kind: 'player' } })).body.error.code).toBe('DELETION_PENDING');
  });

  it('options: categories with English labels, note limit', async () => {
    const w = await setup();
    const ja = (await w.call('me', '/v1/reports/options')).body;
    expect(ja.categories.map((c: any) => c.id)).toEqual([...REPORT_CATEGORIES]);
    expect(ja.categories[0]).toEqual({ id: 'name', label: '不適切な名前', kinds: ['display_name', 'horse_name', 'stable_name'] });
    const en = (await w.call('me', '/v1/reports/options', { lang: 'en' })).body;
    expect(en.categories.map((c: any) => c.label)).toEqual(['Inappropriate name', 'Inappropriate caption or text', 'Suspected cheating', 'Harassment', 'Other']);
    expect(untranslated(en)).toEqual([]);
  });
});

describe('block management (REQ-RPT-010..012/017)', () => {
  it('GET /v1/blocks lists current names (neutral for unknown), newest first, with the effects in JA and EN', async () => {
    const w = await setup();
    await w.join('a', 'アオ');
    await w.join('b', 'ベニ');
    for (const t of ['a', 'b', 'gone']) expect((await w.call('me', `/v1/blocks/${t}`, { method: 'PUT' })).status).toBe(200);
    await w.join('a', 'アオイ');
    const v = (await w.call('me', '/v1/blocks')).body;
    expect(v.blocked).toEqual([{ playerId: 'gone', name: 'プレイヤー' }, { playerId: 'b', name: 'ベニ' }, { playerId: 'a', name: 'アオイ' }]);
    expect(v).toMatchObject({ count: 3, max: 100 });
    expect(v.effects.map((e: any) => e.feature)).toEqual([...BLOCK_FEATURES]);
    const en = (await w.call('me', '/v1/blocks', { lang: 'en' })).body;
    expect(en.blocked[1].name).toBe('ベニ'); // player names are never translated
    expect(en.blocked[0].name).toBe('Player');
    expect(untranslated(en, new Set(['name']))).toEqual([]);
    expect(Object.keys(BLOCK_EFFECTS)).toEqual([...BLOCK_FEATURES]);
    // Round 17 integration: since Round 16 a block also keeps the two players out of the same hosted cup (REQ-CUP-006)
    expect(BLOCK_EFFECTS.cups).toContain('主催カップ');
    expect(BLOCK_EFFECTS.cups).toContain('同じカップに入れません');
  });

  it('PUT / DELETE are idempotent, share the team-feed mute list and write KPI only on change', async () => {
    const w = await setup();
    await w.call('me', '/v1/blocks/x', { method: 'PUT' });
    await w.call('me', '/v1/blocks/x', { method: 'PUT' });
    expect((await w.call('me', '/v1/teams/me/feed/mutes')).status).toBe(404); // no teams service here; the list is the state's
    expect(ensureFeed(await w.svc.state('me')).muted).toEqual(['x']);
    await w.svc.feedMute('me', 'y', true); // the team feed's mute path
    expect((await w.call('me', '/v1/blocks')).body.count).toBe(2);
    const del = await w.call('me', '/v1/blocks/x', { method: 'DELETE' });
    expect(del.body).toEqual({ playerId: 'x', blocked: false, count: 1, max: 100 });
    await w.call('me', '/v1/blocks/x', { method: 'DELETE' });
    const rows = w.kpi.filter((k) => k.r.name.startsWith('block_')).map((k) => [k.r.name, k.r.s1]);
    expect(rows).toEqual([['block_add', 'blocks'], ['block_add', 'team_feed'], ['block_remove', 'blocks']]);
    expect((await w.call('me', '/v1/blocks/me', { method: 'PUT' })).status).toBe(400);
  });

  it('マイ厩舎: blocked either way → 404 on visit and like, and hidden from my lists (REQ-RPT-012)', async () => {
    const w = await setup();
    const dir = new MemoryStableDirectory();
    const invoker: PlayerInvoker = w.c.player('x');
    const stable = new StableService(stablePlayersFrom(() => invoker), dir, () => stableConfig(m));
    for (const id of ['owner', 'fan', 'other']) {
      await w.svc.tx(id, null, (s) => { s.items.decor_flower_box = 1; });
      await stable.save(id, { theme: 'standard', name: `${id}厩舎`, slots: ['decor_flower_box'], featuredHorseIds: [] });
    }
    expect((await stable.visit('fan', 'owner')).stable.playerId).toBe('owner');
    await w.svc.blockSet('owner', 'fan', true, 'blocks'); // the owner blocks the fan
    await expect(stable.visit('fan', 'owner')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(stable.like('fan', 'owner', 'k1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await w.svc.blockSet('other', 'owner', true, 'blocks'); // other blocks the owner
    await expect(stable.visit('other', 'owner')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await stable.visits('other')).recommended.map((x) => x.playerId)).not.toContain('owner');
    expect((await stable.visits('fan')).recommended.map((x) => x.playerId)).toContain('owner'); // only the visit says 404
    await w.svc.blockSet('owner', 'fan', false, 'blocks');
    expect((await stable.visit('fan', 'owner')).stable.playerId).toBe('owner');
  });
});

describe('ops review (REQ-RPT-013/014)', () => {
  async function reported(w: Awaited<ReturnType<typeof setup>>, by: string[], body: Record<string, unknown>) {
    for (const u of by) await w.report(u, body);
    const list = (await w.admin('viewer', 'GET', '/v1/admin/player-reports?status=open')).body.reports;
    return list.find((r: any) => r.targetId === body.targetId && r.content.kind === (body.content as any).kind).id as string;
  }

  it('the queue orders by weighted score; filters by category, kind and target', async () => {
    const w = await setup();
    await w.join('one', 'ヒトリ');
    await w.join('many', 'オオゼイ');
    await reported(w, ['a'], { targetId: 'one', category: 'harassment', content: { kind: 'player' } });
    await reported(w, ['a', 'b', 'c'], { targetId: 'many', category: 'name', content: { kind: 'display_name' } });
    const q = (await w.admin('viewer', 'GET', '/v1/admin/player-reports')).body.reports;
    expect(q.map((r: any) => r.targetId)).toEqual(['many', 'one']);
    expect((await w.admin('viewer', 'GET', '/v1/admin/player-reports?category=harassment')).body.reports).toHaveLength(1);
    expect((await w.admin('viewer', 'GET', '/v1/admin/player-reports?kind=display_name')).body.reports[0].targetId).toBe('many');
    expect((await w.admin('viewer', 'GET', '/v1/admin/player-reports?targetId=one')).body.reports).toHaveLength(1);
    expect((await w.admin('viewer', 'GET', '/v1/admin/player-reports?category=nope')).status).toBe(400);
  });

  it('dismiss / warn / rename / hide / ban — audited, once only, ban for admins', async () => {
    const w = await setup();
    await w.join('bad', 'ワルイナマエ');
    await w.svc.tx('bad', null, (s) => {
      (s as any).myReplays = { saved: [{ raceId: 'r9', replayTitle: 'ヘンナタイトル', public: true, favorite: false }], moments: [], recent: [] };
      s.photos = { seq: 1, records: [{ id: 'ph_1', caption: 'ヘン', source: { raceId: 'r8' } } as any] };
    });
    const nameId = await reported(w, ['a'], { targetId: 'bad', category: 'name', content: { kind: 'display_name' } });
    const titleId = await reported(w, ['a'], { targetId: 'bad', category: 'text', content: { kind: 'replay_title', raceId: 'r9' } });
    const capId = await reported(w, ['b'], { targetId: 'bad', category: 'text', content: { kind: 'photo_caption', photoId: 'ph_1' } });
    const harassId = await reported(w, ['c'], { targetId: 'bad', category: 'harassment', content: { kind: 'player' } });

    expect((await w.admin('operator', 'POST', `/v1/admin/player-reports/${nameId}/action`, { action: 'hide', reason: 'try hide' })).status).toBe(400);
    const ren = await w.admin('operator', 'POST', `/v1/admin/player-reports/${nameId}/action`, { action: 'rename', reason: 'offensive name' });
    expect(ren.status).toBe(200);
    expect((await w.svc.state('bad')).profile.displayName).not.toBe('ワルイナマエ');
    expect((await w.admin('operator', 'POST', `/v1/admin/player-reports/${nameId}/action`, { action: 'dismiss', reason: 'again' })).status).toBe(409);

    await w.admin('operator', 'POST', `/v1/admin/player-reports/${titleId}/action`, { action: 'hide', reason: 'title' });
    const rec = (await w.svc.state('bad')).myReplays!.saved[0] as any;
    expect(rec).toMatchObject({ public: false, replayTitle: null, opsHidden: true });
    await expect(w.svc.replayUpdate('bad', 'r9', { public: true })).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
    await w.admin('operator', 'POST', `/v1/admin/player-reports/${capId}/action`, { action: 'hide', reason: 'caption' });
    expect((await w.svc.state('bad')).photos!.records[0]!.caption).toBeNull();

    expect((await w.admin('operator', 'POST', `/v1/admin/player-reports/${harassId}/action`, { action: 'ban', reason: 'ban', until: null })).status).toBe(403);
    const warn = await w.admin('operator', 'POST', `/v1/admin/player-reports/${harassId}/action`, { action: 'warn', reason: 'first warning' });
    expect(warn.status).toBe(200);
    const act = (await w.call('bad', '/v1/activity')).body.items;
    expect(act[0]).toMatchObject({ kind: 'ops_notice', category: 'events', link: { screen: 'safety', id: null }, actors: [] });
    expect(JSON.stringify(act)).not.toMatch(/"c"/);
    const actEn = (await w.call('bad', '/v1/activity', { lang: 'en' })).body;
    expect(actEn.items[0].text).toMatch(/A note from support/);

    const banId = await reported(w, ['d'], { targetId: 'bad', category: 'other', content: { kind: 'player' } });
    const ban = await w.admin('admin', 'POST', `/v1/admin/player-reports/${banId}/action`, { action: 'ban', reason: 'repeated', until: null });
    expect(ban.body.effect).toMatchObject({ playerId: 'bad', status: 'banned' });

    const audit = (await w.ops.api.auditQuery({ action: 'player_reports.action', limit: 50 })).filter((e) => e.result === 'ok');
    expect(audit.map((e) => (e.after as any).action)).toEqual(expect.arrayContaining(['rename', 'hide', 'hide', 'warn', 'ban']));
  });

  it('mass false reporting lowers the reporter weight in later reports (REQ-RPT-014)', async () => {
    const w = await setup();
    for (let i = 0; i < 6; i++) {
      await w.join(`v${i}`, `ヒガイ${i}`);
      const id = await reported(w, ['troll'], { targetId: `v${i}`, category: 'harassment', content: { kind: 'player' } });
      if (i < 5) await w.admin('operator', 'POST', `/v1/admin/player-reports/${id}/action`, { action: 'dismiss', reason: 'nothing wrong' });
    }
    await w.join('v9', 'ヒガイ9');
    w.setNow(NOW + DAY);
    await w.report('troll', { targetId: 'v9', category: 'harassment', content: { kind: 'player' } });
    const open = (await w.admin('viewer', 'GET', '/v1/admin/player-reports?status=open')).body.reports;
    expect(open.find((r: any) => r.targetId === 'v9').score).toBe(250);
    expect(open.find((r: any) => r.targetId === 'v5').score).toBe(250); // reported after the five dismissals
  });
});

describe('account deletion and retention (REQ-RPT-016)', () => {
  it('reports BY the deleted player are anonymised, ABOUT them kept and marked; resolved ones purge after resolvedKeepDays', () => {
    const repo = new MemoryPlayerReportRepo();
    const core = new PlayerReportsCore(repo);
    const c = REPORTS_DEFAULTS;
    const snap = (t: string) => ({ displayName: t, text: t, raceId: null, takenAt: NOW });
    const a = core.submit({ reporterId: 'leaver', targetId: 'x', category: 'name', source: 'profile', content: { kind: 'display_name' }, snapshot: snap('X'), note: '私の連絡先' }, NOW, c).report;
    const b = core.submit({ reporterId: 'y', targetId: 'leaver', category: 'harassment', source: 'profile', content: { kind: 'player' }, snapshot: snap('L'), note: null }, NOW, c).report;
    expect(core.forgetPlayer('leaver')).toEqual({ anonymised: 1, marked: 1 });
    expect(core.forgetPlayer('leaver')).toEqual({ anonymised: 0, marked: 0 }); // idempotent
    expect(repo.get(a.id)!.reporters[0]).toMatchObject({ reporterId: DELETED_REPORTER, note: null });
    expect(repo.stats('leaver')).toBeNull();
    expect(repo.get(b.id)).toMatchObject({ targetDeleted: true, snapshot: { text: 'L' } });
    expect(() => core.assertActionable(b.id, 'warn')).toThrow(/deleted the account/);
    core.resolve(b.id, 'dismiss', 'op', 'gone', NOW);
    core.resolve(a.id, 'dismiss', 'op', 'ok', NOW); // the anonymised reporter gets no stats row
    expect(repo.stats(DELETED_REPORTER)).toBeNull();
    core.submit({ reporterId: 'z', targetId: 'q', category: 'other', source: 'profile', content: { kind: 'player' }, snapshot: snap('Q'), note: null }, NOW + 364 * DAY, c);
    expect(repo.get(b.id)).not.toBeNull();
    core.submit({ reporterId: 'z', targetId: 'q2', category: 'other', source: 'profile', content: { kind: 'player' }, snapshot: snap('Q2'), note: null }, NOW + 366 * DAY, c);
    expect(repo.get(b.id)).toBeNull();
  });

  it('the deletion runs a reports step before finalize', () => {
    expect(DELETION_STEPS.indexOf('reports')).toBe(DELETION_STEPS.indexOf('cups') + 1); // Round 17 integration: after the Round 16 cups step
    expect(DELETION_STEPS.indexOf('reports')).toBeLessThan(DELETION_STEPS.indexOf('finalize'));
  });
});
