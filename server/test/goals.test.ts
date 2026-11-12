import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import type { AppError } from '../src/domain/errors.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import { kpiClassOf } from '../src/domain/kpiConsent.js';
import { goalLadderView, PACE_MIN_RACES, type GoalLadderView } from '../src/domain/goals.js';
import { nextActionsView } from '../src/domain/nextAction.js';
import { weekIdAt } from '../src/domain/rival.js';
import { handle, type AppContext, type PlayerInvoker } from '../src/http/app.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 11, 8, 3); // 2026-12-08 12:00 JST
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as AppError).code; } return 'NO_ERROR'; };

function world() {
  let now = T0;
  const kpi: KpiRecord[] = [];
  const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(7), clock: () => now, verifiers: {}, onKpi: (_id, recs) => { kpi.push(...recs); } });
  let n = 0;
  let k = 0;
  const race = (id: string, place: number) => svc.applyRace(id, { raceId: `r_${id}_${n++}`, mode: 'ranked', place, fieldSize: 12, newRating: null, void: false, humans: 2 });
  const player = async (id: string, places: number[] = []) => {
    await svc.bootstrap(id);
    await svc.grantPartner(id, 'アイボウ', `c:partner-${id}`);
    for (const p of places) await race(id, p);
  };
  return { svc, kpi, race, player, key: () => `c:k${k++}`, now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('目標の階段 — the ladder (REQ-GOAL-001..008)', () => {
  it('a new player: no daily set yet, the beginner path with its final reward, the rookie season, no week', async () => {
    const w = world();
    await w.player('p');
    const v = await w.svc.goals('p') as GoalLadderView;
    expect(v.today.open).toBe(false); // daily missions open after 2 races (progression.unlocks)
    expect(v.path?.step).toBe(1);
    expect(v.path?.steps).toBe(m.progression.beginnerMissions!.length);
    expect(v.path?.finalReward).toEqual(m.progression.beginnerMissions!.at(-1)!.reward);
    expect(v.season.status).toBe('rookie');
    expect(v.week).toBeNull();
    expect(v.claimable).toBe(0);
    expect(v.today.resetAt).toBeGreaterThan(T0);
  });

  it('today = the daily missions + the first-win bonus as one set with honest progress', async () => {
    const w = world();
    await w.player('p', [1, 4, 2]);
    const v = await w.svc.goals('p') as GoalLadderView;
    const ids = v.today.items.map((i) => i.id);
    expect(ids).toEqual([...m.progression.dailyMissions.map((d) => d.id), 'first_win']);
    const race3 = v.today.items.find((i) => i.id === 'race3')!;
    expect(race3).toMatchObject({ progress: 3, target: 3, claimable: true });
    expect(v.today.items.find((i) => i.id === 'first_win')).toMatchObject({ progress: 1, claimed: true, claimable: false });
    expect(v.today.items.find((i) => i.id === 'train1')).toMatchObject({ progress: 0, claimable: false });
    expect(v.today.done).toBe(v.today.items.filter((i) => i.progress >= i.target).length);
    expect(v.today.claimable).toBe(v.today.items.filter((i) => i.claimable).length);
  });

  it('the season rung: points to the line, the own pace only after enough races, the ladder with its rewards', async () => {
    const w = world();
    await w.player('p', [1, 1]);
    let v = await w.svc.goals('p') as GoalLadderView;
    expect(v.season.pace.pace10).toBeNull(); // fewer than PACE_MIN_RACES ranked races: no estimate
    for (let i = 2; i < Math.max(PACE_MIN_RACES, 4); i++) await w.race('p', 1);
    v = await w.svc.goals('p') as GoalLadderView;
    const C = m.progression.classes[0]!;
    const per = m.progression.seasonPointsByPlace[0]!;
    expect(v.season.classId).toBe(C.id);
    expect(v.season.points).toBe(4 * per);
    expect(v.season.line).toBe(C.promotePoints);
    expect(v.season.left).toBe(C.promotePoints! - 4 * per);
    expect(v.season.pace.pace10).toBe(per * 10);
    expect(v.season.pace.racesToLine).toBe(Math.ceil((C.promotePoints! - 4 * per) / per));
    expect(v.season.ladder.map((c) => c.classId)).toEqual(m.progression.classes.map((c) => c.id));
    expect(v.season.ladder[0]).toMatchObject({ current: true, statCap: C.statCap });
    expect(v.season.ladder[0]!.rewards.top?.reward).toEqual(m.progression.seasonRewards[C.id]![0]!.reward);
    expect(v.season.nextClassId).toBe(m.progression.classes[1]!.id);
  });

  it('why climb: how much of the partner the class lets race now and in the next class (REQ-GOAL-006)', async () => {
    const w = world();
    await w.player('p', [3]);
    const v = await w.svc.goals('p') as GoalLadderView;
    const p = v.season.power!;
    expect(p.partner).toBe(true);
    expect(p.total).toBeGreaterThan(p.cap); // the partner (SR) is stronger than the C cap
    expect(p.usable).toBe(Math.min(p.total, m.progression.classes[0]!.statCap));
    expect(p.nextUsable).toBe(Math.min(p.total, m.progression.classes[1]!.statCap));
    expect(p.held).toBe(p.total - p.cap);
  });

  it('the top class has no line and no next cap; reaching the line says so', async () => {
    const w = world();
    await w.player('p', [1, 1, 1]);
    const st = await w.svc.state('p');
    const top = m.progression.classes.at(-1)!;
    const asTop = goalLadderView(m, { ...st, season: { ...st.season, classId: top.id } }, w.now());
    expect(asTop.season.line).toBeNull();
    expect(asTop.season.nextClassId).toBeNull();
    expect(asTop.season.power?.nextUsable).toBeNull();
    const reached = goalLadderView(m, { ...st, rating: { ...st.rating, rankedRaces: 10 }, season: { ...st.season, points: 999 } }, w.now());
    expect(reached.season.status).toBe('line_reached');
    expect(reached.season.left).toBe(0);
    expect(reached.season.pace.racesToLine).toBeNull();
  });

  it('the week: the challenges of this week, the rival head to head, and last week\'s unseen rival result (REQ-GOAL-004)', async () => {
    const w = world();
    await w.player('p', Array(20).fill(4));
    w.advance(4 * DAY);
    const st = await w.svc.state('p');
    const weekId = weekIdAt(m, w.now());
    st.rival = {
      optOut: false, weeksWon: 0, weeksPlayed: 1, unseen: 'prev',
      weeks: [{ weekId, assignment: { kind: 'cpu', cpuId: m.progression.rival!.cpuRivals[0]!.id }, me: 2, them: 1, races: [], pending: [], rankedRaces: 3, ta: {}, rivalTa: {} }],
      results: [{ weekId: 'prev', outcome: 'win', kind: 'cpu', rivalName: null, me: 3, them: 1, taMe: 0, taThem: 0, freeCoins: 20, settledAt: 0, newTitles: [] }],
    } as unknown as typeof st.rival;
    const v = goalLadderView(m, st, w.now());
    expect(v.week?.challenge?.total).toBe(3);
    expect(v.week?.challenge?.cleared).toBe(0);
    expect(v.week?.rival).toMatchObject({ kind: 'cpu', me: 2, them: 1, rankedRaces: 3, minRaces: m.progression.rival!.minRacesForResult });
    expect(v.week?.rivalResult).toMatchObject({ outcome: 'win', me: 3, them: 1, freeCoins: 20 });
    expect(v.week!.endsAt).toBeGreaterThan(w.now());
    st.rival!.optOut = true;
    expect(goalLadderView(m, st, w.now()).week?.rival ?? null).toBeNull();
  });

  it('the next login bonus: today\'s when not claimed, tomorrow\'s after the claim (beginner week first, REQ-GOAL-011)', async () => {
    const w = world();
    await w.player('p', [3, 3]);
    let v = await w.svc.goals('p') as GoalLadderView;
    const b = m.progression.beginnerLoginBonus!;
    expect(v.today.loginBonus.next).toMatchObject({ track: 'beginner', day: 1, days: b.length });
    await w.svc.claimLogin('p', w.key());
    v = await w.svc.goals('p') as GoalLadderView;
    expect(v.today.loginBonus.claimedToday).toBe(true);
    const { day: _d, ...r2 } = b[1]!;
    expect(v.today.loginBonus.next).toEqual({ track: 'beginner', day: 2, days: b.length, reward: r2 });
    const st = await w.svc.state('p');
    const after = goalLadderView(m, { ...st, loginBonus: { streakDay: 6, lastClaimDate: st.loginBonus.lastClaimDate, beginnerDay: b.length } }, w.now());
    expect(after.today.loginBonus.next).toMatchObject({ track: 'normal', day: 7 });
  });

  it('reads only: the ladder never changes the wallet or claims anything', async () => {
    const w = world();
    await w.player('p', [1, 1, 1]);
    const before = await w.svc.state('p');
    await w.svc.goals('p');
    const after = await w.svc.state('p');
    expect(after.wallet).toEqual(before.wallet);
    expect(after.missions.claimed).toEqual(before.missions.claimed);
  });
});

describe('目標の階段 — one claim (REQ-GOAL-009/010)', () => {
  it('claims every claimable mission at once, exactly what the one-by-one claims pay, then NOT_ELIGIBLE', async () => {
    const a = world(), b = world();
    for (const w of [a, b]) {
      await w.player('p', [1, 2, 3, 1, 1, 1, 1, 1, 1, 1]); // 10 ranked races: the daily set and sm_races10
    }
    const view = await a.svc.goals('p') as GoalLadderView;
    expect(view.claimable).toBeGreaterThanOrEqual(3);
    const r = await a.svc.claimGoals('p', a.key());
    expect(r.claimed.length).toBe(view.claimable);
    expect(r.claimed.some((c) => c.table === 'season')).toBe(true);
    expect(r.ladder.claimable).toBe(0);
    // the same missions claimed one by one in the twin world give the same balance
    for (const c of r.claimed) await b.svc.claimMission('p', c.id, b.key());
    const [sa, sb] = [await a.svc.state('p'), await b.svc.state('p')];
    expect(sa.wallet).toEqual(sb.wallet);
    expect(sa.items).toEqual(sb.items);
    expect(sa.seasonPass.xp).toBe(sb.seasonPass.xp);
    expect(r.total.freeCoins ?? 0).toBe(r.claimed.reduce((x, c) => x + (c.reward.freeCoins ?? 0), 0));
    expect(await code(a.svc.claimGoals('p', a.key()))).toBe('NOT_ELIGIBLE');
    expect(a.kpi.filter((x) => x.name === 'goals_claim_all')).toHaveLength(1);
    expect(kpiClassOf('goals_claim_all')).toBe('optional');
  });

  it('an idempotency key replays the first answer (no double pay)', async () => {
    const w = world();
    await w.player('p', [1, 1, 1]);
    const r1 = await w.svc.claimGoals('p', 'c:same');
    const coins = (await w.svc.state('p')).wallet.free;
    const r2 = await w.svc.claimGoals('p', 'c:same');
    expect(r2.claimed).toEqual(r1.claimed);
    expect((await w.svc.state('p')).wallet.free).toBe(coins);
    expect(await code(w.svc.claimGoals('p', null))).not.toBe('NO_ERROR');
  });

  it('beginner steps are claimed in order, as many as are reached', async () => {
    const w = world();
    await w.player('p', [1, 1]);
    const st = await w.svc.state('p');
    // the first two steps reached (a scout and a silks change)
    st.onboarding!.counts = { ...(st.onboarding!.counts ?? {}), gacha: 1, silks: 1 };
    const v = goalLadderView(m, st, w.now());
    expect(v.path?.current.claimable).toBe(true);
  });

  it('次にやること counts the beginner and season missions it never announced (REQ-GOAL-010)', async () => {
    const w = world();
    await w.player('p', [5, 5, 5, 5, 5, 5, 5, 5, 5, 5]); // sm_races10 reached, daily race3 reached
    const st = await w.svc.state('p');
    const daily = goalLadderView(m, st, w.now()).today.claimable;
    const nx = nextActionsView(m, st, w.now());
    const all = [nx.primary, ...nx.chips].find((x) => x?.kind === 'missions_claim');
    expect(all?.count).toBe(daily + 1);
  });

  it('HTTP: GET /v1/home/goals and POST /v1/home/goals/claim (Idempotency-Key)', async () => {
    const w = world();
    await w.player('u', [1, 1, 1]);
    const svc = w.svc;
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
    const c = { master: m, authenticate: async () => 'u', player: () => invoker, clock: w.now } as unknown as AppContext;
    const call = async (method: string, path: string, headers: Record<string, string> = {}) => {
      const res = await handle(new Request(`https://x${path}`, { method, headers: { 'content-type': 'application/json', ...headers } }), {}, c);
      return { status: res.status, body: await res.json() as Record<string, any> };
    };
    const g = await call('GET', '/v1/home/goals');
    expect(g.status).toBe(200);
    expect(g.body.today.items.length).toBeGreaterThan(0);
    const p = await call('POST', '/v1/home/goals/claim', { 'idempotency-key': 'abc' });
    expect(p.status).toBe(200);
    expect(p.body.claimed.length).toBeGreaterThan(0);
    expect((await call('POST', '/v1/home/goals/claim', { 'idempotency-key': 'abd' })).status).toBe(409);
  });
});
