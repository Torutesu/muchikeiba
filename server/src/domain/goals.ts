/**
 * 目標の階段 — the goal ladder (REQ-GOAL-001..012, contracts/protocol.md「目標の階段」, docs/quality/goals-rewards.md).
 *
 * One read of "why play today, why this week, why climb" built only from systems that already exist, so home can show
 * three honest rungs instead of a dozen competing meters:
 *   today   the daily missions + today's first-win bonus (one progress figure, one claim)
 *   path    the beginner steps while they last (the next step and the final reward), in place of the week for new players
 *   week    the weekly challenge and the weekly rival (and the team goal when GET /v1/home/goals is given one)
 *   season  the ranked class: points against the promotion line, the player's own pace, what the next class changes for
 *           the partner (the class stat cap = how much of its strength it may use in ranked), the class ladder with its
 *           season rewards, the season missions and the pass level
 * and one claim for everything claimable on the ladder (daily, beginner and season missions) in a single transaction.
 *
 * Rules that keep it honest:
 *   - nothing new is paid: claimAllGoals only calls the existing claim functions (same rewards, same idempotency keys);
 *     the ladder reads, it never writes (safe in GET).
 *   - the pace estimate is the player's own average this season, and only after `PACE_MIN_RACES` ranked races (no
 *     invented numbers); deadlines are real times (game day start, week end, month end), never a countdown.
 *   - no purchasable thing appears as a way up (ranked fairness, REQ-RATE-003): the power line is the class cap only.
 *   - §68 (promotion series, Round 22) plugs in through `extras.promotion` (the GET /v1/promotion brief) when integrated.
 *
 * First week (quality pass 2, docs/quality/first-week.md, REQ-GOAL-013..016) — three reads on the same ladder:
 *   today.tomorrow  what the next game day brings, as facts only: tomorrow's login bonus, the features that open by day
 *                   count tomorrow, the training slots that refill (REQ-GOAL-013). Never a countdown.
 *   partner         the partner's growth: stage of five, trained total, gained today / the game day before (from the
 *                   training log), sessions left today (REQ-GOAL-014). The same stage function as the 馬カード.
 *   path.current    `screen` (fixed in code per kind, never a shop / purchase) and `open` (its feature is unlocked) so the
 *                   next first step is one tap away (REQ-GOAL-015).
 *
 * Week 2 (quality pass 3, docs/quality/week2.md, REQ-GOAL-017..020) — still reads only, nothing new is paid:
 *   path.current.alt / fromDay   the either/or of a social step (its solo way) and the day the last step opens (day 8:
 *                   はじめの10歩 卒業 is the week-2 goal; the same 10-pull ticket, moved later) (REQ-GOAL-017).
 *   today.tomorrow.graduate      on day 7, "tomorrow you graduate" with its reward (REQ-GOAL-018).
 *   week2           days 8..14 (shown from day 7): one reason per day — the login bonus each day brings if the player comes
 *                   every day (the same tables, projected), graduation on its day, the peak of the week (REQ-GOAL-019).
 *   partner.treat   the moment a training item matters for the partner (training.treatHint) (REQ-GOAL-020).
 */
import type { ClassDef, Master, Reward } from './master.js';
import type { PlayerState } from './player.js';
import { addJstDays, dayRule, gameDayKey, gameDayStartMs, jstMonthEndMs, sameGameDay } from './time.js';
import { beginnerMissionsView, claimBeginnerMission, claimSeasonMission, playerDay, seasonMissionsView, unlocksView } from './onboarding.js';
import { claimMission, firstWinBonusView, missionsView } from './rewards.js';
import { levelOf } from './pass.js';
import { STAT_KEYS } from './master.js';
import { potentialOf, raceStats, trainedTotal, trainingConfig, treatHint } from './training.js';
import { GROWTH_STAGES, GROWTH_THRESHOLDS_PERMILLE, growthStage } from './horseProfile.js';
import { weekAt, weeklyChallengeConfig } from './weeklyChallenge.js';
import { rivalConfig, weekEndMs, weekIdAt } from './rival.js';
import type { TeamGoalBrief } from './nextAction.js';
import { AppError } from './errors.js';

/** The pace line needs this many ranked races this season (fewer = no estimate). */
export const PACE_MIN_RACES = 3;

/** §68 brief (GET /v1/promotion): only what the ladder shows. Absent until Round 22 is merged. */
export interface PromotionBrief { status: 'active' | 'passed' | 'failed' | 'season_end'; next: number | null; races: number; needTop: number; tops: number; misses: number }
export interface GoalExtras { teamGoal?: TeamGoalBrief | null; promotion?: PromotionBrief | null }

export interface GoalItem {
  id: string;
  /** daily | first_win | beginner | season */
  table: 'daily' | 'first_win' | 'beginner' | 'season';
  kind: string;
  progress: number;
  target: number;
  reward: Reward;
  claimed: boolean;
  claimable: boolean;
}

const sumReward = (a: Reward, b: Reward): Reward => {
  const items = new Map<string, number>();
  for (const it of [...(a.items ?? []), ...(b.items ?? [])]) items.set(it.itemId, (items.get(it.itemId) ?? 0) + it.qty);
  const out: Reward = {};
  const coins = (a.freeCoins ?? 0) + (b.freeCoins ?? 0);
  if (coins) out.freeCoins = coins;
  const xp = (a.passXp ?? 0) + (b.passXp ?? 0);
  if (xp) out.passXp = xp;
  if (items.size) out.items = [...items].map(([itemId, qty]) => ({ itemId, qty }));
  if (a.horse ?? b.horse) out.horse = (a.horse ?? b.horse)!;
  if (a.broodmare ?? b.broodmare) out.broodmare = (a.broodmare ?? b.broodmare)!;
  return out;
};

const total = (st: Record<string, number>) => STAT_KEYS.reduce((a, k) => a + (st[k] ?? 0), 0);

/** The partner (or the strongest horse) and how much of it the class lets race (REQ-GOAL-006). */
function powerLine(m: Master, s: PlayerState, cls: ClassDef, next: ClassDef | null) {
  const pool = s.horses.filter((h) => h.status === 'active');
  if (!pool.length) return null;
  const partner = pool.find((h) => h.id === s.flags.partnerHorseId);
  const scored = pool.map((h) => ({ h, t: total(raceStats(m, h)) }));
  const pick = partner ? scored.find((x) => x.h.id === partner.id)! : scored.sort((a, b) => b.t - a.t || (a.h.id < b.h.id ? -1 : 1))[0]!;
  const usable = Math.min(pick.t, cls.statCap);
  return {
    horseId: pick.h.id, partner: !!partner,
    total: pick.t, cap: cls.statCap, usable,
    nextCap: next?.statCap ?? null, nextUsable: next ? Math.min(pick.t, next.statCap) : null,
    /** Stats above the cap do nothing in ranked this class (training / awakening show only from the next class). */
    held: Math.max(0, pick.t - cls.statCap),
  };
}

function rewardBands(m: Master, classId: string) {
  const bands = m.progression.seasonRewards[classId] ?? [];
  const top = bands[0] ?? null;
  const floor = bands.find((b) => b.maxRank === null) ?? null;
  return { top: top ? { maxRank: top.maxRank, reward: top.reward } : null, floor: floor ? floor.reward : null };
}

/**
 * REQ-GOAL-011: what the next login bonus claim gives (today's if not claimed yet, else tomorrow's) — the same tables and
 * order as claimLoginBonus (the beginner week once, then the 7-day cycle). A fact for "come back tomorrow", never a countdown.
 */
export function nextLoginBonus(m: Master, s: PlayerState) {
  const beginner = m.progression.beginnerLoginBonus ?? [];
  const bDay = s.loginBonus.beginnerDay ?? (s.loginBonus.lastClaimDate === null ? 0 : beginner.length);
  const strip = (d: { day: number } & Reward): Reward => { const { day: _d, ...r } = d; return r; };
  if (bDay < beginner.length) {
    const d = beginner.find((x) => x.day === bDay + 1);
    return d ? { track: 'beginner' as const, day: bDay + 1, days: beginner.length, reward: strip(d) } : null;
  }
  const cycle = m.progression.loginBonus;
  if (!cycle.length) return null;
  const day = (s.loginBonus.streakDay % cycle.length) + 1;
  const d = cycle.find((x) => x.day === day);
  return d ? { track: 'normal' as const, day, days: cycle.length, reward: strip(d) } : null;
}

/**
 * REQ-GOAL-019: the login bonus each coming game day brings if the player claims every day — the same tables and order as
 * claimLoginBonus, projected from the state. Keyed by player day, from today (if not claimed yet) or tomorrow, to `toDay`.
 */
export function loginBonusPlan(m: Master, s: PlayerState, now: number, toDay: number) {
  const beginner = m.progression.beginnerLoginBonus ?? [];
  const cycle = m.progression.loginBonus;
  const rule = dayRule(m);
  const pday = playerDay(s, now, rule);
  let bDay = s.loginBonus.beginnerDay ?? (s.loginBonus.lastClaimDate === null ? 0 : beginner.length);
  let streak = s.loginBonus.streakDay;
  const strip = (d: { day: number } & Reward): Reward => { const { day: _d, ...r } = d; return r; };
  const out: { playerDay: number; track: 'beginner' | 'normal'; day: number; days: number; reward: Reward }[] = [];
  for (let d = sameGameDay(s.loginBonus.lastClaimDate, gameDayKey(now, rule)) ? pday + 1 : pday; d <= toDay; d++) {
    if (bDay < beginner.length) {
      const def = beginner.find((x) => x.day === bDay + 1);
      bDay += 1;
      if (def) out.push({ playerDay: d, track: 'beginner', day: def.day, days: beginner.length, reward: strip(def) });
      continue;
    }
    if (!cycle.length) break;
    const day = (streak % cycle.length) + 1;
    streak = day;
    const def = cycle.find((x) => x.day === day);
    if (def) out.push({ playerDay: d, track: 'normal', day, days: cycle.length, reward: strip(def) });
  }
  return out;
}

/** The week-2 arc runs over these player days; it is shown from the day before it starts. */
export const WEEK2 = { fromDay: 8, toDay: 14 } as const;
/** The headline of a week: the strongest login reward by kind (a guaranteed-SR ticket, a 10-pull, a scout ticket, coins). */
function rewardRank(r: Reward): number {
  const has = (id: string) => (r.items ?? []).some((x) => x.itemId === id);
  return has('gacha_ticket_10') ? 4000 : has('ticket_sr_plus') ? 3000 : has('gacha_ticket') ? 2000 : r.broodmare || r.horse ? 1500 : (r.freeCoins ?? 0);
}

/**
 * REQ-GOAL-015: where each first step is done (fixed in code; never the shop, a purchase or a paid scout — the scout step is
 * the scout screen the player already used in the FTUE) and the feature that has to be open for it.
 */
export const PATH_SCREENS: Record<string, { screen: string; feature: string | null }> = {
  gacha: { screen: 'scout', feature: null }, silks: { screen: 'silks', feature: null }, care: { screen: 'care', feature: 'bond' },
  ranked_top3: { screen: 'race', feature: null }, ranked_races: { screen: 'race', feature: null }, races: { screen: 'race', feature: null },
  breed: { screen: 'breeding', feature: 'breeding' }, friends: { screen: 'friends', feature: 'friends' }, team: { screen: 'teams', feature: 'teams' },
  ta_finish: { screen: 'time_attack', feature: 'time_attack' }, collect: { screen: 'collection', feature: null },
  // REQ-GOAL-017: the solo ways of the social steps (a treat for the partner, an extra breeding with material)
  treat: { screen: 'training', feature: 'training' }, breed_extra: { screen: 'breeding', feature: 'breeding' },
};

/** REQ-GOAL-014: the partner's growth for home (null without an active partner or with training switched off). */
function partnerGrowth(m: Master, s: PlayerState, now: number, trainingOpen: boolean) {
  const tc = trainingConfig(m);
  const h = s.horses.find((x) => x.id === s.flags.partnerHorseId && x.status === 'active');
  if (!tc || !h) return null;
  const rule = dayRule(m);
  const today = gameDayKey(now, rule);
  const yesterday = addJstDays(today, -1);
  const tt = trainedTotal(h);
  const potential = potentialOf(tc, h);
  const st = growthStage(tt, potential);
  const rec = s.training?.horses[h.id];
  let gainedToday = 0, gainedYesterday = 0;
  for (const e of rec?.log ?? []) {
    const d = gameDayKey(e.at, rule);
    if (d === today) gainedToday += e.gain; else if (d === yesterday) gainedYesterday += e.gain;
  }
  const t = s.training;
  const usedToday = t && sameGameDay(t.day, today) ? t.used : 0;
  const horseToday = rec && sameGameDay(rec.day, today) ? rec.dayCount : 0;
  const full = potential > 0 && tt >= potential;
  const sessionsLeft = !trainingOpen || full ? 0 : Math.max(0, Math.min(tc.slotsPerDay - usedToday, tc.perHorsePerDay - horseToday));
  return {
    horseId: h.id, name: h.name,
    stage: st.index, stageKey: st.key, stages: GROWTH_STAGES.length,
    /** The trained total where this stage started (the gauge runs from here to nextStageAt). */
    stageFrom: Math.ceil((GROWTH_THRESHOLDS_PERMILLE[st.index]! * potential) / 1000), nextStageAt: st.nextAt,
    trainedTotal: tt, potential, gainedToday, gainedYesterday,
    trainingOpen,
    /** REQ-GOAL-020: a treat would help the partner train today (null when it does not matter: no session left today, fresh, none owned). */
    treat: sessionsLeft > 0 ? treatHint(m, tc, s, h, now) : null,
    /** Sessions this horse can still train today (0 once the account's slots or the horse's daily limit are used, or it is full). */
    sessionsLeft,
    full,
  };
}

/** REQ-GOAL-001: GET /v1/home/goals. Reads only (no writes). */
export function goalLadderView(m: Master, s: PlayerState, now: number, extras: GoalExtras = {}) {
  const rule = dayRule(m);
  const day = gameDayKey(now, rule);
  const resetAt = gameDayStartMs(addJstDays(day, 1), rule);
  const ul = unlocksView(m, s, now);
  const open = (k: string) => ul.features.find((f) => f.key === k)?.unlocked ?? false;

  // ---- today (REQ-GOAL-002): the daily missions and the first-win bonus as one set
  const missionsToday = sameGameDay(s.missions.date, day);
  const daily: GoalItem[] = open('missions') ? m.progression.dailyMissions.map((d) => {
    const progress = missionsToday ? Math.min(d.target, s.missions.progress[d.id] ?? 0) : 0;
    const claimed = missionsToday && s.missions.claimed.includes(d.id);
    return { id: d.id, table: 'daily', kind: d.kind, progress, target: d.target, reward: d.reward, claimed, claimable: progress >= d.target && !claimed };
  }) : [];
  const fw = m.progression.firstWinBonus ? firstWinBonusView(m, s, now) : null;
  const firstWin: GoalItem | null = fw && fw.byWin.length && open('missions') ? {
    id: 'first_win', table: 'first_win', kind: 'first_win', progress: fw.winsToday > 0 ? 1 : 0, target: 1,
    // paid automatically on the win (REQ-UXS-010); shown as a goal, never a claim
    reward: { freeCoins: fw.byWin[0]! }, claimed: fw.winsToday > 0, claimable: false,
  } : null;
  const items = [...daily, ...(firstWin ? [firstWin] : [])];
  const done = items.filter((i) => i.progress >= i.target).length;
  const today = {
    open: items.length > 0,
    items, done, total: items.length,
    claimable: items.filter((i) => i.claimable).length,
    complete: items.length > 0 && items.every((i) => i.claimed || (i.table === 'first_win' && i.progress >= i.target)),
    resetAt,
    loginBonus: { open: open('login_bonus'), claimedToday: sameGameDay(s.loginBonus.lastClaimDate, day), next: nextLoginBonus(m, s) },
    /** 1 on the install day, 2 the next game day, … (the first week reads it). */
    playerDay: playerDay(s, now, rule),
    tomorrow: null as null | { playerDay: number; at: number; loginBonus: ReturnType<typeof nextLoginBonus>; opens: string[]; trainingSlots: number | null; graduate: { reward: Reward; ready: boolean } | null },
  };
  // REQ-GOAL-013: tomorrow, facts only. The login bonus once today's is received (before that, today's is the news); the
  // features whose day count is reached tomorrow (they may open earlier by races — then they are simply open today);
  // the training slots that refill (training open now or opening tomorrow).
  {
    const pday = today.playerDay;
    const opens = (m.progression.unlocks ?? []).filter((u) => u.days === pday + 1 && !open(u.key)).map((u) => u.key);
    const tc = trainingConfig(m);
    const trainingTomorrow = !!tc && (open('training') || opens.includes('training'));
    today.tomorrow = {
      playerDay: pday + 1, at: resetAt,
      loginBonus: today.loginBonus.claimedToday ? today.loginBonus.next : null,
      opens, trainingSlots: trainingTomorrow ? tc!.slotsPerDay : null,
      graduate: null,
    };
  }

  // ---- the beginner path (REQ-GOAL-003): the next step and the last reward, while the list lasts
  const bv = beginnerMissionsView(m, s, now);
  // REQ-GOAL-018: the last step opens tomorrow (day 8) — the week-2 goal, said the day before. `ready` = every earlier
  // step is claimed and its target is reached (it is claimable as soon as the day starts); otherwise it is the goal.
  {
    const last = bv.steps[bv.steps.length - 1];
    if (last && !last.claimed && last.fromDay === today.playerDay + 1) {
      today.tomorrow!.graduate = { reward: last.reward, ready: last.reached && bv.steps.slice(0, -1).every((x) => x.claimed) };
    }
  }
  const path = bv.completed || !bv.steps.length ? null : (() => {
    const cur = bv.steps.find((x) => !x.claimed)!;
    const last = bv.steps[bv.steps.length - 1]!;
    return {
      step: cur.step, steps: bv.steps.length, done: bv.steps.filter((x) => x.claimed).length,
      current: { id: cur.id, table: 'beginner' as const, kind: cur.kind, progress: cur.progress, target: cur.target, reward: cur.reward, claimed: false, claimable: cur.claimable,
        // REQ-GOAL-015: one tap to where the step is done, and whether that screen is open yet
        screen: PATH_SCREENS[cur.kind]?.screen ?? null, open: PATH_SCREENS[cur.kind]?.feature ? open(PATH_SCREENS[cur.kind]!.feature!) : true,
        // REQ-GOAL-017: the solo way of a social step, with its own screen; the day the step opens (the target may be met)
        alt: cur.alt ? { ...cur.alt, screen: PATH_SCREENS[cur.alt.kind]?.screen ?? null, open: PATH_SCREENS[cur.alt.kind]?.feature ? open(PATH_SCREENS[cur.alt.kind]!.feature!) : true } : null,
        reached: cur.reached, fromDay: cur.fromDay, dayOk: cur.dayOk },
      finalReward: last.reward,
      /** The day the last step opens (null = no day). */
      finalFromDay: last.fromDay,
    };
  })();

  // ---- week 2 (REQ-GOAL-019): days 8..14, shown from day 7. One reason per day, as facts: the login bonus of that day if the
  // player comes every day (projected from the same tables), graduation on its day while the list is unfinished, and the
  // peak of the week. `day` 0 on the preview day, 1..7 inside the week. Nothing is granted by it.
  const week2 = today.playerDay >= WEEK2.fromDay - 1 && today.playerDay <= WEEK2.toDay ? (() => {
    const plan = loginBonusPlan(m, s, now, WEEK2.toDay).filter((x) => x.playerDay >= WEEK2.fromDay);
    // today's, once received (the plan starts tomorrow then): the entry the claim used
    if (today.loginBonus.claimedToday && today.playerDay >= WEEK2.fromDay) {
      const beginnerLen = (m.progression.beginnerLoginBonus ?? []).length;
      const onBeginner = (s.loginBonus.beginnerDay ?? beginnerLen) < beginnerLen || (s.loginBonus.beginnerDay === beginnerLen && s.loginBonus.streakDay === 0);
      const def = onBeginner ? null : m.progression.loginBonus.find((x) => x.day === s.loginBonus.streakDay);
      if (def) { const { day: _d, ...reward } = def; plan.unshift({ playerDay: today.playerDay, track: 'normal', day: def.day, days: m.progression.loginBonus.length, reward }); }
    }
    const last = bv.steps[bv.steps.length - 1];
    const gradDay = last && !last.claimed && last.fromDay !== null ? Math.max(last.fromDay, WEEK2.fromDay, today.playerDay) : null;
    const days = [];
    for (let d = WEEK2.fromDay; d <= WEEK2.toDay; d++) {
      const lb = plan.find((x) => x.playerDay === d) ?? null;
      days.push({
        playerDay: d, today: d === today.playerDay, past: d < today.playerDay,
        loginBonus: lb ? { track: lb.track, day: lb.day, days: lb.days, reward: lb.reward } : null,
        graduate: gradDay === d && last ? { reward: last.reward, ready: last.reached && bv.steps.slice(0, -1).every((x) => x.claimed) } : null,
      });
    }
    const future = days.filter((x) => !x.past && x.loginBonus);
    const peak = future.reduce<(typeof days)[number] | null>((a, x) => (!a || rewardRank(x.loginBonus!.reward) > rewardRank(a.loginBonus!.reward) ? x : a), null);
    return {
      fromDay: WEEK2.fromDay, toDay: WEEK2.toDay, day: Math.max(0, today.playerDay - WEEK2.fromDay + 1), days,
      peak: peak ? { playerDay: peak.playerDay, reward: peak.loginBonus!.reward } : null,
      graduate: last && !last.claimed ? { playerDay: gradDay, reward: last.reward } : null,
    };
  })() : null;

  // ---- this week (REQ-GOAL-004)
  const wc = weeklyChallengeConfig(m);
  const challenge = wc && wc.enabled && open('weekly_challenge') ? (() => {
    const cur = weekAt(m, wc, now);
    const wk = s.weeklyChallenge?.weeks[cur.weekId];
    const cleared = cur.def.challenges.filter((ch) => wk?.cleared[ch.id]).length;
    const reward = cur.def.challenges.reduce<Reward>((a, ch) => sumReward(a, ch.reward), {});
    return { weekId: cur.weekId, endsAt: cur.endsAt, cleared, total: cur.def.challenges.length, reward, badgeId: cur.def.badge.id, badgeName: cur.def.badge.name, badgeEarned: cleared >= cur.def.challenges.length };
  })() : null;
  const rc = rivalConfig(m);
  const rival = rc && open('rival') && s.rival && !s.rival.optOut ? (() => {
    const weekId = weekIdAt(m, now);
    const w = s.rival!.weeks.find((x) => x.weekId === weekId);
    const a = w?.assignment;
    if (!w || !a || (a.kind === 'human' && a.dissolvedAt !== null && now >= a.dissolvedAt)) return null;
    return { weekId, endsAt: weekEndMs(m, weekId), kind: a.kind, me: w.me, them: w.them, rankedRaces: w.rankedRaces, minRaces: rc.minRacesForResult, winReward: rc.rewards.win };
  })() : null;
  const tg = extras.teamGoal && open('teams') ? (() => {
    const next = extras.teamGoal!.milestones.find((x) => !x.reached);
    const reached = extras.teamGoal!.milestones.filter((x) => x.reached).length;
    return { endsAt: extras.teamGoal!.endsAt, progress: extras.teamGoal!.progress, nextTarget: next?.target ?? null, reached, tiers: extras.teamGoal!.milestones.length };
  })() : null;
  // last week's rival result while the player has not looked at it (the home strip used to say 「結果が出ました」)
  const rivalResult = rc && open('rival') && s.rival && !s.rival.optOut && s.rival.unseen ? (() => {
    const r = s.rival!.results.find((x) => x.weekId === s.rival!.unseen);
    return r ? { weekId: r.weekId, outcome: r.outcome, me: r.me, them: r.them, freeCoins: r.freeCoins } : null;
  })() : null;
  const week = challenge || rival || tg || rivalResult ? {
    endsAt: Math.min(...[challenge?.endsAt, rival?.endsAt, tg?.endsAt, rivalResult ? weekEndMs(m, weekIdAt(m, now)) : undefined].filter((x): x is number => typeof x === 'number')),
    challenge, rival, teamGoal: tg, rivalResult,
  } : null;

  // ---- this season (REQ-GOAL-005..008)
  const classes = m.progression.classes;
  const idx = Math.max(0, classes.findIndex((c) => c.id === s.season.classId));
  const cls = classes[idx]!;
  const next = cls.promotePoints !== null ? classes[idx + 1] ?? null : null;
  const line = cls.promotePoints;
  const points = s.season.points;
  const races = s.season.races;
  const left = line === null ? null : Math.max(0, line - points);
  // the player's own pace this season (×10, integer: 12.5 pt a race = 125), only with enough races
  const pace10 = races >= PACE_MIN_RACES ? Math.floor((points * 10) / races) : null;
  const racesToLine = left === null || left === 0 || pace10 === null || pace10 <= 0 ? null : Math.ceil((left * 10) / pace10);
  const status = !open('season') ? 'rookie' : line === null ? 'top' : points >= line ? 'line_reached' : 'climbing';
  const sm = seasonMissionsView(m, s);
  const seasonItems: GoalItem[] = sm.missions.filter((x) => x.available).map((x) => ({ id: x.id, table: 'season', kind: x.kind, progress: x.progress, target: x.target ?? 0, reward: x.reward, claimed: x.claimed, claimable: x.claimable }));
  const sp = s.seasonPass;
  const passLevel = levelOf(m, sp.xp);
  let passFreeClaimable = 0;
  const every = m.progression.passRewards.free.every;
  if (sp.forfeitedAt === undefined && every >= 1) for (let l = every; l <= passLevel; l += every) if (!sp.claimed.free.includes(l)) passFreeClaimable++;
  const season = {
    open: open('season'),
    seasonId: s.season.id, endsAt: jstMonthEndMs(s.season.id),
    classId: cls.id, nextClassId: next?.id ?? null, points, races, line, left, demoteBelow: cls.demoteBelowPoints,
    status,
    pace: { races, pace10, racesToLine, minRaces: PACE_MIN_RACES },
    power: powerLine(m, s, cls, next),
    ladder: classes.map((c, i) => ({ classId: c.id, statCap: c.statCap, promotePoints: c.promotePoints, demoteBelowPoints: c.demoteBelowPoints, current: i === idx, reached: i <= idx, rewards: rewardBands(m, c.id) })),
    missions: seasonItems,
    pass: { level: passLevel, maxLevel: m.progression.passMaxLevel, freeClaimable: passFreeClaimable },
    promotion: extras.promotion ?? null,
  };

  const claimable = today.claimable + (path?.current.claimable ? 1 : 0) + seasonItems.filter((x) => x.claimable).length;
  return { day, now, today, path, week, week2, season, partner: partnerGrowth(m, s, now, open('training')), claimable };
}
export type GoalLadderView = ReturnType<typeof goalLadderView>;

/**
 * REQ-GOAL-009: POST /v1/home/goals/claim — every claimable rung in one transaction: the daily missions, the beginner steps
 * (in order, as many as are reached) and the season missions. Each goes through its own existing claim function, so the
 * rewards, ledger notes and rules are exactly those of POST /v1/missions/:id/claim. NOT_ELIGIBLE when nothing is claimable.
 */
export function claimAllGoals(m: Master, s: PlayerState, now: number) {
  const claimed: { id: string; table: 'daily' | 'beginner' | 'season'; reward: Reward }[] = [];
  const missionsOpen = unlocksView(m, s, now).features.find((f) => f.key === 'missions')?.unlocked ?? false;
  if (missionsOpen) for (const d of missionsView(m, s, now)) if (!d.claimed && d.progress >= d.target) claimed.push({ id: d.id, table: 'daily', reward: claimMission(m, s, d.id, now) });
  for (let guard = 0; guard < 100; guard++) {
    const step = beginnerMissionsView(m, s, now).steps.find((x) => !x.claimed);
    if (!step || !step.claimable) break;
    claimed.push({ id: step.id, table: 'beginner', reward: claimBeginnerMission(m, s, step.id, now) });
  }
  for (const x of seasonMissionsView(m, s).missions) if (x.claimable) claimed.push({ id: x.id, table: 'season', reward: claimSeasonMission(m, s, x.id, now) });
  if (!claimed.length) throw new AppError('NOT_ELIGIBLE', 'nothing to claim');
  const sum = claimed.reduce<Reward>((a, c) => sumReward(a, c.reward), {});
  return { claimed, total: sum };
}
