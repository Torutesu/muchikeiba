/**
 * Round 17 integration: how the four Round 17 features (§46 maintenance, §47 reports and blocks, §48 help center, §49
 * friend suggestions) meet Round 16 (§42 hosted cups, §43 recap, §44 roster, §45 next action) and each other.
 */
import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { seededRng } from '../src/domain/rng.js';
import { MemorySuggestDirectory } from '../src/domain/friendSuggest.js';
import { ReportsService } from '../src/domain/reportsService.js';
import { DELETED_REPORTER, MemoryPlayerReportRepo, PlayerReportsCore } from '../src/ops/playerReports.js';
import { InquiryIndex, MemoryInquiryIndexRepo } from '../src/ops/inquiries.js';
import { reportsConfig } from '../src/domain/reports.js';
import { DELETION_STEPS, runAccountDeletion, type DeletionPorts } from '../src/domain/accountDeletion.js';
import type { PlayerInvoker } from '../src/http/app.js';
import type { PlayerReportsApi } from '../src/http/admin.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 20, 3);

function world() {
  let now = T0;
  const repo = new MemoryPlayerRepo();
  const dir = new MemoryDirectory();
  const cards = new MemorySuggestDirectory(dir);
  const svc = new PlayerService(repo, {
    master: m, rng: seededRng(17), clock: () => now, verifiers: {}, onProfile: (p) => dir.putProfile(p),
    onFsugCard: async (id, card) => { if (card) await cards.put(card); else await cards.remove(id); },
  });
  const invoker = (): PlayerInvoker => ({ invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] });
  const reportRepo = new MemoryPlayerReportRepo();
  const core = new PlayerReportsCore(reportRepo);
  const queue: PlayerReportsApi = {
    submit: async (x, t, cfg) => core.submit(x, t, cfg), list: async (f) => core.list(f), get: async (id, cfg) => core.get(id, cfg),
    check: async (id, a) => core.assertActionable(id, a), resolve: async (id, a, by, note, t) => core.resolve(id, a, by, note, t),
    forget: async (uid) => core.forgetPlayer(uid),
  };
  const reports = new ReportsService(() => m, invoker, () => queue, async () => ({}), () => now);
  const inquiries = new InquiryIndex(new MemoryInquiryIndexRepo());
  return { svc, repo, dir, cards, core, reportRepo, reports, inquiries, now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('account deletion clears Round 17 state (REQ-RPT-016, REQ-HELP-018, REQ-FSUG-*; §46 keeps no player state)', () => {
  it('reports by the player are anonymised, reports about them kept and marked; inquiries, their index rows, the suggestion card and dismissals are gone', async () => {
    const w = world();
    await w.svc.setDisplayName('gone', 'キエル');
    await w.svc.setDisplayName('other', 'ノコル');
    // §47: a report each way (one from a cup lobby, with a note)
    await w.reports.submit('gone', { targetId: 'other', category: 'harassment', source: 'cup_lobby', content: { kind: 'player' }, note: 'ひどい言葉' });
    await w.reports.submit('other', { targetId: 'gone', category: 'name', source: 'profile', content: { kind: 'display_name' }, note: null });
    // §48: an inquiry (state) and its index row (ops)
    const t = await w.svc.helpInquirySubmit('gone', { category: 'bug', description: 'ボタンが反応しません。確認してください', refs: [], diagnostics: { appVersion: '1.0.0', platform: 'ios' } }, 'c:inq1');
    w.inquiries.upsert([{ ticketId: t.ticketId, playerId: 'gone', category: t.category, status: t.status, lang: t.lang, attachments: 0, createdAt: t.createdAt, updatedAt: t.updatedAt }]);
    // §49: a dismissal, and the published card
    await w.svc.fsugDismiss('gone', 'other', 'dismiss', 'none');
    const before = await w.svc.state('gone');
    expect((before as typeof before & { help?: { tickets: unknown[] } }).help?.tickets.length).toBe(1);
    expect(before.friendSuggest?.dismissed.map((d) => d.id)).toEqual(['other']);
    expect(w.cards.store.has('gone')).toBe(true);
    expect(w.inquiries.list({}).map((x) => x.playerId)).toEqual(['gone']);
    // §46: maintenance is remote config only — nothing in the player's state
    expect(Object.keys(before)).not.toContain('maintenance');

    const tok = (await w.svc.requestDeletion('gone', null)) as { confirmToken: string };
    await w.svc.requestDeletion('gone', tok.confirmToken);
    expect(w.cards.store.has('gone')).toBe(false); // a deletion-scheduled player is never suggested (card removed at once)
    w.advance(15 * DAY);
    const ports: DeletionPorts = {
      start: async (u) => { await w.svc.deletionStart(u); },
      snapshot: (u) => w.svc.deletionSnapshot(u),
      markStep: async (u, st) => { await w.svc.deletionMarkStep(u, st); },
      friends: { removeFriend: async () => undefined, dropOutgoing: async () => undefined, dropIncoming: async () => undefined },
      directory: { forget: async () => undefined },
      leaderboards: { forget: async () => undefined, deleteGhosts: async () => undefined },
      replays: { deleteAll: async () => undefined },
      reports: { forget: async (u) => w.core.forgetPlayer(u) },
      inquiries: { forget: async (u) => w.inquiries.forgetPlayer(u) },
      finalize: (u) => w.svc.deletionFinalize(u), retain: async () => undefined, wipe: (u) => w.svc.wipe(u),
    };
    const r = await runAccountDeletion(ports, 'gone', w.now());
    expect(DELETION_STEPS.indexOf('inquiries')).toBe(DELETION_STEPS.indexOf('reports') + 1);
    expect(r.done).toEqual(expect.arrayContaining(['reports', 'inquiries', 'wipe']));
    expect(w.repo.get('gone')).toBeNull();
    const [by] = w.reportRepo.byTarget('other');
    expect(by!.reporters.map((e) => [e.reporterId, e.note])).toEqual([[DELETED_REPORTER, null]]);
    expect(w.reportRepo.byTarget('gone')[0]!.targetDeleted).toBe(true);
    expect(w.inquiries.list({})).toEqual([]);
    expect(w.cards.store.has('gone')).toBe(false);
    expect(reportsConfig(m).enabled).toBe(true);
  });
});
