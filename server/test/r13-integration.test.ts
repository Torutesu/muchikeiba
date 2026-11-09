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
import { classifyLedger, COIN_TITLES } from '../src/domain/history.js';
import { grantFree } from '../src/domain/wallet.js';

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
    expect(r).toMatchObject({ status: 'rewarded', reward: { freeCoins: 8 } });
    // nothing reaches the wallet until the player claims it
    expect(w.state('a').wallet.free).toBe(free0);
    expect(w.state('a').items.breeding_material ?? 0).toBe(mat0);
    const box = (await w.svc.giftBox('a', 'box', 0, 50)).entries;
    expect(box).toHaveLength(1);
    expect(box[0]).toMatchObject({ source: 'team_goal', titleKey: 'team_goal', title: '支部の共同目標の報酬', contents: { freeCoins: 8, items: [{ itemId: 'breeding_material', qty: 1 }] } });
    // the alarm running again is a no-op (one gift, one payment)
    expect((await w.svc.teamGoalReward('a', WEEK, 'team_1', 2, 12))!.status).toBe('already');
    expect((await w.svc.giftBox('a', 'box', 0, 50)).entries).toHaveLength(1);
    await w.svc.giftClaimAll('a', 'c:claim');
    expect(w.state('a').wallet.free).toBe(free0 + 8);
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

describe('account deletion clears the Round 13 state', () => {
  it('exchange points, weekly challenge progress, team goal state, gacha log and gift box go with the wipe; late background calls never recreate it', async () => {
    const w = world(ev.startAtMs + 3_600_000);
    await w.svc.bootstrap('d');
    await w.svc.tutorialDraw('d', 'c:tut');
    const s = w.state('d');
    ensureExchange(m, s, ev).points = 90;
    w.repo.put(s);
    await w.svc.teamGoalReward('d', WEEK, 'team_1', 1, 5);
    await w.svc.wchView('d');
    const before = w.state('d');
    expect(before.gachaLog?.entries.length).toBeGreaterThan(0);
    expect(before.events?.[ev.id]?.exchange?.points).toBe(90);
    expect(before.giftBox?.box.length).toBe(1);
    expect((before as typeof before & { teamGoal?: { rewarded: string[] } }).teamGoal?.rewarded).toContain(WEEK);
    await w.svc.wipe('d');
    expect(w.repo.data.has('d')).toBe(false);
    // the team object's payout retry and a late week close are no-ops on a wiped id (no fresh state written)
    expect(await w.svc.teamGoalReward('d', '2026-12-14', 'team_1', 2, 12)).toBeNull();
    expect(w.repo.data.has('d')).toBe(false);
    await expect(w.svc.history('d', 'gacha')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(w.repo.data.has('d')).toBe(false);
  });
});

describe('§33 coin history: Round 12 / 13 rewards map to readable categories (no raw reason)', () => {
  const cases: [string, string, string][] = [
    ['rival week 2026-12-07 win', 'rival', 'ライバルの週の報酬'],
    ['team goal team_1 week 2026-12-07 tier 2', 'team_goal', '支部の共同目標の報酬'],
    ['weekly challenge 2026-12-07 wa_nige', 'weekly_challenge', '週替わりチャレンジの報酬'],
    ['exchange newyear_cup_2027_01 ex_coins_50', 'exchange', 'イベント交換所'],
    ['invite milestone first_race', 'invite', '友達招待の報酬'],
    ['tournament cup_1 rank 3', 'tournament', '大会の報酬'],
  ];
  for (const [reason, category, title] of cases) {
    it(`${reason} → ${category}`, () => {
      const c = classifyLedger(m, { reason, kind: 'grant', delta: 10 });
      expect(c).toEqual({ category, title });
      expect(COIN_TITLES[c.category]).toBe(title);
    });
  }

  it('end to end: a claimed team goal gift, a rival week and a weekly challenge row are named, never the raw reason', async () => {
    const w = world();
    await w.svc.bootstrap('a');
    await w.svc.teamGoalReward('a', WEEK, 'team_1', 2, 12);
    await w.svc.giftClaimAll('a', 'c:claim');
    const s = w.state('a');
    grantFree(s, 20, T0 + 1, 'rival week 2026-11-30 win', 'rival:2026-11-30');
    grantFree(s, 10, T0 + 2, 'weekly challenge 2026-12-07 wa_nige', 'wch:sess_1');
    w.repo.put(s);
    const page = await w.svc.history('a', 'coins', { currency: 'free', limit: 50 }) as { items: { category: string; title: string }[] };
    const cats = page.items.map((r) => r.category);
    expect(cats).toEqual(expect.arrayContaining(['team_goal', 'rival', 'weekly_challenge']));
    expect(cats).not.toContain('other');
    const text = JSON.stringify(page.items);
    expect(text).not.toMatch(/team_1|rival week|weekly challenge|wa_nige|tier 2/);
  });
});
