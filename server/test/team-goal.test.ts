import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { MemoryTeams, TeamsService } from '../src/domain/teamService.js';
import { teamPlayersFrom, type PlayerInvoker } from '../src/http/app.js';
import { goalFor, teamGoalProblems, weekEndMs, weekKeyOf, type GoalContribution, type TeamGoalConfig } from '../src/domain/teamGoal.js';
import { dayRule } from '../src/domain/time.js';
import { compileCatalog, localize } from '../src/i18n/catalog.js';
import { CODE_EN } from '../src/i18n/en.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import type { PlayerState } from '../src/domain/player.js';
import type { Master } from '../src/domain/master.js';
import type { VerifierOutput } from '../src/domain/schemas.js';
import { TimeAttackService } from '../src/race/timeAttack.js';

/** Tuesday 2026-12-08 12:00 JST (after the 04:00 rollover switch): game week 2026-12-07. */
const T0 = Date.UTC(2026, 11, 8, 3);
const DAY = 86_400_000;
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as AppError).code; } };
const base = m.progression.teamGoal!;
/** A master whose only goal is the given one (the hash pick is then fixed). */
const only = (id: string, patch: Partial<TeamGoalConfig> = {}): Master => ({ ...m, progression: { ...m.progression, teamGoal: { ...base, goals: base.goals.filter((g) => g.id === id), ...patch } } });

function world(master: Master = only('races_sum')) {
  let t = T0;
  const clock = () => t;
  const repo = new MemoryPlayerRepo();
  const teams = new MemoryTeams(() => master, clock);
  const kpi: { id: string; r: KpiRecord }[] = [];
  let failGoal = 0;
  const pushes: { to: string; n: string }[] = [];
  let svc!: PlayerService;
  svc = new PlayerService(repo, {
    master, rng: seededRng(5), clock, verifiers: {},
    onTeamFeed: async (p) => { await teams.feedRace(p.teamId, p.playerId, p.race); },
    onTeamGoal: async (c: GoalContribution) => {
      if (failGoal > 0) { failGoal--; throw new Error('team object unreachable'); }
      const r = await teams.goalContribute(c.teamId, c);
      // what TeamDO does for a milestone: a push to the other members (daily cap applies there)
      if (r.milestone !== null) for (const to of r.notify) { pushes.push({ to, n: String(r.milestone) }); await svc.queuePush(to, 'team_goal', { n: String(r.milestone) }); }
      return r;
    },
    onTeamGoalForget: async (p) => teams.goalForget(p.teamId, p.playerId),
    onKpi: (id, recs) => { for (const r of recs) kpi.push({ id, r }); },
  });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const ts = new TeamsService(() => master, teams, teamPlayersFrom(() => invoker), teams, teams, seededRng(9), clock);
  const state = (u: string) => repo.get(u) as PlayerState;
  let race = 0;
  const raceResult = (u: string, place = 5, mode: 'ranked' | 'tournament' | 'friend' | 'event' = 'ranked', isVoid = false) =>
    svc.applyRace(u, { raceId: `r${race++}`, mode, place, fieldSize: 12, newRating: null, void: isVoid, humans: 2, details: { trackId: 'kirameki_turf_2000', style: 'sashi', finishTick: 2400, startReactionTicks: 3, whips: 3, whipMashed: false, cpuAssisted: false } } as never);
  const races = async (u: string, n: number, place = 5) => { for (let i = 0; i < n; i++) { t += 60_000; await raceResult(u, place); } };
  /** The TeamDO alarm: close the finished week and pay (through the real player method). */
  const alarm = (teamId: string) => teams.goalAlarm(teamId, async (pid, c) => { await svc.teamGoalReward(pid, c.week, teamId, c.tier, c.eligible.find((x) => x.playerId === pid)?.n ?? 0); });
  return {
    svc, repo, teams, ts, kpi, state, raceResult, races, alarm, pushes, master,
    failNext: (n = 1) => { failGoal = n; }, advance: (ms: number) => { t += ms; }, set: (ms: number) => { t = ms; }, now: clock,
  };
}
type W = ReturnType<typeof world>;

async function team(w: W, ...ids: string[]) {
  for (const id of ['lead', ...ids]) await w.svc.bootstrap(id);
  const v = await w.ts.create('lead', 'あおばRC', 'open', '');
  for (const id of ids) await w.ts.join(id, v.teamId);
  return v.teamId;
}

describe('REQ-TGOAL-010 master data', () => {
  it('the shipped config is valid; every reward is free, fixed and under ¥200', () => {
    expect(teamGoalProblems(m)).toEqual([]);
    const tooRich = only('races_sum', { tiers: [{ reward: { freeCoins: 5 } }, { reward: { freeCoins: 10 } }, { reward: { freeCoins: 200 } }] });
    expect(teamGoalProblems(tooRich).join(';')).toMatch(/above the ¥200 premium ceiling/);
    const horse = only('races_sum', { tiers: [{ reward: { freeCoins: 5 } }, { reward: { freeCoins: 10 } }, { reward: { horse: 'x' } as never }] });
    expect(teamGoalProblems(horse).length).toBeGreaterThan(0);
    const mismatch = only('races_sum', { tiers: [{ reward: { freeCoins: 5 } }, { reward: { freeCoins: 10 } }] });
    expect(teamGoalProblems(mismatch).join(';')).toMatch(/one target per tier/);
    const sr = only('races_sum', { tiers: [{ reward: { freeCoins: 5 } }, { reward: { freeCoins: 10 } }, { reward: { items: [{ itemId: 'ticket_sr_plus', qty: 1 }] } }] });
    expect(teamGoalProblems(sr).join(';')).toMatch(/only free coins/);
  });
});

describe('REQ-TGOAL-001/002 the game week and the goal', () => {
  it('weeks start Monday at the 04:00 JST rollover', () => {
    const rule = dayRule(m);
    expect(weekKeyOf(T0, rule)).toBe('2026-12-07');
    const end = weekEndMs('2026-12-07', rule);
    expect(end).toBe(Date.UTC(2026, 11, 13, 19)); // Mon 2026-12-14 04:00 JST
    expect(weekKeyOf(end - 1, rule)).toBe('2026-12-07'); // Monday 03:59 still belongs to the old week
    expect(weekKeyOf(end, rule)).toBe('2026-12-14');
  });

  it('the goal is picked deterministically from the table and scaled by the active members', async () => {
    const w = world(m);
    const teamId = await team(w, 'a', 'b', 'c');
    const v = await w.ts.goal('a');
    const g = goalFor(base, teamId, '2026-12-07');
    expect(v.current).toMatchObject({ week: '2026-12-07', goalId: g.id, kind: g.kind, scale: 4, endsAt: Date.UTC(2026, 11, 13, 19) });
    expect(v.current!.milestones.map((x) => x.target)).toEqual(g.perMember.map((x) => x * 4));
    expect(v.current!.label).toBe(g.label.replace('{n}', String(g.perMember[g.perMember.length - 1]! * 4)));
    expect(v.teamName).toBe('あおばRC');
    // the same team and week give the same goal on any object
    expect(goalFor(base, teamId, '2026-12-07').id).toBe(g.id);
  });

  it('next week scales to last week\'s contributors (at least scale.min)', async () => {
    const w = world();
    const teamId = await team(w, 'a', 'b', 'c', 'd', 'e');
    expect((await w.ts.goal('a')).current!.scale).toBe(6);
    await w.races('a', 3);
    w.set(weekEndMs('2026-12-07', dayRule(m)) + 1000);
    await w.alarm(teamId);
    const v = await w.ts.goal('a');
    expect(v.current!.week).toBe('2026-12-14');
    expect(v.current!.scale).toBe(3); // 1 contributor → the minimum
    expect(v.current!.milestones.map((x) => x.target)).toEqual([18, 36, 60]);
  });
});

describe('REQ-TGOAL-003/004 contributions', () => {
  it('only settled results of counted modes count; friend rooms and void races never do', async () => {
    const w = world();
    await team(w, 'a');
    await w.raceResult('a', 5, 'ranked');
    await w.raceResult('a', 5, 'event');
    await w.raceResult('a', 5, 'tournament');
    await w.raceResult('a', 5, 'friend');
    await w.raceResult('a', 5, 'ranked', true);
    const v = await w.ts.goal('a');
    expect(v.current!.my.contribution).toBe(3);
    expect(v.current!.progress).toBe(3);
    expect(w.kpi.filter((k) => k.r.name === 'team_goal_contribute')).toHaveLength(3);
  });

  it('a retried race result (same race id) counts once', async () => {
    const w = world();
    await team(w, 'a');
    const r = { raceId: 'dup1', mode: 'ranked', place: 2, fieldSize: 12, newRating: null, void: false, humans: 2 } as never;
    await w.svc.applyRace('a', r);
    await w.svc.applyRace('a', r);
    expect((await w.ts.goal('a')).current!.progress).toBe(1);
  });

  it('per-member daily cap: one member cannot carry the team; the next game day resumes', async () => {
    const w = world();
    await team(w, 'a');
    await w.races('a', 14);
    let v = await w.ts.goal('a');
    expect(v.current!.my).toMatchObject({ contribution: 10, today: 10, dailyCap: 10 });
    w.advance(DAY);
    await w.races('a', 2);
    v = await w.ts.goal('a');
    expect(v.current!.my).toMatchObject({ contribution: 12, today: 2 });
  });

  it('a delivery failure is kept on the player and re-sent with the next result (the team dedupes)', async () => {
    const w = world();
    await team(w, 'a');
    w.failNext(1);
    await w.races('a', 1);
    expect(w.state('a') && (w.state('a') as PlayerState & { teamGoal: { pending: unknown[] } }).teamGoal.pending).toHaveLength(1);
    expect((await w.ts.goal('a')).current!.progress).toBe(0);
    await w.races('a', 1);
    expect((w.state('a') as PlayerState & { teamGoal: { pending: unknown[] } }).teamGoal.pending).toHaveLength(0);
    expect((await w.ts.goal('a')).current!.progress).toBe(2);
    // undelivered contributions of a player quarantined meanwhile are dropped, never delivered later
    w.failNext(1);
    await w.races('a', 1);
    await w.svc.setModeration('a', 'quarantined', w.now() + DAY, 'test');
    await w.svc.setModeration('a', 'ok', null, 'released');
    await w.races('a', 1);
    expect((w.state('a') as PlayerState & { teamGoal: { pending: unknown[] } }).teamGoal.pending).toHaveLength(0);
    expect((await w.ts.goal('a')).current!.progress).toBe(1); // only the last race (a's earlier 2 were removed by the quarantine)
    // the same contribution delivered twice is counted once
    const c: GoalContribution = { teamId: (await w.ts.me('a')).team!.teamId, playerId: 'a', displayName: 'x', ref: 'race:r0', at: w.now(), races: 1, wins: 0, taPb: 0 };
    const again = await w.teams.goalContribute(c.teamId, c);
    expect(again).toMatchObject({ counted: 0, reason: 'duplicate' });
  });

  it('a late retry from last week never lands in this week; a non-member never counts', async () => {
    const w = world();
    const teamId = await team(w, 'a');
    await w.svc.bootstrap('outsider');
    const at = w.now();
    w.set(weekEndMs('2026-12-07', dayRule(m)) + 5000);
    expect(await w.teams.goalContribute(teamId, { teamId, playerId: 'a', displayName: 'a', ref: 'race:old', at, races: 1, wins: 0, taPb: 0 })).toMatchObject({ counted: 0, reason: 'week' });
    expect(await w.teams.goalContribute(teamId, { teamId, playerId: 'outsider', displayName: 'o', ref: 'race:o1', at: w.now(), races: 1, wins: 0, taPb: 0 })).toMatchObject({ counted: 0, reason: 'not_member' });
  });

  it('a wins goal counts only wins (cap 3 a day); a TA season best counts for a TA goal', async () => {
    const w = world(only('wins_sum'));
    await team(w, 'a');
    await w.races('a', 2, 4);
    await w.races('a', 5, 1);
    const v = await w.ts.goal('a');
    expect(v.current!.kind).toBe('wins');
    expect(v.current!.my.contribution).toBe(3);
    // the player's own record: units sent today (account-wide)
    expect(v.player.sentToday).toEqual({ races: 7, wins: 3, ta_pb: 0 });
  });

  it('a verified time attack season best counts for a TA goal (once per session; a slower run does not)', async () => {
    const w = world(only('ta_pb_sum'));
    await w.svc.bootstrap('lead');
    const teamId = (await w.ts.create('lead', 'あおばRC', 'open', '')).teamId;
    const tut = await w.svc.tutorialDraw('lead', 'c:tut');
    const horseId = tut.results.find((r: { horseId: string | null }) => r.horseId)!.horseId as string;
    let tick = 1850;
    const out = (): VerifierOutput => ({ resultHash: 'a'.repeat(64), order: [0], finishTicks: [tick], finishFracs: [100], checksums: {} });
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (w.svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(w.svc, args)) as PlayerInvoker['invoke'] };
    const ta = new TimeAttackService({
      player: () => invoker, verifier: { verify: async () => out() },
      board: { upsert: async () => true, rankOf: async () => null, entries: async () => [], snapshot: async () => null },
      ghosts: { put: async () => undefined, get: async () => null }, ticketSecret: 'test-secret', clock: w.now,
    } as never);
    const run = async () => {
      const s = await ta.start('lead', 'kirameki_turf_2000', horseId);
      return ta.submit('lead', { sessionId: s.sessionId, token: s.token, inputs: [[60, 0, 1], [1700, 0, 32]], resultHash: 'a'.repeat(64), config: s.config });
    };
    expect((await run()).seasonBest).toBe(true);
    tick = 1900; // slower: not a best
    w.advance(60_000);
    expect((await run()).seasonBest).toBe(false);
    const v = await w.ts.goal('lead');
    expect(v.current).toMatchObject({ kind: 'ta_pb', progress: 1 });
    expect(v.current!.my.contribution).toBe(1);
    void teamId;
  });

  it('joining mid-week counts from the join; leaving resets the member (the team keeps the progress)', async () => {
    const w = world();
    const teamId = await team(w, 'a');
    await w.svc.bootstrap('late');
    await w.races('late', 3); // not a member yet: nothing
    await w.ts.join('late', teamId);
    await w.races('late', 2);
    expect((await w.ts.goal('late')).current!.my.contribution).toBe(2);
    await w.races('a', 4);
    expect((await w.ts.goal('a')).current!.progress).toBe(6);
    await w.ts.kick('lead', 'a');
    let v = await w.ts.goal('late');
    expect(v.current!.progress).toBe(6); // a's 4 stay in the team's progress
    expect(v.current!.top.map((x) => x.playerId)).toEqual(['late']);
    // a rejoins the same week: a new stint from 0 (the account-wide daily cap still applies)
    await w.ts.join('a', teamId);
    await w.races('a', 1);
    v = await w.ts.goal('a');
    expect(v.current!.my.contribution).toBe(1);
    expect(v.current!.progress).toBe(7);
  });

  it('switching teams cannot reset the daily cap or claim the same week twice', async () => {
    const w = world();
    const t1 = await team(w, 'a');
    await w.svc.bootstrap('lead2');
    const t2 = (await w.ts.create('lead2', 'みなとRC', 'open', '')).teamId;
    await w.races('a', 10);
    await w.ts.kick('lead', 'a'); // kicked: no rejoin cooldown
    await w.ts.join('a', t2);
    await w.races('a', 5);
    expect((await w.ts.goal('a')).current!.my.contribution).toBe(0); // today's cap was used in the first team
    w.advance(DAY);
    await w.races('a', 3);
    await w.races('lead2', 10);
    await w.races('lead', 10);
    w.advance(DAY);
    await w.races('lead2', 10);
    await w.races('lead', 10);
    // close: both teams reached tier 1; a is eligible only in the team they ended the week in
    const before = w.state('a').wallet.free;
    w.set(weekEndMs('2026-12-07', dayRule(m)) + 1000);
    expect((await w.alarm(t1)).paid).toBe(1); // lead only
    expect((await w.alarm(t2)).paid).toBe(2); // lead2 and a
    expect(w.state('a').wallet.free - before).toBe(5);
    // even if the first team tried to pay the same week again, the player's object refuses
    const again = await w.svc.teamGoalReward('a', '2026-12-07', t1, 3, 10);
    expect(again!.status).toBe('already');
    expect(w.state('a').wallet.free - before).toBe(5);
  });
});

describe('REQ-TGOAL-008 milestones in the feed, push and KPI', () => {
  it('a reached milestone posts one team feed item, notifies the other members and writes team_goal_milestone', async () => {
    const w = world();
    const teamId = await team(w, 'a', 'b');
    // scale 3 → 18 / 36 / 60
    await w.races('a', 10);
    await w.races('b', 8);
    const feed = await w.ts.feed('lead', null, null);
    const goals = feed.items.filter((x) => x.kind === 'goal');
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({ playerId: '', displayName: '', mine: false, goal: { week: '2026-12-07', goalId: 'races_sum', tier: 1, target: 18, tiers: 3, label: '支部で合計60レース' } });
    expect(w.pushes.map((p) => p.to).sort()).toEqual(['a', 'lead']);
    expect(w.kpi.filter((k) => k.r.name === 'team_goal_milestone').map((k) => [k.id, k.r.value])).toEqual([['b', 1]]);
    // a goal item has no author: it cannot be reported, and muting a member never hides it
    expect(await code(w.ts.report('a', goals[0]!.seq, 'spam'))).toBe('BAD_REQUEST');
    // English: the label translates, the team name and player names stay as typed
    const cat = compileCatalog(CODE_EN, m.locale?.en);
    const en = localize(await w.ts.goal('a'), 'en', cat);
    expect(en.current!.label).toBe('60 races as a branch');
    expect(en.teamName).toBe('あおばRC');
    void teamId;
  });

  it('a milestone is announced once even when progress dips and re-crosses (quarantine removal)', async () => {
    const w = world();
    await team(w, 'a', 'b');
    await w.races('a', 10);
    await w.races('b', 8);
    await w.svc.setModeration('a', 'quarantined', w.now() + DAY, 'test');
    let v = await w.ts.goal('b');
    expect(v.current!.progress).toBe(8); // a's 10 removed
    expect(v.current!.top.map((x) => x.playerId)).toEqual(['b']);
    await w.races('a', 3); // quarantined: not sent
    expect((await w.ts.goal('b')).current!.progress).toBe(8);
    w.advance(DAY);
    await w.races('b', 10);
    v = await w.ts.goal('b');
    expect(v.current!.progress).toBe(18);
    expect((await w.ts.feed('lead', null, null)).items.filter((x) => x.kind === 'goal')).toHaveLength(1);
  });
});

describe('REQ-TGOAL-005/007/009 week close and rewards', () => {
  it('pays the reached tier once to every member with the minimum; idempotent alarm; others get nothing', async () => {
    const w = world();
    const teamId = await team(w, 'a', 'b');
    await w.races('a', 10);
    await w.races('b', 10);
    await w.races('lead', 2); // below the minimum of 3
    w.advance(DAY);
    await w.races('a', 10);
    await w.races('b', 6); // 38 ≥ 36 → tier 2
    const free = (u: string) => w.state(u).wallet.free;
    const mat = (u: string) => w.state(u).items['breeding_material'] ?? 0;
    const before = { a: free('a'), b: free('b'), lead: free('lead'), am: mat('a') };
    // nothing is paid before the week ends
    expect((await w.alarm(teamId)).paid).toBe(0);
    w.set(weekEndMs('2026-12-07', dayRule(m)) + 1000);
    const r = await w.alarm(teamId);
    expect(r).toMatchObject({ done: true, week: '2026-12-07', paid: 2 });
    expect(free('a') - before.a).toBe(10);
    expect(mat('a') - before.am).toBe(1);
    expect(free('b') - before.b).toBe(10);
    expect(free('lead') - before.lead).toBe(0);
    // running the job again pays nothing more; the player method itself is idempotent per week
    expect((await w.alarm(teamId)).paid).toBe(0);
    expect((await w.svc.teamGoalReward('a', '2026-12-07', teamId, 2, 20))!.status).toBe('already');
    expect(free('a') - before.a).toBe(10);
    // the week result for the viewer
    const v = await w.ts.goal('a');
    expect(v.lastWeek).toMatchObject({ week: '2026-12-07', tier: 2, progress: 38, eligible: true, paid: true, reward: { freeCoins: 10 } });
    expect(v.lastWeek!.top.map((x) => x.playerId)).toEqual(['a', 'b', 'lead']);
    expect((await w.ts.goal('lead')).lastWeek).toMatchObject({ eligible: false, paid: false });
    expect(v.player.lastReward).toMatchObject({ week: '2026-12-07', tier: 2, contribution: 20 });
    expect(w.kpi.filter((k) => k.r.name === 'team_goal_reward').map((k) => k.id).sort()).toEqual(['a', 'b']);
    // the paid grant is free coins (never paid coins) and is in the ledger with its week
    expect(w.state('a').wallet.paid).toBe(0);
    expect(w.state('a').ledger.some((x) => x.ref === 'team_goal:2026-12-07')).toBe(true);
  });

  it('a member who left before the week ended is not paid; a week below the first milestone pays nobody', async () => {
    const w = world();
    const teamId = await team(w, 'a', 'b');
    await w.races('a', 10);
    await w.races('b', 9);
    await w.ts.kick('lead', 'b');
    w.set(weekEndMs('2026-12-07', dayRule(m)) + 1000);
    const r = await w.alarm(teamId);
    expect(r.paid).toBe(1); // a only (19 ≥ 18: tier 1)
    expect((await w.ts.goal('a')).lastWeek).toMatchObject({ tier: 1, progress: 19 });
    w.set(weekEndMs('2026-12-14', dayRule(m)) + 1000);
    expect((await w.alarm(teamId)).paid).toBe(0);
    expect((await w.ts.goal('a')).lastWeek).toMatchObject({ week: '2026-12-14', tier: 0, eligible: false });
  });

  it('a deleted (scheduled) or quarantined member forfeits the week; their contribution is removed from the payout', async () => {
    const w = world();
    const teamId = await team(w, 'a', 'b');
    await w.races('a', 10);
    await w.races('b', 10);
    w.set(weekEndMs('2026-12-07', dayRule(m)) + 1000);
    // closed (by the next team call) but not yet paid; then b is quarantined: removed from the unpaid list
    await w.ts.goal('a');
    await w.svc.setModeration('b', 'quarantined', w.now() + DAY, 'test');
    const before = w.state('b').wallet.free;
    const r = await w.alarm(teamId);
    expect(r.paid).toBe(1);
    expect(w.state('b').wallet.free).toBe(before);
    // directly: a member not in good standing forfeits (recorded, so a later retry pays nothing either)
    expect((await w.svc.teamGoalReward('b', '2026-12-07', teamId, 1, 10))!.status).toBe('forfeited');
    await w.svc.setModeration('b', 'ok', null, 'released');
    expect((await w.svc.teamGoalReward('b', '2026-12-07', teamId, 1, 10))!.status).toBe('already');
  });

  it('an account deletion removes the contribution from every team it went to (feed forget step)', async () => {
    const w = world();
    const teamId = await team(w, 'a', 'b');
    await w.races('a', 5);
    await w.races('b', 4);
    expect((w.state('a') as PlayerState & { teamFeed: { postedIn: string[] } }).teamFeed.postedIn).toContain(teamId);
    await w.teams.feedForget(teamId, 'a');
    expect((await w.ts.goal('b')).current!.progress).toBe(4);
  });

  it('GET /v1/teams/me/goal without a team, and no endpoint lets a client add a contribution', async () => {
    const w = world();
    await w.svc.bootstrap('solo');
    const v = await w.ts.goal('solo');
    expect(v).toMatchObject({ teamId: null, current: null, lastWeek: null, enabled: true });
    await w.races('solo', 2);
    expect(w.kpi.filter((k) => k.r.name === 'team_goal_contribute')).toHaveLength(0);
    const { routes } = await import('../src/http/app.js');
    const goalRoutes = routes.filter((r) => r.path.includes('/goal'));
    expect(goalRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /v1/teams/me/goal']);
  });
});
