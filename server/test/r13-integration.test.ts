/**
 * Round 13 integration: how the four Round 13 features meet Round 12 (gift box §26.1 routing) and each other.
 */
import { describe, expect, it } from 'vitest';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { exchangeClosesAt, ensureExchange } from '../src/domain/exchange.js';
import { dayRule } from '../src/domain/time.js';
import type { PlayerState } from '../src/domain/player.js';
import { m } from './helpers.js';

const ev = m.events.find((e) => e.exchange)!;
const CLOSES = exchangeClosesAt(ev, ev.exchange!, dayRule(m));
const WEEK = '2026-12-07';
const T0 = Date.UTC(2026, 11, 9, 3); // Wed 2026-12-09 12:00 JST

function world(start = T0) {
  let now = start;
  const repo = new MemoryPlayerRepo();
  const svc = new PlayerService(repo, { master: m, rng: seededRng(7), clock: () => now, verifiers: {} });
  return { svc, repo, state: (u: string) => repo.get(u) as PlayerState, set: (t: number) => { now = t; } };
}

describe('§26.1 gift box routing for Round 13 rewards', () => {
  it('a team goal week reward (paid by the team object in the background) arrives in the gift box, once', async () => {
    const w = world();
    await w.svc.bootstrap('a');
    const free0 = w.state('a').wallet.free;
    const mat0 = w.state('a').items.breeding_material ?? 0;
    const r = await w.svc.teamGoalReward('a', WEEK, 'team_1', 2, 12);
    expect(r).toMatchObject({ status: 'rewarded', reward: { freeCoins: 10 } });
    // nothing reaches the wallet until the player claims it
    expect(w.state('a').wallet.free).toBe(free0);
    expect(w.state('a').items.breeding_material ?? 0).toBe(mat0);
    const box = (await w.svc.giftBox('a', 'box', 0, 50)).entries;
    expect(box).toHaveLength(1);
    expect(box[0]).toMatchObject({ source: 'team_goal', titleKey: 'team_goal', title: '支部の共同目標の報酬', contents: { freeCoins: 10, items: [{ itemId: 'breeding_material', qty: 1 }] } });
    // the alarm running again is a no-op (one gift, one payment)
    expect((await w.svc.teamGoalReward('a', WEEK, 'team_1', 2, 12))!.status).toBe('already');
    expect((await w.svc.giftBox('a', 'box', 0, 50)).entries).toHaveLength(1);
    await w.svc.giftClaimAll('a', 'c:claim');
    expect(w.state('a').wallet.free).toBe(free0 + 10);
    expect(w.state('a').items.breeding_material ?? 0).toBe(mat0 + 1);
    expect(w.state('a').wallet.paid).toBe(0);
  });

  it('exchange leftover points (converted in the background after the close) arrive in the gift box, once', async () => {
    const w = world(ev.startAtMs + 3_600_000);
    await w.svc.bootstrap('p');
    const s = w.state('p');
    ensureExchange(m, s, ev).points = 130;
    w.repo.put(s);
    const mat0 = s.items.breeding_material ?? 0;
    w.set(CLOSES + 1000);
    const v = await w.svc.exchangeView('p', ev.id);
    expect(v.leftover.converted).toMatchObject({ points: 130, qty: 2 });
    expect(w.state('p').items.breeding_material ?? 0).toBe(mat0);
    const box = (await w.svc.giftBox('p', 'box', 0, 50)).entries;
    expect(box).toHaveLength(1);
    expect(box[0]).toMatchObject({ source: 'exchange', titleKey: 'exchange', contents: { items: [{ itemId: 'breeding_material', qty: 2 }] } });
    // later transactions never convert or deliver again
    await w.svc.exchangeView('p', ev.id);
    await w.svc.view('p');
    expect((await w.svc.giftBox('p', 'box', 0, 50)).entries).toHaveLength(1);
    await w.svc.giftClaimAll('p', 'c:x');
    expect(w.state('p').items.breeding_material ?? 0).toBe(mat0 + 2);
  });
});
