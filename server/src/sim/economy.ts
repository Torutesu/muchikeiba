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
import { countOnboarding, ensureOnboarding } from '../domain/onboarding.js';
import { rewardValue } from '../domain/comeback.js';
import { raceStats } from '../domain/training.js';
import { effectiveStats } from '../domain/horses.js';
import { normalizeStats } from '../domain/season.js';
import { STAT_KEYS, type Stats } from '../domain/master.js';
import type { HorseInstance } from '../domain/player.js';

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
  /**
   * REQ-INV-*: `invited` redeems a friend's code on day 1 after the FTUE (welcome gift, the friend for bm_friend);
   * `inviter` is the upper bound of the invite program: a new invitee every INVITER_EVERY_DAYS days until the counted
   * cap, each finishing the beginner missions INVITEE_GRADUATE_DAYS later and reaching class B at the next season.
   */
  invite?: 'invited' | 'inviter';
  /** REQ-CB-010: a lapsed player — no play from `fromDay` (0-based) for `days` days, then daily again. */
  lapse?: { fromDay: number; days: number };
  /** REQ-AD-*: watches every rewarded ad the server offers on each active day (after the day's races). */
  watchesAds?: boolean;
}

const INVITER_FIRST_DAY = 3;
const INVITER_EVERY_DAYS = 3;
const INVITEE_GRADUATE_DAYS = 3;
const INVITEE_RACES_PER_DAY = 6;

/**
 * REQ-UXS-015: the day (0-based, counted from install) on which an engaged new player does each beginner step
 * that needs more than ranked races (the earliest day the feature is unlocked, progression.unlocks). Silks, care
 * and scouting go through the real PlayerService; breeding, a friend, a team and a time attack need other players,
 * other Durable Objects or the verifier, so the sim records them on the player's state like those flows would.
 */
const BEGINNER_ACTION_DAY = { silks: 0, care: 0, breed: 1, friends: 1, team: 2, ta_finish: 3 } as const;

export const PERSONAS: Persona[] = [
  { id: 'f2p', label: '無課金（毎日遊ぶ）', racesPerDay: 6, activePermille: 1000, monthlyPurchases: [], placeBias: 0 },
  { id: 'f2p_casual', label: '無課金（週4日）', racesPerDay: 4, activePermille: 570, monthlyPurchases: [], placeBias: 0 },
  { id: 'light', label: '微課金（パス¥1,000/月）', racesPerDay: 6, activePermille: 1000, monthlyPurchases: ['season_pass'], placeBias: 0 },
  { id: 'medium', label: '中課金（パス＋¥5,000/月）', racesPerDay: 6, activePermille: 1000, monthlyPurchases: ['season_pass', 'coin_5000'], placeBias: 0 },
  { id: 'allowance', label: '微課金（厩舎手当¥480/30日）', racesPerDay: 6, activePermille: 1000, monthlyPurchases: ['stable_allowance_30d'], placeBias: 0 },
  { id: 'f2p_invited', label: '無課金（毎日・招待された）', racesPerDay: 6, activePermille: 1000, monthlyPurchases: [], placeBias: 0, invite: 'invited' },
  { id: 'f2p_inviter', label: '無課金（毎日・招待上限まで）', racesPerDay: 6, activePermille: 1000, monthlyPurchases: [], placeBias: 0, invite: 'inviter' },
  // REQ-CB-010: plays daily for 3 weeks, stops for 14 days (mid tier), comes back and plays daily again
  { id: 'lapsed', label: '復帰（無課金、14日休んで復帰）', racesPerDay: 6, activePermille: 1000, monthlyPurchases: [], placeBias: 0, lapse: { fromDay: 21, days: 14 } },
  { id: 'ads', label: '無課金（毎日・広告を全部見る）', racesPerDay: 6, activePermille: 1000, monthlyPurchases: [], placeBias: 0, watchesAds: true },
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
  /** REQ-UXS-015: free coins and pulls (gacha tickets incl. the 10-pull ticket) from beginner missions. */
  beginnerCoins: number;
  beginnerSteps: number;
  /** REQ-UXS-016: pass XP from season missions. */
  seasonMissionXp: number;
  /** REQ-INV-*: free coins and tickets from the invite program (welcome gift or inviter milestones). */
  inviteCoins: number;
  inviteTickets: number;
  /** REQ-CB-*: comeback windows started, coin value of the comeback login track + missions, pass XP from the catch-up. */
  comebackWindows: number;
  comebackValue: number;
  comebackXp: number;
  /** REQ-AD-*: rewarded views and the free coins / time attack attempts they gave. */
  adViews: number;
  adCoins: number;
  adTaAttempts: number;
  /** REQ-ACH-005: achievement tiers claimed and the free coins they paid. */
  achievementTiers: number;
  achievementCoins: number;
  /** REQ-TRAIN-* (E15): training sessions finished and stat points they gave, over the run. */
  trainingSessions: number;
  trainedPoints: number;
  /**
   * E15: per class (cap), the best ranked stat total over the player's active horses at the end of the run — after the
   * class normalisation — with the training growth (`trained`) and without it (`untrained`).
   */
  rankedTotalByClass: Record<string, { trained: number; untrained: number }>;
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

/**
 * `sessionStartJstMin`: when the daily session starts, in minutes after 00:00 JST (default 12:00). 03:30 makes
 * every session straddle the 04:00 game-day rollover (REQ-DAY-001), and the first one also the 2026-12-01 switch.
 */
export async function simulate(master: Master, persona: Persona, days = 90, seed = 1, sessionStartJstMin = 12 * 60): Promise<EconomyResult> {
  const start = Date.UTC(2026, 11, 1, -9, sessionStartJstMin); // on the 1st, a fresh season
  let now = start;
  const repo = new MemoryPlayerRepo();
  const store = new FakeStoreVerifier();
  const rng = seededRng(seed);
  const svc = new PlayerService(repo, { master, rng: seededRng(seed + 1000), trainingRng: seededRng(seed + 2000), clock: () => now, verifiers: { fake: store } });
  const id = `sim_${persona.id}`;
  let key = 0;
  const k = () => `c:sim:${key++}`;
  const r: EconomyResult = {
    persona: persona.id, days, activeDays: 0, freeCoinsEarned: 0, paidCoinsBought: 0, yenSpent: 0, pulls: 0, ssr: 0, sr: 0,
    pityExchanges: 0, firstPityDay: null, breedingMaterial: 0, gachaTickets: 0, ticketPulls: 0, firstWinCoins: 0, allowanceCoins: 0, beginnerCoins: 0, beginnerSteps: 0, seasonMissionXp: 0, inviteCoins: 0, inviteTickets: 0, comebackWindows: 0, comebackValue: 0, comebackXp: 0, adViews: 0, adCoins: 0, adTaAttempts: 0, achievementTiers: 0, achievementCoins: 0, trainingSessions: 0, trainedPoints: 0, rankedTotalByClass: {}, freeCoinsPerActiveDay: 0, pullsPerMonth: 0, ssrPerMonth: 0,
  };
  await svc.bootstrap(id);
  await svc.setAge(id, 1990, 1, false);
  const inv = master.progression.invite;
  if (persona.invite === 'invited' && inv) {
    // FTUE (partner horse), then a friend's code: the welcome gift and the friend (bm_friend) on day 1
    await svc.grantPartner(id, 'シミュ', k());
    const acc = await svc.inviteAccept(`sim_inviter_${persona.id}`, id, 'sim_install_invitee', 'sim');
    const before = (await svc.state(id)).items;
    await svc.inviteCommit(id, `sim_inviter_${persona.id}`, 'SIMCODE0', 'sim_install_invitee', acc.status !== 'refused' && acc.friended);
    const after = (await svc.state(id)).items;
    r.inviteTickets += Object.entries(after).reduce((a, [it, n]) => a + (n - (before[it] ?? 0)), 0);
    r.inviteCoins += inv.welcomeGift.freeCoins ?? 0;
  }
  /** Inviter upper bound: synthetic invitees join and hit their milestones on a fixed schedule (real reward code). */
  const inviterDay = async (d: number) => {
    if (persona.invite !== 'inviter' || !inv) return;
    const joinDays = Array.from({ length: inv.maxCountedInvitees }, (_, i) => INVITER_FIRST_DAY + i * INVITER_EVERY_DAYS);
    const pay = async (inviteeId: string, milestoneId: string) => {
      const before = await svc.state(id);
      const out = await svc.inviteMilestone(id, inviteeId, milestoneId, 'sim');
      if (out.status !== 'rewarded') return;
      const after = await svc.state(id);
      r.inviteCoins += after.wallet.free - before.wallet.free;
      r.inviteTickets += (after.items['gacha_ticket'] ?? 0) - (before.items['gacha_ticket'] ?? 0);
    };
    for (const [i, jd] of joinDays.entries()) {
      const inviteeId = `sim_invitee_${persona.id}_${i}`;
      if (d === jd) await svc.inviteAccept(id, inviteeId, `sim_install_${i}`, 'sim');
      // beginner missions done INVITEE_GRADUATE_DAYS after joining; ranked races at the invitee's 6 a day
      for (const ms of inv.milestones) {
        if (ms.kind === 'beginner_complete' && d === jd + INVITEE_GRADUATE_DAYS) await pay(inviteeId, ms.id);
        if (ms.kind === 'ranked_races' && d === jd + Math.ceil((ms.target ?? 0) / INVITEE_RACES_PER_DAY)) await pay(inviteeId, ms.id);
      }
      // one class up per season (the fastest a promotion can go): class B at the first season change after graduating,
      // class A at the second, …
      if (d > jd + INVITEE_GRADUATE_DAYS && jstMonthKey(start + d * DAY) !== jstMonthKey(start + (d - 1) * DAY)) {
        let changes = 0;
        for (let x = jd + INVITEE_GRADUATE_DAYS + 1; x <= d; x++) if (jstMonthKey(start + x * DAY) !== jstMonthKey(start + (x - 1) * DAY)) changes++;
        for (const ms of inv.milestones.filter((x) => x.kind === 'class')) {
          if (master.progression.classes.findIndex((c) => c.id === ms.classId) === changes) await pay(inviteeId, ms.id);
        }
      }
    }
  };
  const tut = await svc.tutorialDraw(id, k());
  for (const x of tut.results) { r.pulls++; if (x.rarity === 'SSR') r.ssr++; if (x.rarity === 'SR') r.sr++; }
  const pityTarget = master.gacha.banners.find((b) => b.id === 'standard')!.pityTargets[0]!;
  const wallet = async () => (await svc.view(id)).wallet;
  // free coins earned by playing = end balance + free spent on gacha − free coins that came with purchases
  let freeSpent = 0, freeFromPurchases = 0;
  const freeAtStart = (await wallet()).free;
  let tx = 0;

  let season = '';
  let activeDay = 0;
  const done = new Set<string>();
  /** Records an onboarding action the PlayerService cannot do alone (see BEGINNER_ACTION_DAY). */
  const record = async (kind: 'breed' | 'friends' | 'team' | 'ta_finish') => {
    const st = await svc.state(id);
    if (kind === 'friends') st.friends.ids.push(`sim_friend_${persona.id}`);
    else if (kind === 'team') { countOnboarding(st, 'team'); }
    else { if (kind === 'breed') ensureOnboarding(st).breedings += 1; countOnboarding(st, kind); }
    await repo.put(st);
  };
  const total = (st: Stats) => STAT_KEYS.reduce((a, x) => a + st[x], 0);
  const best = (hs: HorseInstance[]) => [...hs].filter((h) => h.status === 'active').sort((a, b) => total(raceStats(master, b)) - total(raceStats(master, a)));
  const trainDay = async () => {
    let tv = await svc.training(id);
    if (!tv.enabled) return;
    let slots = tv.slotsLeft;
    const st0 = await svc.state(id);
    const order = best(st0.horses);
    const rotation = ['hill', 'wood', 'awase'];
    type View = { perHorsePerDay: number; horses: { horseId: string; fatigue: number; blocked: string | null }[] };
    for (const h of order) {
      for (let i = 0; i < (tv as View).perHorsePerDay && slots > 0; i++) {
        const hv = (tv as View).horses.find((x) => x.horseId === h.id) ?? (tv = await svc.training(id), (tv as View).horses.find((x) => x.horseId === h.id)!);
        if (hv.blocked) break;
        const menu = hv.fatigue >= 60 ? 'pool' : rotation[(r.trainingSessions + i) % rotation.length]!;
        const st = await svc.trainingStart(id, h.id, menu, k());
        now += 7_000;
        const res = await svc.trainingFinish(id, st.session.sessionId, { taps: st.session.beats.map((b) => b + 100) }, k());
        tv = res.training as unknown as typeof tv;
        r.trainingSessions++;
        r.trainedPoints += res.total;
        slots--;
      }
      if (slots <= 0) break;
    }
    const top = order[0];
    if (top && (st0.items['training_apple'] ?? 0) > 0) {
      const hv = (tv as View).horses.find((x) => x.horseId === top.id) ?? (await svc.training(id) as View).horses.find((x) => x.horseId === top.id);
      if (hv && hv.fatigue >= 40) await svc.trainingUseItem(id, 'training_apple', top.id, k());
    }
  };
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
    await inviterDay(d);
    if (persona.lapse && d >= persona.lapse.fromDay && d < persona.lapse.fromDay + persona.lapse.days) continue;
    if (unit(rng) * 1000 >= persona.activePermille) continue;
    r.activeDays++;
    await svc.claimLogin(id, k()).catch(() => undefined);
    // REQ-UXS-015: beginner steps on the day their feature opens (the player does each once)
    for (const [kind, day] of Object.entries(BEGINNER_ACTION_DAY)) {
      if (done.has(kind) || activeDay < day) continue;
      done.add(kind);
      if (kind === 'silks') await svc.setSilks(id, (await svc.view(id)).profile.silks);
      else if (kind === 'care') await svc.care(id, (await svc.state(id)).horses[0]!.id, 'fresh_water', k());
      else await record(kind as 'breed' | 'friends' | 'team' | 'ta_finish');
    }
    activeDay++;
    if ((await svc.allowance(id)).active) {
      const a = await svc.claimAllowance(id, k()).catch((e: unknown) => { if (e instanceof AppError) return null; throw e; });
      if (a) { r.allowanceCoins += a.freeCoins; freeFromPurchases += a.freeCoins; }
    }
    for (let i = 0; i < persona.racesPerDay; i++) {
      now += 10 * 60_000;
      // ride details as a confirmed room sends them (stats, wins per course, every other race the horse's skill fires):
      // the achievements (REQ-ACH-*) count from these, so the sim pays them like a real player earns them
      const trackId = master.tracks[(d * persona.racesPerDay + i) % master.tracks.length]!.id;
      const details = { trackId, style: 'senko' as const, finishTick: null, startReactionTicks: null, whips: 0, whipMashed: false, cpuAssisted: false, skillFired: i % 2 === 0 };
      const ar = await svc.applyRace(id, { raceId: `sim_${persona.id}_${d}_${i}`, mode: 'ranked', place: place(rng, persona.placeBias), fieldSize: 12, newRating: null, void: false, humans: 4, details });
      if ('firstWinBonus' in ar && typeof ar.firstWinBonus === 'number') r.firstWinCoins += ar.firstWinBonus;
      if ('comebackXp' in ar && typeof ar.comebackXp === 'number') r.comebackXp += ar.comebackXp;
    }
    // REQ-TRAIN-* (E15): every persona uses its training slots on its best horses (2 on the best, the rest on the next),
    // plays the mini-game at an average level (every beat 100 ms late = "good"), rests a tired horse in the pool and
    // feeds the apple from the daily mission to the best horse. Training gives no coins, so E1–E13 do not move.
    await trainDay();
    // REQ-CB-004/005: a returner claims the comeback login day and every comeback mission it can
    const cb = await svc.comeback(id);
    if (cb.window) {
      if (cb.window.day === 1 && cb.window.login.claimed === 0) r.comebackWindows++;
      if (cb.window.login.claimableToday) r.comebackValue += rewardValue((await svc.comebackClaimLogin(id, k())).reward);
      for (const cm of cb.window.missions.filter((x) => x.claimable)) r.comebackValue += rewardValue((await svc.comebackClaimMission(id, cm.id, k())).reward);
    }
    // daily, beginner (one step at a time, REQ-UXS-015) and season missions (pass XP, REQ-UXS-016): all claimable
    for (;;) {
      const mv = await svc.missionsAll(id);
      const ids = [
        ...mv.missions.filter((x) => x.progress >= x.target && !x.claimed).map((x) => x.id),
        ...mv.beginner.steps.filter((x) => x.claimable).map((x) => x.id),
        ...mv.season.missions.filter((x) => x.claimable).map((x) => x.id),
      ];
      if (!ids.length) break;
      for (const mid of ids) {
        const before = (await wallet()).free;
        const rw = await svc.claimMission(id, mid, k());
        if (mid.startsWith('bm_')) { r.beginnerSteps++; r.beginnerCoins += (await wallet()).free - before; }
        r.seasonMissionXp += (rw as { passXp?: number }).passXp ?? 0;
      }
    }
    // REQ-ACH-005: every unlocked achievement tier is claimed the day it unlocks (free coins only)
    const ac = await svc.claimAllAchievements(id, k());
    r.achievementTiers += ac.claimed.length;
    r.achievementCoins += ac.freeCoins;
    const pv = await svc.passView(id);
    for (let lvl = 1; lvl <= pv.level; lvl++) {
      for (const track of ['free', 'premium'] as const) {
        if (pv.claimed[track].includes(lvl)) continue;
        await svc.claimPass(id, track, lvl, k()).catch((e: unknown) => { if (!(e instanceof AppError)) throw e; });
      }
    }
    // REQ-AD-*: every offered rewarded view, granted through the real session + callback path (the SSV signature is
    // checked in front of the player object, src/ads/ssv.ts; here the callback is already "verified")
    if (persona.watchesAds) {
      for (;;) {
        const av = await svc.ads(id);
        const p = av.placements.find((x) => x.available);
        if (!p) break;
        const st = await svc.adStart(id, p.id, k());
        const before = (await wallet()).free;
        const res = await svc.adReward(id, { network: 'admob', transactionId: `sim_${persona.id}_${seed}_${tx++}`, userId: id, customData: st.customData, adUnit: p.adUnitKey, timestamp: now, rewardAmount: 1, rewardItem: 'reward' });
        if (res.status !== 'rewarded') throw new Error(`sim ad not rewarded: ${JSON.stringify(res)}`);
        r.adViews++;
        r.adCoins += (await wallet()).free - before;
        r.adTaAttempts += res.reward.taAttempts ?? 0;
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
        const tr = await svc.useTicket(id, itemId, def.kind === 'srPlus' ? null : 'standard', k());
        for (const x of tr.results ?? [tr.result]) {
          r.pulls++;
          r.ticketPulls++;
          if (x.rarity === 'SSR') r.ssr++;
          if (x.rarity === 'SR') r.sr++;
        }
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
  for (const c of master.progression.classes) {
    const act = s.horses.filter((h) => h.status === 'active');
    const pick = (f: (h: HorseInstance) => Stats) => Math.max(0, ...act.map((h) => total(normalizeStats(f(h), c.statCap))));
    r.rankedTotalByClass[c.id] = { trained: pick((h) => raceStats(master, h)), untrained: pick((h) => effectiveStats(master, h)) };
  }
  r.pullsPerMonth = (r.pulls - 10) / (days / 30); // excluding the tutorial 10-pull
  r.ssrPerMonth = r.ssr / (days / 30);
  return r;
}

export async function simulateAll(master: Master, days = 90, seeds = [1, 2, 3], sessionStartJstMin = 12 * 60) {
  const out: Record<string, EconomyResult> = {};
  for (const p of PERSONAS) {
    const runs = await Promise.all(seeds.map((s) => simulate(master, p, days, s, sessionStartJstMin)));
    const avg = (f: (x: EconomyResult) => number) => runs.reduce((a, x) => a + f(x), 0) / runs.length;
    const firsts = runs.map((x) => x.firstPityDay).filter((x): x is number => x !== null);
    out[p.id] = {
      ...runs[0]!,
      activeDays: avg((x) => x.activeDays), freeCoinsEarned: avg((x) => x.freeCoinsEarned), paidCoinsBought: avg((x) => x.paidCoinsBought),
      yenSpent: avg((x) => x.yenSpent), pulls: avg((x) => x.pulls), ssr: avg((x) => x.ssr), sr: avg((x) => x.sr), pityExchanges: avg((x) => x.pityExchanges),
      firstPityDay: firsts.length ? firsts.reduce((a, b) => a + b, 0) / firsts.length : null,
      breedingMaterial: avg((x) => x.breedingMaterial), gachaTickets: avg((x) => x.gachaTickets), ticketPulls: avg((x) => x.ticketPulls),
      firstWinCoins: avg((x) => x.firstWinCoins), allowanceCoins: avg((x) => x.allowanceCoins),
      beginnerCoins: avg((x) => x.beginnerCoins), beginnerSteps: avg((x) => x.beginnerSteps), seasonMissionXp: avg((x) => x.seasonMissionXp),
      inviteCoins: avg((x) => x.inviteCoins), inviteTickets: avg((x) => x.inviteTickets),
      comebackWindows: avg((x) => x.comebackWindows), comebackValue: avg((x) => x.comebackValue), comebackXp: avg((x) => x.comebackXp),
      adViews: avg((x) => x.adViews), adCoins: avg((x) => x.adCoins), adTaAttempts: avg((x) => x.adTaAttempts),
      achievementTiers: avg((x) => x.achievementTiers), achievementCoins: avg((x) => x.achievementCoins),
      trainingSessions: avg((x) => x.trainingSessions), trainedPoints: avg((x) => x.trainedPoints),
      rankedTotalByClass: Object.fromEntries(master.progression.classes.map((c) => [c.id, {
        trained: avg((x) => x.rankedTotalByClass[c.id]!.trained), untrained: avg((x) => x.rankedTotalByClass[c.id]!.untrained),
      }])),
      freeCoinsPerActiveDay: avg((x) => x.freeCoinsPerActiveDay), pullsPerMonth: avg((x) => x.pullsPerMonth), ssrPerMonth: avg((x) => x.ssrPerMonth),
    };
  }
  return out;
}
