/**
 * Round 18 integration: how the four Round 18 features (§50 practice, §51 data export, §52 quick chat, §53 horse goals)
 * meet Round 17 (§46 maintenance, §47 reports and blocks, §48 help center, §49 friend suggestions) and each other.
 */
import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import type { PlayerState } from '../src/domain/player.js';
import type { PlayerInvoker } from '../src/http/app.js';
import { buildExportDocument, classifyKey, DEX_EXTENSION_KEYS } from '../src/domain/dataExport.js';
import { MemoryExportStore, runDataExportJob, type DataExportJobPorts } from '../src/domain/dataExportService.js';
import { MemoryPlayerReportRepo, PlayerReportsCore } from '../src/ops/playerReports.js';
import { ReportsService } from '../src/domain/reportsService.js';
import type { PlayerReportsApi } from '../src/http/admin.js';
import { DEFAULT_MAINTENANCE, endpointGroup, gateRequest, isExempt, jstToMs } from '../src/domain/maintenance.js';

const T0 = Date.UTC(2026, 11, 2, 3);

function world() {
  let now = T0;
  const repo = new MemoryPlayerRepo();
  const svc = new PlayerService(repo, { master: m, rng: seededRng(18), clock: () => now, verifiers: {} });
  const invoker = (): PlayerInvoker => ({ invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] });
  const reportRepo = new MemoryPlayerReportRepo();
  const core = new PlayerReportsCore(reportRepo);
  const queue: PlayerReportsApi = {
    submit: async (x, t, cfg) => core.submit(x, t, cfg), list: async (f) => core.list(f), get: async (id, cfg) => core.get(id, cfg),
    check: async (id, a) => core.assertActionable(id, a), resolve: async (id, a, by, note, t) => core.resolve(id, a, by, note, t),
    forget: async (uid) => core.forgetPlayer(uid),
  };
  const reports = new ReportsService(() => m, invoker, () => queue, async () => ({ ok: true }), () => now);
  return { svc, repo, core, reports, invoker, now: () => now, advance: (ms: number) => { now += ms; } };
}
type W = ReturnType<typeof world>;

/** A player with every Round 17 / 18 piece of state: a report made, an inquiry answered, a dismissed suggestion, a pinned goal. */
async function populated(w: W) {
  await w.svc.bootstrap('me');
  await w.svc.grantPartner('me', 'アイボウ', 'c:p');
  await w.svc.setDisplayName('other', 'アイテ');
  await w.svc.setDisplayName('me', 'ワタシ');
  await w.reports.submit('me', { targetId: 'other', category: 'harassment', source: 'profile', content: { kind: 'player' }, note: 'ひどい言葉でした' });
  const t = await w.svc.helpInquirySubmit('me', { category: 'bug', description: 'ボタンが反応しません。確認してください', refs: [], diagnostics: { appVersion: '1.0.0', platform: 'ios' } }, 'c:inq1');
  await w.svc.adminInquiryReply('me', t.ticketId, 'ご連絡ありがとうございます。確認しました', false, 'staff_secret', 'op:1');
  await w.svc.fsugDismiss('me', 'other', 'dismiss', 'none');
  const partner = (await w.svc.state('me')).horses[0]!;
  await w.svc.pinHorseGoal('me', partner.id);
  return { ticketId: t.ticketId, partnerId: partner.id };
}

describe('§51 data export × Round 17 / 18 state (REQ-DEX-006/007)', () => {
  it('every key Round 17 and 18 add is classified (friendSuggest, horseGoals, help, reports)', async () => {
    for (const k of ['friendSuggest', 'horseGoals', 'help', 'reports']) expect(classifyKey(k), k).not.toBeNull();
    expect(DEX_EXTENSION_KEYS as readonly string[]).toEqual(expect.arrayContaining(['help', 'reports']));
    const w = world();
    await populated(w);
    const s = await w.svc.state('me');
    expect(Object.keys(s)).toEqual(expect.arrayContaining(['friendSuggest', 'horseGoals', 'help', 'reports']));
    expect(Object.keys(s).filter((k) => classifyKey(k) === null)).toEqual([]);
  });

  it('the export has the inquiries (text + replies, no operator id), the reports made (no target), the suggestion settings and the goals — never other players\' data', async () => {
    const w = world();
    const { ticketId, partnerId } = await populated(w);
    await w.svc.dataExportRequest('me', 'ja', 'c:dex1');
    const store = new MemoryExportStore();
    const ports: DataExportJobPorts = {
      master: () => m, take: (u) => w.svc.dataExportTake(u), collect: (u) => w.svc.dataExportCollect(u),
      profiles: async (ids) => ids.filter((i) => i === 'other').map((i) => ({ playerId: i, displayName: 'アイテ' })),
      playerReportsMade: async (u) => w.core.madeBy(u),
      store, ready: (u, r, i) => w.svc.dataExportReady(u, r, i), failed: (u, r, why) => w.svc.dataExportFailed(u, r, why),
    };
    const job = await runDataExportJob(ports, 'me');
    expect(job.status).toBe('ready');
    const body = [...store.files.entries()].find(([k]) => k.endsWith('.json'))![1].body;
    const doc = JSON.parse(body) as ReturnType<typeof buildExportDocument>;
    expect(doc.unclassified).toEqual([]);
    // §48: the player's own inquiry and support's reply; the operator's id is an operator note
    const inq = doc.helpInquiries.items as { ticketId: string; description: string; messages: { from: string; content: string; by?: string }[] }[];
    expect(inq.map((x) => x.ticketId)).toEqual([ticketId]);
    expect(inq[0]!.description).toContain('ボタンが反応しません');
    expect(inq[0]!.messages.map((x) => x.from)).toEqual(['support']);
    expect(inq[0]!.messages[0]!.content).toContain('確認しました');
    expect(body).not.toContain('staff_secret');
    // §47: the report the player made — category, source, their own note, status; the reported player is not named
    const made = doc.reportsMade.items as { kind: string; category?: string; note?: string | null; status: string }[];
    expect(made).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'player', category: 'harassment', note: 'ひどい言葉でした', status: 'open' })]));
    expect(JSON.stringify(doc.reportsMade)).not.toContain('other');
    // §49: the opt-out and the players the player dismissed (current public name, like the block list)
    expect(doc.social.friendSuggest).toMatchObject({ hidden: false, dismissed: [{ playerId: 'other', name: 'アイテ', why: 'dismiss' }] });
    // §53: the goals and the pin
    expect(doc.horses.goals).toMatchObject({ pinned: partnerId });
    // §52 keeps nothing in the player's state; §50 (practice) stores nothing at all
    expect(Object.keys(await w.svc.state('me'))).not.toContain('practice');
  });
});

describe('§46 maintenance gate × Round 18 routes (Round 18 integration, §46.2)', () => {
  const START = jstToMs('2026-12-03T02:00')!;
  const all = { ...structuredClone(DEFAULT_MAINTENANCE), windows: [{ id: 'm18', startAtMs: START, endAtMs: START + 4 * 3_600_000, scope: 'all' as const, message: { ja: 'メンテナンスを行います。', en: 'Maintenance.' } }],
    clientVersions: { ios: { min: '1.2.0', recommended: '1.3.0', storeUrl: 'https://apps.apple.com/jp/app/id1234567890' }, android: { min: '1.2.0', recommended: '1.3.0', storeUrl: 'https://play.google.com/store/apps/details?id=jp.example.muchi' } } };
  const noHeaders = { platform: null, version: null, engine: null };
  const old = { platform: 'ios', version: '1.0.0', engine: null };
  it('groups: horse goals and the practice catalog are core, quick chat is teams (with the feed it posts into)', () => {
    for (const p of ['/v1/horses/h1/goals', '/v1/horse-goals/pin', '/v1/horse-goals/pinned', '/v1/practice/catalog']) expect(endpointGroup(p), p).toBe('core');
    for (const p of ['/v1/teams/me/quick-chat', '/v1/teams/me/feed/quick-chat']) expect(endpointGroup(p), p).toBe('teams');
    const teamsOnly = { ...all, windows: [{ ...all.windows[0]!, scope: ['teams' as const] }] };
    expect(gateRequest(teamsOnly, 'POST', '/v1/teams/me/feed/quick-chat', noHeaders, START)?.code).toBe('MAINTENANCE');
    expect(gateRequest(teamsOnly, 'GET', '/v1/practice/catalog', noHeaders, START)).toBeNull();
  });
  it('the data export (request, status, download) is a legal right: never gated, also from an outdated app', () => {
    for (const r of ['GET /v1/player/data-export', 'POST /v1/player/data-export', 'GET /v1/data-export/file']) {
      const [method, path] = r.split(' ');
      expect(isExempt(method!, path!), r).toBe(true);
      expect(gateRequest(all, method!, path!, noHeaders, START), r).toBeNull();
      expect(gateRequest(all, method!, path!, old, START), r).toBeNull();
    }
    // the rest of Round 18 closes with `all`
    for (const r of ['GET /v1/horses/h1/goals', 'PUT /v1/horse-goals/pin', 'GET /v1/practice/catalog', 'POST /v1/teams/me/feed/quick-chat']) {
      const [method, path] = r.split(' ');
      expect(gateRequest(all, method!, path!, noHeaders, START)?.code, r).toBe('MAINTENANCE');
    }
  });
});
