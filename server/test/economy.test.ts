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
  }, 3_600_000);

  it('E4 a casual free player still pulls every couple of weeks', async () => {
    const r = (await run()).f2p_casual!;
    expect(r.pullsPerMonth).toBeGreaterThanOrEqual(15);
    expect(r.pullsPerMonth).toBeLessThanOrEqual(40);
  }, 3_600_000);

  it('E5-E6 paying helps, but a free player is never far behind', async () => {
    const all = await run();
    const f = all.f2p!.pullsPerMonth;
    expect(all.light!.pullsPerMonth / f).toBeGreaterThanOrEqual(1.15);
    expect(all.light!.pullsPerMonth / f).toBeLessThanOrEqual(1.6);
    expect(all.medium!.pullsPerMonth / f).toBeGreaterThanOrEqual(1.8);
    expect(all.medium!.pullsPerMonth / f).toBeLessThanOrEqual(3.0);
  }, 3_600_000);

  it('E10 the daily pack (厩舎手当 ¥480) helps a little, less than the season pass (REQ-UXS-018)', async () => {
    const all = await run();
    const ratio = all.allowance!.pullsPerMonth / all.f2p!.pullsPerMonth;
    expect(ratio).toBeGreaterThanOrEqual(1.05);
    expect(ratio).toBeLessThanOrEqual(1.4);
    expect(ratio).toBeLessThan(all.light!.pullsPerMonth / all.f2p!.pullsPerMonth);
    // claimed every active day: 30 free coins a day while it runs
    expect(all.allowance!.allowanceCoins / all.allowance!.activeDays).toBeCloseTo(30, 0);
  }, 3_600_000);

  it('E13 rewarded ads help a free player a little — less than the cheapest paid product (REQ-AD-011)', async () => {
    const all = await run();
    const f = all.f2p!.pullsPerMonth;
    const ratio = all.ads!.pullsPerMonth / f;
    expect(ratio).toBeGreaterThanOrEqual(1.03);
    expect(ratio).toBeLessThanOrEqual(1.15);
    // never worth more than paying: below the daily pack (E10) and the season pass (E5)
    expect(ratio).toBeLessThan(all.allowance!.pullsPerMonth / f);
    expect(ratio).toBeLessThan(all.light!.pullsPerMonth / f);
    // free coins only, within the code ceiling, and no ads on the install day
    expect(all.ads!.adCoins / all.ads!.activeDays).toBeLessThanOrEqual(40);
    expect(all.ads!.adViews).toBeLessThan(all.ads!.activeDays * 3);
    expect(all.ads!.paidCoinsBought).toBe(0);
  }, 3_600_000);

  it('E1 note: the daily first-win bonus pays on ranked wins only and is part of the free income (REQ-UXS-010)', async () => {
    const r = (await run()).f2p!;
    expect(r.firstWinCoins).toBeGreaterThan(0);
    // at most 30+20+10 a day
    expect(r.firstWinCoins / r.activeDays).toBeLessThanOrEqual(60);
  }, 3_600_000);

  it('E11 the invite program (REQ-INV-*): an invited free player stays inside E1/E2, an inviter at the cap gains less than the season pass', async () => {
    const all = await run();
    const invited = all.f2p_invited!;
    expect(invited.pullsPerMonth).toBeGreaterThanOrEqual(40);
    expect(invited.pullsPerMonth).toBeLessThanOrEqual(65);
    expect(invited.ssrPerMonth).toBeLessThanOrEqual(2.8);
    expect(invited.inviteTickets).toBe(1);
    const inviter = all.f2p_inviter!;
    const c = m.progression.invite!;
    // the counted cap bounds the inviter's lifetime income from invites: 10 × (20 + 40 coins + 1 ticket). Inside the
    // 90 days every graduation and most class-A promotions arrive; class S (≥ 3 seasons) lies beyond the window.
    const lifetimeCoins = c.milestones.reduce((a, d) => a + (d.reward.freeCoins ?? 0), 0) * c.maxCountedInvitees;
    expect(inviter.inviteCoins).toBeGreaterThan(0);
    expect(inviter.inviteCoins).toBeLessThanOrEqual(lifetimeCoins);
    expect(inviter.inviteTickets).toBeLessThanOrEqual(c.maxCountedInvitees);
    // E2 holds for the capped inviter too (r10 merge: the earlier 100 coins + ticket at class B gave 3.00 SSR/month),
    // and the invite income never buys an extra pity exchange over the daily free player
    expect(inviter.ssrPerMonth).toBeLessThanOrEqual(2.8);
    expect(inviter.pityExchanges).toBeLessThanOrEqual(all.f2p!.pityExchanges);
    const ratio = inviter.pullsPerMonth / all.f2p!.pullsPerMonth;
    expect(ratio).toBeGreaterThanOrEqual(1.0);
    expect(ratio).toBeLessThanOrEqual(1.15);
    expect(ratio).toBeLessThan(all.light!.pullsPerMonth / all.f2p!.pullsPerMonth);
  }, 3_600_000);

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

  it('E12 a returner (14 days off) gets back less than a daily free player earned in those days (REQ-CB-010)', async () => {
    const all = await run();
    const r = all.lapsed!;
    const daily = all.f2p!;
    const missed = 14;
    expect(r.comebackWindows).toBe(1);
    expect(r.comebackValue).toBeGreaterThan(0);
    expect(r.comebackValue).toBeLessThanOrEqual(daily.freeCoinsPerActiveDay * missed);
    const dailyXpPerDay = (daily.seasonMissionXp + daily.activeDays * 6 * m.progression.passXpPerRace) / daily.activeDays;
    expect(r.comebackXp).toBeGreaterThan(0);
    expect(r.comebackXp).toBeLessThanOrEqual(dailyXpPerDay * missed);
    // the returner still ends behind the daily player over the 90 days
    expect(r.pullsPerMonth).toBeLessThanOrEqual(daily.pullsPerMonth);
    // players who never lapse never get a window: their numbers (E1–E3, E5–E10) are unchanged
    for (const id of ['f2p', 'light', 'medium', 'allowance']) expect(all[id]!.comebackWindows).toBe(0);
  }, 3_600_000);

  it('E15 training (REQ-TRAIN-013): time-gated growth, the same for everyone; in ranked it never widens the paid/free gap', async () => {
    const all = await run();
    const perDay = (id: string) => all[id]!.trainedPoints / all[id]!.activeDays;
    // every persona trains every active day with the same slots
    for (const id of ['f2p', 'light', 'medium', 'allowance']) {
      expect(all[id]!.trainingSessions / all[id]!.activeDays).toBeGreaterThanOrEqual(2.5);
      expect(all[id]!.trainedPoints).toBeGreaterThan(0);
    }
    // paying never buys more growth: the payer's horses (rarer, less potential) grow at most as fast as the free player's
    for (const id of ['light', 'medium', 'allowance', 'ads']) expect(perDay(id)).toBeLessThanOrEqual(perDay('f2p') * 1.05);
    // in ranked (class-normalised stat totals) the gap between the medium payer's and the free player's best horse
    // after 90 days of training is never wider than without the training, in every class
    for (const c of m.progression.classes) {
      const gap = (k: 'trained' | 'untrained') => all.medium!.rankedTotalByClass[c.id]![k] - all.f2p!.rankedTotalByClass[c.id]![k];
      expect(gap('trained')).toBeLessThanOrEqual(gap('untrained') + 0.5);
      // and the growth never lifts a horse past the class cap
      expect(all.f2p!.rankedTotalByClass[c.id]!.trained).toBeLessThanOrEqual(c.statCap);
    }
    // training pays no coins: the free player's income is the same as without it (E1 holds above)
    expect(all.f2p!.paidCoinsBought).toBe(0);
  }, 3_600_000);

  it('E14 achievements (REQ-ACH-*): play only, free coins, offset by the daily 3-race mission; paying never advances one', async () => {
    const all = await run();
    const f = all.f2p!;
    // the 90-day payout of a daily free player (races, wins, podiums, courses, skills) stays below what the daily
    // 「3戦する」 mission gave up for it (20 → 18 coins × 90 days), so E1–E13 keep their Round 10 values
    expect(f.achievementCoins).toBeGreaterThan(0);
    expect(f.achievementCoins).toBeLessThanOrEqual(2 * 90);
    // spending money never moves an achievement: the paying personas play the same races and get exactly the same
    for (const id of ['light', 'medium', 'allowance', 'f2p_invited', 'f2p_inviter', 'ads']) expect(all[id]!.achievementCoins).toBe(f.achievementCoins);
    expect(all.f2p_casual!.achievementCoins).toBeLessThan(f.achievementCoins);
  }, 600_000);

  it('E17 event exchange (REQ-EXCH-011): playing the event and spending the exchange keeps E1–E6 in range for every persona', async () => {
    const base = await run();
    const ev = await simulateAll(m, 90, [1, 2, 3], 12 * 60, { events: true });
    const f = ev.f2p!;
    // the free player actually plays the event, earns points and takes something from the exchange
    expect(f.eventRaces).toBeGreaterThan(0);
    expect(f.eventPoints).toBeGreaterThan(0);
    expect(f.exchangeHorses + f.exchangeTickets + f.exchangeMaterial + f.exchangeCoins).toBeGreaterThan(0);
    // E1–E4 with the event
    expect(f.pullsPerMonth).toBeGreaterThanOrEqual(40);
    expect(f.pullsPerMonth).toBeLessThanOrEqual(65);
    expect(f.ssrPerMonth).toBeGreaterThanOrEqual(1.2);
    expect(f.ssrPerMonth).toBeLessThanOrEqual(2.8);
    expect(ev.f2p_casual!.pullsPerMonth).toBeGreaterThanOrEqual(15);
    expect(ev.f2p_casual!.pullsPerMonth).toBeLessThanOrEqual(40);
    // E5/E6 ratios with the event
    expect(ev.light!.pullsPerMonth / f.pullsPerMonth).toBeGreaterThanOrEqual(1.15);
    expect(ev.light!.pullsPerMonth / f.pullsPerMonth).toBeLessThanOrEqual(1.6);
    expect(ev.medium!.pullsPerMonth / f.pullsPerMonth).toBeGreaterThanOrEqual(1.8);
    expect(ev.medium!.pullsPerMonth / f.pullsPerMonth).toBeLessThanOrEqual(3.0);
    // for every persona the event (same play time) adds at most 3% pulls over not playing it
    for (const id of Object.keys(base)) expect(ev[id]!.pullsPerMonth).toBeLessThanOrEqual(base[id]!.pullsPerMonth * 1.03);
    // paying never earns event points: the paying personas race the same and earn exactly the free player's points
    for (const id of ['light', 'medium', 'allowance']) expect(ev[id]!.eventPoints).toBe(f.eventPoints);
    // the exchange's coin value per event (coin lines + scout tickets at the single-pull price) stays ≤ 250 coins
    for (const e of m.events.filter((x) => x.exchange)) {
      const single = Math.max(...m.gacha.banners.filter((b) => b.currency === 'any').map((b) => b.priceSingle));
      const value = e.exchange!.items.reduce((a, l) => a + l.stock * ((l.reward.freeCoins ?? 0) + (l.kind === 'ticket' && m.items.tickets[l.reward.items![0]!.itemId] ? single * l.reward.items![0]!.qty : 0)), 0);
      expect(value).toBeLessThanOrEqual(250);
    }
  }, 3_600_000);

  it('E9 friend races cannot replace ranked play as an income (daily cap ≤ 30% of a free player day)', async () => {
    const r = (await run()).f2p!;
    const maxFriendPerDay = m.progression.friendRewardDailyCap * Math.max(...m.progression.raceFreeCoinsByPlace.friend!);
    expect(maxFriendPerDay).toBeLessThanOrEqual(0.3 * r.freeCoinsPerActiveDay);
  }, 3_600_000);
});
