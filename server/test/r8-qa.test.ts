/**
 * Round 8 server QA regressions (fix/r8-server-qa): account deletion races with the player's own transactions.
 */
import { describe, expect, it } from 'vitest';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { applyRetainedRefund, runAccountDeletion, type DeletionPorts, type RetainedRecord } from '../src/domain/accountDeletion.js';
import { handle, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { grantAllowance } from '../src/domain/shop.js';
import { newPlayer } from '../src/domain/player.js';
import type { PublicProfile } from '../src/domain/stats.js';
import type { PaidBalanceSnapshot } from '../src/domain/accounting.js';
import { m } from './helpers.js';
import { SqlPlayerRepo, wipePlayerStorage } from '../src/do/sqlRepo.js';

const T0 = Date.UTC(2026, 10, 5, 3); // 12:00 JST
const DAY = 86_400_000;

function setup() {
  let now = T0;
  const repo = new MemoryPlayerRepo();
  const store = new FakeStoreVerifier();
  const profiles = new Map<string, PublicProfile>();
  const paid: PaidBalanceSnapshot[] = [];
  const svc = new PlayerService(repo, {
    master: m, rng: seededRng(7), clock: () => now, verifiers: { fake: store },
    onProfile: (p) => { profiles.set(p.playerId, p); },
    onPaidBalance: (s) => { paid.push(s); },
  });
  return { svc, repo, store, profiles, paid, advance: (ms: number) => { now += ms; }, now: () => now };
}

function ports(svc: PlayerService, over: Partial<DeletionPorts> & { forgetDir?: (u: string) => void } = {}): DeletionPorts {
  return {
    start: async (u) => { await svc.deletionStart(u); },
    snapshot: (u) => svc.deletionSnapshot(u),
    markStep: async (u, st) => { await svc.deletionMarkStep(u, st); },
    friends: { removeFriend: async () => undefined, dropOutgoing: async () => undefined, dropIncoming: async () => undefined },
    directory: { forget: async (u) => { over.forgetDir?.(u); } },
    leaderboards: { forget: async () => undefined, deleteGhosts: async () => undefined },
    finalize: (u) => svc.deletionFinalize(u),
    retain: async () => undefined,
    wipe: (u) => svc.wipe(u),
    ...over,
  };
}

async function scheduleDeletion(svc: PlayerService, advance: (ms: number) => void) {
  const t = ((await svc.requestDeletion('p', null)) as { confirmToken: string }).confirmToken;
  await svc.requestDeletion('p', t);
  advance(14 * DAY);
}

describe('r8 QA: account deletion vs the player\'s own transactions', () => {
  it('a resumed deletion does not put the public profile back into the directory after the stud/directory step', async () => {
    const { svc, profiles, advance, now } = setup();
    await svc.bootstrap('p');
    expect(profiles.has('p')).toBe(true);
    await scheduleDeletion(svc, advance);
    let failLb = true;
    const p = ports(svc, {
      forgetDir: (u) => { profiles.delete(u); },
      leaderboards: { forget: async () => { if (failLb) { failLb = false; throw new Error('leaderboard down'); } }, deleteGhosts: async () => undefined },
    });
    await expect(runAccountDeletion(p, 'p', now())).rejects.toThrow('leaderboard down');
    expect(profiles.has('p')).toBe(false); // the directory step ran
    advance(10 * 60_000); // past profilePushIntervalMs: a plain transaction would refresh the public profile
    await svc.deletionRetryLater('p');
    await runAccountDeletion(p, 'p', now());
    expect(profiles.has('p')).toBe(false);
  });

  it('a purchase granted while the retained record is being stored is forfeited and kept in the retained record', async () => {
    const { svc, repo, store, advance, now } = setup();
    await svc.bootstrap('p');
    await svc.setAge('p', 1990, 1, false);
    await svc.purchase('p', 'fake', 'coin_160', store.issue({ transactionId: 'TX1', productId: 'coin_160', purchasedAt: now(), priceYen: 160 }));
    await scheduleDeletion(svc, advance);
    const retained: RetainedRecord[] = [];
    let raced = false;
    const p = ports(svc, {
      retain: async (_u, r) => {
        // the account still works until the wipe: a store purchase lands while the record travels to AccountingDO
        if (!raced) {
          raced = true;
          await svc.purchase('p', 'fake', 'coin_480', store.issue({ transactionId: 'TX2', productId: 'coin_480', purchasedAt: now(), priceYen: 480 }));
        }
        retained.push(structuredClone(r));
      },
    });
    await runAccountDeletion(p, 'p', now());
    expect(repo.data.has('p')).toBe(false);
    const last = retained[retained.length - 1]!;
    expect(new Set(retained.map((r) => r.anonId)).size).toBe(1); // one anonymous id, the record is replaced
    expect(last.purchases.map((x) => x.txId)).toEqual(['TX1', 'TX2']);
    expect(last.monthlySpendYen).toEqual({ '2026-11': 640 });
    // TX1: 100 paid + 100 free bonus; TX2: 310 paid + 310 free bonus — every coin is given up in the ledger
    expect(last.forfeited.paidCoins).toBe(410);
    expect(last.forfeited.freeCoins).toBe(410);
    const forfeits = last.ledger.filter((e) => e.kind === 'forfeit');
    expect(forfeits.reduce((a, e) => a + e.delta, 0)).toBe(-820);
    const lastRow = last.ledger[last.ledger.length - 1]!;
    expect(lastRow.balanceAfter).toBe(0);
  });

  it('no paid-balance report for the deleted player is sent after the balances were forfeited (it would outlive retainDeleted)', async () => {
    const { svc, store, paid, advance, now } = setup();
    await svc.bootstrap('p');
    await svc.setAge('p', 1990, 1, false);
    await svc.purchase('p', 'fake', 'coin_160', store.issue({ transactionId: 'TX1', productId: 'coin_160', purchasedAt: now(), priceYen: 160 }));
    await scheduleDeletion(svc, advance);
    const before = paid.length;
    await runAccountDeletion(ports(svc), 'p', now());
    expect(paid.slice(before)).toEqual([]);
  });

  it('deliveries from other objects after the wipe (season / tournament / event / team rewards, stud fees, pushes) do not recreate the player', async () => {
    const { svc, repo, advance, now } = setup();
    await svc.bootstrap('p');
    await scheduleDeletion(svc, advance);
    await runAccountDeletion(ports(svc), 'p', now());
    expect(repo.data.has('p')).toBe(false);
    // boards and brackets keep a renamed row of a deleted player until their close; their payouts still arrive
    await svc.closeSeason('p', '2026-11', 3);
    await svc.tournamentClose('p', 'tour1', 1, { freeCoins: 500 }, '大会');
    await svc.eventClose('p', m.events[0]!.id, 1);
    await svc.teamSeasonReward('p', '2026-11', 'tm1', 1, 10);
    await svc.studSettle('p', 'stud:b:c:1', true, { borrowerId: 'b', horseId: 'h1', fee: 100, foalId: 'h9' });
    await svc.queuePush('p', 'friend_request', { name: 'x' });
    await svc.nudgeTaBeaten('p', 'x', 'kirameki_turf_2000');
    expect(repo.data.has('p')).toBe(false);
  });

  it('a pass refund that arrives after the balances were forfeited takes back only what the pass really gave', async () => {
    const { svc, repo, store, advance, now } = setup();
    await svc.bootstrap('p');
    await svc.setAge('p', 1990, 1, false);
    await svc.purchase('p', 'fake', 'season_pass', store.issue({ transactionId: 'TXP', productId: 'season_pass', purchasedAt: now(), priceYen: 1000 }));
    const st = JSON.parse(repo.data.get('p')!); st.seasonPass.xp = 250; repo.data.set('p', JSON.stringify(st)); // level 2
    await svc.claimPass('p', 'premium', 1, 'c:k1');
    await svc.claimPass('p', 'free', 1, 'c:k2');
    const t = ((await svc.requestDeletion('p', null)) as { confirmToken: string }).confirmToken;
    await svc.requestDeletion('p', t);
    advance(DAY); // still inside the season
    await svc.deletionMarkStep('p', 'friends');
    await svc.deletionFinalize('p');
    const r = await svc.refund('p', 'TXP');
    // premium level 1 was granted (50 free coins + 1 breeding material); levels never reached or paid are not "taken back"
    expect(r.linkedClawback).toEqual({ freeCoins: 50, items: { breeding_material: 1 } });
    // nothing is paid out automatically at the season close either
    advance(30 * DAY);
    await svc.deletionMarkStep('p', 'stud');
    const after = await svc.state('p');
    expect(after.ledger.filter((e) => e.reason.includes('auto, season'))).toEqual([]);
  });

  it('Durable Object storage: after the wipe the player object answers "no player" instead of failing on missing tables', async () => {
    // node:sqlite stands in for the object's SQLite; deleteAll() drops every table, as Durable Object storage does
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    const sql = {
      exec: (q: string, ...b: unknown[]) => {
        const st = db.prepare(q);
        const rows = /^\s*(select|with)/i.test(q) ? (st.all(...(b as never[])) as unknown[]) : (st.run(...(b as never[])), []);
        return { toArray: () => rows, one: () => rows[0] };
      },
    } as unknown as SqlStorage;
    const storage = {
      sql,
      deleteAll: async () => {
        for (const r of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]) db.exec(`DROP TABLE "${r.name}"`);
      },
    } as unknown as DurableObjectStorage;
    const repo = new SqlPlayerRepo(sql);
    const svc = new PlayerService(repo, { master: m, rng: seededRng(1), clock: () => T0, verifiers: {} });
    await svc.bootstrap('p');
    expect(repo.get('p')).not.toBeNull();
    await wipePlayerStorage(storage);
    expect(repo.get('p')).toBeNull();
    // a like that arrives in the same instance after the wipe is not counted and creates nothing
    expect(await svc.stableLikeReceive('p', 'x', 'x:2026-11-05:0')).toMatchObject({ counted: false });
    await svc.tournamentClose('p', 'tour1', 1, { freeCoins: 10 }, 'x');
    expect(repo.get('p')).toBeNull();
  });
});

const invokerOf = (svc: PlayerService): PlayerInvoker => ({ invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] });
const codeOf = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as { code: string }).code; } };

describe('r8 QA follow-up', () => {
  it('a store refund for a deleted account is recorded on the retained record (not dropped), once', async () => {
    const { svc, repo, store, advance, now } = setup();
    await svc.bootstrap('p');
    await svc.setAge('p', 1990, 1, false);
    await svc.purchase('p', 'fake', 'coin_480', store.issue({ transactionId: 'TX1', productId: 'coin_480', purchasedAt: now(), priceYen: 480 }));
    await scheduleDeletion(svc, advance);
    const retained = new Map<string, RetainedRecord>();
    await runAccountDeletion(ports(svc, { retain: async (_u, r) => { retained.set(r.anonId, structuredClone(r)); } }), 'p', now());
    const anonId = [...retained.keys()][0]!;
    // AccountingDO re-points the store transaction to the anonymous id, so the refund notification resolves to it
    const c = {
      master: m, authenticate: async () => 'u', player: () => invokerOf(svc), clock: now,
      parseStoreNotification: async () => ({ kind: 'refund', playerId: anonId, transactionId: 'TX1' }),
      retainedRefund: async (anon: string, txId: string) => {
        const r = retained.get(anon);
        if (!r) return null;
        const out = applyRetainedRefund(r, txId, now());
        retained.set(anon, out.record);
        return out.result;
      },
    } as unknown as AppContext;
    const post = () => handle(new Request('https://x/v1/store/notifications/apple', { method: 'POST', body: '{}' }), {}, c);
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ retained: true, anonId, transactionId: 'TX1', alreadyRefunded: false, priceYen: 480, paidCoins: 310, bonusCoins: 310 });
    const rec = retained.get(anonId)!;
    expect(rec.purchases.find((x) => x.txId === 'TX1')!.refunded).toBe(true);
    expect(rec.refundsAfterDeletion).toEqual([{ txId: 'TX1', at: now(), priceYen: 480, paidCoins: 310, bonusCoins: 310 }]);
    const last = rec.ledger[rec.ledger.length - 1]!;
    expect(last).toMatchObject({ kind: 'refund', delta: 0, balanceAfter: 0, ref: 'TX1', seq: rec.ledger[rec.ledger.length - 2]!.seq + 1 });
    expect(rec.rev).toBeGreaterThan(0);
    expect(await (await post()).json()).toMatchObject({ retained: true, alreadyRefunded: true });
    expect(retained.get(anonId)!.refundsAfterDeletion).toHaveLength(1);
    expect(repo.data.has(anonId)).toBe(false); // no player state is created for the anonymous id
  });

  it('once the deletion run has started: friends, race / time attack / event entries and likes are refused; the pending window stays usable', async () => {
    const { svc, repo, advance } = setup();
    for (const id of ['p', 'q']) await svc.bootstrap(id);
    await svc.tutorialDraw('p', 'c:t1');
    const horseId = (await svc.state('p')).horses[0]!.id;
    const t = ((await svc.requestDeletion('p', null)) as { confirmToken: string }).confirmToken;
    await svc.requestDeletion('p', t);
    // pending (scheduled) window: still usable
    expect(await codeOf(svc.raceEntry('p', horseId))).toBe('ok');
    expect(await codeOf(svc.friendSend('p', 'q'))).toBe('ok');
    advance(14 * DAY);
    await svc.deletionMarkStep('p', 'friends');
    const before = JSON.stringify((await svc.state('p') as unknown as { stable?: unknown }).stable ?? null);
    expect(await codeOf(svc.friendSend('p', 'q'))).toBe('DELETION_PENDING');
    expect(await codeOf(svc.friendReceive('p', 'q'))).toBe('DELETION_PENDING');
    expect(await codeOf(svc.friendAccept('p', 'q'))).toBe('DELETION_PENDING');
    expect(await codeOf(svc.friendAccepted('p', 'q'))).toBe('DELETION_PENDING');
    expect(await codeOf(svc.friendInvite('p', 'q', 'abc'))).toBe('DELETION_PENDING');
    expect(await codeOf(svc.raceEntry('p', horseId))).toBe('DELETION_PENDING');
    expect(await codeOf(svc.tournamentEntry('p', horseId))).toBe('DELETION_PENDING');
    expect(await codeOf(svc.taStart('p', 'kirameki_turf_2000', horseId))).toBe('DELETION_PENDING');
    expect(await codeOf(svc.taPrepare('p', 'sess', [], 'h', {}))).toBe('DELETION_PENDING');
    expect(await codeOf(svc.eventEnter('p', m.events[0]!.id, horseId, 'c:e1'))).toBe('DELETION_PENDING');
    expect(await codeOf(svc.stableLikeGive('p', 'q', 'c:l1'))).toBe('DELETION_PENDING');
    expect(JSON.stringify((JSON.parse(repo.data.get('p')!) as { stable?: unknown }).stable ?? null)).toBe(before); // liker's counter untouched
  });

  it('a cancel after the run has started is refused with DELETION_IN_PROGRESS; a cancel before the run starts stops it cleanly', async () => {
    const { svc, repo, advance, now } = setup();
    await svc.bootstrap('p');
    await scheduleDeletion(svc, advance);
    // the run marks itself started before touching anything else
    let cancelled = 'not tried';
    const p = ports(svc, { friends: { removeFriend: async () => undefined, dropOutgoing: async () => undefined, dropIncoming: async () => undefined } });
    const origSnapshot = p.snapshot;
    p.snapshot = async (u) => { cancelled = await codeOf(svc.cancelDeletion(u)); return origSnapshot(u); };
    await runAccountDeletion(p, 'p', now());
    expect(cancelled).toBe('DELETION_IN_PROGRESS');
    expect(repo.data.has('p')).toBe(false);
    // cancelled before the alarm runs: the run stops before its first step
    await svc.bootstrap('r');
    const t = ((await svc.requestDeletion('r', null)) as { confirmToken: string }).confirmToken;
    await svc.requestDeletion('r', t);
    advance(14 * DAY);
    await svc.cancelDeletion('r');
    const calls: string[] = [];
    await expect(runAccountDeletion(ports(svc, { forgetDir: (u) => { calls.push(u); } }), 'r', now())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(calls).toEqual([]);
    expect(repo.data.has('r')).toBe(true);
  });

  it('daily pack refund after its entitlement was pruned still takes back the claimed coins (linkedFree)', async () => {
    const { svc, repo, store, advance, now } = setup();
    await svc.bootstrap('p');
    await svc.setAge('p', 1990, 1, false);
    await svc.purchase('p', 'fake', 'stable_allowance_30d', store.issue({ transactionId: 'TXA', productId: 'stable_allowance_30d', purchasedAt: now(), priceYen: 480 }));
    await svc.claimAllowance('p', 'c:a1');
    advance(DAY);
    await svc.claimAllowance('p', 'c:a2');
    const st = JSON.parse(repo.data.get('p')!); st.shop.allowances = []; repo.data.set('p', JSON.stringify(st)); // pruned long ago
    const r = await svc.refund('p', 'TXA');
    expect(r.linkedClawback.freeCoins).toBe(60);
  });

  it('grantAllowance keeps at most ALLOWANCE_KEEP entitlements even when 12 are running or queued', () => {
    const s = newPlayer('p', T0, '2026-11');
    const p = m.products.find((x) => x.kind === 'allowance')!;
    s.shop = { offers: {}, allowances: [{ txId: 'old', productId: p.id, startDate: '2025-01-01', days: 30, dailyFreeCoins: 30, claimed: [] }] };
    for (let i = 0; i < 12; i++) grantAllowance(m, s, p, `tx${i}`, T0);
    expect(s.shop.allowances.map((a) => a.txId)).not.toContain('old');
    expect(s.shop.allowances).toHaveLength(12);
  });

  it('a promotion pack credited without the class reached (intent skipped) is flagged for support', async () => {
    const { svc, store, now } = setup();
    await svc.bootstrap('p');
    await svc.setAge('p', 1990, 1, false);
    await svc.purchase('p', 'fake', 'promo_pack_S', store.issue({ transactionId: 'TXS', productId: 'promo_pack_S', purchasedAt: now(), priceYen: 1500 }));
    expect((await svc.state('p')).supportFlags).toContain('promotion_not_reached:promo_pack_S:TXS');
  });
});
