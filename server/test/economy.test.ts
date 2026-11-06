import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { simulateAll, type EconomyResult } from '../src/sim/economy.js';
import { oddsDisclosure } from '../src/domain/gacha.js';

// docs/spec/balance-targets.md E-*: the economy, simulated with the real PlayerService and master data.
describe('economy targets (90 days, 3 seeds)', () => {
  let res: Record<string, EconomyResult>;
  const run = async () => (res ??= await simulateAll(m, 90, [1, 2, 3]));

  it('E1-E3 a free player who plays daily: ~1 ten-pull a week, about 2 SSR a month, pity in about 2 months', async () => {
    const r = (await run()).f2p!;
    expect(r.pullsPerMonth).toBeGreaterThanOrEqual(40);
    expect(r.pullsPerMonth).toBeLessThanOrEqual(65);
    expect(r.ssrPerMonth).toBeGreaterThanOrEqual(1.2);
    expect(r.ssrPerMonth).toBeLessThanOrEqual(2.8);
    expect(r.firstPityDay).not.toBeNull();
    expect(r.firstPityDay!).toBeGreaterThanOrEqual(40);
    expect(r.firstPityDay!).toBeLessThanOrEqual(75);
  }, 600_000);

  it('E4 a casual free player still pulls every couple of weeks', async () => {
    const r = (await run()).f2p_casual!;
    expect(r.pullsPerMonth).toBeGreaterThanOrEqual(15);
    expect(r.pullsPerMonth).toBeLessThanOrEqual(40);
  }, 600_000);

  it('E5-E6 paying helps, but a free player is never far behind', async () => {
    const all = await run();
    const f = all.f2p!.pullsPerMonth;
    expect(all.light!.pullsPerMonth / f).toBeGreaterThanOrEqual(1.15);
    expect(all.light!.pullsPerMonth / f).toBeLessThanOrEqual(1.6);
    expect(all.medium!.pullsPerMonth / f).toBeGreaterThanOrEqual(1.8);
    expect(all.medium!.pullsPerMonth / f).toBeLessThanOrEqual(3.0);
  }, 600_000);

  it('E10 the daily pack (厩舎手当 ¥480) helps a little, less than the season pass (REQ-UXS-018)', async () => {
    const all = await run();
    const ratio = all.allowance!.pullsPerMonth / all.f2p!.pullsPerMonth;
    expect(ratio).toBeGreaterThanOrEqual(1.05);
    expect(ratio).toBeLessThanOrEqual(1.4);
    expect(ratio).toBeLessThan(all.light!.pullsPerMonth / all.f2p!.pullsPerMonth);
    // claimed every active day: 30 free coins a day while it runs
    expect(all.allowance!.allowanceCoins / all.allowance!.activeDays).toBeCloseTo(30, 0);
  }, 600_000);

  it('E1 note: the daily first-win bonus pays on ranked wins only and is part of the free income (REQ-UXS-010)', async () => {
    const r = (await run()).f2p!;
    expect(r.firstWinCoins).toBeGreaterThan(0);
    // at most 30+20+10 a day
    expect(r.firstWinCoins / r.activeDays).toBeLessThanOrEqual(60);
  }, 600_000);

  it('E11 the invite program (REQ-INV-*): an invited free player stays inside E1/E2, an inviter at the cap gains less than the season pass', async () => {
    const all = await run();
    const invited = all.f2p_invited!;
    expect(invited.pullsPerMonth).toBeGreaterThanOrEqual(40);
    expect(invited.pullsPerMonth).toBeLessThanOrEqual(65);
    expect(invited.ssrPerMonth).toBeLessThanOrEqual(2.8);
    expect(invited.inviteTickets).toBe(1);
    const inviter = all.f2p_inviter!;
    const c = m.progression.invite!;
    // the counted cap bounds the inviter's lifetime income from invites: 10 × (100 coins + 1 ticket)
    expect(inviter.inviteCoins).toBe(c.maxCountedInvitees * 100);
    expect(inviter.inviteTickets).toBe(c.maxCountedInvitees);
    const ratio = inviter.pullsPerMonth / all.f2p!.pullsPerMonth;
    expect(ratio).toBeGreaterThanOrEqual(1.0);
    expect(ratio).toBeLessThanOrEqual(1.15);
    expect(ratio).toBeLessThan(all.light!.pullsPerMonth / all.f2p!.pullsPerMonth);
  }, 600_000);

  it('E7 the season pass is worth clearly more than its price in coins', () => {
    const pass = m.products.find((p) => p.id === 'season_pass')!;
    const bestYenPerCoin = Math.min(...m.products.filter((p) => p.kind === 'coins').map((p) => p.priceYen / p.paidCoins));
    const premiumCoins = m.progression.passMaxLevel * (m.progression.passRewards.premium.reward.freeCoins ?? 0) / m.progression.passRewards.premium.every;
    expect(premiumCoins * bestYenPerCoin).toBeGreaterThanOrEqual(pass.priceYen * 1.5);
  });

  it('E8 pity is within the JOGA guideline (≤ 100× the single-pull price, estimated cost ≤ ¥50,000)', () => {
    const worstYenPerCoin = Math.max(...m.products.filter((p) => p.kind === 'coins').map((p) => p.priceYen / p.paidCoins));
    for (const b of m.gacha.banners) {
      const pulls = m.gacha.pityGroups[b.pityGroup]!.cost;
      expect(pulls).toBeLessThanOrEqual(100);
      expect(pulls * b.priceSingle * worstYenPerCoin).toBeLessThanOrEqual(50_000);
      // REQ-GACHA-014: on a step-up banner the coins to the exchange follow the step prices (never above 100 singles)
      const coins = oddsDisclosure(m, b).pity.costCoins;
      expect(coins).toBeLessThanOrEqual(100 * b.priceSingle);
      expect(coins * worstYenPerCoin).toBeLessThanOrEqual(50_000);
    }
  });

  it('E9 friend races cannot replace ranked play as an income (daily cap ≤ 30% of a free player day)', async () => {
    const r = (await run()).f2p!;
    const maxFriendPerDay = m.progression.friendRewardDailyCap * Math.max(...m.progression.raceFreeCoinsByPlace.friend!);
    expect(maxFriendPerDay).toBeLessThanOrEqual(0.3 * r.freeCoinsPerActiveDay);
  }, 600_000);
});
