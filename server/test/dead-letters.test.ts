import { describe, expect, it } from 'vitest';
import { m, makeConfig } from './helpers.js';
import { MAX_ROLLOVER_ATTEMPTS, newRolloverState, rolloverStep } from '../src/domain/leaderboard.js';
import { RaceRoomCore, CMD } from '../src/domain/raceRoom.js';
import { seededRng } from '../src/domain/rng.js';
import { driveSettlement, MAX_SETTLE_ATTEMPTS, newSettleMeta, type SettleDeps } from '../src/race/settlement.js';
import {
  dismissRolloverItem, dismissSettlementItem, MODERATION_DEAD_AFTER, retryRolloverItem, retrySettlementItem, rolloverDeadLetters, settlementDeadLetters,
  type DeadLetterOwner, type DeadLetterItem, type RetryOutcome,
} from '../src/ops/deadLetter.js';
import { dropModeration, enqueueModeration, flushModeration, MemoryModerationOutbox, retryModerationNow, stuckModeration } from '../src/ops/moderationOutbox.js';
import { handle, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { memoryOps } from '../src/ops/memoryOps.js';
import { authenticateAdmin } from '../src/ops/admin.js';
import { sha256Hex } from '../src/ops/hash.js';
import { DEFAULT_RULESET } from '../src/domain/ruleset.js';
import { AppError } from '../src/domain/errors.js';

const NOW = Date.UTC(2026, 11, 2, 3);

describe('dead letters: rollover items (season / team / event) — REQ-OPS-041', () => {
  it('a dead-lettered player can be retried (idempotent close) or dismissed with a note', async () => {
    let st = newRolloverState('2026-10');
    st.status = 'closing';
    const broken = new Set(['b']);
    const closed: string[] = [];
    for (let run = 0; run < MAX_ROLLOVER_ATTEMPTS + 1; run++) {
      st = await rolloverStep(st, [{ playerId: 'a', classId: 'C' }, { playerId: 'b', classId: 'C' }, { playerId: 'c', classId: 'C' }], () => undefined, async (pid) => {
        if (broken.has(pid)) throw new Error('corrupt state');
        if (!closed.includes(pid)) closed.push(pid);
      }, 10);
    }
    expect(rolloverDeadLetters(st)).toEqual([{ itemId: 'b', error: 'corrupt state', attempts: MAX_ROLLOVER_ATTEMPTS }]);
    // retry while still broken: stays, attempts count up, error recorded
    let r = await retryRolloverItem(st, 'b', async () => { throw new Error('still broken'); });
    expect(r.outcome).toEqual({ ok: false, error: 'still broken' });
    expect(rolloverDeadLetters(r.st)).toEqual([{ itemId: 'b', error: 'still broken', attempts: MAX_ROLLOVER_ATTEMPTS + 1 }]);
    // fixed: retry succeeds and the item leaves the list
    broken.clear();
    r = await retryRolloverItem(r.st, 'b', async () => { closed.push('b'); });
    expect(r.outcome.ok).toBe(true);
    expect(rolloverDeadLetters(r.st)).toEqual([]);
    expect(closed.sort()).toEqual(['a', 'b', 'c']);
    await expect(retryRolloverItem(r.st, 'b', async () => {})).rejects.toBeInstanceOf(AppError); // gone: NOT_FOUND
    // dismiss keeps an audit trail on the owner
    const st2 = { ...st };
    const d = dismissRolloverItem(st2, 'b', 'ops@x', 'paid by hand (grant comp-77)', NOW);
    expect(rolloverDeadLetters(d)).toEqual([]);
    expect(d.dismissed).toEqual([{ id: 'b', error: 'corrupt state', by: 'ops@x', note: 'paid by hand (grant comp-77)', at: NOW }]);
  });
});

describe('dead letters: race settlement — REQ-OPS-041', () => {
  it('records the last error per player; a retry re-applies the kept result once the player is fixed', async () => {
    const H = (c: string) => c.repeat(64);
    const cfg = makeConfig(2, 'ranked');
    const r = new RaceRoomCore(cfg, 0, { verifySampleRate: 0, resultWaitMs: 1, rng: seededRng(1) });
    const at = (t: number) => (t + 1) * 50;
    for (const s of r.humanSlots) r.hello(s, -1, 0);
    for (let t = 0; t <= r.minResultTick + 20; t += 20) {
      for (const s of r.humanSlots) r.message(s, { t: 'ping', c: 0 }, at(t));
      r.advance(at(t));
      if (t === 60) r.message(r.humanSlots[0]!, { t: 'in', tick: 62, cmd: CMD.START }, at(t));
    }
    for (const s of r.humanSlots) r.message(s, { t: 'res', h: H('a'), order: [0, 1] }, at(r.minResultTick + 20));
    const victim = r.config.entrants[r.humanSlots[0]!]!.playerId!;
    const applied = new Map<string, number>();
    let broken = true;
    const apply = async (pid: string) => {
      if (pid === victim && broken) throw new Error('corrupt state');
      applied.set(pid, (applied.get(pid) ?? 0) + 1);
    };
    const meta = newSettleMeta({});
    const d: SettleDeps = { verify: async () => { throw new Error('unused'); }, putReplay: async () => {}, applyRace: apply, raceFinished: async () => {}, persist: async () => {} };
    let now = 0;
    let res = await driveSettlement(r, meta, d, now);
    for (let i = 0; i < MAX_SETTLE_ATTEMPTS + 5 && res.retryAt !== null; i++) { now = res.retryAt; res = await driveSettlement(r, meta, d, now); }
    const items = settlementDeadLetters(meta);
    expect(items).toEqual([{ itemId: victim, error: 'corrupt state', attempts: MAX_SETTLE_ATTEMPTS }]);
    broken = false;
    expect(await retrySettlementItem(meta, victim, apply)).toEqual({ ok: true });
    expect(applied.get(victim)).toBe(1);
    expect(settlementDeadLetters(meta)).toEqual([]);
    await expect(retrySettlementItem(meta, victim, apply)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('dismiss moves the player to the dismissed log', () => {
    const meta = { ...newSettleMeta({}), deadLetter: ['p1'], deadLetterErrors: { p1: { error: 'x', attempts: 10 } } };
    dismissSettlementItem(meta, 'p1', 'ops', 'refunded entry by hand', NOW);
    expect(meta.deadLetter).toEqual([]);
    expect(meta.dismissed).toEqual([{ id: 'p1', error: 'x', by: 'ops', note: 'refunded entry by hand', at: NOW }]);
  });
});

describe('dead letters: moderation pushes — REQ-OPS-041', () => {
  it('lists decisions failing MODERATION_DEAD_AFTER+ times; retry delivers; dismiss drops', async () => {
    const store = new MemoryModerationOutbox();
    enqueueModeration(store, [{ playerId: 'p1', status: 'quarantined', until: NOW + 1, reason: 'auto' }, { playerId: 'p2', status: 'banned', until: null, reason: 'x' }] as never, 0);
    let t = 0;
    for (let i = 0; i < MODERATION_DEAD_AFTER; i++) { t += 4_000_000; await flushModeration(store, async () => { throw new Error('player DO down'); }, t); }
    expect(stuckModeration(store, MODERATION_DEAD_AFTER).map((i) => i.change.playerId).sort()).toEqual(['p1', 'p2']);
    const pushed: string[] = [];
    expect(await retryModerationNow(store, 'p1', async (c) => { pushed.push(c.playerId); }, t)).toEqual({ ok: true });
    expect(pushed).toEqual(['p1']);
    expect(await retryModerationNow(store, 'p1', async () => { throw new Error('never called'); }, t)).toEqual({ ok: true }); // already delivered
    expect(dropModeration(store, 'p2')).toBe(true);
    expect(stuckModeration(store, 0)).toEqual([]);
  });
});

describe('dead letters admin API — REQ-OPS-041', () => {
  class FakeOwner implements DeadLetterOwner {
    items = new Map<string, DeadLetterItem>([['p1', { itemId: 'p1', error: 'corrupt', attempts: 5 }], ['p2', { itemId: 'p2', error: 'corrupt', attempts: 5 }]]);
    retries: string[] = [];
    failNext = false;
    async list() { return [...this.items.values()]; }
    async retry(_scope: string, id: string): Promise<RetryOutcome> {
      this.retries.push(id);
      if (this.failNext) { this.failNext = false; return { ok: false, error: 'still corrupt' }; }
      this.items.delete(id);
      return { ok: true };
    }
    async dismiss(_scope: string, id: string) { this.items.delete(id); }
  }

  async function setup() {
    const owner = new FakeOwner();
    const invoker = { invoke: async () => ({}) } as unknown as PlayerInvoker;
    const ops = memoryOps(m, () => invoker, { deadLetterOwners: { season: owner } });
    const tokens = { viewer: 'viewer-token-0123456789', operator: 'operator-token-0123456789', admin: 'admin-token-0123456789' };
    const auth = { tokens: await Promise.all((Object.keys(tokens) as (keyof typeof tokens)[]).map(async (role) => ({ name: role, role, sha256: await sha256Hex(tokens[role]) }))) };
    const c = {
      master: m, authenticate: async () => { throw new AppError('UNAUTHORIZED'); }, player: () => invoker, clock: () => NOW,
      ops: ops.api, authenticateAdmin: (req: Request) => authenticateAdmin(req, auth),
      configInfo: async () => ({ versionId: 'base', hash: 'base', rulesetVersion: DEFAULT_RULESET.rulesetVersion, activatedAt: null }),
      leaderboard: { board: async () => ({}), myRank: async () => ({}) }, paidBalance: async () => ({}), race: { replay: async () => ({}) },
    } as unknown as AppContext;
    const call = async (role: keyof typeof tokens, method: string, path: string, body?: unknown) => {
      const res = await handle(new Request(`https://x${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[role]}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), {}, c);
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    return { call, owner, ops };
  }

  it('inspect syncs the index; retry needs operator, dismiss needs admin + note; both are audited and idempotent', async () => {
    const { call, owner, ops } = await setup();
    const ins = await call('viewer', 'GET', '/v1/admin/dead-letters/season/2026-10');
    expect(ins.status).toBe(200);
    expect(ins.body.items.map((i: { itemId: string }) => i.itemId)).toEqual(['p1', 'p2']);
    expect((await call('viewer', 'GET', '/v1/admin/dead-letters?status=open')).body.items).toHaveLength(2);
    expect((await call('viewer', 'POST', '/v1/admin/dead-letters/season/2026-10/p1/retry', { reason: 'fixed state' })).status).toBe(403);
    // a failing retry keeps it open with the new error
    owner.failNext = true;
    const fail = await call('operator', 'POST', '/v1/admin/dead-letters/season/2026-10/p1/retry', { reason: 'fixed state' });
    expect(fail.body).toMatchObject({ status: 'open', error: 'still corrupt', attempts: 6 });
    const ok = await call('operator', 'POST', '/v1/admin/dead-letters/season/2026-10/p1/retry', { reason: 'fixed state' });
    expect(ok.body).toMatchObject({ status: 'resolved', resolvedBy: 'operator' });
    // repeating the same retry is a no-op (the owner is not called again)
    const again = await call('operator', 'POST', '/v1/admin/dead-letters/season/2026-10/p1/retry', { reason: 'fixed state' });
    expect(again.body.status).toBe('resolved');
    expect(owner.retries).toEqual(['p1', 'p1']);
    expect((await call('operator', 'POST', '/v1/admin/dead-letters/season/2026-10/p2/dismiss', { note: 'paid by hand', reason: 'manual' })).status).toBe(403);
    expect((await call('admin', 'POST', '/v1/admin/dead-letters/season/2026-10/p2/dismiss', { reason: 'manual' })).status).toBe(400); // note required
    const dis = await call('admin', 'POST', '/v1/admin/dead-letters/season/2026-10/p2/dismiss', { note: 'paid by hand (comp-12)', reason: 'manual' });
    expect(dis.body).toMatchObject({ status: 'dismissed', note: 'paid by hand (comp-12)' });
    expect((await call('viewer', 'GET', '/v1/admin/dead-letters?status=open')).body.items).toHaveLength(0);
    expect((await call('viewer', 'GET', '/v1/admin/dead-letters?status=all')).body.items).toHaveLength(2);
    expect((await call('viewer', 'GET', '/v1/admin/dead-letters/nope/x')).status).toBe(400);
    expect((await call('viewer', 'GET', '/v1/admin/dead-letters/team/2026-10')).status).toBe(404); // no owner wired in this test
    const actions = ops.audits.rows.filter((r) => r.result === 'ok').map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['deadletter.inspect', 'deadletter.retry', 'deadletter.dismiss']));
  });
});
