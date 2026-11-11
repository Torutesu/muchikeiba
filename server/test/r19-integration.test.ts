// Round 19 integration: §54 引き継ぎコード, §55 観戦中の応援, §56 画質・通信量, §57 ヒント against Rounds 17 / 18 (§46
// maintenance, §47 blocks, §48 help, §50 practice, §51 data export, account deletion, KPI, activity).
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { m } from './helpers.js';
import { clientEventSchema } from '../src/domain/kpi.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { transferConfig } from '../src/domain/transferCode.js';
import { MemoryTransferDirectory, TransferService } from '../src/domain/transferService.js';
import { DELETION_STEPS, runAccountDeletion, type DeletionPorts } from '../src/domain/accountDeletion.js';
import { EXEMPT_ROUTES } from '../src/domain/maintenance.js';
import { tipsIndex, tipsProblems } from '../src/domain/tips.js';
import { helpIndex } from '../src/domain/help.js';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const csFiles = (dir: string) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.cs')).map((f) => read(join(dir, f))).join('\n');

describe('KPI: every client event has a C# constructor and a query (cross-check incl. Round 19)', () => {
  const names = clientEventSchema.options.map((o) => (o.shape.name as unknown as { value: string }).value);
  it('Round 18 / 19 client events are in the schema', () => {
    for (const n of ['practice_start', 'practice_finish', 'hgoal_view', 'perf_setting_change', 'asset_predownload', 'tutorial_replay', 'tip_view', 'tip_context_open', 'cheer_send', 'cheer_seen']) expect(names).toContain(n);
  });
  it('each client event is built by Muchi.Client (AnalyticsEvent) and documented in docs/ops/kpi-queries.md', () => {
    const cs = csFiles('engine/Muchi.Client');
    const q = read('docs/ops/kpi-queries.md');
    expect(names.filter((n) => !cs.includes(`"${n}"`))).toEqual([]);
    expect(names.filter((n) => !q.includes(n))).toEqual([]);
  });
  it('the server events of Round 18 / 19 are documented too', () => {
    const q = read('docs/ops/kpi-queries.md');
    for (const n of ['dex_request', 'dex_ready', 'dex_download', 'qchat_post', 'hgoal_complete', 'transfer_issue', 'transfer_redeem']) expect(q, n).toContain(n);
  });
  it('master is loaded', () => { expect(m.progression.transfer).toBeTruthy(); });
});

describe('account deletion clears Round 19 state (REQ-TRF-017, §57 tips; §55 cheers and §56 settings keep nothing on the server)', () => {
  it('the transfer code and its audit rows leave the directory, the tips and transfer state go with the wipe', async () => {
    let now = Date.UTC(2026, 10, 11, 3);
    const repo = new MemoryPlayerRepo();
    const svc = new PlayerService(repo, { master: m, rng: seededRng(19), clock: () => now, verifiers: { fake: new FakeStoreVerifier() } });
    const dir = new MemoryTransferDirectory();
    const transfer = new TransferService({
      view: (u) => svc.transferView(u), checkIssue: (u) => svc.transferCheckIssue(u), issued: (u, c, mode) => svc.transferIssued(u, c, mode),
      revoke: (u, by) => svc.transferRevoke(u, by), progress: (u) => svc.transferProgress(u), redeemed: (u, c) => svc.transferRedeemed(u, c),
      noteFail: (u, r) => svc.transferFailed(u, r), admin: (u) => svc.adminTransfer(u),
      redeemReplay: (u, k) => svc.transferRedeemReplay(u, k), redeemRemember: (u, k, p, n) => svc.transferRedeemRemember(u, k, p, n),
    }, dir, () => transferConfig(m), { sign: async (uid) => `ct.${uid}` }, { clock: () => now, iterations: 1000, limitSalt: 'salt' });
    await svc.bootstrap('gone');
    await svc.grantPartner('gone', 'キエルウマ', 'c:p');
    await svc.tipsSeen('gone', ['whip_window']);
    await transfer.issue('gone', { mode: 'custom', password: 'Haneda2026!' });
    expect(dir.codes.size).toBe(1);
    expect(dir.rows.some((r) => r.playerId === 'gone')).toBe(true);
    const st = await svc.state('gone');
    expect(st.tips?.seen).toEqual(['whip_window']);
    expect(st.transfer?.code).toBeTruthy();
    const tok = (await svc.requestDeletion('gone', null)) as { confirmToken: string };
    await svc.requestDeletion('gone', tok.confirmToken);
    now += 15 * 86_400_000;
    const ports = {
      start: async (u: string) => { await svc.deletionStart(u); }, snapshot: (u: string) => svc.deletionSnapshot(u),
      markStep: async (u: string, step: never) => { await svc.deletionMarkStep(u, step); },
      friends: { removeFriend: async () => undefined, dropOutgoing: async () => undefined, dropIncoming: async () => undefined },
      // production: forgetInDirectory deletes the player's rows in their shard, transfer_codes and transfer_audit included
      directory: { forget: async (u: string) => { dir.forget(u); } }, leaderboards: { forget: async () => undefined, deleteGhosts: async () => undefined },
      team: { members: async () => [], leave: async () => undefined, transfer: async () => undefined, dropRequest: async () => undefined },
      finalize: (u: string) => svc.deletionFinalize(u), retain: async () => undefined, wipe: (u: string) => svc.wipe(u),
    } as unknown as DeletionPorts;
    const r = await runAccountDeletion(ports, 'gone', now);
    expect(r.done).toEqual(expect.arrayContaining(['stud', 'wipe']));
    expect(DELETION_STEPS).toContain('stud'); // the directory step
    expect(dir.codes.size).toBe(0);
    expect(dir.rows.filter((x) => x.playerId === 'gone')).toEqual([]);
    expect(repo.get('gone')).toBeNull();
    const sql = read('server/src/do/directory.ts');
    const forget = sql.slice(sql.indexOf('async forget(playerId: string)'), sql.indexOf('async codeOf('));
    expect(forget).toContain('DELETE FROM transfer_codes WHERE player_id = ?');
    expect(forget).toContain('DELETE FROM transfer_audit WHERE player_id = ?');
  });
});

describe('§46 maintenance × §54: transfer is account access — never gated (like sign-in, deletion and the data export)', () => {
  it('the transfer routes are exempt next to the deletion and data export routes', () => {
    for (const r of ['GET /v1/transfer/code', 'POST /v1/transfer/code', 'DELETE /v1/transfer/code', 'POST /v1/transfer/redeem', 'GET /v1/player/data-export', 'POST /v1/player/data-export'])
      expect(EXEMPT_ROUTES as readonly string[], r).toContain(r);
  });
});

describe('§57 tips × §48 help × Round 18 / 19 features (R19 integration)', () => {
  it('a tip card links the article of practice, horse goals, quick chat and spectator cheers; the practice setup has a "?" context', async () => {
    expect(tipsProblems(m, undefined, 6)).toEqual([]);
    const repo = new MemoryPlayerRepo();
    const svc = new PlayerService(repo, { master: m, rng: seededRng(3), clock: () => Date.UTC(2026, 10, 11, 3), verifiers: { fake: new FakeStoreVerifier() } });
    await svc.bootstrap('t1');
    const ja = tipsIndex(m, await svc.state('t1'), Date.UTC(2026, 10, 11, 3), 'ja', 6);
    const links = new Map(ja.tips.map((t) => [t.id, t.help?.articleId ?? null]));
    expect(Object.fromEntries(['practice_tip', 'goals_tip', 'qchat_tip', 'cheer_tip'].map((id) => [id, links.get(id)])))
      .toEqual({ practice_tip: 'practice_races', goals_tip: 'horse_goals', qchat_tip: 'quick_chat', cheer_tip: 'spectator_cheer' });
    expect(helpIndex(m, 'ja').contexts).toMatchObject({ practice: 'practice_races', privacy: 'data_export', storage: 'data_storage' });
    expect(read('engine/Muchi.Client/Help.cs')).toContain('Practice = "practice"');
    expect(read('tools/figma-prototype/site/app.js')).toMatch(/dataset\.helpContext = 'practice'/);
  });
});
