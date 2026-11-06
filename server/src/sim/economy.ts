/**
 * Economy simulator (docs/spec/balance-targets.md, E-*). Drives the real PlayerService with the real master
 * data for a few player personas over N days, so every reward, price, pity and bonus rule is the production one.
 * Not imported by the Worker (no runtime cost); used by test/economy.test.ts and `npm run economy`.
 */
import { MemoryPlayerRepo, PlayerService } from '../domain/service.js';
import { FakeStoreVerifier } from '../domain/purchase.js';
import { seededRng, type Rng } from '../domain/rng.js';
import type { Master } from '../domain/master.js';
import { AppError } from '../domain/errors.js';
import { jstMonthKey } from '../domain/time.js';

export interface Persona {
  id: string;
  label: string;
  /** Ranked races per active day. */
  racesPerDay: number;
  /** Chance (‰) the player shows up on a given day. */
  activePermille: number;
  /**
   * Product ids from master/products.json. Season passes and coin packs are bought on the first day of every
   * season (JST month; the pass is per season, REQ-UXS-020); the daily pack 厩舎手当 whenever none is running
   * (REQ-UXS-018), and its coins are claimed on every active day.
   */
  monthlyPurchases: string[];
  /** Average finishing place is uniform over 1..12 ("average rider"); a skilled rider shifts it. */
  placeBias: number;
}

export const PERSONAS: Persona[] = [
  { id: 'f2p', label: '無課金（毎日遊ぶ）', racesPerDay: 6, activePermille: 1000, monthlyPurchases: [], placeBias: 0 },
  { id: 'f2p_casual', label: '無課金（週4日）', racesPerDay: 4, activePermille: 570, monthlyPurchases: [], placeBias: 0 },
  { id: 'light', label: '微課金（パス¥1,000/月）', racesPerDay: 6, activePermille: 1000, monthlyPurchases: ['season_pass'], placeBias: 0 },
  { id: 'medium', label: '中課金（パス＋¥5,000/月）', racesPerDay: 6, activePermille: 1000, monthlyPurchases: ['season_pass', 'coin_5000'], placeBias: 0 },
  { id: 'allowance', label: '微課金（厩舎手当¥480/30日）', racesPerDay: 6, activePermille: 1000, monthlyPurchases: ['stable_allowance_30d'], placeBias: 0 },
];

export interface EconomyResult {
  persona: string;
  days: number;
  activeDays: number;
  freeCoinsEarned: number;
  paidCoinsBought: number;
  yenSpent: number;
  pulls: number;
  ssr: number;
  sr: number;
  pityExchanges: number;
  firstPityDay: number | null;
  breedingMaterial: number;
  gachaTickets: number;
  /** Pulls paid with tickets instead of coins (REQ-ITEM-001/002). */
  ticketPulls: number;
  /** REQ-UXS-010: free coins from the daily first-win bonus. */
  firstWinCoins: number;
  /** REQ-UXS-018: free coins claimed from the daily pack (counted as bought, not earned by playing). */
  allowanceCoins: number;
  /** Derived. */
  freeCoinsPerActiveDay: number;
  pullsPerMonth: number;
  ssrPerMonth: number;
}

const DAY = 86_400_000;

const unit = (rng: Rng) => rng.nextU32() / 4294967296;

function place(rng: Rng, bias: number): number {
  // uniform 1..12, shifted toward the front by `bias` places for skilled riders
  const p = 1 + Math.floor(unit(rng) * 12) - bias;
  return Math.max(1, Math.min(12, p));
}

export async function simulate(master: Master, persona: Persona, days = 90, seed = 1): Promise<EconomyResult> {
  const start = Date.UTC(2026, 11, 1, 3); // 12:00 JST on the 1st, a fresh season
  let now = start;
  const repo = new MemoryPlayerRepo();
  const store = new FakeStoreVerifier();
  const rng = seededRng(seed);
  const svc = new PlayerService(repo, { master, rng: seededRng(seed + 1000), clock: () => now, verifiers: { fake: store } });
  const id = `sim_${persona.id}`;
  let key = 0;
  const k = () => `c:sim:${key++}`;
  const r: EconomyResult = {
    persona: persona.id, days, activeDays: 0, freeCoinsEarned: 0, paidCoinsBought: 0, yenSpent: 0, pulls: 0, ssr: 0, sr: 0,
    pityExchanges: 0, firstPityDay: null, breedingMaterial: 0, gachaTickets: 0, ticketPulls: 0, firstWinCoins: 0, allowanceCoins: 0, freeCoinsPerActiveDay: 0, pullsPerMonth: 0, ssrPerMonth: 0,
  };
  await svc.bootstrap(id);
  await svc.setAge(id, 1990, 1, false);
  const tut = await svc.tutorialDraw(id, k());
  for (const x of tut.results) { r.pulls++; if (x.rarity === 'SSR') r.ssr++; if (x.rarity === 'SR') r.sr++; }
  const pityTarget = master.gacha.banners.find((b) => b.id === 'standard')!.pityTargets[0]!;
  const wallet = async () => (await svc.view(id)).wallet;
  // free coins earned by playing = end balance + free spent on gacha − free coins that came with purchases
  let freeSpent = 0, freeFromPurchases = 0;
  const freeAtStart = (await wallet()).free;
  let tx = 0;

  let season = '';
  for (let d = 0; d < days; d++) {
    now = start + d * DAY;
    const newSeason = jstMonthKey(now) !== season;
    season = jstMonthKey(now);
    for (const pid of persona.monthlyPurchases) {
      const p = master.products.find((x) => x.id === pid)!;
      if (p.kind !== 'allowance' && !newSeason) continue;
      try {
        await svc.purchaseIntent(id, pid);
      } catch (e) {
        if (e instanceof AppError && e.code === 'ALREADY_PURCHASED' && p.kind === 'allowance') continue; // still running
        throw e;
      }
      const tok = store.issue({ transactionId: `T${tx++}`, productId: pid, purchasedAt: now, priceYen: p.priceYen });
      const before = (await wallet()).free;
      await svc.purchase(id, 'fake', pid, tok);
      freeFromPurchases += (await wallet()).free - before;
      r.yenSpent += p.priceYen;
      r.paidCoinsBought += p.paidCoins;
    }
    if (unit(rng) * 1000 >= persona.activePermille) continue;
    r.activeDays++;
    await svc.claimLogin(id, k()).catch(() => undefined);
    if ((await svc.allowance(id)).active) {
      const a = await svc.claimAllowance(id, k()).catch((e: unknown) => { if (e instanceof AppError) return null; throw e; });
      if (a) { r.allowanceCoins += a.freeCoins; freeFromPurchases += a.freeCoins; }
    }
    for (let i = 0; i < persona.racesPerDay; i++) {
      now += 10 * 60_000;
      const ar = await svc.applyRace(id, { raceId: `sim_${persona.id}_${d}_${i}`, mode: 'ranked', place: place(rng, persona.placeBias), fieldSize: 12, newRating: null, void: false, humans: 4 });
      if ('firstWinBonus' in ar && typeof ar.firstWinBonus === 'number') r.firstWinCoins += ar.firstWinBonus;
    }
    for (const m of master.progression.dailyMissions) await svc.claimMission(id, m.id, k()).catch(() => undefined);
    const pv = await svc.passView(id);
    for (let lvl = 1; lvl <= pv.level; lvl++) {
      for (const track of ['free', 'premium'] as const) {
        if (pv.claimed[track].includes(lvl)) continue;
        await svc.claimPass(id, track, lvl, k()).catch((e: unknown) => { if (!(e instanceof AppError)) throw e; });
      }
    }
    // spend: 10-pulls on the standard banner while affordable, exchange pity as soon as it is full
    for (;;) {
      const v = await svc.view(id);
      if (v.wallet.paid + v.wallet.free < 1000) break;
      const dr = await svc.draw(id, 'standard', 10, k());
      freeSpent += v.wallet.free - (await wallet()).free;
      for (const x of dr.results) { r.pulls++; if (x.rarity === 'SSR') r.ssr++; if (x.rarity === 'SR') r.sr++; }
      if (dr.pityPoints >= master.gacha.pityGroups.standard!.cost) {
        await svc.pityExchange(id, 'standard', pityTarget, k());
        r.pityExchanges++;
        r.ssr++;
        r.firstPityDay ??= d + 1;
      }
    }
    // REQ-ITEM-001/002: tickets are spent as soon as they arrive (one standard pull each; SR+ ticket = one SR+ horse)
    for (const [itemId, def] of Object.entries(master.items.tickets)) {
      let have = (await svc.view(id)).items[itemId] ?? 0;
      for (; have > 0; have--) {
        const tr = await svc.useTicket(id, itemId, def.kind === 'single' ? 'standard' : null, k());
        r.pulls++;
        r.ticketPulls++;
        if (tr.result.rarity === 'SSR') r.ssr++;
        if (tr.result.rarity === 'SR') r.sr++;
        if (tr.pityPoints !== null && tr.pityPoints >= master.gacha.pityGroups.standard!.cost) {
          await svc.pityExchange(id, 'standard', pityTarget, k());
          r.pityExchanges++;
          r.ssr++;
          r.firstPityDay ??= d + 1;
        }
      }
    }
  }
  const s = await svc.state(id);
  r.freeCoinsEarned = s.wallet.free - freeAtStart + freeSpent - freeFromPurchases;
  r.breedingMaterial = s.items['breeding_material'] ?? 0;
  r.gachaTickets = s.items['gacha_ticket'] ?? 0;
  r.freeCoinsPerActiveDay = r.activeDays ? r.freeCoinsEarned / r.activeDays : 0;
  r.pullsPerMonth = (r.pulls - 10) / (days / 30); // excluding the tutorial 10-pull
  r.ssrPerMonth = r.ssr / (days / 30);
  return r;
}

export async function simulateAll(master: Master, days = 90, seeds = [1, 2, 3]) {
  const out: Record<string, EconomyResult> = {};
  for (const p of PERSONAS) {
    const runs = await Promise.all(seeds.map((s) => simulate(master, p, days, s)));
    const avg = (f: (x: EconomyResult) => number) => runs.reduce((a, x) => a + f(x), 0) / runs.length;
    const firsts = runs.map((x) => x.firstPityDay).filter((x): x is number => x !== null);
    out[p.id] = {
      ...runs[0]!,
      activeDays: avg((x) => x.activeDays), freeCoinsEarned: avg((x) => x.freeCoinsEarned), paidCoinsBought: avg((x) => x.paidCoinsBought),
      yenSpent: avg((x) => x.yenSpent), pulls: avg((x) => x.pulls), ssr: avg((x) => x.ssr), sr: avg((x) => x.sr), pityExchanges: avg((x) => x.pityExchanges),
      firstPityDay: firsts.length ? firsts.reduce((a, b) => a + b, 0) / firsts.length : null,
      breedingMaterial: avg((x) => x.breedingMaterial), gachaTickets: avg((x) => x.gachaTickets), ticketPulls: avg((x) => x.ticketPulls),
      firstWinCoins: avg((x) => x.firstWinCoins), allowanceCoins: avg((x) => x.allowanceCoins),
      freeCoinsPerActiveDay: avg((x) => x.freeCoinsPerActiveDay), pullsPerMonth: avg((x) => x.pullsPerMonth), ssrPerMonth: avg((x) => x.ssrPerMonth),
    };
  }
  return out;
}
