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
import { bundleDiff, groupProblems } from '../src/ops/config.js';
import { COMP_TTL_MS } from '../src/ops/compensation.js';
import { MemoryInviteDirectory } from '../src/domain/invite.js';
import { oddsDisclosure, findVisibleBanner } from '../src/domain/gacha.js';
import { parseConsoleOrigins } from '../src/ops/admin.js';
import { m } from './helpers.js';

/** Admin endpoints added for the ops console (REQ-OPS-008/009/015/020/026/027). */
const NOW = Date.UTC(2026, 10, 10, 3);
const TOKENS = { viewer: 'viewer-token-0123456789', operator: 'operator-token-0123456789', admin: 'admin-token-0123456789', admin2: 'second-admin-token-0123456789' };
type Who = keyof typeof TOKENS;
const CONSOLE = 'https://ops.example.test';

async function setup() {
  let now = NOW;
  const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(3), clock: () => now, verifiers: { fake: new FakeStoreVerifier() } });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const ops = memoryOps(m, () => invoker);
  const invites = new MemoryInviteDirectory(seededRng(9));
  const auth: AdminAuthConfig = {
    tokens: await Promise.all((Object.keys(TOKENS) as Who[]).map(async (name) => ({ name, role: name === 'admin2' ? 'admin' as const : name, sha256: await sha256Hex(TOKENS[name]) }))),
  };
  const c: AppContext = {
    master: m,
    authenticate: async () => { throw new AppError('UNAUTHORIZED'); },
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
    inviteLookup: (code) => invites.lookup(code),
    adminConsoleOrigins: [CONSOLE],
  };
  const raw = (path: string, init: RequestInit) => handle(new Request(`https://x${path}`, init), {}, c);
  const call = async (who: Who | null, method: string, path: string, body?: unknown) => {
    const res = await raw(path, {
      method, headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${TOKENS[who]}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any>, headers: res.headers };
  };
  return { svc, ops, invites, c, call, raw, setNow: (t: number) => { now = t; } };
}

describe('CORS for the ops console (REQ-OPS-015)', () => {
  it('only listed origins get CORS headers, never credentials; preflight is answered before auth', async () => {
    const { raw } = await setup();
    const pre = await raw('/v1/admin/whoami', { method: 'OPTIONS', headers: { origin: CONSOLE, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(CONSOLE);
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/authorization/);
    expect(pre.headers.get('access-control-allow-credentials')).toBeNull();
    const evil = await raw('/v1/admin/whoami', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    // a real call from an unlisted origin is refused even with a valid token
    const r = await raw('/v1/admin/whoami', { headers: { origin: 'https://evil.example', authorization: `Bearer ${TOKENS.admin}` } });
    expect(r.status).toBe(403);
    const ok = await raw('/v1/admin/whoami', { headers: { origin: CONSOLE, authorization: `Bearer ${TOKENS.viewer}` } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe(CONSOLE);
    expect(ok.headers.get('cache-control')).toBe('no-store');
  });

  it('writes need a JSON content type (no simple-request writes) and a token', async () => {
    const { raw } = await setup();
    const form = await raw('/v1/admin/players/p1/grants', { method: 'POST', headers: { authorization: `Bearer ${TOKENS.operator}`, 'content-type': 'text/plain' }, body: JSON.stringify({ grant: { freeCoins: 1 }, opKey: 'k-0001', reason: 'test reason' }) });
    expect(form.status).toBe(400);
    expect((await raw('/v1/admin/whoami', {})).status).toBe(401);
  });

  it('parses ADMIN_CONSOLE_ORIGINS strictly', () => {
    expect(parseConsoleOrigins(' https://ops.example.com, http://127.0.0.1:9217 ,*,https://x.com/path')).toEqual(['https://ops.example.com', 'http://127.0.0.1:9217']);
  });
});

describe('remote config dry runs and diff (REQ-OPS-008/009)', () => {
  it('validate groups the problems (day rule, asset catalog, gacha)', async () => {
    const { call } = await setup();
    const bad = await call('viewer', 'POST', '/v1/admin/config/validate', { bundle: { gacha: { pityGroups: { standard: { cost: 0 } } }, assets: { ...m.assetCatalog!, catalogVersion: 0 } } });
    expect(bad.status).toBe(200);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.groups.gacha.length).toBeGreaterThan(0);
    expect(bad.body.groups.assetCatalog.length).toBeGreaterThan(0);
    expect((await call('viewer', 'POST', '/v1/admin/config/validate', { bundle: {} })).body).toMatchObject({ ok: true, problems: [] });
    expect(groupProblems(['progression.dayRollover: x', 'assets: y', 'banner b: z', 'ruleset q', 'other'])).toEqual({ dayRule: ['progression.dayRollover: x'], assetCatalog: ['assets: y'], gacha: ['banner b: z'], ruleset: ['ruleset q'], other: ['other'] });
  });

  it('dry run of activate / rollback / cancel surfaces the day-rule chain and stores nothing', async () => {
    const { call, ops } = await setup();
    const dayBundle = { progression: { dayRollover: { hourJst: 4, previousHourJst: 0, effectiveAtMs: NOW + 1800_000 } } }; // under the 1 h lead time
    const st = await call('operator', 'POST', '/v1/admin/config/versions', { bundle: dayBundle, note: 'reset at 4:00', reason: 'move the reset' });
    expect(st.status).toBe(200);
    const id = st.body.version.id as string;
    const dry = await call('viewer', 'POST', '/v1/admin/config/dry-run', { op: { kind: 'activate', versionId: id } });
    expect(dry.body.ok).toBe(false);
    expect(dry.body.groups.dayRule.join()).toMatch(/dayRollover/);
    // the real call fails the same way
    expect((await call('admin', 'POST', '/v1/admin/config/activations', { versionId: id, reason: 'ship' })).body.error.message).toBe(dry.body.problems.join('; '));
    // a harmless version passes, and nothing was stored by the dry runs
    const ok = await call('operator', 'POST', '/v1/admin/config/versions', { bundle: { ng: { exact: ['ばか'], contains: [] } }, note: 'ng', reason: 'ng words' });
    const dry2 = await call('viewer', 'POST', '/v1/admin/config/dry-run', { op: { kind: 'activate', versionId: ok.body.version.id, at: NOW + 86_400_000 } });
    expect(dry2.body).toMatchObject({ ok: true, problems: [], effect: { id: '(dry run)', versionId: ok.body.version.id, at: NOW + 86_400_000 } });
    expect(ops.config.list(NOW).activations).toHaveLength(0);
    expect((await call('viewer', 'POST', '/v1/admin/config/dry-run', { op: { kind: 'rollback' } })).body).toMatchObject({ ok: false, problems: ['nothing to roll back'] });
    const act = await call('admin', 'POST', '/v1/admin/config/activations', { versionId: ok.body.version.id, at: NOW + 86_400_000, reason: 'tomorrow' });
    expect((await call('viewer', 'POST', '/v1/admin/config/dry-run', { op: { kind: 'cancel', activationId: act.body.id } })).body.ok).toBe(true);
    expect(ops.config.pending(NOW)).toHaveLength(1);
    expect((await call('viewer', 'POST', '/v1/admin/config/dry-run', { op: { kind: 'nope' } })).status).toBe(400);
    // dry runs are reads (viewer) but audited
    expect(ops.audits.rows.filter((r) => r.action === 'config.dryrun')).toHaveLength(5);
  });

  it('diff compares two versions path by path (lists of objects by id)', async () => {
    const { call } = await setup();
    const a = await call('operator', 'POST', '/v1/admin/config/versions', { bundle: { ng: { exact: ['a'], contains: [] } }, note: '', reason: 'version a' });
    const b = await call('operator', 'POST', '/v1/admin/config/versions', { bundle: { ng: { exact: ['a', 'b'], contains: ['c'] } }, note: '', reason: 'version b' });
    const d = await call('viewer', 'GET', `/v1/admin/config/diff?from=${a.body.version.id}&to=${b.body.version.id}`);
    expect(d.body.changes).toEqual([{ path: 'ng.contains', before: [], after: ['c'] }, { path: 'ng.exact', before: ['a'], after: ['a', 'b'] }]);
    expect((await call('viewer', 'GET', `/v1/admin/config/diff?from=base&to=${a.body.version.id}`)).body.changes).toEqual([{ path: 'ng', before: null, after: { exact: ['a'], contains: [] } }]);
    expect(bundleDiff({ x: [{ id: 'p', v: 1 }, { id: 'q', v: 1 }] }, { x: [{ id: 'q', v: 2 }, { id: 'p', v: 1 }] })).toEqual([{ path: 'x[q].v', before: 1, after: 2 }]);
    expect((await call('viewer', 'GET', '/v1/admin/config/diff?from=base')).status).toBe(400);
  });
});

describe('gacha calendar and odds preview (REQ-OPS-027)', () => {
  it('lists every banner with game days, pity chains and step-up prices; odds match the player page', async () => {
    const { call } = await setup();
    const cal = await call('viewer', 'GET', '/v1/admin/gacha/calendar');
    expect(cal.status).toBe(200);
    expect(cal.body.versionId).toBe('base');
    expect(cal.body.banners.map((b: { id: string }) => b.id)).toEqual(m.gacha.banners.map((b) => b.id));
    for (const b of cal.body.banners) {
      expect(['active', 'upcoming', 'hidden', 'ended']).toContain(b.status);
      if (b.endAtMs !== null) expect(b.lastDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const groups = cal.body.pityGroups as { id: string; chain: string[]; endAtMs: number | null; finalGroup: string; carryOver: unknown }[];
    expect(groups.map((g) => g.id).sort()).toEqual(Object.keys(m.gacha.pityGroups).sort());
    for (const g of groups) {
      expect(g.chain[0]).toBe(g.id);
      expect(g.chain[g.chain.length - 1]).toBe(g.finalGroup);
      expect(g.carryOver === null).toBe(g.endAtMs === null);
    }
    const stepUp = m.gacha.banners.find((b) => b.stepUp);
    if (stepUp) expect(cal.body.banners.find((b: { id: string }) => b.id === stepUp.id).stepUp.prices).toEqual(stepUp.stepUp!.steps.map((s) => s.priceTen));
    const visible = m.gacha.banners.find((b) => { try { findVisibleBanner(m, b.id, NOW); return true; } catch { return false; } })!;
    const odds = await call('viewer', 'GET', `/v1/admin/gacha/${visible.id}/odds`);
    const player = await handle(new Request(`https://x/v1/gacha/${visible.id}/odds`), {}, (await setup()).c);
    expect(odds.body.odds).toEqual(await player.json());
    expect(odds.body.odds).toEqual(JSON.parse(JSON.stringify(oddsDisclosure(m, visible))));
    expect((await call('viewer', 'GET', '/v1/admin/gacha/nope/odds')).status).toBe(404);
    expect((await call('viewer', 'GET', '/v1/admin/gacha/calendar?versionId=cfg_404')).status).toBe(404);
  });

  it('events list carries the status per event', async () => {
    const { call } = await setup();
    const ev = await call('viewer', 'GET', '/v1/admin/events');
    expect(ev.body.events).toHaveLength(m.events.length);
    for (const e of ev.body.events) expect(typeof e.status).toBe('string');
  });
});

describe('player support (REQ-OPS-020)', () => {
  it('lookup by invite code, deletion and referral summaries, parsed support flags', async () => {
    const { call, invites, svc } = await setup();
    await svc.bootstrap('p7');
    const code = await invites.codeOf('p7');
    const found = await call('viewer', 'GET', `/v1/admin/players/lookup?inviteCode=${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`);
    expect(found.body).toEqual({ playerId: 'p7', inviteCode: code });
    expect((await call('viewer', 'GET', '/v1/admin/players/lookup?inviteCode=ZZZZZZZZ')).status).toBe(400);
    await svc.inviteFlag('p7', 'invite_same_device:p8');
    const v = await call('viewer', 'GET', '/v1/admin/players/p7');
    expect(v.body.state).toMatchObject({ exists: true, accountDeleted: false, deletion: null });
    expect(v.body.flags).toEqual([{ raw: 'invite_same_device:p8', kind: 'invite_same_device', group: 'invite', detail: 'p8' }]);
    expect(v.body.state).not.toHaveProperty('idem');
    const none = await call('viewer', 'GET', '/v1/admin/players/never-seen');
    expect(none.body.state).toMatchObject({ exists: false, accountDeleted: false });
    const tok = await svc.requestDeletion('p7', null) as { confirmToken: string };
    await svc.requestDeletion('p7', tok.confirmToken);
    const d = await call('viewer', 'GET', '/v1/admin/players/p7');
    expect(d.body.state.deletion).toMatchObject({ status: 'scheduled' });
    expect(JSON.stringify(d.body.state.deletion)).not.toContain(tok.confirmToken);
  });

  it('support flags are split into kind / group / detail', async () => {
    const { parseSupportFlags } = await import('../src/http/admin.js');
    expect(parseSupportFlags(['ads_anomaly:2026-11-10', 'invite_same_device:p2', 'promotion_not_reached:promo_b:T1', 'debt_written_off:1'])).toEqual([
      { raw: 'ads_anomaly:2026-11-10', kind: 'ads_anomaly', group: 'ads', detail: '2026-11-10' },
      { raw: 'invite_same_device:p2', kind: 'invite_same_device', group: 'invite', detail: 'p2' },
      { raw: 'promotion_not_reached:promo_b:T1', kind: 'promotion_not_reached', group: 'purchase', detail: 'promo_b:T1' },
      { raw: 'debt_written_off:1', kind: 'debt_written_off', group: 'support', detail: '1' },
    ]);
  });
});

describe('compensation with the two-person rule (REQ-OPS-026)', () => {
  it('small compensation is paid at once; large needs a different admin; audited before/after', async () => {
    const { call, svc, ops } = await setup();
    const small = await call('operator', 'POST', '/v1/admin/compensations', { playerId: 'p1', grant: { freeCoins: 300 }, opKey: 'outage-small-01', reason: 'outage 11/10' });
    expect(small.status).toBe(200);
    expect(small.body.request).toMatchObject({ status: 'executed', needsApproval: false });
    expect((await svc.view('p1')).wallet.free).toBe(300);

    const big = { playerId: 'p1', grant: { freeCoins: 50_000, items: [{ itemId: 'ticket_sr_plus', qty: 2 }] }, opKey: 'outage-big-01', reason: 'long outage 11/10' };
    const req = await call('operator', 'POST', '/v1/admin/compensations', big);
    expect(req.body.request).toMatchObject({ status: 'pending', needsApproval: true, requestedBy: 'operator' });
    expect((await svc.view('p1')).wallet.free).toBe(300); // nothing paid yet
    // idempotent creation; same key with another grant is a conflict
    expect((await call('operator', 'POST', '/v1/admin/compensations', big)).body).toMatchObject({ created: false, request: { id: req.body.request.id } });
    expect((await call('operator', 'POST', '/v1/admin/compensations', { ...big, grant: { freeCoins: 60_000 } })).status).toBe(409);
    const id = req.body.request.id as string;
    expect((await call('operator', 'POST', `/v1/admin/compensations/${id}/approve`, { reason: 'looks right' })).status).toBe(403); // role
    // an admin who raised the request cannot approve it
    const own = await call('admin', 'POST', '/v1/admin/compensations', { ...big, opKey: 'outage-big-02' });
    const self = await call('admin', 'POST', `/v1/admin/compensations/${own.body.request.id}/approve`, { reason: 'self approve' });
    expect(self.status).toBe(403);
    expect(self.body.error.message).toMatch(/two-person/);
    // QA R11: the refused self-approval is audited against the request it tried to approve
    expect(ops.audits.rows.find((r) => r.action === 'compensation.approve' && r.result === 'error' && r.actor === 'admin')).toMatchObject({ actor: 'admin', error: 'FORBIDDEN', target: `compensation:${own.body.request.id}` });

    const ok = await call('admin', 'POST', `/v1/admin/compensations/${id}/approve`, { reason: 'checked the incident', note: 'INC-42' });
    expect(ok.status).toBe(200);
    expect(ok.body.request).toMatchObject({ status: 'executed', decidedBy: 'admin', decisionNote: 'INC-42' });
    const v = await svc.view('p1');
    expect(v.wallet.free).toBe(50_300);
    expect(v.wallet.paid).toBe(0); // never paid coins
    expect(v.items.ticket_sr_plus).toBe(2);
    // approving again never pays twice
    expect((await call('admin2', 'POST', `/v1/admin/compensations/${id}/approve`, { reason: 'double click' })).status).toBe(409);
    expect((await svc.view('p1')).wallet.free).toBe(50_300);
    const ledger = (await svc.state('p1')).ledger.filter((l) => l.kind === 'grant');
    expect(ledger.at(-1)!.reason).toMatch(/operator, approved by admin/);

    const audit = ops.audits.rows.find((r) => r.action === 'compensation.approve' && r.result === 'ok')!;
    expect(audit).toMatchObject({ actor: 'admin', target: 'player:p1', reason: 'checked the incident', before: { status: 'pending', requestedBy: 'operator', free: 300 }, after: { status: 'executed', approvedBy: 'admin', free: 50_300 } });

    // reject the admin's own request (anyone with operator may reject / withdraw)
    expect((await call('operator', 'POST', `/v1/admin/compensations/${own.body.request.id}/reject`, { reason: 'duplicate of comp_2' })).body.request.status).toBe('rejected');
    const list = await call('viewer', 'GET', '/v1/admin/compensations?status=executed');
    expect(list.body.requests.map((r: { id: string }) => r.id).sort()).toEqual([small.body.request.id, id].sort());
    expect(list.body.threshold).toEqual({ freeCoins: 10_000, itemQty: 100 });
    // the player view lists them
    expect((await call('viewer', 'GET', '/v1/admin/players/p1')).body.compensations).toHaveLength(3);
  });

  it('caps, free-only grants, expiry', async () => {
    const { call, setNow } = await setup();
    expect((await call('operator', 'POST', '/v1/admin/compensations', { playerId: 'p1', grant: { freeCoins: 100_001 }, opKey: 'too-big-0001', reason: 'typo' })).status).toBe(403);
    expect((await call('operator', 'POST', '/v1/admin/compensations', { playerId: 'p1', grant: { paidCoins: 10 }, opKey: 'paid-00001', reason: 'nope' })).status).toBe(400);
    expect((await call('viewer', 'POST', '/v1/admin/compensations', { playerId: 'p1', grant: { freeCoins: 1 }, opKey: 'viewer-0001', reason: 'nope' })).status).toBe(403);
    const r = await call('operator', 'POST', '/v1/admin/compensations', { playerId: 'p1', grant: { freeCoins: 20_000 }, opKey: 'expiring-01', reason: 'later' });
    setNow(NOW + COMP_TTL_MS + 1);
    expect((await call('viewer', 'GET', '/v1/admin/compensations?status=pending')).body.requests).toHaveLength(0);
    expect((await call('viewer', 'GET', '/v1/admin/compensations?status=expired')).body.requests).toHaveLength(1);
    expect((await call('admin', 'POST', `/v1/admin/compensations/${r.body.request.id}/approve`, { reason: 'too late' })).status).toBe(409);
  });

  it('bulk grants are capped per recipient at the approval threshold', async () => {
    const { call } = await setup();
    expect((await call('admin', 'POST', '/v1/admin/grants/bulk', { grant: { freeCoins: 10_001 }, opKey: 'bulk-big-01', reason: 'too much', playerIds: ['a'] })).status).toBe(403);
  });

  it('QA R11: splitting a large grant into small ones does not skip the second person (24 h budget per player)', async () => {
    const { call, svc, setNow, ops } = await setup();
    // two direct grants under the threshold each, over it together
    expect((await call('operator', 'POST', '/v1/admin/players/p1/grants', { grant: { freeCoins: 6_000 }, opKey: 'split-direct-1', reason: 'outage part 1' })).status).toBe(200);
    const second = await call('operator', 'POST', '/v1/admin/players/p1/grants', { grant: { freeCoins: 6_000 }, opKey: 'split-direct-2', reason: 'outage part 2' });
    expect(second.status).toBe(403);
    expect(second.body.error.message).toMatch(/two-person approval/);
    expect((await call('operator', 'POST', '/v1/admin/grants/bulk', { grant: { freeCoins: 6_000 }, opKey: 'split-bulk-01', reason: 'outage part 3', playerIds: ['p1'] })).body).toMatchObject({ granted: 0, failed: [{ playerId: 'p1', error: 'FORBIDDEN' }] });
    expect((await svc.view('p1')).wallet.free).toBe(6_000);
    // a small compensation over the remaining budget waits for a different admin instead of being paid
    const comp = await call('operator', 'POST', '/v1/admin/compensations', { playerId: 'p1', grant: { freeCoins: 6_000 }, opKey: 'split-comp-01', reason: 'outage part 4' });
    expect(comp.status).toBe(200);
    expect(comp.body.request).toMatchObject({ status: 'pending', needsApproval: true });
    expect((await svc.view('p1')).wallet.free).toBe(6_000);
    const ok = await call('admin', 'POST', `/v1/admin/compensations/${comp.body.request.id}/approve`, { reason: 'checked: one incident' });
    expect(ok.body.request.status).toBe('executed');
    expect((await svc.view('p1')).wallet.free).toBe(12_000);
    // items count per item too; other players have their own budget; the window rolls over
    expect((await call('operator', 'POST', '/v1/admin/players/p2/grants', { grant: { freeCoins: 10_000 }, opKey: 'other-player-1', reason: 'outage' })).status).toBe(200);
    setNow(NOW + 24 * 3600 * 1000 + 1);
    expect((await call('operator', 'POST', '/v1/admin/players/p1/grants', { grant: { freeCoins: 6_000 }, opKey: 'split-direct-3', reason: 'next day' })).status).toBe(200);
    expect(ops.audits.rows.some((r) => r.action === 'player.grant' && r.result === 'error' && r.error === 'FORBIDDEN')).toBe(true);
  });
});

describe('tournaments list for the console', () => {
  it('answers NOT_FOUND when tournaments are not served', async () => {
    const { call } = await setup();
    expect((await call('viewer', 'GET', '/v1/admin/tournaments')).status).toBe(404);
  });
});
