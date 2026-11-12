// REQ-TKT-001..020: お問い合わせの状況確認 — support tickets & replies (contracts/protocol.md §73).
import { describe, expect, it } from 'vitest';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { DEFAULT_RULESET } from '../src/domain/ruleset.js';
import { authenticateAdmin, type AdminAuthConfig } from '../src/ops/admin.js';
import { sha256Hex } from '../src/ops/hash.js';
import { memoryOps } from '../src/ops/memoryOps.js';
import { BASE_HELP, helpProblems, type HelpMaster } from '../src/domain/help.js';
import { DAY_MS, TICKET_DEFAULTS, replyTemplatesFor, scrubTicketText, ticketsOf } from '../src/domain/supportTickets.js';
import { EXEMPT_ROUTES, isExempt } from '../src/domain/maintenance.js';
import { KPI_ESSENTIAL, kpiClassOf } from '../src/domain/kpiConsent.js';
import { LNOTIF_OWNERSHIP } from '../src/domain/localNotify.js';
import { buildExportDocument } from '../src/domain/dataExport.js';
import { untranslated, PLAYER_TEXT_KEYS } from '../src/i18n/catalog.js';
import { hasJapanese } from '../src/i18n/locale.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import type { Master } from '../src/domain/master.js';
import type { PlayerState } from '../src/domain/player.js';
import { m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 10, 3);
const H = 3_600_000;
const TOKENS = { viewer: 'viewer-token-0123456789', operator: 'operator-token-0123456789', admin: 'admin-token-0123456789' };
const clone = (): HelpMaster => structuredClone(BASE_HELP);

async function setup() {
  let now = NOW;
  const repo = new MemoryPlayerRepo();
  const kpi: KpiRecord[] = [];
  const svc = new PlayerService(repo, { master: m, rng: seededRng(23), clock: () => now, verifiers: { fake: new FakeStoreVerifier() }, onKpi: (_id, recs) => { kpi.push(...recs); } });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const ops = memoryOps(m, () => invoker);
  const auth: AdminAuthConfig = { tokens: await Promise.all((Object.keys(TOKENS) as (keyof typeof TOKENS)[]).map(async (name) => ({ name, role: name, sha256: await sha256Hex(TOKENS[name]) }))) };
  const c: AppContext = {
    master: m,
    authenticate: async (req) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
    player: () => invoker,
    match: {} as AppContext['match'],
    friends: makeFriendsService(() => invoker, new MemoryDirectory()),
    leaderboard: { board: async () => ({ entries: [], total: 0 }), myRank: async () => ({}) },
    timeAttack: {} as AppContext['timeAttack'],
    clock: () => now,
    race: { websocket: async () => new Response(null), report: async () => ({}), replay: async (id) => ({ raceId: id }) },
    paidBalance: async () => ({}),
    adminToken: undefined,
    parseStoreNotification: async () => null,
    ops: ops.api,
    authenticateAdmin: (req) => authenticateAdmin(req, auth),
    configInfo: async () => ({ versionId: 'base', hash: 'base', rulesetVersion: DEFAULT_RULESET.rulesetVersion, activatedAt: null }),
  };
  const call = async (user: string, path: string, init: { method?: string; body?: unknown; key?: string; lang?: string } = {}) => {
    const headers: Record<string, string> = { 'x-test-user': user, 'content-type': 'application/json' };
    if (init.key) headers['idempotency-key'] = init.key;
    if (init.lang) headers['accept-language'] = init.lang;
    const res = await handle(new Request(`https://x${path}`, { method: init.method ?? 'GET', headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }), {}, c);
    return { status: res.status, body: (await res.json()) as any };
  };
  const admin = async (path: string, who: keyof typeof TOKENS = 'viewer', body?: unknown) => {
    const res = await handle(new Request(`https://x${path}`, {
      method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${TOKENS[who]}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
    }), {}, c);
    return { status: res.status, body: (await res.json()) as any };
  };
  const submit = (user: string, key: string, extra: Record<string, unknown> = {}, lang?: string) => call(user, '/v1/help/inquiries', {
    method: 'POST', key, ...(lang ? { lang } : {}),
    body: { category: 'purchase_missing', description: 'コインを買ったのに増えていません。確認をお願いします。', diagnostics: { appVersion: '1.4.0', platform: 'ios' }, ...extra },
  });
  const say = (user: string, ticket: string, key: string, content: string, lang?: string) =>
    call(user, `/v1/help/inquiries/${ticket}/messages`, { method: 'POST', key, body: { content }, ...(lang ? { lang } : {}) });
  const reply = (user: string, ticket: string, opKey: string, content = '確認しました。少しお待ちください。', close = false) =>
    admin(`/v1/admin/players/${user}/inquiries/${ticket}/reply`, 'operator', { opKey, content, close, reason: 'answer the ticket' });
  const setStatus = (user: string, ticket: string, opKey: string, status: string) =>
    admin(`/v1/admin/players/${user}/inquiries/${ticket}/status`, 'operator', { opKey, status, reason: 'triage' });
  return { svc, repo, kpi, call, admin, submit, say, reply, setStatus, ops, setNow: (t: number) => { now = t; }, now: () => now };
}

describe('master: ticket rules and reply templates (REQ-TKT-002)', () => {
  it('the shipped help.json carries valid ticket rules, templates and the support_tickets article', () => {
    expect(helpProblems(m)).toEqual([]);
    expect(ticketsOf(BASE_HELP)).toEqual(TICKET_DEFAULTS);
    expect(BASE_HELP.replyTemplates!.length).toBeGreaterThanOrEqual(3);
    expect(BASE_HELP.articles.find((a) => a.id === 'support_tickets')?.category).toBe('account');
  });
  it('refuses out-of-range rules, unknown keys and broken templates; a version without the block runs on the defaults', () => {
    const h = clone();
    h.config.tickets = { autoCloseDays: 0, retentionDays: 5000, pushOnReply: 'yes' as never, bogus: 1 } as never;
    const p = helpProblems({ ...m, help: h } as Master, h);
    expect(p.join('\n')).toMatch(/autoCloseDays must be an integer 1\.\.60/);
    expect(p.join('\n')).toMatch(/retentionDays/);
    expect(p.join('\n')).toMatch(/pushOnReply must be a boolean/);
    expect(p.join('\n')).toMatch(/bogus: unknown key/);
    const t = clone();
    t.replyTemplates = [
      { id: 'a', title: { ja: 'x', en: 'x' }, body: { ja: 'x', en: 'x' } },
      { id: 'ok_one', title: { ja: '件名', en: 'Subject' }, body: { ja: '{{ticket_id}} 今だけ', en: 'Only English' } },
      { id: 'tok', title: { ja: '件名', en: 'Subject' }, body: { ja: '{{nope}}', en: '{{nope}}' } },
      { id: 'jp', title: { ja: '件名', en: 'Subject' }, body: { ja: '本文', en: '日本語' } },
    ];
    const q = helpProblems({ ...m, help: t } as Master, t).join('\n');
    expect(q).toMatch(/replyTemplates\[0\] a: bad id/);
    expect(q).toMatch(/ok_one: ja and en carry different tokens/);
    expect(q).toMatch(/shop word 「今だけ」/);
    expect(q).toMatch(/\{\{nope\}\}: unknown token/);
    expect(q).toMatch(/jp\.en contains Japanese/);
    const bare = clone();
    delete bare.config.tickets;
    delete bare.replyTemplates;
    expect(helpProblems({ ...m, help: bare } as Master, bare)).toEqual([]);
    expect(ticketsOf(bare)).toEqual(TICKET_DEFAULTS);
  });
  it('templates come in the ticket language with the ticket id, category and data tokens filled', () => {
    const en = replyTemplatesFor(m, 'q_7', 'refund', 'en');
    const ja = replyTemplatesFor(m, 'q_7', 'refund', 'ja');
    expect(en.items.find((x) => x.id === 'received_ack')!.body).toContain('q_7, About a refund');
    expect(ja.items.find((x) => x.id === 'received_ack')!.body).toContain('q_7・返金について');
    expect(en.items.every((x) => !hasJapanese(x.title + x.body) && !/\{\{/.test(x.body))).toBe(true);
    expect(ja.items.find((x) => x.id === 'deletion_info')!.body).toContain('14日');
  });
});

describe('text scrubbing (REQ-TKT-003)', () => {
  it('removes passwords, tokens and URL queries but keeps the text readable', () => {
    const r = scrubTicketText('引き継ぎのパスワードは abc123XYZ です。Bearer abcdefghijklmnop と https://x.example/path?token=secret を見ました。コイン1,020枚、P-1A2B3C4D');
    expect(r.text).toBe('引き継ぎのパスワードは ［削除しました］ です。<token> と https://x.example/path を見ました。コイン1,020枚、P-1A2B3C4D');
    expect(r.n).toBe(3);
    expect(scrubTicketText('jwt eyJhbGciOi.eyJzdWIiOi.SflKxwRJ mail taro@example.com').text).toBe('jwt <token> mail ［削除しました］');
    expect(scrubTicketText('upward: fine').text).toBe('upward: fine');
  });
});

describe('submitting (REQ-TKT-003)', () => {
  it('diagnostics only with consent; never extra keys; a tombstoned account cannot send', async () => {
    const x = await setup();
    const t = await x.submit('u1', 'a', { shareDiagnostics: false });
    expect(t.status).toBe(200);
    expect(t.body.diagnostics).toEqual({ appVersion: null, platform: null, playerId: 'u1', lastRaceIds: [] });
    expect(t.body.shareDiagnostics).toBe(false);
    expect(t.body).toMatchObject({ canReply: true, replyUntil: null, autoCloseAt: null, compensation: [] });
    x.setNow(NOW + 61_000);
    const none = await x.call('u1', '/v1/help/inquiries', { method: 'POST', key: 'b', body: { category: 'bug', description: '画面が固まりました。再起動で直りました。' } });
    expect(none.status).toBe(200);
    expect(none.body.diagnostics.appVersion).toBeNull();
    expect((await x.submit('u1', 'c', { diagnostics: { appVersion: '1', platform: 'ios', token: 'x' } })).status).toBe(400);
    x.setNow(NOW + 122_000);
    expect((await x.submit('u1', 'd', { description: 'パスワードは hunter22 です。届きません。' })).body.inquiryText).toBe('パスワードは ［削除しました］ です。届きません。');
    x.repo.delete('u9'); // tombstone
    expect((await x.submit('u9', 'e')).status).toBe(403);
    expect(x.repo.get('u9')).toBeNull(); // no fresh state under the deleted id
  });
});

describe('the thread (REQ-TKT-001/004/005/011)', () => {
  it('player replies: keyed, interval, reopen from answered / resolved / closed within the window, then 409', async () => {
    const x = await setup();
    await x.submit('u1', 'a');
    const nokey = await x.call('u1', '/v1/help/inquiries/q_1/messages', { method: 'POST', body: { content: 'x' } });
    expect(nokey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const fast = await x.say('u1', 'q_1', 'm1', '追記です。');
    expect(fast.status).toBe(429);
    expect(fast.body.error.details).toMatchObject({ reason: 'interval', retryAt: NOW + 30_000 });
    x.setNow(NOW + 31_000);
    const r1 = await x.say('u1', 'q_1', 'm1', '追記です。購入は昨日の夜です。');
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ status: 'received', messages: [{ from: 'player', messageText: '追記です。購入は昨日の夜です。' }] });
    expect((await x.say('u1', 'q_1', 'm1', '追記です。購入は昨日の夜です。')).body.messages).toHaveLength(1); // same key, same result
    // the operator marks it in progress: a player reply keeps it there
    x.setNow(NOW + H);
    expect((await x.setStatus('u1', 'q_1', 'st-1', 'in_progress')).body).toMatchObject({ status: 'in_progress', duplicate: false });
    expect((await x.call('u1', '/v1/help/inquiries/q_1')).body).toMatchObject({ status: 'in_progress', statusText: '確認中' });
    x.setNow(NOW + 2 * H);
    expect((await x.say('u1', 'q_1', 'm2', 'よろしくお願いします。')).body.status).toBe('in_progress');
    // an answer, then the player replies: back to received (not a reopen)
    x.setNow(NOW + 3 * H);
    expect((await x.reply('u1', 'q_1', 'rep-1')).body.status).toBe('answered');
    const ans = (await x.call('u1', '/v1/help/inquiries/q_1')).body;
    expect(ans).toMatchObject({ status: 'answered', statusText: '返信あり', canReply: true, autoCloseAt: NOW + 3 * H + 7 * DAY_MS, unread: true });
    x.setNow(NOW + 4 * H);
    expect((await x.say('u1', 'q_1', 'm3', 'まだ届いていません。')).body.status).toBe('received');
    // resolved → a reply reopens
    x.setNow(NOW + 5 * H);
    await x.setStatus('u1', 'q_1', 'st-2', 'resolved');
    x.setNow(NOW + 6 * H);
    expect((await x.say('u1', 'q_1', 'm4', 'もう一度確認してください。')).body.status).toBe('received');
    // closed → a reply within reopenDays reopens; after the window it is refused
    x.setNow(NOW + 7 * H);
    await x.reply('u1', 'q_1', 'rep-2', '完了しました。', true);
    const closed = (await x.call('u1', '/v1/help/inquiries/q_1')).body;
    expect(closed).toMatchObject({ status: 'closed', statusText: 'クローズ', canReply: true, replyUntil: NOW + 7 * H + 14 * DAY_MS });
    x.setNow(NOW + 8 * H);
    expect((await x.say('u1', 'q_1', 'm5', '別の件で、もう一つ。')).body.status).toBe('received');
    x.setNow(NOW + 9 * H);
    await x.setStatus('u1', 'q_1', 'st-3', 'closed');
    expect((await x.setStatus('u1', 'q_1', 'st-4', 'in_progress')).status).toBe(409);
    x.setNow(NOW + 9 * H + 14 * DAY_MS);
    expect((await x.call('u1', '/v1/help/inquiries/q_1')).body.canReply).toBe(false);
    const late = await x.say('u1', 'q_1', 'm6', 'まだですか。');
    expect(late.status).toBe(409);
    expect(late.body.error.details.reason).toBe('closed');
    // KPI rows: replies with the status before, two reopens, resolved / closed
    expect(x.kpi.filter((k) => k.name === 'ticket_player_reply').map((k) => k.s2)).toEqual(['received', 'in_progress', 'answered', 'resolved', 'closed']);
    expect(x.kpi.filter((k) => k.name === 'ticket_reopen').map((k) => k.s2)).toEqual(['resolved', 'closed']);
    expect(x.kpi.filter((k) => k.name === 'ticket_resolved').map((k) => k.s2)).toEqual(['resolved', 'closed', 'closed']);
    expect(JSON.stringify(x.kpi.filter((k) => k.name.startsWith('ticket_')))).not.toMatch(/まだ|確認/);
  });

  it('limits: the daily count and the thread size; a deleting account cannot reply; other players get 404', async () => {
    const x = await setup();
    await x.submit('u1', 'a');
    let t = NOW;
    for (let i = 0; i < 10; i++) { t += 31_000; x.setNow(t); expect((await x.say('u1', 'q_1', `k${i}`, `追記 ${i}`)).status).toBe(200); }
    t += 31_000; x.setNow(t);
    const day = await x.say('u1', 'q_1', 'k10', '追記');
    expect(day.status).toBe(429);
    expect(day.body.error.details.reason).toBe('day');
    expect((await x.call('u1', '/v1/help/inquiries')).body.limits).toMatchObject({ repliesPerDay: 10, repliesToday: 10 });
    expect((await x.say('u2', 'q_1', 'z', 'のぞき見')).status).toBe(404);
    const s = x.repo.get('u1') as PlayerState;
    s.deletion = { ...(s.deletion ?? {}), status: 'deleting' } as PlayerState['deletion'];
    x.repo.put(s);
    x.setNow(t + DAY_MS);
    expect((await x.say('u1', 'q_1', 'k11', '追記')).status).toBe(403);
  });

  it('auto-close after autoCloseDays without a player reply; the queue shows it before the player reads; retention removes it', async () => {
    const x = await setup();
    await x.submit('u1', 'a');
    x.setNow(NOW + H);
    await x.reply('u1', 'q_1', 'rep-1');
    x.setNow(NOW + H + 7 * DAY_MS);
    // the ops queue computes it from the index (nobody read the ticket yet)
    const q = await x.admin('/v1/admin/inquiries?status=closed');
    expect(q.body.items.map((i: any) => [i.ticketId, i.status, i.closedAt])).toEqual([['q_1', 'closed', NOW + H + 7 * DAY_MS]]);
    const mine = await x.call('u1', '/v1/help/inquiries');
    expect(mine.body.items[0]).toMatchObject({ status: 'closed', canReply: true });
    expect(x.kpi.filter((k) => k.name === 'ticket_resolved').map((k) => [k.s2, k.durationMs])).toEqual([['auto_closed', H + 7 * DAY_MS]]);
    // a reply within the reopen window reopens it
    x.setNow(NOW + H + 8 * DAY_MS);
    expect((await x.say('u1', 'q_1', 'm1', 'まだ解決していません。')).body.status).toBe('received');
    await x.reply('u1', 'q_1', 'rep-2', '完了です。', true);
    // retention: gone from the state and from the index
    x.setNow(NOW + H + 8 * DAY_MS + 365 * DAY_MS);
    expect((await x.admin('/v1/admin/inquiries')).body.items).toEqual([]);
    expect((await x.call('u1', '/v1/help/inquiries')).body.items).toEqual([]);
    expect((await x.call('u1', '/v1/help/inquiries/q_1')).status).toBe(404);
  });

  it('a reply notifies: activity entry and a push in the gifts category without the reply text (owner: server)', async () => {
    const x = await setup();
    await x.svc.registerDevice('u1', 'tok-0123456789', 'ios');
    await x.submit('u1', 'a');
    x.setNow(NOW + 2 * H); // 14:00 JST (outside the quiet hours)
    await x.reply('u1', 'q_1', 'rep-1', 'コイン1,020枚を付与しました。');
    const s = x.repo.get('u1') as PlayerState & { push: { outbox: { templateId: string; category: string; vars: Record<string, string> }[] } };
    const item = s.push.outbox.find((o) => o.templateId === 'inquiry_reply')!;
    expect(item).toMatchObject({ category: 'gifts', vars: { ticketId: 'q_1' } });
    expect(JSON.stringify(m.push.templates.inquiry_reply)).not.toMatch(/付与|1,020/);
    expect(LNOTIF_OWNERSHIP.server.inquiry_reply).toBeTruthy();
    // gifts off → no push (the activity entry still arrives)
    await x.svc.setPushPreferences('u1', { categories: { gifts: false } } as never);
    x.setNow(NOW + 3 * H);
    await x.reply('u1', 'q_1', 'rep-2', '追伸です。');
    const after = (x.repo.get('u1') as typeof s).push.outbox.filter((o) => o.templateId === 'inquiry_reply');
    expect(after).toHaveLength(1);
    const act = (await x.call('u1', '/v1/activity')).body.items.filter((i: any) => i.kind === 'inquiry_answered');
    expect(act).toHaveLength(2);
  });
});

describe('ops desk (REQ-TKT-006..010)', () => {
  it('queue filters, SLA age, CSV without text, assignee, internal notes kept from the player and the export', async () => {
    const x = await setup();
    await x.submit('u1', 'a', { description: '購入したのに届きません。秘密の本文です。' });
    x.setNow(NOW + 61_000);
    await x.submit('u2', 'b', {}, 'en');
    x.setNow(NOW + 50 * H);
    const open = await x.admin('/v1/admin/inquiries?status=open');
    expect(open.body.items.map((i: any) => [i.ticketId, i.playerId, i.slaBreached])).toEqual([['q_1', 'u1', true], ['q_1', 'u2', true]]);
    expect(open.body.items[0].waitingMs).toBe(50 * H);
    expect((await x.admin('/v1/admin/inquiries?lang=en')).body.items.map((i: any) => i.playerId)).toEqual(['u2']);
    expect((await x.admin('/v1/admin/inquiries?minAgeHours=51')).body.items).toEqual([]);
    expect((await x.admin('/v1/admin/inquiries?status=bogus')).status).toBe(400);
    // assign (operator only), filter by assignee
    expect((await x.admin('/v1/admin/players/u1/inquiries/q_1/assign', 'viewer', { assignee: 'me', reason: 'mine' })).status).toBe(403);
    expect((await x.admin('/v1/admin/players/u1/inquiries/q_1/assign', 'operator', { assignee: 'me', reason: 'taking it' })).body.assignee).toBe('operator');
    expect((await x.admin('/v1/admin/inquiries?assignee=me', 'operator')).body.items.map((i: any) => i.playerId)).toEqual(['u1']);
    expect((await x.admin('/v1/admin/inquiries?assignee=none')).body.items.map((i: any) => i.playerId)).toEqual(['u2']);
    // internal notes: scrubbed, keyed, capped; shown to ops only
    const note = await x.admin('/v1/admin/players/u1/inquiries/q_1/notes', 'operator', { opKey: 'note-1', text: 'ストアで確認中。パスワード: abc12345 と言われた', reason: 'note' });
    expect(note.body.notes).toEqual([{ by: 'operator', at: NOW + 50 * H, text: 'ストアで確認中。パスワード: ［削除しました］ と言われた' }]);
    expect((await x.admin('/v1/admin/players/u1/inquiries/q_1/notes', 'operator', { opKey: 'note-1', text: 'again', reason: 'retry' })).body).toMatchObject({ duplicate: true });
    const det = await x.admin('/v1/admin/players/u1/inquiries/q_1');
    expect(det.body).toMatchObject({ assignee: 'operator', internalNotes: [{ by: 'operator' }], slaHours: 48, slaBreached: true, player: { deletion: null, moderation: 'ok', purchases: 0 } });
    const mine = await x.call('u1', '/v1/help/inquiries/q_1');
    expect(JSON.stringify(mine.body)).not.toMatch(/ストアで確認中|assignee|internalNotes/);
    const doc = buildExportDocument(m, x.repo.get('u1') as PlayerState, { ledger: [], gacha: [], names: null, reportsMade: null, kpiEvents: null, clientErrors: null } as never, 'r1', 'ja', x.now());
    expect(JSON.stringify(doc.helpInquiries)).not.toMatch(/ストアで確認中|operator/);
    // CSV: columns only, no text
    const csv = await x.admin('/v1/admin/inquiries/export?status=open');
    expect(csv.body.rows).toBe(2);
    expect(csv.body.csv.split('\n')[0]).toBe('ticket_id,player_id,category,status,lang,attachments,created_at,updated_at,first_reply_at,closed_at,assignee,waiting_hours,sla_breached');
    expect(csv.body.csv).toContain('q_1,u1,purchase_missing,received,ja,0,');
    expect(csv.body.csv).not.toMatch(/秘密|届きません|ストア/);
    // audit: the export and the note are logged, without the note text
    const audit = await x.ops.audits.query({ limit: 50 } as never);
    const actions = (audit as { action: string; after?: unknown }[]).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['inquiry.export', 'inquiry.note', 'inquiry.assign']));
    expect(JSON.stringify(audit)).not.toMatch(/ストアで確認中/);
    // templates in the ticket language
    const tpl = await x.admin('/v1/admin/inquiry-templates?playerId=u2&ticketId=q_1');
    expect(tpl.body).toMatchObject({ lang: 'en' });
    expect(tpl.body.items[0].body).toContain('q_1');
    // deletion forgets the desk
    await x.ops.api.inquiries!.forgetPlayer('u1');
    expect(await x.ops.api.inquiries!.desk('u1', 'q_1')).toEqual({ assignee: null, notes: [] });
  });

  it('compensation: only an existing request of the same player; linked once; the player sees the gift box link; nothing granted here', async () => {
    const x = await setup();
    await x.submit('u1', 'a');
    const comp = await x.admin('/v1/admin/compensations', 'operator', { playerId: 'u1', grant: { freeCoins: 100 }, opKey: 'comp-u1-1', reason: 'store delay' });
    expect(comp.status).toBe(200);
    const id = comp.body.request.id as string;
    const other = await x.admin('/v1/admin/compensations', 'operator', { playerId: 'u2', grant: { freeCoins: 100 }, opKey: 'comp-u2-1', reason: 'other' });
    const coinsBefore = (x.repo.get('u1') as PlayerState).wallet;
    expect((await x.admin('/v1/admin/players/u1/inquiries/q_1/compensation', 'operator', { compensationId: other.body.request.id, reason: 'link' })).status).toBe(400);
    expect((await x.admin('/v1/admin/players/u1/inquiries/q_1/compensation', 'operator', { compensationId: 'comp_999', reason: 'link' })).status).toBe(404);
    const link = await x.admin('/v1/admin/players/u1/inquiries/q_1/compensation', 'operator', { compensationId: id, reason: 'link the gift' });
    expect(link.status).toBe(200);
    expect(link.body.compensation).toEqual([{ ref: id, at: NOW }]);
    await x.admin('/v1/admin/players/u1/inquiries/q_1/compensation', 'operator', { compensationId: id, reason: 'again' });
    expect((x.repo.get('u1') as PlayerState).wallet).toEqual(coinsBefore); // linking moves nothing
    const t = await x.call('u1', '/v1/help/inquiries/q_1');
    expect(t.body.compensation).toEqual([{ ref: id, at: NOW, screen: 'gift_box' }]);
    // a rejected request cannot be linked
    const big = await x.admin('/v1/admin/compensations', 'admin', { playerId: 'u1', grant: { freeCoins: 20_000 }, opKey: 'comp-u1-big', reason: 'large' });
    expect(big.body.request.status).toBe('pending');
    expect((await x.admin(`/v1/admin/compensations/${big.body.request.id}/reject`, 'operator', { reason: 'too much' })).status).toBe(200);
    expect((await x.admin('/v1/admin/players/u1/inquiries/q_1/compensation', 'operator', { compensationId: big.body.request.id, reason: 'link' })).status).toBe(409);
  });
});

describe('CSV safety (REQ-TKT-007)', () => {
  it('a cell a spreadsheet would read as a formula is quoted', async () => {
    const x = await setup();
    await x.submit('=HYPERLINK(1)', 'a');
    const csv = (await x.admin('/v1/admin/inquiries/export')).body.csv as string;
    expect(csv.split('\n')[1]!.startsWith(`q_1,'=HYPERLINK(1),`)).toBe(true);
  });
});

describe('wiring (REQ-TKT-012/013/014)', () => {
  it('the reply route is never gated; KPI classes; English keeps the person\'s words', async () => {
    expect(EXEMPT_ROUTES).toContain('POST /v1/help/inquiries/:ticketId/messages');
    expect(isExempt('POST', '/v1/help/inquiries/q_3/messages')).toBe(true);
    for (const n of ['inquiry_submit', 'inquiry_answered', 'ticket_player_reply', 'ticket_reopen', 'ticket_resolved']) expect(kpiClassOf(n), n).toBe('essential');
    expect(KPI_ESSENTIAL.ticket_player_reply).toMatch(/support/);
    expect(kpiClassOf('ticket_reply_view')).toBe('optional');
    const x = await setup();
    await x.submit('u1', 'a', {}, 'en');
    x.setNow(NOW + H);
    await x.reply('u1', 'q_1', 'rep-1', 'We checked your purchase.');
    const read = await x.call('u1', '/v1/help/inquiries/q_1/read', { method: 'POST' });
    expect(read.status).toBe(200);
    expect(x.kpi.filter((k) => k.name === 'ticket_reply_view').map((k) => k.s1)).toEqual(['purchase_missing']);
    x.setNow(NOW + 2 * H);
    const r = await x.say('u1', 'q_1', 'm1', 'まだ届きません。', 'en');
    expect(r.body).toMatchObject({ statusText: 'Received' });
    expect(r.body.messages.map((mm: any) => mm.messageText)).toEqual(['We checked your purchase.', 'まだ届きません。']);
    expect(untranslated(r.body, PLAYER_TEXT_KEYS)).toEqual([]);
    const list = await x.call('u1', '/v1/help/inquiries', { lang: 'en' });
    expect(untranslated(list.body, PLAYER_TEXT_KEYS)).toEqual([]);
  });
});
