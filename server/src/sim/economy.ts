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
import { MemoryRivalRegistry, RivalService, type RivalPlayers } from '../domain/rivalService.js';
import { exchangeClosesAt } from '../domain/exchange.js';
import { dayRule } from '../domain/time.js';
import { raceTimeMs } from '../domain/timeAttack.js';
import { ensureTeam } from '../domain/teams.js';
import { ensureGoal, weekKeyOf } from '../domain/teamGoal.js';

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
   * Quality pass 2 (docs/quality/ranked.md, W8): ranked places drawn from these weights (places 1..12) instead of the
   * uniform draw — the place distribution the ranked harness measures for a rider (contracts/ranked-places.vectors.json).
   * A function picks them by the player's class and ranked-race count at the time of the race (beginner matches, the ramp,
   * each class). Absent = uniform with `placeBias` (every existing persona; their draws are unchanged).
   */
  placeWeights?: number[] | ((at: { classId: string; rankedRaces: number }) => number[] | undefined);
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
  /** REQ-BOX-013: gift box entries claimed (every active day, claim all) and expired unclaimed over the run. */
  giftsClaimed: number;
  giftsExpired: number;
  /**
   * E15: per class (cap), the best ranked stat total over the player's active horses at the end of the run — after the
   * class normalisation — with the training growth (`trained`) and without it (`untrained`).
   */
  rankedTotalByClass: Record<string, { trained: number; untrained: number }>;
  /** REQ-RIVAL-* (E16): weeks settled, weeks won and the free coins the weekly results paid. */
  rivalWeeks: number;
  rivalWins: number;
  rivalCoins: number;
  /**
   * REQ-EXCH-* (E17, only with `events: true`): event races run, event points earned, what the exchange gave (free coins,
   * scout tickets, horses, breeding material, cosmetics) and the material the leftover points became.
   */
  eventRaces: number;
  eventPoints: number;
  exchangeCoins: number;
  exchangeTickets: number;
  exchangeHorses: number;
  exchangeMaterial: number;
  exchangeCosmetics: number;
  leftoverMaterial: number;
  /** REQ-WCH-* (E18): weekly challenges cleared (rewarded first clears), the free coins / breeding material they paid, badges. */
  challengeClears: number;
  challengeCoins: number;
  challengeMaterial: number;
  challengeBadges: number;
  /**
   * REQ-TGOAL-* (E19): weeks the player's team goal paid them and what it paid. Upper bound: the persona's team reaches
   * the top milestone every week; the persona is paid when its own races that week reach the minimum.
   */
  teamGoalWeeks: number;
  teamGoalCoins: number;
  teamGoalMaterial: number;
  /**
   * REQ-CAREER-* (E20): 騎手の道 races first cleared, stars earned, and what they paid (free coins, breeding material). Upper bound: every open race is cleared with every star as soon as the persona has a horse.
   */
  careerClears: number;
  careerStars: number;
  careerCoins: number;
  careerMaterial: number;
  /** Derived. */
  freeCoinsPerActiveDay: number;
  pullsPerMonth: number;
  ssrPerMonth: number;
}

const DAY = 86_400_000;
/** REQ-TGOAL-* (E19): the team every persona joins on its beginner "team" day. */
const SIM_TEAM = 'tsimteam00';

const unit = (rng: Rng) => rng.nextU32() / 4294967296;

function place(rng: Rng, bias: number, weights?: number[]): number {
  if (weights?.length) {
    // one draw, like the uniform draw: the place whose cumulative weight covers it
    let x = unit(rng) * weights.reduce((a, w) => a + w, 0);
    for (let i = 0; i < weights.length; i++) if ((x -= weights[i]!) < 0) return i + 1;
    return weights.length;
  }
  // uniform 1..12, shifted toward the front by `bias` places for skilled riders
  const p = 1 + Math.floor(unit(rng) * 12) - bias;
  return Math.max(1, Math.min(12, p));
}

/**
 * `sessionStartJstMin`: when the daily session starts, in minutes after 00:00 JST (default 12:00). 03:30 makes
 * every session straddle the 04:00 game-day rollover (REQ-DAY-001), and the first one also the 2026-12-01 switch.
 */
/** E17: of each active day's races, this many are event races while an event with an exchange is open (the rest stay ranked). */
export const EVENT_RACES_PER_DAY = 3;
export interface SimOptions {
  /**
   * REQ-EXCH-* (E17): play the configured events that have an exchange — EVENT_RACES_PER_DAY of the day's races become
   * event races (same play time), the exchange is spent once it is in its grace days (lines in list order, as many as the
   * points allow), the final rank reward is taken after the event (rank unknown = the participation tier) and points the
   * player never spent become material at the close.
   */
  events?: boolean;
}

export async function simulate(master: Master, persona: Persona, days = 90, seed = 1, sessionStartJstMin = 12 * 60, opts: SimOptions = {}): Promise<EconomyResult> {
  const start = Date.UTC(2026, 11, 1, -9, sessionStartJstMin); // on the 1st, a fresh season
  let now = start;
  const repo = new MemoryPlayerRepo();
  const store = new FakeStoreVerifier();
  const rng = seededRng(seed);
  const svc = new PlayerService(repo, { master, rng: seededRng(seed + 1000), trainingRng: seededRng(seed + 2000), challengeRng: seededRng(seed + 3000), clock: () => now, verifiers: { fake: store } });
  const id = `sim_${persona.id}`;
  let key = 0;
  const k = () => `c:sim:${key++}`;
  const r: EconomyResult = {
    persona: persona.id, days, activeDays: 0, freeCoinsEarned: 0, paidCoinsBought: 0, yenSpent: 0, pulls: 0, ssr: 0, sr: 0,
    pityExchanges: 0, firstPityDay: null, breedingMaterial: 0, gachaTickets: 0, ticketPulls: 0, firstWinCoins: 0, allowanceCoins: 0, beginnerCoins: 0, beginnerSteps: 0, seasonMissionXp: 0, inviteCoins: 0, inviteTickets: 0, comebackWindows: 0, comebackValue: 0, comebackXp: 0, adViews: 0, adCoins: 0, adTaAttempts: 0, achievementTiers: 0, achievementCoins: 0, trainingSessions: 0, trainedPoints: 0, giftsClaimed: 0, giftsExpired: 0, rivalWeeks: 0, rivalWins: 0, rivalCoins: 0, rankedTotalByClass: {},
    eventRaces: 0, eventPoints: 0, exchangeCoins: 0, exchangeTickets: 0, exchangeHorses: 0, exchangeMaterial: 0, exchangeCosmetics: 0, leftoverMaterial: 0,
    challengeClears: 0, challengeCoins: 0, challengeMaterial: 0, challengeBadges: 0,
    teamGoalWeeks: 0, teamGoalCoins: 0, teamGoalMaterial: 0, careerClears: 0, careerStars: 0, careerCoins: 0, careerMaterial: 0,
    freeCoinsPerActiveDay: 0, pullsPerMonth: 0, ssrPerMonth: 0,
  };
  await svc.bootstrap(id);
  await svc.setAge(id, 1990, 1, false);
  // REQ-RIVAL-* (E16): the weekly rival through the real service and an in-memory registry. The sim has no other humans,
  // so every persona gets a CPU rival (head to head on every ranked race against its targetPlace).
  const rp: RivalPlayers = {
    peek: (u) => svc.rivalPeek(u), sync: (u, d, q) => svc.rivalSync(u, d, q), setOptOut: (u, o) => svc.rivalSetOptOut(u, o), block: (u) => svc.rivalBlock(u),
    challengeCheck: (u) => svc.rivalChallengeCheck(u), challengeReceive: (u, f, p, n) => svc.rivalChallengeReceive(u, f, p, n), seen: (u, w) => svc.rivalSeen(u, w), push: (u, n, c) => svc.rivalPush(u, n, c),
  };
  // every persona meets the same middle-of-the-road CPU (targetPlace 6) so personas differ only by what they pay
  const rc = master.progression.rival;
  const rivalMaster: Master = rc ? { ...master, progression: { ...master.progression, rival: { ...rc, cpuRivals: [rc.cpuRivals.find((c) => c.targetPlace === 6) ?? rc.cpuRivals[0]!] } } } : master;
  const rival = new RivalService(() => master, rp, new MemoryRivalRegistry(() => rivalMaster, () => now));
  const rivalDay = async () => {
    const v = await rival.view(id);
    if (!('result' in v) || !v.result) return;
    const res = v.result as { weekId: string; outcome: string; freeCoins: number };
    r.rivalWeeks++;
    if (res.outcome === 'win') r.rivalWins++;
    r.rivalCoins += res.freeCoins;
    await rival.seen(id, res.weekId);
  };
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
      const out = await svc.inviteMilestone(id, inviteeId, milestoneId, 'sim');
      if (out.status !== 'rewarded') return;
      // REQ-BOX-001: the bonus is delivered to the gift box; the player claims it on the next active day (below)
      r.inviteCoins += out.reward.freeCoins ?? 0;
      r.inviteTickets += (out.reward.items ?? []).filter((x) => x.itemId === 'gacha_ticket').reduce((a, x) => a + x.qty, 0);
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
    else if (kind === 'team') {
      countOnboarding(st, 'team');
      // REQ-TGOAL-* (E19): from here on the persona is in a team (its races count toward the team's weekly goal)
      const t = ensureTeam(st);
      t.teamId = SIM_TEAM; t.joinedAt = now;
    }
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
  /**
   * REQ-WCH-* (E18), the upper bound: on its first active day of every game week the persona clears all 3 weekly challenges
   * with the loan horse (anyone can) through the real start → prepare → record path. The verifier's re-simulation is
   * replaced by an output where the player wins inside every time limit with no whips (a "perfect" week).
   */
  const challengeDay = async () => {
    const v = await svc.wchView(id);
    if (!v.enabled) return;
    for (const ch of v.challenges.filter((c) => !c.progress.cleared)) {
      const st = await svc.wchStart(id, ch.id, { loan: true }, k());
      const hash = 'e'.repeat(64);
      const prep = await svc.wchPrepare(id, st.sessionId, [[Number(st.config.ruleset.gateOpenTick), st.playerSlot, 1]], hash, undefined);
      if (prep.kind !== 'verify') continue;
      const gate = Number(st.config.ruleset.gateOpenTick);
      const msPerTick = Math.floor(1000 / st.config.net.tickHz);
      const tick = gate + Math.floor(((ch.conditions.maxTimeMs ?? 200_000) - 1000) / msPerTick);
      if (ch.conditions.maxTimeMs !== undefined && raceTimeMs(st.config, tick, 0) > ch.conditions.maxTimeMs) throw new Error('sim challenge time');
      const order = [st.playerSlot, ...st.config.entrants.map((e) => e.slot).filter((x) => x !== st.playerSlot)];
      const before = await svc.state(id);
      const res = await svc.wchRecord(id, st.sessionId, { resultHash: hash, order, finishTicks: order.map((_, i) => tick + i * 3), finishFracs: order.map(() => 0), checksums: {} }, hash);
      if ('rejected' in res || !res.cleared) throw new Error(`sim challenge not cleared: ${JSON.stringify(res)}`);
      const after = await svc.state(id);
      if (res.firstClear) r.challengeClears++;
      r.challengeCoins += after.wallet.free - before.wallet.free;
      r.challengeMaterial += (after.items['breeding_material'] ?? 0) - (before.items['breeding_material'] ?? 0);
      if (res.badge.newlyEarned) r.challengeBadges++;
    }
  };
  /**
   * REQ-CAREER-* (E20), the upper bound: on its first active day with an active horse the persona clears every open 騎手の道
   * race with every star (win, no whips), through the real start → prepare → record path (the verifier's re-simulation is
   * replaced by that output). Rewards are once ever, so this is the whole career's lifetime grant on one day.
   */
  const careerDay = async () => {
    for (;;) {
      const v = await svc.careerView(id);
      if (!v.enabled || v.nextRaceId === null) return;
      const horse = (await svc.state(id)).horses.find((h) => h.status === 'active');
      if (!horse) return;
      const st = await svc.careerStart(id, v.nextRaceId, horse.id, k());
      const hash = 'c'.repeat(64);
      const prep = await svc.careerPrepare(id, st.sessionId, [[Number(st.config.ruleset.gateOpenTick), st.playerSlot, 1]], hash, undefined);
      if (prep.kind !== 'verify') return;
      const tick = Number(st.config.ruleset.gateOpenTick) + 1800;
      const order = [st.playerSlot, ...st.config.entrants.map((e) => e.slot).filter((x) => x !== st.playerSlot)];
      const before = await svc.state(id);
      const res = await svc.careerRecord(id, st.sessionId, { resultHash: hash, order, finishTicks: order.map((_, i) => tick + i * 3), finishFracs: order.map(() => 0), checksums: {} }, hash);
      if ('rejected' in res || !res.cleared) throw new Error(`sim career race not cleared: ${JSON.stringify(res)}`);
      const after = await svc.state(id);
      if (res.firstClear) r.careerClears++;
      r.careerStars += res.newStars.length;
      r.careerCoins += after.wallet.free - before.wallet.free;
      r.careerMaterial += (after.items['breeding_material'] ?? 0) - (before.items['breeding_material'] ?? 0);
    }
  };
  /** REQ-TGOAL-007 (E19): the week-close payout of the persona's team (top milestone reached: the upper bound). */
  const goalCfg = master.progression.teamGoal;
  const goalMin = goalCfg ? Math.min(...goalCfg.goals.filter((g) => g.kind === 'races').map((g) => g.minContribution)) : 0;
  let goalWeek = '';
  const payGoal = async (week: string) => {
    if (!goalCfg) return;
    const st = await svc.state(id);
    const g = ensureGoal(st);
    const mine = g.week === week && g.weekTeam === SIM_TEAM ? g.weekSent.races : 0;
    if (st.team?.teamId !== SIM_TEAM || mine < goalMin) return;
    const out = await svc.teamGoalReward(id, week, SIM_TEAM, goalCfg.tiers.length, mine);
    if (out?.status !== 'rewarded') return;
    // §26.1: the week reward arrives in the gift box; it is claimed on the persona's next active day (giftClaimAll above)
    r.teamGoalWeeks++;
    r.teamGoalCoins += out.reward?.freeCoins ?? 0;
    r.teamGoalMaterial += (out.reward?.items ?? []).filter((x) => x.itemId === 'breeding_material').reduce((a, x) => a + x.qty, 0);
  };
  for (let d = 0; d < days; d++) {
    now = start + d * DAY;
    const wk = weekKeyOf(now, dayRule(master));
    if (goalWeek && wk !== goalWeek) await payGoal(goalWeek);
    goalWeek = wk;
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
    // REQ-BOX-013: whatever arrived in the gift box (invite bonuses) is claimed when the player opens the app
    r.giftsClaimed += (await svc.giftClaimAll(id, k())).claimed.length;
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
    // E17: the event with an exchange that is open now (if any) takes EVENT_RACES_PER_DAY of the day's races
    const liveEvent = opts.events ? master.events.find((e) => e.exchange && now >= e.startAtMs && now < e.endAtMs) : undefined;
    for (let i = 0; i < persona.racesPerDay; i++) {
      now += 10 * 60_000;
      if (liveEvent && i < EVENT_RACES_PER_DAY && now < liveEvent.endAtMs) {
        const horse = best((await svc.state(id)).horses)[0];
        if (horse) {
          const entered = await svc.eventEnter(id, liveEvent.id, horse.id, k()).catch((e: unknown) => { if (e instanceof AppError) return null; throw e; });
          if (entered) {
            const er = await svc.applyRace(id, { raceId: `sim_ev_${persona.id}_${d}_${i}`, mode: 'event', eventId: liveEvent.id, place: place(rng, persona.placeBias, Array.isArray(persona.placeWeights) ? persona.placeWeights : undefined), fieldSize: 12, newRating: null, void: false, humans: 4 });
            r.eventRaces++;
            r.eventPoints += (er as { event?: { exchange?: { gained: number } | null } | null }).event?.exchange?.gained ?? 0;
            continue;
          }
        }
      }
      // ride details as a confirmed room sends them (stats, wins per course, every other race the horse's skill fires):
      // the achievements (REQ-ACH-*) count from these, so the sim pays them like a real player earns them
      const trackId = master.tracks[(d * persona.racesPerDay + i) % master.tracks.length]!.id;
      const details = { trackId, style: 'senko' as const, finishTick: null, startReactionTicks: null, whips: 0, whipMashed: false, cpuAssisted: false, skillFired: i % 2 === 0 };
      const pw = typeof persona.placeWeights === 'function'
        ? await svc.state(id).then((st) => (persona.placeWeights as (at: { classId: string; rankedRaces: number }) => number[] | undefined)({ classId: st.season.classId, rankedRaces: st.rating.rankedRaces }))
        : persona.placeWeights;
      const ar = await svc.applyRace(id, { raceId: `sim_${persona.id}_${d}_${i}`, mode: 'ranked', place: place(rng, persona.placeBias, pw), fieldSize: 12, newRating: null, void: false, humans: 4, details });
      if ('firstWinBonus' in ar && typeof ar.firstWinBonus === 'number') r.firstWinCoins += ar.firstWinBonus;
      if ('comebackXp' in ar && typeof ar.comebackXp === 'number') r.comebackXp += ar.comebackXp;
    }
    // E17: the exchange is spent once the event is over (grace days): every line in list order, as many as the points allow;
    // the final rank reward is taken then (the board is not simulated: the participation tier)
    if (opts.events) {
      for (const ev of master.events.filter((e) => e.exchange && now >= e.endAtMs && now < exchangeClosesAt(e, e.exchange!, dayRule(master)))) {
        if (!((await svc.state(id)).events?.[ev.id]?.races)) continue;
        await svc.eventClose(id, ev.id, null);
        for (const line of ev.exchange!.items) {
          for (;;) {
            const v = await svc.exchangeView(id, ev.id);
            const lv = v.items.find((x) => x.id === line.id)!;
            if (lv.maxQty <= 0) break;
            const before = await wallet();
            await svc.exchangeBuy(id, ev.id, line.id, lv.maxQty, k());
            r.exchangeCoins += (await wallet()).free - before.free;
            const n = lv.maxQty * (line.reward.items?.[0]?.qty ?? 1);
            if (line.kind === 'ticket') r.exchangeTickets += n;
            if (line.kind === 'horse') r.exchangeHorses += n;
            if (line.kind === 'material') r.exchangeMaterial += n;
            if (line.kind === 'cosmetic') r.exchangeCosmetics += n;
          }
        }
      }
    }
    // REQ-TRAIN-* (E15): every persona uses its training slots on its best horses (2 on the best, the rest on the next),
    // plays the mini-game at an average level (every beat 100 ms late = "good"), rests a tired horse in the pool and
    // feeds the apple from the daily mission to the best horse. Training gives no coins, so E1–E13 do not move.
    await trainDay();
    await rivalDay(); // REQ-RIVAL-006: the home rival card syncs (an ended week settles and pays here)
    // REQ-WCH-* (E18): the week's 3 challenges, all cleared (upper bound; small fixed rewards once a week)
    await challengeDay();
    // REQ-CAREER-* (E20): the whole 騎手の道 with every star (once ever; after that this is a no-op)
    await careerDay();
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
  // E17: leftover points of exchanges that closed during the run were converted by the player's transactions
  if (opts.events) {
    await svc.exchangeView(id, master.events.find((e) => e.exchange)?.id ?? '').catch(() => undefined);
    for (const e of Object.values((await svc.state(id)).events ?? {})) r.leftoverMaterial += e.exchange?.converted?.qty ?? 0;
  }
  const s = await svc.state(id);
  r.giftsExpired = (s.giftBox?.history ?? []).filter((e) => e.status === 'expired').length;
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

export async function simulateAll(master: Master, days = 90, seeds = [1, 2, 3], sessionStartJstMin = 12 * 60, opts: SimOptions = {}) {
  const out: Record<string, EconomyResult> = {};
  for (const p of PERSONAS) {
    const runs = await Promise.all(seeds.map((s) => simulate(master, p, days, s, sessionStartJstMin, opts)));
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
      giftsClaimed: avg((x) => x.giftsClaimed), giftsExpired: avg((x) => x.giftsExpired),
      rivalWeeks: avg((x) => x.rivalWeeks), rivalWins: avg((x) => x.rivalWins), rivalCoins: avg((x) => x.rivalCoins),
      eventRaces: avg((x) => x.eventRaces), eventPoints: avg((x) => x.eventPoints), exchangeCoins: avg((x) => x.exchangeCoins),
      exchangeTickets: avg((x) => x.exchangeTickets), exchangeHorses: avg((x) => x.exchangeHorses), exchangeMaterial: avg((x) => x.exchangeMaterial),
      exchangeCosmetics: avg((x) => x.exchangeCosmetics), leftoverMaterial: avg((x) => x.leftoverMaterial),
      challengeClears: avg((x) => x.challengeClears), challengeCoins: avg((x) => x.challengeCoins), challengeMaterial: avg((x) => x.challengeMaterial), challengeBadges: avg((x) => x.challengeBadges),
      teamGoalWeeks: avg((x) => x.teamGoalWeeks), teamGoalCoins: avg((x) => x.teamGoalCoins), teamGoalMaterial: avg((x) => x.teamGoalMaterial),
      careerClears: avg((x) => x.careerClears), careerStars: avg((x) => x.careerStars), careerCoins: avg((x) => x.careerCoins),
      careerMaterial: avg((x) => x.careerMaterial),
      rankedTotalByClass: Object.fromEntries(master.progression.classes.map((c) => [c.id, {
        trained: avg((x) => x.rankedTotalByClass[c.id]!.trained), untrained: avg((x) => x.rankedTotalByClass[c.id]!.untrained),
      }])),
      freeCoinsPerActiveDay: avg((x) => x.freeCoinsPerActiveDay), pullsPerMonth: avg((x) => x.pullsPerMonth), ssrPerMonth: avg((x) => x.ssrPerMonth),
    };
  }
  return out;
}

/** contracts/ranked-places.vectors.json (written by the C# ranked harness): place counts per class × horse × stage × rider × ruleset. */
export interface RankedPlaceVectors { cells: { set: string; ruleset: string; rider: string; races: number; places: number[] }[] }

/**
 * Quality pass 2 (docs/quality/ranked.md, W8): the ranked places the field really gives a rider, by where the player is —
 * the beginner matches, the ramp after them (class C), then the regular field of the player's class (the partner as given
 * for the first `day30AfterRaces` ranked races, then the typical day-30 horse). Feeds Persona.placeWeights.
 */
export function harnessPlaceWeights(v: RankedPlaceVectors, rider: string, ruleset: string, beginnerRaces: number, rampRaces: number, day30AfterRaces = 90) {
  const cell = (set: string) => {
    const c = v.cells.find((x) => x.set === set && x.rider === rider && x.ruleset === ruleset);
    if (!c) throw new Error(`ranked-places vectors: no ${set} ${rider} ${ruleset}`);
    return c.places;
  };
  return (at: { classId: string; rankedRaces: number }) =>
    at.rankedRaces < beginnerRaces ? cell('C/starter/beginner')
      : at.rankedRaces < beginnerRaces + rampRaces && at.classId === 'C' ? cell('C/starter/ramp')
        : cell(`${at.classId}/${at.rankedRaces < day30AfterRaces ? 'starter' : 'day30'}/regular`);
}
