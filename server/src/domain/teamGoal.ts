/**
 * 支部の共同目標（REQ-TGOAL-*, contracts/protocol.md §32）: one shared weekly goal per team.
 *
 * - The game week starts Monday at the game-day rollover (04:00 JST, progression.dayRollover) and lasts 7 game days.
 * - When a team's week opens, its goal is picked deterministically from `progression.teamGoal.goals` by a hash of
 *   (team id, week) and its milestone targets are `perMember × scale`, where scale = the members who contributed
 *   last week (or the member count for a team's first week), clamped to `scale.min..scale.max`. Targets are fixed
 *   for the week.
 * - Contributions come only from server-confirmed events: a settled race result (applyRace, counted modes, not void)
 *   and a verified time attack season best (taRecord). The PLAYER object decides what an event is worth (1 race,
 *   1 win, 1 TA personal best), caps it per game day account-wide (so switching teams cannot reset the cap) and sends
 *   it; the TEAM object counts it only for a current member who had joined before the event, once per ref, within
 *   the same per-member daily cap (defence in depth), and only into the week the event happened in.
 * - Leaving resets the member's own contribution (it stays in the team's progress, frozen, but the member is not
 *   eligible for that week any more); a rejoin starts from 0. A deleted or quarantined player's contribution is
 *   removed entirely (progress drops; a milestone already announced is not announced again).
 * - At week close the reached tier (milestones ≤ progress) is fixed and every member still in the team whose own
 *   contribution ≥ `minContribution` gets the tier's fixed reward (free, non-random, ≤ ¥200 per grant, checked by
 *   teamGoalProblems). The payout runs in batches from the team object's alarm (resumable); the player's object
 *   records the paid week, so a retry or a second team can never pay the same week twice.
 */
import { z } from 'zod';
import type { Master, Reward } from './master.js';
import type { TeamState } from './teams.js';
import { memberOf } from './teams.js';
import type { PlayerState } from './player.js';
import { moderationOf } from './player.js';
import { deletionScheduled } from './accountDeletion.js';
import { grantReward } from './items.js';
import { inviteRewardYen } from './invite.js';
import { addJstDays, dayRule, gameDayKey, gameDayStartMs, type DayRule } from './time.js';

export const GOAL_KINDS = ['races', 'wins', 'ta_pb'] as const;
export type GoalKind = typeof GOAL_KINDS[number];

export interface TeamGoalDef {
  id: string; kind: GoalKind;
  /** Shown text; `{n}` = the last milestone's target (「支部で合計{n}レース」). */
  label: string;
  /** Milestone targets per scaled member (ascending; one per tier). */
  perMember: number[];
  /** A member's own contribution needed for the week's reward. */
  minContribution: number;
}
export interface TeamGoalConfig {
  goals: TeamGoalDef[];
  /** One reward per milestone (the highest reached tier's reward is paid, once). */
  tiers: { reward: Reward }[];
  /** Units one member can add per game day, per kind (applied account-wide on the player and per member on the team). */
  dailyCap: Record<GoalKind, number>;
  scale: { min: number; max: number };
  /** Race modes whose settled results count (never friend / tutorial rooms: no self-made farming rooms). */
  modes: string[];
  /** Top contributors shown in the view and the week result. */
  topN: number;
  /** Members paid per alarm step. */
  payBatch: number;
}

/** Ceilings no master or remote config can exceed. ¥200 = the 総付景品 floor applied to every single grant. */
export const TEAM_GOAL_HARD_LIMITS = { maxRewardYen: 200, maxTiers: 5, maxDailyCap: 30, maxGoals: 20, maxPerMember: 200 } as const;

const REF_KEEP = 2000;
const CLOSES_KEEP = 4;
const PENDING_KEEP = 20;
const PENDING_MAX_AGE_MS = 8 * 86_400_000;
const REWARDED_KEEP = 12;

const int = z.number().int();
const rewardSchema = z.object({
  freeCoins: int.min(0).max(1000).optional(),
  items: z.array(z.object({ itemId: z.string().regex(/^[a-z0-9_]{1,40}$/), qty: int.min(1).max(10) }).strict()).max(3).optional(),
}).strict();
const goalSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]{1,32}$/), kind: z.enum(GOAL_KINDS), label: z.string().min(1).max(40),
  perMember: z.array(int.min(1).max(TEAM_GOAL_HARD_LIMITS.maxPerMember)).min(1).max(TEAM_GOAL_HARD_LIMITS.maxTiers),
  minContribution: int.min(1).max(100),
}).strict();
export const teamGoalSchema = z.object({
  _comment: z.string().optional(),
  goals: z.array(goalSchema).min(1).max(TEAM_GOAL_HARD_LIMITS.maxGoals),
  tiers: z.array(z.object({ reward: rewardSchema }).strict()).min(1).max(TEAM_GOAL_HARD_LIMITS.maxTiers),
  dailyCap: z.object({ races: int.min(1).max(TEAM_GOAL_HARD_LIMITS.maxDailyCap), wins: int.min(1).max(TEAM_GOAL_HARD_LIMITS.maxDailyCap), ta_pb: int.min(1).max(TEAM_GOAL_HARD_LIMITS.maxDailyCap) }).strict(),
  scale: z.object({ min: int.min(1).max(50), max: int.min(1).max(50) }).strict(),
  modes: z.array(z.enum(['ranked', 'event', 'tournament'])).min(1),
  topN: int.min(1).max(20),
  payBatch: int.min(1).max(200),
}).strict();

export const teamGoalConfig = (m: Pick<Master, 'progression'>): TeamGoalConfig | null => m.progression.teamGoal ?? null;

/** REQ-TGOAL-010: boot and remote config — shape, tiers match the milestones, the legal value ceiling of every reward. */
export function teamGoalProblems(m: Pick<Master, 'progression' | 'products' | 'items' | 'gacha'>, path = 'progression.teamGoal'): string[] {
  const c = m.progression.teamGoal;
  if (c === undefined) return [];
  const r = teamGoalSchema.safeParse(c);
  if (!r.success) return r.error.issues.map((i) => `${path}.${i.path.join('.')}: ${i.message}`);
  const out: string[] = [];
  if (c.scale.min > c.scale.max) out.push(`${path}.scale: min must not exceed max`);
  if (c.scale.max > m.progression.teams.maxMembers) out.push(`${path}.scale.max: above teams.maxMembers`);
  const ids = new Set<string>();
  for (const [i, g] of c.goals.entries()) {
    if (ids.has(g.id)) out.push(`${path}.goals[${i}]: duplicate id ${g.id}`);
    ids.add(g.id);
    if (g.perMember.length !== c.tiers.length) out.push(`${path}.goals[${i}]: perMember needs one target per tier (${c.tiers.length})`);
    if (g.perMember.some((x, j) => j > 0 && x <= g.perMember[j - 1]!)) out.push(`${path}.goals[${i}]: perMember must be strictly ascending`);
    if (!g.label.includes('{n}')) out.push(`${path}.goals[${i}]: label must contain {n}`);
    // a member who plays the daily cap every day can always reach the minimum
    if (g.minContribution > c.dailyCap[g.kind] * 7) out.push(`${path}.goals[${i}]: minContribution is above 7 days at the daily cap`);
  }
  let prev = -1;
  for (const [i, t] of c.tiers.entries()) {
    const yen = inviteRewardYen(m, { freeCoins: t.reward.freeCoins, items: (t.reward.items ?? []).filter((x) => x.itemId !== 'breeding_material') });
    if (yen === null) out.push(`${path}.tiers[${i}]: only free coins, single/10-pull tickets and breeding material can be team goal rewards`);
    else if (yen > TEAM_GOAL_HARD_LIMITS.maxRewardYen) out.push(`${path}.tiers[${i}]: worth ¥${yen}, above the ¥${TEAM_GOAL_HARD_LIMITS.maxRewardYen} premium ceiling (景品表示法 総付景品)`);
    if ((t.reward.items ?? []).some((x) => x.itemId === 'breeding_material' && x.qty > 3)) out.push(`${path}.tiers[${i}]: at most 3 breeding material`);
    const v = (t.reward.freeCoins ?? 0);
    if (v < prev) out.push(`${path}.tiers[${i}]: a higher tier must not pay fewer coins`);
    prev = v;
  }
  return out;
}

// ------------------------------------------------------------------------------------- the game week

/** REQ-TGOAL-001: the game week (Monday's game-day key) that contains `ms`. */
export function weekKeyOf(ms: number, rule: DayRule): string {
  const day = gameDayKey(ms, rule);
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addJstDays(day, -((dow + 6) % 7));
}
export const weekStartMs = (week: string, rule: DayRule) => gameDayStartMs(week, rule);
export const weekEndMs = (week: string, rule: DayRule) => gameDayStartMs(addJstDays(week, 7), rule);

/** FNV-1a 32-bit (deterministic goal choice). */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** REQ-TGOAL-002: the week's goal for a team (same team + week → same goal on every object and replica). */
export const goalFor = (cfg: TeamGoalConfig, teamId: string, week: string): TeamGoalDef => cfg.goals[fnv(`${teamId}:${week}`) % cfg.goals.length]!;

export const goalLabel = (g: Pick<TeamGoalDef, 'label'>, targets: number[]) => g.label.replace('{n}', String(targets[targets.length - 1] ?? 0));

// ------------------------------------------------------------------------------------- team side

export interface GoalStint { displayName: string; since: number; n: number; day: string; dayN: number; lastAt: number }
export interface GoalWeek {
  week: string; goalId: string; kind: GoalKind; label: string; scale: number; targets: number[]; minContribution: number;
  /** The scale came from the member count (no previous week): it rises as members join this week (never falls). */
  byMembers?: boolean;
  /** Current members' contributions this week (one stint = one membership period). */
  members: Record<string, GoalStint>;
  /** Contributions of members who left this week (frozen; they stay in the team's progress). */
  departed: Record<string, number>;
  /** Highest tier already announced (feed item + push), so a dip and re-cross never announces twice. */
  announced: number;
  /** Refs already counted (dedupe of retried contributions). */
  refs: string[];
}
export interface GoalTop { playerId: string; displayName: string; n: number }
export interface GoalClose {
  week: string; goalId: string; kind: GoalKind; label: string; targets: number[]; progress: number; tier: number; scale: number;
  /** Members who contributed anything (the next week's scale). */
  active: number;
  top: GoalTop[];
  /** Fixed at close: members still in the team with at least minContribution (only when tier ≥ 1). */
  eligible: { playerId: string; n: number }[];
  cursor: number; done: boolean;
}
export interface TeamGoalState { v: 1; cur: GoalWeek | null; closes: GoalClose[] }

export const newGoalState = (): TeamGoalState => ({ v: 1, cur: null, closes: [] });

export const progressOf = (w: GoalWeek) => Object.values(w.members).reduce((a, x) => a + x.n, 0) + Object.values(w.departed).reduce((a, x) => a + x, 0);
export const tierOf = (targets: number[], progress: number) => targets.filter((t) => t <= progress).length;

function topOf(w: GoalWeek, team: TeamState | null, n: number): GoalTop[] {
  const names = new Map((team?.members ?? []).map((m) => [m.playerId, m.displayName]));
  return Object.entries(w.members).filter(([, x]) => x.n > 0)
    .map(([playerId, x]) => ({ playerId, displayName: names.get(playerId) ?? x.displayName, n: x.n, lastAt: x.lastAt }))
    .sort((a, b) => b.n - a.n || a.lastAt - b.lastAt || (a.playerId < b.playerId ? -1 : 1))
    .slice(0, n).map(({ lastAt: _l, ...x }) => x);
}

function closeWeek(cfg: TeamGoalConfig, w: GoalWeek, team: TeamState | null): GoalClose {
  const progress = progressOf(w);
  const tier = tierOf(w.targets, progress);
  const current = new Set((team?.members ?? []).map((m) => m.playerId));
  const eligible = tier >= 1
    ? Object.entries(w.members).filter(([pid, x]) => current.has(pid) && x.n >= w.minContribution).map(([playerId, x]) => ({ playerId, n: x.n })).sort((a, b) => (a.playerId < b.playerId ? -1 : 1))
    : [];
  const active = new Set([...Object.entries(w.members).filter(([, x]) => x.n > 0).map(([p]) => p), ...Object.entries(w.departed).filter(([, x]) => x > 0).map(([p]) => p)]).size;
  return { week: w.week, goalId: w.goalId, kind: w.kind, label: w.label, targets: w.targets, progress, tier, scale: w.scale, active, top: topOf(w, team, cfg.topN), eligible, cursor: 0, done: eligible.length === 0 };
}

function openWeek(cfg: TeamGoalConfig, gs: TeamGoalState, team: TeamState, week: string, rule: DayRule): GoalWeek {
  const g = goalFor(cfg, team.id, week);
  const last = gs.closes[gs.closes.length - 1];
  const prevWeek = addJstDays(week, -7);
  const fromLast = !!last && last.week === prevWeek && last.active > 0;
  const basis = fromLast ? last!.active : team.members.length;
  const scale = Math.max(cfg.scale.min, Math.min(cfg.scale.max, basis));
  const targets = g.perMember.map((x) => x * scale);
  void rule;
  return { week, goalId: g.id, kind: g.kind, label: goalLabel(g, targets), scale, targets, minContribution: g.minContribution, ...(fromLast ? {} : { byMembers: true }), members: {}, departed: {}, announced: 0, refs: [] };
}

/**
 * REQ-TGOAL-002: a week scaled by the member count (a new team, or a team nobody played in last week) follows joins
 * upward, so a team cannot open its week small and then fill up against easy targets. Targets never go down.
 */
export function goalMembersChanged(cfg: TeamGoalConfig, gs: TeamGoalState, team: TeamState) {
  const w = gs.cur;
  if (!w || !w.byMembers) return;
  const scale = Math.max(w.scale, Math.min(cfg.scale.max, team.members.length));
  if (scale === w.scale) return;
  const g = cfg.goals.find((x) => x.id === w.goalId);
  if (!g) return;
  w.scale = scale;
  w.targets = g.perMember.map((x) => x * scale);
  w.label = goalLabel(g, w.targets);
}

/**
 * REQ-TGOAL-001/007: brings the team's goal up to the week of `now`: closes the running week when it is over (its
 * payout list is fixed here) and opens the current one. Called before every goal operation and every membership
 * change, so a week is always closed with the members it ended with. Returns the week closed now, if any.
 */
export function goalRoll(cfg: TeamGoalConfig, rule: DayRule, gs: TeamGoalState, team: TeamState | null, now: number): GoalClose | null {
  const week = weekKeyOf(now, rule);
  let closed: GoalClose | null = null;
  if (gs.cur && gs.cur.week < week) {
    closed = closeWeek(cfg, gs.cur, team);
    gs.closes.push(closed);
    // keep unpaid closes; drop the oldest paid ones beyond the keep count
    while (gs.closes.length > CLOSES_KEEP && gs.closes[0]!.done) gs.closes.shift();
    gs.cur = null;
  }
  if (!gs.cur && team && !team.disbanded && team.members.length > 0) gs.cur = openWeek(cfg, gs, team, week, rule);
  return closed;
}

/** What a player's object sends for one confirmed event (REQ-TGOAL-003). */
export interface GoalContribution {
  teamId: string; playerId: string; displayName: string;
  /** `race:<raceId>` or `ta:<sessionId>`: counted once. */
  ref: string;
  /** When the event was settled (server time of the player's object). */
  at: number;
  races: number; wins: number; taPb: number;
}
export interface GoalCounted { counted: number; milestone: number | null; progress: number; tier: number; reason?: 'no_goal' | 'week' | 'not_member' | 'duplicate' | 'capped' | 'kind' }

const unitsFor = (kind: GoalKind, c: GoalContribution) => Math.max(0, Math.min(1, Math.trunc(kind === 'races' ? c.races : kind === 'wins' ? c.wins : c.taPb)));

/**
 * REQ-TGOAL-003/004: counts one contribution into the current week (members only, from their join on, once per ref,
 * per-member daily cap). A newly reached tier is returned once as `milestone` (feed item + push by the caller).
 */
export function goalContribute(cfg: TeamGoalConfig, rule: DayRule, gs: TeamGoalState, team: TeamState | null, c: GoalContribution, now: number): GoalCounted {
  goalRoll(cfg, rule, gs, team, now);
  const w = gs.cur;
  const none = (reason: GoalCounted['reason']): GoalCounted => ({ counted: 0, milestone: null, progress: w ? progressOf(w) : 0, tier: w ? tierOf(w.targets, progressOf(w)) : 0, reason });
  if (!w || !team || team.disbanded) return none('no_goal');
  const at = Math.min(c.at, now);
  if (weekKeyOf(at, rule) !== w.week) return none('week'); // a late retry of an older week never lands in this one
  const mm = memberOf(team, c.playerId);
  if (!mm || mm.joinedAt > at) return none('not_member');
  if (w.refs.includes(c.ref)) return none('duplicate');
  w.refs.push(c.ref);
  if (w.refs.length > REF_KEEP) w.refs.splice(0, w.refs.length - REF_KEEP);
  const units = unitsFor(w.kind, c);
  if (units === 0) return none('kind');
  let st = w.members[c.playerId];
  if (st && st.since !== mm.joinedAt) { // a stint from before a leave that was not recorded: freeze it
    w.departed[c.playerId] = (w.departed[c.playerId] ?? 0) + st.n;
    st = undefined;
  }
  st ??= (w.members[c.playerId] = { displayName: mm.displayName, since: mm.joinedAt, n: 0, day: '', dayN: 0, lastAt: 0 });
  const day = gameDayKey(at, rule);
  if (st.day !== day) { st.day = day; st.dayN = 0; }
  const add = Math.min(units, cfg.dailyCap[w.kind] - st.dayN);
  if (add <= 0) return none('capped');
  st.n += add; st.dayN += add; st.lastAt = at; st.displayName = mm.displayName;
  const progress = progressOf(w);
  const tier = tierOf(w.targets, progress);
  let milestone: number | null = null;
  if (tier > w.announced) { w.announced = tier; milestone = tier; }
  return { counted: add, milestone, progress, tier };
}

/** REQ-TGOAL-005: a member left (leave, kick, disband): their contribution is frozen into the team's progress. */
export function goalMemberLeft(gs: TeamGoalState, playerId: string) {
  const w = gs.cur;
  const st = w?.members[playerId];
  if (!w || !st) return;
  w.departed[playerId] = (w.departed[playerId] ?? 0) + st.n;
  delete w.members[playerId];
}

/** REQ-TGOAL-006: a deleted or quarantined player's contribution is removed (current week and unpaid closes). */
export function goalForget(gs: TeamGoalState, playerId: string) {
  let removed = 0;
  if (gs.cur) {
    removed += (gs.cur.members[playerId]?.n ?? 0) + (gs.cur.departed[playerId] ?? 0);
    delete gs.cur.members[playerId];
    delete gs.cur.departed[playerId];
  }
  for (const c of gs.closes) {
    c.top = c.top.filter((x) => x.playerId !== playerId);
    const at = c.eligible.findIndex((x) => x.playerId === playerId);
    if (at >= c.cursor) c.eligible.splice(at, 1); // not paid yet: never paid
    if (c.cursor >= c.eligible.length) c.done = true;
  }
  return { removed };
}

/** Next unpaid batch of a closed week (REQ-TGOAL-007). */
export const goalUnpaid = (gs: TeamGoalState) => gs.closes.find((c) => !c.done) ?? null;

/**
 * REQ-TGOAL-007: one resumable payout step: pays up to `batch` eligible members of the oldest unpaid close. `pay`
 * must be idempotent per (player, week) — the player's object records the paid week. `persist` runs after each pay.
 */
export async function goalPayStep(gs: TeamGoalState, teamId: string, batch: number, pay: (playerId: string, c: GoalClose) => Promise<void>, persist: () => Promise<void>) {
  const c = goalUnpaid(gs);
  if (!c) return { done: true, paid: 0, week: null as string | null };
  const end = Math.min(c.eligible.length, c.cursor + batch);
  let paid = 0;
  while (c.cursor < end) {
    await pay(c.eligible[c.cursor]!.playerId, c);
    c.cursor++; paid++;
    await persist();
  }
  if (c.cursor >= c.eligible.length) c.done = true;
  await persist();
  void teamId;
  return { done: goalUnpaid(gs) === null, paid, week: c.week };
}

export const tierReward = (cfg: TeamGoalConfig, tier: number): Reward | null => (tier >= 1 ? cfg.tiers[Math.min(tier, cfg.tiers.length) - 1]?.reward ?? null : null);

/** REQ-TGOAL-008: the team's goal for one member (GET /v1/teams/me/goal, team side). */
export function goalTeamView(cfg: TeamGoalConfig, rule: DayRule, gs: TeamGoalState, team: TeamState, viewer: string, now: number) {
  goalRoll(cfg, rule, gs, team, now);
  const w = gs.cur;
  const last = [...gs.closes].reverse()[0] ?? null;
  const mine = w?.members[viewer];
  const day = gameDayKey(now, rule);
  const week = w ? (() => {
    const progress = progressOf(w);
    const tier = tierOf(w.targets, progress);
    return {
      week: w.week, endsAt: weekEndMs(w.week, rule), goalId: w.goalId, kind: w.kind, label: w.label, scale: w.scale, progress, tier, minContribution: w.minContribution,
      milestones: w.targets.map((target, i) => ({ tier: i + 1, target, reached: progress >= target, reward: cfg.tiers[i]?.reward ?? null })),
      my: { contribution: mine?.n ?? 0, today: mine && mine.day === day ? mine.dayN : 0, dailyCap: cfg.dailyCap[w.kind], qualified: (mine?.n ?? 0) >= w.minContribution },
      top: topOf(w, team, cfg.topN),
      contributors: Object.values(w.members).filter((x) => x.n > 0).length,
    };
  })() : null;
  const lastWeek = last ? {
    week: last.week, goalId: last.goalId, kind: last.kind, label: last.label, targets: last.targets, progress: last.progress, tier: last.tier,
    reward: tierReward(cfg, last.tier), top: last.top, ...(() => { const i = last.eligible.findIndex((x) => x.playerId === viewer); return { eligible: i >= 0, paid: i >= 0 && i < last.cursor }; })(),
  } : null;
  return { current: week, lastWeek };
}

// ------------------------------------------------------------------------------------- player side

type Units = { races: number; wins: number; taPb: number };
export interface PlayerGoalState {
  /** Today's units sent (account-wide daily cap, REQ-TGOAL-004). */
  day: string; sent: Units;
  /** This week's units sent for the current team (informational; the team's tally is the authority). */
  week: string; weekTeam: string | null; weekSent: Units;
  /** Contributions whose delivery to the team failed (re-sent with the next one; the team dedupes by ref). */
  pending: GoalContribution[];
  /** Weeks whose reward was paid (or forfeited): one per week, whatever the team (REQ-TGOAL-009). */
  rewarded: string[];
  /** The last paid week (week result sheet). */
  last: { week: string; teamId: string; tier: number; contribution: number; reward: Reward | null } | null;
}

const zero = (): Units => ({ races: 0, wins: 0, taPb: 0 });
export function ensureGoal(s: PlayerState): PlayerGoalState {
  const x = s as PlayerState & { teamGoal?: PlayerGoalState };
  x.teamGoal ??= { day: '', sent: zero(), week: '', weekTeam: null, weekSent: zero(), pending: [], rewarded: [], last: null };
  return x.teamGoal;
}

/** Contributions are only sent for a member in good standing (REQ-TGOAL-006). */
const mayContribute = (s: PlayerState, now: number) => !deletionScheduled(s) && moderationOf(s, now) === 'ok';

function capped(m: Master, s: PlayerState, now: number, want: Units): Units | null {
  const cfg = teamGoalConfig(m);
  const teamId = s.team?.teamId ?? null;
  if (!cfg || !teamId || !mayContribute(s, now)) return null;
  const rule = dayRule(m);
  const g = ensureGoal(s);
  const day = gameDayKey(now, rule);
  if (g.day !== day) { g.day = day; g.sent = zero(); }
  const week = weekKeyOf(now, rule);
  if (g.week !== week || g.weekTeam !== teamId) { g.week = week; g.weekTeam = teamId; g.weekSent = zero(); }
  const out: Units = {
    races: want.races > 0 && g.sent.races < cfg.dailyCap.races ? 1 : 0,
    wins: want.wins > 0 && g.sent.wins < cfg.dailyCap.wins ? 1 : 0,
    taPb: want.taPb > 0 && g.sent.taPb < cfg.dailyCap.ta_pb ? 1 : 0,
  };
  if (out.races + out.wins + out.taPb === 0) return null;
  for (const k of ['races', 'wins', 'taPb'] as const) { g.sent[k] += out[k]; g.weekSent[k] += out[k]; }
  return out;
}

/** REQ-TGOAL-003: a settled race (counted mode, not void) → a contribution for the player's team, or null. */
export function playerGoalRace(m: Master, s: PlayerState, r: { raceId: string; mode: string; place: number; void: boolean }, now: number): GoalContribution | null {
  const cfg = teamGoalConfig(m);
  if (!cfg || r.void || !cfg.modes.includes(r.mode)) return null;
  const u = capped(m, s, now, { races: 1, wins: r.place === 1 ? 1 : 0, taPb: 0 });
  if (!u) return null;
  return { teamId: s.team!.teamId!, playerId: s.id, displayName: s.profile.displayName, ref: `race:${r.raceId}`, at: now, ...u };
}

/** REQ-TGOAL-003: a verified time attack that set a season best on its course → a contribution, or null. */
export function playerGoalTa(m: Master, s: PlayerState, sessionId: string, now: number): GoalContribution | null {
  const u = capped(m, s, now, { races: 0, wins: 0, taPb: 1 });
  if (!u) return null;
  return { teamId: s.team!.teamId!, playerId: s.id, displayName: s.profile.displayName, ref: `ta:${sessionId}`, at: now, ...u };
}

/** Keeps undelivered contributions (bounded, recent only). */
export function playerGoalPending(s: PlayerState, keep: GoalContribution[], now: number) {
  const g = ensureGoal(s);
  const byRef = new Map<string, GoalContribution>();
  for (const c of keep) if (now - c.at < PENDING_MAX_AGE_MS) byRef.set(c.ref, c);
  g.pending = [...byRef.values()].slice(-PENDING_KEEP);
}

/**
 * REQ-TGOAL-007/009: pays a closed week's tier reward to an eligible member, once per week whatever the team. A member
 * scheduled for deletion or not in good standing forfeits it (recorded, so a retry does not pay later either).
 */
export function playerGoalReward(m: Master, s: PlayerState, week: string, teamId: string, tier: number, contribution: number, now: number) {
  const cfg = teamGoalConfig(m);
  const g = ensureGoal(s);
  if (g.rewarded.includes(week)) return { status: 'already' as const, reward: null };
  const mark = () => { g.rewarded.push(week); if (g.rewarded.length > REWARDED_KEEP) g.rewarded.splice(0, g.rewarded.length - REWARDED_KEEP); };
  if (!cfg) return { status: 'disabled' as const, reward: null };
  if (!mayContribute(s, now)) { mark(); return { status: 'forfeited' as const, reward: null }; }
  const reward = tierReward(cfg, tier);
  mark();
  if (!reward) return { status: 'none' as const, reward: null };
  grantReward(s, reward, now, `team goal ${teamId} week ${week} tier ${tier}`, `team_goal:${week}`);
  g.last = { week, teamId, tier, contribution, reward };
  return { status: 'rewarded' as const, reward };
}

/** The player's side of the goal view: today's units sent (account-wide cap) and the last paid week. */
export function playerGoalView(m: Master, s: PlayerState, now: number) {
  const cfg = teamGoalConfig(m);
  const g = ensureGoal(s);
  const today = g.day === gameDayKey(now, dayRule(m)) ? g.sent : zero();
  return { enabled: !!cfg, sentToday: { races: today.races, wins: today.wins, ta_pb: today.taPb }, pending: g.pending.length, lastReward: g.last };
}
