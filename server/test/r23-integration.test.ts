// Round 23 integration: §70 ログイン中の端末, §71 血統図と系統, §72 レースの見どころ, §73 お問い合わせ履歴 against each other
// and against Rounds 17–21 (§46 maintenance, §47 blocks, §48 help, §51 data export, §57 tips, §58 KPI consent and the one
// prompt table, §63 links, account deletion, deploy §7.1).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clientEventSchema } from '../src/domain/kpi.js';
import { KPI_ESSENTIAL, KPI_EVENT_CLASS } from '../src/domain/kpiConsent.js';
import { EXEMPT_ROUTES, endpointGroup } from '../src/domain/maintenance.js';
import { routes } from '../src/http/app.js';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { helpArticle, helpProblems } from '../src/domain/help.js';
import { buildCheckinInput } from '../src/domain/devices.js';
import { buildExportDocument, DEX_CLASSIFICATION } from '../src/domain/dataExport.js';
import { runAccountDeletion, type DeletionPorts } from '../src/domain/accountDeletion.js';
import { LinkService, MemoryLinkDirectory } from '../src/domain/linkService.js';
import { linksConfig, replayLinkRow } from '../src/domain/deepLinks.js';
import { maintenanceOf } from '../src/domain/maintenance.js';
import { dayRule } from '../src/domain/time.js';
import { memoryOps } from '../src/ops/memoryOps.js';
import type { PlayerInvoker } from '../src/http/app.js';
import type { HorseInstance, PlayerState } from '../src/domain/player.js';
import { createHorseFromTemplate } from '../src/domain/horses.js';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const NOW = Date.UTC(2026, 10, 12, 3);
const sec = (ms: number) => Math.floor(ms / 1000);

const R23_KPI = {
  devices: ['device_signout', 'new_device_notice', 'device_list_view'],
  pedigree: ['pedigree_view', 'bloodline_view'],
  highlights: ['highlight_view', 'highlight_share'],
  tickets: ['ticket_player_reply', 'ticket_reopen', 'ticket_resolved', 'ticket_reply_view'],
};
const ALL_R23_KPI = Object.values(R23_KPI).flat();
const R23_ESSENTIAL = ['device_signout', 'new_device_notice', 'ticket_player_reply', 'ticket_reopen', 'ticket_resolved'];

describe('§58 KPI classification of the Round 23 events (REQ-CNS-012, §58.7)', () => {
  it('every Round 23 event is classified; the account-access audit and the support record are essential, the rest optional', () => {
    for (const n of ALL_R23_KPI) {
      expect(KPI_EVENT_CLASS[n], n).toBe(R23_ESSENTIAL.includes(n) ? 'essential' : 'optional');
      expect(n in KPI_ESSENTIAL, n).toBe(R23_ESSENTIAL.includes(n));
    }
  });
  it('§58.7 lists every Round 23 event with its class; the two device rows are flagged for legal review', () => {
    const p = read('contracts/protocol.md');
    const s = p.slice(p.indexOf('### 58.7'), p.indexOf('### 58.8'));
    for (const n of ALL_R23_KPI) expect(s, n).toContain(`\`${n}\``);
    const deviceRow = s.split('\n').find((l) => l.includes('`device_signout`・`new_device_notice`'))!;
    expect(deviceRow).toMatch(/法務の確認/);
    const legal = read('docs/planning/03-legal-risk.md');
    expect(legal.slice(legal.indexOf('ログイン中の端末とセキュリティ'))).toMatch(/法務の確認/);
  });
  it('the Round 23 client events are client events of the schema and documented in docs/ops/kpi-queries.md', () => {
    const names = clientEventSchema.options.map((o) => (o.shape.name as unknown as { value: string }).value);
    for (const n of ['device_list_view', 'pedigree_view', 'bloodline_view', 'highlight_view', 'highlight_share']) expect(names, n).toContain(n);
    const q = read('docs/ops/kpi-queries.md');
    for (const n of ALL_R23_KPI) expect(q, n).toContain(n);
  });
});

describe('§46 gates × Round 23 routes (§46.2)', () => {
  const PLACES: Record<string, string> = {
    'POST /v1/account/devices/checkin': 'exempt', 'GET /v1/account/devices': 'exempt', 'POST /v1/account/devices/:sessionId/signout': 'exempt',
    'POST /v1/account/devices/signout-others': 'exempt', 'GET /v1/account/security-log': 'exempt',
    'GET /v1/horses/:horseId/pedigree': 'core', 'GET /v1/breeding/pedigree': 'core', 'GET /v1/bloodlines': 'core',
    'POST /v1/help/inquiries/:ticketId/messages': 'exempt',
  };
  it('every Round 23 route exists and sits in its group or the exempt list; no Round 23 family route is unplaced', () => {
    const have = new Set(routes.map((r) => `${r.method} ${r.path}`));
    for (const [r, g] of Object.entries(PLACES)) {
      expect(have.has(r), r).toBe(true);
      const exempt = (EXEMPT_ROUTES as readonly string[]).includes(r);
      if (g === 'exempt') expect(exempt, r).toBe(true);
      else { expect(exempt, r).toBe(false); expect(endpointGroup(r.split(' ')[1]!), r).toBe(g); }
    }
    const r23 = routes.map((r) => `${r.method} ${r.path}`).filter((r) => /^\w+ \/v1\/(account\/devices|account\/security-log|bloodlines|breeding\/pedigree|horses\/:horseId\/pedigree|help\/inquiries\/:ticketId\/messages)/.test(r));
    expect(r23.filter((r) => !(r in PLACES))).toEqual([]);
    const p = read('contracts/protocol.md');
    const s46 = p.slice(p.indexOf('### 46.2'), p.indexOf('### 46.3'));
    for (const r of Object.keys(PLACES)) expect(s46, r).toContain(r.split(' ')[1]!);
  });
});

describe('その他 stays at eight rows per page; Round 23 entries live on their hubs; the one prompt table is unchanged', () => {
  const app = read('tools/figma-prototype/site/app.js');
  const fnBody = (name: string) => { const i = app.search(new RegExp(`(async )?function ${name}\\(`)); return app.slice(i, app.indexOf('\n}\n', i)); };
  it('eight rows each, no Round 23 row; devices in Settings, pedigree on the horse, highlights on the result, tickets in the help center', () => {
    const block = app.slice(app.indexOf('const morePages = {'), app.indexOf("Kicker('その他', 36, 30, m);"));
    const rows = [...block.matchAll(/\[\s*'([^']+)',\s*(?:\(\)|[A-Z][A-Za-z]+[,\]])/g)].map((x) => x[1]);
    expect(rows).toHaveLength(16);
    for (const r of ['ログイン中の端末', '血統', '系統', '見どころ', 'お問い合わせ履歴']) expect(rows, r).not.toContain(r);
    expect(fnBody('Settings')).toContain("dataset.action = 'devices'");
    expect(fnBody('ResultScreen')).toContain("dataset.action = 'hl-result'");
    expect(fnBody('HelpCenter')).toContain("dataset.action = 'my-inquiries'");
    expect(app).toContain("Pedigree(p?.id ?? null, () => Stable(), 'horse')");
  });
  it('§58.11 keeps its seven rows; no Round 23 sheet joined SessionPrompts or the prototype gate', () => {
    const TABLE = ['recommended_update', 'consent_pre_prompt', 'comeback_welcome', 'release_notes', 'reminders_pre_permission', 'account_link', 'review_prompt'];
    const p = read('contracts/protocol.md');
    const s = p.slice(p.indexOf('### 58.11'), p.indexOf('## 59.'));
    expect([...s.matchAll(/^\s*\| \d \| `([a-z_]+)` \|/gm)].map((x) => x[1])).toEqual(TABLE);
    expect(JSON.parse(/const PROMPT_PRIORITY = (\[[^\]]+\]);/.exec(app)![1]!.replace(/'/g, '"'))).toEqual(TABLE);
  });
});

describe('§48 help / §57 tips × Round 23', () => {
  it('every Round 23 feature has an article whose tokens resolve in both languages, and a tip card that links it', () => {
    expect(helpProblems(m)).toEqual([]);
    const tips = JSON.parse(read('server/master/tips.json')) as { tips: { id: string; help?: string }[] };
    for (const [id, tip] of [['signed_in_devices', 'devices_tip'], ['pedigree', 'pedigree_tip'], ['race_highlights', 'highlights_tip'], ['support_tickets', null]] as const) {
      for (const lang of ['ja', 'en'] as const) {
        const a = helpArticle(m, id, lang) as { title: string; body: string } | null;
        expect(a, `${id} ${lang}`).toBeTruthy();
        expect(`${a!.title}${a!.body}`, `${id} ${lang}`).not.toMatch(/\{\{|\}\}/);
        if (lang === 'en') expect(a!.body, id).not.toMatch(/[぀-ヿ一-鿿]/);
      }
      if (tip) expect(tips.tips.find((t) => t.id === tip)?.help, tip).toBe(id);
    }
  });
});

/** One player who uses all four features: two signed-in devices, a bred foal with a birth snapshot, a ticket, a replay link with a start tick. */
async function world() {
  let now = NOW;
  const repo = new MemoryPlayerRepo();
  const svc = new PlayerService(repo, { master: m, rng: seededRng(23), clock: () => now, verifiers: { fake: new FakeStoreVerifier() } });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  for (const id of ['me', 'friend', 'stranger']) await svc.bootstrap(id);
  await svc.devicesCheckin('me', await buildCheckinInput('me', sec(now) - 3600, 'install-a', { platform: 'ios', osMajor: 18, model: 'iPhone15,2', appVersion: '1.9.0' } as never, 'JP', {}));
  now += 60_000;
  await svc.devicesCheckin('me', await buildCheckinInput('me', sec(now), 'install-b', { platform: 'android', osMajor: 15, model: 'Pixel 9', appVersion: '1.9.0' } as never, 'JP', {}));
  await svc.tx('me', null, (s: PlayerState) => {
    const sire = createHorseFromTemplate(s, m.templateById.get('t_ginga')!, now); sire.status = 'retired';
    s.counters.horseSeq += 1;
    const snap = (h: HorseInstance) => ({ name: h.name, templateId: h.templateId, rarity: h.rarity, sex: h.sex, style: h.style, surface: h.surface, line: h.line, appearance: h.appearance!, stats: h.base, sireName: h.sireName, damName: h.damName });
    s.horses.push({ ...structuredClone(sire), id: `h${s.counters.horseSeq}`, templateId: null, name: 'ホシカゲ', named: true, bornAt: now,
      studSire: { ownerId: 'stranger', horseId: 'h9', sireName: null, damName: null },
      lineage: { v: 1, sire: snap(sire), dam: snap(sire) } } as HorseInstance);
  });
  const ticket = await svc.helpInquirySubmit('me', { category: 'purchase_missing', description: 'コインを買ったのに増えていません。確認をお願いします。', refs: [], diagnostics: { appVersion: '1.9.0', platform: 'ios' } }, 'c:/v1/help/inquiries:k1') as unknown as { ticketId: string; summary: never };
  const ops = memoryOps(m, () => invoker);
  await ops.api.inquiries.upsert([ticket.summary]);
  await ops.api.inquiries.assign('me', ticket.ticketId, 'op-1', now);
  await ops.api.inquiries.addNote('me', ticket.ticketId, { by: 'op-1', at: now, text: '内部メモ', opKey: 'n1' } as never, 20);
  const dir = new MemoryLinkDirectory();
  const blocks: Record<string, string[]> = { me: [], friend: [], stranger: [] };
  const links = new LinkService({
    party: async (u) => ({ ...(await svc.linkParty(u)), blocks: blocks[u] ?? [] }), checkCreate: (u) => svc.linkCheckCreate(u), note: async () => undefined,
  }, dir, () => linksConfig(m), { clock: () => now, limitSalt: 's', maintenance: () => maintenanceOf(m), dayRule: () => dayRule(m) });
  const row = replayLinkRow('r-1', 1825);
  await dir.put({ token: 'abcd2345efghjkmnpqrstu', ownerId: 'me', type: 'replay', targetKey: row.targetKey, data: row.data, day: '2026-11-12', createdAt: now, expiresAt: now + 86_400_000, revokedAt: null }, 30, now);
  return { svc, repo, ops, dir, links, blocks, ticket, now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('§51 data export × Round 23 state', () => {
  it('devices (account) and the foal\'s lineage (horses) are exported and classified; no auth_time, hash, other player id or desk note', async () => {
    const w = await world();
    const s = await w.svc.state('me');
    expect(DEX_CLASSIFICATION.devices).toEqual({ section: 'account' });
    const doc = buildExportDocument(m, s, { ledger: [], gacha: [], names: {}, reportsMade: [], kpiEvents: null, linksMade: null }, 'dex_r23', 'ja', w.now());
    expect(doc.unclassified).toEqual([]);
    const text = JSON.stringify(doc);
    expect(text).toContain('signedInDevices');
    expect(text).toContain('"lineage"');
    expect(text).toContain('ホシカゲ');
    for (const bad of ['stranger', 'authTime', 'install-a', '内部メモ', 'op-1']) expect(text, bad).not.toContain(bad);
    const foal = (doc.horses.items as { name: string; lineage?: unknown }[]).find((h) => h.name === 'ホシカゲ')!;
    expect(foal.lineage).toBeTruthy();
  });
});

describe('account deletion × Round 23', () => {
  it('wipes the device list and the tickets with the state, the desk forgets the index / assignee / notes, the replay link (start tick) is gone', async () => {
    const w = await world();
    const tok = (await w.svc.requestDeletion('me', null)) as { confirmToken: string };
    await w.svc.requestDeletion('me', tok.confirmToken);
    w.advance(15 * 86_400_000);
    const ports = {
      start: async (u: string) => { await w.svc.deletionStart(u); }, snapshot: (u: string) => w.svc.deletionSnapshot(u),
      markStep: async (u: string, st: never) => { await w.svc.deletionMarkStep(u, st); },
      friends: { removeFriend: async () => undefined, dropOutgoing: async () => undefined, dropIncoming: async () => undefined },
      directory: { forget: async (u: string) => { w.dir.forget(u); } }, leaderboards: { forget: async () => undefined, deleteGhosts: async () => undefined },
      inquiries: { forget: (u: string) => w.ops.api.inquiries.forgetPlayer(u) },
      finalize: (u: string) => w.svc.deletionFinalize(u), retain: async () => undefined, wipe: (u: string) => w.svc.wipe(u),
    } as unknown as DeletionPorts;
    const before = await w.svc.state('me') as PlayerState & { help?: { tickets: unknown[] } };
    expect([!!before.devices, (before.help?.tickets.length ?? 0) > 0]).toEqual([true, true]);
    expect((await w.ops.api.inquiries.list({})).length).toBe(1);
    expect(await w.dir.get('abcd2345efghjkmnpqrstu')).not.toBeNull();
    await runAccountDeletion(ports, 'me', w.now());
    expect(w.repo.get('me')).toBeNull();
    expect(await w.dir.get('abcd2345efghjkmnpqrstu')).toBeNull();
    expect(await w.ops.api.inquiries.list({})).toEqual([]);
    expect(await w.ops.api.inquiries.desk('me', w.ticket.ticketId)).toEqual({ assignee: null, notes: [] });
    // a check-in after the wipe never brings the account back (REQ-DEV-002)
    await w.svc.devicesCheckin('me', await buildCheckinInput('me', sec(w.now()), 'install-a', { platform: 'ios' } as never, 'JP', {}));
    expect(w.repo.get('me')).toBeNull();
  });
});

describe('§47 one block list × §72 highlight links', () => {
  it('a replay link with a start tick opens at the moment for a friend, and is the one neutral `unavailable` across a block either way', async () => {
    const w = await world();
    const targets = { open: async (_v: string, rec: { data: Record<string, string> }) => ({ state: 'ok', type: 'replay', screen: 'friend_replay', target: { raceId: rec.data.raceId, ...(rec.data.startTick ? { startTick: Number(rec.data.startTick) } : {}) } }) } as never;
    const ok = await w.links.resolve('friend', 'abcd2345efghjkmnpqrstu', {}, targets);
    expect(ok).toMatchObject({ state: 'ok', target: { startTick: 1825 } });
    w.blocks.me = ['friend'];
    expect(await w.links.resolve('friend', 'abcd2345efghjkmnpqrstu', {}, targets)).toEqual({ state: 'unavailable' });
    w.blocks.me = []; w.blocks.friend = ['me'];
    expect(await w.links.resolve('friend', 'abcd2345efghjkmnpqrstu', {}, targets)).toEqual({ state: 'unavailable' });
  });
});

describe('deploy §7.1: one Round 23 row (no migration; old apps and SESSION_REVOKED)', () => {
  it('the row exists once and covers the four features, no v10, the late promotion for SESSION_REVOKED and the kill switches', () => {
    const d = read('docs/ops/deploy.md');
    const rows = d.split('\n').filter((l) => l.startsWith('| Round 23'));
    expect(rows).toHaveLength(1);
    expect(d.indexOf('| Round 21')).toBeLessThan(d.indexOf('| Round 23'));
    for (const s of ['§70', '§71', '§72', '§73', 'マイグレーションは無い', '`v10`', 'SESSION_REVOKED', 'progression.devices.enabled', 'highlights.vectors.json', 'inquiry_reply', 'inquiry_desk', 'lineage', '切り戻し']) expect(rows[0], s).toContain(s);
    expect(read('server/wrangler.toml')).not.toMatch(/tag = "v10"/);
  });
});
