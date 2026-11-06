/**
 * Round 8 server QA regressions (fix/r8-server-qa): account deletion races with the player's own transactions.
 */
import { describe, expect, it } from 'vitest';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { runAccountDeletion, type DeletionPorts, type RetainedRecord } from '../src/domain/accountDeletion.js';
import type { PublicProfile } from '../src/domain/stats.js';
import type { PaidBalanceSnapshot } from '../src/domain/accounting.js';
import { m } from './helpers.js';

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
});
